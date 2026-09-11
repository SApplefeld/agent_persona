# Agentic Plugin

PIANO-esque cognitive layer on Claude Code's Function Hooks API. One plugin module, one `register(on, options)` export, no Agent SDK. The plugin needs no supervisor to run one session; `bin/supervise.sh` is the optional outer loop for runs longer than one session. Modules observe at hook boundaries and write to shared `AgentState`; the Controller : the sole actuator : runs on a clock, classifies the situation, and then (and only then) actuates through exactly three channels.

**Status: v0.11.0 : Stage 3 (supervisor).** `tsc --noEmit` clean. Supervisor (`bin/supervise.sh`) drives outer-loop runs: pre-gate (commons + heartbeat), coproc stdin with EOF stop, real exit codes, `supervisor.err` append (not truncate), `PROMPT=""` cleared after first send, `writeClaimDirect` shared across all three claim sites. 12 live tests in `.kit/` (including supervisor suite F1-F6 + F0).

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

`bin/supervise.sh` is the outer-loop supervisor for days-long runs. It:

1. **Pre-gate**: waits for both the commons store and per-directory heartbeat to be free (no live persona claims) before launching a child.
2. **Launch**: starts a child via coproc with stdin as a pipe (not a file), so EOF can be sent to stop it cleanly.
3. **Poll**: watches the store for `context_budget_crossed` decisions and other signals; decides `continue`, `restart`, `stop_complete`, `stop_budget`, or `stop_crash_loop`.
4. **Stop**: sends EOF (close coproc write end), then TERM after `stopGraceMs`, then KILL. Waits for the child and records the real exit code.
5. **Log**: appends to `supervisor.log` and `supervisor.err` (never truncates after launch).

The supervisor never writes the persona store (invariant §8). It uses `supervise-decide.mjs` (pure JS, 9/9 unit tests) for the decision logic. The prompt is cleared after the first send so subsequent launches don't inherit it.

### Key files

| File | Purpose |
|---|---|
| `bin/supervise.sh` | The supervisor script (bash) |
| `bin/supervise-decide.mjs` | Decision logic (pure JS, 9/9 tests) |
| `bin/agentic-common.sh` | Shared helpers (`wait_persona_free_both`, etc.) |
| `.kit/live-supervisor-test.sh` | Supervisor acceptance test (F1-F6 + F0) |

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

**Env shorthand:** The test runner uses `COST_*` env vars (`COST_MAX_NUDGES_PER_HOUR`, etc.) that `agentic-common.sh:59-70` translates into settings. A hook module cannot read the environment directly.

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

Writes an operator record into the commons store. Refused when:
- The calling session is the owner (owners cannot message themselves)
- The calling session does not hold a reader claim on the target persona

**`agentic_inbox`** (reader only)

Returns unread replies to the caller's records. Refused when:
- The calling session is the owner
- The calling session does not hold a reader claim on the target persona

### Record shapes

All records live in the global store (machine-wide, one store per plugin). Key formats:

| Key format | Type | Description |
|---|---|---|
| `inbox:<persona>:<writer session id>:<seq>` | `inbox` | An operator message from a reader to an owner |
| `reply:<persona>:<record id>` | `reply` | The owner's reply to an inbox record |
| `ask:<persona>:<ask id>` | `ask` | A question from the owner to a reader |
| `reader:<persona>` | `reader` | A reader claim on a persona (no session id in the key) |

**Record-id format:** `ask-<node id>-<ms>` where `<node id>` is the persona's node id and `<ms>` is a millisecond timestamp.

**TTL:** 24 hours, swept on the cost-summary cadence (every `costSummaryEveryNTicks` ticks). Only the owner sweeps records; readers cannot delete records they do not own.

### Delivery

When the owner's controller drains the inbox on a quiet tick, it submits the text through `$.prompt.submit` as an `[OPERATOR]` user turn. The `[OPERATOR]` marker is prepended to the text before submission. After that turn completes, the controller reads the last assistant message from `$.session.messages()` and writes it back as the reply.

### Trust boundary

Text reaches the model **only** through `$.prompt.submit` from a record whose writer holds a reader claim on the same persona. Peer messages (cross-session `SendMessage`) are consumed by the `session.receive` hook and **never** reach the model. The hook tests `e.origin.kind` against `peer` and `peer-send-message`; if either matches, it returns `{ consumed: "agentic: peer text is not steering; use agentic_say" }`, which means nothing is queued, shown, or read by the model. A peer message therefore carries no standing: it cannot steer the owner, open an ask, or trigger a nudge.

### Ask wait

When the owner opens an ask (`ask_opened` decision), it sets `pendingAskId` and waits indefinitely. While `pendingAskId` is set:
- Nudges are skipped (the controller does not nudge while waiting for an answer)
- Classify is skipped (the controller does not spend a model call classifying while waiting)
- The nudge cap, the cost cap and the error streak **pause** the leaf rather than block it (see BG1 in plan v15)

When the reader answers the ask, the owner's controller is reactivated (`reactivated (answer to ask)`).

### Section 6 options (defaults in force)

Two options are defined in the plan (section 6, item 6) with defaults in force:

1. **Ask wait default:** Whether the owner's ask waits indefinitely for a reply or times out. Default: **indefinite** (`askOperatorWaitMs` unset, `hooks/index.ts:118`).
2. **Peer text:** Whether peer text is consumed by the controller or passed through with a `[PEER]` prefix. Default: **consumed** (the controller reads peer text and does not pass it through).

The operator has not yet ruled on these options; the defaults are in force.

### Test coverage

- `.kit/live-operator-test.sh` : the full live suite (phases 1, 2, 3)
- `.kit/controller-tick-test.mjs` : S4 (peer doorbell), S9 (cost cap ask opener)
- `.kit/assert-decisions.js` : decision log assertions (ask lifecycle, reply check)

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
