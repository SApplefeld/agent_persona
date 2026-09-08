#!/usr/bin/env bash
# Live test 3: goal tree + plan selection (R9 acceptance test).
# v0.8.0: per-suite directory, profile-driven timing, --settings.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/goaltree}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K="$SUITE_DIR"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

RUNNING="$K"/RUNNING
trap 'rm -f "$RUNNING"' EXIT
rm -f "$K"/goaltree.out.jsonl "$K"/goaltree.err.log "$K"/goaltree.exit
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

feed() {
  # L7: align the objective with the fixture so the planner does not invent meta-plans
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write three haikus, one about rivers, one about mountains, one about deserts\" maxRounds 10 and roadmapPath \"D:/DeepSeekHarness/agentic-plugin/.kit/roadmap-test.md\". Then reply with the single word: ok"}}'
  # Derive idle wait from TICK_MS: 13 * TICK_MS/1000 (13 ticks to cover the chain)
  IDLE_WAIT_S=$(( 13 * TICK_MS / 1000 ))
  sleep $IDLE_WAIT_S
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 90
}

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite
emit_settings_json "settings.json"

feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__goal_add,mcp__agentic-plugin__goal_done,mcp__agentic-plugin__goal_status,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity" \
  --model haiku \
  > "$K"/goaltree.out.jsonl 2> "$K"/goaltree.err.log
EXIT_CODE=$?
echo $EXIT_CODE > "$K"/goaltree.exit

# P3: write .decisions.log and run assertions.
if [ -f .agentic-personas.json ]; then
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('goaltree.decisions.log', d.join('\n') + '\n');
"
  node "$SCRIPT_DIR/assert-decisions.js" goaltree .agentic-personas.json "$K/goaltree.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "$K/goaltree.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$K/goaltree.exit"
    exit 1
  fi
else
  echo "no store at $PWD" >> "$K/goaltree.exit"
  exit 1
fi
rm -f .agentic-personas.json
exit $EXIT_CODE
