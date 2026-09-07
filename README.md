# Agentic Plugin

PIANO-esque cognitive layer on Claude Code's Function Hooks API. One plugin module, one `register(on, options)` export, no Agent SDK, no external supervisor. Modules observe at hook boundaries and write to shared `AgentState`; the Controller — the sole actuator — runs on a clock, classifies the situation, and then (and only then) actuates through exactly three channels.

**Status: v0.6.2 — Stage 1 closure.** `tsc --noEmit` clean. Goal tree v3 (root/plan/task, single active leaf), H3 (root completion via planner), H4 (planner fault injection → `planning_failed`), M4 (nudge cap → blocked), M7 (single `guardedWrite()` helper), M9/M10 (goal_resume pauses active leaf), L14–L17 (goal_done score, curation prompt, yield-test cleanup, memory injection log), P3 (decision-log assertions in all 5 live tests), P4 (git init + `v0.6.1` tag) all implemented. 5 live tests in `.kit/`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Claude Code Engine (one process, one session)                      │
│                                                                     │
│  OBSERVE (modules — never actuate):                                 │
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
│  ACTUATE (Controller — sole actor):                                 │
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
- **Controller** is the sole actor. It runs on `$.clock.every`, applies the idle gate, builds a compressed summary of shared state, sends it to `$.model.classify` for the decision (classify *cannot* return anything else — this is the architectural enforcement), optionally calls `$.model.complete` for a reason (only when the decision is not `nudge`), logs it, **then** actuates.
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

**L1**: The idle gate is enforced **in code**, not in the prompt. The tick computes `idleMs = now - lastTurnComplete` and only proceeds to a model call if `idleMs >= nudgeIdleMs`. The model decides **what** (nudge/pause/complete/ask-operator), never **whether** — the threshold is a hard gate.

**C2**: `$.model.classify` returns the decision (one of the labels, nothing else). `$.model.complete` is called **only** when the decision ≠ `nudge`, to get a one-line plain-text reason (no Markdown). Never one call doing both.

**M13**: The nudge cap is checked **before** the classify call — if the cap is already reached, the tick escalates to `ask-operator` immediately without spending a model call.

### Nudge discipline (H2, L1)

- **Floor**: at most one nudge per `nudgeFloorMs` (default 5 min).
- **Cap**: 3 consecutive **sent** nudges without an on-goal turn → escalate to `ask-operator` + pause the goal. The counter increments only when `$.prompt.submit` actually fires (not on floored skips). Resets only on an on-goal score or `complete`.
- **Idle gate**: session must be idle for `nudgeIdleMs` (default 2 min) before any model call. Ticks inside the gate are skipped entirely.
- **Skip**: no active goal or a turn in flight → skip the tick entirely.
- **Visible**: `$.ui.status` shows the goal line while a goal is active; cleared on pause/complete/blocked.
- **H8: Nudged-turn scoring.** When the controller nudges, `$.prompt.submit` bypasses the plugin's own `prompt.submit` hook, so `currentPrompt` is set to the nudge text manually. The `turn.complete` scorer uses a reduced label set (`on-goal`, `drift`, `complete`) for nudged turns — `off-goal-by-instruction` is impossible because the nudge *is* the instruction.

### C4: Clock is enough

The K-turn trigger (every Nth turn triggers a controller evaluation) is **removed**. The clock tick is the sole trigger. Simpler, fewer race conditions.

### Liveness: heartbeat sidecar (C5, M3, L3)

`.agentic-heartbeat.json` in the project root: `{ "<persona>": { sessionId, epoch, lastSeen }, ... }`.

- **Heartbeat** refreshes the sidecar every `heartbeatMs` (default 30s). Never touches the persona store.
- **L3: Owner-only heartbeat.** Only the owner stamps its own heartbeat. A passive reader must **not** overwrite the holder's heartbeat, or it will (a) mask the real holder's staleness and (b) make its own promotion check compare the holder id to itself and never fire.
- **Claim is non-destructive**: the epoch bump makes the old holder **yield on its next write** (guarded write checks the store). No store read-modify-write at claim time.
- **H6: Pre-stamp yield.** Before stamping, the owner verifies ownership by reading the store. If the store's `(sessionId, epoch)` no longer matches, the session yields here (not on its next write) and does **not** stamp. This prevents a demoted owner from overwriting the new owner's heartbeat.
- **Passive reader** re-checks the sidecar on every heartbeat tick and **promotes itself** if the holder is stale (beyond `staleAfterMs`, default 90s) and is not self. With the H6 pre-stamp check, the sidecar is only ever written by the store's current owner, so a stale sidecar means no live owner — no store-owner comparison needed.
- **`lastSeen` is NOT a liveness proof.** It proves the holder stopped stamping, never that it exited. A claim is an *intent*, not a *fact*.
- `lastSeen` is **removed** from `AgentState` (M8, M9). It lives only in the sidecar.

### H4: No session-end event

This build has no `session.end` hook. A session that exits without a clean shutdown leaves its heartbeat entry in the sidecar. The **stale window** (`staleAfterMs`, default 90s) is the only release mechanism: after the holder stops stamping, the entry goes stale and a passive reader can promote. There is no immediate cleanup on exit.

### Yield (non-destructive hand-off)

The **only** store write path is the guarded write — owner-only, epoch-checked. If the store on disk shows a different session or higher epoch, this session:
1. Logs `persona_yield` to `state.decisions[]` (in memory, not persisted to the winner's doc).
2. Appends a JSON line to `.agentic-yields.log` (the sidecar).
3. Sets `isOwner = false`. All subsequent writes are no-ops.
4. Emits `$.ui.log` so the yield is visible in the TTY.

The yield logic is extracted into pure helpers `shouldYield(onDisk, mySessionId, myEpoch)` and `yieldRecord(persona, mySessionId, onDiskSessionId, myEpoch, onDiskEpoch)` in `agent-state.ts`. All six call sites in `index.ts` (controller tick, turn.complete save, goal_create, memory_add, Bash deny, **heartbeat pre-stamp**) use them. Only `$.fs` I/O remains inline.

**Yield log format (H7):** JSONL — one JSON object per line:
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
| `heartbeatMs` | 30000 | Heartbeat interval (ms) |
| `staleAfterMs` | 90000 | How stale before a passive reader can claim (ms) |
| `controllerTickMs` | 30000 | Controller tick interval (ms) |
| `nudgeFloorMs` | 300000 | Minimum gap between nudges (ms) |
| `nudgeIdleMs` | 120000 | Session must be idle this long before a nudge is eligible (ms) |

## Loops

1. **Memory** — distills on `turn.complete` (classify kind, conditional complete for statement), persists to `AgentState`, injects on `prompt.submit` as hidden context. Owns `state.memory[]`.
2. **Monitor** — hooks `session.start` (claim persona), `turn.start`/`turn.complete` (track progress), `tool.call` (count calls). Owns `state.monitor` and `state.decisions[]` (capped at 200).
3. **Goal** — hooks `turn.complete` (score against goal), `tool.call` (serve `goal_create`, enforce constraints). Owns `state.goal`. Steering is **exclusively** the Controller's job.
4. **Controller** — `$.clock.every`, idle gate, classifies, optionally reasons, logs, actuates. The only thing that calls `$.prompt.submit`, `$.ui.toast`, or sets the status line.
5. **Worker** — the main agent, unmodified. Sees injected goal + memory via `prompt.submit`'s `context` array.

## Files

| File | Purpose |
|---|---|
| `hooks/index.ts` | The plugin module (one file, all logic) |
| `hooks/agent-state.ts` | `AgentState` interface + defaults + `shouldYield`/`yieldRecord` pure helpers |
| `.agentic-personas.json` | Persona store (project root) |
| `.agentic-heartbeat.json` | Heartbeat sidecar (project root) |
| `.agentic-yields.log` | Yield sidecar, JSONL (project root) |

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
3. **Try `$.model.fork`** for the controller tick (sees full transcript, shares prompt cache) — Fable suggested, not yet adopted.
4. **Memory decay**: confidence -= f(age, accessCount).
5. **Multiple-goal support**: state.goal → state.goals[], priority ordering.

## License

MIT
