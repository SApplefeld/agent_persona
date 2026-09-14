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

import type { PromptSubmitResult, Register } from "claude-code";
import {
  createDefaultState,
  parseState,
  shouldYield,
  yieldRecord,
  completeLeaf,
  activateNext,
  isActivationEligible,
  isPlanningDue,
  previousRoundBlocked,
  planningCapReached,
  applyTurnToErrors,
  envNotable,
  DECISIONS_MAX,
  MEMORY_MAX,
} from "./agent-state";
import type { AgentState, GoalNode, NudgeBudget, EnvGit, EnvState } from "./agent-state";
import {
  claimResource,
  readAllClaims,
  shouldYieldCommons,
  releaseResource,
  stampCommonsMeta,
  commonsWinner,
  readHolderMeta,
} from "./commons";
import type { CommonsStore } from "./commons";
import type { InboxRecord } from "./operator";
import {
  claimReaderRole,
  hasLiveReaderClaim,
  sweepExpiredRecords,
  enforceChannelWindow,
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
  isSelfScoringLesson,
  reviewOwnRecord,
  kaizenSortKey,
  KAIZEN_LONG_TURN_MS,
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

// One turn this plugin's own $.prompt.submit has queued and that has not
// opened yet; the list and its match rules are described at register()'s
// `expectedTurns`. An entry carries two match keys. `text` is the string
// handed to the submit. `settledText` is the text the resolved submit
// reports, which is the text as the hook chain beneath this plugin left it
// (another plugin's prompt.submit hook may rewrite it, and the engine caps
// it whole), and the text the turn then opens with. Both are kept because
// the contract does not order the submit promise settling against
// turn.start: a turn that opens before the submit's continuation has run
// matches on `text`, one that opens after matches on `settledText`. A
// UserPromptSubmit settings hook rewriting the text after the submit has
// settled defeats both keys; that turn reads unaccounted and a delivery
// record ages out unstamped.
type ExpectedTurn = { text: string; settledText?: string } & ({ kind: "delivery"; recordId: string } | { kind: "nudge" } | { kind: "plugin" });
type SubmitOutcome = { ok: true } | { ok: false; how: "failed" | "dropped"; reason: string };

// Runs one queued entry's $.prompt.submit and reads its result. A rejection
// and a resolved `{ drop }` (a hook beneath this plugin dropped the submit,
// which resolves rather than rejects) are one outcome: no turn is coming,
// so the entry leaves the list (by identity, never by position) and the
// caller gets the reason to record. A resolved `{ text }` stores the
// settled text on the entry as its second match key. No site reads the
// submit's result directly. Top level because it takes `dp`.
async function submitExpectedTurn(dp: any, expectedTurns: ExpectedTurn[], entry: ExpectedTurn): Promise<SubmitOutcome> {
  const unexpect = (): void => {
    const i = expectedTurns.indexOf(entry);
    if (i >= 0) expectedTurns.splice(i, 1);
  };
  let result: PromptSubmitResult;
  try {
    result = await dp.prompt.submit({ text: entry.text });
  } catch (err) {
    unexpect();
    return { ok: false, how: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (typeof result.drop === "string") {
    unexpect();
    return { ok: false, how: "dropped", reason: result.drop };
  }
  if (typeof result.text === "string") entry.settledText = result.text;
  return { ok: true };
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
  // register()'s list of queued plugin turns, so the re-raise below can be
  // queued as a plugin-opened turn for the stamp guard at turn.start.
  expectedTurns: ExpectedTurn[],
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
    // A refused re-raise is non-fatal: the decision log still shows the
    // re-raise, and its entry has left the list.
    const reraiseEntry: ExpectedTurn = { kind: "plugin", text: `${REPLY_INSTRUCTION}[STILL WAITING] ${askRecord.question}` };
    expectedTurns.push(reraiseEntry);
    await submitExpectedTurn(dp, expectedTurns, reraiseEntry);
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
// One persona's entry in the heartbeat sidecar. turnStartedAt is the owner's
// clock at turn.start while a turn runs and null between turns (plan item
// 8.3): a reader session in the same work directory reads it to tell a
// sender how long the owner's turn has held their pending record.
type HeartbeatEntry = { sessionId: string; epoch: number; lastSeen: number; turnStartedAt?: number | null };

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
  turnStartedAt: number | null; // plan item 8.3: this session's clock at turn.start, null between turns
  workdir: string; // the directory this session runs in, "" until session.start reads it
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
  turnStartedAt: null,
  workdir: "",
};

// The turn state and workdir every commons-entry write carries, so the entry
// tracks the turn the way the heartbeat file's own stamp does.
const commonsMeta = () => ({ turnStartedAt: sess.turnStartedAt, workdir: sess.workdir });

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

// Every prompt the plugin submits for the operator's eyes carries this, since
// a channel-attached child's own conversational reply is never visible to
// the operator through Discord (item 5, priming turn). Used by the ask
// re-raise (D5b) and the kaizen announcement (item 8.4). The prose-style
// clause is the same text CLAUDE.md's "Writing to the operator" section
// carries, kept in sync by hand with its harness-side copy in
// bin/supervise.sh (CHANNEL_REPLY_INSTRUCTION).
const REPLY_INSTRUCTION = "You are attached to a Discord channel. When you want to say something back to the operator, call the reply tool from the channel-relay MCP server - your own conversational reply is not visible to them. Plain prose, never mannered prose. This governs every reply-tool message the operator reads. Write for a reader on a phone with no session context. One idea per sentence, about twenty words. Answer first, then the reason, then the evidence. Never carry a second rule inside the clause of the first. Never nest a qualification in parentheses or after a semicolon. Name the concrete thing that happened rather than the class it belongs to. Keep precision by adding a sentence, never by packing one. Vary sentence length, because uniform length is its own defect and the twenty is a per-sentence check rather than a target. Use plain words for internal names unless the exact value is what the operator needs to act on. Decide before writing. Never include round numbers, steer numbers, or session ids. End the message when the content ends. When you ask the operator a question, or report something they must decide, give the whole shape: what is happening and why it came up, the question in plain words, what it blocks, each option with what it costs, and your recommendation with its reason. A bare question or a bare pick is not enough. When the operator asks what is going on, or a result is not what they expected, give the outcome, then the reason, then the evidence, each in its own sentence. A shipped notice stays short; an explanation earns its length. ";

// Item 5 (Bounded store): the one append-only rollover log every capped
// store writes to when something falls off its window - the commons
// store's closed inbox/reply records (enforceChannelWindow) and the
// persona file's own decision log and memory cap (persist(), below). Same
// one-JSON-object-per-line rule as the yield log, appended rather than
// rewritten, so the file that grows without bound is this one, by design,
// not the store the plugin reads and rewrites whole on every tick.
const CHANNEL_LOG_PATH = ".agentic-channel.jsonl";
// Bound on the note agentic_resolve writes into the shared commons store.
const RESOLVE_NOTE_MAX = 2000;
// Round 47 finding 1: this used to swallow every write error, and
// enforceChannelWindow deleted the rolled store keys regardless of whether
// the append actually landed - a failed write meant the record vanished
// with no proof it went anywhere. Callers that delete on success (the
// commons window) must see a thrown error and skip the delete; callers
// that only ever mutate in-memory state after a successful roll (the
// decision/memory caps in persist()) let it propagate too, since a decision
// or memory entry silently dropped is the same defect either way.
const appendToChannelLog = async (dp: any, lines: string[]): Promise<void> => {
  if (lines.length === 0) return;
  const existing = await dp.fs.exists(CHANNEL_LOG_PATH) ? await dp.fs.read(CHANNEL_LOG_PATH) : "";
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await dp.fs.write(CHANNEL_LOG_PATH, existing + sep + lines.join("\n") + "\n");
};

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
    await releaseResource(commonsStoreOf(dp), `persona:${sess.persona}`, sess.mySessionId, Date.now(), commonsMeta());
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
    const hb: Record<string, HeartbeatEntry> =
      await dp.fs.exists(heartbeatPath)
        ? (JSON.parse(await dp.fs.read(heartbeatPath)) as Record<string, HeartbeatEntry>)
        : {};
    hb[sess.persona] = { sessionId: sess.mySessionId, epoch: sess.myEpoch, lastSeen: Date.now() };
    await dp.fs.write(heartbeatPath, JSON.stringify(hb, null, 2));
  } catch { /* heartbeat write failed; non-fatal */ }
};

// Owner-only heartbeat write: sessionId, epoch, lastSeen now, and the
// session's turnStartedAt (plan item 8.3). Owner write sites use this so the
// heartbeat tick does not overwrite the turn stamp with an entry that lacks
// it. writeClaimDirect below is the exception and writes no turnStartedAt, so
// a promotion taken mid-turn drops the published stamp until the next tick;
// that gap is recorded in docs/backlog.md rather than fixed here. Declared at the top of the file, as
// writeClaimDirect and persist are, because the hooks loader only lets $
// be passed to a function declared here.
const writeOwnerHeartbeat = async (dp: any): Promise<void> => {
  const heartbeatPath = ".agentic-heartbeat.json";
  const hb: Record<string, HeartbeatEntry> =
    await dp.fs.exists(heartbeatPath)
      ? (JSON.parse(await dp.fs.read(heartbeatPath)) as Record<string, HeartbeatEntry>)
      : {};
  hb[sess.persona] = { sessionId: sess.mySessionId, epoch: sess.myEpoch, lastSeen: Date.now(), turnStartedAt: sess.turnStartedAt };
  await dp.fs.write(heartbeatPath, JSON.stringify(hb, null, 2));
};

// M7: single guarded-write path shared by every store write site.
// Closes over sess so all write sites share one yield + write path.
export const persist = async (dp: any): Promise<boolean> => {
  if (!sess.isOwner) return false;
  sess.state.updatedAt = Date.now();

  // Item 5 (Bounded store): cap the decision log and memory at push time,
  // not only when the file happens to be parsed at a session load - a
  // long-lived child never reloads, which is why the running worker's file
  // held over 500 decisions against a cap of 200 that only ever applied on
  // read. Overflow rolls to the append-only channel log rather than being
  // silently dropped.
  if (sess.state.decisions.length > DECISIONS_MAX) {
    const overflow = sess.state.decisions.slice(0, sess.state.decisions.length - DECISIONS_MAX);
    // Round 47: append before trimming - a failed write must not lose the
    // overflow with no record anywhere. Only drop the in-memory entries
    // once the log actually holds them.
    try {
      await appendToChannelLog(dp, overflow.map((d) => JSON.stringify({ persona: sess.persona, kind: "decision", rolledAt: Date.now(), record: d, logPath: CHANNEL_LOG_PATH })));
      sess.state.decisions = sess.state.decisions.slice(-DECISIONS_MAX);
    } catch (err) {
      // Round 50 point 3: name the refusal instead of staying silent - the
      // overflow stays in memory for the next persist() to retry, but the
      // next gate must be able to tell "nothing to roll" from "roll refused".
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "worker",
        action: "channel_window_roll_failed",
        detail: `decision cap roll refused, overflow kept in memory (persona: ${sess.persona}): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (sess.state.memory.length > MEMORY_MAX) {
    // Evict oldest non-pinned entries first; pinned entries never roll off.
    const pinned = sess.state.memory.filter((m) => m.pinned);
    const unpinned = sess.state.memory.filter((m) => !m.pinned).sort((a, b) => a.createdAt - b.createdAt);
    const keepUnpinnedCount = Math.max(0, MEMORY_MAX - pinned.length);
    const overflowCount = unpinned.length - keepUnpinnedCount;
    if (overflowCount > 0) {
      const overflow = unpinned.slice(0, overflowCount);
      const kept = unpinned.slice(overflowCount);
      try {
        await appendToChannelLog(dp, overflow.map((m) => JSON.stringify({ persona: sess.persona, kind: "memory", rolledAt: Date.now(), record: m, logPath: CHANNEL_LOG_PATH })));
        // Restore original relative order (createdAt) across pinned + kept.
        sess.state.memory = [...pinned, ...kept].sort((a, b) => a.createdAt - b.createdAt);
      } catch (err) {
        // Round 50 point 3: same naming as the decision cap above - the
        // overflow stays in memory for the next persist() to retry.
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "worker",
          action: "channel_window_roll_failed",
          detail: `memory cap roll refused, overflow kept in memory (persona: ${sess.persona}): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
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
        await releaseResource(commonsStoreOf(dp), resource, sess.mySessionId, Date.now(), commonsMeta());
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
  // The turns this plugin's own $.prompt.submit calls have queued and that
  // have not opened yet. Every such call bypasses this plugin's own
  // prompt.submit hook, so nothing else tells a turn it opened from any
  // other: each submit site pushes its entry on the synchronous side
  // immediately before its submit, carrying the exact text it hands the
  // submit, and runs the submit through the top-level submitExpectedTurn,
  // which removes that same entry (by identity, never by position) when no
  // turn is coming. turn.start matches e.text, the text the turn begins
  // with, against each queued entry's two keys (the ExpectedTurn type above
  // says why there are two) and removes the match wherever it sits; that
  // entry's kind is the turn's kind. A delivery entry carries the inbox
  // record its [OPERATOR] prompt delivered, which only that turn stamps and
  // answers; a nudge entry tells turn.complete to score with the
  // nudge-aware label set, since currentPrompt still holds the stale user
  // text; a plugin entry is the kaizen announcement, the reply backstop or
  // the ask re-raise, a turn that stamps nothing. Two queued submits with
  // identical text are a known limit: the first queued entry wins.
  const expectedTurns: ExpectedTurn[] = [];
  const expectTurn = (entry: ExpectedTurn): ExpectedTurn => { expectedTurns.push(entry); return entry; };
  const unexpectTurn = (entry: ExpectedTurn): void => {
    const i = expectedTurns.indexOf(entry);
    if (i >= 0) expectedTurns.splice(i, 1);
  };
  // What the turn now running opened as, set at turn.start from the entry
  // its text matched ("unaccounted" for one that matched none, whether
  // external, a continuation or unknown) and read at turn.complete.
  let currentTurnKind: ExpectedTurn["kind"] | "unaccounted" = "unaccounted";
  // A delivery whose $.prompt.submit rejected or was dropped: its entry has
  // left the list and the refusal is recorded, and nothing else. The record
  // stays as the delivery wrote it and ages out under the TTL; no delivery
  // is retried.
  const recordFailedDelivery = (rec: InboxRecord, outcome: { how: string; reason: string }): void => {
    sess.state.decisions.push({
      timestamp: Date.now(),
      loop: "monitor",
      action: "operator_delivery_failed",
      detail: `record ${rec.id} submit ${outcome.how}; left as delivered: ${outcome.reason}`.slice(0, 200),
    });
  };
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
  // Steer 68/69: whether the real prompt.submit hook (a genuine external
  // turn) just saw e.origin.kind === "channel" - a message that arrived
  // through the Discord relay, as opposed to the keyboard, an SDK caller,
  // or one of this plugin's own internal $.prompt.submit calls (which
  // bypass this hook and so never touch this flag). Consumed by the very
  // next turn.start, the same one-flag handoff isPrimingTurn already uses.
  let lastPromptWasChannelOrigin = false;
  // Whether the real prompt.submit hook fired at all since the last
  // turn.start: true for every genuine external turn (keyboard, SDK caller,
  // channel), never for one of this plugin's own $.prompt.submit calls,
  // which bypass the hook. Consumed by the very next turn.start, the same
  // one-flag handoff as above; it is what tells the delivery's own turn
  // from any other, since a keyboard turn carries no origin the channel
  // flag would see.
  let lastPromptWasExternal = false;
  // Whether THIS turn (the one now running) started from a channel
  // message, captured at turn.start from the flag above so turn.complete
  // can act on it after the flag has already reset for the next prompt.
  let currentTurnIsChannelOrigin = false;
  // Whether the reply tool (channel-relay's mcp__..__reply) was called
  // anywhere during the current turn. Reset at turn.start, set by tool.call.
  let replyCalledThisTurn = false;
  // The turns open right now, each id against the clock at its turn.start, so
  // the controller tick can skip while the worker is inside one.
  // Keyed by id rather than held as a boolean because turn events are not
  // reliably paired:
  // two turns can be open at once, and a turn.complete can arrive for a turn
  // whose turn.start this session never saw. A boolean carries only the last
  // event, so any single completion reads as "no turn open" however many turns
  // are still running, and the tick then nudges into a live turn. A completion
  // for an id not in the map removes nothing and leaves the reading alone.
  //
  // The map holds no entry a live process cannot account for. A turn.complete
  // is delivered whatever the turn's reason, an abort included, so an id is
  // left behind only by a failure below the harness, and a failure that takes
  // the host down takes this in-process map with it. That is why the reading
  // needs no age-out: there is no state a running process can reach in which
  // an entry here is not a turn.
  //
  // The value is that turn's own start time. turn.complete reads it two ways:
  // the long-turn record measures against the completing turn's own entry, and
  // sess.turnStartedAt, the stamp a reader session sees, is derived from the
  // earliest entry left after the delete.
  const openTurns = new Map<string, number>();
  const turnIsOpen = () => openTurns.size > 0;
  // The published stamp names the earliest turn still open, or null when none
  // is. Both turn handlers derive it through here rather than each writing its
  // own value: a start that simply stamped its own clock would move the stamp
  // forward whenever a second turn opened, and a reader in another process
  // would watch one pending record's deferral shrink and then grow again.
  const deriveTurnStartedAt = (): number | null => {
    let earliest: number | null = null;
    for (const startedAt of openTurns.values()) {
      if (earliest === null || startedAt < earliest) earliest = startedAt;
    }
    return earliest;
  };
  // Plan item 8.3: an urgent inbox record is looked for on the owner's
  // passthrough tool calls; this throttles that store read to once per
  // urgentCheckMinMs, since a long turn can make a tool call every second.
  let lastUrgentCheckAt = 0;
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
  const urgentCheckMinMs = typeof cfg.urgentCheckMinMs === "number" ? (cfg.urgentCheckMinMs as number) : 5_000;
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
  // Plan item 8.4: mutable, because the own-record pass halves it when turns
  // repeatedly run past an hour (a cadence counted in turns reviews too
  // rarely then); a restart returns to the configured value and the pass
  // re-applies the change if the record still shows the weakness.
  let selfReviewEveryTurns = typeof cfg.selfReviewEveryTurns === "number" ? (cfg.selfReviewEveryTurns as number) : 20;
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
    // The event carries cwd; $.session.cwd() is the fallback when it does not.
    try {
      if (typeof e.cwd === "string" && e.cwd.length > 0) {
        sess.workdir = e.cwd;
      } else {
        const cwd = await $.session.cwd();
        if (typeof cwd === "string") sess.workdir = cwd;
      }
    } catch {
      // cwd unavailable; the commons entry publishes "" for it
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
      name: "supervisor_restart",
      description:
        "Relaunch the supervised child without stopping the supervisor: this child exits by the graceful EOF " +
        "path and a fresh one starts with the goal tree intact and resumes the active plan. Use when the operator " +
        "asks for a restart, or to pick up an updated runtime (a plugin update) without ending the run. Never for " +
        "a completed goal (goal_done already returns the supervisor to its passive waiting state). Owner only.",
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Optional. Why the operator asked for a restart.",
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
        "The owner sees the message on its next quiet tick; while the owner is inside a turn the record waits, and agentic_inbox " +
        "shows it as deferred with the turn's running time. Pass urgent: true to reach the owner inside the running turn instead, " +
        "folded into its next tool result. Use for steering, reporting, or asking questions.",
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
          urgent: {
            type: "boolean",
            description: "Optional. Deliver inside the owner's current turn (as context on its next tool result) rather than waiting for a quiet tick. Not for answering an ask.",
          },
        },
        required: ["text"],
      },
    });

    await $.tool.register({
      name: "agentic_inbox",
      description:
        "Read replies from the owner session of this persona. The reader session calls this to poll for replies to its messages. " +
        "Returns {inbox: [{id, from, at, text, kind, status, reply?, deferred?, turnRunningMs?, outcome?, note?, resolvedAt?}], asks: [{id, at, nodeId, question, status}]}. " +
        "A pending record carries deferred: true and turnRunningMs while the owner is inside a turn: it waits for that turn to end. " +
        "A resolved record carries outcome (done or declined), note and resolvedAt: the owner finished or declined the work, which a reply alone does not say. " +
        "Answer an open ask with agentic_say(text, answers: <ask id>).",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    });

    await $.tool.register({
      name: "agentic_resolve",
      description:
        "Owner only. Mark an operator record addressed to this persona as resolved once the work it asked for is finished or declined. " +
        "A reply says a turn answered; a resolution says the work is done. The sender reads outcome, note and resolvedAt through agentic_inbox. " +
        "Refused for a record still pending (not delivered yet), for a skipped record, and for a record addressed to another persona.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The record id, <persona>-<sender session id>-<seq>, the same id the sender sees in agentic_inbox.",
          },
          outcome: {
            type: "string",
            description: "done when the work finished, declined when it will not be done.",
          },
          note: {
            type: "string",
            description: "Optional short note for the sender: what was done, or why it was declined. At most 2000 characters; a longer note is refused.",
          },
        },
        required: ["id", "outcome"],
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
      let holderHb: HeartbeatEntry | null = null;
      try {
        if (await $.fs.exists(heartbeatPath)) {
          const hb = JSON.parse(await $.fs.read(heartbeatPath)) as Record<string, HeartbeatEntry>;
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
        await claimReaderRole(commonsStoreOf($), sess.persona, sess.mySessionId, Date.now(), commonsMeta());
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
        await writeOwnerHeartbeat($);
      } catch { /* heartbeat write failed; non-fatal */ }
      // BC3: claim the persona in commons at start, so the owner holds the
      // commons claim before its first turn. Without this, a reader calling
      // agentic_identity in the first 30s (before the first heartbeat) finds
      // no live persona:default claim and takes ownership, evicting the owner.
      try {
        const resource = `persona:${sess.persona}`;
        await claimResource(commonsStoreOf($), resource, sess.mySessionId, Date.now(), commonsMeta());
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
              await writeOwnerHeartbeat($);
            } catch { /* heartbeat write failed */ }
            // Commons: refresh lastSeen to signal liveness (Stage 2 integration).
            try {
              const resource = `persona:${sess.persona}`;
              await claimResource(commonsStoreOf($), resource, sess.mySessionId, Date.now(), commonsMeta());
            } catch { /* non-fatal */ }
          }
        }

        // BE3: non-owner heartbeat tick refreshes the reader claim (idempotent).
        // Without this, the reader claim goes stale at 90s and agentic_inbox
        // denies the reader.
        if (!sess.isOwner) {
          try {
            await claimReaderRole(commonsStoreOf($), sess.persona, sess.mySessionId, Date.now(), commonsMeta());
          } catch { /* non-fatal */ }
        }

        // Passive reader: promote if the sidecar holder is stale and not self.
        // With the shouldYield check above, the sidecar is only ever
        // written by the store's current owner, so a stale sidecar means no
        // live owner, no store-owner comparison needed.
        if (!sess.isOwner) {
          let holderHb: HeartbeatEntry | null = null;
          try {
            if (await $.fs.exists(heartbeatPath)) {
              const hb = JSON.parse(await $.fs.read(heartbeatPath)) as Record<string, HeartbeatEntry>;
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
      if (turnIsOpen()) return;

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
                const answerText = `[OPERATOR] Answer to ${askRecord.question}: ${answer.text}`;
                const expectedAnswerTurn = expectTurn({ kind: "delivery", recordId: answer.id, text: answerText });
                const answerOutcome = await submitExpectedTurn($, expectedTurns, expectedAnswerTurn);
                if (!answerOutcome.ok) recordFailedDelivery(answer, answerOutcome);
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
        // Round 32/36: mark a dead writer's record skipped once, on its own
        // key, rather than re-logging the same decision every tick forever -
        // once `status` is "skipped" it drops out of `pending` above on the
        // next `listInboxRecords` read, so the record costs one line total.
        for (const rec of withoutClaim) {
          await store.set(rec.key, { ...rec, status: "skipped" });
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "operator_skipped_no_claim",
            detail: `record ${rec.id} writer ${rec.from} has no live reader claim (marked skipped)`,
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
          const deliveryText = "[OPERATOR] " + oldest.text;
          const expectedDeliveryTurn = expectTurn({ kind: "delivery", recordId: oldest.id, text: deliveryText });
          const deliveryOutcome = await submitExpectedTurn($, expectedTurns, expectedDeliveryTurn);
          if (!deliveryOutcome.ok) recordFailedDelivery(oldest, deliveryOutcome);
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

        // AT5: Sweep expired operator records on the summary cadence (owner only).
        // The sweep appends each inbox and reply record to the channel log
        // before deleting it and throws on a refused append with every record
        // still in the store, so a refusal reads as its own decision rather
        // than as a quiet count of zero, the same split the window roll below
        // makes.
        if (sess.isOwner) {
          const ttlMs = typeof cfg.operatorRecordTtlMs === "number" ? (cfg.operatorRecordTtlMs as number) : 86400000;
          try {
            const swept = await sweepExpiredRecords(
              commonsStoreOf($),
              sess.persona,
              (lines) => appendToChannelLog($, lines),
              ttlMs,
            );
            if (swept > 0) {
              sess.state.decisions.push({
                timestamp: Date.now(),
                loop: "worker",
                action: "sweep_expired_records",
                detail: `swept ${swept} expired operator records (persona: ${sess.persona})`,
              });
            }
          } catch (err) {
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "worker",
              action: "sweep_expired_records_failed",
              detail: `sweep refused, records left in store (persona: ${sess.persona}): ${err instanceof Error ? err.message : String(err)}`,
            });
          }

          // Item 5 (Bounded store): the shared store keeps only a short
          // window of recent inbox/reply records - overflow rolls to the
          // append-only channel log instead of staying in the one JSON
          // file forever. Open asks are untouched (a different function,
          // a different lifecycle).
          const channelWindowSize = typeof cfg.channelRecordWindow === "number" ? (cfg.channelRecordWindow as number) : 50;
          // Round 50 point 3: enforceChannelWindow now throws instead of
          // swallowing a failed append, so "nothing to roll" (0, no error)
          // and "a roll was refused" (thrown, records still in the store)
          // read as two different decisions - the next gate can tell them
          // apart instead of seeing the store quietly stop shrinking.
          try {
            const rolled = await enforceChannelWindow(
              commonsStoreOf($),
              sess.persona,
              channelWindowSize,
              (lines) => appendToChannelLog($, lines),
            );
            if (rolled > 0) {
              sess.state.decisions.push({
                timestamp: Date.now(),
                loop: "worker",
                action: "channel_window_rolled",
                detail: `rolled ${rolled} closed inbox/reply records to ${CHANNEL_LOG_PATH} (persona: ${sess.persona})`,
              });
            }
          } catch (err) {
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "worker",
              action: "channel_window_roll_failed",
              detail: `roll refused, records left in store (persona: ${sess.persona}): ${err instanceof Error ? err.message : String(err)}`,
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
            // Plan item 8.4: before asking the model for a lesson, read the
            // worker's own record mechanically. A repeated weakness becomes a
            // kaizen goal (a plan under the root with a proof line, announced
            // to the operator's thread in one line), or, where the loop can
            // answer it by changing its own configuration, a change applied
            // here and reported. When either happens the review is spent on
            // it and no model lesson is written: a finding about the worker's
            // own record is exactly the class item 8.2 keeps out of memory.
            const inboxForReview = sess.isOwner ? await listInboxRecords(commonsStoreOf($), sess.persona) : [];
            const findings = reviewOwnRecord(
              { decisions: sess.state.decisions, memory: sess.state.memory, goals: sess.state.goals, inbox: inboxForReview },
              { selfReviewEveryTurns, selfReviewDebounceTurns },
            );
            const root = sess.state.goals.find((g) => g.parentId === null);
            const announced: string[] = [];
            for (const f of findings) {
              if (f.configFix) {
                selfReviewEveryTurns = f.configFix.to;
                sess.state.decisions.push({
                  timestamp: now,
                  loop: "monitor",
                  action: "kaizen_config_adjusted",
                  detail: `${f.signal} x${f.count}: ${f.configFix.knob} ${f.configFix.from} -> ${f.configFix.to}`,
                });
                announced.push(f.rationale);
                continue;
              }
              // A goal needs a tree to live in; with no root the finding waits
              // for the next review, when one may exist.
              if (!root) continue;
              const node: GoalNode = {
                id: `plan-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                parentId: root.id,
                kind: "plan",
                title: f.title.slice(0, 80),
                objective: f.objective.slice(0, 500),
                status: "pending",
                source: "controller",
                planningRounds: 0,
                consecutiveBlockedPlannings: 0,
                consecutivePlanningFailures: 0,
                planningRound: 0,
                maxRounds: 10,
                completedRounds: 0,
                scores: [],
                notes: [],
                createdAt: now,
                updatedAt: now,
                sortKey: kaizenSortKey(sess.state.goals, root.id, now),
                kaizenSignal: f.signal,
              };
              sess.state.goals.push(node);
              sess.state.decisions.push({
                timestamp: now,
                loop: "goal",
                action: "kaizen_goal_proposed",
                detail: `${node.id} (${f.signal} x${f.count}): "${f.title.slice(0, 50)}"`,
              });
              announced.push(`${f.rationale} (${f.signal}, node ${node.id})`);
            }
            if (announced.length > 0) {
              sess.state.decisions.push({
                timestamp: now,
                loop: "monitor",
                action: "self-review",
                detail: `${trigger}: own record -> ${announced.length} kaizen finding(s), no lesson`,
              });
              sr.count += 1;
              if (sr.windowStart === 0) sr.windowStart = now;
              sr.lastAt = now;
              sr.turnsSince = 0;
              sr.pendingPeriodic = false;
              sess.state.updatedAt = now;
              await persist($);
              const kaizenText =
                `${REPLY_INSTRUCTION}[KAIZEN] Post each line below to the operator's thread as written, then continue your work:\n` +
                announced.map((line) => `- ${line}`).join("\n");
              // A refused announcement is non-fatal: the decision log still
              // carries the finding, and its entry has left the list.
              await submitExpectedTurn($, expectedTurns, expectTurn({ kind: "plugin", text: kaizenText }));
            }
            if (announced.length === 0) {
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
                // Item 8.2: a memory entry comes from a proof passing or an
                // operator correction, never from the classifier scoring its
                // own confusion. Refuse the latter before the dedupe check.
                if (isSelfScoringLesson(lesson)) {
                  sess.state.decisions.push({
                    timestamp: Date.now(),
                    loop: "memory",
                    action: "memory_lesson_refused",
                    detail: `self-scoring lesson refused: ${lesson.slice(0, 80)}`,
                  });
                } else if (!dedupeSelfReview(sess.state.memory, lesson)) {
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
            }
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
              // Queued before the submit, as the goal nudge does: the submit
              // parks until the session is next idle, so an entry pushed
              // after it would land only once the nudged turn had already run.
              const nudgeText =
                `[BUDGET] Context is at ${estimatedTokens} tokens (close-out threshold: ${sess.contextBudgetCloseoutTokens}).\n` +
                `Bank your current state to memory and the plan doc, then reach a clean stopping point. ` +
                `The session will be restarted at the critical threshold; bank state now.`;
              const budgetOutcome = await submitExpectedTurn($, expectedTurns, expectTurn({ kind: "nudge", text: nudgeText }));
              if (budgetOutcome.ok) {
                sess.state.decisions.push({
                  timestamp: budgetTs,
                  loop: "monitor",
                  action: "context_budget_nudge",
                  detail: `${estimatedTokens} tokens, close-out nudge sent`,
                });
              } else {
                // Non-fatal. No nudged turn is coming, so its entry has left
                // the list: left in, the tick's next delivery turn would open
                // as the nudge and its record would go unstamped.
                sess.state.decisions.push({
                  timestamp: budgetTs,
                  loop: "monitor",
                  action: "context_budget_nudge_failed",
                  detail: `close-out nudge submit ${budgetOutcome.how}: ${budgetOutcome.reason}`.slice(0, 200),
                });
              }
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
        const askResult = await tickOpenAsk($, sess.state, sess.persona, cfg, null, expectedTurns);
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
        const askResult = await tickOpenAsk($, sess.state, sess.persona, cfg, g.id, expectedTurns);
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
            // Round 58 finding 3: this used to write an ask record from controller prose here - the
            // same class of defect item 8.2 removed from the classifier's ask-operator and pause
            // verdicts, just reached through a third path. The nudge cap has no concrete question to
            // ask, only an idle reading, exactly like the classifier paths: it pauses the node with
            // the cap reason and opens nothing. Round 60 finding 3(b): turn.complete reactivates it
            // on the worker's next completed turn that calls a real work tool (pausedByNudgeCap
            // below is the marker it reads), or goal_resume reactivates it explicitly; no ask, no
            // pendingAskId, nothing waiting on an operator answer that was never asked for.
            try { $.ui.toast(`Agentic: ${capReason}`); } catch { /* non-fatal */ }
            if (g.status === "active") {
              // BG1: nudge cap → paused + no activate (tree stays put, no ask open on it).
              g.status = "paused";
              g.blockedReason = capReason;
              g.pausedByNudgeCap = true;
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
          // Item 8.2 (Round 36, extended Round 39): neither classifier
          // verdict that used to open an ask directly from classifier prose
          // - "ask-operator" nor "pause" - opens an ask record anymore.
          // Word-matching the model's reason text for "unclear"/"scope"/
          // idle-gap language let real forks through unrecognized (eighteen
          // ask wordings in one day matched no keyword list), and the
          // nineteenth ask arrived through "pause" specifically, proving
          // the same classifier prose problem exists on that verdict too.
          // So the rule is structural and covers both: either verdict
          // becomes a nudge here, unconditionally, before the reason call
          // even runs (a failed reason call must not fall through to
          // opening an ask with "no reason", which the old in-try
          // conversion did). The nudge tells the worker to re-read the plan
          // and discussion file and, if a fork truly exists, state it in
          // its own next turn as a line `ASK: <question>? Recommend:
          // <choice>`. Only that marker (read on turn.complete, below)
          // opens an ask record, with the worker's own line as the stored
          // question - never the classifier's reason.
          let idleGapConverted = false;
          if (finalDecision === "ask-operator" || finalDecision === "pause") {
            const convertedFrom = finalDecision;
            finalDecision = "nudge";
            idleGapConverted = true;
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "monitor",
              action: "ask_idle_gap_converted",
              detail: `${g.id}: classifier ${convertedFrom} converted to nudge (worker states a real fork itself, if one exists)`,
            });
          }

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
            // A nudge wakes an idle worker, and a worker inside an open turn is
            // not idle, so no nudge is sent while a turn is open. The tick's
            // in-flight check passes synchronously while the classify call that
            // follows is async, so a turn can open underneath a tick already on
            // its way to this line. That is why the open-turn reading is taken
            // again here rather than trusted from the top of the tick. A
            // submission made here would not reach the running turn at all. It
            // is queued and runs once the session is idle, so it arrives as
            // part of the next turn's prompt, one identical copy per tick,
            // rather than waking anything.
            if (turnIsOpen()) {
              sess.state.decisions.push({
                timestamp: tickTs,
                loop: "monitor",
                action: "nudge_skipped_turn_in_flight",
                detail: `${g.id}: idle ${idleDisplay}, turn in flight`,
              });
            } else if (now - sess.lastNudgeAt >= nudgeFloorMs) {
              // Nudge floor.
              // AK2: Guard only (silent). The nudge-cap check before classify already handles the cap.
              // If we reached here, the cap was not latched at the pre-classify check.
              if (nudgeCapped) {
                return;
              }
              // R8: nudge text appends goal_done instruction. Item 8.2
              // (Round 36): a converted ask-operator gets its own text -
              // re-read the plan and the discussion file, and only state a
              // fork as a literal marker line if one truly exists, since
              // the classifier itself never carries a concrete blocking
              // question, only an idle reading.
              const nudgeText = idleGapConverted
                ? `[GOAL] The active goal is: ${g.objective}\n` +
                  `The controller read this as an idle gap, not a real fork: no concrete blocking question. ` +
                  `Re-read the plan doc and DISCUSSION.md before continuing - the next concrete step should already be there.\n` +
                  `If you genuinely hold a fork the plan doesn't resolve, state it in this turn as a line: ASK: <question>? Recommend: <choice>\n` +
                  `Otherwise take the next concrete step. When this step is done, call goal_done with a one-line note. ` +
                  `If the result names a next goal, continue with it.`
                : `[GOAL] The active goal is: ${g.objective}\n` +
                  `The Controller detected ${idleDisplay} of idle time. ` +
                  `Re-read the objective and take the next concrete step toward it.\n` +
                  `When this step is done, call goal_done with a one-line note. ` +
                  `If the result names a next goal, continue with it.`;
              // The floor is spent here, before the submit, so that the test
              // above and this write are one synchronous step. $.prompt.submit
              // does not resolve until the session is next idle, so during a
              // long turn it parks; writing the floor after it would leave
              // every tick reading the same stale stamp, passing the floor,
              // and queueing another identical copy of this prompt. The cost
              // of spending it first is that a submit that throws has still
              // consumed the floor and the next nudge waits it out, which the
              // nudge_failed record below is there to make visible.
              //
              // The stamp is the clock now rather than the tick's own `now`,
              // which was taken before the classify call: classify latency
              // would otherwise come out of the floor and shorten it.
              sess.lastNudgeAt = Date.now();
              // The rest of this nudge's own bookkeeping is spent here for the
              // same reason as the floor. The region from the open-turn check
              // above to this point is synchronous, so all three writes are made
              // for a nudge that is going out between turns; on the far side of
              // the submit a whole worker turn may have run and been scored, and
              // each of the three then lands too late for the turn it is about.
              //
              // The escalation counter would land after the reset an on-goal
              // score performs, so a nudge the worker met would not clear its
              // own count, and two unmet nudges after a met one would reach the
              // cap that pauses the node, a round earlier than the worker
              // earned. The nudged-turn flag would land after the turn.complete
              // that reads it, leaking into the following turn and scoring an
              // ordinary turn with the nudge-aware label set. The prompt text
              // would land after the scorer had already judged the answer
              // against the previous turn's prompt.
              currentPrompt = nudgeText;
              const expectedNudgeTurn = expectTurn({ kind: "nudge", text: nudgeText });
              sess.consecutiveNudgesWithoutOnGoal += 1;
              // What this nudge made the count, read here rather than after
              // the submit, so the record names the count this nudge reached
              // rather than whatever a turn completing in the meantime left
              // behind.
              const nudgeNumber = sess.consecutiveNudgesWithoutOnGoal;
              // Only the submit's own outcome is read here, so a throw from
              // the ledger writes below is not recorded as a submit failure.
              const nudgeOutcome = await submitExpectedTurn($, expectedTurns, expectedNudgeTurn);
              if (!nudgeOutcome.ok) {
                // Non-fatal, as every actuator failure here is. It is recorded
                // because the floor was already spent above, so a refused submit
                // costs a whole nudge window and would otherwise leave nothing
                // anywhere saying the worker went un-nudged. No nudged turn is
                // coming, so its entry has left the list: left in, the tick's
                // next delivery turn would open as the nudge and lose its stamp.
                sess.state.decisions.push({
                  timestamp: tickTs,
                  loop: "monitor",
                  action: "nudge_failed",
                  detail: `${g.id}: submit ${nudgeOutcome.how}, floor already spent: ${nudgeOutcome.reason}`.slice(0, 200),
                });
              }
              if (nudgeOutcome.ok) {
                // D1: increment nudge ledger (count only, no token estimate)
                sess.state.monitor.cost.nudge.count += 1;
                // D3: update nudge window
                sess.state.monitor.cost.nudgeWindow = bumpWindow(sess.state.monitor.cost.nudgeWindow, now);
                sess.state.decisions.push({
                  timestamp: tickTs,
                  loop: "monitor",
                  action: "nudge_sent",
                  detail: `${g.id}: idle ${idleDisplay}, nudge #${nudgeNumber}`,
                });
              }
            } else {
              // The decider said nudge and the floor held. This is the ordinary
              // outcome for the second of two ticks alive at once, and it is
              // recorded so that a quiet stretch reads as the floor doing its
              // job rather than as the decider never having run.
              sess.state.decisions.push({
                timestamp: tickTs,
                loop: "monitor",
                action: "nudge_skipped_floor",
                detail: `${g.id}: idle ${idleDisplay}, floor not elapsed`,
              });
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
    // The turn is open from here until a completion carrying this same id.
    openTurns.set(e.turnId, Date.now());
    // Plan item 8.3: publish a start so a reader session can report how long a
    // pending record has waited. The value names the earliest turn still open,
    // which on an overlap is not this one. Derived through the helper so this
    // handler and turn.complete agree on what the published value means.
    sess.turnStartedAt = deriveTurnStartedAt();
    if (sess.isOwner) {
      try { await writeOwnerHeartbeat($); } catch { /* heartbeat write failed; non-fatal */ }
    }
    // The commons copy of the stamp exists so a session in another working
    // directory can read this turn's state, which the cwd-relative heartbeat
    // file cannot give it. Owner or reader, the session's own entry carries
    // its turn state: a session that yields mid-turn writes the stamp through
    // releaseResource, and only this handler pair clears it.
    try { await stampCommonsMeta(commonsStoreOf($), sess.mySessionId, commonsMeta()); } catch { /* commons stamp failed; non-fatal */ }
    // H2: record the active leaf at turn start for scoring.
    turnLeafId = sess.state.activeGoalId;
    // C4: reset tool error counter for this turn.
    toolErrorsThisTurn = 0;
    // Item 2 sub-bullet: reset the tool-call counter for this turn.
    toolCallsThisTurn = 0;
    // Steer 68/69: capture whether this turn opened from a channel message,
    // then clear the handoff flag so an unrelated later turn never inherits
    // it. Reset the reply-tracking flag for the turn now starting.
    currentTurnIsChannelOrigin = lastPromptWasChannelOrigin;
    lastPromptWasChannelOrigin = false;
    const currentTurnIsExternal = lastPromptWasExternal;
    lastPromptWasExternal = false;
    replyCalledThisTurn = false;
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

    // AS3: which turn is this? The text it begins with says: e.text is
    // matched against the queued entries, on the text the entry submitted
    // or on the settled text its resolved submit reported, and the match is
    // removed wherever it sits, never by position, so one turn the list
    // cannot place never shifts every later turn onto the wrong entry. A
    // matched delivery entry stamps its record with this turn id, which is
    // what turn.complete uses to file this turn's answer as the record's
    // reply; a matched nudge or plugin entry stamps nothing. A turn whose text
    // matches nothing is unaccounted and stamps nothing: an external turn
    // (the real prompt.submit hook fired since the last turn.start, which
    // the plugin's own submits never do), a continuation (empty text), or
    // one the plugin cannot place; where a delivery is queued its stamp is
    // withheld for this turn and the reason names what the hook saw
    // (channel-origin, external) or unaccounted, and the delivery keeps its
    // entry for the turn that opens with its text. The external flag never
    // decides the match; it only names the reason.
    const matched = expectedTurns.find((entry) => e.text !== "" && (entry.text === e.text || entry.settledText === e.text));
    let stampRecordId: string | null = null;
    if (matched) {
      unexpectTurn(matched);
      currentTurnKind = matched.kind;
      if (matched.kind === "delivery") stampRecordId = matched.recordId;
    } else {
      currentTurnKind = "unaccounted";
      const queuedDelivery = expectedTurns.find((entry) => entry.kind === "delivery");
      if (sess.isOwner && queuedDelivery && queuedDelivery.kind === "delivery") {
        const reason = currentTurnIsChannelOrigin ? "channel-origin" : currentTurnIsExternal ? "external" : "unaccounted";
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "operator_stamp_withheld",
          detail: `record ${queuedDelivery.recordId} not stamped with turn ${e.turnId} (${reason} turn)`,
        });
        await persist($);
      }
    }
    if (sess.isOwner && stampRecordId) {
      const store = commonsStoreOf($);
      const allRecords = await listInboxRecords(store, sess.persona);
      const submitted = allRecords.find(
        (rec) => rec.id === stampRecordId && rec.status === "delivered" && !rec.turnId
      );
      if (submitted) {
        const existing = await store.get(submitted.key);
        if (existing) {
          const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
          parsed.turnId = e.turnId;
          await store.set(submitted.key, parsed);
        }
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "operator_turn_stamped",
          detail: `record ${submitted.id} stamped with turn ${e.turnId}`,
        });
        await persist($);
      }
    }

    return next(e);
  });

  // --- turn.complete: goal scoring, memory curation, guarded save ---
  // Modules write to sess.state. The Controller (clock.tick) reads sess.state and decides.
  on("turn.complete", async ($, e, next) => {
    // Session-scoped and unconditional by design, whether or not this
    // completion matches a turn this session saw start. The plan doc's
    // Decisions entry on the idle anchor owns the reasoning.
    sess.state.monitor.lastTurnComplete = Date.now();
    // This turn's own entry, read before the delete below removes it.
    const mapStartedAt = openTurns.get(e.turnId);
    // Closing by id: a completion for a turn this session never saw start
    // removes nothing, so it cannot clear a different turn that is still open.
    openTurns.delete(e.turnId);
    // Plan item 8.4: a turn that ran past an hour is one of the weaknesses
    // the own-record pass counts, so record it as a decision here, the only
    // point that knows both ends of the turn.
    // The harness measures the turn itself and carries the figure whatever the
    // turn's reason, so where it arrives the record needs no hook-side clock
    // and no open-turn entry, and still counts a turn whose start this session
    // never saw, which is most of them on a session the harness under-reports.
    // The map entry is kept as a defensive fallback against a contract this
    // plugin has never exercised: the field is declared required, and no other
    // line here reads it, so an absent one would switch this record off with
    // nothing saying so.
    {
      const turnMs = typeof e.durationMs === "number"
        ? e.durationMs
        : mapStartedAt === undefined ? null : Date.now() - mapStartedAt;
      if (turnMs !== null && turnMs >= KAIZEN_LONG_TURN_MS) {
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "turn_over_hour",
          detail: `Turn ${e.turnId || "unknown"} ran ${Math.round(turnMs / 1000)}s`,
        });
      }
    }
    // The deferred-status stamp is derived from what is still open rather than
    // cleared, so it names the earliest turn still running, or null when none
    // is. This value leaves the process: it is published to the heartbeat and
    // read by another session to report how long a pending record has waited.
    // A stamp cleared by whichever completion arrived first would tell that
    // reader no turn is running while one still is, and a stamp left set by an
    // unmatched completion would strand and report a turn that ended hours
    // ago. Deriving it cannot strand the in-memory value, because an empty map
    // yields null. The published file is a weaker claim: writeOwnerHeartbeat is
    // a read-modify-write called from both turn handlers and from the heartbeat
    // tick, so two in-flight calls can land out of build order and publish a
    // non-null stamp just after the map emptied. The next tick repairs it, so
    // that exposure is one heartbeat interval rather than unbounded. The
    // commons entry carries the same exposure for the same reason, repaired by
    // the owner's next tick claim write (a reader's tick passes no meta, so its
    // copy holds until its next turn boundary).
    sess.turnStartedAt = deriveTurnStartedAt();
    if (sess.isOwner) {
      try { await writeOwnerHeartbeat($); } catch { /* heartbeat write failed; non-fatal */ }
    }
    try { await stampCommonsMeta(commonsStoreOf($), sess.mySessionId, commonsMeta()); } catch { /* commons stamp failed; non-fatal */ }

    // Read what this turn opened as once, up front, and reset it so a stale
    // reading never leaks into a later turn (a completion for a turn whose
    // start this session never saw reads as unaccounted). The expected-turn
    // list itself is not touched here: its entries leave it at turn.start,
    // one per turn the plugin opened.
    const wasNudged = currentTurnKind === "nudge";
    currentTurnKind = "unaccounted";

    // C3: error streak fold.
    const toolErrors = toolErrorsThisTurn;
    toolErrorsThisTurn = 0;
    sess.state.monitor.env.errors = applyTurnToErrors(
      sess.state.monitor.env.errors,
      { reason: e.reason || "unknown", toolErrors },
    );

    // Skip scoring on aborted or errored turns (no answer to judge).
    const skipped = e.aborted || e.reason === "aborted" || e.reason === "error" || e.reason === "refusal" || !e.answer;

    // Steer 68/69: a Discord message opened this turn and the turn ended
    // with an answer but no reply-tool call - exactly the shape that left
    // an operator's question answered in the transcript and invisible on
    // the thread, twice, because the priming instruction alone did not
    // reliably make the model call the reply tool. Gated off priming and
    // nudged turns for the same reason the item 2 backstop above is: an
    // internal turn was never a Discord message and must not be treated
    // as one. Sends the model's own leftover text directly through the
    // reply tool rather than trusting a second instruction to work where
    // the first already didn't; falls back to one re-prompt, carrying the
    // exact text, only if the direct call itself fails.
    if (!skipped && sess.isOwner && currentTurnIsChannelOrigin && !replyCalledThisTurn && !isPrimingTurn && !wasNudged) {
      try {
        await $.tool.call({ tool: "mcp__plugin_relay_channel-relay__reply", message: e.answer } as any);
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "monitor",
          action: "channel_reply_backfilled",
          detail: `turn ${e.turnId} answered with no reply-tool call; sent through reply directly`,
        });
      } catch (directErr) {
        const backstopText = `${REPLY_INSTRUCTION}[REPLY BACKSTOP] Send this exact text to the operator through the reply tool now, unchanged:\n${e.answer}`;
        // A refused re-prompt means both paths failed; nothing more to do
        // without a live channel, and its entry has left the list.
        const backstopOutcome = await submitExpectedTurn($, expectedTurns, expectTurn({ kind: "plugin", text: backstopText }));
        if (backstopOutcome.ok) {
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "channel_reply_backfill_reprompted",
            detail: `turn ${e.turnId} direct reply call failed (${(directErr as Error).message}); re-prompted instead`,
          });
        }
      }
    }
    currentTurnIsChannelOrigin = false;

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

    // Item 8.2 (Round 36, extended Round 39): an ask record opens only when
    // the worker's own completed turn states a real fork as a literal
    // marker line, never from the classifier's idle-gap or pause reading
    // (see the conversion above, which now covers both verdicts). The
    // stored question is the worker's own line, not a reason the classifier
    // produced. Two guards on the marker itself: refuse a match that still
    // carries the literal template's angle-bracket placeholders (a worker
    // that copies the nudge instruction verbatim without filling it in is
    // not stating a fork), and suppress a re-open of the identical question
    // this same node just closed (the D5b reask guard, driven through this
    // path now that it is the only path that opens an ask from the idle
    // tick's own read of the goal).
    if (!skipped && sess.isOwner && !sess.state.pendingAskId) {
      const askMarkerMatch = e.answer.match(/^ASK:\s*(.+?\?\s*Recommend:\s*.+)$/im);
      if (askMarkerMatch) {
        const question = askMarkerMatch[1].trim();
        if (/<[^<>]+>/.test(question)) {
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "ask_marker_placeholder_refused",
            detail: `worker's ASK line still carries a template placeholder, refused: ${question.slice(0, 100)}`,
          });
        } else {
          const nodeId = turnLeafId || sess.state.activeGoalId || "unknown";
          const askedNode = sess.state.goals.find((node) => node.id === nodeId);
          const askReaskSuppressMs = typeof cfg.askReaskSuppressMs === "number" ? (cfg.askReaskSuppressMs as number) : 10 * 60_000;
          if (shouldSuppressReask(askedNode, question, Date.now(), askReaskSuppressMs)) {
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "monitor",
              action: "ask_reask_suppressed",
              detail: `${nodeId}: suppressed identical question closed ${Math.round((Date.now() - (askedNode?.lastAskClosedAt || Date.now())) / 1000)}s ago: ${question.slice(0, 80)}`,
            });
          } else {
            const askId = `ask-${nodeId}-${Date.now()}`;
            await writeAskRecord(commonsStoreOf($), sess.persona, askId, nodeId, question, sess.mySessionId);
            sess.state.pendingAskId = askId;
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "monitor",
              action: "ask_opened",
              detail: `${nodeId}: worker-stated fork: ${question} (ask ${askId})`,
            });
            try { $.ui.toast(`Agentic: ${question}`); } catch { /* non-fatal */ }
            if (askedNode && askedNode.status === "active") {
              askedNode.status = "paused";
              askedNode.blockedReason = question;
              askedNode.updatedAt = Date.now();
              sess.state.decisions.push({
                timestamp: Date.now(),
                loop: "goal",
                action: "paused_by_controller",
                detail: `${nodeId}: ${question}`,
              });
            }
          }
        }
      }
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
      } else if (turnLeaf.status === "paused" && turnLeaf.pausedByNudgeCap && toolCallsThisTurn > 0) {
        // Round 60 finding 3(b): the cap pause (above) opens no ask, so nothing but this
        // check ever reactivates it in a headless child - goal_resume is a tool call the
        // worker has to think to make, and a paused node otherwise never gets nudged again.
        // A completed turn that called a real work tool while this node sits paused for
        // the cap reason (never for a goal_edit pause, which never sets the flag) means
        // the worker resumed the work on its own; reactivate rather than leave it stalled.
        const cappedReason = turnLeaf.blockedReason || "nudge cap";
        turnLeaf.status = "active";
        turnLeaf.blockedReason = undefined;
        turnLeaf.pausedByNudgeCap = false;
        turnLeaf.updatedAt = Date.now();
        sess.consecutiveNudgesWithoutOnGoal = 0;
        sess.state.decisions.push({
          timestamp: Date.now(),
          loop: "goal",
          action: "reactivated_by_work",
          detail: `${turnLeaf.id}: work tool called while paused (${cappedReason}), reactivating`,
        });
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

    // D4: if the turn.complete turnId matches the record stamped with this
    // turn, write the reply and mark answered. The record may already be
    // resolved: the owner does the work and calls agentic_resolve inside the
    // stamped turn, so the reply is filed for a resolved record too and its
    // resolution stays as it is.
    if (sess.isOwner) {
      const persona = sess.persona;
      const allRecords = await listInboxRecords(commonsStoreOf($), persona);
      const matching = allRecords.find(
        (rec) => (rec.status === "delivered" || rec.status === "resolved") && rec.turnId === e.turnId
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
            if (parsed.status === "delivered") parsed.status = "answered";
            await store.set(matching.key, parsed);
          }
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "operator_answered",
            detail: `record ${matching.id} replied`,
          });
        } else {
          // AX4: empty answer or aborted. The record keeps its status
          // (delivered, or resolved with its resolution), its stamp and no
          // reply until the TTL: a later turn is not the one the plugin
          // opened for it, so none re-stamps it.
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "operator_turn_unanswered",
            detail: `record ${matching.id} turn ${e.turnId} ended with no answer (empty or aborted); left ${matching.status}`,
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
    // Steer 68/69: the reply tool ran somewhere in this turn, so the
    // channel-reply backstop at turn.complete has nothing to backfill.
    if (typeof e.tool === "string" && (e.tool.includes("__reply") || e.tool.endsWith("_reply"))) {
      replyCalledThisTurn = true;
    }

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
          await releaseResource(commonsStoreOf($), `persona:${previousPersona}`, sess.mySessionId, Date.now(), commonsMeta());
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
        await claimResource(commonsStoreOf($), resource, sess.mySessionId, Date.now(), commonsMeta());
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
          await releaseResource(commonsStoreOf($), resource, sess.mySessionId, Date.now(), commonsMeta());
        } catch { /* non-fatal: commons is a coordination layer */ }
        // D2: Claim the reader role
        await claimReaderRole(commonsStoreOf($), sess.persona, sess.mySessionId, Date.now(), commonsMeta());
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
      } else if (kind === "plan") {
        // Section 10 fix round: a plan always resolves to the root when no
        // parentId is given, whatever is active. Without this, Section 10's
        // own no-active-leaf branch below activates the first plan a worker
        // adds in a turn, and a second plan add in the same turn - with no
        // parentId, exactly what this tool's own description tells a worker
        // to omit - would resolve under that now-active first plan and be
        // denied ("plan" only allowed under the root), which never happened
        // before this section since no plan stayed active mid-turn.
        parentId = root.id;
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

      // Section 10: if the tree still has no active leaf, activate the node
      // just created rather than deferring to the next tick, mirroring the
      // task branch above (set status and activeGoalId directly, then call
      // activate() to log the decision and reset the nudge budget). Without
      // this, the node stays pending for the rest of this turn, so a
      // same-turn goal_done has nothing of this node's to close.
      //
      // isActivationEligible carries activateNext's own ancestor rule, so a
      // node added under an abandoned or blocked parent is refused here the
      // same way activateNext's DFS would refuse it - this branch never
      // activates into a closed subtree.
      //
      // The hold check beside it is exactly two things: an open ask
      // (pendingAskId) is the operator's own open question, and a
      // pausedByNudgeCap node is the nudge cap's own hold, restored only by
      // turn.complete's own worker-tool-call path. A plain paused node -
      // dropped by an operator pause, or left over from a plan switch - is
      // neither of those and must not disable this branch for the rest of
      // the session.
      if (
        !sess.state.goals.some((g) => g.status === "active") &&
        !sess.state.pendingAskId &&
        !sess.state.goals.some((g) => g.pausedByNudgeCap === true) &&
        isActivationEligible(sess.state, newNode)
      ) {
        newNode.status = "active";
        newNode.updatedAt = now;
        sess.state.activeGoalId = newNode.id;
        activate($, newNode.id, `${newNode.id} added with no active leaf`);
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
        // Item 8.1's own bullet in one line: a blocked node (e.g. a stale duplicate the planner
        // left behind) could not be retired at all before this - drop refused it alongside every
        // other status, and nothing else marks a blocked node done or dropped. Allowed here, same
        // as pending/paused, with the reason always recorded (never optional for this status, so
        // the tree can say why a blocked node was let go rather than just that it was).
        if (node.status !== "pending" && node.status !== "paused" && node.status !== "blocked") {
          toolErrorsThisTurn++;
          return { deny: `Cannot drop ${nodeId}: status is "${node.status}" (only pending, paused, or blocked nodes can be dropped).` };
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

    // Serve supervisor_restart (plan item 8.3: mirrors supervisor_shutdown;
    // supervise.sh's decide unit maps this fact to restart_passive, so the
    // child is relaunched with the goal tree kept rather than the run ending).
    if (e.tool === "mcp__agentic-plugin__supervisor_restart") {
      if (!sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: `persona '${sess.persona}' is held by a live session; this write was not saved.` };
      }
      const reason = String((e as any).reason || "").trim() || "operator requested restart";
      const now = Date.now();
      sess.state.decisions.push({
        timestamp: now,
        loop: "monitor",
        action: "restart_requested",
        detail: reason,
      });
      const writeOk = await persist($);
      if (writeOk) {
        return { result: `Restart requested: ${reason}. The supervisor will relaunch the child after this turn ends; the goal tree is kept and the new child resumes the active plan.` };
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
      target.pausedByNudgeCap = false;
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
      const urgent = (e as any).urgent === true;
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
      const id = await writeInboxRecord(commonsStoreOf($), persona, sess.mySessionId, seq, text, "say", answers, urgent);
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "worker",
        action: "say_sent",
        detail: `${persona}: "${text.slice(0, 80)}" (id: ${id}${urgent ? ", urgent" : ""})`,
      });
      return { result: `Message sent to owner of ${persona} (id: ${id}${urgent ? ", urgent: delivered inside the owner's running turn if one is in flight" : ""})` };
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
      // Plan item 8.3: the owner's commons entry carries turnStartedAt while
      // a turn runs. A record still pending behind that turn is reported as
      // deferred, with how long the turn has run, so the sender knows the
      // message is held rather than lost. The stamp alone is not enough: an
      // owner killed mid-turn never clears it, so the report also requires
      // the entry's lastSeen within staleAfterMs of now, since a stale owner
      // is dead rather than busy. The commons store is machine-global, so a
      // reader in another working directory sees the same entry, which the
      // cwd-relative heartbeat file cannot give it.
      let ownerTurnStartedAt: number | null = null;
      try {
        const holder = await readHolderMeta(commonsStoreOf($), `persona:${persona}`, sess.staleAfterMs);
        if (holder) ownerTurnStartedAt = holder.turnStartedAt;
      } catch { /* commons read failed; report records without the deferred view */ }
      // Attach replies to records, and the deferred view to pending ones.
      const withReplies = await Promise.all(myRecords.map(async (rec) => {
        const reply = await readReplyRecord(commonsStoreOf($), persona, rec.id);
        const base = reply ? { ...rec, reply: reply.text } : rec;
        if (rec.status === "pending" && ownerTurnStartedAt !== null) {
          return { ...base, deferred: true, turnRunningMs: Math.max(0, Date.now() - ownerTurnStartedAt) };
        }
        return base;
      }));
      return { result: JSON.stringify({ inbox: withReplies, asks: openAsks }, null, 2) };
    }

    // Section 12: serve agentic_resolve (the owner marks a record's work
    // finished or declined). Owner only, and only for a record listed under
    // the session's own persona, so a reader holding the persona cannot
    // resolve, and a record keyed to another persona does not resolve here.
    // A pending record has not been read, and a skipped record's writer is
    // gone, so neither has anything to resolve.
    if ((e as any).tool === "mcp__agentic-plugin__agentic_resolve") {
      const persona = sess.persona;
      const id = String((e as any).id || "").trim();
      const outcome = (e as any).outcome as string | undefined;
      const note = typeof (e as any).note === "string" ? (e as any).note : "";
      if (!sess.isOwner) {
        toolErrorsThisTurn++;
        return { deny: "agentic_resolve is for the owner session only; a reader does not resolve the owner's records." };
      }
      // The note goes whole into the machine-global store, which every live
      // session rewrites and polls, so it is bounded here at the handler.
      if (note.length > RESOLVE_NOTE_MAX) {
        toolErrorsThisTurn++;
        return { deny: `agentic_resolve note is ${note.length} characters; the bound is ${RESOLVE_NOTE_MAX}. Shorten it.` };
      }
      if (!id) {
        toolErrorsThisTurn++;
        return { deny: "agentic_resolve requires a non-empty 'id'." };
      }
      if (outcome !== "done" && outcome !== "declined") {
        toolErrorsThisTurn++;
        return { deny: "agentic_resolve requires 'outcome' of done or declined." };
      }
      const store = commonsStoreOf($);
      const target = (await listInboxRecords(store, persona)).find((rec) => rec.id === id);
      if (!target) {
        toolErrorsThisTurn++;
        return { deny: `no record '${id}' addressed to persona ${persona}.` };
      }
      if (target.status === "pending") {
        toolErrorsThisTurn++;
        return { deny: `record '${id}' is still pending (not delivered yet); nothing to resolve.` };
      }
      if (target.status === "skipped") {
        toolErrorsThisTurn++;
        return { deny: `record '${id}' was skipped (its writer had no live claim); nothing to resolve.` };
      }
      if (target.status !== "delivered" && target.status !== "answered") {
        toolErrorsThisTurn++;
        return { deny: `record '${id}' is already ${target.status} (${target.outcome ?? "no outcome"}).` };
      }
      const existing = await store.get(target.key);
      if (!existing) {
        toolErrorsThisTurn++;
        return { deny: `record '${id}' left the store before it could be resolved.` };
      }
      const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
      parsed.status = "resolved";
      parsed.resolvedAt = Date.now();
      parsed.outcome = outcome;
      parsed.note = note;
      await store.set(target.key, parsed);
      sess.state.decisions.push({
        timestamp: Date.now(),
        loop: "worker",
        action: "operator_resolved",
        detail: `record ${id} resolved ${outcome}${note ? `: "${note.slice(0, 80)}"` : ""}`,
      });
      await persist($);
      return { result: `Record ${id} resolved (${outcome}).` };
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

    // Plan item 8.3: an urgent record from a live reader reaches the owner
    // inside the running turn. The controller tick cannot deliver while a
    // turn is in flight, so the record rides here instead: marked delivered
    // and stamped with this turn (turn.complete then records the turn's
    // answer as its reply), its text appended as context on this tool's
    // result, which the model reads after the result itself. A record that
    // answers an open ask is left to the tick, which owns the ask lifecycle.
    if (sess.isOwner && r.deny === undefined && Date.now() - lastUrgentCheckAt >= urgentCheckMinMs) {
      lastUrgentCheckAt = Date.now();
      try {
        const store = commonsStoreOf($);
        const persona = sess.persona;
        const urgentPending = (await listInboxRecords(store, persona))
          .filter((rec) => rec.status === "pending" && rec.urgent === true && !rec.answers);
        const lines: string[] = [];
        for (const rec of urgentPending) {
          if (!(await hasLiveReaderClaim(store, persona, rec.from))) continue;
          const existing = await store.get(rec.key);
          if (!existing) continue;
          const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
          parsed.status = "delivered";
          parsed.deliveredAt = Date.now();
          parsed.turnId = sess.state.monitor.lastTurnId;
          await store.set(rec.key, parsed);
          sess.state.decisions.push({
            timestamp: Date.now(),
            loop: "monitor",
            action: "operator_delivered_urgent",
            detail: `record ${rec.id} delivered inside the running turn as context on ${e.tool}`,
          });
          lines.push(`[OPERATOR, urgent] ${rec.text}`);
        }
        if (lines.length > 0) {
          await persist($);
          const prior = Array.isArray(r.context) ? r.context : [];
          return { ...r, context: [...prior, ...lines] } as typeof r;
        }
      } catch { /* commons read failed; the tick delivers the record after the turn */ }
    }
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
    // Steer 68/69: a real Discord message carries e.origin.kind === "channel".
    lastPromptWasChannelOrigin = (e as { origin?: { kind?: string } }).origin?.kind === "channel";
    lastPromptWasExternal = true;

    // D5b (bullet 1): an open ask never silences the worker. This hook fires
    // only for a genuine external turn - the controller's own $.prompt.submit
    // calls (nudges, operator-record delivery, the ask re-raise) bypass this
    // handler, per the expected-turns comment above. So any turn that reaches
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
      // A dropped prompt opens no turn, so the one-shot flags set above
      // must not survive to the next turn.start.
      lastPromptWasChannelOrigin = false;
      lastPromptWasExternal = false;
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


