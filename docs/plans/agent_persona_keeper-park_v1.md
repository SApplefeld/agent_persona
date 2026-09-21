# Keeper park

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-21

## Goal

When this is done, a persona can park for an update window and come back on its own at the process keeper's next start. The shutdown tool takes a park option. A parked supervisor exits on a code of its own, 6, where a stopped one still exits 0. The keeper writes a park marker for exit 6 and a hold marker for exit 0, and its next start clears a park marker and launches while a hold marker still stops it until someone releases it by hand. The fleet reading reports a parked persona as held, with a reason that says it comes back at the next start. It matters because on 2026-09-21 the two personas that parked promptly for the update window were the two the restart skipped, and the three that were killed mid-run came back, so the fleet punished the personas that obeyed.

## Dispatch Authorization

The Expert seat wrote a findings brief on this at the operator's keyboard request on 2026-09-21 (`D:/personas/.kit/findings-2026-09-21-keeper-hold-after-drain.md`, outside this repository). The architect checked it against the keeper log and the code, sent the operator a three-part sketch on the architect persona's Discord thread, and the operator answered:

> On the Park, yes, I like having that as a verb, I think that works well. Please write that spec as you've recommended.

That covers authoring. Execution waits on the operator handing this plan to a worker by name.

This plan starts only after two other plans have merged to the trunk, because they edit the same regions and the same pins. `docs/plans/agent_persona_supervisor-gaps_v1.md` edits the stop paths in `bin/supervise.sh`, the launch path in `bin/Start-Persona.ps1`, `bin/keeper-functions.ps1`, and registers a fifteenth tool, which moves the tool-count pin this plan leaves alone. `docs/plans/agent_persona_goal-tree-curation_v1.md` edits tool descriptions and refreshes the injection ledger this plan refreshes again. The trunk is `origin/main`, read after a fetch. The check is that `git ls-tree --name-only origin/main docs/plans/` lists neither file, since a finished plan moves to `docs/archive/`. A worker that finds either still listed stops with a `BLOCKED:` lead naming it. The work runs on one branch cut from that fetched trunk and lands as one pull request for the whole plan.

## Intent

The operator's frame is one sentence: parking gets its own verb. Today a persona has exactly one way to go down on request, the shutdown tool, and that tool means stop for good. The keeper reads the resulting exit 0 as a permanent stop and holds the persona until a hand release. So an update window that asks the fleet to park strands every persona that complies.

Done means four things, which are the four questions the Expert's brief said a plan must settle. The keeper can tell a park from a stop, because the party that knows which it is, the persona at the moment it calls the tool, writes a different fact, and the supervisor carries that fact out as a different exit code. A park clears itself at the keeper's next start, so the window closes with the fleet it opened with. A stop still needs a hand release, so a persona the operator stopped on purpose never comes back by itself. And a parked persona is not silent: the fleet reading reports it held, with a reason that names the park.

Done does not need any of the following, and the plan refuses them. It does not need a park to expire on a timer. It does not need a new fleet action or health class. It does not need the persona charters or the steward's instructions to change, because the tool's own description is where a persona learns when to park. It does not need a live end-to-end run in the test suite. It does not need the manual launchers under the personas folder to relaunch anything.

Alternatives refused:
- A park that expires on its own after some hours, so a keeper nobody restarts still brings the persona back: refused, because the keeper's start is the signal that the window closed, and a timer would bring a persona back into a window still open. The operator's go covers this recommendation.
- Carrying the park inside the existing `shutdown_requested` fact as a prefix on its detail text: refused, because every reader would then match on a string, and the supervisor already carries one such coupling (`backfilled`) that the goal tree plan is paying for.
- A separate `supervisor_park` tool: refused, because a tool costs a registration, a description under the budget, a generated type, and the tool-count pin, where one optional parameter on the shutdown tool costs a sentence.
- A `parked` value in the fleet row's action and a sixth health class: refused, because the classes are read on three surfaces and the reason line already says park.
- One hold marker whose first line names its kind, read back by the wrapper: refused, because the wrapper would then decide whether to launch by parsing text it wrote, where a second file decides it by existence.

Rulings after the spec shipped: none yet.

Provenance: distilled from the architect persona's sessions of 2026-09-21 on its Discord thread, from the Expert seat's brief, from the architect's own `run/keeper.log`, and from the code at trunk `3054302`.

## Approach

**Line numbers and anchors.** Every line number in this plan is at trunk `3054302` and will have moved by the time the plan runs, because two plans merge first. Each block is found by its text, never by its number. The anchors are: `name: "supervisor_shutdown"` and `// Serve supervisor_shutdown` in `hooks/index.ts` for Section 1; `export function readStoreFacts` in `bin/supervise-poll.mjs`, `// 3. An explicit shutdown request newer than child start` in `bin/supervise-decide.mjs`, and `stop_complete)` and `# The shutdown the operator asked for is read before anything else this path` in `bin/supervise.sh` for Section 2; `function Get-KeeperDecision` in `bin/keeper-functions.ps1` and `$holdPath = Join-Path $runDir 'keeper.hold'` in `bin/Start-Persona.ps1` for Section 3; `const readKeeperHalf` and `name: "fleet_status"` in `hooks/index.ts` for Section 4. A worker that cannot find an anchor, or finds the block under it restructured so that a section's text no longer fits, stops with a `BLOCKED:` lead naming the anchor and what it found.

**The park is a fact of its own.** The shutdown tool gains one optional boolean parameter, `park`. With `park: true` the handler writes a decision with action `park_requested` and the reason as its detail, in the place and shape the handler writes `shutdown_requested` today (`hooks/index.ts:6259-6280`). Without it the handler is unchanged. The owner-only refusal stays as it is for both.

**The supervisor carries the fact out as exit 6.** The set of supervisor exit codes is closed at 0, 1, 2, 3, 4, 5, 6, 130 and 143, where 6 means a `park_requested` honored: the persona parked and the keeper's next start launches it again. The poll reads `park_requested` beside `shutdown_requested` (`bin/supervise-poll.mjs:78-99`). The decide unit gains one action, `stop_park`, ranked directly below `stop_complete` and above the two `restart_passive` rows (`bin/supervise-decide.mjs:100-110`), so a shutdown and a park both newer than the child's start end in a stop, and a park outranks a restart request. In `bin/supervise.sh` the decide case `stop_park)` mirrors `stop_complete)` (`3021-3039`) line for line and exits 6 where that case exits 0, keeping the exit 5 on a survivor. On the natural exit path, the block that reads `shutdown_requested` (`3182-3206`) is followed by one that reads `park_requested` the same way and sweeps the same way. The two blocks differ in one thing. The shutdown block exits 0 whatever its sweep found, because a stop must stay down. The park block exits 5 where its sweep leaves a survivor or an unreadable tree, and 6 otherwise. So a park that leaves a survivor exits 5 on both paths and relaunches after the keeper's delay, which is the park's intent anyway; the relaunched supervisor then meets the orphan at the pre-launch gate as any exit-5 relaunch does today. That is deliberate and unchanged.

**The keeper parks on exit 6.** The set of keeper actions is closed at `hold`, `park`, `relaunch` and `exit`. Three things sit outside it. `-Release` is a switch on the wrapper's command line, not an action the decision returns. A park is never a `relaunch` on a timer, since the next launch waits for a keeper start and not for a delay. And a hold is never cleared by a start, since only a park is. `Get-KeeperDecision` (`bin/keeper-functions.ps1:55-114`) gains a row: exit 6 returns `park`, a delay of 0, the ladder unchanged, the exit-1 count reset, and the reason `supervisor exited 6: parked, relaunched at the keeper's next start`. The wrapper (`bin/Start-Persona.ps1:496-542`) handles `park` beside `hold`: it writes `<rundir>/keeper.park` with the reason as its only line, writes `keeper.json` with `holdReason` set to that reason so the fleet reading's fallback reads it, and exits 0 as a hold does. At start (`414-441`) the wrapper checks `keeper.hold` first and behaves as today. Where no hold marker exists and `keeper.park` does, it removes the park marker, logs `UNPARK <path>`, and goes on to launch. A park marker that cannot be removed is logged as `ERROR park marker '<path>' could not be removed: <message>` and the start launches anyway, because a park marker never stops a launch and the next park or hold overwrites or outranks it. Where both exist the hold wins, the park marker is left in place, and the start logs `HOLD` and exits without launching. `-Release` removes both markers, logging one `RELEASE` line per file it removed, and `RELEASE none` where it removed neither.

**The fleet reading reports a park as held.** `readKeeperHalf` (`hooks/index.ts:890-1039`) checks `keeper.park` beside `keeper.hold`, with the same three-state reading the hold check takes: the marker is present, it is absent, or the check itself threw, in which case the failure lands in the row's note and the standing reads `unknown`. Either marker present makes the standing `held`. Where `keeper.hold` exists the reason and its source are read as today, a blank first line falling back to `keeper.json`'s `holdReason`, and `keeper.park` is not read for a reason. Where only `keeper.park` exists, its first line is the reason and its path the source, with the same fallback. The `fleet_status` description's `held` sentence (`2370-2371`) changes from "a marker stops its next start" to say that a marker in its run directory decides its next start, a hold marker stopping it and a park marker being cleared so the persona launches, and that `holdReason` says which. The action vocabulary and the five health classes (`hooks/agent-state.ts:168-174`) do not change.

**The description budget.** Two descriptions grow, `supervisor_shutdown` (354 characters in `.kit/injection-ledger.json:191-196`) and `fleet_status` (3,795). `supervisor_shutdown` stays under 600 and `fleet_status` under 3,950, both read with `node .kit/injection-ledger.mjs`. `.kit/injection-duplicate-test.mjs` fails on any growth past the committed baseline, so Sections 1 and 4 each refresh it with `node .kit/injection-ledger.mjs > .kit/injection-ledger.json` and update the totals `docs/architecture.md:139-150` states. `.kit/tool-description-length-test.mjs`, already at trunk with a cap of 4,000 characters per description, must stay green.

**The generated types file.** `.claude/types/claude-code-mcp.d.ts` says at its head that it is written by the `/plugin-types` command and regenerated rather than edited. That command runs only at the keyboard of an interactive Claude Code session, which a dispatched worker does not have. Its `supervisor_shutdown` entry (`48-52`) already carries an older description than the source. Section 1 edits that entry by hand to carry the new parameter and the new description, in the shape the neighbouring entries use, and the Chapter says so. The next `/plugin-types` run in an interactive session rewrites the file from the source and leaves the entry as the hand edit made it.

**Other plans' scope lines.** `docs/plans/agent_persona_supervisor-gaps_v1.md:201` and `docs/plans/agent_persona_supervisor-peer_v1.md:122` list the exit-code table under their own Out of Scope, and `docs/backlog.md:61-63` records that the gaps plan cannot change it. Those lines bind those plans and stay as written. This plan is the one that changes the table, by one row. The backlog entry's fork, whether a stopped persona that leaves a survivor stays down or comes back, is about a stop and is not settled here.

**Gates.** Before touching anything, the worker runs every `.kit/*-unit-test.mjs` suite, `.kit/controller-tick-test.mjs`, `.kit/tool-description-length-test.mjs`, `.kit/check-loader-rule.mjs`, `.kit/injection-duplicate-test.mjs`, `.kit/supervisor-model-test.sh` and `.kit/supervisor-natural-exit-test.sh` on a clean tree at the base commit and records each result, with its exit code, in the first Chapter as the baseline. That Chapter also records the tool count the pin at `.kit/controller-tick-test.mjs` asserts at that commit, since the supervisor gaps plan moves it from fourteen to fifteen before this plan runs. Each section closes on the suites its acceptance names green, with the red-then-green record for its new cases in the Chapter. Before the pull request is marked ready, the whole set above runs green again, each read from its own exit code. The two suites that hold the box, `.kit/supervisor-model-test.sh` and `.kit/supervisor-natural-exit-test.sh`, each run alone under the machine's heavy-process claim. That claim is the claude-kit plugin's machine-wide record, under `~/.claude/coordinator/`, that one session is running a build or a suite that holds the box; the kit's role skill (`skills/role/SKILL.md` under the kit plugin root) owns how it is taken, held and released, and the worker takes it before either suite starts and releases it when the suite exits.

**Coverage sweep.** One Explore sweep ran on 2026-09-21 over the checkout at `3054302`, with its report at `D:/personas/architect/.kit/keeper-park-sweep-2026-09-21.md`, outside this repository. Every site it found is listed below, so the plan stands without the report. Searches run: every `exit N` in `bin/supervise.sh` and every reader of the exit table; `shutdown_requested` and `stop_complete` as writer and readers; `keeper.hold`, `-Release`, `holdReason`, `holdReasonSource`, `HOLD`, `RELEASE`, `held`; the `supervisor_shutdown` registration and every pin on tool descriptions or tool count; and every prose surface that tells a persona or the operator how to stop, restart or park one. Surfaces found, each placed in a section below or under Out of Scope:
- Exit table: `bin/supervise.sh:23-29`, the `exit 0` sites at 3039 and 3206 (the only two, confirmed), `bin/keeper-functions.ps1:55-114`, `bin/Start-Persona.ps1:497-542`, `hooks/index.ts:1019` (signalled codes), `README.md:325-336` and `378-388`, `docs/architecture.md:53-84`, `176-188` and `199-214`, `docs/backlog.md:63`, the two plans' Out of Scope lines, `.kit/keeper-unit-test.mjs:195-211` and `412-596`, `.kit/supervisor-natural-exit-test.sh` (the `-eq 0` assertions at 1478-1824 and the stub's `record shutdown_requested ""; exit 0` at 1325 and siblings), `.kit/supervisor-model-test.sh:42-96`, the fixtures `.kit/fixtures/fleet-status.keeper-*.json`.
- The shutdown fact: writer `hooks/index.ts:6259-6280`; readers `bin/supervise.sh:2244` (`get_fact`) called at 3188 and 3234, the case at 3021-3039, the natural-exit block at 3182-3206; `bin/supervise-poll.mjs:78-99`; `bin/supervise-decide.mjs:29-45` and 100-110; `README.md:293-309`; `.claude/types/claude-code-mcp.d.ts:48-52`; tests `.kit/supervisor-unit-test.mjs:23-59` and `102-120`, `.kit/supervisor-poll-unit-test.mjs:83-92` and `133-138`, `.kit/supervisor-natural-exit-test.sh` case (u) at 1784-1824. `.kit/controller-tick-test.mjs` holds no case for the shutdown handler.
- The hold marker: `bin/Start-Persona.ps1:4-19`, `414-441`, `496-542`; `bin/keeper-functions.ps1:178` (a comment); `hooks/index.ts:822-872`, `890-1039`, `1134-1146`, `2362-2401`; `hooks/agent-state.ts:159-212`; `.kit/fleet-status-unit-test.mjs` with its fixtures `.kit/fixtures/fleet-status.hold-beta.txt`, `fleet-status.hold-signalled.txt`, `fleet-status.keeper-*.json`, `fleet-status.roster.json`, `fleet-status.roster-actions.json`; `.kit/keeper-unit-test.mjs:133` and `496-536`; `README.md:392`, `410-420`; `docs/architecture.md:66-84`, `103-133`, `203-213`. Nothing but `bin/Start-Persona.ps1` writes or removes the marker, and only `readKeeperHalf` reads it.
- Descriptions and pins: `hooks/index.ts:2212-2246`; `.kit/injection-ledger.json:191-202`; `.kit/injection-ledger.mjs`; `.kit/injection-duplicate-test.mjs`; `docs/architecture.md:139-150`; `.kit/controller-tick-test.mjs:12625` (the tool-count pin, which this plan does not move); `.claude-plugin/plugin.json` (no mention).
- Prose on stopping and restarting: `README.md:38-40` (Quickstart, "Stop it." and "Restart it without stopping it."), `README.md:414-418`, the two tool descriptions. The supervisor's priming text names none of it. The persona charters and the steward's instructions name none of it.

## Sections of Work

### 1. The shutdown tool takes a park option
Model: opus

In `hooks/index.ts`, the `supervisor_shutdown` registration gains an optional boolean property `park` whose schema description says that `park: true` parks the persona for a restart, with the supervisor exiting on the park code and the keeper's next start launching it again, and that a call without it stops for good. The tool description's sentence "Call it only on the operator's explicit ask to stop for good." is replaced, not kept beside the new text, by one sentence saying that `park: true` parks for an update window and the keeper's next start brings the persona back, and that a call without it stops for good and is made only on the operator's explicit ask. The handler under `// Serve supervisor_shutdown` reads the flag, writes `park_requested` with the reason as detail where it is true and `shutdown_requested` otherwise, and returns a result line that names which. The stop line is unchanged. The park line is `Park requested: <reason>. The supervisor will stop after this turn ends, and the keeper's next start launches this persona again.` The default reason for a park is `operator requested park`.

`.kit/controller-tick-test.mjs` gains cases driving the tool through the harness, beside the goal-tool cases, for the four outcomes below. `.kit/injection-ledger.json` is refreshed and `docs/architecture.md:139-150` updated. `.claude/types/claude-code-mcp.d.ts` is hand-edited as the Approach states.

Acceptance:
- A harness call with `park: true` and a reason leaves exactly one new decision, action `park_requested`, detail the reason, and no `shutdown_requested`.
- A harness call with no `park` leaves exactly one new `shutdown_requested` with the reason as detail and no `park_requested`, which is the control.
- A call with `park: true` from a session that does not own the persona is refused with the same deny text as today and writes nothing.
- The `supervisor_shutdown` description is under 600 characters in `node .kit/injection-ledger.mjs`, `.kit/injection-duplicate-test.mjs` passes on the refreshed ledger, and the tool-count pin in `.kit/controller-tick-test.mjs` still asserts the count the baseline Chapter recorded at the base commit.

Files in scope: `hooks/index.ts` (the registration at 2212-2228 and the handler at 6259-6280), `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.json`, `docs/architecture.md` (139-150), `.claude/types/claude-code-mcp.d.ts`.
Tests: at minimum, lock both branches of the flag and the owner-only refusal on the park branch, since a park recorded as a stop is exactly the strand this plan exists to end.

### 2. The supervisor honors a park with exit 6
Model: opus

`bin/supervise-poll.mjs` `readStoreFacts` gains `parkRequestedTs`, read the way `shutdownRequestedTs` is, and hands it to the decide unit. `bin/supervise-decide.mjs` gains the action `stop_park` between the shutdown check and the restart-request check, taken when `parkRequestedTs` is newer than the child's start, with the priority list in its header comment updated. In `bin/supervise.sh` the header table gains the row for 6 directly after the row for 5, and the two signal codes stay where they are today, in the traps at 575-576 and out of the table. The decide case `stop_park)` mirrors `stop_complete)` and exits 6 in place of 0, logging `STOP_PARK: <reason>`, and the natural-exit path gains, directly after the shutdown block, a block reading `park_requested` through `get_fact` that logs `STOP_PARK: park_requested at <ts> > child start <ts>`, sweeps under the label `park`, exits 5 where the sweep's result after the retry is 1, and exits 6 otherwise. `README.md` Poll Loop gains the `stop_park` row, Natural Exit names the park, and the Exit Codes And Logs table gains the row for 6.

Acceptance:
- `.kit/supervisor-unit-test.mjs`: a `park_requested` newer than the child start with no other signal returns `stop_park`; `shutdown_requested` and `park_requested` both newer return `stop_complete`; `park_requested` and `restart_requested` both newer return `stop_park`; a `park_requested` older than the child start returns `continue`.
- `.kit/supervisor-poll-unit-test.mjs`: a store with `park_requested` newer than the start yields `stop_park`; one older yields `continue`; a malformed entry beside it costs no other fact.
- `.kit/supervisor-natural-exit-test.sh`: one case whose stub records `park_requested` and exits on its own asserts the supervisor exits 6 and the log carries `STOP_PARK`; one case whose stub records `park_requested` and stays alive asserts the decide path stops it and the supervisor exits 6; one case whose stub records `park_requested`, leaves a survivor the way the kill-injection cases beside (u) do, and exits on its own asserts the supervisor exits 5; case (u) still exits 0. The suite drives the real `bin/supervise.sh` and holds the box for over half an hour, so it runs alone under the machine's heavy-process claim and never beside a build or another suite.

Files in scope: `bin/supervise-poll.mjs` (78-99), `bin/supervise-decide.mjs` (29-45, 100-110), `bin/supervise.sh` (23-29, 3021-3039, 3182-3206), `README.md` (293-309, 325-336), `.kit/supervisor-unit-test.mjs`, `.kit/supervisor-poll-unit-test.mjs`, `.kit/supervisor-natural-exit-test.sh`.
Tests: at minimum, lock that a shutdown outranks a park and a park outranks a restart, and lock both exit paths, since a park that reaches the keeper as exit 0 on either path reproduces the strand.

### 3. The keeper parks on exit 6 and clears the park at its next start
Model: opus

`bin/keeper-functions.ps1` `Get-KeeperDecision` gains the row for 6 as the Approach states, and its header comment names the fourth action. `bin/Start-Persona.ps1` gains `$parkPath`, the `park` branch beside `hold` in the decision switch, the start-time clear under the hold check, and the two-file `-Release`. The wrapper's own header comment names `keeper.park` and `UNPARK`. `README.md` Process keeper: the exit-code policy paragraph gains exit 6, the holding paragraph gains the park marker and what the next start does with it, the stopping and starting paragraph gains how a persona parks and that a parked persona needs no release, and the state paragraph lists `keeper.park`. `docs/architecture.md`: the decision function's table gains the row, the run loop names the park branch, the logs and state list gains `keeper.park` and the `UNPARK` line family, the wrapper's exit codes paragraph names a park, and the failure modes table's `HOLD` row says a park marker never produces it.

Acceptance, all in `.kit/keeper-unit-test.mjs`:
- Decision rows: exit 6 returns `park` with a delay of 0, the ladder unchanged and the exit-1 count 0, and its reason is one line; exit 0 still returns `hold`, which is the control; the guard at `.kit/keeper-unit-test.mjs:242` that asserts a `hold` carries no delay widens to `hold` or `park`, so a park row reaches it.
- Wrapper cycle: a stub supervisor exiting 6 leaves `keeper.park` whose only line is the reason, `keeper.json` with `holdReason` equal to it and `lastExitCode` 6, no `keeper.hold`, and the wrapper exits 0 with a `DECIDE ... action=park` line.
- The next start of the wrapper over that directory logs `UNPARK <path>`, removes `keeper.park`, and launches the stub.
- A directory holding both markers: the start logs `HOLD`, launches nothing, exits 0, and leaves both files.
- `-Release` over both markers removes both, logs two `RELEASE <path>` lines, and exits 0; over neither it logs `RELEASE none`.

Files in scope: `bin/keeper-functions.ps1` (27-114, and the comment at 178), `bin/Start-Persona.ps1` (1-19, 414-441, 496-542), `.kit/keeper-unit-test.mjs` (195-211, 412-596), `README.md` (378-422), `docs/architecture.md` (53-84, 176-188 read and amended only where its wording no longer holds, 199-214).
Tests: at minimum, lock that a park clears at the next start and a hold does not, in both directions, and that a hold outranks a park, since a park marker that a start honors as a hold is the strand and a hold marker a start clears is a persona the operator stopped coming back on its own.

### 4. The fleet reading reports a parked persona
Model: sonnet

In `hooks/index.ts` `readKeeperHalf`, beside the `keeper.hold` check, check `keeper.park` with the same three-state guard. Either marker present makes `hold` read `yes`. The reason and its source are read from `keeper.hold` where it exists, with today's fallback to `keeper.json`, and from `keeper.park` only where no `keeper.hold` exists, through the same first-line read, the same fallback and the same bounds. The `FleetRow` comment at 822-872 that says a `held` marker stops the next start is reworded to say a marker decides the next start. The `fleet_status` description's `held` sentence is reworded as the Approach states. `.kit/injection-ledger.json` is refreshed and `docs/architecture.md:139-150` updated. `.kit/fleet-status-unit-test.mjs` gains two fixtures, `.kit/fixtures/fleet-status.park-zeta.txt` carrying the park reason and `.kit/fixtures/fleet-status.keeper-zeta.json` carrying a `keeper.json` with `lastExitCode` 6 and `holdReason` equal to that reason, and a roster persona `zeta` built inline in the new cases the way the cases at 294, 380 and 465 build theirs. The shared roster fixture `.kit/fixtures/fleet-status.roster.json` is not edited, so the existing cases read what they read today. `README.md` Quickstart gains a paragraph after "Stop it." headed "Park it." saying that "please park" becomes a `supervisor_shutdown` call with `park: true`, the persona comes back at the keeper's next start, and it is the verb for an update window. `docs/architecture.md`'s fleet reading section says `held` covers both markers.

Acceptance:
- A row whose run directory holds `keeper.park` and no `keeper.hold` reads action `held`, `holdReason` equal to the park file's first line, and `holdReasonSource` the park file's path.
- A row holding both markers reads `held` with the reason and source from `keeper.hold`.
- The existing held and healthy cases still pass unchanged, which is the control.
- A park-marker check that throws lands in the row's note and the standing is `unknown`, as the hold-marker check does today.
- `fleet_status` is under 3,950 characters in `node .kit/injection-ledger.mjs`, and `.kit/injection-duplicate-test.mjs` passes on the refreshed ledger.

Files in scope: `hooks/index.ts` (822-872, 890-1039, 2362-2401), `.kit/fleet-status-unit-test.mjs`, `.kit/fixtures/fleet-status.park-zeta.txt` (new), `.kit/fixtures/fleet-status.keeper-zeta.json` (new), `.kit/injection-ledger.json`, `docs/architecture.md` (103-133, 139-150), `README.md` (36-41).
Tests: at minimum, lock the park-only row and the both-markers row, since a parked persona the steward cannot see is the silent hold the Expert's brief names.

## Out of Scope

- A park that expires on a timer.
- A `parked` action value or a sixth health class in the fleet reading, and any change to `fleetActionOf`, `fleetHealthOf` or the `[FLEET]` prompt text.
- The tool-count pin at `.kit/controller-tick-test.mjs:12625`, which the supervisor gaps plan moves.
- The manual launchers under `D:/personas/<name>/launch.sh`. A supervisor they run exits 6 and nothing relaunches it, as nothing relaunches its exit 0 today.
- The persona charters, the supervisor's priming text and the steward's instructions. The tool description is the surface that tells a persona when to park.
- A live end-to-end park run in `.kit/live-*`. The operator's own update window is the live check, under Operator Verification.
- The fork recorded at `docs/backlog.md:61-63`, whether a stopped persona that leaves a survivor stays down or comes back. This plan changes nothing about a stop.
- `bin/Register-PersonaTasks.ps1`, the scheduled task's trigger and restart policy, and the keeper's ADOPT check the supervisor gaps plan adds.
- `.claude-plugin/plugin.json`.
- `hooks/agent-state.ts` (159-212), whose health classes and their qualifiers do not change.
- `.kit/supervisor-model-test.sh` (42-96), whose assertions name exit codes 1, 2 and 3, none of which this plan touches.
- `docs/plans/agent_persona_supervisor-gaps_v1.md`, `docs/plans/agent_persona_supervisor-peer_v1.md` and the backlog line that cites their scope. Their Out of Scope entries bind their own plans and are left as written.

## Assumptions

- assumed 2026-09-21 (the repository's other plans): the commit model is Branch-and-PR; reversal: one header line.
- assumed 2026-09-21 (default): the park exit code is 6, the first unused code after the table's 5; reversal: one number in four files.
- assumed 2026-09-21 (default): the parameter is a boolean named `park` on the shutdown tool rather than a mode string; reversal: one schema property and its readers in Section 1.
- assumed 2026-09-21 (default): the park marker is a second file, `keeper.park`, beside `keeper.hold`, and a hold marker outranks a park marker where both exist; reversal: Section 3's start-time check and Section 4's read.
- assumed 2026-09-21 (default): `keeper.json` carries the park reason in its existing `holdReason` field rather than a new one, so the fleet reading's fallback needs no change; reversal: one field name in Section 3 and one read in Section 4.
- assumed 2026-09-21 (default): the new keeper log line family is `UNPARK <path>`; reversal: one string in Section 3 and its README and architecture lines.
- assumed 2026-09-21 (`docs/plans/agent_persona_deferred-gate-run_v1.md:21`): the gate policy of 2026-09-18, under which four named plans skip the runs that hold the box and leave them to one later gate, names this plan nowhere, so this plan runs its own suites and defers nothing, with the two slow suites alone under the heavy-process claim; reversal: none, the alternative reintroduces the run the operator asked to defer for those four alone.
- assumed 2026-09-21 (default): the description bound of 3,950 for `fleet_status` leaves 146 characters under the host's 4,096 limit and 50 under the cap test at trunk; reversal: one number.

## Operator Verification

- Run one update window on the fleet after this merges and the fleet relaunches on it: ask each persona to park, read `fleet_status` and confirm every parked persona reads held with a reason naming the park, restart the keepers, and confirm every persona comes back with no `-Release`. The work reopens if any parked persona stays down or any needs a hand release. A persona that came back before the keepers restarted, with an `EXIT ... code=5` line in its keeper log, left a process alive when it parked. That is the survivor case this plan leaves as it is and is not a reopen.
- Stop one persona for good through its tool, restart its keeper, and confirm it stays down until released. The work reopens if it comes back on its own.

## Open Questions

None open. The sketch carried one question, whether a park should expire on a timer, with the recommendation no. The operator's go took the sketch as recommended, and the first line under "Alternatives refused" records it.

## Chapters
