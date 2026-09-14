#!/usr/bin/env node
// Cost migration test: verify that parseState fills in the cost ledger
// when it's absent from a v4 state, and fills in lastSummaryHash and
// capNoticeWindowStart when they're missing from a v4 state that has cost.
// Usage: node cost-migration-test.mjs
// Exits 0 on success, 1 on failure.

import { readFileSync } from "fs";
import { parseState } from "../hooks/agent-state.ts";

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name) { console.error(`  FAIL: ${name}`); failed++; }
function check(name, cond) { if (cond) ok(name); else fail(name); }

// --- Fixture 1: v4 state without cost ---
console.log("\nFixture: state-v4-no-cost.json (cost absent)");
const fixture1 = readFileSync(new URL("./fixtures/state-v4-no-cost.json", import.meta.url), "utf8");
const state1 = parseState(fixture1);

check("cost field exists", state1.monitor.cost !== undefined && state1.monitor.cost !== null);

if (state1.monitor.cost) {
  const c = state1.monitor.cost;
  check("classify.count is 0", c.classify.count === 0);
  check("classify.estTokens is 0", c.classify.estTokens === 0);
  check("reason exists", c.reason !== undefined);
  check("selfReview exists", c.selfReview !== undefined);
  check("planner exists", c.planner !== undefined);
  check("nudge.count is 0", c.nudge.count === 0);
  check("forkUsage is null", c.forkUsage === null);
  check("consecutiveSkips is 0", c.consecutiveSkips === 0);
  check("nudgeWindow.start is 0", c.nudgeWindow.start === 0);
  check("nudgeWindow.count is 0", c.nudgeWindow.count === 0);
  check("callWindow.start is 0", c.callWindow.start === 0);
  check("callWindow.count is 0", c.callWindow.count === 0);
  check("lastSummaryHash is 0", c.lastSummaryHash === 0);
  check("capNoticeWindowStart is 0", c.capNoticeWindowStart === 0);
}

// --- Fixture 2: v4 state with cost but missing lastSummaryHash and capNoticeWindowStart ---
console.log("\nFixture: state-v4-cost-no-hash.json (cost present, hash fields absent)");
const fixture2 = readFileSync(new URL("./fixtures/state-v4-cost-no-hash.json", import.meta.url), "utf8");
const state2 = parseState(fixture2);

check("cost field exists", state2.monitor.cost !== undefined && state2.monitor.cost !== null);

if (state2.monitor.cost) {
  const c2 = state2.monitor.cost;
  check("lastSummaryHash filled to 0", c2.lastSummaryHash === 0);
  check("capNoticeWindowStart filled to 0", c2.capNoticeWindowStart === 0);
  // Verify existing fields are preserved
  check("classify.count preserved (0)", c2.classify.count === 0);
  check("nudgeWindow preserved", c2.nudgeWindow !== undefined);
}

// --- Summary ---
console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${failed} failures`);
process.exit(failed === 0 ? 0 : 1);
