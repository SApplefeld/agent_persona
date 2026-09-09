#!/usr/bin/env node
// Cost migration test: verify that parseState fills in the cost ledger
// when it's absent from a v4 state.
// Usage: node cost-migration-test.mjs
// Exits 0 on success, 1 on failure.

import { readFileSync } from "fs";
import { parseState } from "../hooks/agent-state.ts";

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name) { console.error(`  FAIL: ${name}`); failed++; }
function check(name, cond) { if (cond) ok(name); else fail(name); }

// Load the fixture (v4 state without cost)
const fixture = readFileSync(new URL("./fixtures/state-v4-no-cost.json", import.meta.url), "utf8");

// Parse it
const state = parseState(fixture);

// Verify the cost field was filled
check("cost field exists", state.monitor.cost !== undefined && state.monitor.cost !== null);

if (state.monitor.cost) {
  const c = state.monitor.cost;
  check("classify exists", c.classify !== undefined);
  check("reason exists", c.reason !== undefined);
  check("selfReview exists", c.selfReview !== undefined);
  check("planner exists", c.planner !== undefined);
  check("nudge exists", c.nudge !== undefined);
  check("forkUsage exists", "forkUsage" in c);
  check("consecutiveSkips exists", c.consecutiveSkips !== undefined);
  check("nudgeWindow exists", c.nudgeWindow !== undefined);
  check("callWindow exists", c.callWindow !== undefined);

  check("classify.count is 0", c.classify.count === 0);
  check("classify.estTokens is 0", c.classify.estTokens === 0);
  check("nudge.count is 0", c.nudge.count === 0);
  check("forkUsage is null", c.forkUsage === null);
  check("consecutiveSkips is 0", c.consecutiveSkips === 0);
  check("nudgeWindow.start is 0", c.nudgeWindow.start === 0);
  check("nudgeWindow.count is 0", c.nudgeWindow.count === 0);
  check("callWindow.start is 0", c.callWindow.start === 0);
  check("callWindow.count is 0", c.callWindow.count === 0);
}

// --- Summary ---
console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${failed} failures`);
process.exit(failed === 0 ? 0 : 1);
