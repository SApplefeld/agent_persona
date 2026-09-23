# Nudge cap on plan entries

Status: Abandoned
Commit Model: Branch-and-PR
Created: 2026-09-23

## Goal

When this is done, the controller's three-nudge stall pause fires on a plan entry only when three
nudges land with no un-nudged turn between them that called a work tool, which is Write, Edit,
Bash, NotebookEdit or a non-plugin MCP tool, and a pause it does fire holds the tree still until the worker's own
next working turn lifts it. A worker busy on a plan whose turns open from its own agents'
completions, from delivered records or from the operator is never paused for it, no pending
plan is started in its place, and the lift survives a relaunch of the session. It matters because on 2026-09-23 the dev-persona persona's
controller paused its active plan twice in one day mid-work, keeper-park at its close-out and
goal-levels in its third section, and each time started the next queued plan ten seconds later,
so a plan that must not start yet read as active while the plan being built read as paused.

## Dispatch Authorization

The operator ruled this plan a go on the architect's Discord thread on 2026-09-23: "Agreed.
Please proceed to draft plan and dispatch!", answering the architect's ask that named the
mechanism, the fix and the sequencing. The finding came from the coordinator as record
`ARCHITECT-8d67c288-dd78-478d-a565-e390d50027b0-19`, and its trace is the backlog entry of
2026-09-23 at the head of `docs/backlog.md`, merged as pull request 83.

This plan starts only after `docs/plans/agent_persona_goal-levels_v1.md` has merged to the trunk,
because that plan edits the same `turn.complete` handler and adds a step to the same
no-active-leaf branch of the tick. The trunk is `origin/main`, read after a fetch. The check:
`git ls-tree --name-only origin/main docs/plans/` does not list that file, and it is on the trunk
under `docs/archive/` with `Status: Complete` in its header. A worker that finds it still listed
stops with a `BLOCKED:` lead naming it, and waits for the coordinator's next handoff rather than
polling the trunk. The coordinator queues this plan behind goal-levels, so a worker meets the gate
unmet only where the queue was run out of order. The work runs on one branch cut from that fetched
trunk and lands as one pull request.

Execution waits on the coordinator handing this plan to a worker by name. A worker that finds this
plan as an entry in its own goal tree, read with `goal_status`, has that handoff.

## Intent

The frame, in the architect's ask the operator agreed to: the controller was silently reassigning a worker's active
plan, and the fix is small.

Done means two things. A worker on a plan entry that keeps working, in turns the controller did
not open, is never paused by the nudge count, because each such turn that calls a work tool
clears the count. And where the count does reach three, with no working turn between the three
nudges, the paused entry keeps its place: the tick starts no pending plan while it sits paused,
and the worker's next turn that calls a work tool makes it active again, whether or not the
session was relaunched in between. An entry the operator or the persona drops while paused by
the cap holds nothing.

Done does not need a change to how a nudged turn is scored, to the cap's count of three, to the
hourly nudge budget, to the idle gate, to how the controller matches a turn to the nudge that
opened it, or to any goal tool. It does not touch the two entries the dev-persona store holds
paused with the cap reason on 2026-09-23, which that persona resumes or drops itself.

Alternatives refused:

- Dropping the stall pause for plan entries whole. Refused, because it is the one health signal a
  plan entry keeps, per the README, and a worker that answers three nudges without doing any
  work has stalled.
- Repairing the nudge-to-turn match, so that nudged turns are scored and an on-goal score resets
  the count. Refused, because a scored nudge answers only what the worker said to the nudge, and
  a worker mid-work would still be paused for three nudges it answered while waiting on its own
  agents; the work-tool reading is what the waiting-lead clear and the reactivation already use.
- Making the tick hold a decision record on every tick it holds. Refused, because the tick runs
  every ten seconds and the pause it holds behind is already logged as `paused_by_controller`.

Ruling of 2026-09-23, by the operator on the architect's ask: this plan is retired before any
section ran. The nudge-state plan, drafted the same day, removes the cap pause this plan's hold
and lift were written to contain, so both would be built and then deleted within days. Its
reset survives as one of the five reset events that plan states, and that plan retires the two
backlog entries this one named.

Distilled from the architect session `30d6d808-ccad-45e4-a606-c868636ee4e4` on 2026-09-23, from
the coordinator's finding, the dev-persona persona's decision log at
`D:\agent_persona\.agentic-personas.json`, and the backlog entry that records the trace.

## Approach

**Coverage sweep.** One scout ran on 2026-09-23 over the checkout at `6657a05` for every read
and write of `consecutiveNudgesWithoutOnGoal`, `MAX_CONSECUTIVE_NUDGES`, `pausedByNudgeCap` and
`toolCallsThisTurn`, every test case naming the cap, the cap pause, the reactivation or the
counter reset, every prose surface stating the cap rule or its resets, and every Ready or In
Progress plan naming them. Line numbers below are read at `6657a05` and move when goal-levels
merges, so each site is found by the comment, record text or symbol quoted beside its number.
Surfaces found in `hooks/index.ts`: the constant at 2155; the tick's
no-active-leaf branch at 4983-4994; the cap branch at 5098-5126 with the `BG1` comment at 5117;
the `turn.complete` scoring block, with the origin skip at 6114, the plan-entry skip whose
record reads `plan entry, turn not opened by a nudge` at 6128, the on-goal reset, the
`reactivated_by_work` branch at 6267 and the `plan_progress` reset at 6329; the work-tool count
at 6631; and the two activation holds on `pausedByNudgeCap`, in the `goal_add` handler at 7113
and in `goal_done` by name at 7354. `hooks/agent-state.ts` declares the field at 67 and the
counter at 172. In `.kit/controller-tick-test.mjs`: `caseR60f3b_reactivationAfterCapPause` at
15005, `caseSection4_threeNudgedCompleteTurnsTripTheStallPause` at 14623 and its drift sibling,
`caseR119_aMetNudgeClearsItsOwnCount` and its control, `caseR58f3_capPausesWithNoAsk`,
`caseGtc3_noActiveEntryActivatesNextUnlessHeld` at 17636, and `plan2Harness` at 13304. Prose:
`README.md` at 146 (M13), 151 (the Cap bullet), 169 and 173. The injection ledger names none of
these. No Ready plan names them; the goal-levels plan names the branch and the handler this plan
edits, which is the ordering above.

**Why the count never resets on a busy plan entry.** The controller nudges after `nudgeIdleMs`
idle, 45 seconds in the fleet settings, and adds one to the count per nudge sent. On a plan
entry a turn is scored only where `turn.start` matched it, by exact prompt text, to the nudge
that opened it, and only an on-goal score there resets the count. A worker whose turns open from
a background agent's completion, a delivered record or the operator's message matches nothing;
those turns log `score_skipped` and leave the count as it is. The dev-persona store holds zero scores on
every plan node it has run. So across ordinary work the count climbs to three, the cap branch
pauses the entry with `pausedByNudgeCap` set and changes nothing else, and ten seconds later the
tick's no-active-leaf branch runs `activateNext` and starts the next pending plan. The
`goal_add` handler and `goal_done` by name both refuse to activate while an entry is paused by
the cap; the tick branch is the one activation site without that hold, and the `BG1` comment at
the cap branch already states the intent it lacks: the tree stays put.

**The reset.** In `turn.complete`, on a plan entry, a completed turn the controller did not
nudge, which called at least one work tool (`toolCallsThisTurn > 0`, the reading the waiting-lead
clear at the same handler and the `reactivated_by_work` branch take), sets
`consecutiveNudgesWithoutOnGoal` to zero. The condition is the same at both skip branches a plan
entry's un-nudged turn can take, the origin skip and the plan-entry skip: the turn's leaf is a
plan entry by `isPlanEntry`, `wasNudged` is false and `toolCallsThisTurn` is above zero. The
origin skip also serves task entries, which take no reset there; the `score_skipped` record each
writes gains the words `nudge count cleared by work` where the reset ran, and is unchanged where
the turn called no work tool. A nudged turn is scored as today, so the three nudged-turn trip
cases stand. A task entry is untouched. The reply tool is not a work tool, so an operator
check-in answered with a reply alone still costs a worker nothing and clears nothing.

**The hold.** An entry is cap-held when its status is `paused` and `pausedByNudgeCap` is true.
One exported helper in `hooks/agent-state.ts` answers whether the tree holds one, and four sites
read it. The tick's no-active-leaf branch skips its `activateNext` call while the helper is true,
after the open-ask read; the hold is a skipped call rather than an early return, read from the
code rather than from a case, since with goal-levels merged the only step after the call is the
idle proposal. The `goal_add` handler's hold and the `goal_done` by-name hold, which today read
the flag alone, read the helper, a fourth code change in `hooks/index.ts`. And `hasStartableWork`
returns false while the helper is true, since the controller will then start nothing by itself,
which keeps its comment true and gives the goal-levels idle proposal the reading the operator's
ruling at that plan's Intent states for a tree with nothing the controller will start. The
status half of the test is what keeps a dropped entry from holding: `goal_edit drop` sets a
paused entry `abandoned` and clears no field, so a hold on the flag alone would freeze the tick
for the life of the store. The hold writes no record per tick.

**The queue block.** The `[GOAL QUEUE]` block's closing line reads `hasStartableWork` and today
has two texts, one saying the next pending entry starts on the next tick and one saying nothing
starts by itself and naming `goal_resume` and `goal_edit`. Under the hold both are wrong for a
cap-held tree, so the close gains a third text for that case, chosen where the helper is true:
an entry is paused by the nudge cap, and the persona's next turn that calls a work tool makes it
active again, or `goal_resume` does. It is an injected string, so the injection ledger is
regenerated with `.kit/injection-ledger.mjs` and the new entry is named beside
`GOAL_QUEUE_BLOCK`.

**The lift across a relaunch.** The cap branch leaves `activeGoalId` naming the paused entry, and
while the session lives `turn.start` reads that id as the turn's leaf, so the existing
`reactivated_by_work` branch fires on the next turn that calls a work tool. That chain breaks at
a store load: `enforceInvariants` in `hooks/agent-state.ts` sets `activeGoalId` to null whenever
no entry is active, which is the state a cap pause leaves, so after a keeper restart, a crash or
the plugin update the Operator Verification names, the turn has no leaf and the branch never
fires. So the lift reads the entry by its flag rather than through the leaf: at `turn.complete`,
a completed turn that called a work tool whose leaf is null takes the same reactivation, on the
cap-held entry whose `updatedAt` is latest, any kind, task entries included, as the leaf-bound
branch reads today, since the cap pauses the entry being worked and an older cap-held entry was
left behind before it. Where
the leaf is that entry the branch is as today. The record is `reactivated_by_work` in both
cases. The load repair itself is unchanged.

**Prose.** `README.md` M13 at 146 and the Cap bullet at 151 say the cap escalates to
`ask-operator`; it has paused with no ask since Round 58. Both sentences say what the code does.
The Cap bullet's reset sentence lists every reset the code performs rather than reading
"only": an activation, an on-goal score of a nudged turn, a turn that ends with the entry already
completed by `goal_done`, a plan switch, `goal_resume`, a new goal, a work-tool turn that
reactivates a cap-paused entry, a plan entry's Chapter count rise, and, from this plan, a plan
entry's un-nudged turn that called a work tool. The "Which turns are scored" paragraph at 173
gains the un-nudged work-turn reset, the hold and the lift by flag. That retires the backlog entry of
2026-09-21 on the README's reset sentence as well as this plan's own entry of 2026-09-23.

**Decisions settled at the finalize.**

- The reset rides the `score_skipped` record rather than a new decision action, so the journal's
  action vocabulary does not grow for a reading that is already logged per turn.
- The hold is silent per tick. The pause behind it is logged once as `paused_by_controller`, and
  a per-tick record would write six lines a minute.
- The count of three, the hourly budget and the idle gate stay as they are. The defect is which
  turns count as work, not how many nudges a stall takes.

## Sections of Work

### 1. Clear the count on an un-nudged work turn, and hold the tree behind a cap pause
Model: opus

The changes above: the reset, the lift by flag and the three hold sites in `hooks/index.ts`, the
helper and the `hasStartableWork` change in `hooks/agent-state.ts`, the queue close text with its
ledger entry, with the tick cases written first and watched red against the unchanged code, then
the README edits. Opus because the hold coordinates four read sites across two modules and an
injected string, and each case still has an exact sibling: `caseR60f3b_reactivationAfterCapPause`
for a turn that calls a work tool, `caseSection4_threeNudgedCompleteTurnsTripTheStallPause` and
`plan2Harness` for a plan entry under repeated nudges, and `caseGtc3_noActiveEntryActivatesNextUnlessHeld`
for a hold arm beside a no-hold control.

Tests: lock both directions of the reset on a plan entry, that three nudges each followed by an
un-nudged turn calling a work tool never reach the cap, and that three nudges each followed by an
un-nudged turn calling no work tool still do, since a reset that fires on talk alone would retire
the stall signal; and lock both directions of the hold, that a tree with a cap-paused entry and a
pending sibling activates nothing on the tick and reactivates the capped entry on the next
work-tool turn with the sibling still pending, and that a plainly paused entry with no cap flag
still lets the tick start the sibling, since a hold that reads any paused entry would freeze every
operator pause for the session; and lock that the lift fires with a null active id, since that
is the state every relaunch leaves and the failure there is a tree frozen until a `goal_resume`.

Acceptance:
- On a plan entry, a completed turn the controller did not nudge that called at least one work
  tool leaves `consecutiveNudgesWithoutOnGoal` at zero and writes a `score_skipped` record whose
  detail carries `nudge count cleared by work`; the same turn with no work tool call leaves the
  count and the record as they are today. A nudged turn is scored as today, and the existing
  three nudged-turn trip cases pass unchanged.
- The tick's no-active-leaf branch activates nothing while the tree holds a cap-held entry and
  writes no record for the hold; with none it activates the next pending entry as today, even
  where another entry is plainly paused, and an entry dropped while cap-held holds nothing at any
  of the four sites. The `goal_add` and `goal_done` by-name holds read the helper, and the
  existing `caseGtc3_noActiveEntryActivatesNextUnlessHeld` arms pass unchanged.
- `hasStartableWork` returns false for a tree with a cap-held entry and a pending sibling, and
  true for the same tree once the entry is resumed or dropped; its comment states the hold.
- The `[GOAL QUEUE]` close on a cap-held tree names the nudge cap and the work-tool turn that
  lifts it, the ledger entry for that text exists, and `node .kit/injection-duplicate-test.mjs`,
  which reads the ledger, exits 0.
- After a cap pause on a plan entry with a pending sibling, a completed turn that called a work
  tool leaves the capped entry active with `reactivated_by_work` logged and the sibling pending,
  both where `activeGoalId` still names the capped entry and where the state was seeded with
  `activeGoalId` null as a store load leaves it; with two cap-paused entries the later-updated
  one is the one reactivated.
- `README.md` at the M13 rule, the Cap bullet and the "Which turns are scored" paragraph states
  the pause with no ask, the full reset list and the hold, and no line of the file says the cap
  escalates to `ask-operator` or that the counter resets only on two events.
- Each new case was watched red against the unchanged code before the fix, and the Chapter
  quotes each case's failing check line and the exit code from that red run. The two controls,
  the no-work-tool arm of the reset and the plain-pause arm of the hold, are green both ways and
  owe no red run.
- `node .kit/controller-tick-test.mjs` and `npx tsc --noEmit` exit 0, each run after the
  process-list poll the kit's testing-discipline skill names under its Check the box rule.
- The backlog entries of 2026-09-23 on the nudge cap and of 2026-09-21 on the README's reset
  sentence are retired at the close-out prune.

Files in scope: `hooks/index.ts`, `hooks/agent-state.ts`, `.kit/controller-tick-test.mjs`,
`.kit/injection-ledger.json`, `README.md`, `docs/backlog.md`, and `docs/README.md`, whose index line for this plan moves to Archived plans
at the close-out.

## Out of Scope

- How `turn.start` matches a turn to the nudge that opened it, and why a nudged turn on a busy
  worker often matches nothing.
- The cap's count, the hourly nudge budget, the idle gate and the classifier's label set.
- `isWorkTool`, which counts Write, Edit, Bash, NotebookEdit and non-plugin MCP tools and not
  an agent dispatch or a read.
- `enforceInvariants` and the rest of the store-load repair in `hooks/agent-state.ts`.
- The entries paused with the cap reason in any persona's store today.
- `docs/architecture.md`, which does not state the cap rule.

## Assumptions

- assumed 2026-09-23 (the repository's other plans): the commit model is Branch-and-PR; reversal:
  one header line.
- assumed 2026-09-23 (the architect): the executing worker runs under the kit, whose
  executing-work skill owns the red-then-green rule, the reviewer pair and the Chapter; a worker
  under another engine records that engine's review in the Chapter instead.
- assumed 2026-09-23 (the architect): a delivered-record turn on a plan entry that calls a work
  tool is ordinary work and takes the reset, the same as an agent-completion turn; reversal: drop
  the reset from the origin skip branch, one condition.
- assumed 2026-09-23 (the architect): a stretch of turns that only dispatch agents and read their
  results calls no work tool and does not clear the count, so three nudges across such a stretch
  still pause the entry; the dev-persona log shows work-tool calls in the turns between its
  nudges, and the Operator Verification watches for the residue; reversal: count an agent
  dispatch as work for the reset alone, one predicate.
- assumed 2026-09-23 (the architect): a cap-held tree with a pending sibling is idle for the
  goal-levels proposal, on the ruling's clause that nothing the controller will start by itself
  counts as idle; reversal: the proposal step reads the hold beside `hasStartableWork`, one
  condition.

## Operator Verification

- After the pull request merges, update the installed plugin copy and relaunch each persona's
  supervisor, as the goal-levels plan's Operator Verification describes. Over the following day, no persona's decision log carries `paused_by_controller`
  with the cap reason on an entry whose preceding turns called work tools, and no `activated`
  record reading `no active leaf, pending work found` follows a cap pause.

## Open Questions

None.

## Chapters

Retired 2026-09-23 before any section ran, on the operator's ruling recorded under Intent. No
code changed. The nudge-state plan at `docs/plans/agent_persona_nudge-state_v1.md` carries the
reset and gates on goal-levels alone.
