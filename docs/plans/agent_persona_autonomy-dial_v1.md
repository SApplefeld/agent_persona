# Autonomy dial

Status: Ready
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
the brief's items 4, 5 and 6. Items 1 to 3 are `docs/plans/agent_persona_idle-queue_v1.md`.

Execution waits on the coordinator handing this plan to a worker by name. A worker that finds this
plan in its own queue has that handoff. This plan starts only after two plans have merged to
`origin/main`, read after a fetch: `docs/plans/agent_persona_goal-levels_v1.md`, whose turn-origin
gate and idle proposal this plan extends, and `docs/plans/agent_persona_idle-queue_v1.md`, whose
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
- `docs/plans/agent_persona_idle-queue_v1.md` (Ready). Its `hasStartableWork` is what the standing
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
   the level's sentence, which the ledger holds as one literal per level. At `propose`:
   "Autonomy: propose. You may propose work only: send a
   [PROPOSAL] record to the coordinator and start nothing until it comes back as a queue entry."
   At `plan-and-ask`: "Autonomy: plan and ask. You may write the plan document and queue it with
   goal_add; it waits paused until the operator's yes reaches you. With no goal tree, send a
   [PROPOSAL] instead, since only the operator opens a tree." At `plan-and-start`: "Autonomy: plan
   and start. You may write the plan document, queue it and start it; the plugin tells the
   coordinator. With no goal tree, send a [PROPOSAL] instead, since only the operator opens a
   tree." Where `hasStartableWork` is false and `openGoals` is not empty, the
   block adds one sentence: "Nothing in your tree starts by itself, so you are idle for these
   duties." A tree holding only complete or abandoned entries has an empty `openGoals` and gets no
   idle sentence. The two fixed sentences, the three level sentences and the idle sentence are one
   ledger entry each.
5. The `[PROPOSE]` frame the goal-levels plan builds branches on the level in one sentence, held
   as one more literal per level. The level sentence replaces the frame's sentence that tells the
   persona to start none of it, which stays only at `propose`. At `propose` the frame reads as
   goal-levels states. At `plan-and-ask` it tells the persona to write the plan document and queue
   it with `goal_add`, and that the entry waits for the operator's yes. At `plan-and-start` it
   tells the persona to write the plan document, queue it and start it. At both, where the
   persona holds no tree, the sentence tells it to send a `[PROPOSAL]` instead.
6. The coordinator's instruction gains the `[STARTED]` lead: tell the operator in one line which
   persona started what, and note it on the board. For a `[PROPOSAL]` that names a `planPath` and
   an entry id, the operator's yes is relayed as a coordinator record telling the worker to
   `goal_resume` that entry, and a no tells it to `goal_edit drop` it with the reason. The
   idle-queue plan's sentence that a paused entry carrying a release condition is a queue mistake
   gains one exception: an entry whose reason reads `Awaiting the operator's yes` waits for the
   operator's word and is never resumed on the coordinator's own initiative. `[STARTED]` joins the
   gate's excluded-lead list beside `[FINDING]` and `[PROPOSAL]`. No tool checks which lead a
   persona's own `agentic_say` opens with, and this plan adds no such check.

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
Fact base: `hooks/index.ts`, `hooks/agent-state.ts`, `bin/supervise.sh`, and this plan's Approach.

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

Files in scope: `bin/supervise.sh` (the coordinator instruction), `.kit/injection-ledger.json`,
`.kit/injection-ledger.mjs` where an anchor moves, `README.md`, `docs/architecture.md`,
`docs/README.md` (this plan's line moves to the archive list when the plan closes).

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
