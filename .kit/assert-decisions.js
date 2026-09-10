#!/usr/bin/env node
// M12: assert-decisions.js, ordered-subsequence + forbidden-list checks.
// Usage: node assert-decisions.js <test-name> <store-path> <assert-log-path>
// Exits 0 on success, 1 on failure. Captures stdout+stderr to the assert log.

const fs = require("fs");
const path = require("path");

const testName = process.argv[2];
const storePath = process.argv[3];
const assertLogPath = process.argv[4];

if (!testName || !storePath || !assertLogPath) {
  process.stderr.write("Usage: node assert-decisions.js <test-name> <store-path> <assert-log-path>\n");
  process.exit(1);
}

// Redirect stdout and stderr to the assert log (collect into a buffer, write once at the end).
let _logBuf = "";
const _origOut = process.stdout.write.bind(process.stdout);
const _origErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk) => { _logBuf += chunk; return true; };
process.stderr.write = (chunk) => { _logBuf += chunk; return true; };

// Read the store and extract decisions.
let store;
try {
  store = JSON.parse(fs.readFileSync(storePath, "utf8"));
} catch (e) {
  console.error(`FAIL: cannot read store: ${e.message}`);
  process.exit(1);
}

const persona = Object.keys(store)[0];
if (!persona) {
  console.error("FAIL: no persona in store");
  process.exit(1);
}
const state = store[persona];
const decisions = (state.decisions || []).map(d => d.action);
const details = state.decisions || [];

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name) { console.error(`  FAIL: ${name}`); failed++; }

// Ordered subsequence check: `expected` must appear in `decisions` in order.
function orderedSubsequence(expected, label) {
  let idx = 0;
  for (let i = 0; i < decisions.length && idx < expected.length; i++) {
    if (decisions[i] === expected[idx]) idx++;
  }
  if (idx === expected.length) {
    ok(`${label}: ordered subsequence found`);
  } else {
    fail(`${label}: expected [${expected.join(", ")}], matched ${idx}/${expected.length}`);
  }
}

// Forbidden list: none of these actions may appear in decisions.
function forbidden(actions, label) {
  const found = decisions.filter(a => actions.includes(a));
  if (found.length === 0) {
    ok(`${label}: no forbidden actions`);
  } else {
    fail(`${label}: forbidden action(s) found: ${found.join(", ")}`);
  }
}

// Forbidden before: `forbiddenAction` must not appear before `anchorAction`.
function forbiddenBefore(forbiddenAction, anchorAction, label) {
  const anchorIdx = decisions.indexOf(anchorAction);
  if (anchorIdx === -1) {
    fail(`${label}: anchor '${anchorAction}' not found`);
    return;
  }
  const foundBefore = decisions.slice(0, anchorIdx).filter(a => a === forbiddenAction);
  if (foundBefore.length === 0) {
    ok(`${label}: no '${forbiddenAction}' before '${anchorAction}'`);
  } else {
    fail(`${label}: '${forbiddenAction}' appears ${foundBefore.length}x before '${anchorAction}'`);
  }
}

// Forbidden after: `forbiddenAction` must not appear after `anchorAction`.
function forbiddenAfter(forbiddenAction, anchorAction, label) {
  const anchorIdx = decisions.indexOf(anchorAction);
  if (anchorIdx === -1) {
    fail(`${label}: anchor '${anchorAction}' not found`);
    return;
  }
  const foundAfter = decisions.slice(anchorIdx + 1).filter(a => a === forbiddenAction);
  if (foundAfter.length === 0) {
    ok(`${label}: no '${forbiddenAction}' after '${anchorAction}'`);
  } else {
    fail(`${label}: '${forbiddenAction}' appears ${foundAfter.length}x after '${anchorAction}'`);
  }
}

switch (testName) {
  case "goaltree": {
    orderedSubsequence(
      ["create", "planning_fired", "planning_created", "activated", "nudge_sent", "done", "activated", "done", "activated", "done", "planning_fired", "root_complete"],
      "goaltree"
    );
    // Forbidden: a turn.complete score on a node other than the turn_start leaf.
    // M11 moved goal_done credits into the goal_done handler, so those scores are
    // explicitly allowed regardless of the turn leaf. Only flag a score line that
    // is NOT a (goal_done) credit AND whose node differs from its turn's leaf.
    const turnLeaves = [];
    for (const d of details) {
      if (d.action === "turn_start") {
        const m = (d.detail || "").match(/leaf (\S+)/);
        if (m) turnLeaves.push(m[1]);
      }
    }
    const allowedLeaves = new Set(turnLeaves);
    allowedLeaves.add("none");
    const badScores = details.filter(d => {
      if (d.action !== "score") return false;
      if (/\(goal_done\)/.test(d.detail || "")) return false; // M11 credit, allowed
      const idMatch = (d.detail || "").match(/^(\S+)/);
      return idMatch && !allowedLeaves.has(idMatch[1]);
    });
    if (badScores.length === 0) ok("goaltree: no score on non-turn-leaf");
    else fail(`goaltree: ${badScores.length} score(s) on non-turn-leaf: ${badScores.map(d => d.detail.slice(0, 40)).join("; ")}`);
    // Every plan has completedRounds >= 1.
    const plans = (state.goals || []).filter(g => g.parentId !== null && g.kind === "plan");
    if (plans.length > 0 && plans.every(p => (p.completedRounds || 0) >= 1)) {
      ok("goaltree: all plans have completedRounds >= 1");
    } else {
      fail(`goaltree: plan completedRounds: ${plans.map(p => `${p.id}=${p.completedRounds}`).join(", ")}`);
    }
    break;
  }
  case "stall": {
    orderedSubsequence(
      ["create", "add", "activated", "nudge_sent", "done", "planning_fired", "root_complete"],
      "stall"
    );
    forbiddenBefore("planning_fired", "activated", "stall");
    // L25: after the root is complete there must be no activation of any kind,
    // whether a real activation (activated) or a no-op one (activate_none).
    forbiddenAfter("activated", "root_complete", "stall: activated");
    forbiddenAfter("activate_none", "root_complete", "stall: activate_none");
    break;
  }
  case "controller": {
    orderedSubsequence(
      ["create", "planning_fired", "planning_created", "activated", "nudge_sent", "done", "activated", "score"],
      "controller"
    );
    // D1: cost_summary must appear at least once in the decisions.
    const costSummaries = details.filter(d => d.action === "cost_summary");
    check2("cost_summary emitted at least once", costSummaries.length >= 1);
    break;
  }
  case "yield": {
    // Two-session contention: A creates and remembers; B force-claims (identity_set)
    // and becomes owner, demoting A to passive reader. A's subsequent write is
    // correctly denied, so the surviving on-disk store (B's) shows A's initial
    // decisions then B's identity_set. The acceptance criterion is exit 0 + exactly
    // one yield log line (checked by the shell script), not a 5-element sequence.
    orderedSubsequence(
      ["persona_create", "turn_start", "remember", "identity_set"],
      "yield"
    );
    break;
  }
  case "planfail": {
    // M13: a failing planner is capped at 3 consecutive failures, then the
    // root is blocked. Assert the full sequence, not just "a failure happened".
    const root = (state.goals || []).find(g => g.parentId === null);
    check2("root exists", !!root);
    check2("root is blocked", !!root && root.status === "blocked");
    check2("root blockedReason names planner failing", !!root && /Planner failing/.test(root.blockedReason || ""));
    const pfCount = decisions.filter(a => a === "planning_failed").length;
    check2("exactly 3 planning_failed", pfCount === 3);
    const blockIdx = decisions.indexOf("block");
    check2("block present", blockIdx !== -1);
    // All three failures precede the block.
    const pfAfterBlock = blockIdx !== -1
      ? decisions.slice(blockIdx + 1).filter(a => a === "planning_failed").length
      : pfCount;
    check2("no planning_failed after block", pfAfterBlock === 0);
    // No planner call may fire after the root is blocked.
    const firedAfterBlock = blockIdx !== -1
      ? decisions.slice(blockIdx + 1).filter(a => a === "planning_fired").length
      : decisions.filter(a => a === "planning_fired").length;
    check2("no planning_fired after block", firedAfterBlock === 0);
    forbidden(["planning_created"], "planfail");
    break;
  }
  case "gitprobe": {
    // F3: assert ordered dirty=0, dirty=1, dirty=0 (new detail format).
    // F7: env_git_null absent (cwd is a git repo).
    const gitLines = details.filter(d => d.action === "env_git");
    const dirtySeq = gitLines.map(d => {
      const m = d.detail.match(/dirty=(\d+)/);
      return m ? m[1] : null;
    }).filter(x => x !== null);
    check2("gitprobe: at least 3 env_git samples", dirtySeq.length >= 3);
    check2("gitprobe: dirty=0 first", dirtySeq[0] === "0");
    check2("gitprobe: dirty=1 second", dirtySeq[1] === "1");
    check2("gitprobe: dirty=0 third", dirtySeq[2] === "0");
    forbidden(["env_git_null", "env_git_error"], "gitprobe: no env_git_null or env_git_error");
    break;
  }
  case "health": {
    // G3: activated before health_red (race is named if it recurs).
    const actIdx = details.findIndex(d => d.action === "activated");
    const redIdx = details.findIndex(d => d.action === "health_red");
    const greenIdx = details.findIndex(d => d.action === "health_green");
    check2("health: health_red found", redIdx !== -1);
    check2("health: health_green found", greenIdx !== -1);
    check2("health: activated before health_red", actIdx !== -1 && redIdx !== -1 && actIdx < redIdx);
    check2("health: red before green", redIdx !== -1 && greenIdx !== -1 && redIdx < greenIdx);
    // F5: env_inject present (after health_red, when health exit is non-zero = notable).
    const injectIdx = details.findIndex(d => d.action === "env_inject");
    check2("health: env_inject present", injectIdx !== -1);
    check2("health: env_inject after health_red", redIdx !== -1 && injectIdx !== -1 && injectIdx > redIdx);
    break;
  }
  case "errorstreak": {
    // G2: deny-count pre-check (inducer failure distinguishable from plugin failure).
    const denyCount = decisions.filter(a => a === "deny").length;
    check2("errorstreak: deny count >= 3", denyCount >= 3);
    // F6: ordered deny, deny, deny, error_streak, controller_tick, paused_by_controller.
    orderedSubsequence(["deny", "deny", "deny", "error_streak", "controller_tick", "paused_by_controller"], "errorstreak: ordered deny-deny-deny-streak-tick-paused");
    forbidden(["block"], "errorstreak: no block (ask-operator path, not blocked)");
    break;
  }
  case "cost": {
    // AQ1: assert invariants, report counts.
    // D3 cap: nudge_sent must not exceed the cap (whatever the count).
    const nudgeSents = decisions.filter(a => a === "nudge_sent");
    const COST_MAX_NUDGES_PER_HOUR = process.env.COST_MAX_NUDGES_PER_HOUR ? parseInt(process.env.COST_MAX_NUDGES_PER_HOUR, 10) : 12;
    check2("cost: nudge_sent <= cap in force", nudgeSents.length <= COST_MAX_NUDGES_PER_HOUR);
    console.log(`  REPORT: cap in force: ${COST_MAX_NUDGES_PER_HOUR}`);

    // No nudge_sent after cost_cap_reached (vacuously true when no cap line).
    const capIdx = decisions.indexOf("cost_cap_reached");
    if (capIdx !== -1) {
      const nudgesAfterCap = decisions.slice(capIdx + 1).filter(a => a === "nudge_sent");
      check2("cost: no nudge_sent after cost_cap_reached", nudgesAfterCap.length === 0);
    } else {
      check2("cost: no nudge_sent after cost_cap_reached", true); // vacuously true
    }

    // D1 cadence: at least two cost_summary (deterministic).
    const costSummaries = details.filter(d => d.action === "cost_summary");
    check2("cost: at least two cost_summary", costSummaries.length >= 2);

    // AS1 (AR2 fix): No classify on a fully paused tree.
    // Find every paused_by_controller, then for each window (from that pause to the next activated or end of log),
    // check that no controller_tick with a classify verdict follows.
    const pausedIdxs = details.map((d, i) => d.action === "paused_by_controller" ? i : -1).filter(i => i !== -1);
    // The detail format is "plan-<id>: <verdict>: <reason>", so match with a regex.
    const classifyVerdictRe = /^[^:]+: (nudge|pause|ask-operator)\b/;
    let badTicksTotal = 0;
    for (const lastPausedIdx of pausedIdxs) {
      // Find the next activated after this pause, or end of log.
      let nextActivatedIdx = details.findIndex((d, i) => i > lastPausedIdx && d.action === "activated");
      if (nextActivatedIdx === -1) nextActivatedIdx = details.length;
      // Check for controller_tick lines with classify verdicts in between.
      const badTicks = details.slice(lastPausedIdx + 1, nextActivatedIdx).filter(d =>
        d.action === "controller_tick" &&
        classifyVerdictRe.test(d.detail || "")
      );
      badTicksTotal += badTicks.length;
    }
    check2("cost: no classify on fully paused tree", badTicksTotal === 0);

    // REPORT: nudge_sent, cost_cap_reached, unchanged-skipped, backed-off counts.
    const capReacheds = decisions.filter(a => a === "cost_cap_reached");
    const skippedTicks = details.filter(d => d.action === "controller_tick" && /unchanged, skipped/.test(d.detail || ""));
    const backedOffTicks = details.filter(d => d.action === "controller_tick" && /backed off/.test(d.detail || ""));
    console.log(`  REPORT: nudge_sent: ${nudgeSents.length}`);
    console.log(`  REPORT: cost_cap_reached: ${capReacheds.length}`);
    console.log(`  REPORT: D2 unchanged-skipped ticks: ${skippedTicks.length}`);
    console.log(`  REPORT: D4 backed-off ticks: ${backedOffTicks.length}`);
    break;
  }
  case "budget": {
    // D2: assert through the decision log: context_budget_crossed once per threshold,
    // context_budget_nudge once above close-out. Latch pin: drive the estimate up past
    // a threshold, hold it, assert the crossing logged exactly once.
    const crossings = decisions.filter(a => a === "context_budget_crossed");
    const nudges = decisions.filter(a => a === "context_budget_nudge");
    check2("budget: at least 3 crossings", crossings.length >= 3);
    check2("budget: exactly 1 closeout nudge", nudges.length === 1);
    
    // Check that each threshold was crossed exactly once (latch pin).
    const budgetDetails = details.filter(d => d.action === "context_budget_crossed");
    const infoCrossings = budgetDetails.filter(d => /info:/.test(d.detail)).length;
    const closeoutCrossings = budgetDetails.filter(d => /closeout:/.test(d.detail)).length;
    const criticalCrossings = budgetDetails.filter(d => /critical:/.test(d.detail)).length;
    check2("budget: info crossed exactly once", infoCrossings === 1);
    check2("budget: closeout crossed exactly once", closeoutCrossings === 1);
    check2("budget: critical crossed exactly once", criticalCrossings === 1);

    // AM7: cost_summary must reach the store (persist after push).
    const budgetCostSummaries = details.filter(d => d.action === "cost_summary");
    check2("budget: at least one cost_summary", budgetCostSummaries.length >= 1);

    break;
  }
  case "operator": {
    // Phase 1: message and reply (required)
    // operator_delivered then operator_answered in order.
    orderedSubsequence(["operator_delivered", "operator_answered"], "operator phase 1");

    // Phase 2: ask and answer (only when present)
    const askOpenedIdx = decisions.indexOf("ask_opened");
    const askAnsweredIdx = decisions.indexOf("ask_answered");
    const nudgeSentIdx = decisions.indexOf("nudge_sent");
    const costCapIdx = decisions.indexOf("cost_cap_reached");
    const askWaitingIdx = decisions.indexOf("ask_waiting");

    if (askOpenedIdx !== -1 || askAnsweredIdx !== -1) {
      check2("operator: nudge_sent found", nudgeSentIdx !== -1);
      check2("operator: cost_cap_reached found", costCapIdx !== -1);
      check2("operator: ask_opened found", askOpenedIdx !== -1);
      check2("operator: ask_waiting found", askWaitingIdx !== -1);
      check2("operator: ask_answered found", askAnsweredIdx !== -1);

      if (nudgeSentIdx !== -1 && costCapIdx !== -1 && askOpenedIdx !== -1 && askWaitingIdx !== -1) {
        check2("operator: nudge before cap before ask before waiting",
          nudgeSentIdx < costCapIdx && costCapIdx < askOpenedIdx && askOpenedIdx < askWaitingIdx);
      }

      if (askOpenedIdx !== -1 && askAnsweredIdx !== -1 && askAnsweredIdx > askOpenedIdx) {
        const activatedBetween = decisions.slice(askOpenedIdx + 1, askAnsweredIdx).filter(a => a === "activated").length;
        check2("operator: no activated between ask_opened and ask_answered", activatedBetween === 0);
      }

      const activatedAfterAsk = decisions.slice(askAnsweredIdx + 1).filter(a => a === "activated").length;
      if (askAnsweredIdx !== -1) {
        check2("operator: activated after ask_answered", activatedAfterAsk >= 1);
      }
    }

    // Phase 3: peer probe (only when peer_consumed is present)
    const peerConsumedIdxs = decisions.map((a, i) => a === "peer_consumed" ? i : -1).filter(i => i !== -1);
    if (peerConsumedIdxs.length > 0) {
      const peerDetails = details.filter(d => d.action === "peer_consumed");
      check2("operator: peer_consumed detail non-empty", peerDetails.every(d => (d.detail || "").length > 0));
      console.log(`  REPORT: peer_consumed count: ${peerConsumedIdxs.length}`);
    }

    // REPORT: counts
    const opDelivered = decisions.filter(a => a === "operator_delivered").length;
    const opAnswered = decisions.filter(a => a === "operator_answered").length;
    console.log(`  REPORT: operator_delivered: ${opDelivered}`);
    console.log(`  REPORT: operator_answered: ${opAnswered}`);
    console.log(`  REPORT: ask_opened: ${askOpenedIdx !== -1 ? 1 : 0}`);
    console.log(`  REPORT: peer_consumed: ${peerConsumedIdxs.length}`);
    break;
  }
  default:
    console.error(`FAIL: unknown test name: ${testName}`);
    process.exit(1);
}

function check2(name, cond) {
  if (cond) ok(name);
  else fail(name);
}

const summary = `\n${failed === 0 ? "All checks passed" : failed + " check(s) FAILED"} for ${testName}`;
_logBuf += summary + "\n";
try { fs.writeFileSync(assertLogPath, _logBuf); } catch {}
process.exit(failed === 0 ? 0 : 1);
