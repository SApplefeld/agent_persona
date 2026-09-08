# Agentic Plugin: Self-Review (Lessons from the Decision Log)

**Status**: Proposed
**Created**: 2026-09-08T16:35:00Z
**Author**: DeepSeekHarness
**Reviewer**: Fable

## 1. Purpose

The controller already classifies each turn, tracks an error streak (env monitor, `env.errors`), and builds a summary that the model reads at each tick. What it lacks is a periodic self-review: a moment where the controller looks back at the decisions it has made, extracts a one-sentence lesson, and feeds that lesson into the worker's context on the next prompt.

The invariant from every prior stage: **decide in code whether a review is due, then ask a model what the lesson is.** The code owns the trigger, the input window, the output format, and the cost ceiling. The model owns the content of the lesson (one sentence or `NONE`).

## 2. Decisions

One row per point. Each row has a decision and a reason.

| # | Point | Decision | Reason |
|---|---|---|---|
| 1 | **Trigger** | Two triggers, both in code, sharing the debounce and the cap. The tick handler is the single execution site (S9), running after the owner and in-flight checks, in this priority: (1) `pendingPeriodic` (set by `goal_done` handler, `index.ts:1892-1924`, which runs inside `tool.call` at `index.ts:1617` and must NOT await a model call there); (2) `turnsSince >= selfReviewEveryTurns` (default 20); (3) `env.errors.consecutiveErrorTurns >= selfReviewStreak` (default 3). All three also require the debounce: `lastAt === 0` (never reviewed) OR `turnsSince >= selfReviewDebounceTurns` (default 5, S12). The decision record carries which trigger fired (`reactive` or `periodic`). | Error streak alone is not "periodic" (S4). `goal_done` runs inside `tool.call` (S9), so it sets `selfReview.pendingPeriodic = true` and the tick runs the review one tick later. The debounce is turn-based (S3), not tick-based. `turnsSince: 0` init avoids the 999 hack (S12). |
| 2 | **Input** | Last 20 decisions from `sess.state.decisions`, **filtered** to noise actions (exclude `controller_tick`, `env_inject`, `heartbeat`, `self-review`, `turn_start`, `turn_complete`, `planning_fired`, `planning_created`, `nudge_sent`, `nudge`, `allow`; **keep** `deny`, `block`, `score`, `error_streak`, `paused_by_controller`, `done`, `activated` as worker-facing signal, T5). Plus `env.errors` counters. Plus the active goal node. Plus the live self-review lessons (newest 5, `source === "self-review"`) passed as "do not repeat". Total input: ~3000 chars. | Unfiltered decisions include internal bookkeeping and the review's own prior output (S5, T5). Passing known lessons prevents the model from repeating them. All from session state, no transcript reconstruction. |
| 3 | **Output** | A `MemoryEntry` with `kind: "lesson"`, `source: "self-review"` (S1), `text` = one sentence (max 200 chars), `confidence: 0.5` (answer to Q3), `pinned: false` (S8), and `provenance?: { decisionTimestamps: number[]; windowRange?: [number, number]; streak: number; trigger: string }` (S2, T7: `windowRange` from decision timestamps, not turn indices). The model returns a lesson or `NONE`; the code decides everything else. If the reply is `NONE` (regex `/^\s*NONE\s*$/i`) or empty, no lesson is written. Prompt: "If there is a clear, actionable lesson ... respond with the lesson text only (<=200 chars). If the worker is doing fine and there is nothing worth distilling, respond with exactly: NONE." (T4). | The existing distill path (`index.ts:1570-1600`) already writes `kind: "lesson"`, `source: "distilled"`, `confidence: 0.4`. Adding `"self-review"` to the `source` union makes self-review lessons distinguishable as data (S1). Provenance is data the code attaches, not prose the model emits (S2, T7). `pinned: false` because `pinned` marks user intent (S8). `confidence: 0.5` is above the 0.3 recall floor (`index.ts:2159`), below anything a user stated. T4: prompt explicitly permits NONE rather than forcing a lesson. |
| 4 | **Idempotence** | After a review (whether it produced a lesson or not), push a decision `{ loop: "monitor", action: "self-review", detail: "<trigger>: <first 80 chars of lesson or NONE>" }`. Reset `selfReview.turnsSince` to 0. Increment `selfReview.count`. Set `selfReview.lastAt`. The `turn.complete` handler increments `selfReview.turnsSince += 1` (S3). The 2/hour cap (S10): before the cap check, `if (now - selfReview.windowStart >= 3600000) { count = 0; windowStart = now }`. `selfReview.lastInjectAt` is set when a `lesson_inject` decision is pushed (S11). | One review, one hook site (S3, S9). The `turn.complete` handler's only job is counting turns. The debounce (5 turns) and the cap (2/hour, S10) together prevent loops. The hourly window resets (S10) so the cap is not a one-time budget. |
| 5 | **Cost bound** | One `$.model.complete` call per review, `model: "haiku"`, `maxTokens: 80` (S1, matching the distill path at `index.ts:1570-1577`). Input: ~2500 chars. Output: ~200 chars. Hard ceiling: `selfReviewMaxPerHour` (default 2) per 3600000 ms. | `$.llm.ask` does not exist (S1). The API is `$.model.complete({ model, prompt, maxTokens })` (`claude-code.d.ts:612-629`), already used four times in `index.ts`. Haiku + 80 tokens is the same cost profile as the distill path. |
| 6 | **Acceptance test** | Suite `.kit/live-self-review-test.sh`, reusing `live-errorstreak-test.sh`'s induction and `assert-decisions.js` pattern (S7). Errors induced by prompts that trigger tool errors (a turn counts as an error turn when `reason === "error"` or `toolErrors > 0`, `agent-state.ts:519`). Assertions on persisted facts (not the ephemeral summary): F1 error streak >= 3; F2 `self-review` decision in decisions log with `detail` carrying the trigger name and first 80 chars; F3 `MemoryEntry` with `source: "self-review"` in memory array with `provenance` field; F4 `lesson_inject` decision in decisions log (the injection path, `index.ts:2149` pattern); F5 `selfReview.count` >= 1; F6 `selfReview.lastAt` > 0 (review was executed). Gate on `wait_for_fact` or store state, never on the clock. No `CROSSDIR`. Red run (at HEAD before code): F2 and F3 fail, exit 1. Green run: all pass, exit 0. **Note**: the errorstreak branch in `index.ts` no longer `return`s early after pushing its decision; it falls through to the self-review check. This means the errorstreak suite's assertions must be verified independently of the self-review suite. | The summary is a local string handed to `$.model.classify` (S7); nothing persists it. The `[ENV]` injection pushes an `env_inject` decision (`index.ts:2149`); the lesson injection will push a `lesson_inject` decision the same way. That is what the suite asserts on. Reusing the errorstreak suite's induction avoids inventing a second one (S7). |

## 3. Hook points in `index.ts`

The self-review hooks into existing paths. No new channel, no new event. **One review, one site** (S3, S9). The pure logic lives in `hooks/self-review.ts` (S13); `index.ts` keeps only the wiring: the `$.model.complete` call, the pushes, `persist()`.

| What | Where | How |
|---|---|---|
| **Config read** | `index.ts:319-326` (options block) | Add `selfReviewStreak` (default 3), `selfReviewEveryTurns` (default 20), `selfReviewDebounceTurns` (default 5), `selfReviewMaxPerHour` (default 2) to the `cfg` reads. Read as `cfg.<name>` per the existing pattern. |
| **`goal_done` flag** | `index.ts:1892-1924` (the `goal_done` handler inside `tool.call` at `index.ts:1617`) | Set `sess.state.monitor.selfReview.pendingPeriodic = true` and nothing else. No model call, no state update beyond the flag. The tick runs the review when `pendingPeriodic` is set. |
| **Tick: single execution site** | `index.ts:685-709` (error-streak branch, inside the tick handler) AND the tick's periodic check. Both in the tick handler, after the owner and in-flight checks (`index.ts:683`). | Priority: (1) `pendingPeriodic`; (2) `turnsSince >= selfReviewEveryTurns`; (3) `consecutiveErrorTurns >= selfReviewStreak`. All require the debounce: `lastAt === 0` OR `turnsSince >= selfReviewDebounceTurns`. All require the cap: `count < selfReviewMaxPerHour` (with the hourly reset from S10). When a trigger fires: `const result = shouldSelfReview(stateSlice, opts, now, trigger); if (result.eligible) { const lesson = await $.model.complete(...); applySelfReviewResult(state, result, lesson); persist(); }` (S13: the pure functions take data only, never `$`). |
| **`shouldSelfReview(state, opts, now, trigger)`** | `hooks/self-review.ts` (S13: pure function, takes data only) | Checks: debounce (`lastAt === 0` OR `turnsSince >= debounce`), cap (`count < maxPerHour`, with hourly reset), and the trigger-specific condition. Returns `{ eligible: boolean; reason: string }`. |
| **`buildSelfReviewInput(state, now)`** | `hooks/self-review.ts` | Builds the input window: filtered decisions (exclude noise; keep `deny`, `block`, `score`, `error_streak`, `paused_by_controller`, `done`, `activated` as signal, T5), `env.errors`, active goal node, live self-review lessons (newest 5). Returns `{ prompt: string; decisionTimestamps: number[]; streak: number }`. T7: `windowRange` is computed at the call site from `decisionTimestamps[0]` and `[last]`, not by turn index. |
| **`dedupeSelfReview(memory, text)`** | `hooks/self-review.ts` | Normalizes and compares against existing `source: "self-review"` entries. Returns `true` if it is a dupe. |
| **`evictSelfReview(memory)`** | `hooks/self-review.ts` | If `source === "self-review"` entries > 5, evict the oldest by `createdAt`. Never touches a user's pinned memory (S8). |
| **`runSelfReview(sess, trigger)`** | `index.ts` (wiring only, S13) | 1. `const input = buildSelfReviewInput(sess.state, Date.now())`. 2. `const raw = await $.model.complete({ model: "haiku", prompt: input.prompt, maxTokens: 80 })`. 3. If reply is `NONE` or empty: push `self-review` decision with `detail: <trigger>: NONE`. 4. If reply is a sentence: `if (!dedupeSelfReview(sess.state.memory, reply)) { push MemoryEntry with source: "self-review", provenance from input }`. Push `self-review` decision. 5. `evictSelfReview(sess.state.memory)`. 6. Update `selfReview.{count, lastAt, turnsSince, pendingPeriodic: false}`. 7. `persist()`. |
| **Lesson injection** | `index.ts:2143-2155` (the `[ENV]` block area, in the `prompt.submit` handler) | After the `[ENV]` block, add: `const recentLessons = sess.state.memory.filter(m => m.kind === "lesson" && m.source === "self-review" && Date.now() - m.createdAt < 3600000).slice(-2); if (recentLessons.length > 0 && recentLessons[0].createdAt > sess.state.monitor.selfReview.lastInjectAt) { contextBlocks.push(`LESSON: ${recentLessons.map(l => l.text).join(" | ")}`); sess.state.decisions.push({ action: "lesson_inject", detail: ... }); sess.state.monitor.selfReview.lastInjectAt = recentLessons[0].createdAt; }`. |
| **Summary line** | `index.ts:1155-1178` (the summary builder) | After the `envLine` block, add the same `LESSON:` line (the summary is free and helps the controller judge on-goal, answer to Q2). |
| **Turn counting** | `index.ts:1439-1442` (the `turn.complete` handler, after `applyTurnToErrors`) | `sess.state.monitor.selfReview.turnsSince += 1;`. This is the ONLY thing the `turn.complete` handler does for self-review (S3). |

## 4. State additions

`MonitorState` (agent-state.ts:102-110) gains:

```
selfReview: {
  count: number;          // reviews in the current hourly window
  lastAt: number;         // timestamp of the last review
  turnsSince: number;     // completed turns since the last review
  windowStart: number;    // start of the current hourly window (S10)
  pendingPeriodic: boolean; // set by goal_done, consumed by the tick (S9)
  lastInjectAt: number;   // timestamp of the last lesson_inject (S11)
}
```

`MemoryEntry` (agent-state.ts:5-15) gains:
- `source` union: add `"self-review"` to `"worker" | "user" | "distilled"` (S1).
- Optional field: `provenance?: { decisionTimestamps: number[]; windowRange?: [number, number]; streak: number; trigger: string }` (S2, T7: `windowRange` from decision timestamps).

Migration (S12): the `selfReview` fill goes in `parseState` at the E11 env fill site (`agent-state.ts:314-321`), no version bump. `createDefaultState` (`agent-state.ts:141`) gets the field too. Initialize `turnsSince: 0` (not 999): on a fresh persona, the debounce passes when `lastAt === 0` (never reviewed), so the first review fires at the first eligible trigger without burning an hourly slot on an empty window. `windowStart: 0` (the first cap check resets it). `pendingPeriodic: false`. `lastInjectAt: 0`. The `provenance` field is optional, so no migration needed for existing `MemoryEntry` records.

## 5. Configuration surface

Options arrive through `--settings` `pluginConfigs["agentic-plugin"].options` and are read as `cfg.<name>` at `index.ts:319-326` (S6). Four new options:

| Option | Default | Purpose |
|---|---|---|
| `selfReviewStreak` | 3 | Error-streak threshold for the reactive trigger |
| `selfReviewEveryTurns` | 20 | Completed-turns threshold for the periodic trigger |
| `selfReviewDebounceTurns` | 5 | Minimum turns between reviews (debounce) |
| `selfReviewMaxPerHour` | 2 | Maximum reviews per 3600000 ms (cap) |

The short profile (`PROFILE=short`) sets these through `emit_settings_json` in `live-common.sh` so the suite does not wait 20 real turns (e.g. `selfReviewEveryTurns: 3`, `selfReviewDebounceTurns: 1`).

## 6. Files to touch

| File | Change |
|---|---|
| `hooks/self-review.ts` | New: pure module (S13). `shouldSelfReview(state, opts, now, trigger)`, `buildSelfReviewInput(state, now)`, `dedupeSelfReview(memory, text)`, `evictSelfReview(memory)`. Takes data only (state slices, `now`, the four options), never `$`. Covered by `check-loader-rule.mjs` automatically (`:58-59` scans every `hooks/*.ts`). |
| `hooks/index.ts` | Config reads, tick single execution site (S9: after owner + in-flight checks, priority pendingPeriodic > everyTurns > reactive), `goal_done` flag (S9: sets `pendingPeriodic = true` only), turn counting in `turn.complete`, lesson injection in `prompt.submit` with `lesson_inject` (S11: gates on `lastInjectAt`), summary line, `runSelfReview` wiring (S13: calls the pure functions, does the `$.model.complete` call, pushes, persists) |
| `hooks/agent-state.ts` | `selfReview` field in `MonitorState` (with `windowStart`, `pendingPeriodic`, `lastInjectAt`), `source` union + `provenance` in `MemoryEntry`, fill in `parseState` at the E11 site (`:314`) (S12), `createDefaultState` (`:141`) |
| `.kit/live-self-review-test.sh` | New: acceptance suite (red-then-green), reusing `live-errorstreak-test.sh` induction |
| `.kit/self-review-unit-test.mjs` | New: unit tests for `shouldSelfReview` debounce + cap (S10: third review in the hour refused, review at plus one hour allowed), eviction, dedupe, `buildSelfReviewInput` filtering (S5). Imports `../hooks/self-review.ts` directly (S13). |
| `.kit/live-common.sh` | `emit_settings_json`: add the four self-review options to the short profile |

## 7. Invariants

1. **One model call per review.** `$.model.complete`, `haiku`, `maxTokens: 80`. No retries, no chaining. Ceiling: `selfReviewMaxPerHour` (default 2), with the hourly window reset (S10).
2. **Lessons are bounded.** Max 5 live per persona with `source === "self-review"`. Eviction only touches `source === "self-review"` entries, never a user's pinned memory (S8).
3. **Provenance is data the code attaches.** `runSelfReview` fills `provenance` from the input window it sent. The model does not emit provenance (S2).
4. **The debounce is the hard guard.** 5 completed turns minimum between reviews (S3: turns, not ticks). Passes when `lastAt === 0` (never reviewed) (S12). The 2/hour cap (with reset, S10) is the second guard.
5. **The code owns the trigger.** The model never decides whether a review is due. It only returns one sentence or `NONE` (S2).
6. **No transcript reconstruction.** All input is from session state. No disk read of the full transcript.
7. **Suite never hardwires green.** Red run at HEAD before code: F2 and F3 fail, exit 1. Green run: all pass, exit 0.
8. **The model returns one sentence or NONE.** If `NONE`, no lesson is written, but the `self-review` decision is still pushed (the review happened).
9. **One execution site.** The tick handler is the only place where `runSelfReview` is called. `goal_done` sets `pendingPeriodic = true` and nothing else (S9). The `turn.complete` handler only counts turns (S3).
10. **Pure module.** `shouldSelfReview`, `buildSelfReviewInput`, `dedupeSelfReview`, `evictSelfReview` live in `hooks/self-review.ts`, take data only, never `$` (S13). `index.ts` keeps only the wiring.

## 8. Acceptance test (exact)

**Suite command:**
```bash
cd D:/DeepSeekHarness/agentic-plugin && PROFILE=short bash .kit/live-self-review-test.sh
```

**Induction** (reusing `live-errorstreak-test.sh` pattern): prompts that trigger tool errors. A turn counts as an error turn when `reason === "error"` or `toolErrors > 0` (`agent-state.ts:519`). Three consecutive error turns.

**Assertions** (on persisted facts, not the ephemeral summary, S7):
```
F1: decisions log contains action=error_streak (proves streak reached >= 3; the live `consecutiveErrorTurns` counter is reset by `turn.complete` via `applyTurnToErrors`, so the durable proof is the decision, not the counter)
F2: decisions log contains action=self-review, detail starts with "reactive:" (assert-decisions.js)
F3: memory array contains MemoryEntry with source="self-review" and provenance.decisionTimestamps non-empty (store read)
F4: decisions log contains action=lesson_inject (assert-decisions.js)
F5: monitor.selfReview.count >= 1 (store read)
F6: monitor.selfReview.lastAt > 0 (store read; review was executed)
```

**Gating:** `wait_for_fact` on each decision and store fact, never on the clock (protocol line 24).

**Red run (at HEAD, before code):** F2 fails (no `self-review` decision), F3 fails (no `source: "self-review"` entry), F4 fails (no `lesson_inject`), F5 fails (no `selfReview` field, count is 0), F6 fails (no `lastAt` or 0). F1 passes (error_streak decision exists from the induction). Exit 1.
**Green run (after code):** All F1-F6 pass. Exit 0.
Both exit codes pasted in the completion entry.

## 9. Answers to the Reviewer's three questions (decided 2026-09-08, Reviewer)

1. **Debounce unit.** Completed turns, not ticks. Ticks fire every 30s while idle and carry no new evidence; a turn does. 5 turns, as `selfReviewDebounceTurns`.
2. **Injection surface.** Both. Primary: the `prompt.submit` context injection (next to `[ENV]`, `index.ts:2143-2155`), one line, newest 5 lessons, ~500 chars, only when newer than the last injection. Secondary: the classify summary (`index.ts:1169`), same line, free and helps the controller. (T6: aligned to `slice(-5)` / newest 5 in code.)
3. **Confidence.** 0.5. Above the 0.3 recall floor (`index.ts:2159`), below anything a user stated. The distill path uses 0.4 for a single-turn fact; a streak-derived lesson has more evidence but is still one sample.

## 10. Revision table

| Finding | What was done | Where | Status |
|---|---|---|---|
| S1 | Replaced `$.llm.ask` with `$.model.complete({ model: "haiku", maxTokens: 80 })`. Added `"self-review"` to `MemoryEntry.source` union. F3 asserts on `source: "self-review"`, not `kind: "lesson"` alone. | Section 2 rows 1, 3, 5, 6; section 3 rows 4-5; section 4; section 8 F3 | Done |
| S2 | Removed provenance tag from model output. Added `provenance?` to `MemoryEntry` (optional). `runSelfReview` fills it from the input window. Invariant 3 rewritten: code attaches provenance, model returns sentence or NONE. | Section 2 row 3; section 3 row 5; section 4; invariant 3, 8 | Done |
| S3 | One hook site: the tick's error-streak branch (reactive) and the tick's periodic check. `turn.complete` handler only does `turnsSince += 1`. Section 3 rewritten with the single-site structure. | Section 2 row 4; section 3 (all rows); section 4 | Done |
| S4 | Two triggers: reactive (error streak) and periodic (goal_done OR every 20 turns). Decision record carries which trigger fired. | Section 2 row 1; section 3 rows 2-3 | Done |
| S5 | Input window filtered to worker-facing actions (exclude `self-review`, `controller_tick`, `env_inject`, `heartbeat`). Live self-review lessons passed as "already known, do not repeat". Dedupe by normalized text. | Section 2 row 2; section 3 row 5 step 4 | Done |
| S6 | Four options in the config surface: `selfReviewStreak`, `selfReviewEveryTurns`, `selfReviewDebounceTurns`, `selfReviewMaxPerHour`. Short profile sets them via `emit_settings_json`. | Section 2 rows 1, 4, 5; section 3 row 1; section 5 | Done |
| S7 | F4 changed from summary assertion to `lesson_inject` decision assertion. All assertions on persisted facts. Gating on `wait_for_fact`. Reusing `live-errorstreak-test.sh` induction. Induction method stated. Red run defined as F2/F3/F5/F6 fail. No `CROSSDIR`. | Section 2 row 6; section 3 row 6; section 8 | Done |
| S8 | Eviction only touches `source === "self-review"`. `pinned: false` by default. Confidence 0.5 (above 0.3 recall floor). | Section 2 row 3; section 3 row 7 (eviction); section 9 Q3 | Done |
| S9 | `goal_done` handler runs inside `tool.call` (`index.ts:1617`), not a good site for an awaited model call. Changed to set `pendingPeriodic = true` only; the tick is the single execution site. | Section 2 row 1; section 3 (goal_done flag + tick single site); invariant 9 | Done |
| S10 | Hourly cap never reset. Added `windowStart` to state; reset `count = 0` when `now - windowStart >= 3600000`. Unit test pins it. | Section 2 row 4; section 4 (state); section 3 (cap check); invariant 1, 4 | Done |
| S11 | `lastInjectAt` missing. Added to state; set when `lesson_inject` decision is pushed; gates injection. | Section 2 row 4; section 4 (state); section 3 (lesson injection) | Done |
| S12 | Migration site and the 999 hack. Fill in `parseState` at the E11 site (`agent-state.ts:314`), no version bump. `createDefaultState` gets the field. `turnsSince: 0` init. | Section 4 (migration); section 2 row 1 (debounce) | Done |
| S13 | Pure functions in closure cannot be imported. Moved to `hooks/self-review.ts` (data only, never `$`). Covered by `check-loader-rule.mjs` automatically. | Section 3 (all function rows); section 6 (files); invariant 10 | Done |
| T4 | Prompt forced a lesson even when the worker was doing fine. Rewrote to "If there is a clear, actionable lesson ... respond with the lesson text only. If the worker is doing fine and there is nothing worth distilling, respond with exactly: NONE." Code gate: `/^\s*NONE\s*$/i`. | Section 2 row 3 (Output); `hooks/self-review.ts` prompt; `hooks/index.ts` gate | Done |
| T5 | `NOISE_ACTIONS` over-excluded worker-facing signal (`deny`, `block`, `score`, `error_streak`, `paused_by_controller`, `done`, `activated`). Removed from the noise set; they are now included in the review window. | Section 2 row 2 (Input); `hooks/self-review.ts` `NOISE_ACTIONS` | Done |
| T6 | Plan doc said "newest 2 lessons" for injection; code uses `slice(-5)` (newest 5). Aligned doc to code. | Section 9 Q2; section 2 row 2 | Done |
| T7 | `provenance.turnRange` was turn-index-based (fragile, not anchored to evidence). Replaced with `windowRange?: [number, number]` computed from `decisionTimestamps[0]` and `[last]` (the actual time span of the input window). `trigger` type widened to `string`. | Section 2 row 3; section 4 (state); `hooks/agent-state.ts` `provenance`; `hooks/index.ts` wiring | Done |
| T8 | Suite used fixed `sleep` (clock-based) instead of fact-based gating. Replaced with poll-until-self-review-decision and poll-until-lesson_inject. Added `--debug-file` + fail-fast on "failed to load". Added F0 (no yield assertion). | Section 8 (suite); `.kit/live-self-review-test.sh` | Done |
| T9 | Suite lacked a pre-gate: two back-to-back runs could collide on persona claims. Added `wait_persona_free` to `live-common.sh`; self-review suite calls it before launch. | Section 8; `.kit/live-common.sh` `wait_persona_free`; `.kit/live-self-review-test.sh` | Done |
