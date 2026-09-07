// AgentState: the on-disk persistence layer shared by all five loops.
// Access via $.fs.* (readFile, writeFile, exists).
// One JSON file per project, one owner at a time (the Monitor loop).

export interface MemoryEntry {
  id: string;
  kind: "fact" | "preference" | "lesson" | "goal" | "eval";
  text: string;
  confidence: number; // 0..1
  source: "worker" | "user" | "distilled";
  createdAt: number; // ms
  lastAccessed: number;
  accessCount: number;
  pinned: boolean; // pinned entries survive decay
}

// v2 goal shape (retained for migration only).
export interface GoalState {
  id: string;
  objective: string;
  maxRounds: number;
  completedRounds: number;
  status: "active" | "paused" | "complete" | "blocked";
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
  scores: Array<{
    round: number;
    result: string;
  }>;
}

// v3 goal-tree node.
export interface GoalNode {
  id: string;
  parentId: string | null; // null for the root
  kind: "root" | "plan" | "task";
  title: string;
  objective: string;
  status: "pending" | "active" | "paused" | "complete" | "abandoned" | "blocked";
  source: "operator" | "controller" | "worker";
  maxRounds: number; // 0 for the root
  completedRounds: number;
  scores: Array<{ round: number; result: string }>;
  notes: string[];
  roadmapPath?: string; // root only: the roadmap file path
  planningRounds: number; // root only: number of planning events
  consecutiveBlockedPlannings: number; // root only: consecutive all-blocked plannings
  createdAt: number;
  updatedAt: number;
  blockedReason?: string;
}

export interface MonitorState {
  sessionStart: number;
  turnCount: number;
  lastTurnId?: string;
  lastTurnComplete?: number;
  totalToolCalls: number;
  errors: number;
}

export interface AgentState {
  version: 3;
  persona: string;
  activeSessionId: string;
  epoch: number;
  memory: MemoryEntry[];
  goals: GoalNode[];
  activeGoalId: string | null;
  monitor: MonitorState;
  decisions: Array<{
    timestamp: number;
    loop: "memory" | "goal" | "monitor" | "worker";
    action: string;
    detail: string;
  }>;
  createdAt: number;
  updatedAt: number;
}

// Decision log cap: keep the most recent N entries.
const DECISIONS_MAX = 200;

// Default state (per persona)
export function createDefaultState(persona: string, sessionId: string): AgentState {
  const now = Date.now();
  return {
    version: 3,
    persona,
    activeSessionId: sessionId,
    epoch: 1,
    memory: [],
    goals: [],
    activeGoalId: null,
    monitor: {
      sessionStart: now,
      turnCount: 0,
      totalToolCalls: 0,
      errors: 0,
    },
    decisions: [],
    createdAt: now,
    updatedAt: now,
  };
}

// Serialize/deserialize
export function serializeState(state: AgentState): string {
  return JSON.stringify(state, null, 2);
}

export function parseState(json: string): AgentState {
  const parsed = JSON.parse(json);

  // v2 → v3 migration.
  if (parsed.version === 2) {
    const old = parsed as unknown as {
      persona: string;
      activeSessionId: string;
      epoch: number;
      memory: MemoryEntry[];
      goal: GoalState | null;
      monitor: MonitorState;
      decisions: AgentState["decisions"];
      createdAt: number;
      updatedAt: number;
    };

    const now = Date.now();
    const goals: GoalNode[] = [];
    let activeGoalId: string | null = null;

    if (old.goal) {
      const g = old.goal;
      const rootId = `goal-${g.id.replace(/^goal-?/, "")}`;
      const planId = `plan-${g.id.replace(/^goal-?/, "")}`;

      // L10: v2 active goal maps to a pending root (not an active root).
      // The root is never active in v3; activation is at the leaf level.
      const statusMap: Record<string, GoalNode["status"]> = {
        active: "pending", // L10: root was never active in v3
        paused: "paused",
        complete: "complete",
        blocked: "blocked",
      };
      const rootStatus = statusMap[g.status] ?? "pending";
      const planStatus: GoalNode["status"] =
        g.status === "active" ? "active" : statusMap[g.status] ?? "pending";

      const root: GoalNode = {
        id: rootId,
        parentId: null,
        kind: "root",
        title: g.objective.slice(0, 80),
        objective: g.objective,
        status: rootStatus,
        source: "operator",
        maxRounds: 0,
        completedRounds: 0,
        scores: [],
        notes: [],
        planningRounds: 0,
        consecutiveBlockedPlannings: 0,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        blockedReason: g.blockedReason,
      };

      const plan: GoalNode = {
        id: planId,
        parentId: rootId,
        kind: "plan",
        title: g.objective.slice(0, 80),
        objective: g.objective,
        status: planStatus,
        source: "operator",
        maxRounds: g.maxRounds,
        completedRounds: g.completedRounds,
        scores: g.scores,
        notes: [],
        planningRounds: 0,
        consecutiveBlockedPlannings: 0,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        blockedReason: g.blockedReason,
      };

      goals.push(root, plan);
      if (planStatus === "active") {
        activeGoalId = planId;
      }
    }

    const state: AgentState = {
      version: 3,
      persona: old.persona,
      activeSessionId: old.activeSessionId,
      epoch: old.epoch,
      memory: old.memory ?? [],
      goals,
      activeGoalId,
      monitor: old.monitor ?? {
        sessionStart: now,
        turnCount: 0,
        totalToolCalls: 0,
        errors: 0,
      },
      decisions: old.decisions ?? [],
      createdAt: old.createdAt ?? now,
      updatedAt: now,
    };

    // L10: invariant block runs on both v2 and v3 branches.
    enforceInvariants(state);
    return state;
  }

  if (parsed.version !== 3) {
    throw new Error(`Unsupported AgentState version: ${parsed.version}`);
  }

  const state = parsed as AgentState;

  // L10: invariant block runs on both v2 and v3 branches.
  enforceInvariants(state);
  return state;
}

// L10: extract invariant enforcement so both v2 and v3 branches run it.
function enforceInvariants(state: AgentState): void {
  // Enforce invariants: exactly one active node, and it must be a leaf.
  const actives = state.goals.filter((g) => g.status === "active");
  if (actives.length > 1) {
    // Keep the first (array order), demote the rest.
    actives.slice(1).forEach((g) => {
      g.status = "pending";
    });
  }
  // If the active node is not a leaf, demote it.
  const active = state.goals.find((g) => g.status === "active");
  if (active) {
    const hasChildren = state.goals.some((g) => g.parentId === active.id);
    if (hasChildren) {
      active.status = "pending";
      state.activeGoalId = null;
    } else {
      state.activeGoalId = active.id;
    }
  } else {
    state.activeGoalId = null;
  }

  // Cap the decision log on read.
  if (state.decisions.length > DECISIONS_MAX) {
    state.decisions = state.decisions.slice(-DECISIONS_MAX);
  }
}

// --- Pure helpers for goal-tree operations (R3) ---
// These are called from four sites: worker goal_done, scorer complete,
// controller complete, and the round-budget block. No duplicate logic.

// Mark a leaf complete, walk up completing plan-parents whose children are all
// complete. A plan with any blocked child becomes blocked (H3).
// The root is never touched (H3: root completion belongs to the planner).
export function completeLeaf(state: AgentState, id: string, note: string): void {
  const node = state.goals.find((g) => g.id === id);
  if (!node) return;

  node.status = "complete";
  node.updatedAt = Date.now();
  if (note) node.notes.push(note);

  // Walk up: plan-parents only. A plan completes when all children are
  // complete or abandoned. A plan with any blocked child becomes blocked.
  let current = node;
  while (current.parentId) {
    const parent = state.goals.find((g) => g.id === current.parentId);
    if (!parent) break;
    // H3: Root completion belongs to the planner, not the cascade.
    if (parent.kind === "root") break;
    const children = state.goals.filter((g) => g.parentId === parent.id);
    const hasBlocked = children.some((c) => c.status === "blocked");
    const allDone = children.every(
      (c) =>
        c.status === "complete" ||
        c.status === "abandoned" ||
        c.status === "blocked"
    );
    if (hasBlocked && parent.status !== "complete") {
      parent.status = "blocked";
      parent.blockedReason = "Child task blocked";
      parent.updatedAt = Date.now();
    } else if (allDone && parent.status !== "complete") {
      parent.status = "complete";
      parent.updatedAt = Date.now();
    } else {
      break;
    }
    current = parent;
  }

  // H3: Root completion belongs to the planner, not the cascade.
  // completeLeaf never touches the root.
}

// M6: Activate the next pending leaf (a node with no children).
// Depth-first walk in createdAt order. Prefers the completed node's siblings.
// Only activates nodes that have no children (leaf invariant).
export function activateNext(state: AgentState, completedId?: string): string | null {
  const hasChildren = (id: string): boolean =>
    state.goals.some((g) => g.parentId === id);

  const activate = (g: GoalNode): string => {
    g.status = "active";
    g.updatedAt = Date.now();
    state.activeGoalId = g.id;
    return g.id;
  };

  // 1. Pending leaf siblings of the just-completed node (same parent).
  if (completedId) {
    const completed = state.goals.find((g) => g.id === completedId);
    if (completed && completed.parentId) {
      const siblings = state.goals
        .filter(
          (g) =>
            g.parentId === completed.parentId &&
            g.status === "pending" &&
            !hasChildren(g.id)
        )
        .sort((a, b) => a.createdAt - b.createdAt);
      if (siblings.length > 0) {
        return activate(siblings[0]);
      }
    }
  }

  // 2. DFS from the root: first pending leaf in createdAt order.
  const root = state.goals.find((g) => g.parentId === null);
  if (root) {
    const dfs = (parentId: string): GoalNode | null => {
      const candidates = state.goals
        .filter((g) => g.parentId === parentId && g.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const c of candidates) {
        if (!hasChildren(c.id)) return c;
        // Has children: descend.
        const child = dfs(c.id);
        if (child) return child;
      }
      return null;
    };
    const leaf = dfs(root.id);
    if (leaf) return activate(leaf);
  }

  // Nothing to activate.
  state.activeGoalId = null;
  return null;
}

// Check whether planning is due (R5).
// Due when: root exists, not complete/abandoned, and has no
// pending/active/paused descendants. Blocked counts as no work.
export function isPlanningDue(state: AgentState): boolean {
  const root = state.goals.find((g) => g.parentId === null);
  if (!root) return false;
  if (root.status === "complete" || root.status === "abandoned") return false;
  const descendants = state.goals.filter((g) => g.parentId !== null);
  const hasWork = descendants.some(
    (g) => g.status === "pending" || g.status === "active" || g.status === "paused"
  );
  return !hasWork;
}

// --- Pure helpers for the guarded-write (yield) path. ---

export function shouldYield(
  onDisk: { activeSessionId: string; epoch: number },
  mySessionId: string,
  myEpoch: number,
): boolean {
  return (
    onDisk.activeSessionId !== mySessionId ||
    onDisk.epoch !== myEpoch
  );
}

export function yieldRecord(
  persona: string,
  mySessionId: string,
  onDiskSessionId: string,
  myEpoch: number,
  onDiskEpoch: number,
): { decision: { timestamp: number; loop: "memory" | "goal" | "monitor" | "worker"; action: string; detail: string }; logLine: string } {
  const ts = Date.now();
  const decision: { timestamp: number; loop: "memory" | "goal" | "monitor" | "worker"; action: string; detail: string } = {
    timestamp: ts,
    loop: "monitor",
    action: "persona_yield",
    detail: `Session ${mySessionId} (epoch ${myEpoch}) yielded to ${onDiskSessionId} (epoch ${onDiskEpoch}) on persona '${persona}'`,
  };
  // JSONL: one JSON object per line, terminated with a newline.
  const logLine = JSON.stringify({
    ts: new Date(ts).toISOString(),
    persona,
    yielded: mySessionId,
    yieldedEpoch: myEpoch,
    winner: onDiskSessionId,
    winnerEpoch: onDiskEpoch,
  }) + "\n";
  return { decision, logLine };
}
