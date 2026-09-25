# A planner attempt that throws counts as a planning failure, and a completion result is read through one reader, so a due root cannot burn a Haiku call every tick without end

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-25

## Dispatch Authorization

The coordinator persona raised this as a `[FINDING]` on 2026-09-25 (record `ARCHITECT-3099de12-61b6-4c99-8b12-bfb097b53b0f-1`), reporting the DEV-DISCORD root `root-mubrfbj6` in a silent planner-retry loop, and that the operator approved closing that root. The ARCHITECT confirmed the loop at the source the same day and wrote this plan under its standing authority to write a small, clearly valuable fix for a finding. It shares `hooks/index.ts` with every in-flight persona plan and is not disjoint from them. It is a live cost leak, so it runs ahead of the queued plans, on one branch cut from `origin/main` after a fetch, landing as one pull request. The line numbers below are as of `bc3c153`.

## Goal

When this ships, a planner attempt that throws anywhere inside the planning gate counts as a planning failure, so three in a row block the root and the planner stops retrying every tick. Every place the plugin reads a model completion reads it through one reader that accepts the string the harness typings declare and the object the harness now returns, and treats anything else as a failure on that site's own failure path rather than a throw. `goal_done` can complete a root whose descendants are all complete or abandoned with at least one complete, in a turn the operator or the coordinator persona started, so a root the planner has already broken down can be closed truthfully rather than dropped as abandoned. The DEV-DISCORD root closes that way once the plugin is updated.

## Intent

The frame: the coordinator found `root-mubrfbj6` pending with every child complete or abandoned, 93 `planning_fired` decisions ten seconds apart and no `planning_created`, `planning_complete` or `planning_failed`, and asked for the throw to be diagnosed and the outer catch to count as a failure.

What the ARCHITECT confirmed at the source. The ten-second spacing is `controllerTickMs: 10000` in `D:/personas/DEV-DISCORD/run/settings.json`, the run directory the roster names, which is not the working directory the coordinator read. The child's debug log shows one Haiku completion of about 900 characters every ten seconds, so the model call returns and the planner ledger climbs (`planner.count` 18,339 at the last cost summary). The throw is `raw.slice(0, 100)` in the parse-failure branch (`hooks/index.ts:5520`), reached because `raw.trim()` throws inside the parse `try` when `raw` is not a string. The self-review site, which reads the same call, logged the same fault in words at 09:58:23Z: `raw.trim is not a function. (In 'raw.trim()', 'raw.trim' is undefined)`. So the harness's `$.model.complete` no longer resolves to a string on 2.1.280 and later, against the typings copied on 2026-09-09 (`.claude/types/claude-code.d.ts:1411`), and the planner's own failure counter never runs because the throw sits before `registerPlanningFailure` is called.

What done needs to do: count a throw as a failure; read a completion through one reader at all five sites; close the DEV-DISCORD root truthfully. The `goal_done` admission and the wait until the plugin is updated are the author's picks toward that third need, declared under Assumptions.

What done does not need to do: no change to the planner's prompt or its cap values; no hand edit of any persona store; no change to the supervisor's `untracked_work` or `root_complete` reads; no repair of the roll-refused channel log, which is a separate backlog item.

Alternatives refused:
- Drop the root with `goal_edit`, which records it abandoned. Refused: the plan is archived Complete on `origin/main` at 8b76e3e, so abandoned is untrue, and the coordinator refused it for that reason.
- Complete the root by editing the store file. Refused: the store is the plugin's, a live process overwrites the edit, and the goal tree changes only through a tool call that names the change.
- Fix only the planner's `raw.slice`. Refused: four other sites read the same call with `.trim()`, and the self-review already fails on it; the reader is a property of the call, not of the first site that broke.

Rulings: none at the write.

Provenance: the coordinator's finding record and the ARCHITECT's read of the DEV-DISCORD store, run directory and child debug log on 2026-09-25.

## Approach

**One reader for a completion.** `completionText(value: unknown): string | null` returns `value` where it is a string, `value.text` where `value` is an object carrying a string `text`, and null otherwise. It sits in `hooks/index.ts` beside `safeErrorText`. Every `$.model.complete` site reads its result through it: the self-review lesson (`hooks/index.ts:5175`), the planner (`5488`), the plan switch (`6119`), the controller reason (`6187`) and the memory distill (`7292`). A null takes that site's existing failure path. The planner registers a failure whose detail is `Planner returned no text (<typeof value>, keys: <comma-joined own keys, or none>)`, so `42` reads `(number, keys: none)` and `null` reads `(object, keys: none)`. The other four sites log the decision their own catch logs today, with the detail naming the value's shape in the same form, and write nothing else: no lesson, no switch, no reason text, no distilled memory. An empty string is text, not a null, so the planner's parse branch takes it and registers a parse failure as today. The shape observed at runtime is recorded in a code comment on the reader as a property of the harness, since the typings file says otherwise.

**The bare catch registers the failure.** `registerPlanningFailure` is today a `const` closure declared at `5457` inside the `try` that opens at `5363`, so the catch cannot reach it. It moves above the `try`, taking the root's id as an argument in place of the closed-over `root`, with its body unchanged. The `catch { /* Planning failed; non-fatal. */ }` at `5603` becomes `catch (err)` and awaits `registerPlanningFailure(root!.id, \`Planner threw: ${safeErrorText(err)}\`)`, with no second wrap, since a register whose own persist throws has nothing left to write. So any throw in the gate counts toward the three-strike block, and `planningInFlight` still clears in `finally`.

**`goal_done` completes a finished root.** Today `goal_done` refuses the root outright (`8164-8167`). It gains one admission: a root whose descendants are all `complete` or `abandoned` with at least one `complete`, in a turn `turnMayStartEffort()` admits, completes through `completeRoot` with the tool's note as the `detail` verbatim, so `root_complete` is logged as it is for the controller's own completion; the handler then persists and returns, running none of the leaf follow-on (the health run, the round credit, the next activation, the ask close). That gate's admission set is the one `hooks/index.ts:2588` states: not a priming turn, a delivery under the coordinator persona's ground whose record opens with neither `[FINDING]` nor `[PROPOSAL]`, or an unmatched turn whose origin kind is one of the operator's four; a nudge turn is refused. Every other root call keeps the refusal text. The `planningRounds !== 0` clause of `isRootFinished` stays, because the controller's own auto-completion still defers to the planner for a root it broke down; the tool is the operator's word that the breakdown is done.

**Closing the DEV-DISCORD root** is an operator-verification step, not a section, and it has two moves because the fixed planner runs first. On the first tick after the relaunch the planner parses Haiku's reply, which the log shows is a list of plans rather than an empty array, and creates pending plan nodes under the root, activating the first. Those are the planner's own inventions, so dropping them is true. The coordinator therefore delivers one record telling DEV-DISCORD to `goal_edit` drop each planner-created plan with the reason that the root's plan is archived Complete, and then `goal_done` the root with a note naming the archived plan. After the drops every descendant is complete or abandoned, so the admission holds.

## Sections of Work

### 1. Reproduce the silent loop in the tick harness
Model: opus
Add two cases to `.kit/controller-tick-test.mjs` beside the S13 planner-failure cases (`16940-16967`), each with a root at `planningRounds: 1` and every child `complete` or `abandoned`. The regression pin stubs the harness's `complete` to resolve `{}`, a value with no text. On the trunk it shows the defect: three ticks log three `planning_fired`, no `planning_failed`, no `planning_complete`, the root stays `pending`. Watch it red, then keep it with the assertions inverted by section 2: `planning_failed` at each of three ticks, a `block` at the third, no `planning_fired` afterwards. The second case stubs `{ text: "[]" }` and pins the parse path: after section 2 one tick logs `planning_complete` and `root_complete`. Add the mirror case for the self-review site, whose lesson call the same stub serves.
Acceptance: the regression pin is red on `bc3c153` with the three observations above and green after section 2 with the inverted assertions; the parse-path case is green after section 2; the self-review case shows the site logging its shape-naming decision and no lesson.
Files in scope: `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs` (the `completeValue` stub at 125 and 321 already accepts any value).
Tests: this section is the test; the red run is recorded in the Chapter with its exit code.

### 2. The reader and the counted catch
Model: opus
Add `completionText` and route the five sites through it as the Approach states. Hoist `registerPlanningFailure` above the `try` and replace the bare catch with the counted one. In the planner, the parse branch reads `const text = completionText(raw)` first, and a null registers `Planner returned no text (<type>, keys: <keys>)` before any parse.
Acceptance:
- Section 1's two planner cases are green; the S13 fault-file cases pass unchanged.
- With `complete` resolving to a plain string, every site behaves as on the trunk (the existing cases pass).
- With `complete` resolving to `{ text: "..." }`, the planner parses that text and the self-review, switch, reason and distill sites read it.
- With `complete` resolving to `{}` or `42`, the planner registers a failure naming the shape and the other sites take their failure path with no throw reaching the tick.
- A throw from inside the gate that no inner `try` catches registers `Planner threw:` and counts toward the block. The harness injects it with a `complete` stub resolving an object whose `text` getter throws, which the reader reads outside every inner `try`; `activate` cannot throw and a `persist` throw defeats the register's own write, so neither is the injection.
Files in scope: `hooks/index.ts` (the five sites, the planner gate at 5359-5605, `safeErrorText` at 971), `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs`.
Tests: lock both directions at the planner (string and object parse; a non-text shape and a late throw both count), and lock that the block trips at three; a catch that swallows again is the leak this plan exists for.

### 3. `goal_done` on a finished root, and the documents
Model: sonnet
Add the admission to the `goal_done` handler (`8143-8186`) as the Approach states, with the refusal text for a root that is not finished naming the open child, and a refusal for a turn `turnMayStartEffort()` does not admit saying the root closes only on the operator's or the coordinator's word. Update `README.md` ("Changing the goal tree" at 179, the turn-origin gate paragraph at 715 which says `goal_done` never refuses on whose turn it is, the root-completion paragraph at 717 which says a planned root stays the planner's, and the `goal_done` description), `docs/architecture.md` (the turn-gate row at 289 gains `goal_done`'s root admission, and the failure-modes table gains a row for `planning_failed` with `Planner threw:` and `Planner returned no text`), the `completeLeaf` comment in `hooks/agent-state.ts` at 933 which says the root is never touched, and the tool description of `goal_done`. Tool descriptions are sized by `.kit/injection-ledger.json`, regenerated with `node .kit/injection-ledger.mjs`, and `.kit/tool-description-length-test.mjs` pins their length, so both run after the edit.
Acceptance:
- `goal_done nodeId=<root>` in an operator turn on a finished root completes it with `root_complete` logged; the same call on a root with an open child refuses naming it; the same call in a nudge turn refuses.
- `.kit/controller-tick-test.mjs`, `.kit/tool-description-length-test.mjs` and `.kit/injection-duplicate-test.mjs` pass on their own exit codes.
- Both documents state the admission and the two new failure details, and no sentence in either still says `goal_done` never refuses on turn origin or that a planned root stays the planner's alone.
Files in scope: `hooks/index.ts` (the `goal_done` registration at 3002 and handler at 8143), `hooks/agent-state.ts` (the `completeLeaf` comment at 933), `README.md` (179, 715, 717), `docs/architecture.md` (289 and the failure-modes table), `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.json`, `.kit/tool-description-length-test.mjs`.
Tests: lock the admission in both directions and the turn gate; a root closed from a nudge turn is the plugin closing the operator's objective on its own reading.

## Out of Scope
- The channel log roll refusal (`.agentic-channel.jsonl` at the 4 MB write limit), which keeps overflow in memory; a separate backlog item.
- Regenerating `.claude/types/claude-code.d.ts` from the harness, which has no generated source on this machine.
- Any change to the planner prompt, the cap values or `isRootFinished`.
- Any hand edit of a persona store.

## Assumptions
- assumed 2026-09-25 (source: the self-review error text in the DEV-DISCORD store and the debug log's per-call character counts): the harness now resolves `$.model.complete` to an object carrying the text rather than the string the typings declare; reversal: if the object carries the text under another key, the reader's one lookup changes, and section 2's shape-naming failure detail is what reveals the key.
- assumed 2026-09-25 (default): `goal_done` on a finished root is admitted in operator and coordinator turns only, on the existing `turnMayStartEffort` gate; reversal: widening or narrowing is one condition.
- assumed 2026-09-25 (default): the DEV-DISCORD root is closed by the tool after the update rather than by any edit now, accepting the leak until then; reversal: the operator may instead accept `goal_edit` drop of the root as an interim, which records the root abandoned.
- assumed 2026-09-25 (default): the plan nodes the fixed planner invents on its first tick are dropped as abandoned before the root closes, since they are the planner's inventions and never the operator's word; reversal: an admission that ignores never-activated controller-created children, a larger change.

## Operator Verification
- After the plugin cache updates and the DEV-DISCORD supervisor relaunches, the fixed planner runs once and creates plan nodes from Haiku's reply. The coordinator then delivers one record asking DEV-DISCORD to `goal_edit` drop each planner-created plan, reason: the root's plan is archived Complete, and then `goal_done` `root-mubrfbj6` with a note naming the archived plan. The store then shows the root `complete`, the dropped plans `abandoned`, and no further `planning_fired`. What reopens the work: a `planning_fired` after the close, or a refusal from the tool.
- Until then, the leak continues at one Haiku call per ten seconds on DEV-DISCORD. The operator may ask the coordinator to stop that persona's supervisor as an interim.

## Open Questions
- None.

## Related
- `docs/archive/agent_persona_passive-supervisor_v1.md`: the controller's own root completion this plan's `goal_done` admission sits beside.
- `docs/archive/agent_persona_goal-tree-curation_v1.md`: `goal_done` by name, which this plan extends to a finished root.

## Chapters
