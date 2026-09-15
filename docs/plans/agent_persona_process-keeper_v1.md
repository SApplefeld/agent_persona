# Process keeper: personas as scheduled tasks that come back on their own

Status: In Progress
Commit Model: Branch-and-PR
Disjoint: yes
Created: 2026-09-15

## Goal

When this is done, every persona in the machine's roster runs under a Windows scheduled task that starts at boot with no logon, restarts the supervisor on the exit codes that mean "try again" with a growing delay, holds on the exit codes that mean "stop", and leaves a log and a state file the operator can read. The supervisor itself gains the three self-heal fixes the keeper depends on: no orphaned `claude.exe` at a natural-exit relaunch, the restart and crash limits enforced on the decide path, and a rate-limited or credential-swapped child handled instead of read as a hang. It matters because today the fleet comes back only when the operator opens a terminal and runs a launcher by hand, so a reboot or a crash at night takes the fleet down until morning.

## Dispatch Authorization

The operator authorized this plan for execution on 2026-09-15 on the authoring session's own Discord thread, the relay channel the operator steers that session from, for any session that holds it, and named the dev persona as its executor. The operator's words, in order: "Yes, let's make a plan to build the process keeper", then "Can you plan this work, and hand it off to Persona-Dev to start building?". The expert session authored this plan and this section and does not execute the plan. The receiving session traces the grant to the commit that lands this file and to the operator's own word on its channel, and arms only where both hold.

## Approach

The keeper is three PowerShell scripts in this repo's `bin/`, one roster file and one environment file on the machine, and one scheduled task per persona. The supervisor (`bin/supervise.sh`) is unchanged in shape: it still runs one child, decides restart or stop, and exits with the code its exit table already defines. The keeper wraps it, and the wrapper's whole input is that exit code.

**Why a wrapper with its own loop rather than the scheduler's restart alone.** Task Scheduler's restart-on-failure setting restarts a task that ended badly, at a fixed interval, up to a count. That is the right backstop for the wrapper crashing, and the wrong policy for the supervisor: a supervisor that exits because the operator asked it to shut down must stay down, one that exits on a usage error must not be retried every minute, and one that exits on a crash loop should come back later with a growing delay. Those are three different answers to three exit codes, so the policy lives in a decision function the wrapper runs, and the scheduler only relaunches the wrapper.

**Where it lives.** In this repo's `bin/`, beside the supervisor it launches, because the exit-code contract it reads is this repo's and a change to that table changes the keeper in the same commit. The operator's decision of 2026-08-30 says machine customization converges on the kit repo and its doctor. The keeper is not customization of a session; it is this program's own launcher. What the kit should gain is a doctor health step that reads the keeper's state file, and that is a follow-on for the kit seat, recorded under Open Questions.

**The roster.** One JSON file, default `D:/personas/fleet.json`, listing the personas the machine runs. Each entry maps to the supervisor's own argument and environment contract, and the wrapper sets a variable only where the entry carries the field:

| Roster field | Reaches the supervisor as | Required |
|---|---|---|
| `name` | the `<persona>` argument | yes |
| `workdir` | the `<workdir>` argument | yes |
| `permissionMode` | the `<permission-mode>` argument | yes |
| `rundir` | `--rundir` | no, the supervisor defaults to `<workdir>/run` |
| `channelName` | `--channel-name`; absent means the supervisor's own default thread name, `supervisor-<persona>`, so an entry without it keeps the thread the persona has today | no |
| `model` | the `MODEL` environment variable | no |
| `effort` | the `EFFORT` environment variable | no |
| `controllerTickMs` | the `controllerTickMs` environment variable | no |
| `coordinatorPersona` | the `COORDINATOR_PERSONA` environment variable, by the same path the coordinator launcher uses today | no |
| `args` | any further supervisor flag the table has no row for, appended verbatim; today that is `--dev` and `--no-channel`, and `--prompt` is refused, the build function throwing on it and naming the roster path | no |
| `enabled` | whether a task is registered and enabled | yes |

The three launchers under `D:/personas` today (`aios/launch.sh`, `coordinator/launch.sh`, `dev/relaunch.sh`) are the source for the three entries. The example the repo ships, `bin/fleet.example.json`, is derived from them at Section 5 and the real roster is written from the launchers read at that moment, never from this document.

**The environment file.** Default `D:/personas/keeper.env`, `KEY=value` lines with `#` comments, the broker's `broker.env` shape. The wrapper applies an allowlist and nothing else: `KEEPER_BASH_EXE`, `KEEPER_PATH_PREPEND`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`. The reason is the same as the broker's. S4U is the Task Scheduler logon type that runs a task as a user without a stored password and without loading that user's profile, so the user-scoped PATH (where `bash.exe`, `claude` and the npm shims live on this box) is absent and the profile variables may not resolve to the operator's profile. Every path the supervisor chain needs is pinned in this file. The application rule, which the probe in Section 1 and the wrapper in Section 2 both implement: each allowlisted key present in the file is set as an environment variable of the wrapper's own process before the supervisor starts, except `KEEPER_PATH_PREPEND`, whose value is prepended to the process `PATH` with a semicolon, and `KEEPER_BASH_EXE`, which names the bash executable to run and is not exported. Section 1 measures which of these the task actually needs; the wrapper applies whichever are present.

**The exit-code policy.** The decision function takes the supervisor's exit code, the seconds the supervisor ran, the previous delay, and the count of consecutive exit-1 runs, and returns one action:

| Supervisor exit | Meaning (README exit table) | Keeper action |
|---|---|---|
| 0 | shutdown honored, or stop_complete | write the hold marker with the reason and exit 0 |
| 1 | usage or configuration error, or a launch-time fault | relaunch after 300 seconds; after three consecutive exit-1 runs each shorter than 60 seconds, write the hold marker with the reason and the supervisor's last error line and exit 0 |
| 2 | pre-launch gate failed or timed out | relaunch after 300 seconds, delay unchanged |
| 3, 4, 5, any other | crash loop, restart budget, survivor alive, unknown | relaunch after the current delay, then double it up to 14400 seconds |
| 130, 143 | the supervisor was signaled | exit 0 without relaunching |

The delay starts at 300 seconds and resets to 300 whenever the supervisor ran for 3600 seconds or more before exiting. The hold marker is `<rundir>/keeper.hold`; when it exists at wrapper start, the wrapper logs the hold reason and exits 0 without launching, so a persona the operator shut down stays down across reboots until `Start-Persona.ps1 -Name <n> -Release` removes the marker. The state file `<rundir>/keeper.json` carries the persona name, launch count, last start and end, last exit code, current delay, and the hold reason if any. The log `<rundir>/keeper.log` gets one line per decision and rotates at 5 MB keeping one previous file.

**Registration.** `bin/Register-PersonaTasks.ps1` mirrors `D:/discord-channels/install/Register-BrokerTask.ps1`: an elevation check that fails with a message saying why, one task per enabled roster entry named `AgentPersona-<name>`, an AtStartup trigger, an S4U principal at RunLevel Limited, RestartCount 999 at a one-minute interval, no execution time limit, MultipleInstances IgnoreNew, StartWhenAvailable, and `Set-ScheduledTask` when the task exists so a re-run updates in place. The broker registers AtLogOn; this plan registers AtStartup because the goal is a fleet that needs no logon. `CswapAuto` on this box already runs S4U at boot, which is the precedent that the shape works here.

**The supervisor fixes.** Three backlog entries name defects the keeper would otherwise relaunch into. Backlog entries are named here by their heading text, since line numbers move when the file is pruned: "The natural-exit relaunch never checks for a surviving claude.exe" (a surviving `claude.exe` at a natural-exit relaunch), "The decide path relaunches once more before a restart or crash limit stops the run", and "The supervisor treats a rate-limited child as merely quiet, and a credential swap never reaches it". Section 4 fixes them with their recorded remedies, each checked against the code before it is written, with one amendment to the third: the backlog remedy keys the swap on the credentials file's modification time, and that file is also rewritten on an ordinary token refresh, which would restart a healthy child. The signal is instead the account identity the profile config names, `oauthAccount.accountUuid` in the `.claude.json` under `USERPROFILE`, the file `claude` itself reads, read at child launch and compared on each poll; a change is a swap, and a rewrite that keeps the identity is quiet. On this box the account autoswitch task is what moves accounts, and it rewrites that config in place. The supervisor never reads the credentials file itself.

**Sweep.** The surfaces that speak the launch contract were read directly in the design session rather than by a scout dispatch: `bin/supervise.sh` (usage at lines 4 and 37, argument parsing 45 to 116, environment settings 206 to 207 and 333, launch flags 1463 to 1474, exit points 1832 to 1864, 1937 to 1942, 1996 and 2002, exit table comment at 24); `README.md` (quickstart 5 to 31, the workdir sentence at 24, exit codes 300 to 312, test coverage 322 to 343, limitations and next steps 472 to 491); `docs/backlog.md` lines 3, 64, 78, 82, 94, 158; the launchers under `D:/personas`; the sibling pattern in `D:/discord-channels/install/Register-BrokerTask.ps1` and `Start-Broker.ps1`; the kit's own task in `D:/claude-kit/sidecar/install-daemon-task.ps1`; and this machine's task list, which holds `claude-kit-sidecar-daemon` (Interactive, daily), `CswapAuto` (S4U, boot) and `SapplefeldChannelsBroker` (S4U, logon). Every one of those is in a section's Files in scope or under Out of Scope.

**Order.** Section 1 first, because its measurements are the input to Sections 2 and 3. Sections 2 and 3 next in either order, then 4, then 5. Section 4 is independent of the others and may run beside 2 or 3 in a second worktree. The header's Disjoint line says this plan touches no file another in-flight plan holds, so it may run beside one.

## Sections of Work

### 1. Prove the scheduled-task shape on this box
Model: opus

Measure, under a real scheduled task, what the wrapper will inherit, before the wrapper is written against a guess. Deliver `bin/keeper-probe.ps1`, which takes `-OutFile` and `-EnvFile`, writes to the out file the running user, the session id, the elevation state, and the delivered values of `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `PATH`, then applies the env file's allowlisted keys by the application rule in the Approach and records the exit code and first output line of each of `bash.exe --version`, `node --version` and `claude --version` run through that bash. The env file for the probe is one this section writes at its final path, `D:/personas/keeper.env`, which Section 5 later reduces to the pins that proved necessary, carrying all eight allowlisted keys at this box's values: bash under `C:/Program Files/Git/bin`, node under `C:/Program Files/nodejs`, `claude` under the profile's `.local/bin`, the npm shims under the profile's `AppData/Roaming/npm`, and the profile variables at the operator's profile path. This plan is for this machine: the sibling scripts under `D:/discord-channels/install`, the launchers under `D:/personas` and the `CswapAuto` task are read here as patterns and are not in this repository.

Measurements, each recorded in this section's Chapter with the artifact it came from:

1. Whether the executing session is elevated, read with `IsInRole` on the current Windows identity.
2. Whether registering an S4U task succeeds from that session. Try it with `-ErrorAction Stop`; record the error text if it fails.
3. The delivered environment under the task, from the probe's out file.
4. Whether bash, node and claude resolve and report a version with the env file applied.
5. A real supervisor run under a task, with a scratch persona named `probe`, workdir `D:/personas/probe` and `--no-channel` so no Discord thread is created, launches a child: `LAUNCH child-1` in that run's `supervisor.log` and a heartbeat file that updates across two minutes.
6. Whether `Stop-ScheduledTask` ends the whole tree: after the stop, no `bash.exe`, `node.exe` or `claude.exe` from that run survives, read from the process list by parent chain or start time.
7. If cheap, whether a wrapper that exits 3 is restarted by the scheduler within the restart interval, since that is the backstop the design leans on for the wrapper's own crash.

Acceptance: the Chapter carries all seven readings, each as measured, or as "cannot measure" with the reason. Where reading 1 is unelevated and reading 2 fails, the section still delivers the probe script, registers nothing, records readings 3 to 7 as "cannot measure: registration needs an elevated session", and Sections 2 and 3 proceed on the broker's documented S4U facts (no profile loaded, every path pinned); the Operator Verification items then produce the readings. The scratch task and the scratch persona's directory are removed before the section closes, the env file stays, and the Chapter names all three as machine state that was created, removed or kept.

Files in scope: `bin/keeper-probe.ps1` (new); reads of `D:/discord-channels/install/Register-BrokerTask.ps1` and `Start-Broker.ps1` for the pattern; `bin/supervise.sh` for the exit table and the launch chain.
References: `D:/discord-channels/install/Register-BrokerTask.ps1` for the S4U principal and settings; this machine's `CswapAuto` task for an S4U boot trigger that works.

### 2. The keeper wrapper and its decision function
Model: opus

Deliver `bin/keeper-functions.ps1`, dot-sourced, holding pure functions: `Get-KeeperDecision` (exit code, uptime seconds, previous delay seconds, consecutive exit-1 count, in; action, delay seconds, next delay seconds, next exit-1 count, reason, out) implementing the policy table in the Approach; `Read-KeeperRoster` (path, name, in; the entry, out; a missing or disabled name is a thrown error naming the roster path); `Read-KeeperEnvFile` (path, in; the allowlisted keys and a list of the ignored keys, out); and `Build-SupervisorInvocation` (entry, in; the argument list and the environment map, out) implementing the roster table in the Approach. Deliver `bin/Start-Persona.ps1 -Name <n> [-Roster <path>] [-EnvFile <path>] [-Release]`, which applies the environment, honors the hold marker, runs the supervisor through `KEEPER_BASH_EXE` with the built arguments and with its stdout and stderr appended to `<rundir>/supervisor.out`, loops on the decision function, writes `keeper.json` and `keeper.log` under the entry's run directory, and rotates the log at 5 MB keeping one previous file. Both scripts run under Windows PowerShell 5.1 (`powershell.exe`), which is what the task action names.

Acceptance:
- `Start-Persona.ps1 -Name nosuch` exits 1 with a message naming the roster path and the name.
- With `KEEPER_BASH_EXE` pointed at a stub that exits with a planned code, the wrapper's log shows one `DECIDE exit=<n> uptime=<s> action=<a> delay=<d> reason=<r>` line per exit, the actions match the policy table, the delay doubles from 300 to the 14400 cap across consecutive crashes, and an uptime of 3600 or more resets it to 300.
- The stub's stdout and stderr land in `<rundir>/supervisor.out`, read back after the run.
- An `args` entry carrying `--prompt` makes `Build-SupervisorInvocation` throw, naming the roster path, before anything runs.
- Exit 0 writes `keeper.hold` with the reason and the wrapper exits 0; a single exit 1 relaunches after 300 seconds; three consecutive exit-1 runs each under 60 seconds write `keeper.hold` with the reason, the stub's last stderr line and the path of `supervisor.out`, and the wrapper exits 0; a later start with the marker present logs `HOLD <reason>` and exits 0 without running the stub; `-Release` removes the marker, logs it, and exits 0 without launching, and where no marker exists it logs that and exits 0, which is the only case a running wrapper can present, since the marker is written only as the wrapper exits.
- A key in the env file outside the allowlist is not applied and its name appears in the log's `ENV ignored:` line; an allowlisted key is applied before the stub runs, read back from the stub's own output.
- `keeper.json` after a run carries the fields the Approach lists, as JSON `Get-Content | ConvertFrom-Json` reads.

Files in scope: `bin/keeper-functions.ps1` (new), `bin/Start-Persona.ps1` (new), `.kit/keeper-unit-test.mjs` (new), `bin/supervise.sh` (read only, for the exit table at lines 24 to 33).
Tests: at minimum, lock the policy table both directions for every row (a code that must hold never launches, a code that must launch never holds), the doubling and the cap, the reset on uptime, the hold marker present versus absent, and the allowlist in both directions, since a key that leaks through the allowlist is the same defect the broker's allowlist exists to stop. Drive the real `powershell.exe` from node so the test exercises the engine the task will run.
References: `D:/discord-channels/install/Start-Broker.ps1` for the allowlisted-env pattern; `D:/claude-kit/sidecar/daemon-task.ps1` for a log rotation already written for this box.

### 3. Task registration
Model: sonnet

Deliver `bin/Register-PersonaTasks.ps1 [-Roster <path>] [-EnvFile <path>] [-RepoRoot <path>] [-User <name>] [-Prune] [-Start] [-WhatIf]`, cloned from `D:/discord-channels/install/Register-BrokerTask.ps1` with these substitutions: the build step is a function that returns one definition per enabled roster entry, so a test can inspect the definitions with `-WhatIf` and never touch the scheduler; the task name is `AgentPersona-<name>`; the action is `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File <repo>/bin/Start-Persona.ps1 -Name <name> -Roster <roster> -EnvFile <envfile>` with every path absolute, `<repo>` being `-RepoRoot`, which defaults to the parent of the script's own directory and which the operator runs from the root checkout at `D:/agent_persona` and never from a worktree, since a task pointed at a worktree breaks when that worktree is removed; the trigger is AtStartup; the principal is S4U at RunLevel Limited for `-User`, defaulting to the current identity; the settings are RestartCount 999, RestartInterval one minute, ExecutionTimeLimit zero, MultipleInstances IgnoreNew, StartWhenAvailable, AllowStartIfOnBatteries and DontStopIfGoingOnBatteries. An existing task is updated with `Set-ScheduledTask`; a roster entry with `enabled` false disables its task if one exists and reports otherwise; a task named `AgentPersona-*` with no roster entry is reported, and unregistered only under `-Prune`; `-Start` starts each registered task after registration. The elevation check runs first and throws the broker's message shape.

Acceptance: `-WhatIf` against `bin/fleet.example.json`, or against a fixture of the roster shape under `.kit/fixtures/` until Section 5 lands, prints one definition per enabled entry with the name, action string, trigger class, logon type and the seven settings above, and registers nothing; the script run unelevated without `-WhatIf` throws before any ScheduledTasks cmdlet runs. The idempotence check runs only where Section 1's reading 1 found the session elevated: a first and a second run against a scratch roster naming one scratch persona `keeper-probe`, never started, register `AgentPersona-keeper-probe` once and leave its definition unchanged, read before and after, and the scratch task is unregistered before the section closes. Where the session is unelevated, that check is recorded as cannot measure and Operator Verification item 1 runs the registration twice in its place. The real roster is never registered by this section; the cutover is the operator's.

Files in scope: `bin/Register-PersonaTasks.ps1` (new), `.kit/keeper-register-test.mjs` (new), `bin/fleet.example.json` (Section 5 writes it; this section reads it, or a fixture of the same shape if Section 5 has not landed).
Tests: at minimum, lock the built definition per entry, the elevation guard in both directions with the elevation state injected, the disabled and absent branches through `-WhatIf` output, and the `-Prune` branch reporting rather than removing when the switch is absent, since an unrequested unregister is the destructive failure.
References: `D:/discord-channels/install/Register-BrokerTask.ps1`, whose `-WhatIf` return and `Set-ScheduledTask` branch are the shape to clone.

### 4. Supervisor self-heal fixes the keeper depends on
Model: opus

Three fixes across the supervisor's two halves. `bin/supervise.sh` is the outer loop: it launches the child, polls it, stops it, and relaunches. `bin/supervise-decide.mjs` is the pure decision unit the poll loop calls with the child's state, returning one action such as restart, restart_passive or stop_crash_loop. Fixes 1 and 2 land in `bin/supervise.sh`; fix 3's rate-limit reading lands in the decision unit, since the hang reading it suppresses is decided there, and its account check lands in `bin/supervise.sh` beside the other facts the poll loop reads. Each backlog entry, named by its heading text, has its recorded remedy read whole and checked against the code before it is written; where the code has moved past the remedy, the Chapter says so and the fix follows the code.

1. "The natural-exit relaunch never checks for a surviving claude.exe": resolve and store the child's Windows pid right after the coproc launch, snapshot its tree on every stop and before a natural-exit relaunch, and kill any survivor before launching the next child, so a relaunch never runs beside an orphaned `claude.exe`.
2. "The decide path relaunches once more before a restart or crash limit stops the run": the decide path's restart branch checks the crash-loop limit and the restart budget before it relaunches, so a limit stops the run at the limit rather than one launch later.
3. "The supervisor treats a rate-limited child as merely quiet, and a credential swap never reaches it": the supervisor reads `api_error` records in the child's `stdout.jsonl` that carry a rate limit type and a reset time, logs `RATE_LIMITED until <ISO>`, and does not count the quiet that follows as a hang before that time; and it reads `oauthAccount.accountUuid` from the `.claude.json` under `USERPROFILE`, the file `claude` itself reads, at child launch and on each poll, taking `restart_passive` when the value changes so the child picks up the swapped account, staying quiet when the file is rewritten with the same value, and reading an absent or unparsable file as no identity, which is also quiet. It never opens the credentials file.

Acceptance: each fix has a red-then-green case in the suite named below; the README exit table at lines 300 to 312 is unchanged, since no exit code changes meaning; every offline suite the README lists under The supervisor's own suites passes, namely `.kit/supervisor-unit-test.mjs`, `.kit/supervisor-natural-exit-test.sh`, `.kit/supervisor-model-test.sh`, `.kit/settings-plugin-key-test.sh`, `.kit/channel-reply-instruction-test.sh` and `.kit/persona-live-refuse-test.sh`; and `.kit/live-stopprocesstree-test.sh` passes.

A running supervisor launched from this checkout keeps executing the script it started with (the backlog entry "A running supervisor keeps the script it launched with"), so these fixes reach a persona only at its next launch, which the cutover under Operator Verification provides.

Files in scope: `bin/supervise.sh`, `bin/supervise-decide.mjs`, `.kit/supervisor-natural-exit-test.sh`, `.kit/supervisor-unit-test.mjs`, `docs/backlog.md` (read only here; the close-out prune retires the three entries named above).
Tests: at minimum, lock a survivor left by the stub child being killed before the relaunch and a control where none is left; the decide-path relaunch refused at the limit and taken one below it; a rate-limit record suppressing the hang reading until its reset time and not past it; and an account identity that changed since launch taking `restart_passive`, with a rewrite that kept the identity and an absent file both staying quiet, since the silent direction of each is a persona that looks alive and is not, and the loud direction of the last is a healthy child restarted on every token refresh.
References: `.kit/supervisor-natural-exit-test.sh`'s stub harness for the shell-level cases; `.kit/supervisor-unit-test.mjs` for the decision-unit cases.

### 5. Roster, environment file, README, and launcher migration
Model: sonnet

Write `bin/fleet.example.json` from the three launchers under `D:/personas` read at this moment, one entry each for `coordinator`, `aios` and `dev`, carrying every argument and environment variable each launcher sets, mapped through the roster table in the Approach. Write the real `D:/personas/fleet.json` with the same content and reduce the `D:/personas/keeper.env` Section 1 wrote to the pins Section 1 measured as needed, or keep all eight allowlisted keys where Section 1 could not measure. Both files are machine state outside git and the Chapter names them. The launchers stay in place as the manual fallback.

Add a `## Process keeper` section to `README.md` stating what runs today: the roster fields, the env file keys, the policy table, the hold marker and `-Release`, the registration command and its elevation requirement, how to stop a persona (its own shutdown tool, or `Stop-ScheduledTask` where Section 1's reading 6 found it ends the tree, else the wrapper's own stop path) and start one (`Start-ScheduledTask`), and where `keeper.log` and `keeper.json` live. Add the two new suites to the Test Coverage list at lines 322 to 343 in that list's shape, add the three keeper scripts to the Key Files table at lines 314 to 321, and add the Section 4 cases to the two supervisor suite lines. Re-read Limitations and Next steps at lines 472 to 491 and remove any line this plan retires. The README states current behavior only, never the change story.

Acceptance: `Register-PersonaTasks.ps1 -WhatIf` against the written roster prints three definitions; a diff of each launcher against its roster entry, done by eye and recorded in the Chapter, finds no argument or variable dropped; the README section answers each of the questions above in its own sentence.

Files in scope: `bin/fleet.example.json` (new), `README.md`, `D:/personas/fleet.json` and `D:/personas/keeper.env` (machine state), reads of `D:/personas/aios/launch.sh`, `D:/personas/coordinator/launch.sh`, `D:/personas/dev/relaunch.sh`.

## Out of Scope

- Moving the broker's own task from AtLogOn to AtStartup. That is the `discord-channels` repo's change and the operator's call; Open Questions carries it.
- The split of today's coordinator persona into a Sonnet steward that keeps the fleet running and a Fable architect that does design work on demand. That is the next plan.
- The kit resolving a persona's instructions, memory and leash from the repo it is working in rather than its home directory. That is the plan after, for the session that maintains the `claude-kit` repository.
- The backlog's other outer-loop entries: the design direction "let the outer loops recover a session that stopped" beyond the three fixes in Section 4; "A `--prompt` goal is dropped when the first child dies before its goal turn", since the roster launches every persona passive with no prompt and a prompt field is not added; "A pending record to an unheld coordinator is lost when its writer restarts before the coordinator's first tick", which moves with the steward plan; "A reader session cannot write restart_requested when the owner is the stuck process"; and "A running supervisor keeps the script it launched with".
- A kit doctor health step reading `keeper.json`, and any change to `D:/claude-kit/sidecar`.
- Any change to the supervisor's exit codes or their meanings.
- Syncing the roster or the env file across machines.
- Cutting the running personas over to the tasks. That is the operator's act under Operator Verification, at a quiet point of the operator's choosing.

## Assumptions

- assumed 2026-09-15 (default): the keeper ships in this repo's `bin/`, not in the kit repo, because it launches this repo's supervisor and reads this repo's exit table, and the operator's 2026-08-30 convergence decision covers session customization rather than a program's own launcher; reversal: moving three scripts and two tests to the kit's sidecar directory and re-registering the tasks.
- assumed 2026-09-15 (default): the scripts target Windows PowerShell 5.1, the engine every scheduled task on this box already runs, and the tests drive that same `powershell.exe`; reversal: none, since PowerShell 7 runs the same scripts.
- assumed 2026-09-15 (default): the roster and the env file live under `D:/personas` beside the launchers they replace, and since that directory is not a git repository they are machine state named in the Chapter that writes them; reversal: both scripts already take the paths as parameters.
- assumed 2026-09-15 (default): the trigger is AtStartup alone, because the goal is a fleet that needs no logon; reversal: one trigger line per task, and a roster field if some personas should differ.
- assumed 2026-09-15 (default): the exit-code policy table in the Approach, with 300 seconds as the base delay, 14400 as the cap and 3600 seconds of uptime as the reset; reversal: three constants in the decision function and its test.
- assumed 2026-09-15 (default): exit 1 relaunches after 300 seconds and holds only after three consecutive exit-1 runs each under 60 seconds, because the supervisor exits 1 both on a configuration error that will repeat and on a launch-time fault a boot can hit once; reversal: two constants in the decision function and its test.
- assumed 2026-09-15 (source: `bin/supervise.sh` lines 24 to 33 and `README.md` lines 300 to 312): the supervisor's exit code is the keeper's whole input and the keeper reads nothing else from the run; reversal: the decision function grows an input.
- assumed 2026-09-15 (default): a persona shut down through its own tool stays down across reboots until an operator act, so exit 0 writes a hold marker the task honors at every later start; reversal: drop the marker branch, and every shutdown is followed by a relaunch at the next boot.
- assumed 2026-09-15 (source: the operator's words on 2026-09-15 that the fleet should be a few workers plus one or two homed personas): the roster is closed at the three personas that run today, `coordinator`, `aios` and `dev`, and nothing more; reversal: a roster entry.
- assumed 2026-09-15 (source: the profile config's `oauthAccount.accountUuid` key, present on this box): the account swap signal is that identity changing between child launch and a poll, not the credentials file's timestamp, because the file is rewritten on an ordinary token refresh too; reversal: the check reads a different key or file.
- assumed 2026-09-15 (default): the executing session runs on this machine, where the sibling scripts under `D:/discord-channels/install`, the launchers under `D:/personas` and the `CswapAuto` task exist to read as patterns; reversal: on another machine the Approach carries enough of the broker's shape to write Section 1's probe without them.
- assumed 2026-09-15 (default): Section 1 runs first and its Chapter is the input to Sections 2 and 3; where the executing session is unelevated and cannot register a task, Sections 2 and 3 proceed on the broker's documented S4U facts and the Operator Verification items produce the readings; reversal: a divergence found at the operator's run is a fix round on Section 2.
- assumed 2026-09-15 (default): the executing session is the dev persona, working in this repo on a feature branch under Branch-and-PR, and the expert session that authored this plan does not execute it; reversal: none.

## Operator Verification

1. Where Section 1's Chapter reports the executing session was unelevated: from an elevated PowerShell, with the root checkout at `D:/agent_persona` on a branch that carries the merged work, run `D:/agent_persona/bin/Register-PersonaTasks.ps1 -Roster D:/personas/fleet.json -EnvFile D:/personas/keeper.env -WhatIf`, read the three definitions, then run it without `-WhatIf`, twice: the second run reports the same three definitions and changes nothing. A thrown error, a definition that names a wrong path, or a second run that changes a task reopens Section 3.
2. Cut over at a quiet point. For each hand-launched supervisor: ask the persona to shut down through its own tool or close the launcher's console, wait for the supervisor's exit line in its log, then run `Start-ScheduledTask AgentPersona-<name>`. Each persona's thread reports ready. One that does not come back within ten minutes reopens Section 2, with `keeper.log` as the evidence.
3. Reboot without logging on. Every enabled persona's thread reports ready within ten minutes of the boot. One that does not reopens Section 1 or Section 2, whichever `keeper.log` points at.
4. Ask one persona to shut down through its tool, then reboot. That persona stays down and its `keeper.log` names the hold; the others come back. Then run `Start-Persona.ps1 -Name <name> -Release` and `Start-ScheduledTask AgentPersona-<name>`, and that persona reports ready. A persona that comes back on its own after a shutdown reopens Section 2.

## Open Questions

- Whether `Stop-ScheduledTask` ends the whole process tree in session 0. Section 1 measures it. If the scheduler leaves the supervisor's children running, the wrapper needs a stop path of its own, which is a fix round on Section 2 rather than a new section.
- Whether the broker's task should also move to AtStartup so the whole machine comes up without a logon. The operator's call, in the `discord-channels` repo.
- Whether the kit's doctor gains a step that reads each persona's `keeper.json` and reports a held or backing-off persona. The kit seat's call, after this plan ships.

## Chapters
