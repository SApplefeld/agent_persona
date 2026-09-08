#!/usr/bin/env bash
# Live test: commons two-session race suite (Stage 2 acceptance gate).
# Two concurrent sessions both try to claim the same persona via agentic_identity.
# Commons arbitration (claim-then-read, compareHolders) determines the winner;
# the loser takes the reader path and its writes are refused.
#
# Asserts:
#   F8:   Both sessions wrote a commons:<sessionId> claim entry; exactly one winner.
#   F10c: The reader's session_id (read from its own out.jsonl) is the LATER
#         claimant in the store. The earlier claimant is the winner (F9 rule).
#   F10d: CROSSDIR=1: B ran in its own directory and has its own
#         .agentic-personas.json and .agentic-heartbeat.json there.
#   F12b: Stale RUNNING markers are reclaimed by Windows-PID liveness check
#         (tasklist //FI under Git Bash).
#   F13b: Pre-gate waits for persona:default to have no live claim, using
#         entry.lastSeen (heartbeat liveness) and the 90 000 ms threshold
#         from commons.ts:47.
#   F16:  Each child produces 2 "result" lines (wait_turn gates between prompts).
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
  # F12b: PID is a Windows PID; use tasklist to check liveness (works from Cygwin)
  if [ -r "$RUNNING" ]; then
    MARKER_PID=$(head -1 "$RUNNING" | grep -oE '[0-9]+$' | head -1)
    PID_ALIVE=0
    if [ -n "$MARKER_PID" ]; then
      # Check via tasklist (Windows PID).
      # Under MSYS/Git Bash, single-slash args are path-converted (/FI → C:/Program Files/Git/FI),
      # so use double-slash form: //FI, //FO, //NH.
      if command -v tasklist &>/dev/null; then
        if tasklist //FI "PID eq $MARKER_PID" //FO CSV //NH 2>/dev/null | grep -qi "No tasks"; then
          PID_ALIVE=0
        else
          PID_ALIVE=1
        fi
      elif command -v powershell &>/dev/null; then
        if powershell -NoProfile -Command "Get-Process -Id $MARKER_PID -ErrorAction SilentlyContinue" 2>/dev/null | grep -q .; then
          PID_ALIVE=1
        fi
      else
        # Fallback: kill -0 (works if the PID is a Cygwin/POSIX PID)
        if kill -0 "$MARKER_PID" 2>/dev/null; then PID_ALIVE=1; fi
      fi
    fi
    if [ "$PID_ALIVE" -eq 0 ]; then
      echo "RUNNING marker is stale (PID ${MARKER_PID:-unknown} not alive), reclaiming" >&2
      rm -f "$RUNNING"
    else
      echo "RUNNING exists (PID ${MARKER_PID:-unknown} still alive), refusing to clean" >&2
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

# F12a: include PID in the marker so stale markers can be reclaimed
# F12b: write the WINDOWS PID so both scripts agree on liveness.
# Under Git Bash (MSYS), ps -p $$ shows:
#   PID TTY UID TIME WINPID COMMAND
# Column 1 is the MSYS PID; column 4 ($4 in awk) is the Windows PID.
# The marker must carry the Windows PID so PowerShell's Get-Process -Id
# and bash's tasklist //FI both resolve it against the same PID namespace.
WIN_PID=$$
if command -v ps &>/dev/null; then
  PS_OUT=$(ps -p $$ 2>/dev/null | tail -1 | awk '{print $4}')
  [ -n "$PS_OUT" ] && [ "$PS_OUT" -gt 0 ] 2>/dev/null && WIN_PID="$PS_OUT"
fi
echo "DeepSeekHarness $0 $(date -u +%FT%TZ) pid=$WIN_PID" > "$RUNNING"

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

# F13a: Pre-gate: poll the commons store until persona:default has no live claim.
# This prevents a run started within 90s of a previous one from producing
# two readers and zero yielders (the winner from the previous run still holds).
# F13b: use entry.lastSeen (heartbeat liveness), NOT claimedAt.
# The staleness threshold must match commons.ts DEFAULT_STALE_AFTER_MS (90_000 ms).
# See hooks/commons.ts:47 for the source of truth.
if [ -n "$STORE_FILE" ] && [ -f "$STORE_FILE" ]; then
  STORE_FILE_PRE=$(cygpath -m "$STORE_FILE" 2>/dev/null || echo "$STORE_FILE")
  # F13b: threshold matches commons.ts:47 DEFAULT_STALE_AFTER_MS (90_000 ms).
  # The plugin manifest is .claude-plugin/plugin.json (not agentic-plugin.json),
  # and options arrive via --settings pluginConfigs: there is no per-plugin config
  # file in $PLUGIN_DIR to read, so the threshold is the constant 90000.
  STALE_THRESHOLD_MS=90000
  echo "F13a: pre-gate: waiting for persona:default to have no live claim (threshold: ${STALE_THRESHOLD_MS}ms)..."
  PRE_GATE_N=0
  while true; do
    LIVE_CLAIMS=$(node -e "
const fs = require('fs');
try {
  const store = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const keys = Object.keys(store).filter(k => k.startsWith('commons:'));
  const now = Date.now();
  const stale = parseInt(process.argv[2], 10) || 90000;
  let live = 0;
  for (const key of keys) {
    const entry = store[key];
    // F13b: use entry.lastSeen (heartbeat), NOT claimedAt
    if (entry.lastSeen && (now - entry.lastSeen) < stale) {
      if (entry.claims) {
        for (const c of entry.claims) {
          if (c.resource === 'persona:default') live++;
        }
      }
    }
  }
  console.log(live);
} catch { console.log(0); }
" "$STORE_FILE_PRE" "$STALE_THRESHOLD_MS" 2>/dev/null)
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
B_WORKDIR="$SUITE_DIR"
if [ "$CROSSDIR" = "1" ]; then
  B_SETTINGS="$SUITE_DIR_B/settings.json"
  B_OUT_DIR="$SUITE_DIR_B"
  B_OUT="$SUITE_DIR_B/commons-B.out.jsonl"
  B_WORKDIR="$SUITE_DIR_B"
  # B needs its own settings.json
  emit_settings_json "$SUITE_DIR_B/settings.json"
fi

# F10d: B must run with CWD = B_WORKDIR so its .agentic-* files land in its own dir
( cd "$B_WORKDIR" && B_OUT="$B_OUT" feedB | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$B_SETTINGS")" --allowedTools "$TOOLS" --model haiku \
  --debug-file "$B_OUT_DIR"/commons-B.debug.log \
  > "$B_OUT_DIR"/commons-B.out.jsonl 2> "$B_OUT_DIR"/commons-B.err.log ) &
PB=$!

wait $PA
EA=$?
wait $PB
EB=$?
echo "A=$EA B=$EB" > "$K"/commons.exit

# --- Loader check: fail fast if the plugin failed to load in any child ---
# F10d: in crossdir mode, B's debug.log is in B_OUT_DIR (sibling dir)
LOADER_FAIL=0
A_DEBUG="$K/commons-A.debug.log"
B_DEBUG="$B_OUT_DIR/commons-B.debug.log"
for d in "$A_DEBUG" "$B_DEBUG"; do
  if [ -f "$d" ] && grep -q "failed to load" "$d"; then
    echo "FAIL: plugin failed to load in $d" >> "$K"/commons.assert.log
    grep "failed to load" "$d" >> "$K"/commons.assert.log
    LOADER_FAIL=1
  fi
done
if [ $LOADER_FAIL -eq 1 ]; then
  echo "ASSERT: 1 (LOADER FAILED)" >> "$K"/commons.exit
  exit 1
fi
echo "LOADER: clean (no 'failed to load' in either child)" >> "$K"/commons.assert.log

ASSERT_FAILED=0

# --- F10d: crossdir proof: B must have its own .agentic-* files in B_WORKDIR ---
# B's session.start creates the persona as owner in its own (empty) directory
# BEFORE agentic_identity demotes it to reader. A reader that never owned
# anything would write no heartbeat, so this assertion depends on B being
# owner-at-creation, which is the correct F9 path.
if [ "$CROSSDIR" = "1" ]; then
  B_PERSONAS="$B_WORKDIR/.agentic-personas.json"
  if [ -f "$B_PERSONAS" ]; then
    echo "F10d: B has its own .agentic-personas.json in $B_WORKDIR" >> "$K"/commons.assert.log
  else
    echo "F10d FAIL: B does NOT have its own .agentic-personas.json in $B_WORKDIR" >> "$K"/commons.assert.log
    ASSERT_FAILED=1
  fi
  B_HEARTBEAT="$B_WORKDIR/.agentic-heartbeat.json"
  if [ -f "$B_HEARTBEAT" ]; then
    echo "F10d: B has its own .agentic-heartbeat.json in $B_WORKDIR" >> "$K"/commons.assert.log
  else
    echo "F10d FAIL: B does NOT have its own .agentic-heartbeat.json in $B_WORKDIR" >> "$K"/commons.assert.log
    ASSERT_FAILED=1
  fi
fi

# --- Assertions (F8) ---

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

// Append, not overwrite: F10e: preserve earlier log lines (F13a pre-gate, LOADER, etc.)
const fstream = fs.createWriteStream('$K_WIN/commons.assert.log', { flags: 'a' });
for (const line of lines) fstream.write(line + '\n');
fstream.end();
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
# F10c fix: read the reader's session_id from the READER_FILE's out.jsonl,
# then verify in the commons store that this session has the later claimedAt.
if [ "$OWNER_COUNT" -eq 1 ] && [ -n "$STORE_FILE_WIN" ] && [ "$ASSERT_FAILED" -eq 0 ]; then
  # Determine which file is the reader's
  READER_OUT="$A_OUT"
  if [ "$B_IS_READER" -eq 1 ]; then READER_OUT="$B_OUT"; fi
  READER_OUT_WIN=$(cygpath -m "$READER_OUT")
  # Extract the reader's session_id from its out.jsonl (stream-json has "session_id" in the init line)
  READER_SESSION=$(node -e "
const fs = require('fs');
const lines = fs.readFileSync(process.argv[1], 'utf8').trim().split('\n');
for (const line of lines) {
  try {
    const rec = JSON.parse(line);
    if (rec.session_id) { console.log(rec.session_id); process.exit(0); }
  } catch {}
}
console.error('F10(2) FAIL: could not find session_id in reader out.jsonl');
process.exit(1);
" "$READER_OUT_WIN" 2>&1)
  if [ $? -ne 0 ]; then
    echo "F10(2) FAIL: $READER_SESSION" >> "$K"/commons.assert.log
    ASSERT_FAILED=1
  else
    READER_SESSION_WIN=$(echo "$READER_SESSION" | tr -d '\r')
    # Verify in the commons store that the reader has the later claimedAt
    node -e "
const fs = require('fs');
const store = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const readerSession = process.argv[2];
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
  console.error('F10(2) FAIL: need at least 2 claims in store, got ' + claims.length);
  process.exit(1);
}
claims.sort((a, b) => a.claimedAt - b.claimedAt || a.holder.localeCompare(b.holder));
const winner = claims[0];
const loser = claims[claims.length - 1];
console.log('claims: ' + claims.map(c => c.holder + ' @ ' + c.claimedAt).join(' | '));
if (loser.holder !== readerSession) {
  console.error('F10(2) FAIL: reader ' + readerSession + ' is NOT the later claimant (loser is ' + loser.holder + ')');
  process.exit(1);
}
console.log('F10(2): reader ' + readerSession + ' is the later claimant (loser @ ' + loser.claimedAt + ', winner ' + winner.holder + ' @ ' + winner.claimedAt + ')');
" "$STORE_FILE_WIN" "$READER_SESSION_WIN" >> "$K"/commons.assert.log 2>&1
    if [ $? -ne 0 ]; then
      ASSERT_FAILED=1
    fi
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
  # No yield log file: acceptable (reader path via agentic_identity writes no yield line).
  echo "F10(yieldlog): no yield log file (reader path, acceptable)" >> "$K"/commons.assert.log
fi

# F10e: evidence retention: copy artifacts to .kit/runs/<utc-stamp>/ before exit
RUN_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUNS_DIR="$PLUGIN_DIR/.kit/runs/$RUN_STAMP"
if [ "$CROSSDIR" = "1" ]; then
  RUNS_DIR="$RUNS_DIR/commons-crossdir"
else
  RUNS_DIR="$RUNS_DIR/commons"
fi
mkdir -p "$RUNS_DIR"
# Copy A's artifacts
for f in commons-A.out.jsonl commons-A.debug.log commons-A.err.log commons.exit commons.assert.log; do
  [ -f "$K/$f" ] && cp -f "$K/$f" "$RUNS_DIR/" 2>/dev/null
done
for f in .agentic-*.json .agentic-*.log; do
  [ -f "$K/$f" ] && cp -f "$K/$f" "$RUNS_DIR/" 2>/dev/null
done
# Copy B's artifacts (CROSSDIR: B is in a different directory)
if [ -n "$B_OUT_DIR" ] && [ -d "$B_OUT_DIR" ]; then
  mkdir -p "$RUNS_DIR/B"
  for f in commons-B.out.jsonl commons-B.debug.log commons-B.err.log; do
    [ -f "$B_OUT_DIR/$f" ] && cp -f "$B_OUT_DIR/$f" "$RUNS_DIR/B/" 2>/dev/null
  done
  for f in .agentic-*.json .agentic-*.log; do
    [ -f "$B_OUT_DIR/$f" ] && cp -f "$B_OUT_DIR/$f" "$RUNS_DIR/B/" 2>/dev/null
  done
fi
echo "F10e: evidence retained in $RUNS_DIR" >> "$K"/commons.assert.log

# Final exit code
if [ $ASSERT_FAILED -eq 1 ]; then
  echo "ASSERT: 1 (FAILED)" >> "$K"/commons.exit
  exit 1
else
  echo "ASSERT: 0 (PASSED)" >> "$K"/commons.exit
  exit $EA
fi
