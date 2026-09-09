#!/usr/bin/env bash
# live-supervisor-test.sh - Acceptance test for the supervisor (item 5, plan v1).
# Short profile, thresholds low enough that critical crosses inside the first two plans.
# Exits 0 on all-pass (F0-F6), 1 on any failure.

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

# Opening prompt: goal_create with a roadmap of three trivially completable plans.
# Model: the goaltree suite's haiku set.
OPENING_PROMPT='goal_create "Write three haiku (5-7-5 syllables) about: the sea, the mountain, the sky. One per plan, each one goal_done."'

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

# --- F0: No persona_yield* in the run ---
STORE="$WORKDIR/.agentic-personas.json"
sleep 30
if [ -f "$STORE" ] && node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]);
const yieldCount = d.filter(x => x.action && x.action.startsWith('persona_yield')).length;
process.exit(yieldCount === 0 ? 0 : 1);
" "$STORE" 2>/dev/null; then
  echo "F0 PASS: no persona_yield*"
else
  echo "F0 FAIL: persona_yield* found"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F1: Supervisor launched child 1 after a gate line ---
if [ -f "$SUPERVISE_LOG" ] && grep -q 'live=' "$SUPERVISE_LOG" 2>/dev/null; then
  echo "F1 PASS: supervisor launched child 1 after gate line"
else
  echo "F1 FAIL: no gate line in supervisor.log"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F2: context_budget_crossed critical: appears in .agentic-personas.json during child 1 ---
if wait_for_fact_in_store "context_budget_crossed" "$STORE" 300; then
  if node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]);
const crit = d.filter(x => x.action === 'context_budget_crossed' && x.detail && x.detail.includes('critical'));
process.exit(crit.length > 0 ? 0 : 1);
" "$STORE" 2>/dev/null; then
    echo "F2 PASS: context_budget_crossed critical: found"
  else
    echo "F2 FAIL: context_budget_crossed found but no critical:"
    kill $SUPERVISE_PID 2>/dev/null
    exit 1
  fi
else
  echo "F2 FAIL: context_budget_crossed not found in 300s"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F3: Child 1 exits by the graceful path (stdin-close) ---
# Wait for child 1 to exit
sleep 60
if [ -f "$SUPERVISE_LOG" ] && grep -q 'stdin-close' "$SUPERVISE_LOG" 2>/dev/null; then
  echo "F3 PASS: child 1 exited by stdin-close"
else
  echo "F3 FAIL: no stdin-close in supervisor.log (hung path logs kill)"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F4: Gate waited or passed before child 2, child 2 started, same root goal id ---
if wait_for_fact_in_store "goal_create" "$STORE" 300; then
  echo "F4 PASS: child 2 started (goal_create found)"
else
  echo "F4 FAIL: no goal_create found"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F5: Child 2 continues the tree ---
if wait_for_fact_in_store "nudge_sent" "$STORE" 120; then
  echo "F5 PASS: child 2 continues the tree (nudge_sent found)"
else
  echo "F5 FAIL: no nudge_sent found"
  kill $SUPERVISE_PID 2>/dev/null
  exit 1
fi

# --- F6: root_complete ends the run: supervisor exit 0, no child 3 ---
# Wait for the supervisor to finish
wait $SUPERVISE_PID
SUPERVISE_EXIT=$?

if [ $SUPERVISE_EXIT -eq 0 ]; then
  # Check no child-3 directory
  if [ ! -d "$RUNDIR/child-3" ]; then
    echo "F6 PASS: root_complete, supervisor exit 0, no child-3"
  else
    echo "F6 FAIL: child-3 directory exists"
    exit 1
  fi
else
  echo "F6 FAIL: supervisor exit $SUPERVISE_EXIT (expected 0)"
  exit 1
fi

echo ""
echo "All assertions passed (F0-F6)"
exit 0
