#!/usr/bin/env bash
# Live test 8.3: error streak.
# v0.8.0: per-suite directory, profile-driven timing, --settings.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/errorstreak}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OUT="$SUITE_DIR/errorstreak-test.out.jsonl"
ERR="$SUITE_DIR/errorstreak-test.err.log"
EXIT="$SUITE_DIR/errorstreak-test.exit"
RUNNING="$SUITE_DIR/RUNNING"
trap 'rm -f "$RUNNING"' EXIT

rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

feed() {
  # Plan 8.3: root objective contains "no bash" so the plugin denies Bash calls.
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"no bash: Write one haiku\" and maxRounds 5. Then reply ok."}}'
  wait_turn 1
  # M1: wait for plan activation before the denials (forces a plan active at either cadence)
  wait_activation
  # G2: tool-forcing prompts (haiku obeys these per Reviewer Q2 probe)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Use the Bash tool now to run exactly: echo hello. Make the tool call even if you expect it to be denied; do not explain, report the result in one line."}}'
  wait_turn 2
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Use the Bash tool now to run exactly: echo world. Make the tool call even if you expect it to be denied; do not explain, report the result in one line."}}'
  wait_turn 3
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Use the Bash tool now to run exactly: echo third. Make the tool call even if you expect it to be denied; do not explain, report the result in one line."}}'
  wait_turn 4
  # I1: tick window (turn 4 closes with streak 3, next tick fires the branch)
  # Derive from TICK_MS: TICK_MS/1000 + 15 s
  sleep $((TICK_MS/1000 + 15))
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
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity,Bash" \
  --model haiku \
  > "$OUT" 2> "$ERR"
EXIT_CODE=$?
echo $EXIT_CODE > "$EXIT"

# P3: write .decisions.log and run assertions.
# G1: no-store guard.
if [ -f .agentic-personas.json ]; then
  # I1 precheck: turn_start decisions must number >= 4 (feed collapse detector)
  TS_COUNT=$(count_turn_starts .agentic-personas.json)
  if [ "$TS_COUNT" -lt 4 ]; then
    echo "PRECHECK FAIL: turn_start count $TS_COUNT < 4 (feed collapse)" >> "$EXIT"
    exit 1
  fi
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('errorstreak.decisions.log', d.join('\n') + '\n');
"
  node "$SCRIPT_DIR/assert-decisions.js" errorstreak .agentic-personas.json "$SUITE_DIR/errorstreak.assert.log"
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
