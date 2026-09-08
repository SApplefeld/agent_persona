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
| 1 | **Trigger** | Two triggers, both in code, sharing the debounce and the cap: (a) **reactive**: `env.errors.consecutiveErrorTurns >= 3` AND `turnsSinceLastReview >= 5` (the existing error-streak branch, `index.ts:685-709`); (b) **periodic**: on `goal_done` (node completion) OR every `selfReviewEveryTurns` (default 20) completed turns, whichever comes first, AND `turnsSinceLastReview >= 5`. The decision record carries which trigger fired (`reactive` or `periodic`). | Error streak alone is not "periodic" (S4). A session that makes no errors never learns. Node completion is a natural review point ("what did finishing this node teach"). The 20-turn periodic trigger catches sessions that make progress but no errors. Both share the debounce and cap. |
| 2 | **Input** | Last 10 decisions from `sess.state.decisions`, **filtered** to worker-facing actions (exclude `self-review`, `controller_tick`, `env_inject`, `heartbeat`). Plus `env.errors` counters. Plus the active goal node. Plus the live self-review lessons (newest 2, `source === "self-review"`) passed as "already known, do not repeat". Total input: ~2500 chars. | Unfiltered decisions include noise (`controller_tick`, `env_inject`, `heartbeat`) and the review's own prior output (S5). Passing known lessons prevents the model from repeating them. All from session state, no transcript reconstruction. |
| 3 | **Output** | A `MemoryEntry` with `kind: "lesson"`, `source: "self-review"` (S1), `text` = one sentence (max 200 chars), `confidence: 0.5` (answer to Q3), `pinned: false` (S8), and `provenance?: { decisionTimestamps: number[]; turnRange: [number, number]; streak: number; trigger: "reactive" | "periodic" }` (S2). The model returns one sentence or `NONE`; the code decides everything else. If the reply is `NONE` or empty, no lesson is written. | The existing distill path (`index.ts:1570-1600`) already writes `kind: "lesson"`, `source: "distilled"`, `confidence: 0.4`. Adding `"self-review"` to the `source` union makes self-review lessons distinguishable as data (S1). Provenance is data the code attaches, not prose the model emits (S2). `pinned: false` because `pinned` marks user intent (S8). `confidence: 0.5` is above the 0.3 recall floor (`index.ts:2159`), below anything a user stated. |
| 4 | **Idempotence** | After a review (whether it produced a lesson or not), push a decision `{ loop: "monitor", action: "self-review", detail: "<trigger>: <first 80 chars of lesson or NONE>" }`. Reset `selfReview.turnsSince` to 0. Increment `selfReview.count`. Set `selfReview.lastAt`. The `turn.complete` handler increments `selfReview.turnsSince += 1` (S3). The 2/hour cap checks `selfReview.count` and `selfReview.lastAt`. | One review, one hook site (S3). The `turn.complete` handler's only job is counting turns. The debounce (5 turns) and the cap (2/hour) together prevent loops. |
| 5 | **Cost bound** | One `$.model.complete` call per review, `model: "haiku"`, `maxTokens: 80` (S1, matching the distill path at `index.ts:1570-1577`). Input: ~2500 chars. Output: ~200 chars. Hard ceiling: `selfReviewMaxPerHour` (default 2) per 3600000 ms. | `$.llm.ask` does not exist (S1). The API is `$.model.complete({ model, prompt, maxTokens })` (`claude-code.d.ts:612-629`), already used four times in `index.ts`. Haiku + 80 tokens is the same cost profile as the distill path. |
| 6 | **Acceptance test** | Suite `.kit/live-self-review-test.sh`, reusing `live-errorstreak-test.sh`'s induction and `assert-decisions.js` pattern (S7). Errors induced by prompts that trigger tool errors (a turn counts as an error turn when `reason === "error"` or `toolErrors > 0`, `agent-state.ts:519`). Assertions on persisted facts (not the ephemeral summary): F1 error streak >= 3; F2 `self-review` decision in decisions log with `detail` carrying the trigger name and first 80 chars; F3 `MemoryEntry` with `source: "self-review"` in memory array with `provenance` field; F4 `lesson_inject` decision in decisions log (the injection path, `index.ts:2149` pattern); F5 `selfReview.count` = 1; F6 `selfReview.turnsSince` reset to 0. Gate on `wait_for_fact` or store state, never on the clock. No `CROSSDIR`. Red run (at HEAD before code): F2 and F3 fail, exit 1. Green run: all pass, exit 0. | The summary is a local string handed to `$.model.classify` (S7); nothing persists it. The `[ENV]` injection pushes an `env_inject` decision (`index.ts:2149`); the lesson injection will push a `lesson_inject` decision the same way. That is what the suite asserts on. Reusing the errorstreak suite's induction avoids inventing a second one (S7). |

## 3. Hook points in `index.ts`

The self-review hooks into existing paths. No new channel, no new event. **One review, one site** (S3).

| What | Where | How |
|---|---|---|
| **Config read** | `index.ts:319-326` (options block) | Add `selfReviewStreak` (default 3), `selfReviewEveryTurns` (default 20), `selfReviewDebounceTurns` (default 5), `selfReviewMaxPerHour` (default 2) to the `cfg` reads. Read as `cfg.<name>` per the existing pattern. |
| **Reactive trigger** | `index.ts:685-709` (error-streak branch, inside the tick handler) | After the existing `handledAt` set and decision pushes, add: `if (shouldSelfReview(sess, "reactive")) { await runSelfReview(sess, "reactive"); }`. This is the only site where the model call, memory write, decision push, and state update happen. |
| **Periodic trigger** | `index.ts` `goal_done` handler (the `completeLeaf` site) AND `turn.complete` handler | On `goal_done`: `if (shouldSelfReview(sess, "periodic")) { await runSelfReview(sess, "periodic"); }`. On `turn.complete`: `selfReview.turnsSince += 1` (S3: counting, not reviewing). The 20-turn check: `if (selfReview.turnsSince >= cfg.selfReviewEveryTurns && shouldSelfReview(sess, "periodic")) { await runSelfReview(sess, "periodic"); }` in the tick handler, before the idle gate. |
| **`shouldSelfReview(sess, trigger)`** | `index.ts` (new function) | Checks: `selfReview.turnsSince >= selfReviewDebounceTurns` AND `selfReview.count < selfReviewMaxPerHour` (within last 3600000 ms). For `reactive`: also `env.errors.consecutiveErrorTurns >= selfReviewStreak`. Returns boolean. |
| **`runSelfReview(sess, trigger)`** | `index.ts` (new async function) | 1. Build input: filtered decisions (exclude `self-review`, `controller_tick`, `env_inject`, `heartbeat`), `env.errors`, active goal node, live self-review lessons. 2. `await $.model.complete({ model: "haiku", prompt: <input>, maxTokens: 80 })`. 3. If reply is `NONE` or empty: push `self-review` decision with `detail: <trigger>: NONE`, update state, persist. 4. If reply is a sentence: dedupe by normalized text (S5, `index.ts:1579-1582` pattern). If not a dupe: push `MemoryEntry` with `source: "self-review"`, `provenance` from the input window. Push `self-review` decision. 5. Update `selfReview.{count, lastAt, turnsSince}`. 6. `persist()`. |
| **Lesson injection** | `index.ts:2143-2155` (the `[ENV]` block area, in the `prompt.submit` handler) | After the `[ENV]` block, add: `const recentLessons = sess.state.memory.filter(m => m.kind === "lesson" && m.source === "self-review" && Date.now() - m.createdAt < 3600000).slice(-2); if (recentLessons.length > 0 && <newer than last injection>) { contextBlocks.push(`LESSON: ${recentLessons.map(l => l.text).join(" | ")}`); sess.state.decisions.push({ action: "lesson_inject", detail: ... }); }`. The "only when newer than last injection" gate mirrors the G4 "only when notable" rule (answer to Q2). |
| **Summary line** | `index.ts:1155-1178` (the summary builder) | After the `envLine` block, add the same `LESSON:` line (the summary is free and helps the controller judge on-goal, answer to Q2). |
| **Turn counting** | `index.ts:1439-1442` (the `turn.complete` handler, after `applyTurnToErrors`) | `sess.state.monitor.selfReview.turnsSince += 1;`. This is the ONLY thing the `turn.complete` handler does for self-review (S3). |
| **Eviction** | `index.ts` (in `runSelfReview`, after the new lesson is pushed) | Count `sess.state.memory.filter(m => m.source === "self-review")`. If > 5, evict the oldest by `createdAt` (only `source === "self-review"` entries, never a user's pinned memory, S8). |

## 4. State additions

`MonitorState` (agent-state.ts:102-110) gains:

```
selfReview: {
  count: number;          // reviews in the last 3600000 ms
  lastAt: number;         // timestamp of the last review
  turnsSince: number;     // completed turns since the last review
}
```

`MemoryEntry` (agent-state.ts:5-15) gains:
- `source` union: add `"self-review"` to `"worker" | "user" | "distilled"` (S1).
- Optional field: `provenance?: { decisionTimestamps: number[]; turnRange: [number, number]; streak: number; trigger: "reactive" | "periodic" }` (S2).

Migration: if `monitor.selfReview` is absent, fill with `{ count: 0, lastAt: 0, turnsSince: 999 }` (999 ensures the first review is eligible after 5 turns). The `provenance` field is optional, so no migration needed for existing `MemoryEntry` records.

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
| `hooks/index.ts` | Config reads, `shouldSelfReview()`, `runSelfReview()`, hook in error-streak branch, periodic trigger in tick + `goal_done`, turn counting in `turn.complete`, lesson injection in `prompt.submit`, eviction, summary line |
| `hooks/agent-state.ts` | `selfReview` field in `MonitorState`, `source` union + `provenance` in `MemoryEntry`, migration, default in `createDefaultState` |
| `.kit/live-self-review-test.sh` | New: acceptance suite (red-then-green), reusing `live-errorstreak-test.sh` induction |
| `.kit/self-review-unit-test.mjs` | New: unit tests for `shouldSelfReview` debounce, eviction, dedupe, provenance |
| `.kit/live-common.sh` | `emit_settings_json`: add the four self-review options to the short profile |

## 7. Invariants

1. **One model call per review.** `$.model.complete`, `haiku`, `maxTokens: 80`. No retries, no chaining. Ceiling: `selfReviewMaxPerHour` (default 2).
2. **Lessons are bounded.** Max 5 live per persona with `source === "self-review"`. Eviction only touches `source === "self-review"` entries, never a user's pinned memory (S8).
3. **Provenance is data the code attaches.** `runSelfReview` fills `provenance` from the input window it sent. The model does not emit provenance (S2).
4. **The debounce is the hard guard.** 5 completed turns minimum between reviews (S3: turns, not ticks). The 2/hour cap is the second guard.
5. **The code owns the trigger.** The model never decides whether a review is due. It only returns one sentence or `NONE` (S2).
6. **No transcript reconstruction.** All input is from session state. No disk read of the full transcript.
7. **Suite never hardwires green.** Red run at HEAD before code: F2 and F3 fail, exit 1. Green run: all pass, exit 0.
8. **The model returns one sentence or NONE.** If `NONE`, no lesson is written, but the `self-review` decision is still pushed (the review happened).

## 8. Acceptance test (exact)

**Suite command:**
```bash
cd D:/DeepSeekHarness/agentic-plugin && PROFILE=short bash .kit/live-self-review-test.sh
```

**Induction** (reusing `live-errorstreak-test.sh` pattern): prompts that trigger tool errors. A turn counts as an error turn when `reason === "error"` or `toolErrors > 0` (`agent-state.ts:519`). Three consecutive error turns.

**Assertions** (on persisted facts, not the ephemeral summary, S7):
```
F1: env.errors.consecutiveErrorTurns >= 3 (store read)
F2: decisions log contains action=self-review, detail starts with "reactive:" (assert-decisions.js)
F3: memory array contains MemoryEntry with source="self-review" and provenance.decisionTimestamps non-empty (store read)
F4: decisions log contains action=lesson_inject (assert-decisions.js)
F5: monitor.selfReview.count = 1 (store read)
F6: monitor.selfReview.turnsSince = 0 (store read)
```

**Gating:** `wait_for_fact` on each decision and store fact, never on the clock (protocol line 24).

**Red run (at HEAD, before code):** F2 fails (no `self-review` decision), F3 fails (no `source: "self-review"` entry), F4 fails (no `lesson_inject`). F1 passes (error streak exists from the induction). F5 and F6 fail (no `selfReview` field). Exit 1.
**Green run (after code):** All F1-F6 pass. Exit 0.
Both exit codes pasted in the completion entry.

## 9. Answers to the Reviewer's three questions (decided 2026-09-08, Reviewer)

1. **Debounce unit.** Completed turns, not ticks. Ticks fire every 30s while idle and carry no new evidence; a turn does. 5 turns, as `selfReviewDebounceTurns`.
2. **Injection surface.** Both. Primary: the `prompt.submit` context injection (next to `[ENV]`, `index.ts:2143-2155`), one line, newest 2 lessons, ~300 chars, only when newer than the last injection. Secondary: the classify summary (`index.ts:1169`), same line, free and helps the controller.
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
