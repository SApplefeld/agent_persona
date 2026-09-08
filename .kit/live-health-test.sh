#!/usr/bin/env bash
# Live test 8.2: health run.
# F4: plan 8.2 feed: goal_create, goal_done (red), flag removed at t+20s,
#     goal_done (green) at t+40s, done.
# F5: assert env_inject present after health_red (notable: health exit non-zero).
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

# Setup: health probe file and fail flag (in the harness root cwd)
echo "node agentic-plugin/.kit/health-probe.js" > .agentic-health
touch .agentic-health-fail

feed() {
  # Plan 8.2: goal_create, then two goal_done calls with flag removal in between.
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write one haiku\" and maxRounds 3. Then add two plans. Then reply ok."}}'
  sleep 30
  # goal_done for plan 1 (health_red: fail flag exists)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_done with note \"plan 1 done\"."}}'
  sleep 20
  # Flag removed at t+20s
  rm -f .agentic-health-fail
  sleep 20
  # goal_done for plan 2 (health_green: fail flag removed)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_done with note \"plan 2 done\"."}}'
  sleep 20
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
rm -f .agentic-health .agentic-health-fail .agentic-personas.json
exit $EXIT_CODE
