// Agentic Plugin v0.6.4: PIANO-esque cognitive layer on Function Hooks.
// One module, one register(on, options) export.
//
// Architecture (PIANO mapping):
// - Modules (Memory, Goal scorer, Monitor): observe at hook boundaries,
//   write to AgentState, NEVER steer or act.
// - Controller: runs on $.clock.every(tickMs). Builds a compressed summary
//   of shared state, sends it to $.model.classify (decision) and
//   $.model.complete (reason, only when not nudge), logs it, THEN actuates.
// - Actuators (exactly three, controller-only):
//     1. Context injection on prompt.submit (always on)
//     2. $.prompt.submit to wake an idle session (nudge)
//     3. $.ui.toast for ask-operator
//
// Liveness: heartbeat sidecar (.agentic-heartbeat.json) tracks who holds
// each persona. The persona store has exactly one writer path per session.
// lastSeen is NOT a liveness proof: it proves the holder stopped stamping,
// never that it exited. A claim is non-destructive: the epoch bump makes
// the old holder yield on its next write.

import type { Register } from "claude-code";
import {
  createDefaultState,
  parseState,
  shouldYield,
  yieldRecord,
  completeLeaf,
  activateNext,
  isPlanningDue,
  previousRoundBlocked,
  planningCapReached,
  applyTurnToErrors,
  envNotable,
} from "./agent-state";
import type { AgentState, GoalNode, NudgeBudget, EnvGit, EnvState } from "./agent-state";
import {
  claimResource,
  readAllClaims,
  shouldYieldCommons,
  releaseResource,
  commonsWinner,
} from "./commons";
import type { CommonsStore } from "./commons";
import {
  claimReaderRole,
  hasLiveReaderClaim,
  sweepExpiredRecords,
  writeInboxRecord,
  getHighestInboxSeq,
  listInboxRecords,
  readReplyRecord,
  writeReplyRecord,
  listAskRecords,
  writeAskRecord,
  readAskRecord,
  expireOpenAsks,
  askKey,
} from "./operator";
import {
  shouldSelfReview,
  buildSelfReviewInput,
  dedupeSelfReview,
  evictSelfReview,
} from "./self-review";
import { estimateTokens, fnv1aHash, effectiveWindowCount, bumpWindow, backoffFactor, shouldRunClassify } from "./cost-ledger";

// --- Module-scope session identity ---
// The loader requires `persist` and `activate` to be top-level functions.
// A mutable object carries the per-session values; hooks update it on session.start.
//
// Loader rule: `$` and its nouns (`$.store`, `$.fs`, `$.ui`, ...) may never be
// bound, passed, or read as values. Every use must be a full call spelled
// `$.noun.verb(...)` at the site. Passing `$` itself to a function is allowed
// only when that function is declared at the top level of the same file.

/**
 * Adapter: wrap a hook- or persist-bound `$` into the `CommonsStore` interface
 * that `commons.ts` expects. Each arrow is a full `dp.store.verb(...)` call
 * at its site, which is what the validator accepts.
 */
function commonsStoreOf(dp: any): CommonsStore {
  return {
    get: (k: string) => dp.store.get(k),
    set: (k: string, v: unknown) => dp.store.set(k, v),
    delete: (k: string) => dp.store.delete(k),
    keys: () => dp.store.keys(),
  };
}

/**
 * D5: handle an open ask during a tick.
 * Returns "waiting" if the ask is still open (persist and return),
 * "expired" if the wait elapsed (persist, activateNext, return),
 * "none" if no ask or the ask is not open (caller proceeds normally).
 */
async function tickOpenAsk(
  dp: any,
  state: AgentState,
  persona: string,
  cfg: Record<string, unknown>,
  contextId: string | null,
): Promise<"waiting" | "expired" | "none"> {
  if (!state.pendingAskId) return "none";
  const store = commonsStoreOf(dp);
  const askRecord = await readAskRecord(store, persona, state.pendingAskId);
  if (!askRecord || askRecord.status !== "open") return "none";

  const now = Date.now();
  const lastAskWaiting = state.decisions.findLast((d) => d.action === "ask_waiting");
  if (!lastAskWaiting || now - lastAskWaiting.timestamp >= 60_000) {
    state.decisions.push({
      timestamp: now,
      loop: "monitor",
      action: "ask_waiting",
      detail: `${contextId ? contextId + ": " : ""}ask ${state.pendingAskId} still open`,
    });
  }
  const elapsed = now - askRecord.at;

  // D5b (bullet 3): a quiet channel means the operator may never see the
  // ask_waiting log line. Past a bounded window, re-raise the question into
  // the thread once (a real turn, not a log line) rather than sit silent.
  const reraiseMs = typeof cfg.askReraiseWindowMs === "number" ? (cfg.askReraiseWindowMs as number) : 15 * 60_000;
  if (reraiseMs > 0 && !askRecord.reraisedAt && elapsed >= reraiseMs) {
    askRecord.reraisedAt = now;
    await store.set(askKey(persona, state.pendingAskId), askRecord);
    state.decisions.push({
      timestamp: now,
      loop: "monitor",
      action: "ask_reraised",
      detail: `${contextId ? contextId + ": " : ""}ask ${state.pendingAskId} re-raised after ${Math.round(elapsed / 1000)}s: ${askRecord.question.slice(0, 100)}`,
    });
    try {
      // D5b: re-raise carries the same reply-tool instruction that every operator-facing
      // prompt carries (item 5, priming turn), since a child's own conversational reply
      // is never visible to the operator through Discord.
      const REPLY_INSTRUCTION = "You are attached to a Discord channel. When you want to say something back to the operator, call the reply tool from the channel-relay MCP server - your own conversational reply is not visible to them. ";
      await dp.prompt.submit({ text: `${REPLY_INSTRUCTION}[STILL WAITING] ${askRecord.question}` });
    } catch { /* re-raise failed; non-fatal, the decision log still shows it */ }
  }

  // Round 34: an absent option must still resolve to a real wait, not to 0 -
  // whether the engine fills plugin.json's userConfig default into `cfg` is
  // not established anywhere in this repo, so the code fallback carries its
  // own default (60 minutes, larger than the 15-minute re-raise window),
  // matching how line 123's askReraiseWindowMs fallback is written in code.
  const waitMs = typeof cfg.askOperatorWaitMs === "number" ? (cfg.askOperatorWaitMs as number) : 3_600_000;
  if (waitMs > 0) {
    if (elapsed >= waitMs) {
      state.decisions.push({
        timestamp: now,
        loop: "monitor",
        action: "ask_timeout",
        detail: `${contextId ? contextId + ": " : ""}ask ${state.pendingAskId} expired after ${Math.round(elapsed / 1000)}s`,
      });
      askRecord.status = "expired";
      await store.set(askKey(persona, state.pendingAskId), askRecord);
      // D5b (bullet 4): the controller's nudges resume rather than waiting
      // forever - activateNext already walks to the next pending plan/task,
      // which is what "nudges resume on a plan" means when this node itself
      // has nothing left runnable without the answer.
      const askedNode = state.goals.find((n) => n.id === askRecord.nodeId);
      if (askedNode) {
        askedNode.lastAskQuestion = askRecord.question;
        askedNode.lastAskClosedAt = now;
      }
      state.pendingAskId = undefined;
      const nextId = activateNext(state);
      if (nextId) {
        activate(dp, nextId, "ask timeout, walking on");
      }
      await persist(dp);
      return "expired";
    }
  }
  await persist(dp);
  return "waiting";
}

/**
 * D5b: an open ask never silences the worker, part 2. The classifier can
 * propose the identical ask-operator/pause question again right after the
 * operator (or a thread reply) just closed it, which reads as the worker
 * ignoring the answer. Suppress a re-open of the exact same question on the
 * exact same node within the suppress window; the caller falls through to a
 * nudge instead so the plan keeps moving rather than pausing on a loop.
 */
function shouldSuppressReask(
  node: GoalNode | undefined,
  question: string,
  now: number,
  suppressMs: number,
): boolean {
  if (!node || !node.lastAskQuestion || node.lastAskClosedAt === undefined) return false;
  return node.lastAskQuestion === question && now - node.lastAskClosedAt < suppressMs;
}

/**
 * Item 2 backstop (Round 28): whether a tool call counts as "did real
 * work" for the turn.complete backstop. Built-in file/shell tools that
 * change state; any MCP tool that is neither this plugin's own (which
 * would have opened a goal itself, making the backstop moot) nor the
 * channel's reply tool (a priming turn's only call, which must never look
 * like task work - a channel-attached passive child otherwise backfills
 * a completed goal on its own acknowledgment turn and gets restarted in
 * a loop). Read-only tools (Read, Grep, Glob, ...) do not count: looking
 * at something is not doing the thing the operator asked for.
 */
function isWorkTool(toolName: string): boolean {
  if (["Write", "Edit", "Bash", "NotebookEdit"].includes(toolName)) return true;
  if (!toolName.startsWith("mcp__")) return false;
  if (toolName.startsWith("mcp__agentic-plugin__")) return false;
  if (toolName.includes("__reply") || toolName.endsWith("_reply")) return false;
  return true;
}
const sess: {
  persona: string;
  mySessionId: string;
  myEpoch: number;
  isOwner: boolean;
  state: AgentState;
  storePath: string;
  yieldLogPath: string;
  lastNudgeAt: number;
  consecutiveNudgesWithoutOnGoal: number;
  options: { healthTimeoutMs?: number; gitProbeMs?: number };
  contextBudgetEnabled: boolean;
  contextBudgetInfoTokens: number;
  contextBudgetCloseoutTokens: number;
  contextBudgetCriticalTokens: number;
  contextBudgetReadEveryNTicks: number;
  contextBudgetTickCount: number;
  contextBudgetLatched: { info: boolean; closeout: boolean; critical: boolean };
  controllerTickCount: number; // D4: in-session tick counter for backoff and cost_summary
  staleAfterMs: number; // F9a: single-source the staleness threshold
} = {
  persona: "default",
  mySessionId: "pending",
  myEpoch: 0,
  isOwner: false,
  state: createDefaultState("default", "pending"),
  storePath: ".agentic-personas.json",
  yieldLogPath: ".agentic-yields.log",
  lastNudgeAt: 0,
  consecutiveNudgesWithoutOnGoal: 0,
  options: {},
  contextBudgetEnabled: false,
  contextBudgetInfoTokens: 100_000,
  contextBudgetCloseoutTokens: 250_000,
  contextBudgetCriticalTokens: 350_000,
  contextBudgetReadEveryNTicks: 3,
  contextBudgetTickCount: 0,
  contextBudgetLatched: { info: false, closeout: false, critical: false },
  controllerTickCount: 0,
  staleAfterMs: 90_000,
};

// Reentrancy flag for the git probe (E4).
let gitProbeInFlight = false;

// B1: reentrancy flag for the budget read (serialize to prevent race conditions).
let budgetReadInFlight = false;

// F7: once the cwd is confirmed non-git (exit 128), stop probing for the
// life of the session. The flag lives in the hook module, not in state.
let gitUnavailable = false;

// C4: tool error counter for the current turn (reset at turn.start, folded at turn.complete).
let toolErrorsThisTurn = 0;

// Item 2 sub-bullet (f016b69): tool-call counter for the current turn
// (reset at turn.start), backing the no-goal-tree backstop in
// turn.complete - a cost-conscious model can read the [NO GOAL] reminder
// and still skip goal_create for a task it judges too small; this counts
// whether real tool work happened this turn regardless of what the model
// chose to call.
let toolCallsThisTurn = 0;

// Health run helper (E2).
async function runHealth(dp: any, forNodeId: string | null): Promise<void> {
  const healthPath = ".agentic-health";
  try {
    if (!(await dp.fs.exists(healthPath))) {
      return;
    }
    const raw = await dp.fs.read(healthPath, "utf8");
    const argv: string[] = raw.trim().split(/\s+/).filter((t: string) => t);
    if (argv.length === 0) {
      return;
    }
    const healthTimeoutMs = sess.options.healthTimeoutMs ?? 60000;
    const res = await dp.process.run(argv, { timeoutMs: healthTimeoutMs });
    const tail = (res.stdout || "").split("\n").slice(-20).join("\n");
    const health = {
      command: argv,
      exitCode: res.exitCode,
      tail: tail.slice(-500),
      ranAt: Date.now(),
      forNodeId,
    };
    sess.state.monitor.env.health = health;
    if (res.exitCode === 0) {
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "monitor",
        action: "health_green",
        detail: `health_green ${argv.join(" ")} for ${forNodeId || "no-node"}`,
      });
    } else {
      const firstLine = (res.stdout || "").split("\n")[0] || "no output";
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "monitor",
        action: "health_red",
        detail: `health_red exit ${res.exitCode} ${firstLine} for ${forNodeId || "no-node"}`,
      });
    }
  } catch (err) {
    sess.state.decisions.push({
      timestamp: Date.now(),
      loop: "monitor",
      action: "health_red",
      detail: `health_red error ${(err as Error).message} for ${forNodeId || "no-node"}`,
    });
  }
}

// L26: the yield action (log the decision, drop ownership, append a single
// well-formed line to the yield log) is one code path shared by every site
// that detects a lost-owner condition. persist() calls it on the write path;
// the heartbeat tick calls it on its owner check. One newline rule (one JSON
// object per line, separator inserted when the existing file does not end in a
// newline) so the two paths can never disagree on the log's byte layout.
export const yieldNow = async (dp: any, onDisk: { activeSessionId: string; epoch: number }): Promise<void> => {
  const rec = yieldRecord(sess.persona, sess.mySessionId, onDisk.activeSessionId, sess.myEpoch, onDisk.epoch);
  sess.state.decisions.push(rec.decision);
  sess.isOwner = false;
  try { dp.ui.log(`Agentic: yielded '${sess.persona}' to ${onDisk.activeSessionId} (epoch ${onDisk.epoch})`); } catch { /* non-fatal */ }
  try {
    const el = await dp.fs.exists(sess.yieldLogPath) ? await dp.fs.read(sess.yieldLogPath) : "";
    await dp.fs.write(sess.yieldLogPath, el + (el.length > 0 && !el.endsWith("\n") ? "\n" : "") + rec.logLine);
  } catch { /* non-fatal */ }
  // F13: release the commons claim so an exited session does not lock the
  // persona for the full 90s staleness window.
  try {
    await releaseResource(commonsStoreOf(dp), `persona:${sess.persona}`, sess.mySessionId);
  } catch { /* non-fatal */ }
};

// AD1: Write a stale-takeover claim directly to the store, bypassing persist's
// yield check. Called by the session.start claim and the heartbeat tick promotion
// when the claimant has just established that the holder is stale. The guarded
// write's job is to catch a foreign takeover afterwards, not to veto the
// takeover it belongs to.
const writeClaimDirect = async (dp: any): Promise<void> => {
  const storePath = sess.storePath;
  const store: Record<string, unknown> = await dp.fs.exists(storePath)
    ? (JSON.parse(await dp.fs.read(storePath)) as Record<string, unknown>)
    : {};
  sess.state.updatedAt = Date.now();
  store[sess.persona] = sess.state;
  await dp.fs.write(storePath, JSON.stringify(store, null, 2));
  // Write the heartbeat for the new claim.
  try {
    const heartbeatPath = ".agentic-heartbeat.json";
    const hb: Record<string, { sessionId: string; epoch: number; lastSeen: number }> =
      await dp.fs.exists(heartbeatPath)
        ? (JSON.parse(await dp.fs.read(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>)
        : {};
    hb[sess.persona] = { sessionId: sess.mySessionId, epoch: sess.myEpoch, lastSeen: Date.now() };
    await dp.fs.write(heartbeatPath, JSON.stringify(hb, null, 2));
  } catch { /* heartbeat write failed; non-fatal */ }
};

// M7: single guarded-write path shared by every store write site.
// Closes over sess so all write sites share one yield + write path.
export const persist = async (dp: any): Promise<boolean> => {
  if (!sess.isOwner) return false;
  sess.state.updatedAt = Date.now();
  const store: Record<string, unknown> = await dp.fs.exists(sess.storePath)
    ? (JSON.parse(await dp.fs.read(sess.storePath)) as Record<string, unknown>)
    : {};
  const onDisk = store[sess.persona] as AgentState | undefined;
  // F9 invariant: three sites raise the epoch: agentic_identity (commons winner),
  // session.start claim (heartbeat stale), and controller-tick promotion (heartbeat
  // stale). The two heartbeat-based sites and the commons check all use the same
  // staleAfterMs threshold (F9a: single-sourced via sess.staleAfterMs), so they
  // cannot disagree on liveness. The epoch check and commons check here remain as
  // defense in depth.
  if (onDisk && shouldYield(onDisk, sess.mySessionId, sess.myEpoch)) {
    await yieldNow(dp, onDisk);
    return false;
  }
  // Commons: check machine-global arbitration (Stage 2 integration).
  // If a live competitor has an earlier claim on this persona, yield.
  try {
    const resource = `persona:${sess.persona}`;
    const claims = await readAllClaims(commonsStoreOf(dp), sess.staleAfterMs);
    if (shouldYieldCommons(claims, resource, sess.mySessionId)) {
      const winner = commonsWinner(claims, resource);
      // Write to the yield log for observability (same as epoch-based yield).
      const rec = yieldRecord(
        sess.persona,
        sess.mySessionId,
        winner ?? "unknown",
        sess.myEpoch,
        0, // No epoch in commons; use 0 as a sentinel
      );
      try {
        const el = await dp.fs.exists(sess.yieldLogPath) ? await dp.fs.read(sess.yieldLogPath) : "";
        await dp.fs.write(sess.yieldLogPath, el + (el.length > 0 && !el.endsWith("\n") ? "\n" : "") + rec.logLine);
      } catch { /* non-fatal */ }
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "monitor",
        action: "persona_yield_commons",
        detail: `Yielded ${resource} to ${winner} (commons arbitration)`,
      });
      sess.isOwner = false;
      try { dp.ui.log(`Agentic: yielded '${sess.persona}' to ${winner} (commons)`); } catch { /* non-fatal */ }
      // F13: release the commons claim so an exited session does not lock the
      // persona for the full 90s staleness window.
      try {
        await releaseResource(commonsStoreOf(dp), resource, sess.mySessionId);
      } catch { /* non-fatal */ }
      // Persist the yield decision to disk before returning
      const store2: Record<string, unknown> = await dp.fs.exists(sess.storePath)
        ? (JSON.parse(await dp.fs.read(sess.storePath)) as Record<string, unknown>)
        : {};
      store2[sess.persona] = sess.state;
      await dp.fs.write(sess.storePath, JSON.stringify(store2, null, 2));
      return false;
    }
  } catch { /* non-fatal: commons is a coordination layer */ }
  store[sess.persona] = sess.state;
  await dp.fs.write(sess.storePath, JSON.stringify(store, null, 2));
  return true;
};

// M11: every activation site calls activate() to reset the nudge budget.
// L25: a null target is a distinct decision (activate_none), never an
// "activated" entry that says "No node to activate".
export const activate = (dp: any, nextId: string | null, reason: string): void => {
  sess.consecutiveNudgesWithoutOnGoal = 0;
  sess.lastNudgeAt = 0;
  if (nextId) {
    sess.state.decisions.push({
      timestamp: Date.now(),
      loop: "goal",
      action: "activated",
      detail: `Node ${nextId} activated (${reason})`,
    });
    try { dp.ui.status(`agentic: ${nextId} activated`); } catch { /* non-fatal */ }
  } else {
    sess.state.decisions.push({
      timestamp: Date.now(),
      loop: "goal",
      action: "activate_none",
      detail: `No node to activate (${reason})`,
    });
  }
};

export const register: Register = async (on, options) => {
  // --- Identity: a durable persona is the key, not the session. ---
  // Session vars live in the module-scope `sess` object so persist() and
  // activate() can see them. These local aliases keep existing code readable.
  const storePath = sess.storePath;
  const yieldLogPath = sess.yieldLogPath;
  const heartbeatPath = ".agentic-heartbeat.json";

  // Local aliases: read/write go through sess so persist() and activate()
  // see the same values.
  const getPersona = () => sess.persona;
  const setPersona = (v: string) => { sess.persona = v; };
  const getSessionId = () => sess.mySessionId;
  const getEpoch = () => sess.myEpoch;
  const setEpoch = (v: number) => { sess.myEpoch = v; };
  const getState = () => sess.state;
  const setState = (v: AgentState) => { sess.state = v; };
  const getOwner = () => sess.isOwner;
  const setOwner = (v: boolean) => { sess.isOwner = v; };

  const MAX_CONSECUTIVE_NUDGES = 3;

  // Track the user prompt for the current turn (the goal scorer needs it).
  let currentPrompt = "";
  // When the controller nudges, $.prompt.submit bypasses this plugin's
  // own prompt.submit hook, so currentPrompt still holds the stale user text.
  // This flag tells turn.complete to score with the nudge-aware label set.
  let nudgedTurn = false;
  // Item 2 backstop safety (Round 28): true only when the real
  // prompt.submit hook (a genuine external turn) just saw the
  // [SUPERVISOR-PRIMING] marker bin/supervise.sh's priming turn carries.
  // An internal $.prompt.submit call (nudge, ask re-raise, operator-inbox
  // delivery) bypasses this hook and so never updates this flag - it
  // simply carries forward the last real turn's value, which is
  // acceptable here because staleness can only make the backstop skip a
  // turn it might have covered, never fire it on a priming turn it
  // shouldn't have (only the real hook, seeing the actual marker, ever
  // sets this true).
  let isPrimingTurn = false;
  // Skip the controller tick while a turn is in flight.
  let turnInFlight = false;
  // H2: record the active leaf at turn start; score against THAT node at turn
  // end (not whichever node is active then, which may have been activated
  // mid-turn by goal_done / scorer complete).
  let turnLeafId: string | null = null;

  // M8: planning reentrancy guard.
  let planningInFlight = false;

  // Options carry userConfig fields declared in plugin.json.
  // Read as options.<name> per the types doc (lines 2540–2547).
  const cfg = (options ?? {}) as Record<string, unknown>;
  const heartbeatMs = typeof cfg.heartbeatMs === "number" ? (cfg.heartbeatMs as number) : 30_000;
  const staleAfterMs = typeof cfg.staleAfterMs === "number" ? (cfg.staleAfterMs as number) : 90_000;
  sess.staleAfterMs = staleAfterMs; // F9a: single-source the threshold
  const controllerTickMs = typeof cfg.controllerTickMs === "number" ? (cfg.controllerTickMs as number) : 30_000;
  const nudgeFloorMs = typeof cfg.nudgeFloorMs === "number" ? (cfg.nudgeFloorMs as number) : 5 * 60_000;
  const nudgeIdleMs = typeof cfg.nudgeIdleMs === "number" ? (cfg.nudgeIdleMs as number) : 2 * 60_000;
  const healthTimeoutMs = typeof cfg.healthTimeoutMs === "number" ? Math.min(cfg.healthTimeoutMs as number, 120_000) : 60_000;
  const gitProbeMs = typeof cfg.gitProbeMs === "number" ? Math.min(cfg.gitProbeMs as number, 300_000) : 120_000;
  sess.options = { healthTimeoutMs, gitProbeMs };

  // Plan item 6: the persona the supervisor is given is the persona the child
  // runs as. Without this, every session starts as "default" (sess.persona's
  // own hardcoded initial value) regardless of what was intended, so two
  // sessions meaning to operate under different personas collide on the same
  // shared "default" claim in commons. Read before session.start runs, since
  // register()'s top-level statements execute before any hook fires.
  if (typeof cfg.persona === "string" && cfg.persona.trim()) {
    sess.persona = cfg.persona.trim();
  }

  // Self-review options (S6: options arrive through --settings pluginConfigs).
  const selfReviewStreak = typeof cfg.selfReviewStreak === "number" ? (cfg.selfReviewStreak as number) : 3;
  const selfReviewEveryTurns = typeof cfg.selfReviewEveryTurns === "number" ? (cfg.selfReviewEveryTurns as number) : 20;
  const selfReviewDebounceTurns = typeof cfg.selfReviewDebounceTurns === "number" ? (cfg.selfReviewDebounceTurns as number) : 5;
  const selfReviewMaxPerHour = typeof cfg.selfReviewMaxPerHour === "number" ? (cfg.selfReviewMaxPerHour as number) : 2;
  
  // Context budget (2b).
  sess.contextBudgetEnabled = cfg.contextBudgetEnabled === true;
  sess.contextBudgetInfoTokens = typeof cfg.contextBudgetInfoTokens === "number" ? (cfg.contextBudgetInfoTokens as number) : 100_000;
  sess.contextBudgetCloseoutTokens = typeof cfg.contextBudgetCloseoutTokens === "number" ? (cfg.contextBudgetCloseoutTokens as number) : 250_000;
  sess.contextBudgetCriticalTokens = typeof cfg.contextBudgetCriticalTokens === "number" ? (cfg.contextBudgetCriticalTokens as number) : 350_000;
  sess.contextBudgetReadEveryNTicks = typeof cfg.contextBudgetReadEveryNTicks === "number" ? (cfg.contextBudgetReadEveryNTicks as number) : 3;

  // Cost and cadence (item 6).
  const costEnabled = cfg.costEnabled !== false; // default true
  const costMaxNudgesPerHour = typeof cfg.costMaxNudgesPerHour === "number" ? (cfg.costMaxNudgesPerHour as number) : 12;
  const costMaxPluginCallsPerHour = typeof cfg.costMaxPluginCallsPerHour === "number" ? (cfg.costMaxPluginCallsPerHour as number) : 600;
  const costBackoffAfterTicks = typeof cfg.costBackoffAfterTicks === "number" ? (cfg.costBackoffAfterTicks as number) : 10;
  const costBackoffMaxMs = typeof cfg.costBackoffMaxMs === "number" ? (cfg.costBackoffMaxMs as number) : 300_000;

  // --- D6: doorbell ---
  // Consume peer text so the model never reads it. The only steering that
  // reaches the model from another session comes through a record whose
  // writer holds a reader claim.
  on("session.receive", async ($, e, next) => {
    // BH1: e.origin may be a string (per types) or an object with .kind (runtime)
    const originVal = (e as any)?.origin;
    const kind = typeof originVal === "string" ? originVal : originVal?.kind || "unknown";
    if (e && (kind === "peer" || kind === "peer-send-message")) {
      const text = typeof e.text === "string" ? e.text : "";
      const detail = text.slice(0, 80);
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "monitor",
        action: "peer_consumed",
        detail: detail || "(empty peer text)",
      });
      await persist($);
      try {
        $.ui.toast("agentic: peer text consumed; use agentic_say");
      } catch { /* toast unavailable; non-fatal */ }
      return { consumed: "agentic: peer text is not steering; use agentic_say" };
    }
    // BH1: push decision on pass-through branch
    sess.state.decisions.push({
      timestamp: Date.now(),
      loop: "monitor",
      action: "receive_passthrough",
      detail: `kind=${kind}`,
    });
    await persist($);
    return next(e);
  });

  // --- session.start: register tools, claim or join the persona ---
  on("session.start", async ($, e, next) => {
    try {
      sess.mySessionId = String(await $.session.id());
    } catch {
      // $.session.id unavailable; single-session still works
    }
    $.ui.log(`Agentic: session.start (${sess.mySessionId})`);

    // Register tools.
    await $.tool.register({
      name: "agentic_identity",
      description:
        "Switch this session to a persona's store, joining or claiming ownership safely: it never " +
        "evicts a live session. If another session already holds this persona and its heartbeat is " +
        "current, this session joins as a passive reader (agentic_say/agentic_inbox), taking no " +
        "write access. Ownership is taken only when no live holder exists, or the existing holder's " +
        "heartbeat has gone stale (the holder crashed or exited without releasing it). " +
        "Pass the persona name (e.g. 'default').",
      inputSchema: {
        type: "object",
        properties: {
          persona: {
            type: "string",
            description:
              'The persona name to activate (e.g. "default", "refactorer"). If omitted, activates "default".',
          },
        },
        required: ["persona"],
      },
    });

    await $.tool.register({
      name: "goal_create",
      description:
        "Create a new goal tree for this persona. The root represents the operator's objective; " +
        "plans are created by the planner at the next controller tick. " +
        "Optionally provide a roadmap file to guide planning. " +
        "Use when the user asks to pursue a multi-step objective.",
      inputSchema: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description: "What the worker should accomplish across multiple turns.",
          },
          maxRounds: {
            type: "number",
            description: "Maximum number of goal rounds before auto-blocking. Default 10.",
          },
          roadmapPath: {
            type: "string",
            description: "Optional path to a roadmap file (project-relative). The planner reads it at every planning event.",
          },
        },
        required: ["objective"],
      },
    });

    await $.tool.register({
      name: "goal_add",
      description:
        "Add a node (plan or task) to the goal tree. Plans go under the root; tasks go under a plan. " +
        "If parentId is omitted, the parent is the active leaf when it is a plan, otherwise the active task's parent.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "One-line title for the new node.",
          },
          objective: {
            type: "string",
            description: "What done looks like.",
          },
          parentId: {
            type: "string",
            description: "Optional. The id of the parent node.",
          },
          kind: {
            type: "string",
            description: '"task" (default) or "plan". "plan" is only allowed under the root.',
          },
          maxRounds: {
            type: "number",
            description: "Round budget. Default 10.",
          },
        },
        required: ["title", "objective"],
      },
    });

    await $.tool.register({
      name: "goal_done",
      description:
        "Mark the active goal leaf as complete. The controller activates the next pending plan or fires the planner. " +
        "Call when the current step is finished.",
      inputSchema: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "One-line note about why this is done.",
          },
        },
      },
    });

    await $.tool.register({
      name: "goal_status",
      description: "Show the current goal tree as formatted text. Read-only; works for passive readers.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });

    await $.tool.register({
      name: "goal_resume",
      description:
        "Resume a paused goal leaf. If no node is active, resumes the most recently paused node. " +
        "Resets the nudge budget. Owner only.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            description: "Optional. The id of the paused node to resume. Defaults to the most recently paused node.",
          },
        },
      },
    });

    await $.tool.register({
      name: "supervisor_shutdown",
      description:
        "Stop the supervisor itself, not just the current goal. Use ONLY when the operator " +
        "explicitly asks to shut down, stop the supervisor, or end the session for good - never " +
        "for a completed goal (goal_done already returns the supervisor to its passive waiting " +
        "state for the next one). The child exits by the graceful EOF path. Owner only.",
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Optional. Why the operator asked to shut down.",
          },
        },
      },
    });

    await $.tool.register({
      name: "goal_edit",
      description:
        "Steer the goal tree in response to an operator request: drop a pending plan or task " +
        "(marks it abandoned, it is never activated), pause an active or pending node with a " +
        "reason (use goal_resume to continue it later), or reprioritize a pending node so it " +
        "activates before its siblings. Owner only.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            description: "The id of the node to change (see goal_status).",
          },
          action: {
            type: "string",
            description: '"drop" | "pause" | "reprioritize"',
          },
          reason: {
            type: "string",
            description: "Why (recorded as the node's blockedReason for pause/drop).",
          },
        },
        required: ["nodeId", "action"],
      },
    });

    await $.tool.register({
      name: "memory_add",
      description:
        "Add a memory entry to this persona's durable store. Use for facts, preferences, or lessons the worker should remember across sessions. Distill to one clear, self-contained statement.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "A short, self-contained statement (one fact, preference, or lesson).",
          },
          kind: {
            type: "string",
            description: 'Memory kind: "fact", "preference", or "lesson".',
          },
          confidence: {
            type: "number",
            description: "Confidence 0-1. Default 0.7.",
          },
        },
        required: ["text"],
      },
    });

    // D2: Reader tools (plan signatures: agentic_say(text, answers?), agentic_inbox())
    await $.tool.register({
      name: "agentic_say",
      description:
        "Send a message to the owner session of this persona. The reader session calls this to send text to the owner. " +
        "The owner will see the message on its next quiet tick. Use for steering, reporting, or asking questions.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The message to send to the owner.",
          },
          answers: {
            type: "string",
            description: "Optional: the ask id (from agentic_inbox) to answer. Answer an open ask with agentic_say(text, answers: <id>).",
          },
        },
        required: ["text"],
      },
    });

    await $.tool.register({
      name: "agentic_inbox",
      description:
        "Read replies from the owner session of this persona. The reader session calls this to poll for replies to its messages. " +
        "Returns {inbox: [{id, from, at, text, kind, status, reply?}], asks: [{id, at, nodeId, question, status}]}. " +
        "Answer an open ask with agentic_say(text, answers: <ask id>).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    });

    // --- Claim or join the persona based on liveness (heartbeat sidecar) ---
    const existing = await $.fs.exists(storePath)
      ? JSON.parse(await $.fs.read(storePath))
      : {};
    const existingPersona = existing[sess.persona];

    if (existingPersona) {
      sess.state = parseState(JSON.stringify(existingPersona));
      sess.state.persona = sess.persona;

      // Check the heartbeat sidecar for liveness (not the store).
      let holderHb: { sessionId: string; epoch: number; lastSeen: number } | null = null;
      try {
        if (await $.fs.exists(heartbeatPath)) {
          const hb = JSON.parse(await $.fs.read(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>;
          holderHb = hb[sess.persona] ?? null;
        }
      } catch { /* heartbeat read failed */ }
      const now = Date.now();
      const holderAlive = holderHb
        && holderHb.sessionId !== sess.mySessionId
        && (now - holderHb.lastSeen) <= staleAfterMs;

      if (!holderAlive) {
        // Claim: stale holder, no heartbeat, or already ours.
        sess.state.activeSessionId = sess.mySessionId;
        sess.state.epoch += 1;
        sess.myEpoch = sess.state.epoch;
        sess.isOwner = true;
        const prevId = holderHb?.sessionId ?? existingPersona.activeSessionId;
        sess.state.decisions.push({
          timestamp: now,
          loop: "monitor",
          action: "persona_claim",
          detail: `Claimed '${sess.persona}' (new ${sess.mySessionId}, prev ${prevId}, epoch ${existingPersona.epoch}${holderAlive ? "" : ", stale"})`,
        });
        // AD1: Write the stale-takeover claim directly to the store so that
        // the subsequent persist() call finds the new holder, not the dead one.
        await writeClaimDirect($);
      } else {
        // Passive reader: another session holds it and is alive.
        sess.isOwner = false;
        sess.myEpoch = existingPersona.epoch;
        sess.state.decisions.push({
          timestamp: now,
          loop: "monitor",
          action: "passive_reader",
          detail: `Joining '${sess.persona}' as reader (holder: ${holderHb!.sessionId}, epoch ${existingPersona.epoch})`,
        });
        // D2: Claim the reader role
        await claimReaderRole(commonsStoreOf($), sess.persona, sess.mySessionId);
      }
    } else {
      sess.state = createDefaultState(sess.persona, sess.mySessionId);
      sess.isOwner = true;
      sess.myEpoch = sess.state.epoch;
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "monitor",
        action: "persona_create",
        detail: `Created persona '${sess.persona}'`,
      });
    }

    sess.state.monitor.sessionStart = Date.now();
    sess.state.monitor.turnCount = 0;
    sess.state.monitor.totalToolCalls = 0;
    sess.state.monitor.errors = 0;
    // Reset the idle clock: a persisted lastTurnComplete would make the
    // first tick look like hours of idle time.
    sess.state.monitor.lastTurnComplete = Date.now();

    await persist($);

    // Write the initial heartbeat. L3: owner-only, a passive reader must not
    // stamp its own id over the holder's heartbeat.
    if (sess.isOwner) {
      try {
        const hb: Record<string, { sessionId: string; epoch: number; lastSeen: number }> =
          await $.fs.exists(heartbeatPath)
            ? (JSON.parse(await $.fs.read(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>)
            : {};
        hb[sess.persona] = { sessionId: sess.mySessionId, epoch: sess.myEpoch, lastSeen: Date.now() };
        await $.fs.write(heartbeatPath, JSON.stringify(hb, null, 2));
      } catch { /* heartbeat write failed; non-fatal */ }
      // BC3: claim the persona in commons at start, so the owner holds the
      // commons claim before its first turn. Without this, a reader calling
      // agentic_identity in the first 30s (before the first heartbeat) finds
      // no live persona:default claim and takes ownership, evicting the owner.
      try {
        const resource = `persona:${sess.persona}`;
        await claimResource(commonsStoreOf($), resource, sess.mySessionId);
      } catch { /* non-fatal */ }
      // BD3 part 3: expire open asks from prior owners. The owner that opened
      // them is gone or restarted; its pendingAskId is gone with it.
      try {
        const expired = await expireOpenAsks(commonsStoreOf($), sess.persona);
        for (const askId of expired) {
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "ask_expired",
            detail: `${sess.persona}: ${askId} (owner restart)`,
          });
        }
        if (expired.length > 0) {
          await persist($);
        }
      } catch { /* non-fatal */ }
    }

    $.ui.log(`Agentic: persona '${sess.persona}', ${sess.state.memory.length} memories, ${sess.isOwner ? "owner" : "passive reader"}`);

    // Note: $ is available in the timer callback scope (session.start hook).

    // --- Heartbeat: refresh the sidecar every heartbeatMs ---
    // Only the owner stamps its own heartbeat. A passive reader must NOT
    // overwrite the holder's heartbeat, or it will (a) mask the real holder's
    // staleness and (b) make its own promotion check compare the holder id to
    // itself and never fire.
    $.clock.every(heartbeatMs, async () => {
        // The heartbeat tick verifies ownership BEFORE stamping.
        // If the store's (sessionId, epoch) no longer matches this session,
        // another session has claimed the persona and this one must yield
        // here, not on its next guarded write. Without this check a demoted
        // owner keeps stamping its own id over the new owner's heartbeat,
        // and the sidecar ends up naming a session the store does not.
        if (sess.isOwner) {
          let onDisk: { activeSessionId: string; epoch: number } | null = null;
          try {
            if (await $.fs.exists(storePath)) {
              const store = JSON.parse(await $.fs.read(storePath)) as Record<string, unknown>;
              const existing = store[sess.persona] as AgentState | undefined;
              if (existing) onDisk = existing;
            }
          } catch { /* store read failed */ }

          if (onDisk && shouldYield(onDisk, sess.mySessionId, sess.myEpoch)) {
            await yieldNow($, onDisk);
            // Do NOT stamp: fall through to the reader check below.
          } else {
            try {
              const hb: Record<string, { sessionId: string; epoch: number; lastSeen: number }> =
                await $.fs.exists(heartbeatPath)
                  ? (JSON.parse(await $.fs.read(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>)
                  : {};
              hb[sess.persona] = { sessionId: sess.mySessionId, epoch: sess.myEpoch, lastSeen: Date.now() };
              await $.fs.write(heartbeatPath, JSON.stringify(hb, null, 2));
            } catch { /* heartbeat write failed */ }
            // Commons: refresh lastSeen to signal liveness (Stage 2 integration).
            try {
              const resource = `persona:${sess.persona}`;
              await claimResource(commonsStoreOf($), resource, sess.mySessionId);
            } catch { /* non-fatal */ }
          }
        }

        // BE3: non-owner heartbeat tick refreshes the reader claim (idempotent).
        // Without this, the reader claim goes stale at 90s and agentic_inbox
        // denies the reader.
        if (!sess.isOwner) {
          try {
            await claimReaderRole(commonsStoreOf($), sess.persona, sess.mySessionId);
          } catch { /* non-fatal */ }
        }

        // Passive reader: promote if the sidecar holder is stale and not self.
        // With the shouldYield check above, the sidecar is only ever
        // written by the store's current owner, so a stale sidecar means no
        // live owner, no store-owner comparison needed.
        if (!sess.isOwner) {
          let holderHb: { sessionId: string; epoch: number; lastSeen: number } | null = null;
          try {
            if (await $.fs.exists(heartbeatPath)) {
              const hb = JSON.parse(await $.fs.read(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>;
              holderHb = hb[sess.persona] ?? null;
            }
          } catch { /* heartbeat read failed */ }

          const now = Date.now();
          const holderIsStale = holderHb && (now - holderHb.lastSeen) > staleAfterMs;
          const holderIsSelf = holderHb?.sessionId === sess.mySessionId;
          if (holderIsStale && !holderIsSelf) {
            // BE1: check commons before promoting. If a live claim exists
            // on the persona from anyone, stay reader and do not bump epoch.
            try {
              const claims = await readAllClaims(commonsStoreOf($), staleAfterMs);
              const personaResource = `persona:${sess.persona}`;
              const commonsWinner = claims.find(
                (c) => c.resource === personaResource && c.holder !== sess.mySessionId
              );
              if (commonsWinner) {
                const alreadyLogged = sess.state.decisions.some(
                  (d) => d.action === "promotion_deferred_commons" && d.detail?.includes(commonsWinner.holder)
                );
                if (!alreadyLogged) {
                  sess.state.decisions.push({
                    timestamp: now,
                    loop: "monitor",
                    action: "promotion_deferred_commons",
                    detail: `Deferring promotion: live commons claim by ${commonsWinner.holder}`,
                  });
                  // Persist the decision to disk (reader path, so persist() won't work).
                  // Merge, never replace: read existing slot, push decision onto it, write back.
                  try {
                    const store: Record<string, unknown> = await $.fs.exists(storePath)
                      ? (JSON.parse(await $.fs.read(storePath)) as Record<string, unknown>)
                      : {};
                    const existing = store[sess.persona] as AgentState | undefined;
                    if (existing) {
                      // Push the new decision onto the existing slot's decisions
                      const existingDecisions = existing.decisions ?? [];
                      existingDecisions.push({
                        timestamp: now,
                        loop: "monitor",
                        action: "promotion_deferred_commons",
                        detail: `Deferring promotion: live commons claim by ${commonsWinner.holder}`,
                      });
                      existing.decisions = existingDecisions;
                      existing.updatedAt = now;
                      store[sess.persona] = existing;
                    } else {
                      // No existing slot; use current state but preserve its decisions
                      sess.state.updatedAt = now;
                      store[sess.persona] = sess.state;
                    }
                    const jsonStr = JSON.stringify(store, null, 2);
                    await $.fs.write(storePath, jsonStr);
                  } catch { /* non-fatal */ }
                }
                return;
              }
            } catch { /* commons check failed; proceed with local-only promotion */ }
            const store: Record<string, unknown> = await $.fs.exists(storePath)
              ? (JSON.parse(await $.fs.read(storePath)) as Record<string, unknown>)
              : {};
            const existing = store[sess.persona] as AgentState | undefined;
            if (existing) {
              sess.state = parseState(JSON.stringify(existing));
              sess.state.persona = sess.persona;
            } else {
              sess.state = createDefaultState(sess.persona, sess.mySessionId);
            }
            sess.state.activeSessionId = sess.mySessionId;
            sess.state.epoch += 1;
            sess.myEpoch = sess.state.epoch;
            sess.isOwner = true;
            sess.state.decisions.push({
              timestamp: now,
              loop: "monitor",
              action: "reader_promoted",
              detail: `Promoted from reader to owner (prev ${holderHb?.sessionId ?? "unknown"}, stale after ${now - (holderHb?.lastSeen ?? now)}ms)`,
            });
            // AD1: Write the stale-takeover claim directly to the store so that
            // the subsequent persist() call finds the new holder, not the dead one.
            await writeClaimDirect($);
            $.ui.log(`Agentic: promoted to owner of '${sess.persona}' (previous holder stale)`);
          }
        }
    });

    // --- PIANO CONTROLLER TICK (v3, goal-tree) ---
    // R1 order: owner check → in-flight check → planning gate →
    //   "no active leaf, return" → idle gate → classify.
    // Eligibility in code. The model decides WHAT, never WHETHER.
    // Cap counts *sent* nudges only, resets only on on-goal or complete.
    $.clock.every(controllerTickMs, async () => {
      // 1. Owner check.
      if (!sess.isOwner) return;
      // 2. In-flight check.
      if (turnInFlight) return;

      // D3: drain operator inbox (one record per tick, owner only).
      // List pending inbox records whose writer holds a live reader claim,
      // take the lowest at, mark delivered, submit as [OPERATOR] prompt.
      // D5: if a pending record answers the open ask, close the ask first
      // (ask_answered path) before the general drain.
      if (sess.isOwner) {
        const persona = sess.persona;
        const store = commonsStoreOf($);
        const allRecords = await listInboxRecords(store, persona);
        const pending = allRecords.filter((rec) => rec.status === "pending");

        // D5: check for an answering record that closes the open ask (before general drain)
        if (sess.state.pendingAskId && pending.length > 0) {
          const askId = sess.state.pendingAskId;
          const askRecord = await readAskRecord(store, persona, askId);
          if (askRecord && askRecord.status === "open") {
            const answer = pending.find((rec) => rec.answers === askId);
            if (answer) {
              const answerAlive = await hasLiveReaderClaim(store, persona, answer.from);
              if (!answerAlive) {
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "monitor",
                  action: "operator_skipped_no_claim",
                  detail: `answer ${answer.id} from ${answer.from} has no live reader claim`,
                });
              } else {
                // Close the ask
                askRecord.status = "answered";
                await store.set(askKey(persona, askId), askRecord);
                // D5b: remember the closed question so the classifier does
                // not reopen it on this node right away (bullet 2).
                const askedNodeInbox = sess.state.goals.find((n) => n.id === askRecord.nodeId);
                if (askedNodeInbox) {
                  askedNodeInbox.lastAskQuestion = askRecord.question;
                  askedNodeInbox.lastAskClosedAt = Date.now();
                }
                // Mark the answer as delivered
                answer.status = "delivered";
                answer.deliveredAt = Date.now();
                const existing = await store.get(answer.key);
                if (existing) {
                  const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
                  parsed.status = "delivered";
                  parsed.deliveredAt = answer.deliveredAt;
                  await store.set(answer.key, parsed);
                }
                // Clear the pendingAskId
                sess.state.pendingAskId = undefined;
                // Deliver the answer as an [OPERATOR] prompt
                // Look up the goal by the ask record's nodeId (more reliable than activeGoalId,
                // which enforceInvariants may have cleared for a paused goal).
                const askRecord2 = askRecord; // from outer scope
                const targetNode = askRecord2?.nodeId
                  ? sess.state.goals.find((g) => g.id === askRecord2.nodeId)
                  : null;
                const activeNode = targetNode || (sess.state.activeGoalId
                  ? sess.state.goals.find((g) => g.id === sess.state.activeGoalId)
                  : null);
                if (activeNode && activeNode.status === "paused") {
                  activeNode.status = "active";
                  activeNode.updatedAt = Date.now();
                  sess.state.decisions.push({
                    timestamp: Date.now(),
                    loop: "goal",
                    action: "activated",
                    detail: `${activeNode.id}: reactivated (answer to ask ${askId})`,
                  });
                }
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "monitor",
                  action: "ask_answered",
                  detail: `ask ${askId} closed by record ${answer.id}`,
                });
                await $.prompt.submit({ text: `[OPERATOR] Answer to ${askRecord.question}: ${answer.text}` });
                await persist($);
                return;
              }
            }
          }
        }

        // General drain (D3)
        // Filter to writers with live reader claims
        const withClaim: typeof pending = [];
        const withoutClaim: typeof pending = [];
        for (const rec of pending) {
          const alive = await hasLiveReaderClaim(store, persona, rec.from);
          if (alive) withClaim.push(rec);
          else withoutClaim.push(rec);
        }
        // Push one operator_skipped_no_claim decision per record without a claim
        for (const rec of withoutClaim) {
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "operator_skipped_no_claim",
            detail: `record ${rec.id} writer ${rec.from} has no live reader claim`,
          });
        }
        // Take the oldest record with a live claim
        if (withClaim.length > 0) {
          withClaim.sort((a, b) => a.at - b.at);
          const oldest = withClaim[0];
          oldest.status = "delivered";
          oldest.deliveredAt = Date.now();
          const existing = await store.get(oldest.key);
          if (existing) {
            const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
            parsed.status = "delivered";
            parsed.deliveredAt = oldest.deliveredAt;
            await store.set(oldest.key, parsed);
          }
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "operator_delivered",
            detail: `record ${oldest.id} submitted as [OPERATOR]`,
          });
          await $.prompt.submit({ text: "[OPERATOR] " + oldest.text });
          await persist($);
          return; // One record per tick
        }
      }

      // D4: increment tick index for backoff and cost_summary cadence.
      sess.controllerTickCount = (sess.controllerTickCount ?? 0) + 1;
      const tickIndex = sess.controllerTickCount;

      // D1: emit cost_summary on cadence (AJ2: at top of tick, independent of idle gate).
      const costSummaryEveryNTicks = typeof cfg.costSummaryEveryNTicks === "number" ? (cfg.costSummaryEveryNTicks as number) : 20;
      if (tickIndex % costSummaryEveryNTicks === 0) {
        const cost = sess.state.monitor.cost;
        const totalEstTokens = cost.classify.estTokens + cost.reason.estTokens + cost.selfReview.estTokens + cost.planner.estTokens;
        const totalCalls = cost.classify.count + cost.reason.count + cost.selfReview.count + cost.planner.count + cost.nudge.count;
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "cost_summary",
          detail: `classify:${cost.classify.count} reason:${cost.reason.count} selfReview:${cost.selfReview.count} planner:${cost.planner.count} nudge:${cost.nudge.count} estTokens:${totalEstTokens} totalCalls:${totalCalls}`,
        });
        await persist($);

        // AT5: Sweep expired operator records on the summary cadence (owner only)
        if (sess.isOwner) {
          const ttlMs = typeof cfg.operatorRecordTtlMs === "number" ? (cfg.operatorRecordTtlMs as number) : 86400000;
          const swept = await sweepExpiredRecords(commonsStoreOf($), sess.persona, ttlMs);
          if (swept > 0) {
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "worker",
              action: "sweep_expired_records",
              detail: `swept ${swept} expired operator records (persona: ${sess.persona})`,
            });
          }
        }
      }

      // 2a. C3: error streak branch (before the idle gate; H1: move out of the classify path).
      // F6: route through the ask-operator path (paused, not blocked).
      // Re-fire rule: only when a new error occurred after handledAt.
      const envErrors = sess.state.monitor.env.errors;
      if (envErrors.consecutiveErrorTurns >= 3 && (!envErrors.handledAt || (envErrors.lastErrorAt && envErrors.lastErrorAt > envErrors.handledAt))) {
        const streakTs = Date.now();
        const streakReason = `Error streak ${envErrors.consecutiveErrorTurns} turns; escalating`;
        envErrors.handledAt = streakTs;
        // Look up the active node for the decision detail; if none, still log + toast + handledAt.
        const activeForStreak = sess.state.goals.find((n) => n.status === "active");
        const nodeId = activeForStreak ? activeForStreak.id : "no-active-node";
        sess.state.decisions.push({
          timestamp: streakTs,
          loop: "monitor",
          action: "error_streak",
          detail: `${nodeId}: ${streakReason}`,
        });
        // D5: write an ask record and set pendingAskId
        const askId = `ask-${nodeId}-${Date.now()}`;
        await writeAskRecord(commonsStoreOf($), sess.persona, askId, nodeId, streakReason, sess.mySessionId);
        sess.state.pendingAskId = askId;
        sess.state.decisions.push({
          timestamp: streakTs,
          loop: "monitor",
          action: "ask_opened",
          detail: `${nodeId}: error-streak: ${streakReason} (ask ${askId})`,
        });
        try { $.ui.toast(`Agentic: ${streakReason}`); } catch { /* non-fatal */ }
        if (activeForStreak && activeForStreak.status === "active") {
          activeForStreak.status = "paused";
          activeForStreak.blockedReason = streakReason;
          activeForStreak.updatedAt = streakTs;
          sess.state.decisions.push({
            timestamp: streakTs,
            loop: "goal",
            action: "paused_by_controller",
            detail: `${nodeId}: ${streakReason}`,
          });
          try { $.ui.status(""); } catch { /* non-fatal */ }
        }
        sess.state.updatedAt = streakTs;
        await persist($);
      }

      // 2a2. Self-review (S9: single execution site in the tick handler).
      if (sess.state.monitor.selfReview) {
        const sr = sess.state.monitor.selfReview;
        const now = Date.now();

        // S10: reset the hourly cap when the window has expired.
        if (sr.windowStart > 0 && now - sr.windowStart >= 3600000) {
          sr.count = 0;
          sr.windowStart = now;
        }

        const srOpts = { selfReviewStreak, selfReviewEveryTurns, selfReviewDebounceTurns, selfReviewMaxPerHour };
        // Reactive check (error streak trigger).
        const reactive = shouldSelfReview(
          { monitor: sess.state.monitor, decisions: sess.state.decisions, memory: sess.state.memory, goals: sess.state.goals, activeGoalId: sess.state.activeGoalId },
          srOpts, now, "reactive",
        );
        // Periodic check (pendingPeriodic or turnsSince >= everyTurns).
        const periodic = shouldSelfReview(
          { monitor: sess.state.monitor, decisions: sess.state.decisions, memory: sess.state.memory, goals: sess.state.goals, activeGoalId: sess.state.activeGoalId },
          srOpts, now, "periodic",
        );

        if (reactive.eligible || periodic.eligible) {
          const trigger = reactive.eligible ? reactive.reason : periodic.reason;
          try {
            const input = buildSelfReviewInput(
              { monitor: sess.state.monitor, decisions: sess.state.decisions, memory: sess.state.memory, goals: sess.state.goals, activeGoalId: sess.state.activeGoalId },
              now,
            );
            const raw = await $.model.complete({ model: "haiku", prompt: input.prompt, maxTokens: 80 });
            // D1: increment self-review ledger
            sess.state.monitor.cost.selfReview.count += 1;
            sess.state.monitor.cost.selfReview.estTokens += estimateTokens(input.prompt.length, 80);
            const lesson = raw.trim();
            if (lesson.length > 0 && lesson.toUpperCase() !== "NONE") {
              if (!dedupeSelfReview(sess.state.memory, lesson)) {
                const entryId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                sess.state.memory.push({
                  id: entryId,
                  kind: "lesson",
                  text: lesson,
                  confidence: 0.5,
                  source: "self-review",
                  createdAt: Date.now(),
                  lastAccessed: Date.now(),
                  accessCount: 0,
                  pinned: false,
                  provenance: {
                    decisionTimestamps: input.decisionTimestamps,
                    windowRange: input.decisionTimestamps.length > 0
                      ? [input.decisionTimestamps[0], input.decisionTimestamps[input.decisionTimestamps.length - 1]]
                      : undefined,
                    streak: input.streak,
                    trigger: trigger,
                  },
                });
                // Evict old self-review lessons (S8: keep max 5, never touch pinned).
                evictSelfReview(sess.state.memory, 5);
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "monitor",
                  action: "self-review",
                  detail: `${trigger}: ${lesson.slice(0, 80)}`,
                });
              } else {
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "monitor",
                  action: "self-review",
                  detail: `${trigger}: dupe, skipped`,
                });
              }
            } else {
              sess.state.decisions.push({
                timestamp: Date.now(),
                loop: "monitor",
                action: "self-review",
                detail: `${trigger}: NONE`,
              });
            }
            // Update selfReview state after review.
            sr.count += 1;
            if (sr.windowStart === 0) sr.windowStart = now;
            sr.lastAt = now;
            sr.turnsSince = 0;
            sr.pendingPeriodic = false;
          } catch {
            // Self-review failed; non-fatal.
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "monitor",
              action: "self-review",
              detail: `${trigger}: error`,
            });
          }
          sess.state.updatedAt = now;
          await persist($);
        }
      }

      // 2b. Git probe (E4, C6): time-based cadence, fire-and-forget.
      if (!gitProbeInFlight && !gitUnavailable) {
        const env = sess.state.monitor.env;
        const now = Date.now();
        const gitProbeMs = sess.options.gitProbeMs ?? 120000;
        if (env.git === null || now - env.git.sampledAt >= gitProbeMs) {
          gitProbeInFlight = true;
          $.process.run(["git", "status", "--porcelain=v1", "-b"])
            .then((res) => {
              if (res.exitCode === 0) {
                const lines = (res.stdout || "").split("\n").filter((l) => l.trim());
                const branchLine = lines.find((l) => l.startsWith("## "));
                const branch = branchLine ? branchLine.slice(3).split(" ")[0] : "unknown";
                const dirty = lines.filter((l) => !l.startsWith("## ") && l.trim()).length;
                let ahead = 0;
                let behind = 0;
                // Parse ahead/behind from the branch line if present.
                if (branchLine) {
                  const aheadMatch = branchLine.match(/ahead (\d+)/);
                  const behindMatch = branchLine.match(/behind (\d+)/);
                  if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
                  if (behindMatch) behind = parseInt(behindMatch[1], 10);
                }
                return $.process.run(["git", "log", "-1", "--format=%ct"]).then((logRes) => {
                  const lastCommitAt = logRes.exitCode === 0 ? parseInt((logRes.stdout || "0").trim(), 10) * 1000 : 0;
                  const newGit: EnvGit = { branch, dirty, ahead, behind, lastCommitAt, sampledAt: Date.now() };
                  const prevGit = env.git;
                  if (prevGit === null || prevGit.dirty !== dirty || prevGit.branch !== branch) {
                    const detail = prevGit === null
                      ? `env_git first sample dirty=${dirty} branch ${branch}`
                      : `env_git dirty=${dirty} (was ${prevGit.dirty}) branch ${branch}`;
                    sess.state.decisions.push({
                      timestamp: Date.now(),
                      loop: "monitor",
                      action: "env_git",
                      detail,
                    });
                  }
                  sess.state.monitor.env.git = newGit;
                });
              } else if (res.exitCode === 128) {
                // F7: non-git cwd confirmed; stop probing for the session.
                if (!gitUnavailable) {
                  gitUnavailable = true;
                  sess.state.decisions.push({
                    timestamp: Date.now(),
                    loop: "monitor",
                    action: "env_git_null",
                    detail: `env_git_null exit 128`,
                  });
                }
              } else {
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "monitor",
                  action: "env_git_error",
                  detail: `env_git_error exit ${res.exitCode}`,
                });
              }
            })
            .catch(() => { /* non-fatal */ })
            .finally(() => { gitProbeInFlight = false; });
        }
      }

      // Get the active node.
      const activeNode = sess.state.activeGoalId
        ? sess.state.goals.find((g) => g.id === sess.state.activeGoalId)
        : null;
      const root = sess.state.goals.find((g) => g.parentId === null);

      // 3. Planning gate (R1, R5): planning runs here, NOT in a tool handler.
      // Due when root exists, not complete/abandoned, and no
      // pending/active/paused descendants.
      // M8: reentrancy guard: a planner call slower than one tick must not fire twice.
      if (isPlanningDue(sess.state) && !planningInFlight) {
        planningInFlight = true;
        try {
          const planTs = Date.now();
          sess.state.decisions.push({
            timestamp: planTs,
            loop: "goal",
            action: "planning_fired",
            detail: `Root ${root!.id} has no pending/active/paused descendants; planning`,
          });

          // H5 / M15: cap check BEFORE the model call.
          // The blocked-planning streak is evaluated over the PREVIOUS planning
          // round's plans only (planningRound === planningRounds - 1), never
          // over every node the root has ever produced. A completed plan from an
          // earlier round therefore cannot mask two consecutive all-blocked
          // rounds, and a stale blocked node cannot mask a fresh round.
          const prevBlocked = previousRoundBlocked(root!, sess.state.goals);
          if (prevBlocked) {
            root!.consecutiveBlockedPlannings = (root!.consecutiveBlockedPlannings || 0) + 1;
          } else {
            root!.consecutiveBlockedPlannings = 0;
          }
          const capReason = planningCapReached(root!, root!.consecutiveBlockedPlannings);
          if (capReason) {
            root!.status = "blocked";
            root!.blockedReason = capReason;
            root!.updatedAt = Date.now();
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "goal",
              action: "block",
              detail: `Root ${root!.id}: ${capReason}`,
            });
            try { $.ui.toast(`Agentic: root blocked: planning cap reached`); } catch { /* non-fatal */ }
            try { $.ui.status(""); } catch { /* non-fatal */ }
            await persist($);
            return;
          }

          // R2: re-read the roadmap file at every planning event.
          let roadmapText = "";
          const rp = root!.roadmapPath;
          if (rp) {
            try {
              if (await $.fs.exists(rp)) {
                roadmapText = await $.fs.read(rp);
              }
            } catch { /* roadmap unreadable; planner gets empty text */ }
          }

          // Planning call: Haiku complete, JSON array of plans.
          // H3-part2: carry history and a cap in the prompt.
          const completedPlans = sess.state.goals.filter((g) => g.parentId === root!.id && g.status === "complete");
          const blockedPlans = sess.state.goals.filter((g) => g.parentId === root!.id && g.status === "blocked");
          const abandonedPlans = sess.state.goals.filter((g) => g.parentId === root!.id && g.status === "abandoned");
          const historyLines: string[] = [];
          for (const cp of completedPlans) {
            const lastNote = cp.notes.length > 0 ? cp.notes[cp.notes.length - 1] : "no note";
            historyLines.push(`Completed: ${cp.title}: ${lastNote}`);
          }
          for (const bp of blockedPlans) {
            historyLines.push(`Blocked: ${bp.title}: ${bp.blockedReason || "unknown"}`);
          }
          for (const ap of abandonedPlans) {
            historyLines.push(`Abandoned: ${ap.title}`);
          }
          const historyBlock = historyLines.length > 0 ? `\n${historyLines.join("\n")}\n\n` : "";
          const planPrompt =
            `You are the planner for an agentic plugin. ` +
            `The operator's objective is: "${root!.objective}".\n\n` +
            (roadmapText
              ? `Roadmap file content:\n${roadmapText}\n\n`
              : "") +
            historyBlock +
            `Create a plan of 0 to 7 steps to accomplish the objective.\n` +
            (roadmapText
              ? `When a roadmap is provided, produce exactly one plan per numbered roadmap item.\n`
              : "") +
            `Return a JSON array. Each element: {"title": string, "objective": string, "maxRounds": number (5-20)}.\n` +
            `Return [] (empty array) if the objective and roadmap are fully met by the completed items.\n` +
            `Never repeat a completed item. A blocked item may be retried at most once with a different approach.\n` +
            `Return a JSON array only: no prose, no markdown fences.`;

          // H4 / M14: planner fault injection via a single cwd-relative file
          // flag, beside the store path (which also resolves cwd-relative).
          // A file named .agentic-planner-fault makes the planner return "not
          // json" so parsing fails. The test runs with cwd = harness root, the
          // same cwd the store resolves against, so the flag belongs there.
          let fault = false;
          try { if (await $.fs.exists(".agentic-planner-fault")) { fault = true; } } catch { /* non-fatal */ }

          // M13: a failing planner is capped. Each call/parse failure increments
          // the root counter and persists; at 3 the root is blocked so the
          // planner is not retried every tick. A successful planning round
          // (created or complete) resets it.
          const registerPlanningFailure = async (detail: string): Promise<void> => {
            const rootNow = sess.state.goals.find((g) => g.id === root!.id);
            if (rootNow) {
              rootNow.consecutivePlanningFailures = (rootNow.consecutivePlanningFailures || 0) + 1;
            }
            const failCount = rootNow?.consecutivePlanningFailures || 0;
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "goal",
              action: "planning_failed",
              detail,
            });
            if (rootNow && failCount >= 3 && rootNow.status !== "blocked") {
              rootNow.status = "blocked";
              rootNow.blockedReason = `Planner failing: ${detail}`;
              rootNow.updatedAt = Date.now();
              sess.state.decisions.push({
                timestamp: Date.now(),
                loop: "goal",
                action: "block",
                detail: `Root ${rootNow.id}: Planner failing after ${failCount} consecutive failures`,
              });
              try { $.ui.toast(`Agentic: root blocked: planner failing`); } catch { /* non-fatal */ }
              try { $.ui.status(""); } catch { /* non-fatal */ }
            }
            await persist($);
          };

          // H4: AGENTIC_PLANNER_FAULT file flag replaces the raw response with "not json".
          let raw: string;
          try {
            raw = await $.model.complete({
              model: "haiku",
              prompt: planPrompt,
              maxTokens: 1500,
            });
            // D1: increment planner ledger
            sess.state.monitor.cost.planner.count += 1;
            sess.state.monitor.cost.planner.estTokens += estimateTokens(planPrompt.length, 1500);
          } catch (e) {
            await registerPlanningFailure(`Planner call failed: ${String(e).slice(0, 150)}`);
            return;
          }
          if (fault) {
            raw = "not json";
          }

          // H4: parsed flag set only when JSON.parse returns an array.
          let plans: Array<{ title: string; objective: string }> = [];
          let parsedOk = false;
          try {
            const trimmed = raw.trim().replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              plans = parsed
                .filter((p) => p && typeof p.title === "string" && typeof p.objective === "string")
                .slice(0, 7);
              parsedOk = true;
            }
          } catch { /* parse failed */ }

          if (!parsedOk) {
            // H4: parse failure is not "objective met".
            await registerPlanningFailure(`Planner parse failure: ${raw.slice(0, 100)}`);
            return;
          }

          if (plans.length === 0) {
            // Objective met or nothing to plan: complete the root.
            const rootNow = sess.state.goals.find((g) => g.id === root!.id);
            if (rootNow && rootNow.status !== "complete" && rootNow.status !== "abandoned") {
              rootNow.status = "complete";
              rootNow.updatedAt = Date.now();
            }
            // M13: a successful planning round clears the failure streak.
            if (rootNow) rootNow.consecutivePlanningFailures = 0;
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "goal",
              action: "planning_complete",
              detail: `Planner returned 0 plans`,
            });
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "goal",
              action: "root_complete",
              detail: `Root ${root!.id} marked complete`,
            });
            try { await $.audio.speak("Goal complete"); } catch { /* no audio */ }
            sess.consecutiveNudgesWithoutOnGoal = 0;
            sess.lastNudgeAt = 0;
            try { $.ui.status(""); } catch { /* non-fatal */ }
          } else {
            // Create plan nodes under the root.
            // L9: per-plan maxRounds from the planner, defaulting to root.maxRounds.
            // H3-part2: increment planningRounds on the root.
            for (const p of plans) {
              const perPlanMaxRounds = typeof (p as any).maxRounds === "number"
                ? Math.min(Math.max((p as any).maxRounds, 5), 20)
                : (root!.maxRounds > 0 ? root!.maxRounds : 10);
              const node: GoalNode = {
                id: `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                parentId: root!.id,
                kind: "plan",
                title: p.title.slice(0, 80),
                objective: p.objective.slice(0, 500),
                status: "pending",
                source: "controller",
                maxRounds: perPlanMaxRounds,
                completedRounds: 0,
                scores: [],
                notes: [],
                planningRounds: 0,
                consecutiveBlockedPlannings: 0,
                consecutivePlanningFailures: 0,
                planningRound: root!.planningRounds || 0, // M15: which round created this plan
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              sess.state.goals.push(node);
            }
            // H3-part2: count this planning round on the root.
            root!.planningRounds = (root!.planningRounds || 0) + 1;
            // M13: a successful planning round clears the failure streak.
            root!.consecutivePlanningFailures = 0;

            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "goal",
              action: "planning_created",
              detail: `${plans.length} plans under root ${root!.id}: ${plans.map((p) => p.title.slice(0, 30)).join("; ")}`,
            });

            // BM2: Check planner variance (flag, not trim)
            if (roadmapText) {
              // Count numbered items in the roadmap
              const numberedItems = roadmapText.match(/^\d+\./gm) || [];
              const roadmapCount = numberedItems.length;
              if (plans.length !== roadmapCount) {
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "goal",
                  action: "planner_variance",
                  detail: `planner ${plans.length}, roadmap ${roadmapCount}`,
                });
              }
            }

            // Activate the first plan.
            const firstPlan = sess.state.goals.find((g) => g.parentId === root!.id && g.status === "pending");
            if (firstPlan) {
              firstPlan.status = "active";
              firstPlan.updatedAt = Date.now();
              sess.state.activeGoalId = firstPlan.id;
              activate($, firstPlan.id, `Plan ${firstPlan.id} "${firstPlan.title}" activated`);
            }
          }

          await persist($);
        } catch {
          // Planning failed; non-fatal.
        } finally {
          planningInFlight = false;
        }
        return; // Planning gate consumed this tick.
      }

      // 3.5. Context budget (2b): read on a sub-cadence, latch on crossing, nudge above close-out.
      // Runs regardless of whether there's an active goal.
      // B1: guard the whole block to serialize reads and prevent race conditions.
      if (sess.contextBudgetEnabled && !budgetReadInFlight) {
        sess.contextBudgetTickCount += 1;
        if (sess.contextBudgetTickCount % sess.contextBudgetReadEveryNTicks === 0) {
          budgetReadInFlight = true;
          try {
            const messages = await $.session.messages();
            // Estimate tokens: sum text, toolUses input, toolResults output.
            let chars = 0;
            for (const m of messages) {
              chars += m.text.length;
              for (const tu of m.toolUses) {
                // BJ1: tu.name is undefined on 2.1.268+ (uses tu.tool instead).
                const tuAny = tu as any;
                const toolName = tuAny.tool ?? tuAny.name ?? "";
                chars += toolName.length;
                try { chars += JSON.stringify(tu.input).length; } catch { chars += 100; }
              }
              if (m.toolResults) {
                for (const tr of m.toolResults) {
                  chars += tr.text.length;
                }
              }
            }
            const estimatedTokens = Math.floor(chars / 4);
            
            // Re-arm with hysteresis: only when the estimate falls 5% below the threshold.
            const hysteresis = 0.95;
            if (estimatedTokens < sess.contextBudgetInfoTokens * hysteresis) sess.contextBudgetLatched.info = false;
            if (estimatedTokens < sess.contextBudgetCloseoutTokens * hysteresis) sess.contextBudgetLatched.closeout = false;
            if (estimatedTokens < sess.contextBudgetCriticalTokens * hysteresis) sess.contextBudgetLatched.critical = false;
            
            // Latch on crossing (highest first).
            const budgetTs = Date.now();
            if (!sess.contextBudgetLatched.critical && estimatedTokens >= sess.contextBudgetCriticalTokens) {
              sess.contextBudgetLatched.critical = true;
              sess.state.decisions.push({
                timestamp: budgetTs,
                loop: "monitor",
                action: "context_budget_crossed",
                detail: `critical: ${estimatedTokens} tokens`,
              });
            }
            if (!sess.contextBudgetLatched.closeout && estimatedTokens >= sess.contextBudgetCloseoutTokens) {
              sess.contextBudgetLatched.closeout = true;
              sess.state.decisions.push({
                timestamp: budgetTs,
                loop: "monitor",
                action: "context_budget_crossed",
                detail: `closeout: ${estimatedTokens} tokens`,
              });
              // D1: deliver a close-out nudge through $.prompt.submit.
              try {
                const nudgeText =
                  `[BUDGET] Context is at ${estimatedTokens} tokens (close-out threshold: ${sess.contextBudgetCloseoutTokens}).\n` +
                  `Bank your current state to memory and the plan doc, then reach a clean stopping point. ` +
                  `The session will be restarted at the critical threshold; bank state now.`;
                await $.prompt.submit({ text: nudgeText });
                nudgedTurn = true;
                sess.state.decisions.push({
                  timestamp: budgetTs,
                  loop: "monitor",
                  action: "context_budget_nudge",
                  detail: `${estimatedTokens} tokens, close-out nudge sent`,
                });
              } catch { /* nudge failed; non-fatal */ }
            }
            if (!sess.contextBudgetLatched.info && estimatedTokens >= sess.contextBudgetInfoTokens) {
              sess.contextBudgetLatched.info = true;
              sess.state.decisions.push({
                timestamp: budgetTs,
                loop: "monitor",
                action: "context_budget_crossed",
                detail: `info: ${estimatedTokens} tokens`,
              });
            }
            sess.state.updatedAt = budgetTs;
            await persist($);
          } catch (err) {
            // BJ1: Log the failure so the next silent break names itself.
            const errMsg = err instanceof Error ? err.message : String(err);
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "monitor",
              action: "context_budget_read_failed",
              detail: errMsg,
            });
            await persist($);
          }
          finally {
            budgetReadInFlight = false;
          }
        }
      }

      // 4. No active leaf: activate pending work if any exists (H1), else return.
      if (!activeNode || activeNode.status !== "active") {
        const askResult = await tickOpenAsk($, sess.state, sess.persona, cfg, null);
        if (askResult !== "none") return;
        const nextId = activateNext(sess.state);
        if (nextId) {
          activate($, nextId, "no active leaf, pending work found");
          await persist($);
        }
        return;
      }
      const g = activeNode;

      // 5. Idle gate.
      const now = Date.now();
      const idleMs = sess.state.monitor.lastTurnComplete
        ? now - sess.state.monitor.lastTurnComplete
        : now - sess.state.monitor.sessionStart;
      const eligible = idleMs >= nudgeIdleMs;
      if (!eligible) return;

      // D5: skip nudge and classify if an ask is open; record ask_waiting once per minute.
      if (sess.state.pendingAskId) {
        const askResult = await tickOpenAsk($, sess.state, sess.persona, cfg, g.id);
        if (askResult === "waiting") return;
        if (askResult === "expired") return;
        // Ask was closed by an answer; clear the flag.
        sess.state.pendingAskId = undefined;
      }

      // L6: print seconds below one minute, minutes otherwise
      const idleDisplay = idleMs < 60_000 ? `${Math.floor(idleMs / 1000)}s` : `${Math.floor(idleMs / 60_000)}min`;
      const last5 = g.scores.slice(-5).map((s) => s.result).join(", ") || "none";
      const onGoalCount = g.scores.filter((s) => s.result === "on-goal").length;

      // R6: switch label offered only when ≥1 pending plan exists.
      const pendingPlans = sess.state.goals.filter((x) => x.kind === "plan" && x.status === "pending");
      const hasSwitch = pendingPlans.length > 0;
      const switchLabel = hasSwitch ? `switch: switch to a different pending plan: ${pendingPlans.map((p) => p.title.slice(0, 30)).join("; ")}\n` : "";

      // C7: Environment line only when env.git or env.health is non-null.
      const env = sess.state.monitor.env;
      let envLine = "";
      if (env.git !== null || env.health !== null) {
        const parts: string[] = [];
        if (env.git !== null) {
          parts.push(`git: ${env.git.branch} dirty ${env.git.dirty} ahead ${env.git.ahead} behind ${env.git.behind}`);
        }
        if (env.health !== null) {
          parts.push(`health: exit ${env.health.exitCode} for ${env.health.forNodeId || "no-node"}`);
        }
        envLine = `Environment: ${parts.join(", ")}\n`;
      }

      const summary =
        `Objective: ${g.objective}\n` +
        `Node: ${g.id} (${g.kind}), status ${g.status}, round ${g.completedRounds}/${g.maxRounds}\n` +
        `Last 5 scores: ${last5}\n` +
        `On-goal count: ${onGoalCount} of ${g.scores.length}\n` +
        `Idle time: ${idleDisplay}\n` +
        `Consecutive nudges sent: ${sess.consecutiveNudgesWithoutOnGoal}\n` +
        `Decisions tail: ${sess.state.decisions.slice(-5).map((d) => `${d.loop}:${d.action}`).join(", ")}\n` +
        `Memory: ${sess.state.memory.length} entries (self-review lessons: ${sess.state.memory.filter((m) => m.source === "self-review").length})\n` +
        (() => {
          const sr = sess.state.memory.filter((m) => m.source === "self-review" && m.kind === "lesson");
          if (sr.length === 0) return "";
          const newest = sr.sort((a, b) => b.createdAt - a.createdAt)[0];
          return `LESSON: ${newest.text.slice(0, 120)}\n`;
        })() +
        envLine +
        `\n` +
        `The session has been idle for ${idleDisplay}.\n` +
        `Choose the best decision:\n` +
        `nudge: prompt the worker to take the next concrete step toward the goal\n` +
        `pause: repeated drift or off-goal-by-instruction suggests the operator changed direction\n` +
        `complete: objective evidently met\n` +
        `ask-operator: blocked, ambiguous, or round budget nearly spent\n` +
        switchLabel;

      const classifyLabels: string[] = hasSwitch
        ? ["nudge", "pause", "complete", "ask-operator", "switch"]
        : ["nudge", "pause", "complete", "ask-operator"];

      // Fire-and-forget: the timer callback is sync, so we schedule async work.
      Promise.resolve().then(async () => {
        try {
          // Cap check before spending a classify call.
          if (sess.consecutiveNudgesWithoutOnGoal >= MAX_CONSECUTIVE_NUDGES) {
            const capTs = Date.now();
            const capReason = `Nudged ${sess.consecutiveNudgesWithoutOnGoal} times without on-goal; escalating`;
            sess.state.decisions.push({
              timestamp: capTs,
              loop: "monitor",
              action: "nudge_cap_reached",
              detail: `${g.id}: ${capReason}`,
            });
            // D5: write an ask record and set pendingAskId
            const askId = `ask-${g.id}-${capTs}`;
            await writeAskRecord(commonsStoreOf($), sess.persona, askId, g.id, capReason, sess.mySessionId);
            sess.state.pendingAskId = askId;
            sess.state.decisions.push({
              timestamp: capTs,
              loop: "monitor",
              action: "ask_opened",
              detail: `${g.id}: nudge-cap: ${capReason} (idle ${idleDisplay}, ask ${askId})`,
            });
            try { $.ui.toast(`Agentic: ${capReason}`); } catch { /* non-fatal */ }
            if (g.status === "active") {
              // BG1: nudge cap → paused + no activate (ask is open, tree stays put).
              g.status = "paused";
              g.blockedReason = capReason;
              g.updatedAt = capTs;
              sess.state.decisions.push({
                timestamp: capTs,
                loop: "goal",
                action: "paused_by_controller",
                detail: `${g.id}: ${capReason}`,
              });
              try { $.ui.status(""); } catch { /* non-fatal */ }
            }
            sess.state.updatedAt = capTs;
            await persist($);
            return;
          }

          const tickTs = Date.now();

          // D3: Call cap check. If the call window is latched, skip classify.
          // AK2: emit cost_cap_reached once per window (latched by capNoticeWindowStart).
          if (costEnabled && costMaxPluginCallsPerHour > 0) {
            const callWin = sess.state.monitor.cost.callWindow;
            const callWinCount = effectiveWindowCount(callWin, now);
            if (callWinCount >= costMaxPluginCallsPerHour) {
              if (sess.state.monitor.cost.capNoticeWindowStart !== callWin.start) {
                sess.state.decisions.push({
                  timestamp: tickTs,
                  loop: "monitor",
                  action: "cost_cap_reached",
                  detail: `${g.id}: call cap reached (${callWinCount}/${costMaxPluginCallsPerHour} per hour), skipping classify`,
                });
                sess.state.monitor.cost.capNoticeWindowStart = callWin.start;
              }
              sess.state.updatedAt = tickTs;
              await persist($);
              return;
            }
          }

          // AH5: Nudge cap check before classify. If the nudge cap is latched, skip classify entirely.
          // AK2: emit cost_cap_reached once per window (latched by capNoticeWindowStart).
          // BF2: when the nudge cost cap refuses a nudge and pendingAskId is unset, open an ask.
          const nudgeCapped = costEnabled && costMaxNudgesPerHour > 0 &&
            effectiveWindowCount(sess.state.monitor.cost.nudgeWindow, now) >= costMaxNudgesPerHour;
          if (nudgeCapped) {
            if (sess.state.monitor.cost.capNoticeWindowStart !== sess.state.monitor.cost.nudgeWindow.start) {
              sess.state.decisions.push({
                timestamp: tickTs,
                loop: "monitor",
                action: "cost_cap_reached",
                detail: `${g.id}: nudge cap reached (${effectiveWindowCount(sess.state.monitor.cost.nudgeWindow, now)}/${costMaxNudgesPerHour} per hour), refusing nudge`,
              });
              sess.state.monitor.cost.capNoticeWindowStart = sess.state.monitor.cost.nudgeWindow.start;
            }
            // BF2: open an ask if none is pending
            if (!sess.state.pendingAskId) {
              const askId = `ask-${g.id}-${tickTs}`;
              const capReason = `cost-cap: nudge budget spent (${effectiveWindowCount(sess.state.monitor.cost.nudgeWindow, now)}/${costMaxNudgesPerHour} per hour)`;
              await writeAskRecord(commonsStoreOf($), sess.persona, askId, g.id, capReason, sess.mySessionId);
              sess.state.pendingAskId = askId;
              sess.state.decisions.push({
                timestamp: tickTs,
                loop: "monitor",
                action: "ask_opened",
                detail: `${g.id}: ${capReason} (ask ${askId})`,
              });
              try { $.ui.toast(`Agentic: ${capReason}`); } catch { /* non-fatal */ }
              if (g.status === "active") {
                // BG1: cost cap → paused + no activate (ask is open, tree stays put).
                g.status = "paused";
                g.blockedReason = capReason;
                g.updatedAt = tickTs;
                sess.state.decisions.push({
                  timestamp: tickTs,
                  loop: "goal",
                  action: "paused_by_controller",
                  detail: `${g.id}: ${capReason}`,
                });
                try { $.ui.status(""); } catch { /* non-fatal */ }
              }
            }
            sess.state.updatedAt = tickTs;
            await persist($);
            return;
          }

          // D4: Backoff gate. After K consecutive skipped ticks, run classify less often.
          if (costEnabled) {
            const consecutiveSkips = sess.state.monitor.cost.consecutiveSkips;
            if (!shouldRunClassify(tickIndex, consecutiveSkips, costBackoffAfterTicks, costBackoffMaxMs, controllerTickMs)) {
              // Skip classify and nudge; carry forward the previous decision.
              const factor = backoffFactor(consecutiveSkips, costBackoffAfterTicks, costBackoffMaxMs, controllerTickMs);
              sess.state.decisions.push({
                timestamp: tickTs,
                loop: "monitor",
                action: "controller_tick",
                detail: `${g.id}: backed off (factor ${factor}, tick ${tickIndex})`,
              });
              sess.state.updatedAt = tickTs;
              await persist($);
              return;
            }
          }

          // D2: Idle tick skip. Hash the stable subset of the summary.
          // Skip classify+reason only when the hash is unchanged AND the nudge is not due.
          if (costEnabled) {
            // Build the stable subset string (exclude idle time, nudge count, decisions tail).
            const stableSubset =
              `Objective: ${g.objective}\n` +
              `Node: ${g.id} (${g.kind}), status ${g.status}, round ${g.completedRounds}/${g.maxRounds}\n` +
              `Last 5 scores: ${last5}\n` +
              `On-goal count: ${onGoalCount} of ${g.scores.length}\n` +
              `Memory: ${sess.state.memory.length} entries\n` +
              (() => {
                const sr = sess.state.memory.filter((m) => m.source === "self-review" && m.kind === "lesson");
                if (sr.length === 0) return "";
                const newest = sr.sort((a, b) => b.createdAt - a.createdAt)[0];
                return `LESSON: ${newest.text.slice(0, 120)}\n`;
              })() +
              envLine;
            const currentHash = fnv1aHash(stableSubset);
            const prevHash = sess.state.monitor.cost.lastSummaryHash;
            const nudgeDue = idleMs >= nudgeIdleMs && (now - sess.lastNudgeAt >= nudgeFloorMs);
            if (currentHash === prevHash && !nudgeDue) {
              // Skip classify and reason; carry forward the previous decision.
              sess.state.monitor.cost.consecutiveSkips += 1;
              sess.state.decisions.push({
                timestamp: tickTs,
                loop: "monitor",
                action: "controller_tick",
                detail: `${g.id}: unchanged, skipped`,
              });
              sess.state.updatedAt = tickTs;
              await persist($);
              return;
            }
            // Hash changed or nudge due: reset skip counter, update hash, run classify.
            sess.state.monitor.cost.consecutiveSkips = 0;
            sess.state.monitor.cost.lastSummaryHash = currentHash;
          }

          const decision = await $.model.classify(
            summary,
            classifyLabels,
            { model: "haiku" }
          );
          // D1: increment classify ledger
          sess.state.monitor.cost.classify.count += 1;
          sess.state.monitor.cost.classify.estTokens += estimateTokens(summary.length, 30);
          // D3: update call window (count the classify call)
          sess.state.monitor.cost.callWindow = bumpWindow(sess.state.monitor.cost.callWindow, Date.now());
          let finalDecision: string = decision ?? "nudge";

          // R6: switch, second Haiku call to pick a plan id.
          if (finalDecision === "switch" && pendingPlans.length > 0) {
            try {
              const switchPrompt =
                `Choose which plan to switch to. Plans:\n` +
                pendingPlans.map((p) => `- ${p.id}: ${p.title}`).join("\n") +
                `\nReturn the plan id only.`;
              const switchRaw = await $.model.complete({
                model: "haiku",
                prompt: switchPrompt,
                maxTokens: 50,
              });
              const switchId = switchRaw.trim().split(/\s/)[0];
              const target = pendingPlans.find((p) => p.id === switchId);
              if (target) {
                // Demote current active to paused (M10: write blockedReason).
                g.status = "paused";
                g.blockedReason = "Switched to another plan";
                g.updatedAt = Date.now();
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "goal",
                  action: "switch_from",
                  detail: `${g.id} demoted to paused (switch)`,
                });
                // Activate target.
                target.status = "active";
                target.updatedAt = Date.now();
                sess.state.activeGoalId = target.id;
                sess.consecutiveNudgesWithoutOnGoal = 0;
                sess.lastNudgeAt = 0;
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "goal",
                  action: "switch_to",
                  detail: `${target.id} "${target.title}" activated (switch)`,
                });
                finalDecision = "nudge"; // Fall through to nudge the new plan.
              } else {
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "goal",
                  action: "switch_failed",
                  detail: `No pending plan matched id "${switchId}"`,
                });
                finalDecision = "nudge";
              }
            } catch { /* switch call failed; fall through to nudge */ }
          }

          // Get a reason with a second complete call (for non-nudge decisions).
          // Item 3: an ask record must carry the worker's FULL question, so the
          // model's reason is kept whole (fullReason) for that purpose. The
          // 100-char slice (finalReason) exists only to keep the decision-log
          // detail line terse; it must never be the text a reader sees as "the
          // question asked" - that was the earlier defect (a reader seeing a
          // fragment cut off mid-word).
          let finalReason = "";
          let fullReason = "";
          if (finalDecision !== "nudge") {
            try {
              const reason = await $.model.complete({
                model: "haiku",
                prompt:
                  `You are the controller of an agentic plugin. The decision was "${finalDecision}". ` +
                  `Give a one-line plain-text reason (under 20 words). Do not use Markdown formatting.\n` + summary,
                maxTokens: 30,
              });
              // D1: increment reason ledger
              sess.state.monitor.cost.reason.count += 1;
              sess.state.monitor.cost.reason.estTokens += estimateTokens(summary.length, 30);
              // D3: update call window (count the reason call)
              sess.state.monitor.cost.callWindow = bumpWindow(sess.state.monitor.cost.callWindow, Date.now());
              fullReason = reason.trim().replace(/\*{1,2}/g, "");
              finalReason = fullReason.slice(0, 100);
            } catch { /* reason call failed; non-fatal */ }
          }

          sess.state.decisions.push({
            timestamp: tickTs,
            loop: "monitor",
            action: "controller_tick",
            detail: `${g.id}: ${finalDecision}: ${finalReason || "no reason"} (idle ${idleDisplay})`,
          });

          // Actuate (controller only: the three actuators).
          if (finalDecision === "nudge" && g.status === "active") {
            // Nudge floor.
            if (now - sess.lastNudgeAt >= nudgeFloorMs) {
              // AK2: Guard only (silent). The nudge-cap check before classify already handles the cap.
              // If we reached here, the cap was not latched at the pre-classify check.
              if (nudgeCapped) {
                return;
              }
              try {
                // R8: nudge text appends goal_done instruction.
                const nudgeText =
                  `[GOAL] The active goal is: ${g.objective}\n` +
                  `The Controller detected ${idleDisplay} of idle time. ` +
                  `Re-read the objective and take the next concrete step toward it.\n` +
                  `When this step is done, call goal_done with a one-line note. ` +
                  `If the result names a next goal, continue with it.`;
                await $.prompt.submit({ text: nudgeText });
                currentPrompt = nudgeText;
                nudgedTurn = true;
                sess.lastNudgeAt = now;
                sess.consecutiveNudgesWithoutOnGoal += 1;
                // D1: increment nudge ledger (count only, no token estimate)
                sess.state.monitor.cost.nudge.count += 1;
                // D3: update nudge window
                sess.state.monitor.cost.nudgeWindow = bumpWindow(sess.state.monitor.cost.nudgeWindow, now);
                sess.state.decisions.push({
                  timestamp: tickTs,
                  loop: "monitor",
                  action: "nudge_sent",
                  detail: `${g.id}: idle ${idleDisplay}, nudge #${sess.consecutiveNudgesWithoutOnGoal}`,
                });
              } catch { /* nudge failed; non-fatal */ }
            }
          } else if (finalDecision === "ask-operator" || finalDecision === "pause") {
            const question = fullReason || (finalDecision === "pause" ? "controller pause" : "operator input needed");
            const askReaskSuppressMs = typeof cfg.askReaskSuppressMs === "number" ? (cfg.askReaskSuppressMs as number) : 10 * 60_000;
            if (shouldSuppressReask(g, question, tickTs, askReaskSuppressMs)) {
              // D5b: the classifier re-proposed the identical question this
              // node just closed. Log it and fall through without pausing;
              // the plan keeps nudging instead of silencing the worker on a loop.
              sess.state.decisions.push({
                timestamp: tickTs,
                loop: "monitor",
                action: "ask_reask_suppressed",
                detail: `${g.id}: suppressed identical question closed ${Math.round((tickTs - (g.lastAskClosedAt || tickTs)) / 1000)}s ago: ${question.slice(0, 80)}`,
              });
            } else {
              // D5: write an ask record and set pendingAskId (both ask-operator and pause)
              const askId = `ask-${g.id}-${Date.now()}`;
              await writeAskRecord(commonsStoreOf($), sess.persona, askId, g.id, question, sess.mySessionId);
              sess.state.pendingAskId = askId;
              sess.state.decisions.push({
                timestamp: Date.now(),
                loop: "monitor",
                action: "ask_opened",
                detail: `${g.id}: ${finalDecision}: ${question} (ask ${askId})`,
              });
              try {
                $.ui.toast(`Agentic: ${question}`);
              } catch { /* non-fatal */ }
              if (g.status === "active") {
                g.status = "paused";
                g.blockedReason = question;
                g.updatedAt = Date.now();
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "goal",
                  action: "paused_by_controller",
                  detail: `${g.id}: ${question}`,
                });
                try { $.ui.status(""); } catch { /* non-fatal */ }
              }
            }
          } else if (finalDecision === "complete" && g.status === "active") {
            // R3: use completeLeaf + activateNext.
            const completedId = g.id;
            completeLeaf(sess.state, completedId, finalReason || "controller complete");
            // E2: health run at completeLeaf site (controller complete).
            await runHealth($, completedId);
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "goal",
              action: "completed_by_controller",
              detail: `${completedId}: ${finalReason || "controller complete"}`,
            });
            // R3: activate next.
            const nextId = activateNext(sess.state, completedId);
            activate($, nextId, `${completedId} complete`);
            // L11: plan completion is a log line, not a speech.
            try { $.ui.log(`Agentic: ${completedId} plan complete (controller)`); } catch { /* non-fatal */ }
            try { $.ui.status(""); } catch { /* non-fatal */ }
          }

          // Visible status line while a goal is actively driving.
          const currentActive = sess.state.activeGoalId
            ? sess.state.goals.find((x) => x.id === sess.state.activeGoalId)
            : null;
          if (currentActive && currentActive.status === "active") {
            try {
              $.ui.status(`Goal: ${currentActive.title.slice(0, 50)} | ${currentActive.kind} | ${currentActive.id} | round ${currentActive.completedRounds}/${currentActive.maxRounds}`);
            } catch { /* non-fatal */ }
          }

          // Persist (owner only, guarded write).
          sess.state.updatedAt = Date.now();
          await persist($);
        } catch {
          // Controller tick failed; non-fatal.
        }
      });
    });

    return next(e);
  });

  // --- turn.start: track turn ---
  on("turn.start", async ($, e, next) => {
    sess.state.monitor.turnCount += 1;
    sess.state.monitor.lastTurnId = e.turnId;
    turnInFlight = true;
    // H2: record the active leaf at turn start for scoring.
    turnLeafId = sess.state.activeGoalId;
    // C4: reset tool error counter for this turn.
    toolErrorsThisTurn = 0;
    // Item 2 sub-bullet: reset the tool-call counter for this turn.
    toolCallsThisTurn = 0;
    // D4: reset backoff skip counter on new turn (activity breaks the skip streak).
    if (costEnabled && sess.state.monitor.cost) {
      sess.state.monitor.cost.consecutiveSkips = 0;
    }
    sess.state.decisions.push({
      timestamp: Date.now(),
      loop: "monitor",
      action: "turn_start",
      detail: `Turn ${sess.state.monitor.turnCount} leaf ${turnLeafId || "none"}`,
    });

    // AS3: the first turn.start after a delivery stamps e.turnId onto the
    // delivered record that has none.
    if (sess.isOwner) {
      const persona = sess.persona;
      const allRecords = await listInboxRecords(commonsStoreOf($), persona);
      const undelivered = allRecords.find(
        (rec) => rec.status === "delivered" && !rec.turnId
      );
      if (undelivered) {
        undelivered.turnId = e.turnId;
        const store = commonsStoreOf($);
        const existing = await store.get(undelivered.key);
        if (existing) {
          const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
          parsed.turnId = e.turnId;
          await store.set(undelivered.key, parsed);
        }
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "operator_turn_stamped",
          detail: `record ${undelivered.id} stamped with turn ${e.turnId}`,
        });
        await persist($);
      }
    }

    return next(e);
  });

  // --- turn.complete: goal scoring, memory curation, guarded save ---
  // Modules write to sess.state. The Controller (clock.tick) reads sess.state and decides.
  on("turn.complete", async ($, e, next) => {
    sess.state.monitor.lastTurnComplete = Date.now();
    turnInFlight = false;

    // Read and clear the nudge flag once, up front. This prevents
    // a stale flag from leaking into a later real user turn (e.g. if the
    // nudged turn is aborted or the goal is not active).
    const wasNudged = nudgedTurn;
    nudgedTurn = false;

    // C3: error streak fold.
    const toolErrors = toolErrorsThisTurn;
    toolErrorsThisTurn = 0;
    sess.state.monitor.env.errors = applyTurnToErrors(
      sess.state.monitor.env.errors,
      { reason: e.reason || "unknown", toolErrors },
    );

    // Skip scoring on aborted or errored turns (no answer to judge).
    const skipped = e.aborted || e.reason === "aborted" || e.reason === "error" || e.reason === "refusal" || !e.answer;

    // Item 2 sub-bullet (f016b69): a turn that did real work with no
    // active root - the exact shape a cost-conscious model produces when
    // it reads a one-step request as too small for goal_create, even
    // after the [NO GOAL] reminder names size explicitly - gets a
    // synthetic goal record after the fact, so "every request opens a
    // goal, whatever its size" holds even when the model skipped the
    // ritual. The condition is "no active root", not "goals.length === 0":
    // item 4's second conversational request arrives with the first
    // root still sitting in state, complete but present, so an empty-
    // array check would silently never fire for that case. Gated off
    // real work only (isWorkTool, Round 28) and off priming/nudge turns
    // (isPrimingTurn, wasNudged) - a channel-attached passive child's own
    // acknowledgment turn must never look like task work, or the
    // supervisor sees a fabricated root_complete and restart-loops it.
    const currentRoot = sess.state.goals.find((g) => g.parentId === null);
    const noActiveRoot = !currentRoot || currentRoot.status === "complete" || currentRoot.status === "abandoned";
    if (!skipped && sess.isOwner && !isPrimingTurn && !wasNudged && noActiveRoot && toolCallsThisTurn > 0) {
      const backfillNow = Date.now();
      const objective = (currentPrompt || "Untitled request").slice(0, 200);
      const rootId = `root-${backfillNow.toString(36)}`;
      const backfillRoot: GoalNode = {
        id: rootId,
        parentId: null,
        kind: "root",
        title: objective.slice(0, 80),
        objective,
        status: "complete",
        source: "worker",
        maxRounds: 1,
        completedRounds: 1,
        scores: [{ round: 1, result: "complete" }],
        notes: ["Backfilled: the worker did the work without calling goal_create this turn."],
        planningRounds: 0,
        consecutiveBlockedPlannings: 0,
        consecutivePlanningFailures: 0,
        planningRound: 0,
        createdAt: backfillNow,
        updatedAt: backfillNow,
      };
      sess.state.goals = [backfillRoot];
      sess.state.activeGoalId = null;
      sess.state.decisions.push({
        timestamp: backfillNow,
        loop: "goal",
        action: "create",
        detail: `Root ${rootId} "${objective.slice(0, 80)}" created (max 1 rounds) - backfilled, no goal_create call this turn`,
      });
      sess.state.decisions.push({
        timestamp: backfillNow,
        loop: "goal",
        action: "root_complete",
        detail: `Root ${rootId} marked complete - backfilled, work already done`,
      });
    }

    // H2: Score against the leaf that was active at TURN START (turnLeafId),
    // not whichever node is active now (which may have been activated mid-turn
    // by goal_done or the scorer).
    const turnLeaf = turnLeafId
      ? sess.state.goals.find((g) => g.id === turnLeafId)
      : null;
    if (!skipped && turnLeaf) {
      if (turnLeaf.status === "complete") {
        // M11: goal_done ran during this turn, the credit is already in the
        // goal_done handler. Log score_skipped here.
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "goal",
          action: "score_skipped",
          detail: `${turnLeaf.id} already complete (goal_done)`,
        });
        sess.consecutiveNudgesWithoutOnGoal = 0;
        turnLeafId = null;
      } else if (turnLeaf.status === "active") {
        // Still active at turn end: classify as before.
        const g = turnLeaf;
        const labels = wasNudged
          ? ["on-goal", "drift", "complete"]
          : ["on-goal", "off-goal-by-instruction", "drift", "complete"];
        try {
          const result = await $.model.classify(
            `User asked: ${currentPrompt.slice(0, 500)}\n\nWorker answered: ${e.answer.slice(0, 1000)}\n\nGoal objective: ${g.objective}\n\n` +
            `Did the worker's answer advance the goal objective?`,
            labels,
            { model: "haiku" }
          );
        const label = result ?? "unknown";
        g.scores.push({
          round: g.scores.length + 1,
          result: label,
        });

        // Only on-goal, drift, and complete burn rounds.
        if (label === "on-goal" || label === "drift" || label === "complete") {
          g.completedRounds += 1;
        }

        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "goal",
          action: "score",
          detail: `${g.id} Round ${g.scores.length}: ${label}`,
        });

        // Reset consecutive nudges when on-goal.
        if (label === "on-goal") {
          sess.consecutiveNudgesWithoutOnGoal = 0;
        }

        if (label === "complete") {
          // R3: use completeLeaf + activateNext.
          const completedId = g.id;
          completeLeaf(sess.state, completedId, "scorer complete");
          // E2: health run at completeLeaf site (scorer complete).
          await runHealth($, completedId);
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "goal",
            action: "complete",
            detail: `${completedId}: Goal completed in ${g.completedRounds} rounds`,
          });
          const nextId = activateNext(sess.state, completedId);
          activate($, nextId, `${completedId} complete`);
          // L11: plan completion is a log line, not a speech.
          try { $.ui.log(`Agentic: ${completedId} plan complete`); } catch { /* non-fatal */ }
          try { $.ui.status(""); } catch { /* non-fatal */ }
        } else if (g.completedRounds >= g.maxRounds) {
          // R7: round budget → leaf blocked, toast once, then activateNext.
          g.status = "blocked";
          g.blockedReason = "Max rounds reached";
          g.updatedAt = Date.now();
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "goal",
            action: "block",
            detail: `${g.id}: Max rounds reached`,
          });
          try { $.ui.toast(`Agentic: ${g.id} blocked: max rounds reached`); } catch { /* non-fatal */ }
          const nextId = activateNext(sess.state, g.id);
          activate($, nextId, `${g.id} blocked`);
          try { $.ui.status(""); } catch { /* non-fatal */ }
        }
        g.updatedAt = Date.now();
        } catch (err) {
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "goal",
            action: "score_failed",
            detail: `${g.id}: ${String(err).slice(0, 150)}`,
          });
        }
        turnLeafId = null;
      } else {
        // H2: node is paused, blocked, or switched: skip scoring.
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "goal",
          action: "score_skipped",
          detail: `${turnLeaf.id}: status ${turnLeaf.status} at turn end`,
        });
        turnLeafId = null;
      }
    }

    // Memory curation: distill, don't snapshot.
    // Skip curation on nudged turns: the controller's own instruction
    // is not a user preference and must not be distilled into a memory.
    if (!skipped && !wasNudged) {
      try {
        const kind = await $.model.classify(
          `What kind of memorable content is in this exchange? Answer with exactly one label.\n` +
          `A description of what happened this turn is "discard".\n` +
          `Only a fact or preference the user stated explicitly. An instruction to call a tool is discard.\n` +
          `User asked: ${currentPrompt.slice(0, 300)}\nWorker answered: ${e.answer.slice(0, 500)}`,
          ["fact", "preference", "lesson", "discard"],
          { model: "haiku" }
        );
        if (kind && kind !== "discard") {
          const rawDistilled = await $.model.complete({
            model: "haiku",
            prompt:
              `One durable fact about the user, their preferences, or this project that a future session should know. ` +
              `Reply NONE if there is none. No preamble, no labels, just the fact or NONE.\n` +
              `User asked: ${currentPrompt.slice(0, 300)}\nWorker answered: ${e.answer.slice(0, 500)}`,
            maxTokens: 50,
          });
          const distilled = rawDistilled.trim();
          if (distilled.length > 0 && distilled.toUpperCase() !== "NONE") {
            const normalized = distilled.toLowerCase().trim();
            const isDupe = sess.state.memory.some(
              (m) => m.text.toLowerCase().trim() === normalized
            );
            if (!isDupe) {
              sess.state.memory.push({
                id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                kind: kind as "fact" | "preference" | "lesson",
                text: distilled,
                confidence: 0.4,
                source: "distilled",
                createdAt: Date.now(),
                lastAccessed: Date.now(),
                accessCount: 0,
                pinned: false,
              });
              sess.state.decisions.push({
                timestamp: Date.now(),
                loop: "memory",
                action: "remember",
                detail: `${kind}: ${distilled.slice(0, 80)}`,
              });
            }
          }
        }
      } catch {
        // Curation failed; non-fatal.
      }
    }

    // S12: increment turnsSince for self-review debounce.
    if (sess.state.monitor.selfReview) {
      sess.state.monitor.selfReview.turnsSince += 1;
    }

    // D4: if the turn.complete turnId matches a delivered record, write the
    // reply and mark answered.
    if (sess.isOwner) {
      const persona = sess.persona;
      const allRecords = await listInboxRecords(commonsStoreOf($), persona);
      const matching = allRecords.find(
        (rec) => rec.status === "delivered" && rec.turnId === e.turnId
      );
      if (matching) {
        const store = commonsStoreOf($);
        if (e.answer && e.reason !== "aborted") {
          // AX4: write reply, mark answered
          // BE2: use writeReplyRecord so the value is an object, not a string
          await writeReplyRecord(store, persona, matching.id, e.answer);
          const existing = await store.get(matching.key);
          if (existing) {
            const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
            parsed.status = "answered";
            await store.set(matching.key, parsed);
          }
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "operator_answered",
            detail: `record ${matching.id} replied`,
          });
        } else {
          // AX4: empty answer or aborted. Leave delivered, clear turnId so
          // the next turn.start re-stamps it.
          const existing = await store.get(matching.key);
          if (existing) {
            const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
            parsed.turnId = undefined;
            await store.set(matching.key, parsed);
          }
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "operator_turn_cleared",
            detail: `record ${matching.id} turnId cleared (answer empty or aborted)`,
          });
        }
      }
    }

    // M7: single guarded-write path (shared helper).
    await persist($);

    return next(e);
  });

  // --- tool.call: serve tools, enforce constraints ---
  on("tool.call", async ($, e, next) => {
    sess.state.monitor.totalToolCalls += 1;
    if (isWorkTool(e.tool)) toolCallsThisTurn += 1;

    // Serve agentic_identity (F9: single arbiter = commons; epoch is only the
    // same-directory write fence). Claim in commons FIRST; if a live earlier
    // holder exists, join as reader (no epoch bump, no ownership).
    if (e.tool === "mcp__agentic-plugin__agentic_identity") {
      const name = String((e as any).persona || "default").trim() || "default";
      const previousPersona = sess.persona;
      sess.persona = name;
      // Backlog fix (commons claim staleness): a commons session record shares
      // one lastSeen across every claim it has ever made, so a persona claim
      // left behind on switch reads as live for as long as this session keeps
      // heartbeating under its NEW persona - blocking any other session from
      // ever winning that old persona's arbitration. Release it here, the one
      // place a session's persona actually changes.
      if (previousPersona && previousPersona !== name) {
        try {
          await releaseResource(commonsStoreOf($), `persona:${previousPersona}`, sess.mySessionId);
        } catch { /* non-fatal: commons is a coordination layer */ }
      }
      const store: Record<string, unknown> = await $.fs.exists(storePath)
        ? (JSON.parse(await $.fs.read(storePath)) as Record<string, unknown>)
        : {};
      const existing = store[name] as AgentState | undefined;
      if (existing) {
        sess.state = parseState(JSON.stringify(existing));
        sess.state.persona = name;
      } else {
        sess.state = createDefaultState(name, sess.mySessionId);
      }
      // F9: commons is the single arbiter. Claim first, then check if a live
      // earlier holder exists. Only the commons winner takes ownership.
      const resource = `persona:${sess.persona}`;
      let winnerId = sess.mySessionId; // default: we are the winner
      let shouldYieldTo: string | null = null;
      try {
        await claimResource(commonsStoreOf($), resource, sess.mySessionId);
        const claims = await readAllClaims(commonsStoreOf($), sess.staleAfterMs);
        const winner = commonsWinner(claims, resource);
        if (winner && winner !== sess.mySessionId) {
          shouldYieldTo = winner;
        } else {
          winnerId = winner ?? sess.mySessionId;
        }
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "persona_claim_commons",
          detail: `Claimed ${resource} in commons (session ${sess.mySessionId}, winner ${winnerId})`,
        });
      } catch { /* non-fatal: commons is a coordination layer, not a hard dependency */ }

      if (shouldYieldTo) {
        // F9: a live earlier holder exists. Join as reader, do NOT bump epoch,
        // do NOT set isOwner, do NOT write the heartbeat.
        sess.isOwner = false;
        sess.myEpoch = existing?.epoch ?? 0;
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "passive_reader",
          detail: `Joining '${sess.persona}' as reader (holder: ${shouldYieldTo}, commons arbitration)`,
        });
        try { $.ui.log(`Agentic: joined '${sess.persona}' as reader (held by ${shouldYieldTo})`); } catch { /* non-fatal */ }
        // Round 32: the claimResource call above speculatively claimed
        // `persona:<p>` before the winner was known. A reader join must not
        // keep that claim - left in place, it reads as a live persona holder
        // under this session's own heartbeat and blocks the next relaunch's
        // pre-gate for the full stale-after window, exactly as the stale
        // `persona:default` claim did. Release it before claiming the reader
        // role, so the joiner ends with reader:<p> only.
        try {
          await releaseResource(commonsStoreOf($), resource, sess.mySessionId);
        } catch { /* non-fatal: commons is a coordination layer */ }
        // D2: Claim the reader role
        await claimReaderRole(commonsStoreOf($), sess.persona, sess.mySessionId);
        return {
          result: `persona '${sess.persona}' is held by session ${shouldYieldTo}; joined as reader. ${sess.state.memory.length} memories.`,
        };
      }

      // Commons winner: take ownership, bump epoch, write heartbeat.
      sess.state.activeSessionId = sess.mySessionId;
      sess.state.epoch += 1;
      sess.myEpoch = sess.state.epoch;
      sess.isOwner = true;
      sess.state.monitor.sessionStart = Date.now();
      sess.state.monitor.turnCount = 0;
      sess.state.monitor.totalToolCalls = 0;
      sess.state.monitor.errors = 0;
      sess.state.monitor.lastTurnComplete = Date.now();
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "monitor",
        action: "identity_set",
        detail: `persona '${sess.persona}' (session ${sess.mySessionId}, epoch ${sess.myEpoch}, commons winner)`,
      });
      // Commons winner: one of the three claim sites that share writeClaimDirect
      // (the other two are session.start and the heartbeat tick promotion).
      // The claimant is the commons winner (activeSessionId = self), so the write
      // must not go through persist's yield check.
      await writeClaimDirect($);
      return {
        result: `persona '${sess.persona}' active (epoch ${sess.myEpoch}, owner). ${sess.state.memory.length} memories.`,
      };
    }

    // Serve goal_create (v3: creates the root node, NO planning in handler: R1).
    if (e.tool === "mcp__agentic-plugin__goal_create") {
      if (!sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
      }
      const objective = String((e as any).objective || "").trim();
      if (!objective) {
        toolErrorsThisTurn++;
        return { deny: "goal_create requires a non-empty 'objective'." };
      }
      const maxRounds = Math.min(Math.max(parseInt(String((e as any).maxRounds || "10"), 10) || 10, 1), 50);
      const roadmapPath = String((e as any).roadmapPath || "").trim() || undefined;

      const now = Date.now();
      const rootId = `root-${now.toString(36)}`;
      const root: GoalNode = {
        id: rootId,
        parentId: null,
        kind: "root",
        title: objective.slice(0, 80),
        objective,
        status: "pending",
        source: "operator",
        maxRounds, // L9: operator's value as the default for plans
        completedRounds: 0,
        scores: [],
        notes: [],
        roadmapPath,
        planningRounds: 0,
        consecutiveBlockedPlannings: 0,
        consecutivePlanningFailures: 0,
        planningRound: 0,
        createdAt: now,
        updatedAt: now,
      };

      // Replace any existing tree.
      sess.state.goals = [root];
      sess.state.activeGoalId = null;

      sess.state.decisions.push({
        timestamp: now,
        loop: "goal",
        action: "create",
        detail: `Root ${rootId} "${objective.slice(0, 80)}" created (max ${maxRounds} rounds)`,
      });
      // H2b: a new goal inherits a clean nudge budget.
      sess.consecutiveNudgesWithoutOnGoal = 0;
      sess.lastNudgeAt = 0;

      const writeOk = await persist($);
      if (writeOk) {
        return {
          result: `Root created; planning runs at the next controller tick.`,
        };
      }
      toolErrorsThisTurn++;
      return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
    }

    // Serve goal_add (R4: parent resolution).
    if (e.tool === "mcp__agentic-plugin__goal_add") {
      if (!sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
      }
      const title = String((e as any).title || "").trim();
      const objective = String((e as any).objective || "").trim();
      if (!title || !objective) {
        toolErrorsThisTurn++;
        return { deny: "goal_add requires non-empty 'title' and 'objective'." };
      }
      const kind = String((e as any).kind || "task").trim() === "plan" ? "plan" : "task";
      const maxRounds = Math.min(Math.max(parseInt(String((e as any).maxRounds || "10"), 10) || 10, 1), 50);
      const explicitParent = String((e as any).parentId || "").trim();

      const root = sess.state.goals.find((g) => g.parentId === null);
      if (!root) {
        toolErrorsThisTurn++;
        return { deny: "No goal tree exists. Call goal_create first." };
      }

      // R4: parent resolution.
      let parentId: string;
      if (explicitParent) {
        const parent = sess.state.goals.find((g) => g.id === explicitParent);
        if (!parent) {
          toolErrorsThisTurn++;
          return { deny: `parentId "${explicitParent}" not found in goal tree.` };
        }
        if (kind === "plan" && parent.parentId !== null) {
          toolErrorsThisTurn++;
          return { deny: 'kind "plan" is only allowed under the root.' };
        }
        parentId = explicitParent;
      } else {
        const active = sess.state.activeGoalId
          ? sess.state.goals.find((g) => g.id === sess.state.activeGoalId)
          : null;
        if (active) {
          if (active.kind === "plan") {
            parentId = active.id;
          } else {
            // Active task's parent.
            parentId = active.parentId ?? root.id;
          }
        } else {
          parentId = root.id;
        }
      }

      // Validate kind under parent.
      const parentNode = sess.state.goals.find((g) => g.id === parentId)!;
      if (kind === "plan" && parentNode.parentId !== null) {
        toolErrorsThisTurn++;
        return { deny: 'kind "plan" is only allowed under the root.' };
      }
      // M6: deny goal_add whose resolved parent is a task (three levels max: root > plan > task).
      if (parentNode.kind === "task") {
        toolErrorsThisTurn++;
        return { deny: "Cannot add a node under a task. The tree is root > plan > task; nothing deeper." };
      }

      const now = Date.now();
      const newNode: GoalNode = {
        id: `${kind}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        parentId,
        kind,
        title: title.slice(0, 80),
        objective: objective.slice(0, 500),
        status: "pending",
        source: "worker",
        planningRounds: 0,
        consecutiveBlockedPlannings: 0,
        consecutivePlanningFailures: 0,
        planningRound: 0,
        maxRounds,
        completedRounds: 0,
        scores: [],
        notes: [],
        createdAt: now,
        updatedAt: now,
      };
      sess.state.goals.push(newNode);

      sess.state.decisions.push({
        timestamp: now,
        loop: "goal",
        action: "add",
        detail: `${newNode.id} (${kind}) under ${parentId}: "${title.slice(0, 50)}"`,
      });

      // R4: adding a task under the active plan demotes the plan to pending
      // and activates the new task.
      if (kind === "task") {
        const parent = sess.state.goals.find((g) => g.id === parentId)!;
        if (parent.status === "active") {
          parent.status = "pending";
          parent.updatedAt = now;
          newNode.status = "active";
          sess.state.activeGoalId = newNode.id;
          activate($, newNode.id, `${parent.id} demoted to pending; ${newNode.id} activated`);
        }
      }

      const writeOk = await persist($);
      if (writeOk) {
        const nextActive = sess.state.activeGoalId
          ? sess.state.goals.find((g) => g.id === sess.state.activeGoalId)
          : null;
        return {
          result: nextActive
            ? `Added ${kind} "${title.slice(0, 50)}". Now active: ${nextActive.id} "${nextActive.title}".`
            : `Added ${kind} "${title.slice(0, 50)}". No active goal; planning or activation will occur at the next tick.`,
        };
      }
      toolErrorsThisTurn++;
      return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
    }

    // Serve goal_edit (plan item 3: drop / pause / reprioritize a node in
    // response to an operator steer). Each branch logs a decision naming the
    // change, so the decision log plus the resulting tree diff is the proof
    // the operator's request actually changed something.
    if (e.tool === "mcp__agentic-plugin__goal_edit") {
      if (!sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
      }
      const nodeId = String((e as any).nodeId || "").trim();
      const action = String((e as any).action || "").trim();
      const reason = String((e as any).reason || "").trim();
      if (!nodeId || !["drop", "pause", "reprioritize"].includes(action)) {
        toolErrorsThisTurn++;
        return { deny: 'goal_edit requires a valid nodeId and action ("drop" | "pause" | "reprioritize").' };
      }
      const node = sess.state.goals.find((g) => g.id === nodeId);
      if (!node) {
        toolErrorsThisTurn++;
        return { deny: `nodeId "${nodeId}" not found in goal tree.` };
      }
      if (node.parentId === null) {
        toolErrorsThisTurn++;
        return { deny: "Cannot edit the root; goal_create replaces the whole tree instead." };
      }
      const now = Date.now();

      if (action === "drop") {
        if (node.status !== "pending" && node.status !== "paused") {
          toolErrorsThisTurn++;
          return { deny: `Cannot drop ${nodeId}: status is "${node.status}" (only pending or paused nodes can be dropped).` };
        }
        node.status = "abandoned";
        node.blockedReason = reason || "dropped by operator";
        node.updatedAt = now;
        sess.state.decisions.push({
          timestamp: now,
          loop: "goal",
          action: "drop",
          detail: `${nodeId}: ${node.blockedReason}`,
        });
      } else if (action === "pause") {
        if (node.status !== "active" && node.status !== "pending") {
          toolErrorsThisTurn++;
          return { deny: `Cannot pause ${nodeId}: status is "${node.status}" (only an active or pending node can be paused).` };
        }
        const wasActive = node.status === "active";
        node.status = "paused";
        node.blockedReason = reason || "paused by operator";
        node.updatedAt = now;
        if (wasActive && sess.state.activeGoalId === nodeId) {
          sess.state.activeGoalId = null;
        }
        sess.state.decisions.push({
          timestamp: now,
          loop: "goal",
          action: "paused_by_operator",
          detail: `${nodeId}: ${node.blockedReason}`,
        });
      } else {
        // reprioritize: move nodeId to activate before its pending siblings.
        if (node.status !== "pending") {
          toolErrorsThisTurn++;
          return { deny: `Cannot reprioritize ${nodeId}: status is "${node.status}" (only a pending node can be reprioritized).` };
        }
        const siblings = sess.state.goals.filter((g) => g.parentId === node.parentId && g.id !== nodeId);
        const earliestKey = siblings.length > 0
          ? Math.min(...siblings.map((g) => g.sortKey ?? g.createdAt))
          : node.sortKey ?? node.createdAt;
        node.sortKey = earliestKey - 1;
        node.updatedAt = now;
        sess.state.decisions.push({
          timestamp: now,
          loop: "goal",
          action: "reprioritized",
          detail: `${nodeId}: moved to front of ${node.parentId ?? "root"}'s pending siblings${reason ? ` (${reason})` : ""}`,
        });
      }

      const writeOk = await persist($);
      if (writeOk) {
        return { result: `${action} applied to ${nodeId}. Now: [${node.status}] "${node.title}".` };
      }
      toolErrorsThisTurn++;
      return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
    }

    // Serve goal_done (R3: use completeLeaf + activateNext).
    if (e.tool === "mcp__agentic-plugin__goal_done") {
      if (!sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
      }
      const note = String((e as any).note || "").trim();
      const active = sess.state.activeGoalId
        ? sess.state.goals.find((g) => g.id === sess.state.activeGoalId)
        : null;
      if (!active || active.status !== "active") {
        toolErrorsThisTurn++;
        return { deny: "No active goal leaf to complete." };
      }
      const completedId = active.id;
      const completedTitle = active.title;
      completeLeaf(sess.state, completedId, note || "goal_done");
      // E2: health run at completeLeaf site (goal_done).
      await runHealth($, completedId);
      // M11: credit the round and score in goal_done, not turn.complete.
      active.scores.push({ round: active.scores.length + 1, result: "on-goal" });
      active.completedRounds += 1;
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "goal",
        action: "score",
        detail: `${completedId} Round ${active.scores.length}: on-goal (goal_done)`,
      });
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "goal",
        action: "done",
        detail: `${completedId} "${completedTitle.slice(0, 50)}" marked complete${note ? `: ${note.slice(0, 80)}` : ""}`,
      });
      const nextId = activateNext(sess.state, completedId);
      activate($, nextId, `${completedId} done`);

      // S9: goal_done sets pendingPeriodic; the tick runs the review.
      if (sess.state.monitor.selfReview) {
        sess.state.monitor.selfReview.pendingPeriodic = true;
      }

      const writeOk = await persist($);
      if (writeOk) {
        // F4: goal_done result names the health command, exit code, and first tail line.
        const health = sess.state.monitor.env.health;
        let healthText = "";
        if (health) {
          const firstLine = health.tail.split("\n")[0] || "no output";
          healthText = ` Health: ${health.command.join(" ")} exit ${health.exitCode} (${firstLine}).`;
        }
        // R8: goal_done result names newly active leaf OR planning message.
        if (nextId) {
          const nextNode = sess.state.goals.find((g) => g.id === nextId)!;
          return {
            result: `Complete: "${completedTitle}". Next active: ${nextId} "${nextNode.title}".${healthText}`,
          };
        }
        return { result: `Complete: "${completedTitle}". No pending goals; planning runs at the next tick.${healthText}` };
      }
      toolErrorsThisTurn++;
      return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
    }

    // Serve supervisor_shutdown (plan item 4: distinct from root_complete;
    // supervise.sh's decide unit only exits the whole loop on this signal).
    if (e.tool === "mcp__agentic-plugin__supervisor_shutdown") {
      if (!sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
      }
      const reason = String((e as any).reason || "").trim() || "operator requested shutdown";
      const now = Date.now();
      sess.state.decisions.push({
        timestamp: now,
        loop: "monitor",
        action: "shutdown_requested",
        detail: reason,
      });
      const writeOk = await persist($);
      if (writeOk) {
        return { result: `Shutdown requested: ${reason}. The supervisor will stop after this turn ends.` };
      }
      toolErrorsThisTurn++;
      return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
    }

    // Serve goal_status (read-only, passive-reader OK).
    if (e.tool === "mcp__agentic-plugin__goal_status") {
      const root = sess.state.goals.find((g) => g.parentId === null);
      if (!root) {
        return { result: "No goal tree exists." };
      }
      const lines: string[] = [];
      const statusOf = (id: string) => {
        const n = sess.state.goals.find((g) => g.id === id)!;
        return `[${n.status}] ${n.id} (${n.kind}) "${n.title}"`;
      };
      lines.push(statusOf(root.id));
      const children = (pid: string) =>
        sess.state.goals.filter((g) => g.parentId === pid)
          .sort((a, b) => (a.sortKey ?? a.createdAt) - (b.sortKey ?? b.createdAt));
      const render = (pid: string, indent: string) => {
        for (const c of children(pid)) {
          lines.push(indent + statusOf(c.id));
          render(c.id, indent + "  ");
        }
      };
      render(root.id, "  ");
      return { result: lines.join("\n") };
    }

    // M5: Serve goal_resume (owner only: resumes paused leaf, resets nudge budget).
    if (e.tool === "mcp__agentic-plugin__goal_resume") {
      if (!sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: "goal_resume requires ownership of this persona." };
      }
      const nodeId = String((e as any).nodeId || "").trim();
      let target: GoalNode | undefined;
      if (nodeId) {
        target = sess.state.goals.find((g) => g.id === nodeId && g.status === "paused");
      } else {
        target = sess.state.goals
          .filter((g) => g.status === "paused")
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      }
      if (!target) {
        return { result: "No paused nodes to resume." };
      }
      // M9: if a different node is active, pause it first (M10: write blockedReason).
      if (sess.state.activeGoalId && sess.state.activeGoalId !== target.id) {
        const activeNode = sess.state.goals.find((g) => g.id === sess.state.activeGoalId);
        if (activeNode && activeNode.status === "active") {
          activeNode.status = "paused";
          activeNode.blockedReason = `Paused by goal_resume of ${target.id}`;
          activeNode.updatedAt = Date.now();
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "goal",
            action: "paused_by_resume",
            detail: `${activeNode.id} paused (goal_resume of ${target.id})`,
          });
        }
      }
      // M10: clear blockedReason on resume.
      const pausedReason = target.blockedReason || "unknown";
      target.blockedReason = undefined;
      target.status = "active";
      target.updatedAt = Date.now();
      sess.state.activeGoalId = target.id;
      sess.consecutiveNudgesWithoutOnGoal = 0;
      sess.lastNudgeAt = 0;
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "goal",
        action: "resume",
        detail: `Node ${target.id} resumed (paused: ${pausedReason})`,
      });
      // AZ4: goal_resume on the ask's node closes the ask with status "resumed"
      if (sess.state.pendingAskId) {
        const askRecord = await readAskRecord(commonsStoreOf($), sess.persona, sess.state.pendingAskId);
        if (askRecord && askRecord.status === "open" && askRecord.nodeId === target.id) {
          askRecord.status = "resumed";
          await (commonsStoreOf($)).set(askKey(sess.persona, sess.state.pendingAskId), askRecord);
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "ask_answered",
            detail: `ask ${sess.state.pendingAskId} closed by goal_resume (status: resumed)`,
          });
        }
        sess.state.pendingAskId = undefined;
      }
      sess.state.updatedAt = Date.now();
      await persist($);
      return { result: `Resumed ${target.id} (${target.kind}) "${target.title}". Nudge budget reset.` };
    }

    // Serve memory_add.
    if (e.tool === "mcp__agentic-plugin__memory_add") {
      if (!sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
      }
      const text = String((e as any).text || "").trim();
      if (!text) {
        toolErrorsThisTurn++;
        return { deny: "memory_add requires a non-empty 'text'." };
      }
      const kind = (String((e as any).kind || "fact").trim() as "fact" | "preference" | "lesson") || "fact";
      const confidence = Math.min(Math.max(parseFloat(String((e as any).confidence || "0.7")) || 0.7, 0), 1);
      sess.state.memory.push({
        id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        text,
        confidence,
        source: "worker",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        accessCount: 0,
        pinned: false,
      });
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "memory",
        action: "remember",
        detail: `${kind}: ${text.slice(0, 80)}`,
      });
      const writeOk = await persist($);
      if (writeOk) {
        return {
          result: `Memory saved (${kind}, confidence ${confidence}): "${text.slice(0, 80)}"`,
        };
      }
      toolErrorsThisTurn++;
      return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
    }

    // D2: Serve agentic_say (reader sends a message to the owner)
    // Plan D2: agentic_say(text, answers?), persona is the session's (sess.persona)
    if ((e as any).tool === "mcp__agentic-plugin__agentic_say") {
      const persona = sess.persona;
      const text = String((e as any).text || "").trim();
      const answers = (e as any).answers as string | undefined;
      if (!text) {
        toolErrorsThisTurn++;
        return { deny: "agentic_say requires a non-empty 'text'." };
      }
      // Check if we are a reader
      if (sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: "agentic_say is for reader sessions only; the owner does not need to send itself a message." };
      }
      // D2: require a live reader claim
      const hasClaim = await hasLiveReaderClaim(commonsStoreOf($), persona, sess.mySessionId);
      if (!hasClaim) {
        toolErrorsThisTurn++;
        return { deny: "agentic_say requires a live reader claim; the reader role is not held by this session." };
      }
      // BD3 part 2: when answers is set, verify it names a live open ask.
      if (answers) {
        const askRec = await readAskRecord(commonsStoreOf($), persona, answers);
        if (!askRec || askRec.status !== "open") {
          const allAsks = await listAskRecords(commonsStoreOf($), persona);
          const openIds = allAsks.filter((a) => a.status === "open").map((a) => a.id);
          toolErrorsThisTurn++;
          return { deny: `no open ask '${answers}'; open asks: ${openIds.length ? openIds.join(", ") : "(none)"}` };
        }
      }
      // Write the inbox record
      const seq = await getHighestInboxSeq(commonsStoreOf($), persona, sess.mySessionId) + 1;
      const id = await writeInboxRecord(commonsStoreOf($), persona, sess.mySessionId, seq, text, "say", answers);
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "worker",
        action: "say_sent",
        detail: `${persona}: "${text.slice(0, 80)}" (id: ${id})`,
      });
      return { result: `Message sent to owner of ${persona} (id: ${id})` };
    }

    // D2: Serve agentic_inbox (reader reads replies)
    // Plan D2: agentic_inbox(), persona is the session's (sess.persona)
    if ((e as any).tool === "mcp__agentic-plugin__agentic_inbox") {
      const persona = sess.persona;
      // Check if we are a reader
      if (sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: "agentic_inbox is for reader sessions only; the owner reads its own replies directly." };
      }
      // D2: require a live reader claim
      const hasClaim = await hasLiveReaderClaim(commonsStoreOf($), persona, sess.mySessionId);
      if (!hasClaim) {
        toolErrorsThisTurn++;
        return { deny: "agentic_inbox requires a live reader claim; the reader role is not held by this session." };
      }
      // D2: List inbox records for this persona, filtered to the caller's messages
      const allRecords = await listInboxRecords(commonsStoreOf($), persona);
      const myRecords = allRecords.filter((rec) => rec.from === sess.mySessionId);
      // D2: Append open asks for this persona
      const allAsks = await listAskRecords(commonsStoreOf($), persona);
      const openAsks = allAsks.filter((ask) => ask.status === "open");
      // Attach replies to records
      const withReplies = await Promise.all(myRecords.map(async (rec) => {
        const reply = await readReplyRecord(commonsStoreOf($), persona, rec.id);
        return reply ? { ...rec, reply: reply.text } : rec;
      }));
      return { result: JSON.stringify({ inbox: withReplies, asks: openAsks }, null, 2) };
    }

    // Goal constraint: deny Bash if the ROOT objective says so (R10).
    const rootForConstraint = sess.state.goals.find((g) => g.parentId === null);
    if (rootForConstraint &&
        e.tool === "Bash" && rootForConstraint.objective.toLowerCase().includes("no bash")) {
      toolErrorsThisTurn++;
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "goal",
        action: "deny",
        detail: `${rootForConstraint.id}: Bash denied by root constraint`,
      });
      await persist($);
      return { deny: "Bash is not allowed by the current goal" };
    }

    const r = await next(e);
    if ((r as { isError?: boolean }).isError === true) toolErrorsThisTurn++;
    return r;
  });

  // --- prompt.submit: inject memory + active goal as hidden context ---
  // Actuator 1: context injection (always on, free, cannot be refused).
  // Both owner and passive reader can inject (read-only access to sess.state).
  on("prompt.submit", async ($, e, next) => {
    // Capture the prompt text for the goal scorer.
    currentPrompt = e.text;
    // Item 2 backstop safety: mark whether this genuine external turn is
    // the supervisor's own synthetic priming message.
    isPrimingTurn = e.text.startsWith("[SUPERVISOR-PRIMING]");

    // D5b (bullet 1): an open ask never silences the worker. This hook fires
    // only for a genuine external turn - the controller's own $.prompt.submit
    // calls (nudges, operator-record delivery, the ask re-raise) bypass this
    // handler, per the nudgedTurn comment above. So any turn that reaches
    // here while an ask is open is the operator answering it, whether it
    // came from the keyboard or a Discord thread reply, and whether or not
    // it carries the ask id: close the ask and reactivate the paused node.
    if (sess.isOwner && sess.state.pendingAskId) {
      const askId = sess.state.pendingAskId;
      const store = commonsStoreOf($);
      const askRecord = await readAskRecord(store, sess.persona, askId);
      if (askRecord && askRecord.status === "open") {
        askRecord.status = "answered";
        await store.set(askKey(sess.persona, askId), askRecord);
        sess.state.pendingAskId = undefined;
        const askedNode = sess.state.goals.find((n) => n.id === askRecord.nodeId);
        if (askedNode) {
          askedNode.lastAskQuestion = askRecord.question;
          askedNode.lastAskClosedAt = Date.now();
          if (askedNode.status === "paused") {
            askedNode.status = "active";
            askedNode.updatedAt = Date.now();
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "goal",
              action: "activated",
              detail: `${askedNode.id}: reactivated (thread reply to ask ${askId})`,
            });
          }
        }
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "ask_answered_by_reply",
          detail: `ask ${askId} closed by thread reply, no ask id typed`,
        });
        await persist($);
      }
    }

    const r = await next(e);
    if (r.drop !== undefined) {
      return r;
    }

    const contextBlocks: string[] = [...(r.context ?? [])];

    // --- Active goal injection (M5: [GOAL TREE] shape per plan lines 349-354) ---
    const activeNode = sess.state.activeGoalId
      ? sess.state.goals.find((g) => g.id === sess.state.activeGoalId)
      : null;
    if (activeNode && activeNode.status === "active") {
      // Build the [GOAL TREE] block: Active, Path, Pending siblings, Last note.
      const parent = activeNode.parentId
        ? sess.state.goals.find((g) => g.id === activeNode.parentId)
        : null;
      const path = parent
        ? `root > ${parent.title.slice(0, 40)} > ${activeNode.title.slice(0, 40)}`
        : `root > ${activeNode.title.slice(0, 40)}`;
      const siblings = activeNode.parentId
        ? sess.state.goals.filter((g) => g.parentId === activeNode.parentId && g.id !== activeNode.id && g.status === "pending")
        : [];
      const siblingLine = siblings.length > 0
        ? `Pending siblings: ${siblings.map((s) => s.title.slice(0, 30)).join("; ")}\n`
        : "";
      const lastNote = activeNode.notes.length > 0
        ? `Last note: ${activeNode.notes[activeNode.notes.length - 1]}\n`
        : "";
      const goalBlock =
        `[GOAL TREE]\n` +
        `Active: ${activeNode.kind} ${activeNode.id} | round ${activeNode.completedRounds + 1}/${activeNode.maxRounds} | ${activeNode.objective}\n` +
        `Path: ${path}\n` +
        siblingLine +
        lastNote +
        `Keep working toward this objective. If the user's current request conflicts with it, follow the user.\n` +
        `When this step is done, call goal_done with a one-line note. ` +
        `If the result names a next goal, continue with it.`;
      contextBlocks.push(goalBlock);
      // L17: log each injected block.
      try { $.ui.log(`Agentic: [GOAL TREE] injected for ${activeNode.id}`); } catch { /* non-fatal */ }
    } else {
      // M5: when the tree is paused, inject a one-line reminder.
      const pausedNode = sess.state.goals.find((g) => g.status === "paused");
      if (pausedNode) {
        const pausedBlock = `Goal tree paused: ${pausedNode.blockedReason || "paused by controller"}. Call goal_resume to continue or goal_create to replace.`;
        contextBlocks.push(pausedBlock);
        try { $.ui.log(`Agentic: [GOAL TREE paused] injected`); } catch { /* non-fatal */ }
      } else if (sess.state.goals.length === 0) {
        // Passive-supervisor plan item 2: with no goal at all (never created,
        // or the root already completed), an operator message phrased as a
        // plain request has nothing telling the model to open a goal tree.
        // Without this reminder a cheap-tier child can read an ordinary
        // request as small talk and never call goal_create at all.
        const idleBlock =
          `No goal is active. If the message above describes something to ` +
          `accomplish, call goal_create with that as the objective before doing ` +
          `any other work - even a one-step or trivial-looking request, since ` +
          `size is not the test: a plain request that names no tool always opens ` +
          `a goal first. Then reply in one line naming the goal you took. Only ` +
          `skip goal_create if the message is not a request to accomplish ` +
          `anything (small talk, a question with no task attached).`;
        contextBlocks.push(idleBlock);
        try { $.ui.log(`Agentic: [NO GOAL] reminder injected`); } catch { /* non-fatal */ }
      }
    }

    // --- [ENV] block injection (G4: only when notable per plan section 4; push env_inject) ---
    const env = sess.state.monitor.env;
    const facts = envNotable(env, Date.now());
    if (facts.length > 0) {
      const envBlock = `[ENV] ${facts.join(", ")}\nEnvironment state above is current; act on it when it affects your plan.`;
      contextBlocks.push(envBlock);
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "monitor",
        action: "env_inject",
        detail: `env_inject: ${facts.join(", ")}`,
      });
      try { $.ui.log(`Agentic: [ENV] injected`); } catch { /* non-fatal */ }
    }

    // --- Lesson injection (S11: gated on lastInjectAt) ---
    const recentLessons = sess.state.memory
      .filter((m) => m.source === "self-review" && m.kind === "lesson")
      .sort((a, b) => b.createdAt - a.createdAt);
    if (recentLessons.length > 0) {
      const newest = recentLessons[0];
      const sr = sess.state.monitor.selfReview;
      if (sr && newest.createdAt > sr.lastInjectAt) {
        const lessonBlock = `[LESSON] ${newest.text}\nA self-review lesson from recent activity. Avoid repeating the same mistake.`;
        contextBlocks.push(lessonBlock);
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "lesson_inject",
          detail: `lesson_inject: ${newest.text.slice(0, 80)}`,
        });
        sr.lastInjectAt = Date.now();
        try { $.ui.log(`Agentic: [LESSON] injected`); } catch { /* non-fatal */ }
      }
    }

    // --- Memory injection (MEMQ seam) ---
    const candidates = sess.state.memory.filter((m) => m.confidence > 0.3);
    if (candidates.length > 0) {
      let entries: typeof candidates | undefined;

      // Try MEMQ MCP ranker first.
      try {
        const result = await $.mcp.call("MEMQ", "rank", {
          query: e.text.slice(0, 500),
          memories: candidates.map((m) => ({ id: m.id, text: m.text, kind: m.kind })),
        });
        if (result?.content?.length) {
          const textBlock = (result as any).content.find((c: any) => c.type === "text");
          if (textBlock) {
            const rankedIds: string[] = JSON.parse(textBlock.text);
            const byId = new Map(candidates.map((m) => [m.id, m]));
            const ranked = rankedIds.map((id) => byId.get(id)).filter(Boolean) as typeof candidates;
            if (ranked.length > 0) {
              entries = ranked.slice(0, 20);
              for (const m of entries) {
                m.lastAccessed = Date.now();
                m.accessCount += 1;
              }
            }
          }
        }
      } catch {
        // MEMQ unavailable: fall through to local ranking.
      }

      // Local fallback: confidence-ranked.
      if (!entries) {
        entries = [...candidates]
          .sort((a, b) => b.confidence - a.confidence || b.accessCount - a.accessCount)
          .slice(0, 20);
        for (const m of entries) {
          m.lastAccessed = Date.now();
          m.accessCount += 1;
        }
      }

      const memoryBlock =
        "Relevant user memories (persisted across sessions; treat as standing preferences unless the user overrides them):\n" +
        entries.map((m) => `- [${m.kind}] ${m.text}`).join("\n");
      contextBlocks.push(memoryBlock);
      // L17: log memory injection.
      try { $.ui.log(`Agentic: [MEMORY] injected (${entries.length} entries)`); } catch { /* non-fatal */ }
    }

    return {
      ...r,
      context: contextBlocks as readonly string[],
    };
  });

};


