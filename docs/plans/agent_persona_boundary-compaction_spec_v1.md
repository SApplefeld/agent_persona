# The plugin banks a compaction boundary at each turn's end, so an unleashed persona compacts on its own

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-24

## Dispatch Authorization

The operator approved this plan's shape on the ASSISTANT relay thread on 2026-09-24 ("I'm good with all of the above. Please proceed as recommended." and, on the mechanism, "I'm good with everything you've suggested. Please proceed as recommended."). This is Plan A of the two persona-side plans that follow the nudge-state plan. It carries no Jev call: the judge-driven work is Plan B. Jev is TypeSafe's classifier service, which the plugin calls only in shadow today, journaling each answer and acting on none; promoting a question to a live decision is Plan B's opening section.

This plan depended on a fix in the claude-kit repository, now merged as the interactive-only plan's compaction section (PR 123). That section keys the boundary marker by session id under `~/.kit` and locates the transcript by session id, so the command records a usable position from a linked worktree, which is where every persona runs its plans, and the gate reads the marker wherever the session works. This plan reaches live use once the installed plugin cache is updated to that merged build, which is the operator's own act; the Operator Verification check is where that is observed. The running order is firm: the kit boundary section, now merged, first, then nudge-state, then this plan.

## Goal

When this ships, an unleashed persona compacts at a durable point in its work rather than running to the kit's 800,000 token safety ceiling. The plugin, not a leash and not the model, decides that point in code at the end of each turn: it runs the kit's checkpoint boundary command when the turn ended at a durable boundary and does nothing when the turn stopped mid-work. The idle nudge and the injected goal block name the plan document the persona is working, so a nudged persona re-reads the right document. A plan whose Status was flipped to Complete in the persona's own worktree is recognized as complete, rather than looping nudges on the stale launch-checkout copy until merge. The persona launch instruction and the repository's docs no longer say the model banks the boundary by hand, because the plugin does.

## Intent

The operator ruled that personas run unleashed, and the leash was the only thing that let a persona compact at a chapter boundary. Without a replacement, an unleashed persona would run its context to the kit's 800,000 token ceiling before compacting, the cost and quality regression the operator worked to avoid. This plan is the persona-side replacement: the plugin banks a compaction boundary itself, in code, at the end of every turn that reached a durable point.

The design review turned up a fact the mechanism rests on. The plugin captures the working directory only at session start, the launch checkout, and never refreshes it, while a persona works in a linked worktree. So it would read the plan document and write the marker against the wrong directory. The live directory comes from `$.session.cwd()` instead, which the plugin already uses as the session-start fallback; the stale field stays as it is for the persona store that resolves against it.

What done needs to do: read completion and Chapter progress from the live directory, run the kit's boundary command at turn end under fixed rules, name the plan document in the nudge and goal block, and stop the launch instruction and docs saying the model banks by hand. What it does not need to do: no Jev call and no per-turn goal record, which are Plan B, and it does not make the boundary command work from a worktree, which is the kit fix DEV-PLUGIN owns.

Alternatives refused:
- The plugin writes the marker file directly, in the kit's format. Refused: it makes two owners of the marker format and of the transcript-position computation, the split the operator ruled against; the kit's command owns the marker and this plan calls it.
- The persona is told to run the command through its launch instruction, with no hook. Refused: a model instruction is not reliable, and the point of a function hook is that the boundary is banked whether or not the model remembers.
- The Jev judge decides whether the turn is at a durable boundary. Refused: Jev is shadow-only by contract on main, where a branch reading a Jev answer is a checked defect; promoting a question to live is Plan B's opening section.
- The marker is written on every streaming step rather than at turn end. Refused: a marker written mid-turn declares a boundary the gate would honor mid-turn, which is the wrong moment; the boundary is a property of a turn that ended.
- The live working directory is read from the turn event's `cwd`. Refused: the turn-start and turn-complete events carry no `cwd`; only the session-start and classic-hook payloads do. `$.session.cwd()` is the per-turn source, with the `CwdChanged` hook as the fallback where that call proves not to track the worktree.
- Completion is read from the plan's feature branch with a git command. Refused: the stale-copy problem is the frozen working-directory field, not the absence of a branch read; reading from the live directory reads the worktree copy, which already carries the branch's Complete, and a git read adds a subprocess and a branch-discovery decision for nothing.
- `sess.workdir` is repointed to the live directory. Refused: it is the launch anchor the persona store and the workdir files resolve against, so repointing it would move the store lookup; the live directory is read per call and `sess.workdir` is left alone.

Rulings the operator made after the design conversation, each on 2026-09-24 via the ASSISTANT relay thread: this is Plan A, no Jev, carrying the boundary command at turn end, the plan-document naming in nudges, the completion read, and the launch instruction; Plan B carries the per-turn goal records and the Jev promotion. The kit boundary section ships before this plan.

Provenance: distilled from the ASSISTANT brief `personas-run-unleashed-compaction-and-sequencing.md`, its "Addendum: the mechanism" section, and the ARCHITECT design session of 2026-09-24, across two plan-review rounds that found the frozen working-directory field and the empty turn-event `cwd`.

## Approach

**The live working directory comes from `$.session.cwd()`, not from a stored field or a turn event.** `sess.workdir` is captured once at session start, where it is the launch checkout, and never refreshed; it is the anchor the persona store and the workdir files resolve against, so it stays as it is. No turn event carries a `cwd`. So the completion read obtains the directory from `await $.session.cwd()`, which returns the session's current directory, the worktree once the persona has moved there. The compaction marker needs no directory: the merged kit boundary section keys it by session id under `~/.kit`. The plugin already calls it as the session-start fallback, and the engine's `CwdChanged` hook confirms the directory is tracked live; that hook is the fallback if `$.session.cwd()` is ever shown not to follow the worktree.

**Completion and Chapter progress are read from the live directory.** The plan-record reader joins the plan path onto the directory it is handed. Handed the launch checkout, it reads a copy that never gains a Chapter or a Complete status until the feature branch merges, which is the loop the Goal names. Handed the live directory, it reads the worktree copy the persona is writing, so a Chapter banked and a Status flipped to Complete are seen the same turn. This is also the Chapter-advance signal the durable-boundary check needs.

**The compaction mechanism is a fixed-rule check at a true turn boundary, calling the kit's own command.** The plugin adds one step to its `turn.complete` handler. `turn.complete` fires for a background subagent's completion too, while the persona's own turn is still open, so the step first checks that this is the persona's own turn ending: the completing id equals `currentGateTurnId`, and after this completion's own `openTurns` delete `turnIsOpen()` is false. This is the same true-boundary guard the inbox-drain plan uses, and a completion arriving inside an open turn or for a turn this session never saw start banks nothing. Then, gated on the plugin being the owner and the turn not skipped, when the turn ended at a durable boundary it runs the kit's checkpoint command with the boundary verb as a child process, and otherwise does nothing. A durable boundary is decided from fixed signals, never from Jev: whether the turn ended on a `BLOCKED:` or `WAITING:` lead, read with `readStatusLine(e.answer)`, whose `working` state is no lead, on every turn whatever the active entry's kind rather than from the plan-holder-only `turnLeaf.lead`; whether the plan-record read advanced the Chapter count this turn; and whether an active goal remains mid-work. The active entry's plan holder is resolved with `planHolderOf(sess.state, turnLeaf)`, so a task a worker added under a plan node has that plan as its holder. An entry is mid-work when it has a plan holder and the turn advanced no Chapter for it; a turn whose entry has no plan holder, or where `turnLeaf` is null so no entry was active, is durable when it ended on no lead. "No active goal" is `turnLeaf` null, never `noActiveRoot`, which stays true while a live plan sits under a complete root. The turn's kind is recorded in the decision and does not enter the predicate. A turn that was skipped, ended on a lead, or left a plan holder mid-section with no Chapter advance banks nothing.

**The command is located in code, and run with the live directory and the session id.** The plugin has no path to the kit CLI today; the scout found that CLI-path resolution is punted to the model through the peer-sessions skill's prose. So the plugin reads `~/.claude/plugins/installed_plugins.json`, whose `plugins["claude-kit@applefeld"]` is an array of install records each carrying an `installPath` and a `lastUpdated`; it takes the record with the greatest `lastUpdated` and runs `node <installPath>/hooks/kit-compact-checkpoint.js boundary` through `$.process.run`, passing `{ CLAUDE_CODE_SESSION_ID: <the session id> }` as the child's `env`, which the host sets over its own environment rather than replacing it, and no `cwd`. The merged kit boundary section (interactive-only PR 123) keys the marker by session id under `~/.kit` and locates the transcript by session id, so the command records a usable position from a linked worktree and the gate reads the marker wherever the session works. The caller needs no directory for the marker; that boundary section is the kit precondition named in Dispatch Authorization, now merged.

**The kit is the only decider of compaction, and its own boundary-verb gate does not apply to the plugin's call.** The plugin writes nothing the gate parses on its own; it runs the command, and the kit's gate keeps its ceiling and its single-shot honoring of the marker. The kit's peer-sessions skill states three questions that license a seat to run the boundary verb by hand (worktree edits none or handed off, decisions on disk, owed messages sent). The operator approved the plugin-in-code mechanism; that its fixed rule replaces the skill's three questions for a persona is this plan's reading of that approval, recorded here. It follows the one-owner ruling: two deciders on one moment is the drift that set the leash against the goal tree.

**Naming the plan document in the nudge and the goal block extends injected strings without changing call sites.** The idle nudge text (two arms) and the `[GOAL TREE]` block are strings the plugin submits, pinned by the injection ledger and a duplicate test that pins the template-literal chain shape. The plan path and section are added as a declared whole-variable piece inside the existing chains, beside the block's existing `siblingLine` and `lastNote` pieces, so the chain shape holds and the new copy is sized by the ledger; a bare interpolation would be stripped and never sized. The section printed is the plan holder's Chapter count plus one, printed as `Section N`, since no stored field names a section.

**The launch instruction and the docs.** The coordinator role instruction tells the model to run the boundary command by hand at each turn end; the banking step makes the plugin do it, so that instruction, the injection-ledger baseline that sizes it, and the repository docs that describe it are all updated.

**Line references.** The line numbers in the sections are as of the branch head `4e1a96f`, this plan's own base. Because nudge-state, the self-review flood and the inbox drain all merge before this plan and all touch `hooks/index.ts`, the executing session re-locates each site by its described role rather than by the number. The scout that first mapped these surfaces ran against `b9e6e28`, one merge behind the base, which moved the supervisor priming into `bin/supervise-holder.sh`; the Files-in-scope lists below are re-anchored to the base.

## Sections of Work

### 1. Completion and Chapter progress are read from the live working directory
Model: opus
Pass `await $.session.cwd()`, not `sess.workdir`, to the plan-record read at the tick's caller, so completion and the Chapter count are read from the worktree copy the persona writes. Confirm, with evidence, that `$.session.cwd()` returns the worktree for a persona working in one; where it returns the launch checkout instead, track the directory from the `CwdChanged` hook and use that. The reader itself is unchanged; only the directory it is handed changes. Keep every read failure a returned reason rather than a throw, as the reader already does. `sess.workdir` is not repointed.
Acceptance:
- The tick's plan-record caller is handed the live working directory rather than `sess.workdir`, and `sess.workdir` is unchanged.
- A plan whose Status is Complete under the live directory, and not under the launch anchor, reads as complete, so the controller auto-completes the goal node; a Chapter banked under the live directory is seen as a Chapter-count advance the same turn.
- A read failure logs a reason and leaves the plan not complete rather than throwing.
- `.kit/controller-tick-test.mjs` gains a case where the Complete document sits only under the live directory and not under the launch checkout, and the goal node auto-completes; the suite runs green on its own exit code.
Files in scope: `hooks/index.ts` (the `readPlanRecord` caller at ~7078 to 7080), `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs` (only if the harness must be taught to answer `$.session.cwd()` per case).
Tests: lock that the caller reads the live directory, that a Complete document present only under the live directory auto-completes the node, and that a read failure degrades to not-complete rather than a throw. The case must exercise the caller, not `readPlanRecord` alone, which already takes a directory parameter and would pass green without the caller change.

### 2. The plugin banks a boundary at turn end under fixed rules
Model: opus
The `turn.complete` handler gains a step. It runs only at a true turn boundary: the completing `e.turnId` equals `currentGateTurnId` and, after this completion's own `openTurns` delete, `turnIsOpen()` is false, so a subagent's completion or a completion for an unseen turn banks nothing. The step runs after the handler's plan-record read, so the Chapter-advance signal is settled, and is further gated on the plugin being the owner and the turn not skipped. When the turn ended at a durable boundary it runs the kit boundary command, otherwise nothing. The predicate is the fixed rule in the Approach: `readStatusLine(e.answer)` returned no `blocked` or `waiting` state, and either `turnLeaf` is null, or its `planHolderOf(sess.state, turnLeaf)` is undefined, or that holder advanced a Chapter this turn; a holder that advanced no Chapter is mid-work and not durable. The command is located by reading `installed_plugins.json`, taking the record with the greatest `lastUpdated` under `plugins["claude-kit@applefeld"]`, and run via `$.process.run(["node", "<installPath>/hooks/kit-compact-checkpoint.js", "boundary"], { env: { CLAUDE_CODE_SESSION_ID: sess.mySessionId }, timeoutMs })`, with no `cwd`: the merged kit boundary section (interactive-only PR 123) keys the marker by session id under `~/.kit` and the gate reads it wherever the session works. The call is best-effort: a non-zero exit or a throw logs one decision and never fails the turn. The decision carries the exit code and the child's first stderr line, so an unpositioned marker, which the command still exits zero on, is legible in the log rather than reading as a clean bank. `sess` is the session-state object the handler already reads (`sess.isOwner` gates the existing untracked-work push).
Acceptance:
- On the persona's own durable turn boundary, the boundary command runs once, with `env` carrying `CLAUDE_CODE_SESSION_ID` equal to the session id and no `cwd`, and a decision records the run, its exit code and its first stderr line.
- A subagent completion arriving inside the persona's open turn, and a completion for a turn this session never saw start, bank nothing.
- On a turn that was skipped, ended on a lead whatever the active entry's kind, or left a plan holder mid-section with no Chapter advance, the command does not run.
- The install path is the greatest-`lastUpdated` record's `installPath`; a missing key, an empty array, or an absent file logs one decision and skips the run rather than throwing.
- `.kit/controller-tick-test.mjs` runs green on its own exit code, with the process stub overridden so the assertion is real (see Tests).
Files in scope: `hooks/index.ts` (the `turn.complete` handler at ~6570, its `openTurns`/`currentGateTurnId` boundary check, and the `readStatusLine`, `planHolderOf` and plan-record read it already computes), `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs`.
Tests: lock both directions of the durable-boundary gate: a delivered no-goal turn, a task-entry turn, and a Chapter-banking turn each bank exactly once; a skipped turn, a lead-ended turn including a task-entry turn that ended on `BLOCKED:`, and a plan-holder-mid-section turn each bank nothing. Override the harness's `process.run` stub so the test records the child argv and env and asserts them on the banking cases and an empty record on the others, since the default stub returns a fixed exit code and would go green whether or not the bank ran. A silent bank on a mid-work turn is the expensive failure, because it licenses compaction mid-section.

### 3. The nudge and the goal block name the plan document
Model: sonnet
Add the active plan document's path and section to the idle nudge text (both arms) and the `[GOAL TREE]` block, taking the path and Chapter count from the active entry's plan holder via `planHolderOf(sess.state, turnLeaf)`, so a task under a plan node names that plan's document; the section is the holder's Chapter count plus one, printed as `Section N`. Add it as a declared whole-variable piece inside the existing template-literal chains, beside the block's `siblingLine` and `lastNote`, so the chain-shape pins hold and the ledger sizes the new copy. Add the new piece's name to the ledger extractors' declared-name lists, and regenerate the ledger. When the active entry has no plan holder, the piece is empty so the nudge and block omit the plan line.
Acceptance:
- Both nudge arms name the plan holder's document path and section when the active entry has a plan holder, including a task under a plan node, and omit them for an entry with no plan holder.
- The `[GOAL TREE]` block names the plan document path and section, with its template-literal chain shape preserved.
- The injection ledger regenerates clean and `.kit/injection-duplicate-test.mjs` passes on its own exit code.
- `.kit/controller-tick-test.mjs`'s `[GOAL TREE]` and `[GOAL]` assertions pass.
Files in scope: `hooks/index.ts` (the nudge text at ~6234, the `[GOAL TREE]` block at ~9112), `.kit/injection-ledger.mjs`, `.kit/injection-ledger.json`, `.kit/injection-duplicate-test.mjs`, `.kit/controller-tick-test.mjs`.
Tests: lock that the plan path and section are carried when a plan is active and omitted for a task entry, in both the nudge and the block.

### 4. The launch instruction and the docs stop describing a hand-run boundary
Model: sonnet
The coordinator role instruction in `bin/supervise-holder.sh` tells the model to run the boundary command by hand at each turn end. Now that the plugin banks the boundary for every owner session (section 2), remove that clause and state that the plugin banks the boundary. That instruction's size is recorded in the injection-ledger baseline, so regenerate it. Update the repository docs that describe the hand-run boundary so they match. This section is dispatched after section 2, so the instruction is removed only once the plugin banks reliably. It waits on the interactive-only plan's removal of the self-arm text from the executing-work skill: the executing session confirms that removal has landed before editing the priming, so no instruction is left pointing at a mechanism the other plan removed.
Acceptance:
- The coordinator role instruction no longer tells the model to run the boundary command by hand, and states the plugin banks it.
- The injection-ledger baseline is regenerated and `.kit/injection-duplicate-test.mjs` passes on its own exit code.
- `README.md` (the launch narrative and the no-context-reading paragraph) and `docs/architecture.md` no longer say the coordinator instruction has the child bank the boundary by hand.
- `.kit/channel-reply-instruction-test.sh` passes on its own exit code, updated where it pins the removed control string.
Files in scope: `bin/supervise-holder.sh` (the coordinator role instruction at ~253 and its comment at ~285), `.kit/injection-ledger.json`, `.kit/injection-duplicate-test.mjs`, `README.md` (the launch narrative at ~344 and the no-context-reading paragraph at ~731), `docs/architecture.md` (~16), `.kit/channel-reply-instruction-test.sh`.

## Out of Scope
- Any call to the Jev judge, and any promotion of a shadow question to live. That is Plan B.
- Per-turn goal records beside the goals array, and the retirement of the untracked-work counter. That is Plan B.
- Making the kit boundary command record a transcript position from a worktree. That is the kit fix DEV-PLUGIN owns in the interactive-only plan's boundary section.
- Any change to the kit gate's ceiling or its marker-honoring logic.
- Repointing `sess.workdir`. It stays the launch anchor; the live directory is read from `$.session.cwd()` per call.

## Assumptions
- assumed 2026-09-24 (default): a `$.process.run` child inherits enough environment (PATH, a resolvable `node`) to run the kit command; reversal: if it does not, section 2 passes an explicit environment and its cost rises slightly.
- assumed 2026-09-24 (`git worktree list` and the ASSISTANT scout): personas run their plans in linked worktrees filed under the main checkout; reversal: if a persona ran in the main checkout, the worktree precondition would not bind and the plan could ship without waiting on the kit fix.
- assumed 2026-09-24 (`.claude/types/claude-code.d.ts:1521-1523`, and the plugin's own session-start fallback): `$.session.cwd()` returns the session's live directory, the worktree once the persona has moved there; reversal: if it returns the launch checkout, section 1 tracks the directory from the `CwdChanged` hook, which its confirmation step establishes.
- assumed 2026-09-24 (default): the executing implementer is a persona engineer familiar with the plugin's own vocabulary (the leash, the goal tree, the idle nudge and its two arms, the injection ledger, the Jev shadow seam, the kit marker's declare-and-lapse lifecycle) and resolves each term by reading the named code and the repo's README and architecture.md; reversal: a reader without that context needs those terms glossed, which the repo docs already carry.

## Operator Verification
- After the kit boundary section and this plan both merge and the supervisors relaunch, confirm on one persona that a turn ending at a Chapter boundary compacts before the context reaches the ceiling. What reopens the work: a persona running to the 800,000 token ceiling before compacting.

## Open Questions
- None open. Section 1's live-directory confirmation and section 2's process-stub test are settled in-code against the acceptance above.

## Related
- `claude-kit_kit-goal-interactive-only_spec_v1.md` (claude-kit repo): unleashes personas and adds the boundary section this plan depends on.
- `agent_persona_nudge-state_v1.md`: ships before this plan; replaces the nudge cap's pause with an ask.

## Chapters
