// Commons: machine-global, cross-session coordination for agentic-plugin sessions.
// Substrate: $.store (per plugin, global across sessions, JSON values).
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

// --- Types ---

export interface CommonsClaim {
  resource: string;
  claimedAt: number; // ms timestamp
}

export interface CommonsEntry {
  sessionId: string;
  lastSeen: number; // ms timestamp, refreshed on every controller tick
  claims: CommonsClaim[];
}

export interface UnionedClaim extends CommonsClaim {
  holder: string; // sessionId
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
 * Claim a resource. Idempotent: re-claiming a resource you already hold does not
 * update claimedAt (first-claim-wins arbitration depends on the original claim time).
 * Only refreshes lastSeen.
 */
export function claimResource(
  store: { get(key: string): unknown; set(key: string, value: unknown): void },
  resource: string,
  mySessionId: string,
  now: number = Date.now(),
): void {
  const key = commonsKey(mySessionId);
  const raw = store.get(key);
  const existing: CommonsEntry = raw
    ? (raw as CommonsEntry)
    : { sessionId: mySessionId, lastSeen: now, claims: [] };

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

  // Write back (we own this key, no race)
  store.set(key, existing);
}

/**
 * Release a resource. Removes the claim from the array.
 */
export function releaseResource(
  store: { get(key: string): unknown; set(key: string, value: unknown): void },
  resource: string,
  mySessionId: string,
  now: number = Date.now(),
): void {
  const key = commonsKey(mySessionId);
  const raw = store.get(key);
  if (!raw) return;

  const existing: CommonsEntry = raw as CommonsEntry;

  // Remove the claim
  existing.claims = existing.claims.filter((c) => c.resource !== resource);

  // Refresh liveness
  existing.lastSeen = now;

  // Write back (we own this key, no race)
  store.set(key, existing);
}

/**
 * Read all claims from all sessions (union).
 * Filters out stale sessions (lastSeen older than stalenessThreshold).
 */
export function readAllClaims(
  store: { keys(): string[]; get(key: string): unknown },
  stalenessThresholdMs: number = DEFAULT_STALE_AFTER_MS,
  now: number = Date.now(),
): UnionedClaim[] {
  const keys = store.keys().filter((k) => k.startsWith(COMMONS_PREFIX));
  const claims: UnionedClaim[] = [];

  for (const key of keys) {
    const raw = store.get(key);
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
      competitor.holder < mySessionId
    ) {
      return true; // Tiebreaker: lexicographically smaller sessionId wins
    }
  }

  return false;
}

/**
 * Determine the winner (holder) of a resource among live claims.
 * Returns null if no live claim exists.
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
    return a.holder.localeCompare(b.holder);
  });

  return resourceClaims[0].holder;
}
