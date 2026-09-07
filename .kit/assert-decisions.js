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
    // C6: first probe at first tick (~30s) sees dirty 0; dirty 1 at ~150s; dirty 0 at ~270s.
    const envGitLines = details.filter(d => d.action === "env_git" || d.action === "env_git_null" || d.action === "env_git_error");
    check2("env_git first sample found", envGitLines.some(d => d.detail.includes("dirty 0")));
    check2("env_git dirty 1 found", envGitLines.some(d => d.detail.includes("dirty 1")));
    check2("env_git dirty 0 after dirty 1", envGitLines.some(d => d.detail.includes("dirty 0") && d.timestamp > envGitLines.find(d => d.detail.includes("dirty 1"))?.timestamp));
    break;
  }
  case "health": {
    // C5: health run at completeLeaf site.
    const healthLines = details.filter(d => d.action === "health_green" || d.action === "health_red");
    check2("health run found", healthLines.length > 0);
    check2("health_red found (fail flag set)", healthLines.some(d => d.action === "health_red"));
    break;
  }
  case "errorstreak": {
    // C5: error streak after 3 consecutive error turns.
    const streakLines = details.filter(d => d.action === "error_streak");
    check2("error_streak found", streakLines.length > 0);
    check2("error_streak after 3 turns", streakLines.some(d => d.detail.includes("3 turns")));
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
