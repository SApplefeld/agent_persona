#!/usr/bin/env bash
# Live test 8.2: health run.
# C5: 8.3 adds Bash to --allowedTools, 45s between msg 4 and done.
set -u
cd /d/DeepSeekHarness || exit 9
OUT=/d/DeepSeekHarness/agentic-plugin/.kit/health-test.out.jsonl
ERR=/d/DeepSeekHarness/agentic-plugin/.kit/health-test.err.log
EXIT=/d/DeepSeekHarness/agentic-plugin/.kit/health-test.exit
RUNNING=/d/DeepSeekHarness/agentic-plugin/.kit/RUNNING
trap 'rm -f "$RUNNING"' EXIT
rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

# C5: .agentic-health-fail exists (health probe exits 1)
touch .agentic-health-fail
# C5: .agentic-health = node agentic-plugin/.kit/health-probe.js
echo "node agentic-plugin/.kit/health-probe.js" > .agentic-health

feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Run the health probe\" and maxRounds 5. Then call goal_done with note \"health run complete\"."}}'
  sleep 60
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 45
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
require('fs').writeFileSync('D:/DeepSeekHarness/agentic-plugin/.kit/health-test.decisions.log', d.join('\n') + '\n');
"
  node "D:/DeepSeekHarness/agentic-plugin/.kit/assert-decisions.js" health .agentic-personas.json "D:/DeepSeekHarness/agentic-plugin/.kit/health-test.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "D:/DeepSeekHarness/agentic-plugin/.kit/health-test.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "D:/DeepSeekHarness/agentic-plugin/.kit/health-test.exit"
    exit 1
  fi
fi
rm -f .agentic-health-fail .agentic-health
exit $EXIT_CODE
