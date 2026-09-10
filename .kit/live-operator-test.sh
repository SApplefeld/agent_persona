#!/usr/bin/env bash
# Live test: operator channel end-to-end (section 5).
# Three phases:
#   1. Message and reply: reader sends agentic_say, owner drains, reader gets reply
#   2. Ask and answer: nudge cap forces ask_opened, reader answers, owner reactivated
#   3. Peer probe: peer text consumed, model never reads it (OPERATOR_HOLD_S > 0 only)
#
# Decision 1: ask is forced by the nudge cap (COST_MAX_NUDGES_PER_HOUR=1), not classifier.
# Decision 2: reader is a real claude -p that calls the tools through the model.
# Decision 3: peer probe is sent by the operator from their session on a file handshake.
#
# OPERATOR_HOLD_S=0 skips phase 3 (unattended gate).
# OPERATOR_HOLD_S=240 (standalone) holds the owner open for the probe.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/operator}"
PROFILE="${PROFILE:-short}"
OPERATOR_HOLD_S="${OPERATOR_HOLD_S:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
if [ -f "$SUITE_DIR/RUNNING" ]; then
  echo "RUNNING exists, refusing" >&2
  exit 8
fi
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OWNER_OUT="$SUITE_DIR/operator-owner.out.jsonl"
OWNER_ERR="$SUITE_DIR/operator-owner.err.log"
OWNER_EXIT="$SUITE_DIR/operator.exit"
READER_OUT="$SUITE_DIR/operator-reader.out.jsonl"
READER_ERR="$SUITE_DIR/operator-reader.err.log"
READER_OUT2="$SUITE_DIR/operator-reader2.out.jsonl"
READER_ERR2="$SUITE_DIR/operator-reader2.err.log"
HANDSHAKE_READY="$SUITE_DIR/operator-hold.ready"
HANDSHAKE_SENT="$SUITE_DIR/operator-probe.sent"

trap 'rm -f "$RUNNING" "$HANDSHAKE_READY" "$HANDSHAKE_SENT"' EXIT

rm -f "$OWNER_OUT" "$OWNER_ERR" "$READER_OUT" "$READER_OUT2" \
      "$HANDSHAKE_READY" "$HANDSHAKE_SENT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

# --- Settings ---
export NUDGE_IDLE_MS=60000
export NUDGE_FLOOR_MS=120000
export TICK_MS=10000
export COST_MAX_NUDGES_PER_HOUR=1
export COST_SUMMARY_EVERY_N_TICKS=3
emit_settings_json "settings.json"

OWNER_TOOLS="mcp__agentic-plugin__goal_create,mcp__agentic-plugin__goal_done,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity,mcp__agentic-plugin__agentic_say,mcp__agentic-plugin__agentic_inbox"
READER_TOOLS="mcp__agentic-plugin__agentic_identity,mcp__agentic-plugin__agentic_say,mcp__agentic-plugin__agentic_inbox,mcp__agentic-plugin__memory_add"

echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# --- F13a: Pre-gate ---
STORE_FILE=""
if [ -d "$HOME/.claude/plugins/store" ]; then
  for f in "$HOME/.claude/plugins/store"/agentic-plugin_*.json; do
    if [ -f "$f" ]; then
      STORE_FILE="$f"
      break
    fi
  done
fi

if [ -n "$STORE_FILE" ] && [ -f "$STORE_FILE" ]; then
  STORE_FILE_PRE=$(cygpath -m "$STORE_FILE" 2>/dev/null || echo "$STORE_FILE")
  STALE_THRESHOLD_MS=90000
  echo "pre-gate: waiting for persona:default to have no live claim..."
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
      echo "pre-gate passed (no live claims)"
      break
    fi
    PRE_GATE_N=$((PRE_GATE_N + 5))
    echo "pre-gate poll: live=${LIVE_CLAIMS} oldest_age=${PRE_GATE_N}s"
    [ $PRE_GATE_N -ge 120 ] && { echo "pre-gate timeout after ${PRE_GATE_N}s"; break; }
    sleep 5
  done
fi

# --- Owner feed: create a wait goal, stay idle ---
# The feed stays open (sleep infinity) so the owner process stays alive.
# The suite kills the owner when done.
feed_owner() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Wait for a signal from the user. The task is NOT complete until the user sends a message. Do not mark the goal as done.\" and maxRounds 10. After creating the goal, stop and wait for the signal from the user. Do not take any more actions. Do not call goal_done. The task is incomplete until the user sends a message."}}'
  OUT="$OWNER_OUT" wait_turn 1
  sleep infinity
}

# --- Phase 1: reader (first turn) ---
feed_reader() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona \"default\". Then call agentic_say with text \"Report your current goal in one line.\" Then call agentic_inbox every 20 seconds until the inbox entry has a reply, and print the reply text verbatim on its own line prefixed REPLY: You must print the REPLY: line before finishing. Do not finish until you have printed REPLY:"}}'
  OUT="$READER_OUT" wait_turn 1
}

# --- Phase 2: reader (second turn, after ask_opened) ---
feed_reader2() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call agentic_inbox. Take the id of the open ask in asks. Call agentic_say with answers set to that id and text \"Proceed with the next step.\" Print DONE."}}'
  OUT="$READER_OUT2" wait_turn 1
}

# --- Poll the store for a decision ---
# Usage: wait_for_decision <action> <timeout_s>
wait_for_decision() {
  local action="$1"
  local timeout_s="$2"
  local elapsed=0
  while [ $elapsed -lt $timeout_s ]; do
    if [ -f .agentic-personas.json ]; then
      FOUND=$(node -e "
try {
  const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json', 'utf8'));
  const d = (s.default.decisions || []);
  console.log(d.some(x => x.action === process.argv[1]) ? '1' : '0');
} catch { console.log('0'); }
" "$action" 2>/dev/null)
      if [ "$FOUND" = "1" ]; then
        return 0
      fi
    fi
    sleep 3; elapsed=$((elapsed + 3))
  done
  return 1
}

# --- Launch owner ---
feed_owner | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "$OWNER_TOOLS" \
  --model haiku \
  > "$OWNER_OUT" 2> "$OWNER_ERR" &
OP=$!

# --- Wait for owner to create the goal (persona_create in store) ---
GOAL_N=0
while [ $GOAL_N -lt 120 ]; do
  if [ -f .agentic-personas.json ]; then
    FOUND=$(node -e "
try {
  const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json', 'utf8'));
  const d = (s.default.decisions || []);
  console.log(d.some(x => x.action === 'persona_create') ? '1' : '0');
} catch { console.log('0'); }
" 2>/dev/null)
    if [ "$FOUND" = "1" ]; then
      break
    fi
  fi
  sleep 3; GOAL_N=$((GOAL_N + 3))
done
if [ ! -f .agentic-personas.json ]; then
  echo "FAIL: owner did not create persona after ${GOAL_N}s" >&2
  kill $OP 2>/dev/null
  exit 1
fi
echo "owner created persona and goal"

# --- Phase 1: reader ---
echo "phase 1: launching reader..."
feed_reader | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "$READER_TOOLS" \
  --model haiku \
  > "$READER_OUT" 2> "$READER_ERR" &
RP=$!
wait $RP
echo "phase 1 reader done"

# --- Wait for operator_delivered and operator_answered ---
wait_for_decision "operator_delivered" 60
if [ $? -eq 0 ]; then
  echo "phase 1: operator_delivered found"
else
  echo "FAIL: operator_delivered not found after 60s" >&2
fi

wait_for_decision "operator_answered" 120
if [ $? -eq 0 ]; then
  echo "phase 1: operator_answered found"
else
  echo "FAIL: operator_answered not found after 120s" >&2
fi

# --- Phase 2: wait for ask_opened (nudge cap fires) ---
echo "phase 2: waiting for ask_opened (nudge cap)..."
wait_for_decision "ask_opened" 300
if [ $? -eq 0 ]; then
  echo "phase 2: ask_opened found"
else
  echo "FAIL: ask_opened not found after 300s" >&2
  kill $OP 2>/dev/null
  exit 1
fi

# --- Phase 2: reader (second turn) ---
echo "phase 2: launching reader2..."
feed_reader2 | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "$READER_TOOLS" \
  --model haiku \
  > "$READER_OUT2" 2> "$READER_ERR2" &
RP2=$!
wait $RP2
echo "phase 2 reader done"

# --- Wait for ask_answered ---
wait_for_decision "ask_answered" 120
if [ $? -eq 0 ]; then
  echo "phase 2: ask_answered found"
else
  echo "FAIL: ask_answered not found after 120s" >&2
fi

# --- Phase 3: peer probe (only when OPERATOR_HOLD_S > 0) ---
PHASE3_SKIPPED=1
if [ "$OPERATOR_HOLD_S" -gt 0 ]; then
  PHASE3_SKIPPED=0
  STAMP="$(date -u +%s)"
  echo "$STAMP" > "$HANDSHAKE_READY"
  echo "phase 3: holding owner open for ${OPERATOR_HOLD_S}s, waiting for probe (stamp: $STAMP)"

  PROBE_N=0
  while [ $PROBE_N -lt "$OPERATOR_HOLD_S" ]; do
    if [ -f "$HANDSHAKE_SENT" ]; then
      break
    fi
    sleep 2; PROBE_N=$((PROBE_N + 2))
  done

  if [ ! -f "$HANDSHAKE_SENT" ]; then
    echo "REPORT: phase 3 timeout (no probe after ${OPERATOR_HOLD_S}s)"
    PHASE3_SKIPPED=1
  else
    # Wait for peer_consumed decision
    wait_for_decision "peer_consumed" 30
    if [ $? -eq 0 ]; then
      echo "phase 3: peer_consumed found"
    else
      echo "FAIL: peer_consumed not found after 30s" >&2
    fi
  fi
fi

# --- Kill owner ---
kill $OP 2>/dev/null
wait $OP 2>/dev/null
OWNER_RC=$?
echo $OWNER_RC > "$OWNER_EXIT"

# --- Write decisions log and run assertions ---
if [ -f .agentic-personas.json ]; then
  node -e "
const fs = require('fs');
try {
  const s = JSON.parse(fs.readFileSync('.agentic-personas.json', 'utf8'));
  const p = Object.keys(s)[0];
  const d = (s[p].decisions || []).map(x =>
    new Date(x.timestamp).toISOString().slice(11, 19) + ' ' +
    x.loop + ' | ' + x.action + ' | ' + (x.detail || '')
  );
  fs.writeFileSync('operator.decisions.log', d.join('\n') + '\n');
  console.log('wrote operator.decisions.log (' + d.length + ' lines)');
} catch (e) {
  console.error('Failed to write decisions log:', e.message);
  process.exit(1);
}
"
  node "$SCRIPT_DIR/assert-decisions.js" operator .agentic-personas.json "$SUITE_DIR/operator.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "$OWNER_EXIT"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$OWNER_EXIT"
    exit 1
  fi
else
  echo "no store at $PWD" >> "$OWNER_EXIT"
  exit 1
fi

# --- Evidence retention ---
STAMP_E="$(date -u +%Y%m%dT%H%M%SZ)"
RUNS_DIR="$PLUGIN_DIR/.kit/runs/$STAMP_E/operator"
mkdir -p "$RUNS_DIR"
for f in operator-owner.out.jsonl operator-owner.err.log operator-reader.out.jsonl \
         operator-reader2.out.jsonl operator.decisions.log operator.assert.log \
         operator.exit settings.json; do
  [ -f "$SUITE_DIR/$f" ] && cp -f "$SUITE_DIR/$f" "$RUNS_DIR/" 2>/dev/null
done
for f in .agentic-*.json; do
  [ -f "$SUITE_DIR/$f" ] && cp -f "$SUITE_DIR/$f" "$RUNS_DIR/" 2>/dev/null
done
echo "evidence retained in $RUNS_DIR"

# --- Phase 3 REPORT ---
if [ $PHASE3_SKIPPED -eq 1 ]; then
  echo "REPORT: phase 3 skipped (no probe)"
else
  echo "REPORT: phase 3 completed (probe sent)"
fi

# --- Cleanup ---
rm -f .agentic-personas.json .agentic-heartbeat.json
exit $OWNER_RC
