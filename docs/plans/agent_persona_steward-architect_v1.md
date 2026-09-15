# Steward and architect: split the coordinator persona into a Sonnet fleet keeper and a Fable designer on demand

Status: Ready
Commit Model: Branch-and-PR
Disjoint: no
Created: 2026-09-15

## Goal

When this is done, the always-on coordinator persona is replaced by two personas. The steward runs Sonnet on a five-minute tick and keeps the fleet running: it routes commons-inbox traffic between workers and the operator as the coordinator does today, watches each persona's keeper state and heartbeat and reports one that is held, backing off or stale, holds the kit's Coordinator seat and runs that seat's reconciliation pass, and wakes the architect when a record needs design judgment. The architect runs Fable with no standing goal and no home repository, and is woken by the steward or the operator for design work: assessments, specs written into the target repository, consults, plan reviews, and the finishing judgment on a high-stakes effort. Workers are unchanged. It matters because today one Fable persona ticks every minute doing mostly clerical work at the top tier's cost, while the design work that tier exists for arrives a few times a day.

## Approach

**What the coordinator persona costs today, measured.** The coordinator child's transcript at `D:/personas/coordinator/run/child-1/stdout.jsonl` showed, when read on 2026-09-15, a run cost of 8.75 dollars across 150 assistant turns, 52 shell calls, 2 subagent dispatches, 10 replies to the operator, 1 inbound priming prompt and 0 steers sent to a worker. The work was status reading and reporting. That is the clerical load the steward takes at Sonnet.

**Steward.** The coordinator persona's launch shape, kept whole, with four changes. The persona is named `steward` and the plugin's `coordinatorPersona` setting names it, so the plugin's reach rule (the coordinator persona's holder may address any persona, and workers may address the coordinator persona) applies to the steward with no plugin change. The model is Sonnet. The controller tick is 300000 milliseconds; a delivered record still lands on the next quiet tick, and a worker's urgent record breaks into a running turn, so a slower tick costs response time only for a steward that is idle, and five minutes is the bound the fleet-health duty needs anyway. The standing instruction the supervisor writes for the coordinator persona (`COORDINATOR_ROLE_INSTRUCTION` in `bin/supervise.sh`) gains three duties beside the ones it carries today:

1. Fleet health. On each tick, call the fleet status tool Section 3 adds, which reads the roster from the process keeper plan, each persona's `keeper.json`, and each persona's commons entry, and report to the operator on the steward's own thread any persona that is held, backing off, or whose commons heartbeat is older than the plugin's `staleAfterMs` setting, once per change of state rather than once per tick.
2. The kit's Coordinator seat. At priming, take the seat with the kit's role skill, which writes the registry entry and reads the board; on each tick, run the reconciliation pass the kit's coordinator skill states, including the registry prune of exited entries and the claim probe, and, at the end of each turn whose state is on disk, run the kit's compaction checkpoint CLI's boundary verb as the coordinator instruction already says, so the next automatic compaction lands at a declared point.
3. Waking the architect. A record that turns on a design decision (an operator design question, a worker escalation the worker's plan does not cover, a request for a spec, a plan review or a consult) goes to the architect through `agentic_say` with the persona argument set to `architect`, carrying the ask and the repository it concerns, and the steward tells the operator it did so. A delivered record starts a turn on the architect's next tick, which is how the wake works, and no new mechanism is added. The architect answers the steward the way a worker does, with a record addressed to the steward's persona, and the steward relays the answer to the worker that escalated as a coordinator record, so the architect never addresses a worker directly.

**Architect.** A new persona `architect`, model Fable, effort high through the roster's `effort` field, which the process keeper plan maps to the supervisor's `EFFORT` variable, on a 60000 millisecond tick, which is cheap while idle because a tick with no goal and an empty inbox does nothing. Its home directory is `D:/personas/architect`, not a repository: it is the roaming seat the operator asked for. The supervisor takes any directory as a workdir, the persona store lives there, and the commons store every persona claims into is machine-global under the installed plugin, so the architect holds a commons entry and receives records like any other persona. When an ask names a repository, it cuts a worktree of that repository under its own directory, does the work there on a branch, commits and pushes, and reports the branch and the filename to the steward and the operator. A new standing instruction, `ARCHITECT_ROLE_INSTRUCTION`, built when the launch's persona matches a new `ARCHITECT_PERSONA` setting the way the coordinator instruction is built today, states its charter: design work only, no standing goal, specs go into the target repository's `docs/plans` on a branch, it never executes a plan, and a plan it writes is handed to a worker through the steward. One limitation stands until the kit-resolution plan lands: the kit resolves a session's instructions, memory and leash from the session's launch directory, so the architect's kit memory is its own directory's rather than the target repository's, and it reads a repository's memory index explicitly when it needs it.

**Workers.** Unchanged in this plan. They keep their launch shapes and their roster entries; the only thing that moves is the name their steer instruction targets, which is the `coordinatorPersona` value, so each worker picks up the steward's name at its next launch.

**What retires.** The `coordinator` persona: its roster entry is replaced by `steward`, its launcher becomes the steward's, its thread stays as history, and its store entries in the shared `D:/agent_persona` store are released by its own shutdown. The backlog entry "A pending record to an unheld coordinator is lost when its writer restarts before the coordinator's first tick" is re-read here against a steward that runs under the process keeper: Section 5 retires it with receipts if the keeper closes the window, and otherwise re-dates it with what remains.

**Why not one persona with a model switch.** A persona is one session with one model for its life; the supervisor sets the model at launch. Two jobs with different tiers and different cadences are two personas, and the commons inbox already carries traffic between named personas, so the split costs one instruction, one roster entry and one tool.

**Sweep.** The surfaces that speak the coordinator persona's contract, read directly in the design session: `bin/supervise.sh` (the worker steer instruction and the coordinator role instruction around lines 1540 to 1600, the `COORDINATOR_PERSONA` export at 359 to 370); `hooks/index.ts` (`coordinatorPersona` resolution at 820 to 823, the reach checks at 4420 and 4462, the delivery ground at 1586 and 1687); `hooks/operator.ts` (`mayReachPersonaIn` and `deliveryGroundIn`, the reach rule itself); `.kit/settings-plugin-key-test.sh` (the `coordinatorPersona` round trip); `README.md` (the coordinator launch paragraph at 48, Delivery and Trust boundary at 434 to 452, the coordinator standing instructions the archived coordinator plan's Section 8 states); `.kit/channel-reply-instruction-test.sh`; `docs/archive/agent_persona_coordinator_v2.md` (the persona this plan splits); the launchers under `D:/personas`; the kit's role and coordinator skills, whose seat this plan folds; and the machine's registry under the kit's coordinator directory, which shows the kit's Coordinator seat taken only by interactive sessions so far and never by the coordinator persona.

**Order.** After the process keeper plan, because the fleet-health duty reads the roster and `keeper.json` that plan creates. Section 1 and Section 2 in either order, then 3, then 4, then 5.

## Sections of Work

### 1. The steward's launch shape and standing instruction
Model: opus

In `bin/supervise.sh`, extend `COORDINATOR_ROLE_INSTRUCTION` with the three duties in the Approach, in the same register and length discipline as the sentences it already carries, and keep every existing sentence. Change nothing in how the instruction is selected: it is still built when the launch's persona equals the `coordinatorPersona` value, so a launch under the name `steward` with that setting gets it. Update `README.md`'s coordinator launch paragraph to the steward's shape (Sonnet, the five-minute tick, the name), and the archived coordinator plan is left as history.

Acceptance: `.kit/channel-reply-instruction-test.sh` gains cases pinning that the persona named by `coordinatorPersona` receives the three new duty sentences and a named worker does not; the existing cases pass unchanged; the README paragraph states the steward's shape.

Files in scope: `bin/supervise.sh`, `.kit/channel-reply-instruction-test.sh`, `README.md`.
Tests: at minimum, lock each new duty sentence present for the coordinator persona and absent for a worker and for `default`, since a duty sentence leaking into a worker's priming would have workers probing the registry.

### 2. The architect's launch shape and standing instruction
Model: opus

In `bin/supervise.sh`, add an `ARCHITECT_PERSONA` setting beside `coordinatorPersona`, emitted into the settings file the supervisor writes and read back from a provided one by the same two branches, and an `ARCHITECT_ROLE_INSTRUCTION` built when the launch's persona equals it, stating the charter in the Approach. The instruction names the two ways an ask arrives (a `[COORDINATOR ...]` record from the steward, or the operator on the architect's own thread), the worktree rule, the commit-and-report rule, and the never-execute rule. Add the persona to `README.md` beside the steward.

Acceptance: `.kit/channel-reply-instruction-test.sh` pins the architect instruction present for the architect persona and absent for every other; `.kit/settings-plugin-key-test.sh` pins the new setting emitted and read back under both plugin ids as `coordinatorPersona` is; a launch with `ARCHITECT_PERSONA` unset builds no architect instruction for any persona.

Files in scope: `bin/supervise.sh`, `.kit/channel-reply-instruction-test.sh`, `.kit/settings-plugin-key-test.sh`, `README.md`.
Tests: at minimum, lock the instruction's presence and absence per persona and the setting's round trip through the settings file, both directions, since a mis-set persona name would launch a Fable session with a worker's charter.

### 3. The fleet status tool
Model: opus

Add a `fleet_status` tool to the plugin (`hooks/index.ts`, beside `agentic_inbox`), available under the plugin's reach rule with the coordinator persona as the target: the caller holds the coordinator persona or a live reader claim on it, which is what `mayReachPersonaIn` in `hooks/operator.ts` already states. It reads the roster at the path a new `fleetRoster` setting names, each roster persona's `keeper.json` under that persona's run directory, enabled or not, and each persona's commons entry, and returns one row per roster persona: name, enabled, keeper action and delay, hold reason if any, last supervisor exit, commons claim held or not, heartbeat age, and turn state. `keeper.json` is the process keeper's state file and carries the persona name, launch count, last start and end, last exit code, current delay and the hold reason if any; the commons entry carries the claim's last-seen stamp, from which the heartbeat age is derived, and the turn state. The implementer opens `docs/plans/agent_persona_process-keeper_v1.md` for the roster and state-file layout. A missing roster or a missing `keeper.json` is a row that says so, never an error that hides the other rows.

Acceptance: a unit test drives the tool with fixture files for a healthy persona, a held one, one backing off, one with no `keeper.json`, and one absent from the commons, and checks each row; the tool is denied to a session that does not hold the coordinator persona, with the deny text naming the rule.

Files in scope: `hooks/index.ts`, `hooks/operator.ts` (the reach rule), a new `.kit/fleet-status-unit-test.mjs`, `README.md` (the tool list under the operator channel section).
Tests: at minimum, lock every row shape above and the deny direction, since a worker reading fleet state would be a reach the trust boundary does not grant.

### 4. The kit Coordinator seat under the steward, proven live
Model: opus

A live check that launches a real child, so it runs under the README's rule for live suites: only with the operator's yes while the fleet is up. Write `D:/personas/steward/launch.sh` in the shape of the coordinator's launcher with the steward's model, tick and name, launch it by hand, and watch the child take the kit's Coordinator seat. The seat's artifacts live under the kit's coordinator directory in the memory store, `~/.claude/coordinator/<machine>/`: `board.md` is the board and `registry/<session-id>.md` is one entry per registered session, per the kit's role skill. Acceptance, each read from the artifact: a registry entry under the kit's coordinator directory whose `Name:` is the machine's Coordinator seat name and whose `Session:` is the steward child's session; a board line from the steward's first reconciliation pass; and a registry prune of at least one exited entry with its board line, the machine's registry holding dozens of exited entries at the time of writing. Where the role skill cannot be invoked from a `claude -p` child, the Chapter says what failed and the seat stays with interactive sessions, which is a design stop for the operator rather than a fix round.

Files in scope: none in the tree beyond the Chapter; `D:/personas/steward/launch.sh` (machine state, kept by Section 5); reads of the kit's role and coordinator skills and the machine's coordinator directory.

### 5. Cutover, roster, and the retired persona
Model: sonnet

Update `bin/fleet.example.json` and the machine's `D:/personas/fleet.json`: replace the `coordinator` entry with `steward` (model `sonnet`, `controllerTickMs` 300000, `coordinatorPersona` `steward`, `channelName` `steward`) and add `architect` (model `fable`, `effort` `high`, workdir `D:/personas/architect`, `channelName` `architect`). Keep the steward's launcher Section 4 wrote and write `D:/personas/architect/launch.sh` beside it, as the manual fallbacks in the shape of the existing launchers. Re-adjudicate the pending-record backlog entry named in the Approach and either retire it into the quarter's backlog snapshot, `docs/archive/backlog-2026-Q3.md`, with receipts, per the curating-docs prune path, or re-date it. Update `docs/README.md`'s index line for this plan.

Acceptance: `bin/Register-PersonaTasks.ps1 -WhatIf`, the process keeper's registration script, prints a definition for `steward` and `architect` and none for `coordinator`; each launcher matches its roster entry by eye, recorded in the Chapter; the backlog entry is retired or re-dated with the reason.

Files in scope: `bin/fleet.example.json`, `docs/backlog.md`, `docs/README.md`, `D:/personas/fleet.json` and `D:/personas/architect/launch.sh` (machine state).

## Out of Scope

- The kit resolving a session's instructions, memory and leash from the repository it works in rather than its launch directory. That is the next plan, for the session that maintains the `claude-kit` repository, and it is what lets the architect hold a repository's Expert seat properly.
- Any change to workers' charters or launch shapes.
- The steward relaunching a stuck persona itself. The process keeper owns relaunch; the steward reports.
- A model switch inside one persona's life.
- Moving the steward or the architect to another machine.

## Assumptions

- assumed 2026-09-15 (source: the operator's words on 2026-09-15, "Coordinator should fold into Steward. And it should probably run Sonnet"): the coordinator persona is renamed to `steward` rather than kept under its old name with new duties, since the name states the job; reversal: keep the name `coordinator` in the roster and the setting, and no worker needs relaunching for the steer target.
- assumed 2026-09-15 (default): the steward's tick is five minutes; reversal: one roster value.
- assumed 2026-09-15 (default): the architect is homed at `D:/personas/architect` with no repository, per the operator's words that the fleet should be a few workers with one or two homed; reversal: a workdir change in the roster.
- assumed 2026-09-15 (source: `README.md` Delivery, read 2026-09-15): a record delivered to a persona starts a turn on that persona's next quiet tick, which is the whole wake mechanism; reversal: if a passive architect does not wake on delivery, Section 2 adds a nudge and the Chapter records it.
- assumed 2026-09-15 (default): fleet health is a plugin tool rather than prose telling the steward to read files, because a Sonnet session following a file-reading recipe every five minutes is the failure this plan exists to remove; reversal: drop Section 3 and the duty sentence reads the files by hand.
- assumed 2026-09-15 (default): the executing session runs on this machine, where the launchers under `D:/personas` and the kit's coordinator directory exist; reversal: none, since the paths are parameters of the process keeper's scripts.
- assumed 2026-09-15 (default): this plan is parked until the operator has read it, since the four decisions it rests on were given in outline and the section shapes above were not shown to the operator before writing; it carries no Dispatch Authorization section and arms on the operator's word.

## Operator Verification

1. After the cutover, post a design ask on the architect's thread naming a repository. A spec lands in that repository's `docs/plans` on a branch within the hour, and the architect reports the branch and the filename on its thread.
2. Ask a worker, on its own thread, to escalate a question its plan does not cover. The steward's thread reports the escalation and that it went to the architect, and the architect's thread shows the record arriving.
3. Shut one worker down through its tool. Within one steward tick the steward's thread reports that persona as held, and reports nothing further about it until its state changes.

## Open Questions

- The rename to `steward` is assumed above and every section is written to it, so the plan is executable as it stands. The operator may reverse it before the plan arms, at the cost the assumption names. Recommended: keep the rename, because the name should state the job and the cost is one relaunch per worker at the cutover the process keeper plan already schedules.
- Whether the architect takes the kit's Expert seat for the repository it works in. Recommended: only once the kit-resolution plan lands, since until then the seat's registry entry would name the wrong repository. The kit session's call after that plan.
- Whether the steward should also hold the kit's Admin seat, whose inbox poll is a four-hour loop of the same clerical shape. Recommended: not in this plan; revisit after a month of the steward's boards.

## Related

- `docs/plans/agent_persona_process-keeper_v1.md`: the process keeper, which this plan follows and whose roster and `keeper.json` the steward reads.
- `docs/archive/agent_persona_coordinator_v2.md`: the coordinator persona this plan splits.

## Chapters
