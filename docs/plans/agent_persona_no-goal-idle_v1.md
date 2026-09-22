# No-goal idle

Status: Ready
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

- `agent_persona_goal-levels_v1.md` (open) stops a self-review finding from becoming a goal node in the finder's tree and routes the nodes already written to the coordinator. That plan owns the kaizen node the findings describe, and this plan leaves that code alone.
- `agent_persona_goal-tree-curation_v1.md` (open) removes the backfilled root that a no-goal turn writes today, which is the root the kaizen node attached under. This plan leaves that code alone.
- `../archive/agentic-plugin_env-monitor_v1.md` built the error streak branch and its escalation.

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

Files in scope: `hooks/index.ts` (the streak branch only), `.kit/controller-tick-test.mjs`, `README.md`.

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

## Chapters
