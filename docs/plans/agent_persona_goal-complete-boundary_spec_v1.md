# A Finished Goal Tree Is a Checkpoint Boundary, Not a Relaunch

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-02

## Goal

A persona whose goal tree completes stays in the session it is in. The supervisor no longer stops that child and launches a fresh one, so the next ask lands in a session that still holds the conversation about the last one. The turn that finishes a goal entry counts as a durable point, so the session's next automatic compaction may land there instead of running to the safety ceiling. A worker that finishes one plan with another queued is told to end its turn there, and a turn that did so is a durable point too, so the compaction lands before the next plan's work begins. After a compaction the persona is given its launch instructions again, so its role does not depend on what the summary kept. A child that crashes after its tree completed counts against the crash limit like any other crash. The tool descriptions, the charter sentence and the documents that state the relaunch say what the engine now does. The deliberate restart routes are unchanged.

## Intent

**The frame, in the operator's words (2026-10-02, on the architect's channel).** The operator asked why a persona restarts when its goal tree is clear, and on hearing the reason said: "just fully restarting into a brand-new session doesn't really make sense to me when a goal tree completes, because it's not how we've been using the kit." The use he described: "It was not uncommon to arm multiple plans back to back with a kit goal. It was not uncommon to use one long-running session to complete a goal, dialogue a little bit about it, make a new plan, and start a new one." What must survive the change: "I think what's important is context management, checkpoint writing, and compaction. Those things should definitely still be observed. Finishing a goal is a good time to open a checkpoint, and if you're over your context budget, compact. Finishing, just like finishing a chapter or a section, is a good point for that." And the means: "there is a reasonable mechanism there to compact down to use the checkpoint deferral and capabilities for that."

**What done needs.** Every persona stays up across a finished tree, which is the author's reading of the operator's words and is recorded under Assumptions. Finishing a goal entry opens the same compaction boundary a plan Chapter opens today, whether or not another plan is queued behind it. A crash after a finished tree is still counted. A persona that has been compacted holds its launch instructions in full.

**What done does not need.** It does not need the engine to measure how full the context is. It does not need a compaction forced at the boundary. It does not need a change to the kit. It does not need the three deliberate restart routes to change: the persona's own restart tool, the coordinator's fleet restart, and a parked shutdown.

**Alternatives refused.**

- Exempt only the architect's seat from the relaunch: refused, because the operator's reason is about how every persona is used, not one seat.
- Keep the relaunch and carry the conversation across it with a longer recap: refused, because a recap is a summary the engine writes, and the harness's own compaction already does that job at a point the kit's gate approves.
- Force a compaction whenever a tree completes: refused, because the operator asked for one only "if you're over your context budget", and the kit's gate already makes that call.
- Give the engine its own context estimate to decide the compaction: refused, because an earlier plan removed exactly that monitor and left the kit as the only decider.

- Write the boundary marker inside the turn, at the tool call after `goal_done`: refused, because the plugin has no mid-turn bank today and the turn-end bank already does the job once the turn ends at the finished plan.
- Have the plugin signal the supervisor to write the instructions into the session again: refused, because the supervisor can only write a new prompt, which opens its own turn, arrives up to a poll late and needs a new signal from the plugin to the shell.
- Move the role instructions into a kit role the persona assumes: refused, because the text is composed per launch from the fleet's settings, and a kit role would hold a fixed copy in another repository.
- Save the instructions to a file the plugin reads back: refused, because the plugin already receives the text as the launch prompt and can hold it where the session's own tools cannot rewrite it.
- Inject from the classic `PostCompact` hook: refused, because the engine declares that event with no context field to carry the text (`.claude/types/claude-code.d.ts:1158-1172`).
- Inject from the classic `SessionStart` hook with its `compact` source: refused on the operator's word of 2026-10-03, and not needed, since the compaction hook itself can add the text.

**Later rulings.**

- 2026-10-03, the operator, on the architect's channel: the end of a plan is a compaction point even with another plan queued. "I presumed ending a plan is a reasonable compaction point." The shape is his: "We might need some doctrine to coach ending a turn and following with a small tool call after writing a checkpoint, that is what will trigger the actual harness compaction to be allowed. From there, it can start the next goal / plan, or be nudged into it by the Supervisor loop." Where the coaching sits is the architect's placement and not yet the operator's word: it is in `goal_done`'s answer instead of doctrine, because the worker reads that answer at the moment it applies and the plugin measures what the turn did instead of trusting that the coaching was followed. The operator was told in the same exchange, and the placement is recorded under Assumptions. This closes the first open question and replaces the default it carried.
- 2026-10-03, the operator, on the architect's channel: launch instructions are re-injected after a compaction. "In the interactive sessions, our post-compact hook would reinject role instructions and guidance." And on the means: "I think your approach would work, but it would need to hook the same piece, not rely on SessionStart." The plugin re-injects in its own process, inside the compaction itself, which is the piece that runs after the summary exists. This closes the second open question and brings the work into this plan.

**Provenance.** Written by the architect persona's session of 2026-10-02 from the operator's two channel messages of that day, quoted above. Amended by the architect persona's session of 2026-10-03 on the two rulings above, against the trunk at 930d406.

## Dispatch Authorization

The operator's messages of 2026-10-02 quoted under Intent are the design ask this plan answers. They authorize the plan document. `Status: Ready` means the plan is parked: arming it for a worker is the operator's or the coordinator's act and is not given here, and the run that starts it sets the header to `In Progress`.

The architect's charter clause about the relaunch is on the trunk at 930d406, in `bin/supervise-holder.sh`, as the phrase `relaunching you with the tree kept`. Section 4 edits it there.

No section of this plan restarts, stops or relaunches a running supervisor or persona. A running supervisor keeps the script it launched with, so the change takes effect at each supervisor's next launch, which is the operator's act.

## Approach

**What happens today.** The plugin's controller tick completes a finished root and writes a `root_complete` decision to the persona store (`completeRoot`, `hooks/index.ts:4681`, called from the tick at `hooks/index.ts:8411`, from the planner's zero-plan return and from `goal_done` naming the root). The supervisor's poll reads the newest `root_complete` (`bin/supervise-poll.mjs:127`). Its decision unit maps one newer than the child's start to `restart_passive` (`bin/supervise-decide.mjs:150`). `bin/supervise.sh` then stops the child by the graceful path and launches a fresh one outside the crash counter and the hourly restart budget (`bin/supervise.sh:4871`). An archived plan introduced this so the supervisor would stay up for a second goal instead of exiting (`docs/archive/agent_persona_passive-supervisor_v1.md`, item 4). The fresh child was the means, and staying up was the aim.

**The change to the supervisor.** The decision unit stops reading `root_complete` at all. With step 3c gone, a child on a finished tree is an ordinary live child: the poll keeps reading its liveness, and every other decision still applies. `rootCompleteTs` and `rootCompleteBackfilled` have no other reader in the decision unit or the poll, so both inputs and the poll's read of them go with the step, and with them the poll's copy of the legacy backfilled suffix. The `restart_requested` branch above step 3c stays, and so does its `restart_passive` action, which is now that branch's alone. The branch's refusal to relaunch beside a surviving or unverifiable process stays with it.

**The natural-exit path keeps its read and gains one condition.** When the child exits on its own, `bin/supervise.sh:5073` reads `root_complete` and, for a real root, relaunches unaccounted whatever the exit code. That was safe while a child lived only seconds past its completion. Once children stay up, a `root_complete` newer than the child's start is the normal state of any child that has finished one goal. So the real-root branch takes the relaunch only on exit code 0, as the backfilled branch beside it already does. A non-zero exit falls through to the crash counter and the hourly budget. Without this condition, a child that crashes in a loop after finishing one goal would relaunch without limit. The branch's log line loses its `RESTART_PASSIVE:` prefix, since that word now names the restart request alone and the operator reads its absence after a completion as the pass signal.

**The change to the plugin.** The plugin already banks a compaction boundary for the kit's gate (`bankCompactionBoundary`, near `hooks/index.ts:2738`; the kit is the `claude-kit` plugin, whose `kit-compact-checkpoint.js boundary` verb records the marker and whose `kit-compact-gate.js` reads it). The persona's own turn end sets an owed bank where the turn stopped at a durable point, and the first main-loop tool call of the next turn runs the kit's `boundary` command. The durable test reads a plan holder as mid-section unless its document gained a Chapter or completed the holder this turn (`hooks/index.ts:11032`). A holder that `goal_done` completed this turn passes neither, so that turn owes no bank today. That is the wrong reading: `goal_done` is the persona's own statement that the entry is finished. The rule gains one case: a turn-start plan holder that a `goal_done` call completed this turn is not mid-section. Every other part of the durable test is unchanged, so a `WAITING:` or `BLOCKED:` lead, an open ask, a live background agent, or a move onto another open plan still withholds the bank.

**The turn between two plans.** With no `nodeId`, `goal_done` completes the active leaf and activates the next pending plan inside the same turn, and its answer names that plan as the one to carry on with (`hooks/index.ts:5752` and `:12115-12119`). A turn that carries on has worked the second plan by the time it ends, so the existing rule reads it as mid-section through `endHolderOpen` (`hooks/index.ts:11045`). That reading stays for a turn that carried on. What changes is that the worker is told not to. Where `goal_done` completes a plan entry and activates another plan, its answer tells the worker to report and end the turn, with no `WAITING:` or `BLOCKED:` line, and says the next turn starts the plan it names. The durable test then reads what the turn did: where the main loop made no work call and dispatched no agent after that `goal_done`, the newly active plan does not make the turn mid-section. Work is `isNudgeCountWork`'s set, `isWorkTool` plus an agent dispatch, so a channel reply and a record to another persona after the call do not count.

The next turn opens on the controller's nudge for the active entry, or on a delivered record. Its first main-loop tool call writes the marker, as for any durable turn. The kit's gate honors a marker written while it is already holding compaction back, so a session over the trigger compacts at its next model step, with the second plan read and nothing of it built. A marker written under the trigger lapses after the gate's ten-minute bound and nothing happens. A worker that ignores the answer and carries on loses the boundary and nothing else.

The compaction lands inside a turn either way. The gate is offered a compaction at every model step past the trigger, and the marker is written at a turn's first tool call for that reason (`kit-compact-gate.js`, header; `hooks/index.ts:11145-11160`). Ending the turn is what makes that first tool call sit ahead of the second plan's work.

The owed bank lives in memory and is taken at the next turn's first tool call. Today the relaunch discards it. Once the child stays up, the next turn takes it, with no further change.

**Launch instructions after a compaction.** A persona's role arrives once, as the supervisor's first prompt, a user turn whose text opens `[SUPERVISOR-PRIMING]` (`bin/supervise-holder.sh:575-583`). The plugin already sees that prompt: its `prompt.submit` handler reads the marker to flag the priming turn (`hooks/index.ts:13134`). So the plugin keeps the text. It captures the prompt where the text opens with the marker and the prompt's origin is the supervisor's own write, the `sdk` origin the handler already requires of a `[SUPERVISOR-ASK` prompt, so the same words typed at a keyboard or relayed from a channel are never taken as a role. The text is held in the engine's session state, which survives a reload of the plugin's code and which no tool of the session writes.

The plugin gives the text back inside the compaction. Its `session.compact` hook already wraps every compaction, and the engine's declarations let such a hook change the messages "on the way up": `next(e)` resolves to the conversation as it reads afterwards, the summary and the messages kept, and what the hook returns is what the transcript becomes (`.claude/types/claude-code.d.ts:3849-3859` and `:9169-9180`). So after `next(e)` resolves with messages, the hook returns them with one more message placed directly after the summary: an opening line saying these are the launch instructions repeated after a compaction, that nothing in them is a new ask and that no acknowledgment is owed, then the kept text. The role is back in the conversation before the next model step, whether the compaction landed between turns or inside one.

Three cases add nothing. A compaction the engine or the kit's gate skipped resolves to a skip with no messages, so there is nothing to add to, and a deferred compaction costs no injection. A subagent's or a fork's own compaction carries an `agentId` and passes unchanged. A session with no kept text, one started by hand among them, passes unchanged. One case is guarded: the engine may compute a compaction ahead of time under the `precompute` trigger and keep the result for the compaction that comes (`.claude/types/claude-code.d.ts:9262-9269`). Whether the hook runs again when that kept result is installed is not stated in the declarations, so the hook adds the message only where the resolved messages do not already hold one opening with its line.

The classic `PostCompact` event the operator named exists in the engine, and it cannot carry text back into the conversation, which is why the compaction hook is used instead. The plugin's own `session.start` fires once per load of the plugin's code and is not a compaction event (`.claude/types/claude-code.d.ts:3812-3824`).

**Why no context measurement.** The engine keeps no estimate of context size (`README.md:867`, "No context reading"). The harness triggers automatic compaction at its own window. The kit's gate defers that compaction while a session is mid-work and allows it once a boundary marker exists, up to a safety ceiling of 800,000 tokens. So "if you're over your context budget, compact" is already how the pieces behave once the boundary is banked: under the trigger nothing happens, and over it the next compaction lands at the banked point.

**Why the checkpoint is not a new write.** A plan a worker executes closes with a Chapter in the plan document, and the kit's own skills write it. A plan the architect writes closes with the pushed branch and the draft pull request. Those are the durable records a compacted session resumes from. This plan adds no second record.

**Sections run in order, one at a time.** Section 4 rewrites comments section 1 left and states the suites as sections 1 to 3 leave them, and sections 1 to 3 all touch `hooks/index.ts` and `.kit/controller-tick-test.mjs`.

**The sweep.** Searches over `bin/`, `hooks/`, `.kit/`, `README.md` and `docs/` at 6da8065 for `root_complete`, `rootComplete`, `get_root_complete`, `restart_passive`, `RESTART_PASSIVE`, `goal complete`, `finished goal` and `pendingCompactionBank`. Surfaces found:

- Code: `bin/supervise-decide.mjs` (step 3c and its header comments at 8-9 and 60-67), `bin/supervise-poll.mjs` (112-137, 414, 430), `bin/supervise.sh` (the `restart_passive` case at 4871, the natural-exit branch at 5073-5097, the comment at 5104), `hooks/index.ts` (the durable test at 10968-11036, the two tool descriptions at 5800-5805 and 5825-5827, the comments at 2345, 4665 and 12308).
- Tests: `.kit/supervisor-unit-test.mjs` (the real-root case near 226-236), `.kit/supervisor-poll-unit-test.mjs` (near 227-245), `.kit/supervisor-natural-exit-test.sh` (the suffix pin at 303-328, cases b at 1678, g at 1708, v at 2293 and y at 2318), `.kit/controller-tick-test.mjs` (the boundary-compaction cases and `caseTurnClose_theCompactionRuleInBothDirections`).
- Words: `README.md` (lines 44, 48, 52, 212, 400, 459-502, 531, 555-558, 867), `docs/architecture.md` (the supervisor passages and the size row at 325), `docs/backlog.md` (the items named under section 4 by title), `.kit/injection-ledger.json`, and the architect's charter clause in `bin/supervise-holder.sh`.

Line numbers in this sweep and in section 1 are anchors at 6da8065. The trunk has since moved to 930d406, and the anchors this plan gives for the durable test, `goal_done`, the priming prompt and `session.compact` are at 930d406. Each section re-reads its anchors before editing, and a backlog item is re-found by its heading. The engine's type declarations are the committed file `.claude/types/claude-code.d.ts`, read as it stands with no probe run. The plugin's rename is in flight under `docs/plans/agent_persona_personas-rename_spec_v1.md`, so a tool name written here as `mcp__agentic-plugin__...` is read as whatever prefix the worker's checkout carries.

**One thing not read.** What the controller tick does on every tick for a session whose root is already complete was rare before, because the child was stopped within a poll. It is inferred that the tick makes no planner call and sends no nudge for such a root. Section 1 pins it with a test rather than trusting the inference.

## Sections of Work

### 1. The supervisor keeps the child on a finished tree

Model: opus

The supervisor stops answering a completed root with a relaunch, and a crash after a completed root is counted.

What gets built:

- `bin/supervise-decide.mjs`: step 3c is removed with its header text. The `rootCompleteTs` and `rootCompleteBackfilled` inputs are removed. The `restart_requested` branch and the `restart_passive` action stay, and the comments say the action is the restart request's.
- `bin/supervise-poll.mjs`: the read of the newest `root_complete`, its backfilled flag and the `BACKFILLED_SUFFIX` constant are removed from `readStoreFacts`, with the two values it passes to the decision unit.
- `bin/supervise.sh`, the `restart_passive` case: the comment and the log line name the restart request only. The `goal complete` log arm is removed, since no decision reaches it.
- `bin/supervise.sh`, the natural-exit path: the real-root branch relaunches unaccounted only where the exit code is 0. Its two log lines become one `NOTE:` line, in the shape of the backfilled branch's, saying the child exited clean after a completed goal and is relaunched unaccounted, with no `RESTART_PASSIVE:` prefix. A non-zero exit falls through to the accounted path. The backfilled branch is untouched.
- `.kit/supervisor-natural-exit-test.sh`: the suffix pin at 303-328 narrows to `bin/supervise.sh`'s single reader, one suffix and one whole-line rule, and the test's own stub reader at 348 keeps reading that suffix. Cases (v) and (y) are driven through a restart request instead of a completed root. Case (b) asserts the new `NOTE:` line and the absence of `RESTART_PASSIVE:`. Case (g) is rewritten as the stay-up proof below.
- The other tests named below, changed to state the new behavior.

Acceptance criteria:

- A decision-unit case with a real `root_complete` newer than the child's start, a live child and no other signal returns the same action as the case with no `root_complete`. No decision reason names `root_complete`.
- A poll case over a store holding a real `root_complete` newer than the child's start reports no restart, and the poll's output carries no root-complete field.
- A natural-exit case whose child completes a real root and exits 0 relaunches unaccounted, with the `NOTE:` line and no `RESTART_PASSIVE:` line in the log.
- A natural-exit case whose child completes a real root and then exits non-zero inside the minimum run time, repeated to the crash limit, ends with the supervisor's crash-loop stop. Before the change this case relaunches without limit, so it is written first and seen red.
- Case (g) proves the stay-up: after at least two polls following the stub's `root_complete` write, child-1 is the same process, the log holds no `RESTART_PASSIVE` line and no `EXIT child-1` line, and the stub reports one launch. The run ends through the shutdown request as today.
- Cases (v) and (y) reach the `restart_passive` branch through a restart request and still end in exit 5 with no second launch.
- A restart request newer than the child's start still relaunches the child unaccounted on both paths.
- A controller-tick case over a session whose root is complete and whose child stays up runs several ticks with no planner call, no nudge and no second `root_complete` decision. Where the tick does any of the three, the section makes the smallest change in `hooks/index.ts` that stops it, pins it with the same case, and names the change in its Chapter.
- `node .kit/supervisor-unit-test.mjs`, `node .kit/supervisor-poll-unit-test.mjs`, `bash .kit/supervisor-natural-exit-test.sh` and `node .kit/controller-tick-test.mjs` exit 0, each against a baseline recorded before the first edit, and the natural-exit suite's check count is not lower than the baseline's.

Files in scope: `bin/supervise-decide.mjs`, `bin/supervise-poll.mjs`, `bin/supervise.sh`, `.kit/supervisor-unit-test.mjs`, `.kit/supervisor-poll-unit-test.mjs`, `.kit/supervisor-natural-exit-test.sh`, `.kit/controller-tick-test.mjs`, and `hooks/index.ts` only where the tick case above finds a fault.

Tests: the stay-up behavior in both directions (a completed root does not relaunch, a restart request still does), because a half-removed step would leave one path relaunching. The crash count after a completed root, because the unaccounted branch would otherwise exempt every long-lived child from the crash limit. The survivor refusal on the restart-request route, because cases (v) and (y) are the only proof of it. The quiet tick over a complete root, because that state was rare and is now the resting state of every idle persona.

### 2. A finished goal entry opens a compaction boundary

Model: opus

The turn in which a `goal_done` call completes the plan entry it started on counts as a durable point, so it owes a boundary bank. Where that call activates another plan, the worker is told to end the turn, and a turn that did is durable too.

What gets built:

- `hooks/index.ts`, the durable test in the turn-complete handler: a turn-start plan holder that a `goal_done` call completed this turn, on the holder itself or on its last open child, is not mid-section. The status is the holder's at the delete snapshot, beside `activeIdAtDelete`, not after the handler's own steps. A holder the cascade closed because its last open child was abandoned is out, and so is an abandoned holder. The comment block above the test states the case in the present tense beside the Chapter and document cases.
- `hooks/index.ts`, the same test: where the turn-start holder was completed that way and the main loop made no `isNudgeCountWork` call after the completing `goal_done`, an open end holder does not make the turn mid-section. A turn that did make one keeps today's reading.
- `hooks/index.ts`, `goal_done`'s answer where it completes a plan entry and activates another plan: after the `Next active` sentence it tells the worker to report and end the turn now, with no `WAITING:` or `BLOCKED:` line, and that the next turn starts the plan named. The description's sentence "and that goal is the one to carry on with" says the same for that case. The answer where a task under the same plan becomes active is unchanged.
- No other input of the durable test changes.
- Boundary cases in `.kit/controller-tick-test.mjs`.

Acceptance criteria:

- A turn that starts on a plan entry, calls `goal_done` on it and ends with a plain answer sets the owed bank, and the next turn's first main-loop tool call runs the boundary command once and logs `compaction_boundary_banked`.
- The same turn ending on a `WAITING:` or `BLOCKED:` lead, with an open ask, or with a live background agent owes no bank.
- A turn where `goal_done` completes the entry and activates another open plan, and the main loop then makes no work call and dispatches no agent, sets the owed bank. The same turn with a channel reply or a record to another persona after the call still sets it.
- The same turn with one work call or one agent dispatch after the `goal_done` owes no bank, as today.
- `goal_done`'s answer in that case carries the end-the-turn sentence and names the next plan, and its answer where no other plan becomes active does not carry it.
- The registered `goal_done` description stays within the bound `.kit/tool-description-length-test.mjs` holds.
- The injection ledger's baseline is refreshed from `node .kit/injection-ledger.mjs` in the commit that changes the description, the size row of `docs/architecture.md` states the new totals, and `node .kit/injection-duplicate-test.mjs` exits 0.
- A turn where the holder reads complete only because its last open child was abandoned owes no bank.
- A turn that ends on a plan entry still open, with no new Chapter, owes no bank, as today.
- The bank set by the turn that finished the last entry is still owed after the tick that completes the root, and the next turn takes it. This case runs the tick between the two turns.
- The new cases are written first and seen red against the unchanged handler.
- `node .kit/controller-tick-test.mjs` exits 0 against its recorded baseline, and `npx tsc --noEmit` exits 0.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `.kit/tool-description-length-test.mjs` only where its bound needs restating, and `.kit/injection-ledger.json` with the size row of `docs/architecture.md`.

Tests: the new durable case in both directions, because a marker banked mid-work licenses a compaction that loses the work in hand. The between-plans turn in both directions for the same reason, since the only thing separating the two is whether work followed the call. The bank surviving the root's completion, because the relaunch used to discard it and nothing has ever exercised that path.

### 3. Launch instructions return after a compaction

Model: opus

A persona whose main conversation was compacted is given the supervisor's launch instructions again, from the copy the plugin kept.

What gets built:

- `hooks/agentic-plugin.d.ts`: the plugin's state declaration gains the key that holds the kept text, since `claude plugin validate` refuses an undeclared key.
- `hooks/index.ts`, the `prompt.submit` handler: a prompt whose text opens `[SUPERVISOR-PRIMING]` and whose origin kind is `sdk` is kept whole in the engine's session state under that key. A later one replaces it. A prompt with the marker and any other origin is not kept.
- `hooks/index.ts`, the `session.compact` hook: after `next(e)` resolves, for the main conversation, with messages and a kept text, it returns the result with one message added directly after the summary, holding the opening line the Approach states and then the kept text. It adds nothing where the resolved messages already hold a message opening with that line. Its existing work on the way down, the shown-records sentence, is unchanged.
- One decision per added message, `launch_instructions_reinjected`, with the text's length and no part of the text.
- `.kit/injection-ledger.mjs` gains a rule for the opening line, and the baseline and the size row of `docs/architecture.md` are refreshed in the same commit.
- Cases in `.kit/controller-tick-test.mjs`, or the suite that already drives `prompt.submit` and `session.compact` where that is another file.

Acceptance criteria:

- After a priming prompt with the `sdk` origin, a main-conversation compaction that resolves with messages returns those messages plus one, placed directly after the summary, holding the opening line and the kept text.
- A second compaction, whose input no longer holds the added message, adds it again. A result that already holds a message opening with the line gains no second one.
- A compaction that resolves to a skip returns the skip unchanged and logs no decision.
- A prompt opening with the marker from a channel origin or a keyboard origin is not kept, and a compaction after it adds nothing where no supervisor prompt was kept.
- A subagent's compaction passes unchanged.
- The kept text survives a reload of the plugin's code.
- The shown-records sentence still reaches the summarizer's instructions, pinned by its existing cases.
- The new cases are written first and seen red.
- On a live supervised persona, a manual `/compact` leaves the added message in the transcript directly after the summary, and the persona's next answer does not acknowledge it as a new ask. This is the one check a suite cannot make. Where the engine does not keep the message as built, the section stops with a `BLOCKED:` line and a record to the architect persona naming what the engine did, and adds no other delivery of its own. Where the worker cannot run the check, the Chapter says so and Operator Verification carries it.
- `node .kit/controller-tick-test.mjs` and `node .kit/injection-duplicate-test.mjs` exit 0 against their recorded baselines, and `npx tsc --noEmit` exits 0.

Files in scope: `hooks/index.ts`, `hooks/agentic-plugin.d.ts`, `.kit/controller-tick-test.mjs`, the suite that drives `prompt.submit` where that is another file, `.kit/injection-ledger.mjs`, `.kit/injection-ledger.json`, and the size row of `docs/architecture.md`.

Tests: the origin gate in both directions, because a role taken from a channel message would let anyone who can post there rewrite a persona's standing instructions for the life of the session. The skip, because the kit's gate defers many compactions for each one that lands, and a message added on a deferral would spend several thousand characters with no compaction behind it. The single message, because a compaction computed ahead of time may pass the hook twice. The subagent exclusion, because a subagent compacts on its own and holds no role.

### 4. The words say the child stays up

Model: sonnet

Every sentence that tells a persona or a reader that a finished goal relaunches the child says instead that the child stays up.

What gets built:

- `hooks/index.ts`, the `supervisor_shutdown` description: the sentence "A finished goal needs no call here: goal_done already returns the supervisor to its passive waiting state." becomes "A finished goal needs no call here: the session stays up and waits for the next ask."
- `hooks/index.ts`, the `supervisor_restart` description: "A finished goal needs no call here either." stays as written, since it remains true. The section confirms it and changes nothing there.
- `hooks/index.ts`, the comments at 2345, 4665 and 12308, and `bin/` comments section 1 did not already rewrite: each states what the supervisor reads now.
- `bin/supervise-holder.sh`, the architect's charter. The clause "and the supervisor answers a completed root by relaunching you with the tree kept, so before the turn that calls goal_done on it ends you answer or report every other ask in hand; the next goal_add reopens the root" becomes "and you stay up on a completed root; the next goal_add reopens it". The rest of that sentence and the sentence after it stay. The restatements of the clause in `README.md` and `docs/architecture.md` change with it.
- `.kit/injection-ledger.json` and the size row at `docs/architecture.md:325`, refreshed from `node .kit/injection-ledger.mjs` in the same commit as this section's string edits. Sections 2 and 3 refresh it for theirs.
- `README.md`: each passage the sweep lists is rewritten to the current state. The decision list loses the `root_complete` entry. The natural-exit passage says a clean exit after a completed goal relaunches unaccounted and a crash is counted. The "No context reading" passage adds the finished-entry case and the between-plans turn to its description of a half-done section. The `goal_done` passage near line 212 says a worker ends its turn after finishing a plan with another queued. The compaction passage near line 314 says the launch instructions are kept and added back to the compacted conversation by the `session.compact` hook, and that only the supervisor's own prompt is kept. The row for `hooks/agentic-plugin.d.ts` near line 376 names the new state key. The test inventory lines match what the suites now prove.
- `docs/architecture.md`: the same, wherever it states the relaunch.
- `docs/backlog.md`: the items "The supervisor reads the newest root_complete and never a later root_reopened" (line 300) and "The supervisor relaunches a child that reopened a root it had completed" (line 371) move to `docs/archive/backlog-2026-Q4.md`, each with the reason that the supervisor no longer acts on `root_complete` while the child lives. The item "Operator check owed by the boundary-compaction plan" (line 276) is replaced by a pointer to this plan's Operator Verification, which covers it. The items "Remove the supervisor's backfilled readers once no store can still hold such a line" (line 381) and "A KILL-path variant of the restart-passive F2 leg" (line 543) are reworded to what remains true: the backfilled reader survives only on the natural-exit path, and case (g) proves the stay-up while cases (v) and (y) prove the refusal on the restart-request route.

Acceptance criteria:

- A search over `README.md`, every live document under `docs/` outside `docs/archive/`, `skills/`, `bin/`, `hooks/` and the comments of `.kit/` for `passive`, `goal-complete`, `fresh child` and `relaunch` leaves no sentence that ties a relaunch to a completed goal with a live child. The Chapter lists each remaining hit and why it stays.
- `node .kit/injection-duplicate-test.mjs` exits 0, and the ledger file's totals equal the ledger script's output.
- `docs/architecture.md:325` states the counts and totals the ledger file holds.
- No sentence in the changed documents says when or how the behavior changed. They state the current behavior.
- The charter clause reads as the replacement text above.

Files in scope: `hooks/index.ts` (descriptions and comments only), `bin/supervise-holder.sh`, `bin/supervise-decide.mjs`, `bin/supervise-poll.mjs` and `bin/supervise.sh` (comments only), `.kit/injection-ledger.json`, `.kit/injection-ledger.mjs` where a rule's source shape moved, comments in `.kit/` suites that state the relaunch, `README.md`, `docs/architecture.md`, `docs/backlog.md`, `docs/archive/backlog-2026-Q4.md`, and any other live document or skill the search finds stating the relaunch.

## Out of Scope

- The kit repository. Its gate, its `boundary` verb and its ceiling are used as they are.
- Any context-size estimate in the engine, and any compaction the engine forces.
- An abandoned plan holder as a durable point.
- The rate bound on untracked-work relaunches (`docs/backlog.md`, "An untracked-work relaunch has no rate bound", line 481) and the removal of the backfilled reader (line 381).
- Re-sending the launch instructions through the supervisor, and any kit role that carries them.
- A bank written inside the turn that called `goal_done`.
- Restarting any running supervisor.
- `docs/archive/agent_persona_passive-supervisor_v1.md`, which states the relaunch as history and is not edited.

## Assumptions

- assumed 2026-10-02 (README.md "No context reading" and docs/archive/agent_persona_boundary-compaction_spec_v1.md): "over your context budget" means the harness's own compaction trigger, with the kit's gate landing the compaction at the banked boundary, and no measurement in the engine; reversal: an engine-side estimate is a new plan and reverses an earlier removal.
- assumed 2026-10-02 (default): "open a checkpoint" means the boundary marker the plugin already banks, with the plan's closing Chapter or pushed branch as the durable record, and no new file; reversal: a written goal-close record is one more section in the plugin.
- assumed 2026-10-02 (default): the change applies to every persona, coordinator and liaison included, because the supervisor's step is not per role and the operator's reason was about how personas are used; reversal: a per-role switch is a new setting in the supervisor's config.
- assumed 2026-10-03 (operator, channel ruling of that day): the turn that finishes one plan with another queued is a boundary where the worker ended it there; reversal: drop the condition and the answer's sentence, inside section 2.
- assumed 2026-10-03 (default, the architect's placement, told to the operator and not yet answered): the coaching to end the turn sits in `goal_done`'s answer and description, not in the kit's doctrine; reversal: a sentence in the kit's executing-work skill, which is a plan in the kit's repository.
- assumed 2026-10-03 (default): a worker that ends its turn between plans waits for the controller's nudge on the active entry, and that wait is acceptable; reversal: the plugin opens the next turn itself, which is a new mechanism.
- assumed 2026-10-03 (default): the whole priming prompt is added back under one opening line, its closing request to acknowledge included, since the opening line cancels it; reversal: the supervisor marks where the role text ends, which is one more edit in `bin/supervise-holder.sh`.
- assumed 2026-10-03 (default): a persona started without the supervisor has no kept text and gets no added message; reversal: none needed.
- assumed 2026-10-03 (`.claude/types/claude-code.d.ts`, read and not run): a message a `session.compact` hook adds on the way up stays in the transcript as built; reversal: section 3's live check stops the section and returns the question to the architect.
- assumed 2026-10-02 (default): a persona no longer picks up a new plugin build or harness build at each goal end, only at a deliberate restart; reversal: none in code, the operator or coordinator restarts the fleet after an update as the restart tools already allow.
- assumed 2026-10-02 (default): a clean exit after a completed goal keeps its unaccounted relaunch, since a child that leaves cleanly between asks is healthy; reversal: one condition in the natural-exit branch.
- assumed 2026-10-02 (default): the plan review ran in the architect's session before the push, and again on the amendment of 2026-10-03, and the worker's engine reviews each section as it runs; reversal: none.

## Operator Verification

- After the pull request merges, update the installed plugin copy and relaunch one supervisor. Have that persona finish a goal. The supervisor's log shows no `RESTART_PASSIVE` line after the `root_complete` decision, and the persona answers the next ask in the same session with the earlier conversation still in hand. A relaunch at that point reopens the work.
- On the same persona, across a session long enough to reach the harness's compaction trigger, the kit gate's log in `.kit/compact-gate.jsonl` shows an allow line after a finished goal, and the store shows `compaction_boundary_banked`. A persona that runs to the 800,000 token ceiling before compacting, or a `compaction_boundary_failed` decision on a clean install, reopens the work. This check replaces the one the boundary-compaction plan left owed.
- After that compaction, the persona's transcript shows the launch instructions added back under their opening line, directly after the summary, and the persona still reports where those instructions say to report. A compaction with no such message, or one appearing with no compaction before it, reopens the work.
- Queue two plans for one worker. When it finishes the first, its turn ends with its report and the second plan starts in a new turn. A worker that runs straight on into the second plan lost the boundary, which is safe, and a pattern of it reopens the wording of `goal_done`'s answer.

## Open Questions

None. The two this plan carried were ruled on 2026-10-03, under Intent.

## Related

- `docs/archive/agent_persona_passive-supervisor_v1.md`: introduced the relaunch on a completed root, item 4. This plan replaces that item's means and keeps its aim.
- `docs/archive/agent_persona_boundary-compaction_spec_v1.md`: introduced the boundary bank this plan extends by one case.
- `docs/archive/agent_persona_context-budget-removal_v1.md`: removed the engine's context monitor, which this plan does not bring back.
- `docs/archive/agent_persona_architect-draft-pr_spec_v1.md`: added the charter clause section 4 changes.
- `docs/plans/agent_persona_personas-rename_spec_v1.md`: renames the plugin and its tool prefix while this plan waits, so this plan's tool names are read at the worker's checkout.

## Chapters
