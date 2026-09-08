#!/usr/bin/env node
// Commons unit tests: claim, re-claim (idempotent), read-union, liveness, release, first-claim-wins.
// Usage: node commons-unit-test.mjs
// Exits 0 on success, 1 on failure.

const {
  claimResource,
  releaseResource,
  readAllClaims,
  shouldYieldCommons,
  commonsWinner,
  commonsKey,
} = await import("../hooks/commons.ts");

// In-memory store mock
function createMockStore() {
  const data = new Map();
  return {
    get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    set(key, value) {
      data.set(key, value);
    },
    keys() {
      return Array.from(data.keys());
    },
    delete(key) {
      data.delete(key);
    },
    _data: data, // Expose for assertions
  };
}

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name) { console.error(`  FAIL: ${name}`); failed++; }
function check(name, cond) { if (cond) ok(name); else fail(name); }

// --- Test 1: Basic claim ---
{
  const store = createMockStore();
  const now = Date.now();
  claimResource(store, "persona:default", "session-A", now);
  
  const entry = store.get(commonsKey("session-A"));
  check("Test 1: claim creates entry", !!entry);
  check("Test 1: claim has resource", entry.claims.length === 1 && entry.claims[0].resource === "persona:default");
  check("Test 1: claimedAt is set", entry.claims[0].claimedAt === now);
}

// --- Test 2: Re-claim is idempotent (F5) ---
{
  const store = createMockStore();
  const t1 = 1000;
  const t2 = 2000;
  
  // A claims at t1
  claimResource(store, "persona:default", "session-A", t1);
  
  // A re-claims at t2 (should NOT update claimedAt)
  claimResource(store, "persona:default", "session-A", t2);
  
  const entry = store.get(commonsKey("session-A"));
  check("Test 2: re-claim does not change claimedAt (F5)", entry.claims[0].claimedAt === t1);
  check("Test 2: re-claim refreshes lastSeen", entry.lastSeen === t2);
}

// --- Test 3: First-claim-wins arbitration ---
{
  const store = createMockStore();
  const now = Date.now();
  const t1 = now - 1000;
  const t2 = now;
  
  // A claims first at t1
  claimResource(store, "persona:default", "session-A", t1);
  
  // B claims later at t2
  claimResource(store, "persona:default", "session-B", t2);
  
  const claims = readAllClaims(store, 90_000, now);
  const resourceClaims = claims.filter(c => c.resource === "persona:default");
  
  // A should hold (earlier claim)
  check("Test 3: A holds (earlier claim)", resourceClaims.find(c => c.holder === "session-A").claimedAt < resourceClaims.find(c => c.holder === "session-B").claimedAt);
  
  // B should yield to A
  check("Test 3: B yields to A", shouldYieldCommons(claims, "persona:default", "session-B"));
  
  // A should NOT yield
  check("Test 3: A does not yield", !shouldYieldCommons(claims, "persona:default", "session-A"));
  
  // Winner is A
  const winner = commonsWinner(claims, "persona:default");
  check("Test 3: winner is A", winner === "session-A");
}

// --- Test 4: Liveness (stale session skipped) ---
{
  const store = createMockStore();
  const now = Date.now();
  const stale = now - 100_000; // 100s old, exceeds 90s threshold
  
  // A claims (stale)
  claimResource(store, "persona:default", "session-A", stale);
  
  // B claims (fresh)
  claimResource(store, "persona:default", "session-B", now);
  
  // Use a "now" that is 100s after stale, so A is stale but B is fresh
  const readNow = now;
  const claims = readAllClaims(store, 90_000, readNow); // 90s threshold
  
  // A's claim should be skipped (stale)
  check("Test 4: stale session A skipped", !claims.some(c => c.holder === "session-A"));
  
  // B's claim should be present
  check("Test 4: fresh session B present", claims.some(c => c.holder === "session-B"));
  
  // B should hold (A is stale)
  const winner = commonsWinner(claims, "persona:default");
  check("Test 4: winner is B (A is stale)", winner === "session-B");
}

// --- Test 5: Release removes claim ---
{
  const store = createMockStore();
  const now = Date.now();
  
  // A claims
  claimResource(store, "persona:default", "session-A", now);
  
  // A releases
  releaseResource(store, "persona:default", "session-A", now);
  
  const entry = store.get(commonsKey("session-A"));
  check("Test 5: release removes claim", entry.claims.length === 0);
  
  const claims = readAllClaims(store);
  check("Test 5: no claims after release", !claims.some(c => c.holder === "session-A"));
}

// --- Test 6: Multiple resources ---
{
  const store = createMockStore();
  const now = Date.now();
  
  // A claims two resources
  claimResource(store, "persona:default", "session-A", now);
  claimResource(store, "file:docs/plans/common_v1.md", "session-A", now);
  
  const entry = store.get(commonsKey("session-A"));
  check("Test 6: multiple resources claimed", entry.claims.length === 2);
  
  const claims = readAllClaims(store);
  check("Test 6: both resources in union", claims.length === 2);
}

// --- Test 7: Tiebreaker (same claimedAt, lexicographically smaller sessionId wins) ---
{
  const store = createMockStore();
  const now = Date.now();
  
  // A and B claim at the same time
  claimResource(store, "persona:default", "session-A", now);
  claimResource(store, "persona:default", "session-B", now);
  
  const claims = readAllClaims(store, 90_000, now);
  
  // A should hold (lexicographically smaller)
  check("Test 7: A holds (tiebreaker)", !shouldYieldCommons(claims, "persona:default", "session-A"));
  check("Test 7: B yields to A (tiebreaker)", shouldYieldCommons(claims, "persona:default", "session-B"));
  
  const winner = commonsWinner(claims, "persona:default");
  check("Test 7: winner is A (tiebreaker)", winner === "session-A");
}

// --- Summary ---
console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
