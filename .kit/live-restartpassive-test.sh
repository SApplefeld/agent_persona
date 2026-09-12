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

# --- F5/F6: v2 Section 0 item 1 - a backfilled root_complete never fires
# RESTART_PASSIVE, and a real (non-backfilled) one still does. Authored per
# Reviewer Round 119 R46; the run is deferred with the rest of this suite
# for the same machine-contention reason named in this section's Chapter -
# not executed as part of this change, so this leg's own pass/fail is not
# yet reflected in $FAIL_COUNT or $EXIT_FILE below.
BACKFILL_WORKDIR="$SUITE_DIR/workdir-backfill"
mkdir -p "$BACKFILL_WORKDIR"
BACKFILL_LOG="$SUITE_DIR/supervisor-backfill.log"
# A one-shot prompt that does real tool work (writes a file) with no
# goal_create call - the exact shape the item 2 backstop backfills a root
# for, and the shape a coordinator or reader steer with no open goal tree
# produces (v2 Section 0 item 1's own motivating incident).
BACKFILL_PROMPT='Write a one-line file named backfill.txt containing the word done. Do not call goal_create.'
bash "$SUPERVISE" "$BACKFILL_WORKDIR" "restartpassive-item0-1-$$" acceptEdits --dev --prompt "$BACKFILL_PROMPT" --rundir "$SUITE_DIR/rundir-backfill" --no-channel \
  > "$SUITE_DIR/supervise-backfill.stdout.log" 2>&1 &
BACKFILL_PID=$!

F5_FOUND=0
F5_NOTE_LINE_NO=0
for i in $(seq 1 50); do
  if [ -f "$BACKFILL_LOG" ] && grep -q 'NOTE:.*backfilled' "$BACKFILL_LOG" 2>/dev/null; then
    F5_FOUND=1
    F5_NOTE_LINE_NO=$(grep -n 'NOTE:.*backfilled' "$BACKFILL_LOG" 2>/dev/null | tail -1 | cut -d: -f1)
    break
  fi
  if ! kill -0 "$BACKFILL_PID" 2>/dev/null; then
    break
  fi
  sleep 3
done
if [ "$F5_FOUND" -eq 1 ]; then pass "F5 a backfilled root_complete logs NOTE, not RESTART_PASSIVE"; else failed "F5 a backfilled root_complete logs NOTE, not RESTART_PASSIVE"; fi

# F6 control: no RESTART_PASSIVE line ever appears after the NOTE (a
# backfilled root must never trigger the passive-restart path at all).
F6_NO_RESTART=1
if [ "$F5_FOUND" -eq 1 ]; then
  AFTER_NOTE=$(awk -v r="$F5_NOTE_LINE_NO" 'NR > r && /RESTART_PASSIVE:/' "$BACKFILL_LOG" 2>/dev/null)
  [ -n "$AFTER_NOTE" ] && F6_NO_RESTART=0
fi
if [ "$F6_NO_RESTART" -eq 1 ]; then pass "F6 no RESTART_PASSIVE line follows the backfilled NOTE"; else failed "F6 no RESTART_PASSIVE line follows the backfilled NOTE"; fi

kill -TERM "$BACKFILL_PID" 2>/dev/null
wait "$BACKFILL_PID" 2>/dev/null

echo "$FAIL_COUNT" > "$EXIT_FILE"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "live-restartpassive-test.sh: FAIL ($FAIL_COUNT check(s) failed)"
  exit 1
fi
echo "live-restartpassive-test.sh: PASS"
exit 0
