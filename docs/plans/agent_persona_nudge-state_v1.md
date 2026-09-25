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
field stays on the entry as the worker's record. The switch, `goal_resume` and `goal_add`
demotions keep writing `paused`, because they are assignment of the active slot, which the tree
carries. The hourly cost-cap ask keeps its text. The classifier's controller labels keep their
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
reads it, was not a nudge and no nudge was sent for the entry between, and `false` where a nudge
was sent first,
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
keeps its two close texts), `README.md` (the "Cap" bullet at 151, 628-632).
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
  `continued_unprompted` outcome is `true` on an un-nudged next turn and `false` where a nudge was
  sent first, and is written at most once per call.
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
  count or of the worker's text, escalates the cap to an ask-operator verdict, or reads
  `turn.start` alone.
- The four backlog edits are made and the three retired entries sit in the quarter archive.

Files in scope: `README.md`, `docs/architecture.md`, `docs/backlog.md`,
`docs/archive/backlog-2026-Q3.md`, `docs/README.md`.

## Out of Scope

- The switch (`5371`), `goal_resume` (`7513`) and `goal_add` demotions to `paused`, the
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
