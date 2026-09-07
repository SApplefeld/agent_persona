# Stage 1 Plan: Goal Tree and Plan Selection

Revision: 4

Version target: **0.6.2** · State version: **3** · Plugin: `agentic-plugin`

## Purpose

Replace the single `goal: GoalState | null` with a tree of `GoalNode` objects. The root represents the operator's objective (or a roadmap document). Plans hang under the root; tasks hang under plans. The controller activates one leaf at a time, scores turns against it, and switches when the active leaf completes or the controller decides another plan is more important.

This is the first stage of the six-stage program. It ships the data model, the worker tools, the planning gate, the switch decision, and the injection format.

---

## 1. State shape

### 1.1 `GoalNode` (replaces `GoalState`)

```ts
interface GoalNode {
  id: string;              // "goal-<base36>" for the root; "plan-<base36>" / "task-<base36>" for children
  parentId: string | null; // null for the root
  kind: "root" | "plan" | "task";
  title: string;           // one line
  objective: string;       // what done looks like
  status: "pending" | "active" | "paused" | "complete" | "abandoned" | "blocked";
  source: "operator" | "controller" | "worker";
  maxRounds: number;       // for plans and tasks; L9: operator's value on the root
  completedRounds: number;
  scores: Array<{ round: number; result: string }>;
  notes: string[];         // short, appended by worker or controller
  roadmapPath?: string;    // root only — the roadmap file path (R2)
  planningRounds: number;  // H3-part2: count of planning events on this node
  consecutiveBlockedPlannings: number; // H3-part2: consecutive blocked planning results
  createdAt: number;
  updatedAt: number;
  blockedReason?: string;
}
```

### 1.2 `AgentState` changes (v2 → v3)

```ts
interface AgentState {
  version: 3;
  // … persona, activeSessionId, epoch, memory, monitor, decisions unchanged …
  goals: GoalNode[];          // was: goal: GoalState | null
  activeGoalId: string | null; // was: (implicit in goal.status)
}
```

`createDefaultState` returns `goals: []` and `activeGoalId: null`.

### 1.3 Migration (v2 → v3)

In `parseState`, when `parsed.version === 2`:

1. Read `parsed.goal`.
2. If it is `null` → `goals: []`, `activeGoalId: null`.
3. If it is a `GoalState`:
   - Create a root node: `kind: "root"`, `title: goal.objective`, `objective: goal.objective`, `status: goal.status` (mapped: `active` → `pending` per L10 — the root is never active; the plan child carries the active state), `source: "operator"`, `maxRounds: goal.maxRounds` (L9), `completedRounds: 0`, `scores: []`.
   - Create one plan child: `kind: "plan"`, `parentId: root.id`, `title: goal.objective` (same), `objective: goal.objective`, `status: goal.status === "active" ? "active" : goal.status`, `source: "operator"`, `maxRounds: goal.maxRounds`, `completedRounds: goal.completedRounds`, `scores: goal.scores`.
   - If the plan is `active`, set `activeGoalId = plan.id`.
   - If the plan is `complete`, set the root to `complete` as well.
4. Set `version: 3`.
5. **L10:** After migration, call `enforceInvariants()` to demote any multi-active state and ensure the root is never active.

This preserves the goal's progress (rounds, scores) without losing data.

### 1.4 Invariants

- Exactly one node has `status: "active"` at any time, and it is always a leaf (a plan with no children, or a task).
- The root is never `active` (L10: enforced in `enforceInvariants()` on both v2 and v3 parse paths).
- A node's children are derived from `parentId` — no separate array.
- `parseState` enforces the invariants via `enforceInvariants()`: if multiple nodes are `active`, keep the first (lowest id) and demote the rest to `pending`. If the root is active, demote it to `pending`.

---

## 2. Roadmap intake

`goal_create` gains an optional `roadmapPath` (string, project-relative).

- **With `roadmapPath`:**
  - The root node stores `roadmapPath` (R2). The file is **not** read at creation time — it is re-read through `$.fs.readFile` at every planning event.
  - The root's `title` and `objective` are the operator's `objective` argument (unchanged).
  - `goal_create` returns "Root created; planning runs at the next controller tick." (R1)
- **Without `roadmapPath`:**
  - The root is created with the objective alone.
  - Planning is still available (the worker or controller can add plans via `goal_add`).

The planning gate does not depend on `roadmapPath` being present — it fires whenever the planning predicate (§3.1) is true. If `roadmapPath` is set, the file is re-read and passed to the model as additional context. If the file is missing or unreadable at planning time, log `roadmap_read_failed` and plan from the root objective alone.

---

## 3. Planning gate (code-gated model call)

### 3.1 When planning is due

Planning is due when **all** of the following hold:

1. The root exists and its status is not `complete` or `abandoned`.
2. The root has **no** `pending`, `active`, or `paused` descendants. (R5)
3. There is no active leaf.

`blocked` descendants count as no work. `complete` and `abandoned` descendants also count as no work.

This includes:
- Fresh root, no children (first planning).
- A plan just completed, no pending or paused siblings (re-planning or next plan).
- All plans complete (final check).
- **Not** a tree the operator paused (paused is work).

### 3.2 The model call

**Choice: `$.model.complete` with Haiku and a strict JSON schema.**

Rationale:
- `$.model.fork` (types 641, 644–645) returns `null` on a cold snapshot or an API error. It uses the session's model, which is more expensive.
- `$.model.complete` with `model: "haiku"` is a clean, isolated call. The prompt contains the roadmap text (or root objective) and the current tree as JSON. The response is a JSON array of plan nodes.
- Cost per planning event: ~1 × Haiku completion (~1000–2000 tokens total). A fork would cost ~5000–10000 tokens at 10–20× per-token rate.

### 3.3 Prompt format (H3-part2, L9)

```
You are the planner for an agentic plugin.
The operator's objective is: "{root.objective}".

{roadmapText ? `Roadmap file content:\n${roadmapText}\n` : ""}
{historyBlock: completed/blocked/abandoned plans with notes}

Create a plan of 0 to 7 steps to accomplish the objective.
Return a JSON array. Each element: {"title": string, "objective": string, "maxRounds": number (5-20)}.
Return [] (empty array) if the objective and roadmap are fully met by the completed items.
Never repeat a completed item. A blocked item may be retried at most once with a different approach.
Return a JSON array only: no prose, no markdown fences.
```

**H3-part2:** The history block lists completed plans (with their last note), blocked plans (with reason), and abandoned plans. This lets the planner avoid repeating completed work and retry blocked items with a different approach. The planner's `planningRounds` counter on the root tracks how many planning events have occurred.

**L9:** Per-plan `maxRounds` from the planner (5-20), defaulting to the root's `maxRounds` (the operator's value).

### 3.4 Response parsing

```ts
const raw = await $.model.complete({ model: "haiku", prompt, maxTokens: 2000 });
// Strip any code-fence or preamble.
const jsonText = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
const plans = JSON.parse(jsonText);
// Validate: must be an array of 0–7 objects with title (string), objective (string), maxRounds (number).
// 0 plans is valid — it means "no more work" and the root is complete.
// Create GoalNode for each, parentId = root.id, kind = "plan", source = "controller", status = "pending".
// If plans.length > 0: activate the first plan (status = "active", activeGoalId = first.id).
// If plans.length === 0: mark root complete, clear activeGoalId.
```

If parsing fails, log a `planning_failed` decision and do **not** activate anything. The gate will retry on the next tick.

### 3.5 Decision log entries

- `goal | plan` — "Planned N plans from roadmap" (or "from root objective"). N may be 0.
- `goal | activate` — "Activated plan '<title>' (id <id>)".

### 3.6 Planning is a controller act (R1)

Planning fires **only** at the controller tick, never inside a tool handler. The tick order is:

1. Owner check (non-owner returns).
2. In-flight check (in-flight returns).
3. **Planning gate** (§3.1–§3.5). If planning is due, fire the model call, activate (or complete), and return. **M8:** A `planningInFlight` guard prevents reentrant planning calls if a slow planner outlasts a tick.
4. **H1:** If no active leaf, call `activateNext(state)`. If a node is activated, persist and return. If nothing is pending, return (planning predicate will fire next tick).
5. Idle gate (as today).
6. Classify + act.

This fixes the bug where a fresh root with no active leaf would cause the first line `if (!g || g.status !== "active") return` to skip planning forever. **H1** further fixes the case where pending work exists but no node is active: the tick now activates it instead of returning silently.

---

## 4. Controller decisions (expanded)

### 4.1 `switch` (R6)

Added to the classify labels: `["nudge", "pause", "complete", "ask-operator", "switch"]`.

**Gate in code:** the `switch` label is offered **only** when at least one pending plan exists. The summary passed to the model includes the pending plan titles so the choice is informed.

When the controller chooses `switch`:
1. A second gated call (`$.model.complete`, Haiku) sees the full tree, the pending plan titles, and the last five decisions. It returns the id of the pending plan to activate.
2. **Validate the id against the pending set.** On a miss, log `switch_failed` and do nothing.
3. On a hit: the current active leaf is demoted to `paused` (resumable). The chosen plan is activated (`status: "active"`, `activeGoalId = chosen.id`).
4. Decision log: `goal | switch` — "Switched from '<old>' to '<new>'".

### 4.2 Complete (R3)

When the controller chooses `complete` on the active leaf, call `completeLeaf(state, activeLeaf.id, "controller complete")` (§4.4).

### 4.3 Round budget (R7)

When the active leaf's `completedRounds` reaches `maxRounds`:
1. Mark the leaf `blocked`, `blockedReason: "Max rounds reached"`.
2. Fire `$.ui.toast` once (best-effort).
3. Call `activateNext(state)`.
4. Decision log: `goal | blocked` — "[<id>] Max rounds reached (N rounds)".
5. The root never blocks.

### 4.4 `completeLeaf` and `activateNext` (R3, H3, M6)

These are **pure helpers** in `agent-state.ts`. All four call sites (worker `goal_done`, scorer `complete` label, controller `complete` decision, round-budget block) call the same two functions. No duplicate logic.

```ts
// agent-state.ts

export function completeLeaf(state: AgentState, id: string, note: string): void {
  const node = state.goals.find(g => g.id === id);
  if (!node) return;
  node.status = "complete";
  node.updatedAt = Date.now();
  if (note) node.notes.push(note);

  // Walk up: if the parent is a plan whose children are all complete/abandoned/blocked,
  // mark the parent complete too. Repeat while the condition holds.
  // H3: a plan with any blocked child becomes "blocked" (not "complete").
  let parent = node.parentId ? state.goals.find(g => g.id === node.parentId) : undefined;
  while (parent && parent.kind === "plan") {
    const children = state.goals.filter(g => g.parentId === parent.id);
    const hasBlocked = children.some(c => c.status === "blocked");
    const allDone = children.every(c => c.status === "complete" || c.status === "abandoned" || c.status === "blocked");
    if (hasBlocked) {
      parent.status = "blocked";
      parent.updatedAt = Date.now();
      break;
    }
    if (allDone) {
      parent.status = "complete";
      parent.updatedAt = Date.now();
      node = parent;
      parent = node.parentId ? state.goals.find(g => g.id === node.parentId) : undefined;
    } else {
      break;
    }
  }

  // H3: completeLeaf NEVER completes the root.
  // Root completion belongs to the planner (0 plans) or the controller's complete actuator.
}

export function activateNext(state: AgentState, completedId?: string): string | null {
  // M6: leaf-only DFS. Only activate nodes with no children.
  // 1. If completedId is given, prefer its pending siblings (same parent).
  // 2. Then DFS from the root to find the first pending leaf.
  // Return the id of the activated node, or null if nothing was activated.
  ...
}
```

**Semantics:**
- Mark the leaf complete.
- Walk up while the parent is a plan whose children are all complete, abandoned, or blocked → mark parent complete. **H3:** if any child is blocked, the parent becomes blocked (not complete).
- **H3:** `completeLeaf` never touches the root. Root completion is the planner's job (0 plans) or the controller's complete actuator.
- Then activate: **M6:** leaf-only DFS — prefer a pending task under the same plan (siblings first), then DFS from the root. Only nodes with no children are activated.
- If nothing to activate, leave `activeGoalId` null (the planning predicate becomes true).
- **Activation resets** `lastNudgeAt = 0` and `consecutiveNudgesWithoutOnGoal = 0`, because the floor and cap guard repeats on one leaf, not the next one. (R3)

---

## 5. Worker tools

### 5.1 `goal_create` (modified)

Existing: `objective` (string), `maxRounds` (number).
Added: `roadmapPath` (string, optional).

Behavior:
- Create the root node. If `roadmapPath` is provided, store it on the root (R2). Do **not** read the file.
- Do **not** fire planning (R1). Return: `"Root created; planning runs at the next controller tick."`
- Decision log: `goal | create` — root.

### 5.2 `goal_add` (new, R4)

```
inputSchema: {
  type: "object",
  properties: {
    title: { type: "string", description: "One-line title for the new node." },
    objective: { type: "string", description: "What done looks like." },
    parentId: { type: "string", description: "Optional. The id of the parent node. If omitted: the parent is the active leaf when it is a plan; otherwise the active task's parent." },
    kind: { type: "string", description: '"task" (default) or "plan". "plan" is only allowed under the root.' },
    maxRounds: { type: "number", description: "Round budget. Default 10." },
  },
  required: ["title", "objective"],
}
```

Behavior:
- Deny for a passive reader.
- **Parent resolution (R4):**
  - If `parentId` is explicit, use it.
  - If omitted: the parent is the active leaf **when it is a plan**; otherwise (active leaf is a task), the parent is the active task's parent.
- **Kind validation:** `kind: "plan"` only under the root. `kind: "task"` under a plan or the root.
- **M6: depth guard:** deny if the resolved parent is a task. The tree is root > plan > task; nothing deeper.
- **Leaf invariant (R4):** when a task is added under the active plan, that plan is no longer a leaf → demote the plan to `pending`, activate the new task. Later tasks under that plan are `pending` (not activated).
- Create the node, `source: "worker"`, `status: "pending"` (or `active` if it is the first task under the active plan, per the above). Include `planningRounds: 0` and `consecutiveBlockedPlannings: 0`.
- Decision log: `goal | add` — "Added <kind> '<title>' under <parentId>".

### 5.3 `goal_done` (new, R3, R8)

```
inputSchema: {
  type: "object",
  properties: {
    note: { type: "string", description: "One-line note about why this is done." },
  },
}
```

Behavior:
- Deny for a passive reader.
- Deny if no active leaf: `"No active goal to complete."`
- Call `completeLeaf(state, activeLeaf.id, note)` (R3).
- Call `activateNext(state)` (R3).
- **Result text (R8):** if a new leaf was activated, the result is `"Completed '<old>'. Active: '<new>'."`. If nothing was activated, the result is `"Completed '<old>'. No pending goals; planning runs at the next tick."`
- Decision log: `goal | done` — "Completed '<title>' (id <id>)".

### 5.4 `goal_status` (new)

```
inputSchema: { type: "object", properties: {} }
```

Behavior:
- Read-only. Works for a passive reader (no write, no ownership check).
- Return the tree as formatted text:
  ```
  [root] <title> (status: <status>)
    [plan] <title> (status: <status>) — N rounds done
      [task] <title> (status: <status>) — note
  ```
- Decision log: none (read-only).

### 5.5 `goal_resume` (new, M5)

```
inputSchema: {
  type: "object",
  properties: {
    nodeId: { type: "string", description: "Optional. The id of the paused node to resume. Defaults to the most recently paused node." },
  },
}
```

Behavior:
- Owner only.
- Resume the specified paused node (or the most recently paused one if omitted).
- Reset `consecutiveNudgesWithoutOnGoal = 0` and `lastNudgeAt = 0`.
- Decision log: `goal | resume` — "Node <id> resumed (paused: <reason>)".

### 5.6 No `goal_switch` for the worker

The controller owns switching. The worker can add tasks, mark them done, and resume paused nodes; it cannot activate a different plan.

---

## 6. Injection format

On `prompt.submit`, inject (for the active leaf):

```
[GOAL TREE]
Active: <leaf.title> — <leaf.objective>
Path: <root.title> > <parent.title (if any)> > <leaf.title>
Pending siblings: N
Last note: <leaf.notes[leaf.notes.length - 1] or "—">
Follow the user if they conflict with this goal.
```

Not the whole tree. The worker sees the active leaf, its parent chain (titles only), the count of pending siblings, and the last note.

**Constraint source (R10):** the Bash-deny constraint reads the **root objective**, not the active leaf.

---

## 7. Nudge text (R8)

Append to the nudge text:

> "When this step is done, call goal_done with a one-line note. If the result names a next goal, continue with it."

Combined with `goal_done`'s result naming the newly active leaf (or "No pending goals; planning runs at the next tick"), this makes the worker self-direct through a plan list with one nudge.

---

## 8. Decision log

Every goal-loop entry carries the node id:

```
detail: `[<nodeId>] <action text>`
```

e.g., `[plan-abc123] Activated plan 'Write rivers haiku'`.

Log actions: `create`, `plan`, `activate`, `done`, `add`, `switch`, `switch_failed`, `blocked`, `complete`, `planning_failed`, `roadmap_read_failed`.

---

## 9. Scoring, idle gate, nudge, floor, cap

Unchanged in mechanism. They apply to the **active leaf**:
- **H2:** `turn.start` records `turnLeafId = state.activeGoalId`. At `turn.complete`, scoring checks the status of the **turn-start leaf** (not whichever node is active at turn-end):
  - If `turnLeaf.status === "complete"` (goal_done ran during the turn): log `goal | score | <id> Round n: on-goal (goal_done)`, reset `consecutiveNudgesWithoutOnGoal`. No classify call.
  - If `turnLeaf.status === "active"`: classify as before against `turnLeaf.objective`.
  - Otherwise (paused, switched, blocked): log `score_skipped` with the status. No classify call.
- The idle gate, nudge floor, and cap all reference the active leaf's `completedRounds` and `scores`.
- `consecutiveNudgesWithoutOnGoal` resets on `on-goal` or goal complete (of the active leaf).
- Activation (via `activateNext`) resets `lastNudgeAt` and `consecutiveNudgesWithoutOnGoal` (R3).

---

## 10. Acceptance tests (R9, H1+H3)

### 10.1 `.kit/live-goaltree-test.sh` (R9 shape):

**Shape:** one user message, then silence, then "done". The nudge and the chain are exercised by the controller, not by hand-fed user messages.

1. Delete residue dotfiles.
2. Feed a stream-json session:
   - **User message (turn 1):** `Call goal_create with objective "Write haikus per the roadmap" and roadmapPath ".kit/roadmap-test.md". Then reply with the single word: ok`
   - **Silence for 6 minutes** (360 seconds). During this time:
     - First controller tick (~30s): planning gate fires. `goal | plan` with 3, `goal | activate` plan 1.
     - ~120s: idle gate → nudge. `nudge_sent`. Nudge text drives the worker.
     - Worker calls `goal_done` (driven by nudge + tool result). `goal | done` plan 1, `goal | activate` plan 2.
     - Next idle gate → nudge. Worker calls `goal_done`. `goal | done` plan 2, `goal | activate` plan 3.
     - Next idle gate → nudge. Worker calls `goal_done`. `goal | done` plan 3. No pending goals.
     - Next tick: planning gate fires (no pending/active/paused descendants). `goal | plan` with 0, `goal | complete` root. Status cleared.
   - **User message (turn 2):** `Reply with the single word: done`
     - This turn scores nothing (no active leaf).
3. Expected store lines (in order):
   - `goal | create` (root)
   - `goal | plan` (3)
   - `goal | activate` (plan 1)
   - `monitor | controller_tick` (nudge, plan 1)
   - `monitor | nudge_sent`
   - `goal | score` (plan 1, on-goal)
   - `goal | done` (plan 1)
   - `goal | activate` (plan 2)
   - `monitor | controller_tick` (nudge, plan 2)
   - `monitor | nudge_sent`
   - `goal | score` (plan 2, on-goal)
   - `goal | done` (plan 2)
   - `goal | activate` (plan 3)
   - `monitor | controller_tick` (nudge, plan 3)
   - `monitor | nudge_sent`
   - `goal | score` (plan 3, on-goal)
   - `goal | done` (plan 3)
   - `goal | plan` (0)
   - `goal | complete` (root)
4. Regression: `live-controller-test.sh` and `live-yield-test.sh` still pass unchanged.
5. Quote all four outputs in the completion entry.

### 10.2 `.kit/live-goaltree-stall-test.sh` (new, pins H1 + H3):

**Shape:** one user message (goal_create + goal_add in the same turn), then 240 seconds of silence, then "done". This pins H1 (the tick must activate pending work even when the planner has not fired) and H3 (the root is not completed by `completeLeaf`; only the planner's 0-plans result completes it).

1. Delete residue dotfiles.
2. Feed a stream-json session:
   - **User message (turn 1):** `Call goal_create with objective "Write one haiku about the moon" and maxRounds 5. Then call goal_add with kind "plan", title "Write a haiku about the moon", objective "One 5-7-5 haiku about the moon". Then reply with the single word: ok`
   - **Silence for 240 seconds** (4 minutes). During this time:
     - First controller tick (~30s): no active leaf, pending plan exists → H1 fires `activateNext`. Log `goal | activated` for the added plan. No planning (the plan is pending, not due).
     - ~120s: idle gate → nudge. `nudge_sent`.
     - Worker calls `goal_done`. `goal | done` plan, H3: root NOT completed by completeLeaf.
     - Next tick: planning gate fires (no pending/active/paused descendants). `goal | plan` with 0 (the objective is met). `goal | planning_complete`, root complete.
   - **User message (turn 2):** `Reply with the single word: done`
3. Expected store lines (in order):
   - `goal | create` (root)
   - `goal | add` (plan)
   - `goal | activated` (the added plan, H1)
   - `monitor | nudge_sent`
   - `goal | score` (plan, on-goal)
   - `goal | done` (plan)
   - `goal | planning_fired`
   - `goal | planning_complete` (0 plans, root complete)
4. **H3 assertion:** between `goal | done` and `goal | planning_complete`, the root must NOT have been marked complete. The only `planning_complete` entry must show 0 plans.

Fixture: none (single haiku objective).

---

### 10.3 Fixture for 10.1:

`.kit/roadmap-test.md` with three numbered items:
```
1. Write a haiku about rivers
2. Write a haiku about mountains
3. Write a haiku about deserts
```

---

## 11. Questions and answers

### Q1: Migration — wrap-as-root-plus-one-plan or discard v2 goals?

**Answer: Wrap (as proposed).** The v2 goal has `completedRounds`, `scores`, and a status that represent real progress. Discarding it would lose that history. Wrapping it as a root with one plan child preserves the data and keeps the migration simple. The plan inherits the goal's `maxRounds`, `completedRounds`, and `scores`.

### Q2: Planning call — fork or complete-with-JSON?

**Answer: `$.model.complete` with Haiku and a strict JSON schema.**

Cost per planning event:
- **`$.model.complete` (Haiku):** ~1000–2000 tokens total. Negligible cost.
- **`$.model.fork` (session model):** ~5000–10000 tokens at 10–20× per-token rate. 10–50× more expensive. Also returns `null` on cold snapshot or API error (types 641, 644–645).

Planning is a structured extraction (roadmap → plans), not a contextual judgment. Haiku is sufficient and dramatically cheaper.

**Fork's role:** none in this stage. The switch decision also uses `$.model.complete` with Haiku, passing the tree and last five decisions explicitly in the prompt. Fork's advantages (shared prompt cache, transcript context) are not needed.

### Q3: When the worker calls `goal_done` on the last pending plan — root complete immediately or one more planning call?

**Answer: One more planning call (as proposed).** The roadmap may have items that were not decomposed into plans, or the worker may have finished faster than expected. A final planning call checks for missed items. If the planning call returns zero plans, the root is marked complete. This is cheap (one Haiku call) and prevents premature completion.

### Q4: Should `goal_add` be allowed for a passive reader?

**Answer: Deny (as proposed).** A passive reader has no ownership of the persona. Allowing it to add nodes to the goal tree would be a write to a shared resource, which violates the L2 invariant (the store has exactly one writer path per session). A passive reader can call `goal_status` (read-only) but not `goal_add`, `goal_done`, or `goal_create`.

### Q5: Anything in the shape above to cut for this stage?

**Cut:** None. The shape is minimal: one tree, four worker tools, two controller additions (planning gate + switch), one injection format. The `split` operation (worker-initiated tree restructuring) is explicitly deferred. The `notes` array is simple (append-only, no editing). The `blocked` status is carried over from v2 but is not actively used in this stage (the controller does not block individual plans; it pauses them).

---

## 12. File changes (Revision 3)

| File | Change |
|------|--------|
| `hooks/agent-state.ts` | Add `GoalNode` interface (with `planningRounds`, `consecutiveBlockedPlannings`), update `AgentState` to v3, migration in `parseState` (L10: active→pending for root, `enforceInvariants()` on both v2/v3), update `createDefaultState`, add `completeLeaf` (H3: never completes root; blocked cascading) and `activateNext` (M6: leaf-only DFS) pure helpers |
| `hooks/index.ts` | Replace `state.goal` with `state.goals` / `state.activeGoalId` throughout. Add `goal_add`, `goal_done`, `goal_status`, `goal_resume` tool registrations. Modify `goal_create` for `roadmapPath` (no planning in handler), L9: store maxRounds on root. Add planning gate to controller tick (before idle gate), M8: `planningInFlight` guard, H3-part2: history block in planner prompt. H1: activate pending work at step 4. H2: `turnLeafId` recorded at turn.start, 3-way status check at turn.complete. L11: `$.ui.log` for plan completions (only root speaks). L12: curation classify prompt tightened. M5: injection block rewritten to `[GOAL TREE]` shape. L13: version header v0.6.1, em dashes replaced. |
| `.claude-plugin/plugin.json` | Version → 0.6.1 |
| `.kit/live-goaltree-test.sh` | R9 shape acceptance test |
| `.kit/live-goaltree-stall-test.sh` | New: pins H1 + H3 (goal_create + goal_add same turn, 240s silence) |
| `.kit/roadmap-test.md` | New fixture |

---

## 13. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Planning JSON parse failure | Log `planning_failed`, do not activate anything, retry on next tick. |
| Active leaf not found (orphaned) | `parseState` invariant check: demote to `pending`. Controller tick skips if no active leaf. |
| Roadmap file not found at planning time | Log `roadmap_read_failed`, plan from root objective alone. |
| Worker calls `goal_done` when no active leaf | Deny with "No active goal to complete." |
| Multiple active nodes (bug) | `parseState` keeps only the first, demotes the rest. Logged as a warning. |
| Switch id not in pending set | Validate; on miss, log `switch_failed`, do nothing. |
| Paused tree replanned | Planning predicate (R5) includes paused descendants as work — planning is not due. |

---

## 14. Revision 4 (v0.6.2)

### H3 fix — root never completed by cascade

`completeLeaf` (agent-state.ts) now breaks at the root:

```ts
if (parent.kind === "root") break;
```

The `All goals complete. Objective met.` branch in the `goal_done` handler is deleted.
Root completion belongs to the planner (0 plans) or the controller's complete actuator.

### H4 — planner parse failure does not complete the root

- `parsedOk` flag: set only when `JSON.parse` returns an array.
- If `!parsedOk`: log `planning_failed`, return. Root stays `pending`.
- `maxTokens` raised from 800 to 1500.
- `AGENTIC_PLANNER_FAULT=1` env var (read from `process.env` in the planner) replaces
  the raw response with `"not json"` for testing.

### H3-cap — planning cap

After each planning round:
- `root.planningRounds` incremented.
- `root.consecutiveBlockedPlannings` incremented if all new plans are `blocked`, else reset.
- If `planningRounds >= 5` or `consecutiveBlockedPlannings >= 2`:
  - Root → `blocked`, `blockedReason = "Planning cap reached"`.
  - Log `goal | block | root`.
  - Toast once.
  - Return (no further planning).

### M4 — nudge cap → blocked (not paused)

When `consecutiveNudgesWithoutOnGoal >= MAX_CONSECUTIVE_NUDGES`:
- Active leaf → `blocked` (not `paused`), `blockedReason = capReason`.
- Log `goal | block`.
- Toast once.
- `activateNext` to the next pending leaf.
- Reset `consecutiveNudgesWithoutOnGoal = 0`, `lastNudgeAt = 0`.

### M9 — goal_resume with a different active leaf

If `goal_resume` targets a paused node while a different node is `active`:
- The active node is demoted to `paused` with `blockedReason = "Paused by goal_resume of <target>"`.
- The target is resumed.

### M10 — blockedReason at every pause site

Every site that sets `status = "paused"` now also writes `blockedReason`:
- Controller `ask-operator` → `blockedReason = finalReason`.
- Controller `pause` → `blockedReason = finalReason || "controller pause"`.
- Switch demotion → `blockedReason = "Switched to another plan"`.
- `goal_resume` demotion → `blockedReason = "Paused by goal_resume of <target>"`.
- `goal_resume` resume → `blockedReason = undefined` (cleared).

### L14 — goal_done score increments completedRounds

The `goal_done` branch in turn.complete scoring now:
- Pushes `{ round, result: "on-goal" }` to `turnLeaf.scores`.
- Increments `turnLeaf.completedRounds`.
- Logs the round number from `scores.length`.

### L15 — curation prompt already has L12

The curation classify prompt already says "A description of what happened this turn is discard."
No change needed.

### L16 — yield test guards heartbeat file

`live-yield-test.sh` now removes `.agentic-heartbeat.json` and `.agentic-yields.log`
before the sample loop starts.

### L17 — $.ui.log per injected block

Each injected context block (goal tree, paused reminder, memory) is logged
via `$.ui.log` before being pushed to `contextBlocks`.

### P3 — assert-decisions.js

New script `.kit/assert-decisions.js` validates the decision log for each test:
- `goaltree`: create → planning_fired → planning_created 3 → activated → nudge → done×3 → score goal_done → root complete.
- `stall`: create → add → activated (no planning) → nudge → done → score goal_done → planning_fired → planning_complete 0 → root complete.
- `controller`: create → planning_fired → planning_created → activated → nudge → done → activated → score (turn-start leaf).
- `yield`: persona_create → turn_start → memory → identity_set.
- `planfail`: planning_failed → root pending.

All test scripts write `.decisions.log` and run assertions before exiting.

### P4 — git init

New `.gitignore`:
- `.agentic-*.json`
- `.agentic-*.log`
- `.kit/*.out.jsonl`
- `.kit/*.err.log`
- `.kit/*.exit`
- `.kit/*.decisions.log`
- `.kit/yield-hb.samples`
- `node_modules/`

First commit: `v0.6.1 (pre-0.6.2)`. Tag: `v0.6.1`.

### New test: live-planfail-test.sh

- `AGENTIC_PLANNER_FAULT=1` env var.
- goal_create + "ok", sleep 120, "done".
- Expected: `planning_failed` at first tick, root `pending`, `planning_fired` again at next tick.
