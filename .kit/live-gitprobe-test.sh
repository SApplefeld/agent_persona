#!/usr/bin/env bash
# Live test 8.1: git probe.
# C6: first probe at first tick (~30s) sees dirty 0; hold 390s; dirty 1 at ~150s; dirty 0 at ~270s.
set -u
cd /d/DeepSeekHarness || exit 9
OUT=/d/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.out.jsonl
ERR=/d/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.err.log
EXIT=/d/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.exit
RUNNING=/d/DeepSeekHarness/agentic-plugin/.kit/RUNNING
trap 'rm -f "$RUNNING"' EXIT
rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

# C6: .gitignore with .agentic-*
printf '.agentic-*\n' > .gitignore
# C6: .agentic-health = node agentic-plugin/.kit/health-probe.js
echo "node agentic-plugin/.kit/health-probe.js" > .agentic-health

# Create a dirty state at ~150s and clean at ~270s.
( sleep 120; echo "dirty" > .gitprobe-dirty; touch .gitprobe-dirty-file; sleep 120; rm -f .gitprobe-dirty-file .gitprobe-dirty; ) &
DIRTY_PID=$!

feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Wait 390 seconds\" and maxRounds 10. Then reply with the single word: done"}}'
  sleep 390
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 20
}
PLUGIN_DIR=$(cygpath -w /d/DeepSeekHarness/agentic-plugin)
[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"
feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$PLUGIN_DIR" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity" \
  --model haiku \
  > "$OUT" 2> "$ERR"
EXIT_CODE=$?
wait $DIRTY_PID 2>/dev/null
echo $EXIT_CODE > "$EXIT"

# P3: write .decisions.log and run assertions.
if [ -f .agentic-personas.json ]; then
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('D:/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.decisions.log', d.join('\n') + '\n');
"
  node "D:/DeepSeekHarness/agentic-plugin/.kit/assert-decisions.js" gitprobe .agentic-personas.json "D:/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "D:/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "D:/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.exit"
    exit 1
  fi
fi
rm -f .gitignore .agentic-health .gitprobe-dirty .gitprobe-dirty-file
exit $EXIT_CODE
