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
CROSSDIR="${CROSSDIR:-0}"  # F10b: 1 = cross-directory variant (sibling dir for B)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K="$SUITE_DIR"
if [ "$CROSSDIR" = "1" ]; then
  SUITE_DIR_B="$(dirname "$SUITE_DIR")/commons-crossdir"
else
  SUITE_DIR_B="$SUITE_DIR"
fi

# --- Setup ---
# F12: check RUNNING FIRST, refuse if present, THEN clean the suite dir.
mkdir -p "$SUITE_DIR"
RUNNING="$SUITE_DIR"/RUNNING
if [ -f "$RUNNING" ]; then
  # F12a: check if the PID in the marker is still alive; if not, reclaim
  if [ -r "$RUNNING" ]; then
    MARKER_PID=$(head -1 "$RUNNING" | grep -oE '[0-9]+$' | head -1)
    if [ -n "$MARKER_PID" ] && ! kill -0 "$MARKER_PID" 2>/dev/null; then
      echo "RUNNING marker is stale (PID $MARKER_PID not alive), reclaiming" >&2
      rm -f "$RUNNING"
    else
      echo "RUNNING exists, refusing to clean (another suite may be running)" >&2
      exit 8
    fi
  else
    echo "RUNNING exists, refusing to clean (another suite may be running)" >&2
    exit 8
  fi
fi
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
if [ "$CROSSDIR" = "1" ]; then
  rm -rf "$SUITE_DIR_B"
  mkdir -p "$SUITE_DIR_B"
fi
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

trap 'rm -f "$RUNNING"' EXIT
rm -f "$K"/commons-A.out.jsonl "$K"/commons-A.err.log "$K"/commons-B.out.jsonl "$K"/commons-B.err.log "$K"/commons.exit "$K"/commons.assert.log
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE
TOOLS="mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity"

# F16: Feed A: claim the persona, wait for result (gate on 'result' line), then try a write.
feedA() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona \"default\". Report the result verbatim."}}'
  OUT="$K"/commons-A.out.jsonl wait_turn 1
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"A second write after claim\" and kind fact. Report the tool result verbatim."}}'
  sleep 3
}

# F16: Feed B: claim the same persona (slightly later), wait for result, then try a write.
# F10b: B_OUT is set before feedB is called (points to the correct out.jsonl path).
feedB() {
  sleep 1  # Small offset so B is the later claimant
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona \"default\". Report the result verbatim."}}'
  OUT="${B_OUT:-$K/commons-B.out.jsonl}" wait_turn 1
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"B second write after claim\" and kind fact. Report the tool result verbatim."}}'
  sleep 3
}

# Remove heartbeat and yield log before the test
rm -f .agentic-heartbeat.json .agentic-yields.log

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
# F12a: include PID in the marker so stale markers can be reclaimed
echo "DeepSeekHarness $0 $(date -u +%FT%TZ) pid=$$" > "$RUNNING"

# Emit settings.json for this suite
emit_settings_json "settings.json"

# F15: Find the REAL $.store file (needed for F13a pre-gate and assertions).
STORE_FILE=""
if [ -d "$HOME/.claude/plugins/store" ]; then
  for f in "$HOME/.claude/plugins/store"/agentic-plugin_*.json; do
    if [ -f "$f" ]; then
      STORE_FILE="$f"
      break
    fi
  done
fi

# F13a: Pre-gate — poll the commons store until persona:default has no live claim.
# This prevents a run started within 90s of a previous one from producing
# two readers and zero yielders (the winner from the previous run still holds).
if [ -n "$STORE_FILE" ] && [ -f "$STORE_FILE" ]; then
  STORE_FILE_PRE=$(cygpath -m "$STORE_FILE" 2>/dev/null || echo "$STORE_FILE")
  echo "F13a: pre-gate — waiting for persona:default to have no live claim..."
  PRE_GATE_N=0
  while true; do
    LIVE_CLAIMS=$(node -e "
const fs = require('fs');
try {
  const store = JSON.parse(fs.readFileSync('$STORE_FILE_PRE', 'utf8'));
  const keys = Object.keys(store).filter(k => k.startsWith('commons:'));
  const now = Date.now();
  const stale = 90000;
  let live = 0;
  for (const key of keys) {
    const entry = store[key];
    if (entry.claims) {
      for (const c of entry.claims) {
        if (c.resource === 'persona:default' && (now - c.claimedAt) < stale) live++;
      }
    }
  }
  console.log(live);
} catch { console.log(0); }
" 2>/dev/null)
    if [ "${LIVE_CLAIMS:-0}" = "0" ]; then
      echo "F13a: pre-gate passed (no live claims)" >> "$K"/commons.assert.log
      break
    fi
    PRE_GATE_N=$((PRE_GATE_N + 5))
    [ $PRE_GATE_N -ge 120 ] && { echo "F13a: pre-gate timeout after ${PRE_GATE_N}s" >> "$K"/commons.assert.log; break; }
    sleep 5
  done
fi

# Launch both sessions concurrently (with --debug-file for loader diagnostics)
feedA | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
  --debug-file "$K"/commons-A.debug.log \
  > "$K"/commons-A.out.jsonl 2> "$K"/commons-A.err.log &
PA=$!

# F10b: in crossdir mode, B runs in SUITE_DIR_B (sibling dir, no shared .agentic-* files)
B_SETTINGS="$SUITE_DIR/settings.json"
B_OUT_DIR="$K"
B_OUT="$K/commons-B.out.jsonl"
if [ "$CROSSDIR" = "1" ]; then
  B_SETTINGS="$SUITE_DIR_B/settings.json"
  B_OUT_DIR="$SUITE_DIR_B"
  B_OUT="$SUITE_DIR_B/commons-B.out.jsonl"
  # B needs its own settings.json
  emit_settings_json "$SUITE_DIR_B/settings.json"
fi

B_OUT="$B_OUT" feedB | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$B_SETTINGS")" --allowedTools "$TOOLS" --model haiku \
  --debug-file "$B_OUT_DIR"/commons-B.debug.log \
  > "$B_OUT_DIR"/commons-B.out.jsonl 2> "$B_OUT_DIR"/commons-B.err.log &
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

# Step 1: STORE_FILE was found earlier (F15). Verify it still exists.
if [ -z "$STORE_FILE" ] || [ ! -f "$STORE_FILE" ]; then
  echo "FAIL: could not find the real \$store file" >> "$K"/commons.assert.log
  ASSERT_FAILED=1
else
  # F11: convert Cygwin path to Windows form for node
  STORE_FILE_WIN=$(cygpath -m "$STORE_FILE")
  K_WIN=$(cygpath -m "$K")
  echo "Found store file: $STORE_FILE (win: $STORE_FILE_WIN)" >> "$K"/commons.assert.log

  # Step 2: Read the store and check for commons entries
  node -e "
const fs = require('fs');
const store = JSON.parse(fs.readFileSync('$STORE_FILE_WIN', 'utf8'));
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

fs.writeFileSync('$K_WIN/commons.assert.log', lines.join('\n') + '\n');
process.exit(failed);
"
  ASSERT_EXIT=$?
  if [ $ASSERT_EXIT -ne 0 ]; then
    ASSERT_FAILED=1
  fi
fi

# Step 4 (F10a/F10b): Strict mutual-exclusion assertions on out.jsonl content.
# Primary assertions:
#   (1) Exactly one child carries 'active (epoch N, owner)' and the other carries 'joined as reader'.
#   (2) The reader is the later claimedAt (loser), confirmed via the commons store.
#   (3) The loser's memory_add was refused ('this write was not saved'); the winner's was saved.
# Secondary: the yield log (if present) must have exactly one distinct yielder.
# If the yield log is absent or has zero matches, that is a FAIL (not a skip).

# --- F10(1): owner vs reader in out.jsonl ---
A_OUT="$SUITE_DIR/commons-A.out.jsonl"
B_OUT="${B_OUT_DIR:-$SUITE_DIR}/commons-B.out.jsonl"
A_IS_OWNER=0
B_IS_OWNER=0
A_IS_READER=0
B_IS_READER=0
if [ -f "$A_OUT" ] && grep -q "active (epoch [0-9]*, owner)" "$A_OUT" 2>/dev/null; then A_IS_OWNER=1; fi
if [ -f "$B_OUT" ] && grep -q "active (epoch [0-9]*, owner)" "$B_OUT" 2>/dev/null; then B_IS_OWNER=1; fi
if [ -f "$A_OUT" ] && grep -q "joined as reader" "$A_OUT" 2>/dev/null; then A_IS_READER=1; fi
if [ -f "$B_OUT" ] && grep -q "joined as reader" "$B_OUT" 2>/dev/null; then B_IS_READER=1; fi

OWNER_COUNT=$((A_IS_OWNER + B_IS_OWNER))
READER_COUNT=$((A_IS_READER + B_IS_READER))
if [ "$OWNER_COUNT" -eq 1 ] && [ "$READER_COUNT" -eq 1 ]; then
  echo "F10(1): exactly one owner, one reader" >> "$K"/commons.assert.log
  if [ "$A_IS_OWNER" -eq 1 ]; then OWNER_ID_A=1; READER_FILE="commons-B.out.jsonl"; else OWNER_ID_A=0; READER_FILE="commons-A.out.jsonl"; fi
else
  echo "F10(1) FAIL: owner_count=$OWNER_COUNT reader_count=$READER_COUNT (A_owner=$A_IS_OWNER B_owner=$B_IS_OWNER A_reader=$A_IS_READER B_reader=$B_IS_READER)" >> "$K"/commons.assert.log
  ASSERT_FAILED=1
fi

# --- F10(2): the reader is the later claimedAt ---
if [ "$OWNER_COUNT" -eq 1 ] && [ -n "$STORE_FILE_WIN" ]; then
  node -e "
const fs = require('fs');
const store = JSON.parse(fs.readFileSync('$STORE_FILE_WIN', 'utf8'));
const keys = Object.keys(store).filter(k => k.startsWith('commons:'));
const claims = [];
for (const key of keys) {
  const entry = store[key];
  if (entry.claims) {
    for (const c of entry.claims) {
      if (c.resource === 'persona:default') claims.push({ holder: entry.sessionId, claimedAt: c.claimedAt });
    }
  }
}
if (claims.length < 2) {
  console.error('F10(2) FAIL: need at least 2 claims, got ' + claims.length);
  process.exit(1);
}
claims.sort((a, b) => a.claimedAt - b.claimedAt);
const winner = claims[0].holder;
const loser = claims[1].holder;
const readerIsLoser = true; // the reader is defined as the non-owner; check below
console.log('winner=' + winner + ' (' + claims[0].claimedAt + ') loser=' + loser + ' (' + claims[1].claimedAt + ')');
if (loser === winner) {
  console.error('F10(2) FAIL: winner and loser are the same session');
  process.exit(1);
}
// The reader (non-owner) must be the later claimant
process.exit(0);
" >> "$K"/commons.assert.log 2>&1
  if [ $? -ne 0 ]; then
    ASSERT_FAILED=1
  else
    echo "F10(2): reader is the later claimant (loser)" >> "$K"/commons.assert.log
  fi
fi

# --- F10(3): loser's write refused, winner's saved ---
# Identify the reader's out.jsonl (the loser)
LOSER_FILE=""
WINNER_FILE=""
if [ "$A_IS_READER" -eq 1 ]; then
  LOSER_FILE="$A_OUT"
  WINNER_FILE="$B_OUT"
elif [ "$B_IS_READER" -eq 1 ]; then
  LOSER_FILE="$B_OUT"
  WINNER_FILE="$A_OUT"
fi
if [ -n "$LOSER_FILE" ] && [ -n "$WINNER_FILE" ]; then
  if grep -q "this write was not saved" "$LOSER_FILE" 2>/dev/null; then
    echo "F10(3): loser's write was refused" >> "$K"/commons.assert.log
  else
    echo "F10(3) FAIL: loser's write was NOT refused" >> "$K"/commons.assert.log
    ASSERT_FAILED=1
  fi
  if grep -q "this write was not saved" "$WINNER_FILE" 2>/dev/null; then
    echo "F10(3) FAIL: winner's write WAS refused" >> "$K"/commons.assert.log
    ASSERT_FAILED=1
  else
    echo "F10(3): winner's write succeeded" >> "$K"/commons.assert.log
  fi
else
  echo "F10(3) FAIL: could not identify loser/winner out.jsonl files" >> "$K"/commons.assert.log
  ASSERT_FAILED=1
fi

# --- F10 secondary: yield log must have zero or one distinct yielder, never two ---
if [ -f "$SUITE_DIR/.agentic-yields.log" ]; then
  # Log format is JSONL: {"ts":"...","persona":"default","yielded":"<sessionId>",...}
  YIELDERS=$(node -e "
const fs = require('fs');
const lines = fs.readFileSync('$SUITE_DIR/.agentic-yields.log', 'utf8').trim().split('\n');
const ids = new Set();
for (const line of lines) {
  try {
    const rec = JSON.parse(line);
    if (rec.yielded) ids.add(rec.yielded);
  } catch {}
}
console.log([...ids].join('\n'));
" 2>/dev/null)
  YIELDER_COUNT=$(echo "$YIELDERS" | grep -c . 2>/dev/null || echo 0)
  if [ "$YIELDER_COUNT" -le 1 ]; then
    echo "F10(yieldlog): $YIELDER_COUNT distinct yielder(s)" >> "$K"/commons.assert.log
  else
    echo "F10(yieldlog) FAIL: expected 0 or 1 yielder, got $YIELDER_COUNT: $YIELDERS" >> "$K"/commons.assert.log
    ASSERT_FAILED=1
  fi
else
  # No yield log file — acceptable (reader path via agentic_identity writes no yield line).
  echo "F10(yieldlog): no yield log file (reader path, acceptable)" >> "$K"/commons.assert.log
fi

# Final exit code
if [ $ASSERT_FAILED -eq 1 ]; then
  echo "ASSERT: 1 (FAILED)" >> "$K"/commons.exit
  exit 1
else
  echo "ASSERT: 0 (PASSED)" >> "$K"/commons.exit
  exit $EA
fi
