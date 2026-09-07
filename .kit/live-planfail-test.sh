#!/usr/bin/env bash
# Live test 5: planner parse failure (pins H4 + M13).
# M14: the fault flag is a single cwd-relative file, .agentic-planner-fault,
#      created in the harness root (the cwd the store resolves against).
# M13: a failing planner is capped at 3 consecutive failures, then the root is
#      blocked. The run must last long enough (>=150s) for 3 planning ticks to
#      fire so the cap is reached and the root is blocked.
set -u
cd /d/DeepSeekHarness || exit 9
K=/d/DeepSeekHarness/agentic-plugin/.kit
rm -f "$K"/planfail.out.jsonl "$K"/planfail.err.log "$K"/planfail.exit
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE
# H4 / M14: create the fault flag file in the cwd (harness root), delete on exit.
FLAG=/d/DeepSeekHarness/.agentic-planner-fault
touch "$FLAG"
trap 'rm -f "$FLAG"' EXIT

feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write one haiku about the moon\" maxRounds 5. Then reply with the single word: ok"}}'
  # >=150s: 3 planning ticks (30s cadence) so the failure cap of 3 is reached.
  sleep 150
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 20
}
PLUGIN_DIR=$(cygpath -w /d/DeepSeekHarness/agentic-plugin)
feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$PLUGIN_DIR" \
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
require('fs').writeFileSync('D:/DeepSeekHarness/agentic-plugin/.kit/planfail.decisions.log', d.join('\n') + '\n');
"
  node "D:/DeepSeekHarness/agentic-plugin/.kit/assert-decisions.js" planfail .agentic-personas.json "$K/planfail.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "D:/DeepSeekHarness/agentic-plugin/.kit/planfail.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "D:/DeepSeekHarness/agentic-plugin/.kit/planfail.exit"
    exit 1
  fi
fi
exit $EXIT_CODE
