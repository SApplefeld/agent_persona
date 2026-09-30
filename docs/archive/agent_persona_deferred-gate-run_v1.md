# Deferred gate run

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-18

## Goal

When this is done, every test run the gate policy below deferred has run once against the trunk after the last queued plan merges, every red from that run is traced to the plan that caused it, and each is fixed or filed with its cause named. The policy is then lifted, and plans armed after this one gate as the executing-work skill states. It matters because four plans are landing on `hooks/index.ts` and `bin/supervise.sh` without the runs that prove them together, so this run is the only place their combined behavior is read before the fleet relies on it.

## Dispatch Authorization

The operator asked for this on 2026-09-18 on the coordinator's own Discord thread. Their words: "The 40+ minute gates whenever we need to run a test are blocking other development." and "when all the plans are done, we can do a test run and evaluate any that fail as a wholly separate circle back to fix things." Offered the choice between suspending every check and suspending only the runs that hold the box, they answered "I'm good with Option 2." That is authorization to author and to apply the policy to the queued plans. Execution of this plan is armed only on the operator's own word, typed into the executing session's thread or relayed through the coordinator. The executor is the dev persona.

The operator armed execution on 2026-09-19, naming this plan in a `/kit-goal` invocation relayed to the executing session on the operator's own channel, which is the channel this section reserves the arming to. That is the execution arming, given separately from the authorization to author above, and it approves this plan as written. It is recorded here because the arming state itself does not keep it: a run that re-arms a queue for itself after a session ends records its own invocation and no longer reads the operator's, so a later session reading only that state would find this plan unarmed. The project memory record `self-armed-arming-does-not-satisfy-an-operator-only-execution-grant` holds the general shape.

On 2026-09-29 the operator cleared this run again on the executing session's own relay thread: "You're cleared to do all of them in whatever order you recommend, and the box is quiet except for you, so you can run the deferred test whenever you prefer". That is the window Operator Verification item 1 reserves to the operator. The live suites still need every plugin-loaded session closed, this one and the `STEWARD` seat included, so stopping those two went to the operator as its own ask.

Later on 2026-09-29 a full read found all six roster personas live, and the operator answered the widened ask on the same thread: "Go ahead and do Option 1." Option 1 was to stop all six now, run the live suites, and restart all six through the prepared waiter.

On 2026-09-30 the first stop was voided by a waiter defect, recorded in interim board 11. The operator approved a second stop on the same thread: "Yes, please proceed."

## The gate policy

This section owns the policy. The queued plans point here, and a Chapter that cites it cites this file.

The policy applies to `docs/archive/agent_persona_steward-architect_v1.md` from its finishing pass onward, and to `docs/archive/agent_persona_context-budget-removal_v1.md`, `docs/archive/agent_persona_lean-injection_v1.md` and `docs/archive/agent_persona_supervisor-peer_v1.md` whole. It also covers the live suites of `docs/archive/agent_persona_upgrade-check-and-restart-recap_spec_v1.md`, by the operator's ruling on the relay on 2026-09-27, since `.kit/live-all.sh` refuses to start beside a live fleet. It ends when this plan closes.

Deferred to this plan's run: `.kit/live-all.sh`, every `.kit/live-*-test.sh`, `.kit/supervisor-natural-exit-test.sh`, and any other check that launches a `claude` child, real or stub, or runs past two minutes of wall clock. The named files are instances; the class is any run that holds the box.

Still run, where the plan and the executing-work skill place them: `.kit/check-loader-rule.mjs` after any edit to `hooks/`, the mock-driven `.mjs` suites, the shell suites that finish inside two minutes, every acceptance grep with its control, and one run of any test file a section writes or edits. The named deferred set wins over that last rule: an edit to `.kit/supervisor-natural-exit-test.sh` is verified here and not at the section close. The fresh-context reviewer pair runs as before, since it holds no box time.

A Chapter names each deferred run as deferred, never as passed, with the words "deferred under the gate policy of 2026-09-18 to `docs/plans/agent_persona_deferred-gate-run_v1.md`". Where a section's acceptance names a deferred suite, that clause is met by Section 1 below, and the Chapter says so. A finishing pass records the whole gate the same way. Nothing else in a plan changes: red-first tests are still written and watched red where the file that runs them is not deferred.

## Approach

The run is one whole gate over the trunk, taken when the box is free, and read suite by suite. The baseline is the newest Chapter on the trunk that records a whole gate with its counts and exit code, named in Section 1 from the archive, so every delta has a number to diff against. A red is a signal until proven otherwise: the red protocol in the kit's testing-discipline skill owns capture and discrimination, and a flake is isolated and repeated rather than waved off. Attribution reads the red suite's assertion against the four plans' diffs, and where reading does not settle it, reverts one plan's merge in a scratch worktree and re-runs that one suite. A fix lands on its own branch and pull request, re-runs only the suite it reddened, and is named in this plan's Chapter with its cause and the plan it traces to.

## Standing Brief Amendments

- A test fixture that a Section 2 fix leaves out of step with the code it controls is corrected under Section 2, as one changed fixture with no new test or case.
- Section 2 files, with its cause named and no code or test, a red that a fix's review or a live acceptance check surfaces, beside the reds the deferred suites produce.

## Sections of Work

### 1. The run and the ledger
Model: sonnet

Confirm the trunk carries the merge of every plan the policy covers. Poll the process list for any foreign test runner or build and wait for it. Run `.kit/check-loader-rule.mjs`, then `.kit/supervisor-natural-exit-test.sh`, then `.kit/live-all.sh`, each with its exit code captured to a marker file. Then take the measurements the covered plans deferred to this run, as each plan's own section states them: `docs/archive/agent_persona_supervisor-peer_v1.md` Section 1's measurements 2, 4 and 5, and its Section 3's closing measurement of the probe's time to ack and the heartbeat files advancing under a moved shell, recording as well whether a `[SUPERVISOR-ASK` turn written on the child's stdin while an operator ask is open leaves that ask open, which shows the plugin read the turn's origin as `sdk` since the plugin logs no origin kind itself: an `ask_answered_by_reply` decision for it means the exemption did not fire. Record each result in the plan that deferred it, as an amendment where it contradicts that plan's assumption. The same holds for every other run a covered plan's Chapter records as deferred to this plan, among them `.kit/live-stopprocesstree-test.sh`, `.kit/supervisor-natural-exit-parallel.sh`, the steward-architect plan's Section 4 live Coordinator-seat check and Section 5 architect settings read, and the lean-injection plan's Section 2 live child launch. Record in the Chapter, per suite: the command, the wall clock, the exit code read from the marker, the pass and fail counts, and every failing case by name, beside the baseline Chapter's counts for the same suite.

Acceptance: the Chapter carries that table for every deferred suite; the baseline Chapter is named by file and heading; a suite that did not run names the reason.

Files in scope: this plan document; the archived plans that deferred a run here, for their results; `docs/backlog.md`.

### 2. Attribution and fixes
Model: opus

For every red in Section 1's ledger, apply the red protocol, then trace it to one of the four plans or to the trunk before them, by the Approach's reading-then-revert method. Fix each on its own branch, re-run the reddened suite, and record the fix's pull request, cause and plan in the Chapter. A red that is a flake is recorded with its repeat count and the diagnostics captured. A red whose fix is larger than a round goes to `docs/backlog.md` with its cause and remedy checked against the code.

Acceptance: every ledger red carries one of fixed, flake or filed, with its evidence; every fixed suite has a green re-run with its exit code read from the run; no red is closed on timing or surface signal alone.

Files in scope: whichever files a fix touches, named in the Chapter; `docs/backlog.md`; this plan document.

### 3. Close
Model: sonnet

Flip this plan to Complete, write the close-out Chapter, and move it to `docs/archive/` as the curating-docs skill states, with its `docs/README.md` line. The close-out states that the gate policy has ended and that plans armed after this one gate as the executing-work skill states. It also records the operator's ruling on the supervisor-peer plan's measurement 5, the usage-limit measurement, in that plan and here, or, where the operator has not answered by the close, carries it as an operator-pending item there and here.

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
2. Rule on the supervisor-peer plan's measurement 5, which drives the account all six personas share into its usage limit. The run recommends skipping it. An answer to run it reopens this plan as a new round. Decided 2026-09-30: skipped, on the operator's word on the relay thread. The measurement needs the account rotator, Claude-Swap, stopped first, so one account reaches its five-hour limit without exhausting the rest, and the operator could not prepare the machine for that. `docs/backlog.md` carries the measurement as its own entry.
3. Review and approve pull requests 130 and 129, the tick-suite fixture fix and the parallel runner fix, each armed to merge on approval, and this plan's own pull request. The trunk's tick suite stays red on the `gl6` control until 130 merges.

## Open Questions

- Whether the steward-architect plan's finishing pass had already run a whole gate before the policy took effect. If it had, that gate is the baseline and Section 1 names it. Owner: the dev persona, in the steward-architect plan's next Chapter.

## Related

- `docs/archive/agent_persona_steward-architect_v1.md`, `docs/archive/agent_persona_context-budget-removal_v1.md`, `docs/archive/agent_persona_lean-injection_v1.md`, `docs/archive/agent_persona_supervisor-peer_v1.md`: the plans this policy covers.
- `README.md`, Test Coverage: which suites are live and which are offline.
- `docs/archive/agent_persona_upgrade-check-and-restart-recap_spec_v1.md`: the policy covered its live suites by the operator's ruling of 2026-09-27, and its results block records their run.

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

**The stop is prepared.** A one-shot waiter, `.kit/scratch/deferred-gate/live-waiter.ps1` in this worktree, runs as its own S4U scheduled task outside every persona tree. It writes `shutdown.request` into each run directory, waits until every `AgentPersona-*` task leaves Running and the refuse check passes, runs `.kit/live-all.sh` from `D:\agent_persona` with the exit code to `live/live.exit`, then removes any leftover request, releases each persona with `Start-Persona.ps1 -Release` and starts its task. Two controls ran: a test S4U task registered, ran as `scott-claude\localadmin` and was removed, and the waiter's refuse snippet exits 1 naming STEWARD against the live fleet.

**Three reds so far, one cause, traced and fixed on its own branch.** The suite's static pins `a root_complete detail is found`, `every root_complete decision yielded a detail (0/1)` and `no root_complete detail carries the reader's substring` fail because `64e8f2a` (the goal-levels plan) moved every `root_complete` write into a `completeRoot(dp, rootId, detail)` helper that passes its detail through. The pin read backtick literals inside the decision and found none. The fix is on `fix/root-complete-pin`: the pin reads the literal details on each `completeRoot(` call line and asserts one write, by the helper passing `detail,` through. It passes against the real hooks and fails its own check against three altered copies. A whole-suite green re-run is owed once this run ends.

**Next action.** Read `ne.exit` and write the Section 1 table. Then, on the operator's answer, run the waiter now or at the time they name.

### Interim board 8 - 2026-09-29

Not a Chapter. The natural-exit half of Section 1 has run once on the trunk and its reds are traced and fixed on their own branches. The live half has not run, because it needs every persona stopped and the operator has not yet answered that ask.

**Section 1 ledger so far.** There is no baseline to diff against, per board 6: no pre-policy whole gate exists for these suites.

| Suite | Command | Wall clock | Exit | Pass / fail | Failing cases |
|---|---|---|---|---|---|
| Loader rule | `node .kit/check-loader-rule.mjs` | seconds | 0 | PASS | none |
| Natural exit, trunk `4557c7e` | `bash .kit/supervisor-natural-exit-test.sh` | 22:03:30Z to 22:35:43Z, 32 min | 1, from `ne.exit` | 326 OK / 5 FAIL | the three `root_complete` detail pins; `(pkdu) the exit line names what the stop could not clear`; `(pkdu) the supervisor exits 5 rather than reporting the park as honored (rc=6)` |
| Live suites | `bash .kit/live-all.sh` | not run | none | none | not run: the suite refuses beside a live persona claim, and all six roster personas are live |

The supervisor-peer measurements Section 1 names need the fleet stopped too, so they wait with the live half.

**Red 1: the three `root_complete` detail pins.** The cause is `64e8f2a`, from the goal-levels plan, which moved every `root_complete` write into a `completeRoot` helper. The fix is on `fix/root-complete-pin`, commit `f046f8b`, and it also closes a reader defect the review found: a `goal_done` note containing the word "backfilled" read as a backfilled root. Its targeted lanes are green: supervisor unit 99/99 and poll unit 80/80.

**Red 2: case `(pkdu)`, two checks.** It is a test defect, and the supervisor's own reading was true. The case failed 3 of 3 isolated runs on the trunk. `git bisect` over the 39 supervisor commits since the case was added named `ec2e415`, from the supervisor-peer plan, as the first bad commit. That commit routes the holder kill through `kill_process_snapshot`, the function the case's injection forces to fail. So the stop never closed the child's input, waited out the 60-second grace, and sent TERM. The 90-second survivor process ended on its own before the check, so the tree read as clear and the supervisor exited 6. The fix is on `fix/pkdu-holder-injection`, commit `260d84a`: the injection spares the holder's exact call, a pin holds that call's text, and the case checks it never waited out the grace. Cases r, u, pku and pkdu on the fix exit 0, 34 OK.

**Green re-run.** One whole natural-exit run over a scratch tree carrying both fixes is in progress, with its exit code going to `.kit/scratch/deferred-gate/ne2.exit`.

**Other fixes in flight from this session's mandate.** Pull request 125 carries the subagent-report fix: the tick suite is red on the old code (exit 5, the five new checks) and green on the fix (exit 0, 6205 OK). Pull request 126 carries the override version floor. Both have auto-merge armed.

**Next action.** Read `ne2.exit`. On green, push both suite fixes and open their pull requests. Then run the live half once the operator answers.

### Interim board 9 - 2026-09-29

Not a Chapter. Both natural-exit reds are fixed, with a green whole-suite re-run and a pull request each. The live half still waits on the operator's answer to the six-persona stop.

**Green re-run.** The table row sits beside board 8's trunk row.

| Suite | Command | Wall clock | Exit | Pass / fail | Failing cases |
|---|---|---|---|---|---|
| Natural exit, trunk plus both fixes | `bash .kit/supervisor-natural-exit-test.sh` over `f046f8b` with `260d84a` cherry-picked | 23:12:50Z to 23:44:22Z, 32 min | 0, from `ne2.exit` | 335 OK / 0 FAIL | none |

The nine extra passes over the trunk's 326 are the five fixed checks and four new ones: two `root_complete` run pins, the holder pin and the pkdu grace check. Both injection pins read OK in this run.

**Red dispositions.**

| Red | Disposition | Cause and plan | Fix |
|---|---|---|---|
| Three `root_complete` detail pins | fixed | `64e8f2a`, the goal-levels plan | pull request 127, `fix/root-complete-pin` |
| `(pkdu)`, two checks | fixed, test defect | `ec2e415`, the supervisor-peer plan, by bisect | pull request 128, `fix/pkdu-holder-injection`, with the review's two Minors applied in `8391669`; `--cases r pkdu` exits 0, 18 OK |

**Filed to `docs/backlog.md`.** First, case `(nf)` leaves its first supervisor and holder running after every whole run. Both runs here leaked one pair each, and four processes were killed by hand. Second, a failed holder kill still logs "input closed", the review's third Minor.

**Pull requests.** 125 merged as `ad4d089`. 126 has main merged in, with its archive conflict resolved and its gates re-run green. 127 and 128 are open. All three have auto-merge armed and wait on the operator's review.

**Next action.** On the operator's yes, commit and push everything, then register the waiter and run the live half. Without it, the live half holds.

### Interim board 10 - 2026-09-29

Not a Chapter. The operator approved stopping all six personas, recorded in the Dispatch Authorization. Pull requests 126, 127 and 128 have merged, so the trunk is `c777ceb`, and the main checkout the waiter runs `.kit/live-all.sh` from was fast-forwarded to it.

**The live half starts now.** The waiter `.kit/scratch/deferred-gate/live-waiter.ps1` runs as the one-shot task `DeferredGate-LiveWaiter`. It stops this session with the fleet. Its markers land under `.kit/scratch/deferred-gate/live/` in this worktree: `waiter.log`, `stop.result`, `live-all.log`, `live.exit` and `done`.

**Next action, for the session that resumes after the restart.** Read `done`, `stop.result` and `live.exit`. Confirm all six `AgentPersona-*` tasks are Running again. Then write the live row into the Section 1 table, trace any red under Section 2, and take the supervisor-peer measurements Section 1 names if the window allows. If `done` is absent, read `waiter.log` for where it stopped, and restart any persona still held with `Start-Persona.ps1 -Release` and `Start-ScheduledTask`.

### Interim board 11 - 2026-09-30

Not a Chapter. The fleet stopped and restarted as planned, but the live suites did not run. The cause is a defect in the waiter, now fixed, and a second stop needs the operator's word.

**What happened.** The waiter stopped all six personas by 00:25:13Z, STEWARD last after about five minutes. `.kit/live-all.sh` then exited 10, its refuse code, 27 seconds in, read from `live/live.exit`. Its log reads `refuse-check FAIL: live persona claim in .../agentic-plugin_agent-persona-54422876af67.json: persona:STEWARD (age 54s)`. The waiter restarted all six, and all six `AgentPersona-*` tasks read Running at 00:26:45Z.

**Cause: the waiter's own pre-check passed on a mangled path.** It ran the refuse check as a `bash -c` string from Windows PowerShell 5.1, which re-quotes embedded double quotes when it calls a native program. The installed store's path arrived with `[@]` appended, the check skipped it as absent, and it passed after reading one store. Had it read correctly, it would have waited the extra seconds for STEWARD's claim to age past the 90-second bound. Board 7's control ran the snippet from a different shell, so it never exercised the task's invocation.

**Evidence.** Against the live fleet at 00:27Z, under `powershell.exe`, the inline snippet exits 0 reading one store, and the same check run from a file exits 1 naming `persona:ARCHITECT (age 13s)`. The probe is `.kit/scratch/deferred-gate/refuse-probe.ps1`.

**Fix.** The check now lives in `.kit/scratch/deferred-gate/refuse-check.sh`, and the waiter calls it as a file. The patched waiter parses under PowerShell 5.1 with zero errors.

**Section 1 ledger row.** Live suites: `bash .kit/live-all.sh`, 00:25:13Z to 00:25:40Z, exit 10 from `live.exit`, no cases ran. Reason: refused on a live STEWARD claim 54 seconds old.

**Next action.** On the operator's yes, register the waiter again. On `done`, read `live.exit` and write the live row.

**Second stop approved.** The operator answered "Yes, please proceed." The waiter was registered again as `DeferredGate-LiveWaiter` with the file-based check. The resuming session follows board 10's next action.

### Interim board 12 - 2026-09-30

Not a Chapter. The live half of Section 1 has run and is green. What remains of Section 1 is the supervisor-peer measurements, which need no fleet stop.

**The second stop worked.** The waiter wrote every shutdown request at 02:51:56Z. STEWARD's task was the last to stop, and its claim aged past the 90-second bound at 02:58:37Z, when the file-based refuse check passed on 2 stores read. The waiter restarted all six personas from 03:11:25Z, logged each task Running at 03:12:29Z, and wrote `done`. A read at 03:12Z shows all six `AgentPersona-*` tasks Running. `stop.result` reads `stopped`.

**Live ledger.** Measured on trunk `c777ceb`, the main checkout clean but for the untracked `.claude/worktrees/`, with every persona stopped for the `live-all.sh` row. There is no baseline to diff against, per board 6.

| Suite | Command | Wall clock | Exit | Pass / fail | Failing cases |
|---|---|---|---|---|---|
| Live suites | `bash .kit/live-all.sh`, profile `short`, engine 2.1.283 | 02:58:37Z to 03:11:24Z, 13 min | 0, from `live/live.exit` | 4 suites / 0 failures: goaltree, commons, operator, restartrequest | none |
| Stop process tree | `bash .kit/live-stopprocesstree-test.sh`, beside the restarted fleet | 03:13:28Z to 03:19:26Z, 6 min | 0, from `live/spt.exit` | 38 checks / 0 failed, from the suite's own total line | none |

`live-all.sh` runs the four suites its `ALL_SUITES` line names. The fifth live suite states at its line 40 that it holds no persona claim and that `live-all.sh` does not run it, so it ran separately beside the fleet.

**Two leaked processes from the natural-exit runs were cleaned up.** Two `supervisor-natural-exit-test.sh` shells, started at 22:27Z and 23:36Z on 2026-09-29 inside this plan's two whole runs, were still alive with no parent. Each held one `node` loop stamping a heartbeat file under a `D:/Temp/tmp.*/ne/wd/` scratch directory for persona `natexit`. All four processes were killed. That leak is the `(nf)` case already filed to `docs/backlog.md` at board 9.

**Remaining Section 1 work.** The supervisor-peer measurements: its Section 1 measurements 2, 4 and 5, and its Section 3 closing measurement. The fleet's six mailboxes hold no probe records, so no production data stands in for them.

**Next action.** Take the measurements, record them in the supervisor-peer plan, and write the Section 1 Chapter.

### Chapter 1 - 2026-09-30
Completed: 1. The run and the ledger
Implemented By: main session for the suite runs, the reads and the ledger; implementer-sonnet for the supervisor-peer measurements
Metrics: review rounds 5, closed major-closed; provenance 4 spec-traceable Criticals and 25 spec-traceable Majors across rounds 1 to 5, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations none; consults 0
Decisions / Surprises:
- As written at the resume and superseded by the next line on measurement 5: Section 1 resume (2026-09-30): takes the supervisor-peer measurements 2 and 4 and its Section 3 closing measurement with one supervised real child, and records measurement 5 as cannot-measure; serves Section 1's measurement sentence and its acceptance; adds no mechanism, only scratch scripts; size about three scripts and one Chapter; not building it leaves the supervisor-peer plan's two defaults (priming-turn line form, sdk origin) unconfirmed.
- **The open line's measurement 5 reading was superseded.** Measurement 5 is not taken and is not recorded as cannot-measure. The consultant ruling in the supervisor-peer plan's interim board 1, not a consult of this run, holds that it needs the operator's own yes. The operator was asked on 2026-09-30, with a recommendation to skip it, and Section 3's close-out records the answer.
- **Approval drift, made deliberately, four edits.** Section 1's Files in scope names only this plan document, and the section also wrote results blocks into nineteen archived plans and entries into `docs/backlog.md`, since its own text sends each result to the plan that deferred it. Section 1's text named only the supervisor-peer measurements beyond the three suites. The round 1 review found four more runs the covered plans' Chapters defer here, so Section 1 now names every deferred run, which the Goal already covered. Section 1 and the Related list also pointed at `docs/plans/` paths for the supervisor-peer and lean-injection plans, which have moved to `docs/archive/`, and now point there. Section 3 now names measurement 5's ruling as part of the close-out.
- **Every plan that deferred a run here now carries its results.** The supervisor-peer plan's "End-run measurements - 2026-09-30" block, and an "End-run results - 2026-09-30" block in each of the other twenty-one: the steward-architect, lean-injection, context-budget-removal and upgrade-check plans the policy names, and the seventeen below that applied it on their own. Commit `1259a48`'s title claimed this at eighteen, before round 5 found three more.
- **The plans that applied the policy on their own are recorded in too.** Round 3 closed this with a scope ruling, which the kit does not allow for a correctness Critical, so round 4's fix round recorded results instead. The sweep that found them runs over `docs/archive/*.md` for any of "2026-09-18 policy", "operator gate policy", "gate policy", "deferred-gate", "deferred gate", "deferred under", "deferred by", "deferred per", "deferred to" and "named deferred", case-insensitive, and reads each match that carries no results block. Its control is that it finds all nineteen plans that already carried one. A plan deferring a run in words none of these phrases holds would not be found. Of the plans it finds with no deferral here, four state that the policy does not cover them and their gates defer nothing: dead-claim-release, drop-doorbell, keeper-park and supervisor-gaps. Four more match only on an unrelated use of "deferred": coordinator_v2, idle-queue, task-password-logon and the commons plan. The seventeen that deferred runs here on their own are supervisor-poll-cost, goal-levels, goal-tree-curation, inbox-drain, direct-lines-to-architect, nudge-state, boundary-compaction, autonomy-dial, goal-every-turn, jev-memory-gate, jev-question-quality, persona-memory-port, backstop-turn-guard, task-list, decision-seam, plan-health-from-the-record and self-review-flood. Decision-seam states the policy does not cover it, yet its finishing gate deferred six suites by it. Most of what they deferred is the shared suites this ledger runs. Three items are not: goal-every-turn also deferred `.kit/supervisor-model-test.sh` and `.kit/persona-live-refuse-test.sh`, which now have rows below; supervisor-poll-cost deferred its whole gate, whose offline lanes every later trunk whole gate has run; and inbox-drain deferred a live proof that the harness accepts a submit made right after a completion, which no suite here was read for, so it is filed to `docs/backlog.md` rather than claimed.
- **Board 12 carried four errors, corrected here.** It said no baseline exists for these suites, where each has one, named in the table below. It called the leaked processes "two" and killed four: two test shells and one `node` heartbeat loop under each. It attributed them to the `(nf)` backlog entry, which names a different pair, a `bin/supervise.sh` and its holder. The leak is case `(ne)`'s and has its own backlog entry. And it gave the persona tasks' Running log as 03:12:29Z, where `waiter.log` shows 03:12:27Z to 03:12:29Z.
- **The measurement child ran on a scratch `bin/` copy for the whole run.** Its holder relays any one-block user turn from the ask-request file, where trunk's relays only a `[SUPERVISOR-ASK` line. The supervisor-peer plan's measurement record states why no result depends on it.
- **The late busy probe is the design, not a window defect.** A first reading filed it as a probe window too short for a busy child. The controller tick returns while a turn is open (`hooks/index.ts:6862`), which the supervisor-peer Approach states, so a probe is acknowledged only between turns. That backlog entry was withdrawn before commit.
- **The parallel runner is a red for Section 2, already on the backlog since 2026-09-23.** It schedules only the driven cases on its hard-coded `ORDER` line, 22 of the suite's 42, and the pre-drive checks after a skipped case run nowhere. So its green says nothing about the rest.
Failed approaches: tried a `bash -c` string for the waiter's refuse check under Windows PowerShell 5.1, failed because 5.1 re-quotes embedded double quotes for a native call and mangled the store path, learned to run such a check from a script file (interim board 11).
Assumptions: none
Review Findings: review: adversarial at opus, Workflow (high), 5 rounds; blind: no code diff. Round 1, Critical fixed: four runs the covered plans deferred here were missing from the ledger; each now has a row. Round 1 Majors fixed: the no-baseline claim; no Chapter or per-suite rows; the late probe's wrong cause; two measurement results left as narrative, now amendments in the supervisor-peer Approach and its 2026-09-17 assumption; the measurement record's missing commands and its trunk-holder claim; measurement 5 labelled cannot-measure; figures without host, moment or contention. Round 2, Critical fixed: results were recorded only in the supervisor-peer plan; every deferring plan now carries its own. Round 2 Majors fixed: four baselines wrong or not the newest, including a false attribution of the stop-tree suite's added checks; the amended Approach paragraph still contradicting itself about the heartbeat and overclaiming; the steward row missing two of its three legs; measurement 5 with no home and an ask described before it was sent; the leak entry not naming case `(ne)`; a pointer to a moved plan. Minors fixed across both rounds: the leak misattribution, the shared-store record the measurement left, the probe result not compared against its window, the unrecorded poll predicate, the commons count, the architect row's launcher, and small figure errors. One Minor partly met: the natural-exit suite on `c777ceb` ran only through the parallel runner's 22 cases, and Section 2's re-run over the runner fix covers the rest. Round 3, Critical fixed in round 4's fix round: nineteen other plans cite this plan, and each that deferred a run here now carries its results. Round 3's own fix round had closed it with a scope ruling instead, which the kit does not allow for a correctness Critical. Round 3 Majors fixed: the parallel row's coverage overstated, since pre-drive checks after a skipped case ran nowhere; the stop-process-tree result missing from two covered plans' blocks; the moved-shell heartbeat leg presented as measured, now partly measured. Round 3 Minors fixed: the two departures from Section 1's text named, the loader exit marked inferred, byte-identical corrected to identical but for line endings, the runner red tied to its existing backlog entry, the resume line marked superseded, the leak mechanism marked unconfirmed. Round 4 Majors fixed: the steward registry red's cause, which named the wrong trigger; the scope ruling's false enumeration and false ground, replaced by recording results; the measurement commands kept only in a gitignored file, now inline; the moved-shell leg left without an owner, now filed; the stale first-pass board reading, now met; the heartbeat's new error direction unstated; round 3's Critical closed by a ruling. Round 4 Minors fixed: the missing measurement rows, the loader clock's source, board 12's fourth error, the files-in-scope widening, the live baselines' missing counts, and measurement 2's workdir departure. Round 5, Critical fixed: three more plans that deferred runs here, decision-seam, plan-health-from-the-record and self-review-flood, had no results block; each now has one, and the Chapter states the sweep's predicate, scope and control. Round 5 Majors fixed: the supervisor-model baseline, now `docs/archive/agent_persona_channel-log-retention_spec_v1.md` Chapter 4 at 270 OK, and the live rows' baseline, now `docs/archive/agent_persona_coordinator_v2.md` Chapter 5, the newest live run on this machine. Round 5 Minors fixed: the restartrequest cite, a duplicated sentence, measurement 4's prompt having told the child to finish its call first, the parallel row's blind spot for the stray process, the Files in scope line, two present-tense pointers to the unmerged runner fix, and the backlog's line-number cites into a versioned kit skill. The section closes on the review-round backstop's prose-only exemption: every round's fix delta changed prose alone, so round 5's fixes took an author re-read, recorded here, rather than a sixth round. Rounds 2 to 5 ran by choice after each Critical, and the fix-delta bar owed none of them. The author re-read found each round 5 fix present once in its file and each replaced phrase gone.
Stamps: adjudicated 4, stamped 3 (`relay-status-cadence-is-one-message-per-section-close`, `the-live-gate-is-operator-only-while-the-fleet-is-up`, `heartbeat-writer-follows-cwd-supervisor-reads-fixed-path`); skipped `subagent-can-report-a-documented-past-injection-as-a-live-one` in the operator tier, read but not applied. Two records were corrected this section: the live-gate record named a retired `budget` suite and a deferral now paid, and the heartbeat record described as live a cwd defect the `heartbeatPath` option has fixed for supervised children.
Gate: this section runs the deferred suites rather than being gated by them, so its ledger below is its gate. Every row was measured on SCOTT-CLAUDE, and each exit code is read from a marker file the run wrote. Two departures from Section 1's text are named here. No foreign-runner poll is recorded before the natural-exit start at 22:03:30Z or the live start at 02:58:37Z; the two leaked test shells found afterwards were alive through the live rows and are named there as contention. And the loader rule has no marker of its own: it ran as `live-all.sh`'s first step, so its exit 0 is inferred from its PASS line and from `live-all.sh` going on to spawn, since that script exits 7 when the rule fails.

| Suite | Tree | Moment and contention | Wall clock | Exit | Result | Baseline, by file and heading |
|---|---|---|---|---|---|---|
| Loader rule, `node .kit/check-loader-rule.mjs` | `c777ceb` | 2026-09-30T02:58:37Z, live-all's first step, fleet stopped | within the 27 seconds before the first suite began at 02:59:04Z; not timed on its own | 0, inferred | PASS, no loader-rule violations | `docs/archive/agent_persona_jev-question-quality_spec_v1.md`, Chapter 8 - 2026-09-29: PASS |
| Natural exit, `bash .kit/supervisor-natural-exit-test.sh` | `4557c7e` | 2026-09-29T22:03:30Z, beside the six live personas | 32 min | 1, from `ne.exit` | 326 OK / 5 FAIL: three `root_complete` detail pins, two `(pkdu)` checks | `docs/archive/agent_persona_keeper-park_v1.md`, Chapter 5 - 2026-09-23: 266 OK / 0 FAIL |
| Natural exit, re-run with both fixes | `f046f8b` plus `260d84a` | 2026-09-29T23:12:50Z, beside the six live personas and the leaked shell from the first run | 32 min | 0, from `ne2.exit` | 335 OK / 0 FAIL | same |
| Natural exit, parallel runner, `bash .kit/supervisor-natural-exit-parallel.sh` | `c777ceb` | 2026-09-30T03:56:49Z, beside the six live personas; a poll over every process for `testhost`, `dotnet`, `MSBuild`, `vstest`, a bash running a `test.sh`, `live-all` or `parallel.sh`, or node running `--test` or `test.mjs` matched nothing, the same predicate that had found the two leaked shells; it matches no `bin/supervise.sh` shape, so it did not see the stray PID 16580 burning a core, named in the contention note below | 16 min | 0, from `ne3/exit` | 226 OK / 0 FAIL across 2 processes, over the unit blocks and 22 driven cases only. Its hard-coded `ORDER` line names 23 cases, one of them `f`, which the suite no longer defines, and omits 20 of the suite's 42 (`pk pkd pku pkdu uw uw2 uw7 ha sa sb sc sd` and all eight `na` to `nh`). Pre-drive checks that follow a skipped case are also suppressed, since `check()` returns early while `SKIP_CASE=1` (`.kit/supervisor-natural-exit-test.sh:37`), so the two `(r)` pins after `drive sd` ran in no process. Both are one red for Section 2, already filed as `docs/backlog.md` "The parallel natural-exit runner lists its cases by hand and misses newer ones" | `docs/archive/agent_persona_jev-question-quality_spec_v1.md`, Chapter 8 - 2026-09-29: 221 OK / 3 FAIL, exit 1, the three `root_complete` pins; the delta of 5 is those three fixed plus the two new `root_complete` run pins |
| Live goaltree, via `bash .kit/live-all.sh` | `c777ceb` | 2026-09-30T02:59:04Z, every persona stopped; the two leaked test shells and their `node` loops were alive, idle, rewriting a scratch file every two seconds | 3 min 41 s | 0, from `live.exit` and the suite's `script_exit` | 3 OK of 3 asserts | `docs/archive/agent_persona_coordinator_v2.md`, Chapter 5 - 2026-09-14: `.kit/live-all.sh` at `ba6d351` on this machine, the newest recorded live run, each suite `script_exit=0` and `ASSERT: 0`, with no per-suite count recorded |
| Live commons, via `live-all.sh` | `c777ceb` | 03:02:45Z, same contention | 1 min 50 s | 0 | nine report lines, all passing, among them exactly one owner and one reader, the loser's write refused and the winner's written | same Chapter |
| Live operator, via `live-all.sh` | `c777ceb` | 03:04:36Z, same contention | 2 min 9 s | 0 | 1 OK of 1 assert, "All checks passed" | same Chapter |
| Live restartrequest, via `live-all.sh` | `c777ceb` | 03:06:45Z, same contention | 4 min 39 s | 0 | 6 OK of 6 asserts, F1 to F6 | same Chapter |
| Live stop process tree, `bash .kit/live-stopprocesstree-test.sh` | `c777ceb` | 03:13:28Z, beside the six restarted personas, after the leaked shells were killed | 5 min 58 s | 0, from `spt.exit` | 38 checks / 0 failed | `docs/archive/agent_persona_supervisor-gaps_v1.md`, Chapter 6 - 2026-09-22: 38 checks; no delta |
| Steward Coordinator seat, three legs read from `~/.claude/coordinator/SCOTT-CLAUDE/` | the running STEWARD child, no launch made | read about 04:00Z and again about 05:05Z on 2026-09-30, beside the six live personas | a read | none, a read | registry entry: not met, the directory holds none; the steward's priming tells it to take the seat with the role skill, and none of its eight latest transcripts shows that skill invoked, a red filed; first-pass board line: met, `LAST PASS: 2026-09-30T04:10:51Z` from the child restarted at 03:11Z; registry prune: cannot be read, the directory is empty and no board line names a prune | none; first run |
| Architect settings, read from `D:/personas/ARCHITECT/run/settings.json` | written 2026-09-25T09:57:17Z by the supervisor then starting, not by the trunk's emitter, which writes the file only when absent | 2026-09-30 about 04:00Z | a read | none, a read | `"architectPersona":"ARCHITECT"` under both plugin ids | none; first run |
| Lean-injection live child: a `--no-channel` child under a scratch persona answers the priming turn | `c777ceb`, the measurement child | 2026-09-30T03:29:47Z, beside the six live personas | a read of its first result | none, a read | first `result` reads `"Ready."`, one line | none; first run |
| Supervisor-peer measurement 2, heartbeat through a six-minute tool call | `c777ceb`, the measurement child | 2026-09-30T03:30Z, beside the six live personas | 6 min, 12 samples | none, a measurement | both heartbeat files advanced every 30 seconds throughout | none; first run |
| Supervisor-peer measurement 4, the final ask during a running turn | same child | 2026-09-30T03:38Z | 3-minute call | none, a measurement | the holder relayed the line; the turn ran to its end and its one result answered the ask | none; first run |
| Supervisor-peer measurement 5, a usage limit with the pause off | not run | not run | not run | none | not run: producing one exhausts the account the six personas run on, and the operator was asked on 2026-09-30 whether to skip it | none |
| Supervisor-peer Section 3 closing measurement, probe acks and the moved-shell heartbeat | same child | 2026-09-30T03:42Z | about 2 min | none, a measurement | idle probe acked in 7,947 ms, busy probe in 33,467 ms after its turn ended, as designed; moved-shell heartbeat leg partly measured, the remainder filed | none; first run |
| Supervisor-peer `[SUPERVISOR-ASK` origin check | same child | 2026-09-30T03:44Z | a turn and its control | none, a measurement | the marked turn left an open ask open; the unmarked control closed it | none; first run |
| Supervisor model, `bash .kit/supervisor-model-test.sh`, deferred by the goal-every-turn plan | `c777ceb` | 2026-09-30T05:48:26Z, beside the six live personas and the stray process named in the Chapter's contention note | 6 min 21 s | 0, from its marker | 277 OK / 0 FAIL | `docs/archive/agent_persona_channel-log-retention_spec_v1.md`, Chapter 4 - 2026-09-27: 270 OK / 0 FAIL; the 7 more are checks later plans added, not traced one by one |
| Persona live refuse, `bash .kit/persona-live-refuse-test.sh`, deferred by the goal-every-turn plan | `c777ceb` | 2026-09-30T05:54:47Z, same contention | 4 s | 0, from its marker | 13 OK / 0 FAIL | `docs/archive/agent_persona_supervisor-peer_v1.md`, Chapter 9 - 2026-09-24: 13 OK; no delta |

A first attempt at the live row, 2026-09-30T00:25:13Z, exited 10 from `live.exit` after 27 seconds, refused on a live STEWARD claim 54 seconds old because the waiter's own pre-check passed early. Interim board 11 records the cause and the fix. The live suites' per-suite figures come from `live-all.log`'s summary block. Since 2026-09-27 20:43 local, before every run in this table, a stray `bash - bin/supervise.sh` under a `python3`, PID 16580, burned more than one core throughout; it is none of the personas' and none of this run's, and it went to the coordinator. The supervisor-peer measurements are recorded, with their commands, in that plan's "End-run measurements - 2026-09-30" block. Test delta: none added, none retired, none edited by this section. The fixes in pull requests 127 and 128 carry their own.
Next: 2. Attribution and fixes
Commit Model: Branch-and-PR
Delta: read 2026-09-30 at 06:08Z on SCOTT-CLAUDE against the plan worktree at `1259a48` plus this Chapter's uncommitted edits.

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-30
Completed: 2. Attribution and fixes
Implemented By: main session for the red protocol and the dispositions; implementer-opus for the parallel runner's first fix, which the main session then revised through its two review rounds; the two earlier fixes, pull requests 127 and 128, were this plan's own, recorded at interim boards 7 to 9
Metrics: review rounds 2 on the runner fix, closed major-closed; provenance 2 spec-traceable Criticals, 4 spec-traceable Majors, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 1 findings, 1 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations none; consults 0
Decisions / Surprises:
- Section 2 open (2026-09-30): fixes the parallel runner's red on its own branch and records every other ledger red as fixed, flake or filed; serves Section 2's text and its acceptance; adds no mechanism beyond the runner deriving its cases from the suite; size one script of about 150 lines and one suite function of 4 lines; not building it leaves the parallel runner printing PASS over 20 unscheduled cases.
- **Every ledger red carries its disposition.**

| Red | Disposition | Cause and plan | Evidence |
|---|---|---|---|
| Three `root_complete` detail pins | fixed, pull request 127, merged as `d4646db` | `64e8f2a`, the goal-levels plan, moved every `root_complete` write into a helper the pins could not read | natural-exit re-run 335 OK / 0 FAIL, exit 0 from `ne2.exit` (interim board 9) |
| `(pkdu)`, two checks | fixed, test defect, pull request 128, merged as `c777ceb` | `ec2e415`, the supervisor-peer plan, routed the holder kill through the function the case's injection forced to fail, found by bisect | the same re-run, and `--cases r pkdu` exit 0 with 18 OK (interim board 9) |
| The parallel runner scheduled 22 of 42 cases and ran no pre-drive check after an unscheduled case | fixed, pull request 129, open with auto-merge armed | no single commit: the runner's case list was kept by hand, and every plan that added a case without adding it there widened the gap, the supervisor-peer plan's `pk*` and `s*` cases and the eight `n*` cases among them | whole two-process run on the fix, 337 OK / 0 FAIL, exit 0 from `r3/exit`, 2026-09-30T05:54:59Z to 06:25:14Z; `--cases nf` alone 0 `nf` checks before and 2 after |
| Case `(r)`'s injection setup check | filed, cause unconfirmed: 2 failures in 14 runs over identical code, with no failing run's supervisor log | not traced; one reading is a slow process-tree read under load ending the stop before any kill, and the same signature fits a sweep defect that skips the kill rungs after a failed tree read | `docs/backlog.md`, "Case (r)'s injection setup check fails now and then", whose first remedy is capturing the next failure's log |
| The steward holds the Coordinator seat without a registry entry | filed | the steward does not run the `/role` takeover its priming asks for; why is not confirmed | `docs/backlog.md`, "The steward holds the Coordinator seat without a registry entry" |
| Case `(ne)`'s heartbeat loop and its shell outlive the run | filed | the case's cleanup signals its wrapper subshell, not the `node` pid it recorded | `docs/backlog.md`, "The natural-exit suite leaves a test shell and a heartbeat loop running" |
| Case `(nf)`'s supervisor, holder and stub outlive the run | filed at interim board 9 | inferred: the case's TERM reaches the `env` wrapper rather than the supervisor | `docs/backlog.md`, "The natural-exit suite's case (nf) leaves its first supervisor and holder running" |
| The inbox-drain plan's live submit proof | filed, not a red: no suite here reads that behavior | none | `docs/backlog.md`, "No live run proves the harness accepts a submit made right after a completion" |
| The supervisor-peer moved-shell heartbeat leg | filed, partly measured | the samples sat under the heartbeat's cadence | `docs/backlog.md`, "The moved-shell heartbeat leg is partly measured" |
| `.kit/controller-tick-test.mjs` case `gl6 fact control`, 6204 OK / 1 FAIL on trunk | fixed, test defect, pull request 130, open with auto-merge armed | this plan's own pull request 127 narrowed the poll's backfilled reading to the legacy detail shape, and the case's control used a stand-in detail that never had that shape; pull request 127's targeted lanes did not include the tick suite | found by the finishing pass's QA whole gate; `node .kit/controller-tick-test.mjs` on trunk exit 1 before and exit 0 with 0 failures after, each from its own marker |
| The first live attempt's refusal, exit 10 | fixed in the run's own waiter script, not a repository red | the waiter's refuse check ran as a `bash -c` string that Windows PowerShell 5.1 mangled | interim board 11; the second attempt's live row |

- **The finishing pass's goal read declared two things Section 2 built beyond its text, now in the `Standing Brief Amendments` block:** the gl6 fixture correction, and three backlog filings from a fix's review, a live acceptance check and the inbox-drain plan's own pointer here. It put the parallel runner rewrite to the operator as an ask, since no acceptance bullet names it; the operator's review of pull request 129 answers it. Its asked-but-unbuilt item, the policy's lift, left three test comments stating the policy as current, rewritten in this changeset.
- **This plan's own fix caused one red, which the finishing gate caught.** Pull request 127's targeted lanes were the supervisor unit and poll unit suites, and the tick suite also pins the poll's backfilled reading, through its `gl6` control. A change to a reader shared by a writer and a test owes every suite that pins that reader, found by searching the test tree for the reader's output rather than by the reader's own unit suite.
- **Measurement 5 is the one deferred run neither run nor filed.** It waits on the operator's answer, and Section 3 records it.
- **The runner fix changed shape under review.** Its first form scheduled every case but could split a nested case from its parent at widths above 1, and left a directly gated case's checks suppressed. Round 1's blind and security reviewers found both. The second form adds slots, gate scope, a strict reader and a `want` that lifts suppression. Round 2 found only latent reader gaps, fixed in one close pass.
Failed approaches: tried reading the case list with a word match on `drive` and `want`, failed because a check message and an awk program in the suite use those words as text, learned to match them as shell command words only.
Assumptions: none
Review Findings: review: adversarial, blind and security at fable, Agent tool, 2 rounds on the runner fix, each round's full roster, round 2 re-raised by round 1's Criticals. Round 1, Criticals fixed: `nb` split from `na` at widths above 1; a directly gated case's checks suppressed after a skipped drive. Round 1 Majors fixed: the reader's silent drop of a case line in an unknown shape, which the adversarial and blind lenses each raised; a name pattern narrower than the suite's names; the runner's backlog entry left open. Round 2, Major disposed: case `(r)`'s red in the fix's own whole run had no recorded disposition or diagnostics; it is recorded as a flake with its counts, and six further runs were made to capture a failing log, all passing. Minors: those of both rounds fixed in two close passes, among them quoted and chained case lines, gate scope, duplicate scheduling, width bounds, the `eval`, the header's figures, and the controls now saved to `dry2/results.txt`; one left, the blind reviewer's note that the header's check-count sentence depends on the suite's layout, true today and kept. Advisory: the security lens's round 1 Major was the `nb` split the blind lens rated Critical, fixed with it, and its round 2 returned Minors only.
Stamps: adjudicated 1, stamped 1 (`pr-ready-mark-is-the-reviewers-after-verification`, which set how pull request 129 was opened and armed); the unstamped report for the 2 hours since Chapter 1 lists no record awaiting a stamp.
Gate: the parallel natural-exit runner, whole, at width 1 on the fix tree, 2026-09-30T05:54:59Z to 06:25:14Z on SCOTT-CLAUDE beside the six live personas and the stray process named in Chapter 1: 337 OK / 0 FAIL, exit 0 from `r3/exit`, against Chapter 1's parallel row of 226 OK / 0 FAIL on `c777ceb`. The final close pass changed the runner's reader, its grouping from `eval` to an array, its width bounds and its schedule's deduplication, so it took a stub-suite dry run rather than a whole run, whose per-group listings exercise the grouping and both width refusals: 42 cases at widths 1 to 3 with no duplicate, five bad case-line shapes and two bad widths each refused with exit 2. Test delta: none added, none retired; `.kit/supervisor-natural-exit-test.sh`'s `want` edited, pinning that a directly gated case reports its own checks, and its comment on pre-drive checks corrected. No added test spawns a process. Files a fix touched: `.kit/supervisor-natural-exit-parallel.sh`, `.kit/supervisor-natural-exit-test.sh`, `docs/backlog.md`, `docs/archive/backlog-2026-Q3.md`, all on `fix/natexit-parallel-cases`.
Next: 3. Close
Commit Model: Branch-and-PR
Delta: read 2026-09-30 at 06:08Z on SCOTT-CLAUDE against the plan worktree; this project is outside the kit's measured roots, as Chapter 1's reading printed.

### Chapter 3 - 2026-09-30
Completed: 3. Close
Implemented By: main session, with the finishing pass's qa-verifier, final adversarial reviewer, scope adjudicator and docs-curator dispatched
Metrics: review rounds 1 in the finishing pass, closed major-closed; provenance 0 Criticals and 2 spec-traceable Majors, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused, both advisory lenses waived; NEEDS_CONTEXT 0; escalations none; consults 0
Recap: Goal, verbatim: "When this is done, every test run the gate policy below deferred has run once against the trunk after the last queued plan merges, every red from that run is traced to the plan that caused it, and each is fixed or filed with its cause named. The policy is then lifted, and plans armed after this one gate as the executing-work skill states. It matters because four plans are landing on `hooks/index.ts` and `bin/supervise.sh` without the runs that prove them together, so this run is the only place their combined behavior is read before the fleet relies on it."; What the tree does now: every test the operator's policy of 2026-09-18 held back has run once on the merged trunk, the long natural-exit supervisor suite, its parallel runner, the four live suites that need every persona stopped, and the stop-process-tree suite among them, and each result is written into all twenty-two plans that deferred a run here; the one test that could not honestly run, driving the shared account into its usage limit, waits on the operator; every failure the run found is fixed, filed with its cause, or, for one intermittent failure, filed with its cause still open; the fixes are two merged pull requests, 127 for three stale pins and 128 for a test-injection defect, and two open ones, 129 so the parallel runner can no longer skip test cases and 130 for a test fixture that pull request 127 left out of step; test comments no longer describe the policy as in force; Refinements during the run: Section 1's text widened to every run a covered plan deferred and to the archived paths of two moved plans; Section 1 recorded results in eighteen further plans that applied the policy on their own, after round 3's scope ruling was withdrawn in round 4; Section 3's text widened to carry the measurement 5 ruling, then to carry it as operator-pending where unanswered at close; the Standing Brief Amendments block gained the gl6 fixture correction and the non-suite backlog filings, both declared by the finishing goal read; case (r) moved from flake to filed, cause unconfirmed, on the final review; the operator approved stopping all six personas twice on 2026-09-29 and 2026-09-30; Operator-pending, in order: review and approve pull request 130, review and approve pull request 129, rule on measurement 5, review and approve this plan's pull request
Decisions / Surprises:
- Section 3 open (2026-09-30): flips the plan to Complete, writes this Chapter, archives the plan with its index line and runs the second whole gate; serves Section 3's text and acceptance; adds no mechanism; size one Chapter and a handful of index and pointer edits; not building it leaves the policy nominally in force and the plan unarchived.
- **Measurement 5 is carried as operator-pending, not ruled.** The operator was asked on 2026-09-30 whether to skip the usage-limit measurement, with a recommendation to skip it, and had not answered at close. Finishing-work holds that an item only the operator can move does not hold a plan open, so Section 3's text now carries it as an operator-pending item where unanswered; an answer to run it reopens this plan as a new round.
- **The finishing gate found a red this plan's own fix caused**, the tick suite's `gl6` control, fixed in pull request 130 and recorded in Chapter 2.
- **The advisory reviews were waived on both predicates.** The plan branch's 24 changed files against `c777ceb` are markdown plan records, the backlog and the index, with no code, script, hook, config or machine-read frontmatter, and no section names an audience outside the operator's own sessions. The two fix branches carry their own advisory reviews, recorded in Chapter 2. The three test-comment edits the goal read asked for landed after that listing and are comments only.
- **Drift adjudicated, five items, all deviations, none a stop.** D1: the backlog and index described the gate run as still to come; the curator's edits there stand. D2: `README.md` does not document the parallel runner or the suite's `--units` and `--cases` flags; left, the runner's own header documents them. D3: the backlog's natural-exit cost entry carries figures from a smaller suite; left for that entry's owner, since the drift predates this effort. D4: fixes added checks inside existing suites, which the Out of Scope bar on new tests does not reach, since each pins its own fix. D5: Section 1's loader rule has no marker of its own and no foreign-runner poll preceded its first two runs, both declared in Chapter 1. Library hygiene: the plan's 97 citations inside archived plans keep its old path, as immutable history; the live references in `docs/README.md` and `docs/backlog.md` now point at the archive; the Related section now links the upgrade-check plan.
- **The goal read asked one thing of the operator**: the parallel runner rewrite, which no acceptance bullet names; it ships as its own pull request, 129, so the operator's review of that pull request is the ruling.
Failed approaches: none in this section.
Assumptions: none
Review Findings: review: qa-verifier, one whole offline gate, 27 of 28 suites green and the tick suite red, fixed in pull request 130; final adversarial at fable, Workflow (high), over the three branches, 1 Major re-dispositioned (case (r) moved from flake to filed with its remedy reordered so a sweep defect cannot be hidden) and 3 Minors fixed, two on pull request 129 and one in Chapter 2; `goal read: 3 built-but-unasked (0 refused, 2 declared, 1 asked), 1 asked-but-unbuilt`, the unbuilt item being the policy's lift, whose three stale test comments are rewritten; advisory lenses waived, evidence above; docs-curator's five drift items adjudicated above. No incident: each finishing round's tree-state bracket showed only this session's own edits.
Stamps: adjudicated 1, stamped 1 (`pr-ready-mark-is-the-reviewers-after-verification`, at Chapter 2); none surfaced since.
Gate: the handoff whole gate, run by the main session over the plan worktree after the archive, the pointer repoints and the index refresh, on SCOTT-CLAUDE from 2026-09-30T07:25:52Z to 07:39:20Z, beside the six live personas and the stray process named in Chapter 1, each exit code read from its own marker under `.kit/scratch/deferred-gate/finishing/gate2/`: tsc exit 0; 28 offline lanes, 27 exit 0 and `.kit/controller-tick-test.mjs` exit 1 on its one `gl6 fact control` failure, which pull request 130 fixes on its own branch and which this branch does not carry; the contention lane, `bash .kit/live-all.sh`, exit 10, refusing on a live STEWARD claim 4 seconds old, the honest reading beside a live fleet. Against the finishing pass's first whole gate, the QA verifier's run over the same 28 lanes before the archive: baseline 1 failing {gl6 fact control} → still 1 failing {gl6 fact control}, no other lane changed. On pull request 130's branch the tick suite exits 0 with 0 failures (Chapter 2). The natural-exit suite, its parallel runner and the live suites are this plan's own Section 1 ledger, not re-run here. Test delta for this section: none added, none retired; three test-file comments edited, pinning nothing.
Next: none, the plan is complete. The gate policy of 2026-09-18 has ended, and plans armed after this one gate as the executing-work skill states.
Commit Model: Branch-and-PR
