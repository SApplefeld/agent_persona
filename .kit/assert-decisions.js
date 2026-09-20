#!/usr/bin/env node
// assert-decisions.js: ordered-subsequence checks over a persona store's decision log.
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

switch (testName) {
  case "goaltree": {
    // BL1: derive the plan count from the roadmap instead of hardcoding it
    const roadmapPath = path.join(__dirname, "roadmap-test.md");
    let planCount = 3; // default
    try {
      const roadmapText = fs.readFileSync(roadmapPath, "utf8");
      // Count numbered items (lines starting with "N.")
      const numberedItems = roadmapText.match(/^\d+\./gm) || [];
      planCount = numberedItems.length;
    } catch (e) {
      console.error(`  WARN: cannot read roadmap, defaulting to 3 plans: ${e.message}`);
    }
    
    // Build the expected sequence: create, planning_fired, planning_created, (activated, done)*planCount, planning_fired, root_complete
    const expected = ["create", "planning_fired", "planning_created"];
    for (let i = 0; i < planCount; i++) {
      expected.push("activated", "done");
    }
    expected.push("planning_fired", "root_complete");
    
    orderedSubsequence(
      expected,
      "goaltree"
    );
    
    // BM1: Restore nudge_sent pin - at least one nudge_sent between first activated and first done
    const activatedIdxs = details.map((d, i) => d.action === "activated" ? i : -1).filter(i => i !== -1);
    const doneIdxs = details.map((d, i) => d.action === "done" ? i : -1).filter(i => i !== -1);
    if (activatedIdxs.length > 0 && doneIdxs.length > 0) {
      const firstActivated = activatedIdxs[0];
      const firstDone = doneIdxs[0];
      // Find nudge_sent between first activated and first done
      const nudgesBetween = details.slice(firstActivated + 1, firstDone).filter(d => d.action === "nudge_sent");
      if (nudgesBetween.length >= 1) {
        ok("goaltree: nudge_sent present between first activated and first done");
      } else {
        fail("goaltree: nudge_sent missing between first activated and first done");
      }
    } else {
      // A goaltree run with no activation is red by definition
      fail("goaltree: nudge_sent check failed (no activated/done decisions found)");
    }
    
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
    break;
  }
  case "operator": {
    // Phase 1: the operator message reaches the owner and the reply comes back
    // (operator_turn_stamped precedes operator_answered).
    orderedSubsequence(["operator_turn_stamped", "operator_answered"], "operator phase 1");
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
