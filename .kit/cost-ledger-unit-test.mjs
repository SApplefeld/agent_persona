#!/usr/bin/env node
// Cost-ledger unit tests: FNV-1a hash, window arithmetic, backoff factor, estimate tokens.
// Usage: node cost-ledger-unit-test.mjs
// Exits 0 on success, 1 on failure.

const {
  fnv1aHash,
  effectiveWindowCount,
  backoffFactor,
  shouldRunClassify,
  estimateTokens,
  bumpWindow,
} = await import("../hooks/cost-ledger.ts");

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name) { console.error(`  FAIL: ${name}`); failed++; }
function check(name, cond) { if (cond) ok(name); else fail(name); }

// --- FNV-1a hash ---
check("fnv1aHash: different strings have different hashes", fnv1aHash("foo") !== fnv1aHash("bar"));

// --- Window arithmetic ---
// Fresh window (start = 0, count = 0)
check("effectiveWindowCount: fresh window returns 0",
  effectiveWindowCount({ start: 0, count: 0 }, 1000) === 0);

// Exactly at the boundary (now - start = 3600000)
check("effectiveWindowCount: exactly at boundary returns 0",
  effectiveWindowCount({ start: 1000, count: 5 }, 3601000) === 0);

// Just before the boundary (now - start = 3599999)
check("effectiveWindowCount: just before boundary returns count",
  effectiveWindowCount({ start: 1000, count: 5 }, 3600999) === 5);

// --- Backoff factor ---
// No skips: factor = 1
check("backoffFactor: no skips returns 1",
  backoffFactor(0, 10, 300000, 30000) === 1);

// 10 skips: factor = min(2^1, 10) = 2
check("backoffFactor: 10 skips returns 2",
  backoffFactor(10, 10, 300000, 30000) === 2);

// 40 skips: factor = min(2^4, 10) = 10 (capped)
check("backoffFactor: 40 skips capped at max",
  backoffFactor(40, 10, 300000, 30000) === 10);

check("backoffFactor: 9 skips with threshold 10 returns 1",
  backoffFactor(9, 10, 300000, 30000) === 1);

// --- shouldRunClassify (D4 backoff gate) ---
// No skips: factor 1, so tickIndex % 1 === 0 always true
check("shouldRunClassify: no skips, tick 1 runs",
  shouldRunClassify(1, 0, 10, 300000, 30000) === true);

// 10 skips: factor 2, so even ticks run, odd ticks don't
check("shouldRunClassify: 10 skips, tick 1 does NOT run",
  shouldRunClassify(1, 10, 10, 300000, 30000) === false);

check("shouldRunClassify: 10 skips, tick 2 runs",
  shouldRunClassify(2, 10, 10, 300000, 30000) === true);

// 40 skips: factor 10 (capped), so ticks 1-9 don't run, tick 10 runs
check("shouldRunClassify: 40 skips, tick 9 does NOT run",
  shouldRunClassify(9, 40, 10, 300000, 30000) === false);

check("shouldRunClassify: 40 skips, tick 10 runs",
  shouldRunClassify(10, 40, 10, 300000, 30000) === true);

// --- Estimate tokens ---
check("estimateTokens: basic calculation",
  estimateTokens(100, 30) === 55); // 100/4 = 25, + 30 = 55

// --- Bump window ---
// Fresh window (start = 0): set start to now, count = 1
check("bumpWindow: fresh window starts at now",
  JSON.stringify(bumpWindow({ start: 0, count: 0 }, 5000)) === JSON.stringify({ start: 5000, count: 1 }));

// Expired window (now - start >= 3600000): roll to new window
check("bumpWindow: expired window rolls",
  JSON.stringify(bumpWindow({ start: 1000, count: 5 }, 3601000)) === JSON.stringify({ start: 3601000, count: 1 }));

// Just before the boundary (now - start = 3599999): does not roll
check("bumpWindow: just before boundary increments",
  JSON.stringify(bumpWindow({ start: 1000, count: 5 }, 3600999)) === JSON.stringify({ start: 1000, count: 6 }));

// --- Summary ---
console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${failed} failures`);
process.exit(failed === 0 ? 0 : 1);
