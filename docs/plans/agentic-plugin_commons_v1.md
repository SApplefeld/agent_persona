# Agentic Plugin: Commons (Shared Claims & Coordination)

**Status**: Proposed
**Created**: 2026-09-08T08:26:00Z
**Author**: DeepSeekHarness
**Reviewer**: Fable

## 1. Purpose

Commons provides machine-global, cross-session coordination for agentic-plugin sessions. It lets two or more sessions avoid colliding on the same resource (persona, file, goal, or arbitrary named resource) using its own first-claim-wins arbitration (`claimResource`/`commonsWinner`). The epoch-and-yield primitive is NOT used by commons; it is the same-directory write fence that `agentic_identity` bumps, and commons reads the resulting claimant ordering via `readAllClaims`.

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

### 3.4a F9 rule: commons arbitrates, epoch is the same-directory write fence

The F9 design establishes the relationship between commons arbitration and the epoch-and-yield primitive:

1. **`agentic_identity` claims first, then reads**: the identity hook calls `claimResource('persona:default', sessionId)` to register its claim in the commons store, then calls `readAllClaims()` + `commonsWinner()` to determine whether it won. If it lost, it takes the reader path (`isOwner=false`, no epoch bump, no yield log line). This is the F9 fix: the reader is determined by commons arbitration, not by epoch comparison.

2. **The epoch is the same-directory write fence**: the epoch bump (`sess.epoch++`) in `agentic_identity` serves as a same-directory write fence — it ensures that within a single CWD, only the winner writes `.agentic-personas.json` and `.agentic-heartbeat.json`. It is NOT the arbitration mechanism; that is commons.

3. **Three sites raise the epoch**: the epoch is raised at exactly three sites in the codebase: (a) `agentic_identity` on successful claim (the winner), (b) the persona activation path when a new persona takes ownership, and (c) the goal-creation path when a goal is assigned. Commons does not raise the epoch; it reads the claim ordering.

4. **Liveness is `lastSeen`, not `claimedAt`**: `readAllClaims` filters entries by `entry.lastSeen` (refreshed by heartbeats), not by `claimedAt` (the original claim time). This is critical: a long-running holder that claimed five minutes ago but ticked one second ago is LIVE. The F13a/F13b pre-gate in the test suite mirrors this: it checks `entry.lastSeen` against the staleness threshold (must match `DEFAULT_STALE_AFTER_MS` in `hooks/commons.ts:47`, 90 000 ms).

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

## 10. Revision table (F9–F16)

| Finding | Fix | File:line | Status |
|---------|-----|-----------|--------|
| F9 | Commons is the single arbiter: `agentic_identity` calls `claimResource` FIRST, then `readAllClaims` + `commonsWinner`; non-winner → reader path (no epoch bump, no heartbeat, `isOwner=false`). Design text in §3.4a. | `hooks/index.ts:1637-1639` | Done |
| F9a | `staleAfterMs` single-sourced via `sess.staleAfterMs` field (set in `activate` from `cfg.staleAfterMs`); both `readAllClaims` call sites pass it; invariant comment names the three epoch-raising sites. | `hooks/index.ts:67,318,210,1637,198-203` | Done |
| F10a | Yield-log extraction uses node JSON parse of `rec.yielded` (not `grep -o "yielded=[a-zA-Z0-9-]*"` which matches nothing in JSONL); absent yield log is acceptable (reader path writes no yield line); suite must prove red before green. | `.kit/live-commons-test.sh:~350`, `.kit/live-commons-test.ps1:~370` | Done |
| F10b | Primary assertions on `out.jsonl` content: (1) exactly one child "active (epoch N, owner)" + one "joined as reader"; (2) reader is later `claimedAt`; (3) writes. Yield-log secondary: 0 or 1 distinct yielder, never 2. Cross-directory variant (`SUITE_DIR_B` sibling) is the acceptance gate; same-directory is epoch-fence regression. | `.kit/live-commons-test.sh:~280-400`, `.kit/live-commons-test.ps1:~330-420` | Done |
| F11 | `cygpath -m` for Windows path conversion in Cygwin bash. | `.kit/live-commons-test.sh:~190` | Done |
| F12a | RUNNING marker: `try/finally` removal; PID in marker (`$$` / `$PID`); reclaim-if-PID-dead with log line; `(Get-Date).ToUniversalTime()` for UTC. | `.kit/live-commons-test.sh:~80-90,85`, `.kit/live-commons-test.ps1:~24-58,58,~370` | Done |
| F13a | Pre-launch poll: loop until `persona:default` has no live claim (bounded 120s, 5s polls). No session-end event exists in the engine — release-on-exit deferred to Future. | `.kit/live-commons-test.sh:~90-125`, `.kit/live-commons-test.ps1:~70-100` | Done |
| F14 | `gcStaleClaims` in commons.ts; unit test 9 covers GC. | `hooks/commons.ts:~180`, `.kit/commons-unit-test.mjs:~180` | Done |
| F15 | Store glob: `agentic-plugin_*.json` (not first `*.json`). | `.kit/live-commons-test.sh:~91`, `.kit/live-commons-test.ps1:~72` | Done |
| F16 | `wait_turn` (poll `"type":"result"` count in `$OUT`) between prompts in feeds; `.ps1` feeds now include `memory_add` second prompt. | `.kit/live-commons-test.sh:~63-78`, `.kit/live-commons-test.ps1:~64-77` | Done |
| F10c | F10(2) bash assertion: read reader's `session_id` from READER out.jsonl (node JSON parse of init line), pass to store-checking node block, FAIL unless reader is the later `claimedAt`. Red-proof required. | `.kit/live-commons-test.sh:~355-395` | Done |
| F10d | Cross-directory run: launch B with CWD = B's dir (subshell `cd`); post-run assertions: B has own `.agentic-personas.json` and `.agentic-heartbeat.json`; loader check covers B's debug.log in `B_OUT_DIR`; clean B's `.agentic-*` before run. This is the acceptance gate. | `.kit/live-commons-test.sh:~140-175,~230-248` | Done |
| F12b | PID mismatch: `.sh` wrote `$$` (MSYS PID), `.ps1` wrote `$PID` (Windows PID) — cross-script reclaim broken. Fix: `.sh` writes Windows PID (`ps -p $$ \| awk '{print $4}'` = WINPID column); reclaim via `tasklist //FI` (double-slash for MSYS arg conv). `.ps1` deleted (Round 24) — one suite, one set of assertions. | `.kit/live-commons-test.sh:~30-65,~103-113` | Done |
| F13b | Pre-gate liveness: count claims live by `entry.lastSeen` (not `claimedAt`); threshold from same source as commons.ts (`DEFAULT_STALE_AFTER_MS = 90_000`, `hooks/commons.ts:47`). | `.kit/live-commons-test.sh:~130-170`, `.kit/live-commons-test.ps1:~87-120` | Done |
| F10e | Evidence retention: copy `commons*.{out.jsonl,debug.log,err.log,exit,assert.log}` and `.agentic-*` to `.kit/runs/<utc-stamp>/commons[-crossdir]/` at exit. Assert-log append (not overwrite) in Step 2 node block. `wait_turn` default count to 0. | `.kit/live-commons-test.sh:~500-520,~338-342`, `.kit/live-common.sh:~40-47` | Done |
| F10d-red | F10d assertion red-proof: `ASSERT_FAILED=0` was after the F10d block, erasing failures. Fixed: initializer moved above the block. Red-proof: empty `B_WORKDIR` → exit 1 (proven via Git Bash). | `.kit/live-commons-test.sh:~231-250` | Done |
| F12b-win | F12b fix: `awk '{print $4}'` (WINPID column, not MSYS PID); `tasklist //FI` double-slash for MSYS. Two-direction live proof: bash→PS (`Get-Process -Id 17372` → `bash`), PS→bash (`tasklist //FI "PID eq 20848"` → `pwsh.exe`). | `.kit/live-commons-test.sh:~38-43,~108-113` | Done |
| .ps1-del | `.ps1` suite deleted (Round 24 Reviewer decision): file-based stdin can't gate mid-stream (F16: 1 result line for 2 prompts); one suite, one set of assertions; `.sh` via Git Bash is the single path. | `.kit/live-commons-test.ps1` (deleted) | Done |
| dead-cfg | Dead config branch removed: `$PLUGIN_DIR/agentic-plugin.json` never exists (manifest is `.claude-plugin/plugin.json`, options via `--settings`). Threshold is the constant 90000, matching `commons.ts:47`. | `.kit/live-commons-test.sh:~140-143` | Done |
| header | Header comment updated: describes current assertions (F8, F10c, F10d, F12b, F13b, F16) instead of F8-era text. | `.kit/live-commons-test.sh:1-20` | Done |

## 11. Future: release-on-exit

**Blocker**: the engine has no session-end event. The event list in `agentic-plugin/.claude/types/claude-code.d.ts` includes: `agent.offer, attribution.text, prompt.context, prompt.section, session.start, skill.prompt, tool.call, tool.describe, turn.start, ui.input, ui.press, ui.select`. There is no `session.end` or `session.close` event, so a normally-exiting winner cannot release its commons claim on exit.

**Workaround (implemented)**: the suite pre-gates (F13a) by polling the commons store until `persona:default` has no live claim before launching children. This handles the 90s staleness window without requiring a release event.

**Future**: if/when the engine adds a `session.end` event, add a `releaseResource` call in the `on("session.end")` handler for all held commons claims. This would make the 90s staleness window unnecessary for clean handoffs.
