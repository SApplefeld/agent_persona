# Supervisor gaps: a restart lever, a patient stop, and a keeper that adopts

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-20

## Goal

When this is done, the coordinator persona can restart another persona's child through a tool, with no hand edit of that persona's store and no second writer on it. A restart that reaches a child in the middle of a turn waits for the turn to end, up to a cap, before any signal is sent, so a requested restart no longer kills a session seconds after it wrote a file. A keeper that starts while a supervisor for its persona is already running watches that supervisor, so it launches nothing beside it and stops failing the pre-launch gate every five minutes. It matters because on 2026-09-20 no persona could restart a parked architect, three of five requested restarts ended in a forced tree kill, and the architect's keeper looped on `GATE TIMEOUT` for as long as its orphaned supervisor lived.

## Dispatch Authorization

The operator asked for this plan on 2026-09-20 on the architect persona's Discord thread, in the words "Are you able to take those, verify them, write a plan for them, and pass it to either the Worker to be queued, or the Steward to help manage it getting Queued?" That is authorization to author the plan and to queue it. The operator approved the sketch in that thread the same day, and the two decisions under `## Intent` record the answers. Execution is armed on the operator's own word, typed into the executing session's thread or relayed through the coordinator persona, as for the sibling plans in this directory. Nothing in this section arms it. The executor is the dev persona.

## Intent

The operator's frame, 2026-09-20: a stand-in session wrote three findings from that night's fleet restart, and the operator asked the architect to verify them and plan the fixes. The brief is `D:/personas/.kit/findings-2026-09-20-supervisor-gaps.md`, on the fleet machine and outside this repository.

What done needs to do. The coordinator persona holds a working lever on a stuck persona. A requested restart lets a busy child finish its turn. A keeper never runs a second supervisor beside a live one for its persona.

What done does not need to do. It does not change how a child is judged alive, hung or gone, which is the supervisor-peer plan's. It does not make a shutdown, a crash-loop stop, a budget stop or a hung restart patient. It does not let any persona but the coordinator restart another. It does not establish what `Stop-ScheduledTask` kills under the keeper's task, and it does not find what ended the architect's first keeper on 2026-09-20. It adds no plugin option. It adds one supervisor setting, the cap on the patient wait, and no other.

Alternatives refused.

- Let the restart tool write `restart_requested` into the target persona's store. Refused: the store has one writer by design, and the hand edit the incident needed is the defect, not the model.
- Raise `supervisorStopGraceMs` for every stop. Refused: an idle or parked child has nothing to finish, and a hung one would hold its persona eleven minutes longer.
- Renew the grace while the child's output stream grows. Refused: a tool call can run ten minutes without writing a line, so growth reads a working child as idle.
- Have the keeper hold, or back off further, on exit code 2. Refused: the persona would stay unwatched for as long as the orphan lives, and the orphan's exit would go unseen.
- Wait for the supervisor-peer plan and build on its request file and mailbox. Refused by the operator's first decision below.

Decided 2026-09-20 by the operator on the architect's thread, in the words "I accept your recommendation, that makes sense. Please proceed.": this plan runs before `agent_persona_supervisor-peer_v1.md`. The cost accepted is that the peer plan's executor re-reads `stop_child` and the poll before building on them.

Decided 2026-09-20 by the operator on the same thread, in the words "Agreed, Option 1 is solid.": only the coordinator persona may use the restart lever, on any other persona, on its own judgment or the operator's word. It tells the operator each time. The tool refuses a second restart of one persona inside fifteen minutes. Refused beside it: requiring the operator's word each time, which no tool can check and which costs a round trip when the operator is likeliest away, and letting any persona restart any other, which lets a worker restart the coordinator.

Rulings after the spec shipped: none at the write.

Provenance: distilled from the architect persona's design conversation with the operator on Discord, 2026-09-20.

## Approach

**What was verified.** `supervisor_restart` in `hooks/index.ts` denies a caller that is not the persona's owner and pushes `restart_requested` onto the caller's own store. `stop_child` in `bin/supervise.sh` closes the child's input, waits `supervisorStopGraceMs` (60 seconds by default), sends TERM, waits again, then kills the recorded tree. The architect's second child that night was stopped at 05:43:06Z. Its output stream was last written at 05:44:08Z and its newest record was a tool result, so it was inside a turn. TERM came at 05:44:11Z and the tree kill at 05:44:14Z, and the child's last transcript record never reached disk. The keeper tasks register with `MultipleInstances IgnoreNew`, so the architect task's second start at 05:19:30Z means its first keeper process had already ended, while the supervisor that keeper launched was still running with no living parent. `bin/Start-Persona.ps1` checks a hold marker before it launches and checks for no live process.

**The restart request is a file in the target's run directory, read as the fact the supervisor already acts on.** A new plugin tool, `fleet_restart`, writes `<rundir>/restart.request`, one JSON object `{ at, by, reason }` with `at` in epoch milliseconds. The run directory comes from the fleet roster through `rosterRunDir`, the function `fleet_status` already uses. The supervisor's poll harvests `restartRequestedTs` from the persona store in `bin/supervise-poll.mjs`. The poll now takes the later of the store's value and the file's `at`. `bin/supervise-decide.mjs` does not change, so the rule that fires a restart stays the one in force: a request newer than the child's start. A request the restart has served is therefore stale by construction, since the new child starts after it, and nothing has to delete the file. The supervisor's natural-exit path reads the same fact through `get_fact`, and it takes the file the same way. An `at` more than one minute ahead of the reader's clock is ignored, because a future-dated request would stay newer than every child and restart the persona forever.

**The tool's gate is the coordinator ground alone.** `fleet_status` admits the coordinator ground and a reader claim on the coordinator persona. `fleet_restart` admits only the first, read through the same `deliveryGroundIn` call. A ground is the standing `deliveryGroundIn` in `hooks/operator.ts` computes for a calling session from the live claims in the commons store. It is `COORDINATOR` when the session holds the owner claim on the coordinator persona, `READER:<persona>` when it holds a reader claim on some persona, and `WORKER:<persona>` when it owns a named persona of its own. The cases in `.kit/fleet-status-unit-test.mjs` build each of those callers and are the fixtures to copy.

It refuses in a closed set of cases: the caller lacks that ground, no `fleetRoster` is set or the roster cannot be read, the target is not a roster entry whose `enabled` is exactly `true`, the target is the caller's own persona (whose lever is `supervisor_restart`), the run directory does not exist, and a request file is already there whose `at` is a number less than fifteen minutes behind the tool's clock. A request exactly fifteen minutes old no longer refuses. An existing file that cannot be parsed, carries no numeric `at`, or is dated ahead of the clock is treated as absent and overwritten. The fifteen minutes is a constant in the plugin. The write is a temporary file renamed over the target, so the supervisor never reads half a record. The tool writes nothing to the commons store and nothing to any persona store.

**The patient stop reads the tail of the child's output stream.** A pure module, `bin/supervise-turnstate.mjs`, takes the path of `child-<n>/stdout.jsonl` and returns `busy` or `idle`. It reads conversational records only, which are records of type `assistant` and `user`. `system` records and `rate_limit_event` records are skipped. The child is `busy` when the newest conversational record is a `user` record, or an `assistant` record carrying a `tool_use` block. In the first case the model owes a reply. In the second a tool is running. It is `idle` when the newest is an `assistant` record with no `tool_use` block and the file's modification time is more than thirty seconds old. An `assistant` text record younger than that reads `busy`, because inside a turn a text record is followed by a `tool_use` record within about a second. A stream whose newest record of any type is a rate-limit record reads `idle`, whatever sits before it. A rate-limit record is a `rate_limit_event` record, or a `system` record whose subtype is `api_retry` with `error_status` 429. A child parked on a limit rewrites such a record every thirty seconds, so its stream never goes quiet, and it has nothing to finish. A stream that is missing, empty or unreadable reads `idle`, so a fault in the reader falls back to today's behavior. The module runs unconditionally at load as `bin/supervise-poll.mjs` does, for the reason that file's closing comment states, and its unit suite drives it as a process. The shape rests on one measured stream, the architect's `child-2` of 2026-09-20. That stream carried no record of type `result` and no non-null `stop_reason`, so neither can mark a turn end for a child driven from the channel. Section 1 re-measures on a second stream before Section 2 builds on it.

**Only a requested restart of a live child is patient.** `stop_child` is called under six labels: `cleanup`, `stop_complete`, `stop_crash_loop`, `stop_budget`, `restart_passive` and `restart`. The patient wait applies to `restart_passive` and to no other, and the set is closed at that one label. Under it, the EOF phase keeps its ordinary grace, then keeps waiting while the reader returns `busy`, polling every five seconds. The wait ends on the first of three events: the child exits, the reader returns `idle`, or eleven minutes have passed since the input closed. On the second and third, TERM follows at once with no further grace, since the ordinary grace has already run. A child that reads `idle` and has not exited has ended its turn and ignored the closed input, so more waiting buys nothing. The cap is a supervisor setting, `supervisorStopBusyCapMs`, validated as `supervisorStopGraceMs` is, because the suites that drive `stop_child` must shorten it as they shorten the grace. Eleven minutes is the harness's ten minute tool-call cap plus a margin, the same figure the supervisor-peer plan derives for its final ask. TERM and the tree kill follow unchanged. Closing the input first is harmless to a running turn: the child reads end of input when the turn ends and exits then.

**The keeper looks for a live supervisor before every launch.** A function in `bin/keeper-functions.ps1` takes a list of process records and the wrapper's full argument array, the supervisor script path first, and returns the live supervisor for this persona or nothing. That array is what the wrapper builds around `Build-SupervisorInvocation`'s output before it launches, so the match tokens are the launch tokens. A process matches when the first three tokens after its executable equal the array's first three: the `supervise.sh` path, the working directory and the persona name. No later token is read, so an orphan launched under an earlier roster, with a different channel name or extra arguments, is still adopted. `dev` must not match `dev-plugin`. A live command line reads `"C:\Program Files\Git\bin\bash.exe" /d/agent_persona/bin/supervise.sh /d/personas/dev-plugin/repo dev-plugin bypassPermissions --rundir /d/personas/dev-plugin/run`, with the script, the working directory and the persona in the forms `Build-SupervisorInvocation` emits. The function compares against that function's own output and converts no path itself. A supervisor runs as an outer and an inner `bash.exe`, so among the matches the one returned is the one whose parent is not itself a match. `bin/Start-Persona.ps1` calls it before each launch with the machine's process list. On a match it logs `ADOPT pid=<pid>`, waits on that process through a handle opened before the wait, and hands the exit code and uptime to `Get-KeeperDecision` exactly as for a supervisor it launched. Uptime for an adopted supervisor is measured from the process's own start time, read off the process record before the wait, so an orphan that ran for hours is not judged a fast crash. `Get-KeeperDecision` does not change. A match that has exited by the time the handle is opened counts as no match, and the keeper launches. An adopted exit whose code cannot be read ends the keeper through `Stop-KeeperWithError`, as the loop already does for a launched supervisor that reports none, and the scheduler restarts the keeper. An adopted exit that the policy holds writes the hold reason alone, since an adopted run has no captured last error line.

**The contract sweep.** One scout sweep ran over this repository for four contracts: the restart request fact, the stop phases, the keeper launch, and the coordinator-only tool gate with the fleet roster. Its result is under `## Sweep`.

## Sweep

Searches run: `restart_requested`, `shutdown_requested`, `supervisor_restart|supervisor_shutdown`, `stop_child`, `SUPERVISOR_STOP_GRACE_MS|supervisorStopGraceMs`, `stdout\.jsonl`, `"result"|result line|open turn`, `wc -c|stat -c|filesize` in `bin/supervise.sh`, `Invoke-Supervisor|Get-KeeperDecision|MultipleInstances`, `GATE TIMEOUT|wait_persona_free_both|refuse_if_persona_live`, `Stop-ScheduledTask|process tree`, `agentic_say|fleet_status|readFleetRows|coordinatorPersona`, `RosterEntry|rundir`, `mayReachPersona`, `isOwner`, `Owner only|owner alone`, and the headings of `docs/backlog.md` and of the supervisor-peer plan.

Surfaces returned, cited by symbol because line numbers move.

- Restart request. `hooks/index.ts` (the `supervisor_restart` and `supervisor_shutdown` registrations and handlers, `sess.isOwner`), `.claude/types/claude-code-mcp.d.ts` (a generated mirror of the tool list), `bin/supervise-poll.mjs` (`readStoreFacts`), `bin/supervise-decide.mjs` (the `restart_passive` branch, unchanged), `bin/supervise.sh` (the natural-exit `RESTART_PASSIVE` read, the decide-path `restart_passive` case and its `restart_requested*` log branch). Tests: `.kit/supervisor-unit-test.mjs`, `.kit/supervisor-poll-unit-test.mjs`, `.kit/supervisor-natural-exit-test.sh`, `.kit/live-restartrequest-test.sh`. Docs: `README.md` (Quickstart, Poll Loop, Natural Exit, the tool reference).
- Stop phases. `bin/supervise.sh` (`stop_child`, its six callers, `SUPERVISOR_STOP_GRACE_MS` and its validation, `wait_for_result_line`). Nothing in `bin/supervise.sh` reads the size or the tail shape of `stdout.jsonl` today. `supervisorStopGraceMs` is not a plugin option and is absent from `bin/agentic-common.sh`. Tests: `.kit/supervisor-fn-extract.sh`, `.kit/live-stopprocesstree-test.sh`, `.kit/supervisor-model-test.sh`, `.kit/supervisor-natural-exit-test.sh`. Docs: `README.md` (Stop Phases, the settings table).
- Keeper launch. `bin/Start-Persona.ps1` (the relaunch loop, `Invoke-Supervisor`, the hold check), `bin/keeper-functions.ps1` (`Get-KeeperDecision`, `Build-SupervisorInvocation`, `Read-KeeperRoster`), `bin/Register-PersonaTasks.ps1` (`MultipleInstances IgnoreNew`, unchanged), the pre-launch gate in `bin/supervise.sh` and `wait_persona_free_both` in `bin/agentic-common.sh` (both unchanged). Tests: `.kit/keeper-unit-test.mjs`, `.kit/keeper-register-test.mjs`. Docs: `README.md` (Process keeper, Pre-Launch Gate), `docs/architecture.md`.
- Tool gate and roster. `hooks/index.ts` (`fleet_status` and its handler, `readFleetRows`, `rosterRunDir`, `RosterEntry`, the `coordinatorPersona` resolution), `hooks/operator.ts` (`deliveryGroundIn`, unchanged), `bin/fleet.example.json` and `.claude-plugin/plugin.json` (both unchanged, since no option is added). Tests: `.kit/fleet-status-unit-test.mjs`. Docs: `README.md` (`fleet_status`, Trust boundary).
- The coordinator's instruction. `COORDINATOR_ROLE_INSTRUCTION` in `bin/supervise.sh`, pinned by `.kit/channel-reply-instruction-test.sh`. The sweep did not cover it. The author found it by a direct search for `fleet_status`.

## Related

- `agent_persona_supervisor-peer_v1.md` runs after this plan by the operator's decision. Its Sections 2, 4 and 5 edit `bin/supervise.sh`, and Section 4 states that the stop phases are unchanged past its ask. After this plan that sentence is true of five labels and not of `restart_passive`. Its executor re-reads `stop_child` and `poll` as this plan leaves them. It places both keeper scripts out of scope, so Section 4 here does not meet it.
- `agent_persona_lean-injection_v1.md` rewrites every tool description and every instruction the supervisor writes, and adds a ledger of their sizes. Section 3 here adds one tool description and one instruction sentence. Whichever plan lands second carries the other's text through its own rules. Lean-injection has landed when its plan file sits under `docs/archive/` on `main`. Where it has, Section 3's worker reads that plan's rules for an injected string and its ledger's location from the archived plan, writes both strings to those rules, and records their sizes in the ledger.
- `agent_persona_deferred-gate-run_v1.md` holds the gate policy of 2026-09-18 for four named plans. This plan is not one of them and defers nothing, so that plan's list does not change.
- `docs/backlog.md`, "A reader session cannot write restart_requested when the owner is the stuck process". Section 5 retires it, since the coordinator's lever covers the wedged owner it describes.

## Sections of Work

### 1. The turn-state reader

Model: sonnet

This section feeds Section 2 and has no other consumer. Build `bin/supervise-turnstate.mjs` to the rule in the Approach, in the shape of `bin/supervise-poll.mjs`: a path and a clock value in as arguments, `busy` or `idle` printed as one word, no I/O beyond reading the file it is handed. It runs unconditionally at load and exports nothing, and `.kit/supervisor-turnstate-unit-test.mjs` drives it as a process, as `.kit/supervisor-poll-unit-test.mjs` drives the poll. It reads the file's tail and not the whole file, since a stream reaches megabytes.

Before writing the rule into code, re-measure it. The dev persona runs on the fleet machine, where every persona's run directory is readable. Read one `stdout.jsonl` from a persona other than the architect under `D:/personas/*/run/child-*/`, read only. Find the turn boundaries from the records' own `timestamp` fields and not from the rule under test. A turn end is the last conversational record before a gap of more than sixty seconds. A point inside a turn is a conversational record followed by another within ten seconds. Record in the Chapter the newest conversational record at three turn ends and at three points inside a turn. Where that stream contradicts the rule, stop and report to the coordinator persona through `agentic_say`, because Section 2 rests on it.

Acceptance criteria.

- Newest conversational record is a `user` record carrying `tool_result`: `busy`.
- Newest is an `assistant` record carrying `tool_use`, with file modification time twenty minutes old: `busy`. This is the long silent tool call.
- Newest is an `assistant` record with text only and a modification time ten seconds old: `busy`.
- The same record with a modification time forty seconds old: `idle`.
- `system` records other than a rate-limit record after the newest conversational record do not change the verdict.
- Newest record of any type is a `rate_limit_event`, behind a `user` record carrying `tool_result`, with a modification time five seconds old: `idle`. The same with a `system` record of subtype `api_retry` and `error_status` 429: `idle`.
- A file whose last line is a partial record behind a complete `tool_use` record: `busy`. An unparsable line is skipped, and the verdict rests on the newest parseable conversational record in the tail.
- A missing file, an empty file, and a tail holding no parseable conversational record: `idle`, with no throw.
- A file of ten megabytes returns in under one second.

Files in scope: `bin/supervise-turnstate.mjs`, `.kit/supervisor-turnstate-unit-test.mjs`.
Tests: lock both directions. A busy child read as idle is the defect this plan fixes. An idle child read as busy holds a persona eleven minutes, so the text-only case is pinned at both ages.

### 2. The patient stop

Model: opus

In `stop_child` in `bin/supervise.sh`, under the `restart_passive` label and no other, extend the EOF phase as the Approach states. Log once when the extended wait begins, `STOP[restart_passive]: the child is inside a turn, waiting for it to end`, and once when it ends, naming whether the child exited, the reader returned `idle`, or the cap was reached. The cap is `SUPERVISOR_STOP_BUSY_CAP_MS`, read from `supervisorStopBusyCapMs` beside `SUPERVISOR_STOP_GRACE_MS`, default 660000, under the same numeric check and the same 1000 minimum, with a comment deriving the default from the harness's tool-call cap. A reader call that fails or prints anything but the two words reads as `idle`.

Acceptance criteria.

- A `restart_passive` stop of a stub child whose stream ends in a `tool_use` record, and which exits on end of input after ninety seconds: no TERM line is logged, and `STOP_PATH` is `eof`.
- The same stub that never exits: TERM is sent at the cap and not before, and the existing phases follow.
- A `restart_passive` stop of a stub whose stream reads `idle`: TERM after the ordinary grace, as today.
- A `stop_complete` stop and a `restart` stop of the busy stub: TERM after the ordinary grace, as today.
- A busy stub whose stream gains a text-only record during the wait and then goes quiet, and which never exits: TERM is sent within one poll of the reader first returning `idle`, well before the cap.
- `supervisorStopBusyCapMs` set to `500` is refused at startup, as `supervisorStopGraceMs` is.
- The suites set `supervisorStopGraceMs` to 2000. The first case sets `supervisorStopBusyCapMs` above the stub's exit delay. The second case sets the cap to at least three times the grace, and the fifth sets it above the thirty second idle age, so a TERM at the ordinary grace reds both. The remaining cases set it near the minimum. No case waits eleven minutes.

Files in scope: `bin/supervise.sh`, `.kit/live-stopprocesstree-test.sh`, `.kit/supervisor-fn-extract.sh`, `.kit/supervisor-model-test.sh`.
Tests: the label guard is pinned in both directions, since a patient hung restart would hold a frozen persona eleven minutes longer. `.kit/live-stopprocesstree-test.sh` holds the box, so it runs alone.

### 3. The restart request

Model: opus

Register `fleet_restart` in `hooks/index.ts` with arguments `persona` and `reason`, and serve it as the Approach states. It registers inside the `arming !== "reader"` block, not beside `fleet_status`, which registers under every arming tier. A reader seat never sees it, so the reader tool list that `.claude-plugin/plugin.json` describes and `.kit/controller-tick-test.mjs` pins stays as it is. The reason is trimmed and cut at 200 characters. `by` is the calling session's persona. The result text names the persona and says that its supervisor restarts the child at its next poll and lets a running turn end first. `.claude/types/claude-code-mcp.d.ts` is a generated mirror of the tool list, written by the `/plugin-types` command of an interactive session. Where the worker's session can run that command, it regenerates the file. Where it cannot, it leaves the file untouched, never edits it by hand, and names the stale mirror in the Chapter and in `docs/backlog.md`.

The parser lives in a new module, `bin/supervise-restart-request.mjs`, which exports `readRestartRequest(runDir, now)` and runs nothing at load. It returns the file's `at` or null. A file that is missing, unparsable, without a numeric `at`, or future-dated past one minute returns null. `bin/supervise-poll.mjs` imports it. That file runs `poll` at load by design and is never imported, so the parser cannot live there. `readStoreFacts` keeps its signature. `poll` takes the run directory as one more argument and sets `restartRequestedTs` to the later of the store's value and that reading before it calls the decide unit. The decide reason still opens with `restart_requested`, which `bin/supervise.sh` and `.kit/supervisor-poll-unit-test.mjs` both match on. In `bin/supervise.sh`, the poll call passes the run directory. The natural-exit path reads its store fact through `get_fact`, an inline snippet. It takes the file through a `node` snippet that imports the new module and prints the one value, and it uses the later of the two.

Add one sentence to `COORDINATOR_ROLE_INSTRUCTION` in `bin/supervise.sh`: `fleet_restart` restarts another persona's child, it is for a persona the fleet reading shows stuck or one the operator names, and every use is reported to the operator.

This section touches an authorization gate, so its review round includes the security-reviewer.

Acceptance criteria.

- A caller on the coordinator ground, a roster with an enabled target and an existing run directory: the file exists with a numeric `at`, the caller's persona in `by`, and the trimmed reason. No store file changed, checked by modification time.
- A caller holding a reader claim on the coordinator persona, a caller owning a worker persona, and a caller with no claim: each denied, and no file is written.
- A target absent from the roster, a target with `enabled` false, the caller's own persona, a missing run directory, and no `fleetRoster` setting: each denied with a message naming the reason.
- A second call for one target inside fifteen minutes: denied, and the first file is unchanged. A call after fifteen minutes on the injected clock: written.
- `poll` with no store fact and a file newer than the child start: the decide unit returns `restart_passive` with a reason opening `restart_requested`. With a file older than the child start: `continue`.
- A file with `at` ten minutes ahead of the clock: ignored. A file that is not JSON: ignored, with no throw.
- The coordinator instruction carries the new sentence, and `.kit/channel-reply-instruction-test.sh` pins it.

Files in scope: `hooks/index.ts`, `.claude/types/claude-code-mcp.d.ts`, `bin/supervise-restart-request.mjs`, `bin/supervise-poll.mjs`, `bin/supervise.sh`, `.kit/fleet-status-unit-test.mjs`, `.kit/supervisor-poll-unit-test.mjs`, `.kit/channel-reply-instruction-test.sh`, `.kit/supervisor-natural-exit-test.sh`, `.kit/controller-tick-test.mjs` (the owner tier's tool count pin moves from fourteen to fifteen, and the reader list pin stays).
Tests: every refusal is pinned, because the tool's own rule is the only fence between a worker and a restart of the coordinator. The future-dated case is pinned because its failure is a restart loop. `.kit/supervisor-natural-exit-test.sh` takes over half an hour and holds the box, so it runs alone.

### 4. The keeper adopts a live supervisor

Model: opus

Add the matching function to `bin/keeper-functions.ps1` and call it from the relaunch loop in `bin/Start-Persona.ps1` before each launch, as the Approach states. The function takes its process list as a parameter, so the unit suite hands it records and no test scans the machine. An adopted run is written to `keeper.json` and `keeper.log` as a launched one is, with `ADOPT` in place of `LAUNCH`, and it does not advance `launchCount`.

Acceptance criteria.

- A process list holding an outer and an inner `bash.exe` for persona `dev-plugin`, asked for `dev-plugin`: the outer process is returned.
- The same list asked for `dev`: nothing is returned.
- A list holding a supervisor for the same persona name under a different working directory: nothing is returned.
- A list holding a supervisor for this persona with a different channel name and an extra trailing argument: it is returned.
- An empty list: nothing is returned, and the wrapper launches as today.
- The wrapper, given a live stub supervisor for its persona: logs `ADOPT`, launches nothing, and on the stub's exit with code 1 logs the `DECIDE` line `Get-KeeperDecision` produces for exit 1.
- The wrapper's existing cases pass unchanged.

Files in scope: `bin/keeper-functions.ps1`, `bin/Start-Persona.ps1`, `.kit/keeper-unit-test.mjs`.
Tests: the prefix case is pinned because three personas on the live roster share the prefix `dev`. An adoption of the wrong persona's supervisor leaves this persona with no keeper and no log line saying so.

### 5. Documentation and the backlog

Model: sonnet

Bring the solution docs into line, in the present tense, with no account of the incident.

- `README.md`, the tool reference: a `fleet_restart` block beside `fleet_status`, with its arguments, its refusals and the fifteen minute rule.
- `README.md`, Trust boundary: `fleet_restart` admits the coordinator ground alone, and the request file sits in the run directory the launcher owns.
- `README.md`, Poll Loop and Natural Exit: `restart_requested` is read from the store and from `<rundir>/restart.request`.
- `README.md`, Stop Phases: the extended wait under `restart_passive`, its cap, and that the other five labels keep the ordinary grace.
- `README.md`, the settings table: a `supervisorStopBusyCapMs` row beside `supervisorStopGraceMs`, with its default and its minimum.
- `README.md`, Process keeper, and `docs/architecture.md` where it describes the keeper's launch: the look for a live supervisor, and `ADOPT`.
- `docs/architecture.md`, the layer table: `<rundir>/restart.request` joins the supervisor's reads and the coordinator plugin's writes, since the supervisor now reads one file the child did not write.
- `docs/backlog.md`: retire the reader-cannot-restart entry with a line naming this plan.
- `docs/README.md`: this plan's index line moves as the curating-docs skill directs at close.

Section 5 also restates every sentence in these four files that lists the keeper's functions, the `keeper.log` line families, the offline suites, or what the plugin writes. Known sites: `docs/architecture.md`'s claim that the fleet reading only reads, its closed list of `bin/keeper-functions.ps1` functions and its `keeper.log` line families, and `README.md`'s keeper-functions row and its Supervisor Test Coverage list, which gains `.kit/supervisor-turnstate-unit-test.mjs`.

Acceptance criteria: each site above states the behavior as built, a read of every hit for `keeper.log`, `keeper-functions`, `only reads` and `unit-test.mjs` in the two files finds no sentence the plan made false, and no sentence in `README.md` says that only a persona's owner can request its restart without naming the coordinator's lever beside it.

Files in scope: `README.md`, `docs/architecture.md`, `docs/backlog.md`, `docs/README.md`.

## Gate

- The gate policy of 2026-09-18 in `agent_persona_deferred-gate-run_v1.md` names four plans and this is not one of them, so this plan runs its own suites and defers nothing. The two slow suites it touches hold the box, so each runs alone, one at a time, and never beside a build or another suite.
- Baseline: before touching anything, the worker runs every `.kit/*-unit-test.mjs` suite, `.kit/supervisor-model-test.sh`, `.kit/live-stopprocesstree-test.sh` and `.kit/supervisor-natural-exit-test.sh` on a clean tree at the base commit and records each one's pass and fail counts, exit code and wall clock. Every later run is reported as a delta against that.
- Sections 1, 3 and 4 each close on their own unit suites green, with the red-then-green record for the new cases in the Chapter. Section 2 closes on `.kit/supervisor-model-test.sh` and `.kit/live-stopprocesstree-test.sh` green. Section 3 also closes on `.kit/supervisor-natural-exit-test.sh` green, since its natural-exit case lives there.
- Section 3 edits `hooks/`, so `.kit/check-loader-rule.mjs` runs at its close.
- The fresh-context reviewer pair runs over each code section's delta, and the security-reviewer over Section 3's.
- Before the pull request is marked ready, every `.kit/*-unit-test.mjs` suite, `.kit/check-loader-rule.mjs`, `.kit/supervisor-model-test.sh`, `.kit/live-stopprocesstree-test.sh` and `.kit/supervisor-natural-exit-test.sh` run green, each read from its own exit code.

## Out of Scope

- The liveness verdict, the mailbox, the holder and child adoption. They are the supervisor-peer plan's.
- A patient wait under `cleanup`, `stop_complete`, `stop_crash_loop`, `stop_budget` or `restart`.
- `supervisor_restart` and `supervisor_shutdown`, which keep their owner-only rule.
- A restart lever for any persona but the coordinator, and a shutdown lever across personas.
- `Get-KeeperDecision`, the exit code table, `MultipleInstances`, the pre-launch gate and `wait_persona_free_both`.
- What `Stop-ScheduledTask` ends under the keeper's task, which `README.md` records as unmeasured.
- Cleaning up the architect's orphaned supervisor of 2026-09-20. It is machine state.

## Assumptions

- assumed 2026-09-20 (source: every plan header in `docs/plans/`): the commit model is Branch-and-PR; reversal: a header edit before the run starts.
- assumed 2026-09-20 (source: the sibling plans' Dispatch Authorization sections): the dev persona executes; reversal: a header edit.
- assumed 2026-09-20 (default): the plan is born `Ready`, since no worker starts it at the write; reversal: the run sets `In Progress`.
- assumed 2026-09-20 (source: the repository memory record `claude-child-stdin-via-coproc-eof-is-the-graceful-stop`): a child whose input closes mid-turn exits when the turn ends; reversal: Section 2's first acceptance case fails, and the section stops for a redesign.
- assumed 2026-09-20 (default): thirty seconds of quiet after a text-only record reads as idle; reversal: one constant in `bin/supervise-turnstate.mjs`, and Section 1's re-measure is where a wrong value shows.
- assumed 2026-09-20 (default): the keeper's match compares the forms `Build-SupervisorInvocation` emits, and a supervisor started under another path spelling is not matched; reversal: a normalising compare in Section 4.
- assumed 2026-09-20 (source: the operator's second decision under `## Intent`, which accepted the fifteen minute limit as part of the option put to them): the interval is a constant, not an option, as is the 200 character reason bound; reversal: a plugin option, which the lean-injection ledger would then also carry.
- excluded 2026-09-20 (default): a supervisor launched by hand with arguments in another order is not matched by the keeper; reversal: a wider match rule in Section 4.

## Operator Verification

The running supervisors and keepers keep the scripts they started with, so none of this takes effect until the runtime clone is pulled and each persona's keeper and supervisor are relaunched at a quiet point.

- With the fleet on the new code, ask the steward to restart a worker that is in the middle of a turn. That worker's `supervisor.log` shows the waiting line and no TERM line, and the worker comes back on its own. A TERM line reopens Section 2.
- End one persona's keeper process by its process ID and leave its supervisor running, then start that persona's scheduled task. Its `keeper.log` shows `ADOPT` and no `GATE TIMEOUT` follows. A `LAUNCH` line beside a live supervisor reopens Section 4.

## Open Questions

None.

## Chapters
