# Plan health from the record

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-20

## Goal

When this is done, a queue entry that carries a plan document is judged from the record. The persona plugin reads done and progress from the plan document, and it reads blocked and waiting from the first line of the worker's own closing text. No plan entry is stopped by a count of turns, and a turn the operator or the coordinator persona started costs a worker nothing. The persona's store then holds the state the worker itself would report, which is what the coordinator persona reads when it judges a worker. Three Jev questions about plan health are asked in shadow and journaled, and nothing acts on them. It matters because on 2026-09-20 both workers' in-flight plans read blocked while both workers were working normally, and the controller had stopped nudging them.

## Dispatch Authorization

The operator asked for this plan on 2026-09-20 on the architect persona's Discord thread.

> Yeah, this actually sounds like quite a defect, the measure that the Steward and Supervisor are using to measure health is quite disjoint from the measure the session itself has. I'd love your thoughts on how to address this gap.

He approved the sketch, its Assumptions and its place in the running order the same day with "Yes, they're great. Please proceed." That approval covers authoring. Execution waits on the operator handing this plan to a worker by name.

This plan starts only after `docs/plans/agent_persona_decision-seam_v1.md` has merged to the trunk, because Section 5 extends that plan's code. The check is that `hooks/decision-seam.ts`, `hooks/question-catalog.ts` and `hooks/decision-journal.ts` exist on the trunk. A worker that reaches Section 5 and finds them absent stops with a `BLOCKED:` lead naming that. It never takes them from an unmerged branch.

## Intent

**The frame.** The operator's words: the health measure the coordinator and the supervisor use "is quite disjoint from the measure the session itself has". Both workers had just told him they were "proceeding fine" while their queue files said blocked. The Steward in his words is the coordinator persona.

**What happened.** The plugin gives each queue entry ten rounds. A round is one finished turn that a classifier labels on-goal, drift or complete. At ten the entry is marked blocked with the reason `Max rounds reached` and the next entry is activated. A plan takes far more than ten turns, so every plan hits it. For the `dev` persona the tenth round was spent by the operator's own check-in, which the classifier labelled drift. With no active entry the controller sends no nudge, so a worker that goes quiet in the middle of a plan is not woken.

**What done needs to do.** Make the plan document and the worker's own words the record, and have the plugin read them. Free any entry a round count has already stopped.

**What done does not need to do.** No Jev answer changes any decision, state field or nudge in this plan. The worker gains no new tool or duty for reporting progress, because the document it already keeps is the report. Entries that carry no plan document keep their round budget. The supervisor's own checks are not touched: they read three decision actions and never the round counter.

**Alternatives refused.**
- Raising the round limit to its ceiling of 50: the same wrong measure with more room. It is the stopgap the coordinator persona applies by hand until this lands.
- A progress-report tool for the worker: a second record beside the document, which would drift from it.
- Replacing the turn scorer's classifier with Jev on the same question: a cheaper wrong measure.
- Acting on the three new Jev answers now: a probability on a health reading looks like a fact, and nothing has measured these questions yet.
- Advancing to the next entry when a worker says it is blocked: the worker's tree is mid-plan, and both workers already refuse such a start in writing.

**Rulings after the spec shipped.**

- 2026-09-21, the operator: no section is added for the false-completion defect, and Section 4 gains one acceptance bullet instead. The defect is that `hooks/index.ts:5261` runs `completeLeaf` on whichever entry was active when a turn began, whenever the turn-end classifier returns `complete`. That entry is not the one the turn concerned. Sections 3 and 4 as written already close it for every entry that has a plan, a sub-task under a plan node included, because such an entry is a plan entry by the Approach's own ancestor rule. What the plan left unpinned is that rule's reach at the scorer: Section 2 states it outright for the round budget and Section 4 does not state it for scoring, so an implementer reading Section 4 alone could key on `kind` and reinstate the defect for sub-tasks. The added bullet closes that.

**Provenance.** Distilled from the architect persona's design conversation with the operator on 2026-09-20, and from both workers' stores and decision logs read that day.

## Approach

**The parts named here.** The controller is the plugin's idle tick, which nudges a quiet worker. The scorer is the plugin's turn-end classifier call. The coordinator persona is the fleet's coordinating session, which reads workers' stores. The supervisor is `bin/supervise.sh`, which launches and restarts a persona's session. Jev is the TypeSafe classifier service the decision seam calls.

**Three fields on a queue entry.** `planPath` is the plan document's path relative to the persona's working directory, in the form `docs/plans/<name>.md`. `lead` is null or `{ state, reason, at }`, where `state` is `blocked` or `waiting`. `chapterCount` is the number of Chapters the document held at the last read. All three are stored on the entry, so they survive a restart.

**What a plan entry is.** An entry's plan is its own `planPath`, or else the `planPath` of its nearest ancestor that has one. A plan entry, everywhere in this document, is an entry that has a plan by that rule. So a task a worker adds under its plan node is a plan entry too, judged against its parent's document. An entry with no plan is called a task entry here, whatever its `kind`.

**Where `planPath` comes from.** `goal_add` takes it as an optional parameter on an entry of kind `plan` only, and refuses it on any other kind. It is refused unless it matches `^docs/plans/[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.md$`. An entry of kind `plan` loaded without one gets it filled once, from the first capture of `(?<![A-Za-z0-9._/-])(docs/plans/[A-Za-z0-9][A-Za-z0-9._-]{0,250}?\.md)(?![A-Za-z0-9_-]|\.[A-Za-z0-9]|/)` in its `title` and then its `objective`. Live entries write the path followed by a comma or a full stop, which that expression leaves outside the capture. Both edges are guarded, so a path sitting inside a longer token is not matched: a leading `../` or a URL prefix on the left, and a further extension such as `.md.bak` or a longer path such as `.md/notes` on the right. The coordinator persona's standing instruction tells it to pass `planPath` when it queues a plan.

**Reading the document.** At the end of each turn, for the entry that was active when the turn started, when it is a plan entry, the plugin reads `<workdir>/<planPath>` with a 256 KiB cap. The plan is complete when the first line opening with `Status:` above the first `##` heading has the value `Complete`, trimmed, as the whole value, ignoring case. A line with markup around the key, such as `**Status:**`, is not that line. The plan is also complete when no file exists at `planPath` and a file of the same name exists at `docs/archive/<name>`, `docs/archive/plans/<name>` or `docs/plans/archive/<name>`, whatever that file's status says. The set of places read is closed at those four. Completion completes the entry that holds the `planPath` itself and runs the same steps the scorer's `complete` label runs today: `completeLeaf`, `runHealth`, a `complete` decision, `activateNext` and `activate`. A file that cannot be read, is over the cap, or is found in none of the four places changes nothing that turn and logs one `plan_record_unreadable` decision per entry per session. A document with no `Status:` line is simply not complete. The Chapter count is the number of `### Chapter N` headings under `## Chapters`. A count higher than `chapterCount` stores the new count, resets `consecutiveNudgesWithoutOnGoal`, and logs a `plan_progress` decision.

**No round budget on a plan entry.** Its `completedRounds` is never incremented, at the scorer or in the `goal_done` handler. The `Max rounds reached` block never applies to it. Its `maxRounds` is left as it is and is never read. The round text changes at all four sites that write it: the two worker-facing ones, the prompt text and the status line, omit it, and the controller's idle summary and its skip-hash subset say `plan entry, no round budget` in its place. An entry of kind `plan` that gains a `planPath` at load, and whose status is `blocked` with `blockedReason` exactly `Max rounds reached`, returns to `pending` with the reason cleared, so the controller's ordinary activation picks it up in queue order.

**The worker's lead.** The kit has a worker open its closing text with `BLOCKED:` and a reason when it cannot continue without someone else, and with `WAITING:` when background work will wake it. For a plan entry, the plugin reads the first non-blank line of a turn's closing text. A line opening with the literal uppercase `BLOCKED:` sets `lead` to blocked with the rest of that line as the reason, cut at 300 characters. One opening with `WAITING:` sets it to waiting. Any other first line clears `lead` when the turn made at least one work tool call, which is the count `toolCallsThisTurn` already holds through `isWorkTool`, so a reply to the operator clears nothing. This applies at the end of every turn on the entry, whatever opened the turn. The entry's `status` does not change, the nudge counter is not touched, and the controller does not activate another entry.

While `lead` is blocked the controller skips its whole idle branch for that entry: no classifier call and no nudge. While it is waiting the controller does the same until 60 minutes after `lead.at`, and then runs the idle branch as usual. With no lead set, the idle branch runs as it does today with one change for a plan entry: a classifier outcome of `complete` completes nothing and is logged as `complete_ignored`, because done is read from the document. The classifier's question and labels are not changed. The `ASK:` line is handled exactly as it is today.

**Which turns are scored.** A turn that opened from a channel message, or from a delivered record, is never scored, for any entry. The plugin knows both facts as `currentTurnIsChannelOrigin` and a `currentTurnKind` of `delivery`, but it resets both before the scorer runs, so Section 4 captures them beside `wasNudged`, before the resets. An unaccounted turn is one the plugin did not open and that carried no channel message. For a plan entry, only a turn the controller opened with a nudge is scored. The label array passed to the classifier is unchanged. For a plan entry, `on-goal` and `complete` both reset the nudge counter, `complete` completes nothing, and no label spends a round. The three-nudge stall pause works as it does today.

**Jev in shadow.** The decision seam handles the `choice` primitive only, in its types, its validation and its answer parsing, and its journal closes the outcome kinds at two. A Choice returns one option of a fixed set with a probability for each. A Noul returns the probability that a stated condition holds. A Score returns a position on ordered levels the question itself describes, with a probability for each level. Section 5 widens the seam and the catalog to `noul` and `score`. It adds three question sets, asks them in one request at the end of every turn on a plan entry, and journals each answer with an outcome the plugin can observe later. No value from them reaches a branch.

**The sweep.** Searches run on trunk `fd8f4cb` and re-read on `c22d0fc`: `interface GoalNode`; `maxRounds|completedRounds|Max rounds reached`; the four scorer labels; `consecutiveNudgesWithoutOnGoal|pausedByNudgeCap|wasNudged`; `currentTurnKind|currentTurnIsChannelOrigin`; `ASK:|BLOCKED:|WAITING:`; `goal_add|goal_create`; the same names over `bin/`, `docs/` and `README.md`. Surfaces found: `hooks/agent-state.ts` (the `GoalNode` interface and the v2 to v3 migration); `hooks/index.ts` (the `goal_add` schema and handler, the two `completedRounds` increments, the block, the round text at four sites, the scorer, the nudge cap, the turn-origin tracking, the `ASK:` parse, the idle branch and its no-active-leaf case); `.kit/tick-harness.mjs` `makeGoalNode`; `.kit/controller-tick-test.mjs`; `.kit/injection-ledger.json` and `.kit/injection-ledger.mjs`, which pin the size and shape of every injected string, with their totals stated at `docs/architecture.md:121`; `bin/supervise.sh` (the coordinator instruction); `README.md`; `docs/architecture.md`. Nothing under `bin/` reads the round counter, confirmed by a search that matched one comment there and 38 lines under `hooks/`. No `BLOCKED:` or `WAITING:` parse exists today. On `origin/decision-seam-build`: `hooks/decision-seam.ts`, `hooks/question-catalog.ts`, `hooks/decision-journal.ts` and their three unit tests.

## Standing Brief Amendments

- A plan entry is one that has a plan by the Approach's ancestor rule, never one whose `kind` is `plan`. Every rule this plan states for a plan entry reaches a task entry under a plan node, at the scorer and the idle branch exactly as at the round budget.
- Section 2's reader re-tests a stored `planPath` against the same pattern `goal_add` enforces, before it joins that value onto the working directory. A value that fails the re-test returns `unreadable` and logs one `plan_record_unreadable` decision per entry per session, exactly as a file absent from all four places does. The store is a producer the `goal_add` validation never sees, so a value read back out of it is untrusted at the join.

## Sections of Work

### 1. The plan path on a queue entry
Model: sonnet

Add `planPath`, `lead` and `chapterCount` to `GoalNode`, optional, with the migration leaving them unset. Add the `planPath` parameter to the `goal_add` schema and handler with the kind rule and the pattern check. Add one helper that returns an entry's plan under the Approach's rule. On store load, fill `planPath` by the text match for any entry of kind `plan` that lacks it, and return a round-limit-blocked entry that gains one to `pending`. Add `planPath` to `makeGoalNode` as an optional argument. The `goal_add` description is an injected string, so the injection ledger is regenerated with it.

Acceptance:
- `goal_add` with kind `plan` and `planPath: "docs/plans/a_v1.md"` stores it.
- `goal_add` with `planPath` of `../x.md`, `docs/plans/sub/x.md`, `C:\x.md`, `docs/plans/x.txt` or `Docs/plans/x.md` is refused with a message naming the required form, and adds no entry. So is a valid `planPath` on kind `task`.
- An entry of kind `plan` loaded with `objective` starting `Finish docs/plans/a_v1.md, which` gains `planPath` `docs/plans/a_v1.md`. So does one whose text ends `docs/plans/a_v1.md.` with a full stop. One naming no plan gains none, and an entry of kind `task` whose text names a plan gains none.
- The helper returns the parent's `planPath` for a task under a plan node, and none for an entry with no such ancestor.
- A loaded entry of kind `plan` with status `blocked`, reason `Max rounds reached` and a filled `planPath` is `pending` with no `blockedReason` after load. The same entry with no plan in its text stays blocked.
- Every existing case in `.kit/controller-tick-test.mjs` passes unchanged, and `.kit/injection-duplicate-test.mjs` passes against the regenerated ledger.

Files in scope: `hooks/agent-state.ts`, `hooks/index.ts` (the `goal_add` schema and handler and the store load path only), `.kit/tick-harness.mjs`, `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.json`, `.kit/injection-ledger.mjs`.
Tests: lock the pattern refusal, because `planPath` becomes a read path in Section 2. Lock the recovery in both directions, since an entry wrongly freed would run a task past its budget.

### 2. Done and progress from the document
Model: opus

Build `hooks/plan-record.ts`: a pure parser taking a document's text and returning `{ complete, chapters }`, and a reader taking the host's file functions, the working directory and a `planPath` and returning that result, `archived`, or `unreadable`. Call the reader at turn end for the turn-start entry when it is a plan entry, and apply the Approach's completion and progress rules. Remove the round budget from plan entries at both increment sites and the block, and change the round text at the four sites as the Approach states.

Acceptance:
- A document whose header reads `Status: Complete`, or `status:   complete  `, completes the entry holding the `planPath` at that turn's end, runs `runHealth` and activates the next entry, with a `complete` decision whose detail names the document as the cause.
- `Status: Complete (archived)`, `Status: Completed`, `Status: In Progress`, `**Status:** Complete`, and a `Status: Complete` line that sits below the first `##` heading under a header reading `Status: In Progress`, do not complete it.
- A `planPath` file that is absent, with the same name present in any one of the three archive places, completes it, including when that archived file reads `Status: In Progress`. Absent in all four places changes nothing and logs one `plan_record_unreadable` decision per entry per session.
- A Chapter count rising from 2 to 3 resets the nudge counter and logs `plan_progress`. An unchanged count logs nothing.
- A plan entry scored 25 times is never blocked, and its `completedRounds` stays 0. A `goal_done` call on a plan entry also leaves it 0. A task under a plan node is treated the same way. A task entry still blocks at its budget with today's reason.
- A worker prompt and the status line for a plan entry contain no `round` text. The idle summary for one reads `plan entry, no round budget`. For a task entry all four are unchanged.
- `.kit/injection-duplicate-test.mjs` passes against the regenerated ledger.

Files in scope: `hooks/plan-record.ts` (new), `.kit/plan-record-unit-test.mjs` (new), `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.json`, `.kit/injection-ledger.mjs`.
Tests: lock the `Complete` rule against its near misses, since a wrong completion activates the next plan while the tree is mid-work. Lock the round budget in both directions: gone for a plan entry, intact for a task entry.

### 3. The worker's BLOCKED and WAITING leads
Model: opus

Read the lead at turn end as the Approach states, beside the existing `ASK:` parse. Skip the idle branch in the controller tick while a lead holds, under the two rules, and ignore a classifier `complete` on a plan entry. Log `lead_set`, `lead_cleared` and `complete_ignored` decisions, the first two once per change. Add one sentence to the worker-facing instruction text beside the `ASK:` teaching: the controller reads a first-line `BLOCKED:` or `WAITING:` and holds its nudges. Regenerate the injection ledger for it.

Acceptance:
- A closing text whose first non-blank line is `BLOCKED: waiting on the operator's fork` sets `lead` blocked with that reason. The idle tick after it makes no classifier call and sends no nudge, the entry stays `active`, the nudge counter is unchanged, and no other entry is activated.
- `Blocked: x`, `BLOCKED x`, the same word at the start of a later line, and the word inside a sentence each set nothing.
- `WAITING:` holds the idle branch for 60 minutes of fake clock and no longer.
- A later turn with a work tool call and no lead clears it, and the next idle tick nudges. A later channel-origin turn whose only tool call is the reply tool does not clear it.
- A lead set before a simulated restart is still set after the store reloads.
- A turn carrying both a `BLOCKED:` first line and a valid `ASK:` line opens the ask as today and sets the lead.
- With no lead set, a classifier outcome of `complete` on a plan entry leaves the entry active and logs `complete_ignored`. On a task entry it completes the entry as today.
- A task entry's closing text sets no lead.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.json`, `.kit/injection-ledger.mjs`.
Tests: lock the hold in both directions, since a hold that never lifts is the defect this plan removes wearing a new name. Lock the first-line rule, because a worker quoting the word in prose must not silence its own nudges. Lock that a reply to the operator does not clear a blocked lead.

### 4. Which turns are scored
Model: sonnet

Capture `currentTurnIsChannelOrigin` and whether `currentTurnKind` is `delivery` beside `wasNudged`, before the resets. At the scorer, skip with a `score_skipped` decision when either captured fact is true. For a plan entry, skip as well when the turn was not opened by a nudge. For a plan entry on a nudged turn, keep the label array and apply the Approach's reading of the labels.

Acceptance:
- A channel-origin turn and a delivery turn each log `score_skipped` and leave `scores`, `completedRounds` and the nudge counter untouched, for a plan entry and for a task entry.
- A nudged turn on a plan entry labelled `on-goal` or `complete` resets the nudge counter, and the entry is not completed by the label.
- Three nudged turns labelled `drift` on a plan entry trip the existing stall pause.
- An unaccounted turn on a task entry is scored exactly as today. An unaccounted turn on a plan entry is not scored.
- A task under a plan node is treated exactly as its parent plan entry is, at every rule this section states: its unaccounted turns are not scored, and a nudged turn labelled `complete` does not complete it. An entry with no plan ancestor is the only one that keeps today's scoring.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`.
Tests: lock that an operator check-in spends nothing, which is the incident. Lock that the stall pause still trips, since it is the one health signal this plan keeps.

### 5. Three shadow questions
Model: opus

Rebase onto the trunk first, and check the precondition the Dispatch Authorization states. Read the TypeSafe API page and the three primitive pages before writing the request builder, since they are the source for each primitive's request and answer shape. Widen `ResolvedQuestion`, the resolver's validation, the seam's request builder and its answer parsing to the `noul` and `score` primitives beside `choice`. Widen the journal's closed set of outcome kinds by three. Add three shipped question sets:
- `worker-blocked`, a Noul: is this worker saying it cannot continue without someone else. State: the closing text.
- `rounds-converging`, a Score with three levels written as concrete situations: each turn closes more than it opens; the turns hold steady; the turns reopen what earlier turns settled. State: the last five closing texts for the entry, each cut at 1,000 characters.
- `block-owner`, a Choice among `operator`, `coordinator`, `another-plan`, `self-resolving` and `none`. State: the closing text.

Ask all three in one request at the end of every turn on a plan entry, not awaited. Journal each answer under a stamp id from the journal's `newStampId`. Outcomes: `lead_blocked` records whether that same turn carried a `BLOCKED:` lead; `chapter_within` records whether the Chapter count rose within the next five turns on that entry; `next_speaker` records whether the next turn was channel-origin, a delivery, or neither. The closing texts and the stamp ids awaiting an outcome are held in session memory only. A restart, or the entry completing, drops them, and the outcomes they awaited are never written, which the journal's readers already tolerate.

Acceptance:
- Every existing case in `.kit/controller-tick-test.mjs` and the three seam unit suites passes unchanged with Jev faked to fail, to hang, and to answer at each extreme: a Noul of 0 and of 1, a Score at its lowest and highest level, and each Choice option.
- `state.decisions` and every `GoalNode` field are identical between a run with the three questions on and one with `jevMode` off.
- New cases show one `call` line and three `answer` lines per plan-entry turn, the three primitives recorded by name, and each outcome kind landing once against the right stamp id.
- An entry that completes two turns after a question writes no `chapter_within` outcome for it and throws nothing.
- A task-entry turn asks none of the three.
- An override of `rounds-converging` with two levels or five is refused and falls back, by the catalog's existing rule extended to Score levels.

Files in scope: `hooks/decision-seam.ts`, `hooks/question-catalog.ts`, `hooks/decision-journal.ts`, their three unit tests under `.kit/`, `hooks/index.ts`, `.kit/controller-tick-test.mjs`.
Tests: lock decision invariance against a Jev that answers at each extreme, because a leak from shadow into a decision is the failure the decision seam plan exists to prevent. Lock that a hung request cannot delay a turn's end.
References: `https://docs.typesafe.ai/api.md`, `https://docs.typesafe.ai/primitives/noul.md`, `https://docs.typesafe.ai/primitives/score.md`, `https://docs.typesafe.ai/primitives/choice.md`, `https://docs.typesafe.ai/confidence.md`.

### 6. The documents and the coordinator's instruction
Model: sonnet

`README.md` states the queue entry's three new fields, the `goal_add` parameter, what a plan entry is, how one is judged, which turns are scored, the two leads, and that a plan entry has no round budget. Its passages on rounds, at `README.md:127` and `README.md:566` on `c22d0fc`, are scoped to task entries. `docs/architecture.md` names the plan document as the record the controller reads, lists `hooks/plan-record.ts`, and restates the injection ledger's totals at `:121` as the regenerated ledger gives them. The coordinator instruction in `bin/supervise.sh` gains one sentence: pass `planPath` when queuing a plan, and read an entry's `lead` and its plan document when judging a worker, never `completedRounds`. The ledger is regenerated for that sentence. The README's decision seam section lists the three shadow questions and their outcome kinds.

Acceptance:
- `README.md` names `planPath`, `lead` and `chapterCount` and states the plan-entry rule.
- A case-insensitive search of `README.md` and `docs/architecture.md` for `round` is read hit by hit. Every hit about the round budget or the scorer's rounds says it applies to task entries, and the Chapter lists each hit with its line. The same search at the base commit is run first and returns the two README passages named above, which shows the pattern reaches them.
- The totals at `docs/architecture.md:121` equal the regenerated ledger's, and `.kit/injection-duplicate-test.mjs` passes.

Files in scope: `README.md`, `docs/architecture.md`, `bin/supervise.sh` (the coordinator instruction text only), `.kit/injection-ledger.json`, `.kit/injection-ledger.mjs`, and any `.kit/` test that pins the coordinator instruction's text.

## Related

- `docs/plans/agent_persona_decision-seam_v1.md`: supplies the Jev client, the question catalog and the journal Section 5 extends. This plan starts after it merges.
- `discord-channels` repository, `docs/plans/channels_board-worker-queues_spec_v1.md`: the Discord board card over worker queues. It prefers `planPath` when present and reads a blocked `lead` as blocked. Neither plan waits on the other.
- `docs/plans/agent_persona_supervisor-gaps_v1.md` and `docs/plans/agent_persona_supervisor-peer_v1.md`: both change `bin/supervise.sh`. This plan touches only the coordinator instruction text there, so whichever lands second rebases over a text edit.

## Out of Scope

- The supervisor's decision logic, the keeper, and `fleet_status`.
- The idle classifier's question and labels, the plan switch and the memory gate. What the controller does with a `complete` outcome on a plan entry is in Section 3.
- The `ASK:` path and the ask record.
- Acting on any Jev answer, and any threshold over one.
- `docs/archive/agentic-plugin_goal-tree_v1.md`, which restates the old field list and is history.
- Reading a plan document from a branch that is not checked out in the working directory.
- A lead on a task entry.
- `docs/README.md`, which changes only at this plan's own close-out.

## Assumptions

- assumed 2026-09-20 (source: the kit's wait rule, merged to claude-kit trunk on 2026-09-20, and its `BLOCKED:` lead): a worker opens a stopped turn's closing text with `BLOCKED:` or `WAITING:`. The `worker-blocked` question measures how often it says so another way; reversal: widen the first-line rule in Section 3.
- assumed 2026-09-20 (default): a waiting hold lifts after 60 minutes, so a wake that never comes cannot silence the controller for good; reversal: one constant.
- assumed 2026-09-20 (default): a `complete` label from the scorer or the idle classifier on a plan entry completes nothing, which keeps both label arrays and the decision seam's pin on their option ids unchanged; reversal: a third label variant and a catalog change.
- assumed 2026-09-20 (source: `goal_add`'s default kind of `task` and its demotion of a plan node when a task is added under it): a task under a plan node is judged as a plan entry against its parent's document; reversal: the helper in Section 1.
- assumed 2026-09-20 (source: both workers' pause reasons, which name branch checkouts inside their working directories): the checked-out copy of the active entry's plan document is the live one; reversal: a git read, which the plugin does not do today.
- assumed 2026-09-20 (source: `hooks/index.ts` channel-reply backfill): the operator already sees a worker's `BLOCKED:` text on the worker's own channel, so a lead opens no ask of its own; reversal: route a blocked lead through the ask path.
- assumed 2026-09-20 (source: this repository's `docs/plans/archive/`, which holds two archived plans): a completed plan can sit in any of three archive places; reversal: one entry in the closed list.

## Operator Verification

- After this merges and the fleet relaunches on it, message a worker mid-plan several times and confirm on the board or in its store that the entry stays active and never reads blocked. The work reopens if any plan entry shows `Max rounds reached` again.
- After a week, read the journal's three new question sets against their outcomes. That reading decides whether a later plan may act on any of them.

## Open Questions

None.

## Chapters

### Interim board 1 - 2026-09-21

In-flight sections: Section 1 only. It is at its fix round over review round 1's findings. No section has closed, so this entry carries no `Completed:` line.

Live dispatches: one implementer at sonnet, given the five fixes below and an explicit do-not-fix list of six held Minors, so the fix delta stays reviewable. The round 1 review of three lenses has returned and is adjudicated.

Gate baseline: the controller tick suite reads 1410 assertions and 0 failures on this tree, and 1378 with 0 failures at the base commit `8df99af`, measured by cutting a scratch worktree there and running the same suite. Both readings taken 2026-09-21T01:05Z on SCOTT-CLAUDE by this session, under this session's own heavy-process claim, uncontended, with the claim released after. The rest of the targeted lane is green at exit 0: `npx tsc --noEmit`, `node .kit/check-loader-rule.mjs`, `node .kit/injection-ledger.mjs`, `node .kit/injection-duplicate-test.mjs`.

Rulings adopted since the last boundary:

- The operator ruled on 2026-09-21 that no section is added for the false-completion defect and that Section 4 gains one acceptance bullet instead. Recorded in the `## Intent` record with its reasoning, and the Standing Brief Amendments block was created for the definition that ruling turns on.
- Review round 1 returned CHANGES_REQUIRED from the blind lens with one Critical, APPROVED_WITH_CONCERNS from the adversarial lens, and CLEAR from the security lens. One Critical and five Majors enter the fix round; eight Minors accumulate for the close pass; three findings are recorded and not fixed.
- No finding was held and no judge was convened. Every Major traces to the Goal sentence "No plan entry is stopped by a count of turns", to Section 1's own acceptance, or to the Standing Brief Amendment, so none reads as new-requirement and no design stop fired. Two Minors were upgraded on a stated consequence: a text pattern that fills a different document than the one named, and an unguarded field read that turns session start into a throw.
- The security lens's finding that the path pattern guards one producer rather than the channel is routed to Section 2, whose reader owns the join. It is named there rather than fixed here, since this section owns no reader.
- The security lens's finding that the project has no security model document is out of this plan's goal and is routed to `docs/backlog.md` at the section close.

The Critical, confirmed at the code rather than taken on report: `applyPlanRecordOnLoad` returns a round-budget-blocked entry to pending without testing its root, and `isActivationEligible` deliberately exempts the root from its status test, breaking out of its ancestor walk at the root before reading status. So a store load can resurrect work under a root already marked complete, which also defeats the planning cap. The blind lens's separate Major about a recovered node with children is the same defect from another angle: such a node is activatable by nothing, since `isActivationEligible` refuses a node with children, and the planner never runs either, since `isPlanningDue` returns false while any descendant is pending. One guard answers both.

Next action per section: read the fix round's report, verify it against the recorded baseline, then run review round 2. Round 1 returned a Critical, so round 2 runs round 1's full roster at its tier rather than a single lens. Sections 2 through 6 are unstarted. Section 5's precondition is met: pull request 57 merged at 2026-09-21T00:38Z as `622c19b`, and all three decision seam modules are confirmed present on `origin/main` by a direct read rather than inferred from the merge state.

Commit Model: Branch-and-PR

### Interim board 2 - 2026-09-21

In-flight sections: Section 1 only, at its second fix round. No section has closed, so this entry carries no `Completed:` line.

Live dispatches: one implementer at opus, given three fixes and an eight-item do-not-fix list. Review round 2 of three lenses has returned and is adjudicated, and the scope adjudicator has ruled.

Gate baseline: the controller tick suite reads 1436 assertions and 0 failures on this tree, up from 1410 before fix round 1 and 1378 at base commit `8df99af`. Read from the run's own exit code of 0. Measured 2026-09-21T01:41Z on SCOTT-CLAUDE by this session, uncontended. A foreign heavy-process claim (DEV-PLUGIN, repo `D:/personas/dev-plugin/repo`, written 2026-09-21T01:44Z) went live after that reading, so the fix round's own gate runs under the claim protocol rather than uncontended. The rest of the targeted lane is green at exit 0: `npx tsc --noEmit`, `node .kit/check-loader-rule.mjs`, `node .kit/injection-duplicate-test.mjs`.

Rulings adopted since the last boundary:

- Review round 2 returned CHANGES_REQUIRED from the adversarial and blind lenses and CONCERNS from the security lens. All three independently found one Critical, the blind lens among them, which never held the spec.
- The Critical: `applyPlanRecordOnLoad` frees a round-budget-blocked entry whose intermediate ancestor is blocked, and nothing can then activate it. `activateNext` filters each level on `pending` so it never descends past the blocked ancestor, `isActivationEligible` refuses on ancestor status, and `isPlanningDue` goes false once anything is pending. Confirmed at the code rather than taken on report. The change makes such a store strictly worse than before it: with nothing pending, the planner used to recover it.
- This is the same finding class as round 1's Critical, which was the same guard reading the root alone. Round 1 covered the root and the leaf; the span between them stayed uncovered. A repeating class means the tier is the lever, so the fix round is escalated from sonnet to opus with both rounds' evidence in the brief.
- A design stop fired on the Critical's fix, because clearing a blocked ancestor mutates a node no acceptance bullet names. The scope adjudicator ruled ACCEPT-AND-DECLARE: the plan parent's block exists only because its child was stopped at the round budget, so it is itself an entry a count of turns stopped, one hop removed, and the Goal sentence "No plan entry is stopped by a count of turns" already asks for it. The ruling's grounds were checked against the plan's own text on this side before adoption. The mechanism is one the bullets already asked for, so no acceptance bullet moved and the Standing Brief Amendments block is unchanged.
- The blind lens's Major, that the round budget stops binding across restarts, is recorded and not fixed. Section 2's acceptance removes the round budget from plan entries outright, so after that section there is no count to re-free. Both sections land in the same pull request under Branch-and-PR, so no window exists where one ships without the other.
- The security lens's Major, that a plan path is shape-checked but never existence-checked, is recorded and not fixed here. Section 2's acceptance already owns it: a path absent from all four places logs one `plan_record_unreadable` decision per entry per session.
- The three lenses' shared Minor, that the fill and the recovery share one pass and so depend on array order, is not reachable in production. Every write to a goals array across all six files under `hooks/` is an empty literal, a single-element reset or an append, and the four files beyond `agent-state.ts` and `index.ts` only read it. The invariant is unstated even so, and 27 fixtures in the tick suite build the array directly, so the two-pass split rides with this fix round rather than the close pass.

Next action per section: read the fix round's report, verify it against the 1436 baseline, then run review round 3. Round 2 returned a Critical, so round 3 runs the full roster again rather than a single lens. That will be the third round, and the operator backstop fires at the fifth. Sections 2 through 6 are unstarted.

Commit Model: Branch-and-PR

### Interim board 3 - 2026-09-21

In-flight sections: Section 1 only, at its third fix round. No section has closed, so this entry carries no `Completed:` line.

Live dispatches: one implementer at opus, given four fixes and a nine-item do-not-fix list. Review round 3 of three lenses has returned and is adjudicated.

Gate baseline: the controller tick suite reads 1473 assertions and 0 failures on this tree, up from 1436 before fix round 2, 1410 before fix round 1, and 1378 at base commit `8df99af`. Read from the run's own exit code of 0. Measured 2026-09-21T01:57Z on SCOTT-CLAUDE by this session, with no claim live on the box at the reading. `npx tsc --noEmit`, `node .kit/check-loader-rule.mjs` and `node .kit/injection-duplicate-test.mjs` each exit 0.

Rulings adopted since the last boundary:

- Review round 3 returned no Critical from any of the three lenses, which is the first round with none. The blind lens returned APPROVED_WITH_CONCERNS, the adversarial CHANGES_REQUIRED, the security CONCERNS. Three Majors enter fix round 3; the Minors accumulate for the close pass.
- The round overturns a fix adopted in round 1. Round 1's leaf guard refuses recovery for any node with children, on the stated ground that such a node can be activated by nothing. That ground is false and was adopted here without being checked. `isActivationEligible` does refuse a node with children, but `activateNext`'s DFS descends through a pending parent into its children, so a freed parent with pending children is reachable. `goal_add` with an explicit `parentId` checks the parent's existence and kind and never its status, so a blocked plan node can gain a pending child. All three confirmed by reading the code. The guard therefore refuses the one shape where freeing works, and the subtree is stranded in the same permanent idle this plan exists to remove. Fix round 3 replaces the leaf test with a reachability test and must make the result independent of the order of `state.goals`.
- The kind-rule refusal on `goal_add` names no required form, and fix round 2's test asserts the form token is absent. Section 1's acceptance bullet reads "is refused with a message naming the required form, and adds no entry. So is a valid planPath on kind `task`." Ruled here that the plain reading governs: "So is" carries the whole predicate. The message gains the form and the assertion flips.
- The text pattern's right-edge lookahead excludes neither a full stop nor a slash, so text naming `docs/plans/a_v1.md.bak` fills the path with `docs/plans/a_v1.md`, a different file, silently. Same class as the left-edge defect an earlier round closed. The repair was tested here across eight cases including both acceptance bullets before being handed over.
- The comment on `PLAN_PATH_PATTERN` calls it the path-joining guard and says a refused shape never reaches the join. That is untrue: the store is a second producer and is read verbatim with no re-test. The sentence is corrected. The validation itself stays routed to Section 2, as round 1 decided, because Section 2 owns the reader that performs the join.
- Two declared assumptions from fix round 2, both accepted: the ancestor clear does not reset `completedRounds`, because a plan parent's block is not a round-budget block and its counter is never read; and a missing parent mid-chain refuses the whole recovery, because an orphaned subtree is what the activation walk cannot reach. The second had no test, and fix round 3 adds one.
- The security lens's Major is advisory under the operator's standing instruction of 2026-09-20 that the security lens gives no recommendations and is acted on only where it finds a Critical. It found none. Its subject is the stored-value producer, already routed to Section 2. The false comment is fixed on the separate ground that nothing untrue ships.

Next action per section: read fix round 3's report, verify it against the 1473 baseline, then run review round 4. Round 3 returned no Critical, so round 4 is one lens at the writer tier rather than the full roster. That will be the fourth round; the operator backstop fires at the fifth. Sections 2 through 6 are unstarted.

Commit Model: Branch-and-PR

### Interim board 4 - 2026-09-21

In-flight sections: Section 1 only, at its fourth fix round. No section has closed, so this entry carries no `Completed:` line.

Live dispatches: one implementer at opus, given five fixes and an eight-item do-not-fix list. Review round 4 of one lens has returned and is adjudicated.

Review-round stage: four rounds have run. The operator backstop fires at the fifth adjudication that still leaves the terminal condition unmet.

Gate baseline: the controller tick suite reads 1504 assertions and 0 failures, exit 0, wall clock 38 seconds. Up from 1473 before fix round 3, 1436 before fix round 2, 1410 before fix round 1 and 1378 at base commit `8df99af`. Measured 2026-09-21T02:30Z on SCOTT-CLAUDE by this session, on the main checkout with the section's five files dirty. Read from the run's own exit code. `npx tsc --noEmit`, `node .kit/check-loader-rule.mjs`, `node .kit/injection-duplicate-test.mjs` and `node .kit/injection-ledger.mjs` each exit 0, and the ledger generator leaves `.kit/injection-ledger.json` byte-unchanged.

That reading was taken under a named contention. A foreign heavy-process claim (DEV-PLUGIN, repo `D:/personas/dev-plugin/repo`, written 02:11:23Z with `Expected-seconds: 600`) was still live 17 minutes on, and a bounded 15-minute wait for it timed out without the gate running. The box measured free at the reading: no test runner, build or msbuild process, and 19.6 GB free virtual memory. So the suite was run without writing a claim, per the protocol's wait-or-name-the-contention rule, and the foreign claim was left untouched. The 38-second wall clock is consistent with an uncontended box and is not comparable to figures recorded under the machine's earlier memory configuration.

Rulings adopted since the last boundary:

- Review round 4 returned no Critical, the second consecutive round with none. One lens ran, the adversarial reviewer at opus and effort `high` through the Workflow route, because round 3 returned no Critical and the fix delta touched code rather than a deliverable document. Verdict CHANGES_REQUIRED on two Majors.
- The first Major is a pointer left aimed at nothing. The `PLAN_PATH_PATTERN` comment states as present-tense fact that Section 2's reader re-tests a stored `planPath` at the join. Section 2's acceptance bullets carry no such requirement, confirmed here by reading them; the routing existed only in a Chapter. A Section 2 implementer reading that comment ships the join unguarded, which is a file read outside `docs/plans/`. Held to the behavior bar as a claim on a security boundary and on a published contract surface. Fixed in two places: the comment is restated as a requirement, and a Standing Brief Amendment now declares the re-test so every later sighted dispatch is built from it.
- The second Major is a missing cross-surface pin. `PLAN_PATH_TEXT_PATTERN`'s capture is a third writer of `planPath`, checked against `PLAN_PATH_PATTERN` by nothing. The two agree today, confirmed by the lens over ten prose forms, so the pin is preventive: without it a later relaxation of the text pattern writes a value `goal_add` would refuse straight into the store.
- One Minor is upgraded to Major on a stated consequence. The left-edge lookbehind omits the backslash, so `D:\other_repo\docs/plans/a_v1.md` still fills `planPath` with `docs/plans/a_v1.md`, a different file. That is the exact rewrite class the left-edge guard was added to close, on the separator this Windows host uses.
- Two further fixes ride the round: an empty or whitespace-only `planPath` is refused rather than silently treated as absent, and the shipped comments stop narrating the review rounds. The bare `F1`, `F2`, `F3(a)` and `F3(b)` tokens are unresolvable by any reader who does not hold this plan, and the before-this-fix framing is the journey the doctrine keeps out of shipped text.
- The Approach's stated fill regex is corrected to the shipped one. It still named the pre-fix expression, so the plan contradicted the code it describes. Recorded as approval drift: the Approach sits inside the approval-scoped region.
- Recorded and deliberately not fixed: the recovery writes no `decisions` entry and no `updatedAt` bump. Every lens has raised it in three consecutive rounds. Building it here adds a mechanism no Goal sentence, Intent clause or Section 1 acceptance bullet names, which would fire a design stop for a Minor. The decision-log surface belongs to Sections 3 and 4, which this plan already has. Carried to Section 3's open.
- Round 4 traced the recovery's guards against `activateNext`'s DFS, `isActivationEligible`, `isPlanningDue` and `enforceInvariants` and found them sound, and found no shape the change makes worse. The fix round 3 implementer's own inferred concern, that its child test is one level deep rather than transitive, is closed on that trace. No transitive form is built.

Record recovered this boundary: round 3's Minors and fix round 3's add-decision lines were never written to their scratch files at adjudication, and a compaction took the context holding them. All three round-3 lens reports were recovered from their transcripts on disk and written to `.kit/scratch/plan-health/`, seven open Minors and two already disposed. The lesson is the doctrine's own: a hold that lives only in context dies at the next compaction.

Next action per section: read fix round 4's report, verify it against the 1504 baseline, then run review round 5. Round 4 returned no Critical, so round 5 is one lens at the writer tier. Sections 2 through 6 are unstarted.

Commit Model: Branch-and-PR

### Interim board 5 - 2026-09-21

In-flight sections: Section 1 only, at the review-round backstop. No section has closed, so this entry carries no `Completed:` line.

Backstop stage: this is the opening bound. Section 1 has taken five review rounds and round 5's adjudication leaves the terminal condition unmet, so the run declares to the operator rather than opening the fix round that adjudication would owe. Round count as it stands: 5. The ladder has not restarted, and a continue past this bound buys three further rounds.

Live dispatches: none. The scope adjudicator dispatched on a design stop has ruled, and the expert ask sent to the repository's expert seat has been answered.

Gate baseline: the controller tick suite reads 1525 assertions and 0 failures on this tree, up from 1522 after fix round 4, 1504 before it, and 1378 at base commit `8df99af`. Read from the run's own exit code of 0. Measured 2026-09-21T02:58Z on SCOTT-CLAUDE by this session, under this session's own heavy-process claim, written after the box polled free and released at completion. `npx tsc --noEmit`, `node .kit/check-loader-rule.mjs`, `node .kit/injection-duplicate-test.mjs` and `node .kit/injection-ledger.mjs` each exit 0, and the ledger is byte-unchanged across the regen.

Owed and unrun, to be taken on the re-arm before anything else: the fix for round 5's Major 2 landed in this tree and its delta owes a review round under the fix-delta bar, because it reaches input handling, which is one of the surfaces the security lens's trigger names. This stop opens no round, so that round is owed and unrun. The fix is one character in the text pattern's left-edge lookbehind plus one refusal case and one one-character control.

Not run, and named rather than reported clean: the enumerated offline suite roster. A memory records that a targeted lane on this repository naturally reaches about seven of sixteen runnable suites and that `self-review-unit-test.mjs` is the one that bites, because `hooks/self-review.ts` is edited incidentally by work aimed at `hooks/index.ts`, which this section changes. The enumeration was prepared and not run: a foreign heavy-process claim (DEV-DISCORD, repo `sapplefeld-channels`, written 2026-09-21T03:00:14Z, 900 seconds expected) went live before the spawn. The claim protocol permits waiting or naming the contention, never writing a second claim over a live one. It is named here and is owed with the round above.

Rulings adopted since the last boundary:

- Review round 5 returned no Critical, the third consecutive round with none, from one adversarial lens at the writer tier. Two Majors and five Minors. Verdict CHANGES_REQUIRED.
- Major 2, confirmed here by probe against the literal read out of the source rather than retyped: the text pattern's left-edge lookbehind omitted `:`, so `Finish D:docs/plans/a_v1.md now` filled `planPath` with `docs/plans/a_v1.md`, a file in another tree, with no signal. That is a drive-relative Windows path. It traces to the Goal sentence "judged from the record" and its subject is input handling, which makes it a security finding of Major weight. Such a finding is never held and never parked, so it was fixed before this declaration. The lookbehind gained `:`, the comment was restated, and a refusal case plus a one-character control were added.
- A shape guard on the capture cannot stand in for that left edge. Every rewrite the lookbehind refuses yields a capture that is itself well formed, so re-testing it against `PLAN_PATH_PATTERN` passes it. Confirmed by probe. This corrects an over-generalisation in the expert seat's answer, which read both Majors as one defect.
- Major 1, confirmed here by probe: the cross-surface pin added in fix round 4 is blind to the relaxation its own comment names. Relax the text pattern's body class to admit `/` and both fill fixtures still capture a well-formed value and stay green, while `finish docs/plans/sub/x_v1.md now` writes a value `goal_add` refuses into the store. The pin asserts fixture outputs, never the relation between the two patterns.
- Major 1's repair adds a guard at the fill, which is a mechanism no acceptance bullet, Goal sentence or Intent clause names. That fired a design stop. The scope adjudicator ruled REFUSE on a form ground: the declared bullet puts the one re-test of a stored `planPath` at Section 2's reader, at the join, and Section 1's own fill bullets describe what the fill writes and name no shape refusal. A guard at the fill is therefore a second re-test at a site no bullet names. Its grounds were checked here against the plan's own text before adoption, and the check was that the proposed mechanism departs from the form those clauses ask for rather than that the clauses exist. The judge named the form the fix takes instead: a test that pins the relation between the two patterns, not a runtime branch. A refuse on a form ground closes no finding, so Major 1's fix is still owed and is owed in that form. This ruling stands as the pre-BLOCKED consult, having ruled on the mechanism the phase analysis names, so no second consult was dispatched.
- The expert seat answered the ask and named an existing source that resolves the design question's ground: the operating doctrine at line 114, "A sanitizing or clamping guard is a property of the output channel, not of the producer that first needed it. So the moment a channel gains a second producer the guard moves to the shared boundary as an exported helper." Quote verified against the file here. The load-time fill is the second producer on the `planPath` channel. That makes the guard a doctrine requirement rather than an invention, which is the ground carried into the adjudicator's brief.
- The five Minors accumulate for the close pass. Two are claim findings on comments that overstate what the code does, one is a refusal message that describes an illegal value as legal, and two are store shapes only a hand-edited store produces.

Next action per section: the backstop is declared to the operator with the phase analysis and the ruling in the body. On the answer, three things are taken before anything else: Major 1's owed fix in the form the judge named, a behavioural pin over the two patterns rather than a runtime branch; the review round the security fix's delta owes; and the enumerated offline suite roster. Sections 2 through 6 are unstarted.

Commit Model: Branch-and-PR
