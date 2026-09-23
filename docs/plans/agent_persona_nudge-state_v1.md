# Nudge state split from goal state

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-23

## Goal

When this is done, the controller keeps its own record of whether to nudge, and the goal tree keeps
only the states the worker and the operator mean. The controller never writes `paused` on a goal
entry. Its idle branch reads one hold, computed from an open ask and the worker's own WAITING or
BLOCKED line, and the nudge cap, the hourly nudge budget and the error streak each hold by opening
an ask rather than by writing a status. A nudge asks the worker for a status line from a
closed set, the count that trips the cap counts nudged answers that carried none, and the third
such answer opens one fixed question to the operator and pauses nothing. The controller's reading
of whether a turn is open takes every event that proves one, so a nudge is never queued into live
work. And one shadow question, whether work should continue on its own after the worker's closing
text, is journaled with an outcome so it can be scored before it is trusted. It matters because on
2026-09-23 the dev-persona persona's goal-levels entry was paused mid-section by a cap that counts
nudges the scorer never judged, the tick handed its slot to the next plan, and the same persona's
live log shows 67 turn starts against 106 completions, so the controller believed no turn was open
for four turns in ten.

## Dispatch Authorization

This plan starts only after two other plans have merged to the trunk, because they edit the same
regions. `docs/plans/agent_persona_goal-levels_v1.md` edits the tick's no-active-leaf branch and
the goal tools. `docs/plans/agent_persona_nudge-cap_v1.md` edits the cap branch, the scoring skip
branches, the `goal_add` and `goal_done` holds and `hasStartableWork`, and this plan retires the
hold half of that change and keeps its reset. The trunk is `origin/main`, read after a fetch. The
check: `git ls-tree --name-only origin/main docs/plans/` lists neither file, and each is on the
trunk under `docs/archive/` or `docs/plans/archive/` with `Status: Complete` in its header. A
worker that finds either still listed stops with a `BLOCKED:` lead naming it. The work runs on one
branch cut from that fetched trunk and lands as one pull request for the whole plan. Execution
waits on the coordinator handing this plan to a worker by name.

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

**Rulings.** None made after the spec shipped.

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
and the exported cap-held helper in `hooks/agent-state.ts` that the nudge-cap plan's Section 1
adds, found by its reader sites since that plan names no symbol for it, together with the third
`[GOAL QUEUE]` close text that plan adds for a cap-held tree: that text, its ledger entry and the
branch in `hooks/index.ts` that chooses it are deleted, and the two earlier close texts stay. `hasStartableWork` returns to reading statuses
alone. The load-time repair at the E11 site (`hooks/agent-state.ts:720`) takes every entry with status
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

**The open-turn reading.** `openTurns` (`hooks/index.ts:2251-2252`) is opened by `turn.start`
today. It is also opened by `prompt.submit` and by `tool.call`, under the event's turn id where
the event carries one and under one synthetic key otherwise. A `turn.complete` closes the id it
carries where it carries one, and always closes the synthetic key, so a synthetic entry lives
only until the next completion of any turn. An implementer who finds an event carrying a shape
this rule does not fit stops with a `BLOCKED:` lead naming the event and the field. Both `turn.start` and `turn.complete` write `e.turnId` through the plugin's own log line rather
than the decision ring, which `DECISIONS_MAX` caps at 200 and a per-completion record would
crowd; that is the cheap first step the backlog entry of 2026-09-13 asks for. The idle
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
`6436-6438`, `6463`. Line numbers are the trunk's at `a923263` and move once the two plans ahead
merge, so the worker finds each site by the symbol named beside it.

## Sections of Work

### 1. The open-turn reading takes every event that proves a live turn
Model: opus

The change under "The open-turn reading". Opus because the event shapes are read from the
plugin's own handlers and the harness's delivery is uneven, so the synthetic-key rule has to be
checked against what each event carries rather than assumed.

Acceptance:
- A tick between a `tool.call` and its `turn.complete`, with no `turn.start` delivered, sends no
  nudge and logs `nudge_skipped_turn_in_flight`; the same tick after the `turn.complete` sends
  one.
- A `prompt.submit` with no `turn.start` opens the reading the same way, and a `turn.complete`
  carrying no id closes the synthetic key.
- The plugin's log carries the turn id at both turn start and turn completion, no new decision
  is written per turn, and the existing open-turn cases pass unchanged.

Files in scope: `hooks/index.ts` (the `openTurns` map and the four event handlers),
`.kit/controller-tick-test.mjs`.
Tests: lock that a live turn known only from a tool call blocks the nudge, since the dev-persona
log shows four turns in ten open without a start event, and lock that the reading closes, since a
key that never closes silences nudges for the life of the session.

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
`.kit/injection-ledger.json` and `.kit/injection-ledger.mjs` (the third `[GOAL QUEUE]` close
text is deleted with its entry, and the block at `8202-8207` keeps the two earlier texts),
`README.md` (the "Cap" bullet at 151, 628-632).
Tests: lock both directions of every hold reason, since a hold that never lifts is the frozen
tree of 2026-09-23 and one that never holds is a nudge into an open ask. Lock the load repair
against a store with two cap-paused entries and no active one, the dev-persona shape.

### 3. The status line, the count and the fixed ask
Model: opus

The change under "The status line and the count". Opus because the count's reset sites span the
scorer, the turn-end lead read, the tool-call handler, the channel-origin read and `activate`,
and each has an exact sibling in the nudge-cap plan's reset.

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
active entry, is removed here. `docs/README.md` gains this plan's row.

Acceptance:
- No sentence in either document says the controller pauses an entry on its own reading of a
  count or of the worker's text, escalates the cap to an ask-operator verdict, or reads
  `turn.start` alone.
- The two backlog edits are made and the retired entry sits in the quarter archive.

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

