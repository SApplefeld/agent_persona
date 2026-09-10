#!/usr/bin/env node
// controller-tick-test.mjs: tick-harness tests for D2, D4, AM7, D3.
//
// Drives the real hooks/index.ts controller-tick callback through the
// tick-harness fake $ with stubbed Date.now and configurable model.classify.
// Proves:
//   D2  : idle tick skip (unchanged summary, classify not called)
//   D4  : backoff after consecutive skips, reset on turn.start
//   AM7 : cost_summary fires on cadence (every N ticks)
//   D3  : nudge cap (costMaxNudgesPerHour)
//
// Usage: node controller-tick-test.mjs
// Exits 0 on success, 1 on failure.

import {
  createTickHarness,
  stubDateNow,
  fireTick,
  fireTurn,
  makeState,
  getTestHook,
  SESSION_ID,
} from "./tick-harness.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  OK: ${name}`);
  } else {
    console.error(`  FAIL: ${name}`);
    failures++;
  }
}

const OPTS = {
  nudgeIdleMs: 60000,
  nudgeFloorMs: 120000,
  tickMs: 10000,
  costMaxNudgesPerHour: 2,
  costSummaryEveryNTicks: 2,
  costBackoffAfterTicks: 2,
};

const T0 = 1_700_000_000_000;

// Helper: patch sess.state directly via __test hook.
async function patchState(fn) {
  const t = await getTestHook();
  const st = t.getState();
  fn(st);
}

// Helper: read decisions from sess.state.
async function getDecisions() {
  const t = await getTestHook();
  return t.getState().decisions;
}

function countAction(decisions, action) {
  return decisions.filter(d => d.action === action).length;
}

async function tickAndSettle(h, clock, ms = 50) {
  await fireTick(h);
  await new Promise(r => setTimeout(r, ms));
}

// ============================================================
// D2: idle tick skip
// ============================================================
async function caseD2(clock) {
  console.log("\n=== D2: idle tick skip ===");
  clock.set(T0);

  const h = await createTickHarness(OPTS);
  const t = await getTestHook();

  // Patch sess.state: seed lastTurnComplete 65s back, clear decisions.
  const st = t.getState();
  st.monitor.lastTurnComplete = T0 - 65000;
  st.decisions = [];
  st.monitor.cost.consecutiveSkips = 0;
  t.resetNudge();
  t.setTickCount(0);

  h.setClassifyValue("nudge");
  h.resetClassifyCalls();

  // --- Tick 1: nudge is due (idle 65s > nudgeIdleMs 60s) ---
  await tickAndSettle(h, clock);

  let cls = h.classifyCalls.length;
  let decs = t.getState().decisions;
  let nudgeSent = countAction(decs, "nudge_sent");
  let nudgeCount = t.getState().monitor.cost.nudge.count;

  check("D2 tick1: classify called exactly once", cls === 1);
  check("D2 tick1: nudge_sent in decisions", nudgeSent === 1);
  check("D2 tick1: nudge count bumped", nudgeCount === 1);

  // --- Phase 2: D2 unchanged-skip test.
  // Use costSummaryEveryNTicks=100 to avoid interference from cost_summary.
  // The D2 path fires when: idle >= nudgeIdleMs AND unchanged hash AND NOT nudgeDue.
  // nudgeDue = idle >= nudgeIdleMs AND (now - lastNudgeAt >= nudgeFloorMs).
  // Set lastNudgeAt = now (floor not met → nudgeDue false).
  // Reset tick count so we don't hit the cost_summary cadence.
  t.setLastNudgeAt(Date.now());
  t.setLastTurnComplete(Date.now() - 65000);
  t.getState().decisions = [];
  t.getState().monitor.cost.consecutiveSkips = 0;

  // --- Four ticks with unchanged summary: D2 skip fires ---
  const classifyBefore = h.classifyCalls.length;
  for (let i = 0; i < 4; i++) {
    clock.advance(10000);
    await tickAndSettle(h, clock, 20);
  }

  cls = h.classifyCalls.length;
  decs = t.getState().decisions;
  const skipDecs = decs.filter(d => d.detail && d.detail.includes("unchanged, skipped"));
  const consecutiveSkips = t.getState().monitor.cost.consecutiveSkips;

  check("D2: no new classify calls in skip phase", cls === classifyBefore);
  check("D2: >= 3 unchanged skip decisions", skipDecs.length >= 3);
  check("D2: consecutiveSkips >= 3", consecutiveSkips >= 3);
}

// ============================================================
// D4: backoff after consecutive skips
// ============================================================
async function caseD4(clock) {
  console.log("\n=== D4: backoff ===");
  clock.set(T0);

  const h = await createTickHarness(OPTS);
  const t = await getTestHook();

  // Patch: seed lastTurnComplete 65s back, consecutiveSkips = 4.
  const st = t.getState();
  st.monitor.lastTurnComplete = T0 - 65000;
  st.decisions = [];
  st.monitor.cost.consecutiveSkips = 4;
  st.monitor.cost.nudgeWindow = { start: 0, count: 0 };
  t.resetNudge();
  t.setTickCount(0);

  h.setClassifyValue("nudge");
  h.resetClassifyCalls();

  // Fire 6 ticks. With consecutiveSkips starting at 4 and
  // costBackoffAfterTicks = 2, classify is refused (backed off).
  for (let i = 0; i < 6; i++) {
    clock.advance(10000);
    await tickAndSettle(h, clock, 20);
  }

  const decs = t.getState().decisions;
  const backedOff = decs.filter(d => d.detail && d.detail.includes("backed off")).length;
  const skipped = decs.filter(d => d.detail && d.detail.includes("unchanged, skipped")).length;
  const consecutiveSkips = t.getState().monitor.cost.consecutiveSkips;

  check("D4: backed off >= 3", backedOff >= 3);
  check("D4: consecutiveSkips >= 2 (after reset on classify)", consecutiveSkips >= 2);
  check("D4: unchanged skips present", skipped >= 1);

  // turn.start resets consecutiveSkips.
  await fireTurn(h);
  await new Promise(r => setTimeout(r, 20));
  const st2 = t.getState();
  check("D4 turn.start: consecutiveSkips reset to 0", st2.monitor.cost.consecutiveSkips === 0);
}

// ============================================================
// AM7: cost summary cadence
// ============================================================
async function caseAM7(clock) {
  console.log("\n=== AM7: cost summary cadence ===");
  clock.set(T0);

  const h = await createTickHarness({
    ...OPTS,
    stateOpts: { hasActiveLeaf: false },
  });
  const t = await getTestHook();

  // Patch: clear decisions.
  t.getState().decisions = [];
  t.setTickCount(0);

  h.resetClassifyCalls();

  // Fire 4 ticks. costSummaryEveryNTicks = 2, so ticks 2 and 4
  // should emit cost_summary.
  for (let i = 0; i < 4; i++) {
    clock.advance(10000);
    await tickAndSettle(h, clock, 20);
  }

  const decs = t.getState().decisions;
  const costSummaries = countAction(decs, "cost_summary");
  const cls = h.classifyCalls.length;

  check("AM7: two cost_summary decisions (ticks 2 and 4)", costSummaries === 2);
  check("AM7: no classify calls (no active goal)", cls === 0);
}

// ============================================================
// D3: nudge cap
// ============================================================
async function caseD3(clock) {
  console.log("\n=== D3: nudge cap ===");
  clock.set(T0);

  const h = await createTickHarness(OPTS);
  const t = await getTestHook();

  // Patch: seed lastTurnComplete 65s back, clear decisions, reset nudge.
  const st = t.getState();
  st.monitor.lastTurnComplete = T0 - 65000;
  st.decisions = [];
  st.nudge = { lastNudgeAt: 0, consecutiveNudgesWithoutOnGoal: 0 };
  st.monitor.cost.nudgeWindow = { start: 0, count: 0 };
  t.resetNudge();
  t.setTickCount(0);

  h.setClassifyValue("nudge");
  h.resetClassifyCalls();

  // Three due nudges, 130s apart (above nudgeFloorMs = 120s).
  // costMaxNudgesPerHour = 2, so the third should hit the cap.
  for (let i = 0; i < 3; i++) {
    clock.advance(130000);
    await tickAndSettle(h, clock, 50);
  }

  const decs = t.getState().decisions;
  const nudgeSent = countAction(decs, "nudge_sent");
  const capReached = countAction(decs, "cost_cap_reached");
  const cls = h.classifyCalls.length;

  check("D3: two nudge_sent", nudgeSent === 2);
  check("D3: one cost_cap_reached", capReached === 1);
  check("D3: classify called exactly twice", cls === 2);
}

// --- Main ---

async function main() {
  const clock = stubDateNow();
  try {
    await caseD2(clock);
    await caseD4(clock);
    await caseAM7(clock);
    await caseD3(clock);
  } finally {
    clock.restore();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failure(s)`);
  process.exit(failures);
}

main().catch(e => { console.error(e); process.exit(1); });
