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
  readHolderMeta,
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

  // B should yield to A
  check("Test 3: B yields to A", shouldYieldCommons(claims, "persona:default", "session-B"));

  // A should NOT yield
  check("Test 3: A does not yield", !shouldYieldCommons(claims, "persona:default", "session-A"));

  // Winner is A
  const winner = commonsWinner(claims, "persona:default");
  check("Test 3: winner is A", winner === "session-A");
}

// --- Test 5: Release removes claim ---
{
  const store = createMockStore();
  const now = Date.now();

  // A claims
  await claimResource(store, "persona:default", "session-A", now);

  // A releases
  await releaseResource(store, "persona:default", "session-A", now);

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

  // A releases (session A exits)
  await releaseResource(store, "persona:default", "session-A", t3);

  // B should now be the winner (A released)
  const claims = await readAllClaims(store, 90_000, t3 + 1);
  const winner = commonsWinner(claims, "persona:default");
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

// --- Test 10: readHolderMeta reads the live holder's meta ---
{
  const store = createMockStore();
  const now = Date.now();

  // No entry claims the resource
  check("Test 10: no live holder returns null", await readHolderMeta(store, "persona:default", 90_000, now) === null);

  // A stale entry with a turn stamp is skipped, not read, and not gc'd
  await claimResource(store, "persona:default", "session-A", now - 100_000, { turnStartedAt: now - 200_000, workdir: "D:/a" });
  check("Test 10: stale holder is skipped", await readHolderMeta(store, "persona:default", 90_000, now) === null);
  check("Test 10: stale entry is not gc'd by the read", (await store.get(commonsKey("session-A"))) !== null);

  // An entry written by an older plugin lacks both meta fields
  store._data.set(commonsKey("session-B"), { sessionId: "session-B", lastSeen: now, claims: [{ resource: "persona:default", claimedAt: now }] });
  const metaB = await readHolderMeta(store, "persona:default", 90_000, now);
  check("Test 10: missing turnStartedAt normalizes to null", metaB?.holder === "session-B" && metaB.turnStartedAt === null);
  check("Test 10: missing workdir normalizes to \"\"", metaB?.workdir === "");

  // The live holder's stamp is read back
  await claimResource(store, "persona:default", "session-B", now, { turnStartedAt: now - 5_000, workdir: "D:/b" });
  const metaLive = await readHolderMeta(store, "persona:default", 90_000, now);
  check("Test 10: live holder's turnStartedAt and workdir are read", metaLive?.turnStartedAt === now - 5_000 && metaLive.workdir === "D:/b");
}

// --- Summary ---
console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
