# agentic-plugin: live-test runner, v1

Status: Complete. Written before any code. The plan is the contract: the completion entry quotes the assertions this plan names.

## 1. Purpose

The eight live suites currently run serially from a single working directory (`D:\DeepSeekHarness`), sharing one `.agentic-personas.json` store, one `.agentic-heartbeat.json`, one `.agentic-yields.log`, and the health/planner-fault flags. This forces a 45 to 55 minute wall clock (8 suites × 4 to 7 minutes each, plus 90 s gaps) because the suites cannot run in parallel.

The operator wants the wall clock cut. The fix is twofold: (1) give each suite a private working directory so stores and flags are isolated, and (2) run suites in parallel at concurrency 3. This plan settles the design of the runner script and the path fixes required to make per-suite isolation safe.

Non-goals: no plugin behavior change beyond reading a short-cadence profile (item 5); no new decisions or actuators; no change to the assertions' meaning.

## 2. Working directory per suite

Each suite runs its session from `D:\Temp\agentic-live\<suite>\` (created fresh at start). **Removal order (J4):** the suite writes its `.exit`, `.assert.log`, `.decisions.log` inside its own directory; the runner copies them to `runs/<stamp>/` after the suite process returns; and only then removes the directory. A trap inside the suite that removes its own directory would delete the evidence before the runner reads it, so the removal belongs to the runner.

The dotfiles that become private per suite:

| Dotfile | Written by | Read by | Current directory |
|---|---|---|---|
| `.agentic-personas.json` | Plugin (index.ts:186, `storePath = sess.storePath` = `.agentic-personas.json`) | Plugin (store load/save), test scripts (assertions) | Session cwd |
| `.agentic-heartbeat.json` | Plugin (index.ts:188, `heartbeatPath = ".agentic-heartbeat.json"`) | Plugin (liveness check) | Session cwd |
| `.agentic-yields.log` | Plugin (index.ts:187, `yieldLogPath`) | Plugin (yield log), yield test (assertion) | Session cwd |
| `.agentic-health` | Test script (live-health-test.sh writes the command) | Plugin (index.ts:76, `healthPath = ".agentic-health"`) | Session cwd |
| `.agentic-health-fail` | Test script (live-health-test.sh touches/removes) | `health-probe.js` (line 6: `path.join(__dirname, '..', '..', '.agentic-health-fail')`) | Harness root (via `__dirname`) |
| `.agentic-planner-fault` | Test script (live-planfail-test.sh touches) | Plugin (index.ts:777, `$.fs.exists(".agentic-planner-fault")`) | Session cwd |

**Path fixes required:**

1. **`health-probe.js` fail-flag path.** Currently `path.join(__dirname, '..', '..', '.agentic-health-fail')` resolves to the harness root. Fix: read the flag from `process.cwd()` instead: `const failPath = path.join(process.cwd(), '.agentic-health-fail');`. The test script already writes the flag in the session cwd (it `cd`s to `D:\DeepSeekHarness` before running `claude`, so the session cwd is `D:\DeepSeekHarness`; under the new layout, the session cwd is `D:\Temp\agentic-live\health\` and the flag is written there).

2. **Health command in `.agentic-health`.** Currently `node agentic-plugin/.kit/health-probe.js` (relative to the harness root). Fix: the test script writes the absolute path: `node D:\DeepSeekHarness\agentic-plugin\.kit\health-probe.js`. The plugin runs it through `dp.process.run(argv)` in the session cwd, so an absolute path is safe regardless of cwd. **Parsing (J5):** `runHealth` (index.ts:74-120) reads the file text and splits on whitespace: `raw.trim().split(/\s+/).filter((t: string) => t)` (index.ts:82). The path `D:\DeepSeekHarness\agentic-plugin\.kit\health-probe.js` contains no spaces, so the whitespace split is safe.

3. **Planner-fault flag.** Already cwd-relative (`index.ts:777` checks `$.fs.exists(".agentic-planner-fault")`). No fix needed; the test script writes the flag in the session cwd.

4. **Yields log.** Already cwd-relative (`yieldLogPath` is set to `.agentic-yields.log` in `sess`). No fix needed.

**Citation:** `index.ts:76` (healthPath), `index.ts:186` (storePath), `index.ts:187` (yieldLogPath), `index.ts:188` (heartbeatPath), `index.ts:777` (planner-fault), `health-probe.js:6` (fail flag).

## 3. The RUNNING claim under parallelism

Keep one claim per suite directory: `D:\Temp\agentic-live\<suite>\RUNNING`. The runner writes a global claim `agentic-plugin/.kit/RUNNING` for the whole batch (transition safety: a suite from the old protocol that checks the global claim will see it and refuse to start).

## 4. The runner script

One tracked script: `agentic-plugin/.kit/live-all.sh [suite...]`.

- Default: all eight suites.
- Concurrency: at most 3 at a time (a job-slot loop, no external tools). Concurrency is a variable at the top of the script: `CONCURRENCY=3`.
- 30 s stagger between launches.
- Each suite's artifacts (`.decisions.log`, `.assert.log`, `.exit`, stdout) are copied into `agentic-plugin/.kit/runs/<utc-stamp>/<suite>.*`.
- One summary file in the same form as the Reviewer's `v070e-run.summary`: one line per suite: `script_exit`, `started`, `ended`, exit file, assert log.
- Exit code: non-zero when any suite fails.
- **L4 (runner):** When any suite fails, the run directory is the evidence and stays. It stays today, so nothing to change, but say so here.

## 5. The short-cadence profile

**How options reach the plugin (J1):** A plugin's `register(on, options)` receives the values of its manifest's `userConfig` fields, stored in `settings.json` under `pluginConfigs[<plugin>].options` (`.claude/types/claude-code.d.ts:2534-2540`). For a `--plugin-dir` plugin the key is the manifest `name` (`agentic-plugin`). The CLI flag is `--settings <file-or-json>` (`claude --help` line 221). Confirmed live: a `settings.json` containing `{"pluginConfigs":{"agentic-plugin":{"options":{"heartbeatMs":5000}}}}` passed as `--settings <file>` to a `claude -p` stream-json session made the plugin rewrite `.agentic-heartbeat.json` every 5 s for a 70 s hold (default 30 s).

**Citation:** `index.ts:50` (`options: { healthTimeoutMs?: number; gitProbeMs?: number }`), `index.ts:228-230` (reading `cfg.gitProbeMs`, `cfg.nudgeIdleMs` into `sess.options`).

**Profiles (J2):** The two profiles live in `live-common.sh` as shell variables, selected by `PROFILE=full|short` (default `short`):

| Variable | full | short |
|---|---|---|
| `TICK_MS` | 30000 | 10000 |
| `NUDGE_IDLE_MS` | 120000 | 45000 |
| `GIT_PROBE_MS` | 120000 | 30000 |

`heartbeatMs`, `staleAfterMs`, `nudgeFloorMs`, `healthTimeoutMs` stay at defaults in both profiles. The same file emits the `settings.json` JSON for the suite's `--settings` flag.

**Timing derivation:** Every timing literal in the suites becomes derived from those variables: gitprobe holds become `GIT_PROBE_MS + TICK_MS + 10s`, the errorstreak tick window `TICK_MS + 15s`, the controller idle wait `NUDGE_IDLE_MS + TICK_MS + 10s`. The assertion files do not change.

## 6. Acceptance test

Quoted in the completion entry:

(a) `live-all.sh` at full cadence: eight green, wall clock at or under 25 minutes, read from the summary's first `started` and last `ended`.

(b) `live-all.sh` with the short profile: eight green, wall clock at or under 12 minutes.

(c) One suite run alone from its private directory leaves nothing in `D:\DeepSeekHarness` (paste `ls -a D:\DeepSeekHarness | grep '^\.agentic'` before and after).

(d) The full-cadence run is mandatory at each tag; the short profile is the default for fix rounds. Recorded in the protocol block of the plan doc.

## 7. Protocol block

- Full-cadence run: mandatory at each tag (v0.7.x, v0.8.0, etc.).
- Short-cadence run: default for fix rounds and iterative work.
- Concurrency: 3 (operator's number; harness killed a background task for low memory during the a5e9703 round).
- Wall clock targets: full ≤ 25 min, short ≤ 12 min.

## 8. Non-goals

- No plugin behavior change beyond reading the profile.
- No new decisions or actuators.
- No change to the assertions' meaning.

## 9. Cheap questions (answered)

1. **Concurrent haiku sessions:** No direct observation of concurrent haiku sessions on this box with the local model loaded. Keeping concurrency at 3.

2. **Absolute paths in hooks:** `grep -n "DeepSeekHarness" hooks/*.ts` returns no matches. The plugin does not write to `D:\DeepSeekHarness` by absolute path; all paths are cwd-relative.

---

## Revisions

### Revision 1 (2026-09-08)

| Item | Change |
|---|---|
| J1 | Rewrote section 5: `--settings <file>` with `settings.json` containing `{"pluginConfigs":{"agentic-plugin":{"options":{...}}}}`. Dropped the `.agentic-config.json` fallback (there is a supported path). Kept the citation to `index.ts:228-230`. |
| J2 | Added `controllerTickMs=10000` to the short profile. Profiles live in `live-common.sh` as shell variables (`TICK_MS`, `NUDGE_IDLE_MS`, `GIT_PROBE_MS`, selected by `PROFILE=full\|short`). Timing literals in suites derived from those variables. |
| J3 | Acceptance (c) now uses `grep '^\.agentic'` (not `grep agentic`, which matches the `agentic-plugin` directory). |
| J4 | Section 2 states the removal order: suite writes artifacts → runner copies to `runs/<stamp>/` → runner removes directory. |
| J5 | Section 2.2 cites the whitespace split (index.ts:82) and states the path contains no spaces. |
| J6 | Commit the plan before building (this commit). |

---

## Closing (v0.8.0)

### What shipped

1. **Parallel runner** (`.kit/live-all.sh`): concurrency-3 parallel execution of the eight live suites, with a job-slot loop and exit-file lookup. The runner copies artifacts to `runs/<stamp>/` and removes suite directories (kept on red batches, documented in section 4).

2. **Per-suite scratch directories**: each suite runs from `/d/Temp/agentic-live/<suite>/` with its own `.agentic-personas.json`, `.agentic-heartbeat.json`, `.agentic-yields.log`, and flag files. This isolated the suites and made parallel execution safe.

3. **Cadence profiles** (`PROFILE=full|short`): `live-common.sh` defines `TICK_MS`, `NUDGE_IDLE_MS`, and `GIT_PROBE_MS` for both profiles. The `--settings` flag passes the profile to the plugin via `pluginConfigs`. The short profile (10s tick) cuts wall clock from ~50 min serial to 8m46s (target 12m); the full profile (30s tick) runs in 18m40s (target 25m).

### Fixes (M1, N1)

Both were live-session ordering races gated on observed state, not a clock:

| Label | Suite | Root cause | Fix |
|---|---|---|---|
| M1 | errorstreak | At full cadence (30s tick), the planning tick fires after all three denied Bash turns, so the streak fires against `no-active-node` and pauses nothing. The plan activates 30s later. Short cadence (10s tick) passes by luck. | Added `wait_activation` after `wait_turn 1` in `feed()` (`.kit/live-errorstreak-test.sh:33`), forcing a plan active before the denials at either cadence. |
| N1 | yield | Two concurrent `claude -p` sessions (A and B) launched ~`STAGGER_S` apart each take 45-60s to reach turn 1, so which one writes first is a startup race. When B wins, A's write is denied and the ordered assertion fails. | Added `wait_for_fact` helper (`.kit/live-common.sh:73-92`) that polls `.agentic-personas.json` until Session A's first write is observed. Replaced `sleep $STAGGER_S` with `wait_for_fact "Session A owns default"` in `feedB` launch (`.kit/live-yield-test.sh:56`). |

### Gate

Full-cadence 8-suite gate at commit `3f316ec`, run `20260908T061726Z`: **8/8 green, exit 0**. Wall clock 18m40s (target 25m). Short profile: 8m46s (target 12m). Both fixes (M1, N1) confirmed at full cadence.

### Revision table (final)

| Label | Status | File:line | Note |
|---|---|---|---|
| J1-J6 | shipped | `.kit/live-all.sh`, `.kit/live-common.sh`, all suites | Plan revisions 1-6 |
| K1-K5 | shipped | `.kit/live-all.sh` | Runner fixes (honesty gate, job-slot loop, exit-file lookup, summary form, run dir on red) |
| L1-L7 | shipped | `.kit/live-*.sh`, `hooks/index.ts`, `roadmap-test.md` | Test-construction fixes (errorstreak allowedTools, gitprobe .gitignore, MSYS path bug, runner doc, controller feed, nudge display, goaltree objective) |
| M1 | shipped | `.kit/live-errorstreak-test.sh:33` | `wait_activation` gate before denials |
| N1 | shipped | `.kit/live-common.sh:73-92`, `.kit/live-yield-test.sh:56` | `wait_for_fact` gate before Session B launch |
