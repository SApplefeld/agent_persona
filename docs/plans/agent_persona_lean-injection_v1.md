# Lean injection: every injected prompt says only what its reader cannot already know

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-18

## Goal

When this is done, every prompt the plugin or the supervisor writes into a session, and every tool description the plugin registers, carries only what that session cannot already hold: the meaning of the label at the prompt's head, what to do with this one prompt, and a pointer to the surface that owns the rest. The writing rules live in `CLAUDE.md`, the roles live in the kit's skills, and each tool's contract lives in that tool's description, each once. A test fails the build when an injected string repeats a sentence that `CLAUDE.md` or another injected string already carries, and a ledger records each injected string's size so growth is declared rather than discovered. It matters because a worker's startup message today carries about 4,000 characters of instruction, the coordinator's about 11,200, and every plugin-submitted prompt for the operator's eyes carries a further 1,564 of which 19 of 21 sentences are copied from `CLAUDE.md`.

## Dispatch Authorization

The operator armed execution of this plan on 2026-09-19, naming it in a `/kit-goal` invocation relayed to the executing session on the operator's own channel. Under the kit-goal skill's arming-is-approval rule that invocation carries the authority of a typed "proceed", so this plan is approved as written and no separate approval is waited on. The authorization to author is the operator's request of 2026-09-18 recorded in the Intent below, in the words "Are there a whole bunch of detailed, redundant, injected instructions that we should be doing a pass over and trimming down to avoid overcomplicating what the plugin guidance is trying to give?".

This section was absent until the arming. Its absence was a document defect rather than a decision: every sibling plan in this queue carries one, and the arming tool reported this plan as having no authorization recorded, which reads to a later session as a plan nobody approved. The record is kept here because the arming state does not keep it. A run that re-arms a queue for itself after a session ends records its own invocation and no longer reads the operator's, so a session reading only that state would find this plan unarmed. The project memory record `self-armed-arming-does-not-satisfy-an-operator-only-execution-grant` holds the general shape.

## Intent

The operator's words on 2026-09-18, on the coordinator's Discord thread, after seeing a kaizen prompt in a transcript: "It's not so much that I have a problem with that particular sentence or its existence. It's more that I'm looking for signals that flag excessive growth and excessive detailed instruction." "We're having a lot of problems with there just being too much prose, too much specificity, not enough high-level goal, high-level guidance, high-level lesson." "Are there a whole bunch of detailed, redundant, injected instructions that we should be doing a pass over and trimming down to avoid overcomplicating what the plugin guidance is trying to give?" On the cause: "things are being added in isolation without a larger goal-vision-type structure."

What done looks like: each injected prompt is short and points at its owner, the pass covers the pattern and not one block, and a mechanical signal catches the next copy so nobody has to spot it by eye.

What done does not need to do: it does not rewrite `CLAUDE.md`, the kit's skills or the relay server's instructions, which are the owners the prompts point at. It does not change when any prompt fires or what any tool does. It does not decide which persona may hold which tool. It does not add a rule about prose anywhere, since the rule already exists in the doctrine and in the lean-kit program's "one owner per moment" decision, and a new rule is the growth under diagnosis.

Refused alternatives: trimming the one block the operator saw, refused because it fixes the sample and not the pattern. A doctrine or `CLAUDE.md` sentence about injected prompts, refused for the reason above. Registering `fleet_status` only for the coordinator, refused here because it changes behavior and the description trim removes most of the cost; it is recorded under Open Questions.

Provenance: the coordinator persona's inventory of 2026-09-18, measured from the source strings, and the kit's `docs/plans/claude-kit_lean-kit_program_v1.md` and `docs/plans/claude-kit_goal-fit_spec_v1.md`, whose decisions this plan applies in this repository.

## Approach

**The rule each edit applies.** For every sentence in an injected string, name the surface that already carries its content. Where one exists, the sentence goes, and the string keeps at most one pointer to that surface. Where none exists and the content is a standing rule rather than this prompt's own instruction, the sentence moves to the owner, which is `CLAUDE.md` for writing and channel conduct, the kit's role skill for a seat's duties, and the tool's description for a tool's contract. Where none exists and the content is what to do with this prompt, the sentence stays. The lean-kit program's "one owner per moment" is the rule; this paragraph is how it is applied to a prompt.

**The base.** This plan's base is the trunk after `docs/archive/agent_persona_steward-architect_v1.md` merges. The strings the sections name are the ones on that plan's branch at `3c03886` and in its Section 6 worked tree, which is where the architect instruction, the `fleet_status` tool and the `[FLEET]` and `[RECONCILE]` frames live; the trunk at `8e177ce` has four instruction strings and none of those. A string a section names that does not exist at the executing base makes that clause void, and the Chapter says so.

**What the inventory found.** Measured 2026-09-18 from `bin/supervise.sh` and `hooks/index.ts` on the steward-architect branch at `3c03886` and its worked tree. The startup message is assembled at the `printf` that writes `$SKILL_LOAD_INSTRUCTION$COORDINATOR_STEER_INSTRUCTION$COORDINATOR_ROLE_INSTRUCTION$ARCHITECT_ROLE_INSTRUCTION$CHANNEL_REPLY_INSTRUCTION` and the priming body to the child. Its parts: the skill-load instruction at 518 characters, the coordinator steer instruction at 1,389, the channel instruction at 1,564, the coordinator role instruction at 3,711 with its fleet, seat and architect clauses at 1,408, 614 and 1,761, and the architect role instruction at 5,574. The channel instruction is byte-identical to `REPLY_INSTRUCTION` in `hooks/index.ts`, and 19 of its 21 sentences are verbatim in `CLAUDE.md`, the other two restating the relay server's own instructions. `REPLY_INSTRUCTION` is prepended to the still-waiting re-raise, the fleet reading, the kaizen announcement and the reply backstop. The coordinator role instruction restates the `agentic_say`, `agentic_inbox` and `agentic_resolve` descriptions; its fleet clause and the `fleet_status` description each define the same health classes; the architect instruction overrides two instructions the same message injected and states its clone rule three times. The tool descriptions total about 10,700 characters, `fleet_status` at 3,547, and are registered into every session. The per-prompt context blocks (`[GOAL TREE]`, `[NO GOAL]`, the idle nudges) repeat the `goal_done` clause among themselves.

**The guard.** `.kit/injection-ledger.mjs` extracts every injected string and tool description from the two source files by the anchors the sections name, and prints each with its size. `.kit/injection-duplicate-test.mjs` runs it and fails on any sentence of eight words or more that appears in `CLAUDE.md` or in another injected string, and on any string whose size exceeds the number recorded for it in `.kit/injection-ledger.json`. The check exempts nothing, so a sentence two prompts both need is a sentence with one owner and a pointer, never two copies. The reply-tool sentence's owner is the startup message, which every channel-attached child reads once; each recurring prompt names the reply tool inside its own instruction in its own words, and the `REPLY_INSTRUCTION` prefix goes. A string that grows raises its own number in the same commit, which is the lean-kit program's "growth is declared" decision at this repository's scale. The test is offline, so it runs beside a live fleet.

**Order.** This plan runs after `docs/archive/agent_persona_steward-architect_v1.md`, because that plan's worked copy already rewrites the coordinator and architect instructions on its branch and a trim landed first would be overwritten. It runs after `docs/plans/agent_persona_context-budget-removal_v1.md`, because that plan deletes the `[BUDGET]` prompt this one would otherwise trim. It runs before `docs/plans/agent_persona_supervisor-peer_v1.md`, so that plan's one new priming sentence is written under the guard. The order is the operator's at arming, except that this plan cannot run before steward-architect.

## Sections of Work

### 1. The ledger and the baseline
Model: sonnet

`.kit/injection-ledger.mjs` reads `bin/supervise.sh` and `hooks/index.ts`, extracts each injected string by name, and prints a JSON array of `{ name, file, chars, words }`. The names are the five `*_INSTRUCTION` variables and the three priming bodies in the supervisor, and in the plugin `REPLY_INSTRUCTION`, each prompt frame's literal text at its call site where it reaches `submitExpectedTurn` or `$.prompt.submit`, with interpolated content excluded, each `prompt.submit` context block's literal text, and each registered tool's description with its parameter descriptions. `.kit/injection-ledger.json` is written from that output at the section's base and committed. `.kit/injection-duplicate-test.mjs` lands with the duplicate check and the size check, and its exit code at the base is recorded in the Chapter: red, with the count of duplicate sentences it found, which is the baseline every later section reports against.

Acceptance: the ledger's names cover every string the Approach's inventory lists, and the Chapter shows the ledger's output at the base; the test is red at the base with its duplicate count named; `README.md`'s Test Coverage list names the new test among the offline suites, since the repository has no offline runner and that list is how a suite is found.

Files in scope: `.kit/injection-ledger.mjs` (new), `.kit/injection-ledger.json` (new), `.kit/injection-duplicate-test.mjs` (new), `README.md` (the Test Coverage list), `.kit/.gitignore` (folded in: the directory is ignored by a blanket rule with a per-file allowlist, so the three new files are uncommittable without an allowlist entry).

Tests: at minimum, lock that the duplicate check speaks on a fixture string carrying one `CLAUDE.md` sentence and stays silent on one carrying none, because a guard that is silent for the wrong reason is the failure this plan exists to catch.

### 2. The startup message
Model: opus

Each `*_INSTRUCTION` string in `bin/supervise.sh` is rewritten under the Approach's rule. The channel instruction becomes the reply-tool sentence and a pointer to `CLAUDE.md`. The coordinator role instruction keeps the label semantics and the compaction-boundary clause, and points at the kit's role skill and the three tool descriptions for the rest; its fleet clause keeps the meaning of `[FLEET]` and points at `fleet_status` for the classes. The architect role instruction loses its overrides of the skill-load and steer sentences, which are instead conditioned out of the message for the architect at assembly, and states its clone rule once. The steer instruction takes the same rule as the others: its label semantics stay, since nothing else carries them, and a sentence that restates the `agentic_resolve` description or the doctrine's data-not-instructions bullet points there instead. A sentence that moves rather than goes lands in its owner in the same commit where the owner is in this repository. A sentence whose owner is the kit stays in place and is named in the Chapter as owed to a kit plan, with a kaizen note filed, since a kit surface cannot be edited from here. The parity pin in `.kit/channel-reply-instruction-test.sh` that holds the channel string byte-identical to `REPLY_INSTRUCTION` is removed in this section, because Section 3 deletes that constant. `.kit/channel-reply-instruction-test.sh` is rewritten to pin the sentences that stay and the absence of the ones that went. The Chapter records each string's size before and after, and for every sentence removed names the surface that carries it, and for every sentence kept says why none does. That accounting is the acceptance, not a size.

Acceptance: `.kit/injection-duplicate-test.mjs` reports no duplicate in any supervisor string; every string's ledger number is lowered to its new size in the same commit; `.kit/channel-reply-instruction-test.sh` passes; the Chapter carries the sentence accounting for every string; and one real `claude -p` child launched with `--no-channel` under a scratch persona answers the priming turn with its one line, recorded in the Chapter with the command and output, which checks that the trimmed skill-load and steer strings still assemble into one priming turn and does not exercise the channel string, since `--no-channel` leaves it empty.

Files in scope: `bin/supervise.sh`, `.kit/channel-reply-instruction-test.sh`, `.kit/injection-ledger.json`, `README.md` (the priming-text paragraph and the Test Coverage entry for the channel-reply test), `CLAUDE.md` where a sentence lands there.

Tests: at minimum, lock that the steer label semantics survive for a worker and that the coordinator's message carries no tool contract, because a worker that loses the label misreads a steer as the operator, and the coordinator's message is where the copies were.

### 3. The recurring prompts and context blocks
Model: opus

`REPLY_INSTRUCTION` in `hooks/index.ts` is deleted. Each frame it prefixed keeps its label and its one instruction, which names the reply tool in its own words where the frame's text goes to the operator. The `[GOAL TREE]`, `[NO GOAL]` and idle-nudge texts are rewritten so the `goal_done` clause appears once, in the `goal_done` description, and the blocks point at it. The `[FLEET]` and `[RECONCILE]` frames, which the steward-architect plan's Section 6 adds to `hooks/index.ts`, keep their label and one instruction and point at the `fleet_status` description and the kit's coordinator skill for the rest. The `[BUDGET]` text is absent by this point, and the section asserts that. The authored prose of a fleet note's `composed` half is this section's too, and it is named here because Section 1's review found it reaching the child unsized: nineteen `composed:` sites in `hooks/index.ts`, several of them a sentence or more, which join a `[FLEET]` line through an interpolation and which Section 1's extraction therefore excludes by construction. This section gives them a rule that sizes their literal text, brings them under the duplicate check, and rewrites them under the Approach's rule like any other injected prose. The Chapter carries the same sentence accounting Section 2 carries. `.kit/controller-tick-test.mjs` and any other suite that pins these strings are edited to the new wording. The Chapter records each string's size before and after.

Acceptance: the duplicate test reports no duplicate in any plugin string; every ledger number is lowered in the same commit; the fleet notes' authored prose is one or more ledger entries and the ledger's header no longer names it as a gap; the tick and prompt suites pass with their counts reported against the section's base; and the plugin builds.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs` where a fixture pins wording, `.kit/injection-ledger.mjs` (the rule that sizes the fleet notes' authored prose), `.kit/injection-duplicate-test.mjs` (its control), `.kit/injection-ledger.json`, `README.md` (the prompt-label table, if one exists, and the coverage sentence that currently names this prose as unsized).

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
- `docs/archive/agent_persona_steward-architect_v1.md`: runs before this plan and rewrites two of the strings it trims.
- `docs/archive/agent_persona_context-budget-removal_v1.md`: ran before this plan and deleted the `[BUDGET]` prompt.
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

### Interim board 4 - 2026-09-19

Not a Chapter. Section 1 is still unstarted and no repository code changed. The `Status:` header stays at `Ready`, for the reason board 1 gives.

**Stage.** The armed queue's leash advanced to this plan a fourth time, after `docs/plans/agent_persona_context-budget-removal_v1.md` was recorded blocked for the sixth time. Nothing of this plan ran.

**The preceding plan's blocker was tested and does not carry.** It is the context-budget plan's own bar against running beside a plan that edits `bin/supervise.sh`, `bin/supervise-decide.mjs` or `hooks/index.ts`, together with the operator's recorded word on the order. That is a statement about that plan's files and about its place in the queue. It says nothing about the injection ledger or the strings this plan trims, and it is not the ground below.

**This plan's gate is confirmed unmet from the trunk's own content, measured this session and sharper than board 3's reading.** `origin/main` is at `266b396`, unmoved since board 3. Predicate `git grep -c` over `bin/supervise.sh` and `hooks/index.ts` at that ref, for each string Sections 2 to 4 name: `ARCHITECT_ROLE_INSTRUCTION`, `[FLEET]`, `[RECONCILE]` and `fleet_status` all returned no match. The control was `REPLY_INSTRUCTION` over the same two files at the same ref, which returned 4 and 5, so the predicate and the scope both speak.

The count settles Section 1 on its own terms rather than by order alone. `git grep -o -E "[A-Z_]+_INSTRUCTION=" ` over `bin/supervise.sh` at that ref returns exactly four names: `CHANNEL_REPLY_INSTRUCTION`, `COORDINATOR_ROLE_INSTRUCTION`, `COORDINATOR_STEER_INSTRUCTION` and `SKILL_LOAD_INSTRUCTION`. Section 1's own text names "the five `*_INSTRUCTION` variables", and its acceptance requires the ledger's names to cover every string the Approach's inventory lists. A ledger built at this base would be short by one instruction string, one tool description and two prompt frames, and it would be the baseline every later section reports against.

**One route was considered and rejected, recorded so it is not re-litigated.** Two of Section 1's three new files, the ledger script and the duplicate test, extract by anchor and would run against either base, so only `.kit/injection-ledger.json` is base-dependent. Writing the two now was rejected on two grounds. The checkout sits on `steward-architect`, so a commit would land this plan's work on another plan's branch and into that plan's pull request, against the doctrine's stay-in-scope rule. And the Approach's base paragraph sets the base as the trunk after that plan merges, which is a statement about where the work lands rather than about the order it runs in.

**The ground below the chain, re-read rather than carried.** `docs/plans/agent_persona_steward-architect_v1.md:3` still reads `Status: In Progress`. `gh pr list --head steward-architect --state all` returns an empty list, so no pull request has been opened in any state and the merge this plan's base waits on has not happened. That plan's current blocker is the review-round backstop its Section 5 records, which is the operator's to answer.

**Gate baseline.** None taken. No repository code changed beyond this document, so no test lane ran and there is nothing to diff.

**Live dispatches.** None.

**Asks in flight.** None of this plan's own. An ask to the repository's Expert seat covering this set of ordering blocks went out again this session under the context-budget plan's declaration, and remains unanswered, as do the two before it.

**Next action.** Nothing, until `docs/plans/agent_persona_steward-architect_v1.md` closes and merges. Section 1 then starts by building the injection ledger against the merged trunk and recording the duplicate test's red baseline.

### Interim board 5 - 2026-09-19

Not a Chapter. Section 1 is still unstarted and no repository code changed. The `Status:` header stays at `Ready`, for the reason board 1 gives.

**Stage.** The armed queue's leash advanced to this plan a fifth time, after `docs/plans/agent_persona_context-budget-removal_v1.md` was recorded blocked for the seventh time. The plan before that one in the queue, `docs/archive/agent_persona_steward-architect_v1.md`, is now Complete and archived, which is new. Nothing of this plan ran.

**The preceding plan's blocker was tested and half of it carries, which is a different answer from boards 1 to 4.** That blocker was recorded as: pull request 49 merged, and the operator's word to arm execution. Its first half is not specific to the context-budget plan at all. This plan's own Approach at line 27 fixes its base as the trunk after the steward plan merges, and line 33 states this plan cannot run before it. So the merge is this plan's own bar on this plan's own text, reached independently rather than inherited. Its second half does not carry as written, because that blocker turned on the context-budget plan's own grant covering authoring rather than execution. This plan's authorization problem is a different one, recorded below.

**The base bar is confirmed unmet, re-measured this session rather than carried.** `git fetch` then `git rev-parse origin/main` returns `266b396`, unmoved since board 4. A predicate `git grep -c` at that ref over `bin/supervise.sh` and `hooks/index.ts` returns no match for `ARCHITECT_ROLE_INSTRUCTION`, `[FLEET]`, `[RECONCILE]` or `fleet_status`. The control was `REPLY_INSTRUCTION` over the same two files at the same ref, returning 4 and 5, so the predicate and the scope both speak. `gh pr view 49` reports state OPEN, `mergedAt` null, `reviewDecision` REVIEW_REQUIRED, with auto-merge enabled at 2026-09-19T23:42:04Z. So the merge has not happened and one approval is what causes it.

**A new fact boards 1 to 4 did not have: the content base now exists on a branch, though not on the trunk.** The checkout sits on `context-budget-removal`, cut from the steward plan's tip. The same predicate at `HEAD` returns `ARCHITECT_ROLE_INSTRUCTION` 3, `[FLEET]` 2 and 14, `[RECONCILE]` 2 and 12, and `fleet_status` 2 and 12 across the two files. `git grep -o -E "[A-Z_]+_INSTRUCTION=" ` at `HEAD` over `bin/supervise.sh` returns exactly the five names Section 1 expects. So Sections 2 to 4 have their strings here and Section 1 would build a correct ledger baseline here. What is absent is not the content but the trunk the plan names as the place the work lands. Board 4's rejection of starting early rested partly on the checkout sitting on another plan's pull request branch, and that ground is gone. The other ground, the Approach's base paragraph, stands.

**The authorization bar, which no earlier board of this plan examined.** `kit-goal.js status` reports this plan as "(armed: recorded as this run's own arming) (authorization: none recorded)". The two plans behind it in the queue each report an authorization sentence, so the gap is this plan's rather than the queue's. A grep of this file for `Dispatch Authorization` returns nothing, which agrees with the goal state. The kit-goal skill states that an armed plan is approved by the arming act, and that where a run armed the plan for itself the committed `## Dispatch Authorization` grant it traced stands in the typed invocation's place. With no such section there is nothing to stand in that place, so the arming in force carries no approval for executing this plan. That is a defect in the plan document rather than a fact about the work, and it is fixed by the operator's word or by a grant committed into this file.

**Both bars resolve together.** One operator act approving pull request 49 lands the merge. One word arming execution answers the authorization. Neither is something this session can supply for itself.

**Gate baseline.** None taken. No repository code changed beyond this document, so no test lane ran and there is nothing to diff.

**Live dispatches.** None.

**Asks in flight.** One to the repository's Expert seat, sent this session, asking whether an operator authorization for this plan exists somewhere the goal state does not reach, and whether the absent section reads differently given the plan predates the section becoming usual. A notice went to the `coordinator` seat. The asks recorded at boards 1 to 4 are unanswered and are now moot, having turned on the steward plan being unfinished.

**Commit note.** This entry is committed on `context-budget-removal` rather than on a branch of its own. That branch is this run's holding place for queue bookkeeping while pull request 49 is frozen, and it already carries the context-budget plan's board 7. A branch per board entry would leave the operator a sprawl to clean up for no gain.

**Next action.** Nothing, until pull request 49 merges and the operator arms execution. Section 1 then starts by building the injection ledger against the merged trunk and recording the duplicate test's red baseline.

### Interim board 6 - 2026-09-19

Not a Chapter. Section 1 is built, reviewed once, fixed and re-verified, and is awaiting its round 2 review. It is not closed and carries no `Completed:` line.

**Both bars boards 1 to 5 recorded are discharged, and this is the first board of this plan that says so.** The base bar: `gh pr view 49` reports state MERGED at 2026-09-20T00:12:40Z, `origin/main` is `952e940`, and a `git grep -c` at that ref over `bin/supervise.sh` and `hooks/index.ts` returns matches for all four strings boards 3 to 5 found absent, `ARCHITECT_ROLE_INSTRUCTION` 3, `[FLEET]` 2 and 14, `[RECONCILE]` 2 and 12, `fleet_status` 2 and 12. The control was `REPLY_INSTRUCTION` over the same two files at the same ref, returning 4 and 6, so the predicate and the scope both speak. `git grep -o -E "[A-Z_]+_INSTRUCTION=" ` at that ref over `bin/supervise.sh` returns exactly the five names Section 1 expects. The authorization bar: this document now carries a `## Dispatch Authorization` section recording the operator's `/kit-goal` arming of 2026-09-19, committed in `87b082d`, which is what board 5 found missing.

**Status normalization.** The header read `Status: Ready` at this run's start and now reads `Status: In Progress`, set as part of starting the run per the executing-work skill. That is an edit inside the approval-scoped fingerprint and is recorded here deliberately.

**The base this plan executes from is the branch, not the trunk, and that is a decision rather than a drift.** The Approach fixes the base as the trunk after the steward plan merges, and the Order paragraph separately requires the context-budget removal to have happened, because that removal deletes the `[BUDGET]` prompt this plan would otherwise trim. The first holds at the trunk. The second does not: `git grep -c -E '\[BUDGET\]|contextBudget'` at `origin/main` returns 32 matches in `hooks/index.ts`, because pull request 50 is open and unmerged. The branch `lean-injection` is cut from `f43eee7`, the context-budget branch tip, where the same predicate returns no match and all four steward strings are present. That is the only base where both of this plan's stated preconditions hold at once. `origin/main` is not an ancestor of that tip, the branch having been cut from the steward branch tip whose tree pull request 49's merge commit reproduces, so this plan's pull request will target `context-budget-removal` and retarget itself to `main` when 50 merges.

**Section 1 stage.** Built by `implementer-sonnet`, reviewed at round 1 by `adversarial-reviewer`, `blind-reviewer` and `security-reviewer`, all three at opus and effort high through Workflow run `wf_7cbbed24-0a0`. Round 1 returned one Critical, eight Majors and ten Minors across the three lenses. All of them are fixed in one fix round at the same tier, and the fix is verified. Round 2 is owed and not yet dispatched.

**What round 1 found, in one sentence.** The guard failed open: a string the ledger could not match was recorded as zero characters rather than raising, and the size check only ever reported growth, so a renamed or reformatted instruction string dropped out of both checks while the suite read green. Section 2 rewrites all five of those strings, so the failure would have fired on the very next section. All three lenses reached it independently.

**Rulings adopted since the last boundary.**

- `.kit/.gitignore` is folded into Section 1 and its `Files in scope` line is widened to name it. That directory is ignored by a blanket rule with a per-file allowlist, so the section's three deliverables cannot be staged without an allowlist entry. The fold test is met: the file sits in the same directory as files the section changed, it needs no acceptance criterion the section does not carry, and the close gate covers it.
- Two injected strings in `bin/supervise.sh` that the Approach's inventory never listed, `GOAL_PROMPT_FRAMING` at line 2657 and the `[SUPERVISOR-PRIMING]` marker at line 2841, are added to the ledger. They trace to the Goal sentence "every prompt the plugin or the supervisor writes into a session", so they are spec-traceable rather than a new requirement, and they sit in a file the ledger already reads.
- A third unledgered site, `hooks/operator.ts`, is deliberately left out. Adding it would widen the ledger to a third file the section never names. It is recorded here for Sections 3 and 4, which already work in `hooks/`.
- Two shipped sentences claimed the check exempts nothing and that it covers every string the plugin and the supervisor inject. Both were false while `hooks/operator.ts` stands outside the ledger. Both are corrected to name the two files actually read.

**Gate baseline, measured on this worktree at branch `lean-injection` with the section's work unstaged and three foreign untracked paths present.** `npx tsc -p tsconfig.json` exit 0 with zero bytes of output. `.kit/injection-duplicate-test.mjs` exit 1 with 19 duplicate sentences, which is this section's intended red baseline and is up from the 18 the pre-fix ledger found; the gain is the sentence "When this step is done, call goal_done with a one-line note.", carried by three plugin strings and missed before because an escaped newline was never decoded and so never read as a sentence boundary. All eight of the test's own fixture controls report both directions. `.kit/controller-tick-test.mjs` exit 0. `.kit/self-review-unit-test.mjs` exit 0. Every exit code read from its own unpiped run.

**Controls run against the guard itself, both withheld from the patterns they test.** Lowering one recorded size made the size check name the string and the two numbers. Adding a baseline row with no live counterpart made the reconciliation check name it and say the extraction is gone or renamed. Both probes restored from a pre-probe copy and verified byte-identical against it.

**Deferred and named deferred, never passed**, under the operator's gate policy of 2026-09-18 recorded in this plan's Assumptions: `.kit/live-all.sh`, every `.kit/live-*-test.sh`, `.kit/supervisor-natural-exit-test.sh`, and any check launching a `claude` child.

**Live dispatches.** None. Both implementer dispatches and all three round 1 reviewers have completed and returned.

**Asks in flight.** None.

**Next action.** Dispatch Section 1's round 2 review. Round 1 returned a Critical that survived adjudication, so round 2 runs at round 1's roster and tier rather than decaying to one lens. The security lens is dropped from that roster because its trigger does not hold: it reported that neither new file references `child_process`, `spawn`, `exec`, `eval` or `new Function`, so the process-execution trigger the round 1 brief asserted was the brief's error rather than the code's. Round 2 is therefore the adversarial and blind pair at opus and effort high.

### Interim board 7 - 2026-09-19

Not a Chapter. Section 1 is built, reviewed twice, escalated one tier, fixed and re-verified. It is not closed and carries no `Completed:` line. The run is parked here on the operator's request, recorded below.

**Stage.** Section 1 has taken two review rounds. Round 1 returned one Critical, eight Majors and ten Minors and was fixed at the writer's own sonnet tier. Round 2 returned one Critical, one Major from the adversarial lens and two from the blind lens, and fifteen Minors. Round 2's Critical drove a tier escalation, and the fix round that followed ran at fable. That fix is verified. Round 3 is owed and deliberately not dispatched.

**What round 2 found, and why it moved the tier.** Round 1's Critical was that the guard failed open: a string the ledger could not match was recorded as zero characters rather than raising. The round 1 fix made a total extraction loss throw. It did not make a partial loss throw. Two of the five `*_INSTRUCTION` strings are assembled from several assignment lines, `COORDINATOR_ROLE_INSTRUCTION` from five at `bin/supervise.sh:2686, 2688, 2711, 2719, 2737`. A reformatting of any one of them left the name resolving, the zero-character check silent, the name reconciliation silent, and the size check reporting only growth, so several thousand characters could vanish while the suite read green. Section 2 rewrites all five of those strings.

So the same class survived two rounds: the guard fails open on an extraction that silently loses content. Under the executing-work skill's tier-escalation ladder a repeating class means the tier is the lever rather than the brief, and the comparison was made before the bump rather than after. Section 1's writer tier was sonnet and this session runs below fable, so the section took its one re-dispatch to `implementer-fable` with the fable model override, both rounds' findings written into the brief. The dispatch resolved at `claude-fable-5-1` on every assistant turn, read from its own transcript.

**The five fixes, each with the control that proves it fires.**

- The Critical. `.kit/injection-ledger.mjs` now carries a per-name expected assignment count and throws `[instruction-count]` naming the variable and both numbers, mirroring the `PRIMING_BODY` rule that was already in the file. Confirmed by this session's own withheld probe: `bin/supervise.sh:2719` split across two lines with a backslash continuation, a shape no pattern in the ledger names and which bash still reads as one string. The ledger exits 0 unmutated, exits 1 under the probe naming `[instruction-count] COORDINATOR_ROLE_INSTRUCTION ... expected 5 ... found 4`, and exits 0 again after restore. The restore was verified byte-identical against a pre-probe copy and `git status` reports the file clean.
- A newly added injected string was invisible to all three checks, because three of the four families were a fixed name list rather than a structural read. The ledger now reconciles, in both directions, every `*_INSTRUCTION` left-hand side, every variable spliced into the priming write, every `contextBlocks.push` identifier, and every `submitExpectedTurn` call site, each under its own tag. That is what the Approach's Order paragraph requires when it says this plan runs before the supervisor-peer plan so that plan's new priming sentence is written under the guard.
- The ledger's own comment claimed the fleet prompt's trailing lines were entirely per-reading data. That was false. Nine field labels and two sentence frames at `hooks/index.ts:1225, 1262-1268, 1290, 1292` are authored prose that nothing sized. They are now one ledger entry, `FLEET_PROMPT_LINE_LITERALS` at 288 characters, and the false comment is corrected.
- Two prompt frames at `hooks/index.ts:3438` and `:3522` are built by helpers in `hooks/operator.ts`, a third file this section never names. Rather than widen the ledger to it, the exclusion is declared by name, pinned by the test, and asserted per site: the call must pass only data, carrying no quote or backtick. The ledger header, the test header and `README.md` all state the bound, so no shipped sentence claims coverage the guard does not have. Section 1's own text needed no amendment.
- `README.md:369` now says the suite is red by design until Sections 2 to 4 land. Without it a peer running the whole gate reads a fresh failure outside its own diff and misattributes it.

**Gate baseline.** Measured by this session on this worktree at branch `lean-injection`, HEAD `6190fed`, with the section's fix-round work unstaged and one foreign untracked path present (`.claude/worktrees/`), at 2026-09-20T03:54:44Z, 40 seconds wall clock, under a heavy-process claim this session wrote and released, with no foreign test runner or build in the process list and no live claim standing before it. Every exit code read from its own unpiped run. `npx tsc -p tsconfig.json` exit 0 with zero bytes of output. `node .kit/injection-ledger.mjs` exit 0 with zero bytes on stderr. `node .kit/injection-duplicate-test.mjs` exit 1, which is this section's intended red baseline, unchanged at 19 duplicate sentences against the 19 recorded at board 6; its name reconciliation and its size check both report OK, and its output carries no stack frame and no `Error` line, so the red is duplicates alone and not a throw. `node .kit/controller-tick-test.mjs` exit 0. `node .kit/self-review-unit-test.mjs` exit 0. The committed `.kit/injection-ledger.json` is byte-identical to the live ledger's output, compared this session. The ledger holds 39 entries, up from 38, the one addition being the fleet-line literals.

**Rulings adopted since the last boundary.**

- The two record-delivery prompt frames are excluded from the ledger by name rather than reached through `hooks/operator.ts`. The ground is that those call sites pass only data, so there is no literal in `hooks/index.ts` to read, and adding a third source file would widen a section that names two. The exclusion is asserted rather than assumed, which is what keeps it from being a silent hole.
- The fleet prompt's line literals are ledgered rather than excluded, because they sit in `hooks/index.ts`, a file this section already reads.
- No Minor was worked. Twenty-two accumulated Minors and claim findings across both rounds are recorded at `.kit/scratch/lean-injection/minors-section-1.md` for the single close pass the skill directs, which runs before the close gate and after the terminal condition is met.

**Carried forward for later sections, from the fix round's own concerns.** Section 2 will trip the new `[priming-write]` and `[instruction-count]` rules when it conditions the architect string out of the assembly or changes a clause count. That is the declared-growth design working, and Section 2's brief should name the count table and the write pattern as the places to update. Section 3 deletes `REPLY_INSTRUCTION`, so the extraction rule for it and every frame pattern anchored on it will throw until retired, and Section 3's brief should name them.

**Deferred and named deferred, never passed**, under the operator's gate policy of 2026-09-18 recorded in this plan's Assumptions: `.kit/live-all.sh`, every `.kit/live-*-test.sh`, `.kit/supervisor-natural-exit-test.sh`, and any check launching a `claude` child.

**Live dispatches.** None. Both round 2 reviewers and the escalated fable implementer have completed and returned, and nothing was stopped.

**Asks in flight.** None.

**The park, and a report this session tested rather than accepted.** The operator asked on their own channel, while the fix round was in flight, that this run shut down after the review round once everything was written durably. This entry, the commit that carries it, its push and the compaction checkpoint are that record. The fix round was allowed to finish rather than stopped, because its work was nearly complete and a stop would have discarded the Critical's fix.

A later channel message reported that a fable usage limit had been hit, that this probably killed the reviewers, and that their work was lost. This session tested that and it does not hold, so no work was discarded on it. Round 2's two reviewers completed and returned full findings and ran at `claude-opus-5` rather than fable, read from their own transcripts, so a fable limit could not have reached them. The fable implementer also completed and returned its report. Its output is not taken on trust either: the gate baseline above is this session's own run, and the Critical's control is this session's own probe. What sits in the worktree is verified work, not a partial edit.

**Next action.** Dispatch Section 1's round 3 review. Round 2 returned a Critical that survived adjudication, so round 3 runs at round 1's roster rather than decaying to a single lens: the adversarial and blind pair, with no security lens, that trigger having been tested at round 1 and found not to hold. The tier is one above the writer tier, and the writer tier is now fable after the escalation, so the ceiling applies and both reviewers run at fable. A Fable reviewer carries its agent's frontmatter effort, so round 3 rides the Agent tool at effort low rather than the Workflow route the opus rounds needed. Where a fable allotment is genuinely unavailable at that moment, the finishing-work skill's unavailability rule governs what the round does instead, and it is confirmed from an actual dispatch failure rather than assumed. The base ref for the review is `f43eee7`. After round 3 adjudicates: the Minor close pass, the section close gate, Section 1's Chapter, and then Sections 2 to 5.

### Interim board 8 - 2026-09-20

Not a Chapter. Section 1 has taken three review rounds. Round 3's findings are adjudicated and its fixes are built and gated. Round 4 is dispatched. No `Completed:` line is written.

**Stage.** Section 1 is the only section in flight. Sections 2 to 5 are not started. The base bar boards 1 to 5 recorded stayed discharged: `origin/main` is `2da6543` and carries all five `*_INSTRUCTION` names, the `[FLEET]` and `[RECONCILE]` frames and the `fleet_status` tool. A first reading of this session's own missed them, because the predicate anchored each name to the start of a line while every assignment sits indented inside a function. The corrected predicate, a grep for `INSTRUCTION` over that file at that ref, returns all five. An outline never proves absence, and this one nearly cost the plan a false blocker.

**What round 3 returned.** The adversarial lens returned one Critical, three Majors and three Minors, verdict CHANGES_REQUIRED. The blind lens returned six Minors and no Critical or Major, verdict APPROVED_WITH_CONCERNS. Every Critical and Major was confirmed against the cited code by this session before it was acted on.

**The Critical, and why the tier moved to the main thread.** The three plugin-side chain rules read the backtick pieces of a chain joined by `+` and ignored whatever sat between them. Two carried no completeness check at all and the third refused only total loss. So a piece rewritten to a quoted literal, or factored into a constant and spliced back by name, left the entry short with nothing raised: the name still resolved, and the size check reports growth and never a shrink, so the loss read as a trim. Section 3 rewrites exactly those constructs. This is the third consecutive round returning one class, fail-open on a silent extraction loss, at a different site each time. Under the tier-escalation ladder a repeating class means the tier is the lever, and the comparison was made before the move rather than after: round 1's Critical was total loss on any rule, round 2's was partial loss on the shell rules, round 3's is partial loss on the plugin rules. Round 2 already spent this section's one re-dispatch to the fable implementer, and that attempt is the one round 3 found this Critical in, so the ladder's remaining exit for a session below fable is the main thread. This session took the fix.

**The fix, which closes the class rather than the three sites.** A shared chain reader tokenizes a chain joined by `+` and refuses any operand it was not told to expect, each rule declaring by name the whole variables it splices in, `siblingLine` and `lastNote` for the goal-tree block and none elsewhere. It tracks template nesting inside an interpolation, so a backtick inside an interpolation cannot close a piece early. The literal-chain parser every tool description uses now throws when a `+` is followed by anything but another quoted literal, which is the same hole on the path Section 4 rewrites. Both refusals name the entry that would have shrunk.

**The two further Majors, and what each became.** The ledger's declared coverage named two record-delivery sites as its exclusions while `hooks/operator.ts` itself says there are three. The third hands its record to the running turn as tool-result context, so no prompt-call-site row reaches it and the two named rows could never have bounded the class. It is now bounded by a count asserted over every `deliveryText` call site, with each site required to pass only data in its ground, id and text arguments, and both the names and the count are pinned. The README's coverage sentence said two and now says three. Its security section already said three, so the two halves of that document disagreed.

The other Major is the authored prose of a fleet note's `composed` half, nineteen sites in `hooks/index.ts` and several of them a sentence or more, which reaches the child through an interpolation and which no rule sizes. Section 1's own extraction excludes interpolated content by construction, so sizing it here would need an acceptance criterion this section does not carry, and it cannot fold. It is not routed out of the plan either, because the Goal covers it: it is a prompt the plugin writes. It is added to Section 3, which already rewrites the `[FLEET]` frame, with its files and its acceptance named there. That is approval drift and is recorded here as such. The claim half was in scope and is fixed: the ledger's comment said the joined lines were field labels and per-row data alone, which was false, and the header's declared-gap list did not name this prose. Both now do, in the ledger and in the README.

**A Minor upgraded on a stated consequence.** This suite is red by design until Sections 2 to 4 land, so exit 1 could not tell a real duplicate from a broken control, and a regression in any control was invisible at the level a gate reads. A control or guard failure now exits 2, and exit 1 means every control passed. The predicate that sorts the two classes is driven by a case rather than asserted, over three instrument labels and five real-check labels taken from the strings this file actually prints.

**Every fix driven by a case watched to fail first.** The three chain controls each failed against the unfixed ledger with the message that the ledger built with no throw, which is the hole rather than a missed anchor, and each now passes naming its own tag and its own entry. The delivery controls include the coverage case rather than the instrument case: a literal added at the site no named row reaches, which the two named rows passed before the shape rule existed. Seven further Minors are accumulated at `.kit/scratch/lean-injection/minors-section-1.md` for the single close pass.

**Gate, run by this session on this worktree at branch `lean-injection`, HEAD `092c07c` with round 3's fixes unstaged and one foreign untracked path present, at 2026-09-20T11:05Z, under a heavy-process claim this session wrote and released.** The box was contended once: the plugin persona held the claim, and this session waited 115 seconds for it to clear rather than running beside it. Every exit code read from its own unpiped run. The type check exits 0. The ledger exits 0 with zero bytes on stderr. The duplicate test exits 1, the intended red, at 19 duplicate sentences, unchanged from board 7's 19, with every control and guard passing and no stack frame in its output. The controller tick suite exits 0. The self-review suite exits 0. The committed `.kit/injection-ledger.json` parses identical to the live ledger output at 39 entries, and no entry's character count moved across this fix, so the delta changed what the ledger refuses and not what it reads.

**Rulings adopted since the last boundary.** Three, all this session's, and all turning on facts about the system rather than on preference. The completeness guard belongs to the channel rather than to the three rules that first needed it, so it is one shared reader the rules declare into rather than three patched patterns. The delivery-site class is bounded by a count over its own shape rather than by a list of names, because the site that escaped was the one no name reached. And the fleet notes' prose belongs to Section 3 rather than to a new section or to the backlog, because Section 3 already owns that frame and the Goal already covers the prose.

**Live dispatches.** Round 4's adversarial and blind pair, dispatched at fable over round 3's fix delta. Round 3 returned a Critical that survived adjudication, so round 4 runs round 1's roster rather than decaying to one lens, at one tier above the writer tier, which is now this session's main thread, with fable as the ceiling. Its base ref is `f43eee7`.

**Next action.** Adjudicate round 4. Then the Minor close pass, the section close gate, Section 1's Chapter, and Sections 2 to 5.
