# agentic-plugin: environment monitor, v0.7.0

Status: In Progress (v0.7.0-a). Target version v0.7.0. Written before any code. The plan is the contract: the completion entry for v0.7.0 quotes the assertions this plan names.

Stage 1 (goal tree and plan selection) is Complete at v0.6.4 (commit 2ef521d). This plan is Stage 2: the environment monitor.

PIANO rule, unchanged: the monitor observes and writes state. It never actuates. No exceptions.

## 1. Purpose

The controller today knows the goal tree and the idle clock, nothing about the workspace. A worker can sit on forty uncommitted files for two hours, or keep calling `goal_done` while the project's tests are red, and the controller's summary and the injected `[GOAL TREE]` block say nothing.

Stage 2 gives the Monitor module facts about the environment so that (a) the controller summary carries them, (b) the worker sees them when they matter, and (c) some decisions become due in code on environment facts. The monitor observes and writes state. It never actuates: PIANO rule, unchanged, no exceptions.

Design constraint from the Reviewer: no model calls in the monitor. Every signal is measured in code.

## 2. Signals

Three signals, the minimum set for v1. Every signal is measured in code. No model calls in the monitor.

| Signal | Source API (types line) | Cadence | Cost | State field |
|--------|-------------------------|---------|------|-------------|
| Git state | `$.process.run` (`ProcessRunInit` :2593-2613, `ProcessRunResult` :2617-2634; "Git runs with repo hooks off" :1028) | time-based: probe when `env.git === null` or `now - env.git.sampledAt >= gitProbeMs` (config, default 120000 ms); after the in-flight check and before the planning gate; never while a turn is in flight | 1 subprocess per probe, `timeoutMs` 10 s, ~100 ms typical | `env.git` |
| Project health | `$.process.run` (`ProcessRunInit` :2593-2613, `ProcessRunResult` :2617-2634) | at `completeLeaf` sites only (goal_done, scorer complete, controller complete); not at `activate`, not at planning | 1 subprocess per `completeLeaf`, `timeoutMs` from config `healthTimeoutMs` (default 60000, cap 120000) | `env.health` |
| Error streak | `turn.complete` reason + `tool.call` hook return after `next(e)` (`ToolCallResult` :3901-3972) | per turn (no timer; driven by turn.complete and tool.call events) | 0 (no subprocess, no model call) | `env.errors` |

### 2.1 Git state

Source: `$.process.run(["git", "status", "--porcelain=v1", "-b"])` and `$.process.run(["git", "log", "-1", "--format=%ct"])`.

- `cwd` absent: defaults to the session's working directory (types :2597-2598). Confirmed by a debug run before the git probe relies on it (see Q3, section 9).
- `timeoutMs`: 10 s (types :2612, "30 seconds when absent, ten minutes at most"; we set 10 s explicitly).
- `env.git` shape: `{ branch: string; dirty: number; ahead: number; behind: number; lastCommitAt: number; sampledAt: number } | null`.
  - `branch`: the `## <branch>` line from `git status --porcelain=v1 -b` stdout, parsed.
  - `dirty`: count of non-empty lines in stdout after the `##` line.
  - `ahead` / `behind`: parsed from the `## <branch>...<remote> [ahead <a>, behind <b>]` line, if present; `0` if the line is absent or the repo has no upstream.
  - `lastCommitAt`: the Unix timestamp (seconds) from `git log -1 --format=%ct` stdout, converted to ms.
  - `sampledAt`: `Date.now()` at the time of the probe.
- A non-git cwd (exit code 128 from either call) records `env.git = null` once and stops probing until the next session (the `sessionStart` boundary). This is recorded in the decision log as `env_git_null` with the exit code.
- A failed probe (non-zero exit that is not 128) records the error in the decision log as `env_git_error` with the exit code and stderr tail, and leaves `env.git` at its last known value (no overwrite on failure).
- **Cadence (E4 fix).** Time-based, not tick-count-based. The probe fires when `env.git === null` or `now - env.git.sampledAt >= gitProbeMs`. `gitProbeMs` is a config field in `plugin.json` `userConfig` (default 120000 ms, i.e. 2 min). The probe sits in the controller tick after the in-flight check (the existing `turnInFlight` flag, index.ts:148, read at :506) and before the planning gate. This is stated here so the implementation does not place it in the wrong position.
- **In-flight check (E4 fix).** The probe is skipped if the `turnInFlight` flag is true (index.ts:148, read at :506). This is the existing flag, not `lastTurnComplete`.
- **Fire-and-forget (E4 fix).** The git probe runs fire-and-forget with its own reentrancy flag (`gitProbeInFlight`), like `planningInFlight`. A slow git never blocks the classify path. The probe starts, the tick continues, and the probe writes its result to state when it completes.
- **First sample (E4 fix).** The first sample (null to a value) logs `env_git` too (the change-only logging rule applies to the first sample as well, since the previous value was null).

### 2.2 Project health

Source: a cwd-relative file `.agentic-health` (one line, argv split on whitespace, no shell). The same resolution rule as the store and the fault flag: cwd-relative, the cwd the session runs in.

- File absent: no health signal. `env.health` stays `null`. No probe is run.
- File present: the line is split on whitespace into argv. The first token is the command, the rest are arguments. No shell interpolation (no `sh -c`). This is a safety constraint: the file is operator-written, not model-written, but the no-shell rule prevents accidental shell injection.
- `cwd` absent: defaults to the session's working directory (types :2597-2598).
- `timeoutMs`: from config `healthTimeoutMs` (default 60000 ms, cap 120000 ms). The config key is `healthTimeoutMs` in `plugin.json` `userConfig` (E3 fix: the config surface exists in `plugin.json`, not in a runtime config object). The cap is enforced in code: `Math.min(configValue, 120000)`.
- `env.health` shape: `{ command: string[]; exitCode: number; tail: string; ranAt: number; forNodeId: string | null } | null`.
  - `command`: the argv array (the command that was run).
  - `exitCode`: the child's exit status (types :2620-2622).
  - `tail`: the last 20 lines of combined output (stdout + stderr, types :2624-2632).
  - `ranAt`: `Date.now()` at the time of the run.
  - `forNodeId`: the id of the completed node (the plan or task the health run verifies), or `null` if no node.
- **Cadence (E2 fix).** At `completeLeaf` sites only. Specifically, the health run fires:
  - at `goal_done` (the worker completed a leaf),
  - at the scorer `complete` (the scorer completed a plan),
  - at the controller `complete` (the controller completed a plan).
  - It does NOT fire at `activate`. It does NOT fire at planning. It fires only at `completeLeaf` sites.
  - `goal_done` calls `activate`, but the health run is at the `completeLeaf` site (before `activate`), so it fires once, not twice.
  - One helper `runHealth(dp, forNodeId)` is called once at each `completeLeaf` site, with `forNodeId` the completed node.
- **Blocking (E2 fix).** Inside `goal_done`, the health run blocks the tool result for up to the timeout (`healthTimeoutMs`, default 60 s, cap 120 s). This is why the default is 60 s and the cap is 120 s: the worker waits for the health result before the `goal_done` tool call returns.
- A failed health run (non-zero exit) records the error in `env.health` and in the decision log as `health_red` with the exit code and the first line of the tail.
- A successful health run (zero exit) records the success in `env.health` and in the decision log as `health_green`.

### 2.3 Error streak

Source: two inputs, both measured in code.

1. **Consecutive error turns**: a turn is an error turn if its `turn.complete` reason is `error` OR it had at least one tool error (E8 fix: the streak is defined on what the plugin can observe in every turn). The monitor counts consecutive error turns: increment `consecutiveErrorTurns` on an error turn, reset to 0 on a non-error turn.

2. **Tool-call errors per turn**: the `tool.call` hook's return value after `next(e)` (the `ToolCallResult`, types :3901-3972). For a built-in tool such as Bash, the hook receives:
   - On success (answered variant, :3912-3947): `result` (the tool's typed record) and `text`, with `isError` absent (undefined, :3946).
   - On error (errored variant, :3948-3971): `isError: true` (:3953), `result` (unknown, the error text, :3958), and `text`.
   - On deny (deny variant, :3901-3911): `deny` (:3903), with `result` and `isError` absent.

   The monitor counts tool-call errors per turn: increment `toolErrorsLastTurn` on each `tool.call` where `isError === true` (or `deny` is present), reset to 0 at the start of each turn (on `turn.start` or the first `tool.call` of the turn).

   Cite the exact lines relied on: `isError: true` at :3953; `deny: string` at :3903; `result` (typed) at :3913; `result` (unknown) at :3958.

- `env.errors` shape: `{ consecutiveErrorTurns: number; toolErrorsLastTurn: number; lastErrorAt?: number; handledAt?: number }`.
  - `consecutiveErrorTurns`: the count of consecutive error turns (0 if the last turn was not an error).
  - `toolErrorsLastTurn`: the count of tool-call errors in the last completed turn (0 if the last turn had no tool-call errors).
  - `lastErrorAt`: `Date.now()` at the time of the last error (either an error turn or a tool-call error), or `undefined` if no errors have occurred.
  - `handledAt`: `Date.now()` at the time the controller handled the streak (set by the controller, not the monitor), or `undefined` if the streak has not been handled.
- **E1 fix: the monitor does not actuate.** The monitor writes `env.errors` (including `consecutiveErrorTurns` and `handledAt`). The controller tick reads it. At the tick, after the in-flight check, if `env.errors.consecutiveErrorTurns >= 3` and `env.errors.handledAt` is undefined (or older than the last reset), the controller runs its existing ask-operator branch (toast, `controller_tick`, `paused_by_controller`) and sets `env.errors.handledAt = Date.now()`. Without the handled marker the pause fires every 30 s. The monitor never toasts, never pauses, never logs `controller_tick`. It only writes state.
- The error streak is driven by events (turn.complete, tool.call), not by a timer. No new model calls. No new subprocesses.
- **E8 fix: pure helper `computeErrorStreak`.** The helper `computeErrorStreak(turns: Array<{ reason: string; toolErrors: number }>): { consecutiveErrorTurns: number; toolErrorsLastTurn: number }` is in agent-state.ts. The hooks call it. The plan names its signature. It is the implementation, not a fallback.

## 3. State shape and migration

`MonitorState` (agent-state.ts:56-63) gains an `env` field. `AgentState.version` (agent-state.ts:71) bumps from `3` to `4`.

New `MonitorState` shape:
```
{
  sessionStart: number;
  turnCount: number;
  lastTurnId?: string;
  lastTurnComplete?: number;
  totalToolCalls: number;
  errors: number;
  env: {
    git: { branch: string; dirty: number; ahead: number; behind: number; lastCommitAt: number; sampledAt: number } | null;
    health: { command: string[]; exitCode: number; tail: string; ranAt: number; forNodeId: string | null } | null;
    errors: { consecutiveErrorTurns: number; toolErrorsLastTurn: number; lastErrorAt?: number; handledAt?: number };
  };
}
```

Migration v3 to v4 (parseState, agent-state.ts:122):
- If `parsed.version === 3`, read the existing `monitor` field, add `env: { git: null, health: null, errors: { consecutiveErrorTurns: 0, toolErrorsLastTurn: 0 } }`, set `version = 4`. All existing v3 fields are preserved (they are all optional or have defaults).
- If `parsed.version` is absent or less than 3, run the existing v2 to v3 migration first, then the v3 to v4 migration.
- **E11 fix: `parseState` fills `env` with defaults whenever it is absent, whatever the version number says.** So a hand-edited store (a v3 store without `env`, or a v4 store with `env` deleted) cannot crash the load. The check is: if `monitor.env` is undefined, fill it with `{ git: null, health: null, errors: { consecutiveErrorTurns: 0, toolErrorsLastTurn: 0 } }`. This is done in `parseState` and in `enforceInvariants` (the invariant check that runs after `parseState`).
- `createDefaultState` (agent-state.ts:94) sets `version: 4` and `monitor.env: { git: null, health: null, errors: { consecutiveErrorTurns: 0, toolErrorsLastTurn: 0 } }`.

The JSON file store stays. The store path is cwd-relative (`.agentic-personas.json` at the harness root, the cwd the session runs in), keyed by persona. Cross-session sharing through the file is the point of Stages 3 and 5; the monitor writes to the same file the goal tree and nudge budget use.

`$.store` is not used for env samples. `$.store` is per plugin, global across sessions (types :935-940), not per-session; the env samples are per-session and go in the file store (keyed by persona). See Q1, section 9.

## 4. Consumers

The monitor does not actuate. It writes state. The consumers read the state and decide.

**E9 fix: summary versus injection.** The summary is the classify prompt built at index.ts (the `summary` string in the tick). The `[GOAL TREE]` block is the `prompt.submit` injection. The `Environment:` line goes in the summary; `[ENV]` is a separate injected block. They are two surfaces.

- **Controller summary (the `summary` string in the tick).** Gains an `Environment:` line: `git <branch> dirty <n> ahead <a> behind <b> last commit <m>min ago | health <exit|none> | error turns <k>`. The classify labels do not change in v1. The `Environment:` line is present only when `env.git` or `env.health` is non-null or `env.errors.consecutiveErrorTurns` is non-zero.

- **`prompt.submit` injection (the `[ENV]` block).** The `prompt.submit` hook injects an `[ENV]` block of at most six lines into the worker's context, and only when a fact is notable. A fact is notable if:
  - `env.git.dirty > 0` and `lastCommitAt` is older than 30 min, OR
  - `env.health.exitCode` is non-zero, OR
  - `env.errors.consecutiveErrorTurns` is 2 or more.
  - Nothing notable, no block.
  - The `[ENV]` block is logged through `$.ui.log` as the goal block does (the existing log path for the `[GOAL TREE]` injection).

- **Nudge text.** The nudge text (the text the controller sends to the worker when it nudges) names the notable facts in one sentence before the goal objective. So an idle worker with a dirty tree is told to commit before it is told to continue. Example: `Environment: git main dirty 4 last commit 42min ago. Objective: <objective>`.

- **Code-gated decisions**, logged under loop `monitor`:
  - `env_git`: each sample whose dirty count or branch changed since the previous sample (including the first sample, null to a value), detail carrying the new values. Example: `env_git dirty 4 -> 0 branch main`.
  - `env_git_null`: one per non-git cwd detection (exit 128), stops probing until next session.
  - `env_git_error`: one per failed git probe (non-zero exit, not 128).
  - `health_red`: each health run with a non-zero exit code, detail carrying the exit code and the first line of the tail.
  - `health_green`: each health run with a zero exit code, detail carrying the command.
  - `env_inject`: one per `[ENV]` block injection, only when the block is non-empty.
  - **`error_streak` (E1 fix: controller, not monitor).** At the controller tick, after the in-flight check, if `env.errors.consecutiveErrorTurns >= 3` and `env.errors.handledAt` is undefined, the controller:
    - toasts once (through the existing toast path, `$.ui.toast`),
    - logs `controller_tick` (ask-operator),
    - pauses the active leaf with `blockedReason` naming the streak, through the existing ask-operator path (the `paused_by_controller` decision),
    - sets `env.errors.handledAt = Date.now()`.
    - The monitor does not do any of this. The monitor writes `env.errors.consecutiveErrorTurns` and `env.errors.handledAt`. The controller reads and acts.
  - `goal_done` with a red health result still completes the leaf, and its result text tells the worker the command, the exit code, and the first line of the tail. Example: `Goal done. Health: node agentic-plugin/.kit/health-probe.js exited 1. Output: <first line of tail>.`

## 5. Decision action names

The monitor emits these decision actions (in the `monitor` loop, consistent with the existing `monitor` loop):

- `env_git`: "env_git dirty <n> -> <n2> branch <b> at <iso>" (one per git sample whose dirty count or branch changed, including the first sample).
- `env_git_null`: "env_git_null exit 128 at <iso>" (one per non-git cwd detection).
- `env_git_error`: "env_git_error exit <code> <stderr tail> at <iso>" (one per failed git probe).
- `health_red`: "health_red exit <code> <first line of tail> at <iso> for <nodeId>" (one per failed health run).
- `health_green`: "health_green <command> at <iso> for <nodeId>" (one per successful health run).
- `env_inject`: "env_inject <n> notable facts at <iso>" (one per `[ENV]` block injection, only when the block is non-empty).
- **`error_streak` (E1 fix: controller, not monitor).** "error_streak <k> consecutive error turns at <iso>; ask-operator; pause <nodeId>" (one per 3-consecutive-error-turn event, logged by the controller, not the monitor).
- **`controller_tick` (ask-operator)** and **`paused_by_controller`**: existing decisions, logged by the controller when it handles the error streak.

The monitor does NOT log `error_streak`, `controller_tick`, or `paused_by_controller`. The controller does. The monitor only logs `env_git`, `env_git_null`, `env_git_error`, `health_red`, `health_green`, and `env_inject`.

These are additive to the existing decision log; they do not replace any existing action. The decision log cap (200, agent-state.ts:91) is unchanged.

## 6. Cost budget

Zero new model calls. No new timers. The monitor rides the existing controller tick clock.

Worst-case `process.run` seconds per hour:
- Git probe: at most one per `gitProbeMs` (default 120000 ms = 2 min) while a goal is live. 30 probes per hour. 1 subprocess per probe, `timeoutMs` 10 s. Worst case: 30 x 10 s = 300 s per hour (if all probes time out). Typical: 30 x 0.1 s = 3 s per hour.
- Health run: one per `completeLeaf` site. The number of `completeLeaf` sites per hour is bounded by the number of `goal_done` + `complete` events. In a steady-state run, this is at most a few per hour. 1 subprocess per run, `timeoutMs` capped at 120 s. Worst case: 5 x 120 s = 600 s per hour (if 5 health runs time out). Typical: 5 x 0.5 s = 2.5 s per hour.
- Error streak: 0 subprocesses, 0 model calls. Event-driven.

Total worst-case: 300 s (git) + 600 s (health) = 900 s per hour. Total typical: 3 s + 2.5 s = 5.5 s per hour.

The Reviewer's cost budget rule: state the worst-case `process.run` seconds per hour. Stated here: 900 s per hour worst case, 5.5 s per hour typical.

## 7. Non-goals (v1)

- No `$.http.fetch` probes.
- No disk or CPU sampling.
- No test-result parsing beyond exit code and tail (the health probe records exit code and the last 20 lines of output, nothing more).
- No new classify labels (the controller's classify labels are unchanged in v1).
- No change to the goal tree (the goal tree structure and the plan selection logic are unchanged).
- Stage 2b (context budget) stays separate.
- No `$.store` use for env samples (the env samples go in the file store, keyed by persona).
- No new timers (the monitor rides the existing controller tick clock and the `completeLeaf` sites).
- No `$.process.run` with a `cwd` override (the monitor uses the session's default cwd, types :2597-2598).
- No monitor actuation (the monitor writes state; the controller acts).

## 8. Acceptance tests

All through `assert-decisions.js`, all scripted in `.kit/` and tracked. The five Stage 1 tests rerun green at the end of the stage; the summary line change touches the controller, so the controller test is not exempt.

**E10 fix: `RUNNING` is written before the run.** Before the `claude` line in every script: `[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }; echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"`. The exit trap removes it.

### 8.1 `live-env-git-test.sh`

Setup: the run's cwd is a scratch git repo the script creates under `.kit/env-repo/` (init, one commit). **E5 fix: the initial commit must include a `.gitignore` with `.agentic-*`** so the store, the heartbeat, and the yield log are not counted as untracked.

Feed:
1. `Call goal_create with objective "Write one haiku" maxRounds 3. Then reply ok.`
2. The script writes an untracked file at 60 s (so the git probe sees dirty 1).
3. The script commits the file at 200 s (so the git probe sees dirty 0).
4. `Reply done.`

**E5 fix: feed timing.** With `gitProbeMs` 120000, the untracked file at 60 s is seen at about 120 s (the first probe after the 120 s mark) and the commit at 200 s at about 240 s (the next probe). So the run holds the session for at least 330 s before `done` (to allow the probe at ~240 s to fire and the session to settle).

Assertions (ordered):
- `env_git` with `dirty 1` (the probe ran and saw the untracked file).
- `env_git` with `dirty 0` (the probe ran again and saw the commit).
- **E6 fix: `env_inject` is absent from the decision log** (since the last commit is fresh, no notable fact, no `[ENV]` block injected).

### 8.2 `live-env-health-test.sh`

Setup: **E7 fix: `.agentic-health` names `node agentic-plugin/.kit/health-probe.js`** (not `node .kit/health-probe.js`, which resolves to the wrong path). `health-probe.js` is tracked in the plugin. `.agentic-health` and `.agentic-health-fail` are in the harness root (the cwd), deleted in the trap with the other dotfiles.

`health-probe.js` exits 1 while `.agentic-health-fail` exists and 0 otherwise.

Feed:
1. `Call goal_create with objective "Write one haiku" maxRounds 3. Then add two plans.`
2. Message 2: `goal_done` for plan 1 (at time t).
3. The script removes the fail flag at t+20 s.
4. Message 3: `goal_done` for plan 2 (at t+40 s).
5. `Reply done.`

Assertions (ordered):
- `health_red` (the first health run, exit 1, at the first `goal_done`).
- `health_green` (the second health run, exit 0, at the second `goal_done`).
- The first `goal_done` result text in the stream names exit 1 (the result text tells the worker the command, the exit code, and the first line of the tail).
- **E6 fix: `env_inject` is present in the decision log after `health_red`** (the `[ENV]` block is injected when the health exit is non-zero).

### 8.3 Error streak test

**E8 fix: the test uses a deny inducer the plugin controls.** A root objective containing "no bash" makes the plugin deny every Bash call (index.ts:1606), a `deny` result. The test creates such a root, then sends three prompts each asking to run a Bash command. Each turn carries a denied tool call (`deny`), which counts as a tool error. The third turn completes the streak (3 consecutive error turns) and the controller's next tick fires ask-operator.

Feed:
1. `Call goal_create with objective "no bash: Write one haiku" maxRounds 5. Then reply ok.` (the root objective contains "no bash").
2. Message 2: `Run the command: echo hello` (the model calls Bash, the plugin denies it, `deny` result).
3. Message 3: `Run the command: echo world` (the model calls Bash, the plugin denies it, `deny` result).
4. Message 4: `Run the command: echo done` (the model calls Bash, the plugin denies it, `deny` result; this is the third consecutive error turn).
5. `Reply done.` (the controller's next tick fires ask-operator).

Assertions (ordered):
- `deny` (first Bash call denied).
- `deny` (second Bash call denied).
- `deny` (third Bash call denied).
- `error_streak` (the controller logs the streak at the next tick).
- `controller_tick` (ask-operator, the controller runs the ask-operator branch).
- `paused_by_controller` (the controller pauses the active leaf).

**E8 fix: the pure helper `computeErrorStreak` is the implementation, not a fallback.** The hooks call it. The plan names its signature: `computeErrorStreak(turns: Array<{ reason: string; toolErrors: number }>): { consecutiveErrorTurns: number; toolErrorsLastTurn: number }`.

### 8.4 Shared invariants (all tests)

- `npx tsc --noEmit; echo $?` returns `0`.
- `claude plugin validate .` passes (warnings allowed).
- `grep -c 'D:/' hooks/*.ts` returns `0` (no absolute paths).
- Em-dash count across hooks, `.kit` scripts, plan doc, README is `0`.
- The `.kit/RUNNING` file is created before each run (E10 fix: the script writes it before the `claude` line) and removed by the exit trap.
- The store path is cwd-relative (`.agentic-personas.json` at the harness root).
- The five Stage 1 tests rerun green at the end of the stage.

## 9. Open questions (numbered)

These are the three questions the Reviewer asked, answered from the types file (the tracked copy, `agentic-plugin/.claude/types/claude-code.d.ts`). The debug-run confirmations are named as verification steps to be done during implementation.

1. **`$.store` scope.** The types declare a native `$.store` (`get/set/delete/keys`, types :941-960). Is its scope per plugin per project, per session, or global? Cite the line. The JSON file store stays regardless, because cross-session sharing through a file is the point of Stages 3 and 5, but the answer decides whether `$.store` can hold per-session scratch (the env samples, for one) instead of the shared file.

   Answer: **per plugin, global across sessions.** Types :935-940: "This plugin's own key-value store, kept between sessions and hot reloads; values are JSON data. On the page localStorage under the plugin's name; in the CLI a JSON file under `~/.claude/plugins/store/`." The store is scoped to the plugin (not per project, not per session). It is global across sessions of that plugin. Therefore, `$.store` cannot hold per-session scratch (the env samples are per-session); the env samples go in the JSON file store (keyed by persona, at the harness root cwd). The JSON file store stays regardless. `$.store` is not used in v1.

   Debug-run confirmation: not required (the types file is definitive for the scope). The scope is a type-level guarantee, not a runtime behavior to probe.

2. **`ToolCallResult` fields for a built-in tool.** Which fields of `ToolCallResult` (types :3901 onward) does the `tool.call` hook actually receive back from `next(e)` for a built-in tool such as Bash: `isError`, `result`, both? Confirm with a debug run that logs the keys, and quote the store line.

   Answer: **both, with the shape depending on success or error.** Types :3901-3972 define `ToolCallResult` as a union of three variants:
   - Deny (:3901-3911): `{ deny: string, result?: undefined, isError?: undefined }`. `deny` at :3903.
   - Answered (:3912-3947): `{ result: ToolResultOf<Name>, context?, ref?, text?: string, isError?: undefined }`. `result` (typed) at :3913; `isError` absent (undefined, :3946).
   - Errored (:3948-3971): `{ isError: true, result: unknown, text?: string, ref? }`. `isError: true` at :3953; `result` (unknown) at :3958.

   So for a built-in tool like Bash: on success, the hook receives `result` (typed) and `text`, with `isError` absent; on error, the hook receives `isError: true`, `result` (unknown, the error text), and `text`; on deny, the hook receives `deny`. The error-detection field is `isError === true` (:3953). The monitor's error-streak probe keys on `isError === true` (:3953) and the presence of `deny` (:3903).

   Debug-run confirmation: a debug session that calls a built-in Bash tool (one that succeeds, one that errors) and logs the keys of the `next(e)` result. The store line (the decision log entry that records the keys) will quote the actual fields received. This debug run is part of the implementation, before the error-streak probe relies on `isError`. The store line to quote: the `env_error` decision (or a dedicated debug decision) that records the keys of the `ToolCallResult` received.

3. **`$.process.run` default cwd.** Which cwd does the piped stream-json session give `$.process.run` by default (types :2597-2600 say "the session's")? Confirm with a `["node", "-e", "console.log(process.cwd())"]` probe in a debug run before the git probe relies on it, and quote the store line.

   Answer: **the session's working directory.** Types :2594-2613 (`ProcessRunInit`): `cwd?: string` (:2599), "The child's working directory, relative to the session's or absolute; absent, the session's working directory." (:2597-2598). So when `cwd` is absent (the monitor's default), the child runs in the session's working directory. For the piped stream-json session, the session's working directory is the cwd the `claude` process was started in (the harness root, `D:\DeepSeekHarness`, per the test harness `cd /d/DeepSeekHarness` at live-planfail-test.sh:9).

   Debug-run confirmation: a debug session that runs `$.process.run(["node", "-e", "console.log(process.cwd())"])` (no `cwd` override) and logs the `stdout`. The store line (the decision log entry that records the cwd) will quote the actual cwd. This debug run is part of the implementation, before the git probe relies on the cwd default (per the Reviewer's instruction: "Confirm with a `["node", "-e", "console.log(process.cwd())"]` probe in a debug run before the git probe relies on it"). The store line to quote: the `env_git` decision (or a dedicated debug decision) that records the `process.cwd()` output.

## 10. Execution order

The implementation order is:

1. **Config (E3 fix).** Add `healthTimeoutMs` (default 60000, cap 120000) and `gitProbeMs` (default 120000) to `plugin.json` `userConfig`. Read them off `options` (index.ts:157-164 pattern).
2. **State shape (E11 fix).** Add `env` to `MonitorState`. Bump version to 4. Update `parseState` to fill `env` with defaults whenever it is absent (whatever the version). Update `enforceInvariants` to tolerate a v3 store without `env`.
3. **Git probe (E4 fix).** Implement the git probe in the controller tick, after the in-flight check (`turnInFlight`, index.ts:148) and before the planning gate. Fire-and-forget with `gitProbeInFlight` reentrancy flag. Time-based cadence (`gitProbeMs`). Log `env_git`, `env_git_null`, `env_git_error`.
4. **Health run (E2 fix).** Implement `runHealth(dp, forNodeId)` helper. Call it once at each `completeLeaf` site (goal_done, scorer complete, controller complete). Not at `activate`, not at planning. Log `health_red`, `health_green`.
5. **Error streak (E1, E8 fix).** Implement `computeErrorStreak` helper in agent-state.ts. The monitor writes `env.errors` (consecutiveErrorTurns, toolErrorsLastTurn, lastErrorAt, handledAt). The controller reads it at the tick and acts (toast, `controller_tick`, `paused_by_controller`, set `handledAt`). Log `error_streak` (controller, not monitor).
6. **Consumers (E9 fix).** Add `Environment:` line to the controller summary (the `summary` string in the tick). Add `[ENV]` block to the `prompt.submit` injection. Add nudge text naming notable facts. Log `env_inject`.
7. **Tests (E5, E6, E7, E8, E10 fix).** Write the three new tests (`live-env-git-test.sh`, `live-env-health-test.sh`, error streak test). Update the `.kit` scripts with the `RUNNING` write (E10 fix). Track `health-probe.js`.
8. **Debug runs.** Confirm Q2 (ToolCallResult keys) and Q3 (process.cwd()) with debug runs. Quote the store lines.
9. **Stage 1 tests rerun green.** The five Stage 1 tests rerun green at the end of the stage.
10. **Commit and tag.** Commit as `v0.7.0`, tag `v0.7.0`.

## 11. Revisions

| Label | Change |
|-------|--------|
| E1 | Monitor does not actuate. The `error_streak` decision is moved to the controller: at the tick, after the in-flight check, if `env.errors.consecutiveErrorTurns >= 3` and `handledAt` is undefined, the controller runs its existing ask-operator branch (toast, `controller_tick`, `paused_by_controller`) and sets `handledAt`. The monitor only writes `env.errors`. (Sections 2.3, 4, 5.) |
| E2 | Health run fires at `completeLeaf` sites only (goal_done, scorer complete, controller complete), not at `activate`, not at planning. One helper `runHealth(dp, forNodeId)` with `forNodeId` the completed node. Inside `goal_done`, the health run blocks the tool result for up to the timeout (default 60 s, cap 120 s). (Sections 2.2, 4.) |
| E3 | Config surface: `healthTimeoutMs` (default 60000, cap 120000) and `gitProbeMs` (default 120000) added to `plugin.json` `userConfig`, read off `options` (index.ts:157-164 pattern). (Sections 2.1, 2.2, 10.) |
| E4 | Git probe cadence is time-based (`gitProbeMs`, default 120000 ms), not tick-count-based. The probe sits after the in-flight check (`turnInFlight`, index.ts:148) and before the planning gate. Fire-and-forget with `gitProbeInFlight` reentrancy flag. The first sample (null to a value) logs `env_git`. (Sections 2.1, 10.) |
| E5 | Git test: the scratch repo's initial commit includes a `.gitignore` with `.agentic-*`. Feed timing: with `gitProbeMs` 120000, the untracked file at 60 s is seen at ~120 s and the commit at 200 s at ~240 s; the run holds the session for at least 330 s. (Section 8.1.) |
| E6 | `[ENV]` absence check: assert `env_inject` absence from the decision log (not from the stream output). In the health test, assert `env_inject` presence after `health_red`. (Sections 8.1, 8.2.) |
| E7 | Health test: `.agentic-health` names `node agentic-plugin/.kit/health-probe.js` (not `node .kit/health-probe.js`). `health-probe.js` is tracked. `.agentic-health` and `.agentic-health-fail` are in the harness root, deleted in the trap. Feed: message 2 (goal_done) at t, flag removed at t+20 s, message 3 (goal_done) at t+40 s, `done` after. (Section 8.2.) |
| E8 | Error streak: defined on what the plugin can observe (a turn is an error turn if `turn.complete` reason is `error` OR it had at least one tool error). The test uses a deny inducer (root objective "no bash", plugin denies Bash calls, `deny` result). Assert ordered: `deny`, `deny`, `deny`, `error_streak`, `controller_tick`, `paused_by_controller`. The pure helper `computeErrorStreak` is the implementation, not a fallback. (Sections 2.3, 8.3.) |
| E9 | Summary versus injection: the summary is the classify prompt (the `summary` string in the tick); the `[GOAL TREE]` block is the `prompt.submit` injection. The `Environment:` line goes in the summary; `[ENV]` is a separate injected block. (Section 4.) |
| E10 | `RUNNING` is written before the run: `[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }; echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"` before the `claude` line in every script. (Section 8.4, scripts.) |
| E11 | Migration: `parseState` fills `env` with defaults whenever it is absent, whatever the version number says. `enforceInvariants` tolerates a v3 store without `env`. (Section 3.) |
| E12 | Header clock: the entry header uses `date -u` (the command is in the script that writes the entry, and in the plan doc's completion-entry checklist). (This entry.) |

### Revision 2 (C1 to C7)

| Label | Change |
|-------|--------|
| C1 | Execution order: move step 8 (debug runs for Q2 and Q3) to step 1. The git probe depends on Q3 and the error streak on Q2. Quote both store lines in the completion entry. (Section 10.) |
| C2 | E10 in the first implementation commit: add the guard-and-write lines to all five scripts plus the three new ones. Paste `grep -n 'RUNNING' .kit/*.sh` in the completion entry. (Section 8.4, scripts.) |
| C3 | Error streak helper is a fold, not a replay: define `applyTurnToErrors(prev: EnvErrors, turn: { reason: string; toolErrors: number }): EnvErrors` in agent-state.ts and call it once per `turn.complete`. (Section 2.3.) |
| C4 | The plugin's own denies count: every plugin-side `deny` return site also increments `toolErrorsThisTurn`. (Section 2.3.) |
| C5 | Test 8.3 needs Bash in `--allowedTools`: add `Bash` to the allow list; the plugin's deny is what stops it running. Leave at least 45 s between message 4 and `done`. (Section 8.3.) |
| C6 | Test 8.1 timing: the first probe runs at the first tick (about 30 s, `env.git` null), so the sequence is `env_git dirty 0`, `dirty 1` at about 150 s, `dirty 0` at about 270 s. Hold the session 390 s, not 330. (Section 8.1.) |
| C7 | Stage 1 controller test: the summary gains an `Environment:` line only when `env.git` or `env.health` is non-null, so in the harness root (a non-git directory, exit 128) the line is absent and the controller test is unaffected. Confirm that in the completion entry with the `env_git_null` store line. (Section 8.4.) |

### Revision 3 (F1 to F9)

| Label | Change |
|-------|--------|
| F1 | Tool errors are never counted; only plugin denies are. Fix: in the tool.call handler, after `await next(e)`, check `isError === true` on the result and increment `toolErrorsThisTurn`. Rewrite 8.3 to the plan: root "no bash", three `Run the command` prompts, `Bash` in the allow list, 45 s before `done`. Assert ordered `deny`, `deny`, `deny`, `error_streak`, `controller_tick`, `paused_by_controller`. (Section 8.3, index.ts tool.call.) |
| F2 | The git test runs in a non-git directory and destroys a file that is not ours. Fix: create `.kit/env-repo/`, `git init`, commit a `.gitignore` with `.agentic-*`, `cd` into it for the `claude` call, one untracked file at 60 s, `git add` and `git commit` at 200 s, hold 390 s. Store lives at `.kit/env-repo/.agentic-personas.json`. (Section 8.1, live-gitprobe-test.sh.) |
| F3 | Assertion strings cannot match the details the code writes. Fix: detail carries the new value in one token, `env_git dirty=1 (was 0) branch main` and `env_git first sample dirty=0 branch main`. Assert ordered `dirty=0`, `dirty=1`, `dirty=0`. (Section 8.1, index.ts git probe, assert-decisions.js gitprobe.) |
| F4 | Health test does not test the plan's feed. Fix: goal_done at t (flag present, health_red), flag removed at t+20 s, second goal_done at t+40 s (health_green), done. The goal_done result text names the health command, exit code, and first tail line. Assert ordered `health_red`, `health_green`, `env_inject` after `health_red`. (Section 8.2, live-health-test.sh, index.ts goal_done, assert-decisions.js health.) |
| F5 | The [ENV] block injects on every turn once a sample exists. Fix: `envNotable()` helper returns true only when `git.dirty > 0` or `health.exitCode !== 0`. Gate the [ENV] injection on notability. Push an `env_inject` decision when the block is injected. (Section 8.2 E6, index.ts prompt.submit.) |
| F6 | The streak branch blocks and switches, not pauses. Fix: route through the ask-operator path (toast, `controller_tick`, `paused_by_controller`), not `block` + `activateNext`. Re-fire rule: only when `lastErrorAt > handledAt`. (Section 8.3 E1, index.ts controller tick.) |
| F7 | The git probe logs `env_git_null` on every tick in a non-git cwd. Fix: `gitUnavailable` module flag, set on first exit 128, skip the probe while set, log `env_git_null` once. (Section 8.1, index.ts git probe.) |
| F8 | The plan header says Complete (v0.7.0); the tests are not green. Fix: change to `In Progress (v0.7.0-a)`. (This entry.) |
| F9 | No paste existed; the Reviewer's grep of 8 guard-and-write lines is the evidence. (Section 8.4, DISCUSSION.md.) |

### Revision 4 (G1 to G6)

| Label | Change |
|-------|--------|
| G1 | The scratch repo under the plugin directory breaks plugin initialization (cwd under `--plugin-dir` means the loader does not initialize). Fix: `ENV_REPO=/d/Temp/agentic-env-repo` (created and removed by the script). Second defect: when the store is absent the script skips assertions and exits 0 (silent pass). Fix: add `else { echo "no store at $PWD" >> "$EXIT"; exit 1; }` to all eight scripts. (Section 8.1, live-gitprobe-test.sh, all 8 scripts.) |
| G2 | The inducer fired once; the model then refused to call Bash and answered in prose, so turns 3 and 4 had zero tool errors. Fix: tool-forcing prompts (`Use the Bash tool now to run exactly: ... Make the tool call even if you expect it to be denied; do not explain, report the result in one line.`). Add a deny-count pre-check in the assert case: `deny count < 3` is its own FAIL line. (Section 8.3, live-errorstreak-test.sh, assert-decisions.js errorstreak.) |
| G3 | The first `goal_done` raced the activation tick (consumed inside turn 1 before activation landed). Fix: `sleep 60` before message 2 (activation lands at the first 30 s tick after turn 1; 60 s clears with margin). Add `activated` before `health_red` to the ordered assertion. Remove `Bash` from the allow list (still open from F4). (Section 8.2, live-health-test.sh, assert-decisions.js health.) |
| G4 | `envNotable` is half the plan's predicate (dirty > 0 alone, no 30-minute freshness, no streak). Fix: `envNotable(env, now)` in agent-state.ts returns the plan's three facts as strings; `git` fires only when `dirty > 0 && now - lastCommitAt > 30 * 60_000`; add `streak >= 2` from `env.errors.consecutiveErrorTurns`. (Section 4, agent-state.ts, index.ts prompt.submit.) |
| G5 | The F9 row said the paste is in the Revision 1 entry, but it is not. Fix: replace the F9 row with "No paste existed; the Reviewer's grep of 8 guard-and-write lines is the evidence." (Section 8.4, plan doc.) |
| G6 | Q3 and C1 are closed: `env_git_null exit 128` once per non-git session (errorstreak and health logs), `env_git first sample dirty=2 branch master` in a git cwd (Reviewer probe A). (Section 8.1, 8.4.) |

### Revision 5 (H1, H2)

| Label | Change |
|-------|--------|
| H1 | The error-streak branch sat behind the nudge idle gate (`idleMs >= 120 s`), so it was unreachable in the test's 45 s window and in practice only fired when the worker was also idle for two minutes. Fix: move the whole streak block to directly after `if (turnInFlight) return;`, before the git probe, with its own active-node lookup; if no node is active, still log `error_streak` and `controller_tick`, toast, and set `handledAt`, skipping only the pause. (Section 7, index.ts controller tick.) |
| H2 | `gitProbeInFlight` was never reset after a successful probe: the `exitCode === 0` branch does `return $.process.run(...).then(...)`, which leaves the callback before the `gitProbeInFlight = false` line. The flag stayed true for the session, blocking every later probe. Fix: delete the two `gitProbeInFlight = false` lines and append `.finally(() => { gitProbeInFlight = false; })` to the chain. (Section 2.1, index.ts git probe.) |
