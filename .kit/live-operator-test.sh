#!/usr/bin/env bash
# Live test: operator channel end-to-end (section 5).
# Three phases:
#   1. Message and reply: reader sends agentic_say, owner drains, reader gets reply
#   2. Ask and answer: ask opens (pause/ask-operator/cap), reader answers, owner reactivated
#   3. Peer probe: peer text consumed, model never reads it (OPERATOR_HOLD_S > 0 only)
#
# BD2: one reader coproc, three turns via three writes to its stdin.
# BD4: phase 2 asserts the ask lifecycle, not the opener.
# BD5: phase 1 and phase 3 transcript assertions, evidence retention, exit = assertion verdict.
# BD6: coproc for owner (no sleep in feed), run stamp in SUITE_DIR, handshake with session id.
#
# OPERATOR_HOLD_S=0 skips phase 3 (unattended gate).
# OPERATOR_HOLD_S=240 (standalone) holds the owner open for the probe.
set -u

# --- Configuration ---
STAMP_O="$(date -u +%Y%m%dT%H%M%SZ)"
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/operator-${STAMP_O}}"
PROFILE="${PROFILE:-short}"
OPERATOR_HOLD_S="${OPERATOR_HOLD_S:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
if [ -f "$SUITE_DIR/RUNNING" ]; then
  echo "RUNNING exists, refusing" >&2
  exit 8
fi
rm -rf "$SUITE_DIR" 2>/dev/null || echo "WARN: could not remove old $SUITE_DIR (busy?)"
mkdir -p "$SUITE_DIR" || exit 9
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OWNER_OUT="$SUITE_DIR/operator-owner.out.jsonl"
OWNER_ERR="$SUITE_DIR/operator-owner.err.log"
OWNER_EXIT="$SUITE_DIR/operator.exit"
READER_OUT="$SUITE_DIR/operator-reader.out.jsonl"
READER_ERR="$SUITE_DIR/operator-reader.err.log"
HANDSHAKE_READY="$SUITE_DIR/operator-hold.ready"
HANDSHAKE_SENT="$SUITE_DIR/operator-probe.sent"

# BE8: LOCAL store is where decisions live (persist writes to cwd-relative path).
LOCAL_STORE="$SUITE_DIR/.agentic-personas.json"

RUNNING="$SUITE_DIR/RUNNING"
FAIL_COUNT=0
OWNER_PID=""
READER_PID=""
cleanup() {
  # BD6: kill the claude processes
  if [ -n "${OWNER_PID:-}" ]; then kill "$OWNER_PID" 2>/dev/null; fi
  if [ -n "${READER_PID:-}" ]; then kill "$READER_PID" 2>/dev/null; fi
  wait 2>/dev/null
  rm -f "$RUNNING" "$HANDSHAKE_READY" "$HANDSHAKE_SENT"
}
trap cleanup EXIT

rm -f "$OWNER_OUT" "$OWNER_ERR" "$READER_OUT" \
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

OWNER_TOOLS="mcp__agentic-plugin__goal_create,mcp__agentic-plugin__goal_done,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity"
READER_TOOLS="mcp__agentic-plugin__agentic_identity,mcp__agentic-plugin__agentic_say,mcp__agentic-plugin__agentic_inbox,mcp__agentic-plugin__memory_add"

echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# --- F13a: Pre-gate ---
# BE7: refuse to start over a live holder.
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
    [ $PRE_GATE_N -ge 120 ] && { echo "pre-gate timeout after ${PRE_GATE_N}s" >&2; exit 1; }
    sleep 5
  done
fi

# --- BD6: Owner via coproc (BE6) ---
# BE6: use coproc, not pipe+subshell.
# BE7: owner prompt must NOT ask for agentic_say (owner cannot say).
# Owner: goal_create, then the controller tick should fire ask-operator
# (or pause) after nudgeIdleMs of idle time.
OWNER_DIR="$SUITE_DIR/owner"
mkdir -p "$OWNER_DIR"
cd "$OWNER_DIR"

coproc OWNER {
  claude -p --input-format stream-json --output-format stream-json --verbose \
    --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
    --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
    --allowedTools "$OWNER_TOOLS" \
    --model haiku \
    > "$OWNER_OUT" 2> "$OWNER_ERR"
}
OWNER_PID=$OWNER_PID
IN_O=${OWNER[1]}
echo "owner coproc started pid=$OWNER_PID fd=$IN_O"

# Write the owner's goal prompt
# Use a JSON file to avoid shell quoting issues with nested quotes
OWNER_PROMPT_FILE="$SUITE_DIR/owner-prompt.json"
cat > "$OWNER_PROMPT_FILE" <<'PROMPT'
{"type":"user","message":{"role":"user","content":"Call goal_create with the objective: Wait for a signal from the user. Do not use agentic_say. Do not call goal_done. After calling goal_create, stop and wait. Do not call goal_done. Do not call agentic_say. Do not call agentic_inbox. Just stop after goal_create."}}
PROMPT
cat "$OWNER_PROMPT_FILE" >&"$IN_O"

echo "owner prompt sent, waiting for persona:default claim..."

# --- Wait for owner's persona:default claim to be LIVE in the global commons store ---
STORE_FILE_LAUNCH=""
if [ -d "$HOME/.claude/plugins/store" ]; then
  for f in "$HOME/.claude/plugins/store"/agentic-plugin_*.json; do
    if [ -f "$f" ]; then STORE_FILE_LAUNCH="$f"; break; fi
  done
fi
GOAL_N=0
LIVE="0"
while [ $GOAL_N -lt 120 ]; do
  if [ -n "$STORE_FILE_LAUNCH" ] && [ -f "$STORE_FILE_LAUNCH" ]; then
    STORE_PRE=$(cygpath -m "$STORE_FILE_LAUNCH" 2>/dev/null || echo "$STORE_FILE_LAUNCH")
    LIVE=$(node -e "
const fs = require('fs');
try {
  const store = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const keys = Object.keys(store).filter(k => k.startsWith('commons:'));
  const now = Date.now();
  for (const key of keys) {
    const entry = store[key];
    if (entry.lastSeen && (now - entry.lastSeen) < 90000) {
      if (entry.claims) {
        for (const c of entry.claims) {
          if (c.resource === 'persona:default') { console.log('1'); process.exit(0); }
        }
      }
    }
  }
  console.log('0');
} catch { console.log('0'); }
" "$STORE_PRE" 2>/dev/null)
    if [ "$LIVE" = "1" ]; then
      break
    fi
  fi
  sleep 3; GOAL_N=$((GOAL_N + 3))
done
if [ "$LIVE" != "1" ]; then
  echo "FAIL: owner did not claim persona:default in commons store after ${GOAL_N}s" >&2
  exit 1
fi
echo "owner persona:default claim live in commons store"

# --- BD6: Read owner session id from out.jsonl ---
OWNER_SESSION_ID=""
if [ -f "$OWNER_OUT" ]; then
  OWNER_SESSION_ID=$(node -e "
const fs = require('fs');
try {
  const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'system' && obj.subtype === 'init' && obj.session_id) {
        console.log(obj.session_id);
        break;
      }
    } catch {}
  }
} catch {}
" "$OWNER_OUT" 2>/dev/null)
fi
echo "owner session id: ${OWNER_SESSION_ID:-unknown}"

# --- BD2/BE12: Reader from its OWN directory, one coproc, three turns ---
# BE12: reader runs from its own directory to test cross-directory behavior.
# BE6: use coproc, not pipe+subshell.
READER_DIR="$SUITE_DIR/reader"
mkdir -p "$READER_DIR"
cd "$READER_DIR"

echo "phase 1: launching reader (from $READER_DIR)..."
coproc READER {
  claude -p --input-format stream-json --output-format stream-json --verbose \
    --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
    --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
    --allowedTools "$READER_TOOLS" \
    --model haiku \
    > "$READER_OUT" 2> "$READER_ERR"
}
READER_PID=$READER_PID
IN_R=${READER[1]}
echo "reader coproc started pid=$READER_PID fd=$IN_R"

# --- Helper: wait for a decision in the LOCAL store (BE8) ---
# BE8: decisions live in the LOCAL store (cwd-relative .agentic-personas.json),
# NOT in the global commons store.
LOCAL_STORE_OWNER="$SUITE_DIR/owner/.agentic-personas.json"
wait_for_decision() {
  local action="$1"
  local timeout_s="$2"
  local elapsed=0
  while [ $elapsed -lt $timeout_s ]; do
    if [ -f "$LOCAL_STORE_OWNER" ]; then
      FOUND=$(node -e "
try {
  const s = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  const p = Object.keys(s)[0];
  if (!p) { console.log('0'); process.exit(0); }
  const d = (s[p].decisions || []);
  console.log(d.some(x => x.action === process.argv[1]) ? '1' : '0');
} catch { console.log('0'); }
" "$action" "$LOCAL_STORE_OWNER" 2>/dev/null)
      if [ "$FOUND" = "1" ]; then
        return 0
      fi
    fi
    sleep 3; elapsed=$((elapsed + 3))
  done
  return 1
}

# --- Phase 1: reader turn 1 (identity + say) ---
# Send turn 1 prompt to reader (use file to avoid quoting issues)
READER_P1="$SUITE_DIR/reader-p1.json"
cat > "$READER_P1" <<'PROMPT'
{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona default. Then call agentic_say with text: Report your current goal in one line. Print SENT on its own line. Do not call agentic_inbox yet. Stop after printing SENT."}}
PROMPT
cat "$READER_P1" >&"$IN_R"
echo "phase 1: reader turn 1 sent"

# Wait for the reader's turn 1 to complete
OUT="$READER_OUT" wait_turn 1
echo "phase 1 reader turn 1 done"

# Wait for operator_turn_stamped (BE10: engine stamps the turn, no user line)
if wait_for_decision "operator_turn_stamped" 90; then
  echo "  OK: phase 1 operator_turn_stamped found"
else
  echo "  FAIL: operator_turn_stamped not found after 90s"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Wait for operator_answered (owner's reply)
if wait_for_decision "operator_answered" 120; then
  echo "  OK: phase 1 operator_answered found"
else
  echo "  FAIL: operator_answered not found after 120s"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Phase 1: reader turn 2 (inbox, get reply) ---
echo "phase 1: reader turn 2 (inbox, get reply)..."
READER_P2="$SUITE_DIR/reader-p2.json"
cat > "$READER_P2" <<'PROMPT'
{"type":"user","message":{"role":"user","content":"Call agentic_inbox once. Read the reply text from the inbox entry. Print the reply text verbatim on its own line prefixed REPLY: You must print the REPLY: line before finishing."}}
PROMPT
cat "$READER_P2" >&"$IN_R"

# Wait for the reader's turn 2 to complete
OUT="$READER_OUT" wait_turn 2
echo "phase 1 reader turn 2 done"

# --- BD5: Phase 1 transcript assertions ---
# REPLY: line must be non-empty and equal to the reply record's text in the store
if [ -f "$READER_OUT" ]; then
  REPLY_LINE=""
  if grep -q 'REPLY:' "$READER_OUT" 2>/dev/null; then
    REPLY_LINE=$(node -e "
const fs = require('fs');
try {
  const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n');
  let found = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (found) break;
      if (obj.type === 'assistant' && obj.message && obj.message.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text.includes('REPLY:')) {
            const m = block.text.match(/REPLY:[^\n]*/);
            if (m) { found = m[0]; break; }
          }
        }
      }
      if (!found && obj.type === 'result' && obj.result && obj.result.includes('REPLY:')) {
        const m = obj.result.match(/REPLY:[^\n]*/);
        if (m) { found = m[0]; }
      }
    } catch {}
  }
  if (found) console.log(found);
} catch {}
" "$READER_OUT" 2>/dev/null)
  fi
  if [ -n "$REPLY_LINE" ]; then
    REPLY_TEXT="${REPLY_LINE#REPLY: }"
    REPLY_TEXT="${REPLY_TEXT#REPLY:}"
    REPLY_TEXT="$(echo "$REPLY_TEXT" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -n "$REPLY_TEXT" ]; then
      # BE8: Read the reply record from the GLOBAL store (reply records are in the global store)
      STORE_REPLY_TEXT=""
      if [ -n "$STORE_FILE_LAUNCH" ] && [ -f "$STORE_FILE_LAUNCH" ]; then
        STORE_REPLY_TEXT=$(node -e "
try {
  const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const keys = Object.keys(s).filter(k => k.startsWith('reply:default:'));
  // Get the latest reply record
  if (keys.length > 0) {
    keys.sort();
    const rec = s[keys[keys.length - 1]];
    console.log(rec.text || '');
  }
} catch {}
" "$(cygpath -m "$STORE_FILE_LAUNCH" 2>/dev/null || echo "$STORE_FILE_LAUNCH")" 2>/dev/null)
      fi
      # Compare: exact match, or prefix match (handles trailing text like SENT)
      REPLY_TRIMMED="$(echo "$REPLY_TEXT" | sed 's/[[:space:]]*$//')"
      STORE_TRIMMED="$(echo "$STORE_REPLY_TEXT" | sed 's/[[:space:]]*$//')"
      if [ "$REPLY_TRIMMED" = "$STORE_TRIMMED" ] || \
         { [ -n "$REPLY_TRIMMED" ] && [[ "$STORE_TRIMMED" == "$REPLY_TRIMMED"* ]]; } || \
         { [ -n "$STORE_TRIMMED" ] && [[ "$REPLY_TRIMMED" == "$STORE_TRIMMED"* ]]; }; then
        echo "  OK: REPLY: line matches global store reply text (prefix match)"
      else
        echo "  FAIL: REPLY: line ('$REPLY_TEXT') does not match global store reply text ('$STORE_REPLY_TEXT')"
        FAIL_COUNT=$((FAIL_COUNT + 1))
      fi
    else
      echo "  FAIL: REPLY: line is empty"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  else
    echo "  FAIL: no REPLY: line in reader transcript"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo "  FAIL: reader transcript missing"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- BE10: Phase 1 control: operator_turn_stamped precedes operator_answered ---
# BE8: read from LOCAL store (decisions live there)
if [ -f "$LOCAL_STORE_OWNER" ]; then
  STAMPED_BEFORE_ANSWERED=$(node -e "
try {
  const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const p = Object.keys(s)[0];
  if (!p) { console.log('0'); process.exit(0); }
  const d = (s[p].decisions || []);
  const stampedIdx = d.findIndex(x => x.action === 'operator_turn_stamped');
  const answeredIdx = d.findIndex(x => x.action === 'operator_answered');
  if (stampedIdx !== -1 && answeredIdx !== -1 && stampedIdx < answeredIdx) console.log('1');
  else console.log('0');
} catch { console.log('0'); }
" "$LOCAL_STORE_OWNER" 2>/dev/null)
  if [ "$STAMPED_BEFORE_ANSWERED" = "1" ]; then
    echo "  OK: operator_turn_stamped precedes operator_answered"
  else
    echo "  FAIL: operator_turn_stamped does not precede operator_answered"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo "  FAIL: local store missing for phase 1 control"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Check no user turn carries the reader's text without the [OPERATOR] prefix
if [ -f "$OWNER_OUT" ]; then
  HAS_BARE=$(node -e "
const fs = require('fs');
try {
  const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && obj.message && obj.message.content) {
        const content = typeof obj.message.content === 'string' ? obj.message.content : '';
        if (content.includes('Report your current goal') && !content.startsWith('[OPERATOR] ')) {
          console.log('1'); break;
        }
      }
    } catch {}
  }
  console.log('0');
} catch { console.log('0'); }
" "$OWNER_OUT" 2>/dev/null)
  if [ "$HAS_BARE" = "0" ]; then
    echo "  OK: owner out.jsonl has no bare reader text"
  else
    echo "  FAIL: owner out.jsonl has reader text without [OPERATOR] prefix"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

# --- Phase 2: owner opens the ask (controller ask-operator), reader answers ---
echo "phase 2: waiting for owner to open an ask..."
# The controller tick should fire ask-operator after nudgeIdleMs of idle time.
# Wait for ask_opened in the LOCAL store.
if wait_for_decision "ask_opened" 120; then
  echo "  OK: ask_opened found"
  # REPORT: which path opened it
  ASK_DETAIL=$(node -e "
try {
  const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const p = Object.keys(s)[0];
  if (!p) { console.log('unknown'); process.exit(0); }
  const d = (s[p].decisions || []);
  const ask = d.find(x => x.action === 'ask_opened');
  if (ask) console.log(ask.detail || 'unknown');
  else console.log('unknown');
} catch { console.log('unknown'); }
" "$LOCAL_STORE_OWNER" 2>/dev/null)
  echo "  REPORT: ask opened by: ${ASK_DETAIL}"
else
  echo "  FAIL: ask_opened not found after 120s"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Wait for ask_waiting (at least one)
if wait_for_decision "ask_waiting" 60; then
  echo "  OK: ask_waiting found"
else
  echo "  FAIL: ask_waiting not found after 60s"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Phase 2: reader turn 3 (answer the ask) ---
echo "phase 2: reader turn 3 (answer the ask)..."
# BE9: key on ask id from agentic_inbox asks list, answer with agentic_say(answers=id)
READER_P3="$SUITE_DIR/reader-p3.json"
cat > "$READER_P3" <<'PROMPT'
{"type":"user","message":{"role":"user","content":"Call agentic_inbox once. Look at the asks list. Take the id of the first open ask. Call agentic_say with text: I am here. Please continue. Set the answers field to that ask id. Print DONE on its own line. You must print the DONE line before finishing."}}
PROMPT
cat "$READER_P3" >&"$IN_R"

# Wait for the reader's turn 3 to complete
OUT="$READER_OUT" wait_turn 3
echo "phase 2 reader turn 3 done"

# Wait for ask_answered
if wait_for_decision "ask_answered" 120; then
  echo "  OK: ask_answered found"
else
  echo "  FAIL: ask_answered not found after 120s"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Wait for activated (owner reactivated)
if wait_for_decision "activated" 120; then
  echo "  OK: activated found"
else
  echo "  FAIL: activated not found after 120s"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# BD4: no UNEXPECTED activated between ask_opened and ask_answered (BE8: local store)
# The reactivation that IS the answer processing (detail mentions "answer to ask") is expected.
NO_ACT_BETWEEN=$(node -e "
try {
  const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const p = Object.keys(s)[0];
  if (!p) { console.log('1'); process.exit(0); }
  const d = (s[p].decisions || []);
  const askIdx = d.findIndex(x => x.action === 'ask_opened');
  const ansIdx = d.findIndex(x => x.action === 'ask_answered');
  if (askIdx === -1 || ansIdx === -1 || ansIdx <= askIdx) { console.log('1'); process.exit(0); }
  const between = d.slice(askIdx + 1, ansIdx).filter(x => x.action === 'activated' && !(x.detail || '').includes('answer to ask'));
  console.log(between.length === 0 ? '0' : '1');
} catch { console.log('0'); }
" "$LOCAL_STORE_OWNER" 2>/dev/null)
if [ "$NO_ACT_BETWEEN" = "0" ]; then
  echo "  OK: no unexpected activated between ask_opened and ask_answered"
else
  echo "  FAIL: unexpected activated found between ask_opened and ask_answered"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Stop reader: close stdin (EOF = graceful stop) ---
eval "exec $IN_R>&-"
wait "$READER_PID" 2>/dev/null
echo "reader done"

# --- Phase 3: peer probe (only when OPERATOR_HOLD_S > 0) ---
PHASE3_SKIPPED=1
if [ "$OPERATOR_HOLD_S" -gt 0 ]; then
  PHASE3_SKIPPED=0
  # BD6: handshake carries <stamp> <owner session id>
  echo "${STAMP_O} ${OWNER_SESSION_ID}" > "$HANDSHAKE_READY"
  echo "phase 3: holding owner open for ${OPERATOR_HOLD_S}s, waiting for probe (stamp: ${STAMP_O})"

  PROBE_N=0
  while [ $PROBE_N -lt "$OPERATOR_HOLD_S" ]; do
    if [ -f "$HANDSHAKE_SENT" ]; then
      break
    fi
    sleep 2; PROBE_N=$((PROBE_N + 2))
  done

  if [ ! -f "$HANDSHAKE_SENT" ]; then
    echo "  FAIL: phase 3 timeout (no probe after ${OPERATOR_HOLD_S}s)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    PHASE3_SKIPPED=1
  else
    # Wait for peer_consumed decision
    if wait_for_decision "peer_consumed" 30; then
      echo "  OK: peer_consumed found"
    else
      echo "  FAIL: peer_consumed not found after 30s"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
    # BD5: no line outside decisions carries PEER-PROBE
    HAS_PROBE=$(node -e "
const fs = require('fs');
try {
  const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes('PEER-PROBE')) { console.log('1'); break; }
  }
  console.log('0');
} catch { console.log('0'); }
" "$OWNER_OUT" 2>/dev/null)
    if [ "$HAS_PROBE" = "0" ]; then
      echo "  OK: owner out.jsonl has no PEER-PROBE outside decisions"
    else
      echo "  FAIL: owner out.jsonl has PEER-PROBE line"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  fi
fi

# --- Stop owner: close stdin (EOF = graceful stop) ---
eval "exec $IN_O>&-"
wait "$OWNER_PID" 2>/dev/null
OWNER_RC=$?
echo "$OWNER_RC" > "$OWNER_EXIT"

# --- Write decisions log and run assertions (BE8: local store) ---
if [ -f "$LOCAL_STORE_OWNER" ]; then
  node -e "
const fs = require('fs');
try {
  const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const p = Object.keys(s)[0];
  if (!p) { console.error('No persona in local store'); process.exit(1); }
  const d = (s[p].decisions || []).map(x =>
    new Date(x.timestamp).toISOString().slice(11, 19) + ' ' +
    x.loop + ' | ' + x.action + ' | ' + (x.detail || '')
  );
  fs.writeFileSync(process.argv[1], d.join('\n') + '\n');
  console.log('wrote operator.decisions.log (' + d.length + ' lines)');
} catch (e) {
  console.error('Failed to write decisions log:', e.message);
  process.exit(1);
}
" "$SUITE_DIR/operator.decisions.log" "$LOCAL_STORE_OWNER"
  # BE8: decisions in LOCAL store, ask records in GLOBAL store. Pass both.
  GLOBAL_STORE_CYG=""
  if [ -n "$STORE_FILE_LAUNCH" ] && [ -f "$STORE_FILE_LAUNCH" ]; then
    GLOBAL_STORE_CYG="$(cygpath -m "$STORE_FILE_LAUNCH" 2>/dev/null || echo "$STORE_FILE_LAUNCH")"
  fi
  node "$SCRIPT_DIR/assert-decisions.js" operator "$LOCAL_STORE_OWNER" "$SUITE_DIR/operator.assert.log" "$GLOBAL_STORE_CYG"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "$OWNER_EXIT"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$OWNER_EXIT"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo "no local store at $SUITE_DIR/owner/.agentic-personas.json" >> "$OWNER_EXIT"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- BD5: evidence retention (BE11) ---
STAMP_E="$(date -u +%Y%m%dT%H%M%SZ)"
RUNS_DIR="$PLUGIN_DIR/.kit/runs/$STAMP_E/operator"
mkdir -p "$RUNS_DIR"
for f in operator-owner.out.jsonl operator-owner.err.log operator-reader.out.jsonl \
         operator-reader.err.log operator.decisions.log operator.assert.log \
         operator.exit settings.json; do
  [ -f "$SUITE_DIR/$f" ] && cp -f "$SUITE_DIR/$f" "$RUNS_DIR/" 2>/dev/null
done
# BE11: also retain the local stores and global store snapshot
[ -f "$SUITE_DIR/owner/.agentic-personas.json" ] && cp -f "$SUITE_DIR/owner/.agentic-personas.json" "$RUNS_DIR/owner-personas.json" 2>/dev/null
[ -f "$SUITE_DIR/reader/.agentic-personas.json" ] && cp -f "$SUITE_DIR/reader/.agentic-personas.json" "$RUNS_DIR/reader-personas.json" 2>/dev/null
if [ -n "$STORE_FILE_LAUNCH" ] && [ -f "$STORE_FILE_LAUNCH" ]; then
  cp -f "$STORE_FILE_LAUNCH" "$RUNS_DIR/global-store-snapshot.json" 2>/dev/null
fi
echo "evidence retained in $RUNS_DIR"

# --- Phase 3 REPORT ---
if [ $PHASE3_SKIPPED -eq 1 ]; then
  echo "REPORT: phase 3 skipped (no probe)"
else
  echo "REPORT: phase 3 completed (probe sent)"
fi

# --- BD5: exit = assertion verdict ---
# 0 only when all checks passed; 1 otherwise
if [ $FAIL_COUNT -eq 0 ]; then
  echo "PASS: all operator checks passed"
  exit 0
else
  echo "FAIL: $FAIL_COUNT check(s) failed"
  exit 1
fi
