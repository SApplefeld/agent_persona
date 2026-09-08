#!/usr/bin/env node
// Self-review unit tests: shouldSelfReview debounce + cap, buildSelfReviewInput filtering,
// dedupeSelfReview, evictSelfReview.
// Usage: node self-review-unit-test.mjs
// Exits 0 on success, 1 on failure.

const {
  shouldSelfReview,
  buildSelfReviewInput,
  dedupeSelfReview,
  evictSelfReview,
} = await import("../hooks/self-review.ts");

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name) { console.error(`  FAIL: ${name}`); failed++; }
function check(name, cond) { if (cond) ok(name); else fail(name); }

const baseOpts = {
  selfReviewStreak: 3,
  selfReviewEveryTurns: 20,
  selfReviewDebounceTurns: 5,
  selfReviewMaxPerHour: 2,
};

function makeState(overrides = {}) {
  return {
    monitor: {
      selfReview: {
        count: 0,
        lastAt: 0,
        turnsSince: 0,
        windowStart: 0,
        pendingPeriodic: false,
        lastInjectAt: 0,
        ...overrides.selfReview,
      },
      env: {
        errors: { consecutiveErrorTurns: 0, toolErrorsLastTurn: 0 },
        ...overrides.env,
      },
      ...overrides.monitor,
    },
    decisions: [],
    memory: [],
    goals: [],
    activeGoalId: null,
    ...overrides,
  };
}

// --- Test 1: fresh state, debounce passes (lastAt === 0) ---
{
  // Fresh state with streak 3: reactive should be eligible (debounce passes).
  const state = makeState({
    env: { errors: { consecutiveErrorTurns: 3, toolErrorsLastTurn: 1 } },
  });
  const now = Date.now();
  const r = shouldSelfReview(state, baseOpts, now, "reactive");
  check("Test 1: fresh state, debounce passes (lastAt === 0), reactive eligible", r.eligible === true && r.reason.includes("streak"));
}

// --- Test 2: debounce blocks when turnsSince < debounce and lastAt > 0 ---
{
  const state = makeState({
    selfReview: { count: 0, lastAt: 1000, turnsSince: 2, windowStart: 1000, pendingPeriodic: false, lastInjectAt: 0 },
    env: { errors: { consecutiveErrorTurns: 5, toolErrorsLastTurn: 1 } },
  });
  const now = 2000;
  const r = shouldSelfReview(state, baseOpts, now, "reactive");
  check("Test 2: debounce blocks (turnsSince 2 < 5, lastAt > 0)", r.eligible === false);
}

// --- Test 3: debounce passes when turnsSince >= debounce ---
{
  const state = makeState({
    selfReview: { count: 0, lastAt: 1000, turnsSince: 5, windowStart: 1000, pendingPeriodic: false, lastInjectAt: 0 },
    env: { errors: { consecutiveErrorTurns: 5, toolErrorsLastTurn: 1 } },
  });
  const now = 2000;
  const r = shouldSelfReview(state, baseOpts, now, "reactive");
  check("Test 3: debounce passes (turnsSince 5 >= 5, streak 5 >= 3)", r.eligible === true);
}

// --- Test 4: reactive trigger requires streak >= threshold ---
{
  const state = makeState({
    selfReview: { count: 0, lastAt: 0, turnsSince: 0, windowStart: 0, pendingPeriodic: false, lastInjectAt: 0 },
    env: { errors: { consecutiveErrorTurns: 1, toolErrorsLastTurn: 0 } },
  });
  const now = Date.now();
  const r = shouldSelfReview(state, baseOpts, now, "reactive");
  check("Test 4: reactive blocked (streak 1 < 3)", r.eligible === false);
}

// --- Test 5: periodic trigger via pendingPeriodic ---
{
  const state = makeState({
    selfReview: { count: 0, lastAt: 0, turnsSince: 0, windowStart: 0, pendingPeriodic: true, lastInjectAt: 0 },
    env: { errors: { consecutiveErrorTurns: 0, toolErrorsLastTurn: 0 } },
  });
  const now = Date.now();
  const r = shouldSelfReview(state, baseOpts, now, "periodic");
  check("Test 5: periodic eligible (pendingPeriodic true, lastAt === 0)", r.eligible === true);
}

// --- Test 6: periodic trigger via turnsSince >= everyTurns ---
{
  const state = makeState({
    selfReview: { count: 0, lastAt: 0, turnsSince: 20, windowStart: 0, pendingPeriodic: false, lastInjectAt: 0 },
    env: { errors: { consecutiveErrorTurns: 0, toolErrorsLastTurn: 0 } },
  });
  const now = Date.now();
  const r = shouldSelfReview(state, baseOpts, now, "periodic");
  check("Test 6: periodic eligible (turnsSince 20 >= 20, lastAt === 0)", r.eligible === true);
}

// --- Test 7: cap blocks when count >= maxPerHour (within window) ---
{
  const state = makeState({
    selfReview: { count: 2, lastAt: 1000, turnsSince: 10, windowStart: 1000, pendingPeriodic: false, lastInjectAt: 0 },
    env: { errors: { consecutiveErrorTurns: 5, toolErrorsLastTurn: 1 } },
  });
  const now = 2000; // within 3600000 ms of windowStart
  const r = shouldSelfReview(state, baseOpts, now, "reactive");
  check("Test 7: cap blocks (count 2 >= maxPerHour 2, within window)", r.eligible === false);
}

// --- Test 8: cap resets when window expires (S10) ---
{
  const state = makeState({
    selfReview: { count: 2, lastAt: 1000, turnsSince: 10, windowStart: 1000, pendingPeriodic: false, lastInjectAt: 0 },
    env: { errors: { consecutiveErrorTurns: 5, toolErrorsLastTurn: 1 } },
  });
  const now = 1000 + 3600000 + 1000; // past the hourly window
  const r = shouldSelfReview(state, baseOpts, now, "reactive");
  check("Test 8: cap resets (window expired, count effectively 0)", r.eligible === true);
}

// --- Test 9: buildSelfReviewInput filters noise decisions (S5) ---
{
  const state = makeState();
  state.decisions = [
    { timestamp: 1, loop: "memory", action: "remember", detail: "fact: user likes red" },
    { timestamp: 2, loop: "monitor", action: "controller_tick", detail: "tick" },
    { timestamp: 3, loop: "monitor", action: "env_inject", detail: "git: clean" },
    { timestamp: 4, loop: "monitor", action: "heartbeat", detail: "hb" },
    { timestamp: 5, loop: "goal", action: "done", detail: "leaf-1 complete" },
    { timestamp: 6, loop: "monitor", action: "self-review", detail: "reactive: NONE" },
  ];
  const now = Date.now();
  const input = buildSelfReviewInput(state, now);
  check("Test 9a: input has prompt", input.prompt.length > 0);
  check("Test 9b: input excludes controller_tick", !input.prompt.includes("controller_tick"));
  check("Test 9c: input excludes env_inject", !input.prompt.includes("env_inject"));
  check("Test 9d: input excludes heartbeat", !input.prompt.includes("heartbeat"));
  check("Test 9e: input excludes self-review", !input.prompt.includes("reactive: NONE"));
  check("Test 9f: input includes worker-facing action", input.prompt.includes("remember") || input.prompt.includes("done"));
  check("Test 9g: provenance has decisionTimestamps", Array.isArray(input.decisionTimestamps) && input.decisionTimestamps.length > 0);
  check("Test 9h: provenance has streak", typeof input.streak === "number");
}

// --- Test 10: dedupeSelfReview detects dupe ---
{
  const memory = [
    { id: "mem-1", kind: "lesson", text: "Use the Bash tool carefully", confidence: 0.5, source: "self-review", createdAt: 1, lastAccessed: 1, accessCount: 0, pinned: false },
  ];
  const isDupe = dedupeSelfReview(memory, "Use the Bash tool carefully");
  check("Test 10a: exact match is dupe", isDupe === true);
  const isNotDupe = dedupeSelfReview(memory, "A completely different lesson");
  check("Test 10b: different text is not dupe", isNotDupe === false);
  // Case-insensitive
  const isDupeCI = dedupeSelfReview(memory, "USE THE BASH TOOL CAREFULLY");
  check("Test 10c: case-insensitive match is dupe", isDupeCI === true);
}

// --- Test 11: evictSelfReview keeps newest 5 (S8) ---
{
  const now = Date.now();
  const memory = [];
  // 7 self-review lessons
  for (let i = 0; i < 7; i++) {
    memory.push({
      id: `mem-${i}`,
      kind: "lesson",
      text: `Lesson ${i}`,
      confidence: 0.5,
      source: "self-review",
      createdAt: now - (7 - i) * 1000,
      lastAccessed: now,
      accessCount: 0,
      pinned: false,
    });
  }
  // 1 user-pinned memory (must survive)
  memory.push({
    id: "mem-user",
    kind: "preference",
    text: "User prefers dark mode",
    confidence: 0.9,
    source: "user",
    createdAt: now - 100000,
    lastAccessed: now,
    accessCount: 5,
    pinned: true,
  });

  evictSelfReview(memory);
  const selfReviewCount = memory.filter(m => m.source === "self-review").length;
  check("Test 11a: eviction keeps max 5 self-review lessons", selfReviewCount <= 5);
  const userMem = memory.find(m => m.id === "mem-user");
  check("Test 11b: user-pinned memory survives eviction", !!userMem);
  // Oldest self-review lessons evicted
  const selfReview = memory.filter(m => m.source === "self-review").sort((a, b) => a.createdAt - b.createdAt);
  check("Test 11c: oldest self-review lesson evicted", !memory.find(m => m.id === "mem-0"));
  check("Test 11d: newest self-review lesson kept", !!memory.find(m => m.id === "mem-6"));
}

// --- Summary ---
const summary = `\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`;
console.log(summary);
process.exit(failed === 0 ? 0 : 1);
