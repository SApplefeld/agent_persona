#!/usr/bin/env bash
# Live test 2: two concurrent sessions on the same persona.
# A claims and writes. B starts while A is alive (passive reader), gets denied,
# force-claims via agentic_identity, writes. A's next write must yield and
# append one line to .agentic-yields.log.
set -u
cd /d/DeepSeekHarness || exit 9
K=/d/DeepSeekHarness/agentic-plugin/.kit
rm -f "$K"/yield-A.out.jsonl "$K"/yield-A.err.log "$K"/yield-B.out.jsonl "$K"/yield-B.err.log "$K"/yield.exit
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE
TOOLS="mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity"

feedA() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"Session A owns default\" and kind fact. Then reply with the single word: ok"}}'
  sleep 75
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"Session A second write\" and kind fact. Report the tool result verbatim."}}'
  sleep 20
}
feedB() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Do these three tool calls in order and report each result verbatim: 1) memory_add with text \"B first try\" kind fact. 2) agentic_identity with persona \"default\". 3) memory_add with text \"B after claim\" kind fact."}}'
  sleep 15
}

# L16: remove heartbeat file before the test so the sample loop doesn't race.
rm -f .agentic-heartbeat.json .agentic-yields.log
rm -f "$K"/yield-hb.samples
( for i in $(seq 1 28); do echo "$(date +%s) $(tr -d '\n ' < .agentic-heartbeat.json 2>/dev/null)"; sleep 5; done ) > "$K"/yield-hb.samples &
PLUGIN_DIR=$(cygpath -w /d/DeepSeekHarness/agentic-plugin)
feedA | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$PLUGIN_DIR" --allowedTools "$TOOLS" --model haiku \
  > "$K"/yield-A.out.jsonl 2> "$K"/yield-A.err.log &
PA=$!
sleep 30
feedB | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$PLUGIN_DIR" --allowedTools "$TOOLS" --model haiku \
  > "$K"/yield-B.out.jsonl 2> "$K"/yield-B.err.log
EB=$?
wait $PA
EA=$?
echo "A=$EA B=$EB" > "$K"/yield.exit

# P3: write .decisions.log and run assertions.
if [ -f .agentic-personas.json ]; then
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('D:/DeepSeekHarness/agentic-plugin/.kit/yield.decisions.log', d.join('\n') + '\n');
"
  node "D:/DeepSeekHarness/agentic-plugin/.kit/assert-decisions.js" yield .agentic-personas.json "$K/yield.assert.log"
  ASSERT_EXIT=$?
  # M12: yield log must have exactly one line.
  YIELD_LINES=$(wc -l < .agentic-yields.log 2>/dev/null || echo 0)
  if [ "$YIELD_LINES" -eq 1 ]; then
    echo "  OK: yield log has exactly 1 line" >> "$K/yield.assert.log"
  else
    echo "  FAIL: yield log has $YIELD_LINES lines (expected 1)" >> "$K/yield.assert.log"
    ASSERT_EXIT=1
  fi
  echo "ASSERT: $ASSERT_EXIT" >> "D:/DeepSeekHarness/agentic-plugin/.kit/yield.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "D:/DeepSeekHarness/agentic-plugin/.kit/yield.exit"
    exit 1
  fi
fi
exit $EA
