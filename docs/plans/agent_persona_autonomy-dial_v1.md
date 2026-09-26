# Autonomy dial

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

When this is done, every persona carries one operator-set autonomy level, closed at three values,
that says what it may do with work it found on its own, and every external prompt carries a
standing block that states the idle order, names the goal tree as the queue, and states that
level in one sentence. The plugin's gate on starting a new effort reads the same field the block
prints, so the written permission and the enforced one cannot drift apart. It matters because
today the standing duty "finish the active work, then the queued work, then the backlog" lives
only in memory files of two seats, nothing re-injects it after a compaction, and the operator can
widen a persona's autonomy only by rewriting doctrine that applies to every persona at once.

## Dispatch Authorization

The operator agreed to every item in the brief at
`D:\personas\ASSISTANT\briefs\persona-idle-queue-and-autonomy.md` on 2026-09-22, on the ASSISTANT
channel, and asked that it go to the architect through the coordinator. The coordinator relayed it
as record `ARCHITECT-8d67c288-dd78-478d-a565-e390d50027b0-15`, quoting the operator: "Please
proceed. Send everything to Steward for architect. Let's get this in action." This plan carries
the brief's items 4, 5 and 6. Items 1 to 3 are `docs/archive/agent_persona_idle-queue_v1.md`.

Execution waits on the coordinator handing this plan to a worker by name. A worker that finds this
plan in its own queue has that handoff. This plan starts only after two plans have merged to
`origin/main`, read after a fetch: `docs/plans/agent_persona_goal-levels_v1.md`, whose turn-origin
gate and idle proposal this plan extends, and `docs/archive/agent_persona_idle-queue_v1.md`, whose
helper the standing block reads. The check has two halves, both read at `origin/main` after a
fetch: `git ls-tree --name-only origin/main docs/plans/` lists neither file, and each file is
present under `docs/archive/` or `docs/plans/archive/` with a `Status: Complete` header line,
read with `git show origin/main:<archived path>`. A file that is in neither place has not merged,
and a worker that finds either plan still listed, or absent from both archives, stops with a
`BLOCKED:` lead naming it.

## Intent

The frame, in the operator's words from the brief. The idle order is standing doctrine, stated
once and re-injected on every prompt. What a persona may do on its own is an autonomy dial, per
persona, that only the operator sets, with three levels: propose, which is today's behavior; plan
and ask; and plan and start. Long-term goals stay outcomes and carry no authority. The dial is
neither a goal, because a persona may propose its own long-term goals and a goal that carried
authority would let it propose its way into more permission, nor doctrine, because doctrine is
fleet-wide and changes only with a release.

Done means the level lives in the persona's own store, is written only in a turn the operator
started, shows in the goal status, and is read by exactly two things: the gate on `goal_add` with
kind `plan`, and the standing block. Each level is one sentence in the block, and the gate does
what the sentence says. An entry queued at plan and ask waits for the operator's word in fact and
not only in prose: the persona cannot resume it itself.

Done does not need a fourth level, a level that reaches `goal_create` or the long-term goal tool,
a level set by the coordinator or by the persona itself, a roster field, a keeper restart, or
knowledge in the plugin of which work a persona is competent to plan. The line between a
persona's own work and a proposal stays the goal-levels plan's: whether the work needs a new plan
document.

Alternatives refused:

- A roster field for the level. Refused, because the roster is read at keeper start, so every
  change restarts the persona, and the goal-levels plan refused the same home for the same reason.
- A level that widens `goal_create`. Refused, because the root is the operator's objective, and a
  persona that opens its own root has left its space.
- A level that lets a persona adopt its own long-term goal. Refused, because the operator's ruling
  1 under goal-levels keeps adoption on the operator's yes.
- The coordinator setting the level on the operator's relayed word. Refused by the architect,
  because a coordinator delivery turn is the one turn kind the goal-levels gate admits beside the
  operator's, so admitting it here would make the two grants indistinguishable in the store. The
  operator may overrule this by naming the relay as a setting channel.
- A kit-side line in the claude-kit session-start output naming the persona goal tree. Refused,
  because that hook cannot tell a persona session from any other without a new contract between
  the two plugins, and the standing block already rides every external prompt.

Rulings: none at the write.

Provenance: distilled from the operator's brief of 2026-09-22 and the architect's read of
`hooks/index.ts`, `hooks/agent-state.ts`, `bin/supervise.sh` and the goal-levels plan at
`origin/main` `9d0e317` the same day.

## Related plans

- `docs/plans/agent_persona_goal-levels_v1.md` (Ready, waits on keeper-park). Section 4 builds the
  turn-origin capture and `turnMayStartEffort`, which this plan's section 2 extends, and section 5
  builds the idle proposal, whose frame this plan's section 3 branches on the level. Section 3
  builds `goal_longterm` beside which the dial tool registers.
- `docs/archive/agent_persona_idle-queue_v1.md` (Complete, archived). Its `hasStartableWork` is what the standing
  block reads to choose its idle sentence.
- `docs/plans/agent_persona_security-model_v1.md` (Ready). The dial is a store field, and the
  persona store is writable by any process under the operator's account, which that model
  accepts. This plan adds no guard on the file.

## Approach

**Decisions settled at the finalize**, by the architect on 2026-09-22, on the brief's open items.

- The dial lives in the persona's store, as `autonomy` on `AgentState`, written by one tool that
  runs only in the operator's own turn. This is the home the goal-levels plan gave the long-term
  goal, for the same reasons: no keeper restart, one record beside the tree, and the gate and the
  block read one field.
- The dial governs exactly one act, `goal_add` with kind `plan`. Everything else the goal-levels
  gate refuses stays refused at every level.
- An entry waiting for the operator's yes carries a flag on the node, `awaitingYes`, and
  `goal_resume` refuses that entry outside an operator or coordinator turn. The flag is what makes
  the wait real, since `goal_resume` is otherwise allowed in every turn and the idle-queue plan's
  queue block tells a persona on an all-paused tree to resume one. The level itself is still read
  by two things; the flag is a third read of the tree, not of the level.
- The kit side gets no line. The standing block is the one owner of the sentence that names the
  goal tree as the queue.
- The levels are named in the store as `propose`, `plan-and-ask` and `plan-and-start`, and the
  default for a store with no field is `propose`.

**Vocabulary.** An owner session is the one live session holding a persona's claim, armed
`owner`; a reader session is armed `reader` and owns no tree. The coordinator persona is the one
`coordinatorPersona` names, which this fleet calls the steward. A priming turn is the
`[SUPERVISOR-PRIMING]` turn the supervisor writes at every launch. A nudge turn is one the
controller submits itself. A coordinator delivery turn is one the tick's drain opens to deliver a
record under the `COORDINATOR` ground. The keeper is the boot-time process that launches each
persona's supervisor from the roster. `sendPluginRecord` is the inbox-writing helper the
goal-levels plan's section 1 adds to `hooks/operator.ts`.

**What exists today, and what goal-levels adds.** Read at `origin/main` `9d0e317` on 2026-09-22.
Line numbers move, so find each site by the names given.

- `AgentState` in `hooks/agent-state.ts` carries the tree, the memory and the monitor, and
  `parseState` backfills fields a stored version lacks. The goal-levels plan adds `longTermGoals`
  the same way, and its section 3 registers `goal_longterm` inside the `arming !== "reader"` gate.
- The goal-levels plan's section 4 captures the prompt's origin kind at turn start and adds
  `turnMayStartEffort()`, which allows the four effort-starting acts only in the operator's turns
  (origin kinds `composer`, `bridge`, `channel`, `sdk`) and in coordinator delivery turns, and
  refuses every other turn with one shared text naming `agentic_say` and `[PROPOSAL]`.
- The goal-levels plan's section 5 submits a `[PROPOSE]` turn once a day to a persona with a
  long-term goal and no open node, telling it to send a `[PROPOSAL]` record and start nothing.
- The `prompt.submit` handler in `hooks/index.ts` builds the context blocks an external prompt
  carries: `[GOAL TREE]`, the queue block the idle-queue plan adds, `[NO GOAL]`, `[ENV]`, the
  lesson and memory blocks. Each fixed literal has an entry in `.kit/injection-ledger.json`.
- `goal_status` renders the tree and, after goal-levels, the long-term goals under a heading.
- The coordinator's instruction in `bin/supervise.sh` names the record leads it acts on, and the
  goal-levels plan's section 2 adds `[FINDING]` and `[PROPOSAL]`.

**The design.**

1. `AgentState.autonomy` is one of `propose`, `plan-and-ask` or `plan-and-start`. `parseState`
   fills an absent field with `propose`, `createDefaultState` writes `propose`, and the state
   version stays as it is. A stored value outside the three is read as `propose` and logged once
   as `autonomy_invalid`.
2. `goal_autonomy` registers beside `goal_longterm`, in the same reader gate. It takes `level`,
   closed at the three values, sets the field, logs `autonomy_set` with the old and new values,
   and returns the new level. It is allowed only in a turn whose captured origin kind is one of the
   operator's four; a coordinator delivery turn, a priming turn, a nudge turn and every other turn
   are refused with a text saying the level is the operator's to set on this persona's own thread.
   The tool decides in `turnMayStartEffort`'s order with the coordinator branch removed: a
   priming turn is refused, a turn that matched an expected turn is refused whatever its ground,
   and any other turn is allowed only on one of the operator's four origin kinds. So a nudge or
   delivery turn that opens while the one-step origin handoff still reads `channel` is refused.
   Its description states the three levels in one sentence each, that only the operator's own
   turn may call it, and that the level governs `goal_add` with kind `plan` and nothing else.
   `goal_status` prints `Autonomy: <level>` on its own line above the long-term goals, whether or
   not a tree exists, ahead of the no-tree sentence where there is none.
   The tick suite, `.kit/controller-tick-test.mjs`, is the suite that exercises
   `hooks/agent-state.ts`; no `.kit/*-unit-test.mjs` file covers it.
3. `turnMayStartEffort` takes the act as an argument. For every act but `goal_add` with kind
   `plan` it decides as goal-levels states. For that act it reads the level. At `propose` it
   decides as goal-levels states. At `plan-and-ask`, any turn may add the plan, where any turn
   means every turn kind the goal-levels gate refuses at `propose`, the priming turn and a
   delivery under a `WORKER:` or `READER:` ground among them, and the handler
   creates the entry `paused` with `blockedReason` reading `Awaiting the operator's yes` and
   `awaitingYes` set on the node, sends one `[PROPOSAL]` record to the coordinator persona through
   `sendPluginRecord` whose text names the entry id, the title and the `planPath`, and logs
   `plan_awaiting_yes`. Where the record cannot be written, because the write fails or the reach
   rule refuses it, the add is refused with a text naming the cause, so no entry waits on a word
   nobody heard. `goal_resume` on a node with `awaitingYes` set is allowed only in an operator or
   coordinator turn, decided by `turnMayStartEffort` with the act `goal_resume`, and refused
   elsewhere with a text saying the entry waits for the operator's word; a resume that is allowed
   clears the flag, and `goal_edit drop` clears it too. A `goal_resume` call with no `nodeId`
   outside those turns selects among unflagged paused nodes only, so an older paused entry stays
   resumable beside an awaiting one. `goal_resume` on any other node is ungated as today. At
   `plan-and-start`, any turn may add the plan, created `pending` and made `active` in the same
   turn by the handler's own activation where the tree had no active leaf, as at the base commit,
   and the handler sends one `[STARTED]`
   record to the coordinator persona naming the entry id, the title and the `planPath`, and logs
   `plan_started_unprompted`. In an operator or coordinator turn the handler behaves as goal-levels
   states at every level, so the operator queuing work is never turned into a proposal.
4. The standing block opens `[STANDING]` and rides every external prompt the `prompt.submit`
   handler decorates, gated on `arming !== "reader"` exactly as the goal blocks beside it are, so
   an owner-armed session that holds no claim carries it too. It sits after the goal blocks and
   before `[ENV]`. It is three sentences. The first is the idle order:
   "Finish the active entry, then the next queued entry in your goal tree, then your backlog." The
   second names the queue: "Your goal tree is the queue; read it with goal_status." The third is
   the level's sentence, which the ledger holds as one literal per level. Each opens by scoping
   the level to work the persona finds on its own, since the block also rides the operator's own
   turns, where the level does not bind. At `propose`: "Autonomy: propose. For work you find on
   your own, outside the operator's request, you may only propose: send a [PROPOSAL] record to
   the coordinator and start nothing until it comes back as a queue entry." At `plan-and-ask`:
   "Autonomy: plan and ask. For work you find on your own, outside the operator's request, you
   may write the plan document and queue it with goal_add; it waits paused until the operator's
   yes reaches you. With no goal tree, send a [PROPOSAL] instead, since only the operator or the
   coordinator opens a tree." At `plan-and-start`: "Autonomy: plan and start. For work you find
   on your own, outside the operator's request, you may write the plan document, queue it and
   start it; the plugin tells the coordinator. With no goal tree, send a [PROPOSAL] instead,
   since only the operator or the coordinator opens a tree." Where `hasStartableWork` is false
   and `openGoals` is not empty, the
   block adds one sentence: "Nothing in your tree starts by itself, so you are idle for these
   duties." A tree holding only complete or abandoned entries has an empty `openGoals` and gets no
   idle sentence. The two fixed sentences, the three level sentences and the idle sentence are one
   ledger entry each, and a clause two level sentences share (the own-work opening, the no-tree
   close) is one literal of its own with one ledger entry, since the duplicate check refuses the
   same text written twice.
5. The `[PROPOSE]` frame the goal-levels plan builds branches on the level, held as one more
   literal per level. At `propose` the frame reads as goal-levels states: send the `[PROPOSAL]`
   with `agentic_say` and start none of it. At `plan-and-ask` it tells the persona to write the
   plan document and queue it with `goal_add`, and that the entry waits for the operator's yes.
   At `plan-and-start` it tells the persona to write the plan document, queue it and start it. At
   both, the frame's own `agentic_say` send rides only in the no-tree clause, where the persona
   holds no tree and sends the `[PROPOSAL]` instead, since `goal_add` already sends the
   coordinator a record for a queued plan.
6. The coordinator's instruction gains the `[STARTED]` lead: tell the operator in one line which
   persona started what, and note it on the board. For a `[PROPOSAL]` that names a `planPath` and
   an entry id, the operator's yes is relayed as a coordinator record telling the worker to
   `goal_resume` that entry where it holds no active entry, and otherwise to `goal_edit drop` it
   and `goal_add` it again as a pending plan with the same `planPath`, so the yes never pauses
   the worker's active entry. A no tells it to `goal_edit drop` it with the reason. The
   idle-queue plan's sentence that a paused entry carrying a release condition is a queue mistake
   gains one exception: an entry whose reason reads `Awaiting the operator's yes` waits for the
   operator's word and is never resumed on the coordinator's own initiative. `[STARTED]` joins the
   gate's excluded-lead list beside `[FINDING]` and `[PROPOSAL]`. No tool checks which lead a
   persona's own `agentic_say` opens with, and this plan adds no such check.

## Standing Brief Amendments

- Section 2: a plan add that sends a `[PROPOSAL]` or `[STARTED]` record sends it only after the entry is saved, so the coordinator's inbox never holds a record naming an entry the store does not hold.
- Section 2: `goal_edit drop` on an entry awaiting the operator's yes, and `goal_done` by name or `goal_resume` on that entry or on a node under it, are refused outside a turn the operator or the coordinator persona started, and allowed in those turns, where they clear the entry's wait. This supersedes the Approach's "`goal_resume` on any other node is ungated as today" for a node under an awaiting entry. No node under an awaiting entry starts by itself, and any completed node loses the flag, so `hooks/agent-state.ts` gains the shared walk `awaitingEntryAtOrAbove`, `clearSettledAwaiting` called from `completeLeaf`, the `AWAITING_YES_REASON` constant, and a filter in `activateNext`, beyond the `awaitingYes` field.
- Section 4: `docs/security-model.md` is in scope. Its sentences on the effort gate are rewritten to match the code: the gate reads the operator-set level for `goal_add` of a plan and nothing else, it decides five acts through its act list and refuses two more directly, a drop or a by-name completion of an entry awaiting the operator's yes outside those turns, the evidence-not-instruction rule is what defends a plan add a nudge turn makes at `plan-and-ask` or `plan-and-start`, and `goal_add` writes `[PROPOSAL]` and `[STARTED]` records through `sendPluginRecord` without a tool call.
- Section 3: each `[STANDING]` level sentence is scoped to work the persona finds on its own, outside the operator's request, and the no-tree clause the plan-and-ask and plan-and-start sentences close on says that only the operator or the coordinator opens a tree.

## Sections of Work

The four sections run in order as commits on one work branch cut from `origin/main`, named by the
worker, with this plan file on it, and finishing-work opens the one pull request.

### 1. The dial in the store and the tool that sets it
Model: opus

Design points 1 and 2. The tool-count pin in `.kit/controller-tick-test.mjs` rises by one from
the baseline the first Chapter records, `.claude/types/claude-code-mcp.d.ts` declares the tool's
input by hand in the form its neighbors use, and the ledger carries `goal_autonomy_description`.

Tests: lock both directions of the tool's turn gate, an operator-origin turn that succeeds and a
coordinator delivery turn that is refused, since a level the coordinator could set is the
distinction the brief draws; lock the backfill, a store with no field reading `propose` and a
store with `plan-and-start` keeping it across a restart and across `goal_create`; lock the
invalid-value read.

Acceptance:
- In a `channel` turn, `goal_autonomy` with `plan-and-ask` sets the field, logs `autonomy_set`
  naming `propose` and `plan-and-ask`, and `goal_status` prints `Autonomy: plan-and-ask`. In a
  coordinator delivery turn, a nudge turn, a priming turn, and a nudge turn opened just after a
  channel prompt so the origin flag still reads `channel`, the same call is refused, the field is
  unchanged, and the refusal names the persona's own thread.
- A level outside the three is denied and the denial lists the three.
- A store written before this section loads with `propose` and no version change. A store with
  `plan-and-start` keeps it across `goal_create` and across a restart. A store with `sometimes`
  loads as `propose` and logs `autonomy_invalid` once.
- The tool does not register in a reader-armed session.
- `node .kit/tool-description-length-test.mjs` and `node .kit/controller-tick-test.mjs` exit 0,
  and `npx tsc --noEmit` exits 0.

Files in scope: `hooks/agent-state.ts`, `hooks/index.ts` (the goal tool registrations, a new
handler, the `goal_status` handler), `.claude/types/claude-code-mcp.d.ts`,
`.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs`, `.kit/injection-ledger.json`,
`.kit/injection-ledger.mjs`.

### 2. The gate reads the dial
Model: opus

Design point 3. `turnMayStartEffort` gains the act argument and the level read, the `goal_add`
handler gains the two branches, `GoalNode` gains the optional `awaitingYes` flag, `goal_resume`
gains the refusal for a flagged node and clears the flag on an allowed resume, `goal_edit drop`
clears it, and the `goal_add` and `goal_resume` descriptions each gain one sentence saying so.
`[STARTED]` joins the gate's excluded-lead list only.

Tests: lock the ten cases below, since the level not doing what its sentence says is the drift
this plan exists to prevent. Cases 1 to 3, a nudge turn at each level: at `propose` the add is
refused; at `plan-and-ask` the entry is `paused` with the reason above and one `[PROPOSAL]`
record is in the coordinator's inbox naming the entry; at `plan-and-start` the entry is created
and one `[STARTED]` record is there, the entry reading `pending` or `active` as the handler's own
same-turn activation decides. Cases 4 to 6, a `channel` turn at each level creates the entry, in
that same status, and sends nothing. Case 7, a priming turn at `plan-and-start` behaves as case 3.
Case 8, `goal_create` and `goal_longterm add` stay refused in a nudge turn at `plan-and-start`.
Case 9, `goal_resume` on the flagged entry in a nudge turn is refused and the entry stays
`paused` with the flag set, since a persona resuming its own awaiting-yes entry is the drift the
review found. Case 10, `goal_resume` with no `nodeId` in a nudge turn, over a tree holding an older unflagged
paused entry and a newer flagged one, resumes the unflagged one.

Acceptance:
- Each of the ten cases in the Tests line holds, read from the tree and the coordinator's inbox
  in the fake store.
- A `plan-and-ask` entry resumed by `goal_resume` in a coordinator delivery turn becomes `active`
  with `activeGoalId` naming it and the flag cleared, and one dropped by `goal_edit drop` reads
  `abandoned` with the reason and the flag cleared.
- The refusal text at `propose` is the goal-levels text unchanged.
- The `goal_add` description states the three levels' effect, the `goal_resume` description
  states the refusal, and both ledger entries match.
- `node .kit/controller-tick-test.mjs` exits 0 and `npx tsc --noEmit` exits 0.

Files in scope: `hooks/index.ts` (`turnMayStartEffort`, the `goal_add`, `goal_resume` and
`goal_edit` handlers, the `goal_add` and `goal_resume` descriptions), `hooks/agent-state.ts` (the
`awaitingYes` field on `GoalNode` only), `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs`,
`.kit/injection-ledger.json`, `.kit/injection-ledger.mjs` where an anchor moves.

### 3. The standing block and the proposal frame
Model: sonnet

Design points 4 and 5. Runs after sections 1 and 2. Each sentence of the standing block is a
named literal with a ledger entry, and the block is assembled from them in the `prompt.submit`
handler. The `[PROPOSE]` frame's level sentences are three further literals, one per level.

Tests: lock that every external prompt of an owner-armed session carries exactly one `[STANDING]` block
and that it names the stored level, since a block that names a stale level is worse than none;
lock the idle sentence in both directions of `hasStartableWork`; lock that a reader session and a
nudge turn carry no block; lock the `[PROPOSE]` frame's sentence at each level.

Acceptance:
- An external prompt at each of the three levels carries one `[STANDING]` block whose third
  sentence is that level's text verbatim, after the goal blocks and before `[ENV]`.
- On an all-paused tree the block carries the idle sentence; on a tree with an active entry and on
  an empty tree it does not.
- A reader session's prompt carries no block. A nudge turn carries none.
- The `[PROPOSE]` turn at each level carries that level's sentence.
- `.kit/injection-ledger.json` carries one entry per literal, `node
  .kit/injection-duplicate-test.mjs` exits 0, and `node .kit/controller-tick-test.mjs` exits 0.

Files in scope: `hooks/index.ts` (the `prompt.submit` handler's context blocks, the `[PROPOSE]`
frame), `.kit/injection-ledger.json`, `.kit/injection-ledger.mjs`, `.kit/controller-tick-test.mjs`.

### 4. The coordinator's instruction and the documents
Model: sonnet
Locus: inline

Design point 6, and the documents. The coordinator's instruction gains the `[STARTED]` lead, the
yes-or-no relay for a `[PROPOSAL]` naming an entry, and the awaiting-yes exception to the
idle-queue plan's queue-mistake sentence, written to the register of the text around it.
`README.md`'s section on findings, proposals and long-term goals, which goal-levels adds, gains the
dial: what each level lets a persona do, how the operator sets it, and what reaches the operator
at each level. `docs/architecture.md` names `[STANDING]` beside the other per-prompt blocks and
states the level's effect on the gate where it describes the goal tools, since goal-levels has it
say there that the gate refuses every turn but the operator's and the coordinator's.

The Audience, Voice and Fact base lines below are inputs to the claude-kit plugin's prose
reviewer, which reviews this section's documents. `company` is that reviewer's name for plain
product documentation with no personal voice.

Audience: the operator, who knows the fleet and has not read the code; a worker session that
holds the repository and has no session context.
Voice: company.
Fact base: `hooks/index.ts`, `hooks/agent-state.ts`, `bin/supervise-holder.sh`, and this plan's Approach.

Must-answer questions. For the operator: what do I say on a persona's thread to change its level;
what does each level let it do without me; what reaches me at each level and from which thread;
why did a persona tell me a tool refused. For a worker: which turn kinds each act succeeds in at
each level; what the standing block says and when it carries the idle sentence.

Acceptance:
- The coordinator's priming text names `[STARTED]`, the one line to the operator, the
  `goal_resume` or `goal_edit drop` relay for a `[PROPOSAL]` naming an entry, and the exception
  for an entry whose reason reads `Awaiting the operator's yes`.
- Each question above is answered in the README section, and no sentence describes behavior this
  plan did not build.
- `.kit/injection-ledger.json` is refreshed, and `node .kit/injection-duplicate-test.mjs` and
  `node .kit/controller-tick-test.mjs` exit 0, each run after the process-list poll the kit's
  testing-discipline skill names under its Check the box rule. Those two are this section's whole
  gate; the supervisor model suite reads no instruction text and does not run for it.
- No em dash in either document's new text.

Files in scope: `bin/supervise-holder.sh` (the coordinator instruction), `.kit/injection-ledger.json`,
`.kit/injection-ledger.mjs` where an anchor moves, `README.md`, `docs/architecture.md`,
`docs/README.md` (this plan's line moves to the archive list when the plan closes), `docs/security-model.md`.

## Out of Scope

- A fourth level, and any level that reaches `goal_create` or `goal_longterm`.
- The board's rendering of the level in the discord-channels repository.
- A guard on the store file. The security model accepts any local process as inside the boundary.
- The kit plugin's session-start output.
- The goal-levels plan's own sections. This plan extends `turnMayStartEffort` and the `[PROPOSE]`
  frame after they exist and changes nothing else that plan builds.

## Assumptions

- assumed 2026-09-22 (the repository's other plans): the commit model is Branch-and-PR; reversal:
  one header line.
- assumed 2026-09-22 (the architect): the executing worker runs under the kit, whose
  executing-work and testing-discipline skills own the red-first proof, the baseline, the
  process-list poll before a suite and the Chapter; reversal: a paragraph naming each.
- assumed 2026-09-22 (the goal-levels plan): the operator's turns are the origin kinds `composer`,
  `bridge`, `channel` and `sdk`, as that plan's section 4 captures them; reversal: this plan's
  tool gate and its acceptance cases read whichever list that plan's first Chapter settles, and
  the Chapter here names the list read.
- assumed 2026-09-22 (the architect): a `plan-and-ask` entry waits `paused` rather than in a new
  status, since the idle-queue plan fixes `paused` as the state for an entry waiting on someone,
  which this one is; reversal: a fourth open status.
- assumed 2026-09-22 (the architect): the plugin's own submits bypass the `prompt.submit`
  handler, so the standing block rides external prompts only and the `[PROPOSE]` frame carries
  its own level sentence; reversal: the block also joins the nudge frame.
- assumed 2026-09-22 (the architect): the coordinator persona and the architect persona carry the
  block like any owner session, since neither is harmed by reading the idle order and the block
  is one line per sentence; reversal: a persona-name exclusion.
- The plan review ran at fable and effort high and returned NOT_READY on one Critical, three
  Major and two Minor, all applied: the Critical, that `goal_resume` is ungated so a plan-and-ask
  entry could be resumed by the persona itself, is answered by the `awaitingYes` flag. A second
  review after that rewrite returned READY_WITH_FINDINGS, two Major and nine Minor, all applied. The blind
  read returned 6 questions and 6 comprehension gaps: 12 answered in the spec, 0 assumed, 0
  asked; its dry run found the gate check passing for a plan that never merged, fixed
  above. The gating litmus: 6 definitions after reconciling, the closed level set, the four Files
  in scope lists, and the standing block's contents; 2 one-sided, the operator-turn origin list,
  which is the goal-levels plan's definition and not this plan's, and what the dial governs, which
  sorts acts rather than content; 0 crossed; 1 unplaced, the standing block's "external prompt of
  an owner session", placed by the Vocabulary paragraph; 0 under-length.

## Operator Verification

- After the pull request merges and the installed plugin copy is updated, say on one worker's
  thread that its autonomy is plan and start. Its goal status then shows `Autonomy:
  plan-and-start`, and its next external prompt's standing block says so. A refusal in that turn
  reopens section 1, since a channel turn is the operator's.
- Within a day of that worker next running out of work while holding a long-term goal, one line
  arrives on the coordinator's thread naming what it started, and its goal status shows the new
  entry as `pending` or `active`; either reading means it worked, since the controller activates a
  pending entry on its next tick.

## Chapters

### Chapter 1 - 2026-09-26
Completed: 1. The dial in the store and the tool that sets it
Implemented By: implementer-opus
Metrics: review rounds 1, closed major-closed; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- Section open (written at close, the open line was not written at dispatch): changes the persona store and the goal tools to hold and set one autonomy level; serves the Goal's "every persona carries one operator-set autonomy level, closed at three values"; adds no mechanism beyond what design points 1 and 2 name; about 130 lines across hooks/agent-state.ts and hooks/index.ts; not building it leaves the plan with no level for sections 2 and 3 to read.
- Implementer: goal_autonomy saves through persistOrRollBack, restoring the old level and dropping the autonomy_set line on a save that yields or throws; serves Acceptance bullet 1 ("the field is unchanged" on a refused call) and the brief's "a failed call leaves the stored field unchanged"; reuses the existing persistOrRollBack and dropDecision helpers, so no new mechanism; 4 lines; not building it writes the new level to the store while the tool reports "not saved".
- Round 1 Major (adversarial, orchestrator-traced to Acceptance bullet 4 "The tool does not register in a reader-armed session"): delete the check pinning goal_autonomy directly after goal_longterm in the registration list; serves that bullet by leaving its registration legs as the whole pin; adds no mechanism; -2 lines; not doing it leaves a check that goes red on any later registration reorder with nothing wrong.
- The Status header read `Ready` and now reads `In Progress`, set as this run started.
- The start check held at `origin/main` 9a907cc after a fetch. `git ls-tree --name-only origin/main docs/plans/` lists neither the goal-levels nor the idle-queue plan, and each reads `Status: Complete` under `docs/archive/`. The plan sits in this worker's own goal tree, which is its handoff.
- The operator's turns are the origin kinds `composer`, `bridge`, `channel` and `sdk`, read from `OPERATOR_ORIGIN_KINDS` in `hooks/index.ts`, the list the goal-levels plan settled.
- The tool's gate is a new predicate, `turnIsOperators`, beside `turnMayStartEffort`, which this section left unchanged. Section 2 rewrites `turnMayStartEffort`, and that is where the two share their priming and expected-turn checks, per the round-1 security Minor.
- The `goal_status` pins in four of the goal-levels section 3 cases now carry the `Autonomy: propose` line, since design point 2 changes that output. The owner tool count moved from sixteen to seventeen.
- Found work routed out: `goal_longterm` keeps an unsaved change in memory after a save that yields. It went to `docs/backlog.md` as its own entry, since the fix is to that sibling rather than to this plan.
Assumptions:
- assumed 2026-09-26 (default, section 1): `autonomy_invalid` is logged at the session-start load site, once per session start, and the later reloads in the same session stay silent. The next launch logs again while the store still holds the bad value, since only a saved write replaces it. Reversal: normalize the stored value with a write at session start for an owner.
- assumed 2026-09-26 (source: the goal_longterm sibling, section 1): a save that does not land denies with the sibling's "held by a live session; this write was not saved" text. Reversal: one constant.
- assumed 2026-09-26 (default, section 1): a `level` that is not a string, a list included, is denied as a level outside the three. Reversal: the `typeof` read in the handler.
Review Findings: review: adversarial + blind at fable, Agent tool, after "fable capacity: scoped 86%, 7d 69%, 5h 26% (account 8, fetched 36s ago) -> dispatch"; security at fable, Agent tool, after "fable capacity: scoped 86%, 7d 69%, 5h 26% (account 8, fetched 39s ago) -> dispatch"; performance at fable, Agent tool, after "fable capacity: scoped 86%, 7d 69%, 5h 26% (account 8, fetched 200s ago) -> dispatch". Tree unchanged across the round: the porcelain capture was empty before and after.
- Major (adversarial, trace orchestrator-made to Acceptance bullet 4): the check pinning `goal_autonomy` directly after `goal_longterm` in the registration list pinned a choice no clause asks for. Fixed by deleting it.
- Security verdict CLEAR, performance verdict CLEAR, blind APPROVED_WITH_CONCERNS, adversarial APPROVED_WITH_CONCERNS. No advisory Critical or Major.
- Minors: 3 fixed in the close pass, 0 upgraded, 6 left with the reason.
  - Fixed: the coordinator-delivery leg now runs through `autExpectRefused`, so it reads the turn's tool errors and the level after the turn closes (adversarial).
  - Fixed: a `level` inside a list no longer passes as a level. The handler reads only a string, and a new case was watched red on the old `String(...)` read, 2 failures, then passed (adversarial).
  - Fixed: the `autonomy_invalid` comment now says the log repeats at the next launch while the store holds the bad value (blind).
  - Left: the tool description and the refusal say "this persona's own thread" while the gate admits all four operator origins, sdk among them. That is the wording Acceptance bullet 1 asks for, and section 4's documents name the four origins (security, blind).
  - Left: `turnIsOperators` repeats two checks of `turnMayStartEffort`. Section 2 rewrites that function and takes the sharing (security).
  - Left: `persistOrRollBack` rethrows after rolling back, where `goal_longterm` keeps its change on the same throw. The sibling is the defect, and it went to the backlog (blind, adversarial).
  - Left: two new cases wait on `tickAndSettle(..., 50)`. That helper is what drives the tick, the suite uses it about fifty times, and `waitUntil` alone sends no tick (performance).
  - Left: three substring checks on the tool description. Design point 2 asks the description to state the three levels, the operator-only rule and the one governed act, and these checks pin that content (adversarial).
Stamps: adjudicated 3, stamped 1. tick-harness-state-is-loaded-at-creation-drive-handlers-to-change-it shaped the brief and the new cases' seeding. a-plugins-own-tool-call-re-enters-its-tool-call-hook bore on no line this section wrote, and function-hooks-prototype-ships-behind-a-flag was a read outside this section's work.
Gate: targeted lane at section close, measured 2026-09-26T01:27:53Z to 01:29:40Z on SCOTT-CLAUDE in the autonomy-dial worktree at bf3e285 plus the uncommitted close-pass fixes, with the process-list poll clear before the run. `npx tsc --noEmit` exit 0; `node .kit/tool-description-length-test.mjs` exit 0; `node .kit/injection-duplicate-test.mjs` exit 0; `node .kit/controller-tick-test.mjs` exit 0, 4522 OK, 0 FAIL, ending `PASS: 0 failure(s)`. Baseline on the same lane: 4432 OK and 0 FAIL at 9a907cc, measured 2026-09-26T00:53:38Z to 00:55:22Z. Test delta: 10 cases added, 0 retired, 5 checks edited. Each added case pins one requirement: an operator turn sets the level (Acceptance 1); every other turn is refused (Acceptance 1); composer, bridge and sdk turns admit it and a peer turn is refused (Acceptance 1); a level outside the three is denied, a list included (Acceptance 2); a store written before the level loads as propose (Acceptance 3); the level survives goal_create and a restart (Acceptance 3); an invalid stored level is logged once per session start (Acceptance 3); the tool registers for an owner and never for a reader (Acceptance 4); a non-owner and an unloaded store are refused by their own rules (Acceptance 1); a save that yields restores the old level (Acceptance 1). The edited checks: the owner tool count moved to seventeen, since the plan adds one tool, and four goal_status pins in the goal-levels section 3 cases gained the Autonomy line, since design point 2 changes that output. 0 added tests spawn a process, since the harness runs in process. Wall clock 1m47s against 1m44s on the baseline run. Contention was clear at the close run. At section 1's first green a foreign `node --test test/hook-dispatch.test.js` was live, PID 6708.
Next: 2. The gate reads the dial
Commit Model: Branch-and-PR
Delta: measured 2026-09-26T01:31:19Z on SCOTT-CLAUDE in the autonomy-dial worktree; exit 2
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 1 - 2026-09-26
- Section 2 (The gate reads the dial): first green committed as 6802bed and pushed. Review round 1 ran at fable through the Agent tool at frontmatter effort (adversarial, blind, security, performance). Its fix round is in flight. Sections 3 and 4 are not started.
- Live dispatch: implementer-opus, resumed for fix round 1. It was asked to save before sending the [PROPOSAL] or [STARTED] record, rolling the add back on a save that yields or a send that throws, and to refuse goal_edit drop on an entry awaiting the operator's yes outside operator and coordinator turns, each watched red first.
- Gate baseline: targeted lane at 6802bed content, measured 2026-09-26T01:55:39Z to 01:57:29Z on SCOTT-CLAUDE in the autonomy-dial worktree with the process-list poll clear. tsc, tool-description-length and injection-duplicate exit 0; controller exit 0, 4637 OK, 0 FAIL.
- Rulings adopted since the last boundary, by the scope adjudicator at fable: the record-before-save Major ACCEPT-AND-DECLARE, the drop Major ACCEPT-AND-DECLARE, and the security-model finding's relevance CONFIRM. The first two are the Section 2 entries in Standing Brief Amendments. The third adds `docs/security-model.md` to section 4.
- Next, per section: section 2 verifies the fix round, runs round 2 (one lens, adversarial at opus, high effort, through Workflow), runs the Minor close pass and the close gate, and writes Chapter 2. Then section 3.
- Queued after this plan, outside its scope, decided 2026-09-26 by the operator on the relay thread: remove the task list's goal-length budget, which is on main since PR 110. A short goal can carry a long list, so the block keeps only `TASK_LIST_MAX_LINES` and `TASK_TEXT_MAX_CHARS`, and the budget test case retires. Run it as a small fix at this plan's close, before goal-every-turn, and record the decision on the backlog entry "Task list: the operator's live check and the length-budget call". The plugin restart for schema 6 also rides at this plan's close.

### Chapter 2 - 2026-09-26
Completed: 2. The gate reads the dial
Implemented By: implementer-opus (one dispatch, resumed for four fix rounds and the close pass)
Metrics: review rounds 4, closed approved-with-concerns (round 4, no Critical, its two Majors fixed below the fix-delta bar); provenance 3 spec-traceable, 4 fix-introduced, 2 new-requirement, rulings (0 refused, 2 declared, 0 asked); advisory: 2 findings, 0 fixed in this section, 1 carried to section 4 on a relevance CONFIRM, 1 covered by a correctness finding, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- The add-decision lines for this section are in `.kit/scratch/autonomy-dial/add-decisions-section-2.md`, summarized here. The section changes the plan gate to read the stored level. Outside the operator's and the coordinator persona's turns, a plan add is refused at `propose`, queued paused with the `awaitingYes` flag and a `[PROPOSAL]` record at `plan-and-ask`, and queued to start with a `[STARTED]` record at `plan-and-start`. `turnMayStartEffort` takes the act and admits only the two named levels, so an unknown stored value fails closed.
- Save first, then send. An unprompted add saves the entry through `persistOrRollBack` and sends its record only after that save lands. A record that then cannot be written takes the node, any root reopening, the activation with the nudge fields `activate()` reset, and the add's decision lines back out through `rollBackAdd`, and saves again. Where that save also fails, the refusal names the entry id that may remain. The later save of the `plan_awaiting_yes` or `plan_started_unprompted` line is best-effort, since the entry and the record have both landed.
- An entry awaiting the operator's yes holds everything under it. One exported walk, `awaitingEntryAtOrAbove` in `hooks/agent-state.ts`, gates `goal_resume` (named and the no-nodeId pick) and `goal_done` by name on the entry or a node under it. `goal_edit drop` is refused on the entry itself. `activateNext`'s sibling pick skips a node under an awaiting entry. `completeLeaf` runs `clearSettledAwaiting`, so no completed node keeps the flag or the awaiting reason. In the operator's or the coordinator persona's turn, an allowed resume or completion under the entry clears the entry's wait, since that turn is the operator's word on it. A bare resume that passes over an awaiting entry names it, and the resume decision line records what admitted it.
- Every site that makes a goal node active or complete was swept twice: by the implementer in fix round 3, and independently by review round 4, which found no remaining path outside the operator's and the coordinator persona's turns. The sibling pick in `activateNext` was the one uncovered site.
- Approval drift: a `## Standing Brief Amendments` block was added above `## Sections of Work`. Its two Section 2 bullets were declared by the scope adjudicator in round 1. The orchestrator widened them in rounds 2 and 4 to cover `goal_done` and `goal_resume` under an awaiting entry. That supersedes the Approach's "`goal_resume` on any other node is ungated as today" for such a node, and widens this section's `hooks/agent-state.ts` scope beyond the one field. Its Section 4 bullet puts `docs/security-model.md` in scope, and Section 4's Files in scope gained that document.
- Found work: `goal_add` shares `goal_longterm`'s gap on every path but the unprompted plan add: a bare `persist($)` whose yield leaves the change in memory. The existing backlog entry was widened to name it. The two-writer race on one inbox sequence number, already in `docs/backlog.md`, now also covers the record this section sends.
- Queued outside this plan, decided by the operator on the relay thread: the task list's goal-length budget comes out, as a small fix at this plan's close, before the plugin restart for schema 6.
Assumptions:
- assumed 2026-09-26 (default, section 2): the plugin's own `[STARTED]` lead joins the leads that never open an effort-starting turn, beside `[PROPOSAL]` and `[FINDING]`. Reversal: `opensWithSeatLead` in `hooks/index.ts`.
- assumed 2026-09-26 (orchestrator ruling, fix round 3): an allowed resume or completion of a node under an awaiting entry, in the operator's or the coordinator persona's turn, clears the entry's wait and leaves it paused. Reversal: the two `awaitingAbove` blocks in the `goal_resume` and `goal_done` handlers.
Review Findings: round 1: adversarial, blind and security at fable, Agent tool, after "fable capacity: scoped 38%, 7d 29%, 5h 24% (account 4, fetched 117s/127s ago) -> dispatch"; performance at fable, Agent tool, once a slot freed under the three-Fable cap. Rounds 2 to 4: one adversarial lens each at opus, effort high, through Workflow on the Reviewer Dispatch template, since the writer tier is opus. Tree unchanged across every round: each porcelain capture was empty before and after.
- Round 1, adversarial APPROVED_WITH_CONCERNS: Major, the record was sent before the entry was saved (trace Section 2 Tests case 2, spec-traceable); fixed in fix round 1. Blind CHANGES_REQUIRED: the same defect (covered), and a persona could drop its own awaiting entry (orchestrator-traced, new-requirement, ACCEPT-AND-DECLARE by the scope adjudicator on the Intent's "waits for the operator's word in fact"); fixed in fix round 1. Security ADVISORY: Major, `docs/security-model.md` misstates the effort gate; relevance CONFIRM, carried to section 4 under the honesty route. Performance ADVISORY: Major covered by the save-first fix.
- Round 2, CHANGES_REQUIRED: `goal_done` by name completed an awaiting entry (spec-traceable, Intent); the decision line's second save could throw after a landed add (fix-introduced); the send-throws test never ran the rollback's hardest legs (fix-introduced). All fixed in fix round 2.
- Round 3, CHANGES_REQUIRED: Critical, a task added under the awaiting entry, then paused, resumed and completed, settled the entry through the cascade (spec-traceable, Intent). Fixed in fix round 3 by closing the class rather than the verb. A Major on two exact-wording description checks (trace none) was downgraded to Minor at adjudication, as a test over-pin with no failure on a reachable path, and fixed.
- Round 4, APPROVED_WITH_CONCERNS: Major, an allowed completion under the entry did not clear its wait as an allowed resume does (fix-introduced); Major, a "node under" description pin (fix-introduced). Both fixed in fix round 4 and judged below the fix-delta bar: in-process state under direct tests, no outward action, no new module. So no fifth round was owed.
- Minors: 16 recorded, 11 fixed in fix rounds 2 to 4 and the close pass, 1 moot, 0 upgraded, 4 left with the reason. Moot: the deny text after a sent record, since the record now follows the save. Left: the priming turn admitted at `plan-and-ask`, which design point 3 names; an awaiting add under a finished root reopens the root, goal-levels behavior this plan keeps; the four commons scans per unprompted add and the double predicate call, where the performance lens asked for no fix. Two restores in `rollBackAdd`, the nudge fields and the conditional active slot, carry no test, since neither is observable without an interleaved call.
- Close pass: an author re-read of the close-pass delta (`.kit/scratch/autonomy-dial/section-2/close-pass.diff`), including a check that no refusal fires between the by-name completion's wait-clear and `completeLeaf`.
Stamps: adjudicated 6 read in this section's window, stamped 0; none shaped a line this section wrote.
Gate: targeted lane at section close, measured 2026-09-26T03:15:08Z to 03:16:58Z on SCOTT-CLAUDE in the autonomy-dial worktree at 20fd97b plus the uncommitted fix round 4 and close pass, with the process-list poll clear. `npx tsc --noEmit` exit 0; `node .kit/tool-description-length-test.mjs` exit 0; `node .kit/injection-duplicate-test.mjs` exit 0; `node .kit/controller-tick-test.mjs` exit 0, 4725 OK, 0 FAIL, ending `PASS: 0 failure(s)`. Baseline on the same lane: 4522 OK, 0 FAIL at Chapter 1's close. The orchestrator re-ran each fix round's gate: 4637 at first green, then 4659, 4692 and 4721. The fix round 1 run overlapped a foreign claude-kit `node --test` suite and still passed. Test delta: 14 `caseAd2_` cases added, 0 retired, 1 existing check moved (the drop leg into a coordinator delivery turn). Red-first runs failed 12, 6, 12, 13 and 6 checks against the prior commit in turn, plus single-leg probes for each rollback leg, the sibling exclusion and the reason clear, each restored from a cmp-verified copy.
Next: 3. The standing block and the proposal frame
Commit Model: Branch-and-PR
Delta: measured 2026-09-26T03:17:13Z on SCOTT-CLAUDE in the autonomy-dial worktree; exit 2
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 3 - 2026-09-26
Completed: 3. The standing block and the proposal frame
Implemented By: implementer-sonnet (one dispatch, resumed for fix round 1); the orchestrator made the round 2 removal inline
Metrics: review rounds 2, closed major-closed; provenance 2 spec-traceable, 0 fix-introduced, 3 new-requirement, rulings (0 refused, 1 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- Section open: adds the [STANDING] block to every external prompt of a non-reader session and gives the [PROPOSE] frame one level sentence per level; serves the Goal's "every external prompt carries a standing block that states the idle order, names the goal tree as the queue, and states that level in one sentence"; adds no mechanism beyond design points 4 and 5 (one block assembly, one frame branch); about 60 lines in hooks/index.ts plus ledger rules and tests; not building it leaves the level enforced by the gate with nothing telling the persona what it may do.
- Round 1 Major (adversarial and blind, trace section 3 acceptance "The [PROPOSE] turn at each level carries that level's sentence" and design point 5's "send a [PROPOSAL] instead"; spec-traceable): at plan-and-ask and plan-and-start the frame drops its own agentic_say send sentence except as the no-tree fallback, so a persona with a tree queues with goal_add only and goal_add's record is the one the coordinator gets; serves design point 5 and the Intent's "the gate does what the sentence says"; adds no mechanism (the frame's text composition per level); about 15 lines; not doing it has a persona at plan-and-ask send two records for one plan, and at plan-and-start a request for work already started.
- Round 1 Major (adversarial, trace section 3 Tests "lock the [PROPOSE] frame's sentence at each level"; spec-traceable): replace the byte-for-byte frame pins with checks on the tokens a reader acts on at each level, plus the propose frame's "Start none of it yourself." and its agentic_say send; serves that Tests line without pinning wording the implementer chose; adds no mechanism; test-only, about 30 lines; not doing it turns the suite red on any rewording nothing else depends on.
- Round 1 Minor fix (blind), frame text only: at plan-and-ask the frame adds that where an entry of the persona's already waits for the operator's yes, it answers "No proposal."; serves the Intent's "An entry queued at plan and ask waits for the operator's word in fact"; adds no mechanism (a sentence; no guard in the ask gate); 1 line; not doing it leaves a daily plan document and paused entry while the first waits.
- Round 1 Major (blind, orchestrator-traced: no bullet; new-requirement; ruled ACCEPT-AND-DECLARE by the scope adjudicator at fable on the Goal's "what it may do with work it found on its own", bound acceptance bullet 1's slot): scope the three [STANDING] level sentences to work the persona finds on its own, outside the operator's request, and say the no-tree clause's "only the operator or the coordinator opens a tree"; serves that Goal sentence and the Intent's "the gate does what the sentence says"; adds no mechanism (three literals and one clause reworded); about 4 lines plus ledger and checks; not doing it has the block tell the persona, in the operator's own turn, that it may only propose, and that an entry the operator added waits paused. The finding's alternative (inject on controller turns instead) was REFUSED on acceptance bullet 3.
- Reversal: round 2 showed the fourth line above traced to nothing. The Intent clause it cited says a persona cannot resume its own awaiting entry and is silent on repeat proposals. The orchestrator withdrew that sentence, its ledger rule, the extractor only it used, and its check. The repeat-proposal concern went to `docs/backlog.md` with a gate-side remedy.
- Deviation, recorded in the spec: design point 4's quoted level sentences now carry the own-work opening and the "operator or the coordinator" no-tree clause, and design point 5 now says the frame's agentic_say send rides only in the no-tree clause at the two non-propose levels. Both are edits to the Approach, above `## Chapters`, made to match what shipped. The Section 3 entry in `Standing Brief Amendments` is the ruling's record.
- Ledger shape: a clause two level sentences share is one literal with one entry (`STANDING_OWN_WORK_LEAD_TEXT`, `STANDING_NO_TREE_FALLBACK_TEXT`), since the duplicate check refuses the same text twice. The frame's no-tree clause is a function, `proposeFrameNoTreeClause`, because it names the coordinator persona. `standingLevelSentence` is exported for the slot check.
- Merge note for finishing: main carries a `[TASK LIST]` block (PR 110) in the same `prompt.submit` handler, so the order of `[TASK LIST]` beside `[STANDING]` is settled at the merge.
Assumptions:
- assumed 2026-09-26 (default, section 3): the [PROPOSE] frame's plan-and-ask and plan-and-start sentences, which design point 5 describes without quoting, read "Write the plan document and queue it with goal_add; the entry waits paused until the operator's yes reaches you." and "Write the plan document, queue it and start it; the plugin tells the coordinator." Reversal: the two `PROPOSE_FRAME_*_TEXT` constants in `hooks/index.ts`.
Review Findings: round 1: adversarial and blind at opus, effort high, Workflow on the Reviewer Dispatch template (wf_378ac7ab-d2b), since the writer tier is sonnet. Round 2: adversarial at sonnet, effort high, Workflow (wf_11f92e6c-b1a). Advisory lenses not dispatched: the delta adds fixed text and two in-memory reads on the once-per-turn prompt path, with no input handling, spawn, store query or per-tool-call path. Tree unchanged across each round: the porcelain capture was empty before and after.
- Round 1, adversarial CHANGES_REQUIRED and blind CHANGES_REQUIRED. Major (both lenses, spec-traceable): the frame at plan-and-ask and plan-and-start still told the persona to send its own [PROPOSAL] beside goal_add's record. Fixed in fix round 1. Major (adversarial, spec-traceable): the frame tests pinned wording the implementer chose. Fixed in fix round 1. Major (blind, orchestrator-traced, new-requirement): the level sentence was unscoped and rode the operator's own turns. Held; the scope adjudicator at fable ruled ACCEPT-AND-DECLARE, after "fable capacity: scoped 48%, 7d 38%, 5h 4% (account 4, fetched 178s ago) -> dispatch"; GROUNDS checked on the plan (the Goal sentence exists verbatim; bullets 1 and 3 exist and cover the subject); fixed in fix round 1.
- Round 2, adversarial CHANGES_REQUIRED. Two Majors, trace none, new-requirement: the plan-and-ask "No proposal." sentence nothing asked for, and the check pinning it. Not held for a judge, because the orchestrator's own re-trace agreed the sentence traced to nothing: the lines were withdrawn, which is the finding's own remedy and adds nothing. Below the fix-delta bar (a removal, no outward action, no new module), so no third round was owed; author re-read of `.kit/scratch/autonomy-dial/section-3/close-pass.diff`.
- The orchestrator's red probe on fix round 1, since the implementer's red-first was a crash on a missing export: the plan-and-ask double-send restored and one own-work opening dropped turned exactly the two meant checks red (exit 2); restored from a copy, cmp identical, porcelain unchanged.
- Minors: 13 recorded; 8 fixed in fix round 1, 1 of them upgraded on a stated consequence (the ledger joined the propose arm after the frame's closing sentence, hiding it from the duplicate check); 1 moot (round 2's "queue nothing" against "send nothing" wording, gone with the sentence); 1 routed to `docs/backlog.md` (repeat plan-and-ask proposals while one waits); 3 left. Left: a non-owner owner-armed session reads the level from its session-start snapshot, as design point 4 asks the block to share the goal blocks' gate and those read the same snapshot; the idle sentence's "these duties", which is design point 4's own text and whose referent is the block's idle order; round 2's note that the nudge-turn test cannot exercise the hook bypass, which that test's comment already states.
Stamps: adjudicated 0 from `memq unstamped --since 3h`, which printed no read stamp in the window and so is an absence of evidence. Owed a hand walk: one record shaped a line this section wrote, `a-doubled-backslash-never-reaches-the-shell` (operator tier), surfaced by the recognition nudge when a shell-quoted edit lost its escapes; the edit moved into a script file. Stamped 1.
Gate: targeted lane at section close, measured 2026-09-26T04:43:21Z to 04:45:11Z on SCOTT-CLAUDE in the autonomy-dial worktree at 4701a46 plus the uncommitted round 2 removal. `npx tsc --noEmit` exit 0; `node .kit/tool-description-length-test.mjs` exit 0; `node .kit/injection-duplicate-test.mjs` exit 0; `node .kit/controller-tick-test.mjs` exit 0, 4781 OK, 0 FAIL, ending `PASS: 0 failure(s)`. Baseline on the same lane: 4725 OK, 0 FAIL at ca0f6da (Chapter 2's close). The orchestrator re-ran each stage's gate: 4767 at first green (03:54:10Z to 03:56:07Z), 4782 after fix round 1 (04:29:10Z to 04:30:58Z). Contention: a foreign claude-kit `node tools/probe-corpus/run.mjs` (PID 13136) was live during the fix round 1 and close runs, both of which passed. Wall clock 1m50s against 1m50s at Chapter 2's close. Test delta: 6 `caseAd3_` cases added, 0 retired, 0 existing checks edited. Each pins one requirement: one [STANDING] block at each level, in the slot before [ENV], its third line the level's sentence (Acceptance 1); the idle sentence on an all-paused tree and not on an active or empty tree (Acceptance 2); no block for a reader, with an owner control leg (Acceptance 3); no [STANDING] in the nudge frame text, with a control leg (Acceptance 3, resting on the engine's bypass of the hook for the plugin's own submits); the [PROPOSE] frame's sentence at each level, with the agentic_say send only in the no-tree clause at the two non-propose levels (Acceptance 4); a level set mid-session shows in the next prompt's block (the Tests line's stale-level clause). 0 added tests spawn a process, since the harness runs in process.
Next: 4. The coordinator's instruction and the documents
Commit Model: Branch-and-PR
Delta: measured 2026-09-26T04:46:11Z on SCOTT-CLAUDE in the autonomy-dial worktree; exit 2
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 4 - 2026-09-26
Completed: 4. The coordinator's instruction and the documents
Implemented By: main session (Locus: inline, since the section writes under docs/)
Metrics: review rounds 1, closed major-closed; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- Section open: adds the [STARTED] lead, the yes-or-no relay for a [PROPOSAL] naming a queued entry, and the awaiting-yes exception to the coordinator's instruction, and describes the dial in README.md, docs/architecture.md and docs/security-model.md; serves design point 6 and section 4's acceptance bullets 1 and 2 plus the Section 4 amendment; adds no mechanism (instruction text and documentation only; the ledger's assignment count for COORDINATOR_ROLE_INSTRUCTION stays 5); about 6 instruction sentences and 4 document passages; not building it leaves [STARTED] records unexplained to the coordinator and the documents describing a gate that no longer matches the code.
- Round 1 Major (adversarial, trace Intent "waits for the operator's word" and design point 6; spec-traceable): the coordinator's yes-relay tells the worker to goal_resume the awaiting entry only where the worker holds no active entry, and otherwise to goal_edit drop it and goal_add it again as a pending plan with the same planPath, and the instruction's "do not have it resume a queued entry" sentence names the exception; serves the Goal's idle order "finish the active work, then the queued work" and design point 6's relay; adds no mechanism (instruction text using acts a coordinator turn already admits); about 3 sentences plus the design point 6 wording; not doing it has an operator's yes pause the worker's current entry, which then waits for another word once the approved plan is done (hooks/index.ts:9651-9663, 10421).
- Deviation, recorded in the spec: design point 6 said the yes is relayed as goal_resume. As written, that relay preempts the worker's active entry, and the queue block then leaves the preempted entry waiting for a word (`hooks/index.ts:10421`). Design point 6 now reads resume-when-idle, else drop and re-add as pending. This is an edit above `## Chapters`, made to match what shipped. The plugin's own [PROPOSAL] record text (`unpromptedPlanRecordText`, `hooks/index.ts:585`) still says "On a yes, tell <persona> to goal_resume <id>". That is right for an idle worker, and the coordinator's instruction governs the busy case.
- Deviation, recorded in the spec: the plan named `bin/supervise.sh` for the coordinator instruction, which lives in `bin/supervise-holder.sh` (the ledger reads it there). The section's Files in scope and Fact base lines were corrected, and `Locus: inline` was added under its Model line. Both are edits above `## Chapters`.
- The architecture doc's ledger size figures were stale from sections 1 to 3 (46 entries and 40,984 characters, against 64 and 45,789 now). They were refreshed here, since this section's scope holds that doc and the ledger. They move again at the finishing merge, which brings main's task-list literals.
Assumptions:
- assumed 2026-09-26 (the Goal's idle order, section 4): an operator's yes on a queued proposal queues the plan behind a busy worker's active entry rather than preempting it. Reversal: the two yes sentences in the coordinator instruction in `bin/supervise-holder.sh` and design point 6.
Review Findings: review: code pair (adversarial, blind) at fable, Agent tool; review: document pair (prose-reviewer, blind-reader) (2 readers) at fable, Agent tool. Each Fable dispatch was preceded by a capacity reading, every one reading "-> dispatch" (account 4, scoped 48 to 49%). The tree was clean before dispatch. The round's captures are at `.kit/scratch/autonomy-dial/section-4/fix-round-1.diff` and `fix-round-1-delta.diff`.
- Major (adversarial; also the blind reviewer's Major, orchestrator-traced to the same clause; spec-traceable): the yes-relay contradicted the instruction's own ban on resuming a queued entry, and it preempted the active entry. Fixed in fix round 1 as the Decisions line above states.
- Prose-reviewer Majors (document pair, no provenance read): "after it started" overstated a [STARTED] line, since the entry may be queued. The level text was called "one sentence", but it runs to three at two levels. Both were fixed.
- Operator-reader Majors inside this section's delta were fixed: how to stop a started plan, what a [STARTED] line means, and how the two docs count the gated acts. The four origin kinds are now mapped to the operator's ways of reaching a persona. The confirm-a-level step now says to ask the persona for its goal status. Findings on pre-existing text outside the delta were left: idle detection, the reach rule, ground, expected turn, reader-armed, owner tier and the default persona.
- Worker-reader Majors on pre-existing text were left: how a session reads its own origin kind, and whether the shutdown ask in `bin/supervise-poll.mjs` is sized by the ledger. The act-count Major was fixed with the README sentence naming the difference in counting.
- The fix delta changes prose alone: charter text in the coordinator instruction, comments and documents. It owes no round under the fix-delta bar. The author re-read of `.kit/scratch/autonomy-dial/section-4/fix-round-1-delta.diff` found one imprecise sentence, "it tried on its own an act", which was wrong for an operator message delivered into a running turn. That sentence was corrected before the gate.
- Minors: 15 recorded in `.kit/scratch/autonomy-dial/minors-section-4.md`. 10 were fixed in fix round 1, 1 of them upgraded on a stated consequence (a relay record opening with a seat lead loses the coordinator's authority, so the worker's act is refused). 5 were left, each on pre-existing text outside this section's delta. The prose-reviewer's style Minors were also left: the long gate paragraph, the "so" reasons riding in the clause, and the README's second copy of the three steps. Each is the shape of the surrounding goal-levels prose rather than of this section's delta.
Stamps: adjudicated 1, stamped 0, from `memq unstamped --since 1h`. The one hit, `test-a-gating-definition-by-crossing-not-by-disjoint-exclusions` (operator tier), was read at a recognition nudge on the blind-reader dispatch and changed nothing built.
Gate: targeted lane at section close, measured 2026-09-26T05:03:26Z to 05:05:16Z on SCOTT-CLAUDE in the autonomy-dial worktree at 065bfb7 plus the uncommitted fix round 1. `node .kit/injection-duplicate-test.mjs` exit 0; `node .kit/tool-description-length-test.mjs` exit 0; `node .kit/controller-tick-test.mjs` exit 0, 4781 OK, 0 FAIL, ending `PASS: 0 failure(s)`; `bash -n bin/supervise-holder.sh` exit 0. Baseline on the same lane: 4781 OK, 0 FAIL at 8b2e8b7 (Chapter 3's close). First green at 065bfb7 read the same 4781 OK, 0 FAIL, measured 04:54:42Z to 04:56:34Z. Contention: the same foreign claude-kit `node tools/probe-corpus/run.mjs` (PID 13136) was live during both runs, which passed. Wall clock 1m50s, against 1m50s at Chapter 3's close. Test delta: 0 added, 0 retired, 0 edited. The section changes instruction text and documents, which the plan's acceptance line gates on the duplicate check and the controller suite alone. 0 added tests spawn a process.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: measured 2026-09-26T05:05:27Z on SCOTT-CLAUDE in the autonomy-dial worktree; exit 2
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
