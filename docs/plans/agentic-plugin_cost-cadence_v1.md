# agentic-plugin : cost and cadence (item 6)

**Status:** Draft (v1, for Reviewer review)
**Created:** 2026-09-09T13:50:00Z
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

### D2. Idle tick skip

Before calling classify, hash the controller summary. If the hash equals the previous tick's and no turn has completed since, skip both haiku calls and record `controller_tick` with detail `unchanged, skipped`. The nudge decision from the previous tick carries forward. This is where most of the saving is and it changes no behavior on an active session.

### D3. Caps

Two caps with rolling one-hour windows: `costMaxNudgesPerHour` (default 12) and `costMaxPluginCallsPerHour` (default 200). When a cap is hit, record `cost_cap_reached` once per window, stop the capped action until the window rolls, and keep the ledger running. The supervisor does not need to read this; it is an inner-loop brake.

### D4. Backoff

After K consecutive skipped ticks (config `costBackoffAfterTicks`, default 10) double the effective controller interval up to `costBackoffMaxMs` (default 5 min), and reset to `controllerTickMs` on the next turn start. Implement as a skip count inside the existing 30 s timer, not a second timer, so the heartbeat cadence is untouched.

## 4. Out of scope

- Pricing in dollars (no rate table in the plugin)
- Reading the SDK result usage (not reachable from hooks)
- Changing the supervisor

## 5. Files

| File | Purpose |
|---|---|
| `hooks/cost-ledger.ts` | Pure unit: window arithmetic, cap latch, backoff schedule |
| `hooks/index.ts` | Integrate ledger, idle tick skip, caps, backoff into controller loop |
| `.kit/live-cost-test.sh` | Live suite: assert `cost_summary`, `cost_cap_reached`, `controller_tick` with `unchanged, skipped` |
| `.kit/live-all.sh` | Add `live-cost-test.sh` to the suite list |

## 6. Protocol

### Gate run shape

Run live-all detached from the wrapper so the wrapper's death does not kill it:

```bash
nohup bash .kit/live-all.sh > .kit/runs/liveall-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 &
```

Then poll in separate short calls until the newest `summary.txt` has its `done` line, and read `Failures:` from the log. Paste that summary. Never paste a wrapper timeout as a suite result.

### Red-run statement

A red run is any suite with `script_exit != 0` or `ASSERT:` count > 0 in the summary. Paste the full summary line for the red suite, the run dir, and the exit code. Do not close over a red.

### Commit convention

- `PLAN:` for plan doc changes
- `HOOK:` for `hooks/` changes
- `KIT:` for `.kit/` changes
- `TEST:` for test file changes

## 7. Revision table

| Label | Finding | Resolution |
|---|---|---|
| (none yet) | (none yet) | (none yet) |

## 8. Acceptance

A pure unit `hooks/cost-ledger.ts` with tests for the window arithmetic, the cap latch, and the backoff schedule. A live suite `.kit/live-cost-test.sh`, short profile, that asserts from the store:

- `cost_summary` present with `nudge` count equal to the number of `nudge_sent` decisions
- With `costMaxNudgesPerHour: 2`, exactly two `nudge_sent` then one `cost_cap_reached` and no `nudge_sent` after it
- At least one `controller_tick` with `unchanged, skipped`

Gate on observed state, never on a sleep. Add the suite to live-all.

## 9. Order

1. AF1-AF4 (done in this round)
2. This plan doc v1 (this file)
3. Code for item 6 waits for Reviewer review of the plan
