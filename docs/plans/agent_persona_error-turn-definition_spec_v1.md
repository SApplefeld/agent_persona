# An error turn is a turn that ended in error, so ordinary tool failures no longer escalate to the operator

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-01

## Goal

When this ships, the error streak counts only turns whose completion reason is `error`. A turn that ends normally after a tool result flagged as an error, or after a call the plugin denied, counts as a good turn and zeroes the streak. The per-turn tool-error count is still recorded on the state for the record and the tests that read it, and it no longer feeds the streak. The re-fire rule, the self-review trigger and the environment facts line keep their code and inherit the narrower meaning. The maintainer reference states the new definition where it stated the old one.

## Intent

The operator's frame, on the ASSISTANT persona's relay thread on 2026-10-01, as the ASSISTANT recorded it: "individual tool failures are not a turn failure at all in my mind, that's just a normal part of work." The operator ruled that the fix goes through a plan and not an ad hoc edit.

The trigger. On 2026-10-01 the DEV-PLUGIN persona relayed "Error streak 3 turns; escalating" to the operator while its turns were ending normally and its work was healthy. In the fifteen minutes before the ask it had two file reads refused for size and three shell commands that exited non-zero, each retried or handled in the same turn. The persona store on that machine holds about a dozen such asks, every one expired unanswered and re-raised once.

What done needs to do: make a turn an error turn only when the harness says the turn itself ended in error; keep the tool-error count on the state as a record; keep every other reader of the streak as it is; make the tick suite prove a normal turn carrying a tool error and a denied call does not advance the streak, and prove a turn ending in error still does; and correct the maintainer reference.

What done does not need to do: no new signal for a worker that keeps hitting the same plugin refusal, since the nudge discipline and the controller question already read a stalled worker; no change to the ask's text, its re-raise window or its expiry; no change to the re-fire rule; no change to the self-review trigger's threshold; no edit to any persona store; no rename of the tool-error field or of the denial sites that feed it.

Alternatives refused:
- Keep a plugin denial as an error turn and drop only the flagged tool result. Refused: a denial is the plugin refusing one call, which the model handles in the same turn as it handles a failed read. The fleet reading refuses the architect every time it asks, and a worker's out-of-turn resume is refused once and moves on. Three such turns in a row are routine, not a failure, which is the operator's ruling applied to the plugin's own refusals.
- Zero the streak when the controller handles it, so a re-fire needs three fresh error turns. Refused: a good turn already zeroes the streak, so a re-fire after an expired ask means the errors never stopped, which is when the operator should hear again. The volume the operator saw came from the definition, not the re-fire rule.
- Drop the tool-error count from the state. Refused: about twenty tick cases pin it as the observable that a denial happened, and it costs nothing to keep.

Rulings after the spec shipped: none yet.

Provenance: distilled by the ARCHITECT persona on 2026-10-01 from the ASSISTANT's record of the operator's words, `hooks/agent-state.ts`, `hooks/index.ts` and `.kit/controller-tick-test.mjs` at `5e7866d`, and `docs/archive/agentic-plugin_env-monitor_v1.md` decision E8.

## Approach

**The definition lives in one pure helper, and the fix is one clause.** `applyTurnToErrors` in `hooks/agent-state.ts:1906-1925` reads a turn as an error turn where its reason is `error` or its tool-error count is above zero. The count comes from `toolErrorsThisTurn` in `hooks/index.ts`, reset at `turn.start` (`:9626`), folded at `turn.complete` (`:9963-9968`), and incremented at 112 sites. One site, `:12964`, counts any tool result whose `isError` is true, which is the leg that counted the DEV-PLUGIN persona's refused reads and non-zero shell exits. The other 111 are the plugin's own denials: the `agentic_identity` name check at `:11162`, the root "no bash" constraint at `:12952`, and the goal, task and record tool refusals between them, each returning `deny` within a few lines of the increment. That classification is by shape, a `deny:` return within four lines of each increment, over all 112 sites, so no site was sampled. Section 1 changes the helper so the reason alone decides, and leaves the count written to `toolErrorsLastTurn` as it is. The helper's signature and its callers do not change.

**The original definition was chosen for observability, and the test it served has another inducer.** Decision E8 in `docs/archive/agentic-plugin_env-monitor_v1.md` defined the streak "on what the plugin can observe" and used the root "no bash" constraint to induce it in the tick suite. The suite now drives streaks with turn reason `error` directly, in the three no-active-node cases at `.kit/controller-tick-test.mjs:19618-19750` and in the shared driver `abkDriveStreak`. So the one case still using the deny inducer, `caseS13_errorStreak_threeDeniedTurnsOpenAnAsk` at `:19583`, moves to the same inducer and keeps every assertion about the ask it opens.

**The re-fire rule stays.** The controller at `hooks/index.ts:7818` fires at a streak of three and again whenever an error turn lands after the last handling. The streak zeroes on any good turn, so under the narrow definition a re-fire means consecutive error turns continued through an expired ask. The case `caseS13_errorStreak_noActiveNode_reFireAfterHandled_stillOpensNoAsk` pins that rule and passes unchanged.

**The other readers change nothing.** The self-review's reactive trigger reads the streak at `hooks/self-review.ts:49` and names it in its prompt at `:124`, and the environment facts line reads it at `hooks/agent-state.ts:201`. Each reads the stored number, so each inherits the meaning. `.kit/self-review-unit-test.mjs` sets the number directly and is unaffected.

**Sweep for the surfaces stating the rule.** Searches run 2026-10-01 at `5e7866d`: a case-insensitive grep for `error turn`, `error streak`, `error_streak`, `consecutiveErrorTurns`, `toolErrors` and `tool error` over the tree outside `docs/archive/` and `node_modules/`. It found the helper, the three readers above, the state fixtures under `.kit/fixtures/` (zeroed counts, unaffected), the tick suite's streak cases and its tool-error pins, `README.md:801` (which states what a streak does and not what an error turn is), and `docs/architecture.md:418`, whose cause column reads "three or more turns in a row ended in error or carried a tool call the plugin denied". The archived plan keeps its text, since an archive is history.

## Sections of Work

### 1. The reason alone decides an error turn, and the suite proves both directions
Model: sonnet
`applyTurnToErrors` in `hooks/agent-state.ts` reads `isErrorTurn` from `turn.reason === "error"` alone and still writes `turn.toolErrors` to `toolErrorsLastTurn`. The comment above it states the rule in one sentence: a turn is an error turn when the harness ends it with reason `error`, and a tool error or a denial inside a turn that ends normally is work, not failure. `docs/architecture.md`'s `error_streak` row changes its cause to three or more turns in a row that ended in error, and drops the denied-call clause. `README.md:801` gains one sentence ahead of its first: an error turn is one whose completion reason is `error`, and a tool error or a denied call inside a turn that ends normally is not one. The tick suite's `caseS13_errorStreak_threeDeniedTurnsOpenAnAsk` drives its three turns with reason `error`, as `abkDriveStreak` does, over the same tree and keeps its ask assertions; its name and the `deny` entries in its expected order change to match, since the root constraint no longer takes part. No increment site in `hooks/index.ts` changes.
Acceptance:
- A new tick case drives three turns over a tree with an active plan entry, each turn carrying one tool result with `isError` true and one call the root "no bash" constraint denies, each ending with reason `completed`. After two ticks: `consecutiveErrorTurns` is 0, `toolErrorsLastTurn` is 2, no `error_streak` or `ask_opened` decision is logged, `pendingAskId` is unset, no ask record is in the store and no toast was shown.
- The same case's control drives the same tree with three turns ending with reason `error` and no tool call: `consecutiveErrorTurns` is 3 at the first tick, one `error_streak` and one `ask_opened` decision are logged, and one ask record is in the store.
- `caseS13_errorStreak_threeDeniedTurnsOpenAnAsk`, renamed, passes on the reason inducer with its no-block, no-pause and ask-is-the-hold assertions unchanged.
- The three no-active-node cases, `caseAbk1_errorStreakKeepsTheOpenAsk` and every case pinning `toolErrorsLastTurn` pass unchanged.
- `npx tsc --noEmit` exits 0. `node .kit/controller-tick-test.mjs` exits 0 and prints no `FAIL:` line. `node .kit/self-review-unit-test.mjs` exits 0.
Files in scope: `hooks/agent-state.ts` (the helper and its comment), `docs/architecture.md` (the `error_streak` row), `README.md` (the Ask wait paragraph at line 801), `.kit/controller-tick-test.mjs` (the renamed case, the new case and its control, the case list near line 3780).
Tests: the new case locks the ruling in both directions, since a helper edit that drops the reason leg by mistake would leave the control red, and one that keeps the count leg would leave the main case red.
References: `.kit/controller-tick-test.mjs:19618-19662` is the sibling for the new case's harness setup and store checks, and `:19583-19616` for the active-entry tree and the ask assertions.

## Out of Scope

- A signal for a worker that keeps calling what the plugin refuses. The nudge discipline and the controller question read a stalled worker today.
- The ask's text, its 15-minute re-raise, its 60-minute expiry and the re-fire rule.
- The self-review trigger's threshold and the environment facts line.
- Renaming `toolErrorsThisTurn`, `toolErrorsLastTurn` or any denial site.
- The backlog item on a background subagent's completion reaching `turn.complete` under the parent's turn, which names `toolErrorsThisTurn` among four readers. Under this plan that reader no longer moves the streak, and the item's other three readers stand.
- Any edit to a persona store, including the expired ask records on the DEV-PLUGIN persona's machine.

## Assumptions

- assumed 2026-10-01 (source: the ASSISTANT's record of the operator's words): a plugin denial is an individual tool failure under the operator's ruling, so it does not count either; reversal: one clause in the helper restoring the count leg for denials alone, plus a second counter, since the count today mixes denials with flagged results.
- assumed 2026-10-01 (default): the plan is queued with the persona-plugin worker on the ASSISTANT's report that the operator directed it, and the pull request gate on `main` is the review; reversal: the coordinator pulls the entry before the worker opens a pull request, or the operator closes the pull request.
- assumed 2026-10-01 (default): a harness that ends a turn with reason `error` for an API or engine failure makes three such turns a signal the operator wants; reversal: raise the threshold or drop the ask, each one constant.

## Operator Verification

- After the plugin cache updates and a persona relaunches, a persona that retries a refused file read or sees a shell command exit non-zero inside a healthy turn opens no "Error streak" ask. An `Error streak` ask on a persona whose turns ended normally reopens this plan.

## Open Questions

None.

## Chapters
