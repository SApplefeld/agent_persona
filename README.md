# Agentic Plugin

PIANO-esque cognitive layer on Claude Code's Function Hooks API. One plugin module, one `register(on, options)` export, no Agent SDK. The plugin needs no supervisor to run one session; `bin/supervise.sh` is the optional outer loop for runs longer than one session. Modules observe at hook boundaries and write to shared `AgentState`; the Controller : the sole actuator : runs on a clock, classifies the situation, and then (and only then) actuates through exactly three channels.

## Quickstart

A fresh clone, one command, a waiting supervisor.

**Install the plugin** (once per machine):

```
claude plugin marketplace add SApplefeld/agent_persona
claude plugin install agentic-plugin@agent-persona --scope user
```

`claude plugin update` re-fetches from GitHub, so the installed runtime always tracks merged `main` rather than whatever happens to be checked out in any one clone. Registering the marketplace from a local directory (`claude plugin marketplace add /path/to/this/clone`) instead makes `claude plugin update` copy that directory's working tree verbatim, uncommitted edits included - useful only for developing the plugin itself, alongside `--dev` below, never for running it.

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

**Reach it while it is busy.** A message sent while the worker is inside a long turn waits for that turn to end; the sender's next `agentic_inbox` shows the record as `deferred` with `turnRunningMs`, how long the turn has run. A message sent with `urgent: true` reaches the worker inside the running turn instead, as context on its next tool result.

**Where the logs are.** `<workdir>/run/supervisor.log` is the supervisor's own narrative (gate checks, launches, restarts, stops). `<workdir>/run/child-N/stdout.jsonl` is child N's full stream-json transcript; `stderr.log` and `claude-debug.log` sit beside it. `<workdir>/.agentic-personas.json` and `.agentic-heartbeat.json` are the persona store and liveness sidecar.

**Working on the plugin's own code** instead of just running it: pass `--dev` to `supervise.sh`, which loads this checkout directly (`--plugin-dir`) instead of the installed copy, so edits here take effect on the next launch with no reinstall.

**Status: v0.11.0 : Stage 3 (supervisor).** `tsc --noEmit` clean. Supervisor (`bin/supervise.sh`) drives outer-loop runs: pre-gate (commons + heartbeat), coproc stdin with EOF stop, real exit codes, `PROMPT=""` cleared after first send, `writeClaimDirect` shared across all three claim sites. The suites are catalogued under Test Coverage in the Supervisor section.

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

## Supervisor (v0.11.0)

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

The child reads its plugin options from `<rundir>/settings.json`, passed on `--settings`. `pluginConfigs` is keyed by plugin id, and the id differs by load mode: `agentic-plugin` under `--plugin-dir` (`--dev`), and `agentic-plugin@agent-persona` for the installed copy. Options under the other id are ignored without an error, and the child then claims persona `default` with default cadences. So `emit_settings_json` writes the same options under both ids. When the run directory already holds a settings file, the supervisor keeps it: `ensure_settings_plugin_ids` copies the options from whichever id carries them to the id that lacks them, every option as the caller wrote it. An id whose options object is missing or empty counts as absent, two ids that both carry options are left byte for byte, and the file is replaced by rename so an interrupted write never truncates it. A file that is not JSON, or whose `pluginConfigs`, id entry or options value is not a plain object, is refused: the supervisor exits 1 and the reason is in `supervisor.log`. A provided file's persona is not reconciled with the launch argument; `docs/backlog.md` records that gap. `.kit/settings-plugin-key-test.sh` pins both ids against the two manifests.

### Pre-Launch Gate

Before every launch the supervisor waits, for 24 polls five seconds apart, for the launch persona to be free in two places: the machine-global commons store for the load mode (`find_global_store` picks the inline store under `--dev` and the installed store otherwise), and the workdir's `.agentic-heartbeat.json`. The commons half counts a `persona:<persona>` claim live while its session's `lastSeen` is younger than `staleAfterMs`. The heartbeat half counts the holder stale once its entry's age exceeds `staleAfterMs`, and an absent file as free. Both halves receive the persona and the bound as program arguments rather than spliced into the program text, so a value carrying code is read as data, and a bound that is not a number counts every holder as live. A store or heartbeat file that fails to parse counts as held for that poll. No store found for the load mode is `GATE FAIL`, exit 2, and a timeout is `GATE TIMEOUT`, exit 2.

### Launch

The child is `claude -p` with stream-json on both ends, started as a coproc so its stdin is a pipe that EOF can close. It loads the installed plugin unless `--dev` adds `--plugin-dir` for this checkout, attaches the Discord relay unless `--no-channel`, and runs with `--model "${MODEL:-$SUPERVISOR_MODEL}" --effort "${EFFORT:-$SUPERVISOR_EFFORT}"`, so the default is opus at medium effort and an exported `MODEL` or `EFFORT` overrides it. `.kit/live-common.sh` exports `haiku` as the live suites' model for exactly that reason. The child's pid is saved from `$!` at launch and every later read uses that copy, because bash unsets the coproc's own variables the moment it reaps the child and the script runs under `set -u`.

Every launch opens with one synthetic priming turn marked `[SUPERVISOR-PRIMING]`. It carries the skill-load instruction whatever `--no-channel` says, and the reply-tool instruction when the channel is attached. A `--prompt` goes to child 1 only, as its own second turn: the supervisor waits up to `supervisorPrimingWaitS` for the priming turn's `result` line, then writes the goal framed as the operator's trusted task. On a timeout it writes the goal anyway, and when the child has already died it skips the write. A child gone before its stdin could be written to is logged and falls through to the accounting below. The prompt is cleared after that first send, so a relaunch never inherits it.

### Poll Loop

Every `supervisorPollMs` the supervisor reads the persona store and the heartbeat and hands one snapshot to `bin/supervise-decide.mjs`, a pure function with no I/O: the newest `root_complete` together with whether its detail text contains `backfilled`, the newest `shutdown_requested`, `restart_requested` and critical `context_budget_crossed`, the heartbeat's session id and `lastSeen`, and the counters. The decision's priority order:

1. `stop_budget`: the restart count reached `supervisorMaxRestartsPerHour`. Exit 4.
2. `stop_crash_loop`: `supervisorCrashLimit` consecutive crashes, the same limit the natural-exit path reads. Exit 3.
3. `stop_complete`: a `shutdown_requested` newer than the child's start. Exit 0.
4. `restart_passive`: a `restart_requested` newer than the child's start. The child is stopped and relaunched with the goal tree kept, with no crash or restart accounting.
5. `restart_passive`: a `root_complete` newer than the child's start that is not backfilled. The goal is done, and the supervisor returns to passive with a fresh child, again unaccounted.
6. `restart`: a critical budget crossing newer than the child's start, or a hung child, which is a heartbeat for the child's own session older than `staleAfterMs` once `staleAfterMs` has passed since launch. Accounted: a crash when the exit was non-zero inside `supervisorMinRunMs`, and one more restart in the hour either way.
7. `continue`.

A backfilled `root_complete` is the hook's backstop for a turn that did tool work with no active goal tree, and it is not a completion. The child keeps running, and only the triggers below it can restart it. The reader, `get_root_complete`, takes the timestamp and the flag from one read of the newest `root_complete`, so a real completion followed within one poll by a backfilled one reads as backfilled; `docs/backlog.md` records that.

### Natural Exit

When the child exits on its own, the supervisor reads the store once more and takes the first match in this order: a `shutdown_requested` newer than the child's start ends the run with exit 0; a `restart_requested` newer than the start relaunches unaccounted; a `root_complete` newer than the start relaunches unaccounted, logged as `RESTART_PASSIVE` when the root is real, and as a `NOTE:` line naming the backfilled root when it is backfilled and the child exited 0. Every other exit is accounted. The crash counter increments when the exit was non-zero and the child ran less than `supervisorMinRunMs`, and resets to zero otherwise; the restart count is the number of restarts in the trailing hour. The budget is checked before the crash limit: exit 4 at `supervisorMaxRestartsPerHour`, then exit 3 at `supervisorCrashLimit`. A backfilled root with a non-zero exit takes this accounted path like any crash. A backfilled relaunch has no rate bound of its own, and the natural-exit relaunch never looks for a surviving `claude.exe` under a dead wrapper; both are on `docs/backlog.md`.

### Stop Phases

Every stop path calls `stop_child`. A failed tree kill is retried against a 30-second budget that is checked before each attempt, so one slow attempt can end past it. Every path except the cleanup trap then waits for the child's real exit code. The stop runs in phases. A phase counts as stopped only once every process in the snapshot is verified gone; a phase can also end unverified or failed, and the stop falls through to the next one.

- It snapshots the child's Windows process tree first, recording each process's pid and start time.
- It sends EOF by closing the coproc write end, then waits `supervisorStopGraceMs`.
- It sends TERM to the wrapper, then waits another `supervisorStopGraceMs`.
- It runs `taskkill` on the tree and force-kills each snapshot process still matching both its pid and its start time.
- A survivor of a resolved snapshot gets up to 30 seconds of retries. A tree that could not be resolved at all is re-snapshotted once, and reported if that read fails too.
- If a stop that ends the supervisor still cannot be verified, the supervisor exits with code 5. A relaunch logs the failure and proceeds.
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
| `bin/agentic-common.sh` | Shared helpers: `emit_settings_json`, `ensure_settings_plugin_ids`, `valid_persona_name`, `find_global_store`, `wait_persona_free_both`, `poll_decisions`, `poll_heartbeat` |

### Test Coverage

The offline suites run with no `claude` session and no persona claim, so they run beside a live fleet. The live suites launch real children, and `.kit/live-all.sh` runs the ones its roster names.

- `.kit/supervisor-unit-test.mjs`: `bin/supervise-decide.mjs`'s decision unit, including the crash limit read from the supervisor's setting, a backfilled root yielding no restart, its real-root control, and a backfilled root still restarting on a hung heartbeat or a critical crossing. Offline.
- `.kit/supervisor-natural-exit-test.sh`: the natural-exit path and the decide path's `RESTART_PASSIVE`, driven through the real `bin/supervise.sh` with a stub `claude` and an isolated `HOME`. Cases: a backfilled root with exit 0 relaunches unaccounted with the `NOTE:` line and no `RESTART_PASSIVE`; a real root takes the natural-exit `RESTART_PASSIVE`; a real `root_complete` written while the child is still alive takes the decide path's `RESTART_PASSIVE` and relaunches; an exit 7 in the poll loop counts as a crash; a backfilled root with exit 7 takes the crash path; a child whose stdin is already gone at launch is counted and relaunched. It also pins that the `backfilled` substring the reader tests for sits inside the hook's backstop detail and no other `root_complete` detail. Offline.
- `.kit/supervisor-model-test.sh`: `supervisorModel` and `supervisorEffort` reaching the launch flags and an exported `MODEL` or `EFFORT` winning over each, both directions of both flags across a real process boundary, the shared numeric rule clause by clause, each numeric setting's own refusal line driven through the real script, the `supervisorPsBoundS` fallback, and a structural pin that every numeric setting is either checked by `positive_number` or emitted and never read by the script itself. Offline.
- `.kit/settings-plugin-key-test.sh`: both plugin ids in the emitted settings, completion of a provided single-id file with its options and persona kept, refusal of shapes that cannot hold options, refusal of a persona or cadence that could break out of the JSON, the same persona class in both files that check it, and `staleAfterMs` refused at startup even with a settings file provided and read as data by both halves of the gate. Offline.
- `.kit/channel-reply-instruction-test.sh`: the priming turn carries the skill-load instruction under both `--no-channel` values and the reply-tool instruction only with a channel attached, read from the script's own text. Offline.
- `.kit/live-stopprocesstree-test.sh`: the stop-path helpers and `stop_child` itself, extracted from `bin/supervise.sh`, against real Windows processes: a wrapper whose native child survives it, a wrapper that ignores TERM and forces the KILL phase, the PowerShell bound holding, and a CIM failure read as unverified. It launches no `claude` session, so it runs beside a live fleet on its own; `live-all.sh` does not run it.
- `.kit/live-restartrequest-test.sh`: a reader's restart request stops a real `claude` child and relaunches one, with the claim handed over and the plan kept. Live.

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

**`agentic_say`** (reader only)

Writes an operator record into the commons store. `urgent: true` marks the record for delivery inside the owner's running turn (see Delivery). Refused when:
- The calling session is the owner (owners cannot message themselves)
- The calling session does not hold a reader claim on the target persona

**`agentic_inbox`** (reader only)

Returns unread replies to the caller's records. A record still `pending` while the owner's commons entry shows a turn in flight (`turnStartedAt` in the machine-global commons store, live while the entry's `lastSeen` is within `staleAfterMs`) comes back with `deferred: true` and `turnRunningMs`. A `resolved` record carries `outcome`, `note` and `resolvedAt` beside `reply`. The store is shared across the machine, so a reader in another working directory sees the same state. Refused when:
- The calling session is the owner
- The calling session does not hold a reader claim on the target persona

**`agentic_resolve`** (owner only)

Marks a record addressed to the owner's persona as `resolved`, writing `resolvedAt`, an `outcome` of `done` or `declined`, and a short `note`. `answered` means a turn replied; `resolved` means the work the record asked for is finished or will not be done, which is what a sender counting rounds per steer needs. Takes the record id (`<persona>-<sender session id>-<seq>`). Refused when:
- The calling session is not the owner (a reader holding the persona cannot resolve)
- The record is not listed under the caller's persona
- The record is still `pending` (not delivered yet) or `skipped` (its writer had no live claim)
- The `note` is longer than 2000 characters (it goes whole into the shared store, so it is bounded at the handler)

### Record shapes

All records live in the global store (machine-wide, one store per plugin). Key formats:

| Key format | Type | Description |
|---|---|---|
| `inbox:<persona>:<writer session id>:<seq>` | `inbox` | An operator message from a reader to an owner. `status` runs `pending` (written, not yet read), `delivered` (submitted to the owner's turn), `answered` (that turn replied), `resolved` (the owner marked the work done or declined through `agentic_resolve`), or `skipped` (the writer had no live claim when the tick reached it) |
| `reply:<persona>:<record id>` | `reply` | The owner's reply to an inbox record |
| `ask:<persona>:<ask id>` | `ask` | A question from the owner to a reader |
| `reader:<persona>` | `reader` | A reader claim on a persona (no session id in the key) |

**Record-id format:** `ask-<node id>-<ms>` where `<node id>` is the persona's node id and `<ms>` is a millisecond timestamp.

**TTL:** 24 hours, swept on the cost-summary cadence (every `costSummaryEveryNTicks` ticks). Only the owner sweeps records; readers cannot delete records they do not own. The sweep never removes a `pending` record, whatever its age: a pending record whose writer is gone leaves through the drain's own `skipped` route, so one still pending is unread live work. An inbox record ages off the latest of its write, delivery and resolution times, and its reply is swept with it rather than on the reply's own age; only an orphan reply with no inbox record ages on its own. Every record the sweep removes (inbox, reply, ask) is appended to `.agentic-channel.jsonl` first, one line per record with `sweptAt` (the window roll's lines carry `rolledAt`), and a refused append leaves every record in the store and logs `sweep_expired_records_failed`.

### Bounded store (item 5)

The store keeps only open asks and a short window of recent inbox/reply records per persona; everything past that window rolls to an append-only `.agentic-channel.jsonl` in the work directory rather than staying in the one rewritten-whole JSON file forever. Enforced on the same cost-summary cadence as the TTL sweep, in `enforceChannelWindow`: `inbox` records that are `skipped` or `resolved` and every `reply` record except an open steer's, combined and ordered oldest-first, past `channelRecordWindow` (default 50) roll to the log. A `pending` record is unread work, and a `delivered` or `answered` record is an open steer whose state the sender still reads, so those stay in the store whatever the window, and so does the reply of a `delivered` or `answered` record; the TTL is the bound on them. A reply whose record is `resolved` or `skipped` rolls with it, and an orphan reply rolls on its own age. Open asks are never touched by this window - only TTL sweeping or the ask's own answer/expire/re-raise lifecycle ends one.

The persona file is bounded the same way, enforced at push time in `persist()` rather than only when the file happens to be parsed at a session load (a long-lived child never reloads): the decision log past `DECISIONS_MAX` (200) and memory past `MEMORY_MAX` (50, pinned entries exempt) both roll their oldest overflow to the same `.agentic-channel.jsonl`.

### Delivery

When the owner's controller drains the inbox on a quiet tick, it submits the text through `$.prompt.submit` as an `[OPERATOR]` user turn. The `[OPERATOR]` marker is prepended to the text before submission. The plugin keeps a list of the turns its own `$.prompt.submit` calls have queued and not yet opened, each entry carrying the exact text it submitted: a delivery entry with its record, a nudge entry, or a plugin entry (the kaizen announcement, the reply backstop, the ask re-raise), pushed right before its submit. At `turn.start` the turn's text is matched against the queued entries and the match is removed wherever it sits: a delivery entry stamps its record with the turn id, a nudge or plugin entry stamps nothing. A turn whose text matches nothing (an external turn from the keyboard, an SDK caller or the channel, a continuation with empty text, or one the plugin cannot place) stamps nothing and, where a delivery is queued, records `operator_stamp_withheld` naming `channel-origin`, `external` or `unaccounted`; the delivery's own turn still stamps it when it opens with its text. Two queued submits with identical text are a known limit: the first queued entry wins. A delivery whose submit is rejected consumes its entry and records `operator_delivery_failed`, and nothing else: the record stays `delivered` as written, an ask it answered stays closed, and no delivery is retried; the TTL ages the record out. When the stamped turn completes with an answer, the controller writes that answer back as the reply and marks the record `answered`. A stamped turn that ends aborted or with an empty answer leaves the record `delivered` with its stamp (`operator_turn_unanswered`); no later turn re-stamps it, and the TTL bounds it.

An `urgent` record does not wait for a quiet tick. On the owner's next passthrough tool call (checked at most once per `urgentCheckMinMs`, default 5000), the record is marked delivered, stamped with the running turn, and its text is appended as `[OPERATOR, urgent] ...` context on that tool's result, which the model reads right after the result. The turn's own answer becomes the reply. A record that answers an open ask is never delivered this way; the tick owns the ask lifecycle.

### Trust boundary

Text reaches the model **only** through `$.prompt.submit` from a record whose writer holds a reader claim on the same persona. Peer messages (cross-session `SendMessage`) are consumed by the `session.receive` hook and **never** reach the model. The hook tests `e.origin.kind` against `peer` and `peer-send-message`; if either matches, it returns `{ consumed: "agentic: peer text is not steering; use agentic_say" }`, which means nothing is queued, shown, or read by the model. A peer message therefore carries no standing: it cannot steer the owner, open an ask, or trigger a nudge.

### Ask wait

When the owner opens an ask (`ask_opened` decision), it sets `pendingAskId` and waits indefinitely. While `pendingAskId` is set:
- Nudges are skipped (the controller does not nudge while waiting for an answer)
- Classify is skipped (the controller does not spend a model call classifying while waiting)
- The nudge cap, the cost cap and the error streak **pause** the leaf rather than block it

When the reader answers the ask, the owner's controller is reactivated (`reactivated (answer to ask)`).

### Section 6 options (defaults in force)

Two options are defined in the plan (section 6) with defaults in force:

1. **Ask wait default:** Whether the owner's ask waits indefinitely for a reply or times out. Default: **60 minutes** (`askOperatorWaitMs` unset, code fallback `hooks/index.ts:142`).
2. **Peer text:** Whether peer text is consumed by the `session.receive` hook or passed through with a `[PEER]` prefix. Default: **consumed** (the hook returns `{ consumed: reason }` and nothing is queued, shown, or read by the model).

The operator has not yet ruled on these options; the defaults are in force.

### Test coverage

- `.kit/live-operator-test.sh` : phase 1 across two real processes, a reader's `agentic_say` delivered to the owner and the reply read back through `agentic_inbox`
- `.kit/controller-tick-test.mjs` : S3 (ask lifecycle), S4 (peer doorbell), S6 (answer linkage), S9 (cost cap ask opener), and the Section 13 cases: the scorer's round, the error streak opening an ask, the git probe's dirty-count cadence, health red then green reaching the turn, plan activation and the post-completion stall guard, the planner failure cap, stale-holder takeover, lesson injection, and the budget latch
- `.kit/assert-decisions.js` : decision log assertions over the live stores (goaltree chain and nudge pin, budget crossings, operator phase 1 order)

The supervisor's own suites are listed under the Supervisor section's Test Coverage above.

**Runner lock:** `live-all.sh` writes `.kit/RUNNING` at start and refuses to start if it already exists (exit 8). After a killed gate, confirm no `claude` child with `--plugin-dir` is running, then `rm .kit/RUNNING`.

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
