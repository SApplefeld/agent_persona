#!/usr/bin/env bash
# Live test 3: goal tree + plan selection (R9 acceptance test).
# One user message: goal_create with roadmap + "ok". Then 6 min silence
# (controller ticks fire: planning → activate → nudge → score → done → activate).
# Then "done" (scores nothing).
# Expected chain: create → plan(3) → activate → nudge_sent → score → done →
#                  activate → (repeat ×3) → plan(0) → root complete.
set -u
cd /d/DeepSeekHarness || exit 9
K=/d/DeepSeekHarness/agentic-plugin/.kit
RUNNING="$K"/RUNNING
trap 'rm -f "$RUNNING"' EXIT
rm -f "$K"/goaltree.out.jsonl "$K"/goaltree.err.log "$K"/goaltree.exit
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE
feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write three haikus as per the roadmap file\" maxRounds 10 and roadmapPath \"D:/DeepSeekHarness/agentic-plugin/.kit/roadmap-test.md\". Then reply with the single word: ok"}}'
  sleep 390
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 90
}
PLUGIN_DIR=$(cygpath -w /d/DeepSeekHarness/agentic-plugin)
[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"
feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$PLUGIN_DIR" \
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
require('fs').writeFileSync('D:/DeepSeekHarness/agentic-plugin/.kit/goaltree.decisions.log', d.join('\n') + '\n');
"
  node "D:/DeepSeekHarness/agentic-plugin/.kit/assert-decisions.js" goaltree .agentic-personas.json "$K/goaltree.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "D:/DeepSeekHarness/agentic-plugin/.kit/goaltree.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "D:/DeepSeekHarness/agentic-plugin/.kit/goaltree.exit"
    exit 1
  fi
else
  echo "no store at $PWD" >> "$K/goaltree.exit"
  exit 1
fi
exit $EXIT_CODE
