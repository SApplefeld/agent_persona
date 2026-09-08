#!/usr/bin/env bash
# Live test 8.1: git probe.
# G1: scratch repo in /d/Temp/agentic-env-repo (outside plugin dir, where the plugin initializes).
# F3: assert ordered dirty=0, dirty=1, dirty=0 (new detail format).
# F7: env_git_null absent (cwd is a git repo).
# G1: no-store guard: if store is absent, FAIL (not silent pass).
set -u
cd /d/DeepSeekHarness || exit 9
OUT=/d/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.out.jsonl
ERR=/d/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.err.log
EXIT=/d/DeepSeekHarness/agentic-plugin/.kit/gitprobe-test.exit
RUNNING=/d/DeepSeekHarness/agentic-plugin/.kit/RUNNING
ENV_REPO=/d/Temp/agentic-env-repo
trap 'rm -f "$RUNNING"' EXIT
rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

# G1: create scratch git repo in /d/Temp (outside the plugin directory)
rm -rf "$ENV_REPO"
mkdir -p "$ENV_REPO"
cd "$ENV_REPO"
git init --quiet
echo ".agentic-*" > .gitignore
git add .gitignore
git -c user.name="test" -c user.email="test@test" commit --quiet -m "init"

# Feed: hold the session long enough for the probes to fire.
# gitProbeMs=120000: first probe at ~120s (dirty 0), dirty file at 60s seen at ~120s (dirty 1),
# commit at 200s seen at ~240s (dirty 0). Hold 390s to be safe.
feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write one haiku\" and maxRounds 3. Then reply ok."}}'
  sleep 390
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 20
}

# F2: dirty file at 60s, commit at 200s (in the env-repo dir)
( sleep 60; echo "untracked" > "$ENV_REPO/untracked.txt"; sleep 140; cd "$ENV_REPO" && git add untracked.txt && git -c user.name="test" -c user.email="test@test" commit --quiet -m "add untracked"; ) &
DIRTY_PID=$!

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
# G1: no-store guard: if store is absent, FAIL.
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
else
  echo "no store at $PWD" >> "$EXIT"
  exit 1
fi
rm -f .agentic-personas.json
rm -rf "$ENV_REPO"
exit $EXIT_CODE
