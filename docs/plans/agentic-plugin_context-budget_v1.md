# agentic-plugin: context budget, v1

Status: Draft. Written before any code. The plan is the contract: the completion entry quotes the assertions this plan names.

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

## 5. Checkpoint (BLOCKED-on-operator)

The Program named the operator's own compaction checkpoint, through the kit. The kit's `open` verb requires an armed kit goal, which a persona worker does not have by design (that is item 5's whole premise). The exact mechanism 2b assumed does not work as written. This is the operator's call, not ours to bake in.

Three paths, so the operator can pick:

- **Path A (plugin marker file):** The plugin writes `.agentic-activation-checkpoint` (JSON: session id, timestamp) at each `activated` boundary; the operator later teaches the kit gate to read it. Ships now, no kit change, but the integration is deferred and does nothing until the operator wires the read.
- **Path B (kit change):** The operator changes the kit so a no-goal plugin session may `open` a real compaction checkpoint. True integration, but it is a kit change the operator designs and it touches the compaction gate's safety model.
- **Path C (existing `boundary` verb):** The plugin calls `kit-compact-checkpoint.js boundary` (no goal required, session-scoped). **Open question**: whether `boundary` actually defers auto-compaction or only marks a role edge. State that open question in the plan rather than assuming it does.

Do not build it. The plan marks this section BLOCKED-on-operator.

## 6. Acceptance test

A live suite (call it `budget`) that drives a session past a low test threshold and asserts the crossing decisions latch once and the nudge fires. Set the test thresholds low via options so a short session crosses them.

**Thresholds**: Set them so all three cross within about five turns. At chars/4, the info threshold of 1000 tokens is 4000 chars (two or three tool turns), the close-out 2000 tokens is 8000 chars (three to five turns), and the critical 3000 tokens is 12000 chars (five to eight turns). Compute the turn count from the per-turn character growth rather than guessing.

**Assertions** (read the decision log the way every other suite does):
- `action: "context_budget_crossed"` appears once per threshold in the decision log.
- `action: "context_budget_nudge"` appears once above the close-out threshold.
- **Latch pin**: Drive the estimate up past a threshold, hold it, and assert the crossing logged exactly once, not once per tick.

## 7. Revisions

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
