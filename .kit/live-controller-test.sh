#!/usr/bin/env bash
# Live test 1: controller tick.
# v0.8.0: per-suite directory, profile-driven timing, --settings.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/controller}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OUT="$SUITE_DIR/ctrl-test.out.jsonl"
ERR="$SUITE_DIR/ctrl-test.err.log"
EXIT="$SUITE_DIR/ctrl-test.exit"
RUNNING="$SUITE_DIR/RUNNING"
trap 'rm -f "$RUNNING"' EXIT

rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

feed() {
  # L5: follow the I1 rule everywhere
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write one haiku about rivers, then one about mountains, then one about deserts, one per turn\" and maxRounds 5. Then write the rivers haiku only and stop."}}'
  wait_turn 1
  # Derive idle wait from NUDGE_IDLE_MS and TICK_MS: (NUDGE_IDLE_MS + TICK_MS + 10000) / 1000
  IDLE_WAIT_S=$(( (NUDGE_IDLE_MS + TICK_MS + 10000) / 1000 ))
  sleep $IDLE_WAIT_S
  # L5: wait for the nudge turn to complete (ceiling 180s)
  wait_turn 2
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  wait_turn 3
  sleep 5
}

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# D1: short profile emits cost_summary every 2 ticks so the live suite exercises it
export COST_SUMMARY_EVERY_N_TICKS="${COST_SUMMARY_EVERY_N_TICKS:-2}"
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
if [ -f .agentic-personas.json ]; then
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('controller.decisions.log', d.join('\n') + '\n');
"
  node "$SCRIPT_DIR/assert-decisions.js" controller .agentic-personas.json "$SUITE_DIR/controller.assert.log"
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
