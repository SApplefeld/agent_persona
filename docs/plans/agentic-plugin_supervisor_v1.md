# Agentic Plugin: Supervisor (Outer Loop for Days-Long Runs)

**Status**: Proposed
**Created**: 2026-09-08T23:24:52Z (commit `07acd9f`; revised in place per Y0 to Y9)
**Author**: DeepSeekHarness
**Reviewer**: Fable

## 1. Purpose

A persona session cannot outlive one process. The plugin already drives turns by itself while the process is alive (the controller tick nudges through `$.prompt.submit`, `index.ts:1429-1445`). What it cannot do is survive its own context filling up or its own process ending. The close-out nudge at `index.ts:1205-1210` tells the worker to stop "until the operator compacts", and in a days-long run there is no operator.

The supervisor is that operator: a process outside Claude Code that starts the CLI with the plugin, watches for the end-of-life signals, ends the session cleanly, waits for the persona to be free, and starts the next one against the same goal tree.

## 2. Facts the design rests on

All read at `c7722e3` except where noted.

- **State lives outside the process, in the working directory.** Persona state (goals, decisions, memory) sits in `.agentic-personas.json` in the session's working directory (`index.ts:98`, `storePath`; every suite reads it there, `live-common.sh:57,64,93`). The plugin's `$.fs` is sandboxed to the working directory, so this cannot be otherwise. The global store (`~/.claude/plugins/store/agentic-plugin_inline-725b37f2a6ed.json`) holds only `commons:<sessionId>` claims; it is 260 bytes on this box right now with no decisions key. Consequence: **the supervisor runs every child in one fixed working directory, passed as an argument; the tree continues only because the directory does.** That is the continuity mechanism, and it is why no `--resume`/`--continue` is needed (they would reload the transcript, the thing we are trying to shed).
- A restarted session becomes owner by the stale-holder promotion at `index.ts:680` once the previous heartbeat is older than `staleAfterMs` (90 s default), or immediately if the persona is free. `agentic_identity` is the forcible path and stays out of scripts; its own description says operator only.
- The signals a supervisor can read are already written as decisions in `.agentic-personas.json`: `context_budget_crossed` with `critical:` (`index.ts:1187-1194`), `root_complete` (`index.ts:1086`), `persona_yield*`, and the heartbeat `lastSeen` (`.agentic-heartbeat.json` sidecar). Child exit code is the other signal.
- The decisions array is capped at 200 (`agent-state.ts:152`, `DECISIONS_MAX`; applied at `:376`). A signal older than 200 decisions rotates out, so the supervisor's poll cadence must be shorter than 200 decisions' worth of time. **Poll cadence: every 10 s** (stated, Y0).
- `wait_persona_free` in `.kit/live-common.sh` is exactly the pre-launch gate a supervisor needs (with W2's retry on read error). It moves to a shared location the supervisor and the suites both source rather than being copied (Y7).
- A piped stream-json child stays alive with stdin open and no further input. Closing stdin is the graceful stop.
- `README.md:3` says "no external supervisor". Still true of the plugin's inside; item 5 adds one outside. That sentence is reworded in the item 5 closing commit, not in this plan.

## 3. Decisions

### D1. Restart triggers

Restart on:
- Child exit (any code, including 0 after a non-`root_complete` reason).
- `context_budget_crossed` with `critical:` newer than the child's start timestamp (read from `<workdir>/.agentic-personas.json` under the persona key, with W2 read-error semantics).
- Heartbeat `lastSeen` older than 3 x `heartbeatMs` while the child is alive (hung session).

Stop, do not restart, on:
- `root_complete` newer than the child's start timestamp. The run is over. Supervisor exit 0.

Alternative weighed: restart on the close-out crossing instead of critical. Rejected: the close-out nudge is the worker's chance to bank state; critical is the point where it has had that chance.

The "is a restart due" question is code, not prose (Y9). It lives in `bin/supervise-decide.mjs`: input JSON (child start timestamp, the newest signal timestamps, the decision log, the crash-loop and restart-budget counters), output `{action, reason}` where `action` is one of `restart`, `stop_complete`, `stop_crash_loop`, `stop_budget`. The bash loop calls it and acts on `action`. This is the same stage rule as everywhere else: the code decides.

### D2. Graceful stop

Close the child's stdin. Wait up to `stopGraceMs` (default 60 s) for exit. If the child has not exited by then, kill the process. Log which path was taken (`stdin-close` or `kill`).

A child whose heartbeat is stale is hung, so it will not read stdin close: the hung case goes to kill after `stopGraceMs` like any other (Y8). The log line names `kill`. The F3 assertion on `stdin-close` applies only to the critical path, where the child is responsive.

### D3. Pre-launch gate

Before every launch, including the first, wait for the persona to be free with the W2 semantics (read error counts as live, timeout is the only exit). Timeout is a supervisor failure: exit 2, no launch.

The gate helper lives at `bin/agentic-common.sh` (new file), sourced by both `bin/supervise.sh` and the live suites. `.kit/live-common.sh` sources it for `wait_persona_free` and `emit_settings_json`, so there is one implementation, not two (Y7). The gate reads the global commons store (the only place it reads it).

### D4. Crash-loop guard

If the child exits within `minRunMs` (default 120 s) `supervisorCrashLimit` (default 3) times in a row, stop with exit 3 (crash loop). A restart budget of `supervisorMaxRestartsPerHour` (default 6) applies on top; when the rolling-hour budget is exhausted, stop with **exit 4** (Y8). Without this, a broken plugin restarts forever at full model cost.

### D5. Close-out nudge text

Under a supervisor, "until the operator compacts" is false. Change `index.ts:1208` to name what actually happens: the session will be restarted at the critical threshold, so bank state now. One line, part of item 5's code section, not the plan.

### D6. Language and location

Bash, `bin/supervise.sh`, sourcing `bin/agentic-common.sh`. Reason: every persona run so far launches from Git Bash, the gate and settings helpers exist in bash, and a second implementation of `wait_persona_free` in PowerShell is a drift surface. The house default is PowerShell; this is the exception, stated here. Argue for PowerShell only if the helper port is carried in the same commit.

### D7. Run record

Each child gets `<rundir>/child-<n>/` with stdout, stderr, the debug file, and a `.exit` marker. The supervisor appends one line per event (launch, signal seen, stop path, exit code) to `<rundir>/supervisor.log`. Same shape as `live-all.sh`. The run dir is fixed for the whole run (one directory, all children), so the tree's working directory and the run record are not confused.

### D8. What the first prompt is

The supervisor takes the persona name and an optional opening prompt. With a tree already in the store it sends nothing and lets the tick nudge. With an empty tree it sends the opening prompt once. The suite exercises both children (first with a prompt, second with none) (Y6, section 7).

## 4. State additions

No new state in `AgentState`. The supervisor is entirely outside the plugin process. The only code change inside the plugin is D5 (the close-out nudge text at `index.ts:1208`).

The supervisor's own state (restart count, per-hour budget, crash-loop counter, current child index) is local to the bash script and passed to `bin/supervise-decide.mjs` on each decision. No persistence across supervisor restarts is needed: the supervisor is the outer loop, not the inner one.

## 5. Files

| File | Change |
|---|---|
| `bin/supervise.sh` (new) | The supervisor loop. Sources `bin/agentic-common.sh`, calls `bin/supervise-decide.mjs`. |
| `bin/supervise-decide.mjs` (new) | The pure "is a restart due" decision unit. Input JSON, output `{action, reason}`. Sourced by the bash loop and imported by the unit test. |
| `bin/agentic-common.sh` (new) | `wait_persona_free`, `emit_settings_json`, the two polls (decision-log poll, heartbeat poll). Shared product/test helper. |
| `.kit/live-common.sh` (modified) | Sources `bin/agentic-common.sh` for `wait_persona_free` and `emit_settings_json`. The functions are defined there, not duplicated. |
| `hooks/index.ts` (modified) | D5: close-out nudge text at line 1208. |
| `.kit/live-supervisor-test.sh` (new) | Acceptance test, section 7. |
| `.kit/supervisor-unit-test.mjs` (new) | Unit test for `bin/supervise-decide.mjs`, section 7. |
| `docs/plans/agentic-plugin_supervisor_v1.md` | This file. |
| `README.md` (closing commit) | Reword line 3 "no external supervisor". |

**Launch line** (Y5), as the suites use it (`live-self-review-test.sh:109`):

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --model haiku \
  --permission-mode acceptEdits \
  --debug-file "$DEBUG" \
  > "$OUT" 2> "$ERR"
```

run in the fixed working directory (Y0), with the permission mode as an explicit flag (`--permission-mode acceptEdits`): an unattended days-long run cannot block on a permission prompt, and the script must not rely on this machine's default mode.

## 6. Configuration surface

`plugin.json` carries `userConfig` declarations (heartbeat, stale, tick, nudge, health, git), and the budget options are declared-but-unread there; the budget options actually arrive through `--settings` (`index.ts:326`). The `supervisor*` values are not plugin options at all: nothing in the plugin reads them, so they are **arguments or environment variables of `bin/supervise.sh` with defaults in the script** (Y3):

| Variable | Default | Description |
|---|---|---|
| `supervisorStopGraceMs` | 60000 | Max wait after stdin close before kill. |
| `supervisorMinRunMs` | 120000 | Child lifetime below this counts as a crash-loop candidate. |
| `supervisorCrashLimit` | 3 | Consecutive crashes within `minRunMs` that stop the supervisor (exit 3). |
| `supervisorMaxRestartsPerHour` | 6 | Restart budget per rolling hour (exit 4 when exhausted). |
| `supervisorHeartbeatStaleMult` | 3 | Heartbeat `lastSeen` older than this x `heartbeatMs` = hung. |
| `supervisorPollMs` | 10000 | Decision-log / heartbeat poll cadence. |

The supervisor **emits the child's settings JSON itself** and carries three plugin values as its own variables, so the two cannot disagree (Y3): `heartbeatMs` and `staleAfterMs` (D1 staleness and the gate read them), and **`contextBudgetEnabled: true`**. That last one is the finding: `index.ts:344` defaults it to `false`, so without it `context_budget_crossed` never fires and D1's main trigger is dead. One set of shell variables, emitted to the settings JSON and used by the supervisor's checks.

## 7. Acceptance test

`.kit/live-supervisor-test.sh`, short profile, thresholds low enough that critical crosses inside the first two plans (Y4).

**Thresholds** (Y4): `contextBudgetInfoTokens=300`, `contextBudgetCloseoutTokens=500`, `contextBudgetCriticalTokens=700`, chars/4, `contextBudgetReadEveryNTicks=1`. Cite `live-budget-test.sh:58-60` (the budget suite's calibrated numbers), not `context-budget_v1.md:64` (that file's 1000/2000/3000 tokens are the suite's plan-level example, not the calibrated test values).

**Nudge cadence** (Y4): under a supervisor, a child's turns come only from tick nudges, and the defaults are `nudgeFloorMs` 5 min and `nudgeIdleMs` 2 min (`index.ts:331-332`). The first nudge passes the floor because `lastNudgeAt` starts at 0 (`index.ts:100`); every later one waits the 5-min floor. The short profile must set both low: `emit_settings_json` emits `nudgeIdleMs` but not `nudgeFloorMs` today, so the supervisor's settings JSON adds `nudgeFloorMs`. **Test values: `nudgeIdleMs=5000`, `nudgeFloorMs=5000`.** With a 10 s tick, the first nudge is due within ~15 s and each later one within ~15 s, so five turns land in roughly **2-3 minutes per child**, not the 25 minutes the defaults would give.

**Opening prompt** (Y6): a `goal_create` with a roadmap of three trivially completable plans (the goaltree suite's haiku set is the model: three short steps, each one `goal_done`), thresholds from above so critical crosses during plan 1 or 2, and child 2 finishes the rest. **Assert on `root_complete`, never on the plan count** (W5: planner variance is a known flake class).

**Assertions** on persisted facts only, `wait_for_fact` gated:

- **F0**: No `persona_yield*` in the run. The gate did its job.
- **F1**: Supervisor launched child 1 after a gate line (`live=` printed in `supervisor.log`).
- **F2**: `context_budget_crossed` `critical:` appears in the store during child 1.
- **F3**: Child 1 exits by the graceful path (`.exit` marker present, `supervisor.log` names `stdin-close`). This is the critical path only; the hung path logs `kill` (Y8).
- **F4**: Gate waited or passed before child 2 (`supervisor.log` line), child 2 started, same root goal id as child 1 (both in the store).
- **F5**: Child 2 continues the tree (an `activated` or `nudge_sent` decision newer than child 2's start timestamp).
- **F6**: `root_complete` ends the run: supervisor exit 0, no child 3 (no `child-3/` directory).

**Red-run statement** (Y9): the suite at HEAD, before code, fails at F1 (no `supervisor.log`, no `bin/supervise.sh`), exit 1, pasted in the hand-back.

**Unit test** (Y9): `bin/supervise-decide.mjs` is a small pure Node file (input JSON, output `{action, reason}`) that the bash loop calls and the unit test imports. Bash cannot import into Node, so the decision is in Node. `.kit/supervisor-unit-test.mjs` test cases:

- Child exited non-zero, no `root_complete`, no `critical` crossing: `restart`.
- Child exited non-zero, `root_complete` newer than start: `stop_complete`.
- `context_budget_crossed` `critical:` newer than start: `restart`.
- `context_budget_crossed` `closeout:` (not critical): do not restart on that signal alone.
- Heartbeat `lastSeen` older than 3x `heartbeatMs`, child alive: `restart`.
- Heartbeat `lastSeen` older than 2x `heartbeatMs`, child alive: do not restart.
- 3 consecutive exits within `minRunMs`: `stop_crash_loop`.
- Restart budget exhausted (7th restart in the hour): `stop_budget`.

## 8. Invariants

1. The supervisor never writes to the store. It reads the store for signals and writes only to its own run dir.
2. The supervisor never calls `agentic_identity`. It relies on stale-holder promotion.
3. The supervisor never uses `--resume` or `--continue`.
4. The supervisor sources the same `wait_persona_free` as the suites. One implementation, one behavior (Y7: holds by construction, both source `bin/agentic-common.sh`).
5. The supervisor's own exit code is meaningful: 0 = run complete, 2 = pre-launch gate timeout, 3 = crash loop, 4 = restart budget exhausted (Y8).

## 9. Revision table

| Label | Finding | Resolution |
|---|---|---|
| Y0 | Persona state is in the working directory, not the global store | Section 2 fact 1, D1, D7, invariant 1 corrected to `.agentic-personas.json` in the fixed workdir |
| Y1 | Invented clock; Created in the future | Entry carries a real stamp and one line correcting both; Created set to commit time `2026-09-08T23:24:52Z` |
| Y2 | Sweep drops `.kit/` | Sweep pasted exactly as written (no `grep -v '^\.'`) |
| Y3 | Section 6 wrong twice; `contextBudgetEnabled` missing | Section 6: supervisor options as script args/env; supervisor emits settings JSON with `heartbeatMs`, `staleAfterMs`, `contextBudgetEnabled:true` |
| Y4 | Wrong line cite; slow turns | Section 7: cite `live-budget-test.sh:58-60`; state `nudgeIdleMs`/`nudgeFloorMs` and wall clock per child |
| Y5 | Launch line missing | Section 5: full `claude -p ...` line with workdir and `--permission-mode acceptEdits` |
| Y6 | Test has no goal | Section 7: opening prompt (`goal_create`, three trivial plans, thresholds), assert `root_complete` not plan count |
| Y7 | Shipped script sources test dir | Section 5, D3, invariant 4: shared helper at `bin/agentic-common.sh` |
| Y8 | Exit codes; hung child | D4: budget exit 4; D2: hung child to `kill` after `stopGraceMs`; F3 critical path only |
| Y9 | Protocol missing: revision table, red-run, testable unit | Section 9 (this table); section 7 red-run statement; `bin/supervise-decide.mjs` named in sections 5 and 7 |
