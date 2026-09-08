#!/usr/bin/env bash
# Live test 8.3: error streak.
# F1: root objective "no bash" makes the plugin deny every Bash call.
# F6: assert ordered deny, deny, deny, error_streak, controller_tick, paused_by_controller.
# C5: Bash in --allowedTools; 45s between message 4 and done.
set -u
cd /d/DeepSeekHarness || exit 9
OUT=/d/DeepSeekHarness/agentic-plugin/.kit/errorstreak-test.out.jsonl
ERR=/d/DeepSeekHarness/agentic-plugin/.kit/errorstreak-test.err.log
EXIT=/d/DeepSeekHarness/agentic-plugin/.kit/errorstreak-test.exit
RUNNING=/d/DeepSeekHarness/agentic-plugin/.kit/RUNNING
trap 'rm -f "$RUNNING"' EXIT
rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

feed() {
  # Plan 8.3: root objective contains "no bash" so the plugin denies Bash calls.
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"no bash: Write one haiku\" and maxRounds 5. Then reply ok."}}'
  sleep 30
  # Three Bash calls, each denied by the plugin (counts as tool error).
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Run the command: echo hello"}}'
  sleep 30
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Run the command: echo world"}}'
  sleep 30
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Run the command: echo done"}}'
  # C5: 45s before done (controller tick fires ask-operator).
  sleep 45
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 20
}

PLUGIN_DIR=$(cygpath -w /d/DeepSeekHarness/agentic-plugin)
[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"
feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$PLUGIN_DIR" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__goal_done,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity,Bash" \
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
require('fs').writeFileSync('D:/DeepSeekHarness/agentic-plugin/.kit/errorstreak-test.decisions.log', d.join('\n') + '\n');
"
  node "D:/DeepSeekHarness/agentic-plugin/.kit/assert-decisions.js" errorstreak .agentic-personas.json "D:/DeepSeekHarness/agentic-plugin/.kit/errorstreak-test.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "D:/DeepSeekHarness/agentic-plugin/.kit/errorstreak-test.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "D:/DeepSeekHarness/agentic-plugin/.kit/errorstreak-test.exit"
    exit 1
  fi
fi
rm -f .agentic-personas.json
exit $EXIT_CODE
