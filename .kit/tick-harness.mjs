// tick-harness.mjs: fake $ builder and tick driver for controller-tick-test.mjs.
//
// Builds an in-memory fake $ that satisfies the hooks/index.ts register() surface.
// Records clock.every callbacks (first = heartbeat, second = controller tick).
// The test fires the controller-tick callback by hand with stubbed Date.now,
// model.classify, and an in-memory fs.
//
// The module-scope `sess` in hooks/index.ts is shared across test cases.
// Each createTickHarness call re-claims the persona via a stale heartbeat,
// which re-sets sess.state from the seeded store.

const SESSION_ID = "harness-session";

// --- Fake $ factory ---

function createFake$(opts = {}) {
  const clockEveryCallbacks = [];
  const toolRegisters = [];
  const promptSubmits = [];
  const fsMap = new Map();
  const storeMap = new Map();
  let classifyValue = opts.classifyValue || "nudge";
  const classifyCalls = [];
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
    },
    session: {
      id() { return Promise.resolve(SESSION_ID); },
    },
    model: {
      classify() {
        classifyCalls.push(1);
        return Promise.resolve(classifyValue);
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
      run() { return Promise.resolve({ exitCode: 128 }); },
    },
  };

  // Attach maps to fake for convenient access (h.fake.fsMap === h.fsMap).
  fake.fsMap = fsMap;
  fake.storeMap = storeMap;
  fake.classifyCalls = classifyCalls;
  fake.completeCalls = completeCalls;
  fake.promptSubmits = promptSubmits;
  fake.uiLogs = uiLogs;

  return {
    fake,
    clockEveryCallbacks,
    toolRegisters,
    promptSubmits,
    fsMap,
    storeMap,
    classifyCalls,
    completeCalls,
    uiLogs,
    setClassifyValue(v) { classifyValue = v; },
    setCompleteValue(v) { completeValue = v; },
    resetClassifyCalls() { classifyCalls.length = 0; },
    resetCompleteCalls() { completeCalls.length = 0; },
    resetPromptSubmits() { promptSubmits.length = 0; },
    get controllerTick() {
      return clockEveryCallbacks.length >= 2 ? clockEveryCallbacks[1].fn : null;
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
  if (hasActiveLeaf) {
    const root = makeGoalNode({ id: "g-root", parentId: null, kind: "root", status: "pending" });
    const plan = makeGoalNode({ id: "g-plan", parentId: "g-root", kind: "plan", status: "active" });
    goals = [root, plan];
    activeGoalId = "g-plan";
  }
  return {
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

// --- Seed the fake fs with persona store + stale heartbeat ---

function seedPersonaStore(harness, state) {
  const storePath = ".agentic-personas.json";
  harness.fsMap.set(storePath, JSON.stringify({ default: state }));
  const hbPath = ".agentic-heartbeat.json";
  // Stale heartbeat: lastSeen far in the past so session.start claims.
  harness.fsMap.set(hbPath, JSON.stringify({
    default: { sessionId: "old-session", epoch: 1, lastSeen: 1_000_000_000_000 },
  }));
}

// --- Access the module's __test hook ---
// After loadModule(), the module exports __test which provides direct
// access to sess.state, sess.isOwner, sess.controllerTickCount, etc.

async function getTestHook() {
  const mod = await loadModule();
  return mod.__test;
}

let _modPromise = null;

function loadModule() {
  if (_modPromise) return _modPromise;
  _modPromise = (async () => {
    // Node ESM requires explicit file extensions for relative imports.
    // hooks/index.ts uses extensionless specifiers ("./agent-state") which the
    // PIANO loader resolves but Node does not. Patch them to explicit .ts
    // (idempotent: already-patched lines are unchanged).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const indexPath = path.resolve(fileURLToPath(new URL("../hooks/index.ts", import.meta.url)));
    let src = fs.readFileSync(indexPath, "utf-8");
    const patched = src.replace(
      /from "\.\/(agent-state|commons|self-review|cost-ledger)"/g,
      'from "./$1.ts"'
    );
    if (patched !== src) fs.writeFileSync(indexPath, patched, "utf-8");
    return import("../hooks/index.ts");
  })();
  return _modPromise;
}

async function createTickHarness(options = {}) {
  const h = createFake$(options);

  // Seed the persona store before session.start so it can claim/join.
  const state = makeState(options.stateOpts || {});
  seedPersonaStore(h, state);

  const mod = await loadModule();
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
  stubDateNow,
  makeState,
  makeGoalNode,
  fireTurn,
  fireTick,
  seedPersonaStore,
  getTestHook,
  loadModule,
  SESSION_ID,
};
