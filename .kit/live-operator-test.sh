#!/usr/bin/env bash
# Live operator suite: the operator channel across two real claude processes.
# Proves what no offline suite can: a reader process sends agentic_say, the
# owner process drains it and replies, and the reader reads that reply back
# through agentic_inbox, the whole round trip on real transcripts.
#
# One reader coproc, two turns via two writes to its stdin; the owner runs in
# its own coproc. The exit code is the assertion verdict.
set -u

# --- Configuration ---
STAMP_O="$(date -u +%Y%m%dT%H%M%SZ)"
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/operator-${STAMP_O}}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
if [ -f "$SUITE_DIR/RUNNING" ]; then
  echo "RUNNING exists, refusing" >&2
  exit 8
fi

# BG4: process guard - refuse to start if there are live claude -p processes
# Predicate: claude.exe whose CommandLine contains " -p " and carries THIS
# plugin's path as the --plugin-dir flag's own value specifically - not the
# path appearing anywhere in the command line. The bare substring match
# used to trip on a concurrent process whose --settings (or any other
# argument) merely happened to sit under this same repo path, refusing a
# real run over an unrelated sibling; confirmed live (PID 6112, its own
# --settings path, not a --plugin-dir collision).
PLUGIN_DIR_W="$(cygpath -w "$PLUGIN_DIR")"
CLAUDE_PROCS_PIDS=$(pwsh -Command "
\$pattern = '--plugin-dir\s+.{0,2}' + [regex]::Escape('$PLUGIN_DIR_W')
Get-CimInstance Win32_Process | Where-Object {
  \$_.Name -eq 'claude.exe' -and
  \$_.CommandLine -match ' -p ' -and
  \$_.CommandLine -match \$pattern
} | Select-Object -ExpandProperty ProcessId
" 2>/dev/null | grep -E '^[0-9]+$' || true)
if [ -n "$CLAUDE_PROCS_PIDS" ]; then
  CLAUDE_PROCS=$(echo "$CLAUDE_PROCS_PIDS" | wc -l)
else
  CLAUDE_PROCS=0
fi
if [ "$CLAUDE_PROCS" -gt 0 ]; then
  echo "BG4: $CLAUDE_PROCS live claude -p processes found with this plugin-dir, refusing to start" >&2
  echo "PIDs: $CLAUDE_PROCS_PIDS" >&2
  exit 10
fi

rm -rf "$SUITE_DIR" 2>/dev/null || echo "WARN: could not remove old $SUITE_DIR (busy?)"
mkdir -p "$SUITE_DIR" || exit 9
cd "$SUITE_DIR" || exit 9

# BG6: tee suite stdout to operator.suite.log (after directory is created)
exec > >(tee "$SUITE_DIR/operator.suite.log") 2>&1

source "$SCRIPT_DIR/live-common.sh"

OWNER_OUT="$SUITE_DIR/operator-owner.out.jsonl"
OWNER_ERR="$SUITE_DIR/operator-owner.err.log"
OWNER_EXIT="$SUITE_DIR/operator.exit"
READER_OUT="$SUITE_DIR/operator-reader.out.jsonl"
READER_ERR="$SUITE_DIR/operator-reader.err.log"

# BE8: LOCAL store is where decisions live (persist writes to cwd-relative path).
LOCAL_STORE="$SUITE_DIR/.agentic-personas.json"

RUNNING="$SUITE_DIR/RUNNING"
FAIL_COUNT=0
OWNER_PID=""
READER_PID=""
cleanup() {
  # BD6 / plan item 5: escalate EOF -> TERM -> KILL and verify death (see
  # stop_coproc_pid in live-common.sh), so an early-exit run never leaves
  # the coproc's claude process alive holding this persona's claim into
  # the next proof. A bare "kill" here is the gap that bullet closes: it
  # sends one SIGTERM and never checks whether the process actually died.
  stop_coproc_pid "${OWNER_PID:-}" "${IN_O:-}" 5
  stop_coproc_pid "${READER_PID:-}" "${IN_R:-}" 5
  wait 2>/dev/null
  rm -f "$RUNNING"
}
trap cleanup EXIT

rm -f "$OWNER_OUT" "$OWNER_ERR" "$READER_OUT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

# --- Settings ---
export NUDGE_IDLE_MS=60000
export NUDGE_FLOOR_MS=120000
export TICK_MS=10000
export COST_MAX_NUDGES_PER_HOUR=1
export COST_SUMMARY_EVERY_N_TICKS=3
emit_settings_json "settings.json"

OWNER_TOOLS="mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity"
READER_TOOLS="mcp__agentic-plugin__agentic_identity,mcp__agentic-plugin__agentic_say,mcp__agentic-plugin__agentic_inbox,mcp__agentic-plugin__memory_add"

echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# --- F13a: Pre-gate ---
# BE7: refuse to start over a live holder.
STORE_FILE="$(find_global_store)"

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

# --- Find the global store file (needed for the owner-claim wait below
# and the BG3 reply lookup) ---
STORE_FILE_LAUNCH="$(find_global_store)"

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
    --debug-file "$(cygpath -w "$SUITE_DIR/owner-debug.log")" \
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
    --debug-file "$(cygpath -w "$SUITE_DIR/reader-debug.log")" \
    > "$READER_OUT" 2> "$READER_ERR"
}
READER_PID=$READER_PID
IN_R=${READER[1]}
echo "reader coproc started pid=$READER_PID fd=$IN_R"

# --- BG3: Read reader session id from out.jsonl (same pattern as BF6 for owner) ---
READER_SESSION_ID=""
SESSION_POLL_N_R=0
while [ $SESSION_POLL_N_R -lt 30 ]; do
  if [ -f "$READER_OUT" ]; then
    READER_SESSION_ID=$(node -e "
const fs = require('fs');
try {
  const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // Look for any line with a session_id (init, hook_started, etc.)
      if (obj.session_id) {
        console.log(obj.session_id);
        break;
      }
    } catch {}
  }
} catch {}
" "$READER_OUT" 2>/dev/null)
    if [ -n "$READER_SESSION_ID" ]; then
      break
    fi
  fi
  SESSION_POLL_N_R=$((SESSION_POLL_N_R + 1))
  sleep 1
done
echo "reader session id: ${READER_SESSION_ID:-unknown}"

# --- BG4: self-check - verify both coprocs are visible to the process guard ---
# After both coprocs are up, run the same predicate and require count >= 2.
BG4_SELF_CHECK_PIDS=$(pwsh -Command "
\$pattern = '--plugin-dir\s+.{0,2}' + [regex]::Escape('$PLUGIN_DIR_W')
Get-CimInstance Win32_Process | Where-Object {
  \$_.Name -eq 'claude.exe' -and
  \$_.CommandLine -match ' -p ' -and
  \$_.CommandLine -match \$pattern
} | Select-Object -ExpandProperty ProcessId
" 2>/dev/null | grep -E '^[0-9]+$' || true)
if [ -n "$BG4_SELF_CHECK_PIDS" ]; then
  BG4_SELF_CHECK_COUNT=$(echo "$BG4_SELF_CHECK_PIDS" | wc -l)
else
  BG4_SELF_CHECK_COUNT=0
fi
if [ "$BG4_SELF_CHECK_COUNT" -lt 2 ]; then
  echo "  FAIL: BG4 self-check: expected >= 2 claude -p processes, found $BG4_SELF_CHECK_COUNT"
  echo "PIDs: $BG4_SELF_CHECK_PIDS"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo "  OK: BG4 self-check: $BG4_SELF_CHECK_COUNT claude -p processes found (PIDs: $BG4_SELF_CHECK_PIDS)"
fi

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

# Wait for operator_turn_stamped (synchronization only: assert-decisions.js asserts the order)
if wait_for_decision "operator_turn_stamped" 90; then
  echo "  OK: phase 1 operator_turn_stamped found"
else
  echo "  wait: operator_turn_stamped not seen after 90s (assert-decisions.js decides)"
fi

# Wait for operator_answered (synchronization only)
if wait_for_decision "operator_answered" 120; then
  echo "  OK: phase 1 operator_answered found"
else
  echo "  wait: operator_answered not seen after 120s (assert-decisions.js decides)"
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

# --- BD5: Phase 1 transcript assertion (BG3 primary) ---
# BG3 primary: in operator-reader.out.jsonl, turn 2's agentic_inbox tool result
#   parses as JSON, inbox entry id === default-<reader sid>-1 has status "answered"
#   and reply.text equals the store record's text.
if [ -f "$READER_OUT" ] && [ -n "$READER_SESSION_ID" ] && [ -n "$STORE_FILE_LAUNCH" ] && [ -f "$STORE_FILE_LAUNCH" ]; then
  # Get the expected reply record: reply:default:default-<reader sid>-1
  EXPECTED_REPLY_KEY="reply:default:default-${READER_SESSION_ID}-1"
  STORE_REPLY_TEXT=""
  STORE_REPLY_STATUS=""
  if STORE_REPLY_DATA=$(node -e "
try {
  const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const key = process.argv[2];
  if (s[key]) {
    console.log(JSON.stringify({ text: s[key].text || '', status: s[key].status || '' }));
  }
} catch {}
" "$(cygpath -m "$STORE_FILE_LAUNCH" 2>/dev/null || echo "$STORE_FILE_LAUNCH")" "$EXPECTED_REPLY_KEY" 2>/dev/null); then
    if [ -n "$STORE_REPLY_DATA" ]; then
      STORE_REPLY_TEXT=$(echo "$STORE_REPLY_DATA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).text||'')}catch{}})")
      STORE_REPLY_STATUS=$(echo "$STORE_REPLY_DATA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).status||'')}catch{}})")
    fi
  fi
  
  # BG3 primary: check inbox tool result in turn 2
  INBOX_CHECK=$(node -e "
const fs = require('fs');
try {
  const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n');
  const expectedId = process.argv[2];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // Look for agentic_inbox tool result in user message content
      if (obj.type === 'user' && obj.message && obj.message.content) {
        for (const c of obj.message.content) {
          if (c.type === 'tool_result' && c.content && typeof c.content === 'string') {
            let inboxData;
            try {
              inboxData = JSON.parse(c.content);
            } catch { continue; }
            if (inboxData.inbox) {
              const entry = inboxData.inbox.find(e => e.id === expectedId);
              if (entry) {
                console.log(JSON.stringify({ status: entry.status || '', replyText: entry.reply || '' }));
                process.exit(0);
              }
            }
          }
        }
      }
    } catch {}
  }
} catch {}
" "$READER_OUT" "default-${READER_SESSION_ID}-1" 2>/dev/null)
  
  if [ -n "$INBOX_CHECK" ]; then
    INBOX_STATUS=$(echo "$INBOX_CHECK" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).status||'')}catch{}})")
    INBOX_REPLY_TEXT=$(echo "$INBOX_CHECK" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).replyText||'')}catch{}})")
    
    if [ "$INBOX_STATUS" = "answered" ] && [ -n "$INBOX_REPLY_TEXT" ] && [ "$INBOX_REPLY_TEXT" = "$STORE_REPLY_TEXT" ]; then
      echo "  OK: BG3 primary: inbox entry answered, reply.text matches store"
    else
      echo "  FAIL: BG3 primary: inbox entry status='$INBOX_STATUS' (expected 'answered'), replyText='$INBOX_REPLY_TEXT' (expected '$STORE_REPLY_TEXT')"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  else
    echo "  FAIL: BG3 primary: no agentic_inbox tool result with id default-${READER_SESSION_ID}-1"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  
else
  echo "  FAIL: BG3: missing prerequisites (reader transcript, session id, or global store)"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Stop reader: close stdin (EOF = graceful stop) ---
eval "exec $IN_R>&-"
wait "$READER_PID" 2>/dev/null
echo "reader done"

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
  node "$SCRIPT_DIR/assert-decisions.js" operator "$LOCAL_STORE_OWNER" "$SUITE_DIR/operator.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "$OWNER_EXIT"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$OWNER_EXIT"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  # BG6: append SUITE: <FAIL_COUNT> as last line
  echo "SUITE: $FAIL_COUNT" >> "$OWNER_EXIT"
else
  echo "no local store at $SUITE_DIR/owner/.agentic-personas.json" >> "$OWNER_EXIT"
  # BG6: append SUITE: <FAIL_COUNT> as last line
  echo "SUITE: $FAIL_COUNT" >> "$OWNER_EXIT"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- BD5: evidence retention (BE11) ---
# Use RUN_DIR if set (when run by live-all.sh), otherwise use STAMP_O
if [ -n "${RUN_DIR:-}" ]; then
  RUNS_DIR="$RUN_DIR/operator"
else
  RUNS_DIR="$PLUGIN_DIR/.kit/runs/$STAMP_O/operator"
fi
mkdir -p "$RUNS_DIR"
for f in operator-owner.out.jsonl operator-owner.err.log operator-reader.out.jsonl \
         operator-reader.err.log operator.decisions.log operator.assert.log \
         operator.exit settings.json; do
  [ -f "$SUITE_DIR/$f" ] && cp -f "$SUITE_DIR/$f" "$RUNS_DIR/" 2>/dev/null
done
# BG6: retain debug logs
[ -f "$SUITE_DIR/owner-debug.log" ] && cp -f "$SUITE_DIR/owner-debug.log" "$RUNS_DIR/owner-debug.log" 2>/dev/null
[ -f "$SUITE_DIR/reader-debug.log" ] && cp -f "$SUITE_DIR/reader-debug.log" "$RUNS_DIR/reader-debug.log" 2>/dev/null
# BE11: also retain the local stores and global store snapshot
[ -f "$SUITE_DIR/owner/.agentic-personas.json" ] && cp -f "$SUITE_DIR/owner/.agentic-personas.json" "$RUNS_DIR/owner-personas.json" 2>/dev/null
[ -f "$SUITE_DIR/reader/.agentic-personas.json" ] && cp -f "$SUITE_DIR/reader/.agentic-personas.json" "$RUNS_DIR/reader-personas.json" 2>/dev/null
# Retain the owner's channel-rollover log so a post-mortem read can see what
# left the store and why.
[ -f "$SUITE_DIR/owner/.agentic-channel.jsonl" ] && cp -f "$SUITE_DIR/owner/.agentic-channel.jsonl" "$RUNS_DIR/owner-channel.jsonl" 2>/dev/null
if [ -n "$STORE_FILE_LAUNCH" ] && [ -f "$STORE_FILE_LAUNCH" ]; then
  cp -f "$STORE_FILE_LAUNCH" "$RUNS_DIR/global-store-snapshot.json" 2>/dev/null
fi
# BG6: retain suite stdout
if [ -f "$SUITE_DIR/operator.suite.log" ]; then
  cp -f "$SUITE_DIR/operator.suite.log" "$RUNS_DIR/operator.suite.log" 2>/dev/null
fi
echo "evidence retained in $RUNS_DIR"

# --- BD5: exit = assertion verdict ---
# 0 only when all checks passed; 1 otherwise
if [ $FAIL_COUNT -eq 0 ]; then
  echo "PASS: all operator checks passed"
  exit 0
else
  echo "FAIL: $FAIL_COUNT check(s) failed"
  exit 1
fi
