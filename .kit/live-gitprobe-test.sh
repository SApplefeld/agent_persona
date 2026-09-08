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

# I3: anchor git mutations on the observed first sample.
# Poll the store until it holds env_git first sample, then write untracked file,
# sleep 160 (120s cadence + 30s tick + 10s slack), commit, sleep 160, touch marker.
MARKER="$ENV_REPO/.dirty-cycle-done"
rm -f "$MARKER"

feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"Write one haiku\" and maxRounds 3. Then reply ok."}}'
  # I3: wait for the dirty-cycle marker (ceiling 480s)
  _n=0
  until [ -f "$MARKER" ]; do
    sleep 2; _n=$((_n+2)); [ $_n -ge 480 ] && break
  done
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  sleep 20
}

# I3: anchored dirty cycle job
(
  # Poll the store until it holds env_git first sample
  _store="$ENV_REPO/.agentic-personas.json"
  _n=0
  until grep -q '"env_git"' "$_store" 2>/dev/null; do
    sleep 2; _n=$((_n+2)); [ $_n -ge 180 ] && exit 1
  done
  # Write untracked file (dirty state)
  echo "untracked" > "$ENV_REPO/untracked.txt"
  # Hold dirty state for one probe interval + tick + slack
  sleep 160
  # Commit (clean state)
  cd "$ENV_REPO" && git add untracked.txt && git -c user.name="test" -c user.email="test@test" commit --quiet -m "add untracked"
  # Hold clean state for one probe interval + tick + slack
  sleep 160
  # Touch marker
  touch "$MARKER"
) &
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
