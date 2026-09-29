# Deferred gate run

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-18

## Goal

When this is done, every test run the gate policy below deferred has run once against the trunk after the last queued plan merges, every red from that run is traced to the plan that caused it, and each is fixed or filed with its cause named. The policy is then lifted, and plans armed after this one gate as the executing-work skill states. It matters because four plans are landing on `hooks/index.ts` and `bin/supervise.sh` without the runs that prove them together, so this run is the only place their combined behavior is read before the fleet relies on it.

## Dispatch Authorization

The operator asked for this on 2026-09-18 on the coordinator's own Discord thread. Their words: "The 40+ minute gates whenever we need to run a test are blocking other development." and "when all the plans are done, we can do a test run and evaluate any that fail as a wholly separate circle back to fix things." Offered the choice between suspending every check and suspending only the runs that hold the box, they answered "I'm good with Option 2." That is authorization to author and to apply the policy to the queued plans. Execution of this plan is armed only on the operator's own word, typed into the executing session's thread or relayed through the coordinator. The executor is the dev persona.

The operator armed execution on 2026-09-19, naming this plan in a `/kit-goal` invocation relayed to the executing session on the operator's own channel, which is the channel this section reserves the arming to. That is the execution arming, given separately from the authorization to author above, and it approves this plan as written. It is recorded here because the arming state itself does not keep it: a run that re-arms a queue for itself after a session ends records its own invocation and no longer reads the operator's, so a later session reading only that state would find this plan unarmed. The project memory record `self-armed-arming-does-not-satisfy-an-operator-only-execution-grant` holds the general shape.

On 2026-09-29 the operator cleared this run again on the executing session's own relay thread: "You're cleared to do all of them in whatever order you recommend, and the box is quiet except for you, so you can run the deferred test whenever you prefer". That is the window Operator Verification item 1 reserves to the operator. The live suites still need every plugin-loaded session closed, this one and the `STEWARD` seat included, so stopping those two went to the operator as its own ask.

## The gate policy

This section owns the policy. The queued plans point here, and a Chapter that cites it cites this file.

The policy applies to `docs/archive/agent_persona_steward-architect_v1.md` from its finishing pass onward, and to `docs/archive/agent_persona_context-budget-removal_v1.md`, `docs/plans/agent_persona_lean-injection_v1.md` and `docs/plans/agent_persona_supervisor-peer_v1.md` whole. It also covers the live suites of `docs/archive/agent_persona_upgrade-check-and-restart-recap_spec_v1.md`, by the operator's ruling on the relay on 2026-09-27, since `.kit/live-all.sh` refuses to start beside a live fleet. It ends when this plan closes.

Deferred to this plan's run: `.kit/live-all.sh`, every `.kit/live-*-test.sh`, `.kit/supervisor-natural-exit-test.sh`, and any other check that launches a `claude` child, real or stub, or runs past two minutes of wall clock. The named files are instances; the class is any run that holds the box.

Still run, where the plan and the executing-work skill place them: `.kit/check-loader-rule.mjs` after any edit to `hooks/`, the mock-driven `.mjs` suites, the shell suites that finish inside two minutes, every acceptance grep with its control, and one run of any test file a section writes or edits. The named deferred set wins over that last rule: an edit to `.kit/supervisor-natural-exit-test.sh` is verified here and not at the section close. The fresh-context reviewer pair runs as before, since it holds no box time.

A Chapter names each deferred run as deferred, never as passed, with the words "deferred under the gate policy of 2026-09-18 to `docs/plans/agent_persona_deferred-gate-run_v1.md`". Where a section's acceptance names a deferred suite, that clause is met by Section 1 below, and the Chapter says so. A finishing pass records the whole gate the same way. Nothing else in a plan changes: red-first tests are still written and watched red where the file that runs them is not deferred.

## Approach

The run is one whole gate over the trunk, taken when the box is free, and read suite by suite. The baseline is the newest Chapter on the trunk that records a whole gate with its counts and exit code, named in Section 1 from the archive, so every delta has a number to diff against. A red is a signal until proven otherwise: the red protocol in the kit's testing-discipline skill owns capture and discrimination, and a flake is isolated and repeated rather than waved off. Attribution reads the red suite's assertion against the four plans' diffs, and where reading does not settle it, reverts one plan's merge in a scratch worktree and re-runs that one suite. A fix lands on its own branch and pull request, re-runs only the suite it reddened, and is named in this plan's Chapter with its cause and the plan it traces to.

## Sections of Work

### 1. The run and the ledger
Model: sonnet

Confirm the trunk carries the merge of every plan the policy covers. Poll the process list for any foreign test runner or build and wait for it. Run `.kit/check-loader-rule.mjs`, then `.kit/supervisor-natural-exit-test.sh`, then `.kit/live-all.sh`, each with its exit code captured to a marker file. Then take the measurements the covered plans deferred to this run, as each plan's own section states them: `docs/plans/agent_persona_supervisor-peer_v1.md` Section 1's measurements 2, 4 and 5, and its Section 3's closing measurement of the probe's time to ack and the heartbeat files advancing under a moved shell, recording as well whether a `[SUPERVISOR-ASK` turn written on the child's stdin while an operator ask is open leaves that ask open, which shows the plugin read the turn's origin as `sdk` since the plugin logs no origin kind itself: an `ask_answered_by_reply` decision for it means the exemption did not fire. Record each result in the plan that deferred it, as an amendment where it contradicts that plan's assumption. Record in the Chapter, per suite: the command, the wall clock, the exit code read from the marker, the pass and fail counts, and every failing case by name, beside the baseline Chapter's counts for the same suite.

Acceptance: the Chapter carries that table for every deferred suite; the baseline Chapter is named by file and heading; a suite that did not run names the reason.

Files in scope: this plan document.

### 2. Attribution and fixes
Model: opus

For every red in Section 1's ledger, apply the red protocol, then trace it to one of the four plans or to the trunk before them, by the Approach's reading-then-revert method. Fix each on its own branch, re-run the reddened suite, and record the fix's pull request, cause and plan in the Chapter. A red that is a flake is recorded with its repeat count and the diagnostics captured. A red whose fix is larger than a round goes to `docs/backlog.md` with its cause and remedy checked against the code.

Acceptance: every ledger red carries one of fixed, flake or filed, with its evidence; every fixed suite has a green re-run with its exit code read from the run; no red is closed on timing or surface signal alone.

Files in scope: whichever files a fix touches, named in the Chapter; `docs/backlog.md`; this plan document.

### 3. Close
Model: sonnet

Flip this plan to Complete, write the close-out Chapter, and move it to `docs/archive/` as the curating-docs skill states, with its `docs/README.md` line. The close-out states that the gate policy has ended and that plans armed after this one gate as the executing-work skill states.

Acceptance: the plan sits in `docs/archive/` at Complete; `docs/README.md` names it there; the close-out Chapter carries the ending sentence.

Files in scope: this plan document, `docs/README.md`.

## Out of Scope

- New tests. This run reads the suites the four plans left behind.
- Shortening the suites themselves. That is its own plan if the operator wants it.
- Any plan armed after this one, which gates under the doctrine again.

## Assumptions

- decided 2026-09-18 by the operator on the coordinator's thread: the runs that hold the box are deferred, and the checks that finish in seconds still run. The words are in the Dispatch Authorization.
- assumed 2026-09-18 (default): two minutes of wall clock is the bound that sorts a check into the deferred set; reversal: the executing session names a check it moved across the bound in its Chapter, and this line is amended.
- assumed 2026-09-18 (default): the named deferred set wins over the run-what-you-edited rule; reversal: none, since the alternative reintroduces the run the operator asked to defer.
- assumed 2026-09-18 (sibling plans): Branch-and-PR; reversal: none, a header edit.
- assumed 2026-09-18 (default): this plan runs last, after the four plans it covers; reversal: the operator's word at arming, and running it earlier only shortens the list of plans it reads.

## Operator Verification

1. The run in Section 1 holds the box for at least one whole gate. The operator chooses when it starts, since that is the cost this policy was written to move. The outcome that holds the work: after Section 3, a whole gate on the trunk is green or every red is filed with its cause.

## Open Questions

- Whether the steward-architect plan's finishing pass had already run a whole gate before the policy took effect. If it had, that gate is the baseline and Section 1 names it. Owner: the dev persona, in the steward-architect plan's next Chapter.

## Related

- `docs/archive/agent_persona_steward-architect_v1.md`, `docs/archive/agent_persona_context-budget-removal_v1.md`, `docs/plans/agent_persona_lean-injection_v1.md`, `docs/plans/agent_persona_supervisor-peer_v1.md`: the plans this policy covers.
- `README.md`, Test Coverage: which suites are live and which are offline.

## Chapters

### Interim board 1 - 2026-09-18

Not a Chapter. Section 1 is unstarted and no repository file changed beyond this document.

**Stage.** The armed queue's leash advanced to this plan, the last of five, after `docs/plans/agent_persona_supervisor-peer_v1.md` was recorded blocked. Nothing of this plan ran. The `Status:` header stays at `Ready`.

**The preceding plan's blocker was tested and does not carry, but this plan's own gate is unmet on two independent grounds.** That blocker is the supervisor-peer plan's arming condition, which is specific to that plan. It stops nothing here.

The first ground is this plan's own subject. Its Goal requires the deferred runs to happen "against the trunk after the last queued plan merges", and Section 1 opens by confirming the trunk carries the merge of every plan the policy covers. Read this session: `origin/main` stands at `266b396`, whose newest commit archives an unrelated poll-cost plan. None of the four covered plans has merged. So there is nothing on the trunk for this run to gate, and running now would measure a tree that carries none of the work the policy deferred.

The second ground is the Dispatch Authorization, which arms execution only on the operator's own word, typed into the executing session's thread or relayed through the coordinator. No such word has been given for this plan.

**Why this matters more than the other blocks.** This plan is where every deferred run is owed. The gate policy of 2026-09-18 suspended the live suites, the natural-exit suite and every check that holds the box, across four plans, on the promise that this one run would take them all. Until this plan runs, that debt stands unpaid and no combined behavior of the four plans has been read.

**The queue is one chain.** `docs/plans/agent_persona_context-budget-removal_v1.md`'s interim board 3 carries the full analysis. It is not repeated here.

**Gate baseline.** None taken. No repository code changed, so no test lane ran and there is nothing to diff. The baseline this plan's Section 1 will need is named there as the newest trunk Chapter recording a whole gate, and it is not selected here because the trunk it must be read against does not yet exist.

**Live dispatches.** None.

**Asks in flight.** One to the repository's Expert seat, recorded in the context-budget plan's board 3. It does not gate and was unanswered at the time of writing.

**Next action.** Nothing, until the four covered plans merge to the trunk and the operator arms this plan on their own word. This is the last plan of the armed queue, so its blocked state releases the session's leash. The goal state stays armed here, and the recovery when work resumes is the run's own `arm --self-armed` naming the plans still to run, in order.

### Interim board 2 - 2026-09-19

Not a Chapter. Section 1 is still unstarted and no repository code changed. The `Status:` header stays at `Ready`.

**Stage.** The armed queue's leash advanced to this plan a second time, the last of five, after `docs/plans/agent_persona_supervisor-peer_v1.md` was recorded blocked a fourth time. Nothing of this plan ran.

**The preceding plan's blocker was tested and does not carry.** That blocker is the supervisor-peer plan's own arming condition, which names that plan's two predecessors. It says nothing about the deferred suites or the trunk this run must gate. It stops nothing here.

**The first ground is unchanged and was re-measured rather than carried from board 1.** Section 1 at line 36 opens by confirming the trunk carries the merge of every plan the policy covers. `origin/main` stands at `266b396`, fetched this session, which is the same commit board 1 recorded and whose newest commit archives an unrelated poll-cost plan. The working branch `steward-architect` is not an ancestor of it. None of the four covered plans has merged, so there is nothing on the trunk for this run to gate.

**The second ground is also unchanged.** The Dispatch Authorization at line 13 arms execution only on the operator's own word, typed into the executing session's thread or relayed through the coordinator. No such word has been given for this plan. Either ground alone holds the run.

**The debt this plan owes is unchanged and still unpaid.** The gate policy of 2026-09-18 suspended every check that holds the box across four plans, on the promise that this one run would take them all. No combined behavior of those four plans has been read, and none can be until they merge.

**Gate baseline.** None taken. No repository code changed, so no test lane ran and there is nothing to diff. Section 1's baseline is still unselectable, because the trunk it must be read against does not yet exist.

**Live dispatches.** None.

**Asks in flight.** One to the repository's Expert seat, recorded in the context-budget plan's board 3. It does not gate and is still unanswered.

**Next action.** Nothing, until the four covered plans merge to the trunk and the operator arms this plan on their own word. This is the last plan of the armed queue, so its blocked state releases the session's leash. The recovery when work resumes is the run's own `arm --self-armed` naming the plans still to run, in order.

### Interim board 3 - 2026-09-19

Not a Chapter. Section 1 is still unstarted and no repository code changed. The `Status:` header stays at `Ready`.

**Stage.** The armed queue's leash advanced to this plan a third time, the last of five, after `docs/plans/agent_persona_supervisor-peer_v1.md` was recorded blocked a fifth time. Nothing of this plan ran.

**The preceding blocker was tested and does not carry.** It is the supervisor-peer plan's own arming condition, naming that plan's two predecessors. It says nothing about the deferred suites or the trunk this run must gate.

**The first ground is re-measured rather than carried.** Section 1 at line 36 opens by confirming the trunk carries the merge of every plan the policy covers. `origin/main` stands at `266b396`, fetched this session. `git merge-base --is-ancestor` confirms the working branch is not an ancestor of it, which is a direct test rather than a reading of the commit's subject line. None of the four covered plans has merged, so there is nothing on the trunk for this run to gate.

**The second ground is unchanged.** The Dispatch Authorization at line 13 arms execution only on the operator's own word, typed into the executing session's thread or relayed through the coordinator. No such word has been given for this plan. Either ground alone holds the run.

**The debt this plan owes is unchanged and still unpaid.** The gate policy of 2026-09-18 suspended every check that holds the box across four plans, on the promise that this one run would take them all. No combined behavior of those four plans has been read, and none can be until they merge.

**Gate baseline.** None taken. No repository code changed, so no test lane ran and there is nothing to diff. Section 1's baseline is still unselectable, because the trunk it must be read against does not yet exist.

**Live dispatches.** None.

**Asks in flight.** One to the repository's Expert seat, recorded in the context-budget plan's board 3. It does not gate and is still unanswered.

**This advance completes the queue's third full lap, and the lap's cost is now filed against the kit rather than against these plans.** Every plan behind the steward plan is held by that one plan closing, and each lap re-derives that fact plan by plan. The kaizen note recorded in `docs/plans/agent_persona_supervisor-peer_v1.md`'s interim board 5 names the friction and two candidate remedies.

**Next action.** Nothing, until the four covered plans merge to the trunk and the operator arms this plan on their own word. This is the last plan of the armed queue, so its blocked state releases the session's leash. The recovery when work resumes is the run's own `arm --self-armed` naming the plans still to run, in order.

### Interim board 4 - 2026-09-19

Not a Chapter. Section 1 is still unstarted and no repository code changed. The `Status:` header stays at `Ready`.

**Stage.** The armed queue's leash advanced to this plan a fourth time, the last of five, after `docs/plans/agent_persona_supervisor-peer_v1.md` was recorded blocked a sixth time. Nothing of this plan ran.

**The preceding blocker was tested and does not carry.** It is the supervisor-peer plan's own arming condition, which names that plan's two predecessors and turns on one of them still being open. It says nothing about the deferred suites or about the trunk this run must gate.

**The first ground is re-measured this session rather than carried.** Section 1 at line 36 opens by confirming the trunk carries the merge of every plan the policy covers. `git fetch origin` ran first, so the tracking ref is fresh rather than assumed, and `origin/main` stands at `266b396`. `git merge-base --is-ancestor HEAD origin/main` exited 1, so the working branch is not an ancestor of the trunk, and `git rev-list --count origin/main..HEAD` returns 81 commits held back. None of the four covered plans has merged.

**One alternative reading was tested and ruled out, which is new since board 3.** Four local branches carry the covered plans' names: `plan/context-budget-removal`, `plan/deferred-gate-run`, `plan/lean-injection` and `plan/supervisor-peer-liveness-amend`. Each could in principle have carried its plan's work to the trunk by another route. Each returns zero for `git rev-list --count origin/main..<branch>` and exits 0 for `git merge-base --is-ancestor <branch> origin/main`, so every one of them sits at or behind the trunk and holds no unmerged work. They are stale pointers from authoring time. So the absence measured above is the whole picture rather than one branch's view of it.

**Board 3's second ground was wrong and is corrected here.** That board held that the Dispatch Authorization's requirement of the operator's own word was unmet. It is met. The operator typed the five-plan queue that names this plan, and the kit-goal skill's arming-is-approval rule states that a typed invocation carries the same authority as a typed "proceed". So one ground holds this run, not two, and a later session should not go looking for a second answer from the operator. The same correction was made this session on `docs/plans/agent_persona_supervisor-peer_v1.md`'s interim board 6, where the two boards had read the same fact in opposite ways.

**The debt this plan owes is unchanged and still unpaid.** The gate policy of 2026-09-18 suspended every check that holds the box across four plans, on the promise that this one run would take them all. No combined behavior of those four plans has been read, and none can be until they merge.

**An observation about machine state, not acted on.** `git worktree list` reports `D:/agent_persona-wt/peer-detach-decision` as prunable. It is left as found, since pruning it is outside this plan and belongs to whoever owns that tree.

**Gate baseline.** None taken. No repository code changed beyond this plan document, so no test lane ran and there is nothing to diff. Section 1's baseline is still unselectable, because the trunk it must be read against does not yet exist.

**Live dispatches.** None.

**Asks in flight.** None of this plan's own. An ask to the repository's Expert seat covering this set of ordering blocks went out again this session and is unanswered, as are the two before it. A routing notice to the coordinator seat naming the whole chain went out beside it.

**This advance completes the queue's fourth full lap.** The kaizen note filed at `docs/plans/agent_persona_supervisor-peer_v1.md`'s interim board 5 names the friction and two candidate remedies. No second note was filed, since a duplicate on the same friction is what the kaizen bar refuses.

**Next action.** Nothing, until the four covered plans merge to the trunk. This is the last plan of the armed queue, so its blocked state releases the session's leash. The recovery when work resumes is the run's own `arm --self-armed` naming the plans still to run, in order, with `docs/plans/agent_persona_steward-architect_v1.md` first.

### Interim board 5 - 2026-09-19

Not a Chapter. Section 1 is unstarted and no repository code changed. The `Status:` header stays at `Ready`.

**Stage.** The armed queue's leash advanced to this plan a fifth time, after `docs/plans/agent_persona_supervisor-peer_v1.md` was recorded blocked a seventh time. This is the last plan of the queue, so its terminal state releases the leash. Nothing of this plan ran.

**The preceding plan's blocker does carry here, which is a different answer from boards 1 to 4.** That blocker was that all four remaining plans need the operator's word to execute. It carries because this plan's own `## Dispatch Authorization` at line 13 has the same shape, read from this file this session: the operator's words of 2026-09-18 are "authorization to author and to apply the policy to the queued plans", and "Execution of this plan is armed only on the operator's own word, typed into the executing session's thread or relayed through the coordinator." The goal state reports this plan as armed by this run for itself. Under the kit-goal skill a self-armed arming carries no authorization of its own and puts the committed grant in the typed invocation's place, so what stands there authorizes authoring and applying the policy, not running the gate. The project memory record `self-armed-arming-does-not-satisfy-an-operator-only-execution-grant`, written this session, holds the general shape.

**Section 1's own first step is unmet, and it is the harder bar.** Section 1 opens "Confirm the trunk carries the merge of every plan the policy covers." The policy at line 19 covers four plans: the steward-architect plan from its finishing pass onward, and the context-budget-removal, lean-injection and supervisor-peer plans whole. The trunk carries none of those merges. The steward plan is in pull request 49, open and unmerged, confirmed this session. The other three have never started, so there is nothing of them to merge. So this plan cannot take its first step whatever the authorization says, and it is last in the queue by construction rather than by preference.

**The plan's open question is now answered, which is new at this board.** The question asked whether the steward-architect plan's finishing pass had already run a whole gate before the policy took effect, and named the dev persona as its owner, to be answered in that plan's next Chapter. That Chapter is now written. `docs/archive/agent_persona_steward-architect_v1.md` line 1014 records a whole gate taken after the policy took effect and answers the question in the negative in its own words: that effort never ran a pre-policy whole gate, so its run cannot serve as this plan's baseline for the deferred suites. It does serve as a baseline for the sixteen suites it did run, and that Chapter carries their counts. So Section 1's baseline for the deferred suites must come from elsewhere or be established by Section 1's own run, and the Open Questions entry can be retired at arming rather than re-asked.

**A third condition sits outside both bars and is the operator's too.** Operator Verification item 1 states that the run holds the box for at least one whole gate and that the operator chooses when it starts, since that cost is what the policy was written to move. Beyond that, `.kit/live-all.sh` refuses beside any live `persona:` claim and the fleet is live, so the contention lane cannot run until the fleet is quiet. That is a scheduling precondition rather than a defect, and it means arming this plan is also a decision about when to take the box down.

**Gate baseline.** None taken. No repository code changed beyond this plan document, so no test lane ran and there is nothing to diff.

**Live dispatches.** None.

**Asks in flight.** One to the repository's Expert seat, sent this session under the lean-injection plan's declaration, on that plan's authorization gap. It does not cover this plan and does not gate. A notice went to the `coordinator` seat naming the chain.

**A channel message arrived mid-lap and was not acted on.** It read "Drop the rounding guard, per the relay from AP: Expert", named no surface this repository carries, and matched no work in any of the five plans. The harness delivered it marked as untrusted external data rather than operator steering. A second message retracted it as sent to the wrong channel. It is recorded here because an instruction that arrives on a channel and is declined should leave a trace.

**Next action.** Nothing, until the four plans the policy covers are merged to the trunk and the operator arms this run on their own word, choosing a window in which the box can be held and the fleet is quiet. Section 1 then confirms the trunk, polls for a foreign runner, and runs the deferred suites with each exit code captured to its own marker.
### Interim board 6 - 2026-09-27

Not a Chapter. The deferred suites did not run, so the `Status:` header stays at `Ready`. One command Section 1 names did run, as a readiness probe rather than as the section's work, and it is recorded below.

**Two of the three gates are met for the first time, which reverses boards 1 to 5.** Those boards refused on the trunk reading. That reading is now stale and was re-measured this session rather than carried.

**The trunk gate is met.** Section 1 opens "Confirm the trunk carries the merge of every plan the policy covers." The policy at line 19 covers four plans, and all four are now `Status: Complete` and archived on `origin/main`, read from the trunk itself with `git show origin/main:<path>` rather than from the working tree: `docs/archive/agent_persona_steward-architect_v1.md`, `docs/archive/agent_persona_context-budget-removal_v1.md`, `docs/archive/agent_persona_lean-injection_v1.md` and `docs/archive/agent_persona_supervisor-peer_v1.md`. The steward plan's pull request 49 merged on 2026-09-20 at commit `952e940`, and `git merge-base --is-ancestor` confirms that commit is an ancestor of `origin/main`, which stands at `327f6fe` after a fetch this session. Board 5 recorded that pull request as open and recorded the other three as never started, so both halves of its reading have since changed. The last two of the four moved from `docs/plans/` to `docs/archive/`, which is why a check written against their old paths reports them missing rather than unstarted.

**The authorization gate is met, and it always was at this file's own reading.** Board 5 read the goal state, found a self-armed arming, and concluded the run was unarmed. This file's own Dispatch Authorization section at line 16 records the operator's execution arming: a `/kit-goal` invocation naming this plan, relayed on the operator's own channel on 2026-09-19, which is the channel this section reserves the arming to, and which that paragraph states approves this plan as written. That paragraph exists precisely because the arming state does not keep the operator's invocation once a run re-arms a queue for itself. So the file is the surface to read here and the goal state is not.

**The third gate is unmet and only the operator can meet it.** `.kit/live-all.sh` exits 10 beside any live `persona:` claim. Its own comment at line 91 states that any plugin-loaded session claims `persona:default` at session start, so an open plain session is enough to trip the check, and calls that the check working rather than a defect. A machine poll this session returned six `claude` processes holding about 1052 MB, seventeen `node`, eight `powershell` and one `pwsh`, with no `testhost`, `dotnet` or `MSBuild`, so no foreign test runner or build. The session writing this board is itself one of those six and holds a claim of its own, so it cannot clear the check even for itself. Operator Verification item 1 already assigns the start to the operator, on the ground that the run holds the box for at least one whole gate. What is needed is therefore a window in which no plugin-loaded session is open, which is an act outside this session's reach rather than a decision it could rule.

**One readiness probe ran and passed.** `node .kit/check-loader-rule.mjs` exits 0 with `PASS: no loader-rule violations in hooks/*.ts`, the code read from its own marker file rather than from a pipeline. That command sits in the policy's still-run list and launches no child, so running it beside the fleet breaks no contention rule. It is also the guard `.kit/live-all.sh` checks before it spawns anything, so its pass means a granted window would not be spent on a loader refusal. It is a readiness reading and not Section 1's deliverable, which is the deferred suites and their table.

**Gate baseline.** None taken for the deferred suites, which is what Section 1 exists to establish. The baseline question board 5 answered stands: `docs/archive/agent_persona_steward-architect_v1.md` records no pre-policy whole gate, so the deferred suites have no prior counts to diff against and Section 1's own run is where they start.

**Live dispatches.** None.

**Asks in flight.** None from this session. The expert ask executing-work requires before a declaration was not sent, because this session holds the `WORKER:DEV-PERSONA` ground and `fleet_status` refuses it the roster read, so no live expert seat could be identified. The blocker is also a physical window rather than a question, so an answer could not have prevented the declaration. A notice went to the `STEWARD` seat naming the flipped gate.

**Next action.** The operator names a window with the fleet down, including this session, and the run then polls for a foreign runner, runs `.kit/supervisor-natural-exit-test.sh` and `.kit/live-all.sh` with each exit code captured to its own marker, takes the measurements `docs/archive/agent_persona_supervisor-peer_v1.md` Sections 1 and 3 deferred here, and writes the per-suite table Section 1's acceptance requires.
### Interim board 7 - 2026-09-29

Not a Chapter. Section 1 is running. The `Status:` header reads `In Progress` from this board on, changed from `Ready` when the operator cleared the run on 2026-09-29 (recorded in the Dispatch Authorization).

**The trunk gate is still met.** `origin/main` stands at `4557c7e` after a fetch this session, and every plan the policy covers is archived there, as board 6 read. This branch, `plan/deferred-gate-run`, is cut from that commit and carries board 6 cherry-picked from the retired `plan/deferred-gate-board`.

**The natural-exit half is running, and the live half is not.** `.kit/supervisor-natural-exit-test.sh` isolates itself with its own HOME and a stub `claude`, so it runs beside a live fleet. It started 22:03:30Z with its exit code going to `.kit/scratch/deferred-gate/ne.exit`. `.kit/live-all.sh` refuses beside any live persona claim, and a read of every store this session found all six roster personas live with heartbeats under two seconds old: STEWARD, ARCHITECT, DEV-PERSONA, DEV-PLUGIN, DEV-DISCORD and ASSISTANT. The operator approved stopping STEWARD and this session on a reading that named only those two. The corrected reading went back to the operator as an ask to stop all six, and it is open.

**The stop is prepared.** A one-shot waiter, `.kit/scratch/deferred-gate/live-waiter.ps1` in this worktree, runs as its own S4U scheduled task outside every persona tree. It writes `shutdown.request` into each run directory, waits until every `AgentPersona-*` task leaves Running and the refuse check passes, runs `.kit/live-all.sh` from `D:agent_persona` with the exit code to `live/live.exit`, then removes any leftover request, releases each persona with `Start-Persona.ps1 -Release` and starts its task. Two controls ran: a test S4U task registered, ran as `scott-claudelocaladmin` and was removed, and the waiter's refuse snippet exits 1 naming STEWARD against the live fleet.

**Three reds so far, one cause, traced and fixed on its own branch.** The suite's static pins `a root_complete detail is found`, `every root_complete decision yielded a detail (0/1)` and `no root_complete detail carries the reader's substring` fail because `64e8f2a` (the goal-levels plan) moved every `root_complete` write into a `completeRoot(dp, rootId, detail)` helper that passes its detail through. The pin read backtick literals inside the decision and found none. The fix is on `fix/root-complete-pin`: the pin reads the literal details on each `completeRoot(` call line and asserts one write, by the helper passing `detail,` through. It passes against the real hooks and fails its own check against three altered copies. A whole-suite green re-run is owed once this run ends.

**Next action.** Read `ne.exit` and write the Section 1 table. Then, on the operator's answer, run the waiter now or at the time they name.
