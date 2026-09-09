# agentic-plugin : cost and cadence (item 6)

**Status:** Draft (v6, for Reviewer review)
**Created:** 2026-09-09T13:40:33Z (commit `4fa322d`)
**Revised:** 2026-09-09T19:42:00Z (AK1-AK6 resolved)
**Program item:** 6 (cost and cadence)
**Supersedes:** N/A (new item)

## 1. Purpose

A persona under the supervisor runs for days. Today nothing in the plugin knows what that costs or slows down when nothing is happening. Item 6 makes the plugin account for its own spend, cap it, and stop paying for idle ticks.

## 2. Facts the design rests on

All read at commit `a8fb23f`.

- No hook event carries API usage. `TurnCompleteInput` (`.claude/types/claude-code.d.ts:4200`) has a reason and nothing else. The `usage` block at `:5031` belongs to the SDK result message, which hooks never see. So per-turn main-model cost cannot be read. It can only be estimated from the transcript, which the budget monitor already does at `hooks/index.ts:1184-1198`.
- `$.model.complete` and `$.model.classify` return text only (`:629`, `:664`). Only `$.model.fork` returns `ModelForkUsage` (`:2034`). The plugin's own model calls therefore have no exact cost either. They have a known count and a known cap: classify at `:1371` and the reason call at `:1432` with `maxTokens: 30` on every controller tick, self-review at `:789` with `maxTokens: 80`, planner at `:1057` with `maxTokens: 1500`.
- Cadence knobs today (`:352-373`): heartbeat 30 s, controller tick 30 s, nudge floor 5 min, nudge idle 2 min, budget read every 3 ticks, git probe 120 s, health timeout 60 s.
- The controller pays two calls per 30 s tick whether or not anything changed since the last tick. On an idle session that is 240 calls an hour to reach the same decision.
- Each nudge starts a full main-model turn. That is the expensive unit, and the plugin decides when it happens.

## 3. Design

### D1. Ledger

Add `monitor.cost` to the state: counts by site (`classify`, `reason`, `selfReview`, `planner`, `nudge`) and an estimated token total per site computed as prompt chars over 4 plus the `maxTokens` cap. Label it an estimate in the field name (`estTokens`). Emit a `cost_summary` decision every N ticks (config `costSummaryEveryNTicks`, default 20) with the counts and the running estimate. Fork usage, where fork is ever used, is exact and goes in a separate field so exact and estimated are never summed.

The `nudge` site is count-only because the nudge's cost is a main-model turn the hooks cannot measure.

**Ledger increments:**

| Site | Location | Field incremented |
|------|----------|-------------------|
| selfReview | `hooks/index.ts:789` | `monitor.cost.selfReview.count`, `monitor.cost.selfReview.estTokens` |
| planner | `hooks/index.ts:1057` | `monitor.cost.planner.count`, `monitor.cost.planner.estTokens` |
| classify | `hooks/index.ts:1371` | `monitor.cost.classify.count`, `monitor.cost.classify.estTokens` |
| reason | `hooks/index.ts:1432` | `monitor.cost.reason.count`, `monitor.cost.reason.estTokens` |
| nudge | `hooks/index.ts:1470` | `monitor.cost.nudge.count` (count-only, no estTokens) |

**Emission:** Every `costSummaryEveryNTicks` ticks (default 20), emit `cost_summary` decision when `tickIndex % costSummaryEveryNTicks === 0`, the same shape as the budget read at `hooks/index.ts:1180`. A skipped tick still counts toward `costSummaryEveryNTicks`, so the summary cadence is wall-clock regular.

**Interface:** Add the `cost` member to the `monitor` interface at `hooks/agent-state.ts:112-124` (where `selfReview` shows the shape and comment style):

```typescript
// hooks/agent-state.ts:112-124 (monitor interface)
cost: {
  classify: { count: number; estTokens: number };
  reason: { count: number; estTokens: number };
  selfReview: { count: number; estTokens: number };
  planner: { count: number; estTokens: number };
  nudge: { count: number }; // count-only, no estTokens
  forkUsage: null | { inputTokens: number; outputTokens: number };
  consecutiveSkips: number; // used by D2 and D4
  nudgeWindow: { start: number; count: number }; // fixed 1-hour window
  callWindow: { start: number; count: number }; // fixed 1-hour window
}
```

**Migration:** Put the `cost` default at `hooks/agent-state.ts:329` (third in the list after `env` at `:329` and `selfReview` at `:338`), filling it "whenever it is absent, whatever the version" like E11 and S12:

```typescript
// hooks/agent-state.ts:329 (migration, after env and selfReview)
if (!state.monitor.cost) {
  state.monitor.cost = {
    classify: { count: 0, estTokens: 0 },
    reason: { count: 0, estTokens: 0 },
    selfReview: { count: 0, estTokens: 0 },
    planner: { count: 0, estTokens: 0 },
    nudge: { count: 0 },
    forkUsage: null,
    consecutiveSkips: 0,
    nudgeWindow: { start: 0, count: 0 },
    callWindow: { start: 0, count: 0 },
  };
}
```

**Migration test:** Load a version 4 fixture without `cost` at `.kit/fixtures/state-v4-no-cost.json` (a new directory, since none exists), call the loader, and assert `cost` present.

### D2. Idle tick skip

Before calling classify, hash the controller summary. If the hash equals the previous tick's and no turn has completed since, skip both haiku calls and record `controller_tick` with detail `unchanged, skipped`. The nudge decision from the previous tick carries forward. This is where most of the saving is and it changes no behavior on an active session.

**Hash input:** The controller summary at `hooks/index.ts:1301-1320` includes fields that change every tick (`Idle time`, `Consecutive nudges sent`, `Decisions tail`). Hash only a stable subset:
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

**Skip counter:** The skip counter lives at `sess.state.monitor.cost.consecutiveSkips`. The timer at `:713` consults it to determine the effective interval.

### D3. Caps

Two caps with fixed one-hour windows: `costMaxNudgesPerHour` (default 12) and `costMaxPluginCallsPerHour` (default 600). When a cap is hit, record `cost_cap_reached` once per window, stop the capped action until the window rolls, and keep the ledger running. The supervisor does not need to read this; it is an inner-loop brake.

Because the cap lives in the persisted state, a cap latched by child 1 still holds for child 2 under the supervisor, which is the behavior a cap is for.

**Arithmetic:** The controller pays two calls per 30 s tick, which is 240 calls/hour on an active session. The default of 600 allows for 2.5 hours of continuous activity before tripping. Count only calls actually made (skipped ticks do not count).

**Window data structure:** Use the same fixed-window shape as `selfReview.windowStart` and `count` at `:116-119`, reset when `now - windowStart >= 3600000`:

```typescript
// Inside monitor.cost
nudgeWindow: { start: number; count: number }; // fixed 1-hour window
callWindow: { start: number; count: number }; // fixed 1-hour window
```

Fixed windows are bounded memory and one comparison; a timestamp ring is neither.

**Nudge cap latch:** Once the nudge cap is latched, the controller also skips classify, because there is nothing left to actuate and paying for the decision is the waste D2 exists to stop.

**`cost_cap_reached` emission:** `cost_cap_reached` is emitted at the tick where a nudge is due and refused, once per window, not on the tick that made the count reach the cap.

### D4. Backoff

After K consecutive skipped ticks (config `costBackoffAfterTicks`, default 10), the controller skips the classify-and-nudge section more often. Implement as a skip count inside the existing 30 s timer, not a second timer, so the heartbeat cadence is untouched.

**Mechanism:** An in-session `tickIndex` incremented at the top of the callback; `factor = min(2 ^ floor(consecutiveSkips / costBackoffAfterTicks), floor(costBackoffMaxMs / controllerTickMs))`; the classify-and-nudge section runs only when `tickIndex % factor === 0`. Reset `consecutiveSkips` to 0 in the `turn.start` handler at `:1545`.

**Safety:** The same callback also runs the error-streak branch (2a), self-review (2a2), the budget read (3.5), and the planning gate (3). Backoff must gate only the idle classify section from step 5 at `:1269` onward. If the factor skips the whole callback, a backed-off session stops reading its context budget and the supervisor's critical trigger goes dark.

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

**`costEnabled` behavior:** When `costEnabled` is `false`, disable the skip (D2), the caps (D3), and the backoff (D4); the ledger (D1) always runs, because it is cheap and the suite and the summary read it.

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

### Red-run statement

A red run is any suite with `script_exit != 0` or `ASSERT:` count > 0 in the summary. Paste the full summary line for the red suite, the run dir, and the exit code. Do not close over a red.

**Before code:** `.kit/live-cost-test.sh` at HEAD fails at assertion 1, `cost_summary` absent, exit 1. Paste this in the hand-back.

### Commit convention

Use the repository's existing conventions:
- `PLAN:` for plan doc changes
- `PLUGIN:` for `hooks/` changes
- `SUITE:` for `.kit/` changes (including unit tests in `.kit/`)
- `README:` for README changes
- `CLOSE:` for closing commits

## 8. Build order

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

**Commit:** `PLUGIN: cost backoff (consecutive skips, tickIndex % factor).`

**Gate:** Unit test on the schedule green, live suite green.

### 6. `.kit/live-cost-test.sh` in `ALL_SUITES`

**Commit:** `SUITE: add live-cost-test.sh to live-all, full live-all green.`

**Gate:** Full live-all green, close.

**Live suite settings:**
- `nudgeIdleMs`: 60000
- `nudgeFloorMs`: 5000
- `controllerTickMs`: 10000
- `costMaxNudgesPerHour`: 2
- `costSummaryEveryNTicks`: 3

**The live suite does not exercise D4:** `consecutiveSkips` peaks around 5 in that profile and the backoff threshold is 10, so the schedule is proven by the unit test alone.

**Timeline table (derivation aid):**

| Tick | Time | Idle | Turn completes at | Hash | Nudge cap | Expected decision |
|------|------|------|-------------------|------|-----------|-------------------|
| 1 | 0 s | 0 s | - | H1 | 0/2 | `controller_tick` (classify, reason) |
| 2 | 10 s | 10 s | - | H1 | 0/2 | `controller_tick` (unchanged, skipped) |
| 3 | 20 s | 20 s | - | H1 | 0/2 | `cost_summary` (classify 1, reason 1, nudge 0) |
| 4 | 30 s | 30 s | - | H1 | 0/2 | `controller_tick` (unchanged, skipped) |
| 5 | 40 s | 40 s | - | H1 | 0/2 | `controller_tick` (unchanged, skipped) |
| 6 | 50 s | 50 s | - | H1 | 0/2 | `cost_summary` (classify 1, reason 1, nudge 0) |
| 7 | 60 s | 60 s | ~75 s | H1 | 0/2 | `controller_tick` (classify, reason, nudge sent) |
| 8 | 70 s | ~5 s | - | H1 | 1/2 | `controller_tick` (unchanged, skipped) |
| 9 | 80 s | ~15 s | - | H1 | 1/2 | `cost_summary` (classify 2, reason 2, nudge 1) |
| 10 | 90 s | ~25 s | - | H1 | 1/2 | `controller_tick` (unchanged, skipped) |
| 11 | 100 s | ~35 s | - | H1 | 1/2 | `controller_tick` (unchanged, skipped) |
| 12 | 110 s | ~45 s | - | H1 | 1/2 | `cost_summary` (classify 2, reason 2, nudge 1) |
| 13 | 120 s | ~55 s | - | H1 | 1/2 | `controller_tick` (unchanged, skipped) |
| 14 | 130 s | ~65 s | ~145 s | H1 | 1/2 | `controller_tick` (classify, reason, nudge sent) |
| 15 | 140 s | ~5 s | - | H2 | 2/2 | `cost_cap_reached` (nudge cap latched) |
| 16 | 150 s | ~15 s | - | H2 | 2/2 | `controller_tick` (skipped, cap latched) |
| 17 | 160 s | ~25 s | - | H2 | 2/2 | `cost_summary` (classify 3, reason 3, nudge 2) |

**Assertions (order-based, not tick-based):**
- Two `nudge_sent` decisions
- One `cost_cap_reached` decision
- No `nudge_sent` after `cost_cap_reached`
- At least three `controller_tick` with `unchanged, skipped`
- At least two `cost_summary`

## 9. Revision table

| Label | Finding | Resolution |
|---|---|---|
| AG1 | Brief not resolved into anchors | Section 3 names exact code locations for each design element |
| AG2 | State shape and migration not specified | Section 3 D1 has exact TypeScript for `monitor.cost`; migration at `:329` |
| AG3 | D2 hashes a string that changes every tick | Section 3 D2 defines hash input as stable subset; FNV-1a hash; nudge rule ensures skip never silences due nudge |
| AG4 | D3 default silences controller | Section 3 D3 default changed to 600, arithmetic stated |
| AG5 | Red-run statement and commit convention invented | Section 7 has before-code red statement; commit convention uses repository's existing labels |
| AG6 | Order and tests missing | Section 8 has build order (6 commits), each with gate; live suite settings stated |
| AG7 | Invented clock | Created stamp fixed to commit time |
| AH1 | Migration site is the wrong one | Section 3 D1 migration at `:329` (after `env` and `selfReview`), version 4 fixture at `.kit/fixtures/state-v4-no-cost.json` |
| AH2 | The interface is missing | Section 3 D1 interface at `:112-124` with all fields including `consecutiveSkips`, `nudgeWindow`, `callWindow` |
| AH3 | Rolling windows have no data structure | Section 3 D3 uses fixed-window shape: `nudgeWindow: { start, count }` and `callWindow: { start, count }`; cap latched by child 1 holds for child 2 |
| AH4 | `$.clock.every` has a fixed interval | Section 3 D4 uses `tickIndex % factor === 0`; backoff gates only the idle classify section, not the whole callback |
| AH5 | Live suite settings cannot produce a skip | Section 8 sets `nudgeIdleMs: 60000`; timeline table shows expected decisions; `nudge` count-only |
| AH6 | `costEnabled` false is undefined | Section 4 defines `costEnabled` behavior: false disables D2, D3, D4; ledger always runs |
| AH7 | `TEST:` is still in the convention | Section 7 commit convention uses `SUITE:` for tests (zero commits with `TEST:` prefix in history) |
| AI1 | Timeline's idle column stops being idle after first nudge | Section 8 timeline table adds "Turn completes at" column; assertions are order-based (two `nudge_sent`, one `cost_cap_reached`, no `nudge_sent` after cap, at least three `unchanged, skipped`, at least two `cost_summary`); two rules written into D3 and D1 |
| AI2 | Fill snippet names a variable that does not exist there | Section 3 D1 fill snippet uses `state` (not `parsed.state`), matching the E11 block at `hooks/agent-state.ts:330` |
| AI3 | `lastCostSummaryTick` compares a persisted number to an in-session counter | Section 3 D1 drops `lastCostSummaryTick`; emission uses `tickIndex % costSummaryEveryNTicks === 0`; section 8 states live suite does not exercise D4 |
| AJ1 | Three Reviewer entries written under Reviewer's name | Answered at top of Round 55 hand-back; protocol violation acknowledged and corrected |
| AJ2 | `cost_summary` emission inside idle gate | Emission moved to top of tick callback, after owner check, independent of idle gate; fixed at commit `481457c` |
| AJ3 | Four inline `Math.floor(x.length / 4) + N` expressions | All four sites now call `estimateTokens(promptChars, maxTokens)` from `cost-ledger.ts`; fixed at commit `481457c` |
| AJ4 | 15 em dashes in timeline table | All replaced with plain hyphens; fixed at commit `481457c` |
| AJ5 | Shared-script change at `a1ec8bb` unannounced | Announced here; `COST_SUMMARY_EVERY_N_TICKS` feeds `emit_settings_json` in `bin/agentic-common.sh`; gate run after commit |
| AJ6 | Count 26 not 25, commit time wrong, misplaced copy | Count corrected to 31 (5 new `bumpWindow` checks added); timestamp fixed; misplaced `DISCUSSION.md` and `dist/` removed from repo |
| AK1 | `nudgeDue` formula wrong | `nudgeDue` now `idleMs >= nudgeIdleMs && (now - lastNudgeAt >= nudgeFloorMs)` at `hooks/index.ts:1465`; prevents firing every tick pre-nudge and post-floor |
| AK2 | `cost_cap_reached` emitted every tick while latched | Added `capNoticeWindowStart` field (default 0) to latch one emission per window; nudge-cap check moved pre-classify per AH5; post-classify guard now silent at `hooks/index.ts:1570-1573` |
| AK3 | `callWindow` bumped 3x for 2 calls | Removed third `bumpWindow` call in nudge branch at `hooks/index.ts:1587-1588` |
| AK4 | Gate ran before `bin/agentic-common.sh` commit | `emit_settings_json` now passes `COST_MAX_NUDGES_PER_HOUR`, `COST_MAX_PLUGIN_CALLS_PER_HOUR`, `COST_SUMMARY_EVERY_N_TICKS`; committed at `90693d2`; gate re-run at final HEAD |
| AK5 | (Not raised by Reviewer) | N/A |
| AK6 | Record defects: em dashes, false claims, wrong `git rm --cached` claim, sections 3+4 one commit, migration test gap | Migration gap fixed with `state-v4-cost-no-hash.json` fixture at `911128d`; em dashes and false claims acknowledged in Round 57 hand-back; commit order corrected (passthrough first, then fixes) |
