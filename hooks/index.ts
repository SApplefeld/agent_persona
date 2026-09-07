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
} from "./agent-state";
import type { AgentState, GoalNode, NudgeBudget, EnvGit } from "./agent-state";

// --- Module-scope session identity ---
// The loader requires `persist` and `activate` to be top-level functions.
// A mutable object carries the per-session values; hooks update it on session.start.
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
};

// Reentrancy flag for the git probe (E4).
let gitProbeInFlight = false;

// C4: tool error counter for the current turn (reset at turn.start, folded at turn.complete).
let toolErrorsThisTurn = 0;

// Health run helper (E2).
async function runHealth(dp: any, forNodeId: string | null): Promise<void> {
  const healthPath = ".agentic-health";
  try {
    if (!(await dp.fs.exists(healthPath))) {
      return;
    }
    const raw = await dp.fs.readFile(healthPath, "utf8");
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
    const el = await dp.fs.exists(sess.yieldLogPath) ? await dp.fs.readFile(sess.yieldLogPath) : "";
    await dp.fs.writeFile(sess.yieldLogPath, el + (el.length > 0 && !el.endsWith("\n") ? "\n" : "") + rec.logLine);
  } catch { /* non-fatal */ }
};

// M7: single guarded-write path shared by every store write site.
// Closes over sess so all write sites share one yield + write path.
export const persist = async (dp: any): Promise<boolean> => {
  if (!sess.isOwner) return false;
  sess.state.updatedAt = Date.now();
  const store: Record<string, unknown> = await dp.fs.exists(sess.storePath)
    ? (JSON.parse(await dp.fs.readFile(sess.storePath)) as Record<string, unknown>)
    : {};
  const onDisk = store[sess.persona] as AgentState | undefined;
  if (onDisk && shouldYield(onDisk, sess.mySessionId, sess.myEpoch)) {
    await yieldNow(dp, onDisk);
    return false;
  }
  store[sess.persona] = sess.state;
  await dp.fs.writeFile(sess.storePath, JSON.stringify(store, null, 2));
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
  const controllerTickMs = typeof cfg.controllerTickMs === "number" ? (cfg.controllerTickMs as number) : 30_000;
  const nudgeFloorMs = typeof cfg.nudgeFloorMs === "number" ? (cfg.nudgeFloorMs as number) : 5 * 60_000;
  const nudgeIdleMs = typeof cfg.nudgeIdleMs === "number" ? (cfg.nudgeIdleMs as number) : 2 * 60_000;
  const healthTimeoutMs = typeof cfg.healthTimeoutMs === "number" ? Math.min(cfg.healthTimeoutMs as number, 120_000) : 60_000;
  const gitProbeMs = typeof cfg.gitProbeMs === "number" ? Math.min(cfg.gitProbeMs as number, 300_000) : 120_000;
  sess.options = { healthTimeoutMs, gitProbeMs };

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
        "Claim ownership of a persona's store. FORCEFULLY takes the persona from whatever session " +
        "currently holds it: the previous holder is demoted to a passive reader on its next write. " +
        "Use only when the operator explicitly asks to hand off or reclaim the persona. " +
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

    // --- Claim or join the persona based on liveness (heartbeat sidecar) ---
    const existing = await $.fs.exists(storePath)
      ? JSON.parse(await $.fs.readFile(storePath))
      : {};
    const existingPersona = existing[sess.persona];

    if (existingPersona) {
      sess.state = parseState(JSON.stringify(existingPersona));
      sess.state.persona = sess.persona;

      // Check the heartbeat sidecar for liveness (not the store).
      let holderHb: { sessionId: string; epoch: number; lastSeen: number } | null = null;
      try {
        if (await $.fs.exists(heartbeatPath)) {
          const hb = JSON.parse(await $.fs.readFile(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>;
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
          detail: `Claimed '${sess.persona}' (prev ${prevId}, epoch ${existingPersona.epoch}${holderAlive ? "" : ", stale"})`,
        });
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
            ? (JSON.parse(await $.fs.readFile(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>)
            : {};
        hb[sess.persona] = { sessionId: sess.mySessionId, epoch: sess.myEpoch, lastSeen: Date.now() };
        await $.fs.writeFile(heartbeatPath, JSON.stringify(hb, null, 2));
      } catch { /* heartbeat write failed; non-fatal */ }
    }

    $.ui.log(`Agentic: persona '${sess.persona}', ${sess.state.memory.length} memories, ${sess.isOwner ? "owner" : "passive reader"}`);

    // Note: $ is available in the timer callback scope (session.start hook).

    // --- Heartbeat: refresh the sidecar every heartbeatMs ---
    // Only the owner stamps its own heartbeat. A passive reader must NOT
    // overwrite the holder's heartbeat, or it will (a) mask the real holder's
    // staleness and (b) make its own promotion check compare the holder id to
    // itself and never fire.
    $.clock.every(heartbeatMs, () => {
      Promise.resolve().then(async () => {
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
              const store = JSON.parse(await $.fs.readFile(storePath)) as Record<string, unknown>;
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
                  ? (JSON.parse(await $.fs.readFile(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>)
                  : {};
              hb[sess.persona] = { sessionId: sess.mySessionId, epoch: sess.myEpoch, lastSeen: Date.now() };
              await $.fs.writeFile(heartbeatPath, JSON.stringify(hb, null, 2));
            } catch { /* heartbeat write failed */ }
          }
        }

        // Passive reader: promote if the sidecar holder is stale and not self.
        // With the shouldYield check above, the sidecar is only ever
        // written by the store's current owner, so a stale sidecar means no
        // live owner, no store-owner comparison needed.
        if (!sess.isOwner) {
          let holderHb: { sessionId: string; epoch: number; lastSeen: number } | null = null;
          try {
            if (await $.fs.exists(heartbeatPath)) {
              const hb = JSON.parse(await $.fs.readFile(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>;
              holderHb = hb[sess.persona] ?? null;
            }
          } catch { /* heartbeat read failed */ }

          const now = Date.now();
          const holderIsStale = holderHb && (now - holderHb.lastSeen) > staleAfterMs;
          const holderIsSelf = holderHb?.sessionId === sess.mySessionId;
          if (holderIsStale && !holderIsSelf) {
            const store: Record<string, unknown> = await $.fs.exists(storePath)
              ? (JSON.parse(await $.fs.readFile(storePath)) as Record<string, unknown>)
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
            // Write heartbeat for the new claim.
            try {
              const hb: Record<string, { sessionId: string; epoch: number; lastSeen: number }> =
                await $.fs.exists(heartbeatPath)
                  ? (JSON.parse(await $.fs.readFile(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>)
                  : {};
              hb[sess.persona] = { sessionId: sess.mySessionId, epoch: sess.myEpoch, lastSeen: Date.now() };
              await $.fs.writeFile(heartbeatPath, JSON.stringify(hb, null, 2));
            } catch { /* non-fatal */ }
            $.ui.log(`Agentic: promoted to owner of '${sess.persona}' (previous holder stale)`);
          }
        }
      });
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

      // 2b. Git probe (E4, C6): time-based cadence, fire-and-forget.
      if (!gitProbeInFlight) {
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
                      ? `env_git first sample: dirty ${dirty} branch ${branch}`
                      : `env_git dirty ${prevGit.dirty} -> ${dirty} branch ${branch}`;
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
                // Non-git cwd.
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "monitor",
                  action: "env_git_null",
                  detail: `env_git_null exit 128`,
                });
              } else {
                sess.state.decisions.push({
                  timestamp: Date.now(),
                  loop: "monitor",
                  action: "env_git_error",
                  detail: `env_git_error exit ${res.exitCode}`,
                });
              }
              gitProbeInFlight = false;
            })
            .catch(() => {
              gitProbeInFlight = false;
            });
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
                roadmapText = await $.fs.readFile(rp);
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

      // 4. No active leaf: activate pending work if any exists (H1), else return.
      if (!activeNode || activeNode.status !== "active") {
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

      const minutesSinceLastTurn = Math.floor(idleMs / 60_000);
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
        `Minutes since last turn: ${minutesSinceLastTurn}\n` +
        `Consecutive nudges sent: ${sess.consecutiveNudgesWithoutOnGoal}\n` +
        `Decisions tail: ${sess.state.decisions.slice(-5).map((d) => `${d.loop}:${d.action}`).join(", ")}\n` +
        `Memory: ${sess.state.memory.length} entries\n` +
        envLine +
        `\n` +
        `The session has been idle for ${minutesSinceLastTurn} minutes.\n` +
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
          // C3: error streak branch (before the cap check).
          const envErrors = sess.state.monitor.env.errors;
          if (envErrors.consecutiveErrorTurns >= 3 && (!envErrors.handledAt || Date.now() - envErrors.handledAt > 60_000)) {
            const streakTs = Date.now();
            const streakReason = `Error streak ${envErrors.consecutiveErrorTurns} turns; escalating`;
            envErrors.handledAt = streakTs;
            sess.state.decisions.push({
              timestamp: streakTs,
              loop: "monitor",
              action: "error_streak",
              detail: `${g.id}: ${streakReason}`,
            });
            sess.state.decisions.push({
              timestamp: streakTs,
              loop: "monitor",
              action: "controller_tick",
              detail: `${g.id}: ask-operator: ${streakReason} (idle ${minutesSinceLastTurn}min)`,
            });
            try { $.ui.toast(`Agentic: ${streakReason}`); } catch { /* non-fatal */ }
            if (g.status === "active") {
              g.status = "blocked";
              g.blockedReason = streakReason;
              g.updatedAt = streakTs;
              sess.state.decisions.push({
                timestamp: streakTs,
                loop: "goal",
                action: "block",
                detail: `${g.id}: ${streakReason}`,
              });
              const nextId = activateNext(sess.state, g.id);
              activate($, nextId, `${g.id} blocked (error streak)`);
              try { $.ui.status(""); } catch { /* non-fatal */ }
            }
            sess.state.updatedAt = streakTs;
            await persist($);
            return;
          }

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
            sess.state.decisions.push({
              timestamp: capTs,
              loop: "monitor",
              action: "controller_tick",
              detail: `${g.id}: ask-operator: ${capReason} (idle ${minutesSinceLastTurn}min)`,
            });
            try { $.ui.toast(`Agentic: ${capReason}`); } catch { /* non-fatal */ }
            if (g.status === "active") {
              // M4: nudge cap → blocked + toast + activateNext (not paused).
              g.status = "blocked";
              g.blockedReason = capReason;
              g.updatedAt = capTs;
              sess.state.decisions.push({
                timestamp: capTs,
                loop: "goal",
                action: "block",
                detail: `${g.id}: ${capReason}`,
              });
              const nextId = activateNext(sess.state, g.id);
              activate($, nextId, `${g.id} blocked (nudge cap)`);
              try { $.ui.status(""); } catch { /* non-fatal */ }
            }
            sess.state.updatedAt = capTs;
            await persist($);
            return;
          }

          const tickTs = Date.now();
          const decision = await $.model.classify(
            summary,
            classifyLabels,
            { model: "haiku" }
          );
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
          let finalReason = "";
          if (finalDecision !== "nudge") {
            try {
              const reason = await $.model.complete({
                model: "haiku",
                prompt:
                  `You are the controller of an agentic plugin. The decision was "${finalDecision}". ` +
                  `Give a one-line plain-text reason (under 20 words). Do not use Markdown formatting.\n` + summary,
                maxTokens: 30,
              });
              finalReason = reason.trim().replace(/\*{1,2}/g, "").slice(0, 100);
            } catch { /* reason call failed; non-fatal */ }
          }

          sess.state.decisions.push({
            timestamp: tickTs,
            loop: "monitor",
            action: "controller_tick",
            detail: `${g.id}: ${finalDecision}: ${finalReason || "no reason"} (idle ${minutesSinceLastTurn}min)`,
          });

          // Actuate (controller only: the three actuators).
          if (finalDecision === "nudge" && g.status === "active") {
            // Nudge floor.
            if (now - sess.lastNudgeAt >= nudgeFloorMs) {
              try {
                // R8: nudge text appends goal_done instruction.
                const nudgeText =
                  `[GOAL] The active goal is: ${g.objective}\n` +
                  `The Controller detected ${minutesSinceLastTurn} minutes of idle time. ` +
                  `Re-read the objective and take the next concrete step toward it.\n` +
                  `When this step is done, call goal_done with a one-line note. ` +
                  `If the result names a next goal, continue with it.`;
                await $.prompt.submit({ text: nudgeText });
                currentPrompt = nudgeText;
                nudgedTurn = true;
                sess.lastNudgeAt = now;
                sess.consecutiveNudgesWithoutOnGoal += 1;
                sess.state.decisions.push({
                  timestamp: tickTs,
                  loop: "monitor",
                  action: "nudge_sent",
                  detail: `${g.id}: idle ${minutesSinceLastTurn}min, nudge #${sess.consecutiveNudgesWithoutOnGoal}`,
                });
              } catch { /* nudge failed; non-fatal */ }
            }
          } else if (finalDecision === "ask-operator") {
            try {
              $.ui.toast(`Agentic: ${finalReason}`);
            } catch { /* non-fatal */ }
            if (g.status === "active") {
              g.status = "paused";
              g.blockedReason = finalReason;
              g.updatedAt = Date.now();
              sess.state.decisions.push({
                timestamp: Date.now(),
                loop: "goal",
                action: "paused_by_controller",
                detail: `${g.id}: ${finalReason}`,
              });
              try { $.ui.status(""); } catch { /* non-fatal */ }
            }
          } else if (finalDecision === "pause" && g.status === "active") {
            g.status = "paused";
            g.blockedReason = finalReason || "controller pause";
            g.updatedAt = Date.now();
            sess.state.decisions.push({
              timestamp: Date.now(),
              loop: "goal",
              action: "paused_by_controller",
              detail: `${g.id}: ${finalReason || "controller pause"}`,
            });
            try { $.ui.status(""); } catch { /* non-fatal */ }
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
    sess.state.decisions.push({
      timestamp: Date.now(),
      loop: "monitor",
      action: "turn_start",
      detail: `Turn ${sess.state.monitor.turnCount} leaf ${turnLeafId || "none"}`,
    });
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

    // M7: single guarded-write path (shared helper).
    await persist($);

    return next(e);
  });

  // --- tool.call: serve tools, enforce constraints ---
  on("tool.call", async ($, e, next) => {
    sess.state.monitor.totalToolCalls += 1;

    // Serve agentic_identity (forceful claim: always takes ownership).
    if (e.tool === "mcp__agentic-plugin__agentic_identity") {
      const name = String((e as any).persona || "default").trim() || "default";
      sess.persona = name;
      const store: Record<string, unknown> = await $.fs.exists(storePath)
        ? (JSON.parse(await $.fs.readFile(storePath)) as Record<string, unknown>)
        : {};
      const existing = store[name] as AgentState | undefined;
      if (existing) {
        sess.state = parseState(JSON.stringify(existing));
        sess.state.persona = name;
      } else {
        sess.state = createDefaultState(name, sess.mySessionId);
      }
      // Forceful claim: always take ownership.
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
        detail: `persona '${sess.persona}' (session ${sess.mySessionId}, epoch ${sess.myEpoch}, forced claim)`,
      });
      // Forceful claim: the one write site allowed to bypass persist's yield check,
      // because the claimant has already taken ownership (activeSessionId = self).
      // persist would read the on-disk store (still the previous holder) and wrongly
      // yield. Write the keyed store directly.
      sess.state.updatedAt = Date.now();
      store[sess.persona] = sess.state;
      await $.fs.writeFile(storePath, JSON.stringify(store, null, 2));
      // Write the heartbeat for the new persona (inline).
      try {
        const hb: Record<string, { sessionId: string; epoch: number; lastSeen: number }> =
          await $.fs.exists(heartbeatPath)
            ? (JSON.parse(await $.fs.readFile(heartbeatPath)) as Record<string, { sessionId: string; epoch: number; lastSeen: number }>)
            : {};
        hb[sess.persona] = { sessionId: sess.mySessionId, epoch: sess.myEpoch, lastSeen: Date.now() };
        await $.fs.writeFile(heartbeatPath, JSON.stringify(hb, null, 2));
      } catch { /* non-fatal */ }
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

      const writeOk = await persist($);
      if (writeOk) {
        // R8: goal_done result names newly active leaf OR planning message.
        if (nextId) {
          const nextNode = sess.state.goals.find((g) => g.id === nextId)!;
          return {
            result: `Complete: "${completedTitle}". Next active: ${nextId} "${nextNode.title}".`,
          };
        }
        return { result: `Complete: "${completedTitle}". No pending goals; planning runs at the next tick.` };
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
        sess.state.goals.filter((g) => g.parentId === pid).sort((a, b) => a.createdAt - b.createdAt);
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

    return next(e);
  });

  // --- prompt.submit: inject memory + active goal as hidden context ---
  // Actuator 1: context injection (always on, free, cannot be refused).
  // Both owner and passive reader can inject (read-only access to sess.state).
  on("prompt.submit", async ($, e, next) => {
    // Capture the prompt text for the goal scorer.
    currentPrompt = e.text;

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
      }
    }

    // --- [ENV] block injection (C7: only when env.git or env.health is non-null) ---
    const env = sess.state.monitor.env;
    if (env.git !== null || env.health !== null) {
      const parts: string[] = [];
      if (env.git !== null) {
        parts.push(`git: ${env.git.branch} dirty ${env.git.dirty} ahead ${env.git.ahead} behind ${env.git.behind}`);
      }
      if (env.health !== null) {
        parts.push(`health: exit ${env.health.exitCode} for ${env.health.forNodeId || "no-node"}`);
      }
      const envBlock = `[ENV] ${parts.join(", ")}\nEnvironment state above is current; act on it when it affects your plan.`;
      contextBlocks.push(envBlock);
      try { $.ui.log(`Agentic: [ENV] injected`); } catch { /* non-fatal */ }
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
