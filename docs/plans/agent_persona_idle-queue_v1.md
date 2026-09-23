# Idle queue

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

When this is done, a persona with queued work starts it without being told, and a persona whose
tree holds only paused or blocked work reads that queue in every prompt and counts as idle rather
than as busy. It matters because on 2026-09-22 the DEV-PLUGIN persona sat idle for about three
hours after its plan merged, with four open plans queued as paused, while its per-prompt reminder
showed one stale reason from a fifth plan and nothing in the plugin would ever start the next one.

## Dispatch Authorization

The operator agreed to every item in the brief at
`D:\personas\ASSISTANT\briefs\persona-idle-queue-and-autonomy.md` on 2026-09-22, on the ASSISTANT
channel, and asked that it go to the architect through the coordinator. The coordinator relayed it
as record `ARCHITECT-8d67c288-dd78-478d-a565-e390d50027b0-15`, quoting the operator: "Please
proceed. Send everything to Steward for architect. Let's get this in action." This plan carries
the brief's items 1, 2 and 3. Items 4, 5 and 6 are `docs/plans/agent_persona_autonomy-dial_v1.md`.

Execution waits on the coordinator handing this plan to a worker by name. A worker that finds this
plan in its own queue has that handoff. This plan waits on no other plan, so the coordinator may
queue it at once.

## Intent

The frame, in the operator's words from the brief: a persona with queued work starts it without
being told, and a persona with no work knows its standing duty. Finish the active work, then the
queued work, then the backlog.

Done means three things. Queued future work is a `pending` plan in the tree, in order, which the
controller starts by itself when its turn comes, and `paused` means stuck. A prompt that arrives
while no entry is active shows the whole open queue with each entry's state, never one stale
reason. And a tree whose open entries cannot start by themselves reads as idle to every duty that
asks whether the persona is idle, through one helper the goal-levels plan's idle proposal also
reads.

Done does not need a new goal status, a machine-readable release condition on a paused entry, a
timer that unpauses work, a change to the planner's own due rule, or any change to how the board
in the discord-channels repository counts open work. `activateNext` already runs pending leaves
one at a time in `sortKey` order, and the plan-health plan already completes a plan entry when its
document reads Complete, so the queue mechanism exists and only the instruction and the prompt
are missing.

Alternatives refused:

- A new `queued` status beside `paused`. Refused, because `pending` in `sortKey` order already is
  the queue, and a fourth open status is one more state every tree walker has to learn.
- A release condition in a machine-readable field, released by the controller when the named
  entry completes. Refused, because it rebuilds ordering the `sortKey` already gives, and a
  condition written in prose today shows the failure of a condition nothing reads.
- Counting an all-paused tree as due for the planner. Refused, because the planner inventing work
  for a finished root is the failure the goal-levels plan's section 6 removes, and a paused entry
  is not a finished one.
- A timer that resumes a paused entry after a wait. Refused, because a stuck entry resumed blind
  is stuck again a turn later, and the operator's word is what unsticks it.
- Reading the release condition out of a paused entry's reason text. Refused, because prose is
  not a contract and the plugin would guess.

Rulings: none at the write.

Provenance: distilled from the operator's brief of 2026-09-22 and the architect's read of
`hooks/index.ts`, `hooks/agent-state.ts` and `bin/supervise.sh` at `origin/main` `9d0e317` the
same day, with the DEV-PLUGIN store at `D:\claude-kit\.agentic-personas.json` as the live case.

## Related plans

- `docs/plans/agent_persona_goal-levels_v1.md` (Ready, waits on keeper-park and on this plan).
  Its section 5 fired the idle proposal only when no node was `pending`, `active`, `paused` or
  `blocked`, which an all-paused tree never satisfies. The architect amended that plan's section
  5 in the same commit that added this plan, to read the helper this plan's section 1 adds; the
  amendment is recorded there as the architect's amendment of 2026-09-22 under Intent, and this
  plan's worker touches that file nowhere. Its section 2 edits the
  coordinator's instruction, which this plan's section 2 edits too; whichever merges second
  rebases over the other, and the text of each is additive.
- `docs/plans/agent_persona_autonomy-dial_v1.md` (Ready, runs after goal-levels and after this
  plan). It carries the standing per-prompt block and the autonomy setting. This plan's queue
  block and helper are what that block reads.
- `docs/plans/agent_persona_ask-bookkeeping_v1.md` (Ready). It changes the thread-reply close and
  the error-streak arm in `hooks/index.ts`, neither of which this plan touches.

## Approach

**Decisions settled at the finalize**, by the architect on 2026-09-22, on the brief's open items.

- Queued work is `pending` and nothing else. The brief offered this as the cheapest form and it
  holds: `activateNext` (`hooks/agent-state.ts`, the DFS from the root) activates the first
  `pending` leaf in `sortKey` order, and `goal_edit`'s `reprioritize` moves a pending plan ahead
  of its siblings. The coordinator's instruction is what changes.
- Idle is a property of the tree, computed by one exported helper, and the planner does not read
  it. `isPlanningDue` keeps counting `paused` as work, so an all-paused tree never fires the
  planner.
- The queue block replaces the paused reminder rather than sitting beside it. One block, one
  ledger entry, one shape whether the queue holds one paused entry or twelve.

**What exists today.** Each point was read at `origin/main` `9d0e317` on 2026-09-22. Line numbers
move as other plans merge, so find each site by the names and comment text given.

- The controller starts `pending` leaves only: `activateNext` in `hooks/agent-state.ts` filters
  each level on `status === "pending"` and returns the first leaf `isActivationEligible` accepts,
  in `orderKey` order, which is `sortKey` where set and `createdAt` otherwise. A `paused` entry is
  never a candidate.
- `isPlanningDue` (`hooks/agent-state.ts`, below `activateNext`) returns false while any
  descendant is `pending`, `active` or `paused`. An all-paused tree therefore neither starts nor
  plans.
- The tick's no-active-leaf branch (`hooks/index.ts`, the comment `// 4. No active leaf: activate
  pending work if any exists (H1), else return.`) calls `activateNext` and returns. Nothing else
  runs there today; the goal-levels plan adds the idle proposal there.
- The per-prompt reminder (`hooks/index.ts:8081`, the comment `// M5: when the tree is paused,
  inject a one-line reminder.` above `const pausedBlock`) fires when no entry is active and any
  entry is `paused`, and injects the first paused entry's `blockedReason` alone. Its literal is
  the ledger entry `GOAL_TREE_PAUSED_BLOCK` (`.kit/injection-ledger.json`, 94 characters),
  extracted by `.kit/injection-ledger.mjs` near line 873. The `[NO GOAL]` block beside it fires
  only when `goals` is empty. `.kit/injection-ledger.mjs` sizes a block built from a template
  chain with `literalOfTemplateChain`, which takes the names of template parts to leave out;
  `GOAL_TREE_BLOCK` leaves out `siblingLine` and `lastNote` that way (near line 865).
- The tick suite, `.kit/controller-tick-test.mjs`, is the suite that exercises
  `hooks/agent-state.ts`; no `.kit/*-unit-test.mjs` file covers it, so the helpers' cases go in
  the tick suite.
- The launch priming (`bin/supervise.sh`, the two `PRIMING_BODY=` assignments that open `You are
  the passive supervisor`) says "If a goal tree is active, resume it from goal_status", which a
  worker holding an all-paused tree read as not applying.
- The coordinator's instruction (`bin/supervise.sh`, `COORDINATOR_ROLE_INSTRUCTION=`) tells the
  coordinator to have a worker pass `planPath` on `goal_add` when it queues a plan. It says
  nothing about the entry's status, and the coordinator chose `paused` with a prose release
  condition.
- The live case: DEV-PLUGIN's store on 2026-09-22 holds plan 9, "Memory record provenance", as
  `paused` with the reason "Queued paused on the coordinator's word after PR 79; starts after
  plan 8", and plan 8 reads `complete`. Nothing will start plan 9.
- `goal_edit`'s `pause` action (`hooks/index.ts`, the `goal_edit` handler, `action === "pause"`)
  is how a worker pauses an entry on the coordinator's steer. Its description does not say what a
  pause is for.

**The design.**

1. `hooks/agent-state.ts` exports two pure helpers. `openGoals(state)` returns every non-root node
   whose status is `pending`, `active`, `paused` or `blocked`, in one flat sort of all of them by
   `sortKey` where set and `createdAt` otherwise, not in the controller's level-by-level walk
   order. `hasStartableWork(state)` is true when any node is `active`, or when
   `nextStartableLeaf(state)` returns a node. `nextStartableLeaf` is `activateNext`'s own DFS from
   the root, the walk that filters each level on `pending` and returns the first leaf
   `isActivationEligible` accepts, lifted out of `activateNext` into a pure function that
   `activateNext` then calls in place of the inline walk. So the helper and the controller share
   one walk and cannot disagree, and a `pending` leaf under a paused parent is not startable for
   either. `activateNext`'s first step, which activates a pending sibling of a node just
   completed, is untouched and is not part of the helper, since it runs only with a `completedId`
   and never from the tick's no-active-leaf call. A tree where the helper is false holds nothing
   the controller will start on its own, which is the idle tree.
2. The per-prompt reminder becomes the queue block. The blocks are exclusive and ordered: an
   `active` entry named by `activeGoalId` gets `[GOAL TREE]` as today; otherwise a non-empty
   `openGoals` gets `[GOAL QUEUE]`; otherwise an empty `goals` gets `[NO GOAL]`; a tree holding
   only a root and complete or abandoned entries gets none of the three, as today. The queue block
   lists each open entry on one line in `openGoals` order: the status, the node's `kind` field
   (`plan` or `task`), the id, the title cut to 40 characters, and the `blockedReason` cut to 60
   where one is set. Past twelve lines it prints the count of the rest. Its last line
   depends on `hasStartableWork`. Where true: "The next pending entry starts on the controller's
   next tick; do not start it by hand." Where false: "Nothing here starts by itself: every open
   entry is paused, blocked or out of the controller's reach. Resume one with goal_resume, drop one with goal_edit, or ask the
   operator." The `[NO GOAL]` block keeps firing only on an empty tree. The ledger entry
   `GOAL_TREE_PAUSED_BLOCK` is replaced by `GOAL_QUEUE_BLOCK`. The block is built as a template
   chain whose entry lines and count line are one named part, and the extractor sizes it with
   that part left out, the way `GOAL_TREE_BLOCK` leaves out `siblingLine` and `lastNote`. Both
   closing sentences are in the sized text.
3. The coordinator's instruction gains three sentences. Future work is queued as a `pending` plan
   with `goal_add`, ordered with `goal_edit reprioritize`, and the plugin starts the next pending
   plan by itself when the current one completes. `paused` is for an entry that cannot proceed
   until someone acts, and the controller never starts a paused entry from the queue. An entry that reads
   `paused` with a release condition in its reason is a queue mistake, and the coordinator has the
   worker drop it with `goal_edit` and `goal_add` it again as `pending` with the same `planPath`,
   never resume it, since `goal_resume` pauses whatever entry is active. A drop does not reach a
   node's children, so any open task under the entry is dropped first, after a pause if it is active.
4. The priming line reads "If a goal tree holds open entries, resume the tree from goal_status
   whether or not an entry is active, and leave a paused entry for the operator or the coordinator
   to release" in both `PRIMING_BODY` forms, and `goal_edit`'s description says a pause is for
   stuck work and queued work stays pending.

## Sections of Work

The two sections run in order as commits on one work branch cut from `origin/main`, named by the
worker, with this plan file on it, and finishing-work opens the one pull request.

### 1. The queue block and the idle helper
Model: opus

The two helpers in `hooks/agent-state.ts` and the queue block in the `prompt.submit` handler, as
the design states, with the ledger entry renamed and its extractor in `.kit/injection-ledger.mjs`
pointed at the new literal. Opus because the block's text is sized by the injection ledger, whose
extractor reads the literal by shape, and because the helper's eligibility read has to match
`activateNext`'s own rather than approximate it.

Tests: lock that the queue block lists every open entry in activation order and names each
entry's status, since one stale reason is the failure this plan answers; lock the last line in
both directions, a tree with a startable pending entry and a tree with only paused entries; lock
that `hasStartableWork` is false for the DEV-PLUGIN shape, a complete plan beside paused ones and
no pending leaf, and true once one of them is resumed; lock that the empty tree still gets the
`[NO GOAL]` block and not the queue block.

Acceptance:
- `openGoals`, `hasStartableWork` and `nextStartableLeaf` are exported from
  `hooks/agent-state.ts`, `activateNext` calls `nextStartableLeaf` for its walk from the root, and
  on every tick-suite fixture with no active node `hasStartableWork` is true exactly where
  `activateNext(state)` called with no `completedId` activates a node. Every existing tick-suite
  case passes unchanged except `caseGtc4_thePausedReminderNamesReplaceTrue`, which pins the old
  paused text and is rewritten to pin the queue block's all-paused last line.
- An external prompt on a tree with no active entry and three open entries carries one
  `[GOAL QUEUE]` block with three entry lines in `sortKey` order, each opening with the entry's
  status, and the last line reads as the design states for that tree.
- A tree with thirteen open entries lists twelve and a count of one more.
- An empty tree carries the `[NO GOAL]` block and no `[GOAL QUEUE]` block. A tree with an active
  entry carries `[GOAL TREE]` and neither.
- `.kit/injection-ledger.json` carries `GOAL_QUEUE_BLOCK` and no `GOAL_TREE_PAUSED_BLOCK`, the
  Chapter records the old and new sizes, and `node .kit/injection-duplicate-test.mjs` exits 0.
- `node .kit/controller-tick-test.mjs` exits 0 after the process-list poll the kit's
  testing-discipline skill names under its Check the box rule, and `npx tsc --noEmit` exits 0.

Files in scope: `hooks/agent-state.ts` (the two helpers and the walk lifted out of
`activateNext`), `hooks/index.ts` (the `prompt.submit` handler's reminder branch),
`.kit/injection-ledger.json`, `.kit/injection-ledger.mjs`, `.kit/controller-tick-test.mjs`,
`.kit/tick-harness.mjs` where a fixture is needed.

### 2. The coordinator queues pending, and the priming names the whole tree
Model: sonnet
Locus: inline

The coordinator's instruction, the two priming lines and the `goal_edit` description gain the text
the design states, each written to the register of the text around it. `README.md` states the
queue rule under its `### Changing the goal tree` heading, beside `goal_edit` and `goal_resume`,
and names the `[GOAL QUEUE]` block in its actuator list where it names context injection, and
`docs/architecture.md`'s failure-modes table gains one row for a persona idle over an all-paused
tree, whose reading is the queue block's last line.

Tests: the injection ledger's `PRIMING_BODY_*` entries and the duplicate test are the gate for
the priming edit, and the ledger and the tool-description length test are the gate for the
description. The supervisor model suite reads no priming text and does not run for this section.

Acceptance:
- The coordinator's priming text says queued work is `pending` in order, that the plugin starts
  the next pending plan by itself, that `paused` is for an entry waiting on someone, and what to do
  with a paused entry carrying a release condition.
- Both `PRIMING_BODY` forms say to resume a tree that exists whether or not an entry is active.
- The `goal_edit` description says a pause is for stuck work and queued work stays pending, and
  the `goal_edit_description` ledger entry matches it.
- `.kit/injection-ledger.json` is refreshed, `node .kit/injection-duplicate-test.mjs` exits 0,
  and `node .kit/tool-description-length-test.mjs` exits 0.
- `README.md` states the rule under `### Changing the goal tree` and names the block in the
  actuator list, `docs/architecture.md` carries the row, and no em dash is in the new text.

Files in scope: `bin/supervise.sh` (the coordinator instruction and the two priming lines),
`hooks/index.ts` (the `goal_edit` description, and the queue block's closing line, folded in
review), `.kit/controller-tick-test.mjs` (that line's pin, folded in review),
`hooks/agent-state.ts` (the `hasStartableWork` comment, folded in review),
`.kit/injection-ledger.json`,
`.kit/injection-ledger.mjs` where an anchor moves, `README.md`, `docs/architecture.md`.

## Out of Scope

- `activateNext`'s behavior, `isActivationEligible` and `isPlanningDue`. The one edit to
  `activateNext` is the lift of its walk into `nextStartableLeaf`, which it then calls; what it
  activates does not change.
- `docs/plans/agent_persona_goal-levels_v1.md`. The architect's amendment there was written
  before this plan was queued.
- The idle proposal and the standing per-prompt block. The goal-levels plan owns the first and the
  autonomy-dial plan the second; both read this plan's helper.
- How the discord-channels board counts a paused entry as open work. That is the other repository's
  reading and stays true under this plan, since a queued entry is open work.
- DEV-PLUGIN's own tree. The coordinator has that worker resume plan 9 on its word; this plan
  stops the shape recurring.
- The kit plugin's session-start output. The queue block rides every external prompt, so the kit
  side needs no line naming the tree.

## Assumptions

- assumed 2026-09-22 (the repository's other plans): the commit model is Branch-and-PR; reversal:
  one header line.
- assumed 2026-09-22 (the architect): the executing worker runs under the kit, whose
  executing-work and testing-discipline skills own the red-first proof, the baseline, the
  heavy-process claim and the Chapter; reversal: a paragraph naming each.
- assumed 2026-09-22 (the architect): the queue block lists at most twelve entries, since the
  block rides every external prompt; reversal: one constant.
- assumed 2026-09-22 (the architect): a plan entry's completion on merge is the plan-health plan's
  existing behavior and needs nothing here, on the evidence that DEV-PLUGIN's plan 8 read
  `complete` after PR 90 merged; reversal: a section restating that rule.
- assumed 2026-09-22 (the architect): the plugin's own submits, nudges among them, bypass the
  `prompt.submit` handler as its comment says, so the queue block rides external prompts only,
  which is where a worker reads its queue after a compaction or a relaunch; reversal: the block
  also joins the nudge frame.
- The plan review ran at fable and effort high and returned READY_WITH_FINDINGS, two Major and
  four Minor, all applied. The blind read returned 5 questions and 4 comprehension gaps: 9 answered in the spec, 0
  assumed, 0 asked; its report that the reminder comment is absent was checked and the comment is
  at `hooks/index.ts:8081`. The gating litmus: 3 definitions after reconciling, the Files in
  scope lists, the `openGoals` set and the twelve-line budget; 2 one-sided, the set and the
  budget, which the reader counted as parts of the bounded block and the author did not, and the
  reader's count stands; 0 crossed, 0 unplaced, 0 under-length, since the budget's one pair is all
  a count threshold yields.

## Operator Verification

- After the pull request merges and the installed plugin copy is updated, the next plan the
  coordinator queues to any worker reads `pending` in that worker's goal status, and the worker
  starts it on the tick after the current plan completes with no word from anyone.

## Chapters

### Chapter 1 - 2026-09-23
Completed: 1. The queue block and the idle helper
Implemented By: implementer-opus
Metrics: review rounds 1, closed major-closed; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
  - Section 1 open: adds openGoals, nextStartableLeaf and hasStartableWork to hooks/agent-state.ts and replaces the paused one-liner with a [GOAL QUEUE] block; serves the Goal sentence "a persona whose tree holds only paused or blocked work reads that queue in every prompt and counts as idle"; adds three pure helpers and one injected block, each named by design points 1 and 2, so no mechanism outside the plan; size about 60 lines of code and one ledger entry; not building it leaves an all-paused persona reading one stale reason.
  - Implementer, mid-work: adds a stored-tree recorder, storedGoalTrees, to .kit/tick-harness.mjs; serves acceptance bullet 1, "on every tick-suite fixture with no active node hasStartableWork is true exactly where activateNext ... activates a node"; test-only, so it adds no plugin mechanism; 21 lines; not building it limits the agreement check to hand-picked fixtures and misses the 101 cases that write the store directly.
  - The header moved from Ready to In Progress at the start of this run.
  - `activateNext`'s walk from the root is now `nextStartableLeaf`, moved out unchanged, and one module-level `orderKey` serves the walk and `openGoals`.
  - The ledger entry `GOAL_TREE_PAUSED_BLOCK` (94 characters) is replaced by `GOAL_QUEUE_BLOCK` (243 characters). The sized text is the header line and both closing sentences, joined by one line break a prompt never carries, so the duplicate check reads them as two sentences.
  - The overflow line reads "entry" for one remaining and "entries" for more, where the brief's template read "entries" for both.
  - An entry reading `active` that `activeGoalId` does not name makes `hasStartableWork` true, so the block would close on "starts on the controller's next tick" where nothing starts. Design point 1 states the rule this way, and roots never read active (`hooks/agent-state.ts:606`, `hooks/index.ts:6805`), so the gap is left as the plan wrote it.
Assumptions:
- assumed 2026-09-23 (the orchestrator, section 1): the entry line reads `- <status> <kind> <id> | <title cut to 40>`, with ` | <reason cut to 60>` where a reason is set, and the overflow line reads `...and <n> more open entries.`, with "entry" for one; reversal: the template in the `prompt.submit` handler and its pins.
- assumed 2026-09-23 (the orchestrator, section 1): `hasStartableWork` counts any node reading `active` literally, as design point 1 states; reversal: one line in `hooks/agent-state.ts`.
Review Findings: review: adversarial and blind at fable, Agent tool, low effort; security at fable, Agent tool, medium effort. Blind Major, "the closing line is wrong while an ask is open": justified-not-fixed, orchestrator-made trace to acceptance bullet 2. `prompt.submit` closes any open ask and reactivates the asked entry before the block is built (`hooks/index.ts:8051-8072`), so an open ask never reaches the block. Security lens ran with its threat model absent, because `docs/security-model.md` is on PR 80's branch and not yet on main. Minors: 2 fixed in the close pass (the helper-mutation check compared an array with itself and now compares with a snapshot taken first, proved red by a probe that sorted the tree in place, which also failed the item2 live-plan check, exit 2, the file restored byte-identical from its copy; the overflow line's grammar). 0 upgraded. 4 left with the reason: title and reason text spliced with a length cut only, the same shape `[GOAL TREE]` has, routed to `docs/backlog.md` because the guard belongs at the shared boundary for both blocks; the all-paused line names `goal_resume` first while `goal_resume` does not check an open ask, routed to `docs/backlog.md` because the design gives that sentence verbatim and the check belongs to `goal_resume`; the orphaned active entry, above; a blocked root with no open children gets no block, which was silent before this change too and has no live path that pauses a root (`hooks/index.ts:7110`). The close-pass delta was checked by author re-read.
Stamps: adjudicated 2, stamped 1 (`forward-resource-arrangements-into-dispatch-briefs`, operator tier, for the brief's wait on the baseline gate); `pr-ready-mark-is-the-reviewers-after-verification` skipped as not applied in this section.
Gate: targeted lane at close, on the worktree at 25b5746 plus the close-pass edits, 2026-09-23 on SCOTT-CLAUDE with no foreign test runner live. `npx tsc --noEmit` exit 0; `node .kit/controller-tick-test.mjs` exit 0, 2608 OK and 0 FAIL, against a baseline of 2592 OK and 0 FAIL on the same lane at e154b09; `node .kit/injection-duplicate-test.mjs` exit 0; `node .kit/injection-ledger.mjs` exit 0, its output equal to the committed JSON. The whole offline gate's baseline at e154b09: 25 of 25 lanes exit 0. Test delta: 6 cases added, 1 edited, 0 retired, none spawning a process. `caseGtc4_thePausedReminderNamesReplaceTrue` now pins the all-paused queue block. `caseIq_theQueueBlockListsEveryOpenEntryInActivationOrder` pins three entry lines in `sortKey` order, with status first and the 40 and 60 cuts. `caseIq_theDevPluginShapeIsIdleUntilOneIsResumed` pins `hasStartableWork` false for the DEV-PLUGIN shape and true after `goal_resume`. `caseIq_theHelpersReadTheControllersWalk` pins `openGoals`' flat order, a pending leaf under a paused plan read as unstartable, and that the helpers leave the tree unchanged. `caseIq_thirteenOpenEntriesListTwelveAndACount` pins twelve lines and the count. `caseIq_theEmptyAndActiveTreesKeepTheirBlocks` pins `[NO GOAL]` alone on an empty tree and `[GOAL TREE]` alone on an active one. `caseIq_theHelperAgreesWithActivateNextOnEveryStoredTree` pins the helper against `activateNext` on 110 stored trees with no active node, 37 startable and 73 idle. The harness gains `storedGoalTrees` for that sweep.
Next: 2. The coordinator queues pending, and the priming names the whole tree
Commit Model: Branch-and-PR
Delta: taken 2026-09-23 on SCOTT-CLAUDE in D:/agent_persona-idle;
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-23
Completed: 2. The coordinator queues pending, and the priming names the whole tree
Implemented By: main session (Locus: inline, recorded under the section's Model line, since the section writes under docs/)
Metrics: review rounds 3, closed major-closed; provenance 2 spec-traceable, 2 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
  - Section 2 open: changes the coordinator instruction, both PRIMING_BODY lines and the goal_edit description to say queued work stays pending, plus a README rule, an actuator-list mention and an architecture failure-modes row; serves Design points 3 and 4 and the section's acceptance bullets; adds no mechanism (text only); size about 6 sentences of injected text and 3 doc passages; not building it leaves coordinators queuing plans as paused, the DEV-PLUGIN plan 9 shape.
  - Round 1 blind Major (resume in sortKey order displaces the active plan): changes the coordinator instruction's last queue sentence to have the worker drop the wrongly paused entry and goal_add it again as pending, in sortKey order; serves acceptance bullet 1 ("what to do with a paused entry carrying a release condition"); adds no mechanism (text only, goal_edit drop and goal_add already exist); size one sentence, about 30 words; not building it has coordinators tell workers to goal_resume a queued plan, which pauses the running plan with a release-shaped reason.
  - Round 2 Major (drop leaves a plan's open tasks orphaned): adds one sentence to the coordinator instruction, the README paragraph and the architecture row saying a drop does not reach children, so open tasks are dropped first; serves acceptance bullet 1; adds no mechanism (text only, no cascade built); size one sentence per surface, about 20 words each; not building it has a re-queued plan leave tasks open forever, listed in the queue and holding the planner off.
  - Round 2 Major (goal_edit description says a drop is only for work that will not be done): widens that clause to name the re-queue case and the children limit; serves acceptance bullet 3; adds no mechanism; size about 25 words; not building it has a worker's tool contract contradict the coordinator's steer.
  - The design's own repair was wrong. Design point 3 told the coordinator to have a worker resume a wrongly paused plan in order, but `goal_resume` pauses whatever entry is active (`hooks/index.ts:7449-7461`), so it would swap the running plan out. Both round 1 lenses found it independently. The shipped repair drops the entry and adds it again as `pending` with the same `planPath`, dropping its open tasks first because a drop does not reach children (`hooks/index.ts:7117-7135`). `goal_add` sets no sort key (`hooks/index.ts:6979-6998`), so re-adding in the old order keeps the queue order. Approach points 2 to 4 are updated to the shipped wording; design intent is unchanged.
  - The priming line now reads "If a goal tree holds open entries, resume the tree from goal_status whether or not an entry is active, and leave a paused entry for the operator or the coordinator to release". The design's "exists" also named a finished tree, and "resume it" read as a call to `goal_resume` on stuck work, which the Intent refuses.
  - The queue block's idle line from section 1 now reads "every open entry is paused, blocked or out of the controller's reach". The old "paused or blocked" was false for a pending entry under a paused parent or a pending plan whose tasks are all abandoned.
  - Folds widened the Files in scope line: `hooks/index.ts` for that closing line, `.kit/controller-tick-test.mjs` for its pin, and `hooks/agent-state.ts` for the `hasStartableWork` comment. This is approval drift above `## Chapters`, recorded here.
  - Riding outside the section: `docs/security-model.md` lost three sentences on the relay's confirm-first instruction, on the operator's word on 2026-09-23, in its own commit d0f7f88. The five-repositories backlog entry records the operator's 2026-09-23 decision to add the review rule later. The "No goal verb returns a paused entry to pending" entry now names the drop-and-re-add workaround and its cost.
  - main was merged in (a201bd1) to bring PR 80's security model onto the branch; the one conflict, `docs/backlog.md`, kept both sides' live entries and dropped the retired tree-lag entry. That merge took the whole gate: 25 of 25 lanes exit 0, gate.exit 0, SCOTT-CLAUDE at 2026-09-23T11:20Z, clean worktree at a201bd1.
Assumptions: none
Review Findings: review: code pair at fable, Agent tool (round 1); review: adversarial at opus, Workflow high (rounds 2 and 3). No Critical in any round. Round 1 Major (resume swaps the active plan) fixed in de25c8b, spec-traceable, the blind copy traced by the orchestrator to acceptance bullet 1. Round 2 Majors: drop orphans open tasks, and the goal_edit description contradicts the repair, both fix-introduced and fixed in f807fde. Round 2's third Major, that the section-1 string changed without an amendment record, states no failure scenario and was downgraded to a Minor claim; it is dispositioned by the fold record above. Round 3 Major (priming "resume it" invites a blind goal_resume) is spec-traceable to the Intent's refused blind resume, fixed at close. Minors: 9 fixed (1 in round 1's fix, 4 in round 2's, 4 at close), 1 upgraded to round 3's Major, 2 left with the reason. README's "says whether anything will start" is true at prompt time, because prompt.submit closes an open ask and reactivates its entry before the block is built (`hooks/index.ts:8051-8072`). reprioritize sorting ahead of finished siblings is harmless for activation and outside this plan, whose Out of Scope keeps activateNext's behavior. The close delta (one clause per surface) owed no round under the fix-delta bar: no outward action, no new module, and the ledger and duplicate tests read the text. The orchestrator re-read it as author, not as a round.
Stamps: adjudicated 1, stamped 0 (pr-ready-mark-is-the-reviewers-after-verification was read and changed nothing built here)
Gate: targeted lane at close: tsc, check-loader-rule, channel-reply-instruction-test.sh, supervisor-model-test.sh, injection-duplicate-test.mjs, tool-description-length-test.mjs, controller-tick-test.mjs, each exit 0, 93 s wall, SCOTT-CLAUDE at 2026-09-23T12:05Z on the idle-queue worktree at f807fde plus the close delta, no foreign suite running. Baseline on the same lane before the section: all exit 0, so no change. Test delta: 0 added, 0 retired, 1 edited (the tick suite's `IQ_IDLE_LINE` pin, twice, following the queue block's closing line, pinning the all-paused block's exact text). Ledger refreshed and byte-fresh against `node .kit/injection-ledger.mjs`.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: SCOTT-CLAUDE, 2026-09-23T12:07Z, idle-queue worktree before the close commit
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
