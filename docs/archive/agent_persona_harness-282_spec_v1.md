# The plugin reads the engine's 2.1.280 contract, so a delivered record is stamped again, the injected context reaches the model again, and the typings match the engine

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-25

## Dispatch Authorization

The operator asked the ARCHITECT on 2026-09-25, on its own channel, to implement the emergency fix for the planner's Haiku leak and the breaking changes of Claude Code 2.1.280 and later inline, in that session, while the DEV-PERSONA worker finishes the nudge-state plan. DEV-PERSONA raised the turn-origin half as a `[FINDING]` the same day (record `ARCHITECT-4961bf83-1013-44e6-9dc7-0761f5b8bdaa-1`). The work shares one branch and one pull request with the planner-catch plan (`docs/plans/agent_persona_planner-catch_spec_v1.md`), since both are the same engine change read at different sites, and both are live cost or lost function on every running persona. The line numbers below are as of `fb753eb`.

## Goal

When this ships, on Claude Code 2.1.282 a turn the plugin submitted itself is matched to the entry it submitted, so a delivered record is stamped with its turn, its reply is filed, and the effort gate reads a coordinator delivery as one. The `[GOAL TREE]`, `[GOAL QUEUE]`, `[NO GOAL]`, `[ENV]`, `[LESSON]` and memory blocks reach the model again. The repository's engine typings are the ones the installed engine writes, so `tsc` reads the engine's contract rather than the one copied on 2026-09-09, and the plugin compiles clean against it.

## Intent

The frame: the operator's word on the channel, and DEV-PERSONA's finding that every plugin-submitted prompt reads unaccounted at `turn.start` since the engine update.

What the ARCHITECT confirmed at the source on 2026-09-25. The engine now presents a plugin-submitted prompt to the model inside a frame: `The agentic-plugin plugin sent a message:`, a newline, the submitted text, a blank line, then one sentence saying how the prompt reached the model. That frame is read verbatim from the ARCHITECT's own transcript of that day. Both the ARCHITECT's and DEV-PERSONA's stores show every `operator_delivered` followed by `turn_start` and then `operator_stamp_withheld` reading `(unaccounted turn)`, which is the two-key equality match at `hooks/index.ts:6482` failing on both keys. The engine's debug log for DEV-PERSONA's child shows `prompt.submit skipped: re-entry (the plugin's own code raised it; origin agentic-plugin)` before each such turn, so the plugin's own submits still skip its own `prompt.submit` hook and the origin readings are unaffected. The same log carries `[WARN] prompt.submit: agentic-plugin put 1 context entry (1585 characters) on its result after next(); not attached, the prompt had entered` on every external prompt, which is the handler at `hooks/index.ts:9163` building its blocks after `next` resolved. The typings the engine writes on 2.1.282, regenerated with the engine's own `/plugin-types` command in a scratch directory, declare `PromptSubmitInput.context` as attached on the way down only, `TurnCompleteInput.isAborted` in place of `aborted`, and `$.model.complete` resolving to `ModelCompleteResult`, which the planner-catch plan reads.

What done needs to do: match the submitted text found inside the turn's text; pass the context blocks down through `next`; read `isAborted`; take the engine's typings for `claude-code.d.ts` while keeping the repository's own `claude-code-mcp.d.ts`, which lists this plugin's tools rather than the scratch session's.

What done does not need to do: no change to the origin readings' own semantics; no repair of the bookkeeping that now runs before a hook beneath drops a prompt; no regeneration of `claude-code-mcp.d.ts`, whose contents depend on the session that writes it.

Alternatives refused:
- Strip the engine's frame by its literal text and compare equal. Refused: the frame names the plugin and reads as the engine's prose, which can change between releases; the submitted text being inside the turn's text is the invariant.
- Return the context on the result as before and also pass it down. Refused: the engine logs a block on the result after `next` as not attached, one warning per prompt, and the typings say the result carries the context that arrived.
- Keep the 2026-09-09 typings and cast at the six sites. Refused: the typings would keep saying `Promise<string>` for a call that resolves an object, so the next site written against them would repeat the planner leak.

Rulings: none at the write.

Provenance: the ARCHITECT's read of the two persona stores, the DEV-PERSONA child's debug log, its own transcript, and the regenerated typings, all on 2026-09-25.

## Approach

**Two rules for a turn's text, equality first.** `turnTextEquals`, `turnTextFrames` and `findExpectedTurn` sit beside `ExpectedTurn` in `hooks/index.ts`. Equality on either key is the first rule and the only one the origin readings take, since the engine never frames an external prompt. Framed containment is the second, for the expected-turn list alone: the key found between line breaks inside the turn's text, which is where the engine's frame puts the submitted text. `findExpectedTurn` prefers an exact match over the whole list before any framed one, so a foreign turn that quotes a queued entry's text whole takes it only where no entry equals the turn's text, and a quote inside a line never matches. An empty turn text matches nothing, and an empty key matches nothing, since an empty string is inside every text. The blind reviewer's finding on 2026-09-25, that bare containment let a stale short origin reading match a later framed turn and hand it the operator's origin kind, is what fixed this shape.

**The context rides down.** The `prompt.submit` handler builds every block before it calls `next`, then calls `next({ ...e, context: [...(e.context ?? []), ...blocks] })` and returns the result as it came. The reader arm calls `next(e)` and returns it as it came. One closure, `settleSubmit`, handles the drop and the settled text on both arms. The bookkeeping the blocks do (the `env_inject` and `lesson_inject` decisions, the lesson stamp, the memory access counts) now runs before the chain answers, and stands where a hook beneath drops the prompt, which is declared under Assumptions.

**The interruption flag.** `turn.complete` reads `isAborted`, and still reads `aborted` and the reason, so the harness's own driver, which passes `aborted: true, reason: "aborted"`, and an older engine both read as skipped.

**The typings.** `.claude/types/claude-code.d.ts` is the file the engine wrote on 2.1.282. `.claude/types/claude-code-mcp.d.ts` stays the repository's own, since the regenerated one lists the tools of the session that ran the command, and the plugins index file the command also writes is not added, since the header of `claude-code.d.ts` says it is optional and nothing here depends on another plugin's contract.

## Sections of Work

### 1. The wrapped turn matches
Model: opus
Locus: inline
Add `turnTextMatches` and route both `turn.start` finds through it. Add the regression case: a delivery submitted by the tick whose turn opens with the engine's frame around the submitted text takes the stamp and files its reply, and a control where the frame surrounds another record's text takes no stamp and logs the withheld line as unaccounted.
Acceptance: the case is green; the existing Section 12 J1, J2, K2 and L1 cases pass unchanged.
Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`.

### 2. The context passes down
Model: opus
Locus: inline
Restructure the handler as the Approach states. Update the tick test's `next` stubs at the `prompt.submit` call sites to echo the text and context they received, which is what core does, so the existing block assertions read the passed-down context. Add the case that reads the context the hook beneath received and that the result is returned as it came.
Acceptance: the case is green; every existing block case passes on the echoing stub; `tsc` is clean.
Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs`.

### 3. The typings and the flag
Model: sonnet
Locus: inline
Replace `.claude/types/claude-code.d.ts` with the engine's 2.1.282 file. Read `isAborted` at `turn.complete`. `tsc --noEmit` exit 0.
Acceptance: `tsc` exit 0 with the new typings; the tick suite passes on its own exit code.
Files in scope: `.claude/types/claude-code.d.ts`, `hooks/index.ts`.

## Out of Scope
- `claude-code-mcp.d.ts` and the plugins index the engine also writes.
- The channel log roll refusal, a separate backlog item.
- Any change to what the origin readings record.

## Assumptions
- assumed 2026-09-25 (source: the ARCHITECT's transcript and both stores): the engine frames a plugin-submitted prompt and opens the turn with the framed text, and the submitted text is inside it whole; reversal: a frame that alters the submitted text itself defeats containment, and the withheld line reading `(unaccounted turn)` after this ships is what reveals it.
- assumed 2026-09-25 (default): the bookkeeping the context blocks do may run before a hook beneath drops the prompt, costing one decision line or one lesson stamp on a rare drop; reversal: defer the bookkeeping to after `next` where the drop matters.
- assumed 2026-09-25 (default): the repository keeps its own `claude-code-mcp.d.ts`; reversal: regenerate it from a session that has this plugin's tools registered.

## Operator Verification
- After the plugin cache updates and a persona relaunches, a coordinator record's turn shows `turn_start` and no `operator_stamp_withheld`, and the record's reply is filed. What reopens the work: a withheld line reading `(unaccounted turn)` on a delivery turn.
- The engine's debug log for a relaunched child carries no `put 1 context entry ... after next()` warning, and the `[GOAL TREE]` or `[GOAL QUEUE]` block is visible in the model's prompt.

## Open Questions
- None.

## Related
- `docs/plans/agent_persona_planner-catch_spec_v1.md`: the same engine change at the completion sites; one branch and one pull request with this plan.
- `docs/plans/agent_persona_nudge-state_v1.md`: reads the ask slot and the lead at `turn.complete`, which this plan's `isAborted` read sits beside.

## Chapters

### Chapter 1: sections 1 to 3, shipped together with planner-catch (2026-09-25)

What shipped. `turnTextEquals`, `turnTextFrames` and `findExpectedTurn` beside `ExpectedTurn` in `hooks/index.ts`: the expected-turn find takes equality first and the framed match second, and the origin-reading find takes equality alone. The `prompt.submit` handler builds its blocks before `next`, passes them down after any context that arrived, and returns core's result through `settleSubmit` on both arms. `turn.complete` reads `isAborted`, and still `aborted` and the reason. `.claude/types/claude-code.d.ts` is the engine's 2.1.282 file; `claude-code-mcp.d.ts` stays the repository's. The tick test's `next` stubs at every `prompt.submit` call site echo the text and context they received, which is what core does, so the existing block assertions read what passed down; one control case now reads the context the hook beneath received rather than the result.

Tests. Four cases: the framed delivery turn taking the stamp with a control on another record's framed text, an operator turn quoting the entry inside a line taking no stamp while the framed form after it does, the context blocks riding down through `next` with the result returned as it came, and `goal_done` on the root in its admitted shape, its three refused shapes, the in-flight planner refusal, the blocked-root completion and the refused-write denial. Red on `fb753eb`: the wrapped case's three checks, the context case's two and the root case's seven all failed, inside the 22 failures the planner-catch Chapter records. Green: exit 0, 3433 OK. The first green attempt failed five older block cases whose call sites reached the handler through a local alias the stub rewrite had not covered; the rewrite was extended to those sites and the suite re-run, which is the green figure above.

Surprises. None beyond those the planner-catch Chapter records.

Reviews. Recorded in the planner-catch plan's Chapter 2, since the two plans shipped as one changeset.

Next: the pull request, then the operator-verification checks above after the plugin cache updates.
