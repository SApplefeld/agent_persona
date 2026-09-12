// AgentState: the on-disk persistence layer shared by all five loops.
// Access via $.fs.* (read, write, exists).
// One JSON file per project, one owner at a time (the Monitor loop).

export interface MemoryEntry {
  id: string;
  kind: "fact" | "preference" | "lesson" | "goal" | "eval";
  text: string;
  confidence: number; // 0..1
  source: "worker" | "user" | "distilled" | "self-review";
  createdAt: number; // ms
  lastAccessed: number;
  accessCount: number;
  pinned: boolean; // pinned entries survive decay
  provenance?: {
    decisionTimestamps: number[];
    windowRange?: [number, number];
    streak: number;
    trigger: string;
  };
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
  consecutivePlanningFailures: number; // root only (M13): consecutive planner call/parse failures
  planningRound: number; // plan only (M15): which planning round created this node
  createdAt: number;
  updatedAt: number;
  blockedReason?: string;
  sortKey?: number; // plan item 3: activation order key; defaults to createdAt when absent,
                     // so goal_edit's reprioritize can move a pending plan without lying
                     // about when it was actually created.
  lastAskQuestion?: string; // plan item 5 (D5b): the question text of the most
                             // recently closed ask on this node, so the classifier
                             // does not reopen the identical question right away.
  lastAskClosedAt?: number; // when that ask closed (answered, by-reply, or timed out).
}

export interface EnvErrors {
  consecutiveErrorTurns: number;
  toolErrorsLastTurn: number;
  lastErrorAt?: number;
  handledAt?: number;
}

export interface EnvGit {
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  lastCommitAt: number;
  sampledAt: number;
}

export interface EnvHealth {
  command: string[];
  exitCode: number;
  tail: string;
  ranAt: number;
  forNodeId: string | null;
}

export interface EnvState {
  git: EnvGit | null;
  health: EnvHealth | null;
  errors: EnvErrors;
}

// G4: envNotable per plan section 4: dirty > 0 AND last commit older than 30 min;
// health exit non-zero; error streak at least 3 (I2: aligned with controller escalation threshold).
export function envNotable(env: EnvState, now: number): string[] {
  const facts: string[] = [];
  if (env.git && env.git.dirty > 0 && now - env.git.lastCommitAt > 30 * 60_000) {
    facts.push(`git: ${env.git.branch} dirty ${env.git.dirty} ahead ${env.git.ahead} behind ${env.git.behind}`);
  }
  if (env.health && env.health.exitCode !== 0) {
    facts.push(`health: exit ${env.health.exitCode} for ${env.health.forNodeId || "no-node"}`);
  }
  if (env.errors.consecutiveErrorTurns >= 3) {
    facts.push(`errors: streak ${env.errors.consecutiveErrorTurns}`);
  }
  return facts;
}

export interface MonitorState {
  sessionStart: number;
  turnCount: number;
  lastTurnId?: string;
  lastTurnComplete?: number;
  totalToolCalls: number;
  errors: number;
  env: EnvState;
  selfReview: {
    count: number;          // reviews in the current hourly window
    lastAt: number;         // 0 = never
    turnsSince: number;     // turns since last review (0 = fresh / just reviewed)
    windowStart: number;    // ms; reset count when now - windowStart >= 3600000
    pendingPeriodic: boolean; // set by goal_done, consumed by tick (S9)
    lastInjectAt: number;   // 0 = never; gates lesson_inject (S11)
  };
  cost: {
    classify: { count: number; estTokens: number };
    reason: { count: number; estTokens: number };
    selfReview: { count: number; estTokens: number };
    planner: { count: number; estTokens: number };
    nudge: { count: number };
    forkUsage: null | { inputTokens: number; outputTokens: number };
    consecutiveSkips: number;
    nudgeWindow: { start: number; count: number };
    callWindow: { start: number; count: number };
    lastSummaryHash: number; // FNV-1a hash of the stable summary subset for D2
    capNoticeWindowStart: number; // AK2: latches cost_cap_reached to one emission per window
  };
}

export interface NudgeBudget {
  lastNudgeAt: number;
  consecutiveNudgesWithoutOnGoal: number;
}

export interface AgentState {
  version: 4;
  persona: string;
  activeSessionId: string;
  epoch: number;
  memory: MemoryEntry[];
  goals: GoalNode[];
  activeGoalId: string | null;
  monitor: MonitorState;
  nudge: NudgeBudget;
  pendingAskId?: string; // D5: ask-operator wait
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
export const DECISIONS_MAX = 200;

// Item 5 (Bounded store): memory cap, enforced at push time in persist().
// Pinned entries are never evicted regardless of this cap.
export const MEMORY_MAX = 50;

// Default state (per persona)
export function createDefaultState(persona: string, sessionId: string): AgentState {
  const now = Date.now();
  return {
    version: 4,
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
      env: {
        git: null,
        health: null,
        errors: { consecutiveErrorTurns: 0, toolErrorsLastTurn: 0 },
      },
      selfReview: { count: 0, lastAt: 0, turnsSince: 0, windowStart: 0, pendingPeriodic: false, lastInjectAt: 0 },
      cost: {
        classify: { count: 0, estTokens: 0 },
        reason: { count: 0, estTokens: 0 },
        selfReview: { count: 0, estTokens: 0 },
        planner: { count: 0, estTokens: 0 },
        nudge: { count: 0 },
        forkUsage: null,
        consecutiveSkips: 0,
        nudgeWindow: { start: 0, count: 0 },
        callWindow: { start: 0, count: 0 },
        lastSummaryHash: 0,
        capNoticeWindowStart: 0,
      },
    },
    nudge: { lastNudgeAt: 0, consecutiveNudgesWithoutOnGoal: 0 },
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
        consecutivePlanningFailures: 0,
        planningRound: 0,
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
        consecutivePlanningFailures: 0,
        planningRound: 0,
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
      version: 4,
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
      nudge: { lastNudgeAt: 0, consecutiveNudgesWithoutOnGoal: 0 },
      decisions: old.decisions ?? [],
      createdAt: old.createdAt ?? now,
      updatedAt: now,
    };

    // L10: invariant block runs on both v2 and v3 branches.
    enforceInvariants(state);
    return state;
  }

  if (parsed.version === 3) {
    // v3 to v4 migration: add env to monitor.
    const state = parsed as unknown as AgentState;
    if (!state.monitor.env) {
      state.monitor.env = {
        git: null,
        health: null,
        errors: { consecutiveErrorTurns: 0, toolErrorsLastTurn: 0 },
      };
    }
    state.version = 4;
    if (!state.nudge) {
      state.nudge = { lastNudgeAt: 0, consecutiveNudgesWithoutOnGoal: 0 };
    }
    enforceInvariants(state);
    return state;
  }

  if (parsed.version !== 4) {
    throw new Error(`Unsupported AgentState version: ${parsed.version}`);
  }

  const state = parsed as AgentState;

  // Migrate: add nudge budget if missing (v3.0 stores predate this field).
  if (!state.nudge) {
    state.nudge = { lastNudgeAt: 0, consecutiveNudgesWithoutOnGoal: 0 };
  }

  // E11: fill env with defaults whenever it is absent, whatever the version.
  if (!state.monitor.env) {
    state.monitor.env = {
      git: null,
      health: null,
      errors: { consecutiveErrorTurns: 0, toolErrorsLastTurn: 0 },
    };
  }

  // S12: fill selfReview with defaults at the E11 site, no version bump.
  if (!state.monitor.selfReview) {
    state.monitor.selfReview = {
      count: 0, lastAt: 0, turnsSince: 0, windowStart: 0,
      pendingPeriodic: false, lastInjectAt: 0,
    };
  }

  // Cost ledger: fill with defaults at the E11 site, no version bump.
  if (!state.monitor.cost) {
    state.monitor.cost = {
      classify: { count: 0, estTokens: 0 },
      reason: { count: 0, estTokens: 0 },
      selfReview: { count: 0, estTokens: 0 },
      planner: { count: 0, estTokens: 0 },
      nudge: { count: 0 },
      forkUsage: null,
      consecutiveSkips: 0,
      nudgeWindow: { start: 0, count: 0 },
      callWindow: { start: 0, count: 0 },
      lastSummaryHash: 0,
      capNoticeWindowStart: 0,
    };
  }
  // D2: ensure lastSummaryHash exists (for states created before this field).
  if (typeof state.monitor.cost.lastSummaryHash !== "number") {
    state.monitor.cost.lastSummaryHash = 0;
  }
  // AK2: ensure capNoticeWindowStart exists (for states created before this field).
  if (typeof state.monitor.cost.capNoticeWindowStart !== "number") {
    state.monitor.cost.capNoticeWindowStart = 0;
  }

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
  // Plan item 3 (reprioritize): sortKey overrides createdAt for activation
  // order when set; absent sortKey falls back to createdAt, so an untouched
  // node's order is unaffected.
  const orderKey = (g: GoalNode): number => g.sortKey ?? g.createdAt;

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
        .sort((a, b) => orderKey(a) - orderKey(b));
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
        .sort((a, b) => orderKey(a) - orderKey(b));
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
  if (root.status === "complete" || root.status === "abandoned" || root.status === "blocked") return false;
  const descendants = state.goals.filter((g) => g.parentId !== null);
  const hasWork = descendants.some(
    (g) => g.status === "pending" || g.status === "active" || g.status === "paused"
  );
  return !hasWork;
}

// M15: the blocked-planning cap must be evaluated over the PREVIOUS planning
// round only, not over every node the root has ever produced. A completed plan
// in an earlier round must not clear a two-consecutive-all-blocked streak, nor
// let an old blocked node linger against a fresh round's plans. The round a
// plan was created in is captured on the plan node (planningRound) at creation
// time. The previous round, at the moment a NEW round is about to start, is
// the one just completed: planningRounds - 1.
//
// planningCapReached returns a block reason, or null when the cap is not
// reached. The cap is: the root has already done 5+ planning rounds, OR two
// consecutive previous rounds were fully blocked. The streak (consecutive
// all-blocked rounds) is tracked by the caller on the root; this helper
// decides whether the most recent completed round counts as all-blocked.
export function previousRoundBlocked(
  root: GoalNode,
  plans: GoalNode[],
): boolean {
  const prevRound = (root.planningRounds || 0) - 1;
  if (prevRound < 0) return false; // no previous round yet
  const prevPlans = plans.filter((g) => g.planningRound === prevRound);
  if (prevPlans.length === 0) return false;
  return prevPlans.every((g) => g.status === "blocked");
}

export function planningCapReached(
  root: GoalNode,
  consecutiveBlockedPlannings: number,
): string | null {
  if ((root.planningRounds || 0) >= 5) {
    return `Planning cap reached (planningRounds=${root.planningRounds})`;
  }
  if (consecutiveBlockedPlannings >= 2) {
    return `Planning cap reached (consecutiveBlockedPlannings=${consecutiveBlockedPlannings})`;
  }
  return null;
}

// --- Pure helpers for the error streak (C3). ---

export function applyTurnToErrors(
  prev: EnvErrors,
  turn: { reason: string; toolErrors: number },
): EnvErrors {
  const isErrorTurn = turn.reason === "error" || turn.toolErrors > 0;
  if (isErrorTurn) {
    return {
      consecutiveErrorTurns: prev.consecutiveErrorTurns + 1,
      toolErrorsLastTurn: turn.toolErrors,
      lastErrorAt: Date.now(),
      handledAt: prev.handledAt,
    };
  }
  return {
    consecutiveErrorTurns: 0,
    toolErrorsLastTurn: 0,
    lastErrorAt: prev.lastErrorAt,
    handledAt: prev.handledAt,
  };
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
