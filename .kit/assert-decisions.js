#!/usr/bin/env node
// M12: assert-decisions.js, ordered-subsequence + forbidden-list checks.
// Usage: node assert-decisions.js <test-name> <store-path> <assert-log-path>
// Exits 0 on success, 1 on failure. Captures stdout+stderr to the assert log.

const fs = require("fs");
const path = require("path");

const testName = process.argv[2];
const storePath = process.argv[3];
const assertLogPath = process.argv[4];
// Optional 5th arg: global commons store path (for ask record lookups).
// If omitted, falls back to storePath.
const globalStorePath = process.argv[5] || storePath;
// Optional 6th arg: reader session id (for BG2 record id validation).
const readerSid = process.argv[6] || null;

if (!testName || !storePath || !assertLogPath) {
  process.stderr.write("Usage: node assert-decisions.js <test-name> <store-path> <assert-log-path> [global-store-path] [reader-sid]\n");
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
    
    // BM1: Check planner variance - read the decision (not just the count)
    const planningCreated = details.filter(d => d.action === "planning_created");
    if (planningCreated.length > 0) {
      const lastPlanningCreated = planningCreated[planningCreated.length - 1];
      const planCountMatch = (lastPlanningCreated.detail || "").match(/(\d+) plans?/);
      if (planCountMatch) {
        const actualPlanCount = parseInt(planCountMatch[1], 10);
        // BM2: Read the planner_variance decision (the plugin's own statement)
        const varianceDecision = details.find(d => d.action === "planner_variance");
        if (actualPlanCount !== planCount) {
          if (varianceDecision) {
            // The plugin flagged it
            ok("goaltree: planner_variance decision present");
          } else {
            // The plugin did NOT flag it - this is a defect
            fail("goaltree: planner_variance: planner created " + actualPlanCount + " plans, roadmap has " + planCount + " items (no decision logged)");
          }
        } else {
          ok("goaltree: planner created exactly the roadmap's plan count");
        }
      }
    }
    
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
      // If there's no activated or done, the nudge_sent check is vacuously true
      ok("goaltree: nudge_sent check skipped (no activated/done)");
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
    // BJ3: Two-phase test. Phase 1 (refusal): B's identity call does NOT result in
    // identity_set (A is live, B stays a reader). Phase 2 (takeover): after A goes
    // stale, B's identity call results in identity_set (B becomes owner).
    // The final store should show identity_set (from phase 2), but the phase 1
    // decisions should not. The yield log should not exist (design is refusal, not yield).
    // Check that identity_set is present in the final store (from phase 2).
    check2("yield: identity_set present (phase 2 takeover)", decisions.includes("identity_set"));
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
    // BJ2: ordered deny, deny, deny, error_streak, ask_opened, paused_by_controller, ask_waiting.
    // The error streak branch opens an ask (ask_opened), not a controller_tick.
    // ask_waiting confirms the ask holds (present at 03:00:27 in the 20260911T025912Z run).
    orderedSubsequence(["deny", "deny", "deny", "error_streak", "ask_opened", "paused_by_controller", "ask_waiting"], "errorstreak: ordered deny-deny-deny-streak-ask-paused-waiting");
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
    // Phase 1: message and reply (BE10: operator_turn_stamped precedes operator_answered)
    orderedSubsequence(["operator_turn_stamped", "operator_answered"], "operator phase 1");

    // BD4/BE9: Phase 2 asserts the ask lifecycle, keyed on the ask id from ask_answered detail.
    // ask_opened, then at least one ask_waiting, then ask_answered, then activated.
    // No activated between ask_opened and ask_answered.
    // The nudge_sent and cost_cap_reached checks are removed (the cost suite pins the cap path).
    const askOpenedIdx = decisions.indexOf("ask_opened");
    const askAnsweredIdx = decisions.indexOf("ask_answered");
    const askWaitingIdx = decisions.indexOf("ask_waiting");

    check2("operator: ask_opened found", askOpenedIdx !== -1);
    check2("operator: ask_waiting found", askWaitingIdx !== -1);
    check2("operator: ask_answered found", askAnsweredIdx !== -1);

    // Ordered: ask_opened before ask_waiting before ask_answered
    if (askOpenedIdx !== -1 && askWaitingIdx !== -1 && askAnsweredIdx !== -1) {
      check2("operator: ask_opened before ask_waiting before ask_answered",
        askOpenedIdx < askWaitingIdx && askWaitingIdx < askAnsweredIdx);
    }

    // No activated between ask_opened and ask_answered EXCEPT the reactivation
    // that IS the answer processing (detail mentions the ask id).
    if (askOpenedIdx !== -1 && askAnsweredIdx !== -1 && askAnsweredIdx > askOpenedIdx) {
      const between = details.slice(askOpenedIdx + 1, askAnsweredIdx);
      const unexpectedActivations = between.filter(d =>
        d.action === "activated" && !(d.detail || "").includes("answer to ask")
      ).length;
      check2("operator: no unexpected activated between ask_opened and ask_answered",
        unexpectedActivations === 0);
    }

    // The reactivation (activated) for the ask answer may appear before OR after
    // ask_answered in the decisions array (engine order: activated then ask_answered).
    // Verify at least one activated decision exists near the ask lifecycle.
    if (askAnsweredIdx !== -1) {
      const windowStart = Math.max(0, askAnsweredIdx - 3);
      const windowEnd = Math.min(decisions.length, askAnsweredIdx + 3);
      const nearActivation = details.slice(windowStart, windowEnd).some(d =>
        d.action === "activated" && (d.detail || "").includes("answer to ask")
      );
      check2("operator: ask answer triggered reactivation", nearActivation);
    }

    // BE9: key on ask id from ask_answered detail, not indexOf over all asks
    // BG2: extract ask id and record id from detail using regex
    // Detail format (hooks/index.ts:1004): "ask <ask-id> closed by record <record-id>"
    // Ask id format: default-<sid>-<n> (e.g., default-abc123-1)
    // Record id format: reply:default:default-<reader-sid>-<n> (e.g., reply:default:default-def456-1)
    const askAnsweredDetail = details.find(d => d.action === "ask_answered");
    let askId = null;
    let recordId = null;
    if (askAnsweredDetail && askAnsweredDetail.detail) {
      const match = askAnsweredDetail.detail.match(/^ask (\S+) closed by record (\S+)$/);
      if (match && match[1] && match[2]) {
        askId = match[1];
        recordId = match[2];
      }
    }
    
    // BG2: require record id to start with default-<reader session id>-
    // The reader session id is passed as the 6th arg (readerSid variable)
    if (askId && recordId) {
      // BH3: FAIL if readerSid is missing or empty
      if (!readerSid) {
        check2("operator: readerSid is missing or empty; cannot validate record id prefix", false);
      } else {
        // BG2: validate record id format
        const expectedPrefix = `default-${readerSid}-`;
        const recordPrefix = recordId.split(":").pop() || "";
        check2("operator: record id starts with default-<reader-sid>-", recordPrefix.startsWith(expectedPrefix));
      }
      
      const gstore = JSON.parse(fs.readFileSync(globalStorePath, "utf8"));
      const askKey = Object.keys(gstore).find(k => k.startsWith("ask:default:") && gstore[k].id === askId);
      if (askKey) {
        check2("operator: ask record (by id) answered", gstore[askKey].status === "answered");
      } else {
        // BG2: FAIL if ask id not found (no fallback)
        check2(`operator: ask record not found for ask id ${askId}`, false);
      }
    } else {
      // BG2: FAIL if ask id or record id cannot be parsed (no fallback)
      const detailStr = askAnsweredDetail ? (askAnsweredDetail.detail || "null") : "no ask_answered detail";
      check2(`operator: cannot parse ask id from detail: ${detailStr}`, false);
    }

    // REPORT: which path opened the ask (from ask_opened detail)
    const askOpenedDetail = details.find(d => d.action === "ask_opened");
    console.log(`  REPORT: ask opened by: ${askOpenedDetail ? (askOpenedDetail.detail || "unknown") : "unknown"}`);

    // Phase 3: peer probe (only when peer_consumed is present)
    const peerConsumedIdxs = decisions.map((a, i) => a === "peer_consumed" ? i : -1).filter(i => i !== -1);
    if (peerConsumedIdxs.length > 0) {
      const peerDetails = details.filter(d => d.action === "peer_consumed");
      check2("operator: peer_consumed detail non-empty", peerDetails.every(d => (d.detail || "").length > 0));
      console.log(`  REPORT: peer_consumed count: ${peerConsumedIdxs.length}`);
    }

    // REPORT: counts (BE10: operator_turn_stamped instead of operator_delivered)
    const opStamped = decisions.filter(a => a === "operator_turn_stamped").length;
    const opAnswered = decisions.filter(a => a === "operator_answered").length;
    const askWaitingCount = decisions.filter(a => a === "ask_waiting").length;
    console.log(`  REPORT: operator_turn_stamped: ${opStamped}`);
    console.log(`  REPORT: operator_answered: ${opAnswered}`);
    console.log(`  REPORT: ask_waiting: ${askWaitingCount}`);
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
