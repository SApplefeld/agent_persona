// Commons: machine-global, cross-session coordination for agentic-plugin sessions.
// Substrate: $.store (per plugin, global across sessions, async JSON values).
//
// Key layout: one writer per key. Each session owns `commons:<its-session-id>`.
// A reader enumerates keys(), filters to commons:*, reads every such key, and unions them.
//
// Arbitration: first-claim-wins (deterministic, total order by (claimedAt, sessionId)).
// Liveness: self-contained (lastSeen refreshed on every controller tick).
// Release: explicit (remove claim from array) + staleness backstop.
//
// Invariant: claimResource(R) is idempotent with respect to ownership -
// re-invoking it on a resource you hold never changes who holds R.
//
// F7 fix: all store calls are async (await). The store param is typed to the
// REAL $.store shape (async methods). No `as any` needed at call sites.

// --- Types ---

export interface CommonsClaim {
  resource: string;
  claimedAt: number; // ms timestamp
}

export interface CommonsEntry {
  sessionId: string;
  lastSeen: number; // ms timestamp, refreshed on every controller tick
  claims: CommonsClaim[];
  turnStartedAt?: number | null; // the session's clock at turn.start, null between turns
  workdir?: string; // the directory the session runs in, "" when unknown
}

// The per-turn fields a session publishes beside its claims, so a session in
// another working directory can read this one's turn state. Entries written
// by an older plugin lack both fields.
export interface CommonsMeta {
  turnStartedAt: number | null;
  workdir: string;
}

export interface UnionedClaim extends CommonsClaim {
  holder: string; // sessionId
}

/**
 * The REAL $.store shape (async). Matched to claude-code.d.ts:941-961.
 */
export interface CommonsStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

// --- Constants ---

const COMMONS_PREFIX = "commons:";
const DEFAULT_STALE_AFTER_MS = 90_000; // 90s, aligned with the plugin's heartbeat model

// --- Core primitives ---

/**
 * Get the key for a session's commons entry.
 */
export function commonsKey(sessionId: string): string {
  return `${COMMONS_PREFIX}${sessionId}`;
}

/**
 * F6: Single-source holder comparison. Both shouldYieldCommons and commonsWinner
 * must use the same comparator to avoid divergence (deadlock or double-hold).
 * Uses UTF-16 code-unit order (JS `<`), which is deterministic and locale-independent.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareHolders(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Claim a resource. Idempotent: re-claiming a resource you already hold does not
 * update claimedAt (first-claim-wins arbitration depends on the original claim time).
 * Only refreshes lastSeen. With meta, also writes the entry's turn state and
 * workdir; without it, whatever the entry already carries is kept.
 */
export async function claimResource(
  store: CommonsStore,
  resource: string,
  mySessionId: string,
  now: number = Date.now(),
  meta?: CommonsMeta,
): Promise<void> {
  const key = commonsKey(mySessionId);
  const raw = await store.get(key);
  const existing: CommonsEntry = raw
    ? (raw as CommonsEntry)
    : { sessionId: mySessionId, lastSeen: now, claims: [], turnStartedAt: null, workdir: "" };

  // Check if we already hold this resource
  const existingClaim = existing.claims.find((c) => c.resource === resource);
  if (!existingClaim) {
    // New claim
    existing.claims.push({ resource, claimedAt: now });
  }
  // Re-claim: no-op for arbitration. claimedAt stays the original claim time.
  // Liveness is already refreshed by the lastSeen update below.

  // Refresh liveness
  existing.lastSeen = now;
  if (meta) {
    existing.turnStartedAt = meta.turnStartedAt;
    existing.workdir = meta.workdir;
  }

  // Write back (we own this key, no race)
  await store.set(key, existing);
}

/**
 * Release a resource. Removes the claim from the array. With meta, also writes
 * the entry's turn state and workdir; without it, the entry's own are kept.
 */
export async function releaseResource(
  store: CommonsStore,
  resource: string,
  mySessionId: string,
  now: number = Date.now(),
  meta?: CommonsMeta,
): Promise<void> {
  const key = commonsKey(mySessionId);
  const raw = await store.get(key);
  if (!raw) return;

  const existing: CommonsEntry = raw as CommonsEntry;

  // Remove the claim
  existing.claims = existing.claims.filter((c) => c.resource !== resource);

  // Refresh liveness
  existing.lastSeen = now;
  if (meta) {
    existing.turnStartedAt = meta.turnStartedAt;
    existing.workdir = meta.workdir;
  }

  // Write back (we own this key, no race)
  await store.set(key, existing);
}

/**
 * Stamp the session's turn state and workdir onto its own entry, leaving its
 * claims as they are. Creates the entry with no claims when absent.
 */
export async function stampCommonsMeta(
  store: CommonsStore,
  mySessionId: string,
  meta: CommonsMeta,
  now: number = Date.now(),
): Promise<void> {
  const key = commonsKey(mySessionId);
  const raw = await store.get(key);
  const existing: CommonsEntry = raw
    ? (raw as CommonsEntry)
    : { sessionId: mySessionId, lastSeen: now, claims: [], turnStartedAt: null, workdir: "" };

  existing.turnStartedAt = meta.turnStartedAt;
  existing.workdir = meta.workdir;

  // Refresh liveness
  existing.lastSeen = now;

  // Write back. One process writes this key, but claimResource, releaseResource
  // and this stamp each read-modify-write it across an await, ordered by the
  // event loop rather than by a lock.
  await store.set(key, existing);
}

/**
 * F14: garbage-collect stale commons entries (lastSeen older than
 * stalenessThreshold). Called opportunistically on read.
 */
export async function gcStaleClaims(
  store: CommonsStore,
  stalenessThresholdMs: number = DEFAULT_STALE_AFTER_MS,
  now: number = Date.now(),
): Promise<void> {
  const allKeys = await store.keys();
  const keys = allKeys.filter((k) => k.startsWith(COMMONS_PREFIX));
  for (const key of keys) {
    const raw = await store.get(key);
    if (!raw) continue;
    const entry: CommonsEntry = raw as CommonsEntry;
    if (now - entry.lastSeen > stalenessThresholdMs) {
      await store.delete(key);
    }
  }
}

/**
 * Read all claims from all sessions (union).
 * Filters out stale sessions (lastSeen older than stalenessThreshold).
 * F14: also garbage-collects stale entries on read.
 */
export async function readAllClaims(
  store: CommonsStore,
  stalenessThresholdMs: number = DEFAULT_STALE_AFTER_MS,
  now: number = Date.now(),
): Promise<UnionedClaim[]> {
  // F14: opportunistic GC of stale entries
  try {
    await gcStaleClaims(store, stalenessThresholdMs, now);
  } catch { /* non-fatal */ }

  const allKeys = await store.keys();
  const keys = allKeys.filter((k) => k.startsWith(COMMONS_PREFIX));
  const claims: UnionedClaim[] = [];

  for (const key of keys) {
    const raw = await store.get(key);
    if (!raw) continue;

    const entry: CommonsEntry = raw as CommonsEntry;

    // Check liveness
    const lastSeen = entry.lastSeen;
    if (now - lastSeen > stalenessThresholdMs) {
      // Abandoned: skip
      continue;
    }

    // Union this session's claims
    for (const claim of entry.claims) {
      claims.push({
        resource: claim.resource,
        claimedAt: claim.claimedAt,
        holder: entry.sessionId,
      });
    }
  }

  return claims;
}

/**
 * Yield check: does any live competitor have an earlier claim on the same resource?
 * First-claim-wins: a session holds resource R if and only if no LIVE competitor
 * has an earlier claim on R, ordered by (claimedAt, then sessionId as tiebreaker).
 * Pure function over already-read claims - stays sync.
 */
export function shouldYieldCommons(
  claims: UnionedClaim[],
  resource: string,
  mySessionId: string,
): boolean {
  const myClaim = claims.find((c) => c.resource === resource && c.holder === mySessionId);
  if (!myClaim) return false; // Not a holder

  // Check if any live competitor has an earlier claim
  const competitors = claims.filter(
    (c) => c.resource === resource && c.holder !== mySessionId,
  );
  for (const competitor of competitors) {
    if (competitor.claimedAt < myClaim.claimedAt) {
      return true; // Yield to the earlier claim
    }
    if (
      competitor.claimedAt === myClaim.claimedAt &&
      compareHolders(competitor.holder, mySessionId) < 0
    ) {
      return true; // Tiebreaker: lexicographically smaller sessionId wins
    }
  }

  return false;
}

/**
 * Determine the winner (holder) of a resource among live claims.
 * Returns null if no live claim exists.
 * Pure function over already-read claims - stays sync.
 */
export function commonsWinner(
  claims: UnionedClaim[],
  resource: string,
): string | null {
  const resourceClaims = claims.filter((c) => c.resource === resource);
  if (resourceClaims.length === 0) return null;

  // Sort by (claimedAt, holder) - the winner is the first in this order
  resourceClaims.sort((a, b) => {
    if (a.claimedAt !== b.claimedAt) {
      return a.claimedAt - b.claimedAt;
    }
    return compareHolders(a.holder, b.holder);
  });

  return resourceClaims[0].holder;
}
