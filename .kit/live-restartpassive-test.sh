#!/usr/bin/env bash
# Live test: item 4 - quiet between goals. A goal completing on its own
# (root_complete, no shutdown_requested) returns bin/supervise.sh to
# passive rather than ending the run: RESTART_PASSIVE fires and a fresh
# child launches, with the supervisor process staying alive throughout.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/restartpassive}"
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
EXIT_FILE="$SUITE_DIR/restartpassive.exit"
ASSERT_LOG="$SUITE_DIR/restartpassive.assert.log"
: > "$ASSERT_LOG"
FAIL_COUNT=0
pass() { echo "OK: $1" | tee -a "$ASSERT_LOG"; }
failed() { echo "FAIL: $1" | tee -a "$ASSERT_LOG"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# One short plan, so root_complete arrives quickly.
PROMPT='Call goal_create with objective "Write a one-line file named done.txt containing the word done" and maxRounds 2. Write the file, then call goal_done.'

bash "$SUPERVISE" "$WORKDIR" "restartpassive-item4-$$" acceptEdits --dev --prompt "$PROMPT" --rundir "$SUITE_DIR" --no-channel \
  > "$SUITE_DIR/supervise.stdout.log" 2>&1 &
SUPERVISE_PID=$!

# --- F1: RESTART_PASSIVE fires (root_complete alone does not stop the run) ---
F1_FOUND=0
for i in $(seq 1 50); do
  if [ -f "$SUPERVISE_LOG" ] && grep -q 'RESTART_PASSIVE:' "$SUPERVISE_LOG" 2>/dev/null; then
    F1_FOUND=1
    break
  fi
  if ! kill -0 "$SUPERVISE_PID" 2>/dev/null; then
    break
  fi
  sleep 3
done
if [ "$F1_FOUND" -eq 1 ]; then pass "F1 RESTART_PASSIVE fired on root_complete"; else failed "F1 RESTART_PASSIVE fired on root_complete"; fi

# --- F2: a fresh child launches after RESTART_PASSIVE ---
F2_FOUND=0
if [ "$F1_FOUND" -eq 1 ]; then
  RESTART_LINE_NO=$(grep -n 'RESTART_PASSIVE:' "$SUPERVISE_LOG" 2>/dev/null | tail -1 | cut -d: -f1)
  for i in $(seq 1 40); do
    LATER_LAUNCH=$(awk -v r="$RESTART_LINE_NO" 'NR > r && /LAUNCH child-/' "$SUPERVISE_LOG" 2>/dev/null)
    if [ -n "$LATER_LAUNCH" ]; then
      F2_FOUND=1
      break
    fi
    sleep 3
  done
fi
if [ "$F2_FOUND" -eq 1 ]; then pass "F2 a fresh passive child launched after RESTART_PASSIVE"; else failed "F2 a fresh passive child launched after RESTART_PASSIVE"; fi

# --- F3: the supervisor process itself is still alive (it did not exit) ---
if kill -0 "$SUPERVISE_PID" 2>/dev/null; then pass "F3 supervisor still alive after returning to passive"; else failed "F3 supervisor still alive after returning to passive"; fi

# --- Stop cleanly ---
kill -TERM "$SUPERVISE_PID" 2>/dev/null
wait "$SUPERVISE_PID" 2>/dev/null
STOP_CODE=$?
if [ "$STOP_CODE" -eq 143 ] || [ "$STOP_CODE" -eq 0 ]; then
  pass "F4 clean stop (exit $STOP_CODE)"
else
  failed "F4 clean stop (got exit $STOP_CODE)"
fi

echo "$FAIL_COUNT" > "$EXIT_FILE"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "live-restartpassive-test.sh: FAIL ($FAIL_COUNT check(s) failed)"
  exit 1
fi
echo "live-restartpassive-test.sh: PASS"
exit 0
