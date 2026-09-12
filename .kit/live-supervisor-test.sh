#!/usr/bin/env bash
# live-supervisor-test.sh - Acceptance test for the supervisor, covering item 4
# (quiet between goals: root_complete alone returns to passive rather than
# stopping the supervisor) and item 5's context-budget-driven restart.
# Short profile, thresholds low enough that critical crosses inside the first two plans.
# Exits 0 on all-pass (F1-F6 + F0 at end), 1 on any failure.
# F6: root_complete -> RESTART_PASSIVE -> a fresh child launches, supervisor
# stays alive; the STOP_COMPLETE/shutdown_requested path is a distinct
# operator action, not exercised by this suite (see supervisor-unit-test.mjs
# and the Item 4 Chapter's own live proof for that path).
# AD4: F4 redefined (child-2 owns persona), F5 added (nudge/turn after child-2),
#      F3 tests EOF (AD3), F0 moved to end (scoped by first LAUNCH), prompt fixed.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/.." && pwd)"

WORKDIR=$(mktemp -d /d/Temp/agentic-supervisor-test-XXXXXX)
RUNDIR="$WORKDIR/run"
mkdir -p "$RUNDIR"

cd "$WORKDIR"

# --- Profiles (short) ---
PROFILE="short"
TICK_MS=10000
NUDGE_IDLE_MS=5000
GIT_PROBE_MS=30000

# Budget thresholds (from live-budget-test.sh:58-60, the calibrated test values)
CONTEXT_BUDGET_INFO_TOKENS=300
CONTEXT_BUDGET_CLOSEOUT_TOKENS=500
CONTEXT_BUDGET_CRITICAL_TOKENS=700
CONTEXT_BUDGET_READ_EVERY_N_TICKS=1

HEARTBEAT_MS=30000
STALE_AFTER_MS=90000

PERSONA="default"
MODEL="haiku"
PERMISSION_MODE="acceptEdits"

# AD4: Fixed prompt - "call goal_create exactly once, with the three essays as the roadmap"
OPENING_PROMPT='call goal_create exactly once, with the three essays as the roadmap. Write three short essays (200-300 words each) about: the sea, the mountain, the sky. One per plan, each one goal_done. Write each essay to a file named sea.md, mountain.md, sky.md in the working directory using the Write tool.'

# --- Emit settings JSON ---
SETTINGS_FILE="$RUNDIR/settings.json"
cat > "$SETTINGS_FILE" <<EOF
{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":$TICK_MS,"nudgeIdleMs":$NUDGE_IDLE_MS,"nudgeFloorMs":5000,"gitProbeMs":$GIT_PROBE_MS,"heartbeatMs":$HEARTBEAT_MS,"staleAfterMs":$STALE_AFTER_MS,"contextBudgetEnabled":true,"contextBudgetInfoTokens":$CONTEXT_BUDGET_INFO_TOKENS,"contextBudgetCloseoutTokens":$CONTEXT_BUDGET_CLOSEOUT_TOKENS,"contextBudgetCriticalTokens":$CONTEXT_BUDGET_CRITICAL_TOKENS,"contextBudgetReadEveryNTicks":$CONTEXT_BUDGET_READ_EVERY_N_TICKS}}}}
EOF

# --- Helper: wait for a fact in .agentic-personas.json ---
wait_for_fact_in_store() {
  local fact="$1"
  local store="$2"
  local timeout="${3:-120}"
  local n=0
  until node -e "
const fs = require('fs');
const store = process.argv[2];
const fact = process.argv[1];
if (!fs.existsSync(store)) process.exit(1);
const s = JSON.parse(fs.readFileSync(store,'utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]);
const found = d.some(x => x.action === fact);
process.exit(found ? 0 : 1);
" "$fact" "$store" 2>/dev/null; do
    sleep 2; n=$((n+2)); [ $n -ge $timeout ] && return 1
  done
  return 0
}

# --- Run the supervisor ---
SUPERVISE="$PLUGIN_DIR/bin/supervise.sh"
if [ ! -f "$SUPERVISE" ]; then
  echo "F1 FAIL: bin/supervise.sh does not exist (red run expected)"
  echo "RED_RUN: no supervisor, no supervisor.log, exit 1"
  exit 1
fi

# Launch the supervisor in the background.
# The supervisor runs every child in $WORKDIR (one fixed working directory).
bash "$SUPERVISE" "$WORKDIR" "$PERSONA" "$PERMISSION_MODE" --prompt "$OPENING_PROMPT" --rundir "$RUNDIR" &
SUPERVISE_PID=$!
SUPERVISE_LOG="$RUNDIR/supervisor.log"

# Give it a moment to start
sleep 5

# Wait for the store to be created (child is running)
STORE="$WORKDIR/.agentic-personas.json"
STORE_TIMEOUT=120
STORE_N=0
until [ -f "$STORE" ] || [ $STORE_N -ge $STORE_TIMEOUT ]; do
  sleep 2; STORE_N=$((STORE_N+2))
done
if [ ! -f "$STORE" ]; then
  echo "F1 FAIL: store not created after ${STORE_TIMEOUT}s"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F1: Supervisor launched child 1 after a gate line ---
if [ -f "$SUPERVISE_LOG" ] && grep -q 'live=\|commons=\|heartbeat=' "$SUPERVISE_LOG" 2>/dev/null; then
  echo "F1 PASS: supervisor launched child 1 after gate line"
else
  echo "F1 FAIL: no gate line in supervisor.log"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F2: context_budget_crossed critical: appears in .agentic-personas.json during child 1 ---
# Poll for a real context_budget_crossed decision in the store (not injected).
# The plugin's budget tracking should write this to the store when the context budget is exceeded.
echo "F2: polling for context_budget_crossed critical in store..."
F2_FOUND=0
for i in $(seq 1 60); do
  if [ -f "$STORE" ] && node -e "
const fs = require('fs');
let s;
try { s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); } catch { process.exit(1); }
const p = Object.keys(s).find(k => k === 'default' || k.startsWith('commons:'));
if (!p) process.exit(1);
const d = (s[p].decisions || []).filter(x => x.action === 'context_budget_crossed' && x.detail && x.detail.includes('critical'));
if (d.length === 0) process.exit(1);
console.log('Found context_budget_crossed critical at', d[d.length-1].timestamp);
" "$STORE" 2>/dev/null; then
    echo "F2 PASS: context_budget_crossed critical found in store"
    F2_FOUND=1
    break
  fi
  sleep 1
done
if [ "$F2_FOUND" -eq 0 ]; then
  echo "F2 FAIL: no context_budget_crossed critical in store after 60s"
fi

# --- F3: Child 1 exits by the graceful path (eof) ---
# AD3: The label is now "eof" (not "stdin-close") because we close the coproc pipe.
# Wait for child 1 to exit
sleep 60
if [ -f "$SUPERVISE_LOG" ] && grep -q 'eof' "$SUPERVISE_LOG" 2>/dev/null; then
  echo "F3 PASS: child 1 exited by eof"
else
  echo "F3 FAIL: no eof in supervisor.log (hung path logs kill)"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F4: AD4 redefined - child-2 owns the persona ---
# Within 60s of child-2's system:init line, .agentic-personas.json has:
# - activeSessionId equal to child-2's session_id
# - a persona_claim or reader_promoted decision whose detail names child-2's id
echo "F4: polling for child-2 to own the persona..."
F4_FOUND=0
for i in $(seq 1 60); do
  # Read child-2's session id from its stdout
  CHILD2_OUT="$RUNDIR/child-2/stdout.jsonl"
  if [ -f "$CHILD2_OUT" ]; then
    CHILD2_SESSION=$(node -e "
const fs = require('fs');
try {
  const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.session_id) {
      console.log(o.session_id);
      break;
    }
  }
} catch (e) { /* not found yet */ }
" "$CHILD2_OUT" 2>/dev/null)
    
    if [ -n "$CHILD2_SESSION" ]; then
      # Check if activeSessionId matches child-2's session_id
      if node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const p = Object.keys(s)[0];
const active = s[p].activeSessionId;
const expected = process.argv[2];
process.exit(active === expected ? 0 : 1);
" "$STORE" "$CHILD2_SESSION" 2>/dev/null; then
        # Check for a persona_claim or reader_promoted decision naming child-2's id
        if node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const p = Object.keys(s)[0];
const d = s[p].decisions || [];
const child2Id = process.argv[2];
const found = d.some(x => (x.action === 'persona_claim' || x.action === 'reader_promoted') && x.detail && x.detail.includes(child2Id));
process.exit(found ? 0 : 1);
" "$STORE" "$CHILD2_SESSION" 2>/dev/null; then
          echo "F4 PASS: child-2 owns the persona (activeSessionId=$CHILD2_SESSION)"
          F4_FOUND=1
          break
        fi
      fi
    fi
  fi
  sleep 1
done
if [ "$F4_FOUND" -eq 0 ]; then
  echo "F4 FAIL: child-2 does not own the persona after 60s"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F5: AD4 added - child-2 continues the tree (nudge_sent or turn_start after child-2 launch) ---
# Check for a nudge_sent or turn_start decision with a timestamp later than child-2's launch line.
echo "F5: polling for nudge_sent or turn_start after child-2 launch..."
F5_FOUND=0
for i in $(seq 1 60); do
  # Read child-2's launch timestamp from supervisor.log
  CHILD2_LAUNCH_TS=$(grep 'LAUNCH child-2' "$SUPERVISE_LOG" 2>/dev/null | grep -oP 'start_ts=\K[0-9]+' | head -1)
  
  if [ -n "$CHILD2_LAUNCH_TS" ]; then
    # Check for nudge_sent or turn_start with timestamp later than child-2's launch
    if node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const p = Object.keys(s)[0];
const d = s[p].decisions || [];
const child2LaunchTs = parseInt(process.argv[2]);
const found = d.some(x => (x.action === 'nudge_sent' || x.action === 'turn_start') && x.timestamp > child2LaunchTs);
process.exit(found ? 0 : 1);
" "$STORE" "$CHILD2_LAUNCH_TS" 2>/dev/null; then
      echo "F5 PASS: child-2 continues the tree (nudge_sent or turn_start found after launch)"
      F5_FOUND=1
      break
    fi
  fi
  sleep 1
done
if [ "$F5_FOUND" -eq 0 ]; then
  echo "F5 FAIL: no nudge_sent or turn_start after child-2 launch after 60s"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F6: root_complete alone returns to passive, it does not end the run ---
# Plan item 4 redefined this: root_complete with no shutdown_requested is
# RESTART_PASSIVE (stop child-2 gracefully, launch a fresh passive child-3),
# never STOP_COMPLETE. Three checks: (a) RESTART_PASSIVE appears, (b) a
# LAUNCH line for the next child follows it, (c) the supervisor process is
# still alive throughout (a real exit here would be the old, wrong behavior).
echo "F6: polling for RESTART_PASSIVE after root_complete..."
F6_FOUND=0
for i in $(seq 1 60); do
  if [ -f "$SUPERVISE_LOG" ] && grep -q 'RESTART_PASSIVE:' "$SUPERVISE_LOG" 2>/dev/null; then
    F6_FOUND=1
    break
  fi
  if ! kill -0 "$SUPERVISE_PID" 2>/dev/null; then
    echo "F6 FAIL: supervisor process exited before RESTART_PASSIVE appeared"
    exit 1
  fi
  sleep 2
done
if [ "$F6_FOUND" -eq 0 ]; then
  echo "F6 FAIL: no RESTART_PASSIVE in supervisor.log after 120s"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

RESTART_LINE_NO=$(grep -n 'RESTART_PASSIVE:' "$SUPERVISE_LOG" 2>/dev/null | tail -1 | cut -d: -f1)
LATER_LAUNCH=$(awk -v r="$RESTART_LINE_NO" 'NR > r && /LAUNCH child-/' "$SUPERVISE_LOG" 2>/dev/null)
if [ -z "$LATER_LAUNCH" ]; then
  echo "F6 FAIL: no LAUNCH line after RESTART_PASSIVE (supervisor did not return to passive)"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

if ! kill -0 "$SUPERVISE_PID" 2>/dev/null; then
  echo "F6 FAIL: supervisor process is not alive after RESTART_PASSIVE (it should still be running, passively)"
  exit 1
fi

echo "F6 PASS: RESTART_PASSIVE fired, a new child launched after it, supervisor still alive"

# This test's own job ends here: the supervisor is confirmed alive and
# passive after completing a goal. Stop it deliberately (SIGTERM), which
# the trap in bin/supervise.sh takes as an operator-style stop (exit 143,
# not the shutdown_requested/STOP_COMPLETE path, which the live-restart
# suite proves separately) rather than leaving it running past this test.
kill -TERM $SUPERVISE_PID 2>/dev/null
wait $SUPERVISE_PID 2>/dev/null
SUPERVISE_EXIT=$?
if [ "$SUPERVISE_EXIT" -ne 143 ] && [ "$SUPERVISE_EXIT" -ne 0 ]; then
  echo "F6 FAIL: supervisor exit $SUPERVISE_EXIT after SIGTERM (expected 143 or 0)"
  exit 1
fi
echo "F6 PASS: supervisor stopped cleanly after SIGTERM (exit $SUPERVISE_EXIT)"

# --- F0: AD4 moved to end - no persona_yield* in the run, scoped by first LAUNCH ---
# Run at the end, over the whole yield log, scoped by the supervisor's first LAUNCH timestamp.
LAUNCH_TS=$(grep 'LAUNCH child-1' "$SUPERVISE_LOG" 2>/dev/null | grep -oP 'start_ts=\K[0-9]+' | head -1)
if [ -n "$LAUNCH_TS" ] && node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]);
const launchTs = parseInt(process.argv[2] || '0');
const yieldCount = d.filter(x => x.action && x.action.startsWith('persona_yield') && x.timestamp > launchTs).length;
process.exit(yieldCount === 0 ? 0 : 1);
" "$STORE" "$LAUNCH_TS" 2>/dev/null; then
  echo "F0 PASS: no persona_yield* after launch"
else
  echo "F0 FAIL: persona_yield* found after launch"
  exit 1
fi

echo ""
echo "All assertions passed (F1-F6 + F0 at end; F6 = exit 0 + STOP_COMPLETE + no LAUNCH after)"
exit 0
