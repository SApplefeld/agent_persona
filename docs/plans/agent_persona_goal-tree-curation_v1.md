# Goal tree curation

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-21

## Goal

When this is done, a persona's goal tree changes only through a tool call that names what it changes. A turn that does work without a goal leaves the tree alone and leaves one line in the decision log. A worker can record any finished entry as finished, by name, where today it can only finish the active entry and must drop the rest as abandoned. `goal_create` refuses to replace an unfinished tree unless the call says to, and a replaced tree is kept in a history file. One refused tool registration no longer costs a session its persona claim, its stored tree and its heartbeat, and a session whose state never loaded says so where today it reports an empty tree. It matters because on 2026-09-21 every persona in the fleet reported its tree cleared, two personas lost live plans within minutes of adding them, and a worker retired a finished plan with the reason "NOT abandoned - this plan is finished".

## Dispatch Authorization

The operator asked for this plan on 2026-09-21 on the architect persona's Discord thread.

> I think we need to look at how the goal tree is managed in Personas. Every session came back up saying it's goal tree was cleared, or is having issues with items getting cleared off it, one session said it can't mark things completed, only abandoned. Can you take a look at how the goals are curated and managed and reset?

After the findings and a five-part sketch he wrote: "can you complete the plan for the goal improvements and open a PR for it so it can be ready to run?" That covers authoring. Three options for untracked work were put to him, and he picked option A, which is how Section 2 is written. His ruling is recorded under `## Intent`. Execution waits on the operator handing this plan to a worker by name.

This plan starts only after two other efforts have merged to the trunk, because they edit the same regions. `docs/plans/agent_persona_plan-health-from-the-record_v1.md` edits the `goal_done` handler and the end of `turn.complete`. `docs/plans/agent_persona_supervisor-gaps_v1.md` edits `bin/supervise.sh`. The trunk is `origin/main`, read after a fetch. The check is that `git ls-tree --name-only origin/main docs/plans/` lists neither file, since a finished plan moves to `docs/archive/`. A worker that finds either still listed stops with a `BLOCKED:` lead naming it. The work runs on one branch cut from that fetched trunk and lands as one pull request for the whole plan. The emergency fix that cut the `fleet_status` description under the host's limit is also expected on the trunk, and Section 1 states what to do where it is not.

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

Rulings after the spec shipped:
- 2026-09-21, the operator, on the architect persona's Discord thread: "I think Option A is fine". A turn that works with no goal open records nothing in the tree and one line per session in the decision log. Section 2 stands as written.
- 2026-09-21, the operator, in the same message: the tree he is aiming for has several levels, after the PIANO architecture from Project Sid. Short-term goals direct the immediate actions, medium-term goals are the plans being worked, and long-term goals span many sections. He reads today's tree as serving the medium term only, "adequate, but short of the ideal". This plan repairs the tree that exists and builds no levels. The levels are a separate design effort.

Provenance: distilled from the architect persona's session of 2026-09-21 on its Discord thread, from the code at trunk `622c19b`, the five personas' store files and their debug logs.

## Approach

**Line numbers and anchors.** Every line number in this plan is at trunk `622c19b` and will have moved by the time the plan runs, because two plans merge first. Each block is found by its text, never by its number. The anchors are: `on("session.start"`, `// Register tools.` and `--- Claim or join the persona based on liveness` for Section 1; the comment opening `Item 2 sub-bullet (f016b69)` and `const noActiveRoot` for Section 2, with `get_root_complete "$WORKDIR" "$PERSONA"` in `bin/supervise.sh`; `// Serve goal_done` for Section 3; `// Serve goal_create`, `// Replace any existing tree.` and `// Serve goal_add` for Section 4. A worker that cannot find an anchor, or finds the block under it restructured so that a section's text no longer fits, stops with a `BLOCKED:` lead naming the anchor and what it found.

**What was found.** Three separate defects produced the three reports.

First, the cleared tree was a start-up crash and the stored trees were intact. `session.start` in `hooks/index.ts` registers fourteen tools one by one (2089-2448) and only then claims the persona and loads the store (2451-2569). Claude Code refuses a tool description over 4096 characters. The `fleet_status` description reached 4926, the refusal threw out of `session.start`, and everything after it was skipped. The session ran on the built-in default state, which is persona `default`, not owner, no goals (`hooks/index.ts:522-526`). `goal_status` answered "No goal tree exists." and every goal write was refused as "held by a live session", which was untrue. An emergency fix outside this plan cut the description. This plan removes the fragility behind it.

Second, entries vanished because of the after-the-fact goal record at `hooks/index.ts:5298-5351`. When a turn made tool calls and the root was absent, complete or abandoned, the plugin set `sess.state.goals` to a single synthetic finished root. `goal_add` accepts a node under a complete root, so plans added there were deleted by the next turn that fired it. It fires on task notifications and on messages from other sessions as well as on operator requests, and each firing writes two decision lines into a log capped at 200 (`DECISIONS_MAX`, `hooks/agent-state.ts:299`). The dev-discord persona's log shows plans added at 03:53Z and gone at 03:56Z, added again at 04:07Z and gone at 04:09Z. `docs/backlog.md` has carried this defect since 2026-09-16.

Third, `goal_done` (`hooks/index.ts:6207`) takes no entry id and completes only `activeGoalId`. The only tool that retires any other entry is `goal_edit` with `drop`, which marks it abandoned. The workaround is `goal_resume` then `goal_done`, which pauses whatever was really active.

A fourth, smaller one: `goal_create` (`hooks/index.ts:5930`) replaces the whole tree, unfinished work included, and keeps nothing.

**The design.** Four changes, one per section.

Registration failures are contained. Every `$.tool.register` call in `session.start` goes through one local helper that catches a throw, logs it, and records it, so the claim, the store load and the heartbeat always run. The refusal is written into the session's decisions once the state is loaded. A flag records that the persona's state has been loaded, by `session.start` or by `agentic_identity`. While the flag is unset, every goal tool answers with one sentence saying the persona's state was never loaded in this session, in place of the empty-tree answer and the held-by-a-live-session refusal.

Untracked work is a log line and nothing else. The block at 5298-5351 stops building a root. It fires on the conditions it fires on today: the session owns its persona, the turn was not skipped, was not the priming turn and was not a nudged turn, the turn made at least one call to a tool `isWorkTool` counts as work, and the root is absent, complete or abandoned. When it fires it writes one decision with action `untracked_work`. A session keeps at most one such line in the log. The first firing pushes it. Each later firing in that session removes the line and pushes it again at the tail with the new clock, a raised count and the new prompt excerpt, so the log stays in time order and a chatty day costs one line. The collapse cannot key on the log's last entry, because real logs carry `turn_start`, `cost_summary` and `env_git` lines between firings. It writes no `create` and no `root_complete`. The supervisor reads the line's clock, so a line re-pushed in this child's life reads newer than the child's start, which is what the supervisor's test needs. The supervisor's clean-exit path in `bin/supervise.sh` (3240-3259) reads the new fact through the existing `get_fact` helper and takes today's unaccounted relaunch on it. The readers of the old `backfilled` text in `bin/supervise.sh`, `bin/supervise-poll.mjs` and `bin/supervise-decide.mjs` stay, because stores written before this change still carry those lines until they roll off the log. The poll path needs no new reader: with no `root_complete` written, `bin/supervise-decide.mjs` already continues.

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

**The tool description budget.** Two descriptions grow, `goal_done` and `goal_create`. Each stays under 600 characters. `.kit/injection-duplicate-test.mjs` fails on any growth past the committed baseline, so each of Sections 3 and 4 refreshes the baseline with `node .kit/injection-ledger.mjs > .kit/injection-ledger.json`, and updates the two totals `docs/architecture.md:121-128` states. The sections run in numeric order, so Section 4 regenerates the ledger and the totals from the tree Section 3 left.

## Sections of Work

### 1. Start-up survives a refused tool registration
Model: opus

Every `$.tool.register` call inside `session.start` goes through one local helper. The helper awaits the registration inside a try block. On a throw it logs one `$.ui.log` line naming the tool and the host's text, and holds the tool name and the error text passed through the file's existing `boundedText(safeErrorText(err))`, the bound the store-read failure beside it already uses. After the persona state is loaded, each held refusal becomes one decision with loop `monitor` and action `tool_register_refused`, the way `startPersonaProblem` is carried today (2571-2579).

Two terms from the file. The plugin's `arming` option sets a session's tier: `off` registers nothing, `reader` registers four tools and owns no persona, `owner` registers all fourteen. The `if (arming !== "reader")` gates around the goal tools and `agentic_resolve` stay as they are. The two clock callbacks are the heartbeat tick and the controller tick, which `session.start` registers after the claim, and which the tick tests already count.

A session field holds why the persona's state is not loaded, or null when it is loaded. It starts as the start-up cause: plugin start-up did not finish, and the debug log's `session.start hook skipped` line names why. The catch that handles an unreadable store (anchor: `startStoreProblem = {`) sets it to the store cause: the store file could not be read, so this session came up on an empty default state. It is set to null in two places. One is where `session.start` leaves its claim-or-join block, and only where the store read did not take that catch. The other is where the `agentic_identity` handler loads a persona's entry from a store that parsed, since a session whose start failed recovers through that tool. While the field is not null, `goal_status`, `goal_create`, `goal_add`, `goal_edit`, `goal_done` and `goal_resume` each answer with one sentence built from one template: this session never loaded its persona's state, then the held cause, then that the stored goal tree is not shown and was not changed. `goal_status` returns it as its result, and the five writers return it as their deny text.

Where the trunk carries no test that fails on a tool description over 4000 characters, this section adds one under `.kit/`, reading `hooks/index.ts` through the ledger's `extractToolDescriptions`. Where the emergency fix already added one, this section leaves it alone.

Acceptance:
- A harness case makes `register` throw for `fleet_status` only. After `session.start`, the session owns its persona, its goals are the stored goals, both clock callbacks are registered, `agentic_resolve` is registered, and the decisions hold one `tool_register_refused` naming `fleet_status`.
- The control for that case registers all fourteen and records no `tool_register_refused`.
- A harness case that calls `goal_status` and `goal_done` on a session whose `session.start` never ran gets the sentence with the start-up cause from both, and the store file is byte-identical afterwards.
- A harness case that starts a session over a store file that does not parse gets the sentence with the store cause from `goal_status` and from `goal_create`, and the unparseable file is byte-identical afterwards.
- The control for both: a session that started over a readable store answers `goal_status` with its stored tree.
- `.kit/check-loader-rule.mjs` passes on the edited file.
- `README.md` states, beside its paragraph on the loader check, that one refused registration costs that tool alone, and names the decision it leaves.

Files in scope: `hooks/index.ts` (the `session.start` handler 2053-2600 and the six goal tool handlers' opening checks), `.kit/tick-harness.mjs`, `.kit/controller-tick-test.mjs`, `README.md`, and a new `.kit/tool-description-cap-test.mjs` only where the trunk lacks one.
Tests: lock both directions of the registration guard, since a helper that swallows the throw and also skips the later tools would pass a claim-only check. Lock that an unloaded session writes nothing, since the expensive failure is a default state persisted over a real store.

### 2. Untracked work leaves the tree alone
Model: opus

The block at `hooks/index.ts:5298-5351` keeps its condition exactly and changes what it does. It builds no root, assigns nothing to `sess.state.goals`, and leaves `activeGoalId` alone. It writes one decision with loop `goal` and action `untracked_work`. The detail is a string of the form `x<count>: <first 80 characters of the prompt>`, and nothing parses it. The session holds two fields in memory, the clock of the line it wrote and the count, both unset at session start. On the first firing it pushes the line with count 1 and sets both fields. On each later firing it removes from `sess.state.decisions` the entry whose action is `untracked_work` and whose timestamp equals the held clock, pushes a new line at the tail with the current clock, the raised count and the new excerpt, and updates both fields. Where the held entry is no longer in the log, because the 200-line cap dropped it, it pushes and carries the count on. Any other decision written between firings has no effect on this. The comment above the block is rewritten to state what the block does now.

`bin/supervise.sh`'s clean-exit path reads `untracked_work` through `get_fact`, which returns the clock of the newest decision with that action, beside the `root_complete` read (anchor: `get_root_complete "$WORKDIR" "$PERSONA"`). That path is where a child that exited on its own is relaunched. An unaccounted relaunch is one that skips `record_restart_in_hour` and the crash counter, so it never counts toward `SUPERVISOR_MAX_RESTARTS_PER_HOUR`, the budget that stops a supervisor whose child restarts too often. A clean exit with an `untracked_work` clock newer than the child's start takes the same unaccounted relaunch the backfilled branch takes, with a NOTE line that names untracked work. The existing backfilled branch stays for stores that still carry the old lines. `bin/supervise-poll.mjs` and `bin/supervise-decide.mjs` are not edited.

Acceptance:
- The five `caseItem2_backfill*` cases in `.kit/controller-tick-test.mjs` are rewritten to the new behavior under names that say so. A turn with tool calls and no root leaves `state.goals` empty and leaves one `untracked_work` decision. A turn with tool calls over a complete root that has a live plan under it leaves every node in place. Three such turns, with a `turn_start` and a `cost_summary` decision written between them, leave exactly one `untracked_work` line, at the tail, whose detail opens `x3:`. A fresh session over that same store pushes a second line and leaves the first. The priming-turn and nudge-turn cases still write nothing.
- No code path in `hooks/index.ts` writes a `root_complete` decision whose detail carries the text `backfilled`.
- `.kit/supervisor-natural-exit-test.sh` gains a case where a child records `untracked_work` and exits 0, and asserts the unaccounted relaunch and its NOTE line. Its cases (a) and (e) keep passing, since they prove the reader still handles an old store's line. The file's source pins (anchor: `mark backfill-pins`) all change together, because they read the writer's detail out of `hooks/index.ts` and that writer is gone. The pin requiring exactly one backstop `root_complete` detail and the pin requiring the reader's substring inside it are removed. `BACKSTOP_DETAIL` and the stub fixture built from it (anchor: `detail-backfilled`) take a fixed literal written in the test, the detail text the trunk's writer produced, with a comment saying it is an old store's line. The pin that no `root_complete` detail in `hooks/index.ts` carries the reader's substring stays and now covers every such write. The pin that every `root_complete` write yielded a detail stays. The whole file passes.
- `.kit/supervisor-unit-test.mjs` and `.kit/supervisor-poll-unit-test.mjs` pass unedited.
- `README.md:295-309` and 359-370 describe the log line and the supervisor's read of it. `docs/backlog.md` loses the 2026-09-16 entry to `docs/archive/backlog-2026-Q3.md`, and its 2026-09-13 entry is reworded to the rate-bound half, naming `untracked_work`. It gains one entry, dated the day of the run, to remove the supervisor's `backfilled` readers and their test cases once no store's decision log can still hold such a line.

The doc comment above `isWorkTool` (anchor: `Item 2 backstop (Round 28)`) says a passive child "otherwise backfills a completed goal". It is rewritten to say what such a turn writes now.

Files in scope: `hooks/index.ts` (5298-5351 and the `isWorkTool` doc comment at 444-454), `bin/supervise.sh` (the clean-exit path near 3240-3259), `.kit/controller-tick-test.mjs`, `.kit/supervisor-natural-exit-test.sh`, `README.md`, `docs/backlog.md`, `docs/archive/backlog-2026-Q3.md`.
Tests: lock that a live plan under a complete root survives a working turn, since that is the loss the operator reported. Lock the collapse, since an uncollapsed line per turn empties the decision log of everything else within hours.

### 3. goal_done completes an entry by name
Model: opus

`goal_done` gains an optional string parameter `nodeId`. Its description names the parameter and says in one sentence that finished work on an entry that is not active is recorded with `goal_done` and its `nodeId`, never with a drop. The `goal_edit` description's sentence on `drop` gains the matching half: a drop is for work that will not be done.

With `nodeId` absent, the handler behaves as it does on the trunk at the time of the run, the plan-health plan's changes included.

With `nodeId` present, the handler refuses in four cases. When the id is not in the tree, the reason names the id. When the entry is the root, when its status is complete or abandoned, and when any child of it has a status other than complete or abandoned, the reason names the entry's status. Otherwise it completes the entry through `completeLeaf` with the note, clears the entry's `blockedReason` and `pausedByNudgeCap`, runs the health command as today, and records the `done` decision naming the entry and that it was closed by name.

What follows depends on which entry it was. Where the entry was the active one, everything proceeds as the call without `nodeId` does. Where another entry is active, that entry stays active and nothing is activated. Where no entry is active, `activateNext` runs unless an operator ask is open on a different entry or some entry is held by the nudge cap, which are the two holds `goal_add` already honors (6087-6092). Round and score credit mean the two statements inside this handler that push onto the entry's `scores` and raise its `completedRounds`, with the `score` decision beside them. They are the handler's own and are not the scorer. The merged trunk's credit block is kept exactly as it stands and is wrapped in one test, that the completed entry was the active one when the call arrived. This section adds no other condition to it and removes none. Where an operator ask is open on the completed entry, it is closed exactly as `goal_resume` closes one (6391-6404), with the decision detail saying `goal_done` closed it.

Acceptance:
- A paused plan completed by name reads complete, the entry that was active is still active, and no `paused_by_resume` decision exists.
- A pending task completed by name under a plan whose other children are complete takes the plan to complete through `completeLeaf`'s walk.
- Each of the four refusals returns its reason and changes no node.
- A call with no `nodeId` on a tree with an active leaf behaves as before the edit. The proof is a test written first, against the unedited handler: it records the actions and order of the decisions that call writes and the resulting node statuses, it passes before any edit to the handler, and it passes unchanged after.
- Completing the active entry by its own name writes the same decisions and the same credit as the call with no `nodeId`. Completing an entry that was not active leaves that entry's `scores` and `completedRounds` as they were and writes no `score` decision.
- Completing by name the entry an open ask points at clears `pendingAskId` and leaves the ask record `resumed`.
- The parameter-named-in-description pin at `.kit/controller-tick-test.mjs:12650` passes, the tool count stays fourteen, the `goal_done` description is under 600 characters, and `.kit/injection-duplicate-test.mjs` passes on a refreshed `.kit/injection-ledger.json`.
- `docs/architecture.md:134` and the totals at 121-128 state the new description and the new character counts.

Files in scope: `hooks/index.ts` (2171-2185, the `goal_edit` registration near 2249, the handler 6206-6268), `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.json`, `docs/architecture.md`, `README.md` where it describes the goal tools.
Tests: lock that completing by name never moves the active entry, since silently pausing live work is the cost of today's workaround. Lock the unfinished-children refusal in both directions.

### 4. Replacing a tree is deliberate, and a replaced tree is kept
Model: opus

`goal_create` gains an optional boolean parameter `replace`, named in its description with one sentence on what it does. When a root exists whose status is neither complete nor abandoned and `replace` is not true, the call is refused. The refusal names the root's title and how many entries under it are not complete or abandoned, and says to pass `replace: true` to replace the tree or to use `goal_add` to extend it.

Whenever the call goes on to replace a tree that holds at least one entry besides its root, it first appends one line to `.agentic-goal-history.jsonl` in the persona's working directory through `appendLines`. The line is a JSON object with the clock, the persona, the reason `goal_create`, and the whole replaced `goals` array. The path is resolved with `workdirPathOf`, the way the store path is. A failed append refuses the `goal_create` and leaves the tree as it was, since a replacement that cannot keep its copy is the loss this section exists to stop.

`goal_add`, when the root it resolves is complete or abandoned, sets the root to pending, clears its `blockedReason`, and records a decision with action `root_reopened` before adding the node. It touches no other node, so children already complete or abandoned stay as they are. The new node is activated by the handler's existing no-active-leaf branch, which this section does not change.

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
- `docs/archive/agent_persona_plan-health-from-the-record_v1.md` (complete) and `docs/plans/agent_persona_supervisor-peer_v1.md`. Neither is edited. The supervisor-peer plan's acceptance that a supervisor-ask turn "backfills nothing" reads, after this plan, as writing no `untracked_work` line, and its own worker settles that wording when it runs.
- Repairing the trees already damaged in the fleet's stores, and any tool that reads the history file back.
- Cutting the `fleet_status` description. The emergency fix did that.

## Assumptions

- assumed 2026-09-21 (the repository's other plans): the commit model is Branch-and-PR; reversal: one header line.
- assumed 2026-09-21 (default): the history file grows without a bound, because after this plan a replacement is a rare deliberate act and a tree is a few kilobytes; reversal: a rotation rule is a later plan.
- assumed 2026-09-21 (default): an operator ask closed by a by-name completion reuses the status `resumed`; reversal: a new status value means finding every reader of ask status first.
- assumed 2026-09-21 (default): the host's description limit is 4096 characters, read from the refusal text in five debug logs, and the cap test's 4000 leaves a margin; reversal: one constant.
- assumed 2026-09-21 (`docs/backlog.md:65-71`): the two backlog entries are covered as the Approach states; reversal: none, the close-out prune follows the text.
- assumed 2026-09-21 (default): the design-time plan review of this document ran at the reviewer's default effort and not at high effort, because the operator asked for the plan quickly during a fleet outage; reversal: one more review at high effort before a worker is handed the plan.

## Operator Verification

- After this merges and the fleet relaunches on it, ask any worker to add two plans, let a background task finish, and confirm with `goal_status` that both plans are still there. The work reopens if either is gone.
- Ask a worker holding a paused entry whose work is done to record it finished. It reads complete, and the entry that was active is still active. The work reopens if the worker reports it could only drop the entry.
- After a day, open one persona's store and confirm its decision log reaches back more than a day. The work reopens if `untracked_work` lines fill it.

## Open Questions

None open. The plan carried one question: what the plugin records when a turn does real work and no goal is open. The operator answered it, and the ruling under `## Intent` records his answer. The two options he passed over are the first two lines under "Alternatives refused" in that section.

## Chapters
