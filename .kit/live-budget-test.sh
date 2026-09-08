#!/usr/bin/env bash
# Live test 9: context budget (2b acceptance test).
# v0.9.0: per-suite directory, profile-driven timing, --settings.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/budget}"
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
rm -f "$K"/budget.out.jsonl "$K"/budget.err.log "$K"/budget.exit
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

feed() {
  # Drive a session past the low test thresholds.
  # D2: Set thresholds so all three cross within about five turns.
  # Info: 500 tokens = 2000 chars (1-2 turns)
  # Closeout: 1000 tokens = 4000 chars (3-4 turns)
  # Critical: 1500 tokens = 6000 chars (5 turns)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 1\". Then reply with the single word: ok"}}'
  sleep 10
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 2 with a bit more text to grow the transcript size for the budget test\". Then reply with the single word: ok"}}'
  sleep 10
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 3 with even more text to grow the transcript size for the budget test and cross the info threshold\". Then reply with the single word: ok"}}'
  sleep 10
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 4 with substantial text to grow the transcript size for the budget test and cross the closeout threshold\". Then reply with the single word: ok"}}'
  sleep 10
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 5 with the most text to grow the transcript size for the budget test and cross the critical threshold\". Then reply with the single word: ok"}}'
  sleep 90
}

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite with low budget thresholds.
# D2: Calibrate the test thresholds to the observed per-turn growth.
cat > settings.json << 'EOF'
{
  "pluginConfigs": {
    "agentic-plugin": {
      "options": {
        "contextBudgetEnabled": true,
        "contextBudgetInfoTokens": 500,
        "contextBudgetCloseoutTokens": 1000,
        "contextBudgetCriticalTokens": 1500,
        "contextBudgetReadEveryNTicks": 1,
        "controllerTickMs": 10000
      }
    }
  }
}
EOF

feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "mcp__agentic-plugin__memory_add" \
  --model haiku \
  > "$K"/budget.out.jsonl 2> "$K"/budget.err.log
EXIT_CODE=$?
echo $EXIT_CODE > "$K"/budget.exit

# P3: write .decisions.log and run assertions.
if [ -f .agentic-personas.json ]; then
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('budget.decisions.log', d.join('\n') + '\n');
"
  node "$SCRIPT_DIR/assert-decisions.js" budget .agentic-personas.json "$K/budget.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "$K"/budget.exit
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$K"/budget.exit
    exit 1
  fi
else
  echo "no store at $PWD" >> "$K"/budget.exit
  exit 1
fi
rm -f .agentic-personas.json
exit $EXIT_CODE
