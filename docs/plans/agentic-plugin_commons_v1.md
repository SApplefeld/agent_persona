# Agentic Plugin: Commons (Shared Claims & Coordination)

**Status**: Proposed
**Created**: 2026-09-08T08:26:00Z
**Author**: DeepSeekHarness
**Reviewer**: Fable

## 1. Purpose

Commons provides machine-global, cross-session coordination for agentic-plugin sessions. It lets two or more sessions avoid colliding on the same resource (persona, file, goal, or arbitrary named resource) using the existing epoch-and-yield primitive.

**MVP**: the smallest shared mechanism that lets two sessions not collide on the same resource.

## 2. Substrate

**`$.store`** (the platform's key-value store, scoped to this plugin, machine-global).

- Scope: per plugin, global across sessions (confirmed from `claude-code.d.ts:934-940`)
- Persistence: kept between sessions and hot reloads
- Location: `~/.claude/plugins/store/<plugin-name>.json`
- API: `get`/`set`/`delete`/`keys` (JSON values)
- **No CAS**: no compare-and-swap, so single-key multi-writer designs lose updates

## 3. Design

### 3.1 Key layout: one writer per key

Each session owns its own key: `commons:<its-session-id>`.

- A session NEVER writes another session's key.
- A reader enumerates `$.store.keys()`, filters to `commons:*`, reads every such key, and unions them into the logical shared document.
- This mirrors the kit registry's one-file-per-session design, applied to `$.store`. No CAS needed, no lost updates.

### 3.2 Value shape (per session key)

```json
{
  "sessionId": "abc-123",
  "lastSeen": "2026-09-08T08:00:00Z",
  "claims": [
    {
      "resource": "persona:default",
      "claimedAt": "2026-09-08T08:00:00Z"
    },
    {
      "resource": "file:docs/plans/common_v1.md",
      "claimedAt": "2026-09-08T08:01:00Z"
    }
  ]
}
```

- `sessionId`: the session that owns this key (self-identifying)
- `lastSeen`: refreshed by the holding session on every controller tick; if older than the staleness threshold, the session's claims are considered abandoned
- `claims`: array of resource claims, each with:
  - `resource`: the resource being claimed (e.g. `persona:default`, `file:path/to/file`, `goal:goal-id`)
  - `claimedAt`: timestamp of the claim (used for first-claim-wins arbitration)

### 3.3 Liveness: self-contained, no registry read

Each session refreshes its own `lastSeen` on every controller tick (`$.clock.every(tickMs)`).

- A reader checks `lastSeen` against a staleness threshold (proposed: `staleAfterMs` from the plugin's config, default 90s, or a small multiple of the tick).
- If `lastSeen` is stale, the session's claims are considered abandoned and re-claimable.
- **No registry read**: the plugin's `$.fs` is sandboxed to the working directory and cannot reach `~/.claude/coordinator/`. Liveness is entirely within `$.store`.

### 3.4 Arbitration: first-claim-wins (deterministic)

**Not epoch-based.** The epoch primitive works for single-persona ownership because there is ONE shared cell per persona. With per-session keys, there is no shared cell to compare against, so epoch comparison provides NO mutual exclusion.

Instead, deterministic first-claim-wins:

- A session holds resource R if and only if no LIVE competitor has an earlier claim on R.
- Ordering: `(claimedAt, then sessionId as tiebreaker)`.
- `shouldYieldCommons(R)` = "does any live competitor have an earlier `claimedAt` on R, or the same `claimedAt` and a lexicographically smaller sessionId?"
- This is deterministic, total (no ties), works with per-session keys, and gives real mutual exclusion: exactly one session wins R.

The `epoch` field is dropped from the claim shape (it no longer earns a job in this model).

### 3.5 Resource-path screening (stranger-supplied data)

Every resource path in a claim is stranger-supplied data. The same peer-sessions screen applies:

1. **Network-shaped path refusal**: two leading separators, UNC and `//server` forms are refused outright.
2. **Normalization**: every other path is normalized before matching.
3. **Parent-directory refusal**: a path still carrying a `..` segment after normalization is refused.
4. **Unplaceable = report unread**: a path that cannot be placed within a known repo is reported unread, not opened.

The screen is a property of the commons channel, not of whichever reader first needed it.

### 3.6 Release semantics

- **Explicit release**: a session that finishes with a resource removes its claim from the `claims` array and writes its own key (no race, one writer per key).
- **Staleness backstop**: if a session crashes without releasing, its `lastSeen` goes stale and the claims become re-claimable by other sessions.
- Release is load-bearing for clean handoff (the yield scenario); staleness is only the backstop for a crashed session.

## 4. API surface (proposed)

### 4.1 Write (claim a resource)

```typescript
// Pseudocode for the commons write path
function claimResource(resource: string, mySessionId: string) {
    const key = `commons:${mySessionId}`;
    const existing = $.store.get(key) || { sessionId: mySessionId, lastSeen: now(), claims: [] };
    
    // Check if we already hold this resource
    const existingClaim = existing.claims.find(c => c.resource === resource);
    if (!existingClaim) {
        // New claim
        existing.claims.push({ resource, claimedAt: now() });
    }
    // Re-claim: no-op for arbitration. `claimedAt` stays the original claim time.
    // Liveness is already refreshed by the lastSeen update below.
    
    // Refresh liveness
    existing.lastSeen = now();
    
    // Write back (we own this key, no race)
    $.store.set(key, existing);
}
```

**Invariant**: `claimResource(R)` is idempotent with respect to ownership - re-invoking it on a resource you hold never changes who holds R. Re-claim does NOT update `claimedAt`; it only refreshes `lastSeen`.

### 4.2 Read (union all claims)

```typescript
// Pseudocode for the commons read path
function readAllClaims() {
    const keys = $.store.keys().filter(k => k.startsWith('commons:'));
    const claims = [];
    const stalenessThreshold = getStaleAfterMs(); // From plugin config, default 90s
    const now = Date.now();
    
    for (const key of keys) {
        const entry = $.store.get(key);
        if (!entry) continue;
        
        // Check liveness
        const lastSeen = new Date(entry.lastSeen).getTime();
        if (now - lastSeen > stalenessThreshold) {
            // Abandoned: skip
            continue;
        }
        
        // Union this session's claims
        for (const claim of entry.claims) {
            claims.push({
                ...claim,
                holder: entry.sessionId,
            });
        }
    }
    
    return claims;
}
```

### 4.3 Yield check (first-claim-wins)

```typescript
// Pseudocode for the yield check (first-claim-wins arbitration)
function shouldYieldCommons(resource: string, mySessionId: string) {
    const claims = readAllClaims();
    const myClaim = claims.find(c => c.resource === resource && c.holder === mySessionId);
    if (!myClaim) return false; // Not a holder
    
    // Check if any live competitor has an earlier claim
    const competitors = claims.filter(c => c.resource === resource && c.holder !== mySessionId);
    for (const competitor of competitors) {
        if (competitor.claimedAt < myClaim.claimedAt) {
            return true; // Yield to the earlier claim
        }
        if (competitor.claimedAt === myClaim.claimedAt && competitor.holder < mySessionId) {
            return true; // Tiebreaker: lexicographically smaller sessionId wins
        }
    }
    
    return false;
}
```

### 4.4 Release (remove a claim)

```typescript
// Pseudocode for the release path
function releaseResource(resource: string, mySessionId: string) {
    const key = `commons:${mySessionId}`;
    const existing = $.store.get(key);
    if (!existing) return;
    
    // Remove the claim
    existing.claims = existing.claims.filter(c => c.resource !== resource);
    
    // Refresh liveness
    existing.lastSeen = now();
    
    // Write back (we own this key, no race)
    $.store.set(key, existing);
}
```

## 5. Staleness and cleanup

- **Staleness threshold**: `staleAfterMs` from the plugin's config (default 90s, aligned with the plugin's own heartbeat model). A session's claims are considered abandoned if `lastSeen` is older than this threshold.
- **Cleanup**: a session's key is NOT automatically deleted (the platform doesn't provide TTL). A reader simply skips stale entries. An operator or a cleanup hook can call `$.store.delete(key)` for a stale session if desired, but this is optional.

## 6. Security model

- **One writer per key**: each session only writes its own `commons:<sessionId>` key. No cross-session writes, no lost updates.
- **Stranger-supplied data**: every resource path is screened (network refusal, normalization, `..` refusal, unplaceable = report unread).
- **No auth**: `$.store` is local to the machine and plugin-scoped. There is no authentication layer; the security model is "one machine, one plugin, trusted sessions."

## 7. Build plan

### 7.1 Stage 1: Core primitives + LIVE two-session suite (acceptance test)

- [ ] Implement `claimResource(resource, mySessionId)` in a new module `hooks/commons.ts`
- [ ] Implement `readAllClaims()` with liveness check and resource screening
- [ ] Implement `shouldYieldCommons(resource, mySessionId)` (first-claim-wins)
- [ ] Implement `releaseResource(resource, mySessionId)`
- [ ] Unit tests: claim, re-claim (idempotent - ownership unchanged), read-union, liveness, screening, release
- [ ] **LIVE two-session suite**: start two real sessions, have both claim the same resource, assert EXACTLY ONE holds it and the other yields. This is the acceptance criterion for the whole feature (template: the existing `yield` suite).

### 7.2 Stage 2: Integration

- [ ] Wire `shouldYieldCommons` into the existing claim path
- [ ] Update the controller tick to refresh `lastSeen` on every tick
- [ ] Integration test: clean handoff (session A claims, session B yields, session A releases, session B re-claims)

### 7.3 Stage 3: Observability

- [ ] Log claim events to the decision log (`persona_claim_commons`, `persona_yield_commons`, `persona_release_commons`)
- [ ] Expose commons state in the health file (optional, for debugging)

## 8. Open questions

1. **Resource naming convention**: `persona:<name>`, `file:<path>`, `goal:<id>` is proposed. Is this sufficient, or do we need a more general resource ID scheme?
2. **Multi-resource claims**: can a session claim multiple resources simultaneously? (Proposed: yes, the `claims` array supports this.)
3. **Operator visibility**: should the operator be able to inspect/clear commons claims? (Proposed: yes, via a CLI command or admin hook.)

## 9. Revisions

- **v1 (2026-09-08T08:26:00Z)**: Initial proposal on `$.store` substrate with per-session keys and self-contained liveness.
- **v2 (2026-09-08T08:32:00Z)**: Fixed F1 (first-claim-wins arbitration, not epoch comparison), F2 (live two-session suite as acceptance test in Stage 1), F3 (explicit release semantics), F4 (staleness aligned to `staleAfterMs`, 90s not 10 minutes).
- **v3 (2026-09-08T08:38:00Z)**: Fixed F5 (re-claim must not touch `claimedAt`; the `if (existingClaim)` branch is a no-op for arbitration, liveness is refreshed by `lastSeen`). Pinned the idempotent-re-claim invariant: `claimResource(R)` is idempotent with respect to ownership - re-invoking it on a resource you hold never changes who holds R.
