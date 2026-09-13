#!/usr/bin/env bash
# Live test: item 1 - passive start. bin/supervise.sh launched with no
# --prompt reaches a live, passively-waiting child (GATE PASSED, LAUNCH
# child-1 with no prompt, at least one WAITING line), then stops cleanly.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/passive}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

RUNNING="$SUITE_DIR/RUNNING"
trap 'rm -f "$RUNNING"' EXIT

export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

WORKDIR="$SUITE_DIR/workdir"
mkdir -p "$WORKDIR"
SUPERVISE="$PLUGIN_DIR/bin/supervise.sh"
SUPERVISE_LOG="$SUITE_DIR/supervisor.log"
EXIT_FILE="$SUITE_DIR/passive.exit"
ASSERT_LOG="$SUITE_DIR/passive.assert.log"
: > "$ASSERT_LOG"
FAIL_COUNT=0
pass() { echo "OK: $1" | tee -a "$ASSERT_LOG"; }
failed() { echo "FAIL: $1" | tee -a "$ASSERT_LOG"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Reviewer Round 141 R109: bin/supervise.sh's own default model is now
# opus (v2 Section 0 item 3 Part B) - export MODEL so this suite's child
# still runs at haiku, unaffected by that new default.
export MODEL="haiku"

bash "$SUPERVISE" "$WORKDIR" "passive-item1-$$" acceptEdits --dev --rundir "$SUITE_DIR" --no-channel \
  > "$SUITE_DIR/supervise.stdout.log" 2>&1 &
SUPERVISE_PID=$!

# --- F1: gate line then launch with no prompt ---
F1_FOUND=0
for i in $(seq 1 30); do
  if [ -f "$SUPERVISE_LOG" ] && grep -q 'GATE PASSED' "$SUPERVISE_LOG" 2>/dev/null && grep -q 'LAUNCH child-1 (start_ts=[0-9]*, prompt=)' "$SUPERVISE_LOG" 2>/dev/null; then
    F1_FOUND=1
    break
  fi
  sleep 2
done
if [ "$F1_FOUND" -eq 1 ]; then pass "F1 gate line and no-prompt launch"; else failed "F1 gate line and no-prompt launch"; fi

# --- F2: at least one WAITING line (child alive, passive) ---
F2_FOUND=0
for i in $(seq 1 40); do
  if [ -f "$SUPERVISE_LOG" ] && grep -q 'WAITING: child-1 alive' "$SUPERVISE_LOG" 2>/dev/null; then
    F2_FOUND=1
    break
  fi
  sleep 3
done
if [ "$F2_FOUND" -eq 1 ]; then pass "F2 child alive and waiting passively"; else failed "F2 child alive and waiting passively"; fi

# --- F3: the store lands under WORKDIR, not the launcher's cwd (the cwd fix) ---
if [ -f "$WORKDIR/.agentic-personas.json" ]; then pass "F3 store created under WORKDIR"; else failed "F3 store created under WORKDIR"; fi

# --- Stop cleanly ---
kill -TERM "$SUPERVISE_PID" 2>/dev/null
wait "$SUPERVISE_PID" 2>/dev/null
STOP_CODE=$?
if [ "$STOP_CODE" -eq 143 ] || [ "$STOP_CODE" -eq 0 ]; then
  pass "F4 clean stop (SIGTERM, exit $STOP_CODE)"
else
  failed "F4 clean stop (SIGTERM, got exit $STOP_CODE)"
fi
if grep -q 'CLEANUP:' "$SUPERVISE_LOG" 2>/dev/null; then pass "F5 cleanup path logged"; else failed "F5 cleanup path logged"; fi

echo "$FAIL_COUNT" > "$EXIT_FILE"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "live-passive-test.sh: FAIL ($FAIL_COUNT check(s) failed)"
  exit 1
fi
echo "live-passive-test.sh: PASS"
exit 0
