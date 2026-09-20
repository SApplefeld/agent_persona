# Decision seam

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-19

## Goal

When this is done, the persona plugin has one module, the decision seam, through which a closed question can be put to Jev, the TypeSafe classifier service. The four closed questions the plugin asks today are also put to Jev in shadow: Haiku still makes every decision, and Jev's answer is written beside it. Each question's wording is versioned data with an override layer outside the repository. Every shadow answer lands in an append-only journal with its question version, every probability, the real token count, and later the outcome. It matters because five later plans act on Jev's answers or revise its questions, and none of them can ship on evidence, or be measured at all, without this instrument.

## Dispatch Authorization

The authorization to author this plan is the operator's word of 2026-09-19 in the design session, "Let's proceed with everything you've recommended on the sketch", followed the same day by "Yes, I approve of the spec above, let's proceed!" after the sketch and its Assumptions block were shown.

The operator armed execution of this plan on 2026-09-20, naming it first in a `/kit-goal` invocation relayed to the executing session on the operator's own channel, and repeating that invocation verbatim after the session reported what the arming required. Under the kit-goal skill's arming-is-approval rule that invocation carries the authority of a typed "proceed", so this plan is approved as written and no separate approval is waited on.

The record is kept here because the arming state does not keep it. A run that arms a queue for itself on a relayed instruction records its own invocation and not the operator's, so a session reading only that state would find this plan unarmed. The project memory record `self-armed-arming-does-not-satisfy-an-operator-only-execution-grant` holds the general shape.

## Intent

**The frame.** The operator asked how much of the persona loop "could potentially be driven by Jev", and then: "How can we tackle all of the above suggestions in an aggressive way, so they are available as soon as possible?" The suggestions were confidence-routed controller decisions, several questions per tick, interruption triage, tool-call reflexes, memory hygiene, recognition-nudge relevance, a judgment sidecar swap, and a slow model retraining the fast one, which the operator called "the Pinnacle". Memory retrieval was excluded as already under way.

**What done needs to do.** It builds the shared parts once so the later plans can run in parallel: a Jev client, versioned questions, and a journal. It turns the four existing closed questions into shadow measurements from the first day, so evidence accrues while the other plans are written.

**What done does not need to do.** It changes no decision the plugin makes. No Jev answer is acted on, no threshold is set, no cap or counter is retired, and no new question is asked that the plugin does not already ask. A reviewer who finds a branch whose outcome depends on a Jev answer has found scope drift.

**Alternatives refused.**
- Swapping the three classify sites to Jev directly: it changes an unattended loop on numbers nobody has measured.
- One spec per suggestion with no shared foundation: each would rebuild the client, the question store and the log.
- Writing the journal straight to SQL Server: the memory database plan tried a database call per write and withdrew it, because each write starts a process. A journal line per tick is a hotter path than that one was.
- Holding question wording in the repository only: the retraining loop could then only open pull requests, and would improve at review speed.
- Holding question wording in SQL only: a persona could not start with the host down.
- Reading the API key from a key file: the operator keeps it in the `env` block of `settings.json` as `TYPESAFE_API_KEY`, one key per VM, and other plugins already read it there.
- Routing a low-confidence decision to the operator on the first tick: the plugin already removed classifier-opened asks, and only the worker's own `ASK:` line opens one. Shadow data will say whether Jev's ask probability predicts that line.

**Rulings after the spec shipped.** None at the write.

**Provenance.** Distilled from the design session of 2026-09-19 in this repository.

## Approach

**The seam is a new file, and `hooks/index.ts` gains imports, call lines and one option read.** Four queued plans edit `hooks/index.ts`. New logic lives in new files so a rebase meets one-line conflicts. No new function is declared in `hooks/index.ts`, and the effective mode is derived inside the seam. Line numbers in this plan are against the trunk at `d6be1f3`. After a rebase each site is re-located by the symbol named beside its line number.

**The engine's loader can refuse a module that compiles and passes every mock suite.** The project memory record `a-hooks-module-can-pass-tsc-and-the-harness-and-still-fail-to-load` holds the two shapes seen so far, and a refusal leaves the child with no plugin tools at all. `.kit/check-loader-rule.mjs` is a regex over known shapes and not the loader. So this plan proves the load against the real engine twice, in Section 1 and at Section 5's close.

**Jev's contract.** One endpoint takes a `POST` with a bearer key, one `state` (text or JSON) and a named map of questions. The map keys come back as the answer keys, so a question id is the join key between catalog and journal. Three primitives exist: Choice (one of up to 255 options, with a distribution and a confidence), Noul (a yes probability, with no confidence) and Score (2 to 10 ordered levels, with a confidence). The response carries `usage.input_tokens`. Errors are 401, 422, 429 and 529. The live contract, the endpoint URL included, is `https://docs.typesafe.ai/api.md`, and the implementer reads it before writing the client. All four question sets in this plan are Choices.

**Shadow runs after Haiku, and off the decision path.** At each site the Haiku call is awaited exactly as today. On the line after it returns, the seam `ask` is started with Haiku's value passed in, and it is not awaited. Where the Haiku call throws, today's catch path runs and no shadow call is made. The `ask` is raced against a timer, because `$.http.fetch` takes no timeout. A Jev failure, a timeout or an absent key writes one journal line and touches nothing else. The seam never throws into a caller.

**The key.** The seam reads `TYPESAFE_API_KEY` with `$.env.get`, which the typings written by Claude Code 2.1.267 add. `process.env` stays undefined in a hook module, so this is the only channel. The plugin has no `$.env` or `$.http` call site today, so Section 1 opens with a live probe of both. No part of the key's value is ever journaled, logged or put in a decision detail.

**Questions are data with two layers.** Shipped defaults are constants in a TypeScript file, because `$.fs` resolves relative paths against the worker's project and cannot read the plugin's own directory. That file also becomes the single source of the label arrays the three classify sites use today, so the catalog and the Haiku calls cannot drift. Overrides live outside the repository at `<home>/.claude/agentic-questions/<questionId>/v<N>.json`, each immutable, with `<questionId>/active.json` naming the active version. `<home>` is `USERPROFILE`, else `HOME`, read with `$.env.get`. This plan writes no override. It only reads them.

**Two sites have label variants, and the caller names the variant in force.** The controller offers `switch` only when a pending plan exists, and the scorer offers `off-goal-by-instruction` only on a turn that was not nudged. Each shipped set holds the superset with a description per option. The caller passes the option ids Haiku was offered, and the seam sends Jev exactly those. Jev is therefore never offered a label Haiku was not.

**The journal is local, in the SQL row shape.** Lines go to `<home>/.claude/agentic-decisions/<persona>/<YYYY-MM-DD>-<session>.jsonl`, UTC date, where `<session>` is the session id with every character outside `A-Z a-z 0-9 _ -` replaced by `_` and cut to 64 characters. The plugin's append idiom reads the whole file and rewrites it, so a file per day bounds that cost, and a file per session means no two processes share one. Inside a session, writes to one path are serialized through one in-module promise chain. The set of line kinds is closed at `call`, `answer` and `outcome`. Each line carries a stamp id, so a later bulk load into SQL is idempotent on stamp id. The state text is stored once on the `call` line, and each `answer` line points at it.

**A stamp id is minted when the call starts, not when it settles.** Its form is `<persona>.<session>.<epochMs>.<counter>`, the counter being per session and never reset. So a joiner always has an id to cite, even where the outcome line reaches the file before the `call` line. A `call` line's `split` is `holdout` where `fnv1aHash(stampId) % 5 === 0` and `dev` otherwise, using the hash already in `hooks/cost-ledger.ts`. The retraining plan never reads holdout lines when proposing a wording.

**Outcomes are joined later, from signals the plugin already produces.** The session holds the stamp id of its latest controller call in memory. The first turn scored after that call writes one `next_score` outcome and clears the scoring half of the hold. The first worker `ASK:` line matched after it writes one `ask_marker` outcome and clears the other half. A tick the unchanged-summary skip skips mints no id, and with no id held a joiner writes nothing. For every site, the `answer` line's own `haikuValue` is the agreement record: agreement is exact equality of option id, and it is marked as agreement and never as truth.

**One option, `jevMode`.** The set of values is closed at `off` and `shadow`. The default is `shadow`. The seam treats any other value as `off`, and treats an absent or empty key as `off`. The scout found three settings lists that disagree, and `costEnabled` is read by the plugin but has no emit path. `jevMode` travels all five surfaces Section 4 lists so it cannot fall into that gap.

**The coverage sweep.** One Explore scout swept the repository on 2026-09-19 for every surface speaking these contracts, under letters A to L: model call sites, the cost ledger, the settings path, `state.decisions[]`, `$.http` and `$.fs` use, the controller summary builder, the inbox delivery path, the `tool.call` handlers, the tests pinning each, the docs stating each, pinned counts, and the ordered option path. Its model-call line numbers, the keeper map, `emit_settings_json`, the `cfg` read and `appendToChannelLog` were re-confirmed against the trunk at `d6be1f3`. Surfaces found:

- Model call sites, all in `hooks/index.ts`: classify at 4444, 5198 and 5307, and complete at 3774, 4058, 4493, 4547 and 5316.
- Label arrays: `classifyLabels` at 4273-4275, the scorer's `labels` at 5194-5196, and the memory gate's inline literal at 5312.
- The option path: `bin/fleet.example.json`, `bin/keeper-functions.ps1:244-251`, `bin/agentic-common.sh:71-208`, `.claude-plugin/plugin.json:4-107`, `hooks/index.ts:1671-1753`.
- Append idiom: `appendToChannelLog` at `hooks/index.ts:529-533`, duplicated inline for the yield log at 548-549 and 1421-1422. The yield log's line is built with its own trailing newline at `hooks/agent-state.ts:845-852`.
- The summary builder at `hooks/index.ts:4248-4271` and the unchanged-summary skip at 4410-4438.
- The ask conversion at `hooks/index.ts:4474-4484` and `askMarkerMatch` at 5125.
- Tests: `.kit/tick-harness.mjs:129-144` fakes `$.model`; `.kit/controller-tick-test.mjs`, `.kit/settings-plugin-key-test.sh`, `.kit/keeper-unit-test.mjs` and `.kit/check-loader-rule.mjs` pin the rest.
- Docs: `README.md:90-151`, `README.md:417-436` and `docs/architecture.md:41-51`.
- No `$.http.fetch` call exists under `hooks/`.

**Ordering against the armed queue.** The lean-injection and supervisor-peer plans both edit `hooks/index.ts`. This plan's branch rebases onto the trunk before Section 2, the first section that edits that file, and again before the pull request is marked ready.

**Gates.** The gate policy of 2026-09-18, stated in `docs/plans/agent_persona_deferred-gate-run_v1.md`, names the plans it covers and this plan is not one, so this plan gates as the executing-work skill states. The two live checks launch a `claude` child. Each takes the machine's heavy-process claim first, per the claim protocol in the kit's role skill, and runs one at a time.

## Sections of Work

### 1. The live probe, then the seam and its Jev client
Model: fable

Start with a throwaway live probe, before any design is fixed. Put the probe in a temporary file `hooks/decision-seam-probe.ts`, called from one temporary line in the existing `session.start` handler, writing its four results to `seam-probe.json` in the probe's working directory. Launch one supervised persona named `seam-probe` with `bin/supervise.sh` against an empty temporary working directory, with a `--debug-file` so a loader refusal is visible. Record four facts in the Chapter: whether `$.env.get("TYPESAFE_API_KEY")` returns a non-empty value there, whether `$.env.get("USERPROFILE")` or `"HOME"` does, whether `$.http.fetch` reaches the Jev endpoint and returns a parsed answer to one Noul, and whether `$.fs.write` to an absolute path under a directory that does not yet exist succeeds. Record the key as present or absent only. Remove the probe file, its call line and the temporary directory before the section's commit.

Where the key does not reach the supervised child, find where the environment is filtered and pass that one name through. `bin/keeper-functions.ps1:16-25` is the keeper's allowlist, and the scout reports it gates a different environment file, so confirm before editing it. Where `$.fs.write` does not create directories, the journal and catalog sections use whatever the probe shows does work, and the Chapter says which.

Then build `hooks/decision-seam.ts`. It exports one `ask` function taking `$`, a question set id, the option ids in force, the state, the mode and Haiku's value. It resolves the question through the catalog, sends one request, races it against a timer of 10 seconds, measures `latencyMs` itself, and returns a typed result: either the answers with `usage` and `latencyMs`, or a failure. It never throws.

The set of failure reasons is closed at `off`, `no_key`, `timeout`, `network`, `http_401`, `http_422`, `http_429`, `http_529`, `http_other` and `parse`. `off` is any mode other than the exact string `shadow`. `no_key` is a key that is absent or an empty string. `network` is a fetch that rejects with no HTTP status. `http_other` is any status outside 200 to 299 that the list does not name. `parse` is a body that is not JSON, or JSON missing the answer for a question that was asked.

Acceptance:
- The four probe facts are in the Chapter with the command that produced each, and the debug file shows no `failed to load` line.
- `ask` returns each closed reason, without throwing, driven through a faked `$`. An unrecognized mode string and an empty key are both driven.
- With mode `off` or an unrecognized mode, the faked `$.http.fetch` is never called.
- A grep of `hooks/decision-seam.ts` for the key variable reaching a journal, log or decision call returns nothing, with a control that shows the grep matches a planted line.
- `.kit/check-loader-rule.mjs` passes.

Files in scope: `hooks/decision-seam.ts` (new), `.kit/decision-seam-unit-test.mjs` (new), `.kit/tick-harness.mjs` (add `http`, `env` and absolute-path `fs` fakes), the temporary probe file and its one call line, and one environment pass-through file only where the probe shows the key does not arrive.
Tests: lock every failure reason returning without a throw, since a throw into the controller tick is the expensive failure. Lock that `off` and an unrecognized mode make no request, since a kill switch that fails open sends data off the machine. Lock that a timeout resolves the race and leaves no unhandled rejection.
References: `https://docs.typesafe.ai/api.md`, `.claude/types/claude-code.d.ts:1846-1863` and `:1914-1932`.

### 2. The question catalog
Model: opus

Rebase onto the trunk first. Build `hooks/question-catalog.ts`. It exports the label arrays the three classify sites use today as named constants, both variants for the controller and the scorer, and `hooks/index.ts` imports them at `classifyLabels` (4273-4275), the scorer's `labels` (5194-5196) and the memory gate's literal (5312) in place of its own literals. The label values and their order do not change.

It holds the shipped defaults for four question sets as typed constants, each with an id, the primitive `choice`, instructions, a description per option, and a shipped version label. Three sets, the controller decision, the turn scorer and the memory kind gate, take their option ids from the exported label constants, the controller's and the scorer's holding the superset. The fourth, the plan switch, has no label array, since Haiku answers it in free text. Its options are the pending plan ids the caller supplies plus `no_match`.

It exports a resolver that reads `active.json` and the named override, validates it, and returns the question with the version label the journal will record. An override is refused where it has fewer than 2 or more than 255 options, an empty instruction, a primitive other than `choice`, or, for the three fixed sets, a set of option ids that differs from the shipped superset. Option order is free. An `active.json` that names a version file that does not exist, or that cannot be parsed, is a refusal. A refused override falls back to the shipped default and returns the refusal reason, which the journal records. A question with no `active.json` at all resolves to the shipped default with no refusal reason.

Acceptance:
- The three sites' Haiku calls receive the same arrays as before, shown by the existing controller-tick cases passing unchanged.
- A test imports the label constants and the shipped sets and shows each set's option ids equal its constant's superset.
- A valid override resolves with its version label. Each refusal above falls back with its reason. An absent `active.json` falls back with none.

Files in scope: `hooks/question-catalog.ts` (new), `.kit/question-catalog-unit-test.mjs` (new), `hooks/index.ts` (one import and the three label literals only).
Tests: lock the option-id pin, since a catalog drifting from the classify labels makes every agreement figure meaningless. Lock each refusal, and lock that a refused override never reaches a request.
References: `https://docs.typesafe.ai/primitives.md` and the Choice page under it.

### 3. The journal
Model: opus

First add two cases to `.kit/controller-tick-test.mjs` asserting the yield log's exact bytes, one for the `yieldNow` path and one for the heartbeat path, and see both green against the unchanged code. The existing case at 3958-3959 checks two substrings only. Then generalize `appendToChannelLog` to take a path, and move the two inline yield-log copies onto it. The helper writes each line with exactly one trailing newline whether or not the caller's line already ends in one, because the yield log's line does and the channel log's lines do not.

Build `hooks/decision-journal.ts`. It exports `newStampId`, `splitOf`, `writeCall`, `writeAnswers` and `writeOutcome`. Writes to one path run through one in-module promise chain. Each writer resolves to `true` or `false` and never throws. The module keeps an in-memory latch per UTC day and returns `firstFailureToday` on the first failed write of a day, so the caller can log it once. A restart resets the latch.

Line shapes. Every field is always present, and a value that does not apply is `null`:
- `call`: `stampId`, `at`, `persona`, `session`, `site`, `questionSet`, `mode`, `split`, `stateHash`, `state`, `stateRef`, `inputTokens`, `latencyMs`, `result` (`ok` or a failure reason).
- `answer`: `stampId`, `callStampId`, `questionId`, `questionVersion`, `overrideRefused`, `primitive`, `value`, `probabilities`, `confidence`, `haikuValue`, `agrees`.
- `outcome`: `stampId`, `callStampId`, `kind`, `value`, `at`. The set of kinds is closed at `next_score` and `ask_marker`.

`state` is `null` and `stateRef` names an earlier stamp id where the `stateHash` equals the previous `call` line's for the same site in the same file. Otherwise `stateRef` is `null`. `inputTokens` and `latencyMs` are `null` on a call that made no request.

Acceptance:
- The two new yield-log byte cases pass before and after the helper move.
- Two writes started together to one path both land, shown by a test that settles them at once and finds both lines.
- A failed write resolves `false`, and `firstFailureToday` is true once per UTC day.
- Two ids minted in one millisecond differ. Across 10,000 minted ids the holdout share is between 15 and 25 percent, and an id's split never changes.

Files in scope: `hooks/decision-journal.ts` (new), `hooks/index.ts` (the append helper at 529-533 and the two inline copies only), `.kit/decision-journal-unit-test.mjs` (new), `.kit/controller-tick-test.mjs` (the two byte cases).
Tests: lock the yield log's bytes across the helper move, since that refactor is the one place this section can break shipped behavior. Lock the concurrent-write case, since a lost line fails the Goal while every other check passes. Lock the never-throws rule, the id uniqueness and the split stability.

### 4. The `jevMode` option
Model: sonnet

Add one option, `jevMode`, across the five surfaces in order: a `jevMode` field on one entry of `bin/fleet.example.json`; a `jevMode = 'JEV_MODE'` entry in the `$map` hashtable of `Build-SupervisorInvocation` at `bin/keeper-functions.ps1:244-251`; a `JEV_MODE` block in `emit_settings_json` in `bin/agentic-common.sh`, following the `cost_opts` sibling at lines 77-92 but validating against the two values; a `userConfig` entry in `.claude-plugin/plugin.json` with default `shadow`; and a `cfg.jevMode` string read beside the others at `hooks/index.ts:1671-1753`, passed to the seam untouched.

Acceptance:
- `.kit/settings-plugin-key-test.sh`, which derives both plugin ids from `plugin.json` and `marketplace.json`, passes and is extended to show `JEV_MODE=off` reaching the options under both ids.
- `JEV_MODE=bogus` makes `emit_settings_json` fail the way an invalid `COST_*` value does.
- `.kit/keeper-unit-test.mjs`, which pins the map at its line 314, passes with the new entry.

Files in scope: the five files named above, `.kit/settings-plugin-key-test.sh`, `.kit/keeper-unit-test.mjs`.

### 5. Shadow wiring and the outcome joiners
Model: opus

Rebase onto the trunk first. At each of the four sites, on the line after the awaited Haiku call returns, mint a stamp id, start a seam `ask` with the same state text Haiku received, the option ids Haiku was offered and Haiku's value, and do not await it. When it settles, a continuation writes the `call` line and the `answer` line. The sites are the controller decision at `hooks/index.ts:4444`, the plan switch at 4493, the turn scorer at 5198 and the memory gate at 5307. For the plan switch, `haikuValue` is Haiku's trimmed reply where it exactly equals a pending plan id, and `no_match` otherwise. The controller's shadow call is not made on a tick the unchanged-summary skip at 4410-4438 skips.

Joiners, per the Approach: after the controller's id is minted it is held in session memory. The turn scorer at 5198 writes one `next_score` outcome against a held id and clears that half. The `askMarkerMatch` branch at 5125 writes one `ask_marker` outcome against a held id and clears that half. With no id held, neither writes.

Where a writer returns `firstFailureToday`, push one `journal_write_failed` decision. That is the only `state.decisions[]` entry this plan adds.

No value read from a seam result reaches any branch, state field, decision action or nudge text.

Close the section with one live load check: launch one supervised persona the way Section 1 did, confirm the debug file shows no `failed to load` line, and confirm a journal file with a `call` line appears.

Acceptance:
- With `jevMode` `shadow`, every existing case in `.kit/controller-tick-test.mjs` passes unchanged with Jev faked to fail, to hang, and to answer the opposite of Haiku.
- With a never-settling Jev fake, the tick's promise resolves and `state.decisions` equals the `off` run's, with no fake-clock advance.
- New cases show the `call` and `answer` lines written for each site, one `next_score` and one `ask_marker` landing on the held id, a second scored turn writing no second `next_score`, and a skipped tick writing nothing.
- The cost ledger's counts are identical with shadow on and off.
- The live load check's two facts are in the Chapter.

Files in scope: `hooks/index.ts` (two imports, the four sites, the two joiner points and the one decision push), `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs`.
Tests: lock decision invariance against an opposite-answering Jev, since a leak from shadow into a decision is the failure this whole plan exists to prevent. Lock that a hung Jev call cannot delay a tick.

### 6. Docs
Model: sonnet

Update `README.md` and `docs/architecture.md`: the seam, the two question layers, the journal's location and line shapes, the `jevMode` row in the options table, and an egress statement naming what is sent to TypeSafe, which is the same state text the four sites already send to Haiku. Replace the stale summary-label table at `README.md:121-151` with what the summary builder at `hooks/index.ts:4248-4271` builds. File one backlog item: `costEnabled` is read at `hooks/index.ts:1817` and has no emit path. Flip the plan's line in `docs/README.md` at close.

Audience: the operator, who knows the plugin and is new to Jev, and a future session with no context, which must be able to find the journal and add a question. Must answer for both: where the journal is, what a line means, how to turn Jev off, what leaves the machine. Voice: other, the plain reference voice the README already uses. Fact base: the three new `hooks/` files and `https://docs.typesafe.ai/api.md`.
Disclosure: the documents never show any part of the key's value, the name of any of the operator's machines, or real state text. The variable name `TYPESAFE_API_KEY` and the vendor's domain are allowed, and a sample journal line uses invented state.

Files in scope: `README.md`, `docs/architecture.md`, `docs/backlog.md`, `docs/README.md`.

## Out of Scope

- Acting on any Jev answer, any confidence threshold, and any `live` mode.
- The four free-text completions at `hooks/index.ts:3774`, `4058`, `4547` and `5316`, which stay on Haiku. The plan switch's Haiku completion at 4493 also stays as it is.
- The cost ledger, its caps and its four-place site shape. Shadow calls are not counted there.
- `state.decisions[]`, apart from the one `journal_write_failed` action. A shadow timeout or failure is journaled and never logged as a decision.
- The inbox delivery scan at `hooks/index.ts:6392-6519` and every `tool.call` handler, which later plans touch.
- Writing, promoting or replaying an override. This plan only reads them.
- The SQL tables, procedures and sync leg for the journal, which are a claude-kit plan.
- Bucketing the summary's numbers, and asking more than today's questions per tick.
- Noul and Score questions. The seam's types admit them and no shipped set uses one.

## Assumptions

- assumed 2026-09-19 (operator's word): the API key is `TYPESAFE_API_KEY` in the `env` block of `settings.json`, one per VM; reversal: one line in the seam.
- assumed 2026-09-19 (typings `.claude/types/claude-code.d.ts:1914-1932`): `$.env.get` works in a supervised persona; reversal: Section 1's probe decides, and the fallback is a pass-through of that one name.
- assumed 2026-09-19 (default): the journal and overrides live under `<home>/.claude/`, not the persona's run directory as the sketch said, because `$.fs` takes absolute paths and this needs no new setting; reversal: two path constants.
- assumed 2026-09-19 (default): a journal file per persona per UTC day per session; reversal: one path function.
- assumed 2026-09-19 (default): one line in five is holdout; reversal: one constant, applied to new lines only.
- assumed 2026-09-19 (default): the shadow timeout is 10 seconds; reversal: one constant.
- assumed 2026-09-19 (default): the once-a-day failure latch is in memory and resets on restart, so a restarting persona can log the failure more than once a day; reversal: none needed.
- assumed 2026-09-19 (operator's approval of the sketch): shadow sends TypeSafe the same state text the four sites already send to Haiku, and `jevMode` defaults to `shadow` on a VM holding a key. The sketch's Assumptions block said "State sent to Jev in shadow is the same summary Haiku already receives", and the operator answered "Yes, I approve of the spec above, let's proceed!"; reversal: default `jevMode` to `off`, one line in `plugin.json`.
- assumed 2026-09-19 (default): whether Jev bills state once per request or once per question is unknown, and the journal's `inputTokens` measures it; reversal: none needed.
- assumed 2026-09-19 (plan review): excluded, doubt falling out: an override that reorders a fixed set's options is admitted, since order carries no meaning to a Choice.

## Operator Verification

- After the pull request merges, update the installed plugin copy and relaunch each supervisor, since a running supervisor keeps the script it launched with. Then confirm a journal file appears for one persona within one controller tick of activity. No file after an hour of activity reopens Section 1.
- Read one day's TypeSafe usage per VM key against the journal's summed `inputTokens`. A gap past a fifth reopens Section 3.

## Open Questions

- Does TypeSafe retain request bodies for non-enterprise accounts? The legal page commits to no training on user data and names zero retention for enterprise only. Owner: the operator. An answer the operator dislikes is acted on by defaulting `jevMode` to `off`.

## Related

- The claude-kit memory database plan on branch `feat/memory-database` sets the local-queue-then-sync pattern this journal follows. The journal's SQL side is a separate claude-kit plan, not yet written.
- `docs/plans/agent_persona_lean-injection_v1.md` and `docs/plans/agent_persona_supervisor-peer_v1.md` edit `hooks/index.ts` ahead of this plan.

## Chapters

### Interim board 1 - 2026-09-20

Not a Chapter. Section 1 is dispatched and in flight. No section has closed and none carries a `Completed:` line.

**Stage.** Section 1, the live probe and the Jev client, is the only section started. Its implementer is running. No review round has been dispatched and no gate has been run against this plan's work.

**Run start, and the normalization it carried.** This session took the leash on 2026-09-20 under the operator's relayed `/kit-goal`, which named this plan first in a queue of four. The `Status:` header read `Ready` at the start and now reads `In Progress`. The `## Dispatch Authorization` section recorded no execution grant at the start and now records the operator's arming, under the memory record `self-armed-arming-does-not-satisfy-an-operator-only-execution-grant`: the arming state records this run's own invocation rather than the operator's, so a session reading only that state would find the plan unarmed.

**Base and anchor drift.** The branch is `decision-seam-build`, cut from `main` at `2da6543`. The plan's line numbers are against `d6be1f3`, two merges earlier, and `hooks/index.ts` has shifted by roughly 45 to 63 lines. Confirmed this session at three of the plan's own anchors: `appendToChannelLog` at `hooks/index.ts:574` against the plan's 529-533, `classifyLabels` at 4335 against 4273-4275, and `askMarkerMatch` at 5188 against 5125. Every site is re-located by its symbol rather than its number.

**Live dispatches.** One. `implementer-fable` at the `fable` model override, asked for Section 1 whole: the throwaway live probe under a supervised `seam-probe` persona, then `hooks/decision-seam.ts` and its unit suite, with the temporary probe file and its one call line in `hooks/index.ts` reverted before it finishes. Its first-turn reading at 02:00 read 13 non-synthetic assistant lines and zero `<synthetic>` lines, every line resolving at `claude-fable-5-1`, so the override was served rather than substituted.

**Gate baseline.** None taken by this session against this plan. Two reasons, both recorded rather than worked around. Another session, `DEV-DISCORD`, holds this machine's heavy-process claim, written 2026-09-20T05:44:06Z with `Expected-seconds` 1500 and read from the claim file's own modification time. And this session's own implementer holds the tree, so a suite run now would contend with it. The section's close gate is the targeted lane and runs when the implementer returns.

**Rulings adopted since the last boundary.**

- Section 1's live probe runs beside the live fleet rather than waiting for a quiet box. `bin/supervise.sh:2491` gates on `wait_persona_free_both "$WORKDIR" "$PERSONA"`, which reads the named persona only, so a fresh `seam-probe` name and a fresh working directory pass it with five personas live. `.kit/live-all.sh` is the one that refuses outright beside any live persona claim, and this section does not use it.
- The work branch is `decision-seam-build` rather than `decision-seam`. The latter name is held by a worktree at `.claude/worktrees/decision-seam`, left from this plan's own authoring branch, which merged as pull request 51.
- The checkout was moved from `lean-injection` to the trunk and brought current before the arming, because the arming tool cannot see a plan file the tree predates. The three files that read as uncommitted there were byte-identical to their `origin/main` blobs, confirmed by hash, and copies were taken before the move.

**Asks in flight.** Two, neither blocking.

One of the plan's own Open Questions is unanswered: whether TypeSafe retains request bodies for non-enterprise accounts. Its owner is the operator and the plan records the remedy, which is defaulting `jevMode` to `off`.

**A held inbound handoff.** The coordinator persona sent this session a plan on 2026-09-20 and asked for it to be queued third, ahead of `agent_persona_supervisor-peer_v1.md`. The plan is `docs/plans/agent_persona_supervisor-gaps_v1.md` at commit `fe5feab` on branch `plans/supervisor-gaps`, fetched into this checkout and readable here. Its state is `received-verified-holding-for-authority`. It is not armed and this session's queue is unchanged at four plans.

What it waits on is the operator's own word arming it. The trace was run and it failed on the arming alone. The plan's `## Dispatch Authorization` section quotes the operator authorizing the plan to be written and passed on, and then states in its own words that nothing in the section arms it, with execution left to the operator's word. The message's stated ground was a standing permission to queue plans, which this session does not hold: `kit-goal status` shows four plans each carrying a separately traced operator authorization and no standing grant, and no memory record in either shared tier carries one.

What did trace is the ordering. That plan's `## Intent` records the operator deciding on 2026-09-20, with their words quoted, that it runs before the supervisor-peer plan. So the position is settled and only the arming is open. A session that arms it later places it third.

Accepted as information rather than as authority: that plan and `agent_persona_supervisor-peer_v1.md` both edit `stop_child` and the supervisor poll loop in `bin/supervise.sh`. This is corroborated inside the artifact itself, whose `## Related` section says the peer plan's executor re-reads both as this plan leaves them. Whoever runs the supervisor-peer plan reads that Chapter first.

**Next action.** Await Section 1's implementer, then verify its diff and its probe evidence, then dispatch Section 1's round 1 reviewers. Section 1's writer tier is fable, so round 1 runs the adversarial and blind pair at fable on the Agent tool at their frontmatter effort. The security lens joins that round: the section writes the repository's first `$.http.fetch` call site and reads a secret from the environment, which meets the security trigger on both counts.

### Interim board 2 - 2026-09-20

Not a Chapter. Section 1 is built and its gates are green, but review round 1 is still in flight and one reviewer has already returned changes. No `Completed:` line is written.

**What the live probe settled, and the ruling it forced.** The plugin engine judges `hooks/index.ts` statically and refuses the whole module when `$` is passed to a function imported from another file. The engine's own words, read from a child's debug file: `$ is passed to "runSeamProbe", imported from "./decision-seam-probe": $ is followed only into a function declared in this same file, never across an import`. A refusal is silent, and `tsc` and every node suite pass over it. So this plan's stated entry point, `ask($, ...)`, cannot load.

The ruling, mine rather than the operator's because it turns on a fact about the engine: new modules take an interface of closures, and `hooks/index.ts` gains a top-level `xxxHostOf($)` adapter per module. The repository already does this at `hooks/index.ts:110`, where `commonsStoreOf(dp)` returns arrow closures that each make a full `dp.store.verb(...)` call at their own site, and it loads in production. Section 1's `ask(host: SeamHost, ...)` is built that way and loaded in a real supervised launch.

Two consequences this plan must carry. The Approach line "No new function is declared in `hooks/index.ts`" is now false and is amended when Section 5 lands. Section 2's resolver and Section 3's journal each need their own host, so their signatures change the same way.

**Probe facts, all confirmed from the probe's own recorded output.** The API key resolves through the child's settings path as PRESENT, with the value never recorded. `USERPROFILE` and `HOME` both resolve. A live call to the vendor returned 200 with a well-formed answer. An absolute write created two missing directories and read back. The probe file, its adapter and its call line were reverted, and `hooks/index.ts` is byte-identical to HEAD, confirmed here by `git diff --quiet` at exit 0.

**Gates, run by this session rather than accepted from the implementer.** `npx tsc --noEmit` exit 0. `node .kit/check-loader-rule.mjs` exit 0. `node .kit/decision-seam-unit-test.mjs` exit 0, 84 OK. `node .kit/controller-tick-test.mjs` exit 0, 1381 OK and 0 FAIL. Nothing was staged by the implementer, confirmed.

**Review round 1.** Four dispatches, all at the fable override: the adversarial reviewer, the blind reviewer, the security lens and a consultant on the host-access ruling. Every first-turn reading resolved clean, each transcript carrying only `claude-fable-5-1` assistant lines and zero synthetic lines, so the override was served on all four.

**Findings confirmed so far.** The blind reviewer returned CHANGES_REQUIRED. Three defects were checked against the code here rather than taken on report, and all three hold. `hooks/decision-seam.ts:218` calls the resolver with no `try`/`catch`, so a rejecting resolver makes `ask` reject, against its own documented contract that it never rejects. Line 225 dereferences `question.options` unguarded, so a resolver returning nothing throws. Line 263 admits a `NaN` status as success, because `NaN` is a number and both range comparisons are false. The fixes wait on the round closing, since a tree-mutating probe may not run while other agents are reading the tree.

The adversarial reviewer returned CHANGES_REQUIRED on the same two defects, reached independently and under a different brief, so the agreement is corroboration rather than one reading echoed. It adds five findings and one open ruling. The open ruling is a spec gap: the closed failure-reason set has no member that can name a resolver failure, so the reason a guarded resolver returns has to be chosen before the fix lands. Its other findings are that the ten-second timer is never cancelled when the request wins, because `SeamHost.sleep` drops the abort signal the engine's own clock accepts; that the module's header comment claims the loader checker covers the cross-import shape when it does not; that the suite pins property insertion order, which no contract covers; and that the clock fake added to the harness has no consumer. It also verified the request's wire shape against the vendor's published API document and found it correct.

One evidence gap it raised is the Chapter's to close rather than the code's. The key-leak sweep's predicate, the paths it ran over and the control's match lines are not recoverable from the tree, so that absence claim is unproven until the Chapter records them.

**A defect fixed in this session's own scope.** `.kit/.gitignore` denies everything by default behind a per-file allowlist, so the new unit suite was invisible to git and would have been dropped from the commit. It is allowlisted now. Confirmed by the file appearing in `git status` only after the edit, with a withheld control showing an unlisted file is still ignored.

**Box contention.** This session ran its gates under its own claim and released it at the operation's end. Another session, `DEV-PLUGIN`, claimed the machine's heavy-process slot at 06:46:56Z for 900 seconds. The fix round's gates either wait for that claim or name the contention in what they report.

**Next action.** Await the three reviewers still running, adjudicate the round against the blind reviewer's findings, fix what holds, re-run the targeted lane, then close the section with a Chapter.
