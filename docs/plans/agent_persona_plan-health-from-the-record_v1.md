# Plan health from the record

Status: Ready
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

**Rulings after the spec shipped.** None at the write.

**Provenance.** Distilled from the architect persona's design conversation with the operator on 2026-09-20, and from both workers' stores and decision logs read that day.

## Approach

**The parts named here.** The controller is the plugin's idle tick, which nudges a quiet worker. The scorer is the plugin's turn-end classifier call. The coordinator persona is the fleet's coordinating session, which reads workers' stores. The supervisor is `bin/supervise.sh`, which launches and restarts a persona's session. Jev is the TypeSafe classifier service the decision seam calls.

**Three fields on a queue entry.** `planPath` is the plan document's path relative to the persona's working directory, in the form `docs/plans/<name>.md`. `lead` is null or `{ state, reason, at }`, where `state` is `blocked` or `waiting`. `chapterCount` is the number of Chapters the document held at the last read. All three are stored on the entry, so they survive a restart.

**What a plan entry is.** An entry's plan is its own `planPath`, or else the `planPath` of its nearest ancestor that has one. A plan entry, everywhere in this document, is an entry that has a plan by that rule. So a task a worker adds under its plan node is a plan entry too, judged against its parent's document. An entry with no plan is called a task entry here, whatever its `kind`.

**Where `planPath` comes from.** `goal_add` takes it as an optional parameter on an entry of kind `plan` only, and refuses it on any other kind. It is refused unless it matches `^docs/plans/[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.md$`. An entry of kind `plan` loaded without one gets it filled once, from the first capture of `(docs/plans/[A-Za-z0-9][A-Za-z0-9._-]{0,250}?\.md)(?![A-Za-z0-9_-])` in its `title` and then its `objective`. Live entries write the path followed by a comma or a full stop, which that expression leaves outside the capture. The coordinator persona's standing instruction tells it to pass `planPath` when it queues a plan.

**Reading the document.** At the end of each turn, for the entry that was active when the turn started, when it is a plan entry, the plugin reads `<workdir>/<planPath>` with a 256 KiB cap. The plan is complete when the first line opening with `Status:` above the first `##` heading has the value `Complete`, trimmed, as the whole value, ignoring case. A line with markup around the key, such as `**Status:**`, is not that line. The plan is also complete when no file exists at `planPath` and a file of the same name exists at `docs/archive/<name>`, `docs/archive/plans/<name>` or `docs/plans/archive/<name>`, whatever that file's status says. The set of places read is closed at those four. Completion completes the entry that holds the `planPath` itself and runs the same steps the scorer's `complete` label runs today: `completeLeaf`, `runHealth`, a `complete` decision, `activateNext` and `activate`. A file that cannot be read, is over the cap, or is found in none of the four places changes nothing that turn and logs one `plan_record_unreadable` decision per entry per session. A document with no `Status:` line is simply not complete. The Chapter count is the number of `### Chapter N` headings under `## Chapters`. A count higher than `chapterCount` stores the new count, resets `consecutiveNudgesWithoutOnGoal`, and logs a `plan_progress` decision.

**No round budget on a plan entry.** Its `completedRounds` is never incremented, at the scorer or in the `goal_done` handler. The `Max rounds reached` block never applies to it. Its `maxRounds` is left as it is and is never read. The round text changes at all four sites that write it: the two worker-facing ones, the prompt text and the status line, omit it, and the controller's idle summary and its skip-hash subset say `plan entry, no round budget` in its place. An entry of kind `plan` that gains a `planPath` at load, and whose status is `blocked` with `blockedReason` exactly `Max rounds reached`, returns to `pending` with the reason cleared, so the controller's ordinary activation picks it up in queue order.

**The worker's lead.** The kit has a worker open its closing text with `BLOCKED:` and a reason when it cannot continue without someone else, and with `WAITING:` when background work will wake it. For a plan entry, the plugin reads the first non-blank line of a turn's closing text. A line opening with the literal uppercase `BLOCKED:` sets `lead` to blocked with the rest of that line as the reason, cut at 300 characters. One opening with `WAITING:` sets it to waiting. Any other first line clears `lead` when the turn made at least one work tool call, which is the count `toolCallsThisTurn` already holds through `isWorkTool`, so a reply to the operator clears nothing. This applies at the end of every turn on the entry, whatever opened the turn. The entry's `status` does not change, the nudge counter is not touched, and the controller does not activate another entry.

While `lead` is blocked the controller skips its whole idle branch for that entry: no classifier call and no nudge. While it is waiting the controller does the same until 60 minutes after `lead.at`, and then runs the idle branch as usual. With no lead set, the idle branch runs as it does today with one change for a plan entry: a classifier outcome of `complete` completes nothing and is logged as `complete_ignored`, because done is read from the document. The classifier's question and labels are not changed. The `ASK:` line is handled exactly as it is today.

**Which turns are scored.** A turn that opened from a channel message, or from a delivered record, is never scored, for any entry. The plugin knows both facts as `currentTurnIsChannelOrigin` and a `currentTurnKind` of `delivery`, but it resets both before the scorer runs, so Section 4 captures them beside `wasNudged`, before the resets. An unaccounted turn is one the plugin did not open and that carried no channel message. For a plan entry, only a turn the controller opened with a nudge is scored. The label array passed to the classifier is unchanged. For a plan entry, `on-goal` and `complete` both reset the nudge counter, `complete` completes nothing, and no label spends a round. The three-nudge stall pause works as it does today.

**Jev in shadow.** The decision seam handles the `choice` primitive only, in its types, its validation and its answer parsing, and its journal closes the outcome kinds at two. A Choice returns one option of a fixed set with a probability for each. A Noul returns the probability that a stated condition holds. A Score returns a position on ordered levels the question itself describes, with a probability for each level. Section 5 widens the seam and the catalog to `noul` and `score`. It adds three question sets, asks them in one request at the end of every turn on a plan entry, and journals each answer with an outcome the plugin can observe later. No value from them reaches a branch.

**The sweep.** Searches run on trunk `fd8f4cb` and re-read on `c22d0fc`: `interface GoalNode`; `maxRounds|completedRounds|Max rounds reached`; the four scorer labels; `consecutiveNudgesWithoutOnGoal|pausedByNudgeCap|wasNudged`; `currentTurnKind|currentTurnIsChannelOrigin`; `ASK:|BLOCKED:|WAITING:`; `goal_add|goal_create`; the same names over `bin/`, `docs/` and `README.md`. Surfaces found: `hooks/agent-state.ts` (the `GoalNode` interface and the v2 to v3 migration); `hooks/index.ts` (the `goal_add` schema and handler, the two `completedRounds` increments, the block, the round text at four sites, the scorer, the nudge cap, the turn-origin tracking, the `ASK:` parse, the idle branch and its no-active-leaf case); `.kit/tick-harness.mjs` `makeGoalNode`; `.kit/controller-tick-test.mjs`; `.kit/injection-ledger.json` and `.kit/injection-ledger.mjs`, which pin the size and shape of every injected string, with their totals stated at `docs/architecture.md:121`; `bin/supervise.sh` (the coordinator instruction); `README.md`; `docs/architecture.md`. Nothing under `bin/` reads the round counter, confirmed by a search that matched one comment there and 38 lines under `hooks/`. No `BLOCKED:` or `WAITING:` parse exists today. On `origin/decision-seam-build`: `hooks/decision-seam.ts`, `hooks/question-catalog.ts`, `hooks/decision-journal.ts` and their three unit tests.

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
