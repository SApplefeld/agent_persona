# Agentic Plugin

PIANO-esque cognitive layer on Claude Code's Function Hooks API. One plugin module, one `register(on, options)` export, no Agent SDK. The plugin needs no supervisor to run one session; `bin/supervise.sh` is the optional outer loop for runs longer than one session. Modules observe at hook boundaries and write to shared `AgentState`; the Controller : the sole actuator : runs on a clock, classifies the situation, and then (and only then) actuates through exactly three channels.

## Quickstart

A fresh clone, one command, a waiting supervisor.

**Install the plugin** (once per machine):

```
claude plugin marketplace add SApplefeld/agent_persona
claude plugin install agentic-plugin@agent-persona --scope user
```

`claude plugin update` re-fetches from GitHub, so the installed runtime always tracks merged `main` rather than whatever happens to be checked out in any one clone. The manifest at `.claude-plugin/plugin.json` carries no version field on purpose. Claude Code installs each plugin under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. A manifest that names a version installs under that name and is rebuilt only when the name changes, so every persona keeps running the commit of the last bump however many commits merge behind it. A manifest that names none installs under the fetched commit's hash instead, one folder per update, which is the shape the kit plugin already uses. Registering the marketplace from a local directory (`claude plugin marketplace add /path/to/this/clone`) instead makes `claude plugin update` copy that directory's working tree verbatim, uncommitted edits included - useful only for developing the plugin itself, alongside `--dev` below, never for running it.

**Start the supervisor** (passive, no goal yet):

```
bin/supervise.sh /path/to/a/workdir dev bypassPermissions
```

The workdir is where the persona store, heartbeat sidecar, and `run/` logs live; it can be this clone or any other directory. The supervisor changes into it itself, so the command above works from anywhere. It idles, holding its persona and heartbeating, until a goal arrives.

By default the child is also directly reachable from Discord: it attaches to the relay in `D:\discord-channels` under a thread named `supervisor-<persona>` (stable across restarts; override with `--channel-name NAME`). Pass `--no-channel` for a scratch run with no Discord side effects.

**Give it a goal**, by talking to it in plain language, no tool names needed - either as the child's first `--prompt`:

```
bin/supervise.sh /path/to/a/workdir dev bypassPermissions --prompt "write three short essays about the sea, the mountain, and the sky"
```

or, once it's already running passively, by talking to its Discord thread (attached by default at launch; pass `--no-channel` to skip it). The worker opens a goal tree, plans it, and replies with the one-line goal it took.

**Steer it mid-goal** by talking to it: "drop the second plan," "pause that for now," "add a task to also write a title." The worker answers each with what it changed, in the goal tree and the decision log both.

**Stop it.** Two ways to end a run, and only one of them ends the supervisor: an explicit "please shut down" (which the worker turns into a `supervisor_shutdown` call) exits the whole supervisor loop cleanly. Just finishing a goal does not - the supervisor returns to passive and waits for the next one. To kill it from outside, `Ctrl-C` or `kill` the `supervise.sh` process; it stops the child via the graceful EOF path first, then TERM, then KILL if it doesn't respond.

**Restart it without stopping it.** "Please restart" (which the worker turns into a `supervisor_restart` call) relaunches the child by the same graceful EOF path and keeps the goal tree, so the fresh child resumes the active plan. This is how a pulled runtime update (`claude plugin update`) is picked up mid-run: one message from a reader, no supervisor restart.

**Reach it while it is busy.** A message sent while the worker is inside a long turn waits for that turn to end; the sender's next `agentic_inbox` shows the record as `deferred` with `turnRunningMs`, how long the turn has run. A message still undelivered past the wait bound breaks into the running turn on its own, as context on the worker's next tool result, unless it is labelled a coordinator record at delivery, which the plugin decides from the sender's live claims at that moment; an unflagged coordinator record waits for the tick. `urgent: true` breaks in immediately, without the wait, from any sender. A message delivered on its wait alone is not replied to: the worker closes it with `agentic_resolve`, and the sender reads that outcome on `agentic_inbox`.

**Where the logs are.** `<workdir>/run/supervisor.log` is the supervisor's own narrative (gate checks, launches, restarts, stops). `<workdir>/run/child-N/stdout.jsonl` is child N's full stream-json transcript; `stderr.log` and `claude-debug.log` sit beside it. `<workdir>/.agentic-personas.json` and `.agentic-heartbeat.json` are the persona store and liveness sidecar.

**Working on the plugin's own code** instead of just running it: pass `--dev` to `supervise.sh`, which loads this checkout directly (`--plugin-dir`) instead of the installed copy, so edits here take effect on the next launch with no reinstall.

**Launch the steward**, a second supervised session whose owner may address every persona's inbox:

```
MODEL=sonnet controllerTickMs=300000 COORDINATOR_PERSONA=steward ARCHITECT_PERSONA=architect bin/supervise.sh /path/to/a/workdir steward bypassPermissions --rundir /path/to/a/rundir --channel-name steward
```

The persona argument and `COORDINATOR_PERSONA` name the same persona, so the steward is the coordinator persona the plugin's reach rule names. `ARCHITECT_PERSONA` names the design seat the steward routes design asks to, and the steward's launch carries it because that clause of its instruction is built from the name: a steward launched without it is told to route nothing, which is right for a fleet with no architect and wrong for one that has it under another name. The two names must differ, and a launch naming one persona for both seats is refused. The thread name defaults to `supervisor-<persona>`; `--channel-name` replaces it with a name of the operator's choosing, here `steward`, separate from any worker's. `controllerTickMs` is five minutes, thirty times the supervisor default. The steward's work is clerical, a delivered record still lands on its next quiet tick, and an urgent record breaks into a running turn, so a slower tick costs response time only while it is idle. The model is Sonnet for the same reason. The launch omits `--dev`, since the steward loads the same installed copy every worker does.

Every worker and the architect launch with the same `COORDINATOR_PERSONA` value the steward carries. The name is what the reach rule matches on, so a worker left on the default sends its escalations to a persona nothing holds, and the steward's own steers reach that worker with no delivery ground and are skipped. The roster's per-entry `coordinatorPersona` field is where the fleet sets it.

The steward's standing instruction carries three duties beyond directing workers. It answers a prompt labelled `[FLEET]`, which carries the personas whose health class changed, and reports each of them on its own channel; the classes are held, backing off, stale, no live claim while the roster enables it, and healthy, and `fleet_status` stays available as an on-demand read. It holds the kit's Coordinator seat, takes that seat at priming, and runs the seat's reconciliation pass on a prompt labelled `[RECONCILE]` and at no other time. And it sends a record that turns on a design decision to the persona `ARCHITECT_PERSONA` names, confirming an architect is live before it calls the ask routed and raising an undelivered ask to the operator instead; the architect answers the steward, which relays the answer onward, so the architect never addresses a worker directly.

**Launch the architect**, the design seat the steward wakes:

```
MODEL=fable EFFORT=high controllerTickMs=60000 COORDINATOR_PERSONA=steward ARCHITECT_PERSONA=architect bin/supervise.sh /path/to/the/architects/own/directory architect bypassPermissions --rundir /path/to/a/rundir --channel-name architect
```

The persona argument and `ARCHITECT_PERSONA` name the same persona, which is what gives this launch the architect's standing instruction. `ARCHITECT_PERSONA` has no default, unlike `COORDINATOR_PERSONA`: a launch whose settings carry no architect name builds that instruction for no persona at all. The setting travels the same two paths the coordinator's name does, written into the settings file the supervisor emits and read back from one the operator provides, so a name set once in a rundir survives every relaunch.

The model is Fable and `EFFORT` is high, since design judgment is the whole of this seat's work. The workdir is the architect's own directory and is not a repository. Its instruction says so: an ask whose product is a file in a repository, a spec, a plan or an assessment, is worked in a worktree the architect cuts of that repository under its own directory, on a branch it commits and pushes, and it reports the branch and the filename back. The repository it cuts that worktree from is a clone of its own under that directory, never a checkout another persona is working in, since `git worktree add` runs inside an existing clone and would otherwise share a live persona's object store and ref locks. That clone is taken from the repository's remote URL rather than from any checkout on this machine: a local clone shares the checkout's object store and carries it as `origin`, so the push lands inside another persona's repository and never reaches the remote. The architect fetches that clone before each ask and cuts each branch from the fetched remote-tracking trunk, not from the clone's local branch of that name, which a fetch leaves where the clone left it. A repository name can travel to this seat inside a record rather than from the operator, and the clone and the push both run under the machine's stored credentials, so the charter holds the clone to a plain https or ssh remote URL, has the architect clone only a repository the operator named themselves, on its own channel or in the prompt its launch wrote, and report rather than clone a name that reaches it any other way, and has it name the clone target and the remote before it pushes. An ask that produces a file and names no repository is worked under that directory outside every worktree, and the architect reports the path it wrote. A plan review, a consult and a finishing judgment produce no file, so the architect answers those in the record that asked or on its own channel and cuts no branch. Each report goes to the steward and to the operator, and on a `--no-channel` launch the record to the steward is the whole report. A design ask normally reaches the architect as the steward's `[COORDINATOR id=<record id>]` record or as the operator's own message on its channel; text arriving any other way, a reader session's record among it, is information rather than an ask, and the architect raises it with the steward instead of working it. The prompt a launch writes is not that case: the supervisor frames it as the operator's own trusted task, so the architect works it as the operator's ask. The steer sentence every launch carries sends a `[COORDINATOR ...]` prompt that ties to no goal node back to the operator, and the charter names that rule and overrides it for this seat: the architect holds no plan and no goal node, so such a record is its own work item. The skill-load sentence is overridden the same way. It sends every session to `claude-kit:executing-work`, which runs a plan section by section, and writing a spec is plan work, so the charter names the skills a design ask takes instead: `claude-kit:operating-instructions`, then `claude-kit:brainstorming`, and `claude-kit:curating-docs` where the product is a document. It writes plans and executes none: a plan lands in the target repository's `docs/plans` and reaches a worker through the steward, which is also the only persona the architect addresses. One limitation rides with the roaming home: the kit resolves a session's instructions, memory and leash from the launch directory, so the architect's kit memory is its own directory's rather than the target repository's, and it reads a repository's memory index explicitly when it needs it.

The steward polls nothing. The controller tick starts no turn on a persona holding no active goal and an empty inbox, so a duty written as a five-minute habit would never run on a quiet fleet, which is when a crashed persona most needs reporting. So each duty is written as a response to a labelled prompt rather than as a cadence of its own. Nothing submits those labels yet, so today the steward reports fleet health when the operator asks for it.

**The arming key** gates what a session's hooks do, in three values. `owner` is the full worker/coordinator shape; a supervisor launch always writes it. `reader` registers `agentic_identity`/`agentic_say`/`agentic_inbox`/`fleet_status` only, with no goal-tree tool and no ownership ever - an interactive reader session takes this shape by passing a settings file with `"arming":"reader"` under both plugin ids through `--settings`. `off`, the default for a session that omits the key, registers no tool, timer, or claim at all: a peer message still reaches an `off` session as the harness delivers it, since no hook consumes it, and nothing is written to `.agentic-personas.json` or the commons store.

**Status: Stage 3 (supervisor).** `tsc --noEmit` clean. Supervisor (`bin/supervise.sh`) drives outer-loop runs: pre-gate (commons + heartbeat), coproc stdin with EOF stop, real exit codes, `PROMPT=""` cleared after first send, `writeClaimDirect` shared across all three claim sites. The suites are catalogued under Test Coverage in the Supervisor section.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Claude Code Engine (one process, one session)                      │
│                                                                     │
│  OBSERVE (modules : never actuate):                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │    Memory    │  │   Monitor    │  │    Goal      │             │
│  │ (distill +   │  │ (turn track, │  │ (score,      │             │
│  │  inject)     │  │  tool count) │  │  constraint) │             │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘             │
│         │                 │                 │                       │
│         ▼                 ▼                 ▼                       │
│  ┌──────────────────────────────────────────────────┐              │
│  │         AgentState (on disk, keyed by persona)   │              │
│  │         + heartbeat sidecar (.agentic-heartbeat) │              │
│  └──────────────────────┬───────────────────────────┘              │
│                         │                                           │
│  ACTUATE (Controller : sole actor):                                 │
│  ┌──────────────────────▼───────────────────────────┐              │
│  │  $.clock.every(tick) → idle gate (nudgeIdleMs)   │              │
│  │  → compressed summary                            │              │
│  │  → $.model.classify (decision)                   │              │
│  │  → $.model.complete (reason, only if ≠ nudge)    │              │
│  │  → log to state.decisions[]                      │              │
│  │  → THEN actuate:                                 │              │
│  │     1. context injection (prompt.submit, always) │              │
│  │     2. $.prompt.submit nudge (floor + cap)       │              │
│  │     3. $.ui.toast ask-operator                   │              │
│  └──────────────────────────────────────────────────┘              │
│                                                                     │
│  Identity: agentic_identity tool → persona (durable key)           │
│  Liveness: heartbeat sidecar, NOT store lastSeen                   │
└─────────────────────────────────────────────────────────────────────┘
```

### The PIANO principle

**P**assive observation, **I**mplicit state, **A**ctuation is explicit, **N**on-destructive hand-off, **O**perator-visible.

- **Modules** (Memory, Monitor, Goal scorer) observe at hook boundaries and write to `AgentState`. They **never** steer, redirect, or actuate.
- **Controller** is the sole actor. It runs on `$.clock.every`, applies the idle gate, builds a compressed summary of shared state, sends it to `$.model.classify` for the decision (classify *cannot* return anything else : this is the architectural enforcement), optionally calls `$.model.complete` for a reason (only when the decision is not `nudge`), logs it, **then** actuates.
- **Exactly three actuators**, controller-only: context injection (always on, free), `$.prompt.submit` nudge (floor + cap gated), `$.ui.toast` ask-operator.

### Controller decision

The controller tick builds a summary with **defined labels** (C1):

| Label | Meaning |
|---|---|
| `goal` | The active goal, status, objective, rounds |
| `last_on_goal` | Last turn scored on-goal (minutes ago) |
| `last_off_goal` | Last turn scored off-goal (minutes ago) |
| `consecutive_nudges` | Nudges **sent** without an on-goal turn since |
| `minutes_since_last_on_goal` | Wall-clock gap |
| `memory_count` | Memory entries in state |
| `turns_total` | Total turns this session |
| `idle_minutes` | Minutes since last turn completed (L1) |

The classify labels are: `nudge`, `pause`, `complete`, `ask-operator`.

**L1**: The idle gate is enforced **in code**, not in the prompt. The tick computes `idleMs = now - lastTurnComplete` and only proceeds to a model call if `idleMs >= nudgeIdleMs`. The model decides **what** (nudge/pause/complete/ask-operator), never **whether** : the threshold is a hard gate.

**C2**: `$.model.classify` returns the decision (one of the labels, nothing else). `$.model.complete` is called **only** when the decision ≠ `nudge`, to get a one-line plain-text reason (no Markdown). Never one call doing both.

**M13**: The nudge cap is checked **before** the classify call : if the cap is already reached, the tick escalates to `ask-operator` immediately without spending a model call.

### Nudge discipline (H2, L1)

- **Floor**: at most one nudge per `nudgeFloorMs` (default 5 min).
- **Cap**: 3 consecutive **sent** nudges without an on-goal turn → escalate to `ask-operator` + pause the goal. The counter increments only when `$.prompt.submit` actually fires (not on floored skips). Resets only on an on-goal score or `complete`.
- **Idle gate**: session must be idle for `nudgeIdleMs` (default 2 min) before any model call. Ticks inside the gate are skipped entirely.
- **Skip**: no active goal or a turn in flight → skip the tick entirely.
- **Visible**: `$.ui.status` shows the goal line while a goal is active; cleared on pause/complete/blocked.
- **H8: Nudged-turn scoring.** When the controller nudges, `$.prompt.submit` bypasses the plugin's own `prompt.submit` hook, so `currentPrompt` is set to the nudge text manually. The `turn.complete` scorer uses a reduced label set (`on-goal`, `drift`, `complete`) for nudged turns : `off-goal-by-instruction` is impossible because the nudge *is* the instruction.

### C4: Clock is enough

The K-turn trigger (every Nth turn triggers a controller evaluation) is **removed**. The clock tick is the sole trigger. Simpler, fewer race conditions.

### Liveness: heartbeat sidecar (C5, M3, L3)

`.agentic-heartbeat.json` in the project root: `{ "<persona>": { sessionId, epoch, lastSeen }, ... }`.

- **Heartbeat** refreshes the sidecar every `heartbeatMs` (default 30s). Never touches the persona store.
- **L3: Owner-only heartbeat.** Only the owner stamps its own heartbeat. A passive reader must **not** overwrite the holder's heartbeat, or it will (a) mask the real holder's staleness and (b) make its own promotion check compare the holder id to itself and never fire.
- **Claim is non-destructive**: the epoch bump makes the old holder **yield on its next write** (guarded write checks the store). No store read-modify-write at claim time.
- **H6: Pre-stamp yield.** Before stamping, the owner verifies ownership by reading the store. If the store's `(sessionId, epoch)` no longer matches, the session yields here (not on its next write) and does **not** stamp. This prevents a demoted owner from overwriting the new owner's heartbeat.
- **Passive reader** re-checks the sidecar on every heartbeat tick and **promotes itself** if the holder is stale (beyond `staleAfterMs`, default 90s) and is not self. With the H6 pre-stamp check, the sidecar is only ever written by the store's current owner, so a stale sidecar means no live owner : no store-owner comparison needed.
- **`lastSeen` is NOT a liveness proof.** It proves the holder stopped stamping, never that it exited. A claim is an *intent*, not a *fact*.
- `lastSeen` is **removed** from `AgentState` (M8, M9). It lives only in the sidecar.

### H4: No session-end event

This build has no `session.end` hook. A session that exits without a clean shutdown leaves its heartbeat entry in the sidecar. The **stale window** (`staleAfterMs`, default 90s) is the only release mechanism: after the holder stops stamping, the entry goes stale and a passive reader can promote. There is no immediate cleanup on exit.

### Yield (non-destructive hand-off)

The **only** store write path is the guarded write : owner-only, epoch-checked. If the store on disk shows a different session or higher epoch, this session:
1. Logs `persona_yield` to `state.decisions[]` (in memory, not persisted to the winner's doc).
2. Appends a JSON line to `.agentic-yields.log` (the sidecar).
3. Sets `isOwner = false`. All subsequent writes are no-ops.
4. Emits `$.ui.log` so the yield is visible in the TTY.

The yield logic is extracted into pure helpers `shouldYield(onDisk, mySessionId, myEpoch)` and `yieldRecord(persona, mySessionId, onDiskSessionId, myEpoch, onDiskEpoch)` in `agent-state.ts`. All six call sites in `index.ts` (controller tick, turn.complete save, goal_create, memory_add, Bash deny, **heartbeat pre-stamp**) use them. Only `$.fs` I/O remains inline.

**Yield log format (H7):** JSONL : one JSON object per line:
```json
{"ts":"2026-09-06T12:00:00.000Z","persona":"default","yielded":"abc123","yieldedEpoch":3,"winner":"def456","winnerEpoch":4}
```

### Memory (M1, M2)

- **Curation prompt** (M1): "description of what happened = discard" and "durable fact, reply NONE if none".
- **Classify every turn** (M2): the kind-classify runs on every `turn.complete`. The `complete` call for the distilled statement runs **only** when the kind is not `discard`.
- **MEMQ seam**: `$.mcp.call("MEMQ", "rank", ...)` is wired in `prompt.submit`. Falls through to local confidence ranking if no MEMQ server responds.

### Identity: persona, not session

The durable key is a **persona** (e.g. `default`, `refactorer`), not the session id.

- **Store**: `.agentic-personas.json` in the project root.
- **Heartbeat sidecar**: `.agentic-heartbeat.json` (separate file, separate concern).
- **Yield sidecar**: `.agentic-yields.log` (append-only JSONL).
- **Concurrency**: `activeSessionId` + monotonic `epoch` in the store. Heartbeat sidecar for liveness. Guarded write for safety.
- **Default**: persona is `default` when no assignment is made.

### L2: Deny policy

When a session attempts to claim a persona held by a live session, the deny text is:

> `Persona '<p>' is held by a live session; this write was not saved.`

**No instruction** to claim back, reclaim, or retry. The reader stays denied until the operator explicitly says otherwise (via `agentic_identity` with a new persona, or by waiting for the stale window). This is **not** last-claimer-wins.

### `userConfig` overrides (H3)

Declared in `plugin.json` with defaults. Read as `options.<name>` in `register(on, options)`.

| Key | Default | Description |
|---|---|---|
| `persona` | `default` | Which persona this session claims at start. `bin/supervise.sh`'s second positional argument is threaded into this option; without it, every session claims `default` regardless of what's passed on the command line. |
| `heartbeatMs` | 30000 | Heartbeat interval (ms) |
| `staleAfterMs` | 90000 | How stale before a passive reader can claim (ms) |
| `controllerTickMs` | 30000 | Controller tick interval (ms) |
| `nudgeFloorMs` | 300000 | Minimum gap between nudges (ms) |
| `nudgeIdleMs` | 120000 | Session must be idle this long before a nudge is eligible (ms) |
| `arming` | `off` | `off`, `reader` or `owner`; gates which tools, timers and claims this session registers. See "The arming key" above. |
| `coordinatorPersona` | `coordinator` | The one persona name the inbox gates treat as the coordinator. A configured name of `default` is refused and falls back. |

## Loops

1. **Memory** : distills on `turn.complete` (classify kind, conditional complete for statement), persists to `AgentState`, injects on `prompt.submit` as hidden context. Owns `state.memory[]`.
2. **Monitor** : hooks `session.start` (claim persona), `turn.start`/`turn.complete` (track progress), `tool.call` (count calls). Owns `state.monitor` and `state.decisions[]` (capped at 200).
3. **Goal** : hooks `turn.complete` (score against goal), `tool.call` (serve `goal_create`, enforce constraints). Owns `state.goal`. Steering is **exclusively** the Controller's job.
4. **Controller** : `$.clock.every`, idle gate, classifies, optionally reasons, logs, actuates. The only thing that calls `$.prompt.submit`, `$.ui.toast`, or sets the status line.
5. **Worker** : the main agent, unmodified. Sees injected goal + memory via `prompt.submit`'s `context` array.

## Files

| File | Purpose |
|---|---|
| `hooks/index.ts` | The plugin module (one file, all logic) |
| `hooks/agent-state.ts` | `AgentState` interface + defaults + `shouldYield`/`yieldRecord` pure helpers |
| `.agentic-personas.json` | Persona store (project root) |
| `.agentic-heartbeat.json` | Heartbeat sidecar (project root) |
| `.agentic-yields.log` | Yield sidecar, JSONL (project root) |

## Supervisor

`bin/supervise.sh` is the outer-loop supervisor for days-long runs. It takes `<workdir> <persona> <permission-mode>` plus the options `--prompt TEXT`, `--rundir DIR`, `--dev`, `--no-channel` and `--channel-name NAME`, and runs one child at a time: it checks its own settings, gates on the persona being free, launches the child, polls the persona store for signals, and stops or relaunches the child by the decision those signals produce. The supervisor never writes the persona store (invariant §8). It only reads it.

### Startup Checks

Every setting the script reads for itself is checked once at startup, before the run directory exists, and a refusal exits 1 with an `ERROR:` line naming the setting and the value it refused. The persona is checked first, since it is spliced into the child's settings JSON: letters, digits, underscore and hyphen, the same class `valid_persona_name` enforces in `bin/agentic-common.sh`. The model is checked on shape rather than against a list, because model names ship without this script changing: lowercase letters, digits, `.` and `-`, starting with a letter or digit, plus an optional bracketed suffix such as the `[1m]` of `opus[1m]`, admitted only as a matched pair at the end. The effort is one of `low`, `medium`, `high`, `xhigh` or `max`. The `MODEL` and `EFFORT` environment overrides take the same two checks, since they are what reaches the launch flags.

The numeric settings share one rule, `positive_number`: digits only, no leading zero, at most nine digits, and at least a minimum that defaults to 1. A leading zero reads as octal in shell arithmetic, a value past nine digits can wrap 64-bit arithmetic, a non-numeric value turns every `[ -lt ]` comparison into a shell error, and zero collapses every wait to no wait at all. Two settings the script divides by 1000 before use, `supervisorStopGraceMs` and `supervisorPollMs`, take a minimum of 1000, so a value under one second cannot floor to a zero-second wait. `staleAfterMs` is a plugin value the script also reads for itself, as the bound the pre-launch gate and the decide unit use, so it takes this rule on every launch, including a launch where a provided settings file skips the emitter's own check. One setting falls back instead of refusing: an unusable `supervisorPsBoundS` resolves to 30 with no error line, because a bad bound costs process-tree verification rather than the run.

The plugin cadences the script only emits (`controllerTickMs`, `nudgeIdleMs`, `nudgeFloorMs`, `gitProbeMs`, `heartbeatMs`, and the budget, self-review and cost options) take `emit_settings_json`'s own rule in `bin/agentic-common.sh`: a non-negative integer with no leading zero. That rule admits zero and any length, and it runs only when the settings file is written, never when one is provided.

| Setting (environment variable) | Default | Check |
|---|---|---|
| `supervisorModel` | `opus` | model shape; `MODEL` overrides it |
| `supervisorEffort` | `medium` | `low`, `medium`, `high`, `xhigh` or `max`; `EFFORT` overrides it |
| `supervisorPsBoundS` | 30 | shared numeric rule; a bad value falls back to 30 |
| `supervisorStopGraceMs` | 60000 | shared numeric rule, minimum 1000 |
| `supervisorMinRunMs` | 120000 | shared numeric rule |
| `supervisorCrashLimit` | 3 | shared numeric rule; both crash readers stop on it |
| `supervisorMaxRestartsPerHour` | 6 | shared numeric rule |
| `supervisorPollMs` | 10000 | shared numeric rule, minimum 1000 |
| `supervisorPrimingWaitS` | 180 | shared numeric rule |
| `staleAfterMs` | 90000 | shared numeric rule; also emitted to the child |

### Settings File

The child reads its plugin options from `<rundir>/settings.json`, passed on `--settings`. `pluginConfigs` is keyed by plugin id, and the id differs by load mode: `agentic-plugin` under `--plugin-dir` (`--dev`), and `agentic-plugin@agent-persona` for the installed copy. Options under the other id are ignored without an error, and the child then claims persona `default` with default cadences. So `emit_settings_json` writes the same options under both ids, `arming` fixed at `owner` and `coordinatorPersona` from `COORDINATOR_PERSONA` (default `coordinator`; a value of `default` or one outside the persona character class is refused and no file is written), and exports `COORDINATOR_PERSONA` for the priming step. When the run directory already holds a settings file, the supervisor keeps it: `ensure_settings_plugin_ids` copies the options from whichever id carries them to the id that lacks them, every option as the caller wrote it. An id whose options object is missing or empty counts as absent, two ids that both carry options are left byte for byte, and the file is replaced by rename so an interrupted write never truncates it. `ensure_settings_arming` then completes a missing `arming` key to `owner` under both ids, creating `pluginConfigs` and the id entries from nothing where the file lacks them, and refuses a file whose `arming` names another tier, leaving it byte for byte. `read_settings_coordinator_persona` reads `coordinatorPersona` back from the id this launch loads, under the plugin's own rule (a missing key, `default`, or a name that fails the rule resolves to `coordinator`), and exports it as `COORDINATOR_PERSONA`. That rule is far wider than the persona character class: it admits any string that is non-empty after trim, carries no colon, bracket or comma, and holds no whitespace, so a name reading as a sentence passes it. The name is spliced into standing instructions, and the read stays as wide as the plugin's because a narrower one would name a different coordinator than the plugin resolves, so the launch is what refuses: a resolved name outside the persona character class exits 1 with the reason in `supervisor.log` and nothing launched. `architectPersona` travels those same two paths from `ARCHITECT_PERSONA`, held to the same character class and refusing `default`, with one difference: it has no default value, so an unset variable leaves the key out of the emitted file entirely, and `read_settings_architect_persona` resolves a missing or unusable key to the empty string, which is a launch with no architect. That read holds the file's value to the persona character class, the same one the emitter holds `ARCHITECT_PERSONA` to, because the name is spliced into the steward's standing instruction and the settings file sits in a run directory its own persona can rewrite. That read is the supervisor's own; the plugin reads `coordinatorPersona` and never this key. The file's name wins over the launch environment's, and a launch whose environment names an architect the file does not resolve to writes both values to `supervisor.log`, so a rundir written without the key does not silently launch an architect session with no charter. A launch whose environment names no architect writes no such line, whatever the file carries. One persona for both seats is refused on both paths, since the two standing instructions contradict each other in a single priming write. A leading byte order mark is stripped before every read. A file that is not JSON, or whose `pluginConfigs`, id entry or options value is not a plain object, is refused by each of these steps: the supervisor exits 1 and the reason is in `supervisor.log`. A provided file's persona is not reconciled with the launch argument; `docs/backlog.md` records that gap. `.kit/settings-plugin-key-test.sh` pins both ids against the two manifests.

### Pre-Launch Gate

Before every launch the supervisor waits, for 24 polls five seconds apart, for the launch persona to be free in two places: the machine-global commons store for the load mode (`find_global_store` picks the inline store under `--dev` and the installed store otherwise), and the workdir's `.agentic-heartbeat.json`. The commons half counts a `persona:<persona>` claim live while its session's `lastSeen` is younger than `staleAfterMs`. The heartbeat half counts the holder stale once its entry's age exceeds `staleAfterMs`, and an absent file as free. Both halves receive the persona and the bound as program arguments rather than spliced into the program text, so a value carrying code is read as data, and a bound that is not a number counts every holder as live. A store or heartbeat file that fails to parse counts as held for that poll. No store found for the load mode is `GATE FAIL`, exit 2, and a timeout is `GATE TIMEOUT`, exit 2.

### Launch

The child is `claude -p` with stream-json on both ends, started as a coproc so its stdin is a pipe that EOF can close. It loads the installed plugin unless `--dev` adds `--plugin-dir` for this checkout, attaches the Discord relay unless `--no-channel`, and runs with `--model "${MODEL:-$SUPERVISOR_MODEL}" --effort "${EFFORT:-$SUPERVISOR_EFFORT}"`, so the default is opus at medium effort and an exported `MODEL` or `EFFORT` overrides it. `.kit/live-common.sh` exports `haiku` as the live suites' model for exactly that reason. The child's pid is saved from `$!` at launch and every later read uses that copy, because bash unsets the coproc's own variables the moment it reaps the child and the script runs under `set -u`.

Every launch opens with one synthetic priming turn marked `[SUPERVISOR-PRIMING]`. It carries the skill-load instruction and the coordinator steer sentence whatever `--no-channel` says, and the reply-tool instruction when the channel is attached. The steer sentence tells the child what a `[COORDINATOR id=<record id>]` prompt carries (the operator's delegated authority inside the approved plan), that an urgent record and a `[READER:...]` or `[WORKER:...]` prompt carry none, and that a finished or declined steer is closed with `agentic_resolve`. The break-in's wait leg is bounded to match that sentence: it never delivers a coordinator-ground record, so `, urgent` is the only marker a coordinator bracket reaches a tool result with, and the sentence covers every coordinator form the worker can meet there. A launch whose persona is named and is not the coordinator persona gets one more clause on that sentence: findings and declined steers go to the coordinator through `agentic_say` with `persona` set to the coordinator's name. A launch whose persona is the coordinator persona gets the coordinator role instruction instead, which states how it directs workers, reads their state from files, counts rounds per steer against resolutions and stops at two, and raises the rest with the operator. The same instruction has it bank a compaction boundary at the end of every turn whose state is on disk, by running the kit checkpoint CLI's `boundary` verb from its working directory, so the kit's PreCompact gate lands the next automatic compaction at that declared point rather than holding it to the safety ceiling. The coordinator holds no kit goal, so the leashed worker's chapter checkpoint never opens for it and this is the goalless path the kit states for such a seat. The comparison is against the `COORDINATOR_PERSONA` the settings step exported, so it sees the name the plugin will resolve. A launch whose persona is the `ARCHITECT_PERSONA` that same step exported gets the architect's charter on that write instead: the design seat, the two ways an ask reaches it, the worktree it cuts for an ask whose product is a file, the branch it reports, the review or consult it answers with no branch at all, and the plans it writes and never executes. That setting has no default, so a launch reading a settings file that names no architect builds the charter for no persona at all. A `--prompt` goes to child 1 only, as its own second turn: the supervisor waits up to `supervisorPrimingWaitS` for the priming turn's `result` line, then writes the goal framed as the operator's trusted task. On a timeout it writes the goal anyway, and when the child has already died it skips the write. A child gone before its stdin could be written to is logged and falls through to the accounting below. The prompt is cleared after that first send, so a relaunch never inherits it.

### Poll Loop

Every `supervisorPollMs` the supervisor reads the persona store and the heartbeat and hands one snapshot to `bin/supervise-decide.mjs`, a pure function with no I/O: the newest `root_complete` together with whether its detail text contains `backfilled`, the newest `shutdown_requested`, `restart_requested` and critical `context_budget_crossed`, the heartbeat's session id and `lastSeen`, the modification time of the child's own harness transcript, and the counters. The decision's priority order:

1. `stop_budget`: the restart count reached `supervisorMaxRestartsPerHour`. Exit 4.
2. `stop_crash_loop`: `supervisorCrashLimit` consecutive crashes, the same limit the natural-exit path reads. Exit 3.
3. `stop_complete`: a `shutdown_requested` newer than the child's start. Exit 0.
4. `restart_passive`: a `restart_requested` newer than the child's start. The child is stopped and relaunched with the goal tree kept, with no crash or restart accounting.
5. `restart_passive`: a `root_complete` newer than the child's start that is not backfilled. The goal is done, and the supervisor returns to passive with a fresh child, again unaccounted.
6. `restart`: a critical budget crossing newer than the child's start, or a hung child, which is a heartbeat for the child's own session older than `staleAfterMs` once `staleAfterMs` has passed since launch. A stale heartbeat alone does not settle it. The transcript the harness writes for that session is the second instrument, and it is one the child does not write itself: a transcript whose modification time sits within `staleAfterMs` of the poll's own clock, in either direction, says the child is alive and the supervisor continues. A transcript as stale as the heartbeat, one further ahead of the poll's clock than the bound, or one that cannot be read leaves the restart standing. The corroboration reaches the hung reading only; a critical budget crossing restarts whatever the transcript says. Accounted: a crash when the exit was non-zero inside `supervisorMinRunMs`, and one more restart in the hour either way.
7. `continue`.

A backfilled `root_complete` is the hook's backstop for a turn that did tool work with no active goal tree, and it is not a completion. The child keeps running, and only the triggers below it can restart it. The reader, `get_root_complete`, takes the timestamp and the flag from one read of the newest `root_complete`, so a real completion followed within one poll by a backfilled one reads as backfilled; `docs/backlog.md` records that.

### Natural Exit

When the child exits on its own, the supervisor reads the store once more and takes the first match in this order: a `shutdown_requested` newer than the child's start ends the run with exit 0; a `restart_requested` newer than the start relaunches unaccounted; a `root_complete` newer than the start relaunches unaccounted, logged as `RESTART_PASSIVE` when the root is real, and as a `NOTE:` line naming the backfilled root when it is backfilled and the child exited 0. Every other exit is accounted. The crash counter increments when the exit was non-zero and the child ran less than `supervisorMinRunMs`, and resets to zero otherwise; the restart count is the number of restarts in the trailing hour. The budget is checked before the crash limit: exit 4 at `supervisorMaxRestartsPerHour`, then exit 3 at `supervisorCrashLimit`. A backfilled root with a non-zero exit takes this accounted path like any crash. A backfilled relaunch has no rate bound of its own, which is on `docs/backlog.md`. Both branches above sweep before they act: the sweep kills every process named in the tree record the poll loop built while the child was alive, and confirms each one dead. What the two do with a failed sweep differs. The shutdown branch exits 0 whatever the sweep found, because exit 0 is what the keeper reads as the shutdown being honored, and a survivor there is recorded as a `NOTE:` line and nothing more. Every other branch ends the run at exit 5 rather than relaunching beside a process it could not confirm dead. The sweep reaches only what the record names, so a process the child started after the last walk is never in it, and a child that died before any walk saw a process under it leaves nothing to sweep at all; both gaps are on `docs/backlog.md`.

### Stop Phases

Every stop path calls `stop_child`. A failed tree kill is retried against a 30-second budget that is checked before each attempt, so one slow attempt can end past it. Every path except the cleanup trap then waits for the child's real exit code. The stop runs in phases. A phase counts as stopped only once every process in the snapshot is verified gone; a phase can also end unverified or failed, and the stop falls through to the next one.

- It snapshots the child's Windows process tree first, recording each process's pid and start time.
- It sends EOF by closing the coproc write end, then waits `supervisorStopGraceMs`.
- It sends TERM to the wrapper, then waits another `supervisorStopGraceMs`.
- It force-kills each snapshot process still matching both its pid and its start time.
- A survivor of a resolved snapshot gets up to 30 seconds of retries. A tree that could not be resolved at all is re-snapshotted once, and reported if that read fails too.
- If a stop that ends the supervisor still cannot be verified, the supervisor exits with code 5. A relaunch never proceeds beside such a tree either: a survivor confirmed alive and a tree no reading could account for both end the run at exit 5 rather than launching the next child beside either one.
- On exit, the cleanup trap stops a live child the same way, or re-verifies the last snapshot when the wrapper is already gone.

Every PowerShell call the stop makes is bounded by `supervisorPsBoundS`, since GNU `timeout` does not terminate a native `powershell.exe` on this box.

### Exit Codes And Logs

| Code | Meaning |
|---|---|
| 0 | `shutdown_requested` honored |
| 1 | usage or an unknown option; a missing workdir; a refused persona, model, effort or numeric setting; an unknown `PROFILE`; a run directory that could not be created; a settings file that could not be written or completed; or a launch that recorded no child pid |
| 2 | no commons store for the load mode, or the pre-launch gate timed out |
| 3 | crash loop |
| 4 | restart budget exhausted |
| 5 | stopped, but a process from the child is alive or unverifiable despite every retry |
| 130, 143 | INT or TERM to the supervisor itself |

`<rundir>/supervisor.log` is the narrative: gate polls, launches, `WAITING` liveness lines every sixth poll, decisions, stop phases and exits. `<rundir>/supervisor.err` collects the `node` and PowerShell stderr, truncated once at each launch and appended to after. Each child writes `stdout.jsonl`, `stderr.log`, `claude-debug.log` and a `.exit` marker under `<rundir>/child-N/`.

### Key Files

| File | Purpose |
|---|---|
| `bin/supervise.sh` | The supervisor script (bash) |
| `bin/supervise-decide.mjs` | Decision logic (pure JS) |
| `bin/agentic-common.sh` | Shared helpers: `emit_settings_json`, `ensure_settings_plugin_ids`, `ensure_settings_arming`, `read_settings_coordinator_persona`, `valid_persona_name`, `find_global_store`, `list_installed_stores`, `wait_persona_free_both`, `refuse_if_persona_live`, `poll_decisions`, `poll_heartbeat` |
| `bin/Start-Persona.ps1` | The process keeper's wrapper; runs one persona's supervisor under the exit-code policy |
| `bin/keeper-probe.ps1` | Records what a scheduled task delivers: the running user, the elevation state, the environment, and whether bash, node and claude resolve |
| `bin/keeper-functions.ps1` | The keeper's pure functions: the policy table, the roster reader, the invocation builder and the env file reader |
| `bin/Register-PersonaTasks.ps1` | Registers, updates, disables and reports on one scheduled task per roster entry |

### Test Coverage

The offline suites run with no `claude` session and no persona claim, so they run beside a live fleet. The live suites launch real children. `.kit/live-all.sh` runs the five its roster names: `goaltree`, `budget`, `commons`, `operator` and `restartrequest`, each a `.kit/live-<name>-test.sh`. `.kit/live-common.sh` is the shared harness they source.

`.kit/check-loader-rule.mjs` is a static check over `hooks/*.ts` for the shapes the engine's loader refuses whole, which the mock-driven suites in `.kit/` do not exercise: a `$` noun used as a value, a nested function that takes `$`, and one event pattern registered twice without a matcher. A refused module loads no hook and registers no tool, and the session runs with the plugin absent; the refusal appears only in the engine's debug log (`--debug-file`), never in the session itself. `.kit/live-all.sh` runs it before spawning any child and exits 7 on a violation; run it directly after any edit to `hooks/`.

The plugin-side live suites in that roster:

- `.kit/live-goaltree-test.sh`: the core loop end to end on a real child: `goal_create` fills the tree from `.kit/roadmap-test.md`, real nudges start real turns, and the chain runs to `root_complete` on the engine's own timing. Live.
- `.kit/live-budget-test.sh`: the context-budget estimate read off a real transcript, climbing past the info, close-out and critical thresholds as turns run. Live.
- `.kit/live-commons-test.sh`: two real children contend for one persona; one wins `persona:default` and the other holds `reader:default` only, with a cross-directory variant under `CROSSDIR=1`. Live.

The supervisor's own suites:

- `.kit/supervisor-unit-test.mjs`: `bin/supervise-decide.mjs`'s decision unit, including the crash limit read from the supervisor's setting, a backfilled root yielding no restart, its real-root control, a backfilled root still restarting on a hung heartbeat or a critical crossing, and the hung check's transcript corroboration: a stale heartbeat with a recently written transcript continues, the same shape with an equally stale or an unreadable transcript restarts, a transcript stamped up to the staleness bound ahead of the poll's own clock still corroborates, one stamped a millisecond past that bound restarts, and a fresh transcript never suppresses a restart the critical-crossing branch calls for. Offline.
- `.kit/supervisor-natural-exit-test.sh`: the natural-exit path and the decide path's `RESTART_PASSIVE`, driven through the real `bin/supervise.sh` with a stub `claude` and an isolated `HOME`. Cases: a backfilled root with exit 0 relaunches unaccounted with the `NOTE:` line and no `RESTART_PASSIVE`; a real root takes the natural-exit `RESTART_PASSIVE`; a real `root_complete` written while the child is still alive takes the decide path's `RESTART_PASSIVE` and relaunches; an exit 7 in the poll loop counts as a crash; a backfilled root with exit 7 takes the crash path; a child whose stdin is already gone at launch is counted and relaunched. It also pins that the `backfilled` substring the reader tests for sits inside the hook's backstop detail and no other `root_complete` detail. It also covers: a survivor a stub child leaves behind is killed, confirmed dead and only then does the next launch or the shutdown path proceed, with a control where no survivor is left; a stop that meets its wrapper under a Windows pid its own snapshot was never walked from fails closed rather than reporting a clean tree; the decide path's own restart branch refuses at the restart budget and at the crash limit exactly where the natural-exit path refuses, and still relaunches one below each; and a rate-limited child's newest stream record logs `RATE_LIMITED until <ISO>` while it stays the newest record, with no such line once real work follows it and no line at all for a retry the child has already worked past. Offline.
- `.kit/supervisor-model-test.sh`: `supervisorModel` and `supervisorEffort` reaching the launch flags and an exported `MODEL` or `EFFORT` winning over each, both directions of both flags across a real process boundary, the shared numeric rule clause by clause, each numeric setting's own refusal line driven through the real script, the `supervisorPsBoundS` fallback, and a structural pin that every numeric setting is either checked by `positive_number` or emitted and never read by the script itself. Offline.
- `.kit/settings-plugin-key-test.sh`: both plugin ids in the emitted settings with `arming` `owner` and the default `coordinatorPersona` under each, `COORDINATOR_PERSONA` exported by the emitter and `default` refused with no file left behind, completion of a provided single-id file with its options and persona kept, `ensure_settings_arming` completing a missing key under both ids (an empty file and a dev-id-only file included, sibling keys kept) and refusing another tier byte for byte, `read_settings_coordinator_persona` resolving a usable name, `default`, a missing key, a key under the other id only and a BOM-prefixed file per load mode, refusal of shapes that cannot hold options by both completion helpers, refusal of a persona or cadence that could break out of the JSON, the same persona class in both files that check it, `architectPersona` emitted under both ids from `ARCHITECT_PERSONA` and left out entirely when it is unset, exported by the emitter either way, `default` and a name carrying a quote refused with no file left behind, `read_settings_architect_persona` resolving the coordinator read's five classes and a BOM per load mode with no architect as its fallback, plus a sixth the two reads answer oppositely: a name outside the persona character class, which this read refuses and the coordinator read admits verbatim, one name refused for both seats by the emitter and by the driven script's provided-file branch, a provided file's architect name winning over the launch environment's with the disagreement logged, a provided `coordinatorPersona` outside the persona character class refusing the launch with the read shown admitting that same name, `controllerTickMs` and `ARCHITECT_PERSONA` reaching the emitted file through the driven script, and `staleAfterMs` refused at startup even with a settings file provided and read as data by both halves of the gate. Offline.
- `.kit/channel-reply-instruction-test.sh`: the priming turn carries the skill-load instruction and the coordinator steer sentence under both `--no-channel` values and the reply-tool instruction only with a channel attached, read from the script's own text and evaluated per persona: the coordinator persona gets the role instruction and no escalation clause, a named worker gets the escalation clause naming the coordinator and no role instruction, and `default` gets no escalation clause. The architect's charter is read the same way against `ARCHITECT_PERSONA`: the persona it names gets every clause, every other persona gets none of them through any part of the priming write, and an unset setting gets them to nobody. The steward's design-escalation clause is read against a name withheld from the script's own literals, so the routing target is proven to come from the setting, and an unset setting builds that clause for nobody while the other two duties stand. Every persona name the priming write splices in is read back and required to be the launch's own coordinator or architect name, so a seat name hardcoded at any of the three shapes that carry one reds whatever clause it sits in. That read is an enumeration of those shapes rather than a read of a class, since the string it searches is rendered prose where a persona name looks like any other word, so a separate check counts the splice sites in the script's own source and reds when a fourth shape appears. Offline.
- `.kit/live-stopprocesstree-test.sh`: the stop-path helpers and `stop_child` itself, extracted from `bin/supervise.sh`, against real Windows processes: a wrapper whose native child survives it, a wrapper that ignores TERM and forces the KILL phase, the PowerShell bound holding, and a CIM failure read as unverified. It launches no `claude` session, so it runs beside a live fleet on its own; `live-all.sh` does not run it.
- `.kit/live-restartrequest-test.sh`: a reader's restart request stops a real `claude` child and relaunches one, with the claim handed over and the plan kept. Live.
- `.kit/persona-live-refuse-test.sh`: `bin/agentic-common.sh`'s `refuse_if_persona_live`, driven with stub commons-store fixtures. Cases: a live claim in the first of two stores, a control with only stale or non-persona claims, a live claim only in the second (installed-store) leg, a missing store path skipped, an unparsable store failing after three re-reads that complete with no wait, a fresh live claim refusing within 3 seconds with no polling wait, zero readable stores refusing, a non-numeric stale bound refusing, a non-numeric `lastSeen` under a live claim refusing (with a numeric-`lastSeen` control), and `list_installed_stores` naming every installed store and no inline store under a stub plugin store directory, with `find_global_store 0` returning its first line. Offline.
- `.kit/keeper-unit-test.mjs`: the keeper's decision function and its helpers, driven through the real `powershell.exe`. Cases include `Get-KeeperDecision`'s policy table in both directions for every row, the delay ladder doubling to its cap and resetting on a long uptime, `Read-KeeperRoster` and `Build-SupervisorInvocation` mapping the roster table (including the `--prompt` refusal and the bash-path conversion), the single allowlist read in both directions, `Read-KeeperEnvFile`'s comment, duplicate and quoting rules, and the wrapper end to end: the delay ladder driven through a stub supervisor, an env key applied, ignored, empty or duplicated and logged accordingly, the hold marker written and read back, `-Release`, `keeper.json`'s fields, `keeper.log` rotation at 5 MB, and a descendant that outlives the supervisor neither delaying the wrapper's own return nor blocking the next launch's capture file. Offline.
- `.kit/keeper-register-test.mjs`: `bin/Register-PersonaTasks.ps1`'s task-definition builder and its registration script, with every Task Scheduler cmdlet shadowed inside a spawned PowerShell so the suite registers nothing real. It reads the live `AgentPersona-*` task count at the start, again after the one case that runs the registration script for real, and asserts the two are equal; that case runs only in an unelevated session, where the script's own elevation guard is what stops it. Cases include the built definition's twelve fields, the elevation guard in both directions, the disabled and absent branches through `-WhatIf`, `-Prune` reporting rather than removing an orphan when the switch is absent, roster validation (duplicate names, a name outside the safe character class, a non-boolean `enabled`, a non-array top level), and the path-quoting and trailing-separator refusals that keep `-RepoRoot`, `-Roster` and `-EnvFile` from escaping the task action's quoted argument string. Offline.
- `.kit/supervisor-tree-walk-test.sh`: the supervisor's Windows process-tree walk, pinning that a process is accepted as a descendant only where its creation time is not earlier than its parent's, so a dead parent's recycled pid cannot adopt an unrelated process that happened to hold that id before. Offline.

## Process keeper

`bin/Start-Persona.ps1` is what each `AgentPersona-<name>` scheduled task runs. It reads one entry from a JSON roster, applies an environment file's allowlisted keys, launches `bin/supervise.sh` through the bash the environment file names, and loops on the supervisor's exit code under a fixed policy: relaunch after a delay, hold, or stop.

**The roster.** One JSON array, each entry a persona, read from `D:/personas/fleet.json` unless `-Roster` names another path. `workdir`, `name` and `permissionMode` are required and become the supervisor's three positional arguments, in that order. `rundir` becomes `--rundir`; where it is absent the supervisor uses `<workdir>/run` and the keeper writes its own state there too. `channelName` becomes `--channel-name`; where it is absent the supervisor uses its own `supervisor-<persona>` thread name. `model`, `effort`, `controllerTickMs` and `coordinatorPersona` become the `MODEL`, `EFFORT`, `controllerTickMs` and `COORDINATOR_PERSONA` environment variables, each set only where the entry carries the field. `args` is any further supervisor flag appended verbatim, refused if it carries `--prompt`, since every roster entry launches passive. `enabled` is required and decides whether a task is registered and turned on.

`bin/fleet.example.json` is a worked example, mapped from the three launchers under `D:/personas` that remain the manual fallback. All three entries set `permissionMode` to `bypassPermissions`, which runs the child with its tool-permission prompts off. Under a scheduled task that choice reaches further than it does at a launcher: the persona runs from boot, unattended, with no console for anyone to answer a prompt at. Set it to a stricter mode for any persona that should not hold that latitude.

**The environment file.** `KEY=value` lines, `#` comments, read from `D:/personas/keeper.env` unless `-EnvFile` names another path. Both `bin/Start-Persona.ps1` and `bin/keeper-probe.ps1` read it through one allowlist in `bin/keeper-functions.ps1`: `KEEPER_BASH_EXE`, `KEEPER_PATH_PREPEND`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP`. A key outside that list is ignored and logged. So is an allowlisted key whose value is empty or whitespace, because setting an empty value removes the variable under Windows PowerShell 5.1 and keeps it under PowerShell 7. Every other allowlisted key is set as an environment variable of the wrapper's own process before it launches the supervisor, except `KEEPER_PATH_PREPEND`, which is prepended to `PATH`, and `KEEPER_BASH_EXE`, which names the bash executable the wrapper runs and is not exported. A file that omits `KEEPER_BASH_EXE` is tolerated only where the wrapper's own process environment already carries it. These keys are pinned here because the task runs under an S4U logon, which starts the process as the user with no stored password and loads no profile, so the user-scoped `PATH` (where `bash.exe`, `node`, `claude` and the npm shims live) and the profile variables are absent until this file supplies them.

**The exit-code policy.** Exit 0 holds. Exit 1 relaunches after 300 seconds, and holds after three consecutive runs that each ended in under 60 seconds. Exit 2 relaunches after 300 seconds with the delay ladder unchanged. Exit 3, 4, 5 or any other code relaunches after the current delay and doubles it, capped at 14400 seconds. Signals 130 and 143 exit without relaunching and write no hold marker, so the persona comes back at the next boot. The delay resets to 300 seconds whenever the supervisor ran for 3600 seconds or more before exiting.

The scheduled task carries a restart policy of its own, separate from this one: 999 restarts at a one-minute interval. It applies to the wrapper ending badly rather than to the supervisor, and it is why the wrapper exits 0 on every hold.

**Holding a persona.** A hold writes `<rundir>/keeper.hold` with the reason. While that file exists, a later start logs the hold and exits without launching, so a persona the operator shut down stays down across a reboot. A marker the wrapper could not write is logged as an error and the wrapper still exits 0, so a failed write leaves the persona free to come back at the next boot. `Start-Persona.ps1 -Name <name> -Release` removes the marker and exits without launching; the task starts the persona again at the next boot, or at an operator's `Start-ScheduledTask`.

**Registering the tasks.** `bin/Register-PersonaTasks.ps1 -Roster D:/personas/fleet.json -EnvFile D:/personas/keeper.env` builds one task per enabled roster entry, named `AgentPersona-<name>`, triggered at startup. Both paths are the defaults, so a run with no arguments does the same thing. `-RepoRoot` sets the checkout the task's action points at, defaulting to the parent of the script's own directory. The script requires an elevated PowerShell session, because registering a task under the Task Scheduler root fails without one. `-WhatIf` needs no elevation and prints what a real run would do without registering anything.

**Stopping and starting a persona.** Stop one through its own shutdown tool. That gives the supervisor a clean exit 0, which the keeper turns into a hold, and the persona stays down until it is released. One case departs from that: where a process from the child is still alive or cannot be verified after every stop retry, the supervisor exits 5 instead, which the keeper reads as a crash and relaunches after a delay. `docs/backlog.md` carries that fork.

`Stop-ScheduledTask` is not documented here as a way to stop a persona, because whether it ends the whole process tree under an S4U task has not been measured on this machine. A TERM or INT signal sent to the supervisor from a bash shell gives 130 or 143, which exits the wrapper with no hold marker, so the persona returns at the next boot. A kill from Task Manager, `taskkill` or `Stop-Process` delivers no signal at all, so the wrapper reads an ordinary failure code instead and relaunches under the exit-code policy above. To keep a persona down rather than have it come back, write a `keeper.hold` file in its run directory first, or disable its scheduled task, and then kill it.

Start one with `Start-ScheduledTask AgentPersona-<name>`. Where the persona is held, release it first with `Start-Persona.ps1 -Name <name> -Release`; a start against a standing hold marker logs the hold and exits without launching, and the task reports success either way.

**Where the state lives.** In the run directory, which is the entry's `rundir` or `<workdir>/run` where it carries none: `keeper.log` (one line per event, rotated at 5 MB keeping one previous file as `keeper.log.1`), `keeper.json` (the last run's persona, launch count, timestamps, exit code, current delay and hold reason), `keeper.hold` (present while held) and `supervisor.out` (the supervisor's own stdout and stderr, appended per run). `supervisor.out` carries no size cap of its own, unlike `keeper.log`.

The keeper reads no file permissions. The roster, the environment file and the repository tree are the operator's own machine state and are trusted as such, by the operator's decision, and no keeper script refuses, warns or skips on who may write them.

## Cost and cadence options (item 6)

The plugin tracks its own model-call cost and caps nudge frequency. All options are settings (`pluginConfigs`):

| Option | Default | Description |
|---|---|---|
| `costEnabled` | `true` | Master switch for D2 (idle skip), D3 (caps), D4 (backoff). When `false`, the ledger still runs but idle ticks are not skipped and caps are not enforced. |
| `costSummaryEveryNTicks` | `20` | Emit a `cost_summary` decision every N ticks (wall-clock regular, skipped ticks still count). |
| `costMaxNudgesPerHour` | `12` | Maximum nudges per hour per persona. When reached, the controller logs `cost_cap_reached` once per window and returns from the tick. |
| `costMaxPluginCallsPerHour` | `600` | Maximum plugin model calls (classify + reason + selfReview + planner) per hour per persona. |
| `nudgeFloorMs` | `300000` (5 min) | Minimum time between nudges. |
| `nudgeIdleMs` | `120000` (2 min) | Idle gate on classify and nudge (the tick fires every `controllerTickMs`; this is the idle threshold for a nudge to be sent). |
| `costBackoffAfterTicks` | `10` | Number of consecutive unchanged ticks before backoff engages. |
| `costBackoffMaxMs` | `300000` (5 min) | Maximum backoff duration. The backoff factor is derived from this value. |

**Env shorthand:** The test runner uses `COST_*` env vars (`COST_MAX_NUDGES_PER_HOUR`, etc.) that `emit_settings_json` in `bin/agentic-common.sh` translates into settings. A hook module cannot read the environment directly.

**Ledger:** The plugin estimates token cost per site (classify, reason, selfReview, planner) as prompt chars over 4 plus the maxTokens cap. The `nudge` site is count-only because the nudge's cost is a main-model turn the hooks cannot measure.

**Test coverage:** `.kit/cost-ledger-unit-test.mjs` (ledger math), `.kit/cost-migration-test.mjs` (state migration), `.kit/controller-tick-test.mjs` (D2, D4, AM7, D3 deterministic cases).

**AL7 (engine 2.1.267):** The plugin uses `$.fs.read` and `$.fs.write` (not `$.fs.readFile` / `$.fs.writeFile`). These function names were introduced in Claude Code engine 2.1.267. The engine version the typings were written by is line 1 of `.claude/types/claude-code.d.ts`.

After any engine update, regenerate with the stream-json invocation. Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment first:

```
printf '%s\n' '{"type":"user","message":{"role":"user","content":"/plugin-types"}}' | claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --permission-mode bypassPermissions --plugin-dir <plugin dir>
```

The two files land in `.claude/types/` of the current directory. Copy both generated files to `.claude/types/`, run `npx tsc --noEmit`, and re-gate with the controller suite before trusting a green.

**Re-gate rule:** If you upgrade the engine, re-run `npx tsc --noEmit` and the full test suite (`.kit/cost-ledger-unit-test.mjs`, `.kit/cost-migration-test.mjs`, `.kit/controller-tick-test.mjs`, controller suite). The function names may change again.

## Operator channel (item 7)

A reader session can steer an owner session without being at the owner's keyboard. The owner can also ask the reader a question and wait for the answer instead of walking on.

### Tools

**`agentic_say`** (`text`, `answers?`, `urgent?`, `persona?`)

Writes an operator record into the commons store, addressed to the target persona: the `persona` argument when given, else the calling session's own persona. The argument reaches another persona's inbox with no identity switch; the caller's own persona and claims stay as they are. `urgent: true` marks the record for delivery inside the owner's running turn, and a record nobody flagged reaches it the same way once it has waited past the break-in bound, unless the caller is the coordinator persona (see Delivery). A caller may reach the target on any of three grounds, checked against the live commons claims, where owning a persona means holding its `persona:<name>` claim and winning the commons arbitration for it (the same winner the deferred view and the yield check resolve, so a session that claimed a persona after a live earlier holder is not its owner):
- The reader path: the caller holds a reader claim on the target persona (a reader steering the owner it reads, which needs no `persona` argument)
- The coordinator path: the caller owns `persona:<coordinatorPersona>`, which reaches any persona. The name comes from the `coordinatorPersona` option, default `coordinator`; a configured name that is empty, contains `:` or is `default` falls back to `coordinator`
- The worker path: the target is `<coordinatorPersona>` and the caller owns a named persona other than `default`. The send is accepted whether or not a live session owns the coordinator persona: the record waits `pending` for the coordinator's tick, which judges the caller's claim again (see Trust boundary), so a caller that exited or relaunched before that tick is skipped there and the record is not delivered

Every ground is a claim a session issues itself. Any plugin-loaded session on this machine can take a reader claim, own a named persona through `agentic_identity`, or own the coordinator persona while no live session holds it (the coordinator's own claim goes stale after `staleAfterMs`, and is absent between supervisor relaunches). The boundary these grounds draw is therefore any plugin-loaded process on this machine. Excluding `persona:default` keeps out a session that has issued none of those claims, which is every plugin-loaded session at start, and nothing more.

Refused when:
- The calling session owns the target persona (an owner does not message itself; a reader addressing the persona it reads is unaffected)
- None of the three grounds holds
- `persona` is given but fails the shared name rule: empty, contains `:` (records are keyed `inbox:<persona>:...`, so a colon would cross persona listings), or contains `[`, `]`, `,`, whitespace after trimming, a control character or a format character (the name is spliced into record ids and delivery labels, so any of those could forge or split a bracket). `agentic_identity`, the configured `coordinatorPersona` and the persona a session starts under apply the same rule; a start persona that fails it runs as `default` and records `persona_name_refused`.

**`agentic_inbox`** (`persona?`)

Returns unread replies to the caller's records addressed to the target persona (the `persona` argument when given, else the caller's own persona), plus that persona's open asks. A record still `pending` while the owner's commons entry shows a turn in flight (`turnStartedAt` in the machine-global commons store, live while the entry's `lastSeen` is within `staleAfterMs`) comes back with `deferred: true` and `turnRunningMs`. A `resolved` record carries `outcome`, `note` and `resolvedAt` beside `reply`. While the target's owner is live, the result also carries `workdir`, that owner's self-reported working directory as its commons entry holds it, which is where its own `.agentic-personas.json` sits; it is store data, trusted as the rest of the store is. The store is shared across the machine, so a reader in another working directory sees the same state. Refused under the same rule as `agentic_say`:
- The calling session owns the target persona
- None of the three grounds above holds
- `persona` is given but fails the shared persona name rule stated under `agentic_say` above

**`agentic_resolve`** (owner only)

Marks a record addressed to the owner's persona as `resolved`, writing `resolvedAt`, an `outcome` of `done` or `declined`, and a short `note`. `answered` means a turn replied; `resolved` means the work the record asked for is finished or will not be done, which is what a sender counting rounds per steer needs. Takes the record id (`<persona>-<sender session id>-<seq>`). Refused when:
- The calling session is not the owner (a reader holding the persona cannot resolve)
- The record is not listed under the caller's persona
- The `id` is empty, or the `outcome` is not `done` or `declined`
- The record is still `pending` (not delivered yet) or `skipped` (refused at delivery; the decision log names whether the writer had no live claim, the record's id or text was malformed, or the writer's persona name was)
- The record is already `resolved`
- The `note` is longer than 2000 characters (it goes whole into the shared store, so it is bounded at the handler)

**`fleet_status`** (no arguments)

Returns fleet health as one row per persona in the roster the `fleetRoster` option names, beside `roster` and `staleAfterMs`. Each row carries `name`, `enabled`, `action`, `nextDelaySeconds`, `holdReason`, `holdReasonSource`, `lastExitCode`, `claimHeld`, `heartbeatAgeMs` and `turnState`, plus `turnRunningMs` while a turn runs and `note` when something could not be read. `action` is where that persona stands, read from the two files the process keeper leaves in the run directory, from the last supervisor exit, and from the commons claim. `held` when `<rundir>/keeper.hold` exists, which is what stops the next start. `stopped` when that exit was 130 or 143 with no marker, on which the keeper's wrapper leaves without relaunching, so nothing restarts the persona until its scheduled task runs again. A hold marker is reported even while a session still holds the persona, because it says what happens next rather than what is running now. `running` when a live session holds the persona's claim under no marker, which outranks the keeper's state file, since that file is written after a supervisor exit and so records a decision already carried out. A signalled exit under a live claim is settled on the clock. `keeper.json` is written at an exit and never at a launch, so a signalled exit code stands in it for the whole of the next run. A claim last seen before `lastEnd` is the session that took the signal and reads `stopped`, and a claim last seen after it is a session that started since and reads `running`. A restart inside the staleness window leaves two entries claiming the persona, and that same comparison picks between them, so the row follows the session that came back rather than the one that went away. Where `lastEnd` carries no timestamp that can be read, the claim decides, the row reads `running`, and its `note` says the exit could not be placed against the claim. `backing off` when `keeper.json` carries a delay above the keeper's 300-second base, `relaunching` at the base, and `unknown` when no state could be read. A `running` row carries no keeper standing in its `action` at all, so where a running persona stands with its keeper is read from `nextDelaySeconds` and `note`. `nextDelaySeconds` is `keeper.json`'s `currentDelay`, the delay the keeper will apply after the next crash, not a wait being served now: the state file records the next rung of the ladder and no timer, so the wait a persona is currently serving cannot be read from this tool. `holdReason` is the hold marker's first line, or `keeper.json`'s own hold reason when that line is blank, and `holdReasonSource` names the file it came from. That text is read out of the persona's own run directory, which the persona itself can write, so the steward relays it as an unverified line from the named file rather than as the keeper's word; square brackets in text the plugin did not compose, the marker's own line, `keeper.json`'s hold reason, and a caught error's message, are turned into round ones, so a forged delivery label cannot ride in, while paths and other plugin-composed text keep theirs. That field and `note` are cut at 2000 characters, the bound `agentic_resolve` applies to its note, and the cut is marked in the text so a shortened value does not read as the whole of it. A roster or a `keeper.json` carrying a byte-order mark still parses. The run directory is the roster entry's `rundir`, or `<workdir>/run` when it carries none. The commons half is the persona's own entry in the machine-global store: `claimHeld` says a live session holds `persona:<name>`, `heartbeatAgeMs` is the age of that entry's `lastSeen`, and `turnState` is `in turn`, `idle`, or `unknown` for a session that is not live. The tool is read-only: it writes nothing, creates nothing and deletes nothing, and unlike the inbox tools it does not collect stale commons entries as it reads, so a stopped session's heartbeat age still reports while its entry stands. A roster that is missing or is not a JSON array comes back with no rows and a `problem` naming the path; a roster entry with no name is listed in `problems`; a keeper state file that is missing or unreadable is that row's `note`. One unreadable persona never hides the others. Refused when:
- The calling session neither owns `persona:<coordinatorPersona>` nor holds a live reader claim on it. The worker standing that reaches the coordinator persona to send it a record is not a standing to read fleet state from.

### Record shapes

All records live in the global store (machine-wide, one store per plugin). Key formats:

| Key format | Type | Description |
|---|---|---|
| `inbox:<persona>:<writer session id>:<seq>` | `inbox` | An operator message from a reader to an owner. `status` runs `pending` (written, not yet read), `delivered` (submitted to the owner's turn), `answered` (that turn replied), `resolved` (the owner marked the work done or declined through `agentic_resolve`), or `skipped` (refused at delivery: the writer had no live claim that reached the persona when the tick judged it, or the record's id or text, or the writer's persona name, failed the bracket rule) |
| `reply:<persona>:<record id>` | `reply` | The owner's reply to an inbox record |
| `ask:<persona>:<ask id>` | `ask` | A question from the owner to a reader |
| `reader:<persona>` | `reader` | A reader claim on a persona (no session id in the key) |

**Record-id format:** `ask-<node id>-<ms>` where `<node id>` is the persona's node id and `<ms>` is a millisecond timestamp.

**TTL:** 24 hours, swept on the cost-summary cadence (every `costSummaryEveryNTicks` ticks). Only the owner sweeps records; readers cannot delete records they do not own. The sweep never removes a `pending` record, whatever its age: a pending record whose writer is gone leaves through the drain's own `skipped` route, so one still pending is unread live work. An inbox record ages off the latest of its write, delivery and resolution times, and its reply is swept with it rather than on the reply's own age; only an orphan reply with no inbox record ages on its own. Every record the sweep removes (inbox, reply, ask) is appended to `.agentic-channel.jsonl` first, one line per record with `sweptAt` (the window roll's lines carry `rolledAt`), and a refused append leaves every record in the store and logs `sweep_expired_records_failed`.

### Bounded store (item 5)

The store keeps only open asks and a short window of recent inbox/reply records per persona; everything past that window rolls to an append-only `.agentic-channel.jsonl` in the work directory rather than staying in the one rewritten-whole JSON file forever. Enforced on the same cost-summary cadence as the TTL sweep, in `enforceChannelWindow`: `inbox` records that are `skipped` or `resolved` and every `reply` record except an open steer's, combined and ordered oldest-first, past `channelRecordWindow` (default 50) roll to the log. A `pending` record is unread work, and a `delivered` or `answered` record is an open steer whose state the sender still reads, so those stay in the store whatever the window, and so does the reply of a `delivered` or `answered` record; the TTL is the bound on them. Every other reply, whether its record is `resolved`, `skipped` or gone, enters the window on its own age, so it can roll on a different cadence from its record. Open asks are never touched by this window - only TTL sweeping or the ask's own answer/expire/re-raise lifecycle ends one.

The persona file is bounded the same way, enforced at push time in `persist()` rather than only when the file happens to be parsed at a session load (a long-lived child never reloads): the decision log past `DECISIONS_MAX` (200) and memory past `MEMORY_MAX` (50, pinned entries exempt) both roll their oldest overflow to the same `.agentic-channel.jsonl`.

### Delivery

When the owner's controller drains the inbox on a quiet tick, it submits the text through `$.prompt.submit` as a user turn opening with a provenance label: `[COORDINATOR id=<record id>] <text>`, `[READER:<persona> id=<record id>] <text>` or `[WORKER:<persona> id=<record id>] <text>`, and an answer to an open ask as `[<ground> id=<record id>] Answer to <question>: <text>`. The ground is computed at delivery from the writer's live commons claims, by the same read that gates the delivery (`deliveryGroundIn` in `hooks/operator.ts`), never stored on the record: `COORDINATOR` when the writer is the commons winner of the coordinator persona; otherwise `READER:<persona>` when the writer holds any reader claim, naming the owner's persona where the writer reads it and the alphabetically first persona it reads otherwise; otherwise `WORKER:<persona>` when the writer's only standing is an owned named persona, naming the alphabetically first one. A writer holding a reader claim anywhere is never labelled `WORKER`. The record id rides in the bracket because `agentic_inbox` is reader-only: it is the id the owner passes to `agentic_resolve` when the work is finished or declined. The record id and the persona name inside the bracket are both store data any process can write, so both are held to one bracket rule at delivery: no `[`, `]`, `,`, whitespace, control or format character. The record's text must be a string. A record whose id or text fails that record rule, or whose writer's persona would fail the bracket rule, is never delivered: the drain marks it `skipped` under `operator_skipped_bad_record` or `operator_skipped_bad_name` (the detail names the field and the reason, with a refused persona name JSON-escaped), the break-in leaves it pending for the drain, and the ask step marks an answer skipped under the same action and leaves the ask open. Only the first line of a delivered turn or context entry opens with a label bracket: the whole body after the bracket, the `Answer to <question>: ` segment included since the question is read back from the store, is split at CRLF and at any of LF, CR, VT, FF, U+0085, U+2028 and U+2029, and every line after the first is quoted with `> ` and joined with LF, so a body carrying a line break and then a bracket cannot read as a second delivered record. The ask re-raise turn (`[STILL WAITING] <question>`) is quoted the same way. `[OPERATOR]` is not a label this path produces. It is reserved for the operator's own channel, whose text reaches the model as typed and never passes through this delivery code. The plugin keeps a list of the turns its own `$.prompt.submit` calls have queued and not yet opened, each entry carrying the exact text it submitted: a delivery entry with its record, a nudge entry, or a plugin entry (the kaizen announcement, the reply backstop, the ask re-raise), pushed right before its submit. When the submit resolves, the entry also takes the settled text the result reports, which is the text as the hook chain beneath the plugin left it (another plugin's `prompt.submit` hook may rewrite it, and the engine caps it whole) and the text the turn opens with. At `turn.start` the turn's text is matched against the queued entries on either key and the match is removed wherever it sits: a delivery entry stamps its record with the turn id, a nudge or plugin entry stamps nothing. Both keys are kept because the engine does not order the submit's resolution against `turn.start`: a turn that opens first matches on the submitted text where nothing rewrote it, and one that opens after matches on the settled text either way. A `UserPromptSubmit` settings hook cannot rewrite the text, since its output carries no text field, and a prompt it suppresses leaves no turn that matches either key. A turn that opens with a rewritten or capped text before the submit's continuation has stored the settled text matches neither key either; that delivery's turn reads `unaccounted` and the record ages out unstamped. A turn whose text matches nothing (an external turn from the keyboard, an SDK caller or the channel, a continuation with empty text, or one the plugin cannot place) stamps nothing and, where a delivery is queued, records `operator_stamp_withheld` naming `channel-origin`, `external` or `unaccounted`; the delivery's own turn still stamps it when it opens with its text. Before naming that record, the plugin takes the delivery entries queued at that moment, reads the store once, and keeps an entry only while its record is present, `delivered` and unstamped, dropping the rest (a record swept by the TTL, resolved, or replaced under a reused id), so the withheld line names the first delivery whose stamp could still land, and names nothing when none is left. Taking the entries before the read is what keeps an entry queued while the read runs out of that check, and a read that fails drops nothing and names nothing. Two queued submits with identical text are a known limit: the first queued entry wins. A delivery whose submit is rejected, or is dropped by a hook beneath the plugin (the submit then resolves `{ drop }` and no turn opens), consumes its entry and records `operator_delivery_failed` with the error or the drop reason, and nothing else: the record stays `delivered` as written, an ask it answered stays closed, and no delivery is retried; the TTL ages the record out. A nudge, kaizen, backstop or re-raise submit that is dropped consumes its own entry the same way. When the stamped turn completes with an answer, the controller writes that answer back as the reply and marks the record `answered`. A stamped turn that ends aborted or with an empty answer leaves the record `delivered` with its stamp (`operator_turn_unanswered`); no later turn re-stamps it, and the TTL bounds it.

A record does not always wait for a quiet tick. Two triggers break one into the turn already running: the sender's `urgent` flag, and the record's own wait, once it has been pending `breakInAfterMs` (default 300000, clamped to at least 30000 and to at most `KAIZEN_MESSAGE_WAIT_MS` less a minute, so a record qualifies while the self-review still has headroom before it counts the wait as too slow; the headroom bounds qualification only, since delivery waits for the next tool call past the throttle and can land past that threshold). The wait trigger does not reach a record whose ground is `COORDINATOR`: the worker's standing steer sentence names `[COORDINATOR id=<record id>, urgent]` as the one coordinator form carrying no delegated authority and covers no other marker, so a coordinator record breaks in on the sender's flag alone and otherwise waits for the tick. A reader or worker bracket carries no delegated authority under that sentence whatever marker it arrives with. On the owner's next passthrough tool call (checked at most once per `urgentCheckMinMs`, default 5000), the record is marked delivered and its text is appended as `[<ground> id=<record id>, urgent] <text>` or `[<ground> id=<record id>, waited] <text>` context on that tool's result, which the model reads right after the result; the ground is the same one the drain would compute, and a record that is both flagged and aged reads as `urgent`. One scan carries at most one record qualifying on its wait, the oldest of those the same delivery check would let through, so a backlog built up over a quiet stretch drains one record per scan rather than emptying into a single tool result; flagged records are unrestricted. The check comes before the slot because the drain that marks an undeliverable record `skipped` cannot run while the turn is in flight, so a record picked on age alone and then refused would hold the slot for the whole turn. A flagged record is stamped with the running turn, and the turn's own answer becomes its reply. A record delivered on its wait alone is not stamped: that turn opened for something else and its answer is not a reply to the message, so no reply is written and the record stays `delivered` until the owner calls `agentic_resolve`, which is the sender's feedback path for it. A record that answers an open ask is never delivered this way; the tick owns the ask lifecycle. Only the main loop's own tool calls carry a break-in. The `tool.call` hook also runs for every other loop's tool calls, which the engine marks with a non-empty `agentId`: a dispatched subagent is the case that matters, and a teammate, a workflow's agents and the engine's own forks carry one too. On those the break-in is not checked at all: a steer delivered into a subagent's tool result reaches a loop that cannot verify it and never reaches the owner. Such a call neither reads nor advances the throttle, so the record stays pending for the owner's own next call or for the tick after the turn.

### Trust boundary

Text reaches the model **only** through `$.prompt.submit` from a record whose writer may reach the owner's persona under the same three grounds `agentic_say` checks at send (a reader claim on the persona, ownership of the coordinator persona, or ownership of a named persona other than `default` when the owner's persona is the coordinator persona), judged again at delivery on the live commons claims as they stand then. One shared rule (`deliveryGroundIn` in `hooks/operator.ts`, over one claims read per gate, with `mayReachPersonaIn` as its boolean form) gates the send, the inbox read, the tick's drain, the ask-answer delivery and the urgent break-in, and at the three delivery sites the same read yields the provenance label the text opens with, so a record that is delivered is a record that is labelled and the label names the strongest ground the writer holds. `fleet_status` reads the same rule and admits less of it: only the coordinator ground and a reader claim on the coordinator persona, never the worker standing, because reaching the coordinator persona to send it a record is not a standing to read the fleet's state from. The boundary those grounds draw is any plugin-loaded process on this machine: each ground is a claim a session issues itself, and the `persona:default` exclusion keeps out only a session that has issued none. That reach includes the coordinator label: while no live session holds `persona:<coordinatorPersona>`, any owner-armed session on the machine can claim it through `agentic_identity`, and its records then open with `[COORDINATOR id=<record id>]`, the label a worker's standing instruction tells it to act on inside its approved plan without an operator round trip. The repository's own controls (branch protection, pull-request review) are what bound such a steer, not the plugin. A record that fails the check at delivery is handled by the site that reaches it: the tick's drain marks it `skipped`, whether the writer's commons entry went stale, its claim was released or lost the arbitration, or the owner runs with a different `coordinatorPersona` than the writer's; an answer to an open ask that fails is logged at the ask step and skipped by the same drain; the break-in passes over that record and leaves it pending for the tick, which skips it. Peer messages (cross-session `SendMessage`) are consumed by the `session.receive` hook and **never** reach the model. The hook tests `e.origin.kind` against `peer` and `peer-send-message`; if either matches, it returns `{ consumed: "agentic: peer text is not steering; use agentic_say" }`, which means nothing is queued, shown, or read by the model. A peer message therefore carries no standing: it cannot steer the owner, open an ask, or trigger a nudge.

### Ask wait

When the owner opens an ask (`ask_opened` decision), it sets `pendingAskId` and waits indefinitely. While `pendingAskId` is set:
- Nudges are skipped (the controller does not nudge while waiting for an answer)
- Classify is skipped (the controller does not spend a model call classifying while waiting)
- The nudge cap, the cost cap and the error streak **pause** the leaf rather than block it

When the reader answers the ask, the owner's controller is reactivated (`reactivated (answer to ask)`).

### Section 6 options (defaults in force)

Two options are defined in the plan (section 6) with defaults in force:

1. **Ask wait default:** Whether the owner's ask waits indefinitely for a reply or times out. Default: **60 minutes** (`askOperatorWaitMs` unset, code fallback `hooks/index.ts:142`).
2. **Peer text:** Whether peer text is consumed by the `session.receive` hook or passed through with a `[PEER]` prefix. Default: **consumed** (the hook returns `{ consumed: reason }` and nothing is queued, shown, or read by the model). Under `arming` `off` no hook but the tier's own start-up log line runs, so peer text reaches the model exactly as the harness delivers it.

The operator has not yet ruled on these options; the defaults are in force.

### Test coverage

- `.kit/live-operator-test.sh` : phase 1 across two real processes, a reader's `agentic_say` delivered to the owner and the reply read back through `agentic_inbox`
- `.kit/controller-tick-test.mjs` : S3 (ask lifecycle), S4 (peer doorbell), S6 (answer linkage), S9 (cost cap ask opener), and the Section 13 cases: the scorer's round, the error streak opening an ask, the git probe's dirty-count cadence, health red then green reaching the turn, plan activation and the post-completion stall guard, the planner failure cap, stale-holder takeover, lesson injection, and the budget latch
- `.kit/fleet-status-unit-test.mjs` : the `fleet_status` tool over fixture roster, keeper state and hold-marker files: the five row shapes, the run directory a roster entry without `rundir` derives, both admitted standings and both refused ones, a roster that is missing or malformed, and the store and filesystem untouched by the call
- `.kit/assert-decisions.js` : decision log assertions over the live stores (goaltree chain and nudge pin, budget crossings, operator phase 1 order)

The supervisor's own suites are listed under the Supervisor section's Test Coverage above.

**Runner lock:** `live-all.sh` writes `.kit/RUNNING` at start and refuses to start if it already exists (exit 8). After a killed gate, confirm no `claude` child with `--plugin-dir` is running, then `rm .kit/RUNNING`. `live-all.sh` also refuses at start, with no wait, when a live `persona:` claim is present in any commons store, inline or installed, or when a store could not be read after three attempts (exit 10). An open session armed `owner`, or one running the previous plugin, is enough to trip it. A claim younger than the stale bound may be residue of a gate killed within the last 90 seconds, in which case wait and re-run.

## Limitations

- **Latency**: goal scoring (1 classify) + memory curation (1 classify + optional 1 complete) + 2 file reads + 1 write per turn end. Controller tick: 1 classify + optional 1 complete per tick. ~1.5–2s on Haiku each.
- **Read-modify-write is not atomic**: the epoch guard catches long-lived staleness. A true atomic write (lockfile or `$.store`) would be the fix.
- **No decay**: memory entries don't decay or expire. Confidence is static after creation.
- **MEMQ not connected**: the `$.mcp.call` path is wired but no MEMQ server exists; local confidence ranking handles all retrieval.
- **Single controller**: only one session runs the controller tick for a persona. Multiple sessions sharing a persona will each run their own controller. The heartbeat sidecar prevents store corruption but not duplicate actuation.
- **No session-end event**: heartbeat entries are only released via the stale window (H4).

## Next steps

1. **Stand up a MEMQ MCP server** and connect for semantic memory ranking.
2. **Stress-test yield-on-stale**: two truly concurrent sessions claiming the same persona; verify the loser yields.
3. **Try `$.model.fork`** for the controller tick (sees full transcript, shares prompt cache) : Fable suggested, not yet adopted.
4. **Memory decay**: confidence -= f(age, accessCount).
5. **Multiple-goal support**: state.goal → state.goals[], priority ordering.

## License

MIT
