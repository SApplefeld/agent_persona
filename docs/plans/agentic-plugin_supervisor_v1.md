# Agentic Plugin: Supervisor (Outer Loop for Days-Long Runs)

**Status**: In Progress
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
- Heartbeat `lastSeen` older than `staleAfterMs` **and** the sidecar's `sessionId` for the persona equals the current child's session id **and** the child is past its startup grace (hung session; Z5, Z6).

Stop, do not restart, on:
- `root_complete` newer than the child's start timestamp. The run is over. Supervisor exit 0.

Alternative weighed: restart on the close-out crossing instead of critical. Rejected: the close-out nudge is the worker's chance to bank state; critical is the point where it has had that chance.

The "is a restart due" question is code, not prose (Y9). It lives in `bin/supervise-decide.mjs`: input JSON (child start timestamp, the newest signal timestamps, the decision log, the crash-loop and restart-budget counters, **`childSessionId`** (from the stream-json init line's `session_id` field, `live-commons-test.sh:403-410`), **`heartbeatSessionId`** (the sidecar's `sessionId` for the persona), **`launchedAt`** (for the startup grace)), output `{action, reason}` where `action` is one of `restart`, `stop_complete`, `stop_crash_loop`, `stop_budget`. The bash loop calls it and acts on `action`. This is the same stage rule as everywhere else: the code decides.

Two rules for the hung check (Z6). The heartbeat is written owner-only (`index.ts:576`, `if (sess.isOwner)`), so a child that starts while the previous holder's heartbeat is not yet stale becomes a passive reader and writes no heartbeat until the controller-tick promotion at `index.ts:680`. In that window a naive `lastSeen`-only check sees a stale heartbeat from the previous child and kills a healthy one. (1) **Identity key**: the hung check fires only when `heartbeatSessionId` equals `childSessionId`; a sidecar naming another session means the child has not been promoted yet and is "waiting", never "hung". (2) **Startup grace** of `staleAfterMs` after launch: during that window the hung check does not run at all, so a child promoted late is not judged before its first heartbeat write.

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

The supervisor takes the persona name and an optional opening prompt. With a tree already in `.agentic-personas.json` it sends nothing and lets the tick nudge. With an empty tree it sends the opening prompt once. The suite exercises both children (first with a prompt, second with none) (Y6, section 7).

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
  --settings "$(cygpath -w "$RUNDIR/settings.json")" \
  --model haiku \
  --permission-mode "$PERMISSION_MODE" \
  --debug-file "$DEBUG" \
  > "$OUT" 2> "$ERR"
```

run in the fixed working directory (Y0). The permission mode is a **required argument of `bin/supervise.sh`, no default** (Z2): in headless `-p` mode no prompt can be shown, so any tool call the mode does not pre-approve is refused; `acceptEdits` pre-approves file edits and nothing else, so a persona doing real project work (Bash: git, tests, builds) would be denied on every one of those calls. The suite passes `acceptEdits` (the haiku test plans use `Write` and live with it). The runbook line for a days-long worker is `--permission-mode bypassPermissions`: the worker runs any command unattended. The alternative is an allow list in the emitted settings; it is not the default here because on this box allow-list behavior in headless mode has not been shown to discriminate, so it is not a verified control. The settings file is written to `$RUNDIR/settings.json` in the run directory (Z2), not to a suite variable.

**Usage** (Z2):

```
bin/supervise.sh <workdir> <persona> <permission-mode> [--prompt TEXT] [--rundir DIR]
```

## 6. Configuration surface

`plugin.json` declares seven `userConfig` fields (heartbeat, stale, tick, nudge floor, nudge idle, health, git probe) and no budget or self-review field. The budget and self-review options are not declared in the manifest and arrive through `--settings` only (`index.ts:326`). The `supervisor*` values are not plugin options at all: nothing in the plugin reads them, so they are **arguments or environment variables of `bin/supervise.sh` with defaults in the script** (Y3):

| Variable | Default | Description |
|---|---|---|
| `supervisorStopGraceMs` | 60000 | Max wait after stdin close before kill. |
| `supervisorMinRunMs` | 120000 | Child lifetime below this counts as a crash-loop candidate. |
| `supervisorCrashLimit` | 3 | Consecutive crashes within `minRunMs` that stop the supervisor (exit 3). |
| `supervisorMaxRestartsPerHour` | 6 | Restart budget per rolling hour (exit 4 when exhausted). |
| `supervisorPollMs` | 10000 | Decision-log / heartbeat poll cadence. |

The supervisor **emits the child's settings JSON itself** and carries three plugin values as its own variables, so the two cannot disagree (Y3): `heartbeatMs` and `staleAfterMs` (D1 staleness and the gate read them), and **`contextBudgetEnabled: true`**. That last one is the finding: `index.ts:344` defaults it to `false`, so without it `context_budget_crossed` never fires and D1's main trigger is dead. One set of shell variables, emitted to the settings JSON and used by the supervisor's checks. Staleness is single-sourced on `staleAfterMs`: the plugin's own promotion reads it (`index.ts:329`), and the supervisor's hung check does the same, so there is no separate multiplier (Z5). The settings file is written to `$RUNDIR/settings.json` in the run directory, not to a suite variable (Z2).

## 7. Acceptance test

`.kit/live-supervisor-test.sh`, short profile, thresholds low enough that critical crosses inside the first two plans (Y4).

**Thresholds** (Y4): `contextBudgetInfoTokens=300`, `contextBudgetCloseoutTokens=500`, `contextBudgetCriticalTokens=700`, chars/4, `contextBudgetReadEveryNTicks=1`. Cite `live-budget-test.sh:58-60` (the budget suite's calibrated numbers), not `context-budget_v1.md:64` (that file's 1000/2000/3000 tokens are the suite's plan-level example, not the calibrated test values).

**Nudge cadence** (Y4): under a supervisor, a child's turns come only from tick nudges, and the defaults are `nudgeFloorMs` 5 min and `nudgeIdleMs` 2 min (`index.ts:331-332`). The first nudge passes the floor because `lastNudgeAt` starts at 0 (`index.ts:100`); every later one waits the 5-min floor. The short profile must set both low: `emit_settings_json` emits `nudgeIdleMs` but not `nudgeFloorMs` today, so the supervisor's settings JSON adds `nudgeFloorMs`. **Test values: `nudgeIdleMs=5000`, `nudgeFloorMs=5000`.** With a 10 s tick, the first nudge is due within ~15 s and each later one within ~15 s, so five turns land in roughly **2-3 minutes per child**, not the 25 minutes the defaults would give.

**Opening prompt** (Y6): a `goal_create` with a roadmap of three trivially completable plans (the goaltree suite's haiku set is the model: three short steps, each one `goal_done`), thresholds from above so critical crosses during plan 1 or 2, and child 2 finishes the rest. **Assert on `root_complete`, never on the plan count** (W5: planner variance is a known flake class).

**Assertions** on persisted facts only, `wait_for_fact` gated:

- **F0**: No `persona_yield*` in the run. The gate did its job.
- **F1**: Supervisor launched child 1 after a gate line (`live=` printed in `supervisor.log`).
- **F2**: `context_budget_crossed` `critical:` appears in `.agentic-personas.json` during child 1.
- **F3**: Child 1 exits by the graceful path (`.exit` marker present, `supervisor.log` names `stdin-close`). This is the critical path only; the hung path logs `kill` (Y8).
- **F4**: Gate waited or passed before child 2 (`supervisor.log` line), child 2 started, same root goal id as child 1 (both in `.agentic-personas.json`).
- **F5**: Child 2 continues the tree (an `activated` or `nudge_sent` decision newer than child 2's start timestamp).
- **F6**: `root_complete` ends the run: supervisor exit 0, no child 3 (no `child-3/` directory).

**Red-run statement** (Y9): the suite at HEAD, before code, fails at F1 (no `supervisor.log`, no `bin/supervise.sh`), exit 1, pasted in the hand-back.

**Unit test** (Y9): `bin/supervise-decide.mjs` is a small pure Node file (input JSON, output `{action, reason}`) that the bash loop calls and the unit test imports. Bash cannot import into Node, so the decision is in Node. `.kit/supervisor-unit-test.mjs` test cases:

- Child exited non-zero, no `root_complete`, no `critical` crossing: `restart`.
- Child exited non-zero, `root_complete` newer than start: `stop_complete`.
- `context_budget_crossed` `critical:` newer than start: `restart`.
- `context_budget_crossed` `closeout:` (not critical): do not restart on that signal alone.
- Heartbeat `lastSeen` older than `staleAfterMs`, `heartbeatSessionId` equals `childSessionId`, past grace: `restart`.
- Heartbeat `lastSeen` older than `staleAfterMs`, `heartbeatSessionId` names another session, child alive: do not restart (waiting, not hung; Z6).
- Heartbeat `lastSeen` older than `staleAfterMs`, `heartbeatSessionId` equals `childSessionId`, within grace: do not restart (startup grace, Z6).
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
| Z1 | Commit `08087ea` fixed an em-dash that was never there; a claimed find must paste the matching `grep -n` line | Record here is the correction; from now on a claimed find pastes the matching `grep -n` line, not a sentence |
| Z2 | `acceptEdits` cannot run a worker for days; settings file in suite var; no usage line | Section 5: permission mode a required argument (no default); suite passes `acceptEdits`; runbook shows `bypassPermissions` with the allow-list alternative and reason; settings file to `$RUNDIR/settings.json`; usage line added |
| Z3 | Section 6 states a declaration that does not exist; "in the store" in D8, F2, F4 | Section 6: manifest declares seven `userConfig` fields, no budget/self-review; D8, F2, F4 say `.agentic-personas.json` |
| Z5 | Two staleness thresholds that agree by coincidence | Single-source on `staleAfterMs`; drop `supervisorHeartbeatStaleMult`; D1 hung = `lastSeen` older than `staleAfterMs`; unit cases 5-6 reworded |
| Z6 | Hung check kills a healthy child in its reader window | D1: identity key (`heartbeatSessionId` = `childSessionId`) + startup grace (`staleAfterMs` after launch); decide unit input adds `childSessionId`, `heartbeatSessionId`, `launchedAt`; two new unit cases |
| AD1 | Restarted children never own the persona; `persist()` vetoes the claimant who just overtook a dead holder | Root cause: the guarded write at the claim sites checked `activeSessionId` and found the dead holder, so the claim was vetoed. Fix: `writeClaimDirect(dp)` helper in `hooks/index.ts` writes `sess.state` to `sess.storePath` directly + heartbeat entry at all three claim sites (session.start, heartbeat tick, agentic_identity) before `persist()`; `persona_claim` detail includes new session id for observability; folded into commit `1b02370` + `6946c9c` |
| AD2 | Pre-gate checked only the commons store; missed a live heartbeat in the workdir | `wait_persona_free_both()` in `agentic-common.sh` checks both commons store AND per-directory heartbeat (`lastSeen` older than `staleAfterMs`); supervisor pre-gate now calls it |
| AD3 | Piped child held stdin open with `sleep 3600` holder; exit codes hardwired to 0; TERM sent 0 s after decision | Coproc stdin with EOF stop (close write end, then TERM after `stopGraceMs`, then KILL); real exit codes via `wait`; single `stop_child <label>` function; `supervisor.err` truncated once at launch and appended after; `CHILD_PID` unbound variable guards added to all code paths; commit `1b02370` + `6946c9c` supersedes `d971672` and `9eae073` |
| AD4 | F4 asserted "gate waited or passed" (weakened from Round 47); F5 absent; F3 tested `stdin-close` (now `eof`); F0 ran at start (cannot see yields); prompt created three roots | F4 redefined: child-2 owns persona (`activeSessionId` + `persona_claim`/`reader_promoted` decision); F5 added: `nudge_sent`/`turn_start` after child-2 launch; F3 tests `eof`; F0 moved to end (scoped by first `LAUNCH` timestamp); prompt says "call goal_create exactly once, with the three essays as the roadmap" |
| AD5 | Record issues: commit title fold, `supervisor.err` truncate, comment block, "known deviations" | Commit `9eae073` folded into AD3 with title "Coproc stdin with EOF stop, real exit codes, heartbeat pre-gate"; `supervisor.err` truncated once at launch, appended after; launch comment block one paragraph about coproc; AC3/AC4 dissolve under AD3 (recorded in AD3 row) |
| AE1 | Third claim site (agentic_identity) still inline, duplicating `writeClaimDirect` body | Replaced inline block with `await writeClaimDirect($)`; comment now says "three claim sites share the helper"; commit `bbb96e1` |
| AE2 | `supervisor.err` truncated twice per poll (`2>` in `get_fact` and decide call) | Changed both `2>` to `2>>`; plan row now true; commit `ffab84c` |
| AE3 | LAUNCH log says `prompt=set` for every child (PROMPT reset after loop, not after send) | Moved `PROMPT=""` to immediately after the first send; log line now accurate; commit `ffab84c` |
| AE4 | F6 asserts a restart count the model controls (`! -d child-3`) | Redefined F6: supervisor exit 0, last decision is STOP_COMPLETE, no LAUNCH after it; commit `7b25dd0` |
| AE5 | Budget suite gates on a fixed `sleep 90` instead of observed state | Replaced with until-loop polling store for `context_budget_crossed` critical:, capped at 300 s; commit `7b25dd0` |
| AE6 | Record: Round 49 header em dash, plan doc em dashes, AD1 row missing real cause | Round 49 header noted as deviation (write-path rule: no in-place edits); plan doc checked (no em dashes found); AD1 row now names the real cause (guarded write vetoed the claimant); plain ASCII from here on |
