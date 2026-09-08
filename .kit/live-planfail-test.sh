#!/usr/bin/env bash
# Live test 5: planner parse failure (pins H4 + M13).
# v0.8.0: per-suite directory, profile-driven timing, --settings.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/planfail}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K="$SUITE_DIR"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

rm -f "$K"/planfail.out.jsonl "$K"/planfail.err.log "$K"/planfail.exit
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

# H4 / M14: create the fault flag file in the suite cwd
FLAG="$SUITE_DIR/.agentic-planner-fault"
touch "$FLAG"
RUNNING="$K"/RUNNING
trap 'rm -f "$FLAG" "$RUNNING"' EXIT

feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write one haiku about the moon\" maxRounds 5. Then reply with the single word: ok"}}'
  # >=150s: 3 planning ticks so the failure cap of 3 is reached.
  # Derive from TICK_MS: 5 * TICK_MS/1000 (5 ticks to be safe)
  IDLE_WAIT_S=$(( 5 * TICK_MS / 1000 ))
  sleep $IDLE_WAIT_S
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
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__goal_add,mcp__agentic-plugin__goal_done,mcp__agentic-plugin__goal_status,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity" \
  --model haiku \
  > "$K"/planfail.out.jsonl 2> "$K"/planfail.err.log
EXIT_CODE=$?
echo $EXIT_CODE > "$K"/planfail.exit

# P3: write .decisions.log and run assertions.
if [ -f .agentic-personas.json ]; then
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('$K/planfail.decisions.log', d.join('\n') + '\n');
"
  node "$SCRIPT_DIR/assert-decisions.js" planfail .agentic-personas.json "$K/planfail.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "$K/planfail.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$K/planfail.exit"
    exit 1
  fi
else
  echo "no store at $PWD" >> "$K/planfail.exit"
  exit 1
fi
rm -f .agentic-personas.json
exit $EXIT_CODE
