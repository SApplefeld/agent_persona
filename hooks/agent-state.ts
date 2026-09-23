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
  pausedByNudgeCap?: boolean; // Round 60 finding 3(b): set when the nudge cap pauses this
                              // node, so turn.complete can reactivate it on the worker's
                              // next completed turn that calls a real work tool, without
                              // reactivating a node paused for any other reason.
  kaizenSignal?: string; // plan item 8.4: set on a plan an earlier self-review loop
                         // raised from the worker's own record, naming the weakness
                         // signal. The loop writes no such node; the tick sends
                         // an open one to the coordinator persona as a finding and
                         // abandons it.
  planPath?: string; // Section 1 (plan-health-from-the-record): the plan document's
                      // path, relative to the persona's working directory, in the
                      // form docs/plans/<name>.md. Set on a plan node only, by
                      // goal_add or filled from the node's own text on load. The
                      // v2/v3 migration itself writes no value; the load-time
                      // fill runs on every migration exit and may fill one.
  lead?: { state: "blocked" | "waiting"; reason: string; at: number } | null; // Section 3:
                      // the worker's own BLOCKED/WAITING first line for a plan entry.
                      // Set and cleared at turn end from the first line of a plan
                      // entry's closing text; a blocked lead is also lifted by
                      // goal_resume and by the idle tick once an ask on the entry
                      // closes after it, and completion by the plan document
                      // clears it. Unset by the v2-v4 migration.
  chapterCount?: number; // Section 2: the number of "### Chapter N" headings the
                      // plan document held at the last read. Written by the
                      // document read at turn end. Unset by the v2-v4 migration.
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

export interface SentFinding {
  signal: string;
  text: string;
  sentAt: number;
  writer: string;
  seq: number;
  delivered: boolean;
}

// A long-term goal: the idea a persona is working towards. It is held in a
// list beside the goal tree, not as a node in it, and no tree walker reads
// that list, so a long-term goal is never activated and never holds a root
// open. goal_longterm adds and drops entries, and goal_create leaves the list
// as it is.
export interface LongTermGoal {
  id: string;
  title: string;
  objective: string;
  createdAt: number;
}

// The most long-term goals a persona holds at once. The list is shown in a
// prompt, so it is kept short, and goal_longterm refuses an add past it.
export const LONG_TERM_GOAL_CAP = 5;

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
    // The finder's ledger of the self-review findings it sent. The inbox
    // record is only the carrier: a record can be skipped, and a delivered
    // one is swept, so this list is what the settle step reads back and what
    // the cool-off counts from. `writer` and `seq` key the record in the
    // coordinator persona's inbox; an entry announced on the persona's own
    // thread instead carries an empty writer and a seq of 0.
    sent: SentFinding[];
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

/**
 * The five health classes the steward reports on. Each is one word for a whole
 * fleet row. The fourth is not a variant of the third: an enabled persona that
 * has never come up has no commons entry at all, so it reports a null
 * heartbeat age and satisfies none of the other four.
 *
 * They live here beside the memo the watcher's reading is made of, which is
 * written in these words.
 */
export const FLEET_HEALTH = {
  held: "held",
  backingOff: "backing off",
  stale: "stale",
  noClaim: "no live claim while the roster enables it",
  healthy: "healthy",
} as const;
export type FleetHealth = (typeof FLEET_HEALTH)[keyof typeof FLEET_HEALTH];

/**
 * What a class value carries when the roster's own entry for that persona is
 * disabled. The roster flag is part of the value the watcher compares rather
 * than a field beside it, so flipping an entry to disabled is itself a change
 * with a line of its own. Without that the flip is invisible: a running
 * persona reads the same class either way, and once it exits its commons entry
 * ages out and the disabled branch reads healthy again, so a persona can write
 * `"enabled": false` into its own roster entry, exit, and leave the fleet with
 * nothing reported before, during or after.
 */
export const FLEET_DISABLED_TAIL = " under a disabled roster entry";

/**
 * What a class value carries when the process keeper has written no state file
 * for that persona. An absent keeper.json is the one unread thing the health
 * reduction passes over, because a persona on its first-ever launch has none
 * for the whole of that run, and that reading is borrowable: the file sits in
 * the persona's own run directory, so a persona whose class the watcher is
 * reporting can delete it and fall back to healthy, which the quiet window
 * then holds back. The file's presence is part of the value compared for that
 * reason, so gaining or losing it is a change with a line of its own whatever
 * the class does.
 */
export const FLEET_KEEPER_UNWRITTEN_TAIL = " with no keeper state written";

/**
 * The value the watcher compares and stores for one persona: its health class,
 * whether the roster enables it, and whether the process keeper has written
 * any state for it. The two qualifiers are independent, so a value can carry
 * both, and they are appended in a fixed order because this text is compared
 * as text.
 */
export function fleetClassValue(health: FleetHealth, enabled: boolean, keeperStateUnwritten: boolean): string {
  const disabled = enabled ? "" : FLEET_DISABLED_TAIL;
  return `${health}${disabled}${keeperStateUnwritten ? FLEET_KEEPER_UNWRITTEN_TAIL : ""}`;
}

/**
 * Two of the three entries the watcher's reading holds that are not personas:
 * how the roster file itself read, and what its entries could not be turned
 * into. The third, how the last controller tick ended, belongs to the tick and
 * is named there. All three keys carry spaces, which the persona-name rule
 * refuses, so no roster persona can take any of them.
 */
export const FLEET_ROSTER_STATE_KEY = "the roster reading itself";
export const FLEET_ENTRY_PROBLEMS_KEY = "the roster entries that carry a problem";

/**
 * What the controller tick's fleet watcher remembers about one key of its
 * reading between ticks.
 *
 * `class` is the class the last reading produced, which is what a further
 * reading is compared against. `reported` is the class the last line the
 * watcher submitted actually named, which is what the operator was last told,
 * and it is the empty string while no line has been submitted at all. The two
 * differ whenever a change was counted rather than reported, and every line
 * the watcher composes reads its `from` out of `reported`, so a line never
 * names a class nobody was told.
 *
 * `reportedAt` is the clock at that line, 0 when there has been none, and it
 * is what the quiet window runs from: one line per key per window, whatever
 * the class does in between. `suppressed` is how many class changes have
 * happened since that line with no line of their own, and it rides the next
 * line about the key.
 *
 * `departed` is true between the line reporting that a cleanly read roster has
 * stopped naming this persona and the reading that names it again. It is what
 * makes that departure one line rather than one per tick, and the memo stands
 * throughout, so a name that comes back is compared against the class the
 * operator was last told rather than read as a persona nothing is known about.
 *
 * `class` and `reported` are typed as plain strings because the reading holds
 * three keys that are not personas, and those three take their value from text
 * the roster file and the tick supplied rather than from the class list.
 *
 * The reading these memos make up is held in the session's own memory for the
 * life of that session and is written to no file, so every memo the watcher
 * compares against is one the watcher itself produced on an earlier tick of
 * this same session.
 */
export interface FleetHealthMemo {
  class: string;
  reported: string;
  reportedAt: number;
  suppressed: number;
  departed: boolean;
}

export interface AgentState {
  version: 4;
  persona: string;
  activeSessionId: string;
  epoch: number;
  memory: MemoryEntry[];
  goals: GoalNode[];
  activeGoalId: string | null;
  longTermGoals: LongTermGoal[]; // beside the tree, never in it; see LongTermGoal
  monitor: MonitorState;
  nudge: NudgeBudget;
  pendingAskId?: string; // D5: ask-operator wait
  decisions: Array<{
    timestamp: number;
    loop: "memory" | "goal" | "monitor" | "worker";
    action: string;
    detail: string;
  }>;
  // The clock at the last [RECONCILE] prompt, for the coordinator persona
  // alone. It lives in the persisted state rather than in the session's own
  // memory because the reconciliation cadence is four hours and a steward
  // relaunched more often than that would otherwise restart the wait at every
  // launch and never reconcile at all. It is absent until the watcher's first
  // tick, which stamps it rather than firing the pass.
  //
  // The fleet watcher's reading is not here. It is held in session memory, so
  // nothing a file carries can decide what the watcher says about a persona;
  // the cost of that is a steward restating each currently unhealthy persona
  // once when it comes up.
  lastReconcileAt?: number;
  createdAt: number;
  updatedAt: number;
}

// Decision log cap: keep the most recent N entries.
export const DECISIONS_MAX = 200;

// Item 5 (Bounded store): memory cap, enforced at push time in persist().
// Pinned entries are never evicted regardless of this cap.
export const MEMORY_MAX = 50;

// Section 1 (plan-health-from-the-record): the shape a plan node's planPath
// must hold. Anchored at both ends, so a value like "x/docs/plans/a.md" or
// "docs/plans/a.md/x" is refused rather than admitted by a partial match.
// This guards one producer, goal_add: a value it would refuse (a ".."
// segment, a subdirectory, a drive letter, a non-.md suffix) is never
// written to an entry by that tool. The store is the other producer, and a
// planPath read back out of it is not re-tested here, so a hand-edited or
// foreign-written store can carry any value at all. Section 2 joins a
// planPath onto the persona's working directory and reads the file it
// names. Its reader owes that value a re-test against this pattern before
// the join, since nothing between the store and the join performs one.
export const PLAN_PATH_PATTERN = /^docs\/plans\/[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.md$/;

// The same shape, found inside free text (a node's title or objective), used
// to fill planPath on load for a plan node that lacks one. The lazy body
// stops at the first ".md", and the negative lookahead refuses to end the
// match inside a longer filename; together they leave a path's own trailing
// punctuation (a comma, a full stop) outside the capture, exactly as a
// worker writes it in prose.
//
// The lookbehind guards the LEFT edge the same way the lookahead guards the
// right. Without it the pattern matches inside a longer token: "finish
// ../docs/plans/a_v1.md", a URL such as
// "https://host/repo/docs/plans/a_v1.md", and a Windows path such as
// "D:\other_repo\docs/plans/a_v1.md" each fill planPath with
// "docs/plans/a_v1.md", a different file from the one actually named, with
// no signal that a rewrite happened. The excluded set covers the characters
// a longer path or filename puts immediately before "docs": letters,
// digits, ".", "_" and "-" (filename characters), "/" and "\" (path
// separators, the second being the one this host's own paths carry), and
// ":" (a drive-relative path such as "D:docs/plans/a_v1.md", which names a
// file under that drive's own current directory rather than this repo's).
// It is a set wide enough for the token shapes above rather than a proof
// that no other character can precede a longer token.
//
// A shape guard cannot stand in for this edge. Every rewrite above yields a
// capture that is itself well formed, so re-testing the capture against
// PLAN_PATH_PATTERN passes it. The left edge is the only thing that refuses
// a path belonging to another tree.
//
// The right edge is guarded by a class of its own, narrower than the
// left's, in three parts. A filename character ends the match inside a
// longer name. A "." followed by a letter or digit is a further extension,
// so "docs/plans/a_v1.md.bak" names a different file. A "/" makes the match
// a directory prefix of a longer path, as in "docs/plans/a_v1.md/notes". A
// "." followed by anything else is ordinary sentence punctuation and stays
// outside the capture, which is how a worker's own prose writes the path.
export const PLAN_PATH_TEXT_PATTERN = /(?<![A-Za-z0-9._/:\\-])(docs\/plans\/[A-Za-z0-9][A-Za-z0-9._-]{0,250}?\.md)(?![A-Za-z0-9_-]|\.[A-Za-z0-9]|\/)/;

// The plain-language form of PLAN_PATH_PATTERN, named in every goal_add
// refusal so a worker sees the required shape rather than a regex literal.
export const PLAN_PATH_REQUIRED_FORM =
  'planPath must be a project-relative path of the form "docs/plans/<name>.md": ' +
  "no leading slash, no drive letter, no further path segments, and a name " +
  "starting with a letter or digit and using only letters, digits, \".\", \"_\" or \"-\".";

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
    longTermGoals: [],
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
      selfReview: { count: 0, lastAt: 0, turnsSince: 0, windowStart: 0, pendingPeriodic: false, lastInjectAt: 0, sent: [] },
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

// Section 1 (plan-health-from-the-record): the store-load side of the plan
// path. Runs once per load, on every version's exit, since a plan node can
// come from a v2 store's migration as easily as a v4 one. Idempotent, one
// test per step: the fill skips a node that already carries planPath, and
// the recovery skips an entry that is not the exact frozen shape below, so
// a second load over the same store changes nothing.
//
// Fill: a plan node loaded without planPath gets one from the first capture
// of PLAN_PATH_TEXT_PATTERN in its title, then (only if the title held none)
// its objective. A node naming no plan document in either field gains none.
// Each field is read only when it is a string, since a stored node can lack
// either one or hold a value of another type, and these call sites sit
// outside the try that produces the "store could not be read" fallback: a
// throw here stops the session coming up at all.
//
// Recover: a node frozen by the round budget - status "blocked",
// blockedReason exactly "Max rounds reached" - and which HAS a plan by the
// ancestor rule (Standing Brief Amendment: a plan entry is one that has a
// plan by that rule, never one whose kind is "plan") returns to "pending"
// with the reason cleared (undefined, the same absent value goal_resume's
// own clear leaves behind) and completedRounds reset to 0, since a node left
// at its maxRounds re-blocks on its first scored round. The ancestor rule
// rather than kind is what it keys on: the scorer blocks the active LEAF and
// a plan node with children is never the active leaf, so the frozen entry is
// usually a task under a plan node, and no goal tool reopens a blocked entry.
// resolvePlanPath is the same ancestor walk Section 2's reader uses, so both
// sides of "has a plan" agree.
//
// A node is freed only where the freed entry can be consumed, on two tests.
// The root must be live, because isActivationEligible exempts the root from
// its status test, so otherwise a recovered entry is activatable under a root
// that is complete, abandoned or blocked. That test reuses the exact three
// statuses isPlanningDue already names, and the root is found the way every
// other helper here finds it: state.goals.find(g => g.parentId === null).
// And a freed node is consumed through a leaf. A childless node is that leaf.
// A node WITH children is reached through them, since activateNext's DFS
// filters each level on "pending", tries isActivationEligible on each
// candidate and descends where it fails, so a pending parent yields its
// pending leaf. Such a node is freed only when at least one child is pending
// once this pass has been applied. Where every child is complete, abandoned
// or still blocked, freeing it yields no activatable leaf while isPlanningDue
// reads the pending node as work in hand and holds the planner back, so it
// stays blocked.
//
// The fill and the recovery run as two passes over state.goals, and the
// recovery is computed whole to a fixpoint before any of it is applied. The
// recovery reads an ancestor's planPath through resolvePlanPath and that
// ancestor can sit after the node in the array, and accepting one entry can
// be what makes its parent's child test pass. Sweeping until a sweep accepts
// nothing yields the least set satisfying both tests, independent of the
// array's order, which nothing states or enforces. The bound is the node
// count, since each sweep past the first accepts at least one node.
//
// The ancestors between a frozen entry and the root, excluding the root,
// decide the recovery with it. A plan parent whose blockedReason is exactly
// "Child task blocked" holds that status only from completeLeaf's upward walk
// over a blocked child, so it is the same round budget one hop up and returns
// to "pending" with the entry. An ancestor frozen by the round budget itself
// and carrying a plan is freed on the same ground, its own child test
// satisfied by construction since the entry beneath it becomes pending in the
// same pass. Leaving either blocked would leave the entry pending and
// reachable by nothing: isActivationEligible refuses a node whose ancestor is
// not pending, activateNext's DFS filters each level on "pending" and so
// never descends to it, and isPlanningDue reads the pending descendant as
// work in hand and does not run the planner. An ancestor in any other state
// refuses the whole recovery, and the chain is decided before any of it is
// mutated, so a refusal high in the chain cannot leave the lower half
// cleared.
function blockedAncestorsToFree(state: AgentState, node: GoalNode): GoalNode[] | undefined {
  const toFree: GoalNode[] = [];
  let current = node;
  // The walk is bounded by the node count, the same guard isActivationEligible
  // and resolvePlanPath use against a parentId cycle.
  let steps = state.goals.length;
  while (current.parentId) {
    if (steps-- <= 0) return undefined;
    const parent = state.goals.find((g) => g.id === current.parentId);
    // A missing parent is a chain activateNext's DFS from the root cannot
    // walk down, so the entry would be unreachable freed.
    if (!parent) return undefined;
    if (parent.parentId === null) break; // the root, which the caller's own liveness test owns
    if (parent.status === "blocked" && parent.blockedReason === "Child task blocked") {
      toFree.push(parent);
    } else if (parent.status === "blocked" && parent.blockedReason === "Max rounds reached"
      && resolvePlanPath(state, parent) !== undefined) {
      toFree.push(parent);
    } else if (parent.status !== "pending" && parent.status !== "active") {
      // "active" is accepted because enforceInvariants, which demotes an
      // active node that has children, runs after this.
      return undefined;
    }
    current = parent;
  }
  return toFree;
}

function applyPlanRecordOnLoad(state: AgentState): void {
  for (const node of state.goals) {
    if (node.kind === "plan" && !node.planPath) {
      const fromTitle = typeof node.title === "string" ? node.title.match(PLAN_PATH_TEXT_PATTERN) : null;
      const found = fromTitle
        ? fromTitle[1]
        : typeof node.objective === "string" ? node.objective.match(PLAN_PATH_TEXT_PATTERN)?.[1] : undefined;
      if (found) node.planPath = found;
    }
  }

  const root = state.goals.find((g) => g.parentId === null);
  const rootIsLive = root !== undefined
    && root.status !== "complete" && root.status !== "abandoned" && root.status !== "blocked";
  if (!rootIsLive) return;

  // Any entry with a plan by the ancestor rule, not just one whose kind is
  // "plan". An entry with no plan keeps the round budget as its only signal.
  const frozen = state.goals.filter(
    (g) => g.status === "blocked" && g.blockedReason === "Max rounds reached"
      && resolvePlanPath(state, g) !== undefined,
  );

  const toFree = new Map<string, GoalNode>();
  // What a child's status will be once this pass has been applied.
  const pendingAfterPass = (child: GoalNode): boolean =>
    child.status === "pending" || toFree.has(child.id);

  let sweeps = state.goals.length + 1;
  let accepted = true;
  while (accepted && sweeps-- > 0) {
    accepted = false;
    for (const node of frozen) {
      if (toFree.has(node.id)) continue;
      const children = state.goals.filter((g) => g.parentId === node.id);
      // No child this pass leaves pending, so freeing this node yields no
      // activatable leaf.
      if (children.length > 0 && !children.some(pendingAfterPass)) continue;
      const ancestors = blockedAncestorsToFree(state, node);
      if (!ancestors) continue; // an ancestor in a state this cannot explain: the entry stays blocked
      toFree.set(node.id, node);
      for (const ancestor of ancestors) toFree.set(ancestor.id, ancestor);
      accepted = true;
    }
  }

  for (const node of toFree.values()) {
    node.status = "pending";
    // An entry the round budget froze is reset, since left at its maxRounds
    // it re-blocks on its very first scored round. An ancestor blocked by its
    // own child never spent a round of its own.
    if (node.blockedReason === "Max rounds reached") node.completedRounds = 0;
    node.blockedReason = undefined;
  }
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
      longTermGoals: [],
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
    // Section 1: fill/recover runs on every branch's exit; see the function.
    applyPlanRecordOnLoad(state);
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
    if (!Array.isArray(state.longTermGoals)) {
      state.longTermGoals = [];
    }
    applyPlanRecordOnLoad(state);
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

  // The long-term goal list, filled empty at the E11 site for a store written
  // before it existed, with no version bump.
  if (!Array.isArray(state.longTermGoals)) {
    state.longTermGoals = [];
  }

  // S12: fill selfReview with defaults at the E11 site, no version bump.
  if (!state.monitor.selfReview) {
    state.monitor.selfReview = {
      count: 0, lastAt: 0, turnsSince: 0, windowStart: 0,
      pendingPeriodic: false, lastInjectAt: 0, sent: [],
    };
  }
  // The findings ledger, filled at the same site for a store written before
  // it existed.
  if (!Array.isArray(state.monitor.selfReview.sent)) {
    state.monitor.selfReview.sent = [];
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

  // The fleet watcher's reading is dropped from anything this file carries.
  // The watcher holds its reading in session memory and reads it back from
  // nowhere, so a `fleetHealth` key here is a legacy state a previous version
  // wrote or one a hand-written store seeded, and either way it contributes
  // nothing to what the watcher says. Dropping it keeps it out of the state
  // the session then writes back, so the key does not survive as a value no
  // reader has.
  //
  // Nothing the watcher reads out of a file may decide silence about an
  // unhealthy persona, and that is why the reading is not stored at all. The
  // store sits inside a persona's own working directory, which a roster can
  // give to more than one persona, and every field of a memo that silences a
  // key is a value the watcher itself legitimately produces, so no check on
  // the value can tell a watcher's own memo from a persona's memo about
  // itself.
  const readClock = Date.now();
  delete (state as { fleetHealth?: unknown }).fleetHealth;

  // The reconciliation cadence's stamp, held to a number the clock can have
  // passed. The tick asks for the pass when `reconcileNow - lastReconcileAt`
  // reaches the cadence, and a stamp that is a string, an object or NaN makes
  // that difference NaN, which is never at or past the cadence; the stamp is
  // no longer absent either, so the branch that starts the cadence does not
  // run. The pass would then never be asked for again, with nothing written
  // down saying why. A stamp ahead of the clock silences it the same way for
  // as long as it stands. Dropping it puts the next tick on the branch that
  // starts the cadence, so the pass runs one cadence later at worst.
  if (state.lastReconcileAt !== undefined
    && (typeof state.lastReconcileAt !== "number"
      || !Number.isFinite(state.lastReconcileAt)
      || state.lastReconcileAt > readClock)) {
    delete state.lastReconcileAt;
  }

  // L10: invariant block runs on both v2 and v3 branches.
  // Section 1: fill/recover runs here too, on the already-v4 exit.
  applyPlanRecordOnLoad(state);
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

// Section 10 fix round: whether a single node is eligible to become the
// active leaf. A node is eligible when its own status is "pending", it has
// no children (the leaf invariant), and every ancestor between it and the
// root also has status "pending" - the root itself is exempt, since
// activateNext's own DFS starts there without testing its status. This is
// activateNext's own DFS rule, extracted so a second caller (goal_add) reads
// the same rule rather than reimplementing it by hand.
export function isActivationEligible(state: AgentState, node: GoalNode): boolean {
  if (node.status !== "pending") return false;
  if (state.goals.some((g) => g.parentId === node.id)) return false;
  // The walk is bounded by the node count. A parentId cycle, which the
  // tree's shape rules do not permit but nothing here re-checks, exhausts the
  // bound and reads as not eligible rather than spinning.
  let current = node;
  let steps = state.goals.length;
  while (current.parentId) {
    if (steps-- <= 0) return false;
    const parent = state.goals.find((g) => g.id === current.parentId);
    if (!parent) break;
    if (parent.parentId === null) break; // parent is the root, exempt from the status test
    if (parent.status !== "pending") return false;
    current = parent;
  }
  return true;
}

// Section 1 (plan-health-from-the-record): the plan document a node is
// judged against. A node's plan is its own planPath, or else the planPath
// of its nearest ancestor that has one - so a task a worker adds under a
// plan node is judged against that plan's document too. Returns undefined
// for a task entry, one with no such ancestor. The walk is bounded by the
// node count, the same guard isActivationEligible uses, since a parentId
// cycle the tree's shape rules do not permit would otherwise spin here too.
export function resolvePlanPath(state: AgentState, node: GoalNode): string | undefined {
  return planHolderOf(state, node)?.planPath;
}

// The entry that holds the planPath a node is judged against: the node
// itself, or else its nearest ancestor with one. This is the entry a plan
// document's completion completes, which for a task under a plan node is
// its parent. Returns undefined for a task entry. resolvePlanPath is this
// walk's path; the two never diverge because one derives from the other.
export function planHolderOf(state: AgentState, node: GoalNode): GoalNode | undefined {
  if (node.planPath) return node;
  let current: GoalNode | undefined = node;
  let steps = state.goals.length;
  while (current && current.parentId) {
    if (steps-- <= 0) return undefined;
    const parent: GoalNode | undefined = state.goals.find((g) => g.id === current!.parentId);
    if (!parent) return undefined;
    if (parent.planPath) return parent;
    current = parent;
  }
  return undefined;
}

// Plan item 3 (reprioritize): sortKey overrides createdAt for activation
// order when set; absent sortKey falls back to createdAt, so an untouched
// node's order is unaffected. The controller's walk and the open-entry list
// both order by this one key.
const orderKey = (g: GoalNode): number => g.sortKey ?? g.createdAt;

// The leaf the controller activates when it walks from the root: depth-first,
// each level filtered on "pending" and ordered by orderKey, returning the
// first leaf isActivationEligible accepts. A pending leaf under a paused,
// blocked or complete parent is never reached. Pure: it reads the tree and
// changes nothing. activateNext calls this for its walk, so the controller
// and hasStartableWork share one walk and cannot disagree.
export function nextStartableLeaf(state: AgentState): GoalNode | null {
  const root = state.goals.find((g) => g.parentId === null);
  if (!root) return null;
  const dfs = (parentId: string): GoalNode | null => {
    const candidates = state.goals
      .filter((g) => g.parentId === parentId && g.status === "pending")
      .sort((a, b) => orderKey(a) - orderKey(b));
    for (const c of candidates) {
      // Every candidate here already descends through an all-pending
      // ancestor chain (the level-by-level status filter above), so the
      // eligibility predicate's ancestor test is trivially satisfied and
      // this reduces to the leaf check - reusing it rather than repeating
      // "no children" inline.
      if (isActivationEligible(state, c)) return c;
      // Has children: descend.
      const child = dfs(c.id);
      if (child) return child;
    }
    return null;
  };
  return dfs(root.id);
}

// Every non-root entry still open (pending, active, paused or blocked), in
// one flat orderKey sort across the whole tree rather than the controller's
// level-by-level walk. This is the list the [GOAL QUEUE] block prints.
export function openGoals(state: AgentState): GoalNode[] {
  return state.goals
    .filter(
      (g) =>
        g.parentId !== null &&
        (g.status === "pending" || g.status === "active" || g.status === "paused" || g.status === "blocked")
    )
    .sort((a, b) => orderKey(a) - orderKey(b));
}

// Whether the tree holds work the controller will run on its own: an active
// node, or a leaf its walk from the root would activate. False means every
// open entry is paused, blocked or out of the walk's reach, which is the idle tree.
export function hasStartableWork(state: AgentState): boolean {
  if (state.goals.some((g) => g.status === "active")) return true;
  return nextStartableLeaf(state) !== null;
}

// M6: Activate the next pending leaf (a node with no children).
// Prefers the completed node's siblings, then nextStartableLeaf's walk from
// the root. Only activates nodes that have no children (leaf invariant).
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
        .sort((a, b) => orderKey(a) - orderKey(b));
      if (siblings.length > 0) {
        return activate(siblings[0]);
      }
    }
  }

  // 2. The walk from the root: first pending leaf in orderKey order.
  const leaf = nextStartableLeaf(state);
  if (leaf) return activate(leaf);

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
