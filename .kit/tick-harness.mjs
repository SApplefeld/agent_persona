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
const HARNESS_CWD = "D:/harness-root";

// The one path the plugin resolves the heartbeat file to under this harness.
// The plugin anchors it to the launch directory it captured at session.start,
// which here is HARNESS_CWD. Cases seed and assert through this constant so a
// fixture cannot go on naming a path the plugin stopped writing, which is the
// shape of the production defect the anchoring fixes.
const HEARTBEAT_FILE = `${HARNESS_CWD}/.agentic-heartbeat.json`;
const PERSONA_STORE_FILE = `${HARNESS_CWD}/.agentic-personas.json`;
const YIELD_LOG_FILE = `${HARNESS_CWD}/.agentic-yields.log`;

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
  // Every write the plugin makes through $.fs.write, in order, as
  // { path, content }. A case pinning that some state reached no file at all
  // reads this rather than a path it would have to name itself: a path that
  // was never written and a path the case guessed wrong read the same way.
  const fsWrites = [];
  const promptSubmits = [];
  // The texts of accepted submits whose turn has not opened yet, in
  // submission order. A turn.start a case fires without `text` takes the
  // next one, the way the engine begins a plugin's turn with the text it
  // submitted; a case whose turn is not the next queued submit's (an
  // external turn, a continuation) passes its own `text`.
  const queuedTurnTexts = [];
  const fsMap = new Map();
  const storeMap = new Map();
  let classifyValue = opts.classifyValue || "nudge";
  const classifyCalls = [];
  const completeCalls = [];
  let completeValue = opts.completeValue ?? "[]";
  const uiLogs = [];
  // Every $.http.fetch call, in order, as { url, init }. The decision seam's
  // kill switch is pinned by this list staying empty, which is a stronger
  // reading than any assertion on what a request would have carried.
  const httpCalls = [];
  // What the next fetches resolve with: an HttpResponse-shaped object
  // ({ status, ok, headers, text }), or a function of (url, init) returning
  // a promise, so a case can hang, reject, or answer from the request it was
  // handed. The default answers 200 with an empty answers map, which the
  // seam reads as a parse failure: a case that forgot to set a response sees
  // a settled, visible result rather than a hang.
  let httpResponse = {
    status: 200,
    ok: true,
    headers: {},
    text: '{"model":"jev-fake","answers":{},"usage":{"input_tokens":0,"output_tokens":0}}',
  };
  // The environment $.env.get reads, and every name read, in order. Empty by
  // default: a fake with no TYPESAFE_API_KEY is a VM with no key, so the
  // seam's shadow path is opt-in per case through setEnv.
  const envMap = new Map();
  const envGets = [];
  // Every $.clock.sleep call, in order, each holding its own resolve and
  // reject so a case decides when a timer fires. Nothing fires on its own,
  // which is what lets a case pin the race between a request and its timer.
  const sleeps = [];
  // Non-null while prompt submissions are held open; every submit issued in
  // that window returns this same promise and parks on it.
  let submitHold = null;
  let releaseSubmitHold = null;
  // Non-null to make every subsequent prompt submission reject with it.
  let submitFailure = null;
  // Non-null to make the next prompt submission resolve `{ drop: reason }`,
  // the shape a hook beneath the plugin returns when it drops the plugin's
  // own submit; no turn opens, so nothing is queued. Cleared by that call.
  let submitDrop = null;
  // Non-null to run the next prompt submission's text through it: the stub
  // resolves `{ text: settled }` and queues the settled text, the way a
  // hook beneath the plugin or the engine's cap rewrites the text a turn
  // then opens with. Cleared by that call.
  let submitSettle = null;
  // Non-null while store reads of one key are held: every store.get of that
  // key reads the value as it stands at the call, then parks in
  // parkedStoreGets until releaseStoreGet() lets it resolve.
  let storeGetHoldKey = null;
  const parkedStoreGets = [];

  const fake = {
    ui: {
      log(msg) { uiLogs.push(String(msg)); },
      status() {},
      toast() {},
    },
    // A Map keyed on the raw path string, relative or absolute, with no
    // directory model: a write to an absolute path under a directory nothing
    // has created lands like any other. That is the real $.fs.write's
    // behavior too (it creates the file and its directories as needed), so
    // a module writing journal or catalog files under an absolute <home>
    // path reads the same here as on the engine.
    fs: {
      exists(p) { return Promise.resolve(fsMap.has(p)); },
      read(p) {
        if (!fsMap.has(p)) return Promise.reject(new Error("ENOENT: " + p));
        return Promise.resolve(fsMap.get(p));
      },
      write(p, content) {
        const text = typeof content === "string" ? content : JSON.stringify(content);
        fsMap.set(p, text);
        fsWrites.push({ path: p, content: text });
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
      // The harness fires session.start with no cwd on the event, so the
      // plugin reads its workdir from here. A fixed literal cases can assert on.
      cwd() { return Promise.resolve(HARNESS_CWD); },
      // The session's own message history. The tick reads it for nothing, and
      // the case that pins that hands its own implementation through
      // sessionMessages: a history past 350,000 estimated tokens, which logs
      // no crossing and submits no turn.
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
      // The real $.prompt.submit does not resolve until the session is next
      // idle, so a submit issued during a long turn parks for as long as that
      // turn runs. holdPromptSubmits() puts the stub in that shape. The text is
      // recorded before the wait, so promptSubmits counts submissions attempted
      // rather than submissions resolved, which is what a case asserting "only
      // one copy was ever queued" needs to read. An accepted submit resolves
      // `{ text }` with the text the turn will open with, as the real call
      // does; a held one resolves that once released.
      submit({ text }) {
        promptSubmits.push(text);
        if (submitFailure) return Promise.reject(submitFailure);
        if (submitDrop !== null) {
          const drop = submitDrop;
          submitDrop = null;
          return Promise.resolve({ drop });
        }
        const settled = submitSettle ? submitSettle(text) : text;
        submitSettle = null;
        queuedTurnTexts.push(settled);
        if (submitHold) return submitHold.then(() => ({ text: settled }));
        return Promise.resolve({ text: settled });
      },
    },
    clock: {
      every(intervalMs, fn) {
        clockEveryCallbacks.push({ intervalMs, fn });
        return 0;
      },
      now() { return Date.now(); },
      sleep(ms) {
        return new Promise((resolve, reject) => { sleeps.push({ ms, resolve, reject }); });
      },
    },
    http: {
      fetch(url, init) {
        httpCalls.push({ url, init });
        const r = httpResponse;
        return typeof r === "function" ? Promise.resolve().then(() => r(url, init)) : Promise.resolve(r);
      },
    },
    env: {
      get(name) {
        envGets.push(name);
        return Promise.resolve(envMap.get(name));
      },
    },
    store: {
      // A copy, as the real store hands back a parsed JSON value: a plugin
      // function that mutates what it fetched lands nothing until set runs.
      // A held read keeps the value it read at the call, so it resolves with
      // the store as it stood before any write that lands while it is parked.
      get(key) {
        const value = storeMap.has(key) ? structuredClone(storeMap.get(key)) : null;
        if (storeGetHoldKey !== null && key === storeGetHoldKey) {
          return new Promise((resolve) => { parkedStoreGets.push(() => resolve(value)); });
        }
        return Promise.resolve(value);
      },
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
  fake.toolCalls = toolCalls;
  fake.uiLogs = uiLogs;
  fake.httpCalls = httpCalls;
  fake.envGets = envGets;

  return {
    fake,
    clockEveryCallbacks,
    toolRegisters,
    toolCalls,
    promptSubmits,
    queuedTurnTexts,
    fsMap,
    fsWrites,
    storeMap,
    classifyCalls,
    completeCalls,
    uiLogs,
    httpCalls,
    envGets,
    sleeps,
    setClassifyValue(v) { classifyValue = v; },
    // What every subsequent $.http.fetch resolves with: a response object,
    // or a function of (url, init) returning a promise.
    setHttpResponse(v) { httpResponse = v; },
    // Set (or, with undefined, unset) a variable $.env.get reads.
    setEnv(name, value) {
      if (value === undefined) envMap.delete(name); else envMap.set(name, value);
    },
    get pendingSleepCount() { return sleeps.length; },
    // Resolve the oldest pending $.clock.sleep, the way the host's timer
    // would fire it. Called once per timer, so a case chooses the order.
    fireSleep() {
      const s = sleeps.shift();
      if (s) s.resolve();
    },
    setCompleteValue(v) { completeValue = v; },
    resetClassifyCalls() { classifyCalls.length = 0; },
    resetCompleteCalls() { completeCalls.length = 0; },
    resetPromptSubmits() { promptSubmits.length = 0; },
    resetFsWrites() { fsWrites.length = 0; },
    // Make every subsequent prompt submission reject. The text is still
    // recorded, because the real call has taken the submission by the time it
    // can fail, and a case needs to tell a submit that was never attempted from
    // one that was attempted and threw.
    failPromptSubmits(err) { submitFailure = err; },
    // Make the next prompt submission resolve `{ drop: reason }` and queue
    // nothing; one shot, cleared by that submission. The text is still
    // recorded, as for a rejection.
    dropNextPromptSubmit(reason) { submitDrop = reason; },
    // Run the next prompt submission's text through `fn` before it is
    // queued; the submission resolves `{ text: fn(text) }`. One shot.
    settleNextPromptSubmit(fn) { submitSettle = fn; },
    // Hold every subsequent prompt submission open until releasePromptSubmits().
    holdPromptSubmits() {
      submitHold = new Promise((resolve) => { releaseSubmitHold = resolve; });
    },
    // Resolve the held submissions and let later ones through immediately.
    // Clearing the hold before resolving it is what makes a submit issued after
    // this call return at once rather than joining the batch being released.
    releasePromptSubmits() {
      const resolve = releaseSubmitHold;
      submitHold = null;
      releaseSubmitHold = null;
      if (resolve) resolve();
    },
    // Hold every subsequent store.get of `key` open until releaseStoreGet().
    // Each held read keeps the value the store held at the call.
    holdStoreGets(key) { storeGetHoldKey = key; },
    get parkedStoreGetCount() { return parkedStoreGets.length; },
    // Stop holding new reads, then resolve the oldest parked read. Called
    // once per parked read, so a case chooses which reader resumes first.
    releaseStoreGet() {
      storeGetHoldKey = null;
      const resolve = parkedStoreGets.shift();
      if (resolve) resolve();
    },
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

// The same turnId rides both events, because the plugin closes an open turn by
// the id its turn.start carried; a completion under a different id (or none)
// closes nothing and leaves the session reading as still inside a turn.
async function fireTurn(harness, turnId = "harness-turn") {
  const { fake } = harness;
  const handlers = harness.handlers;
  const startH = handlers["turn.start"];
  const completeH = handlers["turn.complete"];
  if (startH) await startH(fake, { turnId }, () => {});
  if (completeH) await completeH(fake, { turnId, aborted: true, reason: "aborted" }, () => {});
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
  const storePath = PERSONA_STORE_FILE;
  const store = { default: state };
  harness.fsMap.set(storePath, JSON.stringify(store));
  // The plugin anchors the heartbeat file to the launch directory it captured
  // at session.start, which for the harness is HARNESS_CWD. Seeding the bare
  // name instead would leave the plugin reading a file this seed never wrote,
  // which is the production defect the anchoring fixes rather than a property
  // the harness should reproduce.
  const hbPath = HEARTBEAT_FILE;
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
    if (event === "turn.start") {
      // A turn.start fired without `text` begins with the next queued
      // submit's text, "" when none is queued (a continuation).
      handlers[event] = (dp, e, next) =>
        handler(dp, e.text === undefined ? { ...e, text: h.queuedTurnTexts.shift() ?? "" } : e, next);
      return;
    }
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
  HARNESS_CWD,
  HEARTBEAT_FILE,
  PERSONA_STORE_FILE,
  YIELD_LOG_FILE,
};
