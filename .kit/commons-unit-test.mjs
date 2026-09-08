#!/usr/bin/env node
// Commons unit tests: claim, re-claim (idempotent), read-union, liveness, release, first-claim-wins.
// F7: Mock store is now async (matches the real $.store API).
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

// Async in-memory store mock (matches $.store shape)
function createMockStore() {
  const data = new Map();
  return {
    get: async (key) => data.has(key) ? data.get(key) : null,
    set: async (key, value) => { data.set(key, value); },
    keys: async () => Array.from(data.keys()),
    delete: async (key) => { data.delete(key); },
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
  await claimResource(store, "persona:default", "session-A", now);

  const entry = await store.get(commonsKey("session-A"));
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
  await claimResource(store, "persona:default", "session-A", t1);

  // A re-claims at t2 (should NOT update claimedAt)
  await claimResource(store, "persona:default", "session-A", t2);

  const entry = await store.get(commonsKey("session-A"));
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
  await claimResource(store, "persona:default", "session-A", t1);

  // B claims later at t2
  await claimResource(store, "persona:default", "session-B", t2);

  const claims = await readAllClaims(store, 90_000, now);
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
  await claimResource(store, "persona:default", "session-A", stale);

  // B claims (fresh)
  await claimResource(store, "persona:default", "session-B", now);

  // Use a "now" that is 100s after stale, so A is stale but B is fresh
  const readNow = now;
  const claims = await readAllClaims(store, 90_000, readNow); // 90s threshold

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
  await claimResource(store, "persona:default", "session-A", now);

  // A releases
  await releaseResource(store, "persona:default", "session-A", now);

  const entry = await store.get(commonsKey("session-A"));
  check("Test 5: release removes claim", entry.claims.length === 0);

  const claims = await readAllClaims(store);
  check("Test 5: no claims after release", !claims.some(c => c.holder === "session-A"));
}

// --- Test 6: Multiple resources ---
{
  const store = createMockStore();
  const now = Date.now();

  // A claims two resources
  await claimResource(store, "persona:default", "session-A", now);
  await claimResource(store, "file:docs/plans/common_v1.md", "session-A", now);

  const entry = await store.get(commonsKey("session-A"));
  check("Test 6: multiple resources claimed", entry.claims.length === 2);

  const claims = await readAllClaims(store);
  check("Test 6: both resources in union", claims.length === 2);
}

// --- Test 7: Tiebreaker (same claimedAt, lexicographically smaller sessionId wins) ---
{
  const store = createMockStore();
  const now = Date.now();

  // A and B claim at the same time
  await claimResource(store, "persona:default", "session-A", now);
  await claimResource(store, "persona:default", "session-B", now);

  const claims = await readAllClaims(store, 90_000, now);

  // A should hold (lexicographically smaller)
  check("Test 7: A holds (tiebreaker)", !shouldYieldCommons(claims, "persona:default", "session-A"));
  check("Test 7: B yields to A (tiebreaker)", shouldYieldCommons(claims, "persona:default", "session-B"));

  const winner = commonsWinner(claims, "persona:default");
  check("Test 7: winner is A (tiebreaker)", winner === "session-A");
}

// --- Test 8: F13 - claim, release, second claimant wins immediately ---
{
  const store = createMockStore();
  const t1 = 1000;
  const t2 = 2000;
  const t3 = 3000;

  // A claims first
  await claimResource(store, "persona:default", "session-A", t1);

  // B claims later (should yield to A)
  await claimResource(store, "persona:default", "session-B", t2);

  let claims = await readAllClaims(store, 90_000, t2 + 1);
  let winner = commonsWinner(claims, "persona:default");
  check("Test 8: A holds before release", winner === "session-A");

  // A releases (session A exits)
  await releaseResource(store, "persona:default", "session-A", t3);

  // B should now be the winner (A released)
  claims = await readAllClaims(store, 90_000, t3 + 1);
  winner = commonsWinner(claims, "persona:default");
  check("Test 8: B wins after A releases (F13)", winner === "session-B");
  check("Test 8: B does not yield after A releases", !shouldYieldCommons(claims, "persona:default", "session-B"));
}

// --- Test 9: F14 - GC stale entries ---
{
  const store = createMockStore();
  const now = Date.now();
  const stale = now - 100_000; // 100s old, exceeds 90s threshold

  // A claims (will become stale)
  await claimResource(store, "persona:default", "session-A", stale);

  // B claims (fresh)
  await claimResource(store, "persona:default", "session-B", now);

  // Read all claims (triggers GC)
  const claims = await readAllClaims(store, 90_000, now);

  // A's entry should be deleted by GC
  const entryA = await store.get(commonsKey("session-A"));
  check("Test 9: stale entry A deleted by GC (F14)", entryA === null);

  // B's entry should remain
  const entryB = await store.get(commonsKey("session-B"));
  check("Test 9: fresh entry B remains (F14)", entryB !== null);

  // Winner is B (A was stale and GC'd)
  const winner = commonsWinner(claims, "persona:default");
  check("Test 9: winner is B (A GC'd)", winner === "session-B");
}

// --- Summary ---
console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
