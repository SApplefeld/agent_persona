# Nudge state split from goal state

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-23

## Goal

When this is done, the controller keeps its own record of whether to nudge, and the goal tree keeps
only the states the worker and the operator mean. The controller never writes `paused` on a goal
entry. Its idle branch reads one hold, computed from an open ask and the worker's own WAITING or
BLOCKED line, and the nudge cap, the hourly nudge budget and the error streak each hold by opening
an ask rather than by writing a status. A nudge asks the worker for a status line from a
closed set, the count that trips the cap counts nudged answers that carried none, and the third
such answer opens one fixed question to the operator and pauses nothing. Each turn's id
reaches the plugin's log at its start and its completion, so whether a turn was open when a nudge
went out can be read from the log. And one shadow question, whether work should continue on its own after the worker's closing
text, is journaled with an outcome so it can be scored before it is trusted. It matters because on
2026-09-23 the dev-persona persona's goal-levels entry was paused mid-section by a cap that counts
nudges the scorer never judged, and the tick handed its slot to the next plan. The same persona's live
log shows 67 turn starts against 106 completions, a gap the ruling of 2026-09-25 under Intent
traces to background subagents finishing inside an open turn rather than to missed starts.

## Dispatch Authorization

This plan starts only after `docs/plans/agent_persona_goal-levels_v1.md` has merged to the
trunk, because that plan edits the tick's no-active-leaf branch and the goal tools, which this
plan edits too. The nudge-cap plan that once stood between them was retired unrun on 2026-09-23,
under the ruling recorded below in Intent, so nothing else gates this plan. The trunk is
`origin/main`, read after a fetch. The check: `git ls-tree --name-only origin/main docs/plans/`
does not list the goal-levels file, and it is on the trunk under `docs/archive/` or
`docs/plans/archive/` with `Status: Complete` in its header. A worker that finds it still listed
stops with a `BLOCKED:` lead naming it. The work runs on one branch cut from that fetched trunk
and lands as one pull request for the whole plan. Execution waits on the coordinator handing this
plan to a worker by name.

## Intent

The frame, in the operator's words on 2026-09-23: "Pause wasn't supposed to be the session's
bookkeeping tool, it was supposed to be the controller's bookkeeping tool. But then the session
started using it for goal-tracking and assignment, and it became confusing." And: "Pause was meant
to control whether we keep nudging, which is separate from what the session is working on."

**What done needs.** The controller decides whether to nudge from one hold it owns, never from a
goal entry's status. A goal entry's status is written by the worker, the operator, or the
controller's assignment of the active slot, which includes the one-time load repair this plan
adds, and by nothing else. The controller reads the worker's answer to a nudge without a classifier, on the architect's
status-line design under Assumptions, and a worker that answers is never paused for the answer. The controller never queues a nudge while a turn is live. The operator's question about
the closing text is measured in the dark before anything reads it.

**What done does not need.** No classifier reads the status line where one is present. No goal
entry is paused, completed or dropped on the controller's own reading of the worker's text. The
shadow question reaches no branch, no state field and no nudge text in this plan. The `lead`
field stays on the entry as the worker's record. The switch and `goal_resume` demotions keep
writing `paused`, and the `goal_add` demotion keeps writing `pending`, because they are
assignment of the active slot, which the tree carries. The hourly cost-cap ask keeps its text. The classifier's controller labels keep their
set.

Alternatives refused:
- A new goal status, `held`, beside `paused`. Refused, because the hold is the controller's and
  the tree is the worker's, and a status on the entry is the conflation this plan removes.
- Reading the harness's own `UserPromptSubmit` and `Stop` hooks as the open-turn signal in place of
  the plugin's events. Refused for this plan, because the plugin already receives `prompt.submit`,
  `tool.call` and `turn.complete`, and the dev-persona log shows those arrive where `turn.start`
  does not; a hook file is a second delivery path to keep in step.
- Wiring the continue-automatically question live in this plan. Refused, because the journal
  shows the existing blocked question reads waiting as blocked on nearly every turn, and a question
  is promoted on a score, never on its wording.
- Walking on to the next pending entry when an ask times out, as today. Refused, because it is the
  silent reassignment the operator named.

**Rulings.** Ruled 2026-09-23 by the operator, on the architect's ask: the nudge-cap plan,
`docs/archive/agent_persona_nudge-cap_v1.md`, is retired before any of it ran, and this plan
carries the one thing it would have built that survives here. That thing is its reset, a turn
that calls a work tool clearing the count, which is the second of the five reset events under
"The status line and the count". The rest of that plan, the hold that kept the tick from starting
a sibling behind a cap pause and the lift that reactivated the paused entry across a relaunch,
is not built, because under this plan the cap never pauses the entry and there is nothing to
hold behind or lift. So this plan gates on goal-levels alone, and its Section 5 retires the two
backlog entries the nudge-cap plan would have retired, the nudge-cap entry of 2026-09-23 and the
README nudge-counter entry of 2026-09-21.

Ruled 2026-09-25 by the architect, on the executing session's finding: section 1 is narrowed to
its logging half. The premise that the harness under-delivers `turn.start` is disproven at the
source: the child debug logs reconcile every persona turn's start with the prompts that opened it
(the backlog entry of 2026-09-23 on the extra turn completions), and the surplus completions are
background subagents finishing inside an open turn. So `prompt.submit` and `tool.call` do not
open the open-turn reading, and `turn.start` stays its only opener. A dev-persona session nudged
while its closing text read `WAITING:` is idle on a background run, which is section 2's waiting
hold, not a turn the reading missed.

Provenance: distilled from the architect session of 2026-09-23 on the operator's thread, four
messages from the operator between the nudge-cap plan's merge and this plan's draft.

## Approach

**The hold.** A function `holdOf(state, now)` in `hooks/agent-state.ts` returns the one reason
the controller must not nudge, or null. It reads, in this order, and returns the first that holds:
an open ask (`pendingAskId` set) as `ask`; the active entry's `lead` with state `blocked` as
`blocked`; and the active entry's `lead` with state `waiting` within `LEAD_WAITING_HOLD_MS` of its
`at` as `waiting`. The set of reasons is closed at those three. A blocked lead set before the
entry's last ask closed is cleared with `lead_cleared` before the read, as today
(`hooks/index.ts:5028-5037`), so an answered ask on a `BLOCKED:` worker lifts the hold. No new state field is added: the
nudge cap, the cost cap and the error streak each already open an ask, and that open ask is their
hold, so a stored controller reason would only restate `pendingAskId`. The tick's idle branch
(`hooks/index.ts:4997-5040`) replaces its open-ask skip and its `heldLead` reads with one
`holdOf` call after the idle gate. An `ask` hold still runs `tickOpenAsk` so an answer or an
expiry closes the ask. Nothing is logged per held tick, as today. The decision that opened each
ask names why it opened, which is how a reader tells a cap hold from a streak hold.

**What stops writing paused.** Four controller sites write `paused` today and stop. The nudge cap
(`hooks/index.ts:5116-5120`) opens the fixed ask below and writes no status. The cost cap
(`5186-5189`) keeps the ask it opens and writes no status; once that ask closes, the hourly
budget check before classify (`5161`) still refuses nudges until the window rolls, as today. The
error streak (`4436-4437`) keeps the ask it opens and writes no status. The worker's own `ASK:`
line at turn end (`6028-6029`) pauses nothing, since the open ask is itself the hold. None of
the four writes `blockedReason` either; the ask record carries the reason, and the `[GOAL QUEUE]`
line for the entry reads as an active entry with an ask open. The two
ask-close gates that read `status === "paused"` before reactivating (`4193`, `8124`) go with it. `reactivateAskedEntry` (`2015-2027`) no longer
demotes other active entries or re-activates the asked one, since the asked entry never left
`active`; it clears a `blockedReason` left on the asked entry by a store written before this plan and
nothing else.
An ask that times out (`tickOpenAsk`, `hooks/index.ts:513-515`) closes as `expired`, lifts the
hold, leaves the entry active, and activates nothing. The next nudge on that entry names the
expired ask in one sentence. `pausedByNudgeCap` is removed from `GoalNode`, and every reader of it
goes: the `goal_add` hold (`7113`), the `goal_done` hold (`7353`), the `reactivated_by_work`
branch (`6251-6267`), the `goal_done` clear (`7296-7298`), the `goal_resume` clear (`7526-7528`),
and the `goal_add` handler's activation refusal that reads it beside `goal_done`'s (`7113`,
`7353`). `hasStartableWork` (`hooks/agent-state.ts:988`) is unchanged, since it reads statuses
alone today and nothing this plan adds is a status. The load-time repair at the E11 site (`hooks/agent-state.ts:720`) takes every entry with status
`paused` and `pausedByNudgeCap` true: where no entry is active, the one with the latest
`updatedAt` becomes `active` and the rest `pending`; where one is, all become `pending`. It drops
the field and writes one decision per entry repaired, so the two dev-persona entries paused
by the cap today recover on the next load.

**The status line and the count.** The nudge text asks the worker to open its closing text with
one of `WORKING:`, `WAITING:` or `BLOCKED:` and what follows. The two existing leads keep their
meaning and their writer (`hooks/index.ts:6053-6081`), and `WORKING:` is read at the same site
by the same rule, the literal as the closing text's first characters, case as written: it sets no
lead and clears a `waiting` lead. A nudged turn is one whose `turn.start` matched the nudge's
expected entry (`5711`); a turn that matched nothing is unaccounted and moves the count neither
way, so a nudge whose turn cannot be placed never trips the cap. `sess.consecutiveNudgesWithoutOnGoal` is renamed
`nudgedAnswersWithoutStatus` and counts nudged turns whose closing text opened with none of the
three and that called no work tool and dispatched no agent. A nudged turn that worked and wrote
no line is a working turn, so the reset below wins and the count moves to zero, never up. The count is one per session, as today, not one per entry. It resets to zero on five events, and
the list is closed at them: a nudged turn that opened with any of the three lines; any turn,
whatever entry it ran under, that called a work tool or dispatched an agent (`isWorkTool` at
`570` gains `Agent` for this count alone, through a second predicate rather than a change to the
shared one); a turn opened from a channel message; every `activate` call (`1968`); and the close of the
fixed ask below, by answer or by expiry, since an ask closed either way ends the count that opened
it, and a count left at the cap would reopen the ask on the next tick in place of the nudge the
expiry promises. The scorer's on-goal reset (`6192`)
goes, since the scorer no longer feeds the count; the scorer itself stays for task entries. The
count reaching `MAX_CONSECUTIVE_NUDGES` opens an ask
whose text is a named literal with a ledger entry: the persona, the entry's title, that three
nudges were answered with no status line, and that any answer resumes nudging. The answer closes
the ask, lifts the hold, and resets the count. The toast stays.

**The open-turn reading.** `openTurns` (`hooks/index.ts:2251-2252`) stays opened by `turn.start`
alone, under the ruling of 2026-09-25 in Intent. Both `turn.start` and `turn.complete` write
`e.turnId` through the plugin's own log line rather than the decision ring, which
`DECISIONS_MAX` caps at 200 and a per-completion record would crowd; that is the cheap first step
the backlog entry of 2026-09-13 asks for, and the instrument the Open Questions read. The idle
clock keeps reading `lastTurnComplete`.

**The shadow question.** `hooks/question-catalog.ts` gains `WORK_CONTINUES = "work-continues"`,
primitive `noul`, which answers a number from 0 to 1 read as the probability of yes, instructions asking whether, given `closingText`, work should continue on its
own after this message with nobody else acting first. It joins `PLAN_HEALTH_SET_IDS` and the asks
in `shadowAskPlanHealth` (`hooks/index.ts:321-325`), so it costs no second request. Its outcome
kind is `continued_unprompted`, written `true` where the next completed turn, whatever entry it ran under, as `next_speaker`
reads it, opened unaccounted and not from a channel message, and no nudge was sent for the entry
between. It is written `false` where a nudge was sent for the entry first, or where that next turn
opened from a nudge, a channel message, a delivery, a proposal or a plugin prompt, since each of
those is somebody or something else acting first,
at the sites that write `next_speaker` (`6420`) and `nudge_sent` (`5556`). A call is one
plan-health request, one per plan-entry turn end, and its outcome is written once by whichever of
the two sites fires first; where neither fires, because the entry never gets another turn, no
outcome is written and the scoring skips that answer. The promotion bar is
written in `README.md` beside the question: seven days of answers, and agreement with the
outcome above 0.85 at a threshold of one half, read from the journal. Nothing reads the answer.

**Coverage sweep.** One Explore sweep ran on 2026-09-23 over the checkout at `a923263`, with the
searches: every write of `status = "paused"`, `pausedByNudgeCap`, `blockedReason` and `lead`;
every read of `status === "paused"`, `pausedByNudgeCap`, `blockedReason`, `lead`,
`hasStartableWork`, `enforceInvariants` and the `[GOAL QUEUE]` block; the `.kit/` cases asserting
on those; the doc surfaces naming pausing, the cap, the lead hold and the queue block; the
question-catalog declaration shape and the `writeOutcome` sites; and the `AgentState` shape and
its load-time fill. Surfaces found, each placed in a section or under Out of Scope: the eight
`paused` writers (`2017`, `4436`, `5118`, `5188`, `5371`, `6028`, `7193`, `7513`); the readers
at `4193`, `5022-5039`, `6251`, `7113`, `7174`, `7353`, `7500-7503`, `8124`, `8202-8207`;
`hasStartableWork` (`agent-state.ts:988`), `openGoals` (`980`), `activateNext` (`1043`),
`enforceInvariants` (`804-831`), `parseState` (`577`), `createDefaultState` (`378`); the
`.kit/controller-tick-test.mjs` families `caseR58f3`, `caseR60f3b`, `caseSection10FixRound`,
`caseLead3_*`, `casePlanHealth_*`, `caseS3_*`, `caseItem8p2_*`, `caseS13_*`, `caseGtc3_*`,
`caseIq_*`; `README.md` at 121, 140-154, 173, 175, 187, 189, 628-632, 650, 686, 771, 878;
`docs/architecture.md` at 18, 278, 284; `hooks/question-catalog.ts` at 84-86, 98-99, 115, 119,
205-239; `hooks/decision-journal.ts:114-115`; the outcome writers at `5995`, `6165`, `6420`,
`6436-6438`, `6463`. Line numbers are the trunk's at `a923263` and move once the goal-levels plan
merges, so the worker finds each site by the symbol named beside it.

## Standing Brief Amendments

- `turn.start` is the only event that opens the open-turn reading; `prompt.submit` and `tool.call`
  open nothing (the architect's ruling of 2026-09-25 under Intent).

## Sections of Work

### 1. The turn id reaches the plugin log at turn start and completion
Model: opus

The change under "The open-turn reading", narrowed to its logging half by the ruling of
2026-09-25 in Intent.

Acceptance:
- The plugin's log carries the turn id at both turn start and turn completion, folded to one line
  with no square bracket, no new decision is written per turn, and the existing open-turn cases
  pass unchanged.

Files in scope: `hooks/index.ts` (the `turn.start` and `turn.complete` handlers),
`.kit/controller-tick-test.mjs`.
Tests: lock that both log lines carry the id and that a hostile id cannot break the line, since
the line is the instrument the Open Questions read.

### 2. One hold, and the controller stops writing paused
Model: fable

The changes under "The hold" and "What stops writing paused", with the load-time repair. Fable
because the hold coordinates the tick, four controller writers, the ask close, the ask expiry,
two goal tools and the store's load, and a miss at any one leaves a tree the controller either
nudges through a hold or never nudges again.

Acceptance:
- `holdOf` returns `ask` while an ask is open, `blocked` for a blocked lead, `waiting` inside the
  window and null past it, and null on a plain active entry; the tick's idle branch sends no
  nudge under any non-null hold and nudges under null.
- The nudge cap, the cost cap and the error streak leave the entry `active`, open their ask, and
  the tick activates nothing after any of them; the ask's close, by answer or expiry, is the lift,
  and the cost cap's hourly refusal still holds past it until the window rolls.
- A worker `ASK:` line leaves the entry `active`; the ask's answer lifts the hold and moves no
  status; an ask that times out lifts the hold, leaves the entry `active`, activates nothing, and
  the next nudge names it.
- A store carrying two entries `paused` with `pausedByNudgeCap` true and no active entry loads
  with the later-updated one `active` and the other `pending`, the field gone from both, and one
  decision per repair; the same store with an active entry loads with both `pending`; `enforceInvariants` then finds an active entry and leaves `activeGoalId` set.
- The `goal_add` and `goal_done` handlers hold on no cap state, `hasStartableWork` reads statuses
  alone, and every case that asserts `paused` on a path this plan changes (`caseR58f3_capPausesWithNoAsk`,
  `caseR60f3b_*`, `caseSection10FixRound_nudgeCapPauseBlocksActivation`, `caseS13_errorStreak_*`,
  `caseS3_*`, `caseItem8p2_*`, `caseGtc3_noActiveEntryActivatesNextUnlessHeld`, and any
  `caseLead3_*` or `caseIq_*` case that does) is rewritten to the status this Approach names for
  that path, `active` with an ask open, with each rewrite named in the Chapter; a case on a path
  this plan leaves alone passes unchanged.

Files in scope: `hooks/index.ts`, `hooks/agent-state.ts`, `.kit/controller-tick-test.mjs`,
`.kit/injection-ledger.json` and `.kit/injection-ledger.mjs` (regenerated where the nudge
sentence naming an expired ask changes an injected text; the `[GOAL QUEUE]` block at `8202-8207`
keeps its two close texts), `README.md` (the "Cap" bullet at 151, 628-632), `hooks/self-review.ts`
(one comment naming the removed pause, folded in during section 2).
Tests: lock both directions of every hold reason, since a hold that never lifts is the frozen
tree of 2026-09-23 and one that never holds is a nudge into an open ask. Lock the load repair
against a store with two cap-paused entries and no active one, the dev-persona shape.

### 3. The status line, the count and the fixed ask
Model: opus

The change under "The status line and the count". Opus because the count's reset sites span the
scorer, the turn-end lead read, the tool-call handler, the channel-origin read and `activate`,
and each has a sibling in the code: the waiting-lead clear and the `reactivated_by_work`
branch (`6251-6267`) both read `toolCallsThisTurn` at the same handler for the same question.

Acceptance:
- A nudged turn opening with `WORKING:`, `WAITING:` or `BLOCKED:` resets the count; one opening
  with none of them adds one; three in a row open the fixed ask, which `holdOf` then reads as `ask`, and pause
  nothing; the ask's close, by answer or expiry, resets the count and lifts the hold.
- A nudged turn that called a work tool and wrote no status line resets the count.
- An un-nudged turn that calls a work tool or dispatches an agent resets the count, under the
  active entry or any other, and a channel-origin turn resets it; a read-only un-nudged turn does
  not, and an unaccounted turn moves it neither way.
- `WORKING:` clears a waiting lead and sets none; the nudge text names the three lines and the
  ledger carries the fixed ask literal; the scorer's on-goal label moves the count no longer.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.json`,
`.kit/injection-ledger.mjs`, `README.md` (M13 at 146, 173, 175).
Tests: lock that three answers without a line reach the ask and that any line resets, in both
directions, since the cap firing on a working worker is the defect of 2026-09-23 and a cap that
never fires leaves a lost worker un-asked.

### 4. The shadow question and its outcome
Model: sonnet

The change under "The shadow question". Sonnet because `WORKER_BLOCKED` is the exact sibling for
the declaration, the `lead_blocked` writer at `6463` the sibling for the outcome, and
`casePlanHealth_oneCallAndThreeAnswersPerPlanEntryTurn` the sibling case.

Acceptance:
- One plan-health request carries four questions and journals four answers; the
  `continued_unprompted` outcome is `true` on a next turn that opened unaccounted and not from a
  channel message, and `false` where a nudge was sent first or that turn had another origin, and
  is written at most once per call.
- The decisions and every state field are invariant across the answer's extremes, as
  `casePlanHealth_decisionsAreInvariantAcrossEveryJevExtreme` locks for the three today, and a
  request that hangs or rejects delays the turn's end by nothing and writes no outcome, as
  `casePlanHealth_hungRequestCannotDelayTheTurnEnd` locks.

Files in scope: `hooks/question-catalog.ts`, `hooks/decision-journal.ts`, `hooks/index.ts`,
`.kit/controller-tick-test.mjs`, `.kit/question-catalog-unit-test.mjs` (its set-count pin and
its plan-health list pin move to four), `.kit/decision-journal-unit-test.mjs` (its closed-set
pin gains `continued_unprompted`), `README.md` (the question table at 686 and the promotion bar).

### 5. The documents
Model: sonnet
Locus: inline

`README.md` and `docs/architecture.md` state the behavior as it now is: the hold and its reasons,
what the controller writes on an entry and what it never writes, the three status lines, the
count's reset list, the fixed ask, the open-turn reading, and the shadow question with its bar.
`docs/backlog.md` retires the open-turn guard entry of 2026-09-13 to
`docs/archive/backlog-2026-Q3.md`, and narrows the ask-close entry of 2026-09-22 to its
persist-ordering half, since its other half, the reactivation that leaves the paused reason on an
active entry, is removed here. It also retires two entries the retired nudge-cap plan would have
retired, the nudge-cap entry of 2026-09-23 and the README nudge-counter entry of 2026-09-21, to
the same quarter archive, since the count's reset list this plan writes into `README.md` is the
closed list of five and the cap no longer pauses anything. `docs/README.md` gains this plan's
row.

Acceptance:
- No sentence in either document says the controller pauses an entry on its own reading of a
  count or of the worker's text, escalates the cap to an ask-operator verdict, or says the
  open-turn reading opens on `prompt.submit` or `tool.call`.
- The four backlog edits are made and the three retired entries sit in the quarter archive.

Files in scope: `README.md`, `docs/architecture.md`, `docs/backlog.md`,
`docs/archive/backlog-2026-Q3.md`, `docs/README.md`.

## Out of Scope

- The switch (`5371`) and `goal_resume` (`7513`) demotions to `paused`, the `goal_add` demotion to
  `pending`, the
  `goal_edit` pause (`7193`), and the `goal_edit` drop's status check (`7174`).
- A verb that returns a paused entry to `pending` (the backlog entry of 2026-09-22).
- `goal_resume` ignoring an open ask, and the persist ordering at ask close (the two backlog
  entries of 2026-09-22 and 2026-09-23 that state them).
- The hourly cost-cap ask's text and whether it should exist (the backlog entry of 2026-09-14).
- Wiring the shadow question live, and any change to the three plan-health questions.
- The classifier's controller and scorer label sets, `MAX_CONSECUTIVE_NUDGES`, the idle gate and
  the nudge floor.
- Why `turn.start` goes undelivered, which is the harness's.
- The board in the discord-channels repository.

## Assumptions

- assumed 2026-09-23 (default): Branch-and-PR, as every agent_persona plan since the trunk gained
  review; reversal: the header line.
- assumed 2026-09-23 (the architect): the hold is computed by one function over the ask slot and
  the lead, never stored, so nothing can drift from it; reversal: a stored field written at each
  site, five writers.
- assumed 2026-09-23 (the architect): the closed status set is three lines, and a worker with
  nothing left under an entry says so with `goal_done` or `BLOCKED:`; reversal: a fourth line, one
  literal and one branch.
- assumed 2026-09-23 (the architect): an agent dispatch counts as work for the count's reset
  alone, and a read does not, on the operator's agreement of 2026-09-23; reversal: one predicate.
- assumed 2026-09-23 (the architect): an expired ask lifts the hold and nudges resume, rather than
  the entry pausing; reversal: one branch in `tickOpenAsk`.
- assumed 2026-09-23 (the architect): the promotion bar for the shadow question is a README
  sentence and no code reads it; reversal: none needed, it is prose.
- The fixed ask is not the controller prose Round 58 removed, because its text is a literal with
  the entry's title spliced in and asks one question the operator can answer.

The freeze: these hold until the operator or the architect appends a ruling under Intent, which
the Chapter records as drift.

## Operator Verification

- After the fleet relaunches on this, a worker sitting on a background test run for more than a
  minute receives no nudge inside that turn. A nudge landing inside a live turn reopens Section 1.
- The dev-persona persona's two entries paused by the cap read `active` or `pending` after its
  next load, with no hand `goal_resume`.
- After the fleet relaunches on this, section 1's turn start and turn complete log lines show a
  background subagent completing inside a turn with a turn id different from that turn's own.
  The nudge count reads a nudged answer from the completion carrying the nudged turn's id, so
  matching ids would count the subagent's text and skip the worker's. Across the same week, no
  turn start line falls between a persona turn's start and its own completion. One that does
  reverses section 3's ruling that per-turn tallies belong to the completing persona turn.
- After seven days, the journal's `work-continues` answers agree with `continued_unprompted` at
  the bar or the question is reworded before any plan wires it.

## Open Questions

- Why the dev-persona persona was nudged through test runs while writing `WAITING:` on three
  turns in four. Section 1's turn-id logging is the instrument; the answer is read after a week.

## Chapters

### Chapter 1 - 2026-09-25
Completed: 1. The turn id reaches the plugin log at turn start and completion
Implemented By: implementer-opus (three rounds), then main session for the narrowing revert after the architect's ruling
Metrics: review rounds 3, closed major-closed; provenance 9 spec-traceable, 0 fix-introduced, 1 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 1 open: changes the open-turn reading so prompt.submit and tool.call open it (by turn id where carried, else one synthetic key) and turn.complete always closes the synthetic key, plus turn-id logging at turn.start and turn.complete; serves the Goal sentence "The controller's reading of whether a turn is open takes every event that proves one" and the Intent clause "The controller never queues a nudge while a turn is live"; adds a mechanism, the synthetic key, which the Approach "The open-turn reading" names; size about 3 handler edits and one key constant plus 4-6 test cases; not building it leaves four turns in ten read as idle and nudged into.
- round 1 fix (drop leak, Critical blind / Major adversarial, spec-traceable): prompt.submit removes the synthetic key it opened when the prompt is dropped or the handler throws; serves section 1's Tests clause "lock that the reading closes, since a key that never closes silences nudges for the life of the session"; adds no mechanism beyond undoing its own open (a guard traced to that clause); size about 10 lines plus 2 cases; not building it lets one dropped idle prompt silence the controller for the session.
- round 2 fix (blind Majors, spec-traceable to Tests "a key that never closes silences nudges" and Goal "a nudge is never queued into live work"): tool.call from a subagent loop (agentId set) no longer opens the reading, and prompt.submit always opens the synthetic key rather than its turn id; adds no mechanism (narrows an existing open, reuses the file's inSubagent predicate); size about 4 lines plus 2 cases; not building it holds the whole tick, inbox delivery included, for a background agent's whole run, and lets a delivered prompt leave an id key no completion closes.
- round 3 fix (adversarial Majors, spec-traceable to section 1 "opens the reading the same way" and Tests "lock that the reading closes"): prompt.submit no longer removes its key when its chain throws, since the host skips a failed hook and the turn still runs (claude-code.d.ts:2101, 2193); comments corrected on settings hooks, which run inside next(e), and on turn.start delivery; removes a mechanism rather than adding one; size about 10 lines net. Superseded before it landed: the implementer was stopped mid-round by the ruling below, and its uncommitted edits were discarded.
- The premise was wrong. Round 3's adversarial review found the repository's own backlog entry of 2026-09-23 ("The extra turn completions are subagents finishing inside an open turn") reconciling every persona turn's start with the prompts that opened it, and the comment in the currentGateTurnId block of hooks/index.ts saying the same. The Goal's 67-against-106 gap is background subagents' completions, not missed starts. The architect ruled on 2026-09-25 to narrow section 1 to its logging half and drop the extra opens, after the check that nothing in sections 2 to 5 reads them (their Approach reads the ask slot and the lead, never openTurns). The main session rebuilt the section from the base commit 55b9025 plus the two log lines and the logging case, and reverted every fixture change the extra opens had forced on existing cases. Commits d65e2b6, bb34bfc and 07f8233 on the branch carry the superseded rounds; the section's net diff against 55b9025 is the logging half alone.
- Plan doc drift, recorded deliberately: the header moved from Ready to In Progress at the start of this run; the ruling of 2026-09-25 is appended under Intent; the Goal's open-turn sentence and its evidence sentence are rewritten to the ruling; the Approach paragraph "The open-turn reading" and section 1's heading, acceptance, Files in scope and Tests are rewritten to the logging half; a Standing Brief Amendments block is added above Sections of Work carrying the ruling.
- The Open Question about a dev-persona nudged through test runs while writing WAITING now points at section 2's waiting-lead hold, per the same ruling.
Assumptions:
- assumed 2026-09-25 (default, section 1): a turn id is event-supplied text on a one-line log, so it passes through the file's existing kaizenLine fold (one line, bracket-safe) rather than a new sanitizer; reversal: one call site each.
Review Findings: review: adversarial + blind at fable, Agent tool (rounds 1 and 2); review: performance at fable, Agent tool (round 1); review: adversarial at opus, Workflow high (round 3). Every Critical and Major across the three rounds was about the extra opens (the drop leak, the throw path, subagent tool calls, delivered-prompt id keys, subagent completions closing the synthetic key, the plain-path skip log, the premise), and the narrowing removed the code each one named, so none survives against the shipped delta. The round 3 premise Major, orchestrator-traced to the Goal's evidence sentence, is the one whose remedy was the ruling. Minors: 0 fixed in the close pass, 0 upgraded, 22 left because the narrowing removed the code each names, except the hostile-id pin, which ships in its round 2 shape (no line terminator and no bracket, rather than an exact rendering). Author re-read of the narrowing delta in place of a fourth round: the shipped code diff is the two log lines rounds 1 to 3 already reviewed, and the test diff is the logging case in its reviewed round 2 shape.
Stamps: adjudicated 2, stamped 2 (the-shell-pipe-is-a-better-turn-signal-than-the-plugins-hook-events and prompt-submit-always-waits-for-idle-so-it-cannot-reach-a-running-turn, both of which shaped the event-shape reading); the 20 operator-tier hits are other sessions' reads on this machine's shared tier and none bore on this section.
Gate: targeted lane (SCOTT-CLAUDE, 2026-09-25 00:57, worktree D:/agent_persona-nudge, three files modified on top of 07f8233): tsc --noEmit exit 0; node .kit/controller-tick-test.mjs exit 0, 3372 OK, 0 failures, against the baseline 3365 OK, 0 failures on the same lane at 55b9025 (the implementer's run, reported). Red before green: the logging case against the base hooks/index.ts failed 3 checks and passed after. Test delta: 1 added (caseOpenTurn_turnIdLoggedAtStartAndCompletion, 7 checks, pins that both turn log lines carry the id and that a hostile id cannot break or bracket the line), 0 retired, 0 existing tests edited. Spawning tests added: 0. Contention: none beyond the relay and sidecar daemons.
Next: 2. One hold, and the controller stops writing paused
Commit Model: Branch-and-PR
Delta: SCOTT-CLAUDE, 2026-09-25 00:57
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-25
Completed: 2. One hold, and the controller stops writing paused
Implemented By: implementer-fable (first green and two fix rounds); main session for one README sentence before 0e4b1db
Metrics: review rounds 4, closed claim-exit; provenance provenance 6 spec-traceable, 1 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 1 findings, 1 fixed (the round 1 performance Major, covered by the blind Critical's fix), 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 2 open: replaces the idle branch's open-ask skip and heldLead reads with one holdOf(state, now) in hooks/agent-state.ts; stops the nudge cap, cost cap, error streak and worker ASK: line writing paused (the cap newly opens an ask); narrows reactivateAskedEntry to clearing a legacy blockedReason; makes tickOpenAsk expiry activate nothing and the next nudge name the expired ask; removes pausedByNudgeCap and its readers; adds the load repair for cap-paused entries; serves the Goal sentences "The controller never writes paused on a goal entry" and "Its idle branch reads one hold", and the Intent clause "The controller decides whether to nudge from one hold it owns, never from a goal entry's status"; adds mechanisms the Approach names (holdOf, the cap's ask, the load repair) and removes two (pausedByNudgeCap and the work-tool reactivation branch); size about 8 controller sites, one new function, one repair pass, and about 15 rewritten or added cases; not building it leaves the cap pausing entries the scorer never judged and the tick walking on to the next plan, the frozen tree of 2026-09-23.
- round 1 fix (expired-ask wording, adversarial Major, spec-traceable to section 2 acceptance "the next nudge names it"): the sentence stops attributing the ask to the worker, reading "An ask on this entry, ... expired unanswered ..."; adds no mechanism (one string, re-pinned test); size one injected sentence plus one case edit; not building it tells the worker it asked a question the controller opened, for three of the four ask openers.
- round 1 fix (count at the cap, blind Critical, orchestrator-traced to section 2 acceptance "the ask's close, by answer or expiry, is the lift"): the nudge cap resets consecutiveNudgesWithoutOnGoal to zero when it opens its ask, which has the effect the Approach's fifth reset (the fixed ask's close) names, since no nudge can move the count while the ask holds; adds no mechanism (a reset of the existing count, which the Approach names); size one line plus the lift case's assertion; not building it leaves the cap reopening its ask every wait window and never nudging again.
- round 2 fix (cost-cap ask reopen, blind Major, orchestrator-traced to section 2 acceptance "the ask's close, by answer or expiry, is the lift, and the cost cap's hourly refusal still holds past it until the window rolls"): the cost cap opens its ask once per nudge window, under the latch the same block already keeps for its cost_cap_reached line, so a closed cost-cap ask is followed by the refusal alone until the window rolls; adds no mechanism (moves the open under an existing latch); size about 5 lines plus one case's assertion; not building it re-asks the operator the same question minutes after each answer for the rest of the hour.
- round 3 fix (phantom ask slot, adversarial Major, fix-introduced by round 2's reorder, traced to the Goal "one hold, computed from an open ask"): the nudge cap writes its ask record before the slot names it, as the cost cap already does, and resets the count only once the write returns; adds no mechanism (reorders two lines, drops a comment paragraph); size 2 lines moved plus one test check; not building it leaves a store write that throws with a slot naming no record, which refuses the worker's own ASK: line and holds goal_add and goal_done until the next idle tick, and persists to disk on any turn in between.
- Declined, not built, no design stop: fix round 2's implementer proposed a second latch field (monitor.cost.nudgeCapAskWindowStart) so the call cap's shared use of capNoticeWindowStart cannot reopen a cost-cap ask inside one nudge window. The misfire needs the cost-cap ask to close, the call cap to trip and the call window to roll before the nudge window, all inside one hour. Its cost is one extra ask, and the shared field already duplicated the notice line in that same interleaving before this section. Known limit.
- Drift from the plan, recorded deliberately: the nudge cap's count resets when its ask opens rather than at the ask's close as the Approach words it; the two are equivalent because no nudge can raise the count while the ask holds. The load repair activates only an entry isActivationEligible admits, the latest-updated such one, and leaves demoted entries' clocks alone. The plan's Intent and Out of Scope say goal_add demotes to paused while the code demotes to pending (both before and after this section); the README now says pending. caseS13_errorStreak_threeDeniedTurnsOpenAnAsk had its clock moved to 65 s so the streak's ask opens past the cadence gate. hooks/self-review.ts is folded into this section's Files in scope for one stale comment (same directory as hooks/index.ts, no new acceptance, the gate covers it).
- Legacy entries a pre-plan store left paused on an ask are not repaired, justified-not-fixed: owner session.start runs expireOpenAsks (hooks/index.ts near 3570-3585) before any prompt, so no pre-plan ask survives to be answered on this build, and the leftover paused entry then meets the no-active-leaf activateNext exactly as it did under the pre-plan code on any relaunch. goal_resume stays the way out. Named for the operator at the close-out.
- Rewritten or renamed cases: caseS3_no_walk_while_open; caseS3_answer_lifts_the_hold (was answer_reactivates); caseS3_say_leaves_ask_open; caseS3_timeout_lifts_the_hold_and_walks_nowhere; caseS3_timeout_expires_at_the_default_wait; caseD5b_replyClosesAsk; caseSection12_G3; caseSection3_workerAnswer; caseItem8p2_worker_states_fork_opens_ask; caseS9_cost_cap_opens_ask; caseSection10FixRound_capPausedStoreIsRepairedAndGoalAddHoldsOnNoCapState; caseLead3_blockedWithAnAskOpensTheAskAndSetsTheLead; caseLead3_ignoredComplete; caseSection4_threeNudgedComplete and Drift; caseLead3_theOperatorsAnswer; caseR58f3_capOpensAnAskAndPausesNothing; caseR60f3b_workUnderTheCapAskMovesNoStatus; caseR119 control; caseS13_errorStreak_threeDeniedTurnsOpenAnAsk; caseAbk1_errorStreakKeepsTheOpenAsk; caseAbk1_threadReplyMovesNoStatus; caseAbk2_answerRecordMovesNoStatus; caseGtc3_completingByName; caseGtc3_noActiveEntryActivatesNextUnlessHeld. Each was edited because it pinned a paused write, a reactivation or an activateNext on expiry that this section removes.
Assumptions:
- assumed 2026-09-25 (default, section 2): the nudge cap's new ask carries the existing capReason text as its question until section 3 replaces it with the named literal and its ledger entry; reversal: one string.
- assumed 2026-09-25 (source: the Approach's words "An ask that times out (tickOpenAsk ...)", section 2): the next nudge names an ask that expired by tickOpenAsk's timeout only; the owner-start expireOpenAsks pass (hooks/index.ts near 3573) is a restart, not a timeout, and needs no change because the entry already stays active; reversal: extend the naming to that path.
- assumed 2026-09-25 (default, section 2): what tells the next nudge an expired ask is still unnamed is read from existing state (the node's lastAskQuestion and lastAskClosedAt, the ask_timeout decision) before any new field; a new field comes back as an add-decision line; reversal: one field.
- assumed 2026-09-25 (source: the Approach's "What stops writing paused", section 2): an entry a pre-plan store left paused by the cost cap, the error streak or a worker ASK: line is not repaired at load; the repair covers pausedByNudgeCap entries alone, and goal_resume stays the way out of the others.
Review Findings: review: adversarial + blind at fable, Agent tool (rounds 1 and 2); review: security + performance at fable, Agent tool (rounds 1 and 2, the section touches a store write and a per-tick path); review: adversarial at fable, Agent tool (round 3, decayed). Round 1: blind Critical, count left at the cap reopens the ask every wait window (adversarial and performance reported the same), spec-traceable, orchestrator-traced for the blind lens, fixed by resetting the count at the ask's open; blind Major, the expired sentence unreachable for a cap ask, closed by the same fix; adversarial Major, "Your earlier question" false for controller-opened asks, fixed with neutral wording; adversarial Major, legacy paused-on-ask entries, justified-not-fixed as above. Round 2: blind Major, the cost-cap ask reopened after each close within the hour, orchestrator-traced to acceptance bullet 2, fixed by opening it under the existing notice latch; adversarial Major on exact-wording pins downgraded to Minor at adjudication (trace none, injected text governed by the ledger) and fixed with stable-token pins. Round 3: adversarial Major, fix round 2's slot-before-write order left a slot naming no record when the ask write threw, fix-introduced, fixed by writing the record before the slot names it (red before green: a check that a persist after the throw writes no slot failed at 0e4b1db and passes at 6c7c654); adversarial Major, the call cap shares capNoticeWindowStart so a rolled call window can reopen the cost-cap ask inside one nudge window, spec-traceable, justified-not-fixed as the known limit above. Round 4 (owed by round 3's store-write delta): no Critical, no Major, verdict approved with concerns. Minors: 3 fixed in the close pass (three case functions and seventeen labels renamed from the stall pause to the cap ask; the Intent and Out of Scope sentences corrected to say goal_add demotes to pending, recorded as approval drift; the README test index stopped naming a reactivation, fixed in round 3), 0 upgraded, and left with the reason: two ticks overlapping one ask write can open a second record (one store write against a 30 s tick, the cost cap had the same order before this section, and the 24-hour record TTL sweeps an orphan); the cost cap latches its window before its ask write, so a thrown write loses that window's ask while the refusal still holds (a store-write reorder owes a round, and the cost is one question in one hour on a failed write); persist's return is ignored after the cap's ask opens (pre-existing shape at the cost cap); the count resets at the ask's open (drift above, section 3 keeps it by declared assumption); a cap-paused child of a cap-paused plan cannot be eligible in the same repair pass, so both go pending and the next tick's activateNext seats one (inferred from isActivationEligible reading the parent's pre-repair status); an expired ask clears a BLOCKED lead, ruled consistent with the acceptance's lift by answer or expiry, since the next nudge names the expired question; the per-tick persist under an ask hold, the silent lift on a swept record and the unbounded worker ASK question (pre-existing); ring eviction of ask_timeout drops the expired sentence (the README states it); the nudgeCapPaused fixture keeps its name, since it is a legacy cap-paused entry. Author re-read of the close-pass delta in place of a round: it renames test identifiers and labels and corrects two plan sentences, prose only.
Stamps: adjudicated 21, stamped 1 (no-open-ask-survives-an-owner-start, the ground for leaving legacy paused-on-ask entries unrepaired); the 20 operator-tier hits are other sessions' reads on this machine's shared tier and none bore on this section.
Gate: targeted lane (SCOTT-CLAUDE, 2026-09-25 02:24, worktree D:/agent_persona-nudge, the close-pass renames and plan edits uncommitted on top of 6c7c654): tsc --noEmit exit 0; node .kit/controller-tick-test.mjs exit 0, 3451 OK, 0 failures, against the baseline 3372 OK on the same lane at 184a892 (then 3423 at e483493, 3447 at 3d7a758, 3450 at 0e4b1db, 3451 at 6c7c654); injection-duplicate-test exit 0; a fresh injection ledger byte-matches the committed one. Test delta: 7 added (caseHold_holdOfReadsTheAskThenTheLead pins every hold reason both ways; caseHold_theCapAskLiftsOnExpiryAndOnAnswer pins the cap's ask, both lifts and the throwing write; caseHold_theCostCapAskLeavesTheEntryActiveAndTheRefusalHoldsPastIt pins the cost cap's once-per-window ask and the refusal past it; caseHold_theWorkerAskLineLeavesTheEntryActiveAndAnExpiryIsNamedOnce pins the worker ASK: line and the one-time expiry naming; caseHold_theLoadRepairsCapPausedEntries and caseHold_theLoadRepairSkipsAnEntryUnderAClosedPlan pin the load repair; caseHold_anExpiredQuestionsBracketAfterATerminatorIsQuoted pins the expired sentence's quoting), 0 retired, and the rewritten cases listed above, each edited because it pinned a paused write this section removes. Spawning tests added: 0. Wall clock 79 s against no recorded baseline on this lane. Contention: 14 node.exe processes on the box at the start, not attributed (the relay, sidecar and other sessions' daemons run as node).
Next: 3. The status line, the count and the fixed ask
Commit Model: Branch-and-PR
Delta: SCOTT-CLAUDE, 2026-09-25 02:24
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 1 - 2026-09-25
- Section 3: fix round 1 committed as e585131 (3520 OK, 0 failures); round 2 review is one adversarial lens at opus, high, through Workflow, running. Adjudication records sit in the gitignored scratch path .kit/scratch/nudge-state/ under the main checkout.
- Live dispatches: the round 2 reviewer only; the section 3 implementer is idle and resumable for a further fix round.
- Gate baseline: 3520 OK, 0 failures, tsc exit 0, duplicate test exit 0 (SCOTT-CLAUDE, 2026-09-25, worktree clean at e585131).
- Rulings since the last boundary: section 3 round 1 took the nudged-turn-id fix over moving the turn-kind reset; the empty-answer assumption is reversed; "Task" as a dispatch tool name refused on .claude/types/claude-code.d.ts:40-45.
- Held, not armed: docs/plans/agent_persona_backstop-turn-guard_spec_v1.md, sent by the coordinator on 2026-09-25 with the operator's dispatch authorization relayed; it waits on PR #96 merging (the plan is not on main) and on this plan completing, since its fix sits in the same turn.complete block section 3 reshaped. It runs next after this plan, ahead of boundary-compaction.
- Next: adjudicate section 3 round 2, close section 3, then sections 4 and 5, then finishing-work.

### Chapter 3 - 2026-09-25
Completed: 3. The status line, the count and the fixed ask
Implemented By: implementer-opus (first green, fix rounds 1 and 2); main session for fix rounds 3 to 8
Metrics: review rounds 8, closed consult-ruled; provenance 9 spec-traceable, 3 fix-introduced, 2 new-requirement, rulings (1 refused, 0 declared, 0 asked); advisory: 3 findings, 1 fixed, 0 deferred, 2 left; NEEDS_CONTEXT 0; escalations 0; consults 1
Decisions / Surprises:
- section 3 open: adds the WORKING: status line beside WAITING: and BLOCKED:, renames the nudge count to nudgedAnswersWithoutStatus and makes it count nudged turns that wrote no status line and did no work, moves its resets to the Approach's list, drops the scorer's on-goal reset, and replaces the cap's bookkeeping ask text with a named literal carrying a ledger entry; serves the Goal, the Approach paragraph "The status line and the count" and section 3's acceptance; adds no mechanism the Approach does not name (a second work predicate and one literal); size about 6 controller sites, one predicate, one literal, a ledger entry and about 8 cases; not building it leaves the cap firing on a working worker.
- round 1 fix (nudged turn id, adversarial and blind Major, spec-traceable to the Approach's definition of a nudged turn): the count reads a nudged answer from the completion whose id equals the id recorded at the nudged turn's start, since a background subagent's completion spent the old currentTurnKind reading; adds no mechanism (the id the definition names); about 8 lines plus one case; not building it freezes the count on every nudged turn a background agent finishes inside.
- round 1 then round 2 (empty answer): round 1 excluded an empty nudged answer on README prose; round 2 reversed it on the Approach's words "counts nudged turns whose closing text opened with none of the three". An empty answer counts as unlined; aborted, errored and refused turns move nothing. One reversal, no second.
- round 2 fix (activation inside a nudged turn, traced to the Approach's reset on every activate call): an activation during the nudged turn makes its answer reset the count rather than add one, through a flag set in activate(), goal_create and goal_resume; about 5 lines plus one case.
- round 2 fix (hold sentence, traced to the lead rule that a lead holds on a plan entry): NUDGE_LEAD_HOLD_TEXT is its own ledger literal spliced into the nudge only on a plan entry, since the classifier's verdict picks the nudge text (hooks/index.ts near 6314).
- round 3 fix (tests and comments): the hold-sentence pins read the literal from source, since a reword left the task-entry leg asserting the absence of a retired wording; goal_resume inside a nudged turn gained a case (watched red); the ask-close case asserts the record's status; stale comments restated.
- round 4 fix (persona switch, adversarial Major, new-requirement traced to the cap's ask naming the persona): agentic_identity loads another persona's tree with an active entry and performs no activation, so the count carried across personas and the cap could name the wrong one. The load now resets the count and sets the flag. My round 3 commit had called goal_create's flag unobservable; that was wrong, and this path is why. Two lines, cases watched red both ways.
- round 5 fix (reader promotion, adversarial Major, new-requirement): the heartbeat promotion loads the stored tree afresh and carried the count held before the yield. It now resets there. A second case pins the load's own reset line through a switch in an unaccounted turn, which the nudged-turn case could not.
- round 6 fix (fix-introduced by round 5): the heartbeat runs with a turn open, so a nudged turn spanning a yield and a promotion added one to the new tree's count; the promotion sets the flag too. Case watched red with the flag alone removed.
- round 7 fix (class review): the flag is renamed countResetSinceNudgeOpened and cleared where a nudged reading opens rather than at every turn.start; session.start drops the count, since it fires again on a plugin reload while the module's session state lives on. Both cases watched red. I took this over the reviewer's structural option (spend nudgedTurnId at each reset event), which would have moved nudgedTurnId out of register for the same effect.
- round 8 Major refused on a consult ruling: it held that nudgeCountWorkThisTurn and currentTurnIsChannelOrigin, zeroed at every turn.start, lose a nudged turn's work call when another turn starts beside it. The consultant (fable, high) found from the live logs that no turn.start lands inside an open persona turn: across 7 persona logs, 212 engine turn starts, 0 nested, and plugin turn.start counts equal engine starts in every log (DEV-PERSONA 22 starts, 0 nested, re-counted by the main session). The overlap that exists is a subagent's turn.complete, carrying turn.complete only. Keying the tally to the nudged turn's id was refused because tool.call carries no turn id (claude-code.d.ts ToolCallInput near 6164, 6183-6187) and a turn.step-keyed tally would read a working turn as unlined when its step never arrives, the founding defect. Two cases pin that a foreign completion neither erases a nudged turn's work call (watched red with a post-block clear on a non-nudged completion) nor stops a channel-origin turn's reset (that one pins the outcome; no single line turns it red). The Operator Verification item on turn ids gained the reading that would reverse this.
- Drift from the plan, recorded deliberately: the Approach closes the reset list at five events. The count also resets on a new tree from goal_create, the root's completion, a persona's state loading at agentic_identity, a reader's promotion and every session.start. Each keeps a count from reaching the cap on a tree or persona that did not earn it, and README's reset list names all of them. The fixed ask's reset stays at its open, per section 2's drift.
- The persisted NudgeBudget.consecutiveNudgesWithoutOnGoal (hooks/agent-state.ts, .kit/tick-harness.mjs) has no reader; it goes to section 5 beside the backlog lines. Also for section 5's backlog pass: wasNudged and currentTurnKind are still consumed by whichever completion arrives first, so the scorer's nudge-aware labels and the reply backfill can read a subagent's completion as the nudged turn (pre-existing, the turn.complete block the held backstop-turn-guard plan touches); and the openTurns comment's "two turns can be open at once" is not what the map ever holds, its reason being the foreign completion.
Assumptions:
- assumed 2026-09-25 (source: section 2's Chapter drift): the fixed ask's reset stays at the ask's open, equivalent for nudging since holdOf holds every nudge while it is open; reversal: move it to the close sites.
- assumed 2026-09-25 (default, implementer): the Approach's "every activate call" keeps the resets at the plan switch, goal_resume, goal_create and root completion; the goal_done turn-end reset and the Chapter-rise reset are removed; reversal: one line each.
- assumed 2026-09-25 (source: the Approach's "clears a waiting lead"): WORKING: clears a waiting lead only; a blocked lead stays until a work turn or an ask close clears it.
- assumed 2026-09-25 (source: consult ruling on live logs): the harness opens no turn.start while a persona turn is open and runs the own turn.complete hook before the next turn starts (the second half rests on one tight sample), so per-turn tallies zeroed at turn.start belong to the completing persona turn; reversal: key the work tally to turn.step's tool calls for nudgedTurnId, keeping any main-loop work call seen at tool.call.
- assumed 2026-09-25 (inferred, Operator Verification): a background subagent's completion carries a turn id other than the parent turn's (docs/backlog.md 285-292; the harness type states only that a completion carries its own turn.start's id).
Review Findings: review: adversarial + blind at fable, Agent tool (round 1); review: performance + security at fable, Agent tool (round 1); review: adversarial at opus, Workflow high (rounds 2 to 8, one lens at the writer's tier). Round 1: subagent completion spending the nudged reading (Major both lenses) and the empty answer (blind Major), both fixed; "Task" as a dispatch tool name refused on claude-code.d.ts 40-45. Round 2: inferred turn-id premise marked and carried by Operator Verification; the false "close finds it above zero" sentence restated; empty answer reversed. Round 3: 1 Major (hold-sentence pin) and 8 Minors, 6 fixed, 2 routed to section 5. Round 4: persona-switch Major fixed, 3 Minors fixed. Round 5: promotion Major and the unpinned reset-line Major fixed. Round 6: mid-turn promotion Major fixed, 1 Minor fixed. Round 7: session.start Major and flag-lifetime Major fixed, the drift Major recorded above, 2 Minors fixed. Round 8: flag fix confirmed; the per-turn tally Major refused on the consult; the flag comment Minor fixed; the activation-between-queue-and-open Minor ruled by design (the answer resets only where the act lands while the nudged turn is open). Minors left with reason: readStatusLine splits the whole text (per turn, sub-millisecond); the count reaching 3 while another ask is open opens the cap ask after that ask closes (needs a third unlined answer that itself carries an ASK: line); the goal_done pointer repair near 8358 moves activeGoalId with no reset only from a desynced state enforceInvariants repairs on every load. Advisory: security m1 (README journal example) fixed; security m2 (dead persisted field) and performance m1/m2 left as above. Fix-introduced: 3 (round 5's missing flag at promotion, round 3's wrong unobservability claim, round 7's flag comment).
Stamps: adjudicated 19, stamped 1 (prompt-submit-always-waits-for-idle-so-it-cannot-reach-a-running-turn, which grounds the non-overlap ruling); 18 operator-tier hits are other sessions' reads on this machine's shared tier and none bore on this section.
Gate: targeted lane (SCOTT-CLAUDE, 2026-09-25, worktree D:/agent_persona-nudge, the round 8 tests and comment on top of 4e19698): tsc --noEmit exit 0; node .kit/controller-tick-test.mjs exit 0, 3553 OK, 0 failures, against the section baseline 3451 OK at c5c45f4 (then 3515 at d10f53a, 3520 at e585131, 3530 at 9d195ba, 3536 at d52e5b2, 3539 at 292afeb, 3543 at e7d7303, 3545 at bdc20b8, 3549 at 4e19698); injection-duplicate-test exit 0; a fresh injection ledger byte-matches the committed one. Test delta: cases added for the three status lines both ways, each reset, the unaccounted turn, the cap's fixed ask, the subagent completion, goal_resume, the persona switch (nudged and unaccounted turns), reader promotion (between turns and mid-turn), an overlapping turn, a second session.start and the foreign completion (work and channel); each fix case watched red against its own mutation with the source restored byte-identical by cmp. 0 retired. Spawning tests added: 0. Contention: 14 node.exe processes on the box at the fix-round runs, not attributed (the relay, sidecar and other sessions' daemons run as node).
Next: 4. The shadow question and its outcome
Commit Model: Branch-and-PR

### Chapter 4 - 2026-09-25
Completed: 4. The shadow question and its outcome
Implemented By: implementer-sonnet (first green and fix round 1); main session for the round 2 close pass
Metrics: review rounds 2, closed claim-exit; provenance 5 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 4 open: adds WORK_CONTINUES ("work-continues", primitive noul) to the question catalog and PLAN_HEALTH_SET_IDS, so the one plan-health request carries four questions; adds the continued_unprompted outcome kind, written once per call at the next completed turn's next_speaker site or the nudge_sent site, whichever fires first; serves the Goal sentence "one shadow question ... is journaled with an outcome so it can be scored before it is trusted" and section 4's acceptance; adds no mechanism the Approach does not name (one question, one outcome kind, one held stamp per call); size about 100 controller lines, one catalog entry, one outcome kind and 7 cases; not building it leaves the operator's question about the closing text unmeasured.
- round 1 fixes (adversarial and blind, all spec-traceable to the Approach paragraph "The shadow question" and acceptance bullet 1): the nudge site captures and clears the held call before its parking prompt.submit and writes false only on an accepted submit, restoring the record on a failed one, so a nudged turn completing while the submit is parked cannot have its own fresh call settled false; the nudge site settles only the call held for the nudged entry; the nudge site honours the plan-health mode gate; the README carries the promotion bar beside the question row; the decision-journal comment on the outcome kinds stops contradicting itself.
- Drift from the plan, recorded deliberately: the true rule is narrower than the Approach's first wording. true is written only where the next completed turn opened unaccounted and not from a channel message; a channel, delivery, proposal or plugin-prompt turn writes false. The Approach's own clause "with nobody else acting first" is the ground, since each of those origins is somebody or something else acting first. Round 2's adversarial Major named the gap between the code and the old wording; the Approach sentence and acceptance bullet 1 are rewritten to the shipped rule in this Chapter's changeset.
- Refused in round 1: that a hung or rejected request writes no outcome. The case the acceptance bullet cites asserts that lead_blocked lands on a hung call (.kit/controller-tick-test.mjs near 20929), so an outcome on an unanswered call is the established precedent and the new outcome follows it; the turn's end is still not delayed. Also refused: deriving the ask list from PLAN_HEALTH_SET_IDS (a refactor outside the section) and scoping the stamp by persona (next_speaker shares the shape; not this section).
- Known limits, stated in README: a keyboard turn reads unaccounted and so counts as true; a background subagent's completion can act as the next completed turn (pre-existing in the turn.complete block, routed to the backstop-turn-guard plan per Chapter 3).
- Operator run order, decided 2026-09-25 on the relay thread: after this plan, docs/plans/agent_persona_boundary-compaction_spec_v1.md runs second and docs/plans/agent_persona_backstop-turn-guard_spec_v1.md third. The operator accepts the extra thread posts a while longer so the goal and nudge fixes land before the fleetwide reset. This supersedes Interim board 1's "runs next after this plan, ahead of boundary-compaction". The operator asked for a message once this plan and boundary-compaction have both merged, so the fleet can be rebooted.
- The session was restarted by an operator reboot between fix round 1 (committed and pushed as 7942a77) and review round 2; the resumed session picked up from the scratch adjudication record with nothing lost.
Assumptions:
- assumed 2026-09-25 (source: the Approach's "with nobody else acting first", section 4): a channel, delivery, proposal or plugin-prompt next turn is somebody else acting first and writes false; reversal: one condition at the next_speaker site.
Review Findings: review: adversarial + blind at opus, Workflow high (round 1, one tier above the sonnet writer); review: adversarial at sonnet, Workflow high (round 2, decayed to the writer's tier). Round 1: 5 Majors across both lenses (the parked-submit settle, entry scoping at the nudge site, the true rule, the mode gate, the README bar and the contradictory journal comment), each spec-traceable, the blind lens's traced by the orchestrator, all fixed in 7942a77. Round 2: no Critical; 1 Major, a claim finding traced to acceptance bullet 1 (the plan's wording against the shipped true rule), dispositioned by rewriting the plan's Approach sentence and the bullet, prose only; approved with concerns. Minors: 1 fixed in the close pass (seven test comments and headers in this section's cases narrated fix history, restated in the present tense; a sweep of the section's delta for fix-round labels matched 10 lines before and 0 after), 0 upgraded, 1 left with the reason: a turn that completes while a failed nudge submit is still awaiting its rejection finds the held call cleared and settles nothing, and the call is restored to await a later turn, which drops one scoring sample and writes nothing wrong. Author re-read of the close-pass delta in place of a round: comment and header text and two plan sentences, prose only.
Stamps: adjudicated 4, stamped 0; the project record the-false-completion-defect-and-how-the-plan-closes-it and three operator-tier records were read inside the window by other work and none shaped this section.
Gate: targeted lane (SCOTT-CLAUDE, 2026-09-25 06:12, worktree D:/agent_persona-nudge, the close-pass comments and plan edits uncommitted on top of 7942a77): tsc --noEmit exit 0; node .kit/controller-tick-test.mjs exit 0, 3574 OK, 0 failures, against the section baseline 3553 OK at 30bba5c; question-catalog-unit-test exit 0, 149 OK (147 at 30bba5c); decision-journal-unit-test exit 0, 138 OK (137); injection-duplicate-test exit 0; a fresh injection ledger byte-matches the committed one. Test delta: 7 cases added or renamed in controller-tick-test (casePlanHealth_oneCallAndFourAnswersPerPlanEntryTurn, renamed from the three-answer case, pins one request carrying four questions and four journaled answers; casePlanHealth_continuedUnpromptedTrueUnnudgedFalseNudged pins true on an un-nudged next turn and false where a nudge went first; ...SettlesTheCallItWasArmedForAcrossAParkedSubmit pins that a nudge settles the call it was armed for; ...FalseOnChannelAndDeliveryNextTurns pins the narrower true rule; ...NudgeForAnotherEntryLeavesTheHeldCallUnwritten pins entry scoping; ...AtMostOnceAcrossFurtherTurns pins one write per call; ...RestoresOnAFailedSubmitThenSettlesTrue pins the failed-submit restore); casePlanHealth_decisionsAreInvariantAcrossEveryJevExtreme and casePlanHealth_hungRequestCannotDelayTheTurnEnd edited to four questions; the question-catalog set-count and plan-health list pins moved to four; the decision-journal closed-set pin gained continued_unprompted. 0 retired. Spawning tests added: 0. Wall clock 94 s for the whole lane, no baseline recorded on this lane. Contention: a process poll before the run matched no foreign test runner or build.
Next: 5. The documents
Commit Model: Branch-and-PR
Delta: SCOTT-CLAUDE, 2026-09-25 06:13
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```


### Chapter 5 - 2026-09-25
Completed: 5. The documents
Implemented By: main session (Locus: inline)
Metrics: review rounds 1, closed claim-exit; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked)
Decisions / Surprises:
- README.md gains the Open turn bullet under Nudge discipline, a cost-cap row stating the ask leaves the entry active and nudges stay refused until the window rolls, and one sentence after the classifier paragraph: a `pause` or `ask-operator` verdict is converted to a nudge with `ask_idle_gap_converted` logged (hooks/index.ts:6154), so neither pauses an entry or opens an ask. The README named both labels and never said what they do.
- docs/architecture.md gains the hold paragraph (holdOf, what the controller writes on an entry and never writes, the status lines, the fixed ask, the turn-id log lines, the shadow question), and its error_streak row stops saying the streak pauses an entry.
- docs/backlog.md: the nudge-cap entry (2026-09-23), the README nudge-counter entry (2026-09-21) and the extra-turn-completions entry (parked 2026-09-13) moved byte-for-byte to docs/archive/backlog-2026-Q3.md, each with a retirement note. The ask-close entry (2026-09-22) is narrowed to its persist-ordering half, since reactivateAskedEntry (hooks/index.ts:2412) clears a leftover reason on an active entry and the load repair drops pausedByNudgeCap (hooks/agent-state.ts:709). Chapter 3's three routed items landed: two new entries (the unread persisted NudgeBudget count, the openTurns comment's first reason) and wasNudged added to the existing turn.complete scoring entry.
- The extra-turn-completions entry's open question, whether a subagent's completion carries its own turn id, lives on in this plan's Operator Verification and goes into the operator-checks backlog entry at the archive.
- docs/README.md's row for this plan states what shipped. docs/plans/README.md does not exist in this repository.
- Drift from the plan, recorded deliberately: acceptance bullet 1's third clause read "or reads `turn.start` alone". That predates the architect's ruling of 2026-09-25, which made turn.start the only opener. The clause now forbids saying the reading opens on prompt.submit or tool.call, which is the ruling's concern.
- A coordinator priority change arrived during the review: docs/plans/agent_persona_planner-catch_spec_v1.md runs ahead of this plan's finishing pass. This plan resumes at finishing-work once that one is Complete and archived.
Review Findings: review: adversarial at sonnet, Workflow high (round 1, the writer's tier). 1 Major (claim): acceptance bullet 1's third clause contradicted the ruling, fixed by the rewording above. Every document sentence in the delta was confirmed against the code, and the three archived entries were confirmed byte-identical. A prose-only fix delta owes no further round.
Stamps: adjudicated 0, stamped 0.
Gate: targeted lane (SCOTT-CLAUDE, 2026-09-25, worktree D:/agent_persona-nudge, the section 5 edits uncommitted on top of 3bb940c, no code change): /d/agent_persona/node_modules/.bin/tsc --noEmit -p . exit 0; node .kit/controller-tick-test.mjs exit 0, 3574 OK, equal to section 4's close; question-catalog-unit-test, decision-journal-unit-test and injection-duplicate-test exit 0. A first tsc run through npx resolved a different package in this worktree and did not compile; it was re-run with the main checkout's compiler. Test delta: 0 added, 0 retired.
Next: finishing-work (after the planner-catch plan)
Commit Model: Branch-and-PR
