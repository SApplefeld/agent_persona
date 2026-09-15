# agentic-plugin: context budget, v3

Status: Complete

## 1. Purpose

Long-running persona sessions accumulate context: the transcript grows with every turn, and the model's working memory fills. The plugin's job is to surface the budget state and nudge the worker toward safe stopping points. This plan adds a context-budget monitor to the controller tick that estimates the transcript's token count, latches on threshold crossings, and fires a close-out nudge above the close-out threshold.

Non-goals: no auto-compaction (that is the operator's kit gate's job); no new decisions or actuators beyond the nudge path; no change to the assertions' meaning.

## 2. Budget read (controller tick)

The controller tick runs on `$.clock.every(controllerTickMs)` (`.hooks/index.ts:568`). It already has the session handle and makes decisions (error streak, idle nudge, git probe). Add a context-budget check to the tick:

1. **Read the transcript**: `const messages = await $.session.messages();` (`.claude/types/claude-code.d.ts:737`).
2. **Estimate tokens**: Sum what the model actually read, each piece once:
   - `SessionMessage.text` (`.claude/types/claude-code.d.ts:3589-3607`)
   - Per tool call: `ToolUseSummary.name` and `JSON.stringify(ToolUseSummary.input)` (`.claude/types/claude-code.d.ts:4147`)
   - `ToolResultSummary.text` (`.claude/types/claude-code.d.ts:4105`, "the result as the model read it")
   
   **Trap**: `ToolUseSummary` also carries a `text`/`result` for the answered call, which overlaps `ToolResultSummary.text`; summing both double-counts every tool result. Pick one source for the result text and say which in the plan: `ToolResultSummary.text` is the right field, not `result` (which is the transcript's stored record; Bash blanks stdout headless).
   
   **Under-count**: chars/4 under-counts dense JSON (real tokenization of code and JSON runs nearer 3 chars per token), so the estimate is a lower bound and the thresholds carry the headroom, because for a safety budget the dangerous error is thinking you have room you do not.
   
   **Sub-cadence**: Consider reading the budget on a sub-cadence rather than every tick: the estimate changes one turn at a time while `$.session.messages()` rebuilds the whole transcript each call, so on a large session an every-tick read allocates the full transcript every 10 to 30 seconds for a slow-moving number. A `contextBudgetReadEveryNTicks` (default a few) halves the cost with no loss.
3. **Latch on crossing**: Three thresholds, each an option defaulting to the Program's numbers:
   - `contextBudgetInfoTokens=100000`
   - `contextBudgetCloseoutTokens=250000`
   - `contextBudgetCriticalTokens=350000`
   
   Latch on the highest crossed. Log a decision (`action: "context_budget_crossed"`) with the threshold name and the estimate. Do NOT re-log every tick above the line (that would collapse the ladder).
4. **Re-arm with hysteresis**: When the estimate drops below a threshold (after the operator compacts, the transcript shrinks and tokens fall), re-arm that crossing so the next climb warns again. A latch with no re-arm warns once per session and then goes silent through every later compaction cycle, which is the wrong behavior for a days-long run. **Hysteresis band**: Re-arm only when the estimate falls a small margin below the threshold (say 5 percent), so an estimate hovering exactly at a threshold does not flap crossed, re-armed, crossed. In practice the estimate grows monotonically and a compaction is a sharp discrete drop, so flapping is unlikely, but the margin is cheap insurance.

## 3. Close-out nudge (above 250K)

The Program names a worker nudge above 250K: "ask the worker to close out above 250K". This is NOT auto-compaction (the kit's job). It is a prompt telling the worker to bank state and reach a clean stopping point. That is the worker self-directing toward safety, which is the plugin's whole reason to exist.

**Delivery**: `$.prompt.submit({ text })` (the same path the idle nudge uses, `.hooks/index.ts:1130`), NOT `$.ui.toast` or `$.ui.status` (those notify the operator's terminal and never reach the worker). The nudge names the budget state and tells the worker to bank state to memory and the plan doc, then reach a clean stopping point. Log a decision (`action: "context_budget_nudge"`).

**Latch**: Fire it once, latched to the close-out crossing, re-arming with that threshold, so it does not repeat every tick above the line.

**Nudge budget**: The budget nudge is a different trigger than idle, so it should NOT consume the idle nudge's `consecutiveNudgesWithoutOnGoal` budget.

## 4. Gate the feature

Gate the whole feature behind `options.contextBudgetEnabled` (default `false`). When off, no budget read, no latch, no nudge. The plugin ships useful without it.

## 5. Checkpoint

The Program named the operator's own compaction checkpoint, through the kit. The kit's `open` verb requires an armed kit goal, which a persona worker does not have by design (that is item 5's whole premise). The exact mechanism 2b assumed does not work as written. This is the operator's call, not ours to bake in.

Three paths, so the operator can pick:

- **Path A (plugin marker file):** The plugin writes `.agentic-activation-checkpoint` (JSON: session id, timestamp) at each `activated` boundary; the operator later teaches the kit gate to read it. Ships now, no kit change, but the integration is deferred and does nothing until the operator wires the read.
- **Path B (kit change):** The operator changes the kit so a no-goal plugin session may `open` a real compaction checkpoint. True integration, but it is a kit change the operator designs and it touches the compaction gate's safety model.
- **Path C (existing `boundary` verb):** The plugin calls `kit-compact-checkpoint.js boundary` (no goal required, session-scoped). **Fact (read from kit source):** The `boundary` verb defers auto-compaction. It writes a role-boundary marker (`compact-role-boundary.<session>.json`) that the PreCompact gate (`kit-compact-gate.js:695-699`) reads; when the marker is valid (same session, within `ROLE_BOUNDARY_MAX_AGE_MS`, and no new turn has begun since it was written), the gate allows the next auto-compaction attempt and consumes the marker (`return decide({ verdict: 'allow', reason: 'role-boundary', consumed })`). It is not merely marking a role edge; it is actively enabling compaction at that boundary. The marker is single-shot: once the gate spends it, the boundary is done. **Caveat**: `cmdBoundary` writes the marker under `process.cwd()` (`kit-compact-checkpoint.js:549`), while the gate reads it under `payload.cwd || process.cwd()` (`kit-compact-gate.js:564`); the gate's `cwd` comes from the hook input JSON, not from `process.cwd()` alone. If the harness invokes the boundary hook from a session cwd that differs from the directory where the gate later runs, the marker will not be found; the seat must invoke `cmdBoundary` from the same cwd the gate will read under (in practice, the session's working directory).

**Resolution (Path D, the operator's ruling):** the boundary is the seat's own judgment, not a plugin act. The coordinator role instruction in `bin/supervise.sh` carries a standing sentence: at the end of a turn where the seat's worktree edits are none or handed off, every decision from the stretch is on disk, and every message owed is sent, the seat runs `kit-compact-checkpoint.js boundary` from its own working directory as the turn's last act, and skips it while a goal or a steer is still in flux. Path C's mechanical call at each `activated` boundary was not taken because whether a turn is a boundary depends on whether a conversation or a decision is mid-flight, which the plugin cannot read and the seat can. The clause reaches the coordinator persona only. A worker on an armed kit goal already lands its compaction through the chapter checkpoint; a worker with no kit goal is not covered by this section and is a follow-on if one is wanted. The cwd caveat above is met by construction: the seat runs the verb from the session's own working directory, which is the directory the gate reads under.

## 6. Acceptance test

A live suite (call it `budget`) that drives a session past a low test threshold and asserts the crossing decisions latch once and the nudge fires. Set the test thresholds low via options so a short session crosses them.

**Thresholds**: Set them so all three cross within about five turns. At chars/4, the info threshold of 1000 tokens is 4000 chars (two or three tool turns), the close-out 2000 tokens is 8000 chars (three to five turns), and the critical 3000 tokens is 12000 chars (five to eight turns). Compute the turn count from the per-turn character growth rather than guessing.

**Assertions** (read the decision log the way every other suite does):
- `action: "context_budget_crossed"` appears once per threshold in the decision log.
- `action: "context_budget_nudge"` appears once above the close-out threshold.
- **Latch pin**: Drive the estimate up past a threshold, hold it, and assert the crossing logged exactly once, not once per tick.

## 7. Close-out: Independent Part (2026-09-08)

### What shipped

- **Budget read** (section 2): `$.session.messages()` read on controller tick with sub-cadence (`contextBudgetReadEveryNTicks`, default 3). Token estimate sums `SessionMessage.text`, `ToolUseSummary.name`, `JSON.stringify(ToolUseSummary.input)`, and `ToolResultSummary.text` (chars/4, lower bound by design).
- **Three latched thresholds** (section 2.3): `contextBudgetInfoTokens=100000`, `contextBudgetCloseoutTokens=250000`, `contextBudgetCriticalTokens=350000`. Each crossed once, logged as `context_budget_crossed` with detail `<level>: <N> tokens`. Latch on highest crossed.
- **Hysteresis re-arm** (section 2.4): Re-arm only when estimate falls below threshold × 0.95 (5% band).
- **Close-out nudge** (section 3): Fires via `$.prompt.submit({ text })` above close-out threshold. Latched, does not consume idle nudge budget. Logged as `context_budget_nudge`.
- **Feature gate** (section 4): `contextBudgetEnabled` option (default `false`).
- **B1 race guard**: `budgetReadInFlight` flag serializes budget reads, preventing decision-reorder and double-nudge flake (Reviewer finding, round 18).
- **Budget test suite**: 5 turns of haiku + `memory_add`, calibrated thresholds (info=300, closeout=500, critical=700). Asserts: ≥3 crossings, exactly 1 closeout nudge, each threshold crossed exactly once (latch pin).

### Lanes that gated it

- **Short cadence**: budget + controller + errorstreak (regression pin), all green, `script_exit=0`, ASSERT 0, EXIT 0. Run `20260908T073743Z`.
- **Full cadence**: budget green, `script_exit=0`, ASSERT 0, EXIT 0. Crossed at 07:41:44 (1381 tokens), order correct. Run `20260908T074040Z`.

### B1 finding and fix

Reviewer's run crossed thresholds across separate ticks and exposed a race: two ticks entering the budget block concurrently could log decisions out of order or double-nudge. Fix: `budgetReadInFlight` guard (line 81), set before first await, cleared in `finally`. Verified: all three crossings logged atomically at same timestamp.

### What's left

Checkpoint section (section 5) remains BLOCKED-on-operator (Paths A/B/C). Not built. Path C open question (does `kit-compact-checkpoint.js boundary` defer auto-compaction or only mark a role edge) is the operator's to settle.

### Commits

- `a288c2f` 2b: context budget implementation (independent part)
- `35b6265` Fix: move budget check before active leaf check
- `2303db1` Calibrate budget test thresholds to observed per-turn growth
- `3072690` B1: add budgetReadInFlight guard to serialize budget reads

## 8. Revisions

### Revision 1 (2026-09-08)

| Item | Change |
|---|---|
| C1 | Three latched crossings (100K, 250K, 350K), not one. Re-arm on drop below threshold. |
| C2 | Reinstate the close-out nudge above 250K. It is not auto-compaction; it is the worker self-directing toward safety. |
| C3 | Include `toolUses` input and `toolResults` output in the estimate, not `text` alone. State the under-count: chars/4 under-counts dense JSON, so the estimate is a lower bound. |
| C4 | Checkpoint as BLOCKED-on-operator with paths A/B/C. Do not build it. |
| C5 | Acceptance test: `budget` suite with low thresholds, asserts latch once and nudge fires. |
| D1 | Close-out nudge delivers through `$.prompt.submit`, not a toast. Fire once, latched, re-arming with that threshold. Do not consume the idle nudge's budget. |
| D2 | Set test thresholds so all three cross within about five turns. Assert through the decision log: `context_budget_crossed` once per threshold, `context_budget_nudge` once above close-out. Latch pin: drive the estimate up past a threshold, hold it, assert the crossing logged exactly once. |
| D3 | Name the exact fields: `SessionMessage.text`, `ToolUseSummary.name`, `JSON.stringify(ToolUseSummary.input)`, `ToolResultSummary.text`. Avoid double-counting: pick `ToolResultSummary.text` for the result, not `result`. Consider `contextBudgetReadEveryNTicks` (default a few) to reduce cost. |
| D4 | Re-arm with hysteresis: only when the estimate falls a small margin below the threshold (say 5 percent), so an estimate hovering exactly at a threshold does not flap. |

### Revision 2 (2026-09-11)

| Item | Change |
|---|---|
| E1 | Path C open question resolved: read `kit-compact-checkpoint.js:517-566` and `kit-compact-gate.js:695-699`. The `boundary` verb defers auto-compaction by writing a role-boundary marker that the gate reads and uses to allow the next auto-compaction attempt. It is not merely marking a role edge; it is actively enabling compaction at that boundary. Stated as a fact with file and line in section 5. |

### Revision 3 (2026-09-11)

| Item | Change |
|---|---|
| F1 | Removed `2026-09-11` from the Status line and the Path C fact line (kept in Revision 2 only). |
| F2 | Added cwd caveat to Path C: `cmdBoundary` writes the marker under `process.cwd()` (`kit-compact-checkpoint.js:549`), while the gate reads it under `payload.cwd \|\| process.cwd()` (`kit-compact-gate.js:564`); if the harness invokes the boundary hook from a session cwd that differs from the directory where the gate later runs, the marker will not be found. |

### Revision 4

| Item | Change |
|---|---|
| G1 | Section 5 resolved by the operator's ruling as Path D: a standing judgment clause in the coordinator role instruction rather than a plugin call at each activation. Status flipped to Complete. |

## 9. Close-out: Checkpoint

### What shipped

- `bin/supervise.sh`: the coordinator role instruction gains the compaction-boundary clause (the three-question test, the `boundary` verb run from the seat's own working directory as the turn's last act, skip while a goal or a steer is in flux, a quiet turn declares one too). The comment above the instruction names the clause and why the coordinator needs the goalless path.
- `.kit/channel-reply-instruction-test.sh`: pins the boundary verb on both persona-matching cases through a new `ROLE_BOUNDARY_CONTROL` substring.
- `README.md`: the launch paragraph states the clause.
- `docs/README.md`: this plan moves to the archived list.

### Decisions and surprises

- The operator ruled for the seat's judgment over a mechanical plugin call, on the ground that a boundary is a reading of whether a conversation or a decision is mid-flight. Section 5 records it as Path D.
- The clause names the plugin root by its relation to the operating-instructions skill's base directory, since a child's Bash tool does not see `CLAUDE_PLUGIN_ROOT` and the priming already assumes claude-kit is installed on the host.
- A live run of the verb from the coordinator's own session confirmed the marker opens from this project directory, with no lapsed-marker warning, and the status read showed the gate honoring a sibling session's marker in the same directory. That session was a supervised `claude -p` stream-json child of `bin/supervise.sh` under the coordinator persona (its session id appears in the launch's `run/child-1/stdout.jsonl`), and `CLAUDE_CODE_SESSION_ID` was set in its Bash tool while `CLAUDE_PLUGIN_ROOT` was not, which is why the clause locates the plugin root through a loaded skill's base directory rather than the environment.
- Review findings addressed: the docs index listed the archived plan as active; the plugin-root pointer assumed a skill the coordinator may never have loaded; the marker's age bound was unstated; a prior close-out's record line had been rewritten. One finding was discarded: the kit's seat Stop hook rewriting the same marker applies only to a seat with a registry entry under the coordinator directory, and the coordinator persona holds none.

### Lanes that gated it

- Targeted lane: `.kit/channel-reply-instruction-test.sh`, baseline 25 OK exit 0 on the untouched tree, 25 OK exit 0 after the change. Red probe: the boundary verb swapped for another verb in the script turned both new pins red (exit 1), and the script was restored byte-identical from the pre-probe copy.
- `bash -n bin/supervise.sh` clean.

### Commit model

Branch-and-PR on `coordinator-compaction-boundary` off `01003f3`, the repository's convention for a protected `main`. Delivered in this changeset.
