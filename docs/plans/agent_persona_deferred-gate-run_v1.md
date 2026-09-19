# Deferred gate run

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-18

## Goal

When this is done, every test run the gate policy below deferred has run once against the trunk after the last queued plan merges, every red from that run is traced to the plan that caused it, and each is fixed or filed with its cause named. The policy is then lifted, and plans armed after this one gate as the executing-work skill states. It matters because four plans are landing on `hooks/index.ts` and `bin/supervise.sh` without the runs that prove them together, so this run is the only place their combined behavior is read before the fleet relies on it.

## Dispatch Authorization

The operator asked for this on 2026-09-18 on the coordinator's own Discord thread. Their words: "The 40+ minute gates whenever we need to run a test are blocking other development." and "when all the plans are done, we can do a test run and evaluate any that fail as a wholly separate circle back to fix things." Offered the choice between suspending every check and suspending only the runs that hold the box, they answered "I'm good with Option 2." That is authorization to author and to apply the policy to the queued plans. Execution of this plan is armed only on the operator's own word, typed into the executing session's thread or relayed through the coordinator. The executor is the dev persona.

## The gate policy

This section owns the policy. The queued plans point here, and a Chapter that cites it cites this file.

The policy applies to `docs/plans/agent_persona_steward-architect_v1.md` from its finishing pass onward, and to `docs/plans/agent_persona_context-budget-removal_v1.md`, `docs/plans/agent_persona_lean-injection_v1.md` and `docs/plans/agent_persona_supervisor-peer_v1.md` whole. It ends when this plan closes.

Deferred to this plan's run: `.kit/live-all.sh`, every `.kit/live-*-test.sh`, `.kit/supervisor-natural-exit-test.sh`, and any other check that launches a `claude` child, real or stub, or runs past two minutes of wall clock. The named files are instances; the class is any run that holds the box.

Still run, where the plan and the executing-work skill place them: `.kit/check-loader-rule.mjs` after any edit to `hooks/`, the mock-driven `.mjs` suites, the shell suites that finish inside two minutes, every acceptance grep with its control, and one run of any test file a section writes or edits. The named deferred set wins over that last rule: an edit to `.kit/supervisor-natural-exit-test.sh` is verified here and not at the section close. The fresh-context reviewer pair runs as before, since it holds no box time.

A Chapter names each deferred run as deferred, never as passed, with the words "deferred under the gate policy of 2026-09-18 to `docs/plans/agent_persona_deferred-gate-run_v1.md`". Where a section's acceptance names a deferred suite, that clause is met by Section 1 below, and the Chapter says so. A finishing pass records the whole gate the same way. Nothing else in a plan changes: red-first tests are still written and watched red where the file that runs them is not deferred.

## Approach

The run is one whole gate over the trunk, taken when the box is free, and read suite by suite. The baseline is the newest Chapter on the trunk that records a whole gate with its counts and exit code, named in Section 1 from the archive, so every delta has a number to diff against. A red is a signal until proven otherwise: the red protocol in the kit's testing-discipline skill owns capture and discrimination, and a flake is isolated and repeated rather than waved off. Attribution reads the red suite's assertion against the four plans' diffs, and where reading does not settle it, reverts one plan's merge in a scratch worktree and re-runs that one suite. A fix lands on its own branch and pull request, re-runs only the suite it reddened, and is named in this plan's Chapter with its cause and the plan it traces to.

## Sections of Work

### 1. The run and the ledger
Model: sonnet

Confirm the trunk carries the merge of every plan the policy covers. Poll the process list for any foreign test runner or build and wait for it. Run `.kit/check-loader-rule.mjs`, then `.kit/supervisor-natural-exit-test.sh`, then `.kit/live-all.sh`, each with its exit code captured to a marker file. Record in the Chapter, per suite: the command, the wall clock, the exit code read from the marker, the pass and fail counts, and every failing case by name, beside the baseline Chapter's counts for the same suite.

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

- `docs/plans/agent_persona_steward-architect_v1.md`, `docs/plans/agent_persona_context-budget-removal_v1.md`, `docs/plans/agent_persona_lean-injection_v1.md`, `docs/plans/agent_persona_supervisor-peer_v1.md`: the plans this policy covers.
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
