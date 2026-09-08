#!/usr/bin/env bash
# Live test 8.2: health run.
# v0.8.0: per-suite directory, profile-driven timing, --settings.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/health}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HARNESS_ROOT="$(cd "$PLUGIN_DIR/.." && pwd)"
HEALTH_PROBE="$PLUGIN_DIR/.kit/health-probe.js"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OUT="$SUITE_DIR/health-test.out.jsonl"
ERR="$SUITE_DIR/health-test.err.log"
EXIT="$SUITE_DIR/health-test.exit"
RUNNING="$SUITE_DIR/RUNNING"
trap 'rm -f "$RUNNING"' EXIT

rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

# Setup: health probe file and fail flag (in the suite cwd)
echo "node $(cygpath -w "$HEALTH_PROBE")" > .agentic-health
touch .agentic-health-fail

feed() {
  # Plan 8.2: goal_create, then two goal_done calls with flag removal in between.
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write one haiku\" and maxRounds 3. Then add two plans. Then reply ok."}}'
  wait_turn 1
  # I1: wait for activation (tick needs the turn closed first)
  wait_activation
  # goal_done for plan 1 (health_red: fail flag exists)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_done with note \"plan 1 done\"."}}'
  wait_turn 2
  # Flag removed
  rm -f .agentic-health-fail
  # goal_done for plan 2 (health_green: fail flag removed)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_done with note \"plan 2 done\"."}}'
  wait_turn 3
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 20
}

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite
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
# G1: no-store guard.
if [ -f .agentic-personas.json ]; then
  # I1 precheck: turn_start decisions must number >= 3 (feed collapse detector)
  TS_COUNT=$(count_turn_starts .agentic-personas.json)
  if [ "$TS_COUNT" -lt 3 ]; then
    echo "PRECHECK FAIL: turn_start count $TS_COUNT < 3 (feed collapse)" >> "$EXIT"
    exit 1
  fi
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('$SUITE_DIR/health.decisions.log', d.join('\n') + '\n');
"
  node "$SCRIPT_DIR/assert-decisions.js" health .agentic-personas.json "$SUITE_DIR/health.assert.log"
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
rm -f .agentic-health .agentic-health-fail .agentic-personas.json
exit $EXIT_CODE
