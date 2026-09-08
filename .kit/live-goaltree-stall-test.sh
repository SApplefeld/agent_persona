#!/usr/bin/env bash
# Live test 4: goal tree stall (pins H1 + H3).
# One user message: goal_create (no roadmap) + goal_add (plan) + "ok".
# Then 240s silence: tick activates the pending plan (H1), nudge, done,
# planning fires with 0 plans → root complete (H3: root NOT completed by completeLeaf).
# Then "done" (scores nothing).
set -u
cd /d/DeepSeekHarness || exit 9
K=/d/DeepSeekHarness/agentic-plugin/.kit
RUNNING="$K"/RUNNING
trap 'rm -f "$RUNNING"' EXIT
rm -f "$K"/goaltree-stall.out.jsonl "$K"/goaltree-stall.err.log "$K"/goaltree-stall.exit
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE
feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write one haiku about the moon\" maxRounds 5. Then call goal_add with kind plan title \"Write a haiku about the moon\" objective \"One 5-7-5 haiku about the moon\". Then reply with the single word: ok"}}'
  sleep 240
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 20
}
PLUGIN_DIR=$(cygpath -w /d/DeepSeekHarness/agentic-plugin)
[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"
feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$PLUGIN_DIR" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__goal_add,mcp__agentic-plugin__goal_done,mcp__agentic-plugin__goal_status,mcp__agentic-plugin__goal_resume,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity" \
  --model haiku \
  > "$K"/goaltree-stall.out.jsonl 2> "$K"/goaltree-stall.err.log
EXIT_CODE=$?
echo $EXIT_CODE > "$K/goaltree-stall.exit"

# P3: write .decisions.log and run assertions.
if [ -f .agentic-personas.json ]; then
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('D:/DeepSeekHarness/agentic-plugin/.kit/goaltree-stall.decisions.log', d.join('\n') + '\n');
"
  node "D:/DeepSeekHarness/agentic-plugin/.kit/assert-decisions.js" stall .agentic-personas.json "$K/goaltree-stall.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "D:/DeepSeekHarness/agentic-plugin/.kit/goaltree-stall.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "D:/DeepSeekHarness/agentic-plugin/.kit/goaltree-stall.exit"
    exit 1
  fi
else
  echo "no store at $PWD" >> "$K/goaltree-stall.exit"
  exit 1
fi
exit $EXIT_CODE
