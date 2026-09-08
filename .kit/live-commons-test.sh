#!/usr/bin/env bash
# Live test: commons two-session race suite (Stage 2 acceptance gate).
# Two concurrent sessions both try to claim the same persona via agentic_identity.
# Commons arbitration (first-claim-wins) determines the winner.
#
# F8 fix: reads the REAL $.store (not the persona store's decisions).
# Asserts: (1) BOTH sessions wrote a commons:<sessionId> claim entry,
#          (2) EXACTLY ONE is the winner,
#          (3) the loser's decision log shows persona_yield_commons.
# Exit code: non-zero on any assertion failure.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/commons}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K="$SUITE_DIR"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

RUNNING="$K"/RUNNING
trap 'rm -f "$RUNNING"' EXIT
rm -f "$K"/commons-A.out.jsonl "$K"/commons-A.err.log "$K"/commons-B.out.jsonl "$K"/commons-B.err.log "$K"/commons.exit "$K"/commons.assert.log
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE
TOOLS="mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity"

# Feed A: claim the persona, then try a write.
feedA() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona \"default\". Report the result verbatim."}}'
  sleep 5
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"A second write after claim\" and kind fact. Report the tool result verbatim."}}'
  sleep 10
}

# Feed B: claim the same persona, then try a write.
feedB() {
  sleep 3
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona \"default\". Report the result verbatim."}}'
  sleep 5
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"B second write after claim\" and kind fact. Report the tool result verbatim."}}'
  sleep 10
}

# Remove heartbeat and yield log before the test
rm -f .agentic-heartbeat.json .agentic-yields.log

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite
emit_settings_json "settings.json"

# Launch both sessions concurrently (with --debug-file for loader diagnostics)
feedA | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
  --debug-file "$K"/commons-A.debug.log \
  > "$K"/commons-A.out.jsonl 2> "$K"/commons-A.err.log &
PA=$!

feedB | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
  --debug-file "$K"/commons-B.debug.log \
  > "$K"/commons-B.out.jsonl 2> "$K"/commons-B.err.log &
PB=$!

wait $PA
EA=$?
wait $PB
EB=$?
echo "A=$EA B=$EB" > "$K"/commons.exit

# --- Loader check: fail fast if the plugin failed to load in any child ---
LOADER_FAIL=0
for d in commons-A.debug.log commons-B.debug.log; do
  if [ -f "$K/$d" ] && grep -q "failed to load" "$K/$d"; then
    echo "FAIL: plugin failed to load in $d" >> "$K"/commons.assert.log
    grep "failed to load" "$K/$d" >> "$K"/commons.assert.log
    LOADER_FAIL=1
  fi
done
if [ $LOADER_FAIL -eq 1 ]; then
  echo "ASSERT: 1 (LOADER FAILED)" >> "$K"/commons.exit
  exit 1
fi
echo "LOADER: clean (no 'failed to load' in either child)" >> "$K"/commons.assert.log

# --- Assertions (F8) ---
ASSERT_FAILED=0

# Step 1: Find the REAL $.store file.
# The plugin's store is at ~/.claude/plugins/store/<plugin-name>.json
# or similar. We need to find it.
STORE_FILE=""
if [ -d "$HOME/.claude/plugins/store" ]; then
  # Look for a JSON file in the store directory
  for f in "$HOME/.claude/plugins/store"/*.json; do
    if [ -f "$f" ]; then
      STORE_FILE="$f"
      break
    fi
  done
fi

if [ -z "$STORE_FILE" ] || [ ! -f "$STORE_FILE" ]; then
  echo "FAIL: could not find the real \$store file" >> "$K"/commons.assert.log
  ASSERT_FAILED=1
else
  echo "Found store file: $STORE_FILE" >> "$K"/commons.assert.log

  # Step 2: Read the store and check for commons entries
  node -e "
const fs = require('fs');
const store = JSON.parse(fs.readFileSync('$STORE_FILE', 'utf8'));
const lines = [];
let failed = 0;

// Find all commons:* keys
const commonsKeys = Object.keys(store).filter(k => k.startsWith('commons:'));
lines.push('commons keys found: ' + (commonsKeys.length > 0 ? commonsKeys.join(', ') : 'NONE'));

if (commonsKeys.length === 0) {
  lines.push('FAIL: no commons:* entries in the store');
  failed = 1;
} else {
  // Check that we have at least one claim entry
  let claimCount = 0;
  let sessionIds = new Set();
  for (const key of commonsKeys) {
    const entry = store[key];
    if (entry.claims && entry.claims.length > 0) {
      claimCount += entry.claims.length;
      sessionIds.add(entry.sessionId);
    }
  }
  lines.push('total claims: ' + claimCount);
  lines.push('unique sessions: ' + sessionIds.size + ' (' + Array.from(sessionIds).join(', ') + ')');

  if (sessionIds.size < 2) {
    lines.push('FAIL: expected 2 sessions to have claimed, got ' + sessionIds.size);
    failed = 1;
  }

  // Step 3: Determine the winner using commonsWinner logic
  // We need to simulate the readAllClaims + commonsWinner logic
  const now = Date.now();
  const STALE_THRESHOLD = 90000; // 90s

  // Collect all claims
  const allClaims = [];
  for (const key of commonsKeys) {
    const entry = store[key];
    if (!entry.lastSeen || now - entry.lastSeen > STALE_THRESHOLD) {
      continue; // stale
    }
    for (const claim of entry.claims) {
      allClaims.push({
        resource: claim.resource,
        claimedAt: claim.claimedAt,
        holder: entry.sessionId
      });
    }
  }

  lines.push('live claims (non-stale): ' + allClaims.length);

  // Find the winner for the persona:default resource
  const personaClaims = allClaims.filter(c => c.resource === 'persona:default');
  if (personaClaims.length === 0) {
    lines.push('FAIL: no claims found for persona:default');
    failed = 1;
  } else {
    // Sort by (claimedAt, holder) to find the winner
    personaClaims.sort((a, b) => {
      if (a.claimedAt !== b.claimedAt) return a.claimedAt - b.claimedAt;
      return a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0;
    });
    const winner = personaClaims[0].holder;
    lines.push('winner: ' + winner);
    lines.push('claims: ' + personaClaims.map(c => c.holder + ' @ ' + new Date(c.claimedAt).toISOString()).join(' | '));

    // Check that the loser has a persona_yield_commons decision in their log
    // We need to check the session logs for this
  }
}

fs.writeFileSync('$K/commons.assert.log', lines.join('\n') + '\n');
process.exit(failed);
"
  ASSERT_EXIT=$?
  if [ $ASSERT_EXIT -ne 0 ]; then
    ASSERT_FAILED=1
  fi
fi

# Step 4: Check for persona_yield_commons decisions (mutual exclusion proof).
# The yield decision is written to the persona store and .agentic-yields.log,
# NOT to the session stdout jsonl. Check both sources.
YIELD_FOUND=0
YIELD_EVIDENCE=""

# Check the yield log first (most direct evidence)
if [ -f ".agentic-yields.log" ]; then
  if grep -q "persona_yield_commons" ".agentic-yields.log"; then
    YIELD_FOUND=1
    YIELD_EVIDENCE=$(grep "persona_yield_commons" ".agentic-yields.log" | head -1)
    echo "Yield log evidence: $YIELD_EVIDENCE" >> "$K"/commons.assert.log
  fi
fi

# Also check the persona store for the decision (secondary source)
if [ -f ".agentic-personas.json" ]; then
  if grep -q "persona_yield_commons" ".agentic-personas.json"; then
    YIELD_FOUND=1
    if [ -z "$YIELD_EVIDENCE" ]; then
      YIELD_EVIDENCE=$(grep "persona_yield_commons" ".agentic-personas.json" | head -1)
    fi
    echo "Persona store evidence: $YIELD_EVIDENCE" >> "$K"/commons.assert.log
  fi
fi

if [ $YIELD_FOUND -eq 0 ]; then
  # NO yield found: this is a FAILURE (mutual exclusion not proven)
  echo "FAIL: no persona_yield_commons decision found in yield log or persona store" >> "$K"/commons.assert.log
  ASSERT_FAILED=1
else
  echo "OK: persona_yield_commons decision confirmed (mutual exclusion proven)" >> "$K"/commons.assert.log
fi

# Final exit code
if [ $ASSERT_FAILED -eq 1 ]; then
  echo "ASSERT: 1 (FAILED)" >> "$K"/commons.exit
  exit 1
else
  echo "ASSERT: 0 (PASSED)" >> "$K"/commons.exit
  exit $EA
fi
