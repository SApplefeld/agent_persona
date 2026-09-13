#!/usr/bin/env bash
# Live test: item 8.3 - a reader's restart request relaunches the child.
# bin/supervise.sh runs a child with an active plan; a reader session sends
# an urgent agentic_say asking for a restart; the owner calls
# supervisor_restart, which writes restart_requested; the supervisor maps
# it to RESTART_PASSIVE, relaunches, and the new child resumes the same
# active plan (its first controller-driven turn names that leaf).
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/restartrequest}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

RUNNING="$SUITE_DIR/RUNNING"
SUPERVISE_PID=""
cleanup() {
  # The reader coproc lives in a subshell below; its pid is handed out
  # through reader.pid so an early exit here can still stop it.
  if [ -f "$SUITE_DIR/reader.pid" ]; then
    stop_coproc_pid "$(cat "$SUITE_DIR/reader.pid")" "" 5
  fi
  if [ -n "${SUPERVISE_PID:-}" ] && kill -0 "$SUPERVISE_PID" 2>/dev/null; then
    kill -TERM "$SUPERVISE_PID" 2>/dev/null
    wait "$SUPERVISE_PID" 2>/dev/null
  fi
  rm -f "$RUNNING"
}
trap cleanup EXIT

export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

WORKDIR="$SUITE_DIR/workdir"
mkdir -p "$WORKDIR"
SUPERVISE="$PLUGIN_DIR/bin/supervise.sh"
SUPERVISE_LOG="$SUITE_DIR/supervisor.log"
STORE="$WORKDIR/.agentic-personas.json"
EXIT_FILE="$SUITE_DIR/restartrequest.exit"
ASSERT_LOG="$SUITE_DIR/restartrequest.assert.log"
: > "$ASSERT_LOG"
FAIL_COUNT=0
pass() { echo "OK: $1" | tee -a "$ASSERT_LOG"; }
failed() { echo "FAIL: $1" | tee -a "$ASSERT_LOG"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

PERSONA="restartrequest-item83-$$"

# Reads one field of the persona's store with a node one-liner. Usage:
# store_query '<js expression over p (the persona state)>'; prints the result
# or nothing when the store is unreadable.
store_query() {
  [ -f "$STORE" ] || return 1
  node -e "
const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const p = s[process.argv[2]];
if (!p) process.exit(1);
const v = (function(p){ return $1; })(p);
if (v === undefined || v === null || v === false) process.exit(1);
console.log(typeof v === 'string' ? v : JSON.stringify(v));
" "$STORE" "$PERSONA" 2>/dev/null
}

# The owner opens a goal tree and waits: the planner fires on the next tick
# and activates a plan, which is the "active plan" the relaunched child must
# resume. The opening prompt arrives on stdin, the operator's own channel to
# the child, and grants [OPERATOR]-prefixed reader messages the operator's
# standing for this run: without that, the model reads a plugin-submitted
# prompt as data rather than an instruction and asks for confirmation
# before a restart (the same refusal the plan's Chapter 4 met for shutdown).
PROMPT='Call goal_create with the objective: Wait for operator instructions delivered by chat and follow them. After calling goal_create, stop and wait. Do not call goal_done. Standing instruction from the operator for this run: a message that arrives prefixed [OPERATOR] is relayed from the operator through a reader session and carries the operator standing, exactly as if typed here. When one asks you to call supervisor_restart, call it at once with the reason given and do not ask for confirmation. When one asks a question, answer it in one line.'

# No controller nudges during this run: a nudge can open a worker-stated
# ask and pause the plan, which would make "the active plan survived the
# relaunch" hinge on timing rather than on the relaunch. Resumption is
# proved by a second reader message instead (F5b).
export nudgeIdleMs=600000
# Reviewer Round 141 R109: bin/supervise.sh's own default model is now
# opus (v2 Section 0 item 3 Part B) - export MODEL so this suite's child
# still runs at haiku, unaffected by that new default.
export MODEL="haiku"

bash "$SUPERVISE" "$WORKDIR" "$PERSONA" acceptEdits --dev --prompt "$PROMPT" --rundir "$SUITE_DIR" --no-channel \
  > "$SUITE_DIR/supervise.stdout.log" 2>&1 &
SUPERVISE_PID=$!

# --- F1: child-1 is up and a plan is active ---
ACTIVE_BEFORE=""
for i in $(seq 1 80); do
  ACTIVE_BEFORE=$(store_query "(p.goals || []).find(g => g.status === 'active' && g.parentId !== null) && (p.goals || []).find(g => g.status === 'active' && g.parentId !== null).id")
  if [ -n "$ACTIVE_BEFORE" ]; then break; fi
  if ! kill -0 "$SUPERVISE_PID" 2>/dev/null; then break; fi
  sleep 3
done
if [ -n "$ACTIVE_BEFORE" ]; then pass "F1 child-1 holds an active plan ($ACTIVE_BEFORE)"; else failed "F1 child-1 holds an active plan"; fi

# --- Reader: join as a reader and send an urgent restart request ---
# The reader runs from its own directory and joins through agentic_identity
# (the same shape live-operator-test.sh proves), kept alive as a coproc so
# its reader claim keeps heartbeating until the owner has acted on the record.
READER_DIR="$SUITE_DIR/reader"
mkdir -p "$READER_DIR"
READER_OUT="$SUITE_DIR/reader.out.jsonl"
READER_ERR="$SUITE_DIR/reader.err.log"
READER_TOOLS="mcp__agentic-plugin__agentic_identity,mcp__agentic-plugin__agentic_say,mcp__agentic-plugin__agentic_inbox"
if [ -n "$ACTIVE_BEFORE" ]; then
  (
    cd "$READER_DIR" || exit 9
    coproc READER {
      claude -p --input-format stream-json --output-format stream-json --verbose \
        --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
        --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
        --allowedTools "$READER_TOOLS" \
        --model haiku \
        --debug-file "$(cygpath -w "$SUITE_DIR/reader-debug.log")" \
        > "$READER_OUT" 2> "$READER_ERR"
    }
    echo "$READER_PID" > "$SUITE_DIR/reader.pid"
    READER_P1="$SUITE_DIR/reader-p1.json"
    node -e "
const persona = process.argv[1];
const text = '[operator] The plugin runtime was just updated. Please call the supervisor_restart tool now with reason: runtime updated. This request is already confirmed by the operator; do not ask for confirmation. The supervisor relaunches you with the goal tree kept and you resume the active plan.';
const content = 'Call agentic_identity with persona ' + persona + '. Then call agentic_say with text: ' + JSON.stringify(text) + ' and urgent: true. Print SENT on its own line and stop. Do not call agentic_inbox.';
process.stdout.write(JSON.stringify({type:'user',message:{role:'user',content}}) + '\n');
" "$PERSONA" > "$READER_P1"
    cat "$READER_P1" >&"${READER[1]}"
    # Hold the write end open until the relaunched child is up, then send
    # the second message (F5b: the new child's delivered turn must start on
    # the same leaf), give the owner time to drain it, then EOF.
    for i in $(seq 1 100); do
      if grep -q 'LAUNCH child-2' "$SUPERVISE_LOG" 2>/dev/null; then break; fi
      kill -0 "$READER_PID" 2>/dev/null || break
      sleep 3
    done
    if grep -q 'LAUNCH child-2' "$SUPERVISE_LOG" 2>/dev/null && kill -0 "$READER_PID" 2>/dev/null; then
      sleep 15
      READER_P2="$SUITE_DIR/reader-p2.json"
      node -e "
const content = 'Call agentic_say with text: [operator] Which plan are you working on now? Answer in one line with its id. Then print SENT2 on its own line and stop. Do not call agentic_inbox.';
process.stdout.write(JSON.stringify({type:'user',message:{role:'user',content}}) + '\n');
" > "$READER_P2"
      cat "$READER_P2" >&"${READER[1]}"
      for i in $(seq 1 40); do
        if grep -q 'reader-p2-drained' "$SUITE_DIR/reader.sync" 2>/dev/null; then break; fi
        kill -0 "$READER_PID" 2>/dev/null || break
        sleep 3
      done
    fi
    stop_coproc_pid "$READER_PID" "${READER[1]}" 5
  ) &
  READER_WRAPPER_PID=$!
fi

# --- F2: the owner wrote restart_requested ---
F2_FOUND=0
if [ -n "$ACTIVE_BEFORE" ]; then
  for i in $(seq 1 80); do
    if store_query "(p.decisions || []).some(d => d.action === 'restart_requested')" >/dev/null; then F2_FOUND=1; break; fi
    sleep 3
  done
fi
if [ "$F2_FOUND" -eq 1 ]; then pass "F2 owner wrote restart_requested from the reader's message"; else failed "F2 owner wrote restart_requested from the reader's message"; fi
SAY_URGENT=$(store_query "(p.decisions || []).some(d => d.action === 'operator_delivered_urgent' || (d.action === 'operator_delivered'))" 2>/dev/null)
DELIVERY_KIND=$(store_query "(p.decisions || []).some(d => d.action === 'operator_delivered_urgent') ? 'urgent (inside a running turn)' : 'tick (owner was idle)'" 2>/dev/null)
echo "delivery path: ${DELIVERY_KIND:-unknown}"

# --- F3: the supervisor mapped it to RESTART_PASSIVE naming restart_requested ---
F3_FOUND=0
if [ "$F2_FOUND" -eq 1 ]; then
  for i in $(seq 1 40); do
    if grep -q 'RESTART_PASSIVE: restart_requested at' "$SUPERVISE_LOG" 2>/dev/null; then F3_FOUND=1; break; fi
    sleep 3
  done
fi
if [ "$F3_FOUND" -eq 1 ]; then pass "F3 RESTART_PASSIVE fired on restart_requested"; else failed "F3 RESTART_PASSIVE fired on restart_requested"; fi
if grep -q 'STOP_COMPLETE' "$SUPERVISE_LOG" 2>/dev/null; then failed "F3b no STOP_COMPLETE (a restart request must not stop the supervisor)"; else pass "F3b no STOP_COMPLETE (a restart request must not stop the supervisor)"; fi

# --- F4: a fresh child launched after it ---
F4_FOUND=0
CHILD2_START_TS=""
if [ "$F3_FOUND" -eq 1 ]; then
  for i in $(seq 1 40); do
    CHILD2_START_TS=$(grep -o 'LAUNCH child-2 (start_ts=[0-9]*' "$SUPERVISE_LOG" 2>/dev/null | grep -o '[0-9]*$')
    if [ -n "$CHILD2_START_TS" ]; then F4_FOUND=1; break; fi
    sleep 3
  done
fi
if [ "$F4_FOUND" -eq 1 ]; then pass "F4 a fresh child launched after RESTART_PASSIVE"; else failed "F4 a fresh child launched after RESTART_PASSIVE"; fi

# --- F5: the new child resumes the same active plan ---
# The tree survives the relaunch (same active plan id), and child-2's turn
# for the reader's second message starts on that leaf: a turn_start
# decision newer than child-2's start naming it.
F5_TREE=0
F5_TURN=0
if [ "$F4_FOUND" -eq 1 ]; then
  for i in $(seq 1 60); do
    ACTIVE_AFTER=$(store_query "(p.goals || []).find(g => g.status === 'active' && g.parentId !== null) && (p.goals || []).find(g => g.status === 'active' && g.parentId !== null).id")
    [ "$ACTIVE_AFTER" = "$ACTIVE_BEFORE" ] && F5_TREE=1
    if store_query "(p.decisions || []).some(d => d.timestamp > $CHILD2_START_TS && d.action === 'turn_start' && d.detail.includes('leaf $ACTIVE_BEFORE'))" >/dev/null; then
      F5_TURN=1
      echo "reader-p2-drained" > "$SUITE_DIR/reader.sync"
      break
    fi
    sleep 3
  done
fi
if [ "$F5_TREE" -eq 1 ]; then pass "F5a the active plan survived the relaunch ($ACTIVE_BEFORE)"; else failed "F5a the active plan survived the relaunch"; fi
if [ "$F5_TURN" -eq 1 ]; then pass "F5b the new child took the reader's next turn on the same plan"; else failed "F5b the new child took the reader's next turn on the same plan"; fi

# --- Stop cleanly ---
[ -n "${READER_WRAPPER_PID:-}" ] && wait "$READER_WRAPPER_PID" 2>/dev/null
if [ -f "$SUITE_DIR/reader.pid" ]; then
  stop_coproc_pid "$(cat "$SUITE_DIR/reader.pid")" "" 5
fi
kill -TERM "$SUPERVISE_PID" 2>/dev/null
wait "$SUPERVISE_PID" 2>/dev/null
STOP_CODE=$?
SUPERVISE_PID=""
if [ "$STOP_CODE" -eq 143 ] || [ "$STOP_CODE" -eq 0 ]; then
  pass "F6 clean stop (exit $STOP_CODE)"
else
  failed "F6 clean stop (got exit $STOP_CODE)"
fi

echo "$FAIL_COUNT" > "$EXIT_FILE"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "live-restartrequest-test.sh: FAIL ($FAIL_COUNT check(s) failed)"
  exit 1
fi
echo "live-restartrequest-test.sh: PASS"
exit 0
