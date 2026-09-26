# The Claude Code upgrade check and the restart recap: two skills agentic-plugin ships, each on a script, so a new build is validated before the fleet moves and a restarted persona reads where things stood

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-25

## Dispatch Authorization

This plan arms in two stages, and the coordinator queues it after the plans already in its queue. Stage one is sections 1 and 2, the upgrade check. They arm when items 0 and 3 under Decisions no longer read `Ruled: pending`. Stage two is sections 3 to 6, the restart recap and the close. They arm when items 1 and 2 no longer read `Ruled: pending`. The operator's answers arrive on the architect's relay thread or at a keyboard, and "all as recommended" binds every item at once. Every section runs one at a time on the kit's executing-work loop. That loop dispatches two fresh-context reviewers per section, at the Fable model on low effort through the Workflow tool, and this plan fans out nothing beyond that pair, so the operator's standing cap of three Fable agents and five agents open at once is met by construction.

## Goal

When this is done, agentic-plugin ships a `skills/` directory with two skills the operator can call from a persona's Discord thread. `upgrade-check` validates a newly installed Claude Code build against the plugin before any other persona restarts onto it: one script runs the seven pre-restart steps and writes a results table per version, the canary session restarts itself under a goal that carries the post-restart checks, and the new session finishes the table and gives the operator one verdict, clear to restart the fleet or a named list to triage. `restart-recap` reads the transcript of the session that held the persona before this one, from the lineage the plugin now records in its store, and prints a bounded digest of what the operator said and what the persona replied, so a restarted session knows what was in flight instead of misreading its own finished goal. The same digest is injected automatically as a `[RESTART RECAP]` block on the first prompt after a restart, only where the previous session was recent and had an open goal or recent operator traffic. Both checks are repeatable: a second run appends to the same records and never overwrites them.

## Intent

The operator's frame, from the request the assistant persona relayed on 2026-09-25: "make this repeatable and runnable on demand." The upgrade check exists because the function-hooks API is an unsupported beta that changes between releases without notice, and build 2.1.280 broke the plugin four ways, two of which a stale copy of the types hid. The first run of the check, 2.1.282 to 2.1.283 on the assistant persona, passed every step but the engine tests, which do not exist. The restart recap exists because the assistant persona, after a restart, told the operator it had not run the check when it had, since a fresh session starts with no memory of the conversation the operator sees as one thread.

Done means: the operator types one skill name in a persona's thread and the check runs to a verdict; the pre-restart steps are a script, not prose a session follows by hand; every run appends a results row per step under its version, so the table for a build is the record of every attempt at it; the compile step proves it can fail before its pass counts; the recap reads the right session, the one that held this persona, even where two personas share a working directory; the automatic recap stays quiet after an idle stretch; and each skill's mechanics live in one script both the skill and the plugin call.

Done does not need: engine tests for the plugin, which are their own effort; a Discord command parser, since the relay delivers text and the session invokes the skill; a recap of any other persona's sessions; a change to how the supervisor decides a restart; a recap that reads tool calls or files, since the operator's messages and the persona's replies are what the operator remembers; or a transcript archive, since the harness rotates transcripts on the order of weeks and a recap older than that has no source.

Alternatives refused, one line each:
- Keeping the check as a runbook in the assistant persona's docs: a runbook is followed by hand and drifts, and the persona's docs folder is not installed on any other persona.
- Shipping the skills in the kit: the check is specific to this plugin's hooks and types, and every persona loads this plugin, so the plugin is where the skill travels with its subject.
- Finding the previous session by newest transcript in the working directory: two personas can share a working directory, so the newest file can be another persona's; the plugin knows both ids at claim time and records them instead.
- Running the recap on every restart unconditionally: after a parked stretch there is nothing to carry, and the block costs context on every launch.
- A results file in the plugin repository: the check is a property of a machine and its installed build, not of the source tree, and a canary should not need a commit to record a run.
- One script per caller for the recap: the skill and the plugin's automatic block would drift; one script prints a machine header and a human digest, and each caller reads its half.

Rulings after the spec shipped: none yet. Each is appended here dated, and the Chapter that lands it names it as drift.

Provenance: distilled by the architect persona from the assistant persona's relayed brief (record ARCHITECT-3e1be2f1-6f7a-42f6-bb1f-2cedc3afd862-1), the assistant persona's runbook and first-run results at `D:/personas/ASSISTANT/docs/claude-code-upgrade-check.md`, and a read of the plugin's claim path, prompt.submit injection, transcript records and CLI subcommands, on 2026-09-25 in session 1e18cd68.

## Decisions

Written to the recommendations. An item reading `Ruled: pending` parks the sections its stage names; nothing lands by silence. The evidence block sits at the end of this section.

**Item 0. The two skills ship in agentic-plugin, under a new `skills/` directory at the plugin root.** Ruled: pending.

- Situation. The plugin ships no skills today, and the check's runbook lives in one persona's docs folder. Claude Code discovers a plugin's skills from `skills/<name>/SKILL.md` under the plugin root, the layout the kit plugin already uses, and `claude plugin validate` reads them.
- Decision. Where the two skills live.
- Stakes. A skill in the plugin reaches every persona on the next `claude plugin update`; a skill anywhere else needs its own install path.
- Options. (a) agentic-plugin `skills/`. (Recommended.) (b) The kit. Cost: the kit would carry a plugin's private check and a dependency on its types. (c) A persona's docs folder. Cost: not installed anywhere, followed by hand.
- Unanswered: sections 1 and 2 stay parked.

**Item 1. The plugin records the previous session's id in the persona's store at claim time, and the recap reads that lineage.** Ruled: pending.

- Situation. The claim path computes the outgoing session's id and writes it only into a decision log string. Nothing on disk names the previous session as a field, and the supervisor's `child-<n>/handle.json` trail is cleared once an exit is accounted. Two personas can share a working directory, so their transcripts share one folder.
- Decision. Whether the recap's source is a `previousSessionIds` field the plugin writes, or a heuristic over the transcript folder.
- Stakes. A heuristic can recap another persona's session, which is worse than no recap. The field costs a state migration, four claim sites and a change to `agentic_identity`'s output.
- Options. (a) The field, a ring of the last three ids, newest first, written at every claim site, with the heuristic kept only as a labelled fallback for a store written before this plan. (Recommended.) (b) The heuristic alone. Cost: wrong-persona recaps in a shared directory.
- Unanswered: sections 3 to 6 stay parked.

**Item 2. The automatic recap is on by default, gated so an idle stretch injects nothing.** Ruled: pending.

- Situation. The operator wants the skill on demand and "possibly" an automatic version. The plugin's first prompt after a launch is the supervisor's priming turn, and prompt.submit already appends context blocks there. A hook has ten seconds; the script reads bounded tails of at most two transcripts, so five seconds is its ceiling.
- Decision. Whether the block is injected automatically, and under what gate.
- Stakes. Without it the persona has to be told to read its transcripts, which is the failure the request names. With it unconditionally, every launch after a parked night carries a stale block.
- Options. (a) A `restartRecap` setting, `auto` by default, `skill` to disable, and under `auto` the block is injected at the priming turn only where the previous session's last record is within 24 hours and either the store holds an active goal or the last operator message is within 6 hours; both windows are named constants. (Recommended.) (b) Skill only. Cost: the failure recurs until someone remembers. (c) Always. Cost: stale context on quiet launches.
- Unanswered: sections 3 to 6 stay parked.

**Item 3. Results live beside the fleet roster, one markdown table and one JSON lines file, appended per run.** Ruled: pending.

- Situation. The first run's results sit in the assistant persona's docs folder. The check is a property of the machine and its installed build. The roster file, `fleetRoster` in each persona's settings, names the fleet's directory, `D:/personas` on the fleet machine.
- Decision. Where a run's rows are written.
- Stakes. A home the next canary cannot find means a second table somewhere else.
- Options. (a) `<roster directory>/upgrade-checks.jsonl` as the record and `<roster directory>/upgrade-checks.md` regenerated from it, the directory passed to the script as `--results` and named in the skill. (Recommended.) (b) The plugin repository's docs. Cost: a canary needs a commit to record a run. (c) The persona's run directory. Cost: one table per persona, none for the machine.
- Unanswered: sections 1 and 2 stay parked.

**Declared under routes (a) and (b), reversible by one word.** Writing engine tests for the plugin is its own effort and goes to the backlog as one item, since `claude plugin test` runs `*.test.ts` files and none exists. The post-restart half of the check runs under a goal the canary sets before it restarts, since the new session starts with no context and the goal tree is what survives. The skill names are `upgrade-check` and `restart-recap`. The scratch folder is `<temp>/cc-validate-<version>`. The checkout the compile reads is passed as `--repo`: the clone the fleet's scheduled tasks run `bin/Start-Persona.ps1` from, `D:/agent_persona` on the fleet machine, with `npm install` run in it once so `node_modules/typescript` exists. The installed plugin copy under the plugins cache is not a valid `--repo`, since it carries no `node_modules`. The transcript folder rule is not restated: both scripts import `projectKey` and `transcriptPathsFor` from `bin/supervise-liveness.mjs`, which already derives the folder for the supervisor's liveness verdict. The harness has written the same directory under two letter cases on this machine, so the recap wraps that result in a lookup across every folder whose name matches case-insensitively, and section 4 pins that wrapper with a control folder differing in case only. The recap digest caps each message at 400 characters and the whole at 6,000, both named constants.

**Evidence.**
- Runbook and first run: `D:/personas/ASSISTANT/docs/claude-code-upgrade-check.md` (eight steps, the 2.1.283 results table, the two lessons).
- Claim site and the outgoing id: `hooks/index.ts`, the `persona_claim` decision whose detail reads `prev ${prevId}`, `prevId` computed from `holderHb?.sessionId ?? existingPersona.activeSessionId`; `README.md` names four claim sites.
- State shape: `hooks/agent-state.ts`, `activeSessionId` and `epoch` on the persisted state, the parse and migration functions beside them.
- Priming turn and context blocks: `hooks/index.ts`, `on("prompt.submit"`, `isPrimingTurn = e.text.startsWith("[SUPERVISOR-PRIMING]")`, the `[GOAL TREE]` and `[TASK LIST]` blocks that follow.
- Hook budget and plugin root: `.claude/types/claude-code.d.ts`, `HookBudget.ms` 10,000 and `$.plugin.root`; a precedent for running a node script from a hook, `dp.process.run(["node", script, "boundary"], { timeoutMs })` in `hooks/index.ts`.
- Injected strings are pinned: `.kit/injection-ledger.mjs` and `.kit/injection-duplicate-test.mjs`, one rule per injected block, refreshed by `node .kit/injection-ledger.mjs > .kit/injection-ledger.json`.
- Transcript records, read from this session's own file under `~/.claude/projects/D--personas-ARCHITECT/`: every record carries `sessionId`, `timestamp`, `cwd` and `version`; an operator message is a `type: "user"` record whose `message.content` is a string opening `<channel source="plugin:relay:channel-relay"`; a reply is a `type: "assistant"` record carrying a `tool_use` block named `mcp__plugin_relay_channel-relay__reply` with `input.message`; the shell inside a session carries `CLAUDE_CODE_SESSION_ID`.
- CLI, read from `claude plugin validate --help` and `claude plugin test --help` on 2.1.283 (the `test` subcommand does not appear in the first screen of `claude plugin --help`, which truncates the list): `claude plugin validate <path>` validates "a plugin or marketplace manifest, or the skills, agents, and commands in a directory"; `claude plugin test [dir]` runs "every *.test.ts and *.test.tsx under dir" and "exits 1 when a test fails"; `claude plugin details <name>` shows a plugin's component inventory.
- The store: `.agentic-personas.json` in the working directory, one entry per persona name, each carrying the state `hooks/agent-state.ts` types; the goal tree's active node is `activeGoalId` on that entry.
- `/plugin-types` writes `.claude/types/claude-code.d.ts` under the directory it runs in, and its first line names the build that wrote it.
- Load modes: `bin/supervise.sh`, the `--dev` branch that passes `--plugin-dir`; otherwise the installed copy under `~/.claude/plugins/cache/agent-persona/agentic-plugin/<hash>/`.
- Transcript retention: the operator memory `transcripts-rotate-chapters-are-the-record` (about 30 days).

## Approach

Two scripts carry the mechanics and two skills carry the procedure. `bin/upgrade-check.mjs` has a `pre` verb for the seven steps a session can run before it restarts and a `post` verb for the checks only the restarted session can run. `bin/restart-recap.mjs` prints one JSON header line and a text digest. Each skill is a short procedure that names the script's invocation, reads its output and says what to tell the operator. The plugin's automatic block calls the recap script through `$.process.run` with `$.plugin.root`, so the installed copy and a `--dev` checkout both find it.

The upgrade check's verdict is computed, not judged. `pre` reads each step's exit code and evidence and writes one row per step. Steps 2 to 5 and 7 must pass, step 6 may read `gap`, and manifest warnings are listed but do not fail. The compile step is two runs: the plugin's `hooks/` against the regenerated types must exit 0, and a control file that references a member the types do not declare must exit non-zero; a control that compiles turns the step to `fail` with the reason "control did not reject", since a clean exit then proves nothing. The verdict line is the last line of output and the exit code carries it: 0 clear, 1 triage, 2 could not run. `post` takes the three tool checks the model performed as an argument, since a script cannot call the session's tools, and reads the mechanical three itself: the running session's version from its own transcript, the heartbeat advancing across one interval, and `supervisor.log` since the newest `LAUNCH child-` line with the pre-gate's expected `FAIL` lines named as expected.

The restart recap's source is the lineage field. Section 3 adds `previousSessionIds` to the persisted state, a ring of three, newest first, written at every claim site from the id the claim already computes, and returned by `agentic_identity`. The script reads the persona's entry from the store, excludes the session named by `CLAUDE_CODE_SESSION_ID`, and reads the tail of each named transcript in the working directory's transcript folder. Where the field is empty, the fallback is the newest other transcript in that folder, and the header says `lineage: unrecorded` so the model reports the digest as possibly another persona's. The digest is chronological, one line per operator message and per reply, each trimmed, with the session's last assistant text as its closing line, and a final count line. The header carries what the gate needs: when the previous session's last record was written, when the operator last wrote, and whether the store holds an active goal.

The automatic block rides prompt.submit at the priming turn of an owner session. It is one new injected string, `RESTART_RECAP_BLOCK`, so the injection ledger gains a rule and is regenerated in the same commit. A timeout, a non-zero exit or an empty digest injects nothing and writes one decision line, so a broken script never costs a launch.

Sweep for shared surfaces, run by hand over the tree: the claim sites (`grep -n "activeSessionId = sess.mySessionId" hooks/index.ts`, four hits), the store shape's readers (`hooks/agent-state.ts` parse and migrate, `README.md`'s store-shape paragraphs, `.kit/controller-tick-test.mjs` fixtures), the injected-string pins (`.kit/injection-ledger.mjs`, `.kit/injection-ledger.json`, `.kit/injection-duplicate-test.mjs`), the tool-description pin (`.kit/tool-description-length-test.mjs`, for `agentic_identity`), the settings writer (`bin/agentic-common.sh`, which writes each `userConfig` key into `<rundir>/settings.json`, so a new key is added there or takes the code fallback), and the docs index (`docs/README.md`, active plans). No `skills/` directory, `*.test.ts` file, or `upgrade-check` and `restart-recap` name exists in the tree.

## Sections of Work

### 1. The upgrade check script
Model: opus
Files in scope: `bin/upgrade-check.mjs` (new), `.kit/upgrade-check-unit-test.mjs` (new), `.kit/fixtures/upgrade-check/` (new: a fake `claude` command for the test, a fixture types file, a fixture transcript), `bin/supervise-liveness.mjs` (imported, not edited), `README.md` (the unit test joins the test list, marked Offline).
Tests: lock the verdict in both directions (all pass with step 6 gap reads clear; a compile failure reads triage); lock the control (a control file the compiler accepts turns the compile step to fail); lock append-only results (two runs on one version give two runs in the table and the same table on a third regeneration); lock `post`'s version check both ways. The risk is a clean exit that proves nothing.

`node bin/upgrade-check.mjs pre --repo <checkout> --results <dir> [--scratch <dir>] [--canary <persona>]` runs steps 1 to 7 of the runbook in order, in a scratch folder it creates empty so the plugin stays passive there, with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment of steps 2 and 7. Step 1 records `claude --version` as `version` and the running session's version as `from`, read from the newest record of the transcript `CLAUDE_CODE_SESSION_ID` names, located with `transcriptPathsFor` imported from `bin/supervise-liveness.mjs`, or `unknown` where the shell carries no id. Step 2 runs `claude -p "/plugin-types"` in the scratch folder and reads the first line of `.claude/types/claude-code.d.ts` it writes there. Step 3 diffs that file against `<repo>/.claude/types/claude-code.d.ts`, counts added and removed lines, and lists the changed declaration names that also appear in `<repo>/hooks/*.ts`. Step 4 writes a scratch `tsconfig.json` over the new types and `<repo>/hooks`, runs `<repo>/node_modules/typescript/bin/tsc --noEmit`, then runs it again over a control file that reads a member the types do not declare, and passes only where the first exits 0 and the second does not; where `<repo>/node_modules/typescript` is absent the step reads `fail` with the evidence "typescript is not installed in <repo>; run npm install there". Step 5 runs `claude plugin validate <repo>/.claude-plugin/plugin.json` and records the exit code and its warnings. Step 6 runs `claude plugin test <repo>` where a `*.test.ts` file exists outside `node_modules`, records `gap` where none does, and records `skipped` with the CLI's own error where the subcommand is absent from the build. Step 7 runs `claude -p "Reply with the word ok." --model haiku --debug-file smoke.log` in the scratch folder and searches the log for `skipped`, `WARN`, `not attached`, `does not validate` and `refused` on lines carrying `agentic-plugin`, the manifest name the log uses.

Each step writes one row to `<results>/upgrade-checks.jsonl`: `{ run, version, from, at, canary, step, result, evidence }`, where `run` is one id per `pre` invocation, printed on the verdict line so the goal can carry it, and `result` is one of a closed list: `pass`, `warn`, `gap`, `fail` or `skipped`. After the rows, the script regenerates `<results>/upgrade-checks.md` from the whole file: one heading per version, one table per run under it, newest first. The last line printed is the verdict: `pre: clear to restart the canary onto <version>` when steps 2 to 5 and 7 read pass or warn and step 6 reads pass or gap, else `pre: triage <step list>`; exit 0, 1 or 2.

`node bin/upgrade-check.mjs post --run <id> --results <dir> --rundir <dir> --tools <ok | fail: reason>` runs the mechanical half of step 8 and writes its rows under the `run` the `pre` verdict printed, so one table holds both halves: the running session's transcript version equals `claude --version`; `<rundir>/heartbeat.json`'s `lastSeen` advances across one heartbeat interval plus five seconds, the interval read as `heartbeatMs` from `<rundir>/settings.json` or the plugin default of 30 seconds; `<rundir>/supervisor.log` since the newest `LAUNCH child-` line carries no line matching the closed list `ERROR`, `HEARTBEAT_ABSENT` or `RESTART`, with the lines the pre-launch gate writes while the old child's heartbeat ages out, the ones carrying `GATE` and `FAIL`, counted and reported as expected rather than as errors. The `--tools` value is the model's own reading of `goal_status`, `agentic_inbox` and the relay reply, recorded as one row. The verdict line reads `post: fleet clear to restart onto <version>` or `post: triage <list>`.

Every child process the script runs carries a timeout, `STEP_TIMEOUT_MS`, 180 seconds, and a step whose process outlives it reads `fail` with the evidence `timed out`; a missing `--repo` or `--results`, a `--repo` with no `hooks/` directory, or a results directory that cannot be written exits 2 before any step runs and prints why. The results files hold version strings, step names and evidence lines cut from command output, never the smoke log itself, which stays in the scratch folder.

Acceptance: the unit test drives both verbs against the fake `claude` in `.kit/fixtures/upgrade-check/` placed first on `PATH`, and passes; run against the real CLI on this machine with `--repo` at the checkout and `--results` at a scratch directory, never the fleet's, `pre` completes and, for steps 1 to 7, its `result` value equals the runbook's verdict for that step, step 6 reading `gap`, with evidence text not compared; the script's exit code is read from the run, never from its output.

### 2. The upgrade check skill
Model: sonnet
Files in scope: `skills/upgrade-check/SKILL.md` (new), `README.md` (one section, "Checking a new Claude Code build", placed with the install and update material), `docs/architecture.md` (one paragraph naming the `skills/` directory and both skills), `docs/backlog.md` (one new item: engine tests for the plugin's hooks under `claude plugin test`; the existing type-mirror item gains a line pointing at step 2 of the check as the regeneration the check already performs for `claude-code.d.ts`, not for the tool-list mirror).
Audience: a persona session that has never run the check, owner tier, with the plugin's tools; and the operator reading the verdict on Discord, who cannot open files. The document answers, for the session: when the check runs, the exact commands, what to do on each verdict, how the restart carries the second half; for the operator: what one verdict line means and where the table is. Voice: none. Fact base: `bin/upgrade-check.mjs`, section 1's unit test, `D:/personas/ASSISTANT/docs/claude-code-upgrade-check.md`.

The skill is invoked by its name in the thread or by the operator asking for the upgrade check. Its body: run `pre` with the results directory beside the roster and the repository the keeper runs from; read the verdict line and the exit code; on triage, reply with the failing steps and their evidence lines and stop; on clear, create a goal whose text carries the `post` command with the `--run` id the verdict line printed and the three tool checks, then call `supervisor_restart` with the reason; after the restart the new session takes that goal, runs `goal_status`, `agentic_inbox` on the coordinator persona and one relay reply, runs `post` with `--tools`, and replies with the verdict line and the table's path. The skill states the two lessons from the first run as rules: the smoke step proves only that the plugin loads, and the relaunch pre-gate reads `FAIL` for about ninety seconds while the old heartbeat ages out.

Acceptance: `claude plugin validate . --json` at the repository root exits 0 and its report names the skill; `claude plugin validate skills` exits 0; the README section and the architecture paragraph name the results path and the two verbs; the backlog item exists with today's date.

### 3. Session lineage in the persona store
Model: opus
Files in scope: `hooks/agent-state.ts` (the state type, `createDefaultState`, the parse and migration paths), `hooks/index.ts` (the four claim sites and `agentic_identity`'s result), `README.md` (the store-shape paragraphs), `.kit/controller-tick-test.mjs` and `.kit/tick-harness.mjs` (claim cases), `.kit/tool-description-length-test.mjs` (only where the tool's description changes).
Tests: lock the migration (a store written without the field parses to an empty ring); lock the write at each claim site (the outgoing id lands first, the ring holds three, the own id never enters it); lock the identity tool's output carrying the ring. The risk is a claim path that skips the write, which the recap then cannot see.

`previousSessionIds: string[]` joins the persisted state. Every claim site that sets `activeSessionId` to this session's id first pushes the id it is replacing, where one is known, to the front of the ring, drops duplicates and trims to three. `agentic_identity` returns the ring beside the fields it returns today. No reader other than the recap script consumes it. The ring is one wider than the recap's default read of two sessions so that a relaunch which died before its first turn, which leaves a transcript with nothing to digest, does not push the session that did the work out of reach.

Acceptance: the unit suites in `.kit/` that read the state pass; a persona store from before this plan loads without a decision line about the new field.

### 4. The restart recap script
Model: opus
Files in scope: `bin/restart-recap.mjs` (new), `.kit/restart-recap-unit-test.mjs` (new), `.kit/fixtures/restart-recap/` (new: three transcript fixtures cut from real records with their text replaced, a store fixture), `bin/supervise-liveness.mjs` (imported, not edited), `README.md` (the unit test joins the test list, marked Offline).
Tests: lock exclusion of the own session; lock the lineage read over the fallback and the `lineage: unrecorded` header when the ring is empty; lock the folder-name rule with a control path carrying a dot and a colon, and the case-insensitive lookup with a folder that differs from the derived name in case only; lock both caps; lock the header's three fields against fixtures with and without an active goal. The risk is a recap of the wrong session.

`node bin/restart-recap.mjs [--store <path>] [--persona <name>] [--exclude <id>] [--projects <dir>] [--sessions <n>] [--since <hours>]` defaults to `.agentic-personas.json` in the working directory, the one persona that store holds where it holds exactly one and otherwise requires `--persona`, the id in `CLAUDE_CODE_SESSION_ID`, the transcript folder from `transcriptPathsFor` in `bin/supervise-liveness.mjs` wrapped in the case-insensitive lookup the Decisions section states, two sessions and 48 hours. It reads the last `RECAP_TAIL_BYTES` (2 MB) of each transcript, skipping a partial first line, and takes the operator messages and the replies as the Evidence block shapes them, plus each session's last assistant text. The digest admits nothing else: not tool calls or their results, not the supervisor's priming turn or any prompt the plugin injected, not a coordinator or worker record delivered as a turn, not subagent transcripts under the session's folder, and not the model's thinking. A persona session is headless, so every user record without the channel tag is text a program submitted, and the operator's own words are exactly the tagged ones. A transcript that cannot be read, or a record that is not JSON, is skipped with one line naming it, and the script exits 0 with an empty digest and a header rather than failing, so the caller always has the header. Line one is the header, JSON: `{ "lineage": "recorded" | "unrecorded", "sessions": [ids], "lastRecordAt": iso | null, "lastOperatorAt": iso | null, "activeGoal": true | false | null }`, where `lastRecordAt` and `lastOperatorAt` are the newest timestamps across every session the digest read. The lines after it are the digest: a session line with its id, its first and last timestamps and its `version`, then `operator <hh:mm>: <text>` and `persona <hh:mm>: <text>` lines in time order, then `last words: <text>`, then a count line. A session outside `--since` prints as one line naming its age. Messages are trimmed to `RECAP_MESSAGE_CHARS` (400) and the whole digest to `RECAP_DIGEST_CHARS` (6,000), the oldest lines dropped first, with a line saying how many were dropped.

Acceptance: the unit test passes; run in this architect session's own directory with `--exclude` set to this session, the digest names the prior architect session and its last operator message, read against the transcript by hand.

### 5. The restart recap skill and the automatic block
Model: opus
Files in scope: `skills/restart-recap/SKILL.md` (new), `hooks/index.ts` (prompt.submit at the priming turn; the `RESTART_RECAP_BLOCK` string; two constants `RECAP_RECENT_MS` 24 hours and `RECAP_OPERATOR_MS` 6 hours; a `restart_recap_skipped` decision), `.claude-plugin/plugin.json` (`restartRecap`, `auto` or `skill`, default `auto`), `bin/agentic-common.sh` (the settings writer, where it enumerates keys), `.kit/injection-ledger.mjs` and `.kit/injection-ledger.json` (the new rule and the regeneration), `.kit/controller-tick-test.mjs` (gate cases), `README.md` and `docs/architecture.md` (the block joins the list of injected strings and the settings table).
Tests: lock the gate both ways (recent with an active goal injects; recent with no goal and no operator message in six hours injects nothing; stale injects nothing); lock the off switch; lock the failure path (a script that exits non-zero, times out or prints an empty digest injects nothing and writes the decision line); the injection duplicate test passes on the regenerated ledger. The risk is a block on a quiet launch, or a launch delayed by a stuck script.
Audience: a persona session after a restart, any tier that can read its own directory; the operator who types the skill name. The document answers: what the digest is and is not, how to read the `lineage` header, what to say to the operator when work was in flight. Voice: none. Fact base: `bin/restart-recap.mjs`, section 4's fixtures.

At the priming turn of an owner session whose setting reads `auto`, the hook runs the script with `$.process.run(["node", `${$.plugin.root}/bin/restart-recap.mjs`, "--persona", sess.persona, "--exclude", sess.mySessionId], { cwd: sess.workdir, timeoutMs: RECAP_TIMEOUT_MS })`, five seconds, reads the header, and appends `[RESTART RECAP]` followed by the digest where `lastRecordAt` is within `RECAP_RECENT_MS` and either `activeGoal` is true or `lastOperatorAt` is within `RECAP_OPERATOR_MS`. The block's frame line says what the digest is, that it is read from the previous session's transcript, and that the persona reports where things stood rather than resuming any act the digest names. Under `skill` the hook runs nothing. The skill body says: run the script, read the header, tell the operator what was in flight or that nothing was, and where `lineage` reads `unrecorded`, say the digest may be another persona's.

Acceptance: the regenerated ledger passes `.kit/injection-duplicate-test.mjs`; the gate cases pass; `claude plugin validate .` lists both skills.

### 6. The close
Model: sonnet
Files in scope: `docs/README.md` (this plan moves to the archived list at finishing), `docs/backlog.md` (the engine-tests item cross-references this plan), `README.md` (the skills section names both skills and the results path once).
Tests: none new; the whole gate runs.

The whole gate is every `.kit/*.mjs` test, `.kit/controller-tick-test.mjs` and `.kit/check-loader-rule.mjs` among them, every `.kit/*.sh` suite that finishes inside two minutes, `claude plugin validate . --json`, and the live suites `.kit/live-all.sh` names, each read from its exit code. The live suites run here rather than deferring to the deferred-gate-run plan, whose scope line does not name this plan, and because sections 3 and 5 change the priming turn a live launch exercises; they wait for a free box per the doctrine's one-heavy-process rule. The pull request body lists the validate output, the gate counts against the baseline taken at section 1's start, and the operator verification items below.

## Out of Scope

- Engine tests for the plugin's hooks. Section 2 files the backlog item; nothing here writes a `*.test.ts`.
- The kit repository, its skills and its hooks.
- Changes to the supervisor's restart, liveness or gate rules, and to `child-<n>/handle.json`.
- A recap of another persona's sessions, of tool calls, or of files changed.
- Regenerating `.claude/types/claude-code-mcp.d.ts`, the tool-list mirror, which the check does not touch and the existing backlog item owns.

## Assumptions

- assumed 2026-09-25 (default): engine tests are a backlog item, not a section; reversal: one section and its own plan review.
- assumed 2026-09-25 (the goal tree survives a restart, `hooks/agent-state.ts`): the post-restart half runs under a goal the canary sets; reversal: the operator prompts the new session by hand.
- assumed 2026-09-25 (default): the skill names are `upgrade-check` and `restart-recap`; reversal: a rename before section 2 lands.
- assumed 2026-09-25 (`projectKey` in `bin/supervise-liveness.mjs`): the transcript folder rule is that function, imported rather than restated; reversal: section 4's control test fails and the function is corrected where it lives.
- assumed 2026-09-25 (default): the live suites run at section 6 rather than deferring to the deferred-gate-run plan; reversal: a dated ruling adding this plan to that policy's scope line.
- assumed 2026-09-25 (`HookBudget.ms` in the types): the recap script gets five seconds inside the hook's ten; reversal: one constant.
- assumed 2026-09-25 (default): the results directory is the roster's directory, passed as `--results`; reversal: item 3's ruling names another.
- assumed 2026-09-25 (`bin/supervise.sh`'s `--dev` branch): `$.plugin.root` resolves the script under both load modes; reversal: section 5 reads the installed path from `installed_plugins.json` as the kit boundary call does.

## Operator Verification

- After the plan merges and `claude plugin update` runs on the fleet machine, type `upgrade-check` in one persona's thread on a build already checked; a verdict line arrives and `D:/personas/upgrade-checks.md` gains a run. A reply that names no verdict reopens section 2.
- On the next Claude Code update, run the skill on one persona before restarting the others; the canary restarts itself and the new session replies with the `post` verdict. A canary that restarts without the goal, or a new session that does not run `post`, reopens sections 1 and 2.
- Restart a persona that has an open goal and recent operator messages; its first reply after the restart shows it read the recap. Restart one that has been idle a day; no `[RESTART RECAP]` block appears in its transcript. Either failing reopens section 5.

## Open Questions

None beyond the Decisions items.

## Chapters
