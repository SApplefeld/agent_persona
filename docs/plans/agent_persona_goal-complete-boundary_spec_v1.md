# A Finished Goal Tree Is a Checkpoint Boundary, Not a Relaunch

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-02

## Goal

A persona whose goal tree completes stays in the session it is in. The supervisor no longer stops that child and launches a fresh one, so the next ask lands in a session that still holds the conversation about the last one. The turn that finishes a goal entry counts as a durable point, so the session's next automatic compaction may land there instead of running to the safety ceiling. A child that crashes after its tree completed counts against the crash limit like any other crash. The tool descriptions, the charter sentence and the documents that state the relaunch say what the engine now does. The deliberate restart routes are unchanged.

## Intent

**The frame, in the operator's words (2026-10-02, on the architect's channel).** The operator asked why a persona restarts when its goal tree is clear, and on hearing the reason said: "just fully restarting into a brand-new session doesn't really make sense to me when a goal tree completes, because it's not how we've been using the kit." The use he described: "It was not uncommon to arm multiple plans back to back with a kit goal. It was not uncommon to use one long-running session to complete a goal, dialogue a little bit about it, make a new plan, and start a new one." What must survive the change: "I think what's important is context management, checkpoint writing, and compaction. Those things should definitely still be observed. Finishing a goal is a good time to open a checkpoint, and if you're over your context budget, compact. Finishing, just like finishing a chapter or a section, is a good point for that." And the means: "there is a reasonable mechanism there to compact down to use the checkpoint deferral and capabilities for that."

**What done needs.** Every persona stays up across a finished tree, which is the author's reading of the operator's words and is recorded under Assumptions. Finishing a goal entry opens the same compaction boundary a plan Chapter opens today. A crash after a finished tree is still counted.

**What done does not need.** It does not need the engine to measure how full the context is. It does not need a compaction forced at the boundary. It does not need a change to the kit. It does not need the three deliberate restart routes to change: the persona's own restart tool, the coordinator's fleet restart, and a parked shutdown.

**Alternatives refused.**

- Exempt only the architect's seat from the relaunch: refused, because the operator's reason is about how every persona is used, not one seat.
- Keep the relaunch and carry the conversation across it with a longer recap: refused, because a recap is a summary the engine writes, and the harness's own compaction already does that job at a point the kit's gate approves.
- Force a compaction whenever a tree completes: refused, because the operator asked for one only "if you're over your context budget", and the kit's gate already makes that call.
- Give the engine its own context estimate to decide the compaction: refused, because an earlier plan removed exactly that monitor and left the kit as the only decider.

Whether the turn that finishes one plan and moves straight onto a queued one is also a boundary is the operator's call, under Open Questions, and not refused here.

**Later rulings.** None yet.

**Provenance.** Written by the architect persona's session of 2026-10-02 from the operator's two channel messages of that day, quoted above.

## Dispatch Authorization

The operator's messages of 2026-10-02 quoted under Intent are the design ask this plan answers. They authorize the plan document. `Status: Ready` means the plan is parked: arming it for a worker is the operator's or the coordinator's act and is not given here, and the run that starts it sets the header to `In Progress`.

One edit in section 3 depends on another plan. The architect's charter clause about the relaunch is carried by the branch `plans/architect-draft-pr-charter` of `docs/plans/agent_persona_architect-draft-pr_spec_v1.md`, at its commit f08aa0d or a later one, in `bin/supervise-holder.sh`. The clause is not in the charter plan's own text and not on the trunk at 6da8065. Section 3 edits it where the worker's checkout of `bin/supervise-holder.sh` holds the phrase `relaunching you with the tree kept`. Where it does not, section 3 skips that edit and the two restatements that go with it, and registers the three in `docs/backlog.md` as one item in the file's own shape: a `##` heading naming the edit with `(found YYYY-MM-DD)`, then one paragraph naming the phrase, the replacement text under section 3 and the two restatement surfaces. The rest of the plan proceeds.

No section of this plan restarts, stops or relaunches a running supervisor or persona. A running supervisor keeps the script it launched with, so the change takes effect at each supervisor's next launch, which is the operator's act.

## Approach

**What happens today.** The plugin's controller tick completes a finished root and writes a `root_complete` decision to the persona store (`completeRoot`, `hooks/index.ts:4681`, called from the tick at `hooks/index.ts:8411`, from the planner's zero-plan return and from `goal_done` naming the root). The supervisor's poll reads the newest `root_complete` (`bin/supervise-poll.mjs:127`). Its decision unit maps one newer than the child's start to `restart_passive` (`bin/supervise-decide.mjs:150`). `bin/supervise.sh` then stops the child by the graceful path and launches a fresh one outside the crash counter and the hourly restart budget (`bin/supervise.sh:4871`). An archived plan introduced this so the supervisor would stay up for a second goal instead of exiting (`docs/archive/agent_persona_passive-supervisor_v1.md`, item 4). The fresh child was the means, and staying up was the aim.

**The change to the supervisor.** The decision unit stops reading `root_complete` at all. With step 3c gone, a child on a finished tree is an ordinary live child: the poll keeps reading its liveness, and every other decision still applies. `rootCompleteTs` and `rootCompleteBackfilled` have no other reader in the decision unit or the poll, so both inputs and the poll's read of them go with the step, and with them the poll's copy of the legacy backfilled suffix. The `restart_requested` branch above step 3c stays, and so does its `restart_passive` action, which is now that branch's alone. The branch's refusal to relaunch beside a surviving or unverifiable process stays with it.

**The natural-exit path keeps its read and gains one condition.** When the child exits on its own, `bin/supervise.sh:5073` reads `root_complete` and, for a real root, relaunches unaccounted whatever the exit code. That was safe while a child lived only seconds past its completion. Once children stay up, a `root_complete` newer than the child's start is the normal state of any child that has finished one goal. So the real-root branch takes the relaunch only on exit code 0, as the backfilled branch beside it already does. A non-zero exit falls through to the crash counter and the hourly budget. Without this condition, a child that crashes in a loop after finishing one goal would relaunch without limit. The branch's log line loses its `RESTART_PASSIVE:` prefix, since that word now names the restart request alone and the operator reads its absence after a completion as the pass signal.

**The change to the plugin.** The plugin already banks a compaction boundary for the kit's gate (`bankCompactionBoundary`, near `hooks/index.ts:2738`; the kit is the `claude-kit` plugin, whose `kit-compact-checkpoint.js boundary` verb records the marker and whose `kit-compact-gate.js` reads it). The persona's own turn end sets an owed bank where the turn stopped at a durable point, and the first main-loop tool call of the next turn runs the kit's `boundary` command. The durable test reads a plan holder as mid-section unless its document gained a Chapter or completed the holder this turn (`hooks/index.ts:11032`). A holder that `goal_done` completed this turn passes neither, so that turn owes no bank today. That is the wrong reading: `goal_done` is the persona's own statement that the entry is finished. The rule gains one case: a turn-start plan holder that a `goal_done` call completed this turn is not mid-section. Every other part of the durable test is unchanged, so a `WAITING:` or `BLOCKED:` lead, an open ask, a live background agent, or a move onto another open plan still withholds the bank.

The move onto another open plan deserves one sentence, because `goal_done` itself makes it. With no `nodeId`, `goal_done` completes the active leaf and activates the next pending plan inside the same turn (`README.md:212`), so the turn may go on to work that plan before it ends. The existing rule reads such a turn as mid-section through `endHolderOpen` (`hooks/index.ts:11030`), and this plan keeps that reading unless the operator rules otherwise under Open Questions. The next plan the turn-complete handler's own scorer activates after the turn got no work in the turn, so that point stays durable, as the handler's comment says (`hooks/index.ts:10991-10996`).

The owed bank lives in memory and is taken at the next turn's first tool call. Today the relaunch discards it. Once the child stays up, the next turn takes it, with no further change.

**Why no context measurement.** The engine keeps no estimate of context size (`README.md:867`, "No context reading"). The harness triggers automatic compaction at its own window. The kit's gate defers that compaction while a session is mid-work and allows it once a boundary marker exists, up to a safety ceiling of 800,000 tokens. So "if you're over your context budget, compact" is already how the pieces behave once the boundary is banked: under the trigger nothing happens, and over it the next compaction lands at the banked point.

**Why the checkpoint is not a new write.** A plan a worker executes closes with a Chapter in the plan document, and the kit's own skills write it. A plan the architect writes closes with the pushed branch and the draft pull request. Those are the durable records a compacted session resumes from. This plan adds no second record.

**Sections run in order, one at a time.** Section 3 rewrites comments section 1 left and states the suites as sections 1 and 2 leave them, and sections 1 and 2 both touch `hooks/index.ts` and `.kit/controller-tick-test.mjs`.

**The sweep.** Searches over `bin/`, `hooks/`, `.kit/`, `README.md` and `docs/` at 6da8065 for `root_complete`, `rootComplete`, `get_root_complete`, `restart_passive`, `RESTART_PASSIVE`, `goal complete`, `finished goal` and `pendingCompactionBank`. Surfaces found:

- Code: `bin/supervise-decide.mjs` (step 3c and its header comments at 8-9 and 60-67), `bin/supervise-poll.mjs` (112-137, 414, 430), `bin/supervise.sh` (the `restart_passive` case at 4871, the natural-exit branch at 5073-5097, the comment at 5104), `hooks/index.ts` (the durable test at 10968-11036, the two tool descriptions at 5800-5805 and 5825-5827, the comments at 2345, 4665 and 12308).
- Tests: `.kit/supervisor-unit-test.mjs` (the real-root case near 226-236), `.kit/supervisor-poll-unit-test.mjs` (near 227-245), `.kit/supervisor-natural-exit-test.sh` (the suffix pin at 303-328, cases b at 1678, g at 1708, v at 2293 and y at 2318), `.kit/controller-tick-test.mjs` (the boundary-compaction cases and `caseTurnClose_theCompactionRuleInBothDirections`).
- Words: `README.md` (lines 44, 48, 52, 212, 400, 459-502, 531, 555-558, 867), `docs/architecture.md` (the supervisor passages and the size row at 325), `docs/backlog.md` (the items named under section 3 by title), `.kit/injection-ledger.json`, and the architect's charter clause in `bin/supervise-holder.sh` where the charter plan has landed it.

Line numbers are anchors at 6da8065. Each section re-reads them before editing, and a backlog item is re-found by its heading.

**One thing not read.** What the controller tick does on every tick for a session whose root is already complete was rare before, because the child was stopped within a poll. It is inferred that the tick makes no planner call and sends no nudge for such a root. Section 1 pins it with a test rather than trusting the inference.

## Sections of Work

### 1. The supervisor keeps the child on a finished tree

Model: opus

The supervisor stops answering a completed root with a relaunch, and a crash after a completed root is counted.

What gets built:

- `bin/supervise-decide.mjs`: step 3c is removed with its header text. The `rootCompleteTs` and `rootCompleteBackfilled` inputs are removed. The `restart_requested` branch and the `restart_passive` action stay, and the comments say the action is the restart request's.
- `bin/supervise-poll.mjs`: the read of the newest `root_complete`, its backfilled flag and the `BACKFILLED_SUFFIX` constant are removed from `readStoreFacts`, with the two values it passes to the decision unit.
- `bin/supervise.sh`, the `restart_passive` case: the comment and the log line name the restart request only. The `goal complete` log arm is removed, since no decision reaches it.
- `bin/supervise.sh`, the natural-exit path: the real-root branch relaunches unaccounted only where the exit code is 0. Its two log lines become one `NOTE:` line, in the shape of the backfilled branch's, saying the child exited clean after a completed goal and is relaunched unaccounted, with no `RESTART_PASSIVE:` prefix. A non-zero exit falls through to the accounted path. The backfilled branch is untouched.
- `.kit/supervisor-natural-exit-test.sh`: the suffix pin at 303-328 narrows to `bin/supervise.sh`'s single reader, one suffix and one whole-line rule, and the test's own stub reader at 348 keeps reading that suffix. Cases (v) and (y) are driven through a restart request instead of a completed root. Case (b) asserts the new `NOTE:` line and the absence of `RESTART_PASSIVE:`. Case (g) is rewritten as the stay-up proof below.
- The other tests named below, changed to state the new behavior.

Acceptance criteria:

- A decision-unit case with a real `root_complete` newer than the child's start, a live child and no other signal returns the same action as the case with no `root_complete`. No decision reason names `root_complete`.
- A poll case over a store holding a real `root_complete` newer than the child's start reports no restart, and the poll's output carries no root-complete field.
- A natural-exit case whose child completes a real root and exits 0 relaunches unaccounted, with the `NOTE:` line and no `RESTART_PASSIVE:` line in the log.
- A natural-exit case whose child completes a real root and then exits non-zero inside the minimum run time, repeated to the crash limit, ends with the supervisor's crash-loop stop. Before the change this case relaunches without limit, so it is written first and seen red.
- Case (g) proves the stay-up: after at least two polls following the stub's `root_complete` write, child-1 is the same process, the log holds no `RESTART_PASSIVE` line and no `EXIT child-1` line, and the stub reports one launch. The run ends through the shutdown request as today.
- Cases (v) and (y) reach the `restart_passive` branch through a restart request and still end in exit 5 with no second launch.
- A restart request newer than the child's start still relaunches the child unaccounted on both paths.
- A controller-tick case over a session whose root is complete and whose child stays up runs several ticks with no planner call, no nudge and no second `root_complete` decision. Where the tick does any of the three, the section makes the smallest change in `hooks/index.ts` that stops it, pins it with the same case, and names the change in its Chapter.
- `node .kit/supervisor-unit-test.mjs`, `node .kit/supervisor-poll-unit-test.mjs`, `bash .kit/supervisor-natural-exit-test.sh` and `node .kit/controller-tick-test.mjs` exit 0, each against a baseline recorded before the first edit, and the natural-exit suite's check count is not lower than the baseline's.

Files in scope: `bin/supervise-decide.mjs`, `bin/supervise-poll.mjs`, `bin/supervise.sh`, `.kit/supervisor-unit-test.mjs`, `.kit/supervisor-poll-unit-test.mjs`, `.kit/supervisor-natural-exit-test.sh`, `.kit/controller-tick-test.mjs`, and `hooks/index.ts` only where the tick case above finds a fault.

Tests: the stay-up behavior in both directions (a completed root does not relaunch, a restart request still does), because a half-removed step would leave one path relaunching. The crash count after a completed root, because the unaccounted branch would otherwise exempt every long-lived child from the crash limit. The survivor refusal on the restart-request route, because cases (v) and (y) are the only proof of it. The quiet tick over a complete root, because that state was rare and is now the resting state of every idle persona.

### 2. A finished goal entry opens a compaction boundary

Model: opus

The turn in which a `goal_done` call completes the plan entry it started on counts as a durable point, so it owes a boundary bank.

What gets built:

- `hooks/index.ts`, the durable test in the turn-complete handler: a turn-start plan holder that a `goal_done` call completed this turn, on the holder itself or on its last open child, is not mid-section. The status is the holder's at the delete snapshot, beside `activeIdAtDelete`, not after the handler's own steps. A holder the cascade closed because its last open child was abandoned is out, and so is an abandoned holder. The comment block above the test states the case in the present tense beside the Chapter and document cases.
- No other input of the durable test changes.
- Boundary cases in `.kit/controller-tick-test.mjs`.

Acceptance criteria:

- A turn that starts on a plan entry, calls `goal_done` on it and ends with a plain answer sets the owed bank, and the next turn's first main-loop tool call runs the boundary command once and logs `compaction_boundary_banked`.
- The same turn ending on a `WAITING:` or `BLOCKED:` lead, with an open ask, or with a live background agent owes no bank.
- A turn where `goal_done` completes the entry and activates another open plan owes no bank, as today, unless the operator's answer under Open Questions changes it before the section runs.
- A turn where the holder reads complete only because its last open child was abandoned owes no bank.
- A turn that ends on a plan entry still open, with no new Chapter, owes no bank, as today.
- The bank set by the turn that finished the last entry is still owed after the tick that completes the root, and the next turn takes it. This case runs the tick between the two turns.
- The new cases are written first and seen red against the unchanged handler.
- `node .kit/controller-tick-test.mjs` exits 0 against its recorded baseline, and `npx tsc --noEmit` exits 0.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`.

Tests: the new durable case in both directions, because a marker banked mid-work licenses a compaction that loses the work in hand. The bank surviving the root's completion, because the relaunch used to discard it and nothing has ever exercised that path.

### 3. The words say the child stays up

Model: sonnet

Every sentence that tells a persona or a reader that a finished goal relaunches the child says instead that the child stays up.

What gets built:

- `hooks/index.ts`, the `supervisor_shutdown` description: the sentence "A finished goal needs no call here: goal_done already returns the supervisor to its passive waiting state." becomes "A finished goal needs no call here: the session stays up and waits for the next ask."
- `hooks/index.ts`, the `supervisor_restart` description: "A finished goal needs no call here either." stays as written, since it remains true. The section confirms it and changes nothing there.
- `hooks/index.ts`, the comments at 2345, 4665 and 12308, and `bin/` comments section 1 did not already rewrite: each states what the supervisor reads now.
- `bin/supervise-holder.sh`, the architect's charter, under the condition Dispatch Authorization states. The clause "and the supervisor answers a completed root by relaunching you with the tree kept, so before the turn that calls goal_done on it ends you answer or report every other ask in hand; the next goal_add reopens the root" becomes "and you stay up on a completed root; the next goal_add reopens it". The rest of that sentence and the sentence after it stay. The charter plan's restatements of the clause in `README.md` and `docs/architecture.md` change with it, and are skipped with it.
- `.kit/injection-ledger.json` and the size row at `docs/architecture.md:325`, refreshed from `node .kit/injection-ledger.mjs` in the same commit as the string edits.
- `README.md`: each passage the sweep lists is rewritten to the current state. The decision list loses the `root_complete` entry. The natural-exit passage says a clean exit after a completed goal relaunches unaccounted and a crash is counted. The "No context reading" passage adds the finished-entry case to its description of a half-done section. The test inventory lines match what the suites now prove.
- `docs/architecture.md`: the same, wherever it states the relaunch.
- `docs/backlog.md`: the items "The supervisor reads the newest root_complete and never a later root_reopened" (line 300) and "The supervisor relaunches a child that reopened a root it had completed" (line 371) move to `docs/archive/backlog-2026-Q4.md`, each with the reason that the supervisor no longer acts on `root_complete` while the child lives. The item "Operator check owed by the boundary-compaction plan" (line 276) is replaced by a pointer to this plan's Operator Verification, which covers it. The items "Remove the supervisor's backfilled readers once no store can still hold such a line" (line 381) and "A KILL-path variant of the restart-passive F2 leg" (line 543) are reworded to what remains true: the backfilled reader survives only on the natural-exit path, and case (g) proves the stay-up while cases (v) and (y) prove the refusal on the restart-request route.

Acceptance criteria:

- A search over `README.md`, `docs/architecture.md`, `docs/backlog.md`, `bin/` and `hooks/` for `passive`, `goal-complete`, `fresh child` and `relaunch` leaves no sentence that ties a relaunch to a completed goal with a live child. The Chapter lists each remaining hit and why it stays.
- `node .kit/injection-duplicate-test.mjs` exits 0, and the ledger file's totals equal the ledger script's output.
- `docs/architecture.md:325` states the counts and totals the ledger file holds.
- No sentence in the changed documents says when or how the behavior changed. They state the current behavior.
- The charter edit is made, or the Chapter names the backlog item that carries it.

Files in scope: `hooks/index.ts` (descriptions and comments only), `bin/supervise-holder.sh`, `bin/supervise-decide.mjs`, `bin/supervise-poll.mjs` and `bin/supervise.sh` (comments only), `.kit/injection-ledger.json`, `README.md`, `docs/architecture.md`, `docs/backlog.md`, `docs/archive/backlog-2026-Q4.md`.

## Out of Scope

- The kit repository. Its gate, its `boundary` verb and its ceiling are used as they are.
- Any context-size estimate in the engine, and any compaction the engine forces.
- An abandoned plan holder as a durable point.
- The rate bound on untracked-work relaunches (`docs/backlog.md`, "An untracked-work relaunch has no rate bound", line 481) and the removal of the backfilled reader (line 381).
- Re-delivering a persona's launch instructions after a compaction. See Open Questions.
- Restarting any running supervisor.
- `docs/archive/agent_persona_passive-supervisor_v1.md`, which states the relaunch as history and is not edited.

## Assumptions

- assumed 2026-10-02 (README.md "No context reading" and docs/archive/agent_persona_boundary-compaction_spec_v1.md): "over your context budget" means the harness's own compaction trigger, with the kit's gate landing the compaction at the banked boundary, and no measurement in the engine; reversal: an engine-side estimate is a new plan and reverses an earlier removal.
- assumed 2026-10-02 (default): "open a checkpoint" means the boundary marker the plugin already banks, with the plan's closing Chapter or pushed branch as the durable record, and no new file; reversal: a written goal-close record is one more section in the plugin.
- assumed 2026-10-02 (default): the change applies to every persona, coordinator and liaison included, because the supervisor's step is not per role and the operator's reason was about how personas are used; reversal: a per-role switch is a new setting in the supervisor's config.
- assumed 2026-10-02 (default): the turn that finishes one plan and moves straight onto a queued one stays mid-section, pending the operator's answer under Open Questions; reversal: one condition in the durable test and one test case, inside section 2.
- assumed 2026-10-02 (default): a persona no longer picks up a new plugin build or harness build at each goal end, only at a deliberate restart; reversal: none in code, the operator or coordinator restarts the fleet after an update as the restart tools already allow.
- assumed 2026-10-02 (default): a clean exit after a completed goal keeps its unaccounted relaunch, since a child that leaves cleanly between asks is healthy; reversal: one condition in the natural-exit branch.
- assumed 2026-10-02 (default): the plan review ran in the architect's session before the push, and the worker's engine reviews each section as it runs; reversal: none.

## Operator Verification

- After the pull request merges, update the installed plugin copy and relaunch one supervisor. Have that persona finish a goal. The supervisor's log shows no `RESTART_PASSIVE` line after the `root_complete` decision, and the persona answers the next ask in the same session with the earlier conversation still in hand. A relaunch at that point reopens the work.
- On the same persona, across a session long enough to reach the harness's compaction trigger, the kit gate's log in `.kit/compact-gate.jsonl` shows an allow line after a finished goal, and the store shows `compaction_boundary_banked`. A persona that runs to the 800,000 token ceiling before compacting, or a `compaction_boundary_failed` decision on a clean install, reopens the work. This check replaces the one the boundary-compaction plan left owed.
- After that compaction, the persona still follows its role: it reports where its launch instructions say to report. A persona that loses its role after a compaction turns the open question below into a plan.

## Open Questions

- **The between-plans turn (operator's call, recommendation: keep it mid-section).** A worker with two plans queued finishes the first with `goal_done`, and the same call activates the second inside that turn. Under this plan that turn owes no boundary, because it may already have worked the second plan before it ended. The alternative reads it as a boundary anyway, on the ground that finishing a goal is a checkpoint whatever follows. The cost of the alternative is a marker that can license a compaction a few tool calls into the next plan's first section, before any Chapter exists. The cost of the recommendation is that a queue of three plans banks a boundary only at the last. Answer before section 2 runs; unanswered, section 2 runs as written.
- **Launch instructions after a compaction (operator's call, recommendation: ship without, watch for it).** A persona's role instruction arrives once, in the supervisor's first prompt. No search of `hooks/` or `bin/` found a step that delivers it again after a compaction, so it survives only as far as the compaction summary carries it. That exposure exists today inside any one long goal. The relaunch used to refresh the instruction at every goal end, and after this plan only a deliberate restart does. The third Operator Verification item is the watch. A fix would be a separate plan.

## Related

- `docs/archive/agent_persona_passive-supervisor_v1.md`: introduced the relaunch on a completed root, item 4. This plan replaces that item's means and keeps its aim.
- `docs/archive/agent_persona_boundary-compaction_spec_v1.md`: introduced the boundary bank this plan extends by one case.
- `docs/archive/agent_persona_context-budget-removal_v1.md`: removed the engine's context monitor, which this plan does not bring back.
- `docs/plans/agent_persona_architect-draft-pr_spec_v1.md`: its branch adds the charter clause section 3 changes.

## Chapters
