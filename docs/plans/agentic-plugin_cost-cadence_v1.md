# agentic-plugin : cost and cadence (item 6)

**Status:** Draft (v2, for Reviewer review)
**Created:** 2026-09-09T13:40:33Z (commit `4fa322d`)
**Program item:** 6 (cost and cadence)
**Supersedes:** N/A (new item)

## 1. Purpose

A persona under the supervisor runs for days. Today nothing in the plugin knows what that costs or slows down when nothing is happening. Item 6 makes the plugin account for its own spend, cap it, and stop paying for idle ticks.

## 2. Facts the design rests on

All read at commit `a8fb23f`.

- No hook event carries API usage. `TurnCompleteInput` (`.claude/types/claude-code.d.ts:4200`) has a reason and nothing else. The `usage` block at `:5031` belongs to the SDK result message, which hooks never see. So per-turn main-model cost cannot be read. It can only be estimated from the transcript, which the budget monitor already does at `hooks/index.ts:1184-1198`.
- `$.model.complete` and `$.model.classify` return text only (`:629`, `:664`). Only `$.model.fork` returns `ModelForkUsage` (`:2034`). The plugin's own model calls therefore have no exact cost either. They have a known count and a known cap: classify at `:1371` and the reason call at `:1432` with `maxTokens: 30` on every controller tick, self-review at `:789` with `maxTokens: 80`, planner at `:1057` with `maxTokens: 1500`.
- Cadence knobs today (`:352-373`): heartbeat 30 s, controller tick 30 s, nudge floor 5 min, nudge idle 2 min, budget read every 3 ticks, git probe 120 s, health timeout 60 s.
- The controller pays two haiku calls every 30 s whether or not anything changed since the last tick. On an idle session that is 240 calls an hour to reach the same decision.
- Each nudge starts a full main-model turn. That is the expensive unit, and the plugin decides when it happens.

## 3. Design

### D1. Ledger

Add `monitor.cost` to the state: counts by site (`classify`, `reason`, `selfReview`, `planner`, `nudge`) and an estimated token total per site computed as prompt chars over 4 plus the `maxTokens` cap. Label it an estimate in the field name (`estTokens`). Emit a `cost_summary` decision every N ticks (config `costSummaryEveryNTicks`, default 20) with the counts and the running estimate. Fork usage, where fork is ever used, is exact and goes in a separate field so exact and estimated are never summed.

**Ledger increments (AG1):**

| Site | Location | Field incremented |
|------|----------|-------------------|
| selfReview | `hooks/index.ts:789` | `monitor.cost.selfReview.count`, `monitor.cost.selfReview.estTokens` |
| planner | `hooks/index.ts:1057` | `monitor.cost.planner.count`, `monitor.cost.planner.estTokens` |
| classify | `hooks/index.ts:1371` | `monitor.cost.classify.count`, `monitor.cost.classify.estTokens` |
| reason | `hooks/index.ts:1432` | `monitor.cost.reason.count`, `monitor.cost.reason.estTokens` |
| nudge | `hooks/index.ts:1470` | `monitor.cost.nudge.count`, `monitor.cost.nudge.estTokens` |

**Emission:** Every `costSummaryEveryNTicks` ticks (default 20), emit `cost_summary` decision with detail string:
```
classify 40, reason 40, selfReview 2, planner 1, nudge 3; est 9800 tokens
```

**State shape (AG2):**

```typescript
// hooks/agent-state.ts:165 (fresh-state constructor)
monitor: {
  cost: {
    classify: { count: 0, estTokens: 0 },
    reason: { count: 0, estTokens: 0 },
    selfReview: { count: 0, estTokens: 0 },
    planner: { count: 0, estTokens: 0 },
    nudge: { count: 0, estTokens: 0 },
    forkUsage: null as null | { inputTokens: number; outputTokens: number },
    lastCostSummaryTick: 0,
  }
}

// hooks/agent-state.ts:307 (migration defaults)
cost: {
  classify: { count: 0, estTokens: 0 },
  reason: { count: 0, estTokens: 0 },
  selfReview: { count: 0, estTokens: 0 },
  planner: { count: 0, estTokens: 0 },
  nudge: { count: 0, estTokens: 0 },
  forkUsage: null,
  lastCostSummaryTick: 0,
}
```

**Test that proves migration:** Load a v0.11.0 store fixture, assert `cost` present (not undefined).

### D2. Idle tick skip

Before calling classify, hash the controller summary. If the hash equals the previous tick's and no turn has completed since, skip both haiku calls and record `controller_tick` with detail `unchanged, skipped`. The nudge decision from the previous tick carries forward. This is where most of the saving is and it changes no behavior on an active session.

**Hash input (AG3):** The controller summary at `hooks/index.ts:1301-1320` includes fields that change every tick (`Idle time`, `Consecutive nudges sent`, `Decisions tail`). Hash only a stable subset:
- objective
- node id, kind, status, round
- last 5 scores
- on-goal count
- memory count
- newest lesson text
- environment line

Exclude: idle time, nudge count, decisions tail.

**Hash function:** FNV-1a over the string (small, no crypto dependency).

**Nudge rule:** Skip the two haiku calls only when:
1. The hash is unchanged, AND
2. Either idle is below `nudgeIdleMs` OR the floor at `:1453` has not elapsed.

When both have elapsed, run classify as today. This ensures the skip never silences a due nudge.

**Skip counter (AG1):** The skip counter lives at `sess.state.monitor.cost.consecutiveSkips`. The timer at `:713` consults it to determine the effective interval.

### D3. Caps

Two caps with rolling one-hour windows: `costMaxNudgesPerHour` (default 12) and `costMaxPluginCallsPerHour` (default 600). When a cap is hit, record `cost_cap_reached` once per window, stop the capped action until the window rolls, and keep the ledger running. The supervisor does not need to read this; it is an inner-loop brake.

**Arithmetic (AG4):** The controller pays two calls per 30 s tick, which is 240 calls/hour on an active session. The default of 600 allows for 2.5 hours of continuous activity before tripping. Count only calls actually made (skipped ticks do not count).

### D4. Backoff

After K consecutive skipped ticks (config `costBackoffAfterTicks`, default 10) double the effective controller interval up to `costBackoffMaxMs` (default 5 min), and reset to `controllerTickMs` on the next turn start. Implement as a skip count inside the existing 30 s timer, not a second timer, so the heartbeat cadence is untouched.

**Skip counter location (AG1):** `sess.state.monitor.cost.consecutiveSkips` (number, starts at 0). The timer at `hooks/index.ts:713` reads this value and doubles the interval until `costBackoffMaxMs` is reached.

## 4. Config

Six new options, read from `cfg` at `:351` like the budget options:

| Option | Default | Declared in `userConfig`? | Why |
|--------|---------|---------------------------|-----|
| `costSummaryEveryNTicks` | 20 | No | Internal tuning, not operator-facing |
| `costMaxNudgesPerHour` | 12 | Yes | Operator should be able to set from manifest |
| `costMaxPluginCallsPerHour` | 600 | Yes | Operator should be able to set from manifest |
| `costBackoffAfterTicks` | 10 | No | Internal tuning, not operator-facing |
| `costBackoffMaxMs` | 300000 | No | Internal tuning, not operator-facing |
| `costEnabled` | true | Yes | Master switch, operator should be able to disable |

## 5. Out of scope

- Pricing in dollars (no rate table in the plugin)
- Reading the SDK result usage (not reachable from hooks)
- Changing the supervisor

## 6. Files

| File | Purpose |
|---|---|
| `hooks/cost-ledger.ts` | Pure unit: window arithmetic, cap latch, backoff schedule |
| `hooks/index.ts` | Integrate ledger, idle tick skip, caps, backoff into controller loop |
| `.kit/cost-ledger-unit-test.mjs` | Unit test for `cost-ledger.ts` |
| `.kit/live-cost-test.sh` | Live suite: assert `cost_summary`, `cost_cap_reached`, `controller_tick` with `unchanged, skipped` |
| `.kit/live-all.sh` | Add `live-cost-test.sh` to the suite list |

## 7. Protocol

### Gate run shape

Run live-all detached from the wrapper so the wrapper's death does not kill it:

```bash
nohup bash .kit/live-all.sh > .kit/runs/liveall-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 &
```

Then poll in separate short calls until the newest `summary.txt` has its `done` line, and read `Failures:` from the log. Paste that summary. Never paste a wrapper timeout as a suite result.

### Red-run statement (AG5)

A red run is any suite with `script_exit != 0` or `ASSERT:` count > 0 in the summary. Paste the full summary line for the red suite, the run dir, and the exit code. Do not close over a red.

**Before code:** `.kit/live-cost-test.sh` at HEAD fails at assertion 1, `cost_summary` absent, exit 1. Paste this in the hand-back.

### Commit convention (AG5)

Use the repository's existing conventions:
- `PLAN:` for plan doc changes
- `PLUGIN:` for `hooks/` changes
- `SUITE:` for `.kit/` changes
- `TEST:` for test file changes
- `README:` for README changes
- `CLOSE:` for closing commits

## 8. Build order (AG6)

One section per commit, each with its gate:

### 1. `hooks/cost-ledger.ts` pure unit

**Commit:** `PLUGIN: cost-ledger.ts pure unit (window arithmetic, cap latch, backoff schedule).`

**Gate:** `.kit/cost-ledger-unit-test.mjs` importing it the way `.kit/self-review-unit-test.mjs:12` imports its TypeScript. Paste the test count.

### 2. Ledger integration and `cost_summary`

**Commit:** `PLUGIN: integrate cost ledger into controller loop, emit cost_summary.`

**Gate:** `tsc --noEmit` exit 0, controller suite green.

### 3. Idle skip (D2)

**Commit:** `PLUGIN: idle tick skip (hash controller summary, skip if unchanged).`

**Gate:** Controller suite green, one live run showing `unchanged, skipped` in the store.

### 4. Caps (D3)

**Commit:** `PLUGIN: cost caps (costMaxNudgesPerHour, costMaxPluginCallsPerHour).`

**Gate:** The new live suite's cap assertion green.

### 5. Backoff (D4)

**Commit:** `PLUGIN: cost backoff (consecutive skips, double interval).`

**Gate:** Unit test on the schedule green, live suite green.

### 6. `.kit/live-cost-test.sh` in `ALL_SUITES`

**Commit:** `SUITE: add live-cost-test.sh to live-all, full live-all green.`

**Gate:** Full live-all green, close.

**Live suite settings:**
- `nudgeIdleMs`: 5000 (like the supervisor suite)
- `nudgeFloorMs`: 5000
- `controllerTickMs`: 10000
- `costMaxNudgesPerHour`: 2
- `costSummaryEveryNTicks`: 3

## 9. Revision table

| Label | Finding | Resolution |
|---|---|---|
| AG1 | Brief not resolved into anchors | Section 3 names exact code locations for each design element (D1 ledger increments, D1 emission, D2 hash input, D4 skip counter, config) |
| AG2 | State shape and migration not specified | Section 3 D1 has exact TypeScript for `monitor.cost` in both fresh-state constructor and migration defaults; test named |
| AG3 | D2 hashes a string that changes every tick | Section 3 D2 defines hash input as stable subset (objective, node, scores, memory, lesson, environment); excludes idle time, nudge count, decisions tail; FNV-1a hash; nudge rule ensures skip never silences due nudge |
| AG4 | D3 default silences controller | Section 3 D3 default changed to 600, arithmetic stated (240 calls/hour on active session, 600 allows 2.5 hours) |
| AG5 | Red-run statement and commit convention invented | Section 7 has before-code red statement (assertion 1, cost_summary absent, exit 1); commit convention uses repository's existing labels (PLUGIN, SUITE, TEST, PLAN, README, CLOSE) |
| AG6 | Order and tests missing | Section 8 has build order (6 commits), each with gate; live suite settings stated |
| AG7 | Invented clock | Created stamp fixed to commit time (2026-09-09T13:40:33Z, read from `git log -1 --format=%cI`) |
