// tick-harness.mjs: fake $ builder and tick driver for controller-tick-test.mjs.
//
// Builds an in-memory fake $ that satisfies the hooks/index.ts register() surface.
// Records clock.every callbacks (first = heartbeat, second = controller tick).
// The test fires the controller-tick callback by hand with stubbed Date.now,
// model.classify, and an in-memory fs.
//
// AO1: Use a Node resolve hook instead of rewriting hooks/index.ts.
// AO2: Fresh module per case using `import(\`../hooks/index.ts?case=${name}\`)`.
// Reads go through the fake store (fs.write receives the persisted persona JSON).

import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SESSION_ID = "harness-session";

// AO1: Resolve hook - when specifier starts with "./", has no extension, and
// parent URL is under hooks/, append ".ts" and defer to next resolver.
const resolveHook = (specifier, context, nextResolve) => {
  // Only apply to extensionless relative imports from within hooks/
  if (
    specifier.startsWith("./") &&
    !path.extname(specifier) &&
    context.parentURL &&
    context.parentURL.includes("hooks")
  ) {
    return nextResolve(specifier + ".ts", context);
  }
  return nextResolve(specifier, context);
};

// Register the resolve hook once.
registerHooks({ resolve: resolveHook });

// --- Fake $ factory ---

function createFake$(opts = {}) {
  const clockEveryCallbacks = [];
  const toolRegisters = [];
  const toolCalls = [];
  const promptSubmits = [];
  const fsMap = new Map();
  const storeMap = new Map();
  let classifyValue = opts.classifyValue || "nudge";
  const classifyCalls = [];
  // Opt-in git answers. The default stays exit 128 (the non-git-cwd path), so a
  // case that never calls setGitScript exercises gitUnavailable exactly as it
  // did before this existed. Making git answers the default instead would have
  // retired that coverage in every existing case without turning one red.
  let gitScript = [];
  let gitIndex = 0;
  const completeCalls = [];
  let completeValue = opts.completeValue ?? "[]";
  const uiLogs = [];

  const fake = {
    ui: {
      log(msg) { uiLogs.push(String(msg)); },
      status() {},
      toast() {},
    },
    fs: {
      exists(p) { return Promise.resolve(fsMap.has(p)); },
      read(p) {
        if (!fsMap.has(p)) return Promise.reject(new Error("ENOENT: " + p));
        return Promise.resolve(fsMap.get(p));
      },
      write(p, content) {
        fsMap.set(p, typeof content === "string" ? content : JSON.stringify(content));
        return Promise.resolve();
      },
    },
    tool: {
      register(def) { toolRegisters.push(def); },
      // Records a hook-initiated call (e.g. the channel-reply backstop's
      // own $.tool.call({ tool: "...reply", message }) - never invoked for
      // model tool calls, which arrive through the "tool.call" hook event
      // instead, not through this method).
      call(args) {
        toolCalls.push(args);
        return Promise.resolve({ result: "ok" });
      },
    },
    session: {
      id() { return Promise.resolve(SESSION_ID); },
      // BJ1: Add messages() for budget fixtures.
      // The test can override this with its own implementation.
      messages() {
        if (typeof opts.sessionMessages === "function") {
          return opts.sessionMessages();
        }
        return Promise.resolve([]);
      },
    },
    model: {
      // Records the call's own arguments rather than a placeholder, so a case can
      // assert on the summary the controller actually hands the decider. Length
      // semantics are unchanged, so existing count-based checks still read the same.
      classify(...args) {
        classifyCalls.push(args);
        // A function value lets a case decide from the summary it was actually
        // handed, which is the only way to tell a feature working from this stub
        // answering the same thing regardless of its input.
        const v = typeof classifyValue === "function" ? classifyValue(...args) : classifyValue;
        return Promise.resolve(v);
      },
      complete() {
        completeCalls.push(1);
        return Promise.resolve(completeValue);
      },
    },
    prompt: {
      submit({ text }) {
        promptSubmits.push(text);
        return Promise.resolve();
      },
    },
    clock: {
      every(intervalMs, fn) {
        clockEveryCallbacks.push({ intervalMs, fn });
        return 0;
      },
    },
    store: {
      get(key) { return Promise.resolve(storeMap.has(key) ? storeMap.get(key) : null); },
      set(key, value) { storeMap.set(key, value); return Promise.resolve(); },
      delete(key) { storeMap.delete(key); return Promise.resolve(); },
      keys() { return Promise.resolve([...storeMap.keys()]); },
    },
    process: {
      // The git sampler issues `git status --porcelain=v1 -b` and then
      // `git log -1 --format=%ct` as a pair. A step supplies both halves, so
      // `commitAt` belongs to the same step as its dirty count: the sampler keys
      // its commit-landed signal on that timestamp advancing, and a case needs to
      // drive a commit and a bare worktree clean separately.
      //
      // The pair is consumed as a unit: `status` selects the step and `log`
      // advances past it. A sampler path that issued a status without reaching the
      // log would pin the script on one step, so the advance stays on the second
      // call rather than the first, where a half-consumed pair would read as a
      // step that never arrives.
      run(argv) {
        if (gitScript.length > 0 && Array.isArray(argv) && argv[0] === "git") {
          const step = gitScript[Math.min(gitIndex, gitScript.length - 1)];
          if (argv[1] === "status") {
            const lines = ["## " + (step.branch ?? "main")];
            for (let i = 0; i < (step.dirty ?? 0); i++) lines.push(" M file" + i + ".txt");
            return Promise.resolve({ exitCode: 0, stdout: lines.join("\n") + "\n" });
          }
          if (argv[1] === "log") {
            gitIndex += 1;
            const commitAt = step.commitAt ?? 1_700_000_000;
            return Promise.resolve({ exitCode: 0, stdout: String(commitAt) + "\n" });
          }
        }
        return Promise.resolve({ exitCode: 128 });
      },
    },
  };

  // Attach maps to fake for convenient access (h.fake.fsMap === h.fsMap).
  fake.fsMap = fsMap;
  fake.storeMap = storeMap;
  fake.classifyCalls = classifyCalls;
  fake.completeCalls = completeCalls;
  fake.promptSubmits = promptSubmits;
  fake.toolCalls = toolCalls;
  fake.uiLogs = uiLogs;

  return {
    fake,
    clockEveryCallbacks,
    toolRegisters,
    toolCalls,
    promptSubmits,
    fsMap,
    storeMap,
    classifyCalls,
    completeCalls,
    uiLogs,
    setClassifyValue(v) { classifyValue = v; },
    setCompleteValue(v) { completeValue = v; },
    // steps: [{ branch?, dirty?, commitAt? }, ...], one per sampler status/log
    // pair. The last step repeats once the script is exhausted.
    setGitScript(steps) { gitScript = steps || []; gitIndex = 0; },
    resetClassifyCalls() { classifyCalls.length = 0; },
    resetCompleteCalls() { completeCalls.length = 0; },
    resetPromptSubmits() { promptSubmits.length = 0; },
    resetToolCalls() { toolCalls.length = 0; },
    get controllerTick() {
      return clockEveryCallbacks.length >= 2 ? clockEveryCallbacks[1].fn : null;
    },
    get heartbeatTick() {
      return clockEveryCallbacks.length >= 1 ? clockEveryCallbacks[0].fn : null;
    },
  };
}

// --- Date.now stub ---

function stubDateNow() {
  const realNow = Date.now;
  let current = 1_700_000_000_000;
  Date.now = () => current;
  return {
    set(ms) { current = ms; },
    advance(ms) { current += ms; },
    get() { return current; },
    restore() { Date.now = realNow; },
  };
}

// --- Goal node builder ---

function makeGoalNode(overrides = {}) {
  return {
    id: "g-root",
    parentId: null,
    kind: "root",
    title: "Harness root goal",
    objective: "Harness objective for tick tests",
    status: "pending",
    source: "operator",
    maxRounds: 0,
    completedRounds: 0,
    scores: [],
    notes: [],
    planningRounds: 0,
    consecutiveBlockedPlannings: 0,
    consecutivePlanningFailures: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// --- State builder (full AgentState for persona store seeding) ---
// Default tree: root (pending) + plan (active, leaf) + no tasks.
// This satisfies enforceInvariants: plan is active and a leaf,
// so activeGoalId = plan id. Root is not active, so isPlanningDue = false.

function makeState(opts = {}) {
  const now = opts.now || 1_700_000_000_000;
  const hasActiveLeaf = opts.hasActiveLeaf !== false;
  let goals = [];
  let activeGoalId = null;
  // BM2: allow custom goals array (for testing planner with root-only state)
  if (opts.goals) {
    goals = opts.goals;
    activeGoalId = opts.activeGoalId || null;
  } else if (hasActiveLeaf) {
    const root = makeGoalNode({ id: "g-root", parentId: null, kind: "root", status: "pending" });
    const plan = makeGoalNode({ id: "g-plan", parentId: "g-root", kind: "plan", status: "active" });
    goals = [root, plan];
    activeGoalId = "g-plan";
  }
  const state = {
    version: 4,
    persona: "default",
    activeSessionId: SESSION_ID,
    epoch: 1,
    memory: [],
    goals,
    activeGoalId,
    monitor: {
      sessionStart: now,
      turnCount: 0,
      totalToolCalls: 0,
      errors: 0,
      lastTurnComplete: opts.lastTurnComplete || 0,
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
        consecutiveSkips: opts.consecutiveSkips || 0,
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
  // BO1-pin: allow custom selfReview state
  if (opts.selfReview) {
    state.monitor.selfReview = opts.selfReview;
  }
  return state;
}

// --- Turn driver: fires turn.start then turn.complete (aborted, no scoring) ---

async function fireTurn(harness) {
  const { fake } = harness;
  const handlers = harness.handlers;
  const startH = handlers["turn.start"];
  const completeH = handlers["turn.complete"];
  if (startH) await startH(fake, { turnId: "harness-turn" }, () => {});
  if (completeH) await completeH(fake, { aborted: true, reason: "aborted" }, () => {});
}

// --- Tick driver: fires the controller-tick callback ---

async function fireTick(harness) {
  const { fake } = harness;
  const fn = harness.controllerTick;
  if (!fn) throw new Error("controller tick callback not registered");
  await fn();
}

// --- Heartbeat driver: fires the heartbeat-tick callback ---

async function fireHeartbeat(harness) {
  const { fake } = harness;
  const fn = harness.heartbeatTick;
  if (!fn) throw new Error("heartbeat tick callback not registered");
  await fn();
}

// --- Seed the fake fs with persona store + stale heartbeat ---

function seedPersonaStore(harness, state) {
  const storePath = ".agentic-personas.json";
  const store = { default: state };
  harness.fsMap.set(storePath, JSON.stringify(store));
  const hbPath = ".agentic-heartbeat.json";
  // Stale heartbeat: lastSeen far in the past so session.start claims.
  harness.fsMap.set(hbPath, JSON.stringify({
    default: { sessionId: "old-session", epoch: 1, lastSeen: 1_000_000_000_000 },
  }));
}

// AO2: Fresh module per case. Drop the _modPromise cache.
// Each createTickHarness call gets a fresh module instance via query param.

async function loadModule(caseName) {
  const query = `?case=${encodeURIComponent(caseName || "default")}`;
  return import(`../hooks/index.ts${query}`);
}

async function createTickHarness(options = {}) {
  const h = createFake$(options);

  // Seed the persona store before session.start so it can claim/join.
  const state = makeState(options.stateOpts || {});
  seedPersonaStore(h, state);

  const caseName = options.caseName || "default";
  const mod = await loadModule(caseName);
  const handlers = {};

  const on = (event, handler) => {
    handlers[event] = handler;
  };

  await mod.register(on, options);

  // Fire session.start to initialize sess and register clock callbacks.
  // The stale heartbeat causes session.start to claim the persona and
  // re-set sess.state from the seeded store.
  const startH = handlers["session.start"];
  if (startH) {
    await startH(h.fake, {}, () => {});
  }

  h.handlers = handlers;

  return h;
}

export {
  createTickHarness,
  createFake$,
  stubDateNow,
  makeState,
  makeGoalNode,
  fireTurn,
  fireTick,
  fireHeartbeat,
  seedPersonaStore,
  loadModule,
  SESSION_ID,
};
