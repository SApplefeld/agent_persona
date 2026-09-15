#!/usr/bin/env bash
# Live budget suite: the context budget read off the real engine.
# Proves what no offline suite can: the estimate parses the real shape of
# session.messages() and climbs past every threshold as a real turn runs.
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
  # Info: 500 tokens = 2000 chars
  # Closeout: 1000 tokens = 4000 chars
  # Critical: 1500 tokens = 6000 chars
  # Each turn adds ~1000-2000 chars of text (prompt + response + tool call/result).
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 1 - rivers flow through valleys carrying silt from the mountains above, shaping the land they cross and feeding the plains below with their water and their silence\". Then reply with the single word: ok"}}'
  sleep 10
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 2 - mountains stand as ancient witnesses to the passage of time, their peaks touching clouds while their roots plunge deep into the earth, holding together the very foundations of the world\". Then reply with the single word: ok"}}'
  sleep 10
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 3 - deserts stretch out in endless golden waves, their silence speaking louder than any voice, teaching us that emptiness is not void but a kind of fullness, a space where the soul can hear its own heartbeat\". Then reply with the single word: ok"}}'
  sleep 10
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 4 - the budget test requires substantial text to grow the transcript size and cross the closeout threshold, so we add more words here to ensure we have enough characters in the session history\". Then reply with the single word: ok"}}'
  sleep 10
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with content \"budget test turn 5 - this is the final turn with the most text to cross the critical threshold, adding even more words to the session history to ensure we have well over 6000 characters total\". Then reply with the single word: ok"}}'
  # AE5: poll the store for a critical: budget crossing instead of a fixed sleep.
  # Capped at 300 s so a genuinely broken plugin still fails the suite.
  local deadline=$(( $(date +%s) + 300 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).filter(x => x.action === 'context_budget_crossed' && (x.detail||'').startsWith('critical:'));
process.exit(d.length > 0 ? 0 : 1);
" 2>/dev/null; then
      # AN2: hold stdin open 35 s after the critical crossing so the in-flight
      # turn can finish and the cost_summary persist (index.ts:745) can land.
      echo "$(date -u +%FT%TZ) AN2: holding stdin open for 35s after critical crossing" >&2
      sleep 35
      echo "$(date -u +%FT%TZ) AN2: stdin hold complete, closing" >&2
      return 0
    fi
    sleep 5
  done
  return 0
}

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite with low budget thresholds.
# D2: Calibrate the test thresholds to the observed per-turn growth.
# Observed: 5 turns of haiku + memory_add adds ~800 tokens total.
# So: info at 300, closeout at 500, critical at 700.
cat > settings.json << 'EOF'
{
  "pluginConfigs": {
    "agentic-plugin": {
      "options": {
        "contextBudgetEnabled": true,
        "contextBudgetInfoTokens": 300,
        "contextBudgetCloseoutTokens": 500,
        "contextBudgetCriticalTokens": 700,
        "contextBudgetReadEveryNTicks": 1,
        "controllerTickMs": 10000,
        "costSummaryEveryNTicks": 2,
        "arming": "owner"
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
