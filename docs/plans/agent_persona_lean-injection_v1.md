# Lean injection: every injected prompt says only what its reader cannot already know

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-18

## Goal

When this is done, every prompt the plugin or the supervisor writes into a session, and every tool description the plugin registers, carries only what that session cannot already hold: the meaning of the label at the prompt's head, what to do with this one prompt, and a pointer to the surface that owns the rest. The writing rules live in `CLAUDE.md`, the roles live in the kit's skills, and each tool's contract lives in that tool's description, each once. A test fails the build when an injected string repeats a sentence that `CLAUDE.md` or another injected string already carries, and a ledger records each injected string's size so growth is declared rather than discovered. It matters because a worker's startup message today carries about 4,000 characters of instruction, the coordinator's about 11,200, and every plugin-submitted prompt for the operator's eyes carries a further 1,564 of which 19 of 21 sentences are copied from `CLAUDE.md`.

## Intent

The operator's words on 2026-09-18, on the coordinator's Discord thread, after seeing a kaizen prompt in a transcript: "It's not so much that I have a problem with that particular sentence or its existence. It's more that I'm looking for signals that flag excessive growth and excessive detailed instruction." "We're having a lot of problems with there just being too much prose, too much specificity, not enough high-level goal, high-level guidance, high-level lesson." "Are there a whole bunch of detailed, redundant, injected instructions that we should be doing a pass over and trimming down to avoid overcomplicating what the plugin guidance is trying to give?" On the cause: "things are being added in isolation without a larger goal-vision-type structure."

What done looks like: each injected prompt is short and points at its owner, the pass covers the pattern and not one block, and a mechanical signal catches the next copy so nobody has to spot it by eye.

What done does not need to do: it does not rewrite `CLAUDE.md`, the kit's skills or the relay server's instructions, which are the owners the prompts point at. It does not change when any prompt fires or what any tool does. It does not decide which persona may hold which tool. It does not add a rule about prose anywhere, since the rule already exists in the doctrine and in the lean-kit program's "one owner per moment" decision, and a new rule is the growth under diagnosis.

Refused alternatives: trimming the one block the operator saw, refused because it fixes the sample and not the pattern. A doctrine or `CLAUDE.md` sentence about injected prompts, refused for the reason above. Registering `fleet_status` only for the coordinator, refused here because it changes behavior and the description trim removes most of the cost; it is recorded under Open Questions.

Provenance: the coordinator persona's inventory of 2026-09-18, measured from the source strings, and the kit's `docs/plans/claude-kit_lean-kit_program_v1.md` and `docs/plans/claude-kit_goal-fit_spec_v1.md`, whose decisions this plan applies in this repository.

## Approach

**The rule each edit applies.** For every sentence in an injected string, name the surface that already carries its content. Where one exists, the sentence goes, and the string keeps at most one pointer to that surface. Where none exists and the content is a standing rule rather than this prompt's own instruction, the sentence moves to the owner, which is `CLAUDE.md` for writing and channel conduct, the kit's role skill for a seat's duties, and the tool's description for a tool's contract. Where none exists and the content is what to do with this prompt, the sentence stays. The lean-kit program's "one owner per moment" is the rule; this paragraph is how it is applied to a prompt.

**The base.** This plan's base is the trunk after `docs/plans/agent_persona_steward-architect_v1.md` merges. The strings the sections name are the ones on that plan's branch at `3c03886` and in its Section 6 worked tree, which is where the architect instruction, the `fleet_status` tool and the `[FLEET]` and `[RECONCILE]` frames live; the trunk at `8e177ce` has four instruction strings and none of those. A string a section names that does not exist at the executing base makes that clause void, and the Chapter says so.

**What the inventory found.** Measured 2026-09-18 from `bin/supervise.sh` and `hooks/index.ts` on the steward-architect branch at `3c03886` and its worked tree. The startup message is assembled at the `printf` that writes `$SKILL_LOAD_INSTRUCTION$COORDINATOR_STEER_INSTRUCTION$COORDINATOR_ROLE_INSTRUCTION$ARCHITECT_ROLE_INSTRUCTION$CHANNEL_REPLY_INSTRUCTION` and the priming body to the child. Its parts: the skill-load instruction at 518 characters, the coordinator steer instruction at 1,389, the channel instruction at 1,564, the coordinator role instruction at 3,711 with its fleet, seat and architect clauses at 1,408, 614 and 1,761, and the architect role instruction at 5,574. The channel instruction is byte-identical to `REPLY_INSTRUCTION` in `hooks/index.ts`, and 19 of its 21 sentences are verbatim in `CLAUDE.md`, the other two restating the relay server's own instructions. `REPLY_INSTRUCTION` is prepended to the still-waiting re-raise, the fleet reading, the kaizen announcement and the reply backstop. The coordinator role instruction restates the `agentic_say`, `agentic_inbox` and `agentic_resolve` descriptions; its fleet clause and the `fleet_status` description each define the same health classes; the architect instruction overrides two instructions the same message injected and states its clone rule three times. The tool descriptions total about 10,700 characters, `fleet_status` at 3,547, and are registered into every session. The per-prompt context blocks (`[GOAL TREE]`, `[NO GOAL]`, the idle nudges) repeat the `goal_done` clause among themselves.

**The guard.** `.kit/injection-ledger.mjs` extracts every injected string and tool description from the two source files by the anchors the sections name, and prints each with its size. `.kit/injection-duplicate-test.mjs` runs it and fails on any sentence of eight words or more that appears in `CLAUDE.md` or in another injected string, and on any string whose size exceeds the number recorded for it in `.kit/injection-ledger.json`. The check exempts nothing, so a sentence two prompts both need is a sentence with one owner and a pointer, never two copies. The reply-tool sentence's owner is the startup message, which every channel-attached child reads once; each recurring prompt names the reply tool inside its own instruction in its own words, and the `REPLY_INSTRUCTION` prefix goes. A string that grows raises its own number in the same commit, which is the lean-kit program's "growth is declared" decision at this repository's scale. The test is offline, so it runs beside a live fleet.

**Order.** This plan runs after `docs/plans/agent_persona_steward-architect_v1.md`, because that plan's worked copy already rewrites the coordinator and architect instructions on its branch and a trim landed first would be overwritten. It runs after `docs/plans/agent_persona_context-budget-removal_v1.md`, because that plan deletes the `[BUDGET]` prompt this one would otherwise trim. It runs before `docs/plans/agent_persona_supervisor-peer_v1.md`, so that plan's one new priming sentence is written under the guard. The order is the operator's at arming, except that this plan cannot run before steward-architect.

## Sections of Work

### 1. The ledger and the baseline
Model: sonnet

`.kit/injection-ledger.mjs` reads `bin/supervise.sh` and `hooks/index.ts`, extracts each injected string by name, and prints a JSON array of `{ name, file, chars, words }`. The names are the five `*_INSTRUCTION` variables and the three priming bodies in the supervisor, and in the plugin `REPLY_INSTRUCTION`, each prompt frame's literal text at its call site where it reaches `submitExpectedTurn` or `$.prompt.submit`, with interpolated content excluded, each `prompt.submit` context block's literal text, and each registered tool's description with its parameter descriptions. `.kit/injection-ledger.json` is written from that output at the section's base and committed. `.kit/injection-duplicate-test.mjs` lands with the duplicate check and the size check, and its exit code at the base is recorded in the Chapter: red, with the count of duplicate sentences it found, which is the baseline every later section reports against.

Acceptance: the ledger's names cover every string the Approach's inventory lists, and the Chapter shows the ledger's output at the base; the test is red at the base with its duplicate count named; `README.md`'s Test Coverage list names the new test among the offline suites, since the repository has no offline runner and that list is how a suite is found.

Files in scope: `.kit/injection-ledger.mjs` (new), `.kit/injection-ledger.json` (new), `.kit/injection-duplicate-test.mjs` (new), `README.md` (the Test Coverage list).

Tests: at minimum, lock that the duplicate check speaks on a fixture string carrying one `CLAUDE.md` sentence and stays silent on one carrying none, because a guard that is silent for the wrong reason is the failure this plan exists to catch.

### 2. The startup message
Model: opus

Each `*_INSTRUCTION` string in `bin/supervise.sh` is rewritten under the Approach's rule. The channel instruction becomes the reply-tool sentence and a pointer to `CLAUDE.md`. The coordinator role instruction keeps the label semantics and the compaction-boundary clause, and points at the kit's role skill and the three tool descriptions for the rest; its fleet clause keeps the meaning of `[FLEET]` and points at `fleet_status` for the classes. The architect role instruction loses its overrides of the skill-load and steer sentences, which are instead conditioned out of the message for the architect at assembly, and states its clone rule once. The steer instruction takes the same rule as the others: its label semantics stay, since nothing else carries them, and a sentence that restates the `agentic_resolve` description or the doctrine's data-not-instructions bullet points there instead. A sentence that moves rather than goes lands in its owner in the same commit where the owner is in this repository. A sentence whose owner is the kit stays in place and is named in the Chapter as owed to a kit plan, with a kaizen note filed, since a kit surface cannot be edited from here. The parity pin in `.kit/channel-reply-instruction-test.sh` that holds the channel string byte-identical to `REPLY_INSTRUCTION` is removed in this section, because Section 3 deletes that constant. `.kit/channel-reply-instruction-test.sh` is rewritten to pin the sentences that stay and the absence of the ones that went. The Chapter records each string's size before and after, and for every sentence removed names the surface that carries it, and for every sentence kept says why none does. That accounting is the acceptance, not a size.

Acceptance: `.kit/injection-duplicate-test.mjs` reports no duplicate in any supervisor string; every string's ledger number is lowered to its new size in the same commit; `.kit/channel-reply-instruction-test.sh` passes; the Chapter carries the sentence accounting for every string; and one real `claude -p` child launched with `--no-channel` under a scratch persona answers the priming turn with its one line, recorded in the Chapter with the command and output, which checks that the trimmed skill-load and steer strings still assemble into one priming turn and does not exercise the channel string, since `--no-channel` leaves it empty.

Files in scope: `bin/supervise.sh`, `.kit/channel-reply-instruction-test.sh`, `.kit/injection-ledger.json`, `README.md` (the priming-text paragraph and the Test Coverage entry for the channel-reply test), `CLAUDE.md` where a sentence lands there.

Tests: at minimum, lock that the steer label semantics survive for a worker and that the coordinator's message carries no tool contract, because a worker that loses the label misreads a steer as the operator, and the coordinator's message is where the copies were.

### 3. The recurring prompts and context blocks
Model: opus

`REPLY_INSTRUCTION` in `hooks/index.ts` is deleted. Each frame it prefixed keeps its label and its one instruction, which names the reply tool in its own words where the frame's text goes to the operator. The `[GOAL TREE]`, `[NO GOAL]` and idle-nudge texts are rewritten so the `goal_done` clause appears once, in the `goal_done` description, and the blocks point at it. The `[FLEET]` and `[RECONCILE]` frames, which the steward-architect plan's Section 6 adds to `hooks/index.ts`, keep their label and one instruction and point at the `fleet_status` description and the kit's coordinator skill for the rest. The `[BUDGET]` text is absent by this point, and the section asserts that. The Chapter carries the same sentence accounting Section 2 carries. `.kit/controller-tick-test.mjs` and any other suite that pins these strings are edited to the new wording. The Chapter records each string's size before and after.

Acceptance: the duplicate test reports no duplicate in any plugin string; every ledger number is lowered in the same commit; the tick and prompt suites pass with their counts reported against the section's base; and the plugin builds.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs` where a fixture pins wording, `.kit/injection-ledger.json`, `README.md` (the prompt-label table, if one exists).

Tests: at minimum, lock that the reply backstop still opens with its label and the answer, because a backstop that loses its shape resends nothing.

### 4. The tool descriptions
Model: opus

Each registered tool's description in `hooks/index.ts` is rewritten to its contract: what the tool does, its parameters, and what it returns or refuses. Role guidance in a description, such as what to do with a `fleet_status` reading, moves to the prompt that delivers the reading where that prompt owns it. Guidance whose owner is the kit's role skill stays in place and is named in the Chapter as owed to a kit plan, with a kaizen note filed. The health-class definitions live in the `fleet_status` description once, and the `[FLEET]` frame points at it. The Chapter records each description's size before and after.

Acceptance: the duplicate test reports no duplicate across the descriptions and the prompts; every ledger number is lowered in the same commit; the Chapter carries the sentence accounting for every description and the descriptions' total before and after; the suites that pin a description pass.

Files in scope: `hooks/index.ts`, `.kit/injection-ledger.json`, the suite that pins a description, `README.md` (the tool table).

Tests: at minimum, lock that each tool's parameter names in its description match its schema, because a description trimmed past its contract is a tool the session cannot call.

### 5. Close
Model: sonnet

`README.md` is read where it describes the priming text, the prompt labels and the tools, and each sentence is restated for the as-built strings. `docs/README.md` moves this plan's index line as the curating-docs skill states. The Chapter carries the final ledger beside the baseline, and the totals the Goal names.

Acceptance: every offline suite the README's Test Coverage list names passes, the duplicate test among them, each exit code read from its run; the README paragraphs named are read by the section's reviewer pair against the strings; the ledger totals in the Chapter are read from the ledger script's own run.

Files in scope: `README.md`, `docs/README.md`, this plan document.

## Out of Scope

- `CLAUDE.md`, the kit's skills and the relay server's instructions, except where Section 2 moves a sentence into `CLAUDE.md` as its owner.
- When any prompt fires, what any tool does, and which persona holds which tool.
- The steward-architect plan's own rewrite of the coordinator and architect instructions. This plan runs after it and trims what it leaves.
- The doctrine's own copy in the output style, which the kit pins.

## Assumptions

- decided 2026-09-18 by the operator on the coordinator's thread: the runs that hold the box are deferred to one end-run, `docs/plans/agent_persona_deferred-gate-run_v1.md`, which states the gate policy whole. Under it, `.kit/live-all.sh`, every `.kit/live-*-test.sh`, `.kit/supervisor-natural-exit-test.sh` and any check that launches a `claude` child or runs past two minutes of wall clock do not run at this plan's section closes or its finishing pass. Every other check this plan names still runs. A Chapter names each deferred run as deferred, never as passed. Where an acceptance line above names a deferred suite, that clause is met by the end-run.
- decided 2026-09-18 by the operator on the coordinator's thread: the pass is worth doing as a plan of its own. The words are in the Intent.
- assumed 2026-09-18 (default): the order the Approach states, after steward-architect and the context-budget removal and before supervisor-peer; reversal: the operator's word at arming, except that running before steward-architect is not available, since the strings Sections 2 to 4 name exist only once that plan merges.
- assumed 2026-09-18 (default): eight words is the duplicate bound; reversal: one constant in the test, and a lower bound catches pointers as duplicates.
- assumed 2026-09-18 (sibling plans): Branch-and-PR; reversal: none, a header edit.

## Operator Verification

1. After the merge and the installed plugin's update, each persona relaunched at the operator's convenience. The outcome that holds the work: one transcript per persona shows the trimmed startup message, and a kaizen or fleet prompt in a transcript shows one sentence of instruction and its label rather than the block the operator saw on 2026-09-18.

## Open Questions

- Whether `fleet_status` should be registered only for the coordinator and its readers, since a worker cannot call it. Not in this plan. Owner: the operator, after this plan's numbers are in.
- Whether the duplicate test should also read the doctrine file under the operator's profile. Not in this plan, because a repository test should not depend on a file outside the repository; the sentences it would catch are the ones `CLAUDE.md` already carries. Owner: the operator, at arming.

## Related

- `docs/plans/claude-kit_lean-kit_program_v1.md` in the claude-kit repository: the decisions this plan applies, growth declared and one owner per moment.
- `docs/plans/claude-kit_goal-fit_spec_v1.md` in the claude-kit repository: the intent record this plan's Intent section follows.
- `docs/plans/agent_persona_steward-architect_v1.md`: runs before this plan and rewrites two of the strings it trims.
- `docs/plans/agent_persona_context-budget-removal_v1.md`: runs before this plan and deletes the `[BUDGET]` prompt.
- `docs/plans/agent_persona_supervisor-peer_v1.md`: runs after this plan and adds one priming sentence under the guard.

## Chapters

### Interim board 1 - 2026-09-18

Not a Chapter. Section 1 is unstarted and no repository file changed beyond this document.

**Stage.** The armed queue's leash advanced to this plan after `docs/plans/agent_persona_context-budget-removal_v1.md` was recorded blocked. Nothing of this plan ran. The `Status:` header stays at `Ready`, because the run is not starting.

**The preceding plan's blocker was tested and does not carry, but this plan's own gate is unmet.** That blocker is the context-budget plan's ordering bar, which is specific to that plan. It stops nothing here. What stops this plan is its own text, read this session from this file. Line 33 states "this plan cannot run before steward-architect". Line 27 sets this plan's base as the trunk after that plan merges, and states that the strings Sections 2 to 4 rewrite exist only on that plan's branch until then. Line 101 records the reversal as unavailable for the same reason. So the bar here is not a preference about ordering. Sections 2 to 4 have nothing to edit at `origin/main`.

**The queue is one chain.** `docs/plans/agent_persona_context-budget-removal_v1.md`'s interim board 3 carries the full analysis, including the operator's recorded word on the order and the corrections to three readings this run had wrong. It is not repeated here.

**Gate baseline.** None taken. No repository code changed, so no test lane ran and there is nothing to diff.

**Live dispatches.** None.

**Asks in flight.** One to the repository's Expert seat, recorded in the context-budget plan's board 3, covering this whole set of ordering blocks. It does not gate and was unanswered at the time of writing.

**Next action.** Nothing, until `docs/plans/agent_persona_steward-architect_v1.md` closes and merges. Section 1 then starts by building the injection ledger against the merged trunk and recording the duplicate test's red baseline.

### Interim board 2 - 2026-09-19

Not a Chapter. Section 1 is still unstarted and no repository code changed. The `Status:` header stays at `Ready`, for the reason board 1 gives.

**Stage.** The armed queue's leash advanced to this plan a second time, after `docs/plans/agent_persona_context-budget-removal_v1.md` was recorded blocked for the fourth time. Nothing of this plan ran.

**The preceding plan's blocker was tested and does not carry.** That blocker is the context-budget plan's own ordering bar: its Assumptions forbid it running beside a plan that edits three named files, and the steward plan edits two of them and is blocked rather than closed. That is a statement about the context-budget plan's files and says nothing about the injection ledger or the strings this plan trims. It stops nothing here.

**This plan's own gate is unmet, re-read from this file this session rather than carried from board 1.** Line 33 states "this plan cannot run before steward-architect". Line 27 sets the base as the trunk after that plan merges, and states that the strings Sections 2 to 4 rewrite live on that plan's branch and in its Section 6 worked tree, with the trunk carrying four instruction strings and none of them. Line 101 records the reversal as unavailable for the same reason. Sections 2 to 4 have nothing to edit at `origin/main`.

**The ground below the chain is confirmed and has moved since board 1.** `docs/plans/agent_persona_steward-architect_v1.md:3` reads `Status: In Progress`, so it has neither closed nor merged. Its blocker is now the ownership fork its interim board 25 records: whether the steward persona gets its own working directory. That is a different question from the one standing at board 1, and it is the operator's to answer. It does not change this plan's bar, which turns on the merge rather than on the reason the merge is waiting.

**Gate baseline.** None taken. No repository code changed, so no test lane ran and there is nothing to diff.

**Live dispatches.** None.

**Asks in flight.** One to the repository's Expert seat, recorded in the context-budget plan's board 3, covering this whole set of ordering blocks. It does not gate and is still unanswered.

**Next action.** Nothing, until `docs/plans/agent_persona_steward-architect_v1.md` closes and merges. Section 1 then starts by building the injection ledger against the merged trunk and recording the duplicate test's red baseline.

### Interim board 3 - 2026-09-19

Not a Chapter. Section 1 is still unstarted and no repository code changed. The `Status:` header stays at `Ready`.

**Stage.** The armed queue's leash advanced to this plan a third time, after `docs/plans/agent_persona_context-budget-removal_v1.md` was recorded blocked for the fifth time. Nothing of this plan ran.

**The preceding plan's blocker was tested and does not carry.** It is the context-budget plan's own bar against running beside a plan that edits three named files. That says nothing about the injection ledger or the strings this plan trims.

**This plan's gate is confirmed unmet from the trunk's content, which is a different reading from boards 1 and 2.** Those argued from this document's own sentences. This one opened the files at `origin/main`, now `266b396`. `bin/supervise.sh` there carries no `ARCHITECT_ROLE_INSTRUCTION`, and `hooks/index.ts` there carries no `[FLEET]` frame, no `[RECONCILE]` frame and no `fleet_status` tool. So Section 2 has no architect string to rewrite, Section 3 has no fleet frames to trim, and Section 4 has no `fleet_status` description to reduce. `REPLY_INSTRUCTION` is the one named string that does exist at the trunk, at five occurrences.

Section 1 is gated by the same fact rather than merely by the order. Its acceptance requires the ledger's names to cover every string the Approach's inventory lists, and four of those strings are absent at the trunk. A ledger built there would record a baseline that every later section reports against, and it would be the wrong baseline.

**The ground below the chain has moved again since board 2.** `docs/plans/agent_persona_steward-architect_v1.md:3` still reads `Status: In Progress`. Its blocker is no longer the working-directory ownership fork board 2 names. It is now the review-round backstop question its Section 6 records, which is the operator's to answer. No pull request exists for the `steward-architect` branch in any state, so the merge this plan's base waits on has not been opened, let alone landed.

**Gate baseline.** None taken. No repository code changed, so no test lane ran and there is nothing to diff.

**Live dispatches.** None.

**Asks in flight.** One to the repository's Expert seat, recorded in the context-budget plan's board 3, covering this whole set of ordering blocks. It does not gate and is still unanswered.

**Next action.** Nothing, until `docs/plans/agent_persona_steward-architect_v1.md` closes and merges. Section 1 then starts by building the injection ledger against the merged trunk and recording the duplicate test's red baseline.
