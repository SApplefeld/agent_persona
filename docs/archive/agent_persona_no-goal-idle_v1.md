# No-goal idle

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

When this is done, an error streak on a persona that holds no active goal node is logged and nothing more. The controller opens no ask for it, writes no ask record under the placeholder node id `no-active-node`, submits no `[STILL WAITING]` turn for it, and shows no toast saying it is escalating. A persona whose charter gives it no standing goal, the architect among them, therefore sits idle between asks as a healthy state rather than an error streak that escalates to an operator question nobody can act on. A streak on a persona with an active node keeps today's path: the ask opens, the node pauses, and the operator's answer resumes it.

## Dispatch Authorization

The operator relayed this ask on the architect persona's Discord thread on 2026-09-22, as findings another machine wrote:

> Design ask for the agent_persona plugin. The monitor loop treats a persona that holds no goal node as a failing persona. Spec a fix so a no-goal persona is a healthy idle state, not an error streak.

The findings are the other machine's and the operator relayed them verbatim; the architect confirmed each mechanism they name against the code at `origin/main` `dda8afb`. Execution waits on the operator handing this plan to a worker by name.

## Intent

**The frame.** The relayed findings above. On the NEO-CLAUDE machine the architect persona, which holds no goal by charter, reached an error streak of four turns. The monitor logged `error_streak: no-active-node`, opened an ask named `ask-no-active-node-<ms>` whose question is the streak toast, re-submitted a `[STILL WAITING]` prompt on later ticks, and counted each turn that handled that prompt toward the streak. Two unanswered asks then produced a kaizen goal node in the architect's tree.

**What done needs to do.** Make the streak branch do nothing beyond its decision line when no node is active. Keep the streak branch as it is when a node is active. Say in the README's ask-wait section that a streak with no active leaf opens no ask.

**What done does not need to do.** It does not need to change what counts as an error turn: a turn that ended in error or that carried a denied plugin tool call still counts, since that is a true signal on a working persona. It does not need to stop the reactive self-review firing on the streak, which spends one small model call and writes a lesson at most. It does not need to keep a kaizen finding from becoming a goal node, or to remove the backfilled root that gives the finding a tree, since two open plans already do both. It does not need to let a persona close an ask itself, since an ask is the operator's to answer. It does not need to clean up the asks and nodes already written on NEO-CLAUDE.

**Alternatives refused.**
- A persona-level flag saying the persona is idle by design. Refused, because the plugin does not need to know which persona holds no goal: the condition it can read, no active node, is the one that matters, and it covers a worker between plans too.
- Opening the ask on the root node instead of a placeholder id. Refused, because there is no node to pause and nothing for the operator's answer to resume, so the ask has no work behind it.
- Suppressing the streak counter itself when no node is active. Refused, because the counter feeds the `[ENV]` facts and the reactive self-review, both of which stay useful, and the defect is the escalation, not the count.
- Not counting the plugin's own tool denies as errors. Refused, because on a working persona a run of denied calls is exactly the streak the branch exists to catch.

**Rulings.** None yet.

**Provenance.** Distilled by the architect on 2026-09-22 from the relayed findings and from the code at `origin/main` `dda8afb`, read that day.

## Related plans

- `../plans/agent_persona_goal-levels_v1.md` (open) stops a self-review finding from becoming a goal node in the finder's tree and routes the nodes already written to the coordinator. That plan owns the kaizen node the findings describe, and this plan leaves that code alone.
- `agent_persona_goal-tree-curation_v1.md` removed the backfilled root that a no-goal turn wrote, which is the root the kaizen node attached under. This plan leaves that code alone.
- `agentic-plugin_env-monitor_v1.md` built the error streak branch and its escalation.

This plan edits only the streak branch of the controller tick and its tests, so it can run before or after either open plan. Whichever lands second takes a textual merge in `hooks/index.ts` and `.kit/controller-tick-test.mjs`.

## Approach

**What exists today.** Each point was read at `origin/main` `dda8afb` on 2026-09-22. Find each site by the comment or text named rather than by line, since the open plans move lines in the same file.

- A turn is an error turn when its completion reason is `error` or it carried at least one denied plugin tool call (`applyTurnToErrors` in `hooks/agent-state.ts`, fed from `turn.complete` in `hooks/index.ts` with `toolErrorsThisTurn`). Every `deny` return in the plugin's tool handlers raises that counter, `agentic_resolve`'s "no record addressed to persona" among them. An error turn raises `consecutiveErrorTurns`; any other turn resets it to zero.
- The streak branch is the block in the controller tick commented `2a. C3: error streak branch`. It fires when `consecutiveErrorTurns >= 3` and either no streak has been handled or a new error came after `handledAt`. It looks up the active node, and where none exists it uses the string `no-active-node` as the node id. It then logs `error_streak`, writes an ask record keyed on that id with the streak text as the question, sets `pendingAskId`, logs `ask_opened`, shows a toast reading `Agentic: Error streak N turns; escalating`, and pauses the node only where one was found.
- With `pendingAskId` set and no active node, the tick's `No active leaf` step calls `tickOpenAsk`, which logs `ask_waiting` each minute, re-raises the question as a `[STILL WAITING]` turn once after `askReraiseWindowMs` (15 minutes by default), and expires the ask after `askOperatorWaitMs` (60 minutes by default). An external turn while the ask is open closes it as answered and reactivates the asked node where one exists.
- A persona cannot close an ask: `agentic_resolve` closes inbox records, and an ask is a different record kind, so the attempt is denied and the deny counts as a tool error.
- `.kit/controller-tick-test.mjs` case `caseS13_errorStreak_threeDeniedTurnsOpenAnAsk` pins today's path with an active plan: three denied turns, then `error_streak`, `ask_opened`, `paused_by_controller` and `ask_waiting` in order. `.kit/tick-harness.mjs` builds a state from `stateOpts`, and the test file already builds states with `goals: []` and with `activeGoalId: null`.
- `README.md`'s "Ask wait" section says the nudge cap, the cost cap and the error streak pause the leaf rather than block it. Nothing in `README.md` or `docs/architecture.md` describes the streak with no active node.
- The fleet health class reads claims, heartbeats and the keeper's action and never the streak, so the fleet card does not change under this plan.

**The design.**

1. In the streak branch, when no active node exists, the branch sets `handledAt`, logs one `error_streak` decision whose detail reads `no-active-node: Error streak N turns; no leaf to pause, no ask opened`, persists, and falls through to the rest of the tick exactly as today's branch does. No ask record, no `pendingAskId`, no `ask_opened`, no toast.
2. When an active node exists, the branch runs as today.
3. The re-fire rule is unchanged, so a later error turn after `handledAt` logs another `error_streak` line and still opens nothing.

## Sections of Work

### 1. The streak branch opens no ask without an active node
Model: sonnet

Tests: Lock that three error turns on a persona with an empty tree log `error_streak` and nothing else the escalation writes: no `ask_opened`, no ask record in the store, `pendingAskId` unset, no toast, and no `ask_waiting` or `[STILL WAITING]` submit on the ticks that follow. Lock the same on a persona whose only root is complete, since a backfilled root exists on every no-goal persona until the curation plan lands and the condition is the absence of an active node rather than of a root. Lock that a further error turn after the streak was handled logs a second `error_streak` line and still opens nothing. Keep the existing case with an active plan green unchanged, as the control that the escalation still runs where it should.

Change the streak branch as the design states. Add the cases to `.kit/controller-tick-test.mjs` beside `caseS13_errorStreak_threeDeniedTurnsOpenAnAsk`, driven the way that case drives its turns, and watch the first go red before the branch changes. Add one sentence to `README.md`'s "Ask wait" section saying that an error streak with no active leaf is logged and opens no ask.

Acceptance:
- Every behaviour on the `Tests:` line has a case in `.kit/controller-tick-test.mjs`, and the first was observed red before the change.
- `node .kit/controller-tick-test.mjs` exits 0, reported as a delta against a baseline taken on the same command before the change.
- `npx tsc --noEmit` exits 0, the type check `README.md` names under its status line and its re-gate rule.
- The `README.md` sentence is present and states the behaviour with no change-narrative.
- `node .kit/injection-duplicate-test.mjs` exits 0 and `node .kit/injection-ledger.mjs` output matches `.kit/injection-ledger.json`, since no prompt text or tool description changes.

Files in scope: `hooks/index.ts` (the streak branch only), `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs` (toast capture only), `README.md`.

## Out of Scope

- What counts as an error turn, and the reactive self-review the streak triggers.
- The kaizen goal node and the backfilled root, owned by the goal-levels and goal-tree-curation plans.
- The asks and the kaizen node already written on NEO-CLAUDE. An open ask there expires after `askOperatorWaitMs` or closes on the operator's next message; the node is the goal-levels plan's to route, or the operator's to drop with `goal_edit`.
- Any way for a persona to close an ask itself.
- The `[STILL WAITING]` re-raise for an ask that does have a node behind it.

## Assumptions

- assumed 2026-09-22 (the repository's open plans): the commit model is Branch-and-PR; reversal: one header line.
- assumed 2026-09-22 (the architect): the decision line keeps the `error_streak` action name so the self-review's own-record reader and the [ENV] facts read the streak as before; reversal: a new action name and a sweep of its readers.
- assumed 2026-09-22 (the architect): the blind read and the gating litmus are skipped as a one-section spec per the brainstorming skill, which skips the plan review with them. The plan review was run anyway, at fable and effort high, and returned READY_WITH_FINDINGS with one Major and three Minors, all applied.
- The findings' evidence is reported, not confirmed. The NEO-CLAUDE log lines, decision records and session id come from the other machine's report as the operator relayed it; the architect did not read those files. Each mechanism the report names was confirmed in the code at `dda8afb`.

## Operator Verification

- On NEO-CLAUDE, the architect's pending kaizen node "Kaizen: asks run out the clock" stays in its tree until the goal-levels plan routes it or you drop it with `goal_edit`. The tick activates a pending plan when no leaf is active, so dropping it before this plan lands is the safe move.
- Write the threat model. The finishing security review found no `docs/security-model.md` and reviewed against the README's Trust boundary section. `docs/backlog.md` already carries the item as "The keeper's boot-time execution surface has no security model document". This plan adds no surface to it, since it removes a store write and a prompt submission rather than adding one. Done when the document exists.

## Chapters

### Chapter 1 - 2026-09-22
Completed: 1. The streak branch opens no ask without an active node
Implemented By: implementer-sonnet; the Minor close pass inline in the main session; no tier escalation
Metrics: review rounds 1, closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section open (2026-09-22): Section 1 makes the controller tick's error-streak branch in hooks/index.ts log one error_streak decision and set handledAt, and nothing more, when no goal node is active; with an active node it runs as today. Serves the Goal's "an error streak on a persona that holds no active goal node is logged and nothing more" and design points 1 to 3. Adds mechanism: no, it narrows an existing branch to its decision line. Size: about 10 lines in the branch, three or four tick cases, one README sentence, and a toast recorder in .kit/tick-harness.mjs so the "no toast" check can be observed. Cost of not building: a no-goal persona, the architect among them, keeps escalating an ask nobody can act on.
- The plan header read `Status: Ready` at the run's start and now reads `Status: In Progress`, the executing-work start normalization.
- Fold: `.kit/tick-harness.mjs` gained a toast recorder (`uiToasts`), since the harness's `toast` was a no-op and the Tests line's "no toast" lock could not be observed without it. It sits in the same directory as the test file, needs no new acceptance and is covered by the tick suite, so it was folded and the section's Files in scope line now names it. That line sits above Chapters, so the widening is recorded here as approval drift.
- Related plans is stale: `agent_persona_goal-tree-curation_v1.md` merged as PR #71 and is archived, so its line no longer describes an open plan. The branch was cut from origin/main 4b61108, which carries it. Left for the finishing docs pass.
- The branch was cut from origin/main 4b61108 as `no-goal-idle-build`; first-green commit b0df017.
- With no ask open, step 4 of the tick now activates pending work during a no-active-node streak, where before the placeholder ask held it back. That is the tick's ordinary no-leaf behaviour and the plan's Operator Verification relies on it; the branch comment and the README say so.
Assumptions: none
Review Findings: `review: adversarial and blind at opus, Workflow, effort high` over 4b61108..b0df017, every assistant turn resolved claude-opus-5-5 (23 and 23). Critical 0, Major 0 from either lens. Minors: 7 as printed (5 adversarial, 3 blind, the README placement reported by both); 6 fixed in the close pass (the re-fire case now drives one further error turn instead of three, the README sentence moved out of the "While pendingAskId is set" list, the block header comment scoped to the active-node arm, the always-true status guard dropped, the branch comment names that pending work still activates, and the harness file named in Files in scope); 1 carried to docs/backlog.md (an active-leaf streak overwriting an open ask, which predates this plan). The close pass's delta took an author re-read, not a round: it changes no outward action and adds no module, and a control proved the strengthened case: with `envErrors.consecutiveErrorTurns = 0` inserted in the no-node arm the tick suite exited 1 on exactly "s13 errorstreak no-active refire: a second error_streak line was logged", then hooks/index.ts was restored from a pre-probe copy, cmp-identical, porcelain unchanged.
Stamps: adjudicated 3, stamped 1 (pr-ready-mark-is-the-reviewers-after-verification, which governs the pull request step ahead); the two operator-tier records read in the window did not bear on this section.
Gate: close gate 2026-09-23T00:58:25Z to 00:59:28Z on this machine, branch no-goal-idle-build at b0df017 plus the close-pass edits, the fleet's resident node processes running beside it and no foreign test runner or build. `npx tsc --noEmit` exit 0. `node .kit/controller-tick-test.mjs` exit 0, 2507 OK and 0 FAIL, against the section-open baseline of 2489 OK and 0 FAIL on the same command (+18 checks, all from the three new cases). `node .kit/injection-duplicate-test.mjs` exit 0. `node .kit/injection-ledger.mjs` output equals `.kit/injection-ledger.json` with line endings normalized (diff exit 0; a raw cmp differs only on CRLF against LF). Test delta: 3 added, 0 retired, 0 edited: caseS13_errorStreak_noActiveNode_emptyTree_logsOnlyAndOpensNoAsk pins that a streak with an empty tree opens no ask, record, toast or re-raise; caseS13_errorStreak_noActiveNode_completeRootOnly_logsOnlyAndOpensNoAsk pins the same with only a complete root; caseS13_errorStreak_noActiveNode_reFireAfterHandled_stillOpensNoAsk pins that one further error turn logs a second line and still opens nothing. Tests spawning a process: 0, the tick harness runs in-process (inferred from the harness's fake host). The red-before-change run is the implementer's report of 14 failing checks, which the adversarial reviewer's check-by-check count reproduced by reading; the control above is this session's own red. No wall-clock baseline was recorded on this lane.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: 2026-09-23T01:00Z, this machine, no foreign test runner live
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-23 (finishing pass and close)
Completed: the finishing pass over Section 1; the plan is Complete.
Implemented By: main session for the finishing fix, the Minor close pass, the docs edits and the plan close; qa-verifier, adversarial-reviewer, scope-adjudicator and docs-curator dispatched; no tier escalation
Metrics: finishing review rounds 1; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 1 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; goal read: 1 declared, 0 asked, 0 unbuilt; NEEDS_CONTEXT 0; escalations 0; consults 0
Recap: The plan's Goal, verbatim: "When this is done, an error streak on a persona that holds no active goal node is logged and nothing more. The controller opens no ask for it, writes no ask record under the placeholder node id `no-active-node`, submits no `[STILL WAITING]` turn for it, and shows no toast saying it is escalating. A persona whose charter gives it no standing goal, the architect among them, therefore sits idle between asks as a healthy state rather than an error streak that escalates to an operator question nobody can act on. A streak on a persona with an active node keeps today's path: the ask opens, the node pauses, and the operator's answer resumes it."; What the tree does now: when a persona has had three or more failing turns in a row and holds no goal it is actively working, the plugin's controller writes one line to its decision log saying so and does nothing else, so no question reaches the operator, no reminder turn is sent and no pop-up appears, and the controller goes on starting any queued work as usual; a persona that is working a goal still gets today's escalation, where the goal pauses and the operator is asked; Refinements during the run: the test harness gained a pop-up recorder so the "no toast" check could be observed, folded into Section 1's file list (Section 1 fold); the re-fire test drives one further failing turn rather than three so it catches a branch that zeroes the counter (Section 1 Minor pass); the log-line check pins stable tokens rather than the sentence (finishing fix); Operator-pending: leave or drop the NEO-CLAUDE kaizen node per the Operator Verification section; write the threat model.
Decisions / Surprises:
- base ref (2026-09-23): bdcad4d, the merge-base with origin/main and its head, after merging origin/main (PR #72, direct lines) into the branch at b751643 before the pass; the one conflict, docs/backlog.md, kept both new entries. Scope check against bdcad4d: the changeset is hooks/index.ts, .kit/controller-tick-test.mjs, .kit/tick-harness.mjs, README.md, docs/backlog.md and the plan doc; only docs/backlog.md sits outside the Files in scope line, the entry Chapter 1 records.
- step 1 (2026-09-23): qa-verifier PASS at b751643. The whole gate ran 26 lanes, all exit 0 from their own markers, 2026-09-23T01:02:30Z to 01:22:49Z: tick 2566 OK and 0 FAIL, higher than Chapter 1's 2507 because the merge brought the direct-lines cases. Contention lane `.kit/live-all.sh` exit 10, refusing beside the live persona:STEWARD claim, as designed. Every acceptance bullet PASS, the red-before-change bullet on the reported evidence Chapter 1 records. Tree unchanged across the round.
- steps 2 and 3 (2026-09-23): one adversarial dispatch at fable, effort high, through Workflow, carrying the security and performance lenses folded in as a small effort; every assistant turn resolved claude-fable-5-1 (29). Security: "threat model: absent", no findings, Disclosure none. Performance: no findings. Adversarial APPROVED_WITH_CONCERNS with one Major and two Minors. Tree unchanged across the round.
- finishing fix round 1 (2026-09-23): the empty-tree case's detail check pins tokens rather than the log line's sentence: it keeps `no-active-node` and asserts the detail carries neither "escalating" nor an `ask-` id. Serves Section 1's Tests line, "Lock that three error turns on a persona with an empty tree log error_streak and nothing else the escalation writes" (trace orchestrator-made; the reviewer returned trace: none). Adds mechanism: no. Size: one check, two lines changed. Cost of not building: a reword of the decision detail turns the tick suite red with no defect behind it, against the repo's own stable-token rule at .kit/controller-tick-test.mjs:15679.
- The fix delta changes a test and moves one constant; it touches no outward action and adds no module, so it owed no round and took an author re-read. A control proved the new check: with the no-node detail rewritten to end "escalating", the tick suite exited 1 on exactly "s13 errorstreak no-active empty: the detail names no-active-node and no escalation or ask"; hooks/index.ts was restored from a pre-probe copy, cmp-identical, porcelain unchanged. After the fix, tsc exit 0 and tick exit 0 at 2566 OK and 0 FAIL, 2026-09-23T01:30:48Z to 01:31:52Z.
- step 4 goal read (scope adjudicator, fable, Agent tool, charter effort high): ASKED-BUT-UNBUILT none. BUILT-BUT-UNASKED: the docs/backlog.md entry on an active-leaf streak overwriting an open ask, accept-and-declare on the Goal sentence "A streak on a persona with an active node keeps today's path", bound one backlog record and no code. GROUNDS checked: the sentence exists and the entry adds no mechanism. No Standing Brief Amendments block was written for it, since no dispatch follows the close to read one.
- step 5 docs curator: wrote docs/architecture.md, one failure-modes row for `error_streak` decisions with no ask, toast or paused entry; the diff was read line by line against hooks/index.ts:4305-4359. D1 deviation, the README's Section 13 coverage list did not name the no-active-node cases: fixed. D2 deviation, the README's Ask wait section said an owner with an open ask waits indefinitely, which holds only where `askOperatorWaitMs` is 0 (hooks/index.ts:504-505); pre-change state unread, recorded as an unverified pre-change claim; fixed. D3 deviation, the README's `askOperatorWaitMs` fallback anchor read :502 for :504; fixed. H1, the Related plans line, fixed. H2, the goal-levels plan does not link back to this one: left, since goal-levels is a parked plan whose text above its Chapters is its own approval record. H3 and H4, stale sequencing lines in docs/README.md and a docs/plans/archive/ folder, predate this effort and are named in the close-out.
- close (2026-09-23): the Operator Verification section gained the threat-model item, pointing at the existing docs/backlog.md entry; no backlog item closed with this plan; no backlog item is older than 90 days, the oldest dated 2026-09-12.
Assumptions: none
Review Findings: `review: adversarial with folded security and performance lenses at fable, Workflow, effort high` over bdcad4d..b751643. Correctness Criticals 0; Majors 1, spec-traceable on an orchestrator-made trace, fixed. Advisory 0. goal read: 1 built-but-unasked (0 refused, 1 declared, 0 asked), 0 asked-but-unbuilt. Minors: 2 fixed in the close pass (streakReason moved into the active-node arm with a shared `streakHead` prefix; the Related plans line repointed at the archived goal-tree-curation plan), 0 left.
Stamps: adjudicated 1, stamped 0; the one operator-tier record read in the window (subagent-can-report-a-documented-past-injection-as-a-live-one) did not bear on this pass.
Gate: handoff whole gate 2026-09-23T01:37:08Z to 01:57:38Z on this machine, branch no-goal-idle-build at b751643 plus the finishing edits and the plan close, the fleet's resident node processes beside it and no foreign test runner live at start. `bash .kit/scratch/no-goal-idle/gate/run.sh`: 26 lanes, each exit 0 from its own marker; tick 2566 OK and 0 FAIL, channel-reply-instruction 160 OK, fleet-status 201 OK, equal to the step 1 QA run at b751643 (01:02:30Z to 01:22:49Z, 26 lanes exit 0, tick 2566 OK). Contention lane `bash .kit/live-all.sh` exit 10, refusing beside the live persona:STEWARD claim, as designed. Test delta over the pass: 0 added, 0 retired, 2 edited: caseS13_errorStreak_noActiveNode_reFireAfterHandled_stillOpensNoAsk now drives one further error turn, pinning that the re-fire does not rebuild the counter from zero; caseS13_errorStreak_noActiveNode_emptyTree_logsOnlyAndOpensNoAsk's detail check pins the `no-active-node` token and the absence of "escalating" and an `ask-` id rather than the line's sentence. Tests spawning a process: 0. No wall-clock baseline was recorded on this lane.
Next: none; the plan is complete. The pull request follows.
Commit Model: Branch-and-PR
Delta: 2026-09-23T01:58Z, this machine, no foreign test runner live
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
