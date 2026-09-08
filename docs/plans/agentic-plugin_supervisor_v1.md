# Agentic Plugin: Supervisor (Outer Loop for Days-Long Runs)

**Status**: Proposed
**Created**: 2026-09-08T23:30:00Z
**Author**: DeepSeekHarness
**Reviewer**: Fable

## 1. Purpose

A persona session cannot outlive one process. The plugin already drives turns by itself while the process is alive (the controller tick nudges through `$.prompt.submit`, `index.ts:1429-1445`). What it cannot do is survive its own context filling up or its own process ending. The close-out nudge at `index.ts:1205-1210` tells the worker to stop "until the operator compacts", and in a days-long run there is no operator.

The supervisor is that operator: a process outside Claude Code that starts the CLI with the plugin, watches for the end-of-life signals, ends the session cleanly, waits for the persona to be free, and starts the next one against the same goal tree.

## 2. Facts the design rests on

All read at `c7722e3`.

- State lives outside the process. Goals, decisions, memory sit in the global store file (`~/.claude/plugins/store/agentic-plugin_inline-725b37f2a6ed.json`); the per-cwd `.agentic-personas.json` and `.agentic-heartbeat.json` carry ownership. A fresh session reads the same tree. No `--resume` or `--continue`: they reload the transcript, which is the thing we are trying to shed.
- A restarted session becomes owner by the stale-holder promotion at `index.ts:680` once the previous heartbeat is older than `staleAfterMs` (90 s), or immediately if the persona is free. `agentic_identity` is the forcible path and stays out of scripts; its own description says operator only.
- The signals a supervisor can read are already written as decisions: `context_budget_crossed` with `critical:` (`index.ts:1187-1194`), `root_complete` (`index.ts:1086`), `persona_yield*`, and the heartbeat `lastSeen` (`index.ts:519`). Child exit code is the other signal.
- `wait_persona_free` in `.kit/live-common.sh` is exactly the pre-launch gate a supervisor needs (with W2's retry on read error). It moves to a shared location the supervisor and the suites both source rather than being copied.
- A piped stream-json child stays alive with stdin open and no further input. Closing stdin is the graceful stop.
- `README.md:3` says "no external supervisor". Still true of the plugin's inside; item 5 adds one outside. That sentence is reworded in the item 5 closing commit, not in this plan.

## 3. Decisions

### D1. Restart triggers

Restart on:
- Child exit (any code, including 0 after a non-root_complete reason).
- `context_budget_crossed` with `critical:` newer than the child's start timestamp.
- Heartbeat `lastSeen` older than 3 x `heartbeatMs` while the child is alive (hung session).

Stop, do not restart, on:
- `root_complete` newer than the child's start timestamp. The run is over. Supervisor exit 0.

Alternative weighed: restart on the close-out crossing instead of critical. Rejected: the close-out nudge is the worker's chance to bank state; critical is the point where it has had that chance.

### D2. Graceful stop

Close the child's stdin. Wait up to `stopGraceMs` (default 60 s) for exit. If the child has not exited by then, kill the process. Log which path was taken (`stdin-close` or `kill`).

### D3. Pre-launch gate

Before every launch, including the first, wait for the persona to be free with the W2 semantics (read error counts as live, timeout is the only exit). Timeout is a supervisor failure: exit 2, no launch.

The gate helper moves to `.kit/supervisor-common.sh` (new file), sourced by both `bin/supervise.sh` and the live suites. `live-common.sh` sources it for `wait_persona_free` to avoid a second implementation.

### D4. Crash-loop guard

If the child exits within `minRunMs` (default 120 s) three times in a row, stop with exit 3. A restart budget per hour (default 6) applies on top. Without this, a broken plugin restarts forever at full model cost.

### D5. Close-out nudge text

Under a supervisor, "until the operator compacts" is false. Change `index.ts:1208` to name what actually happens: the session will be restarted at the critical threshold, so bank state now. One line, part of item 5's code section, not the plan.

### D6. Language and location

Bash, `bin/supervise.sh`, sourcing the shared gate helper. Reason: every persona run so far launches from Git Bash, the gate and settings helpers exist in bash, and a second implementation of `wait_persona_free` in PowerShell is a drift surface. The house default is PowerShell; this is the exception, stated here. Argue for PowerShell only if the helper port is carried in the same commit.

### D7. Run record

Each child gets `.kit/runs/supervisor-<start-stamp>/child-<n>/` with stdout, stderr, the debug file, and a `.exit` marker. The supervisor appends one line per event (launch, signal seen, stop path, exit code) to `supervisor.log` in the run dir. Same shape as `live-all.sh`.

### D8. What the first prompt is

The supervisor takes the persona name and an optional opening prompt. With a tree already in the store it sends nothing and lets the tick nudge. With an empty tree it sends the opening prompt once. The suite exercises both children (first with a prompt, second with none).

## 4. State additions

No new state in `AgentState`. The supervisor is entirely outside the plugin process. The only code change inside the plugin is D5 (the close-out nudge text at `index.ts:1208`).

The supervisor's own state (restart count, per-hour budget, crash-loop counter, current child index) is local to the bash script. No persistence across supervisor restarts is needed: the supervisor is the outer loop, not the inner one.

## 5. Files

| File | Change |
|---|---|
| `bin/supervise.sh` (new) | The supervisor loop. Sources `.kit/supervisor-common.sh`. |
| `.kit/supervisor-common.sh` (new) | `wait_persona_free` (moved from `live-common.sh`), `emit_settings_json` (moved), `poll_store` (read the global store for signal decisions), `poll_heartbeat` (read the heartbeat sidecar for liveness). |
| `.kit/live-common.sh` (modified) | Sources `.kit/supervisor-common.sh` for `wait_persona_free` and `emit_settings_json`. The functions are defined there, not duplicated. |
| `hooks/index.ts` (modified) | D5: close-out nudge text at line 1208. |
| `.kit/live-supervisor-test.sh` (new) | Acceptance test, section 7. |
| `docs/plans/agentic-plugin_supervisor_v1.md` | This file. |
| `README.md` (closing commit) | Reword line 3 "no external supervisor". |

## 6. Configuration surface

New options in `plugin.json` (all have defaults, all optional):

| Option | Default | Description |
|---|---|---|
| `supervisorStopGraceMs` | 60000 | Max wait after stdin close before kill. |
| `supervisorMinRunMs` | 120000 | Child lifetime below this counts as a crash-loop candidate. |
| `supervisorCrashLimit` | 3 | Consecutive crashes within `minRunMs` that stop the supervisor. |
| `supervisorMaxRestartsPerHour` | 6 | Restart budget per rolling hour. |
| `supervisorHeartbeatStaleMult` | 3 | Heartbeat `lastSeen` older than this x `heartbeatMs` = hung. |

These are read by the supervisor script (not the plugin), via the settings JSON it emits for the child.

## 7. Acceptance test

`.kit/live-supervisor-test.sh`, short profile with the context thresholds low enough that critical crosses inside about five turns (the 2b plan's numbers at `docs/plans/agentic-plugin_context-budget_v1.md:64`: info=300 tokens, closeout=500 tokens, critical=700 tokens, chars/4).

Assertions on persisted facts only, `wait_for_fact` gated:

- **F0**: No `persona_yield*` in the run. The gate did its job.
- **F1**: Supervisor launched child 1 after a gate line (`live=` printed in `supervisor.log`).
- **F2**: `context_budget_crossed` `critical:` appears in the store during child 1.
- **F3**: Child 1 exits by the graceful path (`.exit` marker present, `supervisor.log` names `stdin-close`).
- **F4**: Gate waited or passed before child 2 (`supervisor.log` line), child 2 started, same root goal id as child 1 (both in the store).
- **F5**: Child 2 continues the tree (an `activated` or `nudge_sent` decision newer than child 2's start timestamp).
- **F6**: `root_complete` ends the run: supervisor exit 0, no child 3 (no `child-3/` directory).

Plus a unit test for the trigger logic (`.kit/supervisor-unit-test.mjs`): the "is a restart due" question is code. Test cases:
- Child exited non-zero, no `root_complete`, no `critical` crossing: restart.
- Child exited non-zero, `root_complete` newer than start: do not restart.
- `context_budget_crossed` `critical:` newer than start: restart.
- `context_budget_crossed` `closeout:` (not critical): do not restart.
- Heartbeat `lastSeen` older than 3x `heartbeatMs`, child alive: restart.
- Heartbeat `lastSeen` older than 2x `heartbeatMs`, child alive: do not restart.
- 3 consecutive exits within `minRunMs`: stop (crash loop).
- Restart budget exhausted (7th restart in the hour): stop.

## 8. Invariants

1. The supervisor never writes to the store. It reads the store for signals and writes only to its own run dir.
2. The supervisor never calls `agentic_identity`. It relies on stale-holder promotion.
3. The supervisor never uses `--resume` or `--continue`.
4. The supervisor sources the same `wait_persona_free` as the suites. One implementation, one behavior.
5. The supervisor's own exit code is meaningful: 0 = run complete, 2 = pre-launch gate timeout, 3 = crash loop, 4 = restart budget exhausted.
