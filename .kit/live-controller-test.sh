#!/usr/bin/env bash
# Live test 1: controller tick. Holds a piped stream-json session open so the
# 30-second $.clock.every controller tick can fire while the session is idle.
set -u
cd /d/DeepSeekHarness || exit 9
OUT=/d/DeepSeekHarness/agentic-plugin/.kit/ctrl-test.out.jsonl
ERR=/d/DeepSeekHarness/agentic-plugin/.kit/ctrl-test.err.log
EXIT=/d/DeepSeekHarness/agentic-plugin/.kit/ctrl-test.exit
RUNNING=/d/DeepSeekHarness/agentic-plugin/.kit/RUNNING
trap 'rm -f "$RUNNING"' EXIT
rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE
feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write one haiku about rivers, then one about mountains, then one about deserts, one per turn\" and maxRounds 5. Then write the rivers haiku only and stop."}}'
  sleep 330
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 20
}
PLUGIN_DIR=$(cygpath -w /d/DeepSeekHarness/agentic-plugin)
feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$PLUGIN_DIR" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity" \
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
require('fs').writeFileSync('D:/DeepSeekHarness/agentic-plugin/.kit/ctrl-test.decisions.log', d.join('\n') + '\n');
"
  node "D:/DeepSeekHarness/agentic-plugin/.kit/assert-decisions.js" controller .agentic-personas.json "D:/DeepSeekHarness/agentic-plugin/.kit/ctrl-test.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "D:/DeepSeekHarness/agentic-plugin/.kit/ctrl-test.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "D:/DeepSeekHarness/agentic-plugin/.kit/ctrl-test.exit"
    exit 1
  fi
fi
exit $EXIT_CODE
