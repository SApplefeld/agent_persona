#!/usr/bin/env node
// Cost-ledger unit tests: FNV-1a hash, window arithmetic, cap check, backoff factor, estimate tokens.
// Usage: node cost-ledger-unit-test.mjs
// Exits 0 on success, 1 on failure.

const {
  fnv1aHash,
  effectiveWindowCount,
  isCapReached,
  backoffFactor,
  estimateTokens,
  bumpWindow,
} = await import("../hooks/cost-ledger.ts");

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name) { console.error(`  FAIL: ${name}`); failed++; }
function check(name, cond) { if (cond) ok(name); else fail(name); }

// --- FNV-1a hash ---
check("fnv1aHash: empty string", fnv1aHash("") === 2166136261);
check("fnv1aHash: deterministic", fnv1aHash("test") === fnv1aHash("test"));
check("fnv1aHash: different strings have different hashes", fnv1aHash("foo") !== fnv1aHash("bar"));
check("fnv1aHash: returns unsigned 32-bit", fnv1aHash("test") >= 0 && fnv1aHash("test") < 4294967296);

// --- Window arithmetic ---
// Fresh window (start = 0, count = 0)
check("effectiveWindowCount: fresh window returns 0",
  effectiveWindowCount({ start: 0, count: 0 }, 1000) === 0);

// Active window (start = 1000, count = 5, now = 3000000)
check("effectiveWindowCount: active window returns count",
  effectiveWindowCount({ start: 1000, count: 5 }, 3000000) === 5);

// Expired window (start = 1000, count = 5, now = 4000000)
check("effectiveWindowCount: expired window returns 0",
  effectiveWindowCount({ start: 1000, count: 5 }, 4000000) === 0);

// Exactly at the boundary (now - start = 3600000)
check("effectiveWindowCount: exactly at boundary returns 0",
  effectiveWindowCount({ start: 1000, count: 5 }, 3601000) === 0);

// Just before the boundary (now - start = 3599999)
check("effectiveWindowCount: just before boundary returns count",
  effectiveWindowCount({ start: 1000, count: 5 }, 3600999) === 5);

// --- Cap check ---
// Fresh window, count below cap
check("isCapReached: cap not reached",
  isCapReached({ start: 0, count: 2 }, 3, 1000) === false);

// Active window, count at cap
check("isCapReached: cap reached",
  isCapReached({ start: 1000, count: 3 }, 3, 2000) === true);

// Active window, count above cap
check("isCapReached: cap exceeded",
  isCapReached({ start: 1000, count: 5 }, 3, 2000) === true);

// Expired window, count was above cap but now reset
check("isCapReached: expired window resets count",
  isCapReached({ start: 1000, count: 5 }, 3, 4000000) === false);

// --- Backoff factor ---
// No skips: factor = 1
check("backoffFactor: no skips returns 1",
  backoffFactor(0, 10, 300000, 30000) === 1);

// 10 skips: factor = min(2^1, 10) = 2
check("backoffFactor: 10 skips returns 2",
  backoffFactor(10, 10, 300000, 30000) === 2);

// 20 skips: factor = min(2^2, 10) = 4
check("backoffFactor: 20 skips returns 4",
  backoffFactor(20, 10, 300000, 30000) === 4);

// 30 skips: factor = min(2^3, 10) = 8
check("backoffFactor: 30 skips returns 8",
  backoffFactor(30, 10, 300000, 30000) === 8);

// 40 skips: factor = min(2^4, 10) = 10 (capped)
check("backoffFactor: 40 skips capped at max",
  backoffFactor(40, 10, 300000, 30000) === 10);

// 50 skips: factor = min(2^5, 10) = 10 (capped)
check("backoffFactor: 50 skips capped at max",
  backoffFactor(50, 10, 300000, 30000) === 10);

// Different backoff threshold
check("backoffFactor: 5 skips with threshold 5 returns 2",
  backoffFactor(5, 5, 300000, 30000) === 2);

check("backoffFactor: 9 skips with threshold 10 returns 1",
  backoffFactor(9, 10, 300000, 30000) === 1);

// --- Estimate tokens ---
check("estimateTokens: basic calculation",
  estimateTokens(100, 30) === 55); // 100/4 = 25, + 30 = 55

check("estimateTokens: larger prompt",
  estimateTokens(1000, 80) === 330); // 1000/4 = 250, + 80 = 330

check("estimateTokens: zero prompt",
  estimateTokens(0, 50) === 50);

check("estimateTokens: zero maxTokens",
  estimateTokens(200, 0) === 50); // 200/4 = 50

check("estimateTokens: both zero",
  estimateTokens(0, 0) === 0);

// --- Bump window ---
// Fresh window (start = 0): set start to now, count = 1
check("bumpWindow: fresh window starts at now",
  JSON.stringify(bumpWindow({ start: 0, count: 0 }, 5000)) === JSON.stringify({ start: 5000, count: 1 }));

// Active window, within 1 hour: increment count
check("bumpWindow: active window increments count",
  JSON.stringify(bumpWindow({ start: 1000, count: 5 }, 3000000)) === JSON.stringify({ start: 1000, count: 6 }));

// Expired window (now - start >= 3600000): roll to new window
check("bumpWindow: expired window rolls",
  JSON.stringify(bumpWindow({ start: 1000, count: 5 }, 3601000)) === JSON.stringify({ start: 3601000, count: 1 }));

// Exactly at the boundary (now - start = 3600000): rolls
check("bumpWindow: exactly at boundary rolls",
  JSON.stringify(bumpWindow({ start: 1000, count: 5 }, 3601000)) === JSON.stringify({ start: 3601000, count: 1 }));

// Just before the boundary (now - start = 3599999): does not roll
check("bumpWindow: just before boundary increments",
  JSON.stringify(bumpWindow({ start: 1000, count: 5 }, 3600999)) === JSON.stringify({ start: 1000, count: 6 }));

// --- Summary ---
console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${failed} failures`);
process.exit(failed === 0 ? 0 : 1);
