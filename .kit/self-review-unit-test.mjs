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
  reviewOwnRecord,
  kaizenSortKey,
  KAIZEN_MESSAGE_WAIT_MS,
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
  // Meaning dedupe (item 8.4's memory_quality kaizen goal): a paraphrase
  // sharing the stored lesson's first six normalized words is a duplicate,
  // and a distinct proof-backed lesson is kept.
  const memoryWithLongLesson = [
    ...memory,
    { id: "mem-2", kind: "lesson", text: "When a reader claim is missing, investigate the root cause before retrying", confidence: 0.5, source: "self-review", createdAt: 1, lastAccessed: 1, accessCount: 0, pinned: false },
  ];
  const isParaphraseDupe = dedupeSelfReview(memoryWithLongLesson, "When a reader claim is missing entirely, dig into the root cause first");
  check("Test 10d: paraphrase sharing the lead is dupe", isParaphraseDupe === true);
  const isDistinctKept = dedupeSelfReview(memoryWithLongLesson, "Tests passed after adding the missing null check, confirmed by the harness");
  check("Test 10e: distinct proof-backed lesson is not dupe", isDistinctKept === false);
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

// --- Test 12: reviewOwnRecord counts each signal from the worker's own record (item 8.4) ---
{
  const T = 1_700_000_000_000;
  const srOpts = { selfReviewEveryTurns: 20, selfReviewDebounceTurns: 5 };
  const lesson = (id, text, createdAt) => ({ id, kind: "lesson", text, confidence: 0.5, source: "self-review", createdAt, lastAccessed: createdAt, accountCount: 0, pinned: false });
  const root = { id: "root", status: "pending", kind: "root", parentId: null, createdAt: T - 100, updatedAt: T - 100 };

  // 12a: tree lag - two worktree-cleared samples with no tree write between them is one event,
  // a third with a `done` in between is not; two events fire.
  const treeLagDecisions = [
    { timestamp: T + 1, loop: "monitor", action: "env_git", detail: "env_git dirty=0 (was 3) branch b...origin/b" },
    { timestamp: T + 2, loop: "monitor", action: "env_git", detail: "env_git dirty=0 (was 2) branch b...origin/b" },
    { timestamp: T + 3, loop: "monitor", action: "env_git", detail: "env_git dirty=0 (was 1) branch b...origin/b" },
    { timestamp: T + 4, loop: "goal", action: "done", detail: "plan-x marked complete" },
    { timestamp: T + 5, loop: "monitor", action: "env_git", detail: "env_git dirty=0 (was 4) branch b...origin/b" },
    { timestamp: T + 6, loop: "monitor", action: "env_git", detail: "env_git dirty=0 (was 0) branch b...origin/b" },
  ];
  const treeLag = reviewOwnRecord({ decisions: treeLagDecisions, memory: [], goals: [root], inbox: [] }, srOpts);
  check("Test 12a: tree_lag counts cleared samples with no tree write since the previous one (2), skips the one after `done`",
    treeLag.length === 1 && treeLag[0].signal === "tree_lag" && treeLag[0].count === 2);

  // 12b: memory quality - two lessons sharing their first six words count as two events; a distinct third does not.
  const memory = [
    lesson("m1", "When a reader claim is missing, investigate the root cause before retrying. Repeated skips.", T + 1),
    lesson("m2", "When a reader claim is missing, investigate the root cause before retrying. No live reader.", T + 2),
    lesson("m3", "Run the harness before the live suite so a loader failure shows first.", T + 3),
  ];
  const mem = reviewOwnRecord({ decisions: [], memory, goals: [root], inbox: [] }, srOpts);
  check("Test 12b: memory_quality counts the duplicate pair (2) and not the distinct lesson",
    mem.length === 1 && mem[0].signal === "memory_quality" && mem[0].count === 2 && /Proof:/.test(mem[0].objective));

  // 12c: message wait - records delivered past the bound count, one under it does not.
  const inbox = [
    { at: T, deliveredAt: T + KAIZEN_MESSAGE_WAIT_MS },
    { at: T, deliveredAt: T + KAIZEN_MESSAGE_WAIT_MS + 1 },
    { at: T, deliveredAt: T + 5000 },
    { at: T },
  ];
  const wait = reviewOwnRecord({ decisions: [], memory: [], goals: [root], inbox }, srOpts);
  check("Test 12c: message_wait counts the two records at or past the bound", wait.length === 1 && wait[0].signal === "message_wait" && wait[0].count === 2);

  // 12d: a closed kaizen node for a signal hides the events before it; only newer ones count.
  const closedKaizen = { id: "k1", status: "complete", kind: "plan", parentId: "root", createdAt: T + 1, updatedAt: T + 5, kaizenSignal: "asks_unresolved" };
  const askDecisions = [
    { timestamp: T + 2, loop: "monitor", action: "ask_timeout", detail: "old" },
    { timestamp: T + 3, loop: "monitor", action: "ask_reraised", detail: "old" },
    { timestamp: T + 6, loop: "monitor", action: "ask_timeout", detail: "new" },
  ];
  const sinceClosed = reviewOwnRecord({ decisions: askDecisions, memory: [], goals: [root, closedKaizen], inbox: [] }, srOpts);
  check("Test 12d: events before a closed kaizen node do not count (1 new event, no finding)", sinceClosed.length === 0);
  const noPrior = reviewOwnRecord({ decisions: askDecisions, memory: [], goals: [root], inbox: [] }, srOpts);
  check("Test 12d control: with no prior node all three events count", noPrior.length === 1 && noPrior[0].count === 3);

  // 12e: long turns carry a config fix halving the cadence, floored at the debounce; at the floor they propose a goal instead.
  const longTurns = [
    { timestamp: T + 1, loop: "monitor", action: "turn_over_hour", detail: "Turn 1 ran 3700s" },
    { timestamp: T + 2, loop: "monitor", action: "turn_over_hour", detail: "Turn 2 ran 3800s" },
  ];
  const fix = reviewOwnRecord({ decisions: longTurns, memory: [], goals: [root], inbox: [] }, srOpts);
  check("Test 12e: long_turns carries configFix selfReviewEveryTurns 20 -> 10",
    fix.length === 1 && fix[0].configFix && fix[0].configFix.from === 20 && fix[0].configFix.to === 10);
  const atFloor = reviewOwnRecord({ decisions: longTurns, memory: [], goals: [root], inbox: [] }, { selfReviewEveryTurns: 5, selfReviewDebounceTurns: 5 });
  check("Test 12e control: at the floor there is no configFix and the finding proposes a goal", atFloor.length === 1 && !atFloor[0].configFix);

  // 12f: kaizenSortKey interleaves after the (k+1)th pending roadmap plan; past the end it is `now`.
  const plans = [
    root,
    { id: "p1", status: "pending", kind: "plan", parentId: "root", createdAt: T + 10, updatedAt: T + 10 },
    { id: "p2", status: "pending", kind: "plan", parentId: "root", createdAt: T + 20, updatedAt: T + 20 },
    { id: "p0", status: "complete", kind: "plan", parentId: "root", createdAt: T + 5, updatedAt: T + 5 },
  ];
  const k0 = kaizenSortKey(plans, "root", T + 1000);
  check("Test 12f: first kaizen sorts between the first and second pending roadmap plans", k0 > T + 10 && k0 < T + 20);
  const withOne = [...plans, { id: "k", status: "pending", kind: "plan", parentId: "root", createdAt: T + 30, updatedAt: T + 30, sortKey: k0, kaizenSignal: "asks_unresolved" }];
  const k1 = kaizenSortKey(withOne, "root", T + 1000);
  check("Test 12f: second kaizen sorts after the second pending roadmap plan", k1 > T + 20 && k1 < T + 1000);
  const k2 = kaizenSortKey([...withOne, { id: "k2", status: "pending", kind: "plan", parentId: "root", createdAt: T + 31, updatedAt: T + 31, sortKey: k1, kaizenSignal: "tree_lag" }], "root", T + 1000);
  check("Test 12f: past the pending roadmap list the kaizen sorts at now", k2 === T + 1000);
}

// --- Summary ---
const summary = `\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`;
console.log(summary);
process.exit(failed === 0 ? 0 : 1);
