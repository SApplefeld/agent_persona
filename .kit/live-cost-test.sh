#!/usr/bin/env bash
# Live test: cost and cadence (item 6, D1-D3).
# v0.9.0: per-suite directory, profile-driven timing, --settings.
#
# Exercises D2 (idle tick skip), D3 (nudge cap), and cost_summary emission.
# Profile (plan v7 section 8):
#   nudgeIdleMs: 60000, nudgeFloorMs: 120000, controllerTickMs: 10000
#   costMaxNudgesPerHour: 2, costSummaryEveryNTicks: 3
#
# Expected decisions (order-based, not tick-based):
#   - Two nudge_sent
#   - One cost_cap_reached
#   - No nudge_sent after cost_cap_reached
#   - At least three controller_tick with "unchanged, skipped"
#   - At least two cost_summary
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/cost}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OUT="$SUITE_DIR/cost-test.out.jsonl"
ERR="$SUITE_DIR/cost-test.err.log"
EXIT="$SUITE_DIR/cost-test.exit"
RUNNING="$SUITE_DIR/RUNNING"
trap 'rm -f "$RUNNING"' EXIT

rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

feed() {
  # Create a goal with maxRounds 1, then tell the worker to stop and wait.
  # This keeps the worker idle so the hash stays unchanged, allowing D2 skip to fire.
  # nudgeIdleMs=60s, controllerTickMs=10s.
  # First nudge at ~60s idle. Worker is idle (stopped), hash unchanged.
  # Second nudge at ~120s idle. Worker is still idle (stopped), hash unchanged.
  # Cap latches after 2 nudges.
  # CRITICAL: The worker must not complete the goal or create new rounds.
  # Use a task that the worker cannot complete (waiting for user input).
  # The worker must not call goal_done until the user sends a message.
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Wait for a signal from the user. The task is NOT complete until the user sends a message. Do not mark the goal as done.\" and maxRounds 10. After creating the goal, stop and wait for the signal from the user. Do not take any more actions. Do not call goal_done. The task is incomplete until the user sends a message."}}'
  wait_turn 1
  # Wait for the controller to tick enough times to exercise D2 skip, nudge, and cap.
  # Use a deadline-based wait: poll the store for cost_cap_reached.
  local deadline=$(( $(date +%s) + 420 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f .agentic-personas.json ]; then
      if node "$SCRIPT_DIR/check-cap-reached.mjs" 2>/dev/null; then
        # Give a few more seconds for the last cost_summary to emit
        sleep 15
        return 0
      fi
    fi
    sleep 5
  done
  return 0
}

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite with cost-specific settings.
export NUDGE_IDLE_MS=60000
export NUDGE_FLOOR_MS=120000
export TICK_MS=10000
export COST_MAX_NUDGES_PER_HOUR=2
export COST_SUMMARY_EVERY_N_TICKS=3
export COST_BACKOFF_AFTER_TICKS=2
emit_settings_json "settings.json"

feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__goal_done,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity" \
  --model haiku \
  > "$OUT" 2> "$ERR"
EXIT_CODE=$?
echo $EXIT_CODE > "$EXIT"

# P3: write .decisions.log and run assertions.
if [ -f .agentic-personas.json ]; then
  node "$SCRIPT_DIR/write-decisions-log.mjs"
  node "$SCRIPT_DIR/assert-decisions.js" cost .agentic-personas.json "$SUITE_DIR/cost.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "$EXIT"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$EXIT"
    exit 1
  fi
else
  echo "no store at $PWD" >> "$EXIT"
  exit 1
fi
rm -f .agentic-personas.json
exit $EXIT_CODE
