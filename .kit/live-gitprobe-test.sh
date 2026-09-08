#!/usr/bin/env bash
# Live test 8.1: git probe.
# v0.8.0: per-suite directory (also the scratch repo), profile-driven timing, --settings.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/gitprobe}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OUT="$SUITE_DIR/gitprobe-test.out.jsonl"
ERR="$SUITE_DIR/gitprobe-test.err.log"
EXIT="$SUITE_DIR/gitprobe-test.exit"
RUNNING="$SUITE_DIR/RUNNING"
trap 'rm -f "$RUNNING"' EXIT

rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

# G1: create scratch git repo in the suite directory
git init --quiet
# L2: gitignore everything the suite and runner write there
cat > .gitignore << 'EOF'
.agentic-*
settings.json
*.jsonl
*.log
*.exit
RUNNING
.dirty-cycle-done
EOF
git add .gitignore
git -c user.name="test" -c user.email="test@test" commit --quiet -m "init"

# I3: anchor git mutations on the observed first sample.
# Poll the store until it holds env_git first sample, then write untracked file,
# sleep (GIT_PROBE_MS + TICK_MS + 10s), commit, sleep (GIT_PROBE_MS + TICK_MS + 10s), touch marker.
MARKER="$SUITE_DIR/.dirty-cycle-done"
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
# Derive hold time from GIT_PROBE_MS and TICK_MS: (GIT_PROBE_MS + TICK_MS + 10000) / 1000
HOLD_S=$(( (GIT_PROBE_MS + TICK_MS + 10000) / 1000 ))
(
  # Poll the store until it holds env_git first sample
  _store="$SUITE_DIR/.agentic-personas.json"
  _n=0
  until grep -q '"env_git"' "$_store" 2>/dev/null; do
    sleep 2; _n=$((_n+2)); [ $_n -ge 180 ] && exit 1
  done
  # Write untracked file (dirty state)
  echo "untracked" > "$SUITE_DIR/untracked.txt"
  # Hold dirty state for one probe interval + tick + slack
  sleep $HOLD_S
  # Commit (clean state)
  cd "$SUITE_DIR" && git add untracked.txt && git -c user.name="test" -c user.email="test@test" commit --quiet -m "add untracked"
  # Hold clean state for one probe interval + tick + slack
  sleep $HOLD_S
  # Touch marker
  touch "$MARKER"
) &
DIRTY_PID=$!

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite
emit_settings_json "settings.json"

feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__goal_done,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity" \
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
require('fs').writeFileSync('gitprobe.decisions.log', d.join('\n') + '\n');
"
  node "$SCRIPT_DIR/assert-decisions.js" gitprobe .agentic-personas.json "$SUITE_DIR/gitprobe.assert.log"
  ASSERT_EXIT=$?
  echo "ASSERT: $ASSERT_EXIT" >> "$EXIT"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$EXIT"
    exit 1
  fi
else
  echo "no store at $PWD" >> "$EXIT"
  exit 1
fi
rm -f .agentic-personas.json
exit $EXIT_CODE
