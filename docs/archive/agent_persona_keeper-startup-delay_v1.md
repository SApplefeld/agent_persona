# Keeper startup delay and the NEO-CLAUDE fleet

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-21

## Goal

When this is done, every persona task the keeper registers waits a configurable time after boot before it launches, two minutes by default, so the channel broker is up before any persona child attaches its Discord channel. And the NEO-CLAUDE machine runs a four-persona fleet from `D:\personas`: a steward on Sonnet, an architect on Fable, and two Opus workers, one per repository. It matters because the registration script fires every persona task at boot with no delay today, the broker's own boot task fires thirty seconds after boot and then has to start node and log in to Discord, and the other machine closed that gap by hand on each task, which the next re-registration would undo.

## Dispatch Authorization

The operator asked for this at the keyboard on 2026-09-21 and answered "proceed" to the plan and its three recommendations: a two-minute default, workers at the supervisor's default effort, and the decision seam left off. Sections run in this session on branch `fleet-startup-delay` cut from `origin/main` at `23aa100`, landing as one pull request.

## Intent

The operator's frame: bring the fleet that runs on SCOTT-CLAUDE to this machine, with the same `D:\personas` root, and make the delay part of the install rather than a hand step.

Done means three things. The registration script takes `-StartupDelay`, holds every task's boot trigger by it, prints it under `-WhatIf`, refuses a value outside the duration class it admits, and the keeper register suite pins all of that. `D:\personas` holds a roster, an environment file and four persona directories that the keeper and the broker both read. The four tasks are registered, started, and each persona holds its thread in Discord.

Done does not need any of the following. It does not need the broker's own task changed on this machine: it already carries a boot trigger with a thirty-second delay and a logon trigger, read from the scheduler on 2026-09-21. It does not need the decision seam on the steward, which the operator declined. It does not need the workers' effort pinned. It does not need the other machine's tasks re-registered, which is that machine's own step.

Alternatives refused:
- Setting the delay by hand on each task after registration: refused, because a re-run of the registration script updates the existing task with a delay-less trigger and silently drops it.
- No delay, leaning on the pre-launch gate: refused, because that gate waits on the persona's seat and heartbeat, never on the broker, and the relay's documentation says nothing about what a child does when the broker is not yet listening.
- A default written in three places, on the script parameter and on each function's parameter: refused in favour of one script-scope constant the three read.

Provenance: the operator's keyboard messages of 2026-09-21, `README.md` under Process keeper, `bin/Register-PersonaTasks.ps1`, `bin/fleet.example.json`, `.kit/keeper-register-test.mjs`, and the scheduler and broker environment read on NEO-CLAUDE the same day.

## Approach

**Section 1: the startup delay parameter.** Model: fable, inline. `bin/Register-PersonaTasks.ps1` gains `-StartupDelay`, a string. One script-scope constant `$KeeperDefaultStartupDelay = 'PT2M'` is the single source of the default: the script body fills an unbound parameter from it, and both `Get-PersonaTaskDefinitions` and `Register-PersonaTasks` take it as their parameter default, so the suite's direct callers keep working unchanged. `Get-PersonaTaskDefinitions` refuses a value outside uppercase `PT` followed by hours, minutes and seconds with at least one digit, matched case-sensitively, naming the parameter and the value, then sets `$trigger.Delay` on each boot trigger. A zero duration such as `PT0S` is inside that class and is the operator's explicit choice. A bound empty string takes the default, the same shape `-RepoRoot` has. `Write-PersonaTaskDefinition` prints `startupDelay:` after the trigger line. `.kit/keeper-register-test.mjs` pins the default on both fixture blocks, pins a withheld value `PT90S` reaching both blocks, and pins the refusal of a bare number, of a digitless duration and of a lowercase duration. The README's Registering the tasks paragraph gains two sentences, and the sentence in `docs/architecture.md` that lists the trigger gains the delay. Acceptance: `node .kit/keeper-register-test.mjs` exits 0 with the new cases counted, and the real script under `-WhatIf` against the fleet roster prints `startupDelay: PT2M`.

**Section 2: the fleet files.** Model: fable, inline. Outside the repository, on this machine only. `D:\personas\fleet.json` carries four entries mirroring `bin/fleet.example.json`: `STEWARD` (Sonnet, tick 300000, coordinator and architect names, `fleetRoster` naming the roster itself), `ARCHITECT` (Fable, high, tick 60000), `DEV-NEO` (Opus, workdir `D:/Neuro-Evolution-Operations`), `DEV-AIOS` (Opus, workdir `D:/ai-os`). Every entry names `STEWARD` as coordinator, `bypassPermissions`, a `channelName` equal to its persona name, `enabled: true`, and a run directory under `D:/personas/<name>/run`. `D:\personas\keeper.env` names Git's bash, prepends `C:\Users\NEO\.local\bin`, `C:\Program Files\nodejs`, `C:\Users\NEO\AppData\Roaming\npm` and `C:\Program Files\Git\usr\bin` to PATH, and carries HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and TMP for the S4U logon. The steward's and architect's own directories are created empty. Acceptance: `bin/keeper-probe.ps1` or the registration script's `-WhatIf` reads the roster and env file without refusal.

**Section 3: registration and first start.** Model: fable, inline with the operator. The script runs under `-WhatIf` from this session and prints four blocks. The operator runs the real registration once from an elevated PowerShell, since this session is not elevated (read on 2026-09-21). The tasks are then started with `Start-ScheduledTask`, and each persona's `keeper.log` and `supervisor.log` are read for a launch, with the broker log read for four channel bindings. Acceptance: four `AgentPersona-*` tasks registered with `Delay PT2M` on their boot trigger, four supervisors running, four threads in Discord.

**Gates.** Baseline on the clean tree at `23aa100`: `node .kit/keeper-register-test.mjs` 110 passed, 0 failed, exit 0. Section 1 closes on that suite green with its new cases. Sections 2 and 3 are machine state and close on the real observations named above.

## Out of Scope

- The broker task on SCOTT-CLAUDE, and re-registering that machine's persona tasks with the new default.
- The decision seam, worker effort, and any persona charter text.

## Chapters

### Chapter 1: the startup delay parameter (2026-09-21)

Shipped: `-StartupDelay` on `bin/Register-PersonaTasks.ps1`, the `$KeeperDefaultStartupDelay` constant, the case-sensitive duration guard in `Get-PersonaTaskDefinitions`, `$trigger.Delay` on every boot trigger, the `startupDelay:` line in the printed block, four new cases in `.kit/keeper-register-test.mjs`, two README sentences, and the architecture doc's trigger sentence. Line citations in both docs that the diff moved were updated to the new lines.

Review findings. The adversarial reviewer returned CHANGES_REQUIRED and the blind reviewer APPROVED_WITH_CONCERNS; both found the same major, that `-notmatch` ignores case and would pass `pt2m` to the scheduler. Fixed with `-cnotmatch` and a third refusal case. The adversarial reviewer found the plan's Out of Scope naming the architecture doc while the diff edited it: the exclusion was wrong, since that sentence lists the trigger, so the bullet was retired and the Approach amended. It also found the withheld test value `PT1M` was not withheld, since the restart interval prints as `PT1M`; the case now uses `PT90S`. The blind reviewer found an adjacent comment reading "not the broker's AtLogOn" that implied the broker has no boot trigger; reworded. Declared rather than changed: a bound empty string takes the default, as `-RepoRoot` does; `PT0S` and any value under the broker's thirty seconds pass the guard as the operator's explicit choice; the digit run is unbounded; and the constant resolves by dynamic scope, so a dot-source inside a nested scope followed by a call from elsewhere would see no default, a path no caller takes.

Lane: `node .kit/keeper-register-test.mjs`, baseline 110 passed 0 failed exit 0 → 114 passed 0 failed exit 0, read from the run. The real script under `-WhatIf` against `D:\personas\fleet.json` printed four blocks with `startupDelay: PT2M`, exit 0.

Commit model: Branch-and-PR, branch `fleet-startup-delay`. Next: Sections 2 and 3, below.

### Chapter 2: the fleet files and the first start (2026-09-21)

Shipped outside the repository: `D:\personas\fleet.json` with the four entries the Approach names, `D:\personas\keeper.env`, and run directories under `D:\personas\STEWARD`, `ARCHITECT`, `DEV-NEO` and `DEV-AIOS`. The operator ran the registration with `-Start` from an elevated PowerShell and pasted its output: four registered, four started.

Observed from this session after the start. `Get-ScheduledTask` reports all four `AgentPersona-*` tasks Running, boot trigger delay `PT2M`, logon S4U. Each persona's `keeper.log` carries one LAUNCH line naming Git's bash and the right workdir and rundir. Each `supervisor.log` passed the pre-launch gate and launched child-1 within two seconds. Each child-1 `stdout.jsonl` carries one `result` line, so the priming turn completed. The steward's emitted settings carry `coordinatorPersona` STEWARD, `architectPersona` ARCHITECT and `fleetRoster` `D:/personas/fleet.json`; a worker's carries `coordinatorPersona` STEWARD. The broker log shows four "relay attached" lines in the two seconds after launch and its state file names all four sessions. Not observed from here: the four threads in Discord, which the operator sees.

Lane: none in the repository; the section is machine state and closed on the observations above. Commit model: Branch-and-PR. Next: none. Close-out: delivered in this changeset on branch fleet-startup-delay as one pull request; the fleet is running on NEO-CLAUDE and the plan is archived.
