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
// AO2: Fresh module per case. Each case gets a new module instance via
// `import(\`../hooks/index.ts?case=${name}\`)`, so no state leaks between cases.
// Reads go through the fake store (fs.write receives the persisted persona JSON).
//
// AO1: The harness uses a Node resolve hook, so hooks/index.ts is never written.
// The last assertion checks that `git diff --quiet hooks/index.ts` succeeds.
//
// Usage: node controller-tick-test.mjs
// Exits 0 on success, 1 on failure.

import { createTickHarness, createFake$, stubDateNow, fireTick, fireHeartbeat, fireTurn, SESSION_ID, HARNESS_CWD, loadModule, makeState, makeGoalNode } from "./tick-harness.mjs";
import { DECISIONS_MAX, MEMORY_MAX } from "../hooks/agent-state.ts";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  OK: ${name}`);
  } else {
    console.error(`  FAIL: ${name}`);
    if (detail !== undefined) console.error(`        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
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

// Helper: read state from the fake store (persona JSON).
function getState(h) {
  const storePath = ".agentic-personas.json";
  const raw = h.fsMap.get(storePath);
  if (!raw) throw new Error("Persona store not found in fake fs");
  const store = JSON.parse(raw);
  return store.default;
}

// Helper: read decisions from state.
function getDecisions(h) {
  return getState(h).decisions;
}

// Helper: read state for an arbitrary persona key (item 6: the persona
// option means the store's top-level key is no longer always "default").
function getStateForPersona(h, persona) {
  const storePath = ".agentic-personas.json";
  const raw = h.fsMap.get(storePath);
  if (!raw) throw new Error("Persona store not found in fake fs");
  const store = JSON.parse(raw);
  return store[persona];
}

function countAction(decisions, action) {
  return decisions.filter(d => d.action === action).length;
}

async function tickAndSettle(h, clock, ms = 50) {
  await fireTick(h);
  await new Promise(r => setTimeout(r, ms));
}

// A bounded poll on a condition the code under test actually sets, for the
// cases that have one. It is the readable half of the alternative: a fixed
// sleep passes by being long enough today and reds by being short tomorrow,
// while this reports whether the condition ever held. The ceiling is polls
// rather than milliseconds because Date.now is stubbed under these cases.
async function waitUntil(pred, maxPolls = 400, stepMs = 5) {
  for (let i = 0; i < maxPolls; i++) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return pred();
}

// The controller tick's last act is a persisted write, so a round's own
// controller_tick decision showing up in the persisted store is the signal that
// the whole tick body, actuator included, has finished.
function countPersistedTicks(h) {
  return countAction(getDecisions(h), "controller_tick");
}

// The nudge prompts the tick queued, in submission order.
function goalPrompts(h) {
  return (h.promptSubmits || []).filter(p => p.startsWith("[GOAL]"));
}


// ============================================================
// D2: idle tick skip
// ============================================================
async function caseD2(clock) {
  console.log("\n=== D2: idle tick skip ===");
  clock.set(T0);

  const h = await createTickHarness({
    ...OPTS,
    caseName: "d2",
  });

  h.setClassifyValue("nudge");
  h.resetClassifyCalls();

  // Fire a turn to set lastTurnComplete to the current time.
  await fireTurn(h);
  await new Promise(r => setTimeout(r, 20));

  // Advance the clock by 65 seconds (past nudgeIdleMs = 60s).
  clock.advance(65000);

  // --- Tick 1: nudge is due (idle 65s > nudgeIdleMs 60s) ---
  await tickAndSettle(h, clock);

  let cls = h.classifyCalls.length;
  let st = getState(h);
  let decs = st.decisions;

  check("D2 tick1: classify called exactly once", cls === 1);

  // --- Phase 2: D2 unchanged-skip test.
  // After the first nudge, lastNudgeAt is set to now.
  // The nudgeDue condition is: idle >= nudgeIdleMs AND (now - lastNudgeAt >= nudgeFloorMs).
  // Since lastNudgeAt was just set to now, (now - lastNudgeAt) = 0 < nudgeFloorMs (120s).
  // So nudgeDue is false, and the D2 skip path fires.
  // Reset tick count so we don't hit the cost_summary cadence.
  // Note: With a fresh module, the tick count starts at 0 for each case.
  // But costSummaryEveryNTicks = 2, so ticks 2 and 4 would emit cost_summary.
  // To avoid interference, we just check that no NEW classify calls happen.

  // --- Four ticks with unchanged summary: D2 skip fires ---
  const classifyBefore = h.classifyCalls.length;
  for (let i = 0; i < 4; i++) {
    clock.advance(10000);
    await tickAndSettle(h, clock, 20);
  }

  cls = h.classifyCalls.length;
  decs = getState(h).decisions;
  const skipDecs = decs.filter(d => d.detail && d.detail.includes("unchanged, skipped"));
  const consecutiveSkips = getState(h).monitor.cost.consecutiveSkips;

  check("D2: no new classify calls in skip phase", cls === classifyBefore);
  check("D2: >= 3 unchanged skip decisions", skipDecs.length >= 3);
  check("D2: consecutiveSkips >= 3", consecutiveSkips >= 3);
}

// ============================================================
// D4: activity resets the skip streak
// ============================================================
async function caseD4(clock) {
  console.log("\n=== D4: turn.start resets consecutiveSkips ===");
  clock.set(T0);

  // Seed the state with consecutiveSkips = 4, so the reset below has a
  // nonzero streak to clear. The backoff arithmetic itself is unit-tested
  // in cost-ledger-unit-test.mjs.
  const h = await createTickHarness({
    ...OPTS,
    caseName: "d4",
    stateOpts: { consecutiveSkips: 4 },
  });

  const st = getState(h);
  check("D4 control: the seeded streak is 4 before any turn", st.monitor.cost.consecutiveSkips === 4);

  // turn.start resets consecutiveSkips.
  await fireTurn(h);
  await new Promise(r => setTimeout(r, 20));
  const st2 = getState(h);
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
    caseName: "am7",
    stateOpts: { hasActiveLeaf: false },
  });

  h.resetClassifyCalls();

  // Fire 4 ticks. costSummaryEveryNTicks = 2, so ticks 2 and 4
  // should emit cost_summary.
  for (let i = 0; i < 4; i++) {
    clock.advance(10000);
    await tickAndSettle(h, clock, 20);
  }

  const st = getState(h);
  const decs = st.decisions;
  const costSummaries = countAction(decs, "cost_summary");

  check("AM7: two cost_summary decisions (ticks 2 and 4)", costSummaries === 2);
}

// ============================================================
// D3: nudge cap
// ============================================================
async function caseD3(clock) {
  console.log("\n=== D3: nudge cap ===");
  clock.set(T0);

  // With a fresh module per case, the state is clean.
  // The seeded state has lastNudgeAt = 0, consecutiveNudgesWithoutOnGoal = 0,
  // nudgeWindow = { start: 0, count: 0 }.
  // So the first nudge will be the first in the window.
  const h = await createTickHarness({
    ...OPTS,
    caseName: "d3",
  });

  h.setClassifyValue("nudge");
  h.resetClassifyCalls();

  // Three due nudges, 130s apart (above nudgeFloorMs = 120s).
  // costMaxNudgesPerHour = 2, so the third should hit the cap.
  for (let i = 0; i < 3; i++) {
    clock.advance(130000);
    await tickAndSettle(h, clock, 50);
  }

  const st = getState(h);
  const decs = st.decisions;
  const nudgeSent = countAction(decs, "nudge_sent");
  const capReached = countAction(decs, "cost_cap_reached");
  const cls = h.classifyCalls.length;

  check("D3: two nudge_sent", nudgeSent === 2);
  check("D3: one cost_cap_reached", capReached === 1);
  check("D3: classify called exactly twice", cls === 2);
}

// ============================================================
// AT4: Reader claim and tools
// ============================================================

// Helper: build a valid persona state for AU3 cases
function buildPersonaState(otherSid, now) {
  return {
    version: 4,
    persona: "default",
    activeSessionId: otherSid,
    epoch: 1,
    memory: [],
    goals: [],
    activeGoalId: null,
    monitor: {
      sessionStart: now,
      turnCount: 0,
      totalToolCalls: 0,
      errors: 0,
      lastTurnComplete: 0,
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
        // D5b: every prior buildPersonaState case took the "no active leaf"
        // branch (step 4), which returns before the idle-gate/classify code
        // that reads these. A case that reaches classify on an active node
        // (the D5b reask-suppression case) needs the full cost shape, so
        // it is seeded here rather than special-cased per test.
        consecutiveSkips: 0,
        nudgeWindow: { start: 0, count: 0 },
        callWindow: { start: 0, count: 0 },
        lastSummaryHash: 0,
        capNoticeWindowStart: 0,
      },
    },
    decisions: [],
  };
}

// Case 2: Owner refusal (agentic_say denied for owner)
async function caseAT4_owner_refusal(clock) {
  console.log("\n=== AT4: Owner refusal (agentic_say denied for owner) ===");
  clock.set(T0);

  const now = T0;

  // Create a fresh harness
  const h = await createTickHarness({
    ...OPTS,
    caseName: "at4_owner_refusal",
  });

  // Seed the persona store with this session as owner
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(SESSION_ID, now) }));

  // Re-fire session.start on the existing closure (h.handlers) so closure A
  // re-reads the seeded owner state (AY1).
  const startH = h.handlers["session.start"];
  if (startH) {
    await startH(h.fake, {}, () => {});
  }

  // Fire tool.call for agentic_say through the existing closure
  const toolCallH = h.handlers["tool.call"];
  const sayResult = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_say",
    text: "Hello, owner.",
  }, async (e) => ({ result: "passthrough" }));

  // Check that the result is a deny
  check("AT4 owner_refusal: deny response for owner", sayResult.deny !== undefined);

  // Check that no inbox key was written
  const storeKeys = [...h.storeMap.keys()];
  const inboxKeys = storeKeys.filter(k => k.startsWith("inbox:default:"));
  check("AT4 owner_refusal: no inbox: key written", inboxKeys.length === 0);
}

// Case 3: agentic_say refused for session without claim
async function caseAT4_say_refused(clock) {
  console.log("\n=== AT4: agentic_say refused for session without claim ===");
  clock.set(T0);

  const otherSid = "other-session-456";
  const now = T0;

  // Create a fresh harness
  const h = await createTickHarness({
    ...OPTS,
    caseName: "at4_say_refused",
  });

  // Seed the commons store with the other session owning the persona
  h.storeMap.set(`commons:${otherSid}`, {
    sessionId: otherSid,
    lastSeen: now,
    claims: [
      { resource: "persona:default", claimedAt: now - 1000 },
    ],
  });

  // Seed the persona store with the other session as owner
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(otherSid, now) }));

  // Seed the heartbeat sidecar with the other session as live holder
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: otherSid, epoch: 1, lastSeen: now },
  }));

  // Re-fire session.start on the existing closure (h.handlers) so closure A
  // re-reads the seeded reader state (AY1).
  const startH = h.handlers["session.start"];
  if (startH) {
    await startH(h.fake, {}, () => {});
  }

  // Remove the reader claim to simulate a session without a claim
  const myCommons = h.storeMap.get(`commons:${SESSION_ID}`);
  if (myCommons) {
    myCommons.claims = myCommons.claims.filter(c => c.resource !== "reader:default");
    h.storeMap.set(`commons:${SESSION_ID}`, myCommons);
  }

  // Fire tool.call for agentic_say through the existing closure
  const toolCallH = h.handlers["tool.call"];
  const sayResult = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_say",
    text: "Hello, owner.",
  }, async (e) => ({ result: "passthrough" }));

  // Check that the result is a deny
  check("AT4 say_refused: deny response for session without claim", sayResult.deny !== undefined);

  // Check that no inbox key was written
  const storeKeys = [...h.storeMap.keys()];
  const inboxKeys = storeKeys.filter(k => k.startsWith("inbox:default:"));
  check("AT4 say_refused: no inbox: key written", inboxKeys.length === 0);
}

// Case 4: Record shape and inbox
async function caseAT4_inbox_status(clock) {
  console.log("\n=== AT4: Record shape and inbox ===");
  clock.set(T0);

  const otherSid = "other-session-789";
  const mySid = SESSION_ID;
  const now = T0;

  // Create a fresh harness
  const h = await createTickHarness({
    ...OPTS,
    caseName: "at4_inbox_status",
  });

  // Seed the commons store with the other session owning the persona
  h.storeMap.set(`commons:${otherSid}`, {
    sessionId: otherSid,
    lastSeen: now,
    claims: [
      { resource: "persona:default", claimedAt: now - 1000 },
    ],
  });

  // Seed the persona store with the other session as owner
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(otherSid, now) }));

  // Seed the heartbeat sidecar with the other session as live holder
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: otherSid, epoch: 1, lastSeen: now },
  }));

  // Re-fire session.start on the existing closure (h.handlers) (AY1).
  const startH = h.handlers["session.start"];
  if (startH) {
    await startH(h.fake, {}, () => {});
  }

  // Write a fresh reader claim for this session (simulating a valid reader)
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [
      { resource: "reader:default", claimedAt: now },
    ],
  });

  // Seed the open ask that answers references (BD3: say verifies the ask id).
  h.storeMap.set("ask:default:ask-1", {
    id: "ask-1",
    ownerSessionId: otherSid,
    at: now - 5000,
    nodeId: "g",
    question: "test question",
    status: "open",
  });

  // Fire agentic_say with text and answers through the existing closure
  const toolCallH = h.handlers["tool.call"];
  const sayResult = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_say",
    text: "hello",
    answers: "ask-1",
  }, async (e) => ({ result: "passthrough" }));

  // Check that an inbox record was written
  const storeKeys = [...h.storeMap.keys()];
  const inboxKeys = storeKeys.filter(k => k.startsWith("inbox:default:"));
  check("AT4 inbox_status: inbox record written", inboxKeys.length === 1);

  // Check the record shape
  if (inboxKeys.length === 1) {
    const record = h.storeMap.get(inboxKeys[0]);
    check("AT4 inbox_status: record has id", record.id !== undefined);
    check("AT4 inbox_status: record has key", record.key !== undefined);
    check("AT4 inbox_status: record has from === mySid", record.from === mySid);
    check("AT4 inbox_status: record has at", record.at !== undefined);
    check("AT4 inbox_status: record has text === hello", record.text === "hello");
    check("AT4 inbox_status: record has status === pending", record.status === "pending");
  }

  // Fire agentic_inbox
  const inboxResult = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_inbox",
  }, async (e) => ({ result: "passthrough" }));

  // Check that the result is a success (not deny)
  check("AT4 inbox_status: agentic_inbox succeeds for reader", inboxResult.result !== undefined);

  // Parse the result and check the shape
  if (inboxResult.result) {
    const parsed = JSON.parse(inboxResult.result);
    check("AT4 inbox_status: inbox has 1 record", parsed.inbox.length === 1);
    check("AT4 inbox_status: no reply yet", parsed.inbox[0].reply === undefined);
  }

  // Write a reply into the fake store
  if (inboxKeys.length > 0) {
    const inboxRecord = h.storeMap.get(inboxKeys[0]);
    h.storeMap.set(`reply:default:${inboxRecord.id}`, {
      at: now + 1000,
      text: "I hear you.",
    });
  }

  // Fire agentic_inbox again
  const inboxResult2 = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_inbox",
  }, async (e) => ({ result: "passthrough" }));

  // Check that the reply is now present
  if (inboxResult2.result) {
    const parsed2 = JSON.parse(inboxResult2.result);
    check("AT4 inbox_status: reply present after owner reply", parsed2.inbox[0].reply === "I hear you.");
  }
}

// S2: D3 drain - one record per tick
async function caseS2_drain(clock) {
  console.log("\n=== S2: D3 drain (one record per tick) ===");
  clock.set(T0);

  const otherSid = "drain-sender-001";
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s2_drain",
  });

  // Seed the commons store: mySid owns the persona
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [
      { resource: "persona:default", claimedAt: now - 2000 },
    ],
  });
  // otherSid holds a live reader claim
  h.storeMap.set(`commons:${otherSid}`, {
    sessionId: otherSid,
    lastSeen: now,
    claims: [
      { resource: "reader:default", claimedAt: now - 1000 },
    ],
  });

  // Seed the persona store with mySid as owner
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(mySid, now) }));

  // Seed the heartbeat sidecar with mySid as live holder (so the session claims ownership)
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  // Seed two inbox records from otherSid (both pending)
  const rec1Key = `inbox:default:${otherSid}:1`;
  const rec2Key = `inbox:default:${otherSid}:2`;
  h.storeMap.set(rec1Key, {
    id: "drain-rec-1",
    key: rec1Key,
    from: otherSid,
    at: now - 5000,
    text: "First message",
    kind: "say",
    status: "pending",
  });
  h.storeMap.set(rec2Key, {
    id: "drain-rec-2",
    key: rec2Key,
    from: otherSid,
    at: now - 4000,
    text: "Second message",
    kind: "say",
    status: "pending",
  });

  // Re-fire session.start on the existing closure (h.handlers) (AY1).
  const startH = h.handlers["session.start"];
  if (startH) {
    await startH(h.fake, {}, () => {});
  }

  // Fire one tick (D3 should drain the oldest record only)
  await tickAndSettle(h, clock);

  // Check: rec1 should be delivered, rec2 should still be pending
  const rec1 = h.storeMap.get(rec1Key);
  const rec2 = h.storeMap.get(rec2Key);
  if (rec1 && rec2) {
    const parsed1 = typeof rec1 === "string" ? JSON.parse(rec1) : rec1;
    const parsed2 = typeof rec2 === "string" ? JSON.parse(rec2) : rec2;
    check("S2 drain: oldest record is delivered", parsed1.status === "delivered");
    check("S2 drain: second record still pending", parsed2.status === "pending");
  } else {
    check("S2 drain: oldest record is delivered", false);
    check("S2 drain: second record still pending", false);
  }

  // Check: prompt.submit was called once with [OPERATOR]
  const prompts = h.promptSubmits || [];
  const operatorPrompts = prompts.filter(p => p.startsWith("[OPERATOR]"));
  check("S2 drain: one [OPERATOR] prompt submitted", operatorPrompts.length === 1);
}

// S2: D3 drain in-flight control (turn in flight, nothing delivered)
async function caseS2_drain_inflight(clock) {
  console.log("\n=== S2: D3 drain in-flight (turn in flight, nothing delivered) ===");
  clock.set(T0);

  const otherSid = "drain-inflight-001";
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s2_drain_inflight",
  });

  // Seed the commons store: mySid owns the persona
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  // otherSid holds a live reader claim
  h.storeMap.set(`commons:${otherSid}`, {
    sessionId: otherSid,
    lastSeen: now,
    claims: [{ resource: "reader:default", claimedAt: now - 1000 }],
  });

  // Seed the persona store with mySid as owner.
  const personaState = buildPersonaState(mySid, now);
  // Being inside a turn is not a persisted field, so it cannot be seeded here.
  // The plugin holds the open turns in a module-local map keyed by turn id, and
  // the tick's in-flight check reads that map, so the only way to put this case
  // inside a turn is to fire a real turn.start and no matching turn.complete,
  // which is what the driver below does.
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  // Seed the heartbeat sidecar
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  // Seed one inbox record (pending)
  const recKey = `inbox:default:${otherSid}:1`;
  h.storeMap.set(recKey, {
    id: "inflight-rec-1",
    key: recKey,
    from: otherSid,
    at: now - 5000,
    text: "In-flight test",
    kind: "say",
    status: "pending",
  });

  // AY1: Re-fire session.start on the existing closure (h.handlers) so it re-reads the seeded state.
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // Check: sess.isOwner should be true (mySid has the persona:default claim)
  const stateAfterStart = getState(h);
  check("S2 drain in-flight: sess.isOwner is true after session.start", stateAfterStart.activeSessionId === mySid);

  // Fire turn.start (turn is now in flight) on the existing closure
  const turnStartH = h.handlers["turn.start"];
  let nextCalled = false;
  if (turnStartH) {
    await turnStartH(h.fake, { turnId: "t-inflight" }, async (e) => { nextCalled = true; return { result: "ok" }; });
  }
  check("S2 drain in-flight: turn.start handler called next()", nextCalled);

  // Fire tick (D3 should NOT drain because turn is in flight)
  await tickAndSettle(h, clock);

  // Check: record should still be pending (not delivered)
  const rec = h.storeMap.get(recKey);
  if (rec) {
    const parsed = typeof rec === "string" ? JSON.parse(rec) : rec;
    check("S2 drain in-flight: record still pending", parsed.status === "pending");
  } else {
    check("S2 drain in-flight: record still pending", false);
  }

  // Check: no [OPERATOR] prompt was submitted
  const prompts = h.promptSubmits || [];
  const operatorPrompts = prompts.filter(p => p.startsWith("[OPERATOR]"));
  check("S2 drain in-flight: no [OPERATOR] prompt submitted", operatorPrompts.length === 0);
}

// S2: D4 reply by turn id. An aborted or empty-answer turn leaves the record
// delivered with its stamp in place and no reply, and a later turn neither
// re-stamps it nor answers it: the record reads as unanswered until the TTL
// (Section 12 bullet 6, the retired abort re-stamp).
async function caseS2_reply_turnid(clock) {
  console.log("\n=== S2: D4 reply by turn id (an aborted turn leaves the record delivered and unanswered) ===");
  clock.set(T0);

  const otherSid = "reply-turnid-001";
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s2_reply_turnid",
  });

  // Seed the commons store
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  h.storeMap.set(`commons:${otherSid}`, {
    sessionId: otherSid,
    lastSeen: now,
    claims: [{ resource: "reader:default", claimedAt: now - 1000 }],
  });

  // Seed the persona store
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(mySid, now) }));

  // Seed the heartbeat sidecar
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  // Seed one inbox record (pending)
  const recKey = `inbox:default:${otherSid}:1`;
  h.storeMap.set(recKey, {
    id: "turnid-rec-1",
    key: recKey,
    from: otherSid,
    at: now - 5000,
    text: "TurnId test",
    kind: "say",
    status: "pending",
  });

  // Re-fire session.start on the existing closure (h.handlers) (AY1).
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // Fire tick (D3 drains the record)
  await tickAndSettle(h, clock);

  // Fire turn.start (AS3 stamps turnId)
  const turnId = "t-turnid-1";
  const turnStartH = h.handlers["turn.start"];
  if (turnStartH) await turnStartH(h.fake, { turnId: turnId }, () => {});

  // Fire turn.complete with empty answer: the record stays delivered with
  // its stamp, and the turn is recorded as unanswered.
  const turnCompleteH = h.handlers["turn.complete"];
  if (turnCompleteH) await turnCompleteH(h.fake, { turnId: turnId, answer: "", reason: "aborted" }, () => {});

  let rec = h.storeMap.get(recKey);
  if (rec) {
    const parsed = typeof rec === "string" ? JSON.parse(rec) : rec;
    check("S2 reply turnid: record still delivered after empty answer", parsed.status === "delivered");
    check("S2 reply turnid: turnId kept after empty answer", parsed.turnId === turnId);
  } else {
    check("S2 reply turnid: record still delivered after empty answer", false);
    check("S2 reply turnid: turnId kept after empty answer", false);
  }

  // Check: no reply written
  const replyKey = `reply:default:turnid-rec-1`;
  const reply = h.storeMap.get(replyKey);
  check("S2 reply turnid: no reply written for empty answer", !reply);
  check("S2 reply turnid: operator_turn_unanswered names the record", getDecisions(h).some(d => d.action === "operator_turn_unanswered" && d.detail.includes("turnid-rec-1")));

  // A later turn the plugin did not open for the record neither re-stamps
  // nor answers it.
  const turnId2 = "t-turnid-2";
  if (turnStartH) await turnStartH(h.fake, { turnId: turnId2 }, () => {});

  rec = h.storeMap.get(recKey);
  if (rec) {
    const parsed = typeof rec === "string" ? JSON.parse(rec) : rec;
    check("S2 reply turnid: second turn.start leaves the stamp alone", parsed.turnId === turnId);
  } else {
    check("S2 reply turnid: second turn.start leaves the stamp alone", false);
  }

  if (turnCompleteH) await turnCompleteH(h.fake, { turnId: turnId2, answer: "Real answer", reason: "completed" }, () => {});

  check("S2 reply turnid: no reply written on the second turn.complete", !h.storeMap.get(replyKey));

  rec = h.storeMap.get(recKey);
  if (rec) {
    const parsed = typeof rec === "string" ? JSON.parse(rec) : rec;
    check("S2 reply turnid: record still delivered after the second turn.complete", parsed.status === "delivered");
  } else {
    check("S2 reply turnid: record still delivered after the second turn.complete", false);
  }
}

// S2: D4 reply unrelated turn control (turn.complete with another id writes nothing)
async function caseS2_reply_unrelated(clock) {
  console.log("\n=== S2: D4 reply unrelated turn (another id writes nothing) ===");
  clock.set(T0);

  const otherSid = "reply-unrelated-001";
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s2_reply_unrelated",
  });

  // Seed the commons store
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  h.storeMap.set(`commons:${otherSid}`, {
    sessionId: otherSid,
    lastSeen: now,
    claims: [{ resource: "reader:default", claimedAt: now - 1000 }],
  });

  // Seed the persona store
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(mySid, now) }));

  // Seed the heartbeat sidecar
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  // Seed one inbox record (delivered, stamped with a specific turnId)
  const recKey = `inbox:default:${otherSid}:1`;
  const stampedTurnId = "t-stamped-1";
  h.storeMap.set(recKey, {
    id: "unrelated-rec-1",
    key: recKey,
    from: otherSid,
    at: now - 5000,
    text: "Unrelated test",
    kind: "say",
    status: "delivered",
    deliveredAt: now - 4000,
    turnId: stampedTurnId,
  });

  // Re-fire session.start on the existing closure (h.handlers) (AY1).
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // Fire turn.complete with a DIFFERENT turnId
  const turnCompleteH = h.handlers["turn.complete"];
  if (turnCompleteH) await turnCompleteH(h.fake, { turnId: "t-different-999", answer: "Should not match", reason: "completed" }, () => {});

  // Check: no reply written
  const replyKey = `reply:default:unrelated-rec-1`;
  const reply = h.storeMap.get(replyKey);
  check("S2 reply unrelated: no reply written for mismatched turnId", !reply);

  // Check: record still delivered (not answered)
  const rec = h.storeMap.get(recKey);
  if (rec) {
    const parsed = typeof rec === "string" ? JSON.parse(rec) : rec;
    check("S2 reply unrelated: record still delivered", parsed.status === "delivered");
  } else {
    check("S2 reply unrelated: record still delivered", false);
  }
}

// ============================================================
// S3: AZ2 - no walk-on while ask is open (ask_waiting once, classify not called)
// ============================================================
async function caseS3_no_walk_while_open(clock) {
  console.log("\n=== S3: no walk-on while ask is open ===");
  clock.set(T0);

  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s3_no_walk_while_open",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // Seed persona store: active goal + pending goal + open ask
  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "node-001", kind: "leaf", objective: "Goal 1", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
    { id: "node-002", kind: "leaf", objective: "Goal 2", status: "pending", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 9000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.pendingAskId = "ask-no-walk-1";
  personaState.monitor.turnCount = 5;
  personaState.monitor.lastTurnComplete = now - 120_000; // idle past nudgeIdleMs
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  // Re-fire session.start to pick up seeded state.
  // BD3: owner-start expires open asks, so seed the ask AFTER the start.
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // Seed an open ask record (after session.start, so it survives BD3 expiration)
  const askKey = "ask:default:ask-no-walk-1";
  h.storeMap.set(askKey, {
    id: "ask-no-walk-1",
    key: askKey,
    persona: "default",
    askId: "ask-no-walk-1",
    at: now - 1000,
    nodeId: "node-001",
    question: "What should we do?",
    status: "open",
  });

  h.resetClassifyCalls();

  // Fire 3 ticks; ask is open, so classify should NOT be called
  clock.advance(65_000);
  await tickAndSettle(h, clock, 20);
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);

  const state = getState(h);

  // Check: node-002 should still be pending (not activated)
  const node2 = state.goals.find(g => g.id === "node-002");
  check("S3 no-walk: node-002 still pending after 3 ticks", node2 && node2.status === "pending");

  // Check: classify was never called
  check("S3 no-walk: classify not called", h.classifyCalls.length === 0);

  // Check: ask_waiting appears at least once in decisions
  const decisions = state.decisions || [];
  const askWaitingCount = decisions.filter(d => d.action === "ask_waiting").length;
  check("S3 no-walk: ask_waiting appears at least once", askWaitingCount >= 1);
}

// ============================================================
// S3: AZ2 - answer reactivates the paused goal
// ============================================================
async function caseS3_answer_reactivates(clock) {
  console.log("\n=== S3: answer reactivates paused goal ===");
  clock.set(T0);

  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s3_answer_reactivates",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // Seed persona store: paused goal + open ask
  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "node-001", kind: "leaf", objective: "Goal 1", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.pendingAskId = "ask-answer-1";
  personaState.monitor.turnCount = 5;
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  // Seed an inbox answer record with answers === askId, from a session with a live reader claim
  const answerWriter = "answer-writer-session";
  const inboxKey = `inbox:default:${answerWriter}:1`;
  h.storeMap.set(inboxKey, {
    id: "default-answer-writer-session-1",
    key: inboxKey,
    from: answerWriter,
    at: now - 500,
    text: "Please continue with the fix.",
    kind: "answer",
    answers: "ask-answer-1",
    status: "pending",
  });

  // Seed reader claim for the answer writer session
  h.storeMap.set(`commons:${answerWriter}`, {
    sessionId: answerWriter,
    lastSeen: now - 100,
    claims: [{ resource: "reader:default", claimedAt: now - 2000 }],
  });

  // Re-fire session.start
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // Seed the open ask AFTER session.start (BD3: owner-start expires prior asks)
  const askKey = "ask:default:ask-answer-1";
  h.storeMap.set(askKey, {
    id: "ask-answer-1",
    key: askKey,
    persona: "default",
    askId: "ask-answer-1",
    at: now - 1000,
    nodeId: "node-001",
    question: "What should we do?",
    status: "open",
  });

  h.resetPromptSubmits();

  // Fire tick - should detect the answer, close the ask, and reactivate
  clock.advance(65_000);
  await tickAndSettle(h, clock, 50);

  const state = getState(h);

  // Check: the goal should be reactivated (paused -> active)
  const node1 = state.goals.find(g => g.id === "node-001");
  check("S3 answer-react: goal reactivated to active", node1 && node1.status === "active");

  // Check: pendingAskId cleared
  check("S3 answer-react: pendingAskId cleared", !state.pendingAskId);

  // Check: ask_answered action present
  const decisions = state.decisions || [];
  check("S3 answer-react: ask_answered action present", decisions.some(d => d.action === "ask_answered"));

  // Check: [OPERATOR] prompt submitted
  check("S3 answer-react: [OPERATOR] prompt submitted", h.promptSubmits.some(t => t.includes("[OPERATOR]")));
}

// ============================================================
// S3: AZ2 - say leaves ask open (answer without reader claim is skipped)
// ============================================================
async function caseS3_say_leaves_ask_open(clock) {
  console.log("\n=== S3: say without reader claim leaves ask open ===");
  clock.set(T0);

  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s3_say_leaves_ask_open",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // Seed persona store: paused goal + open ask
  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "node-001", kind: "leaf", objective: "Goal 1", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.pendingAskId = "ask-say-1";
  personaState.monitor.turnCount = 5;
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  // Seed an inbox record with answers === askId but NO reader claim for the writer
  const sayWriter = "say-writer-session";
  const inboxKey = `inbox:default:${sayWriter}:1`;
  h.storeMap.set(inboxKey, {
    id: "default-say-writer-session-1",
    key: inboxKey,
    from: sayWriter,
    at: now - 500,
    text: "Just a say, not an answer.",
    kind: "say",
    answers: "ask-say-1",
    status: "pending",
  });

  // NO reader claim for sayWriter (intentionally omitted)

  // Re-fire session.start
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // Seed the open ask AFTER session.start (BD3: owner-start expires prior asks)
  const askKey = "ask:default:ask-say-1";
  h.storeMap.set(askKey, {
    id: "ask-say-1",
    key: askKey,
    persona: "default",
    askId: "ask-say-1",
    at: now - 1000,
    nodeId: "node-001",
    question: "What should we do?",
    status: "open",
  });

  // Fire tick
  clock.advance(65_000);
  await tickAndSettle(h, clock, 50);

  const state = getState(h);

  // Check: the ask should still be open (not closed by say)
  const askRecord = h.storeMap.get("ask:default:ask-say-1");
  check("S3 say-leaves: ask still open", askRecord && askRecord.status === "open");

  // Check: pendingAskId still set
  check("S3 say-leaves: pendingAskId still set", state.pendingAskId === "ask-say-1");

  // Check: the goal is still paused
  const node1 = state.goals.find(g => g.id === "node-001");
  check("S3 say-leaves: goal still paused", node1 && node1.status === "paused");
}

// ============================================================
// S3: AZ2 - timeout walks on (ask expires, next goal activated)
// ============================================================
async function caseS3_timeout_walks_on(clock) {
  console.log("\n=== S3: timeout expires ask and walks on ===");
  clock.set(T0);

  const mySid = SESSION_ID;
  const now = T0;

  // Override askOperatorWaitMs to 60000 for this case
  const h = await createTickHarness({
    ...OPTS,
    askOperatorWaitMs: 60_000,
    caseName: "s3_timeout_walks_on",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // Seed persona store: root + paused goal + pending goal + open ask
  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "root", kind: "goal", parentId: null, objective: "Root plan", status: "active", completedRounds: 0, maxRounds: 10, scores: [], createdAt: now - 11000, updatedAt: now - 5000, children: ["node-001", "node-002"] },
    { id: "node-001", kind: "leaf", parentId: "root", objective: "Goal 1", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
    { id: "node-002", kind: "leaf", parentId: "root", objective: "Goal 2", status: "pending", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 9000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.pendingAskId = "ask-timeout-1";
  personaState.monitor.turnCount = 5;
  personaState.monitor.lastTurnComplete = now - 120_000;
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  // Re-fire session.start
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // Seed an open ask record AFTER session.start (BD3: owner-start expires prior asks).
  // at = T0, so 61s later it will have elapsed 61s > 60s wait.
  const askKey = "ask:default:ask-timeout-1";
  h.storeMap.set(askKey, {
    id: "ask-timeout-1",
    key: askKey,
    persona: "default",
    askId: "ask-timeout-1",
    at: now,
    nodeId: "node-001",
    question: "What should we do?",
    status: "open",
  });

  // Advance 61 seconds past T0 (past the 60s wait)
  clock.advance(61_000);
  await tickAndSettle(h, clock, 50);

  const state = getState(h);

  // Check: ask record status is "expired"
  const askRecord = h.storeMap.get("ask:default:ask-timeout-1");
  check("S3 timeout: ask status is expired", askRecord && askRecord.status === "expired");

  // Check: pendingAskId is undefined
  check("S3 timeout: pendingAskId cleared", !state.pendingAskId);

  // Check: ask_timeout action present
  const decisions = state.decisions || [];
  check("S3 timeout: ask_timeout action present", decisions.some(d => d.action === "ask_timeout"));

  // Check: node-002 activated (walked on)
  const node2 = state.goals.find(g => g.id === "node-002");
  check("S3 timeout: node-002 activated", node2 && node2.status === "active");
}

// S3: askOperatorWaitMs default fires with no option set (Round 34). Whether
// the harness engine fills plugin.json's userConfig default into `cfg` is
// not established anywhere in this repo, so the code fallback must resolve
// an absent option to a real wait on its own. Mirrors caseS3_timeout_walks_on
// exactly (that case is this one's control: option set to a small value
// fires there), but OPTS carries no askOperatorWaitMs, and the clock
// advances past the 60-minute code default instead of a configured 60s.
async function caseS3_timeout_walks_on_default(clock) {
  console.log("\n=== S3: timeout expires ask at the no-option-set default ===");
  clock.set(T0);

  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s3_timeout_walks_on_default",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "root", kind: "goal", parentId: null, objective: "Root plan", status: "active", completedRounds: 0, maxRounds: 10, scores: [], createdAt: now - 11000, updatedAt: now - 5000, children: ["node-001", "node-002"] },
    { id: "node-001", kind: "leaf", parentId: "root", objective: "Goal 1", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
    { id: "node-002", kind: "leaf", parentId: "root", objective: "Goal 2", status: "pending", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 9000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.pendingAskId = "ask-timeout-default-1";
  personaState.monitor.turnCount = 5;
  personaState.monitor.lastTurnComplete = now - 120_000;
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  const askKey = "ask:default:ask-timeout-default-1";
  h.storeMap.set(askKey, {
    id: "ask-timeout-default-1",
    key: askKey,
    persona: "default",
    askId: "ask-timeout-default-1",
    at: now,
    nodeId: "node-001",
    question: "What should we do?",
    status: "open",
  });

  // Advance 1 hour and 1 second: past the 3_600_000ms code default, not past
  // any value a configured option would have set.
  clock.advance(3_601_000);
  await tickAndSettle(h, clock, 50);

  const state = getState(h);

  const askRecord = h.storeMap.get(askKey);
  check("S3 timeout default: ask status is expired", askRecord && askRecord.status === "expired");
}

// Item 8.2 (Round 36 case a): a classifier ask-operator decision converts to
// a nudge unconditionally, before the reason call even runs - not on a
// keyword match against the reason text. Proof: the reason is set to today's
// real eighteenth-ask text verbatim ("Blocked on reader claim mechanism..."),
// which matches no keyword list (that's exactly why the keyword-based draft
// missed it), and conversion still happens.
async function caseItem8p2_classifier_ask_operator_converts_unconditionally(clock) {
  console.log("\n=== Item 8.2(a): classifier ask-operator converts to nudge unconditionally ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item8p2a_unconditional",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "root", kind: "goal", parentId: null, objective: "Root plan", status: "active", completedRounds: 0, maxRounds: 10, scores: [], createdAt: now - 11000, updatedAt: now - 5000, children: ["node-001"] },
    { id: "node-001", kind: "leaf", parentId: "root", objective: "Some task", status: "active", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.monitor.turnCount = 5;
  personaState.monitor.lastTurnComplete = now - 120_000;
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  h.setClassifyValue("ask-operator");
  // Today's real ask text, verbatim - matches no keyword pattern.
  h.fake.model.complete = async () =>
    "Blocked on reader claim mechanism, systemic issue preventing task progress despite repeated attempts";

  // Two ticks: the first clears the transitional re-activation the reseeded
  // session.start produces, the second reaches classify.
  clock.advance(130_000);
  await tickAndSettle(h, clock, 50);
  clock.advance(130_000);
  await tickAndSettle(h, clock, 50);

  const decisions = getDecisions(h);
  check("item8p2a: classify was called", h.classifyCalls.length > 0);

  const askKeys = [...h.storeMap.keys()].filter(k => k.startsWith("ask:"));
  check("item8p2a: no ask record written", askKeys.length === 0);

  const conversionCount = decisions.filter(d => d.action === "ask_idle_gap_converted").length;
  check("item8p2a: ask_idle_gap_converted decision present", conversionCount >= 1);

  const nudgeCount = decisions.filter(d => d.action === "nudge_sent").length;
  check("item8p2a: nudge_sent decision present", nudgeCount >= 1);

  check("item8p2a: nudge carries the ASK marker instruction", h.promptSubmits.some(t => t.includes("ASK: <question>? Recommend: <choice>")));
}

// Item 8.2 (Round 39 case a2): the classifier's "pause" verdict converts
// exactly like "ask-operator" - the nineteenth ask that day arrived through
// "pause" specifically, proving the classifier-prose problem was never
// limited to one verdict. Proof uses that ask's own text verbatim.
async function caseItem8p2_pause_converts_unconditionally(clock) {
  console.log("\n=== Item 8.2(a2): classifier pause converts to nudge unconditionally ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item8p2a2_pause_unconditional",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "root", kind: "goal", parentId: null, objective: "Root plan", status: "active", completedRounds: 0, maxRounds: 10, scores: [], createdAt: now - 11000, updatedAt: now - 5000, children: ["node-001"] },
    { id: "node-001", kind: "leaf", parentId: "root", objective: "Some task", status: "active", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.monitor.turnCount = 5;
  personaState.monitor.lastTurnComplete = now - 120_000;
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  h.setClassifyValue("pause");
  // Today's real pause-triggered ask text, verbatim.
  h.fake.model.complete = async () =>
    "Repeated off-goal-by-instruction scores and operator-skipped decisions indicate systemic blocker requiring root-cause investigation before proce";

  clock.advance(130_000);
  await tickAndSettle(h, clock, 50);
  clock.advance(130_000);
  await tickAndSettle(h, clock, 50);

  const decisions = getDecisions(h);
  const askKeys = [...h.storeMap.keys()].filter(k => k.startsWith("ask:"));
  check("item8p2a2: no ask record written", askKeys.length === 0);

  const conversionCount = decisions.filter(d => d.action === "ask_idle_gap_converted").length;
  check("item8p2a2: ask_idle_gap_converted decision present", conversionCount >= 1);

  const nudgeCount = decisions.filter(d => d.action === "nudge_sent").length;
  check("item8p2a2: nudge_sent decision present", nudgeCount >= 1);
}

// Item 8.2 (Round 36 case b): an ask record opens only when the worker's own
// completed turn states a real fork as the literal marker line; the stored
// question is that line, not anything the classifier produced.
async function caseItem8p2_worker_states_fork_opens_ask(clock) {
  console.log("\n=== Item 8.2(b): worker's ASK marker line opens an ask record ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item8p2b_worker_states_fork",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "root", kind: "goal", parentId: null, objective: "Root plan", status: "active", completedRounds: 0, maxRounds: 10, scores: [], createdAt: now - 11000, updatedAt: now - 5000, children: ["node-001"] },
    { id: "node-001", kind: "leaf", parentId: "root", objective: "Some task", status: "active", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // session.start's reload resets a reseeded "active" leaf to "pending" and
  // relies on the next controller tick to re-activate it (the same
  // transitional step every reseed-then-refire case in this file needs
  // before classify) - one tick here re-activates node-001 before the turn.
  clock.advance(1000);
  await tickAndSettle(h, clock, 50);

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-fork" }, async () => ({ result: "ok" }));

  const turnCompleteH = h.handlers["turn.complete"];
  const markerLine = "ASK: Should we migrate to the new store format now? Recommend: yes, before the next release.";
  await turnCompleteH(h.fake, {
    turnId: "t-fork",
    answer: `Here is my status update.\n${markerLine}`,
    reason: "completed",
  }, async () => ({ result: "ok" }));

  const state = getState(h);
  const askKeys = [...h.storeMap.keys()].filter(k => k.startsWith("ask:"));
  check("item8p2b: exactly one ask record written", askKeys.length === 1);

  const askRecord = askKeys.length === 1 ? h.storeMap.get(askKeys[0]) : null;
  check(
    "item8p2b: ask question is the worker's own marker line",
    !!askRecord && askRecord.question === markerLine.replace(/^ASK:\s*/, ""),
  );

  check("item8p2b: pendingAskId is set", !!state.pendingAskId);

  const node1 = state.goals.find(g => g.id === "node-001");
  check("item8p2b: active goal paused", node1 && node1.status === "paused");
}

// Item 8.2 (Round 39): a marker match that still carries the literal
// template's angle-bracket placeholders is refused, not opened as an ask -
// a worker that copies the nudge instruction verbatim without filling it in
// has not stated a fork.
async function caseItem8p2_placeholder_marker_refused(clock) {
  console.log("\n=== Item 8.2: ASK marker with unfilled placeholders is refused ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item8p2_placeholder_refused",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "root", kind: "goal", parentId: null, objective: "Root plan", status: "active", completedRounds: 0, maxRounds: 10, scores: [], createdAt: now - 11000, updatedAt: now - 5000, children: ["node-001"] },
    { id: "node-001", kind: "leaf", parentId: "root", objective: "Some task", status: "active", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));

  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  clock.advance(1000);
  await tickAndSettle(h, clock, 50);

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-placeholder" }, async () => ({ result: "ok" }));

  const turnCompleteH = h.handlers["turn.complete"];
  await turnCompleteH(h.fake, {
    turnId: "t-placeholder",
    answer: "ASK: <question>? Recommend: <choice>",
    reason: "completed",
  }, async () => ({ result: "ok" }));

  const state = getState(h);
  const askKeys = [...h.storeMap.keys()].filter(k => k.startsWith("ask:"));
  check("item8p2 placeholder: no ask record written", askKeys.length === 0);

  const decisions = state.decisions || [];
  check("item8p2 placeholder: ask_marker_placeholder_refused decision present", decisions.some(d => d.action === "ask_marker_placeholder_refused"));

  const node1 = state.goals.find(g => g.id === "node-001");
  check("item8p2 placeholder: node stays active (not paused)", node1 && node1.status === "active");
}

// Item 8.2 (Round 36 case c, plan bullet's memory half): a self-review
// lesson about the worker scoring its own confusion is refused as a memory;
// a lesson grounded in a passed test or an operator correction is kept.
// Both shapes exercised here, one harness run per shape.
async function caseItem8p2_memory_quality_self_scoring_vs_proof_backed(clock) {
  console.log("\n=== Item 8.2(c): self-scoring lesson refused, proof-backed lesson kept ===");

  const selfScoringLesson = "The worker was repeatedly unclear and kept scoring its own confusion instead of asking a real question.";
  const proofBackedLesson = "The test suite confirmed the fix: askOperatorWaitMs now defaults to 60 minutes, verified by a passing harness case.";

  async function runSelfReview(lessonText, caseName) {
    clock.set(T0);
    const rootGoal = {
      id: "root-goal", parentId: null, kind: "root", title: "Test goal", objective: "Test goal",
      status: "pending", source: "controller", maxRounds: 10, completedRounds: 0, scores: [], notes: [],
      planningRounds: 0, consecutiveBlockedPlannings: 0, consecutivePlanningFailures: 0, planningRound: 0,
      createdAt: T0 - 10000, updatedAt: T0 - 5000,
    };
    const h = await createTickHarness({
      ...OPTS,
      caseName,
      stateOpts: {
        now: T0,
        goals: [rootGoal],
        activeGoalId: null,
        selfReview: { count: 0, lastAt: 0, turnsSince: 0, windowStart: 0, pendingPeriodic: true, lastInjectAt: 0 },
      },
      classifyValue: "NONE",
    });
    h.fake.model.complete = async () => lessonText;
    await tickAndSettle(h, clock, 100);
    return getDecisions(h);
  }

  const refusedDecisions = await runSelfReview(selfScoringLesson, "item8p2c_self_scoring");
  check("item8p2c: self-scoring lesson refused (memory_lesson_refused)", refusedDecisions.some(d => d.action === "memory_lesson_refused"));
  check("item8p2c: self-scoring lesson NOT kept as memory (no self-review decision)", !refusedDecisions.some(d => d.action === "self-review"));

  const keptDecisions = await runSelfReview(proofBackedLesson, "item8p2c_proof_backed");
  check("item8p2c: proof-backed lesson kept (self-review decision present)", keptDecisions.some(d => d.action === "self-review"));
  check("item8p2c: proof-backed lesson NOT refused", !keptDecisions.some(d => d.action === "memory_lesson_refused"));
}

// Round 32/36 point 4: a dead writer's pending inbox record is marked
// skipped once, not re-logged every tick forever.
async function caseItem8p2_dead_writer_record_skipped_once(clock) {
  console.log("\n=== Item 8.2 point 4: dead writer's record skipped once, not every tick ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item8p2_dead_writer_skip",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const deadWriter = "dead-writer-session";
  const inboxKey = `inbox:default:${deadWriter}:1`;
  h.storeMap.set(inboxKey, {
    id: `default-${deadWriter}-1`,
    key: inboxKey,
    from: deadWriter,
    at: now - 5000,
    text: "stale message from a dead session",
    kind: "message",
    status: "pending",
  });
  // No commons entry for deadWriter: no live reader claim.

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  clock.advance(15_000);
  await tickAndSettle(h, clock, 50);
  clock.advance(15_000);
  await tickAndSettle(h, clock, 50);
  clock.advance(15_000);
  await tickAndSettle(h, clock, 50);

  const decisions = getDecisions(h);
  const skipDecisions = decisions.filter(d => d.action === "operator_skipped_no_claim" && d.detail.includes(deadWriter));
  check("item8p2 point4: skipped exactly once across three ticks", skipDecisions.length === 1);

  const record = h.storeMap.get(inboxKey);
  check("item8p2 point4: record status is skipped", record && record.status === "skipped");
}

// Item 5 (Bounded store): the shared commons store rolls closed inbox/reply
// records past its window to the append-only channel log. Proof per the
// plan's own line: send more records than the window holds, find the store
// at the window size and the log holding the rest.
async function caseItem5_channelWindowRollsOverflow(clock) {
  console.log("\n=== Item 5: channel window rolls overflow to the log ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item5_channel_window",
    channelRecordWindow: 3,
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // Seed 6 closed inbox records (resolved, the state the window rolls) -
  // twice the window of 3 - plus one open ask, which the window must never
  // touch. A delivered or answered record staying put is the Section 12
  // bullet 5 case.
  for (let i = 0; i < 6; i++) {
    const key = `inbox:default:writer-${i}:1`;
    h.storeMap.set(key, {
      id: `default-writer-${i}-1`,
      key,
      from: `writer-${i}`,
      at: now - (6 - i) * 1000,
      text: `message ${i}`,
      kind: "say",
      status: "resolved",
      resolvedAt: now - (6 - i) * 1000 + 500,
      outcome: "done",
      note: "",
    });
  }
  const openAskKey = "ask:default:ask-open-1";
  h.storeMap.set(openAskKey, {
    id: "ask-open-1",
    key: openAskKey,
    persona: "default",
    at: now - 500,
    nodeId: "node-001",
    question: "still open",
    status: "open",
  });

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // costSummaryEveryNTicks is 2 in OPTS; two ticks reach the sweep cadence.
  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);
  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);

  const remainingInbox = [...h.storeMap.keys()].filter(k => k.startsWith("inbox:default:"));
  check("item5 channel window: store holds exactly the window size", remainingInbox.length === 3);

  check("item5 channel window: the open ask is untouched", h.storeMap.has(openAskKey));

  const decisions = getDecisions(h);
  check("item5 channel window: channel_window_rolled decision present", decisions.some(d => d.action === "channel_window_rolled"));

  const logRaw = h.fsMap.get(".agentic-channel.jsonl") || "";
  const logLines = logRaw.split("\n").filter(l => l.trim().length > 0);
  check("item5 channel window: log holds the rolled records", logLines.length === 3);
  check("item5 channel window: log entries are valid JSON with kind=inbox", logLines.every(l => { try { return JSON.parse(l).kind === "inbox"; } catch { return false; } }));
}

// Item 5 / Round 47 finding 1: a failed append must not lose records - the
// store keys stay put when the log write throws. Direct unit test of
// enforceChannelWindow against a minimal in-memory store, no tick harness
// needed since the function is pure. Control: the same setup with a
// succeeding append rolls normally (mirrors caseItem5_channelWindowRollsOverflow
// above, restated here so the two cases sit side by side).
function makeMiniStore(seed) {
  const map = new Map(Object.entries(seed));
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async keys() { return [...map.keys()]; },
    _map: map,
  };
}

async function caseItem5_channelWindowNoDeleteOnAppendFailure() {
  console.log("\n=== Item 5: enforceChannelWindow deletes nothing when the append throws ===");

  // Dynamic import (matching the pattern the rest of this file uses for
  // hooks/*.ts) rather than a static top-level import: a static import of
  // operator.ts's own extensionless sibling imports (e.g. "./commons")
  // does not resolve under plain Node ESM the way the dynamic-import path
  // the harness already relies on does.
  const { enforceChannelWindow } = await import("../hooks/operator.ts?case=item5_direct_unit");

  const seed = {};
  for (let i = 0; i < 6; i++) {
    const key = `inbox:default:writer-${i}:1`;
    seed[key] = { id: `default-writer-${i}-1`, key, from: `writer-${i}`, at: 1000 + i, text: `m${i}`, kind: "say", status: "resolved", resolvedAt: 1500 + i, outcome: "done", note: "" };
  }

  // Failing case: appendLines always throws. Round 50 point 3: enforceChannelWindow
  // now lets the error propagate instead of swallowing it and returning 0 - the
  // caller (index.ts) is what turns "nothing to roll" and "roll refused" into two
  // different decisions, and a thrown error is exactly the signal it needs.
  const failStore = makeMiniStore(seed);
  let threw = false;
  try {
    await enforceChannelWindow(failStore, "default", 3, async () => { throw new Error("write failed"); });
  } catch (err) {
    threw = err instanceof Error && err.message === "write failed";
  }
  check("item5 append-fails: enforceChannelWindow throws instead of swallowing", threw);
  check("item5 append-fails: all 6 records remain in the store", failStore._map.size === 6);

  // Control: the same setup with a succeeding append rolls exactly the overflow.
  const okStore = makeMiniStore(seed);
  const appended = [];
  const okRolled = await enforceChannelWindow(okStore, "default", 3, async (lines) => { appended.push(...lines); });
  check("item5 append-succeeds (control): enforceChannelWindow returns 3", okRolled === 3);
  check("item5 append-succeeds (control): store holds exactly the window size", okStore._map.size === 3);
  check("item5 append-succeeds (control): appendLines received the 3 rolled lines", appended.length === 3);
}

// Item 5 (Bounded store): the persona file's decision log is capped at push
// time (persist()), not only when the file is parsed at a session load - a
// long-lived child never reloads. Proof per the plan's own line: push more
// decisions than the cap in a single session, find the file at the cap
// with the overflow in the log.
async function caseItem5_decisionLogCappedAtPush(clock) {
  console.log("\n=== Item 5: decision log capped at push, overflow rolled to the log ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item5_decision_cap",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // Seed exactly DECISIONS_MAX decisions - at the cap, not over it, so
  // the load itself does not trip parseState's own separate (silent,
  // load-time only) trim. The overflow this case proves is one that
  // accumulates from live, in-session growth with no reload in between -
  // the real shape of "a long-lived child never reloads" - not one that
  // parseState's read-time cap would have already caught.
  const personaState = buildPersonaState(mySid, now);
  const seeded = [];
  for (let i = 0; i < DECISIONS_MAX; i++) {
    seeded.push({ timestamp: now - (DECISIONS_MAX - i) * 1000, loop: "monitor", action: "seed", detail: `seed-${i}` });
  }
  personaState.decisions = seeded;
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: mySid, epoch: 1, lastSeen: now } }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // Ten ticks, each pushing at least one decision (idle/env/cost-summary
  // logging) with no reload in between - live growth past the cap, the
  // shape a long-lived child actually produces.
  for (let i = 0; i < 10; i++) {
    clock.advance(60_000);
    await tickAndSettle(h, clock, 50);
  }

  const state = getState(h);
  check("item5 decision cap: decisions capped at DECISIONS_MAX", state.decisions.length === DECISIONS_MAX);

  const logRaw = h.fsMap.get(".agentic-channel.jsonl") || "";
  const logLines = logRaw.split("\n").filter(l => l.trim().length > 0);
  const decisionLines = logLines.filter(l => { try { return JSON.parse(l).kind === "decision"; } catch { return false; } });
  check("item5 decision cap: overflow rolled to the log", decisionLines.length >= 1);

  // The oldest seeded entries are the ones that rolled off first; the
  // newest seeded entry survives.
  check("item5 decision cap: newest seeded entry survives", state.decisions.some(d => d.detail === `seed-${DECISIONS_MAX - 1}`));
  check("item5 decision cap: oldest seeded entry rolled off", !state.decisions.some(d => d.detail === "seed-0"));
}

// Item 5 (Bounded store): memory is capped at push time too (MEMORY_MAX),
// oldest unpinned entries roll to the log first; a pinned entry is the
// control - it never rolls off regardless of the cap.
async function caseItem5_memoryCappedAtPush(clock) {
  console.log("\n=== Item 5: memory capped at push, pinned entry survives ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item5_memory_cap",
  });

  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // Seed MEMORY_MAX unpinned entries plus one pinned entry, older than
  // all of them - the control that must survive every roll.
  const personaState = buildPersonaState(mySid, now);
  const seededMemory = [{
    id: "mem-pinned", kind: "lesson", text: "pinned lesson", confidence: 0.9,
    source: "worker", createdAt: now - 100_000, lastAccessed: now - 100_000, accessCount: 0, pinned: true,
  }];
  for (let i = 0; i < MEMORY_MAX; i++) {
    seededMemory.push({
      id: `mem-${i}`, kind: "fact", text: `fact ${i}`, confidence: 0.5,
      source: "worker", createdAt: now - (MEMORY_MAX - i) * 1000, lastAccessed: now, accessCount: 0, pinned: false,
    });
  }
  personaState.memory = seededMemory;
  personaState.updatedAt = now;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: mySid, epoch: 1, lastSeen: now } }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);

  const state = getState(h);
  check("item5 memory cap: memory capped at MEMORY_MAX", state.memory.length === MEMORY_MAX);
  check("item5 memory cap: pinned entry survives", state.memory.some(m => m.id === "mem-pinned"));
  check("item5 memory cap: newest unpinned entry survives", state.memory.some(m => m.id === `mem-${MEMORY_MAX - 1}`));
  check("item5 memory cap: oldest unpinned entry rolled off", !state.memory.some(m => m.id === "mem-0"));

  const logRaw = h.fsMap.get(".agentic-channel.jsonl") || "";
  const logLines = logRaw.split("\n").filter(l => l.trim().length > 0);
  const memoryLines = logLines.filter(l => { try { return JSON.parse(l).kind === "memory"; } catch { return false; } });
  check("item5 memory cap: overflow rolled to the log", memoryLines.length >= 1);
}

// S4: D6 doorbell - peer consumed
async function caseS4_peer_consumed(clock) {
  console.log("\n=== S4: peer consumed ===");
  clock.set(T0);

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s4_peer_consumed",
  });

  const hnd = h.handlers["session.receive"];

  let nextCalled = false;
  let nextArg = null;
  const next = (e) => {
    nextCalled = true;
    nextArg = e;
    return { passed: true };
  };

  // BH1: engine passes origin as an object with .kind
  const e = { origin: { kind: "peer" }, text: "do this now" };
  const result = await hnd(h.fake, e, next);

  check("S4 peer consumed: next was NOT called", !nextCalled);
  check("S4 peer consumed: result has consumed", result && result.consumed !== undefined);

  const state = getState(h);
  const peerDecisions = (state.decisions || []).filter(d => d.action === "peer_consumed");
  check("S4 peer consumed: peer_consumed pushed once", peerDecisions.length === 1);
  check("S4 peer consumed: detail contains text", peerDecisions.length === 1 && peerDecisions[0].detail.includes("do this now"));
}

// S4: D6 doorbell - peer-send-message consumed
async function caseS4_peer_send_message_consumed(clock) {
  console.log("\n=== S4: peer-send-message consumed ===");
  clock.set(T0);

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s4_peer_send_message",
  });

  const hnd = h.handlers["session.receive"];

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
    return { passed: true };
  };

  // BH1: engine passes origin as an object with .kind
  const e = { origin: { kind: "peer-send-message" }, text: "stop working" };
  const result = await hnd(h.fake, e, next);

  check("S4 ps-m consumed: next was NOT called", !nextCalled);
  check("S4 ps-m consumed: result has consumed", result && result.consumed !== undefined);
}

// S4: D6 doorbell - other origin passes through (control)
async function caseS4_other_origin_passes(clock) {
  console.log("\n=== S4: other origin passes (control) ===");
  clock.set(T0);

  const h = await createTickHarness({
    ...OPTS,
    caseName: "s4_other_origin",
  });

  const hnd = h.handlers["session.receive"];

  // BH1: engine passes origin as an object with .kind
  // Test origin: { kind: "bridge" }
  let nextCalled1 = false;
  let nextArg1 = null;
  const e1 = { origin: { kind: "bridge" }, text: "bridge message" };
  const result1 = await hnd(h.fake, e1, (e) => {
    nextCalled1 = true;
    nextArg1 = e;
    return { bridge: true };
  });

  check("S4 other origin: bridge - next was called", nextCalled1);
  check("S4 other origin: bridge - next received e unchanged", nextArg1 === e1);
  check("S4 other origin: bridge - result has NO consumed", !result1 || result1.consumed === undefined);

  // Test origin: { kind: "task-notification" }
  let nextCalled2 = false;
  let nextArg2 = null;
  const e2 = { origin: { kind: "task-notification" }, text: "task done" };
  const result2 = await hnd(h.fake, e2, (e) => {
    nextCalled2 = true;
    nextArg2 = e;
    return { task: true };
  });

  check("S4 other origin: task-notification - next was called", nextCalled2);
  check("S4 other origin: task-notification - next received e unchanged", nextArg2 === e2);
  check("S4 other origin: task-notification - result has NO consumed", !result2 || result2.consumed === undefined);

  // BH1: extra control with bare string (should be consumed as peer)
  let nextCalled3 = false;
  let nextArg3 = null;
  const e3 = { origin: "peer", text: "bare string peer" };
  const result3 = await hnd(h.fake, e3, (e) => {
    nextCalled3 = true;
    nextArg3 = e;
    return { bare: true };
  });

  check("S4 other origin: bare string peer - next was NOT called", !nextCalled3);
  check("S4 other origin: bare string peer - result has consumed", result3 && result3.consumed !== undefined);
}

// S5: BC3 - reader claims reader not persona at start (control)
async function caseS5_reader_claims_reader_not_persona(clock) {
  console.log("\n=== S5: reader claims reader not persona (control) ===");
  clock.set(T0);

  // Manually create the harness to seed before session.start.
  const mod = await loadModule("s5_reader_claims");
  const h = createFake$(OPTS);
  const handlers = {};
  const on = (event, handler) => { handlers[event] = handler; };
  await mod.register(on, OPTS);

  const otherSessionId = "other-owner-session";
  const now = Date.now();

  // Seed the global commons store with the other session's persona claim.
  const otherCommonsKey = `commons:${otherSessionId}`;
  h.storeMap.set(otherCommonsKey, {
    sessionId: otherSessionId,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 1000 }],
  });

  // Seed the local persona store with the other session as active.
  const state = makeState({ now });
  state.activeSessionId = otherSessionId;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));

  // Seed a live heartbeat for the other session.
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: otherSessionId, epoch: 1, lastSeen: now },
  }));

  // Now fire session.start for the new session.
  await handlers["session.start"](h.fake, {}, () => {});

  // Check that the new session's commons entry has reader:default, not persona:default.
  const commonsKey = `commons:${SESSION_ID}`;
  const entry = h.storeMap.get(commonsKey);
  check("S5 reader: entry has reader:default claim", entry && entry.claims && entry.claims.some(c => c.resource === "reader:default"));
  check("S5 reader: entry has NO persona:default claim", entry && entry.claims && !entry.claims.some(c => c.resource === "persona:default"));
}

// S5: BC3 - identity joins live owner as reader
async function caseS5_identity_joins_live_owner(clock) {
  console.log("\n=== S5: identity joins live owner as reader ===");
  clock.set(T0);

  const mod = await loadModule("s5_identity_joins");
  const h = createFake$(OPTS);
  const handlers = {};
  const on = (event, handler) => { handlers[event] = handler; };
  await mod.register(on, OPTS);

  const otherSessionId = "other-owner-session";
  const now = Date.now();

  // Seed a live earlier persona:default holder.
  const otherCommonsKey = `commons:${otherSessionId}`;
  h.storeMap.set(otherCommonsKey, {
    sessionId: otherSessionId,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 1000 }],
  });

  // Seed the local persona store with the other session as active.
  const state = makeState({ now });
  state.activeSessionId = otherSessionId;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));

  // Seed a live heartbeat for the other session.
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: otherSessionId, epoch: 1, lastSeen: now },
  }));

  // Fire session.start for the new session.
  await handlers["session.start"](h.fake, {}, () => {});

  // Fire agentic_identity tool call.
  const toolCallH = handlers["tool.call"];

  // The tool.call handler signature is (fake, event, next).
  // The event should have `tool` (not `toolName`) and `input`.
  const identityResult = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_identity",
    input: {},
  }, async (e) => ({ result: "passthrough" }));

  // Check the result text.
  const resultText = identityResult?.result || identityResult?.text || "";
  check("S5 identity: result contains 'joined as reader'", resultText.includes("joined as reader"));

  // Check that the new session's commons entry has reader:default.
  const commonsKey = `commons:${SESSION_ID}`;
  const entry = h.storeMap.get(commonsKey);
  check("S5 identity: entry has reader:default claim", entry && entry.claims && entry.claims.some(c => c.resource === "reader:default"));

  // BD8: the owner's heartbeat is intact.
  const hbRaw = h.fsMap.get(".agentic-heartbeat.json");
  const hb = hbRaw ? JSON.parse(hbRaw) : null;
  check("S5 identity: owner heartbeat intact", hb && hb.default && hb.default.sessionId === otherSessionId && hb.default.epoch === 1);
}

// S5: identity switch releases the old persona's commons claim (Round 11/34)
// Item 6 fix (db68855): when a session calls agentic_identity to switch from
// one persona to another, the old persona's commons claim must be released -
// left behind, a persona claim reads as live under this session's own
// heartbeat forever, blocking any other session from ever winning that old
// persona's arbitration. Control: before the switch, the entry carries the
// old persona's claim; after, it must not.
async function caseS5_identity_releases_old_persona(clock) {
  console.log("\n=== S5: identity switch releases old persona ===");
  clock.set(T0);

  const mod = await loadModule("s5_identity_release");
  const h = createFake$(OPTS);
  const handlers = {};
  const on = (event, handler) => { handlers[event] = handler; };
  await mod.register(on, OPTS);

  // This session becomes commons winner for "default" at session.start.
  await handlers["session.start"](h.fake, {}, () => {});

  const commonsKey = `commons:${SESSION_ID}`;
  const beforeEntry = h.storeMap.get(commonsKey);
  check("S5 release control: entry has persona:default claim before switch", beforeEntry && beforeEntry.claims && beforeEntry.claims.some(c => c.resource === "persona:default"));

  // Switch to a different persona with no live earlier holder; this session
  // becomes its commons winner too.
  const toolCallH = handlers["tool.call"];
  await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_identity",
    persona: "other",
  }, async () => ({ result: "passthrough" }));

  const afterEntry = h.storeMap.get(commonsKey);
  check("S5 release: entry has NO persona:default claim after switch", afterEntry && afterEntry.claims && !afterEntry.claims.some(c => c.resource === "persona:default"));
  check("S5 release: entry has persona:other claim after switch", afterEntry && afterEntry.claims && afterEntry.claims.some(c => c.resource === "persona:other"));
}

// S5: identity reader join releases its speculative persona claim (Round 32)
// The tool.call handler claims persona:<p> in commons before it knows
// whether a live earlier holder exists (F9: claim first, then arbitrate).
// When a live holder does exist and this session joins as reader, that
// speculative claim must not survive - left in place, it reads as a live
// persona holder under this session's own heartbeat, which would hold the
// next relaunch's pre-gate for the full stale-after window (the same shape
// that blocked a Reviewer session on a stale persona:default claim, Round
// 33's restart record). Setup mirrors caseS5_identity_joins_live_owner,
// which is this case's control: it already shows the join adds
// reader:default; this shows the speculative persona:default claim the
// claim-first step took does not survive alongside it.
async function caseS5_identity_reader_releases_speculative_claim(clock) {
  console.log("\n=== S5: identity reader join releases speculative persona claim ===");
  clock.set(T0);

  const mod = await loadModule("s5_identity_reader_release");
  const h = createFake$(OPTS);
  const handlers = {};
  const on = (event, handler) => { handlers[event] = handler; };
  await mod.register(on, OPTS);

  const otherSessionId = "other-owner-session";
  const now = Date.now();

  const otherCommonsKey = `commons:${otherSessionId}`;
  h.storeMap.set(otherCommonsKey, {
    sessionId: otherSessionId,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 1000 }],
  });

  const state = makeState({ now });
  state.activeSessionId = otherSessionId;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: otherSessionId, epoch: 1, lastSeen: now },
  }));

  await handlers["session.start"](h.fake, {}, () => {});

  const toolCallH = handlers["tool.call"];
  await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_identity",
    input: {},
  }, async () => ({ result: "passthrough" }));

  const commonsKey = `commons:${SESSION_ID}`;
  const entry = h.storeMap.get(commonsKey);
  check("S5 reader release: entry has NO persona:default claim", entry && entry.claims && !entry.claims.some(c => c.resource === "persona:default"));
}

// ============================================================
// S6: BD3 ask/say/inbox pair
// ============================================================

function seedOpenAsk(h, askId, nodeId, question, ownerSessionId, at) {
  h.storeMap.set(`ask:default:${askId}`, {
    id: askId,
    ownerSessionId,
    at,
    nodeId,
    question,
    status: "open",
  });
}

function seedReaderClaim(h, sid, now) {
  h.storeMap.set(`commons:${sid}`, {
    sessionId: sid,
    lastSeen: now,
    claims: [{ resource: "reader:default", claimedAt: now - 1000 }],
  });
}

// S6-1: agentic_inbox returns asks with an id field
async function caseS6_inbox_carries_ask_id(clock) {
  console.log("\n=== S6: inbox carries ask id ===");
  clock.set(T0);
  const now = T0;

  const mod = await loadModule("s6_inbox_id");
  const h = createFake$(OPTS);
  const handlers = {};
  await mod.register((event, handler) => { handlers[event] = handler; }, OPTS);

  seedOpenAsk(h, "ask-g-1", "g", "what now?", "prior-owner", now - 5000);

  // Seed an owner so the reader path is taken.
  h.storeMap.set(`commons:owner-session`, {
    sessionId: "owner-session",
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const state = makeState({ now });
  state.activeSessionId = "owner-session";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: "owner-session", epoch: 1, lastSeen: now },
  }));

  await handlers["session.start"](h.fake, {}, () => {});

  seedReaderClaim(h, SESSION_ID, now);

  const toolCallH = handlers["tool.call"];
  const res = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_inbox",
    input: {},
  }, async () => ({ result: "passthrough" }));

  const resultText = res?.result || "";
  check("S6 inbox: result is JSON with id field", (() => {
    try {
      const parsed = JSON.parse(resultText);
      return Array.isArray(parsed.asks) && parsed.asks.length === 1 && parsed.asks[0].id === "ask-g-1";
    } catch { return false; }
  })());
}

// S6-2: agentic_say with unknown answers is refused
async function caseS6_say_unknown_answers_refused(clock) {
  console.log("\n=== S6: say unknown answers refused ===");
  clock.set(T0);
  const now = T0;

  const mod = await loadModule("s6_say_unknown");
  const h = createFake$(OPTS);
  const handlers = {};
  await mod.register((event, handler) => { handlers[event] = handler; }, OPTS);

  // Seed one open ask so the refusal can list it.
  seedOpenAsk(h, "ask-g-1", "g", "what now?", "prior-owner", now - 5000);

  h.storeMap.set(`commons:owner-session`, {
    sessionId: "owner-session",
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const state = makeState({ now });
  state.activeSessionId = "owner-session";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: "owner-session", epoch: 1, lastSeen: now },
  }));

  await handlers["session.start"](h.fake, {}, () => {});
  seedReaderClaim(h, SESSION_ID, now);

  const toolCallH = handlers["tool.call"];
  const res = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_say",
    text: "hi",
    answers: "ask-wrong",
  }, async () => ({ result: "passthrough" }));

  check("S6 say: refused (deny present)", !!res?.deny);
  check("S6 say: denial names the unknown id", (res?.deny || "").includes("ask-wrong"));
  check("S6 say: denial lists the open ask id", (res?.deny || "").includes("ask-g-1"));

  // No inbox record was written.
  const inboxKeys = [...h.storeMap.keys()].filter(k => k.startsWith("inbox:"));
  check("S6 say: no inbox record written", inboxKeys.length === 0);
}

// S6-3: agentic_say with known open answers writes a record
async function caseS6_say_known_answers_writes_record(clock) {
  console.log("\n=== S6: say known answers writes record ===");
  clock.set(T0);
  const now = T0;

  const mod = await loadModule("s6_say_known");
  const h = createFake$(OPTS);
  const handlers = {};
  await mod.register((event, handler) => { handlers[event] = handler; }, OPTS);

  seedOpenAsk(h, "ask-g-1", "g", "what now?", "prior-owner", now - 5000);

  h.storeMap.set(`commons:owner-session`, {
    sessionId: "owner-session",
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const state = makeState({ now });
  state.activeSessionId = "owner-session";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: "owner-session", epoch: 1, lastSeen: now },
  }));

  await handlers["session.start"](h.fake, {}, () => {});
  seedReaderClaim(h, SESSION_ID, now);

  const toolCallH = handlers["tool.call"];
  const res = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__agentic_say",
    text: "answer",
    answers: "ask-g-1",
  }, async () => ({ result: "passthrough" }));

  check("S6 say: not denied", !res?.deny);

  const inboxKeys = [...h.storeMap.keys()].filter(k => k.startsWith("inbox:"));
  check("S6 say: inbox record written", inboxKeys.length === 1);
  const rec = h.storeMap.get(inboxKeys[0]);
  check("S6 say: record answers field is ask-g-1", rec?.answers === "ask-g-1");
}

// S6-4: owner start expires prior open asks
async function caseS6_owner_start_expires_prior_asks(clock) {
  console.log("\n=== S6: owner start expires prior asks ===");
  clock.set(T0);
  const now = T0;

  const mod = await loadModule("s6_owner_expire");
  const h = createFake$(OPTS);
  const handlers = {};
  await mod.register((event, handler) => { handlers[event] = handler; }, OPTS);

  // Seed two open asks from a prior owner.
  seedOpenAsk(h, "ask-g-1", "g", "question one", "prior-owner-1", now - 9000);
  seedOpenAsk(h, "ask-g-2", "g", "question two", "prior-owner-1", now - 4000);

  await handlers["session.start"](h.fake, {}, () => {});

  const a1 = h.storeMap.get("ask:default:ask-g-1");
  const a2 = h.storeMap.get("ask:default:ask-g-2");
  check("S6 owner: ask 1 expired", a1?.status === "expired");
  check("S6 owner: ask 2 expired", a2?.status === "expired");
}

// S6-5: reader start leaves asks open (control)
async function caseS6_reader_start_leaves_asks_open(clock) {
  console.log("\n=== S6: reader start leaves asks open ===");
  clock.set(T0);
  const now = T0;

  const mod = await loadModule("s6_reader_control");
  const h = createFake$(OPTS);
  const handlers = {};
  await mod.register((event, handler) => { handlers[event] = handler; }, OPTS);

  seedOpenAsk(h, "ask-g-1", "g", "question", "other-owner", now - 9000);

  // Seed a live owner holder.
  h.storeMap.set(`commons:other-owner`, {
    sessionId: "other-owner",
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const state = makeState({ now });
  state.activeSessionId = "other-owner";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: "other-owner", epoch: 1, lastSeen: now },
  }));

  // Delete the harness's own owner-start commons entry (BC3), so the
  // re-fire is the reader start.
  h.storeMap.delete(`commons:${SESSION_ID}`);

  await handlers["session.start"](h.fake, {}, () => {});

  const a1 = h.storeMap.get("ask:default:ask-g-1");
  check("S6 reader: ask still open", a1?.status === "open");
}

// S7: promotion with a live commons claim must not bump the epoch
async function caseS7_promotion_deferred(clock) {
  console.log("\n=== S7: promotion deferred by live commons claim ===");
  clock.set(T0);
  const now = T0;

  const mod = await loadModule("s7_promo_defer");
  const h = createFake$(OPTS);
  const handlers = {};
  await mod.register((event, handler) => { handlers[event] = handler; }, OPTS);

  // Seed a live commons claim from another session (owner).
  h.storeMap.set(`commons:other-owner`, {
    sessionId: "other-owner",
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // Seed the persona state with the other owner as active.
  const state = makeState({ now });
  state.activeSessionId = "other-owner";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));

  // Seed the heartbeat with the other owner as the live holder.
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: "other-owner", epoch: 1, lastSeen: now },
  }));

  // Fire session.start to join as reader (owner is live).
  const startH = handlers["session.start"];
  if (startH) {
    await startH(h.fake, {}, () => {});
  }

  // Advance time by 120s: past the 90s stale threshold for the holder's
  // heartbeat (triggering the promotion path). The commons entry's
  // lastSeen is also 120s old, but I'll refresh it right before the tick
  // so the commons check sees a LIVE claim.
  clock.set(now + 120_000);
  
  // Refresh the commons entry's lastSeen to keep it live (simulating
  // the other owner's heartbeat tick refreshing their commons claim).
  const otherEntry = h.storeMap.get(`commons:other-owner`);
  if (otherEntry) {
    const parsed = typeof otherEntry === 'string' ? JSON.parse(otherEntry) : otherEntry;
    parsed.lastSeen = now + 120_000; // Set to current time
    h.storeMap.set(`commons:other-owner`, parsed);
  }
  
  // Fire the heartbeat tick. The holder's heartbeat is stale (120s > 90s),
  // but the commons claim is live (lastSeen was just refreshed).
  await fireHeartbeat(h);

  // Read back the state.
  const raw = h.fsMap.get(".agentic-personas.json");
  const store = raw ? JSON.parse(raw) : {};
  const decisions = (store.default && store.default.decisions) || [];
  const deferred = decisions.filter(d => d.action === "promotion_deferred_commons");
  check("S7: promotion_deferred_commons decision present", deferred.length >= 1);
  check("S7: detail names the commons holder", deferred.some(d => (d.detail || "").includes("other-owner")));

  // The epoch must NOT have been bumped (still at the other owner's epoch).
  const rawHb = h.fsMap.get(".agentic-heartbeat.json");
  const hb = rawHb ? JSON.parse(rawHb) : {};
  check("S7: local heartbeat not stamped (epoch unchanged)", hb.default?.epoch === 1);
}

// S8: reader claim stays live across a 300s gap
async function caseS8_reader_claim_stays_live(clock) {
  console.log("\n=== S8: reader claim stays live across 300s gap ===");
  clock.set(T0);
  const now = T0;

  const mod = await loadModule("s8_reader_claim");
  const h = createFake$(OPTS);
  const handlers = {};
  await mod.register((event, handler) => { handlers[event] = handler; }, OPTS);

  // Seed a live owner.
  h.storeMap.set(`commons:owner-sid`, {
    sessionId: "owner-sid",
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 1000 }],
  });

  // Set up the persona state so the session is a non-owner.
  const state = makeState({ now });
  state.activeSessionId = "owner-sid";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: "owner-sid", epoch: 1, lastSeen: now },
  }));

  // Fire session.start to initialize the session and register clock callbacks.
  const startH = handlers["session.start"];
  if (startH) {
    await startH(h.fake, {}, () => {});
  }

  // Advance time by 300s and fire the heartbeat tick.
  clock.set(now + 300_000);
  await fireHeartbeat(h);

  // Check the reader claim is still live (lastSeen should have been refreshed).
  const readerEntry = h.storeMap.get(`commons:${SESSION_ID}`);
  const readerClaim = readerEntry?.claims?.find(c => c.resource === "reader:default");
  check("S8: reader claim present after 300s tick", !!readerClaim);
  check("S8: reader entry lastSeen refreshed", readerEntry && readerEntry.lastSeen > now);
}

// S9: cost cap opens ask (BF2)
async function caseS9_cost_cap_opens_ask(clock) {
  console.log("\n=== S9: cost cap opens ask ===");
  clock.set(T0);
  const now = T0;

  // Use createTickHarness to get the full harness with controller tick registered.
  // costMaxNudgesPerHour = 2, so the third nudge attempt should hit the cap.
  const h = await createTickHarness({
    ...OPTS,
    caseName: "s9_cost_cap_opens",
  });

  h.setClassifyValue("nudge");
  h.resetClassifyCalls();

  // Three due nudges, 130s apart (above nudgeFloorMs = 120s).
  // costMaxNudgesPerHour = 2, so the third should hit the cap and open an ask.
  for (let i = 0; i < 3; i++) {
    clock.advance(130000);
    await tickAndSettle(h, clock, 50);
  }

  // Read back the state.
  const storePath = ".agentic-personas.json";
  const raw = h.fsMap.get(storePath);
  const store = raw ? JSON.parse(raw) : {};
  const decisions = (store.default && store.default.decisions) || [];

  // BF2 opens an ask when the cap is reached.
  const askOpened = decisions.filter(d => d.action === "ask_opened");
  check("S9: ask_opened detail contains cost-cap", askOpened.some(d => (d.detail || "").includes("cost-cap")));

  check("S9: pendingAskId set", store.default?.pendingAskId !== undefined && store.default?.pendingAskId !== null);

  // BG1: the active goal should be paused, not blocked
  const activeGoal = store.default?.goals?.find(g => g.id === store.default?.activeGoalId);
  check("S9 BG1: active goal status is paused", activeGoal && activeGoal.status === "paused");
  check("S9 BG1: no block decision", !decisions.some(d => d.action === "block"));
  check("S9 BG1: paused_by_controller decision present", decisions.some(d => d.action === "paused_by_controller"));

  // BG1: no other node should have changed status (no activateNext, no activate)
  const otherGoals = store.default?.goals?.filter(g => g.id !== store.default?.activeGoalId) || [];
  check("S9 BG1: no other goal activated", !otherGoals.some(g => g.status === "active"));
}

// S9 control: cost cap below (no ask opened)
async function caseS9_cost_cap_below(clock) {
  console.log("\n=== S9 control: cost cap below ===");
  clock.set(T0);
  const now = T0;

  // Use createTickHarness to get the full harness with controller tick registered.
  const h = await createTickHarness({
    ...OPTS,
    caseName: "s9_cost_cap_below",
  });

  h.setClassifyValue("nudge");

  // Fire one nudge to get the window count to 1 (below cap of 2).
  clock.advance(130000);
  await tickAndSettle(h, clock, 50);

  // Fire another tick. The window is below cap, so no ask should be opened.
  clock.advance(130000);
  await tickAndSettle(h, clock, 50);

  // Read back the state.
  const storePath = ".agentic-personas.json";
  const raw = h.fsMap.get(storePath);
  const store = raw ? JSON.parse(raw) : {};
  const decisions = (store.default && store.default.decisions) || [];

  // No cost_cap_reached should be present (window is below cap).
  const costCap = decisions.filter(d => d.action === "cost_cap_reached");
  check("S9 control: no cost_cap_reached (window below cap)", costCap.length === 0);

  // No ask_opened should be present.
  const askOpened = decisions.filter(d => d.action === "ask_opened");
  check("S9 control: no ask_opened", askOpened.length === 0);

  // pendingAskId should not be set.
  check("S9 control: pendingAskId not set", store.default?.pendingAskId === undefined || store.default?.pendingAskId === null);
}

// S7 control: reader deferral does not overwrite owner's goals (BF1)
async function caseS7_reader_does_not_overwrite(clock) {
  console.log("\n=== S7 control: reader does not overwrite owner's goals ===");
  clock.set(T0);
  const now = T0;

  const mod = await loadModule("s7_no_overwrite");
  const h = createFake$(OPTS);
  const handlers = {};
  await mod.register((event, handler) => { handlers[event] = handler; }, OPTS);

  // Seed a live commons claim from another session (owner).
  h.storeMap.set(`commons:other-owner`, {
    sessionId: "other-owner",
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // Seed the persona state with the owner's goals and decisions.
  const ownerState = makeState({ now });
  ownerState.activeSessionId = "other-owner";
  ownerState.goals.push({
    id: "owner-goal-1",
    text: "Owner's goal",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  ownerState.decisions.push({
    timestamp: now - 5000,
    loop: "goal",
    action: "goal_created",
    detail: "owner-goal-1: Owner's goal",
  });
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: ownerState }));

  // Seed the heartbeat with the other owner as the live holder.
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: "other-owner", epoch: 1, lastSeen: now },
  }));

  // Fire session.start to join as reader (owner is live).
  const startH = handlers["session.start"];
  if (startH) {
    await startH(h.fake, {}, () => {});
  }

  // Advance time by 120s: past the 90s stale threshold for the holder's
  // heartbeat (triggering the promotion path). The commons entry's
  // lastSeen is also 120s old, but I'll refresh it right before the tick
  // so the commons check sees a LIVE claim.
  clock.set(now + 120_000);
  
  // Refresh the commons entry's lastSeen to keep it live (simulating
  // the other owner's heartbeat tick refreshing their commons claim).
  const otherEntry = h.storeMap.get(`commons:other-owner`);
  if (otherEntry) {
    const parsed = typeof otherEntry === 'string' ? JSON.parse(otherEntry) : otherEntry;
    parsed.lastSeen = now + 120_000; // Set to current time
    h.storeMap.set(`commons:other-owner`, parsed);
  }
  
  // Fire the heartbeat tick. The holder's heartbeat is stale (120s > 90s),
  // but the commons claim is live (lastSeen was just refreshed).
  await fireHeartbeat(h);

  // Read back the state.
  const raw = h.fsMap.get(".agentic-personas.json");
  const store = raw ? JSON.parse(raw) : {};
  const decisions = (store.default && store.default.decisions) || [];

  // The owner's original decision should still be present.
  const ownerDecision = decisions.filter(d => d.detail?.includes("owner-goal-1"));
  check("S7 control: owner's original decision preserved", ownerDecision.length >= 1);

  // The reader's deferral decision should be present.
  const deferred = decisions.filter(d => d.action === "promotion_deferred_commons");
  check("S7 control: reader's deferral decision present", deferred.length >= 1);

  // The owner's goal should still be present.
  const goals = (store.default && store.default.goals) || [];
  const ownerGoal = goals.filter(g => g.id === "owner-goal-1");
  check("S7 control: owner's goal preserved", ownerGoal.length >= 1);
}

// BM2: Planner variance - four plans against three-item roadmap
async function caseBM2_planner_variance_four_plans(clock) {
  console.log("\n=== BM2: planner_variance (four plans, three-item roadmap) ===");
  clock.set(T0);

  // BM2: Seed a root goal with a roadmap (planner will run)
  const rootGoal = {
    id: "root-goal",
    parentId: null,
    kind: "root",
    title: "Write three haikus",
    objective: "Write three haikus",
    status: "active",
    source: "controller",
    maxRounds: 10,
    completedRounds: 0,
    scores: [],
    notes: [],
    planningRounds: 0,
    consecutiveBlockedPlannings: 0,
    consecutivePlanningFailures: 0,
    planningRound: 0,
    createdAt: T0 - 10000,
    updatedAt: T0 - 5000,
    roadmapPath: ".kit/roadmap-test.md",
  };
  const h = await createTickHarness({
    ...OPTS,
    caseName: "bm2_planner_variance_four",
    stateOpts: {
      now: T0,
      goals: [rootGoal],
      activeGoalId: "root-goal",
    },
    // Stub the planner to return four plans (against a three-item roadmap)
    completeValue: JSON.stringify([
      { title: "Haiku 1", objective: "Write haiku 1", maxRounds: 5 },
      { title: "Haiku 2", objective: "Write haiku 2", maxRounds: 5 },
      { title: "Haiku 3", objective: "Write haiku 3", maxRounds: 5 },
      { title: "Verify Syllable Counts", objective: "Verify all haikus", maxRounds: 5 },
    ]),
  });

  // Seed the roadmap file (three numbered items) into the fake fs
  h.fsMap.set(".kit/roadmap-test.md", "1. Write haiku 1\n2. Write haiku 2\n3. Write haiku 3\n");

  // Fire a tick to trigger planning
  await fireTick(h, T0);

  // Read the state
  const state = getState(h);
  const decisions = state.decisions || [];

  // Check: planner_variance should be present
  const variance = decisions.find(d => d.action === "planner_variance");
  check("BM2 four: planner_variance present", variance !== undefined);

  // Check: four plans should be created (flag, not trim)
  const plans = state.goals.filter(g => g.kind === "plan");
  check("BM2 four: four plans created", plans.length === 4);
}

// BM2: Planner variance - control (three plans, three-item roadmap)
async function caseBM2_planner_variance_three_plans(clock) {
  console.log("\n=== BM2: planner_variance control (three plans, three-item roadmap) ===");
  clock.set(T0);

  // BM2: Seed a root goal with a roadmap (planner will run)
  const rootGoal = {
    id: "root-goal",
    parentId: null,
    kind: "root",
    title: "Write three haikus",
    objective: "Write three haikus",
    status: "active",
    source: "controller",
    maxRounds: 10,
    completedRounds: 0,
    scores: [],
    notes: [],
    planningRounds: 0,
    consecutiveBlockedPlannings: 0,
    consecutivePlanningFailures: 0,
    planningRound: 0,
    createdAt: T0 - 10000,
    updatedAt: T0 - 5000,
    roadmapPath: ".kit/roadmap-test.md",
  };
  const h = await createTickHarness({
    ...OPTS,
    caseName: "bm2_planner_variance_three",
    stateOpts: {
      now: T0,
      goals: [rootGoal],
      activeGoalId: "root-goal",
    },
    // Stub the planner to return three plans (matching the three-item roadmap)
    completeValue: JSON.stringify([
      { title: "Haiku 1", objective: "Write haiku 1", maxRounds: 5 },
      { title: "Haiku 2", objective: "Write haiku 2", maxRounds: 5 },
      { title: "Haiku 3", objective: "Write haiku 3", maxRounds: 5 },
    ]),
  });

  // Seed the roadmap file (three numbered items) into the fake fs
  h.fsMap.set(".kit/roadmap-test.md", "1. Write haiku 1\n2. Write haiku 2\n3. Write haiku 3\n");

  // Fire a tick to trigger planning
  await fireTick(h, T0);

  // Read the state
  const state = getState(h);
  const decisions = state.decisions || [];

  // Check: planner_variance should NOT be present
  const variance = decisions.find(d => d.action === "planner_variance");
  check("BM2 three: planner_variance absent", variance === undefined);

  // Check: three plans should be created
  const plans = state.goals.filter(g => g.kind === "plan");
  check("BM2 three: three plans created", plans.length === 3);
}

// BJ1: Budget fixture - 2.1.268 shape (tu.tool instead of tu.name)
async function caseBJ1_budget_268_shape(clock) {
  console.log("\n=== BJ1: budget 2.1.268 shape ===");
  clock.set(T0);

  // Create a harness with a custom session.messages() that returns 2.1.268 shape.
  // Enable budget and set thresholds low enough to be crossed by the test message.
  const h = await createTickHarness({
    ...OPTS,
    caseName: "bj1_budget_268",
    // Budget options (passed to mod.register as options)
    contextBudgetEnabled: true,
    contextBudgetInfoTokens: 100,
    contextBudgetCloseoutTokens: 200,
    contextBudgetCriticalTokens: 300,
    contextBudgetReadEveryNTicks: 1,
    // 2.1.268 shape: { tool_use_id, tool, input }
    sessionMessages: () => Promise.resolve([
      {
        text: "hello world this is a test message with enough text to cross the info threshold " + "x".repeat(1000),
        toolUses: [
          { tool_use_id: "tu-1", tool: "bash", input: { command: "ls -la" } },
          { tool_use_id: "tu-2", tool: "read", input: { file_path: "/etc/hosts" } },
        ],
        toolResults: [
          { tool_use_id: "tu-1", text: "file1\nfile2\nfile3", isError: false },
        ],
      },
    ]),
  });

  // Fire a tick to trigger the budget check.
  await tickAndSettle(h, clock, 100);

  const storePath = ".agentic-personas.json";
  const raw = h.fsMap.get(storePath);
  const store = raw ? JSON.parse(raw) : {};
  const decisions = (store.default && store.default.decisions) || [];

  // Check for context_budget_crossed decisions.
  const crossings = decisions.filter(d => d.action === "context_budget_crossed");
  check("BJ1 268: at least one crossing", crossings.length >= 1);
  check("BJ1 268: info threshold crossed", crossings.some(d => (d.detail || "").includes("info")));
}

// BJ1: Budget fixture - messages() throws, should log context_budget_read_failed
async function caseBJ1_budget_read_failed(clock) {
  console.log("\n=== BJ1: budget read failed ===");
  clock.set(T0);

  const h = await createTickHarness({
    ...OPTS,
    caseName: "bj1_budget_read_failed",
    // Budget options
    contextBudgetEnabled: true,
    contextBudgetInfoTokens: 100,
    contextBudgetCloseoutTokens: 200,
    contextBudgetCriticalTokens: 300,
    contextBudgetReadEveryNTicks: 1,
    // messages() throws an error
    sessionMessages: () => Promise.reject(new Error("simulated messages() failure")),
  });

  await tickAndSettle(h, clock, 100);

  const storePath = ".agentic-personas.json";
  const raw = h.fsMap.get(storePath);
  const store = raw ? JSON.parse(raw) : {};
  const decisions = (store.default && store.default.decisions) || [];

  // Check for context_budget_read_failed.
  const readFailed = decisions.filter(d => d.action === "context_budget_read_failed");
  check("BJ1 read_failed: context_budget_read_failed present", readFailed.length >= 1);
  check("BJ1 read_failed: detail contains error message", readFailed.some(d => (d.detail || "").includes("simulated")));

  // No crossings should be present.
  const crossings = decisions.filter(d => d.action === "context_budget_crossed");
  check("BJ1 read_failed: no crossings", crossings.length === 0);
}

// BO1-pin: The self-review branch must not return early, so the planning gate runs.
// State: root goal, one plan in done, selfReview.pendingPeriodic: true.
// Model stubbed: NONE for self-review, zero plans for planner.
// Assert: decisions carry self-review and then planning_fired.
async function caseBO1_pin_selfreview_then_planning(clock) {
  console.log("\n=== BO1-pin: self-review then planning ===");
  clock.set(T0);

  // Set up state: root goal (pending), one plan in done, selfReview.pendingPeriodic: true
  const rootGoal = {
    id: "root-goal",
    parentId: null,
    kind: "root",
    title: "Test goal",
    objective: "Test goal",
    status: "pending",
    source: "controller",
    maxRounds: 10,
    completedRounds: 0,
    scores: [],
    notes: [],
    planningRounds: 0,
    consecutiveBlockedPlannings: 0,
    consecutivePlanningFailures: 0,
    planningRound: 0,
    createdAt: T0 - 10000,
    updatedAt: T0 - 5000,
  };
  const donePlan = {
    id: "plan-1",
    parentId: "root-goal",
    kind: "leaf",
    objective: "Test plan",
    status: "done",
    createdAt: T0 - 9000,
    updatedAt: T0 - 4000,
    children: [],
  };

  const h = await createTickHarness({
    ...OPTS,
    caseName: "bo1_pin_selfreview",
    stateOpts: {
      now: T0,
      goals: [rootGoal, donePlan],
      activeGoalId: null,
      selfReview: { count: 0, lastAt: 0, turnsSince: 0, windowStart: 0, pendingPeriodic: true, lastInjectAt: 0 },
    },
    // Stub the model: NONE for self-review, empty array for planner
    classifyValue: "NONE",
    completeValue: "[]",
  });

  // Fire one tick
  await tickAndSettle(h, clock, 100);

  const decisions = getDecisions(h);
  const selfReviewIdx = decisions.findIndex(d => d.action === "self-review");
  const planningFiredIdx = decisions.findIndex(d => d.action === "planning_fired");

  check("BO1-pin: self-review present", selfReviewIdx !== -1);
  check("BO1-pin: planning_fired present", planningFiredIdx !== -1);
  check("BO1-pin: self-review before planning_fired", selfReviewIdx !== -1 && planningFiredIdx !== -1 && selfReviewIdx < planningFiredIdx);
}

// BO1-pin control: same state but selfReview.pendingPeriodic: false.
// Assert: planning_fired present and no self-review.
async function caseBO1_pin_control_no_selfreview(clock) {
  console.log("\n=== BO1-pin control: no self-review ===");
  clock.set(T0);

  // Set up state: root goal (pending), one plan in done, selfReview.pendingPeriodic: false
  const rootGoal = {
    id: "root-goal",
    parentId: null,
    kind: "root",
    title: "Test goal",
    objective: "Test goal",
    status: "pending",
    source: "controller",
    maxRounds: 10,
    completedRounds: 0,
    scores: [],
    notes: [],
    planningRounds: 0,
    consecutiveBlockedPlannings: 0,
    consecutivePlanningFailures: 0,
    planningRound: 0,
    createdAt: T0 - 10000,
    updatedAt: T0 - 5000,
  };
  const donePlan = {
    id: "plan-1",
    parentId: "root-goal",
    kind: "leaf",
    objective: "Test plan",
    status: "done",
    createdAt: T0 - 9000,
    updatedAt: T0 - 4000,
    children: [],
  };

  const h = await createTickHarness({
    ...OPTS,
    caseName: "bo1_pin_control",
    stateOpts: {
      now: T0,
      goals: [rootGoal, donePlan],
      activeGoalId: null,
      selfReview: { count: 0, lastAt: 0, turnsSince: 0, windowStart: 0, pendingPeriodic: false, lastInjectAt: 0 },
    },
    // Stub the model: NONE for classify, empty array for planner
    classifyValue: "NONE",
    completeValue: "[]",
  });

  // Fire one tick
  await tickAndSettle(h, clock, 100);

  const decisions = getDecisions(h);
  const selfReviewIdx = decisions.findIndex(d => d.action === "self-review");
  const planningFiredIdx = decisions.findIndex(d => d.action === "planning_fired");

  check("BO1-pin control: no self-review", selfReviewIdx === -1);
  check("BO1-pin control: planning_fired present", planningFiredIdx !== -1);
}

// ============================================================
// Item 6: the `persona` userConfig option. A session given
// options.persona claims that persona at session.start instead of the
// plugin's hardcoded "default", and never touches the "default" slot.
// ============================================================
async function caseItem6_personaOption(clock) {
  console.log("\n=== Item 6: persona option claims the given persona, never default ===");
  clock.set(T0);

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item6_persona_dev",
    persona: "dev",
  });

  const devState = getStateForPersona(h, "dev");
  const defaultState = getStateForPersona(h, "default");

  check("item6 persona: 'dev' persona slot exists", !!devState);
  check(
    "item6 persona: 'dev' claimed via persona_create",
    !!devState && devState.decisions.some(d => d.action === "persona_create" && d.detail.includes("'dev'")),
  );
  check(
    "item6 persona: the seeded 'default' slot was never touched (still zero decisions)",
    !!defaultState && defaultState.decisions.length === 0,
  );
}

// Control: no persona option given at all. Must fall back to "default"
// exactly as before the option existed - the option is additive, not a
// breaking change to every session that doesn't set it.
async function caseItem6_personaOption_control(clock) {
  console.log("\n=== Item 6 control: no persona option, default behavior unchanged ===");
  clock.set(T0);

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item6_persona_control",
  });

  // The harness's own seedPersonaStore pre-populates "default" with an
  // active goal (not a fresh persona_create), so the assertion is that no
  // second slot appeared, not that a fresh persona was created from nothing.
  check(
    "item6 persona control: no unexpected extra persona slot appeared",
    Object.keys(JSON.parse(h.fsMap.get(".agentic-personas.json"))).length === 1,
  );
}

// --- Main ---

async function main() {
  const clock = stubDateNow();
  try {
    await caseD2(clock);
    await caseD4(clock);
    await caseAM7(clock);
    await caseD3(clock);
    await caseAT4_owner_refusal(clock);
    await caseAT4_say_refused(clock);
    await caseAT4_inbox_status(clock);
    await caseS2_drain(clock);
    await caseS2_drain_inflight(clock);
    await caseS2_reply_turnid(clock);
    await caseS2_reply_unrelated(clock);
    await caseS3_no_walk_while_open(clock);
    await caseS3_answer_reactivates(clock);
    await caseS3_say_leaves_ask_open(clock);
    await caseS3_timeout_walks_on(clock);
    await caseS3_timeout_walks_on_default(clock);
    await caseD5b_replyClosesAsk(clock);
    await caseD5b_reaskSuppressed(clock);
    await caseD5b_reraiseOnce(clock);
    await caseItem2_noGoalReminderPushesOnSize(clock);
    await caseItem2_noGoalReminder_control(clock);
    await caseItem2_backfillOnRealWork(clock);
    await caseItem2_backfillOnRealWork_control(clock);
    await caseItem2_backfillSkipsPrimingTurn(clock);
    await caseItem2_backfillSkipsNudgeTurn(clock);
    await caseChannelBackstop_firesOnChannelOriginNoReply(clock);
    await caseChannelBackstop_skipsKeyboardOrigin(clock);
    await caseItem2_backfillFiresOnSecondRequest(clock);
    await caseItem8p2_classifier_ask_operator_converts_unconditionally(clock);
    await caseItem8p2_pause_converts_unconditionally(clock);
    await caseItem8p2_worker_states_fork_opens_ask(clock);
    await caseItem8p2_placeholder_marker_refused(clock);
    await caseItem8p2_memory_quality_self_scoring_vs_proof_backed(clock);
    await caseItem8p2_dead_writer_record_skipped_once(clock);
    await caseItem5_channelWindowRollsOverflow(clock);
    await caseItem5_channelWindowNoDeleteOnAppendFailure();
    await caseItem5_decisionLogCappedAtPush(clock);
    await caseItem5_memoryCappedAtPush(clock);
    await caseSection10_goalDoneClosesSameTurnNoTickBetween(clock);
    await caseSection10_taskUnderActiveParentStillDemotesAndActivates_control(clock);
    await caseSection10_tickPlanningGateStillActivates_control(clock);
    await caseSection10_competingOlderPendingLeafLoses(clock);
    await caseSection10_openAskBlocksActivation(clock);
    await caseSection10FixRound_unrelatedPausedNodeDoesNotBlock(clock);
    await caseSection10FixRound_nudgeCapPauseBlocksActivation(clock);
    await caseSection10FixRound_droppedPlanParentNotActivated(clock);
    await caseSection10FixRound_secondPlanAddLandsUnderRoot(clock);
    await caseSection10FixRound_taskUnderPendingPlanActivated(clock);
    await caseItem81_goalEditDropAllowsBlocked(clock);
    await caseItem81_goalEditDropStillRefusesActive_control(clock);
    await caseNudgeGuard_sentBetweenTurns_control(clock);
    await caseR58f3_nudgeInsideOpenTurnNotSent(clock);
    await caseR58f3_capPausesWithNoAsk(clock);
    await caseR60f3b_reactivationAfterCapPause(clock);
    await caseR117a_concurrentTicksNudgeOnce(clock);
    await caseR117b_openTurnsCloseByIdOnly(clock);
    await caseR118_bookkeepingLandsThoughATurnOpenedUnderTheSubmit(clock);
    await caseR119_aMetNudgeClearsItsOwnCount(clock);
    await caseR119_noRoundMetReachesTheCap_control(clock);
    await caseNudgeFailed_recordedAndTheFloorIsStillSpent(clock);
    await caseItem8p3_ownerStampsTurnStartInHeartbeat(clock);
    await caseSection1_turnStartStampsCommonsEntry(clock);
    await caseSection1_turnCompleteClearsCommonsStamp_control(clock);
    await caseSection1_yieldMidTurnStillClearsCommonsStamp(clock);
    await caseSection1_readerEntryCarriesWorkdirAtSessionStart(clock);
    await caseItem8p3_inboxReportsDeferredWhileTurnRuns(clock);
    await caseItem8p3_deferredNotReportedForStaleOwner(clock);
    await caseSection2_deferredReadsCommonsNotLocalHeartbeat(clock);
    await caseSection12_1_resolveSetsOutcomeAndInboxReturnsIt(clock);
    await caseSection12_2_resolveRefusals(clock);
    await caseSection12_3_sweepKeepsPendingRecord(clock);
    await caseSection12_4_sweepLogsBeforeDeleteAndKeepsOnRefusedAppend(clock);
    await caseSection12_5_windowRollKeepsUnresolvedRecords(clock);
    await caseSection12_6_foreignTurnDoesNotTakeTheStamp(clock);
    await caseSection12_6_budgetNudgeFlagsTheTurnBeforeItsSubmit(clock);
    await caseSection12_7_ownTurnStillTakesTheStamp_control(clock);
    await caseSection12_F1_resolveInsideTheAnsweringTurnKeepsTheReply(clock);
    await caseSection12_F2_windowRollKeepsAnOpenSteersReply(clock);
    await caseSection12_F3_failedNudgeResetsTheNudgedFlag(clock);
    await caseSection12_F4_failedDeliverySubmitLeavesTheRecordDelivered(clock);
    await caseSection12_G1_lateRejectingSubmitLeavesAnAnsweredRecord(clock);
    await caseSection12_G2_sweepAgesOffDeliveryAndKeepsReplyWithRecord(clock);
    await caseSection12_G3_failedAskAnswerSubmitLeavesTheAskClosed(clock);
    await caseSection12_6_pluginTurnDoesNotTakeTheStamp(clock);
    await caseSection12_H1_deliveryTurnOpensAheadOfAQueuedBackstop(clock);
    await caseSection12_H1_parkedPluginTurnAfterAnExternalTurnTakesNoStamp(clock);
    await caseSection12_J1_unmatchedTurnTextTakesNoStamp(clock);
    await caseSection12_J1_continuationTurnTakesNoStamp(clock);
    await caseSection12_J2_droppedPromptDoesNotLeaveTheExternalFlagSet(clock);
    await caseSection12_K1_droppedDeliverySubmitIsHandledLikeARejectedOne(clock);
    await caseSection12_K1_droppedAskAnswerSubmitLeavesTheAskClosed(clock);
    await caseSection12_K1_droppedNudgeSubmitConsumesItsEntry(clock);
    await caseSection12_K2_settledTextMatchesTheDeliveryTurn(clock);
    await caseSection12_K2_submittedTextStillMatchesBeforeTheSubmitSettles(clock);
    await caseSection12_L1_sweptRecordDropsItsDeliveryEntry(clock);
    await caseSection12_L1_resolvedRecordDropsItsDeliveryEntry(clock);
    await caseSection12_L1_withheldLineNamesTheFirstLiveRecord(clock);
    await caseSection12_M1_deliveryQueuedDuringTheWithheldReadIsKept(clock);
    await caseSection12_M1_throwingWithheldReadKeepsEveryEntry(clock);
    await caseSection12_N1_reusedRecordIdDoesNotKeepASweptDeliveryEntry(clock);
    await caseItem8p3_sayCarriesUrgent(clock);
    await caseItem8p3_urgentBreaksIntoRunningTurn(clock);
    await caseItem8p4_repeatedWeaknessBecomesKaizenGoal(clock);
    await caseItem8p4_control_singleEventProducesNeither(clock);
    await caseItem8p4_openKaizenGoalNotDuplicated(clock);
    await caseItem8p4_longTurnsAdjustConfigNotGoal(clock);
    await caseItem8p4_turnOverHourRecorded(clock);
    await caseSection9_unmatchedCompletionLeavesTheStampOnAnOpenTurn(clock);
    await caseSection9_completingOneOfTwoLeavesTheEarlierTurnsStamp(clock);
    await caseSection9_longTurnRecordMeasuresItsOwnTurn(clock);
    await caseSection9_turnStartDerivesTheStampToo(clock);
    await caseSection9_durationMsCountsAnUnmatchedLongTurn(clock);
    await caseS4_peer_consumed(clock);
    await caseS4_peer_send_message_consumed(clock);
    await caseS4_other_origin_passes(clock);
    await caseS5_reader_claims_reader_not_persona(clock);
    await caseS5_identity_joins_live_owner(clock);
    await caseS5_identity_reader_releases_speculative_claim(clock);
    await caseS5_identity_releases_old_persona(clock);
    await caseS6_inbox_carries_ask_id(clock);
    await caseS6_say_unknown_answers_refused(clock);
    await caseS6_say_known_answers_writes_record(clock);
    await caseS6_owner_start_expires_prior_asks(clock);
    await caseS6_reader_start_leaves_asks_open(clock);
    await caseS7_promotion_deferred(clock);
    await caseS8_reader_claim_stays_live(clock);
    await caseS9_cost_cap_opens_ask(clock);
    await caseS9_cost_cap_below(clock);
    await caseS7_reader_does_not_overwrite(clock);
    await caseS13_score_completedTurnRecordsRound(clock);
    await caseS13_errorStreak_threeDeniedTurnsOpenAnAsk(clock);
    await caseS13_gitProbe_dirtyCountSampledOnCadence(clock);
    await caseS13_health_redThenGreenAndTheRedReachesTheTurn(clock);
    await caseS13_stall_pendingPlanActivatesFirstAndNothingActivatesAfterRootComplete(clock);
    await caseS13_planFail_threeFailuresBlockTheRoot(clock);
    await caseS13_identity_takesOverAStaleHolder(clock);
    await caseS13_lessonInject_newestLessonReachesTheNextTurnOnce(clock);
    await caseS13_budget_latchCrossesEachThresholdOnce(clock);
  } finally {
    clock.restore();
  }

  // BM2: Planner variance - test the planner_variance decision
  await caseBM2_planner_variance_four_plans(clock);
  await caseBM2_planner_variance_three_plans(clock);

  // BJ1: Budget fixtures - test the token estimator with different message shapes.
  await caseBJ1_budget_268_shape(clock);
  await caseBJ1_budget_read_failed(clock);

  // BO1-pin: The self-review branch must not return early, so the planning gate runs.
  await caseBO1_pin_selfreview_then_planning(clock);
  await caseBO1_pin_control_no_selfreview(clock);
  await caseItem6_personaOption(clock);
  await caseItem6_personaOption_control(clock);

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failure(s)`);
  process.exit(failures);
}

// ============================================================
// D5b (plan item 5, bullet "an open ask never silences the worker"):
// a reply in the thread closes an open ask with no ask id typed.
// ============================================================
async function caseD5b_replyClosesAsk(clock) {
  console.log("\n=== D5b: a thread reply with no ask id closes the open ask ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "d5b_reply_closes_ask" });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "node-001", kind: "leaf", objective: "Goal 1", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.pendingAskId = "ask-reply-1";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: mySid, epoch: 1, lastSeen: now } }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  const askKey = "ask:default:ask-reply-1";
  h.storeMap.set(askKey, {
    id: "ask-reply-1", key: askKey, persona: "default", askId: "ask-reply-1",
    at: now, nodeId: "node-001", question: "Which branch should I use?", status: "open",
  });

  // Simulate a genuine external turn: a reply typed in the thread, carrying
  // no ask id anywhere in its text.
  const submitH = h.handlers["prompt.submit"];
  await submitH(h.fake, { text: "use the passive-supervisor branch" }, async () => ({}));

  const state = getState(h);
  const askRecord = h.storeMap.get(askKey);
  check("D5b reply: ask record closed (status answered)", askRecord && askRecord.status === "answered");
  check("D5b reply: pendingAskId cleared", !state.pendingAskId);
  const node1 = state.goals.find(g => g.id === "node-001");
  check("D5b reply: node reactivated", node1 && node1.status === "active");
  check("D5b reply: lastAskQuestion recorded on the node", node1 && node1.lastAskQuestion === "Which branch should I use?");
  const decisions = state.decisions || [];
  check("D5b reply: ask_answered_by_reply logged", decisions.some(d => d.action === "ask_answered_by_reply"));
}

// ============================================================
// D5b: a closed question is not re-asked for the same node.
// ============================================================
async function caseD5b_reaskSuppressed(clock) {
  console.log("\n=== D5b: identical question suppressed shortly after closing ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "d5b_reask_suppressed" });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const question = "Should we keep going on this branch? Recommend: yes, continue.";
  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "root", kind: "goal", parentId: null, objective: "Root plan", status: "active", completedRounds: 0, maxRounds: 10, scores: [], createdAt: now - 11000, updatedAt: now - 5000, children: ["node-001"] },
    {
      id: "node-001", kind: "leaf", parentId: "root", objective: "Goal 1", status: "active",
      completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [],
      lastAskQuestion: question, lastAskClosedAt: now - 30_000, // closed 30s ago
    },
  ];
  personaState.activeGoalId = "node-001";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: mySid, epoch: 1, lastSeen: now } }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  // Item 8.2 (Round 36/39): neither classifier verdict opens an ask
  // directly anymore - the reask-suppression guard now runs on the marker
  // path (turn.complete), the only place an ask still opens from the idle
  // tick's own read of the goal. One tick re-activates the reseeded node
  // (the same transitional step every reseed-then-refire case needs) before
  // the worker's turn restates the identical question.
  clock.advance(1000);
  await tickAndSettle(h, clock, 50);

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-reask" }, async () => ({ result: "ok" }));
  const turnCompleteH = h.handlers["turn.complete"];
  await turnCompleteH(h.fake, {
    turnId: "t-reask",
    answer: `ASK: ${question}`,
    reason: "completed",
  }, async () => ({ result: "ok" }));

  const state = getState(h);
  const decisions = state.decisions || [];
  check("D5b suppress: ask_reask_suppressed logged", decisions.some(d => d.action === "ask_reask_suppressed"));
  check("D5b suppress: no ask_opened for the identical question", !decisions.some(d => d.action === "ask_opened"));
  check("D5b suppress: pendingAskId never set", !state.pendingAskId);
  const askKeys = [...h.storeMap.keys()].filter(k => k.startsWith("ask:"));
  check("D5b suppress: no ask record written", askKeys.length === 0);
  const node1 = state.goals.find(g => g.id === "node-001");
  check("D5b suppress: node stays active (not paused again)", node1 && node1.status === "active");
}

// ============================================================
// D5b: an ask open past the reraise window re-raises into the thread once.
// ============================================================
async function caseD5b_reraiseOnce(clock) {
  console.log("\n=== D5b: an open ask re-raises into the thread once ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({
    ...OPTS,
    caseName: "d5b_reraise_once",
    askReraiseWindowMs: 30_000,
    askOperatorWaitMs: 300_000, // well past the reraise window, so this tick only reraises
  });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "node-001", kind: "leaf", objective: "Goal 1", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-001";
  personaState.pendingAskId = "ask-reraise-1";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: mySid, epoch: 1, lastSeen: now } }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  const askKey = "ask:default:ask-reraise-1";
  h.storeMap.set(askKey, {
    id: "ask-reraise-1", key: askKey, persona: "default", askId: "ask-reraise-1",
    at: T0, nodeId: "node-001", question: "Should I keep going on this branch?", status: "open",
  });

  h.resetPromptSubmits();
  clock.advance(35_000); // past the 30s reraise window, well short of the 300s wait
  await tickAndSettle(h, clock, 20);

  const state = getState(h);
  const askRecord = h.storeMap.get(askKey);
  check("D5b reraise: ask stays open (not expired)", askRecord && askRecord.status === "open");
  const decisions = state.decisions || [];
  check("D5b reraise: ask_reraised logged", decisions.some(d => d.action === "ask_reraised"));
  check("D5b reraise: a real turn was submitted into the thread", h.promptSubmits.some(t => t.includes("Should I keep going on this branch?")));

  // A second tick within the window must not reraise again (once only).
  const submitsBefore = h.promptSubmits.length;
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);
  check("D5b reraise: no second reraise on the next tick", h.promptSubmits.length === submitsBefore);
}

// ============================================================
// Item 2 sub-bullet (f016b69): the [NO GOAL] reminder pushes on size,
// so a one-step request is not read as too small for the goal tree.
// ============================================================
async function caseItem2_noGoalReminderPushesOnSize(clock) {
  console.log("\n=== Item 2: [NO GOAL] reminder names size explicitly ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "item2_no_goal_size", stateOpts: { hasActiveLeaf: false } });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  // No goals at all - the exact state the goalconvo suite hit live.
  const submitH = h.handlers["prompt.submit"];
  const result = await submitH(h.fake, { text: "Write a haiku to ocean.txt." }, async () => ({}));

  const blocks = result.context || [];
  const noGoalBlock = blocks.find(b => b.includes("No goal is active"));
  check("item2 size: [NO GOAL] block injected with no goals", !!noGoalBlock);
  check("item2 size: block says size is not the test",
    !!noGoalBlock && noGoalBlock.toLowerCase().includes("size is not the test"));
}

// Control: an active goal already exists - the [NO GOAL] block must not
// appear (the [GOAL TREE] block does instead), proving the reminder is
// scoped to the true no-goal state, not injected unconditionally.
async function caseItem2_noGoalReminder_control(clock) {
  console.log("\n=== Item 2 control: [NO GOAL] absent when a goal is active ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "item2_no_goal_control" });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "node-001", kind: "leaf", title: "Goal 1", objective: "Goal 1", status: "active", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [], notes: [] },
  ];
  personaState.activeGoalId = "node-001";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: mySid, epoch: 1, lastSeen: now } }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  const submitH = h.handlers["prompt.submit"];
  const result = await submitH(h.fake, { text: "keep going" }, async () => ({}));

  const blocks = result.context || [];
  check("item2 control: no [NO GOAL] block when a goal is active", !blocks.some(b => b.includes("No goal is active")));
  check("item2 control: [GOAL TREE] block present instead", blocks.some(b => b.includes("[GOAL TREE]")));
}

// ============================================================
// Item 2 sub-bullet: the turn.complete backstop backfills a goal record
// when a turn does real tool work with no goal tree at all - the shape a
// cost-conscious model produces even after the [NO GOAL] reminder (live-
// confirmed three times, Round 24/26, commit c0e07f5/this section).
// ============================================================
async function caseItem2_backfillOnRealWork(clock) {
  console.log("\n=== Item 2: turn.complete backfills a goal when work happened with no tree ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "item2_backfill", stateOpts: { hasActiveLeaf: false } });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const submitH = h.handlers["prompt.submit"];
  await submitH(h.fake, { text: "Write a haiku to ocean.txt." }, async () => ({}));

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-backfill" }, async () => ({ result: "ok" }));

  // The model wrote the file directly - a real tool call, no goal_create.
  const toolCallH = h.handlers["tool.call"];
  await toolCallH(h.fake, { tool: "Write", turnId: "t-backfill" }, async () => ({ result: "ok" }));

  const turnCompleteH = h.handlers["turn.complete"];
  await turnCompleteH(h.fake, { turnId: "t-backfill", answer: "Wrote the haiku.", reason: "completed" }, async () => ({ result: "ok" }));

  const state = getState(h);
  check("item2 backfill: a root node now exists", state.goals.length === 1);
  check("item2 backfill: root is marked complete", state.goals[0]?.status === "complete");
  const decisions = state.decisions || [];
  check("item2 backfill: create decision logged", decisions.some(d => d.action === "create" && d.detail.includes("backfilled")));
  check("item2 backfill: root_complete decision logged", decisions.some(d => d.action === "root_complete" && d.detail.includes("backfilled")));
}

// Control: the same shape, but the turn used no tool at all (pure chat) -
// the backstop must not fabricate a goal for a turn that did nothing.
async function caseItem2_backfillOnRealWork_control(clock) {
  console.log("\n=== Item 2 control: no backfill when the turn used no tool ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "item2_backfill_control", stateOpts: { hasActiveLeaf: false } });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const submitH = h.handlers["prompt.submit"];
  await submitH(h.fake, { text: "What's your favorite color?" }, async () => ({}));

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-nochat" }, async () => ({ result: "ok" }));

  // No tool.call fired - a pure conversational turn.

  const turnCompleteH = h.handlers["turn.complete"];
  await turnCompleteH(h.fake, { turnId: "t-nochat", answer: "I like blue.", reason: "completed" }, async () => ({ result: "ok" }));

  const state = getState(h);
  check("item2 backfill control: no goal fabricated for a no-tool turn", state.goals.length === 0);
}

// Round 28: the backstop must never fire on a priming turn (a channel-
// attached passive child's own acknowledgment, whose only tool call is
// reply) - the exact shape that would otherwise restart-loop the
// supervisor on a fabricated root_complete.
async function caseItem2_backfillSkipsPrimingTurn(clock) {
  console.log("\n=== Item 2 Round 28: no backfill on a priming turn ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "item2_backfill_priming", stateOpts: { hasActiveLeaf: false } });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const submitH = h.handlers["prompt.submit"];
  await submitH(h.fake, { text: "[SUPERVISOR-PRIMING] You are the passive supervisor, waiting for a goal or a steering message from the operator. Reply now with one short line acknowledging you are ready, then wait." }, async () => ({}));

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-priming" }, async () => ({ result: "ok" }));

  // The priming turn's only tool call: the channel's reply tool.
  const toolCallH = h.handlers["tool.call"];
  await toolCallH(h.fake, { tool: "mcp__plugin_relay_channel-relay__reply", turnId: "t-priming" }, async () => ({ result: "ok" }));

  const turnCompleteH = h.handlers["turn.complete"];
  await turnCompleteH(h.fake, { turnId: "t-priming", answer: "Ready.", reason: "completed" }, async () => ({ result: "ok" }));

  const state = getState(h);
  check("item2 Round28: no goal fabricated on the priming turn", state.goals.length === 0);
}

// Round 28: the backstop must never fire on a nudge turn, even if the
// nudged turn happens to use a real work tool.
async function caseItem2_backfillSkipsNudgeTurn(clock) {
  console.log("\n=== Item 2 Round 28: no backfill on a nudge turn ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  // A real nudge only ever fires with an active leaf (the idle gate needs
  // one to classify against), which means a real root is always pending
  // or active too - so wasNudged's own exclusion is defense-in-depth on
  // top of noActiveRoot here, not independently isolable through the
  // production nudge path. This proves the whole path stays quiet across
  // a real nudge-and-answer cycle rather than isolating wasNudged alone.
  const h = await createTickHarness({ ...OPTS, caseName: "item2_backfill_nudge" });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  h.setClassifyValue("nudge");
  clock.advance(130_000);
  await tickAndSettle(h, clock, 50);
  check("item2 Round28: nudge_sent fired (setup sanity)", getDecisions(h).some(d => d.action === "nudge_sent"));

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-nudge" }, async () => ({ result: "ok" }));
  const toolCallH = h.handlers["tool.call"];
  await toolCallH(h.fake, { tool: "Write", turnId: "t-nudge" }, async () => ({ result: "ok" }));
  const turnCompleteH = h.handlers["turn.complete"];
  await turnCompleteH(h.fake, { turnId: "t-nudge", answer: "Working on it.", reason: "completed" }, async () => ({ result: "ok" }));

  const state = getState(h);
  check("item2 Round28: no extra goal fabricated on the nudge-answering turn", state.goals.length === 2);
}

// Round 28: the trigger condition is "no active root", not
// "goals.length === 0" - item 4's second conversational request arrives
// with the first (completed) root still present in the array.
async function caseItem2_backfillFiresOnSecondRequest(clock) {
  console.log("\n=== Item 2 Round 28: backfill fires on a second request after a completed root ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "item2_backfill_second_request" });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const personaState = buildPersonaState(mySid, now);
  personaState.goals = [
    { id: "root-1", kind: "root", parentId: null, title: "First goal", objective: "First goal", status: "complete", completedRounds: 1, maxRounds: 1, scores: [], createdAt: now - 20000, updatedAt: now - 10000, children: [], notes: [] },
  ];
  personaState.activeGoalId = null;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: mySid, epoch: 1, lastSeen: now } }));

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  const submitH = h.handlers["prompt.submit"];
  await submitH(h.fake, { text: "Now write a limerick to limerick.txt." }, async () => ({}));

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-second" }, async () => ({ result: "ok" }));
  const toolCallH = h.handlers["tool.call"];
  await toolCallH(h.fake, { tool: "Write", turnId: "t-second" }, async () => ({ result: "ok" }));
  const turnCompleteH = h.handlers["turn.complete"];
  await turnCompleteH(h.fake, { turnId: "t-second", answer: "Wrote the limerick.", reason: "completed" }, async () => ({ result: "ok" }));

  const state = getState(h);
  check("item2 Round28: a second root was backfilled (goals.length was 1, not 0, before this turn)",
    state.goals.length === 1 && state.goals[0].id !== "root-1" && state.goals[0].status === "complete");
}

// ============================================================
// Steer 68/69: a channel-opened turn that answers with no reply-tool
// call gets that answer sent through the reply tool directly by the
// plugin (hooks/index.ts turn.complete, currentTurnIsChannelOrigin).
// ============================================================
async function caseChannelBackstop_firesOnChannelOriginNoReply(clock) {
  console.log("\n=== Channel backstop: a channel-opened turn with no reply call gets backfilled ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "channel_backstop_fires" });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const submitH = h.handlers["prompt.submit"];
  await submitH(h.fake, { text: "What's the status?", origin: { kind: "channel" } }, async () => ({}));

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-channel-noreply" }, async () => ({ result: "ok" }));

  // The model answered in plain text; it never called the reply tool.

  const turnCompleteH = h.handlers["turn.complete"];
  await turnCompleteH(h.fake, { turnId: "t-channel-noreply", answer: "All green.", reason: "completed" }, async () => ({ result: "ok" }));

  const state = getState(h);
  const decisions = state.decisions || [];
  check("channel backstop: exactly one reply tool.call recorded", h.toolCalls.length === 1);
  check("channel backstop: the recorded call is the reply tool with the model's answer",
    h.toolCalls[0]?.tool === "mcp__plugin_relay_channel-relay__reply" && h.toolCalls[0]?.message === "All green.");
  check("channel backstop: one channel_reply_backfilled decision logged",
    decisions.filter(d => d.action === "channel_reply_backfilled").length === 1);
}

// Control: the same shape, but the turn opened from the keyboard, not the
// channel - the backstop must never fire, and never call reply, for an
// ordinary interactive turn that simply chose not to call a tool.
async function caseChannelBackstop_skipsKeyboardOrigin(clock) {
  console.log("\n=== Channel backstop control: a keyboard-opened turn is never backfilled ===");
  clock.set(T0);
  const mySid = SESSION_ID;
  const now = T0;

  const h = await createTickHarness({ ...OPTS, caseName: "channel_backstop_control" });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });

  const submitH = h.handlers["prompt.submit"];
  await submitH(h.fake, { text: "What's the status?", origin: { kind: "keyboard" } }, async () => ({}));

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-keyboard-noreply" }, async () => ({ result: "ok" }));

  const turnCompleteH = h.handlers["turn.complete"];
  await turnCompleteH(h.fake, { turnId: "t-keyboard-noreply", answer: "All green.", reason: "completed" }, async () => ({ result: "ok" }));

  const state = getState(h);
  const decisions = state.decisions || [];
  check("channel backstop control: no reply tool.call recorded", h.toolCalls.length === 0);
  check("channel backstop control: no channel_reply_backfilled decision logged",
    decisions.filter(d => d.action === "channel_reply_backfilled").length === 0);
}

// ============================================================
// Item 8.3: a busy worker is reachable
// ============================================================

// Seeds an owner harness: mySid holds the persona in commons, the persona
// store names it, and the heartbeat sidecar carries its live entry.
async function seedOwnerHarness(caseName, now) {
  const mySid = SESSION_ID;
  const h = await createTickHarness({ ...OPTS, caseName });
  h.storeMap.set(`commons:${mySid}`, {
    sessionId: mySid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(mySid, now) }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: mySid, epoch: 1, lastSeen: now },
  }));
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});
  return h;
}

function readHeartbeat(h) {
  const raw = h.fsMap.get(".agentic-heartbeat.json");
  return raw ? JSON.parse(raw) : {};
}

// The heartbeat tick's own read-modify-write of the sidecar keeps the
// turnStartedAt stamp while the turn runs rather than clobbering it - this is
// the cross-process signal a reader's agentic_inbox reads mid-turn. The stamp
// at turn.start and its clearing at turn.complete are the Section 9 cases'.
async function caseItem8p3_ownerStampsTurnStartInHeartbeat(clock) {
  console.log("\n=== Item 8.3: the heartbeat tick keeps turnStartedAt while the turn runs ===");
  clock.set(T0);
  const now = T0;
  const h = await seedOwnerHarness("item8p3_turn_stamp", now);

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-busy" }, async () => ({ result: "ok" }));

  // The heartbeat tick fires mid-turn and must keep the stamp, not clobber it.
  clock.advance(30_000);
  await fireHeartbeat(h);
  const midTurn = readHeartbeat(h).default;
  check("item8.3 stamp: heartbeat tick refreshed lastSeen", midTurn?.lastSeen === now + 30_000);
  check("item8.3 stamp: heartbeat tick kept turnStartedAt", midTurn?.turnStartedAt === now);
}

// Section 1: the owner's commons entry carries the turn stamp and the
// session's workdir, so a session in another working directory can read this
// one as busy. The heartbeat file cannot give it that, being cwd-relative.
async function caseSection1_turnStartStampsCommonsEntry(clock) {
  console.log("\n=== Section 1: turn.start stamps turnStartedAt and workdir onto the commons entry ===");
  clock.set(T0);
  const now = T0;
  const h = await seedOwnerHarness("section1_commons_stamp", now);

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-commons" }, async () => ({ result: "ok" }));
  const entry = h.storeMap.get(`commons:${SESSION_ID}`);
  check("section1 stamp: commons entry carries turnStartedAt at turn.start", entry?.turnStartedAt === now, entry);
  check("section1 stamp: commons entry carries the session's workdir", entry?.workdir === HARNESS_CWD, entry);
  check("section1 stamp: the persona claim is untouched", entry?.claims?.some(c => c.resource === "persona:default") === true, entry);

  // The live branch: session.start carries cwd on the event, so the fallback
  // $.session.cwd() is not consulted. createTickHarness already fired
  // session.start once at creation, so this re-fire on the same closure
  // inherits the creation-time claims; harmless here, only workdir is read.
  const startH = h.handlers["session.start"];
  await startH(h.fake, { cwd: "D:/other-root" }, () => {});
  await turnStartH(h.fake, { turnId: "t-commons-2" }, async () => ({ result: "ok" }));
  const entry2 = h.storeMap.get(`commons:${SESSION_ID}`);
  check("section1 stamp: workdir comes from the event's cwd when it carries one", entry2?.workdir === "D:/other-root", entry2);
}

// Control: turn.complete clears the commons entry's copy back to null, as it
// clears the heartbeat file's own stamp, and leaves the workdir in place.
async function caseSection1_turnCompleteClearsCommonsStamp_control(clock) {
  console.log("\n=== Section 1 control: turn.complete clears the commons entry's turnStartedAt ===");
  clock.set(T0);
  const now = T0;
  const h = await seedOwnerHarness("section1_commons_clear", now);

  const turnStartH = h.handlers["turn.start"];
  const turnCompleteH = h.handlers["turn.complete"];
  await turnStartH(h.fake, { turnId: "t-commons" }, async () => ({ result: "ok" }));
  clock.advance(5_000);
  await turnCompleteH(h.fake, { turnId: "t-commons", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  const entry = h.storeMap.get(`commons:${SESSION_ID}`);
  check("section1 control: commons turnStartedAt is null after turn.complete", entry?.turnStartedAt === null, entry);
  check("section1 control: workdir unchanged after turn.complete", entry?.workdir === HARNESS_CWD, entry);
}

// A session that yields ownership mid-turn still clears its commons stamp at
// turn.complete. yieldNow writes the mid-turn stamp through releaseResource,
// and the reader tick's claimReaderRole republishes the still-open turn, so an
// owner-gated stamp at turn.complete would strand the non-null value. The yield is
// the heartbeat tick's store check: the persona store names another session.
async function caseSection1_yieldMidTurnStillClearsCommonsStamp(clock) {
  console.log("\n=== Section 1: a session that yields mid-turn still clears its commons turnStartedAt ===");
  clock.set(T0);
  const now = T0;
  const h = await seedOwnerHarness("section1_commons_yield_clear", now);

  const turnStartH = h.handlers["turn.start"];
  const turnCompleteH = h.handlers["turn.complete"];
  await turnStartH(h.fake, { turnId: "t-yield" }, async () => ({ result: "ok" }));
  const midTurn = h.storeMap.get(`commons:${SESSION_ID}`);
  check("section1 yield: commons entry carries turnStartedAt before the yield (setup sanity)", midTurn?.turnStartedAt === now, midTurn);

  // Another session takes the persona in the store; the heartbeat tick yields.
  clock.advance(10_000);
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState("foreign-owner-001", now + 10_000) }));
  await fireHeartbeat(h);
  const yieldLog = h.fsMap.get(".agentic-yields.log") ?? "";
  check("section1 yield: the session yielded on the heartbeat tick (precondition)", yieldLog.includes(`"yielded":"${SESSION_ID}"`) && yieldLog.includes(`"winner":"foreign-owner-001"`), yieldLog);
  const afterYield = h.storeMap.get(`commons:${SESSION_ID}`);
  check("section1 yield: the persona claim was released (precondition)", afterYield?.claims?.some(c => c.resource === "persona:default") === false, afterYield);

  clock.advance(5_000);
  await turnCompleteH(h.fake, { turnId: "t-yield", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  const entry = h.storeMap.get(`commons:${SESSION_ID}`);
  check("section1 yield: commons turnStartedAt is null after turn.complete as a reader", entry?.turnStartedAt === null, entry);
}

// A reader session's commons entry carries its workdir from session.start and
// its turn stamp from turn.start, on the entry claimReaderRole writes. The
// second half pins the recreation path: a peer's gcStaleClaims can delete the
// reader's entry mid-turn, and the reader tick's claimReaderRole recreates it,
// which must carry the open turn's stamp rather than a fresh null.
async function caseSection1_readerEntryCarriesWorkdirAtSessionStart(clock) {
  console.log("\n=== Section 1: a reader's commons entry carries workdir at session.start and the turn stamp through recreation ===");
  clock.set(T0);
  const now = T0;
  const h = await joinAsReader("section1_reader_meta", now, "meta-owner-001", {});

  const atStart = h.storeMap.get(`commons:${SESSION_ID}`);
  check("section1 reader: joined as a reader at session.start (precondition)", atStart?.claims?.some(c => c.resource === "reader:default") === true, atStart);
  check("section1 reader: commons entry carries the session's workdir at session.start", atStart?.workdir === HARNESS_CWD, atStart);
  check("section1 reader: commons turnStartedAt is null between turns at session.start", atStart?.turnStartedAt === null, atStart);

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-reader" }, async () => ({ result: "ok" }));
  const midTurn = h.storeMap.get(`commons:${SESSION_ID}`);
  check("section1 reader: commons entry carries turnStartedAt at turn.start", midTurn?.turnStartedAt === now, midTurn);

  // A peer's gc deleted the entry mid-turn; the reader tick recreates it.
  h.storeMap.delete(`commons:${SESSION_ID}`);
  clock.advance(1_000);
  await fireHeartbeat(h);
  const recreated = h.storeMap.get(`commons:${SESSION_ID}`);
  check("section1 reader: the reader tick recreated the entry (precondition)", recreated?.claims?.some(c => c.resource === "reader:default") === true, recreated);
  check("section1 reader: the recreated entry carries the open turn's turnStartedAt", recreated?.turnStartedAt === now, recreated);
  check("section1 reader: the recreated entry carries the session's workdir", recreated?.workdir === HARNESS_CWD, recreated);
}

// Writes otherSid's commons entry holding persona:default, live at now.
// commonsExtra is merged over it (a turn stamp, a workdir, an aged lastSeen).
// Written whole rather than merged into an existing entry, because a stale
// entry is gc'd by any readAllClaims and may no longer be there.
function seedOwnerCommons(h, otherSid, now, commonsExtra) {
  h.storeMap.set(`commons:${otherSid}`, {
    sessionId: otherSid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 1000 }],
    ...commonsExtra,
  });
}

// Joins this session to a persona otherSid owns (commons, persona store,
// heartbeat) as a reader at session.start. hbExtra is merged into the owner's
// heartbeat entry, commonsExtra into the owner's commons entry. createTickHarness
// fired session.start once at creation as the owner, so that entry is dropped
// first: a real reader starts with none, and the entry read after the join is
// the one the reader path wrote.
async function joinAsReader(caseName, now, otherSid, hbExtra, commonsExtra = {}) {
  const h = await createTickHarness({ ...OPTS, caseName });
  h.storeMap.delete(`commons:${SESSION_ID}`);
  seedOwnerCommons(h, otherSid, now, commonsExtra);
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(otherSid, now) }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: otherSid, epoch: 1, lastSeen: now, ...hbExtra },
  }));
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});
  return h;
}

// Seeds a reader harness: joinAsReader, then this session's own commons entry
// is replaced with a bare live reader claim.
async function seedReaderHarness(caseName, now, otherSid, hbExtra, commonsExtra = {}) {
  const h = await joinAsReader(caseName, now, otherSid, hbExtra, commonsExtra);
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "reader:default", claimedAt: now }],
  });
  return h;
}

// A record still pending while the owner's commons entry shows a turn in
// flight reads back from agentic_inbox as deferred, with the turn's running
// time. This is the same-repo control for Section 2: the owner's heartbeat
// file and its commons entry agree. Control: the same record with no turn in
// flight carries no deferred field.
async function caseItem8p3_inboxReportsDeferredWhileTurnRuns(clock) {
  console.log("\n=== Item 8.3: agentic_inbox reports a deferred record and the turn's running time ===");
  clock.set(T0);
  const now = T0;
  const turnStartedAt = now - 120_000;

  const h = await seedReaderHarness("item8p3_deferred", now, "busy-owner-001", { turnStartedAt }, { turnStartedAt, workdir: HARNESS_CWD });
  const toolCallH = h.handlers["tool.call"];
  const say = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_say", text: "are you there?" }, async () => ({ result: "passthrough" }));
  check("item8.3 deferred: agentic_say accepted (setup sanity)", say.result !== undefined);

  const inbox = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_inbox" }, async () => ({ result: "passthrough" }));
  const parsed = inbox.result ? JSON.parse(inbox.result) : { inbox: [] };
  const rec = parsed.inbox[0];
  check("item8.3 deferred: record still pending", rec?.status === "pending");
  check("item8.3 deferred: record marked deferred", rec?.deferred === true);
  check("item8.3 deferred: turnRunningMs is the owner's turn age", rec?.turnRunningMs === 120_000);

  // Control: owner commons entry with no turn in flight.
  const hc = await seedReaderHarness("item8p3_deferred_control", now, "idle-owner-001", {}, { turnStartedAt: null, workdir: HARNESS_CWD });
  const toolCallHc = hc.handlers["tool.call"];
  await toolCallHc(hc.fake, { tool: "mcp__agentic-plugin__agentic_say", text: "are you there?" }, async () => ({ result: "passthrough" }));
  const inboxC = await toolCallHc(hc.fake, { tool: "mcp__agentic-plugin__agentic_inbox" }, async () => ({ result: "passthrough" }));
  const recC = inboxC.result ? JSON.parse(inboxC.result).inbox[0] : undefined;
  check("item8.3 deferred control: record pending with no turn in flight", recC?.status === "pending");
  check("item8.3 deferred control: no deferred field", recC?.deferred === undefined);
  check("item8.3 deferred control: no turnRunningMs field", recC?.turnRunningMs === undefined);
}

// A turnStartedAt left behind by an owner killed mid-turn must not read as
// "held behind a running turn": the deferred report also needs the owner's
// commons lastSeen within staleAfterMs of now. Control: the same stamp
// with a fresh lastSeen does report deferred.
async function caseItem8p3_deferredNotReportedForStaleOwner(clock) {
  console.log("\n=== Item 8.3: no deferred report when the owner's commons entry is stale ===");
  clock.set(T0);
  const now = T0;
  const otherSid = "killed-owner-001";

  // Join as a reader against a live owner, then age its commons entry: the
  // entry now shows a turn stamp from an owner that stopped stamping
  // 200s ago (staleAfterMs is 90s).
  const h = await seedReaderHarness("item8p3_deferred_stale", now, otherSid, {});
  const toolCallH = h.handlers["tool.call"];
  await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_say", text: "anyone home?" }, async () => ({ result: "passthrough" }));
  seedOwnerCommons(h, otherSid, now, { lastSeen: now - 200_000, turnStartedAt: now - 300_000, workdir: HARNESS_CWD });
  const inbox = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_inbox" }, async () => ({ result: "passthrough" }));
  const rec = inbox.result ? JSON.parse(inbox.result).inbox[0] : undefined;
  check("item8.3 stale owner: record still pending (setup sanity)", rec?.status === "pending");
  check("item8.3 stale owner: no deferred field", rec?.deferred === undefined);
  check("item8.3 stale owner: no turnRunningMs field", rec?.turnRunningMs === undefined);

  // Control: same stamp, commons entry fresh. Written whole: the stale entry
  // was gc'd by the inbox read above.
  seedOwnerCommons(h, otherSid, now, { turnStartedAt: now - 300_000, workdir: HARNESS_CWD });
  const inboxC = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_inbox" }, async () => ({ result: "passthrough" }));
  const recC = inboxC.result ? JSON.parse(inboxC.result).inbox[0] : undefined;
  check("item8.3 stale owner control: fresh commons entry reports deferred", recC?.deferred === true);
  check("item8.3 stale owner control: fresh commons entry reports turnRunningMs", recC?.turnRunningMs === 300_000);
}

// The deferred check reads the addressed persona's own commons entry, which
// is machine-global, rather than the caller's cwd-relative heartbeat file.
// First half, the cross-repo shape: the owner's commons entry carries a turn
// stamp and another repo's workdir while the caller's local heartbeat file
// knows of no turn; the record is deferred. Second half, the inverse: the
// local heartbeat file carries a stamp the commons entry does not; the record
// is not deferred, because the local file says nothing about the owner.
async function caseSection2_deferredReadsCommonsNotLocalHeartbeat(clock) {
  console.log("\n=== Section 2: the deferred check reads the owner's commons entry, not the local heartbeat file ===");
  clock.set(T0);
  const now = T0;

  const h = await seedReaderHarness("section2_cross_repo", now, "remote-owner-001",
    { turnStartedAt: null },
    { turnStartedAt: now - 120_000, workdir: "D:/other-repo" });
  const toolCallH = h.handlers["tool.call"];
  await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_say", text: "status?" }, async () => ({ result: "passthrough" }));
  const inbox = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_inbox" }, async () => ({ result: "passthrough" }));
  const rec = inbox.result ? JSON.parse(inbox.result).inbox[0] : undefined;
  check("section2 cross-repo: record still pending (setup sanity)", rec?.status === "pending");
  check("section2 cross-repo: record deferred from the owner's commons stamp", rec?.deferred === true);
  check("section2 cross-repo: turnRunningMs is the commons stamp's age", rec?.turnRunningMs === 120_000);

  // Inverse: only the caller's local heartbeat file shows a turn.
  const hl = await seedReaderHarness("section2_local_only", now, "idle-owner-002",
    { turnStartedAt: now - 60_000 },
    { turnStartedAt: null, workdir: "D:/other-repo" });
  const toolCallHl = hl.handlers["tool.call"];
  await toolCallHl(hl.fake, { tool: "mcp__agentic-plugin__agentic_say", text: "status?" }, async () => ({ result: "passthrough" }));
  const inboxL = await toolCallHl(hl.fake, { tool: "mcp__agentic-plugin__agentic_inbox" }, async () => ({ result: "passthrough" }));
  const recL = inboxL.result ? JSON.parse(inboxL.result).inbox[0] : undefined;
  check("section2 local-only: record still pending (setup sanity)", recL?.status === "pending");
  check("section2 local-only: no deferred field from the local heartbeat stamp", recL?.deferred === undefined);
  check("section2 local-only: no turnRunningMs field", recL?.turnRunningMs === undefined);
}

// ============================================================
// Section 12: inbox upkeep (a handled state, cleanup that never loses
// unread work, a reply link only the plugin's own turn can take)
// ============================================================

// Seeds one inbox record for the default persona and returns its store key.
// The id follows writeInboxRecord's shape, <persona>-<writer>-<seq>.
function seedInboxRecord(h, writerSid, seq, fields) {
  const key = `inbox:default:${writerSid}:${seq}`;
  h.storeMap.set(key, { id: `default-${writerSid}-${seq}`, key, from: writerSid, kind: "say", text: `message ${seq}`, ...fields });
  return key;
}

function readStoreRecord(h, key) {
  const raw = h.storeMap.get(key);
  if (!raw) return undefined;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// An owner harness on the default makeState tree (an active leaf, so the
// tick can reach the nudge path), holding the persona in commons, with one
// pending record from a writer holding a live reader claim. `extraOpts`
// rides into the plugin's options over OPTS.
async function seedOwnerWithPendingRecord(caseName, now, writerSid, extraOpts = {}) {
  const h = await createTickHarness({ ...OPTS, ...extraOpts, caseName });
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  seedReaderClaim(h, writerSid, now);
  const key = seedInboxRecord(h, writerSid, 1, { at: now - 5000, status: "pending" });
  return { h, key, id: `default-${writerSid}-1` };
}

// Bullet 1: agentic_resolve on a delivered or answered record addressed to
// the owner's persona sets status resolved with the outcome and note, and the
// sender reads them back through agentic_inbox. The sender side is a reader
// harness holding the same records under its own session id.
async function caseSection12_1_resolveSetsOutcomeAndInboxReturnsIt(clock) {
  console.log("\n=== Section 12 bullet 1: agentic_resolve marks a record resolved and agentic_inbox returns the outcome ===");
  clock.set(T0);
  const now = T0;
  const h = await seedOwnerHarness("section12_1_resolve", now);
  const deliveredKey = seedInboxRecord(h, SESSION_ID, 1, { at: now - 5000, status: "delivered", deliveredAt: now - 4000, turnId: "t-d" });
  const answeredKey = seedInboxRecord(h, SESSION_ID, 2, { at: now - 3000, status: "answered", deliveredAt: now - 2000, turnId: "t-a" });
  const toolCallH = h.handlers["tool.call"];

  const r1 = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id: `default-${SESSION_ID}-1`, outcome: "done", note: "shipped" }, async () => ({ result: "passthrough" }));
  check("section12.1: resolve on a delivered record accepted", r1.deny === undefined && r1.result !== undefined && r1.result !== "passthrough", r1);
  const d = readStoreRecord(h, deliveredKey);
  check("section12.1: delivered record now resolved", d?.status === "resolved", d);
  check("section12.1: outcome, note and resolvedAt written", d?.outcome === "done" && d?.note === "shipped" && d?.resolvedAt === now, d);

  const r2 = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id: `default-${SESSION_ID}-2`, outcome: "declined", note: "" }, async () => ({ result: "passthrough" }));
  check("section12.1: resolve on an answered record accepted", r2.deny === undefined && r2.result !== undefined && r2.result !== "passthrough", r2);
  const a = readStoreRecord(h, answeredKey);
  check("section12.1: answered record now resolved with outcome declined", a?.status === "resolved" && a?.outcome === "declined" && a?.note === "", a);
  check("section12.1: one operator_resolved decision per resolve", countAction(getDecisions(h), "operator_resolved") === 2);

  const hr = await seedReaderHarness("section12_1_inbox", now, "owner-001", {}, { turnStartedAt: null, workdir: HARNESS_CWD });
  hr.storeMap.set(deliveredKey, d);
  hr.storeMap.set(answeredKey, a);
  const inbox = await hr.handlers["tool.call"](hr.fake, { tool: "mcp__agentic-plugin__agentic_inbox" }, async () => ({ result: "passthrough" }));
  const recs = inbox.result ? JSON.parse(inbox.result).inbox : [];
  const first = recs.find((r) => r.id === `default-${SESSION_ID}-1`);
  const second = recs.find((r) => r.id === `default-${SESSION_ID}-2`);
  check("section12.1: agentic_inbox returns outcome, note and resolvedAt for the done record",
    first?.status === "resolved" && first?.outcome === "done" && first?.note === "shipped" && first?.resolvedAt === now, first);
  check("section12.1: agentic_inbox returns the declined outcome too",
    second?.status === "resolved" && second?.outcome === "declined" && second?.resolvedAt === now, second);
}

// Bullet 2: agentic_resolve is refused for a pending record, for a record
// addressed to another persona, for a skipped record (a dead writer's record
// has nothing to resolve), and for a caller that is not the owner. Each
// refused record is unchanged afterwards.
async function caseSection12_2_resolveRefusals(clock) {
  console.log("\n=== Section 12 bullet 2: agentic_resolve refuses pending, other-persona, skipped and non-owner calls ===");
  clock.set(T0);
  const now = T0;
  const h = await seedOwnerHarness("section12_2_refusals", now);
  const pendingKey = seedInboxRecord(h, "writer-p", 1, { at: now - 5000, status: "pending" });
  const skippedKey = seedInboxRecord(h, "writer-s", 1, { at: now - 5000, status: "skipped" });
  const otherKey = "inbox:other:writer-o:1";
  h.storeMap.set(otherKey, { id: "other-writer-o-1", key: otherKey, from: "writer-o", at: now - 5000, text: "for another persona", kind: "say", status: "delivered", deliveredAt: now - 4000 });
  const toolCallH = h.handlers["tool.call"];

  const rp = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id: "default-writer-p-1", outcome: "done", note: "" }, async () => ({ result: "passthrough" }));
  check("section12.2: pending record refused, and the refusal says pending", typeof rp.deny === "string" && rp.deny.includes("pending"), rp);
  check("section12.2: pending record unchanged", readStoreRecord(h, pendingKey)?.status === "pending");

  const ro = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id: "other-writer-o-1", outcome: "done", note: "" }, async () => ({ result: "passthrough" }));
  check("section12.2: other-persona record refused as not addressed to this persona", typeof ro.deny === "string" && ro.deny.includes("default"), ro);
  check("section12.2: other-persona record unchanged", readStoreRecord(h, otherKey)?.status === "delivered");

  const rs = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id: "default-writer-s-1", outcome: "done", note: "" }, async () => ({ result: "passthrough" }));
  check("section12.2: skipped record refused, and the refusal says skipped", typeof rs.deny === "string" && rs.deny.includes("skipped"), rs);
  check("section12.2: skipped record unchanged", readStoreRecord(h, skippedKey)?.status === "skipped");
  check("section12.2: no operator_resolved decision logged", countAction(getDecisions(h), "operator_resolved") === 0);

  const longKey = seedInboxRecord(h, "writer-l", 1, { at: now - 5000, status: "delivered", deliveredAt: now - 4000 });
  const rl = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id: "default-writer-l-1", outcome: "done", note: "x".repeat(2001) }, async () => ({ result: "passthrough" }));
  check("section12.2: a note over 2000 characters is refused, and the refusal names the bound", typeof rl.deny === "string" && rl.deny.includes("2000"), rl);
  check("section12.2: the over-length record unchanged", readStoreRecord(h, longKey)?.status === "delivered" && readStoreRecord(h, longKey)?.note === undefined);
  const rb = await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id: "default-writer-l-1", outcome: "done", note: "y".repeat(2000) }, async () => ({ result: "passthrough" }));
  check("section12.2: a note of exactly 2000 characters is accepted (control)", rb.deny === undefined && readStoreRecord(h, longKey)?.note?.length === 2000, rb);

  const hr = await seedReaderHarness("section12_2_reader", now, "owner-002", {}, { turnStartedAt: null, workdir: HARNESS_CWD });
  const readerKey = seedInboxRecord(hr, SESSION_ID, 1, { at: now - 5000, status: "delivered", deliveredAt: now - 4000 });
  const rr = await hr.handlers["tool.call"](hr.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id: `default-${SESSION_ID}-1`, outcome: "done", note: "" }, async () => ({ result: "passthrough" }));
  check("section12.2: a reader session is refused as not the owner", typeof rr.deny === "string" && rr.deny.includes("owner"), rr);
  check("section12.2: the reader's record unchanged", readStoreRecord(hr, readerKey)?.status === "delivered");
}

// Bullet 3: a pending record older than the TTL survives the sweep. Direct
// call against a mini store, as the item 5 append-failure case does: the
// tick's drain consumes or skips every pending record before the sweep runs
// on the same tick, so no tick-driven path puts a pending record in front of
// the sweep. Control: an old delivered record is swept, and its log line
// carries sweptAt.
async function caseSection12_3_sweepKeepsPendingRecord(clock) {
  console.log("\n=== Section 12 bullet 3: the TTL sweep never deletes a pending record ===");
  clock.set(T0);
  const now = T0;
  const { sweepExpiredRecords } = await import("../hooks/operator.ts?case=section12_direct_unit");
  const pendingKey = "inbox:default:writer-p:1";
  const deliveredKey = "inbox:default:writer-d:1";
  const freshKey = "inbox:default:writer-f:1";
  const askKey = "ask:default:ask-old-1";
  const store = makeMiniStore({
    [pendingKey]: { id: "default-writer-p-1", key: pendingKey, from: "writer-p", at: now - 10_000, text: "old and unread", kind: "say", status: "pending" },
    [deliveredKey]: { id: "default-writer-d-1", key: deliveredKey, from: "writer-d", at: now - 9_000, text: "old and read", kind: "say", status: "delivered", deliveredAt: now - 8_000 },
    [freshKey]: { id: "default-writer-f-1", key: freshKey, from: "writer-f", at: now - 100, text: "fresh", kind: "say", status: "pending" },
    [askKey]: { id: "ask-old-1", ownerSessionId: "owner-old", at: now - 9_500, nodeId: "node-old", question: "old question", status: "expired" },
  });
  const appended = [];
  const swept = await sweepExpiredRecords(store, "default", async (lines) => { appended.push(...lines); }, 1000);
  check("section12.3: old pending record still in the store", store._map.has(pendingKey));
  check("section12.3: fresh pending record still in the store", store._map.has(freshKey));
  check("section12.3 control: old delivered record swept", !store._map.has(deliveredKey));
  check("section12.3 control: old ask record swept", !store._map.has(askKey));
  check("section12.3 control: swept count is 2", swept === 2, swept);
  const lines = appended.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  check("section12.3 control: the swept inbox record was appended with sweptAt and its key",
    lines.some((l) => l && l.kind === "inbox" && l.key === deliveredKey && typeof l.sweptAt === "number" && l.record?.id === "default-writer-d-1"), appended);
  check("section12.3 control: the swept ask record was appended with kind ask",
    lines.length === 2 && lines.some((l) => l && l.kind === "ask" && l.key === askKey && typeof l.sweptAt === "number" && l.record?.id === "ask-old-1"), appended);
}

// Bullet 4: every record the TTL sweep removes reaches the channel log first,
// and a refused append leaves it in the store with a decision naming the
// refusal. Driven through the tick: the channel log write is made to throw
// once, at the sweep cadence, then the next cadence sweeps cleanly.
async function caseSection12_4_sweepLogsBeforeDeleteAndKeepsOnRefusedAppend(clock) {
  console.log("\n=== Section 12 bullet 4: the TTL sweep appends before it deletes, and keeps the record on a refused append ===");
  clock.set(T0);
  const now = T0;
  const DAY = 86_400_000;
  const h = await seedOwnerHarness("section12_4_sweep_log", now);
  const key = seedInboxRecord(h, "writer-old", 1, { at: now - 2 * DAY, status: "answered", deliveredAt: now - 2 * DAY + 1000, turnId: "t-old" });
  const replyKey = "reply:default:default-writer-old-1";
  h.storeMap.set(replyKey, { at: now - 2 * DAY + 2000, text: "old reply" });
  const askKey = "ask:default:ask-old-1";
  h.storeMap.set(askKey, { id: "ask-old-1", ownerSessionId: SESSION_ID, at: now - 2 * DAY + 3000, nodeId: "node-old", question: "old question", status: "expired" });

  const realWrite = h.fake.fs.write;
  let refused = 0;
  h.fake.fs.write = (p, content) => {
    if (p === ".agentic-channel.jsonl" && refused === 0) {
      refused++;
      return Promise.reject(new Error("log write refused"));
    }
    return realWrite(p, content);
  };

  // costSummaryEveryNTicks is 2 in OPTS; the second tick reaches the sweep.
  // The tick returns without persisting on this goal-less tree, so a turn
  // pair follows each cadence: turn.complete persists, which is how the
  // sweep's in-memory decisions reach the file getDecisions reads.
  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);
  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);
  await fireTurn(h, "t-flush-1");

  check("section12.4: the append was attempted and refused (setup sanity)", refused === 1);
  check("section12.4: inbox record still in the store after the refused append", h.storeMap.has(key));
  check("section12.4: reply record still in the store after the refused append", h.storeMap.has(replyKey));
  check("section12.4: ask record still in the store after the refused append", h.storeMap.has(askKey));
  let decisions = getDecisions(h);
  check("section12.4: sweep_expired_records_failed decision names the refusal",
    decisions.some((d) => d.action === "sweep_expired_records_failed" && d.detail.includes("log write refused")));
  check("section12.4: no sweep_expired_records decision on the refused cadence", !decisions.some((d) => d.action === "sweep_expired_records"));
  check("section12.4: nothing in the channel log yet", !h.fsMap.has(".agentic-channel.jsonl"));

  // Next cadence: the append lands, then the delete.
  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);
  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);
  await fireTurn(h, "t-flush-2");

  check("section12.4 control: inbox record removed after the append landed", !h.storeMap.has(key));
  check("section12.4 control: reply record removed after the append landed", !h.storeMap.has(replyKey));
  check("section12.4 control: ask record removed after the append landed", !h.storeMap.has(askKey));
  const logLines = (h.fsMap.get(".agentic-channel.jsonl") || "").split("\n").filter((l) => l.trim().length > 0);
  const parsed = logLines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  check("section12.4 control: the log holds one line per swept record, each with sweptAt and its key",
    parsed.length === 3 && parsed.every((l) => l && typeof l.sweptAt === "number") &&
    parsed.some((l) => l.kind === "inbox" && l.key === key) && parsed.some((l) => l.kind === "reply" && l.key === replyKey) &&
    parsed.some((l) => l.kind === "ask" && l.key === askKey), logLines);
  decisions = getDecisions(h);
  check("section12.4 control: sweep_expired_records decision counts all three", decisions.some((d) => d.action === "sweep_expired_records" && d.detail.includes("swept 3")));
}

// Bullet 5: the window roll leaves a delivered or answered record that is not
// resolved in the store. Seven records over a window of 3: the two oldest are
// delivered and answered, then four resolved and one skipped. Control: the
// two oldest resolved records roll, so the rollable set is what the window
// bounds.
async function caseSection12_5_windowRollKeepsUnresolvedRecords(clock) {
  console.log("\n=== Section 12 bullet 5: the window roll keeps delivered and answered records that are not resolved ===");
  clock.set(T0);
  const now = T0;
  const h = await createTickHarness({ ...OPTS, caseName: "section12_5_window", channelRecordWindow: 3 });
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const deliveredKey = seedInboxRecord(h, "writer-d", 1, { at: now - 9000, status: "delivered", deliveredAt: now - 8900, turnId: "t-d" });
  const answeredKey = seedInboxRecord(h, "writer-a", 1, { at: now - 8000, status: "answered", deliveredAt: now - 7900, turnId: "t-a" });
  const resolvedKeys = [];
  for (let i = 0; i < 4; i++) {
    resolvedKeys.push(seedInboxRecord(h, `writer-r${i}`, 1, { at: now - 7000 + i * 1000, status: "resolved", deliveredAt: now - 6900 + i * 1000, resolvedAt: now - 6800 + i * 1000, outcome: "done", note: "" }));
  }
  const skippedKey = seedInboxRecord(h, "writer-s", 1, { at: now - 2000, status: "skipped" });

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);
  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);

  check("section12.5: delivered record still in the store", h.storeMap.has(deliveredKey));
  check("section12.5: answered record still in the store", h.storeMap.has(answeredKey));
  check("section12.5 control: the two oldest resolved records rolled", !h.storeMap.has(resolvedKeys[0]) && !h.storeMap.has(resolvedKeys[1]));
  check("section12.5 control: the newer resolved records and the skipped record stay within the window",
    h.storeMap.has(resolvedKeys[2]) && h.storeMap.has(resolvedKeys[3]) && h.storeMap.has(skippedKey));
  const logLines = (h.fsMap.get(".agentic-channel.jsonl") || "").split("\n").filter((l) => l.trim().length > 0);
  check("section12.5 control: the log holds the two rolled records", logLines.length === 2 && logLines.every((l) => { try { return JSON.parse(l).kind === "inbox"; } catch { return false; } }), logLines);
  check("section12.5 control: channel_window_rolled counts two", getDecisions(h).some((d) => d.action === "channel_window_rolled" && d.detail.includes("rolled 2")));
}

// Bullet 6: a turn the plugin did not open for the record, starting after a
// delivery, does not take the stamp, and its answer is not written as the
// reply. Two shapes: a turn opened from the Discord channel, and a turn
// opened by a goal nudge. The plugin's own turn is the bullet 7 control.
async function caseSection12_6_foreignTurnDoesNotTakeTheStamp(clock) {
  console.log("\n=== Section 12 bullet 6: a channel-origin or nudge-opened turn does not take a delivered record's stamp ===");
  clock.set(T0);
  const now = T0;

  // A Discord message opens the turn that starts first after the delivery.
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_6_channel", now, "writer-c");
  await tickAndSettle(h, clock, 50);
  check("section12.6 channel: record delivered (setup sanity)", readStoreRecord(h, key)?.status === "delivered");
  await h.handlers["prompt.submit"](h.fake, { text: "What's the status?", origin: { kind: "channel" } }, async () => ({}));
  await h.handlers["turn.start"](h.fake, { turnId: "t-channel", text: "What's the status?" }, async () => ({ result: "ok" }));
  const afterStart = readStoreRecord(h, key);
  check("section12.6 channel: record not stamped with the channel turn", afterStart?.turnId === undefined, afterStart);
  check("section12.6 channel: operator_stamp_withheld names the record and channel-origin",
    getDecisions(h).some((d) => d.action === "operator_stamp_withheld" && d.detail.includes(id) && d.detail.includes("channel-origin")));
  check("section12.6 channel: no operator_turn_stamped decision", !getDecisions(h).some((d) => d.action === "operator_turn_stamped"));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-channel", answer: "Answer meant for Discord.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.6 channel: no reply written from the channel turn's answer", !h.storeMap.has(`reply:default:${id}`));
  check("section12.6 channel: record still delivered, not answered", readStoreRecord(h, key)?.status === "delivered");

  // A goal nudge is submitted, then a delivery; plugin turns open in
  // submission order, so the nudged turn opens first and the delivery's
  // own turn second.
  const n = await createTickHarness({ ...OPTS, caseName: "section12_6_nudge" });
  n.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  n.setClassifyValue("nudge");
  clock.advance(130_000);
  await tickAndSettle(n, clock, 50);
  check("section12.6 nudge: nudge_sent fired (setup sanity)", getDecisions(n).some((d) => d.action === "nudge_sent"));
  seedReaderClaim(n, "writer-n", clock.get());
  const nKey = seedInboxRecord(n, "writer-n", 1, { at: clock.get() - 500, status: "pending" });
  const nId = "default-writer-n-1";
  clock.advance(10_000);
  await tickAndSettle(n, clock, 50);
  check("section12.6 nudge: record delivered (setup sanity)", readStoreRecord(n, nKey)?.status === "delivered");
  await n.handlers["turn.start"](n.fake, { turnId: "t-nudge" }, async () => ({ result: "ok" }));
  const afterNudgeStart = readStoreRecord(n, nKey);
  check("section12.6 nudge: record not stamped with the nudged turn", afterNudgeStart?.turnId === undefined, afterNudgeStart);
  await n.handlers["turn.complete"](n.fake, { turnId: "t-nudge", answer: "Working on the goal.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.6 nudge: no reply written from the nudged turn's answer", !n.storeMap.has(`reply:default:${nId}`));
  check("section12.6 nudge: record still delivered, not answered", readStoreRecord(n, nKey)?.status === "delivered");
  await n.handlers["turn.start"](n.fake, { turnId: "t-delivery-after-nudge" }, async () => ({ result: "ok" }));
  check("section12.6 nudge: the delivery's own turn, opening next, takes the stamp", readStoreRecord(n, nKey)?.turnId === "t-delivery-after-nudge");

  // A keyboard turn opens first after the delivery: an external turn with no
  // channel origin, seen only through the real prompt.submit hook, which the
  // plugin's own submits never fire.
  clock.set(T0);
  const k = await seedOwnerWithPendingRecord("section12_6_keyboard", now, "writer-k");
  await tickAndSettle(k.h, clock, 50);
  check("section12.6 keyboard: record delivered (setup sanity)", readStoreRecord(k.h, k.key)?.status === "delivered");
  await k.h.handlers["prompt.submit"](k.h.fake, { text: "Typed at the keyboard.", origin: { kind: "keyboard" } }, async () => ({}));
  await k.h.handlers["turn.start"](k.h.fake, { turnId: "t-keyboard", text: "Typed at the keyboard." }, async () => ({ result: "ok" }));
  const afterKeyboardStart = readStoreRecord(k.h, k.key);
  check("section12.6 keyboard: record not stamped with the keyboard turn", afterKeyboardStart?.turnId === undefined, afterKeyboardStart);
  check("section12.6 keyboard: operator_stamp_withheld names the record and external",
    getDecisions(k.h).some((d) => d.action === "operator_stamp_withheld" && d.detail.includes(k.id) && d.detail.includes("external")));
  await k.h.handlers["turn.complete"](k.h.fake, { turnId: "t-keyboard", answer: "Answer to the typed prompt.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.6 keyboard: no reply written from the keyboard turn's answer", !k.h.storeMap.has(`reply:default:${k.id}`));
  check("section12.6 keyboard: record still delivered, not answered", readStoreRecord(k.h, k.key)?.status === "delivered");
}

// The budget close-out nudge sets the nudged-turn flag on the synchronous
// side of its submit, as the goal nudge does. The real submit parks until the
// session is next idle, so a flag set after it lands only once the nudged
// turn has run: a turn starting under the parked submit would then read as
// the plugin's own and take a delivered record's stamp.
async function caseSection12_6_budgetNudgeFlagsTheTurnBeforeItsSubmit(clock) {
  console.log("\n=== Section 12 bullet 6: a budget-nudge turn starting under the parked submit does not take the stamp ===");
  clock.set(T0);
  const now = T0;
  const h = await createTickHarness({
    ...OPTS,
    caseName: "section12_6_budget",
    contextBudgetEnabled: true,
    contextBudgetInfoTokens: 100,
    contextBudgetCloseoutTokens: 200,
    contextBudgetCriticalTokens: 1_000_000,
    contextBudgetReadEveryNTicks: 1,
    sessionMessages: () => Promise.resolve([{ text: "x".repeat(2000), toolUses: [], toolResults: [] }]),
  });
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  seedReaderClaim(h, "writer-b", now);
  const key = seedInboxRecord(h, "writer-b", 1, { at: now - 5000, status: "pending" });
  const id = "default-writer-b-1";

  // Tick 1 delivers nothing (the record is not seeded yet), crosses the
  // close-out threshold and submits the budget nudge, which parks.
  h.storeMap.delete(key);
  h.holdPromptSubmits();
  const tick1 = fireTick(h);
  const nudgeQueued = await waitUntil(() => (h.promptSubmits || []).some((p) => p.startsWith("[BUDGET]")));
  check("section12.6 budget: the close-out nudge was submitted (setup sanity)", nudgeQueued);

  // Tick 2 delivers the record behind the parked nudge.
  seedInboxRecord(h, "writer-b", 1, { at: now - 5000, status: "pending" });
  clock.advance(10_000);
  const tick2 = fireTick(h);
  const delivered = await waitUntil(() => readStoreRecord(h, key)?.status === "delivered");
  check("section12.6 budget: record delivered behind the parked nudge (setup sanity)", delivered);

  // The nudged turn opens first, then the delivery's own.
  await h.handlers["turn.start"](h.fake, { turnId: "t-budget" }, async () => ({ result: "ok" }));
  const afterStart = readStoreRecord(h, key);
  check("section12.6 budget: record not stamped with the budget-nudge turn", afterStart?.turnId === undefined, afterStart);
  await h.handlers["turn.complete"](h.fake, { turnId: "t-budget", answer: "Banking state.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.6 budget: no reply written from the nudged turn's answer", !h.storeMap.has(`reply:default:${id}`));
  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-after-budget" }, async () => ({ result: "ok" }));
  check("section12.6 budget: the delivery's own turn, opening next, takes the stamp", readStoreRecord(h, key)?.turnId === "t-delivery-after-budget");
  h.releasePromptSubmits();
  await tick1;
  await tick2;
}

// Bullet 7 (control for bullet 6): the plugin's own delivery turn still takes
// the stamp and writes the reply, at the general drain and at the ask-answer
// delivery.
async function caseSection12_7_ownTurnStillTakesTheStamp_control(clock) {
  console.log("\n=== Section 12 bullet 7 (control): the plugin's own delivery turn takes the stamp and writes the reply ===");
  clock.set(T0);
  const now = T0;

  // General drain.
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_7_drain", now, "writer-g");
  await tickAndSettle(h, clock, 50);
  check("section12.7 drain: record delivered (setup sanity)", readStoreRecord(h, key)?.status === "delivered");
  await h.handlers["turn.start"](h.fake, { turnId: "t-own" }, async () => ({ result: "ok" }));
  check("section12.7 drain: record stamped with the plugin's own turn", readStoreRecord(h, key)?.turnId === "t-own");
  check("section12.7 drain: operator_turn_stamped names the record", getDecisions(h).some((d) => d.action === "operator_turn_stamped" && d.detail.includes(id)));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-own", answer: "Done.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.7 drain: reply written from the turn's answer", readStoreRecord(h, `reply:default:${id}`)?.text === "Done.");
  check("section12.7 drain: record answered", readStoreRecord(h, key)?.status === "answered");

  // Ask-answer delivery: a pending record answering the open ask.
  const ha = await createTickHarness({ ...OPTS, caseName: "section12_7_ask" });
  ha.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const personaState = buildPersonaState(SESSION_ID, now);
  personaState.goals = [
    { id: "node-s12", kind: "leaf", objective: "Goal", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-s12";
  personaState.pendingAskId = "ask-s12-1";
  ha.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  ha.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: SESSION_ID, epoch: 1, lastSeen: now } }));
  seedReaderClaim(ha, "writer-ans", now);
  const answerKey = seedInboxRecord(ha, "writer-ans", 1, { at: now - 500, kind: "answer", answers: "ask-s12-1", status: "pending" });
  const startH = ha.handlers["session.start"];
  if (startH) await startH(ha.fake, {}, () => {});
  ha.storeMap.set("ask:default:ask-s12-1", { id: "ask-s12-1", ownerSessionId: SESSION_ID, at: now - 1000, nodeId: "node-s12", question: "Which way?", status: "open" });
  clock.advance(65_000);
  await tickAndSettle(ha, clock, 50);
  check("section12.7 ask: answer record delivered (setup sanity)", readStoreRecord(ha, answerKey)?.status === "delivered");
  check("section12.7 ask: ask_answered logged (setup sanity)", getDecisions(ha).some((d) => d.action === "ask_answered"));
  await ha.handlers["turn.start"](ha.fake, { turnId: "t-own-ask" }, async () => ({ result: "ok" }));
  check("section12.7 ask: answer record stamped with the plugin's own turn", readStoreRecord(ha, answerKey)?.turnId === "t-own-ask");
  await ha.handlers["turn.complete"](ha.fake, { turnId: "t-own-ask", answer: "Going left.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.7 ask: reply written from the turn's answer", readStoreRecord(ha, "reply:default:default-writer-ans-1")?.text === "Going left.");
  check("section12.7 ask: answer record answered", readStoreRecord(ha, answerKey)?.status === "answered");
}

// F1: the owner does the work and calls agentic_resolve inside the stamped
// turn, so the record is already resolved when turn.complete runs. The reply
// is still filed, the status stays resolved, and the sender reads both.
async function caseSection12_F1_resolveInsideTheAnsweringTurnKeepsTheReply(clock) {
  console.log("\n=== Section 12 F1: a resolve inside the answering turn still files the reply ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_f1_resolve_in_turn", now, "writer-f1");
  await tickAndSettle(h, clock, 50);
  await h.handlers["turn.start"](h.fake, { turnId: "t-resolve" }, async () => ({ result: "ok" }));
  check("section12.F1: record stamped (setup sanity)", readStoreRecord(h, key)?.turnId === "t-resolve");
  const r = await h.handlers["tool.call"](h.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id, outcome: "done", note: "shipped" }, async () => ({ result: "passthrough" }));
  check("section12.F1: resolve accepted inside the turn (setup sanity)", r.deny === undefined);
  await h.handlers["turn.complete"](h.fake, { turnId: "t-resolve", answer: "Here is the result.", reason: "completed" }, async () => ({ result: "ok" }));
  const rec = readStoreRecord(h, key);
  const reply = readStoreRecord(h, `reply:default:${id}`);
  check("section12.F1: reply written from the turn's answer", reply?.text === "Here is the result.", reply);
  check("section12.F1: record stays resolved with its outcome", rec?.status === "resolved" && rec?.outcome === "done", rec);
  check("section12.F1: operator_answered names the record", getDecisions(h).some((d) => d.action === "operator_answered" && d.detail.includes(id)));

  // The sender's read. The reader harness lists records by its own session
  // id, so the record is copied over with `from` rewritten to it; the reply
  // key is by record id and copies as is.
  const hr = await seedReaderHarness("section12_f1_inbox", now, "owner-f1", {}, { turnStartedAt: null, workdir: HARNESS_CWD });
  hr.storeMap.set(key, { ...rec, from: SESSION_ID });
  hr.storeMap.set(`reply:default:${id}`, reply);
  const inbox = await hr.handlers["tool.call"](hr.fake, { tool: "mcp__agentic-plugin__agentic_inbox" }, async () => ({ result: "passthrough" }));
  const seen = inbox.result ? JSON.parse(inbox.result).inbox.find((x) => x.id === id) : undefined;
  check("section12.F1: agentic_inbox returns reply beside outcome", seen?.reply === "Here is the result." && seen?.outcome === "done" && seen?.status === "resolved", seen);
}

// F2: the window roll keeps the reply of an open steer (an answered or
// delivered record still in the store) while a reply for a record that
// rolls, and an orphan reply, roll as before.
async function caseSection12_F2_windowRollKeepsAnOpenSteersReply(clock) {
  console.log("\n=== Section 12 F2: the window roll keeps an answered record's reply ===");
  clock.set(T0);
  const now = T0;
  const h = await createTickHarness({ ...OPTS, caseName: "section12_f2_window_reply", channelRecordWindow: 2 });
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const answeredKey = seedInboxRecord(h, "writer-a", 1, { at: now - 9000, status: "answered", deliveredAt: now - 8950, turnId: "t-a" });
  const answeredReplyKey = "reply:default:default-writer-a-1";
  h.storeMap.set(answeredReplyKey, { at: now - 8900, text: "the open steer's reply" });
  const resolvedKey = seedInboxRecord(h, "writer-r", 1, { at: now - 7000, status: "resolved", resolvedAt: now - 6800, outcome: "done", note: "" });
  const resolvedReplyKey = "reply:default:default-writer-r-1";
  h.storeMap.set(resolvedReplyKey, { at: now - 6900, text: "reply on a resolved record" });
  const resolved2Key = seedInboxRecord(h, "writer-r2", 1, { at: now - 5000, status: "resolved", resolvedAt: now - 4800, outcome: "declined", note: "" });
  const orphanReplyKey = "reply:default:default-writer-gone-1";
  h.storeMap.set(orphanReplyKey, { at: now - 4000, text: "orphan reply" });
  const skippedKey = seedInboxRecord(h, "writer-s", 1, { at: now - 2000, status: "skipped" });

  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});
  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);
  clock.advance(60_000);
  await tickAndSettle(h, clock, 50);

  check("section12.F2: answered record still in the store (setup sanity)", h.storeMap.has(answeredKey));
  check("section12.F2: the answered record's reply survives the roll", h.storeMap.has(answeredReplyKey));
  check("section12.F2 control: the rolled resolved record's reply rolled with it", !h.storeMap.has(resolvedKey) && !h.storeMap.has(resolvedReplyKey));
  check("section12.F2 control: the orphan reply and the newest rollable records sit within the window",
    !h.storeMap.has(resolved2Key) && h.storeMap.has(orphanReplyKey) && h.storeMap.has(skippedKey));
  const logLines = (h.fsMap.get(".agentic-channel.jsonl") || "").split("\n").filter((l) => l.trim().length > 0);
  check("section12.F2 control: the log holds the three rolled records", logLines.length === 3, logLines);

  const hr = await seedReaderHarness("section12_f2_inbox", clock.get(), "owner-f2", {}, { turnStartedAt: null, workdir: HARNESS_CWD });
  hr.storeMap.set(answeredKey, { ...readStoreRecord(h, answeredKey), from: SESSION_ID });
  const keptReply = readStoreRecord(h, answeredReplyKey);
  if (keptReply) hr.storeMap.set(answeredReplyKey, keptReply);
  const inbox = await hr.handlers["tool.call"](hr.fake, { tool: "mcp__agentic-plugin__agentic_inbox" }, async () => ({ result: "passthrough" }));
  const seen = inbox.result ? JSON.parse(inbox.result).inbox.find((x) => x.id === "default-writer-a-1") : undefined;
  check("section12.F2: agentic_inbox still returns the reply", seen?.reply === "the open steer's reply", seen);
}

// F3: a budget nudge whose submit is refused resets the nudged flag, so the
// tick's next delivery turn is the plugin's own and takes the stamp.
async function caseSection12_F3_failedNudgeResetsTheNudgedFlag(clock) {
  console.log("\n=== Section 12 F3: a refused budget nudge does not withhold the next delivery turn's stamp ===");
  clock.set(T0);
  const now = T0;
  const h = await createTickHarness({
    ...OPTS,
    caseName: "section12_f3_nudge_failed",
    contextBudgetEnabled: true,
    contextBudgetInfoTokens: 100,
    contextBudgetCloseoutTokens: 200,
    contextBudgetCriticalTokens: 1_000_000,
    contextBudgetReadEveryNTicks: 1,
    sessionMessages: () => Promise.resolve([{ text: "x".repeat(2000), toolUses: [], toolResults: [] }]),
  });
  // A goal-less tree, so the tick returns after the budget read and no goal
  // nudge rides on the same refused submit.
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(SESSION_ID, now) }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: SESSION_ID, epoch: 1, lastSeen: now } }));
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  h.failPromptSubmits(new Error("submit refused for the nudge"));
  clock.advance(10_000);
  await tickAndSettle(h, clock, 50);
  check("section12.F3: the budget nudge was attempted (setup sanity)", (h.promptSubmits || []).some((p) => p.startsWith("[BUDGET]")));
  // No turn pair here: turn.complete resets the nudged flag, which is the
  // very state this case observes. The decisions are read after the
  // turn.start below, which persists.

  h.failPromptSubmits(null);
  seedReaderClaim(h, "writer-f3", clock.get());
  const key = seedInboxRecord(h, "writer-f3", 1, { at: clock.get() - 500, status: "pending" });
  clock.advance(10_000);
  await tickAndSettle(h, clock, 50);
  check("section12.F3: record delivered (setup sanity)", readStoreRecord(h, key)?.status === "delivered");
  await h.handlers["turn.start"](h.fake, { turnId: "t-own-after-failed-nudge" }, async () => ({ result: "ok" }));
  check("section12.F3: the delivery's own turn takes the stamp", readStoreRecord(h, key)?.turnId === "t-own-after-failed-nudge");
  await fireTurn(h, "t-flush-f3");
  const decisions = getDecisions(h);
  check("section12.F3: no operator_stamp_withheld", !decisions.some((d) => d.action === "operator_stamp_withheld"));
  check("section12.F3: the refused budget nudge is recorded and no context_budget_nudge was logged",
    decisions.some((d) => d.action === "context_budget_nudge_failed" && d.detail.includes("submit refused for the nudge")) && !decisions.some((d) => d.action === "context_budget_nudge"));
}

// F4 (ruled form): a refused delivery submit consumes the stamp handoff it
// armed and records the refusal, and nothing else. The record stays
// delivered with its deliveredAt, its entry is gone from the list, and no
// delivery is retried; the TTL ages it out.
async function caseSection12_F4_failedDeliverySubmitLeavesTheRecordDelivered(clock) {
  console.log("\n=== Section 12 F4: a refused delivery submit leaves the record delivered, unstamped, and not retried ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_f4_delivery_failed", now, "writer-f4");
  h.failPromptSubmits(new Error("submit refused for the delivery"));
  await fireTick(h).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  check("section12.F4: the delivery was attempted (setup sanity)", (h.promptSubmits || []).filter((p) => p.startsWith("[OPERATOR]")).length === 1);
  const afterFail = readStoreRecord(h, key);
  check("section12.F4: record stays delivered with deliveredAt intact", afterFail?.status === "delivered" && typeof afterFail?.deliveredAt === "number", afterFail);
  check("section12.F4: operator_delivery_failed names the record and the error",
    getDecisions(h).some((d) => d.action === "operator_delivery_failed" && d.detail.includes(id) && d.detail.includes("submit refused for the delivery")));

  // Its entry is gone: a turn opening with the delivery's own text is not
  // matched, so it stamps nothing and no withheld decision names it.
  await h.handlers["turn.start"](h.fake, { turnId: "t-after-refusal", text: "[OPERATOR] message 1" }, async () => ({ result: "ok" }));
  check("section12.F4: a later turn with the delivery's text stamps nothing", readStoreRecord(h, key)?.turnId === undefined);
  check("section12.F4: a later turn withholds nothing (no delivery queued)", !getDecisions(h).some((d) => d.action === "operator_stamp_withheld"));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-after-refusal", answer: "unrelated", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.F4: no reply written", !h.storeMap.has(`reply:default:${id}`));

  h.failPromptSubmits(null);
  clock.advance(10_000);
  await tickAndSettle(h, clock, 50);
  check("section12.F4: the next tick does not retry the delivery", (h.promptSubmits || []).filter((p) => p.startsWith("[OPERATOR]")).length === 1 && readStoreRecord(h, key)?.status === "delivered");
}

// G1: the real submit parks until the session is next idle, so a rejection
// can arrive after the submitted turn ran and answered. A record whose id a
// turn.start already consumed is left as it stands rather than reverted.
async function caseSection12_G1_lateRejectingSubmitLeavesAnAnsweredRecord(clock) {
  console.log("\n=== Section 12 G1: a submit rejecting after its turn ran does not revert the answered record ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_g1_late_reject", now, "writer-g1");
  // A submit that parks until this case rejects it, recorded like the stub's.
  const realSubmit = h.fake.prompt.submit;
  let rejectParked = null;
  h.fake.prompt.submit = ({ text }) => {
    h.promptSubmits.push(text);
    return new Promise((_, reject) => { rejectParked = reject; });
  };
  const tick = fireTick(h);
  const queued = await waitUntil(() => rejectParked !== null);
  check("section12.G1: the delivery's submit is parked (setup sanity)", queued && readStoreRecord(h, key)?.status === "delivered");
  // The stub's submit is overridden above, so the harness's text queue never
  // saw this delivery: the turn carries its text explicitly.
  await h.handlers["turn.start"](h.fake, { turnId: "t-late", text: "[OPERATOR] message 1" }, async () => ({ result: "ok" }));
  check("section12.G1: the delivery's own turn took the stamp under the parked submit (setup sanity)", readStoreRecord(h, key)?.turnId === "t-late");
  await h.handlers["turn.complete"](h.fake, { turnId: "t-late", answer: "Answered under the parked submit.", reason: "completed" }, async () => ({ result: "ok" }));
  rejectParked(new Error("late rejection"));
  await tick.catch(() => {});
  h.fake.prompt.submit = realSubmit;
  const rec = readStoreRecord(h, key);
  check("section12.G1: record stays answered, not reverted to pending", rec?.status === "answered" && rec?.turnId === "t-late" && rec?.deliveredAt !== undefined, rec);
  check("section12.G1: the reply is still there", readStoreRecord(h, `reply:default:${id}`)?.text === "Answered under the parked submit.");
  check("section12.G1: operator_delivery_failed names the record and the rejection",
    getDecisions(h).some((d) => d.action === "operator_delivery_failed" && d.detail.includes(id) && d.detail.includes("late rejection")));
  clock.advance(10_000);
  await tickAndSettle(h, clock, 50);
  check("section12.G1: the next tick does not re-deliver it", (h.promptSubmits || []).filter((p) => p.startsWith("[OPERATOR]")).length === 1 && readStoreRecord(h, key)?.status === "answered");
}

// G2: an inbox record ages off the latest of its write, delivery and
// resolution times, and its reply is swept with it rather than on its own
// age, so a record that waited pending past the TTL and then got answered
// keeps its reply. Control: a record old on every time is swept with its
// reply as a pair, and an orphan reply is swept on its own age.
async function caseSection12_G2_sweepAgesOffDeliveryAndKeepsReplyWithRecord(clock) {
  console.log("\n=== Section 12 G2: the sweep ages a record off delivery time and sweeps its reply with it ===");
  clock.set(T0);
  const now = T0;
  const { sweepExpiredRecords } = await import("../hooks/operator.ts?case=section12_g2_direct_unit");
  const lateKey = "inbox:default:writer-late:1";
  const lateReplyKey = "reply:default:default-writer-late-1";
  const oldKey = "inbox:default:writer-old:1";
  const oldReplyKey = "reply:default:default-writer-old-1";
  const orphanReplyKey = "reply:default:default-writer-gone-1";
  const store = makeMiniStore({
    [lateKey]: { id: "default-writer-late-1", key: lateKey, from: "writer-late", at: now - 10_000, text: "waited, then answered", kind: "say", status: "answered", deliveredAt: now - 100, turnId: "t-late" },
    [lateReplyKey]: { at: now - 50, text: "fresh reply" },
    [oldKey]: { id: "default-writer-old-1", key: oldKey, from: "writer-old", at: now - 10_000, text: "old and answered", kind: "say", status: "answered", deliveredAt: now - 9_000, turnId: "t-old" },
    [oldReplyKey]: { at: now - 200, text: "reply newer than the TTL, swept with its record" },
    [orphanReplyKey]: { at: now - 5_000, text: "orphan" },
  });
  const appended = [];
  const swept = await sweepExpiredRecords(store, "default", async (lines) => { appended.push(...lines); }, 1000);
  check("section12.G2: the late-delivered record is kept", store._map.has(lateKey));
  check("section12.G2: its reply is kept with it", store._map.has(lateReplyKey));
  check("section12.G2 control: the record old on every time is swept", !store._map.has(oldKey));
  check("section12.G2 control: its reply is swept with it as a pair", !store._map.has(oldReplyKey));
  check("section12.G2 control: the orphan reply is swept on its own age", !store._map.has(orphanReplyKey));
  check("section12.G2 control: swept count is 3", swept === 3, swept);
}

// G3 (ruled form): the F4 shape on the ask-answer path. The ask stays
// closed as the delivery wrote it, pendingAskId stays cleared, the node
// stays active, the record stays delivered, and nothing is retried.
async function caseSection12_G3_failedAskAnswerSubmitLeavesTheAskClosed(clock) {
  console.log("\n=== Section 12 G3: a refused ask-answer submit leaves the ask closed and the record delivered ===");
  clock.set(T0);
  const now = T0;
  const ha = await createTickHarness({ ...OPTS, caseName: "section12_g3_ask_refused" });
  ha.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const personaState = buildPersonaState(SESSION_ID, now);
  personaState.goals = [
    { id: "node-g3", kind: "leaf", objective: "Goal", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-g3";
  personaState.pendingAskId = "ask-g3-1";
  ha.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  ha.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: SESSION_ID, epoch: 1, lastSeen: now } }));
  seedReaderClaim(ha, "writer-g3", now);
  const answerKey = seedInboxRecord(ha, "writer-g3", 1, { at: now - 500, kind: "answer", answers: "ask-g3-1", status: "pending" });
  const startH = ha.handlers["session.start"];
  if (startH) await startH(ha.fake, {}, () => {});
  const askKey = "ask:default:ask-g3-1";
  ha.storeMap.set(askKey, { id: "ask-g3-1", ownerSessionId: SESSION_ID, at: now - 1000, nodeId: "node-g3", question: "Which way?", status: "open" });

  ha.failPromptSubmits(new Error("submit refused for the answer"));
  clock.advance(65_000);
  await fireTick(ha).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  check("section12.G3: the answer delivery was attempted (setup sanity)", (ha.promptSubmits || []).some((p) => p.startsWith("[OPERATOR] Answer to")));
  const rec = readStoreRecord(ha, answerKey);
  check("section12.G3: the answer record stays delivered with deliveredAt intact", rec?.status === "delivered" && typeof rec?.deliveredAt === "number", rec);
  check("section12.G3: the ask stays answered", readStoreRecord(ha, askKey)?.status === "answered");
  const state = getState(ha);
  check("section12.G3: pendingAskId stays cleared", state.pendingAskId === undefined);
  check("section12.G3: the node stays active", state.goals.find((g) => g.id === "node-g3")?.status === "active");
  check("section12.G3: operator_delivery_failed names the record and the error",
    state.decisions.some((d) => d.action === "operator_delivery_failed" && d.detail.includes("default-writer-g3-1") && d.detail.includes("submit refused for the answer")));
  check("section12.G3: no ask_answer_delivery_reverted", !state.decisions.some((d) => d.action === "ask_answer_delivery_reverted"));

  ha.failPromptSubmits(null);
  clock.advance(10_000);
  await tickAndSettle(ha, clock, 50);
  check("section12.G3: the next tick retries nothing", (ha.promptSubmits || []).filter((p) => p.startsWith("[OPERATOR]")).length === 1 && readStoreRecord(ha, answerKey)?.status === "delivered");
}

// G4 (bullet 6, fourth shape): a turn one of the plugin's other submits
// opened (the ask re-raise here; the kaizen announcement and the reply
// backstop set the same flag) starting first after a delivery does not take
// the stamp.
async function caseSection12_6_pluginTurnDoesNotTakeTheStamp(clock) {
  console.log("\n=== Section 12 bullet 6: a turn the ask re-raise opened does not take a delivered record's stamp ===");
  clock.set(T0);
  const now = T0;
  const h = await createTickHarness({ ...OPTS, caseName: "section12_g4_plugin_turn", askReraiseWindowMs: 30_000, askOperatorWaitMs: 300_000 });
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const personaState = buildPersonaState(SESSION_ID, now);
  personaState.goals = [
    { id: "node-g4", kind: "leaf", objective: "Goal", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-g4";
  personaState.pendingAskId = "ask-g4-1";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: SESSION_ID, epoch: 1, lastSeen: now } }));
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});
  h.storeMap.set("ask:default:ask-g4-1", { id: "ask-g4-1", ownerSessionId: SESSION_ID, at: T0, nodeId: "node-g4", question: "Keep going?", status: "open" });

  clock.advance(35_000);
  await tickAndSettle(h, clock, 20);
  check("section12.6 plugin: the re-raise turn was submitted (setup sanity)", (h.promptSubmits || []).some((p) => p.includes("[STILL WAITING]")));

  seedReaderClaim(h, "writer-g4", clock.get());
  const key = seedInboxRecord(h, "writer-g4", 1, { at: clock.get() - 500, status: "pending" });
  clock.advance(10_000);
  await tickAndSettle(h, clock, 50);
  check("section12.6 plugin: record delivered (setup sanity)", readStoreRecord(h, key)?.status === "delivered");
  // The re-raise was submitted before the delivery, so its turn opens first.
  await h.handlers["turn.start"](h.fake, { turnId: "t-reraise" }, async () => ({ result: "ok" }));
  check("section12.6 plugin: record not stamped with the re-raise turn", readStoreRecord(h, key)?.turnId === undefined);
  await h.handlers["turn.complete"](h.fake, { turnId: "t-reraise", answer: "Still waiting on you.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.6 plugin: no reply written from the re-raise turn's answer", !h.storeMap.has("reply:default:default-writer-g4-1"));
  // The delivery's own turn opens next and takes the stamp.
  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-after-reraise" }, async () => ({ result: "ok" }));
  check("section12.6 plugin: the delivery's own turn, opening next, takes the stamp", readStoreRecord(h, key)?.turnId === "t-delivery-after-reraise");
  await h.handlers["turn.complete"](h.fake, { turnId: "t-delivery-after-reraise", answer: "On it.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.6 plugin: the delivery's own turn files the reply", readStoreRecord(h, "reply:default:default-writer-g4-1")?.text === "On it.");
}

// H1 (A): a delivery submit parks, then a channel turn completes with no
// reply call and its backstop queues a plugin submit behind it. The
// delivery's own turn opens first and takes the stamp: a queued plugin
// submit says nothing about which turn is opening.
async function caseSection12_H1_deliveryTurnOpensAheadOfAQueuedBackstop(clock) {
  console.log("\n=== Section 12 H1 (A): the delivery's turn opening ahead of a queued backstop submit takes the stamp ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_h1_a", now, "writer-h1a");
  h.holdPromptSubmits();
  const tick = fireTick(h);
  const queued = await waitUntil(() => (h.promptSubmits || []).some((p) => p.startsWith("[OPERATOR]")));
  check("section12.H1a: the delivery's submit is parked (setup sanity)", queued && readStoreRecord(h, key)?.status === "delivered");

  // A channel turn runs to completion with no reply call; the direct reply
  // call fails, so the backstop submits a re-prompt, which parks too.
  h.fake.tool.call = () => Promise.reject(new Error("no live channel"));
  await h.handlers["prompt.submit"](h.fake, { text: "status?", origin: { kind: "channel" } }, async () => ({}));
  await h.handlers["turn.start"](h.fake, { turnId: "t-channel-h1a", text: "status?" }, async () => ({ result: "ok" }));
  const completeChannel = h.handlers["turn.complete"](h.fake, { turnId: "t-channel-h1a", answer: "All green.", reason: "completed" }, async () => ({ result: "ok" }));
  const backstopQueued = await waitUntil(() => (h.promptSubmits || []).some((p) => p.includes("[REPLY BACKSTOP]")));
  check("section12.H1a: the backstop submit is parked behind the delivery (setup sanity)", backstopQueued);
  check("section12.H1a: the channel turn did not take the stamp", readStoreRecord(h, key)?.turnId === undefined);

  // The delivery's own turn opens first.
  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-h1a" }, async () => ({ result: "ok" }));
  check("section12.H1a: the delivery's own turn takes the stamp", readStoreRecord(h, key)?.turnId === "t-delivery-h1a");
  await h.handlers["turn.complete"](h.fake, { turnId: "t-delivery-h1a", answer: "Done.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.H1a: its answer is filed as the reply", readStoreRecord(h, `reply:default:${id}`)?.text === "Done." && readStoreRecord(h, key)?.status === "answered");
  h.releasePromptSubmits();
  await tick;
  await completeChannel;
}

// H1 (B): a plugin submit (the ask re-raise) parks behind an external turn;
// that turn runs and completes; a delivery is then submitted. The parked
// plugin turn opens first and takes no stamp; the delivery's turn opens
// next and takes it.
async function caseSection12_H1_parkedPluginTurnAfterAnExternalTurnTakesNoStamp(clock) {
  console.log("\n=== Section 12 H1 (B): a plugin turn parked behind an external turn takes no stamp; the delivery's turn does ===");
  clock.set(T0);
  const now = T0;
  const h = await createTickHarness({ ...OPTS, caseName: "section12_h1_b", askReraiseWindowMs: 30_000, askOperatorWaitMs: 300_000 });
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const personaState = buildPersonaState(SESSION_ID, now);
  personaState.goals = [
    { id: "node-h1b", kind: "leaf", objective: "Goal", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-h1b";
  personaState.pendingAskId = "ask-h1b-1";
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: SESSION_ID, epoch: 1, lastSeen: now } }));
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});
  h.storeMap.set("ask:default:ask-h1b-1", { id: "ask-h1b-1", ownerSessionId: SESSION_ID, at: T0, nodeId: "node-h1b", question: "Keep going?", status: "open" });

  // The re-raise submit parks behind the external turn that is about to run.
  h.holdPromptSubmits();
  clock.advance(35_000);
  const reraiseTick = fireTick(h);
  const reraiseQueued = await waitUntil(() => (h.promptSubmits || []).some((p) => p.includes("[STILL WAITING]")));
  check("section12.H1b: the re-raise submit is parked (setup sanity)", reraiseQueued);
  await h.handlers["prompt.submit"](h.fake, { text: "typed", origin: { kind: "keyboard" } }, async () => ({}));
  await h.handlers["turn.start"](h.fake, { turnId: "t-external-h1b", text: "typed" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-external-h1b", answer: "typed answer", reason: "completed" }, async () => ({ result: "ok" }));

  // A delivery is submitted in the gap.
  seedReaderClaim(h, "writer-h1b", clock.get());
  const key = seedInboxRecord(h, "writer-h1b", 1, { at: clock.get() - 500, status: "pending" });
  clock.advance(10_000);
  const deliveryTick = fireTick(h);
  const delivered = await waitUntil(() => readStoreRecord(h, key)?.status === "delivered");
  check("section12.H1b: record delivered behind the parked re-raise (setup sanity)", delivered);

  // The parked plugin turn opens first.
  await h.handlers["turn.start"](h.fake, { turnId: "t-reraise-h1b" }, async () => ({ result: "ok" }));
  check("section12.H1b: the parked plugin turn takes no stamp", readStoreRecord(h, key)?.turnId === undefined);
  await h.handlers["turn.complete"](h.fake, { turnId: "t-reraise-h1b", answer: "Still waiting.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.H1b: the plugin turn files no reply", !h.storeMap.has("reply:default:default-writer-h1b-1"));

  // The delivery's own turn opens next.
  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-h1b" }, async () => ({ result: "ok" }));
  check("section12.H1b: the delivery's own turn takes the stamp", readStoreRecord(h, key)?.turnId === "t-delivery-h1b");
  await h.handlers["turn.complete"](h.fake, { turnId: "t-delivery-h1b", answer: "Delivered answer.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.H1b: the delivery's turn files the reply", readStoreRecord(h, "reply:default:default-writer-h1b-1")?.text === "Delivered answer.");
  h.releasePromptSubmits();
  await reraiseTick;
  await deliveryTick;
}

// J1 (A): the turn's text is what says whose turn it is. A non-external turn
// whose text matches no queued entry is unaccounted: it stamps nothing, the
// delivery's entry stays queued, and the delivery's own turn, opening later
// with its own text, takes the stamp.
async function caseSection12_J1_unmatchedTurnTextTakesNoStamp(clock) {
  console.log("\n=== Section 12 J1 (A): a turn whose text matches no queued submit takes no stamp; the delivery's own text does ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_j1_a", now, "writer-j1a");
  h.holdPromptSubmits();
  const tick = fireTick(h);
  const queued = await waitUntil(() => (h.promptSubmits || []).some((p) => p.startsWith("[OPERATOR]")));
  check("section12.J1a: the delivery's submit is parked (setup sanity)", queued);

  // An external turn opens and completes.
  await h.handlers["prompt.submit"](h.fake, { text: "first typed", origin: { kind: "keyboard" } }, async () => ({}));
  await h.handlers["turn.start"](h.fake, { turnId: "t-x-j1a", text: "first typed" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-x-j1a", answer: "first answer", reason: "completed" }, async () => ({ result: "ok" }));

  // A turn the hook did not see opens next with text that is not D's (the
  // shape of a second typed prompt whose hook firing was spent on an
  // earlier turn.start): its text matches nothing.
  await h.handlers["turn.start"](h.fake, { turnId: "t-second-j1a", text: "second typed" }, async () => ({ result: "ok" }));
  check("section12.J1a: the unmatched turn takes no stamp", readStoreRecord(h, key)?.turnId === undefined);
  check("section12.J1a: operator_stamp_withheld names the record and unaccounted",
    getDecisions(h).some((d) => d.action === "operator_stamp_withheld" && d.detail.includes(id) && d.detail.includes("unaccounted")));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-second-j1a", answer: "second answer", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.J1a: the unmatched turn files no reply", !h.storeMap.has(`reply:default:${id}`));

  // The delivery's own turn opens with the delivery's text.
  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-j1a" }, async () => ({ result: "ok" }));
  check("section12.J1a: the delivery's own turn, by its text, takes the stamp", readStoreRecord(h, key)?.turnId === "t-delivery-j1a");
  await h.handlers["turn.complete"](h.fake, { turnId: "t-delivery-j1a", answer: "Delivered answer.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.J1a: the delivery's turn files the reply", readStoreRecord(h, `reply:default:${id}`)?.text === "Delivered answer.");
  h.releasePromptSubmits();
  await tick;
}

// J1 (B): a continuation turn (empty text) opening while a delivery is
// queued matches nothing, stamps nothing, and leaves the entry queued.
async function caseSection12_J1_continuationTurnTakesNoStamp(clock) {
  console.log("\n=== Section 12 J1 (B): a continuation turn takes no stamp and leaves the delivery queued ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_j1_b", now, "writer-j1b");
  h.holdPromptSubmits();
  const tick = fireTick(h);
  await waitUntil(() => (h.promptSubmits || []).some((p) => p.startsWith("[OPERATOR]")));
  await h.handlers["turn.start"](h.fake, { turnId: "t-cont-j1b", text: "" }, async () => ({ result: "ok" }));
  check("section12.J1b: the continuation turn takes no stamp", readStoreRecord(h, key)?.turnId === undefined);
  check("section12.J1b: operator_stamp_withheld names the record and unaccounted",
    getDecisions(h).some((d) => d.action === "operator_stamp_withheld" && d.detail.includes(id) && d.detail.includes("unaccounted")));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-cont-j1b", answer: "continued", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.J1b: the continuation files no reply", !h.storeMap.has(`reply:default:${id}`));
  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-j1b" }, async () => ({ result: "ok" }));
  check("section12.J1b: the delivery's own turn still takes the stamp", readStoreRecord(h, key)?.turnId === "t-delivery-j1b");
  h.releasePromptSubmits();
  await tick;
}

// J2: a prompt the hook chain drops opens no turn, so the external flag it
// set is reset on the drop branch. Pinned through the withheld reason: an
// unmatched turn after a dropped prompt reads unaccounted, not external,
// and the delivery's own turn then stamps with no withheld decision naming
// channel-origin or external.
async function caseSection12_J2_droppedPromptDoesNotLeaveTheExternalFlagSet(clock) {
  console.log("\n=== Section 12 J2: a dropped prompt does not leave the external flag set for the next turn ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_j2_drop", now, "writer-j2");
  h.holdPromptSubmits();
  const tick = fireTick(h);
  await waitUntil(() => (h.promptSubmits || []).some((p) => p.startsWith("[OPERATOR]")));
  const dropped = await h.handlers["prompt.submit"](h.fake, { text: "dropped by a hook beneath", origin: { kind: "channel" } }, async () => ({ drop: "refused beneath" }));
  check("section12.J2: the prompt was dropped (setup sanity)", dropped?.drop === "refused beneath");
  await h.handlers["turn.start"](h.fake, { turnId: "t-unmatched-j2", text: "" }, async () => ({ result: "ok" }));
  const withheld = getDecisions(h).filter((d) => d.action === "operator_stamp_withheld");
  check("section12.J2: the unmatched turn after the drop reads unaccounted, not channel-origin or external",
    withheld.length === 1 && withheld[0].detail.includes("unaccounted"), withheld);
  await h.handlers["turn.complete"](h.fake, { turnId: "t-unmatched-j2", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-j2" }, async () => ({ result: "ok" }));
  check("section12.J2: the delivery's own turn takes the stamp", readStoreRecord(h, key)?.turnId === "t-delivery-j2");
  check("section12.J2: no withheld decision names channel-origin or external",
    !getDecisions(h).some((d) => d.action === "operator_stamp_withheld" && (d.detail.includes("channel-origin") || d.detail.includes("external"))));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-delivery-j2", answer: "Delivered answer.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.J2: the delivery's turn files the reply", readStoreRecord(h, `reply:default:${id}`)?.text === "Delivered answer.");
  h.releasePromptSubmits();
  await tick;
}

// K1 (A): a hook beneath the plugin can drop the plugin's own submit, and
// $.prompt.submit then resolves { drop } rather than rejecting. A dropped
// delivery takes the rejected delivery's path: the record stays delivered
// with its deliveredAt, operator_delivery_failed names the drop reason, its
// entry is consumed so a later turn neither stamps it nor withholds on it,
// and no delivery is retried.
async function caseSection12_K1_droppedDeliverySubmitIsHandledLikeARejectedOne(clock) {
  console.log("\n=== Section 12 K1 (A): a dropped delivery submit leaves the record delivered, consumes its entry, and is not retried ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_k1_a_delivery_dropped", now, "writer-k1a");
  h.dropNextPromptSubmit("hook beneath refused the delivery");
  await tickAndSettle(h, clock, 50);
  check("section12.K1a: the delivery was attempted (setup sanity)", (h.promptSubmits || []).filter((p) => p.startsWith("[OPERATOR]")).length === 1);
  const afterDrop = readStoreRecord(h, key);
  check("section12.K1a: record stays delivered with deliveredAt intact", afterDrop?.status === "delivered" && typeof afterDrop?.deliveredAt === "number", afterDrop);
  check("section12.K1a: operator_delivery_failed names the record and the drop reason",
    getDecisions(h).some((d) => d.action === "operator_delivery_failed" && d.detail.includes(id) && d.detail.includes("submit dropped") && d.detail.includes("hook beneath refused the delivery")));

  // Its entry is gone: a turn opening with the delivery's own text matches
  // nothing, stamps nothing, and withholds nothing (no delivery is queued).
  await h.handlers["turn.start"](h.fake, { turnId: "t-after-drop-k1a", text: "[OPERATOR] message 1" }, async () => ({ result: "ok" }));
  check("section12.K1a: a later turn with the delivery's text stamps nothing", readStoreRecord(h, key)?.turnId === undefined);
  check("section12.K1a: a later turn writes no operator_stamp_withheld naming the record",
    !getDecisions(h).some((d) => d.action === "operator_stamp_withheld" && d.detail.includes(id)));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-after-drop-k1a", answer: "unrelated", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.K1a: no reply written", !h.storeMap.has(`reply:default:${id}`));

  clock.advance(10_000);
  await tickAndSettle(h, clock, 50);
  check("section12.K1a: the next tick does not retry the delivery", (h.promptSubmits || []).filter((p) => p.startsWith("[OPERATOR]")).length === 1 && readStoreRecord(h, key)?.status === "delivered");
}

// K1 (B): the ask-answer delivery dropped: the same, and the ask stays
// closed with pendingAskId as the delivery wrote it.
async function caseSection12_K1_droppedAskAnswerSubmitLeavesTheAskClosed(clock) {
  console.log("\n=== Section 12 K1 (B): a dropped ask-answer submit leaves the ask closed and the record delivered ===");
  clock.set(T0);
  const now = T0;
  const ha = await createTickHarness({ ...OPTS, caseName: "section12_k1_b_ask_dropped" });
  ha.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  const personaState = buildPersonaState(SESSION_ID, now);
  personaState.goals = [
    { id: "node-k1b", kind: "leaf", objective: "Goal", status: "paused", blockedReason: "operator input needed", completedRounds: 0, maxRounds: 3, scores: [], createdAt: now - 10000, updatedAt: now - 5000, children: [] },
  ];
  personaState.activeGoalId = "node-k1b";
  personaState.pendingAskId = "ask-k1b-1";
  ha.fsMap.set(".agentic-personas.json", JSON.stringify({ default: personaState }));
  ha.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: SESSION_ID, epoch: 1, lastSeen: now } }));
  seedReaderClaim(ha, "writer-k1b", now);
  const answerKey = seedInboxRecord(ha, "writer-k1b", 1, { at: now - 500, kind: "answer", answers: "ask-k1b-1", status: "pending" });
  const startH = ha.handlers["session.start"];
  if (startH) await startH(ha.fake, {}, () => {});
  const askKey = "ask:default:ask-k1b-1";
  ha.storeMap.set(askKey, { id: "ask-k1b-1", ownerSessionId: SESSION_ID, at: now - 1000, nodeId: "node-k1b", question: "Which way?", status: "open" });

  ha.dropNextPromptSubmit("hook beneath refused the answer");
  clock.advance(65_000);
  await tickAndSettle(ha, clock, 50);
  check("section12.K1b: the answer delivery was attempted (setup sanity)", (ha.promptSubmits || []).some((p) => p.startsWith("[OPERATOR] Answer to")));
  const rec = readStoreRecord(ha, answerKey);
  check("section12.K1b: the answer record stays delivered with deliveredAt intact", rec?.status === "delivered" && typeof rec?.deliveredAt === "number", rec);
  check("section12.K1b: the ask stays answered", readStoreRecord(ha, askKey)?.status === "answered");
  const state = getState(ha);
  check("section12.K1b: pendingAskId stays cleared", state.pendingAskId === undefined);
  check("section12.K1b: operator_delivery_failed names the record and the drop reason",
    state.decisions.some((d) => d.action === "operator_delivery_failed" && d.detail.includes("default-writer-k1b-1") && d.detail.includes("submit dropped") && d.detail.includes("hook beneath refused the answer")));
  await ha.handlers["turn.start"](ha.fake, { turnId: "t-after-drop-k1b", text: "[OPERATOR] Answer to Which way?: message 1" }, async () => ({ result: "ok" }));
  check("section12.K1b: a later turn with the answer's text stamps nothing", readStoreRecord(ha, answerKey)?.turnId === undefined);
  await ha.handlers["turn.complete"](ha.fake, { turnId: "t-after-drop-k1b", answer: "unrelated", reason: "completed" }, async () => ({ result: "ok" }));
  clock.advance(10_000);
  await tickAndSettle(ha, clock, 50);
  check("section12.K1b: the next tick retries nothing", (ha.promptSubmits || []).filter((p) => p.startsWith("[OPERATOR]")).length === 1 && readStoreRecord(ha, answerKey)?.status === "delivered");
}

// K1 (C): a nudge whose submit is dropped consumes its own entry and its
// failure decision names the reason. Observed through a queued delivery: a
// turn opening with the dropped nudge's text matches nothing, so it reads
// unaccounted and withholds the delivery's stamp, where a surviving nudge
// entry would have matched it as the nudge and withheld nothing.
async function caseSection12_K1_droppedNudgeSubmitConsumesItsEntry(clock) {
  console.log("\n=== Section 12 K1 (C): a dropped budget nudge consumes its entry and records the drop reason ===");
  clock.set(T0);
  const now = T0;
  const h = await createTickHarness({
    ...OPTS,
    caseName: "section12_k1_c_nudge_dropped",
    contextBudgetEnabled: true,
    contextBudgetInfoTokens: 100,
    contextBudgetCloseoutTokens: 200,
    contextBudgetCriticalTokens: 1_000_000,
    contextBudgetReadEveryNTicks: 1,
    sessionMessages: () => Promise.resolve([{ text: "x".repeat(2000), toolUses: [], toolResults: [] }]),
  });
  // A goal-less tree, so the tick returns after the budget read and no goal
  // nudge rides on the same dropped submit.
  h.storeMap.set(`commons:${SESSION_ID}`, {
    sessionId: SESSION_ID,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 2000 }],
  });
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: buildPersonaState(SESSION_ID, now) }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: SESSION_ID, epoch: 1, lastSeen: now } }));
  const startH = h.handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});

  h.dropNextPromptSubmit("hook beneath refused the nudge");
  clock.advance(10_000);
  await tickAndSettle(h, clock, 50);
  const nudgeText = (h.promptSubmits || []).find((p) => p.startsWith("[BUDGET]"));
  check("section12.K1c: the budget nudge was attempted (setup sanity)", typeof nudgeText === "string");
  check("section12.K1c: context_budget_nudge_failed names the drop reason and no context_budget_nudge was logged",
    getDecisions(h).some((d) => d.action === "context_budget_nudge_failed" && d.detail.includes("submit dropped") && d.detail.includes("hook beneath refused the nudge")) && !getDecisions(h).some((d) => d.action === "context_budget_nudge"));

  // A delivery queues behind the dropped nudge, then a turn opens with the
  // nudge's own text.
  seedReaderClaim(h, "writer-k1c", clock.get());
  const key = seedInboxRecord(h, "writer-k1c", 1, { at: clock.get() - 500, status: "pending" });
  const id = "default-writer-k1c-1";
  clock.advance(10_000);
  await tickAndSettle(h, clock, 50);
  check("section12.K1c: record delivered (setup sanity)", readStoreRecord(h, key)?.status === "delivered");
  await h.handlers["turn.start"](h.fake, { turnId: "t-nudge-text-k1c", text: nudgeText }, async () => ({ result: "ok" }));
  check("section12.K1c: a turn with the dropped nudge's text reads unaccounted and withholds the delivery's stamp",
    getDecisions(h).some((d) => d.action === "operator_stamp_withheld" && d.detail.includes(id) && d.detail.includes("unaccounted")));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-nudge-text-k1c", answer: "not the nudge", reason: "completed" }, async () => ({ result: "ok" }));
  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-k1c" }, async () => ({ result: "ok" }));
  check("section12.K1c: the delivery's own turn still takes the stamp", readStoreRecord(h, key)?.turnId === "t-delivery-k1c");
  await fireTurn(h, "t-flush-k1c");
}

// K2 (D): the text a turn opens with is the text as the hook chain beneath
// the plugin left it, which $.prompt.submit resolves as { text }. A
// delivery whose submit settles to a rewritten text, and whose turn opens
// with that settled text, still takes the stamp and files the reply.
async function caseSection12_K2_settledTextMatchesTheDeliveryTurn(clock) {
  console.log("\n=== Section 12 K2 (D): a delivery turn opening with the settled text takes the stamp ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_k2_d_settled", now, "writer-k2d");
  h.settleNextPromptSubmit((text) => "[relay] " + text);
  await tickAndSettle(h, clock, 50);
  check("section12.K2d: the delivery was submitted with its own text (setup sanity)", (h.promptSubmits || []).includes("[OPERATOR] message 1"));
  check("section12.K2d: the turn queued with the settled text (setup sanity)", h.queuedTurnTexts[0] === "[relay] [OPERATOR] message 1");
  await h.handlers["turn.start"](h.fake, { turnId: "t-settled-k2d" }, async () => ({ result: "ok" }));
  check("section12.K2d: the turn opening with the settled text takes the stamp", readStoreRecord(h, key)?.turnId === "t-settled-k2d");
  check("section12.K2d: no operator_stamp_withheld", !getDecisions(h).some((d) => d.action === "operator_stamp_withheld"));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-settled-k2d", answer: "Delivered answer.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.K2d: the reply is filed", readStoreRecord(h, `reply:default:${id}`)?.text === "Delivered answer.");
}

// K2 (E): the contract does not order the submit promise settling against
// turn.start, so a turn that opens with the submitted text before the
// submit has settled still matches on that key. The submit is parked here,
// so the settled text has not been read when the turn opens.
async function caseSection12_K2_submittedTextStillMatchesBeforeTheSubmitSettles(clock) {
  console.log("\n=== Section 12 K2 (E): a delivery turn opening with the submitted text before the submit settles takes the stamp ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_k2_e_presettle", now, "writer-k2e");
  h.settleNextPromptSubmit((text) => "[relay] " + text);
  h.holdPromptSubmits();
  const tick = fireTick(h);
  const queued = await waitUntil(() => (h.promptSubmits || []).some((p) => p.startsWith("[OPERATOR]")));
  check("section12.K2e: the delivery's submit is parked (setup sanity)", queued);
  await h.handlers["turn.start"](h.fake, { turnId: "t-presettle-k2e", text: "[OPERATOR] message 1" }, async () => ({ result: "ok" }));
  check("section12.K2e: the turn opening with the submitted text takes the stamp", readStoreRecord(h, key)?.turnId === "t-presettle-k2e");
  await h.handlers["turn.complete"](h.fake, { turnId: "t-presettle-k2e", answer: "Delivered answer.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.K2e: the reply is filed", readStoreRecord(h, `reply:default:${id}`)?.text === "Delivered answer.");
  h.releasePromptSubmits();
  await tick;
  check("section12.K2e: no operator_stamp_withheld after the submit settles", !getDecisions(h).some((d) => d.action === "operator_stamp_withheld"));
}

// L1 (A): a delivery entry whose turn never opens with a matching text
// outlives its record once the TTL sweep removes it. The withheld branch
// reads the store and drops the entry, so no later unmatched turn writes an
// operator_stamp_withheld naming a record that is gone. The sweep is driven
// through the tick with a short operatorRecordTtlMs: the delivery tick
// returns early, and the second tick after it reaches the summary cadence.
async function caseSection12_L1_sweptRecordDropsItsDeliveryEntry(clock) {
  console.log("\n=== Section 12 L1 (A): a delivery entry whose record was swept is dropped, and no withheld line names it ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_l1_a_swept", now, "writer-l1a", { operatorRecordTtlMs: 1000 });
  await tickAndSettle(h, clock, 50);
  check("section12.L1a: record delivered and its turn never opened (setup sanity)", readStoreRecord(h, key)?.status === "delivered" && readStoreRecord(h, key)?.turnId === undefined);
  clock.advance(5_000);
  await tickAndSettle(h, clock, 50);
  await tickAndSettle(h, clock, 50);
  check("section12.L1a: the TTL sweep removed the record (setup sanity)", !h.storeMap.has(key));

  await h.handlers["turn.start"](h.fake, { turnId: "t-ext-1-l1a", text: "typed after the sweep" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-ext-1-l1a", answer: "first answer", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.L1a: no operator_stamp_withheld names the swept record",
    !getDecisions(h).some((d) => d.action === "operator_stamp_withheld" && d.detail.includes(id)));
  await h.handlers["turn.start"](h.fake, { turnId: "t-ext-2-l1a", text: "typed again" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-ext-2-l1a", answer: "second answer", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.L1a: a second external turn names nothing either (the entry is gone)",
    !getDecisions(h).some((d) => d.action === "operator_stamp_withheld"));
}

// L1 (B): the same exit when the record is resolved rather than swept.
// agentic_resolve accepts a delivered record whether or not it is stamped,
// so the parked delivery's record is resolved through the tool, after
// which it is no longer delivered and unstamped and the entry is dropped.
async function caseSection12_L1_resolvedRecordDropsItsDeliveryEntry(clock) {
  console.log("\n=== Section 12 L1 (B): a delivery entry whose record was resolved is dropped, and no withheld line names it ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_l1_b_resolved", now, "writer-l1b");
  await tickAndSettle(h, clock, 50);
  check("section12.L1b: record delivered and its turn never opened (setup sanity)", readStoreRecord(h, key)?.status === "delivered" && readStoreRecord(h, key)?.turnId === undefined);
  const r = await h.handlers["tool.call"](h.fake, { tool: "mcp__agentic-plugin__agentic_resolve", id, outcome: "declined", note: "" }, async () => ({ result: "passthrough" }));
  check("section12.L1b: resolve accepted the unstamped delivered record (setup sanity)", r?.deny === undefined && readStoreRecord(h, key)?.status === "resolved", r);

  await h.handlers["turn.start"](h.fake, { turnId: "t-ext-1-l1b", text: "typed after the resolve" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-ext-1-l1b", answer: "first answer", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.L1b: no operator_stamp_withheld names the resolved record",
    !getDecisions(h).some((d) => d.action === "operator_stamp_withheld" && d.detail.includes(id)));
  await h.handlers["turn.start"](h.fake, { turnId: "t-ext-2-l1b", text: "typed again" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-ext-2-l1b", answer: "second answer", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.L1b: a second external turn names nothing either (the entry is gone)",
    !getDecisions(h).some((d) => d.action === "operator_stamp_withheld"));
}

// L1 (C): two deliveries parked, the first's record swept and the second's
// live: the withheld line names the second record, the first entry is gone,
// and the second entry still stamps its own turn. The records carry
// different texts so the two entries cannot match one turn.
async function caseSection12_L1_withheldLineNamesTheFirstLiveRecord(clock) {
  console.log("\n=== Section 12 L1 (C): with a swept and a live delivery queued, the withheld line names the live one ===");
  clock.set(T0);
  const now = T0;
  const { h, key: key1, id: id1 } = await seedOwnerWithPendingRecord("section12_l1_c_two", now, "writer-l1c1", { operatorRecordTtlMs: 4000 });
  seedReaderClaim(h, "writer-l1c2", now);
  const key2 = seedInboxRecord(h, "writer-l1c2", 1, { at: now - 4000, status: "pending", text: "second message" });
  const id2 = "default-writer-l1c2-1";
  await tickAndSettle(h, clock, 50);
  check("section12.L1c: the first record delivered first (setup sanity)", readStoreRecord(h, key1)?.status === "delivered" && readStoreRecord(h, key2)?.status === "pending");
  clock.advance(3_000);
  await tickAndSettle(h, clock, 50);
  check("section12.L1c: the second record delivered (setup sanity)", readStoreRecord(h, key2)?.status === "delivered");
  clock.advance(2_000);
  await tickAndSettle(h, clock, 50);
  await tickAndSettle(h, clock, 50);
  check("section12.L1c: the sweep removed the first record and kept the second (setup sanity)", !h.storeMap.has(key1) && readStoreRecord(h, key2)?.status === "delivered");

  await h.handlers["turn.start"](h.fake, { turnId: "t-ext-l1c", text: "typed between" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-ext-l1c", answer: "typed answer", reason: "completed" }, async () => ({ result: "ok" }));
  const withheld = getDecisions(h).filter((d) => d.action === "operator_stamp_withheld");
  check("section12.L1c: the withheld line names the live second record and not the swept first",
    withheld.length === 1 && withheld[0].detail.includes(id2) && !withheld[0].detail.includes(id1), withheld);
  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-l1c", text: "[OPERATOR] second message" }, async () => ({ result: "ok" }));
  check("section12.L1c: the second delivery's own turn still takes the stamp", readStoreRecord(h, key2)?.turnId === "t-delivery-l1c");
  await h.handlers["turn.complete"](h.fake, { turnId: "t-delivery-l1c", answer: "Delivered answer.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.L1c: the second delivery's turn files the reply", readStoreRecord(h, `reply:default:${id2}`)?.text === "Delivered answer.");
}

// M1 (A): the withheld branch's store read can span a tick that delivers
// another record. The tick reads R2 pending, an unmatched turn opens and its
// withheld read reads R2 pending too, then the tick marks R2 delivered and
// queues its entry while that read is still parked. The entry pushed during
// the read is not judged against it, so R2's own turn still takes the stamp.
async function caseSection12_M1_deliveryQueuedDuringTheWithheldReadIsKept(clock) {
  console.log("\n=== Section 12 M1 (A): a delivery queued while the withheld read is parked keeps its entry ===");
  clock.set(T0);
  const now = T0;
  const { h, key: key1, id: id1 } = await seedOwnerWithPendingRecord("section12_m1_a_race", now, "writer-m1a1");
  await tickAndSettle(h, clock, 50);
  check("section12.M1a: E1 delivered and its turn never opened (setup sanity)", readStoreRecord(h, key1)?.status === "delivered" && readStoreRecord(h, key1)?.turnId === undefined);
  seedReaderClaim(h, "writer-m1a2", clock.get());
  const key2 = seedInboxRecord(h, "writer-m1a2", 1, { at: clock.get() - 100, status: "pending", text: "second message" });
  const id2 = "default-writer-m1a2-1";

  h.holdStoreGets(key2);
  clock.advance(3_000);
  const tick = fireTick(h);
  check("section12.M1a: the tick's inbox read of R2 is parked (setup sanity)", await waitUntil(() => h.parkedStoreGetCount === 1));
  const turnStart = h.handlers["turn.start"](h.fake, { turnId: "t-unmatched-m1a", text: "typed during the delivery" }, async () => ({ result: "ok" }));
  check("section12.M1a: the withheld branch's read of R2 is parked too (setup sanity)", await waitUntil(() => h.parkedStoreGetCount === 2));
  h.releaseStoreGet();
  await tick;
  check("section12.M1a: the tick delivered R2 while the withheld read was parked (setup sanity)",
    readStoreRecord(h, key2)?.status === "delivered" && (h.promptSubmits || []).includes("[OPERATOR] second message"));
  h.releaseStoreGet();
  await turnStart;
  const withheld = getDecisions(h).filter((d) => d.action === "operator_stamp_withheld");
  check("section12.M1a: the withheld line names E1", withheld.length === 1 && withheld[0].detail.includes(id1), withheld);
  await h.handlers["turn.complete"](h.fake, { turnId: "t-unmatched-m1a", answer: "typed answer", reason: "completed" }, async () => ({ result: "ok" }));

  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-m1a", text: "[OPERATOR] second message" }, async () => ({ result: "ok" }));
  check("section12.M1a: R2's own turn takes the stamp", readStoreRecord(h, key2)?.turnId === "t-delivery-m1a");
  await h.handlers["turn.complete"](h.fake, { turnId: "t-delivery-m1a", answer: "Delivered answer.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.M1a: R2's turn files the reply", readStoreRecord(h, `reply:default:${id2}`)?.text === "Delivered answer.");
}

// N1: a sender's next record is numbered from its highest seq still in the
// store, so once the sweep removes a delivered record whose turn never
// opened, the sender's next record takes the same id and reads pending.
// The swept delivery's entry is dropped rather than kept on that pending
// record, so no withheld line names a record that was never delivered. The
// new record is written straight into the store in the shape
// writeInboxRecord gives it, and no tick runs after it, so it stays pending.
async function caseSection12_N1_reusedRecordIdDoesNotKeepASweptDeliveryEntry(clock) {
  console.log("\n=== Section 12 N1: a pending record reusing a swept delivery's id does not keep its entry ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_n1_reused_id", now, "writer-n1", { operatorRecordTtlMs: 1000 });
  await tickAndSettle(h, clock, 50);
  check("section12.N1: record delivered and its turn never opened (setup sanity)", readStoreRecord(h, key)?.status === "delivered" && readStoreRecord(h, key)?.turnId === undefined);
  clock.advance(5_000);
  await tickAndSettle(h, clock, 50);
  await tickAndSettle(h, clock, 50);
  check("section12.N1: the TTL sweep removed the record (setup sanity)", !h.storeMap.has(key));

  seedReaderClaim(h, "writer-n1", clock.get());
  const reusedKey = seedInboxRecord(h, "writer-n1", 1, { at: clock.get(), status: "pending", text: "a later message" });
  check("section12.N1: the new record reuses the swept id and reads pending (setup sanity)", reusedKey === key && readStoreRecord(h, key)?.id === id && readStoreRecord(h, key)?.status === "pending");

  await h.handlers["turn.start"](h.fake, { turnId: "t-ext-1-n1", text: "typed after the reuse" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-ext-1-n1", answer: "first answer", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.N1: no operator_stamp_withheld names the reused id",
    !getDecisions(h).some((d) => d.action === "operator_stamp_withheld" && d.detail.includes(id)));
  await h.handlers["turn.start"](h.fake, { turnId: "t-ext-2-n1", text: "typed again" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-ext-2-n1", answer: "second answer", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.N1: a second external turn names nothing either (the entry is gone)",
    !getDecisions(h).some((d) => d.action === "operator_stamp_withheld"));
}

// M1 (B): a withheld read that throws leaves every queued entry in place,
// writes no withheld line, and the turn still reaches the hooks beneath.
async function caseSection12_M1_throwingWithheldReadKeepsEveryEntry(clock) {
  console.log("\n=== Section 12 M1 (B): a throwing withheld read keeps every entry and the turn continues ===");
  clock.set(T0);
  const now = T0;
  const { h, key, id } = await seedOwnerWithPendingRecord("section12_m1_b_throw", now, "writer-m1b");
  await tickAndSettle(h, clock, 50);
  check("section12.M1b: record delivered and its turn never opened (setup sanity)", readStoreRecord(h, key)?.status === "delivered" && readStoreRecord(h, key)?.turnId === undefined);

  const realKeys = h.fake.store.keys;
  let refused = 0;
  h.fake.store.keys = () => {
    if (refused === 0) {
      refused++;
      return Promise.reject(new Error("store read refused"));
    }
    return realKeys();
  };
  let nextCalled = false;
  let threw = null;
  try {
    await h.handlers["turn.start"](h.fake, { turnId: "t-unmatched-m1b", text: "typed while the store refuses" }, async () => { nextCalled = true; return { result: "ok" }; });
  } catch (err) {
    threw = err;
  }
  h.fake.store.keys = realKeys;
  check("section12.M1b: the store read was attempted and refused (setup sanity)", refused === 1);
  check("section12.M1b: turn.start does not throw and reaches the hooks beneath", threw === null && nextCalled, threw);
  await h.handlers["turn.complete"](h.fake, { turnId: "t-unmatched-m1b", answer: "typed answer", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.M1b: no operator_stamp_withheld on a refused read",
    !getDecisions(h).some((d) => d.action === "operator_stamp_withheld"));

  await h.handlers["turn.start"](h.fake, { turnId: "t-delivery-m1b", text: "[OPERATOR] message 1" }, async () => ({ result: "ok" }));
  check("section12.M1b: the delivery's entry was kept, so its own turn takes the stamp", readStoreRecord(h, key)?.turnId === "t-delivery-m1b");
  await h.handlers["turn.complete"](h.fake, { turnId: "t-delivery-m1b", answer: "Delivered answer.", reason: "completed" }, async () => ({ result: "ok" }));
  check("section12.M1b: the delivery's turn files the reply", readStoreRecord(h, `reply:default:${id}`)?.text === "Delivered answer.");
}

// agentic_say(urgent: true) writes urgent onto the record; a plain say does not.
async function caseItem8p3_sayCarriesUrgent(clock) {
  console.log("\n=== Item 8.3: agentic_say threads the urgent flag onto the record ===");
  clock.set(T0);
  const now = T0;
  const h = await seedReaderHarness("item8p3_say_urgent", now, "owner-urgent-001", {});
  const toolCallH = h.handlers["tool.call"];
  await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_say", text: "stop now", urgent: true }, async () => ({ result: "passthrough" }));
  await toolCallH(h.fake, { tool: "mcp__agentic-plugin__agentic_say", text: "no rush" }, async () => ({ result: "passthrough" }));
  const recs = [...h.storeMap.keys()].filter(k => k.startsWith("inbox:default:")).map(k => h.storeMap.get(k)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  check("item8.3 say urgent: two records written (setup sanity)", recs.length === 2);
  const urgentRec = recs.find(r => r.text === "stop now");
  const plainRec = recs.find(r => r.text === "no rush");
  check("item8.3 say urgent: urgent record carries urgent === true", urgentRec?.urgent === true);
  check("item8.3 say urgent control: plain record carries no urgent flag", plainRec?.urgent === undefined);
}

// An urgent pending record from a live reader reaches the owner inside the
// running turn: the next passthrough tool call's result carries the text as
// context, the record is marked delivered and stamped with the turn, and the
// decision log records it. Controls: a plain pending record is untouched by
// the same call, and an urgent record from a writer with no live reader claim
// is left for the tick's own skip path.
async function caseItem8p3_urgentBreaksIntoRunningTurn(clock) {
  console.log("\n=== Item 8.3: an urgent record breaks into the running turn via the tool result ===");
  clock.set(T0);
  const now = T0;
  const readerSid = "urgent-reader-001";
  const deadSid = "urgent-dead-002";
  const h = await seedOwnerHarness("item8p3_urgent_breakin", now);

  h.storeMap.set(`commons:${readerSid}`, {
    sessionId: readerSid,
    lastSeen: now,
    claims: [{ resource: "reader:default", claimedAt: now - 1000 }],
  });
  const urgentKey = `inbox:default:${readerSid}:1`;
  h.storeMap.set(urgentKey, { id: "urgent-1", key: urgentKey, from: readerSid, at: now - 5000, text: "Stop and commit what you have.", kind: "say", status: "pending", urgent: true });
  const plainKey = `inbox:default:${readerSid}:2`;
  h.storeMap.set(plainKey, { id: "plain-2", key: plainKey, from: readerSid, at: now - 4000, text: "No hurry on this one.", kind: "say", status: "pending" });
  const deadKey = `inbox:default:${deadSid}:1`;
  h.storeMap.set(deadKey, { id: "dead-1", key: deadKey, from: deadSid, at: now - 3000, text: "From a writer with no claim.", kind: "say", status: "pending", urgent: true });

  const turnStartH = h.handlers["turn.start"];
  await turnStartH(h.fake, { turnId: "t-long" }, async () => ({ result: "ok" }));

  const toolCallH = h.handlers["tool.call"];
  const r = await toolCallH(h.fake, { tool: "Bash", command: "ls" }, async () => ({ result: { stdout: "a.txt" }, text: "a.txt" }));
  check("item8.3 urgent: real tool result kept", r.text === "a.txt" && r.deny === undefined);
  const ctx = Array.isArray(r.context) ? r.context.join("\n") : "";
  check("item8.3 urgent: tool result context carries the urgent text", ctx.includes("Stop and commit what you have."));
  check("item8.3 urgent: context names it as an urgent operator message", ctx.includes("[OPERATOR"));
  check("item8.3 urgent: control text not folded into the context", !ctx.includes("No hurry on this one.") && !ctx.includes("From a writer with no claim."));

  const urgentRec = h.storeMap.get(urgentKey);
  check("item8.3 urgent: record marked delivered", urgentRec?.status === "delivered");
  check("item8.3 urgent: record stamped with the running turn", urgentRec?.turnId === "t-long");
  check("item8.3 urgent control: plain record still pending", h.storeMap.get(plainKey)?.status === "pending");
  check("item8.3 urgent control: dead writer's urgent record still pending", h.storeMap.get(deadKey)?.status === "pending");
  check("item8.3 urgent: operator_delivered_urgent decision logged", getDecisions(h).some(d => d.action === "operator_delivered_urgent" && d.detail.includes("urgent-1")));

  // A second call in the same turn finds nothing new and adds no context.
  const r2 = await toolCallH(h.fake, { tool: "Bash", command: "ls" }, async () => ({ result: { stdout: "b.txt" }, text: "b.txt" }));
  check("item8.3 urgent: second call in the turn adds no context", r2.context === undefined);
}

// ============================================================
// Item 8.4: the worker finds the next three itself
// ============================================================

// A kaizen node is a plan under the root carrying the signal it was raised
// for; the harness reads it back from the persisted store.
function findKaizenNodes(h, signal) {
  return getState(h).goals.filter(g => g.kaizenSignal === signal);
}

// Runs one periodic self-review over a seeded decision log and memory. The
// model stub returns a proof-backed lesson, so if the model path runs at all
// it would be kept as a memory entry; the assertions below distinguish the
// two paths by whether that lesson landed.
async function runOwnRecordReview(clock, caseName, seededDecisions, extra = {}) {
  clock.set(T0);
  const root = {
    id: "root-goal", parentId: null, kind: "root", title: "Roadmap", objective: "Roadmap",
    status: "pending", source: "operator", maxRounds: 0, completedRounds: 0, scores: [], notes: [],
    planningRounds: 1, consecutiveBlockedPlannings: 0, consecutivePlanningFailures: 0, planningRound: 0,
    createdAt: T0 - 20000, updatedAt: T0 - 20000,
  };
  const planA = { ...root, id: "plan-a", parentId: "root-goal", kind: "plan", title: "Roadmap item A", objective: "A", maxRounds: 10, planningRounds: 0, createdAt: T0 - 19000, updatedAt: T0 - 19000 };
  const planB = { ...planA, id: "plan-b", title: "Roadmap item B", objective: "B", createdAt: T0 - 18000, updatedAt: T0 - 18000 };
  const goals = [root, planA, planB, ...(extra.goals || [])];
  const h = await createTickHarness({
    ...OPTS,
    caseName,
    stateOpts: {
      now: T0,
      goals,
      activeGoalId: null,
      selfReview: { count: 0, lastAt: 0, turnsSince: 0, windowStart: 0, pendingPeriodic: true, lastInjectAt: 0 },
    },
    classifyValue: "NONE",
  });
  // Seed the decision log and memory into the persisted store, then reload
  // through session.start the way the running module reads its own file.
  const raw = JSON.parse(h.fsMap.get(".agentic-personas.json"));
  raw.default.decisions = seededDecisions;
  raw.default.memory = extra.memory || [];
  h.fsMap.set(".agentic-personas.json", JSON.stringify(raw));
  const startH = h.handlers["session.start"];
  await startH(h.fake, {}, () => {});
  h.fake.model.complete = async () => {
    h.completeCalls.push(1);
    return extra.lesson ?? "The test suite confirmed the fix: verified by a passing harness case.";
  };
  await tickAndSettle(h, clock, 100);
  return h;
}

// Proof line, half one: a seeded log with a repeated weakness (two asks
// that ran out the clock) produces a kaizen goal node with a proof line, a
// one-line rationale posted to the thread, and no memory lesson.
async function caseItem8p4_repeatedWeaknessBecomesKaizenGoal(clock) {
  console.log("\n=== Item 8.4: a repeated weakness becomes a kaizen goal, not a memory lesson ===");
  const seeded = [
    { timestamp: T0 - 9000, loop: "monitor", action: "ask_opened", detail: "plan-a: ASK: which base? Recommend: main" },
    { timestamp: T0 - 8000, loop: "monitor", action: "ask_timeout", detail: "plan-a: ask ask-1 expired after 3600s" },
    { timestamp: T0 - 7000, loop: "monitor", action: "ask_opened", detail: "plan-a: ASK: which suite? Recommend: live-all" },
    { timestamp: T0 - 6000, loop: "monitor", action: "ask_timeout", detail: "plan-a: ask ask-2 expired after 3600s" },
  ];
  const h = await runOwnRecordReview(clock, "item8p4_repeated", seeded);
  const state = getState(h);
  const nodes = findKaizenNodes(h, "asks_unresolved");
  check("item8.4 goal: exactly one kaizen node raised for asks_unresolved", nodes.length === 1);
  const node = nodes[0];
  check("item8.4 goal: the node is a plan under the root", !!node && node.kind === "plan" && node.parentId === "root-goal");
  check("item8.4 goal: the node is interleaved after the next roadmap plan (sortKey between plan-a and plan-b)",
    !!node && typeof node.sortKey === "number" && node.sortKey > (T0 - 19000) && node.sortKey < (T0 - 18000));
  check("item8.4 goal: kaizen_goal_proposed decision names the signal",
    state.decisions.some(d => d.action === "kaizen_goal_proposed" && d.detail.includes("asks_unresolved")));
  check("item8.4 goal: one-line rationale posted to the thread ([KAIZEN] prompt submitted)",
    h.promptSubmits.some(t => t.includes("[KAIZEN]") && t.includes("asks_unresolved")));
  check("item8.4 goal: no memory lesson written (no self-review memory entry)",
    !state.memory.some(m => m.source === "self-review"));
  check("item8.4 goal: the model lesson call was skipped for this review", h.completeCalls.length === 0);
  check("item8.4 goal: the review still counted against the cap (selfReview.count 1)", state.monitor.selfReview.count === 1);
}

// Proof line, half two (control): a log with the same weakness once produces
// neither a kaizen node nor a memory lesson; the model path runs and says NONE.
async function caseItem8p4_control_singleEventProducesNeither(clock) {
  console.log("\n=== Item 8.4 control: one event is not repeated; neither goal nor lesson ===");
  const seeded = [
    { timestamp: T0 - 9000, loop: "monitor", action: "ask_opened", detail: "plan-a: ASK: which base? Recommend: main" },
    { timestamp: T0 - 8000, loop: "monitor", action: "ask_timeout", detail: "plan-a: ask ask-1 expired after 3600s" },
    { timestamp: T0 - 7000, loop: "monitor", action: "ask_opened", detail: "plan-a: ASK: which suite? Recommend: live-all" },
    { timestamp: T0 - 6000, loop: "monitor", action: "ask_answered", detail: "ask ask-2 closed by record r-1" },
  ];
  const h = await runOwnRecordReview(clock, "item8p4_control", seeded, { lesson: "NONE" });
  const state = getState(h);
  check("item8.4 control: no kaizen node", !state.goals.some(g => g.kaizenSignal));
  check("item8.4 control: no kaizen_goal_proposed decision", !state.decisions.some(d => d.action === "kaizen_goal_proposed"));
  check("item8.4 control: no memory lesson", !state.memory.some(m => m.source === "self-review"));
  check("item8.4 control: the model path ran and the review was recorded",
    h.completeCalls.length === 1 && state.decisions.some(d => d.action === "self-review"));
  check("item8.4 control: nothing posted to the thread", !h.promptSubmits.some(t => t.includes("[KAIZEN]")));
}

// An open kaizen goal for a signal is not raised twice while it is open.
async function caseItem8p4_openKaizenGoalNotDuplicated(clock) {
  console.log("\n=== Item 8.4: an open kaizen goal suppresses a second one for the same signal ===");
  const seeded = [
    { timestamp: T0 - 8000, loop: "monitor", action: "ask_timeout", detail: "plan-a: ask ask-1 expired after 3600s" },
    { timestamp: T0 - 6000, loop: "monitor", action: "ask_timeout", detail: "plan-a: ask ask-2 expired after 3600s" },
  ];
  const existing = {
    id: "plan-kaizen-open", parentId: "root-goal", kind: "plan", title: "Kaizen: asks run out the clock", objective: "Proof: ...",
    status: "pending", source: "controller", maxRounds: 10, completedRounds: 0, scores: [], notes: [],
    planningRounds: 0, consecutiveBlockedPlannings: 0, consecutivePlanningFailures: 0, planningRound: 0,
    createdAt: T0 - 10000, updatedAt: T0 - 10000, kaizenSignal: "asks_unresolved",
  };
  const h = await runOwnRecordReview(clock, "item8p4_open_dedupe", seeded, { goals: [existing], lesson: "NONE" });
  check("item8.4 dedupe: still exactly one kaizen node for asks_unresolved", findKaizenNodes(h, "asks_unresolved").length === 1);
  check("item8.4 dedupe: no kaizen_goal_proposed decision", !getDecisions(h).some(d => d.action === "kaizen_goal_proposed"));
}

// A weakness the loop can fix by changing its own configuration is fixed and
// reported, not proposed: repeated turns past an hour halve the periodic
// review cadence (turn-counted) and post the change, with no goal node.
async function caseItem8p4_longTurnsAdjustConfigNotGoal(clock) {
  console.log("\n=== Item 8.4: repeated long turns adjust selfReviewEveryTurns and report, no goal ===");
  const seeded = [
    { timestamp: T0 - 8000, loop: "monitor", action: "turn_over_hour", detail: "Turn 3 ran 3720s" },
    { timestamp: T0 - 6000, loop: "monitor", action: "turn_over_hour", detail: "Turn 5 ran 4100s" },
  ];
  const h = await runOwnRecordReview(clock, "item8p4_config_fix", seeded);
  const state = getState(h);
  check("item8.4 config: kaizen_config_adjusted decision recorded",
    state.decisions.some(d => d.action === "kaizen_config_adjusted"));
  check("item8.4 config: no kaizen node for long_turns", findKaizenNodes(h, "long_turns").length === 0);
  check("item8.4 config: the change is reported to the thread", h.promptSubmits.some(t => t.includes("[KAIZEN]") && t.includes("selfReviewEveryTurns")));
  check("item8.4 config: no memory lesson written", !state.memory.some(m => m.source === "self-review"));
}

// turn.complete records a turn that ran past an hour as a decision, so the
// own-record pass can count it; a short turn records nothing.
async function caseItem8p4_turnOverHourRecorded(clock) {
  console.log("\n=== Item 8.4: a turn past an hour is recorded, a short one is not ===");
  clock.set(T0);
  const h = await seedOwnerHarness("item8p4_turn_over_hour", T0);
  const startH = h.handlers["turn.start"];
  const completeH = h.handlers["turn.complete"];
  await startH(h.fake, { turnId: "t-short" }, async () => ({ result: "ok" }));
  clock.advance(5 * 60_000);
  await completeH(h.fake, { turnId: "t-short", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  check("item8.4 long turn control: a five-minute turn records no turn_over_hour", !getDecisions(h).some(d => d.action === "turn_over_hour"));
  await startH(h.fake, { turnId: "t-long" }, async () => ({ result: "ok" }));
  clock.advance(61 * 60_000);
  await completeH(h.fake, { turnId: "t-long", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  const rec = getDecisions(h).find(d => d.action === "turn_over_hour");
  check("item8.4 long turn: a sixty-one-minute turn records turn_over_hour with its duration", !!rec && /3660s/.test(rec.detail));
}

main().catch(e => { console.error(e); process.exit(1); });

// Section 10: goal_done closes the node goal_add just activated in the same
// turn, with no controller tick running in between - the exact sequence the
// defect broke (goal_done denied "No active goal leaf to complete" because
// the node stayed pending).
async function caseSection10_goalDoneClosesSameTurnNoTickBetween(clock) {
  console.log("\n=== Section 10: goal_done closes the goal_add-activated node with no tick between ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "section10_goal_done_same_turn",
    stateOpts: { now: T0, goals: [rootGoal], activeGoalId: null },
  });

  const toolCallH = h.handlers["tool.call"];
  const addResult = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "plan",
    title: "New plan",
    objective: "Do the newly added work",
  }, async () => ({ result: "passthrough" }));
  check("section10 done: goal_add not denied", addResult.deny === undefined, addResult.deny);

  // No tick fires here - fireTick/tickAndSettle is never called between
  // goal_add and goal_done, which is the exact "same turn" the defect broke.
  const doneResult = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_done",
    note: "finished in the same turn",
  }, async () => ({ result: "passthrough" }));

  check("section10 done: goal_done not denied", doneResult.deny === undefined, doneResult.deny);

  const state = getState(h);
  const newNode = state.goals.find(g => g.kind === "plan");
  check("section10 done: the node is complete", newNode && newNode.status === "complete");
  check("section10 done: a 'done' decision names the node", newNode && getDecisions(h).some(d => d.action === "done" && d.detail.includes(newNode.id)));
}

// Control: adding a task under an already-active parent still demotes the
// parent to pending and activates the new task exactly as it did before
// this section - the new no-active-leaf branch runs after this one and must
// see an active leaf already present, so it does nothing here.
async function caseSection10_taskUnderActiveParentStillDemotesAndActivates_control(clock) {
  console.log("\n=== Section 10 control: adding a task under an active parent still demotes and activates ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });
  const activePlan = makeGoalNode({ id: "plan-active", parentId: "root-1", kind: "plan", status: "active" });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "section10_task_under_active_parent_control",
    stateOpts: { now: T0, goals: [rootGoal, activePlan], activeGoalId: "plan-active" },
  });

  const toolCallH = h.handlers["tool.call"];
  const result = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "task",
    parentId: "plan-active",
    title: "New task",
    objective: "Do the task",
  }, async () => ({ result: "passthrough" }));

  check("section10 task-control: not denied", result.deny === undefined, result.deny);

  const state = getState(h);
  const plan = state.goals.find(g => g.id === "plan-active");
  const task = state.goals.find(g => g.kind === "task");
  check("section10 task-control: the parent plan is demoted to pending", plan && plan.status === "pending");
  check("section10 task-control: the new task is active", task && task.status === "active");
  check("section10 task-control: activeGoalId points at the new task", task && state.activeGoalId === task.id);
  check("section10 task-control: exactly one 'activated' decision (the task branch fires, the no-active-leaf branch is a no-op)",
    getDecisions(h).filter(d => d.action === "activated").length === 1);
}

// Control: the tick's own planning gate is untouched by this section - a
// root added with no turn open still gets a plan created and activated by
// the planner path, same as before.
async function caseSection10_tickPlanningGateStillActivates_control(clock) {
  console.log("\n=== Section 10 control: the tick's own planning gate still activates a new plan ===");
  clock.set(T0);

  const rootGoal = {
    id: "root-1",
    parentId: null,
    kind: "root",
    title: "Section 10 tick control root",
    objective: "Get one thing done",
    status: "pending",
    source: "controller",
    maxRounds: 10,
    completedRounds: 0,
    scores: [],
    notes: [],
    planningRounds: 0,
    consecutiveBlockedPlannings: 0,
    consecutivePlanningFailures: 0,
    planningRound: 0,
    createdAt: T0 - 10000,
    updatedAt: T0 - 5000,
  };

  const h = await createTickHarness({
    ...OPTS,
    caseName: "section10_tick_planning_gate_control",
    stateOpts: { now: T0, goals: [rootGoal], activeGoalId: null },
    completeValue: JSON.stringify([
      { title: "Only plan", objective: "Get one thing done", maxRounds: 5 },
    ]),
  });

  // No goal_add or goal_done fired here at all. The tick's planning gate,
  // with no turn open, runs the planner and activates its first plan, which
  // is the path through activateNext that this section refactored.
  await fireTick(h);

  const state = getState(h);
  const plan = state.goals.find(g => g.kind === "plan");
  check("section10 tick-control: planner created the plan", !!plan);
  check("section10 tick-control: the planning gate activated it", plan && plan.status === "active" && state.activeGoalId === plan.id);
}

// Section 10 fix round: the node goal_add creates wins activation even when
// an older pending leaf already sits in the tree - activateNext's DFS/
// createdAt order would otherwise hand activation to that older leaf, which
// is the exact defect the Critical finding named.
async function caseSection10_competingOlderPendingLeafLoses(clock) {
  console.log("\n=== Section 10: a competing older pending leaf loses to the node just added ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });
  const olderLeaf = makeGoalNode({
    id: "plan-old",
    parentId: "root-1",
    kind: "plan",
    status: "pending",
    createdAt: T0 - 10_000,
    updatedAt: T0 - 10_000,
  });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "section10_competing_older_leaf",
    stateOpts: { now: T0, goals: [rootGoal, olderLeaf], activeGoalId: null },
  });

  const toolCallH = h.handlers["tool.call"];
  const result = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "plan",
    title: "New plan",
    objective: "Do the newly added work",
  }, async () => ({ result: "passthrough" }));

  check("section10 competing-leaf: not denied", result.deny === undefined);

  const state = getState(h);
  const newNode = state.goals.find(g => g.id !== "root-1" && g.id !== "plan-old");
  check("section10 competing-leaf: new plan node exists", !!newNode);
  check("section10 competing-leaf: the new node is active, not the older leaf",
    newNode && newNode.status === "active" && state.activeGoalId === newNode.id);
  check("section10 competing-leaf: the older leaf is still pending",
    state.goals.find(g => g.id === "plan-old").status === "pending");

  const decisions = getDecisions(h);
  check("section10 competing-leaf: the 'activated' decision names the new node positionally, not the older leaf",
    newNode && decisions.some(d => d.action === "activated" && d.detail.startsWith(`Node ${newNode.id} activated`)));
}

// Section 10 fix round: an open ask means the controller deliberately holds
// the tree, so goal_add must not activate anything while pendingAskId is set.
// The held node is seeded "pending", not "paused" (Reviewer round 2 finding:
// the prior seeding let the guard's now-removed paused clause carry this
// case, so a green result proved nothing about the ask clause specifically).
// With the paused clause gone entirely (item 3), an open ask is the only
// rule left standing between this case and activation, so the assertion
// below is the ask clause's own coverage - proved by the mutation control
// this case's caller runs separately (delete the pendingAskId clause, watch
// this case go red, restore).
//
// pendingAskId lives on the state itself, not on a goal node, and
// createTickHarness seeds its state through makeState(), which has no
// stateOpts field for it. getState(h) reads the fake fs after the fact,
// which is a separate copy from the module's live in-memory sess.state that
// the goal_add handler actually reads, so mutating it there would never
// reach the handler. Building the harness manually here, seeding
// pendingAskId into the persona store before session.start runs, is what
// gets it into sess.state, mirroring the buildPersonaState pattern used
// elsewhere in this file for state fields stateOpts does not cover.
async function caseSection10_openAskBlocksActivation(clock) {
  console.log("\n=== Section 10: an open ask blocks activation ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });
  const heldLeaf = makeGoalNode({
    id: "plan-held",
    parentId: "root-1",
    kind: "plan",
    status: "pending",
    createdAt: T0 - 10_000,
    updatedAt: T0 - 5_000,
  });

  const options = { ...OPTS, caseName: "section10_open_ask_blocks" };
  const seedState = makeState({ now: T0, goals: [rootGoal, heldLeaf], activeGoalId: null });
  seedState.pendingAskId = "ask-plan-held-12345";

  const h = createFake$(options);
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: seedState }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({
    default: { sessionId: "old-session", epoch: 1, lastSeen: 1_000_000_000_000 },
  }));
  const mod = await loadModule(options.caseName);
  const handlers = {};
  const on = (event, handler) => { handlers[event] = handler; };
  await mod.register(on, options);
  const startH = handlers["session.start"];
  if (startH) await startH(h.fake, {}, () => {});
  h.handlers = handlers;

  // enforceInvariants (agent-state.ts) runs on every session.start load and
  // nulls activeGoalId when no node's status is "active" - the seeded
  // pending held leaf never holds it either. So the pre-call value (null),
  // not any node id, is the baseline this case's "unchanged" assertion
  // compares against.
  const activeGoalIdBefore = getState(h).activeGoalId;
  const decisionsBefore = getDecisions(h).length;
  const toolCallH = h.handlers["tool.call"];
  const result = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "plan",
    title: "New plan while ask open",
    objective: "Should not activate",
  }, async () => ({ result: "passthrough" }));

  check("section10 open-ask: not denied", result.deny === undefined);

  const state = getState(h);
  console.log(`  scope: status of every node in the tree = ${JSON.stringify(state.goals.map(g => ({ id: g.id, status: g.status })))}`);
  check("section10 open-ask: no node in the tree is active",
    !state.goals.some(g => g.status === "active"));
  check("section10 open-ask: activeGoalId is unchanged", state.activeGoalId === activeGoalIdBefore);

  const newDecisions = getDecisions(h).slice(decisionsBefore);
  console.log(`  scope: actions of decisions pushed by this call = ${JSON.stringify(newDecisions.map(d => d.action))}`);
  check("section10 open-ask: no 'activated' decision was pushed by this call",
    !newDecisions.some(d => d.action === "activated"));
}

// Section 10 fix round (regression case for item 3): a stale, unrelated
// paused node - not held by the nudge cap, just a plain operator pause or a
// leftover plan-switch pause - must not disable this branch. The prior
// round's guard scanned the whole tree for any paused node at all, which
// silently reinstated the defect Section 10 exists to fix the moment one
// stray paused node sat anywhere in the tree. Only an open ask or a
// nudge-cap hold (the next case) may block activation now.
async function caseSection10FixRound_unrelatedPausedNodeDoesNotBlock(clock) {
  console.log("\n=== Section 10 fix round: an unrelated paused node does not block activation ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });
  const planParent = makeGoalNode({
    id: "plan-parent",
    parentId: "root-1",
    kind: "plan",
    status: "pending",
    createdAt: T0 - 20_000,
    updatedAt: T0 - 20_000,
  });
  const unrelatedPaused = makeGoalNode({
    id: "plan-unrelated-paused",
    parentId: "root-1",
    kind: "plan",
    status: "paused",
    createdAt: T0 - 10_000,
    updatedAt: T0 - 5_000,
  });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "section10_unrelated_paused_no_block",
    stateOpts: { now: T0, goals: [rootGoal, planParent, unrelatedPaused], activeGoalId: null },
  });

  const toolCallH = h.handlers["tool.call"];
  const result = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "task",
    parentId: "plan-parent",
    title: "New task under a pending plan",
    objective: "Should activate despite the unrelated paused node",
  }, async () => ({ result: "passthrough" }));

  check("section10 unrelated-paused: not denied", result.deny === undefined);

  const state = getState(h);
  const newTask = state.goals.find(g => g.kind === "task");
  check("section10 unrelated-paused: the new task exists", !!newTask);
  check("section10 unrelated-paused: the new task is active",
    newTask && newTask.status === "active" && state.activeGoalId === newTask.id);
  check("section10 unrelated-paused: the unrelated paused node is still paused",
    state.goals.find(g => g.id === "plan-unrelated-paused").status === "paused");
}

// Section 10 fix round (item 3): a nudge-cap pause is the one paused shape
// that must still block activation - the same hold turn.complete's own
// worker-tool-call path (Round 60 finding 3b) restores on the worker's next
// completed turn, never on a goal_add call.
async function caseSection10FixRound_nudgeCapPauseBlocksActivation(clock) {
  console.log("\n=== Section 10 fix round: a nudge-cap pause blocks activation ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });
  const nudgeCapPaused = makeGoalNode({
    id: "plan-nudgecap-paused",
    parentId: "root-1",
    kind: "plan",
    status: "paused",
    pausedByNudgeCap: true,
    createdAt: T0 - 10_000,
    updatedAt: T0 - 5_000,
  });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "section10_nudgecap_pause_blocks",
    stateOpts: { now: T0, goals: [rootGoal, nudgeCapPaused], activeGoalId: null },
  });

  const decisionsBefore = getDecisions(h).length;
  const toolCallH = h.handlers["tool.call"];
  const result = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "plan",
    title: "New plan while a nudge-cap pause holds",
    objective: "Should not activate",
  }, async () => ({ result: "passthrough" }));

  check("section10 nudgecap-pause: not denied", result.deny === undefined);

  const state = getState(h);
  check("section10 nudgecap-pause: no node in the tree is active",
    !state.goals.some(g => g.status === "active"));
  check("section10 nudgecap-pause: activeGoalId is null", state.activeGoalId === null);

  const newDecisions = getDecisions(h).slice(decisionsBefore);
  check("section10 nudgecap-pause: no 'activated' decision was pushed by this call",
    !newDecisions.some(d => d.action === "activated"));
}

// Section 10 fix round (item 2): a task added under a dropped (abandoned)
// plan must never be activated. isActivationEligible's ancestor rule is what
// refuses this - the parent's own status fails the "every ancestor is
// pending" test - so no separate parent-status check is written for it.
async function caseSection10FixRound_droppedPlanParentNotActivated(clock) {
  console.log("\n=== Section 10 fix round: a task under a dropped plan is not activated ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });
  const droppedPlan = makeGoalNode({
    id: "plan-dropped",
    parentId: "root-1",
    kind: "plan",
    status: "abandoned",
    blockedReason: "dropped by operator",
    createdAt: T0 - 10_000,
    updatedAt: T0 - 5_000,
  });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "section10_dropped_plan_parent",
    stateOpts: { now: T0, goals: [rootGoal, droppedPlan], activeGoalId: null },
  });

  const activeGoalIdBefore = getState(h).activeGoalId;
  const decisionsBefore = getDecisions(h).length;
  const toolCallH = h.handlers["tool.call"];
  const result = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "task",
    parentId: "plan-dropped",
    title: "New task under a dropped plan",
    objective: "Should not activate",
  }, async () => ({ result: "passthrough" }));

  check("section10 dropped-parent: not denied", result.deny === undefined);

  const state = getState(h);
  check("section10 dropped-parent: no node in the tree is active",
    !state.goals.some(g => g.status === "active"));
  check("section10 dropped-parent: activeGoalId did not move", state.activeGoalId === activeGoalIdBefore);

  const newDecisions = getDecisions(h).slice(decisionsBefore);
  check("section10 dropped-parent: no 'activated' decision was pushed by this call",
    !newDecisions.some(d => d.action === "activated"));
}

// Section 10 fix round (item 4): a second same-turn plan add, with no
// parentId given (the tool's own description tells a worker to omit it),
// must land under the root even though the first plan add already activated
// and is now the active leaf - before this fix the no-explicit-parent branch
// resolved a bare "plan" add to whatever was active, and a plan can only be
// added under the root, so the second call was denied.
async function caseSection10FixRound_secondPlanAddLandsUnderRoot(clock) {
  console.log("\n=== Section 10 fix round: a second same-turn plan add lands under the root ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "section10_second_plan_add",
    stateOpts: { now: T0, goals: [rootGoal], activeGoalId: null },
  });

  const toolCallH = h.handlers["tool.call"];
  const first = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "plan",
    title: "First plan",
    objective: "Do the first thing",
  }, async () => ({ result: "passthrough" }));
  check("section10 second-plan: first add not denied", first.deny === undefined);

  const second = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "plan",
    title: "Second plan",
    objective: "Do the second thing",
  }, async () => ({ result: "passthrough" }));
  check("section10 second-plan: second add not denied", second.deny === undefined);

  const state = getState(h);
  const plans = state.goals.filter(g => g.kind === "plan");
  check("section10 second-plan: two plan nodes exist", plans.length === 2);
  check("section10 second-plan: the second plan's parentId is the root",
    plans.length === 2 && plans[1].parentId === "root-1");
}

// Section 10 fix round (new coverage, adversarial lens): a task added under
// a pending (not active) plan, with nothing active anywhere, is activated -
// this shape (parent pending rather than active) had no case before this
// round.
async function caseSection10FixRound_taskUnderPendingPlanActivated(clock) {
  console.log("\n=== Section 10 fix round: a task added under a pending plan is activated ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });
  const pendingPlan = makeGoalNode({
    id: "plan-pending",
    parentId: "root-1",
    kind: "plan",
    status: "pending",
    createdAt: T0 - 10_000,
    updatedAt: T0 - 10_000,
  });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "section10_task_under_pending_plan",
    stateOpts: { now: T0, goals: [rootGoal, pendingPlan], activeGoalId: null },
  });

  const toolCallH = h.handlers["tool.call"];
  const result = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_add",
    kind: "task",
    parentId: "plan-pending",
    title: "New task under a pending plan",
    objective: "Do the task",
  }, async () => ({ result: "passthrough" }));

  check("section10 task-under-pending-plan: not denied", result.deny === undefined);

  const state = getState(h);
  const newTask = state.goals.find(g => g.kind === "task");
  check("section10 task-under-pending-plan: the new task exists", !!newTask);
  check("section10 task-under-pending-plan: the new task is active",
    newTask && newTask.status === "active" && state.activeGoalId === newTask.id);
  check("section10 task-under-pending-plan: the pending plan parent stays pending (it was never active, so nothing demotes it)",
    state.goals.find(g => g.id === "plan-pending").status === "pending");
}

// Item 8.1 / Round 58 finding 4: goal_edit's drop action refused a blocked node outright, which is
// exactly why the stale duplicate plan-mtwxh5jx-acm9 could not be retired - blocked was not in its
// allowed-status list alongside pending/paused. Allowed here, with the reason always recorded.
async function caseItem81_goalEditDropAllowsBlocked(clock) {
  console.log("\n=== Item 8.1: goal_edit drop allows a blocked node, recording the reason ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });
  const blockedPlan = makeGoalNode({
    id: "plan-blocked",
    parentId: "root-1",
    kind: "plan",
    status: "blocked",
    blockedReason: "stale duplicate",
  });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item81_drop_blocked",
    stateOpts: { now: T0, goals: [rootGoal, blockedPlan], activeGoalId: null },
  });

  const toolCallH = h.handlers["tool.call"];
  const result = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_edit",
    nodeId: "plan-blocked",
    action: "drop",
    reason: "superseded by item 7's own node",
  }, async () => ({ result: "passthrough" }));

  check("item81 drop-blocked: not denied", result.deny === undefined, result.deny);

  const state = getState(h);
  const node = state.goals.find(g => g.id === "plan-blocked");
  check("item81 drop-blocked: status is abandoned", node.status === "abandoned");
  check("item81 drop-blocked: reason recorded", node.blockedReason === "superseded by item 7's own node");

  const decisions = getDecisions(h);
  check("item81 drop-blocked: drop decision logged", decisions.some(d => d.action === "drop" && d.detail.includes("plan-blocked")));
}

// Control: an active node is still refused, so the widened allow-list is exactly
// {pending, paused, blocked} and nothing broader.
async function caseItem81_goalEditDropStillRefusesActive_control(clock) {
  console.log("\n=== Item 8.1 control: goal_edit drop still refuses an active node ===");
  clock.set(T0);

  const rootGoal = makeGoalNode({ id: "root-1", kind: "root", status: "pending" });
  const activePlan = makeGoalNode({ id: "plan-active", parentId: "root-1", kind: "plan", status: "active" });

  const h = await createTickHarness({
    ...OPTS,
    caseName: "item81_drop_active_control",
    stateOpts: { now: T0, goals: [rootGoal, activePlan], activeGoalId: "plan-active" },
  });

  const toolCallH = h.handlers["tool.call"];
  const result = await toolCallH(h.fake, {
    tool: "mcp__agentic-plugin__goal_edit",
    nodeId: "plan-active",
    action: "drop",
    reason: "should not apply",
  }, async () => ({ result: "passthrough" }));

  check("item81 drop-active control: denied", result.deny !== undefined);

  const state = getState(h);
  const node = state.goals.find(g => g.id === "plan-active");
  check("item81 drop-active control: status unchanged", node.status === "active");
}

// ============================================================
// NUDGE GUARD: a nudge is not sent while a turn is open
//
// A nudge wakes an idle worker, and a worker inside an open turn is not idle.
// A prompt submitted there does not reach the running turn: it is queued and
// runs once the session is idle. So a long turn would otherwise collect one
// identical [GOAL] copy per tick and hand the worker the whole pile as the
// next turn's prompt.
//
// The tick's in-flight check is synchronous and the classify call after it is
// not, so the turn can open underneath a tick already on its way to the nudge.
// That race is the only route to the nudge path with a turn open, and it is
// what the driver below reproduces.
// ============================================================

// One driver, one axis. Each round fires a tick, waits for that tick's own
// deferred work to land, and differs only in whether a turn opens while that
// work is in flight. The two sides are not otherwise identical, and the claim
// is narrower than that: the open-turn side also runs the turn.start and
// turn.complete handlers in full, with their heartbeat write, their inbox read
// and their own decisions. What is held equal is everything the nudge path
// reads - the tick count, the clock advance, the classify verdict, the goal
// node and the nudge budget - so a silence on the open-turn side is readable as
// the guard rather than as a driver that never reached the path, which is what
// the between-turns side speaking under the same driver establishes.
//
// The turn is opened from inside the classify stub, which is the tick's own
// first await past the synchronous in-flight check. That is the live shape:
// the check passes, the tick goes async, and the turn opens underneath it.
// Opening the turn before the tick instead would make every tick return at the
// in-flight check and never reach the nudge path at all, which is why each
// case asserts the decider was reached before it asserts the silence.
//
// turn.start adds the turn's id to the module's open-turn map synchronously,
// before its own first await, so the session reads as inside a turn by the time
// the stub returns and the call needs no awaiting here.
async function nudgeRaceDrive(h, clock, { openTurn, rounds }) {
  const startH = h.handlers["turn.start"];
  const completeH = h.handlers["turn.complete"];
  let opened = 0;
  // The classify stub returns the verdict to the tick synchronously, so it
  // cannot await the turn.start it fires. The promise is kept with a rejection
  // handler attached at creation: a throw inside turn.start (its own
  // unguarded inbox read is the live path) then fails a check here instead of
  // escaping as an unhandled rejection that takes the suite process down.
  const started = [];
  const startErrors = [];
  h.setClassifyValue(() => {
    if (openTurn) {
      started.push(Promise.resolve(startH(h.fake, { turnId: `race-turn-${opened}` }, () => {}))
        .catch((err) => { startErrors.push(err); }));
      opened += 1;
    }
    return "nudge";
  });
  for (let i = 0; i < rounds; i++) {
    const ticksBefore = countPersistedTicks(h);
    clock.advance(130_000);
    await fireTick(h);
    const landed = await waitUntil(() => countPersistedTicks(h) > ticksBefore);
    check(`nudge race driver: round ${i + 1}'s tick body ran to its persist`, landed);
    // Closed under the id its own turn.start carried, since the plugin closes an
    // open turn by id: a completion under any other id closes nothing.
    if (openTurn) await completeH(h.fake, { turnId: `race-turn-${opened - 1}`, aborted: true, reason: "aborted" }, () => {});
    await new Promise(r => setTimeout(r, 20));
  }
  await Promise.all(started);
  for (const err of startErrors) console.error(`  turn.start rejected: ${err}`);
  // Each side gets the assertion that can speak on it. On the open-turn side
  // that is the rejection check the kept promises exist for. On the control
  // side no turn.start is ever fired, so the same check is empty by
  // construction and says nothing; what it asserts there instead is the axis
  // itself, that the control really is the no-turn side of the pair.
  if (openTurn) {
    check("nudge race driver: every turn.start settled without rejecting", startErrors.length === 0);
  } else {
    check("nudge race driver: the control side opened no turn at all", opened === 0 && started.length === 0);
  }
  return opened;
}

async function seedNudgeRaceHarness(caseName, extraOpts = {}) {
  const h = await createTickHarness({
    ...OPTS,
    // OPTS's own costMaxNudgesPerHour (2) is a different, unrelated cap, the
    // per-hour nudge budget D3's own case exercises. Raised here so that a case
    // sending more than two nudges reads the guard it is about rather than that
    // budget. Cases that send at most one nudge take this raise inertly, and a
    // case passing costEnabled: false turns the whole cost path off and with it
    // this cap. It is carried in the shared seeder so every case on this driver
    // has the same budget, rather than one case's own reach deciding what the
    // others get.
    costMaxNudgesPerHour: 20,
    caseName,
    ...extraOpts,
  });
  h.setClassifyValue("nudge");
  // session.start's reload resets the reseeded "active" leaf to "pending" - a completed dummy
  // turn (H2 scoring) re-activates g-plan before the race under test, the same transitional step
  // caseD2/D4 use via fireTurn().
  await fireTurn(h);
  await new Promise(r => setTimeout(r, 20));
  return h;
}

// The withheld control: the same driver with the turn closed. The nudge is
// sent, which is what makes the silence above a decision rather than a harness
// that failed to drive the path at all.
async function caseNudgeGuard_sentBetweenTurns_control(clock) {
  console.log("\n=== Nudge guard control: with no turn open the nudge is sent ===");
  clock.set(T0);

  const h = await seedNudgeRaceHarness("nudge_guard_control");
  await nudgeRaceDrive(h, clock, { openTurn: false, rounds: 1 });

  const state = getState(h);
  const decisions = state.decisions;
  const goalPrompts = (h.promptSubmits || []).filter(p => p.startsWith("[GOAL]"));
  check("nudge guard control: one [GOAL] prompt submitted", goalPrompts.length === 1);
  const nudges = decisions.filter(d => d.action === "nudge_sent");
  check("nudge guard control: one nudge_sent decision", nudges.length === 1);
  check("nudge guard control: the nudge is counted", nudges.length === 1 && nudges[0].detail.includes("nudge #1"));
  check("nudge guard control: no skip decision", !decisions.some(d => d.action === "nudge_skipped_turn_in_flight"));
  check("nudge guard control: nudge ledger incremented", state.monitor.cost.nudge.count === 1);
}

// Round 58 finding 3, part (a), repointed: the pile-up itself. Four ticks whose
// nudges all land inside an open turn produce no [GOAL] prompts at all, rather
// than one copy per tick.
async function caseR58f3_nudgeInsideOpenTurnNotSent(clock) {
  console.log("\n=== Round 58 finding 3a: repeated nudges inside open turns never pile up ===");
  clock.set(T0);

  const h = await seedNudgeRaceHarness("r58f3_open_turn");
  const opened = await nudgeRaceDrive(h, clock, { openTurn: true, rounds: 4 });

  const state = getState(h);
  const decisions = state.decisions;
  check("r58f3a: a turn was opened inside every tick", opened === 4);
  check("r58f3a: the decider ran on every round", decisions.filter(d => d.action === "controller_tick" && d.detail.startsWith("g-plan: nudge:")).length === 4);
  check("r58f3a: no [GOAL] prompt submitted at all", !(h.promptSubmits || []).some(p => p.startsWith("[GOAL]")));
  check("r58f3a: no nudge_sent", !decisions.some(d => d.action === "nudge_sent"));
  check("r58f3a: four skips, one per round", decisions.filter(d => d.action === "nudge_skipped_turn_in_flight").length === 4);
  check("r58f3a: no nudge_cap_reached", !decisions.some(d => d.action === "nudge_cap_reached"));
  check("r58f3a: no ask_opened", !decisions.some(d => d.action === "ask_opened"));
  check("r58f3a: no paused_by_controller", !decisions.some(d => d.action === "paused_by_controller"));
  // Nothing else in the nudge path ran: no ledger increment, no nudge window bump.
  check("r58f3a: nudge ledger not incremented", state.monitor.cost.nudge.count === 0);
  check("r58f3a: nudge window not bumped", (state.monitor.cost.nudgeWindow?.count ?? 0) === 0);
  const plan = state.goals.find(g => g.id === "g-plan");
  check("r58f3a: the active leaf stays active", plan && plan.status === "active");
}

// Round 58 finding 3, part (b): the nudge cap, reached through completed-turn nudges (real idle
// time, no turn ever open), pauses the node and opens no ask - the same shape item 8.2 already
// gave the classifier's ask-operator and pause verdicts, reached here through a third path.
async function caseR58f3_capPausesWithNoAsk(clock) {
  console.log("\n=== Round 58 finding 3b: the nudge cap pauses the node and opens no ask ===");
  clock.set(T0);

  const h = await createTickHarness({
    ...OPTS,
    // Same reason as 3a: keep the unrelated per-hour nudge-budget cap out of the way of the
    // consecutive-nudge cap this case actually exercises.
    costMaxNudgesPerHour: 20,
    caseName: "r58f3_cap_no_ask",
  });
  h.setClassifyValue("nudge");

  // One completed turn to establish a baseline; no further turn.start below, so the open-turn
  // map is empty at every tick and each nudge lands between completed turns.
  await fireTurn(h);
  await new Promise(r => setTimeout(r, 20));

  for (let i = 0; i < 4; i++) {
    clock.advance(130_000);
    await tickAndSettle(h, clock);
  }

  const state = getState(h);
  const decisions = state.decisions;
  check("r58f3b: nudge_cap_reached present", decisions.some(d => d.action === "nudge_cap_reached"));
  check("r58f3b: paused_by_controller present", decisions.some(d => d.action === "paused_by_controller"));
  check("r58f3b: no ask_opened", !decisions.some(d => d.action === "ask_opened"));
  const askKeys = [...h.storeMap.keys()].filter(k => k.startsWith("ask:"));
  check("r58f3b: no ask record in the store", askKeys.length === 0);
  check("r58f3b: pendingAskId not set", state.pendingAskId === null || state.pendingAskId === undefined);
  const plan = state.goals.find(g => g.id === "g-plan");
  check("r58f3b: the node is paused, not active", plan && plan.status === "paused");
}

// Round 60 finding 3(b): a cap pause opens no ask (finding 3a/b above), so nothing but a
// completed turn that calls a real work tool, or goal_resume, ever reactivates the node in a
// headless child. Three cases: (i) a work-tool turn.complete reactivates a cap-paused node;
// (ii) control - a turn.complete with no work tool leaves it paused; (iii) control - a node
// paused by goal_edit pause (not the cap) is never reactivated by work.
async function caseR60f3b_reactivationAfterCapPause(clock) {
  console.log("\n=== Round 60 finding 3b: turn.complete reactivates a cap-paused node on real work ===");

  // (i) work-tool turn.complete reactivates.
  {
    clock.set(T0);
    const h = await createTickHarness({
      ...OPTS,
      costMaxNudgesPerHour: 20,
      caseName: "r60f3b_reactivate",
    });
    h.setClassifyValue("nudge");
    await fireTurn(h);
    await new Promise(r => setTimeout(r, 20));
    for (let i = 0; i < 4; i++) {
      clock.advance(130_000);
      await tickAndSettle(h, clock);
    }
    let state = getState(h);
    let plan = state.goals.find(g => g.id === "g-plan");
    check("r60f3b(i): cap pause landed first", plan && plan.status === "paused" && plan.pausedByNudgeCap === true);

    const startH = h.handlers["turn.start"];
    const toolCallH = h.handlers["tool.call"];
    const completeH = h.handlers["turn.complete"];
    await startH(h.fake, { turnId: "work-turn" }, () => {});
    await toolCallH(h.fake, { tool: "Bash", command: "echo hi" }, async (e) => ({ result: "ok" }));
    await completeH(h.fake, { turnId: "work-turn", aborted: false, reason: "stop", answer: "Did the work." }, () => {});

    state = getState(h);
    const decisions = state.decisions;
    plan = state.goals.find(g => g.id === "g-plan");
    check("r60f3b(i): reactivated_by_work present", decisions.some(d => d.action === "reactivated_by_work"));
    check("r60f3b(i): the node is active again", plan && plan.status === "active");
    check("r60f3b(i): blockedReason cleared", plan && !plan.blockedReason);
    // consecutiveNudgesWithoutOnGoal lives on sess (in-memory), not sess.state; a fresh
    // nudge_cap_reached this soon would only happen if the reset in the fix didn't take,
    // so absence of a second cap hit on the very next tick is the reachable proxy for it.
    clock.advance(130_000);
    await tickAndSettle(h, clock);
    const afterState = getState(h);
    check("r60f3b(i): no immediate re-trip of the cap (counter was reset)",
      afterState.decisions.filter(d => d.action === "nudge_cap_reached").length === 1);
  }

  // (ii) control: a turn.complete with no work tool leaves the node paused.
  {
    clock.set(T0);
    const h = await createTickHarness({
      ...OPTS,
      costMaxNudgesPerHour: 20,
      caseName: "r60f3b_control_no_work_tool",
    });
    h.setClassifyValue("nudge");
    await fireTurn(h);
    await new Promise(r => setTimeout(r, 20));
    for (let i = 0; i < 4; i++) {
      clock.advance(130_000);
      await tickAndSettle(h, clock);
    }
    const startH = h.handlers["turn.start"];
    const completeH = h.handlers["turn.complete"];
    await startH(h.fake, { turnId: "no-work-turn" }, () => {});
    // No tool.call fired this turn: toolCallsThisTurn stays 0.
    await completeH(h.fake, { turnId: "no-work-turn", aborted: false, reason: "stop", answer: "Just talked, did nothing." }, () => {});

    const state = getState(h);
    const decisions = state.decisions;
    const plan = state.goals.find(g => g.id === "g-plan");
    check("r60f3b(ii): no reactivated_by_work", !decisions.some(d => d.action === "reactivated_by_work"));
    check("r60f3b(ii): the node stays paused", plan && plan.status === "paused");
  }

  // (iii) control: a node paused by goal_edit pause (not the cap) is not reactivated by work.
  {
    clock.set(T0);
    const h = await createTickHarness({
      ...OPTS,
      costMaxNudgesPerHour: 20,
      caseName: "r60f3b_control_goal_edit_pause",
    });
    const startH0 = h.handlers["session.start"];
    await startH0(h.fake, {}, () => {});
    const toolCallH0 = h.handlers["tool.call"];
    await toolCallH0(h.fake, { tool: "mcp__agentic-plugin__goal_edit", nodeId: "g-plan", action: "pause", reason: "operator asked" }, async () => ({}));

    let state = getState(h);
    let plan = state.goals.find(g => g.id === "g-plan");
    check("r60f3b(iii): goal_edit pause landed, not the cap", plan && plan.status === "paused" && plan.blockedReason === "operator asked");

    const startH = h.handlers["turn.start"];
    const toolCallH = h.handlers["tool.call"];
    const completeH = h.handlers["turn.complete"];
    await startH(h.fake, { turnId: "work-turn-2" }, () => {});
    await toolCallH(h.fake, { tool: "Bash", command: "echo hi" }, async () => ({ result: "ok" }));
    await completeH(h.fake, { turnId: "work-turn-2", aborted: false, reason: "stop", answer: "Did other work." }, () => {});

    state = getState(h);
    const decisions = state.decisions;
    plan = state.goals.find(g => g.id === "g-plan");
    check("r60f3b(iii): no reactivated_by_work", !decisions.some(d => d.action === "reactivated_by_work"));
    check("r60f3b(iii): the node stays paused (goal_edit pause is not the cap)", plan && plan.status === "paused");
  }
}

// Round 58 finding 3's control - the worker's own ASK: marker still opens an ask record,
// unaffected by removing the nudge-cap's ask-writing - is already proven by
// caseItem8p2_worker_states_fork_opens_ask above (item 8.2), which this round's changes do not
// touch (the marker path lives in turn.complete; the nudge cap lives in the controller tick).
// Re-driving the same seeding here would duplicate that case rather than add coverage, so this
// round leans on it directly: it still passes, unchanged, per the run below.

// ============================================================
// The nudge floor is spent before the submit, and the open-turn reading is a
// set of turn ids
//
// $.prompt.submit does not resolve until the session is next idle, so a submit
// issued while a turn runs parks for the length of that turn. The controller
// tick is fire-and-forget, so further ticks keep arriving while it parks. A
// floor stamped after the submit is therefore never stamped at all for as long
// as the parking lasts: each later tick reads the same stale stamp, clears the
// floor, and queues another identical copy of the same prompt, and the pile
// arrives together as the next turn's prompt.
//
// The harness's holdPromptSubmits() is that parked call. Each case asserts its
// instrument before its subject: a submit that never parked, a second tick that
// never ran, and a turn that never opened all fail the same way as the guard
// working, so without them the silence is unreadable.
// ============================================================

// Two tick bodies alive at once, the first parked inside its submit. Exactly one
// [GOAL] prompt is queued (1), a later tick inside the floor window still queues
// none (2), and a tick past the floor queues the next one (3).
async function caseR117a_concurrentTicksNudgeOnce(clock) {
  console.log("\n=== R117a: two live ticks over one parked submit queue one [GOAL] prompt ===");
  clock.set(T0);

  // The cost path is off so that the second tick reaches the floor test at all.
  // With it on, an unchanged summary and a not-due nudge send that tick to the
  // D2 idle skip before the decider, and the floor is never the thing that
  // turned it away, which is what this case is about.
  const h = await seedNudgeRaceHarness("r117a_floor_spent_before_submit", { costEnabled: false });
  h.holdPromptSubmits();

  // Tick 1 clears the floor, reaches the actuator, and parks inside the submit.
  clock.advance(130_000);
  await fireTick(h);
  const parked = await waitUntil(() => goalPrompts(h).length >= 1);
  check("r117a: the first tick reached the submit and parked there", parked);
  check("r117a: it has not finished - no nudge_sent while its submit is parked",
    !getDecisions(h).some(d => d.action === "nudge_sent"));

  // Tick 2 runs while tick 1 is still parked, on the same clock, so the floor it
  // meets is the one tick 1 spent on its way in. With the floor spent, tick 2's
  // decider says nudge and the floor turns it away; with the floor left for
  // after the submit it reads as clear and tick 2 queues a second copy. Waiting
  // on either outcome makes this readable in both directions, since a bare count
  // of persisted ticks is satisfied by tick 1's own decision being flushed out
  // by tick 2's first write.
  await fireTick(h);
  const secondSettled = await waitUntil(() =>
    goalPrompts(h).length >= 2 ||
    countAction(getDecisions(h), "nudge_skipped_floor") >= 1);
  check("r117a: the second tick reached its own decision while the first was parked", secondSettled);
  check("r117a: exactly one [GOAL] prompt queued across both ticks", goalPrompts(h).length === 1);
  check("r117a: the second tick was turned away by the floor, not by a missing decider",
    countAction(getDecisions(h), "nudge_skipped_floor") === 1);

  // Release: the first tick resumes and finishes its own bookkeeping.
  h.releasePromptSubmits();
  const settled = await waitUntil(() => getDecisions(h).some(d => d.action === "nudge_sent"));
  check("r117a: the first tick's nudge_sent lands once its submit resolves", settled);
  check("r117a: still exactly one [GOAL] prompt after the submit resolved", goalPrompts(h).length === 1);

  // (2) A tick inside the floor window, with the submit now resolved.
  clock.advance(60_000);
  await fireTick(h);
  const insideFloorSettled = await waitUntil(() =>
    goalPrompts(h).length >= 2 ||
    countAction(getDecisions(h), "nudge_skipped_floor") >= 2);
  check("r117a: a tick inside the floor window reached its own decision", insideFloorSettled);
  check("r117a: it queued nothing - still one [GOAL] prompt", goalPrompts(h).length === 1);

  // (3) A tick past the floor window sends the next nudge. This is the withheld
  // control: without it the two silences above would also be produced by a
  // driver that had stopped reaching the nudge path at all.
  clock.advance(130_000);
  await fireTick(h);
  const pastFloorSent = await waitUntil(() => getDecisions(h).filter(d => d.action === "nudge_sent").length >= 2);
  check("r117a: a tick past the floor window queues the next [GOAL] prompt", pastFloorSent);
  check("r117a: exactly two [GOAL] prompts in total", goalPrompts(h).length === 2);
  check("r117a: exactly two nudge_sent decisions", countAction(getDecisions(h), "nudge_sent") === 2);
  check("r117a: the nudge ledger counted both", getState(h).monitor.cost.nudge.count === 2);
  check("r117a: two ticks were turned away by the floor between them",
    countAction(getDecisions(h), "nudge_skipped_floor") === 2);
}

// The open-turn reading is a set of turn ids, so a completion closes only the
// turn it names. A completion for a turn that never started closes nothing (4),
// and two overlapping turns need both completions before the session reads as
// between turns (5).
async function caseR117b_openTurnsCloseByIdOnly(clock) {
  console.log("\n=== R117b: open turns close by id, so an unmatched completion clears nothing ===");
  clock.set(T0);

  const h = await seedNudgeRaceHarness("r117b_open_turn_ids");
  const startH = h.handlers["turn.start"];
  const completeH = h.handlers["turn.complete"];

  // Two turns open at once.
  clock.advance(130_000);
  await startH(h.fake, { turnId: "turn-a" }, () => {});
  await startH(h.fake, { turnId: "turn-b" }, () => {});

  // Each leg advances the clock past the idle gate first, because turn.complete
  // stamps lastTurnComplete whatever id it carries, so an unmatched completion
  // still resets the idle reading the nudge path needs.
  const tickReachedADecision = async () => {
    const before = countPersistedTicks(h);
    clock.advance(130_000);
    await fireTick(h);
    // A tick that returns at the in-flight check persists nothing, so on the
    // open-turn legs this poll is expected to run out; its answer is the
    // assertion rather than a precondition for one.
    await waitUntil(() => countPersistedTicks(h) > before, 40);
    return countPersistedTicks(h) > before;
  };

  // (4) A completion for a turn this session never saw start.
  await completeH(h.fake, { turnId: "turn-never-started", aborted: true, reason: "aborted" }, () => {});
  check("r117b: an unknown completion leaves the session reading as inside a turn", !(await tickReachedADecision()));
  check("r117b: and queues no [GOAL] prompt", goalPrompts(h).length === 0);

  // (5) One of the two real turns completes; the other is still running.
  await completeH(h.fake, { turnId: "turn-a", aborted: true, reason: "aborted" }, () => {});
  check("r117b: one completion of two leaves the session reading as inside a turn", !(await tickReachedADecision()));
  check("r117b: and still queues no [GOAL] prompt", goalPrompts(h).length === 0);

  // The control: with both completions in, the same driver nudges. Without it
  // the two silences above would also be produced by a tick that had stopped
  // reaching the nudge path for some unrelated reason.
  await completeH(h.fake, { turnId: "turn-b", aborted: true, reason: "aborted" }, () => {});
  check("r117b: the second completion lets the tick through", await tickReachedADecision());
  const sent = await waitUntil(() => goalPrompts(h).length >= 1);
  check("r117b: it queues the [GOAL] prompt", sent && goalPrompts(h).length === 1);
  check("r117b: one nudge_sent decision", getDecisions(h).filter(d => d.action === "nudge_sent").length === 1);
}

// (6) A turn that opens while the submit is parked, and is still open when it
// resolves, does not cost the nudge its own record: the ledger, the window and
// the nudge_sent decision all still land once the submit comes back.
async function caseR118_bookkeepingLandsThoughATurnOpenedUnderTheSubmit(clock) {
  console.log("\n=== R118: a turn opening under the parked submit does not cost the nudge its record ===");
  clock.set(T0);

  const h = await seedNudgeRaceHarness("r118_counter_at_submit_time");
  h.holdPromptSubmits();

  clock.advance(130_000);
  await fireTick(h);
  const parked = await waitUntil(() => goalPrompts(h).length >= 1);
  check("r118: the tick reached the submit and parked there", parked);

  // A turn opens under the parked submit and never completes, so it is still
  // open at the moment the submit resolves.
  const startH = h.handlers["turn.start"];
  await startH(h.fake, { turnId: "turn-during-submit" }, () => {});

  h.releasePromptSubmits();
  const settled = await waitUntil(() => getDecisions(h).some(d => d.action === "nudge_sent"));
  check("r118: the nudge_sent decision lands once the submit resolves", settled);
  check("r118: exactly one nudge_sent", countAction(getDecisions(h), "nudge_sent") === 1);
  check("r118: the nudge ledger counted it", getState(h).monitor.cost.nudge.count === 1);
  check("r118: the nudge window was bumped", (getState(h).monitor.cost.nudgeWindow?.count ?? 0) === 1);

  // Instrument: the turn really was open across the resolution, so a reading
  // taken after the submit would have been a different reading.
  const before = countPersistedTicks(h);
  clock.advance(130_000);
  await fireTick(h);
  await waitUntil(() => countPersistedTicks(h) > before, 40);
  check("r118: the turn opened during the submit is still open afterwards",
    countPersistedTicks(h) === before);
}

// ============================================================
// A nudge's own bookkeeping is spent before the submit, like the floor
//
// $.prompt.submit parks until the session is next idle, so a whole worker turn
// can run and be scored between the call and its return. Three writes ride on
// that call: the escalation counter, the nudged-turn flag, and the prompt text
// the scorer reads. Written after the submit, each one lands after the turn it
// describes has already been judged - the counter after the reset an on-goal
// score performs, the flag after the turn.complete that reads it, the text
// after the scorer took the previous turn's prompt in its place.
//
// The counter's half of that is one round of credit. A nudge met on goal must
// clear its own nudge from the counter; written after the submit it increments
// past the reset, so the met round leaves a 1 behind and the two rounds after it
// reach the cap that pauses the node, one round earlier than the worker earned.
//
// The pair below varies one axis: whether the first of four rounds is met on
// goal. Everything else - the seeding, the goal node, the round budget, the
// parked submit, the three unmet rounds after it - is the same on both sides.
// ============================================================

// The seeding both sides share. The harness's default leaf carries maxRounds 0,
// which blocks it on its first scored round and ends the tree; these cases need
// a leaf that survives four scored rounds, so the round budget is raised and
// nothing else about the default tree is changed.
const R119_OPTS = {
  costEnabled: false,
  stateOpts: {
    goals: [
      makeGoalNode({ id: "g-root", parentId: null, kind: "root", status: "pending" }),
      makeGoalNode({ id: "g-plan", parentId: "g-root", kind: "plan", status: "active", maxRounds: 10 }),
    ],
    activeGoalId: "g-plan",
  },
};

// One round: a tick reaches the actuator and parks inside its submit, the
// worker's own turn runs and ends while it is parked, then the submit resolves.
// Returns the number of rounds whose tick actually queued a [GOAL] prompt, so a
// round the cap turned away is visible to the caller rather than an assertion
// failure inside the driver.
async function nudgeUnderParkedSubmitDrive(h, clock, { meetRounds }) {
  const startH = h.handlers["turn.start"];
  const completeH = h.handlers["turn.complete"];
  const scoredLabels = [];
  const scoredPrompts = [];
  // One stub serves both callers, told apart by the label set each is handed:
  // only the turn scorer offers "on-goal". The decider gets "nudge" so every
  // round reaches the actuator.
  h.setClassifyValue((prompt, labels) => {
    if (Array.isArray(labels) && labels.includes("on-goal")) {
      scoredLabels.push(labels);
      scoredPrompts.push(String(prompt));
      return "on-goal";
    }
    return "nudge";
  });

  let nudgedRounds = 0;
  for (let i = 0; i < meetRounds.length; i++) {
    h.holdPromptSubmits();
    const promptsBefore = goalPrompts(h).length;
    const sentBefore = countAction(getDecisions(h), "nudge_sent");
    clock.advance(130_000);
    await fireTick(h);
    const parked = await waitUntil(() => goalPrompts(h).length > promptsBefore, 60);
    if (!parked) {
      // The tick never reached the submit. That is the cap turning it away on
      // the control side; it is the assertion the caller reads, not an error.
      h.releasePromptSubmits();
      await new Promise(r => setTimeout(r, 20));
      continue;
    }
    nudgedRounds += 1;

    // The worker's own turn, opened and closed while the submit is parked. Met
    // on goal it is a real scored completion; unmet it is aborted, which skips
    // scoring and so resets nothing.
    const turnId = `met-turn-${i}`;
    await startH(h.fake, { turnId }, () => {});
    await completeH(h.fake, meetRounds[i]
      ? { turnId, answer: "took the next concrete step toward the objective", reason: "end_turn" }
      : { turnId, aborted: true, reason: "aborted" }, () => {});

    h.releasePromptSubmits();
    await waitUntil(() => countAction(getDecisions(h), "nudge_sent") > sentBefore);
  }
  return { nudgedRounds, scoredLabels, scoredPrompts };
}

// The headline: the first round is met on goal, so it costs the counter nothing,
// and the three unmet rounds after it all still get their nudge. The cap is
// three, so a met round that left its own nudge on the counter would have capped
// the fourth.
async function caseR119_aMetNudgeClearsItsOwnCount(clock) {
  console.log("\n=== R119: a nudge met on goal clears its own count, so the cap is not reached early ===");
  clock.set(T0);

  // The cost path is off inside R119_OPTS for the same reason caseR117a turns
  // it off: with it on, a round can be turned away by the D2 idle skip before
  // the actuator, and the counts below would then be reading that rather than
  // the cap.
  const h = await seedNudgeRaceHarness("r119_met_on_goal", R119_OPTS);

  const { nudgedRounds, scoredLabels, scoredPrompts } =
    await nudgeUnderParkedSubmitDrive(h, clock, { meetRounds: [true, false, false, false] });

  check("r119: all four rounds queued their [GOAL] prompt", nudgedRounds === 4);
  check("r119: four nudge_sent decisions", countAction(getDecisions(h), "nudge_sent") === 4);
  check("r119: the cap was not reached", countAction(getDecisions(h), "nudge_cap_reached") === 0);
  check("r119: the node was not paused", getState(h).goals.every(g => g.status !== "paused"));

  // Instrument: the met round's turn really was scored, so the reset this case
  // is about actually happened.
  check("r119: the met round's turn was scored", scoredLabels.length === 1);
  // The nudged-turn flag was spent before the submit, so the turn that ran under
  // it is scored with the nudge-aware label set rather than the ordinary one.
  check("r119: the scored turn saw the nudge-aware label set",
    scoredLabels.length === 1 && !scoredLabels[0].includes("off-goal-by-instruction"));
  // The prompt text was spent before the submit, so the scorer judges the answer
  // against the nudge the worker was actually answering.
  check("r119: the scorer read the nudge text as the prompt",
    scoredPrompts.length === 1 && scoredPrompts[0].includes("[GOAL] The active goal is"));
}

// The withheld control, varying only the first round: with nothing met on goal
// the same four rounds reach the cap at the fourth. Without it the absence
// asserted above would also be produced by a driver that had stopped reaching
// the cap check at all.
async function caseR119_noRoundMetReachesTheCap_control(clock) {
  console.log("\n=== R119 control: the same four rounds with nothing met on goal reach the cap ===");
  clock.set(T0);

  const h = await seedNudgeRaceHarness("r119_unmet_control", R119_OPTS);

  const { nudgedRounds, scoredLabels } =
    await nudgeUnderParkedSubmitDrive(h, clock, { meetRounds: [false, false, false, false] });

  check("r119 control: the control side scored no turn at all", scoredLabels.length === 0);
  check("r119 control: three rounds nudged and the fourth did not", nudgedRounds === 3);
  check("r119 control: three nudge_sent decisions", countAction(getDecisions(h), "nudge_sent") === 3);
  check("r119 control: the cap was reached", countAction(getDecisions(h), "nudge_cap_reached") >= 1);
  check("r119 control: the node was paused by the cap",
    getState(h).goals.some(g => g.status === "paused" && g.pausedByNudgeCap === true));
}

// ============================================================
// A submit that throws is recorded, because the floor is already spent
// ============================================================

// Spending the floor before the submit means a failed submit costs a whole
// window with nothing retrying it. The record is what keeps that from being
// silent.
async function caseNudgeFailed_recordedAndTheFloorIsStillSpent(clock) {
  console.log("\n=== Nudge failed: a throwing submit is recorded and the floor is still spent ===");
  clock.set(T0);

  // Cost path off so the second tick below reaches the floor test rather than
  // the D2 idle skip, the same reason caseR117a turns it off.
  const h = await seedNudgeRaceHarness("nudge_failed", { costEnabled: false });
  h.failPromptSubmits(new Error("prompt-submit budget exhausted"));

  clock.advance(130_000);
  await fireTick(h);
  const failed = await waitUntil(() => getDecisions(h).some(d => d.action === "nudge_failed"));
  check("nudge failed: the failure is recorded", failed);
  check("nudge failed: the submit was attempted, so this is a throw and not a skip",
    goalPrompts(h).length === 1);
  check("nudge failed: no nudge_sent", !getDecisions(h).some(d => d.action === "nudge_sent"));
  // The one detail assertion in this case. Naming the error is the whole
  // payload of this record, and one that does not say why the nudge failed
  // leaves an operator exactly where the silence did. The surrounding wording
  // is deliberately not pinned.
  const failures = getDecisions(h).filter(d => d.action === "nudge_failed");
  check("nudge failed: the record carries the error",
    failures.length === 1 && failures[0].detail.includes("prompt-submit budget exhausted"));

  // The floor was spent before the submit, so the next tick inside the window is
  // turned away by the floor rather than retrying into the same failure.
  clock.advance(60_000);
  await fireTick(h);
  const held = await waitUntil(() => countAction(getDecisions(h), "nudge_skipped_floor") >= 1);
  check("nudge failed: the floor was spent even though the submit threw", held);
  check("nudge failed: no second submit attempt inside the window", goalPrompts(h).length === 1);
}

// ============================================================
// Section 9: turn.complete is keyed to its own turn.
//
// The deferred-status stamp sess.turnStartedAt is published to the heartbeat
// and read by another session, so a wrong value there is not superseded in
// process: it is what the reader sees. These cases drive the shapes that used
// to corrupt it - a completion for a turn this session never saw start, and a
// completion for one of two turns open at once.
// ============================================================

// Criterion 1, with criterion 6 beside it and criterion 2 as the withheld
// control: an unmatched completion leaves the stamp naming the turn that is
// still open, while the idle anchor still moves, because its only reader runs
// when nothing is open at all.
async function caseSection9_unmatchedCompletionLeavesTheStampOnAnOpenTurn(clock) {
  console.log("\n=== Section 9: an unmatched completion leaves the deferred stamp on the turn still open ===");
  clock.set(T0);
  const h = await seedOwnerHarness("section9_unmatched_stamp", T0);
  const startH = h.handlers["turn.start"];
  const completeH = h.handlers["turn.complete"];

  await startH(h.fake, { turnId: "t-real" }, async () => ({ result: "ok" }));
  check("section9 unmatched setup: the open turn's start is stamped", readHeartbeat(h).default?.turnStartedAt === T0);

  clock.advance(90_000);
  await completeH(h.fake, { turnId: "t-never-started", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  check(
    "section9 unmatched: the stamp still names the turn that is still open",
    readHeartbeat(h).default?.turnStartedAt === T0,
    readHeartbeat(h).default,
  );
  check(
    "section9 unmatched: the idle anchor still moves on an unmatched completion",
    getState(h).monitor.lastTurnComplete === T0 + 90_000,
    getState(h).monitor.lastTurnComplete,
  );

  // The control, withheld from the shapes above: a matched completion for the
  // only open turn still clears the stamp, so the two readings above are the
  // fix rather than a stamp that stopped being written at all.
  clock.advance(30_000);
  await completeH(h.fake, { turnId: "t-real", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  check(
    "section9 control: a matched completion for the only open turn clears the stamp to null",
    readHeartbeat(h).default?.turnStartedAt === null,
    readHeartbeat(h).default,
  );
  check(
    "section9 control: and the idle anchor moved again",
    getState(h).monitor.lastTurnComplete === T0 + 120_000,
    getState(h).monitor.lastTurnComplete,
  );
}

// Criterion 3: with two turns open, completing the later one leaves the stamp
// at the earlier turn's start - not null, and not the completed turn's own.
// This is the reading the naive "skip the clear when unmatched" fix gets wrong,
// because that completion is matched.
async function caseSection9_completingOneOfTwoLeavesTheEarlierTurnsStamp(clock) {
  console.log("\n=== Section 9: completing one of two open turns leaves the earlier turn's stamp ===");
  clock.set(T0);
  const h = await seedOwnerHarness("section9_two_open_stamp", T0);
  const startH = h.handlers["turn.start"];
  const completeH = h.handlers["turn.complete"];

  await startH(h.fake, { turnId: "t-a" }, async () => ({ result: "ok" }));
  clock.advance(45_000);
  await startH(h.fake, { turnId: "t-b" }, async () => ({ result: "ok" }));

  clock.advance(15_000);
  await completeH(h.fake, { turnId: "t-b", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  const afterB = readHeartbeat(h).default?.turnStartedAt;
  check("section9 two open: the stamp is the still-running turn's start", afterB === T0, afterB);

  clock.advance(20_000);
  await completeH(h.fake, { turnId: "t-a", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  check(
    "section9 two open: the last completion empties the map and clears the stamp",
    readHeartbeat(h).default?.turnStartedAt === null,
    readHeartbeat(h).default,
  );
}

// Criteria 4 and 5: the long-turn record measures against its own turn's start.
// An unmatched completion arriving mid-turn writes no record at all, and a
// completion for one of two open turns is measured against the turn it names.
// No completion here carries durationMs, so every figure comes from the
// open-turn map's own entry for the turn named, the fallback the harness
// duration otherwise shadows.
async function caseSection9_longTurnRecordMeasuresItsOwnTurn(clock) {
  console.log("\n=== Section 9: the long-turn record measures its own turn, and is skipped when unmatched ===");
  clock.set(T0);
  const h = await seedOwnerHarness("section9_long_turn_own_start", T0);
  const startH = h.handlers["turn.start"];
  const completeH = h.handlers["turn.complete"];

  // A real turn runs past the hour, then a completion arrives for a turn this
  // session never saw start. Measured against the running turn's clock it
  // would read as a sixty-one-minute turn of its own; keyed to its own missing
  // map entry it records nothing.
  await startH(h.fake, { turnId: "t-a" }, async () => ({ result: "ok" }));
  clock.advance(61 * 60_000);
  await completeH(h.fake, { turnId: "t-never-started", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  check(
    "section9 long turn: an unmatched short completion banks no record from the running turn",
    countAction(getDecisions(h), "turn_over_hour") === 0,
    getDecisions(h).filter(d => d.action === "turn_over_hour"),
  );

  // The real turn's own completion records its own duration, sixty-six
  // minutes measured from its map entry, rather than the sixty-one the
  // unmatched completion would have banked and then cleared.
  clock.advance(5 * 60_000);
  await completeH(h.fake, { turnId: "t-a", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  const afterA = getDecisions(h).filter(d => d.action === "turn_over_hour");
  check("section9 long turn: the matched completion writes exactly one record", afterA.length === 1, afterA);
  check(
    "section9 long turn: measured against its own start, 3960s",
    afterA.length === 1 && /\b3960s\b/.test(afterA[0].detail),
    afterA[0]?.detail,
  );

  // Two real turns open at once: the long one completes first, while the
  // short one is still running. Its record is its own sixty-three minutes,
  // and the short turn that follows records nothing.
  await startH(h.fake, { turnId: "t-c" }, async () => ({ result: "ok" }));
  clock.advance(61 * 60_000);
  await startH(h.fake, { turnId: "t-d" }, async () => ({ result: "ok" }));
  clock.advance(2 * 60_000);
  await completeH(h.fake, { turnId: "t-c", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  const afterC = getDecisions(h).filter(d => d.action === "turn_over_hour");
  check("section9 long turn: the overlapped long turn still records", afterC.length === 2, afterC);
  check(
    "section9 long turn: measured against its own start, 3780s",
    afterC.length === 2 && /\b3780s\b/.test(afterC[1].detail),
    afterC[1]?.detail,
  );
  clock.advance(60_000);
  await completeH(h.fake, { turnId: "t-d", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  check(
    "section9 long turn control: the three-minute turn records nothing",
    getDecisions(h).filter(d => d.action === "turn_over_hour").length === 2,
    getDecisions(h).filter(d => d.action === "turn_over_hour"),
  );
}

// Section 9 fix round 1: both turn handlers derive the published stamp through
// one rule. Before this, turn.start stamped its own clock, so opening a second
// turn moved the stamp forward and a reader watched one record's deferral
// shrink and then grow again when that second turn completed.
async function caseSection9_turnStartDerivesTheStampToo(clock) {
  console.log("\n=== Section 9: a second turn opening does not move the published stamp ===");
  clock.set(T0);
  const h = await seedOwnerHarness("section9_start_derives", T0);
  const startH = h.handlers["turn.start"];
  const completeH = h.handlers["turn.complete"];

  await startH(h.fake, { turnId: "t-a" }, async () => ({ result: "ok" }));
  check("section9 start-derive setup: A's start is stamped", readHeartbeat(h).default?.turnStartedAt === T0, readHeartbeat(h).default);

  clock.advance(30_000);
  await startH(h.fake, { turnId: "t-b" }, async () => ({ result: "ok" }));
  const afterBStarts = readHeartbeat(h).default?.turnStartedAt;
  check("section9 start-derive: opening B leaves the stamp at A's start", afterBStarts === T0, afterBStarts);

  clock.advance(30_000);
  await completeH(h.fake, { turnId: "t-a", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  const afterADone = readHeartbeat(h).default?.turnStartedAt;
  check("section9 start-derive: with A closed the stamp moves to B's start", afterADone === T0 + 30_000, afterADone);
}

// Section 9 fix round 1: the long-turn record prefers the harness's own
// duration, so a turn whose start this session never saw is still counted.
// Nothing else in the plugin reads that field, so this case is the only place
// the branch is exercised at all.
async function caseSection9_durationMsCountsAnUnmatchedLongTurn(clock) {
  console.log("\n=== Section 9: the harness duration counts a long turn whose start was never seen ===");
  clock.set(T0);
  const h = await seedOwnerHarness("section9_durationms", T0);
  const completeH = h.handlers["turn.complete"];
  const longTurns = () => getState(h).decisions.filter((d) => d.action === "turn_over_hour");

  // Withheld control first: the same unmatched completion with no duration
  // field writes nothing, so a record below cannot come from anywhere else.
  await completeH(h.fake, { turnId: "t-unseen-1", aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  check("section9 durationMs control: an unmatched completion with no duration writes nothing", longTurns().length === 0, longTurns());

  await completeH(h.fake, { turnId: "t-unseen-2", aborted: true, reason: "aborted", durationMs: 4_200_000 }, async () => ({ result: "ok" }));
  const recorded = longTurns();
  check("section9 durationMs: an unmatched long turn is counted from the harness duration", recorded.length === 1, recorded);
  check("section9 durationMs: measured at the harness figure, 4200s", recorded[0] && recorded[0].detail.includes("4200s"), recorded[0] && recorded[0].detail);

  await completeH(h.fake, { turnId: "t-unseen-3", aborted: true, reason: "aborted", durationMs: 180_000 }, async () => ({ result: "ok" }));
  check("section9 durationMs control: a three-minute harness duration records nothing", longTurns().length === 1, longTurns());

}

// ============================================================
// Section 13: hook paths driven whole through the harness: the scorer's
// round, the error streak, the git probe, the health probe, plan activation
// and the post-completion guard, the planner failure cap, stale-holder
// takeover, lesson injection, and the budget latch.
// ============================================================

// Ordered-subsequence match, the shape assert-decisions.js reads a live
// decision log with: how many of `expected` appear in `decisions` in order.
function matchedInOrder(decisions, expected) {
  let idx = 0;
  for (const d of decisions) {
    if (idx < expected.length && d.action === expected[idx]) idx++;
  }
  return idx;
}

// A root with one active plan under it, the tree a live suite holds after
// goal_create and the first activation. maxRounds is set so a scored round
// does not trip the round cap.
function rootWithActivePlan(now, rootOverrides = {}) {
  return [
    makeGoalNode({ id: "g-root", parentId: null, kind: "root", status: "pending", maxRounds: 10, createdAt: now, updatedAt: now, ...rootOverrides }),
    makeGoalNode({ id: "g-plan", parentId: "g-root", kind: "plan", status: "active", maxRounds: 5, createdAt: now, updatedAt: now }),
  ];
}

// Scorer: the scorer on turn.complete classifies a completed turn
// against the leaf that was active at turn.start, records a score decision,
// and an on-goal verdict burns one round of that leaf.
async function caseS13_score_completedTurnRecordsRound(clock) {
  console.log("\n=== S13 score: a completed turn on the active leaf records a score and burns a round ===");
  clock.set(T0);
  const h = await createTickHarness({
    ...OPTS,
    caseName: "s13_score",
    stateOpts: { now: T0, goals: rootWithActivePlan(T0), activeGoalId: "g-plan" },
  });
  h.setClassifyValue("on-goal");
  await h.handlers["turn.start"](h.fake, { turnId: "t-score" }, async () => ({ result: "ok" }));
  await h.handlers["turn.complete"](h.fake, { turnId: "t-score", answer: "Rivers run to the sea.", reason: "completed" }, async () => ({ result: "ok" }));
  const state = getState(h);
  const scores = state.decisions.filter((d) => d.action === "score");
  check("s13 score: one score decision names the turn's leaf and the verdict", scores.length === 1 && scores[0].detail === "g-plan Round 1: on-goal", scores);
  const plan = state.goals.find((g) => g.id === "g-plan");
  check("s13 score: the on-goal round is burned (completedRounds 1)", plan && plan.completedRounds === 1, plan && plan.completedRounds);
}

// Error streak: a root objective saying "no bash" denies Bash in
// tool.call, three denied turns reach the C3 streak on the next tick, and the
// streak opens an ask and pauses the plan rather than blocking it.
async function caseS13_errorStreak_threeDeniedTurnsOpenAnAsk(clock) {
  console.log("\n=== S13 errorstreak: three denied turns escalate to an ask, not a block ===");
  clock.set(T0);
  const h = await createTickHarness({
    ...OPTS,
    caseName: "s13_errorstreak",
    stateOpts: { now: T0, goals: rootWithActivePlan(T0, { objective: "no bash: write the file with the Write tool" }), activeGoalId: "g-plan" },
  });
  const startH = h.handlers["turn.start"];
  const toolH = h.handlers["tool.call"];
  const completeH = h.handlers["turn.complete"];
  let denied = 0;
  for (let i = 1; i <= 3; i++) {
    const turnId = `t-streak-${i}`;
    await startH(h.fake, { turnId }, async () => ({ result: "ok" }));
    const r = await toolH(h.fake, { tool: "Bash", turnId }, async () => ({ result: "ran" }));
    if (r && r.deny) denied++;
    await completeH(h.fake, { turnId, aborted: true, reason: "aborted" }, async () => ({ result: "ok" }));
  }
  check("s13 errorstreak: the root constraint denied Bash on every turn", denied === 3, denied);
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);
  const decisions = getDecisions(h);
  const expected = ["deny", "deny", "deny", "error_streak", "ask_opened", "paused_by_controller", "ask_waiting"];
  check("s13 errorstreak: deny x3, error_streak, ask_opened, paused_by_controller, ask_waiting in order", matchedInOrder(decisions, expected) === expected.length, decisions.map((d) => d.action));
  check("s13 errorstreak: no block (the streak asks, it does not block)", !decisions.some((d) => d.action === "block"));
}

// Git probe: the git probe runs on its cadence, counts the porcelain
// lines that are not the branch line, and logs env_git when the count moves.
// The probe is fire-and-forget and the tick persists only on its own paths,
// so a turn flushes the in-memory decisions to the store before the read.
async function caseS13_gitProbe_dirtyCountSampledOnCadence(clock) {
  console.log("\n=== S13 gitprobe: the porcelain dirty count is sampled on the probe cadence ===");
  clock.set(T0);
  const h = await createTickHarness({ ...OPTS, caseName: "s13_gitprobe", gitProbeMs: 30_000 });
  const porcelains = ["## main\n", "## main\n?? new-file.txt\n", "## main\n"];
  let sample = 0;
  h.fake.process.run = (argv) => {
    if (argv[0] === "git" && argv[1] === "status") {
      return Promise.resolve({ exitCode: 0, stdout: porcelains[Math.min(sample++, porcelains.length - 1)] });
    }
    if (argv[0] === "git" && argv[1] === "log") return Promise.resolve({ exitCode: 0, stdout: "1700000000\n" });
    return Promise.resolve({ exitCode: 128 });
  };
  for (let i = 0; i < 3; i++) {
    clock.advance(30_000);
    await tickAndSettle(h, clock, 20);
  }
  await fireTurn(h, "t-gitprobe-flush");
  const decisions = getDecisions(h);
  const gitLines = decisions.filter((d) => d.action === "env_git");
  const dirtySeq = gitLines.map((d) => (d.detail.match(/dirty=(\d+)/) || [])[1]);
  check("s13 gitprobe: three env_git samples read dirty 0, then 1, then 0", dirtySeq.join(",") === "0,1,0", gitLines.map((d) => d.detail));
  check("s13 gitprobe: no env_git_null or env_git_error", !decisions.some((d) => d.action === "env_git_null" || d.action === "env_git_error"), decisions.map((d) => d.action));
}

// Health probe: runHealth maps the probe's exit code to health_red or
// health_green at the goal_done completion site, and a red probe reaches the
// next turn as an [ENV] block with an env_inject decision. The first tick
// activates the first pending plan, so the activation precedes the first probe.
async function caseS13_health_redThenGreenAndTheRedReachesTheTurn(clock) {
  console.log("\n=== S13 health: the probe's exit code maps to health_red then health_green, and the red reaches the [ENV] block ===");
  clock.set(T0);
  const goals = [
    makeGoalNode({ id: "g-root", parentId: null, kind: "root", status: "pending", maxRounds: 10 }),
    makeGoalNode({ id: "g-plan-1", parentId: "g-root", kind: "plan", status: "pending", maxRounds: 5 }),
    makeGoalNode({ id: "g-plan-2", parentId: "g-root", kind: "plan", status: "pending", maxRounds: 5, createdAt: T0 + 1 }),
  ];
  const h = await createTickHarness({ ...OPTS, caseName: "s13_health", stateOpts: { now: T0, goals, activeGoalId: null } });
  h.fsMap.set(".agentic-health", "node probe.js");
  const probeExits = [1, 0];
  h.fake.process.run = (argv) => {
    if (argv[0] === "node") return Promise.resolve({ exitCode: probeExits.shift() ?? 0, stdout: "probe output\n" });
    return Promise.resolve({ exitCode: 128 });
  };
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);
  const toolH = h.handlers["tool.call"];
  const submitH = h.handlers["prompt.submit"];
  await toolH(h.fake, { tool: "mcp__agentic-plugin__goal_done", note: "first" }, async () => ({ result: "ok" }));
  const injected = await submitH(h.fake, { text: "next step" }, async () => ({}));
  await toolH(h.fake, { tool: "mcp__agentic-plugin__goal_done", note: "second" }, async () => ({ result: "ok" }));
  const decisions = getDecisions(h);
  const expected = ["activated", "health_red", "env_inject", "health_green"];
  check("s13 health: activated, health_red, env_inject, health_green in order", matchedInOrder(decisions, expected) === expected.length, decisions.map((d) => d.action));
  const envBlock = (injected.context || []).find((b) => b.startsWith("[ENV]"));
  check("s13 health: the [ENV] block names the red probe's exit code", !!envBlock && envBlock.includes("health: exit 1"), injected.context);
}

// Plan activation: H1, a pending plan under the root is activated by the
// tick with no planner run before it, and L25, once the root is complete no
// later tick activates anything, as a real activation or as activate_none.
async function caseS13_stall_pendingPlanActivatesFirstAndNothingActivatesAfterRootComplete(clock) {
  console.log("\n=== S13 goaltree-stall: a pending plan activates with no planner run before it (H1); nothing activates after root_complete (L25) ===");
  clock.set(T0);
  const goals = [
    makeGoalNode({ id: "g-root", parentId: null, kind: "root", status: "pending", maxRounds: 10 }),
    makeGoalNode({ id: "g-added", parentId: "g-root", kind: "plan", status: "pending", maxRounds: 5, source: "worker" }),
  ];
  const h = await createTickHarness({ ...OPTS, caseName: "s13_stall", completeValue: "[]", stateOpts: { now: T0, goals, activeGoalId: null } });
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);
  let decisions = getDecisions(h);
  const activatedIdx = decisions.findIndex((d) => d.action === "activated");
  check("s13 stall H1: the tick activates the pending plan with no planning_fired before it", activatedIdx !== -1 && !decisions.slice(0, activatedIdx).some((d) => d.action === "planning_fired"), decisions.map((d) => d.action));
  check("s13 stall H1: the planner was not called while the added plan was pending", h.completeCalls.length === 0, h.completeCalls.length);
  await h.handlers["tool.call"](h.fake, { tool: "mcp__agentic-plugin__goal_done", note: "done" }, async () => ({ result: "ok" }));
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);
  decisions = getDecisions(h);
  const rootCompleteIdx = decisions.findIndex((d) => d.action === "root_complete");
  check("s13 stall: planning_fired then root_complete once the plan is done", rootCompleteIdx !== -1 && decisions.slice(0, rootCompleteIdx).some((d) => d.action === "planning_fired"), decisions.map((d) => d.action));
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);
  clock.advance(10_000);
  await tickAndSettle(h, clock, 20);
  const after = getDecisions(h).slice(rootCompleteIdx + 1).map((d) => d.action);
  check("s13 stall L25: no activated after root_complete", rootCompleteIdx !== -1 && !after.includes("activated"), after);
  check("s13 stall L25: no activate_none after root_complete", rootCompleteIdx !== -1 && !after.includes("activate_none"), after);
}

// Planner failure cap: the .agentic-planner-fault flag replaces the planner's reply
// with "not json"; three parse failures block the root with a reason naming
// the planner, and no planner call fires after the block (M13). The stubbed
// reply is a valid plan, so a flag the code ignored would show as
// planning_created.
async function caseS13_planFail_threeFailuresBlockTheRoot(clock) {
  console.log("\n=== S13 planfail: three planner failures block the root and stop the retries ===");
  clock.set(T0);
  const root = makeGoalNode({ id: "g-root", parentId: null, kind: "root", status: "pending", maxRounds: 10 });
  const h = await createTickHarness({
    ...OPTS,
    caseName: "s13_planfail",
    completeValue: JSON.stringify([{ title: "Step 1", objective: "Do step 1", maxRounds: 5 }]),
    stateOpts: { now: T0, goals: [root], activeGoalId: null },
  });
  h.fsMap.set(".agentic-planner-fault", "1");
  for (let i = 0; i < 4; i++) {
    clock.advance(10_000);
    await tickAndSettle(h, clock, 20);
  }
  const state = getState(h);
  const decisions = state.decisions;
  const rootNow = state.goals.find((g) => g.parentId === null);
  check("s13 planfail: the root is blocked with a reason naming the planner", !!rootNow && rootNow.status === "blocked" && /Planner failing/.test(rootNow.blockedReason || ""), rootNow && [rootNow.status, rootNow.blockedReason]);
  check("s13 planfail: exactly three planning_failed", countAction(decisions, "planning_failed") === 3, decisions.map((d) => d.action));
  const blockIdx = decisions.findIndex((d) => d.action === "block");
  const afterBlock = decisions.slice(blockIdx + 1).map((d) => d.action);
  check("s13 planfail: no planning_failed or planning_fired after the block", blockIdx !== -1 && !afterBlock.includes("planning_failed") && !afterBlock.includes("planning_fired"), afterBlock);
  check("s13 planfail: no planning_created (the fault flag took effect)", countAction(decisions, "planning_created") === 0);
}

// Stale-holder takeover: a session that joined as reader behind a live holder
// takes the persona over through agentic_identity once that holder's commons
// entry is older than staleAfterMs. caseS5_identity_joins_live_owner is the
// control: the same call against a live holder joins as reader.
async function caseS13_identity_takesOverAStaleHolder(clock) {
  console.log("\n=== S13 takeover: agentic_identity takes over a persona whose holder went stale ===");
  clock.set(T0);
  const mod = await loadModule("s13_stale_takeover");
  const h = createFake$(OPTS);
  const handlers = {};
  await mod.register((event, handler) => { handlers[event] = handler; }, OPTS);
  const holderSid = "earlier-holder-session";
  const now = Date.now();
  h.storeMap.set(`commons:${holderSid}`, {
    sessionId: holderSid,
    lastSeen: now,
    claims: [{ resource: "persona:default", claimedAt: now - 1000 }],
  });
  const state = makeState({ now });
  state.activeSessionId = holderSid;
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));
  h.fsMap.set(".agentic-heartbeat.json", JSON.stringify({ default: { sessionId: holderSid, epoch: 1, lastSeen: now } }));
  await handlers["session.start"](h.fake, {}, () => {});
  const toolH = handlers["tool.call"];
  const refused = await toolH(h.fake, { tool: "mcp__agentic-plugin__agentic_identity", persona: "default" }, async () => ({ result: "passthrough" }));
  check("s13 takeover control: with the holder live, the call joins as reader", (refused?.result || "").includes("joined as reader"), refused);
  // The holder stops heartbeating: its entry ages past the 90 s staleAfterMs default.
  clock.advance(200_000);
  const taken = await toolH(h.fake, { tool: "mcp__agentic-plugin__agentic_identity", persona: "default" }, async () => ({ result: "passthrough" }));
  const text = taken?.result || "";
  check("s13 takeover: with the holder stale, the result names ownership", /owner/.test(text) && !/joined as reader/.test(text), text);
  const decisions = getState(h).decisions;
  check("s13 takeover: identity_set is recorded for the takeover", decisions.some((d) => d.action === "identity_set"), decisions.map((d) => d.action));
  const mine = h.storeMap.get(`commons:${SESSION_ID}`);
  check("s13 takeover: this session's commons entry holds persona:default", !!mine && mine.claims.some((c) => c.resource === "persona:default"), mine);
}

// Lesson injection: the newest self-review lesson in memory is
// injected into the next turn as a [LESSON] block with a lesson_inject
// decision, and the S11 gate on lastInjectAt keeps it from riding every
// later turn. The decision lands in the store through the turn that follows
// the prompt, since prompt.submit itself does not persist.
async function caseS13_lessonInject_newestLessonReachesTheNextTurnOnce(clock) {
  console.log("\n=== S13 lesson_inject: the newest self-review lesson is injected into the next turn, once ===");
  clock.set(T0);
  const h = await createTickHarness({ ...OPTS, caseName: "s13_lesson_inject" });
  const state = makeState({ now: T0 });
  const lesson = (id, text, createdAt) => ({ id, kind: "lesson", text, confidence: 0.9, source: "self-review", createdAt, lastAccessed: 0, accessCount: 0, pinned: false });
  state.memory = [
    lesson("m-older", "An older lesson.", T0 - 60_000),
    lesson("m-newest", "Run the tests before claiming done.", T0 - 1_000),
  ];
  h.fsMap.set(".agentic-personas.json", JSON.stringify({ default: state }));
  await h.handlers["session.start"](h.fake, {}, () => {});
  const submitH = h.handlers["prompt.submit"];
  const first = await submitH(h.fake, { text: "continue" }, async () => ({}));
  const lessonBlock = (first.context || []).find((b) => b.startsWith("[LESSON]"));
  check("s13 lesson_inject: the [LESSON] block carries the newest self-review lesson", !!lessonBlock && lessonBlock.includes("Run the tests before claiming done."), first.context);
  await fireTurn(h, "t-lesson-1");
  const injects = getDecisions(h).filter((d) => d.action === "lesson_inject");
  check("s13 lesson_inject: one lesson_inject decision names that lesson", injects.length === 1 && injects[0].detail.includes("Run the tests before claiming done."), injects);
  const second = await submitH(h.fake, { text: "continue again" }, async () => ({}));
  check("s13 lesson_inject: the same lesson is not injected again on the next prompt", !(second.context || []).some((b) => b.startsWith("[LESSON]")), second.context);
}

// Budget latch: each threshold's crossing is latched, so
// three reads of one over-critical estimate log info, closeout and critical
// once each and send the close-out nudge once (D2 latch).
async function caseS13_budget_latchCrossesEachThresholdOnce(clock) {
  console.log("\n=== S13 budget latch: each threshold crosses once and the close-out nudge is sent once ===");
  clock.set(T0);
  const h = await createTickHarness({
    ...OPTS,
    caseName: "s13_budget_latch",
    contextBudgetEnabled: true,
    contextBudgetInfoTokens: 100,
    contextBudgetCloseoutTokens: 200,
    contextBudgetCriticalTokens: 300,
    contextBudgetReadEveryNTicks: 1,
    sessionMessages: () => Promise.resolve([{ text: "x".repeat(2000), toolUses: [], toolResults: [] }]),
  });
  for (let i = 0; i < 3; i++) {
    clock.advance(10_000);
    await tickAndSettle(h, clock, 50);
  }
  const decisions = getDecisions(h);
  const crossings = decisions.filter((d) => d.action === "context_budget_crossed").map((d) => d.detail.split(":")[0]);
  check("s13 budget latch: info, closeout and critical each crossed exactly once over three reads", ["info", "closeout", "critical"].every((t) => crossings.filter((c) => c === t).length === 1), crossings);
  check("s13 budget latch: exactly one context_budget_nudge", countAction(decisions, "context_budget_nudge") === 1, countAction(decisions, "context_budget_nudge"));
}

