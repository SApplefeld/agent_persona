# Goal tree curation

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-21

## Goal

When this is done, a persona's goal tree changes only through a tool call that names what it changes. A turn that does work without a goal leaves the tree alone and leaves one line in the decision log. A worker can record any finished entry as finished, by name, where today it can only finish the active entry and must drop the rest as abandoned. `goal_create` refuses to replace an unfinished tree unless the call says to, and a replaced tree is kept in a history file. One refused tool registration no longer costs a session its persona claim, its stored tree and its heartbeat, and a session whose state never loaded says so where today it reports an empty tree. It matters because on 2026-09-21 every persona in the fleet reported its tree cleared, two personas lost live plans within minutes of adding them, and a worker retired a finished plan with the reason "NOT abandoned - this plan is finished".

## Dispatch Authorization

The operator asked for this plan on 2026-09-21 on the architect persona's Discord thread.

> I think we need to look at how the goal tree is managed in Personas. Every session came back up saying it's goal tree was cleared, or is having issues with items getting cleared off it, one session said it can't mark things completed, only abandoned. Can you take a look at how the goals are curated and managed and reset?

After the findings and a five-part sketch he wrote: "can you complete the plan for the goal improvements and open a PR for it so it can be ready to run?" That covers authoring. He did not pick among the three options put to him for untracked work, so the plan is written on the recommended one and `## Assumptions` records it. Merging this plan's pull request is his approval of that pick. Execution waits on the operator handing this plan to a worker by name.

This plan starts only after two other efforts have merged to the trunk, because they edit the same regions. `docs/plans/agent_persona_plan-health-from-the-record_v1.md` edits the `goal_done` handler and the end of `turn.complete`. `docs/plans/agent_persona_supervisor-gaps_v1.md` edits `bin/supervise.sh`. The check is that neither file is still in `docs/plans/` on the trunk. A worker that finds either still there stops with a `BLOCKED:` lead naming it. The emergency fix that cut the `fleet_status` description under the host's limit is also expected on the trunk, and Section 1 states what to do where it is not.

## Intent

The operator's frame is his message above: the tree gets cleared, entries get cleared off it, and finished work can only be abandoned. He asked how goals are "curated and managed and reset".

Done means four things. The tree is never replaced as a side effect of a turn. A finished entry can be recorded as finished whatever its status was. A deliberate reset keeps what it replaced. A session that could not load its tree says that, in words, to the worker that asks.

Done does not need any of the following, and the plan refuses them. It does not need a record in the tree for every small request: nothing reads that record, and the supervisor already treats it as not a completion. It does not need a tool that reads the history file back, since the file is a recovery copy an operator or a worker opens by hand. It does not need a new status value on an entry or on an operator ask. It does not need the planner, the scorer, the nudge loop or the round budget to change. It does not need the supervisor's restart rules to change beyond reading one new fact in the one place the old fact was read.

Alternatives refused:
- Append each after-the-fact record under the existing tree as a finished entry: refused, because it adds several entries an hour and that clutter is what buried the real history.
- One permanent "conversation" entry that small requests land under, which is the remedy `docs/backlog.md` recorded on 2026-09-16: refused, because it keeps a mechanism with no reader and costs more code than the log line.
- Remove the after-the-fact record entirely, log line included: refused, because the supervisor's clean-exit path needs to know a child did real work with no goal, or it counts a healthy exit against the restart budget.
- Move the persona claim ahead of every tool registration: refused in favor of catching each registration's refusal, which protects the same steps without moving four hundred lines of a seven-thousand-line file that three other plans are editing.
- Let `goal_done` close an entry that still has unfinished children: refused, because the parent would read complete over open work.

Rulings after the spec shipped: none at the write.

Provenance: distilled from the architect persona's session of 2026-09-21 on its Discord thread, from the code at trunk `622c19b`, the five personas' store files and their debug logs.

## Approach

**What was found.** Three separate defects produced the three reports. All line numbers are at trunk `622c19b`.

First, the cleared tree was a start-up crash and the stored trees were intact. `session.start` in `hooks/index.ts` registers fourteen tools one by one (2089-2448) and only then claims the persona and loads the store (2451-2569). Claude Code refuses a tool description over 4096 characters. The `fleet_status` description reached 4926, the refusal threw out of `session.start`, and everything after it was skipped. The session ran on the built-in default state, which is persona `default`, not owner, no goals (`hooks/index.ts:522-526`). `goal_status` answered "No goal tree exists." and every goal write was refused as "held by a live session", which was untrue. An emergency fix outside this plan cut the description. This plan removes the fragility behind it.

Second, entries vanished because of the after-the-fact goal record at `hooks/index.ts:5298-5351`. When a turn made tool calls and the root was absent, complete or abandoned, the plugin set `sess.state.goals` to a single synthetic finished root. `goal_add` accepts a node under a complete root, so plans added there were deleted by the next turn that fired it. It fires on task notifications and on messages from other sessions as well as on operator requests, and each firing writes two decision lines into a log capped at 200 (`DECISIONS_MAX`, `hooks/agent-state.ts:299`). The dev-discord persona's log shows plans added at 03:53Z and gone at 03:56Z, added again at 04:07Z and gone at 04:09Z. `docs/backlog.md` has carried this defect since 2026-09-16.

Third, `goal_done` (`hooks/index.ts:6207`) takes no entry id and completes only `activeGoalId`. The only tool that retires any other entry is `goal_edit` with `drop`, which marks it abandoned. The workaround is `goal_resume` then `goal_done`, which pauses whatever was really active.

A fourth, smaller one: `goal_create` (`hooks/index.ts:5930`) replaces the whole tree, unfinished work included, and keeps nothing.

**The design.** Four changes, one per section.

Registration failures are contained. Every `$.tool.register` call in `session.start` goes through one local helper that catches a throw, logs it, and records it, so the claim, the store load and the heartbeat always run. The refusal is written into the session's decisions once the state is loaded. A flag records that the persona's state has been loaded, by `session.start` or by `agentic_identity`. While the flag is unset, every goal tool answers with one sentence saying the persona's state was never loaded in this session, in place of the empty-tree answer and the held-by-a-live-session refusal.

Untracked work is a log line and nothing else. The block at 5298-5351 stops building a root. Under the same conditions it fires on today, it writes one decision with action `untracked_work`. Where the newest decision in the log is already `untracked_work`, it updates that line's timestamp and a count in its detail and pushes no new line, so a chatty hour costs one line. It writes no `create` and no `root_complete`. The supervisor's clean-exit path in `bin/supervise.sh` (3240-3259) reads the new fact through the existing `get_fact` helper and takes today's unaccounted relaunch on it. The readers of the old `backfilled` text in `bin/supervise.sh`, `bin/supervise-poll.mjs` and `bin/supervise-decide.mjs` stay, because stores written before this change still carry those lines until they roll off the log. The poll path needs no new reader: with no `root_complete` written, `bin/supervise-decide.mjs` already continues.

`goal_done` takes an optional `nodeId`. Without it the call behaves as it does today. With it, the call completes that entry where the entry is not the root, its status is active, pending, paused or blocked, and every child it has is complete or abandoned. Completing an entry that was not the active one leaves the active entry alone. An open operator ask on the completed entry closes the way `goal_resume` closes one, with the existing status value `resumed`, because the set of ask status values is closed at `open`, `answered`, `resumed` and `expired` and this plan does not widen it.

`goal_create` refuses to replace an unfinished tree. A tree is unfinished when its root exists and the root's status is neither complete nor abandoned. The call proceeds over an unfinished tree only with `replace: true`. Whenever a tree holding at least one entry besides the root is replaced, the whole replaced tree is appended as one JSON line to `.agentic-goal-history.jsonl` beside the store, through the existing `appendLines` helper (`hooks/index.ts:737`). `.gitignore` already covers `.agentic-*.jsonl`. `goal_add` under a root that is complete or abandoned sets the root back to pending and records `root_reopened`, so a tree never holds live work under a finished root.

**The coverage sweep.** One Explore sweep ran over `hooks/`, `bin/`, `.kit/`, `docs/`, `README.md`, `CLAUDE.md`, `.claude-plugin/` and `package.json`, with `docs/archive/` listed and not searched. The searches were: `backfill` in any case, `\[NO GOAL\]`, `noActiveRoot`, `rootCompleteBackfilled`, `get_root_complete`, `root_complete`, each of `goal_done`, `goal_edit`, `goal_resume` and `goal_create`, `mcp__agentic-plugin__goal_`, `[Rr]eplace(s)? any existing tree|replaces the whole tree|goal tree kept`, `await \$\.tool\.register\(\{`, `toolRegisters`, and `length limit|max.{0,10}char|character limit|size limit`. It returned these surfaces, each placed in a section below or under `## Out of Scope`:

- The record's writer and trigger: `hooks/index.ts:5298-5351`, the `isWorkTool` gate at 444-461, the `[NO GOAL]` reminder at 6932-6948, and the separate channel-reply backstop at 5278-5294.
- The supervisor's readers of the `backfilled` text: `bin/supervise.sh:2266-2303` and 3240-3259, `bin/supervise-poll.mjs:81-96,211`, `bin/supervise-decide.mjs:8-9,52-53,116-121`.
- Tests of the record: `.kit/controller-tick-test.mjs` cases `caseItem2_backfill*` (3524-3700), `.kit/supervisor-unit-test.mjs:214-274`, `.kit/supervisor-poll-unit-test.mjs:95-106`, `.kit/supervisor-natural-exit-test.sh` cases (a), (b), (e) and its source pins at 256 and 1197, which read the writer's detail text out of `hooks/index.ts`.
- `goal_done` surfaces: registration `hooks/index.ts:2171-2185`, handler 6206-6268, the prompt text that points at it (4880-4888, 6920-6921), `completeLeaf` in `hooks/agent-state.ts:611`, `.kit/controller-tick-test.mjs:12370-12397`, `docs/architecture.md:134`, `hooks/self-review.ts:58`.
- `goal_create` surfaces: handler 5893-5951, the `goal_edit` root refusal at 6135-6137, the paused reminder at 6929. No test asserts the replacement.
- Registration surfaces: the block at 2089-2448, the tool-count pins at `.kit/controller-tick-test.mjs:12520-12561` and 12621-12629, the parameter-named-in-description pin at 12650-12689, the harness's `register` shadow in `.kit/tick-harness.mjs`, the description ledger `.kit/injection-ledger.json` with its no-growth test `.kit/injection-duplicate-test.mjs`, the character totals in `docs/architecture.md:121-128`, and the arming text in `.claude-plugin/plugin.json`.
- Prose: `README.md:295-309` and 359-370, `docs/backlog.md:65-71`.
- Two other plans: `agent_persona_plan-health-from-the-record_v1.md` lines 54 and 94, and `agent_persona_supervisor-peer_v1.md` line 75.
- A generated file: `.claude/types/claude-code-mcp.d.ts`.

**Backlog covered.** This effort retires the `docs/backlog.md` entry "A harness task notification arriving as a prompt is backfilled as a completed root" (found 2026-09-16) whole. It retires half of "A backfilled root_complete relaunch has no rate bound, and a newer backfilled root can mask a real completion" (found 2026-09-13): the masking half ends because no new backfilled `root_complete` is written. The rate-bound half stays, reworded to name `untracked_work`.

**The tool description budget.** Two descriptions grow, `goal_done` and `goal_create`. Each stays under 600 characters. `.kit/injection-duplicate-test.mjs` fails on any growth past the committed baseline, so each of Sections 3 and 4 refreshes the baseline with `node .kit/injection-ledger.mjs > .kit/injection-ledger.json`, and updates the two totals `docs/architecture.md:121-128` states.

## Sections of Work

### 1. Start-up survives a refused tool registration
Model: opus

Every `$.tool.register` call inside `session.start` goes through one local helper. The helper awaits the registration inside a try block. On a throw it logs one `$.ui.log` line naming the tool and the host's text, and holds the tool name and the bounded error text for later. After the persona state is loaded, each held refusal becomes one decision with loop `monitor` and action `tool_register_refused`, the way `startPersonaProblem` is carried today (2571-2579). The arming gates around `goal_create` and `agentic_resolve` stay as they are.

A session field records that the persona's state has been loaded. It starts false. It is set true in two places: where `session.start` leaves its claim-or-join block (after 2569), and where the `agentic_identity` handler loads a persona's entry (5776-5813), since a session whose start failed recovers through that tool. While it is false, `goal_status`, `goal_create`, `goal_add`, `goal_edit`, `goal_done` and `goal_resume` each answer with one fixed sentence. The sentence says this session never loaded its persona's state because plugin start-up did not finish, that the stored goal tree is not shown and was not changed, and that the debug log's `session.start hook skipped` line names the cause. `goal_status` returns it as its result, and the five writers return it as their deny text. The sentence is one constant.

Where the trunk carries no test that fails on a tool description over 4000 characters, this section adds one under `.kit/`, reading `hooks/index.ts` through the ledger's `extractToolDescriptions`. Where the emergency fix already added one, this section leaves it alone.

Acceptance:
- A harness case makes `register` throw for `fleet_status` only. After `session.start`, the session owns its persona, its goals are the stored goals, both clock callbacks are registered, `agentic_resolve` is registered, and the decisions hold one `tool_register_refused` naming `fleet_status`.
- The control for that case registers all fourteen and records no `tool_register_refused`.
- A harness case that calls `goal_status` and `goal_done` on a session whose `session.start` never ran gets the fixed sentence from both, and the store file is byte-identical afterwards.
- `.kit/check-loader-rule.mjs` passes on the edited file.
- `README.md` states, beside its paragraph on the loader check, that one refused registration costs that tool alone, and names the decision it leaves.

Files in scope: `hooks/index.ts` (the `session.start` handler 2053-2600 and the six goal tool handlers' opening checks), `.kit/tick-harness.mjs`, `.kit/controller-tick-test.mjs`, `README.md`, and a new `.kit/tool-description-cap-test.mjs` only where the trunk lacks one.
Tests: lock both directions of the registration guard, since a helper that swallows the throw and also skips the later tools would pass a claim-only check. Lock that an unloaded session writes nothing, since the expensive failure is a default state persisted over a real store.

### 2. Untracked work leaves the tree alone
Model: opus

The block at `hooks/index.ts:5298-5351` keeps its condition exactly and changes what it does. It builds no root, assigns nothing to `sess.state.goals`, and leaves `activeGoalId` alone. It writes one decision with loop `goal`, action `untracked_work`, and a detail that carries the first 80 characters of the prompt and a count of 1. Where the last entry of `sess.state.decisions` already has action `untracked_work`, it updates that entry's timestamp, raises the count in its detail, replaces the prompt excerpt, and pushes nothing. The comment above the block is rewritten to state what the block does now.

`bin/supervise.sh`'s clean-exit path reads `untracked_work` through `get_fact` beside the `root_complete` read at 3240. A clean exit with an `untracked_work` newer than the child's start takes the same unaccounted relaunch the backfilled branch takes, with a NOTE line that names untracked work. The existing backfilled branch stays for stores that still carry the old lines. `bin/supervise-poll.mjs` and `bin/supervise-decide.mjs` are not edited.

Acceptance:
- The five `caseItem2_backfill*` cases in `.kit/controller-tick-test.mjs` are rewritten to the new behavior under names that say so. A turn with tool calls and no root leaves `state.goals` empty and leaves one `untracked_work` decision. A turn with tool calls over a complete root that has a live plan under it leaves every node in place. Three such turns in a row leave one `untracked_work` line whose count reads 3. The priming-turn and nudge-turn cases still write nothing.
- No code path in `hooks/index.ts` writes a `root_complete` decision whose detail carries the text `backfilled`.
- `.kit/supervisor-natural-exit-test.sh` gains a case where a child records `untracked_work` and exits 0, and asserts the unaccounted relaunch and its NOTE line. Its cases (a) and (e) keep passing against a fixed fixture line, since the writer they read their detail text from is gone. The pin at 256 is rewritten to assert the second acceptance bullet above.
- `.kit/supervisor-unit-test.mjs` and `.kit/supervisor-poll-unit-test.mjs` pass unedited.
- `README.md:295-309` and 359-370 describe the log line and the supervisor's read of it. `docs/backlog.md` loses the 2026-09-16 entry to `docs/archive/backlog-2026-Q3.md`, and its 2026-09-13 entry is reworded to the rate-bound half, naming `untracked_work`.

Files in scope: `hooks/index.ts` (5298-5351), `bin/supervise.sh` (the clean-exit path near 3240-3259), `.kit/controller-tick-test.mjs`, `.kit/supervisor-natural-exit-test.sh`, `README.md`, `docs/backlog.md`, `docs/archive/backlog-2026-Q3.md`.
Tests: lock that a live plan under a complete root survives a working turn, since that is the loss the operator reported. Lock the collapse, since an uncollapsed line per turn empties the decision log of everything else within hours.

### 3. goal_done completes an entry by name
Model: opus

`goal_done` gains an optional string parameter `nodeId`. Its description names the parameter and says in one sentence that finished work on an entry that is not active is recorded with `goal_done` and its `nodeId`, never with a drop. The `goal_edit` description's sentence on `drop` gains the matching half: a drop is for work that will not be done.

With `nodeId` absent, the handler behaves as it does on the trunk at the time of the run, the plan-health plan's changes included.

With `nodeId` present, the handler refuses, each with a reason that names the entry's status, when the id is not in the tree, when the entry is the root, when its status is complete or abandoned, and when any child of it has a status other than complete or abandoned. Otherwise it completes the entry through `completeLeaf` with the note, clears the entry's `blockedReason` and `pausedByNudgeCap`, runs the health command as today, and records the `done` decision naming the entry and that it was closed by name.

What follows depends on which entry it was. Where the entry was the active one, everything proceeds as the call without `nodeId` does. Where another entry is active, that entry stays active and nothing is activated. Where no entry is active, `activateNext` runs unless an operator ask is open on a different entry or some entry is held by the nudge cap, which are the two holds `goal_add` already honors (6087-6092). Round and score credit go only to an entry that was active when the call arrived. Where an operator ask is open on the completed entry, it is closed exactly as `goal_resume` closes one (6391-6404), with the decision detail saying `goal_done` closed it.

Acceptance:
- A paused plan completed by name reads complete, the entry that was active is still active, and no `paused_by_resume` decision exists.
- A pending task completed by name under a plan whose other children are complete takes the plan to complete through `completeLeaf`'s walk.
- Each of the four refusals returns its reason and changes no node.
- A call with no `nodeId` on a tree with an active leaf produces the same decisions, in the same order, as the trunk's handler does.
- Completing by name the entry an open ask points at clears `pendingAskId` and leaves the ask record `resumed`.
- The parameter-named-in-description pin at `.kit/controller-tick-test.mjs:12650` passes, the tool count stays fourteen, the `goal_done` description is under 600 characters, and `.kit/injection-duplicate-test.mjs` passes on a refreshed `.kit/injection-ledger.json`.
- `docs/architecture.md:134` and the totals at 121-128 state the new description and the new character counts.

Files in scope: `hooks/index.ts` (2171-2185, the `goal_edit` registration near 2249, the handler 6206-6268), `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.json`, `docs/architecture.md`, `README.md` where it describes the goal tools.
Tests: lock that completing by name never moves the active entry, since silently pausing live work is the cost of today's workaround. Lock the unfinished-children refusal in both directions.

### 4. Replacing a tree is deliberate, and a replaced tree is kept
Model: opus

`goal_create` gains an optional boolean parameter `replace`, named in its description with one sentence on what it does. When a root exists whose status is neither complete nor abandoned and `replace` is not true, the call is refused. The refusal names the root's title and how many entries under it are not complete or abandoned, and says to pass `replace: true` to replace the tree or to use `goal_add` to extend it.

Whenever the call goes on to replace a tree that holds at least one entry besides its root, it first appends one line to `.agentic-goal-history.jsonl` in the persona's working directory through `appendLines`. The line is a JSON object with the clock, the persona, the reason `goal_create`, and the whole replaced `goals` array. The path is resolved with `workdirPathOf`, the way the store path is. A failed append refuses the `goal_create` and leaves the tree as it was, since a replacement that cannot keep its copy is the loss this section exists to stop.

`goal_add`, when the root it resolves is complete or abandoned, sets the root to pending, clears its `blockedReason`, and records a decision with action `root_reopened` before adding the node.

The paused reminder at 6929 and the `goal_edit` root refusal at 6137 are reworded to match: replacing takes `replace: true`.

Acceptance:
- `goal_create` over a pending root with one pending plan is refused, and the tree and the store are unchanged.
- The same call with `replace: true` succeeds, and the history file's last line parses to an object whose `goals` holds both old nodes.
- `goal_create` over a complete root needs no `replace`. A lone complete root writes no history line. A complete root with plans under it writes one.
- With the append made to throw, `goal_create` with `replace: true` is refused and the old tree stands.
- `goal_add` of a plan under a complete root leaves the root pending, the plan active, and one `root_reopened` decision.
- The `goal_create` description is under 600 characters, the parameter pin passes, and `.kit/injection-duplicate-test.mjs` passes on a refreshed `.kit/injection-ledger.json`, with `docs/architecture.md:121-128` updated.
- `README.md` names the history file beside its account of the store file, says what writes to it and that nothing reads it back.

Files in scope: `hooks/index.ts` (the `goal_create` registration 2113-2137 and handler 5893-5951, the `goal_add` handler 5953-6112, the lines at 6137 and 6929), `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.json`, `docs/architecture.md`, `README.md`.
Tests: lock both directions of the replace guard, since a guard that also refuses a finished tree would stop every second goal. Lock that a failed history write stops the replacement.

## Out of Scope

- The `[NO GOAL]` reminder at `hooks/index.ts:6932-6948`. Its condition and text stand. It will now repeat on every prompt of a persona that holds no tree, which is its written intent.
- The channel-reply backstop at `hooks/index.ts:5278-5294`. It shares a word with the record this plan changes and nothing else.
- Removing the `backfilled` readers from `bin/supervise.sh`, `bin/supervise-poll.mjs` and `bin/supervise-decide.mjs`, and their cases in `.kit/supervisor-unit-test.mjs` and `.kit/supervisor-poll-unit-test.mjs`. Older stores still carry those lines. `docs/backlog.md` gains an entry to remove them once no store can.
- Any rate bound on relaunches after untracked work. The reworded backlog entry keeps it.
- `.claude/types/claude-code-mcp.d.ts`. It is generated by a command inside a live session, the handlers read their arguments through `any` casts, and the file is already behind the live descriptions.
- `.claude-plugin/plugin.json`. Its arming text lists the reader tier's tools, which this plan does not change.
- The planner, the scorer, the nudge loop, the round budget, `completeLeaf`'s walk, `activateNext` and `isPlanningDue` in `hooks/agent-state.ts`, and `hooks/self-review.ts`.
- `docs/plans/agent_persona_plan-health-from-the-record_v1.md` and `docs/plans/agent_persona_supervisor-peer_v1.md`. Neither is edited. The supervisor-peer plan's acceptance that a supervisor-ask turn "backfills nothing" reads, after this plan, as writing no `untracked_work` line, and its own worker settles that wording when it runs.
- Repairing the trees already damaged in the fleet's stores, and any tool that reads the history file back.
- Cutting the `fleet_status` description. The emergency fix did that.

## Assumptions

- assumed 2026-09-21 (default): untracked work is recorded as one collapsed decision-log line and never as a tree entry, which is option A of the three put to the operator, who asked for the plan without picking one; reversal: Section 2 is rewritten before it runs, at no cost to Sections 1, 3 and 4.
- assumed 2026-09-21 (the repository's other plans): the commit model is Branch-and-PR; reversal: one header line.
- assumed 2026-09-21 (default): the history file grows without a bound, because after this plan a replacement is a rare deliberate act and a tree is a few kilobytes; reversal: a rotation rule is a later plan.
- assumed 2026-09-21 (default): an operator ask closed by a by-name completion reuses the status `resumed`; reversal: a new status value means finding every reader of ask status first.
- assumed 2026-09-21 (default): the host's description limit is 4096 characters, read from the refusal text in five debug logs, and the cap test's 4000 leaves a margin; reversal: one constant.
- assumed 2026-09-21 (`docs/backlog.md:65-71`): the two backlog entries are covered as the Approach states; reversal: none, the close-out prune follows the text.
- assumed 2026-09-21 (default): the plan review ran through the Agent tool where the Workflow tool was not used, recorded in the handoff; reversal: a re-review at higher effort before arming.

## Operator Verification

- After this merges and the fleet relaunches on it, ask any worker to add two plans, let a background task finish, and confirm with `goal_status` that both plans are still there. The work reopens if either is gone.
- Ask a worker holding a paused entry whose work is done to record it finished. It reads complete, and the entry that was active is still active. The work reopens if the worker reports it could only drop the entry.
- After a day, open one persona's store and confirm its decision log reaches back more than a day. The work reopens if `untracked_work` lines fill it.

## Open Questions

None. The operator's pick among the three options for untracked work is recorded under `## Assumptions` and is settled by the merge of this plan's pull request.

## Chapters
