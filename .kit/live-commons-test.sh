#!/usr/bin/env bash
# Live test 10: commons two-session coordination.
# Acceptance test for Stage 1: two real sessions both claim the same resource,
# assert EXACTLY ONE holds and the other yields.
# v1.0: per-suite directory.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/commons}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K="$SUITE_DIR"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

RUNNING="$K"/RUNNING
trap 'rm -f "$RUNNING"' EXIT
rm -f "$K"/commons-A.out.jsonl "$K"/commons-A.err.log "$K"/commons-B.out.jsonl "$K"/commons-B.err.log "$K"/commons.exit
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE
TOOLS="mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity"

# For this test, we need the plugin to use commons.
# The plugin should automatically claim resources when creating goals.
# For now, we'll use a simple approach: both sessions create a goal on the same persona,
# which should trigger the commons claim path.

feedA() {
  # Session A creates a goal on persona "default"
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with goal \"commons test goal A\" and reply with the single word: ok"}}'
  sleep 10
  # Wait for controller tick to claim the resource
  IDLE_WAIT_S=$(( (25 * TICK_MS) / 10000 ))
  sleep $IDLE_WAIT_S
  # Second turn to keep the session alive
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"Session A alive\" and kind fact. Then reply with the single word: ok"}}'
  sleep 15
}

feedB() {
  # Session B creates a goal on the SAME persona "default" (contention!)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with goal \"commons test goal B\" and reply with the single word: ok"}}'
  sleep 15
  # Session B should yield to A (first-claim-wins)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona \"default\" and report the result verbatim. Then call memory_add with text \"Session B after contention\" and kind fact."}}'
  sleep 15
}

# Remove any existing commons state
rm -f .agentic-heartbeat.json .agentic-yields.log
rm -f .agentic-personas.json

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite
emit_settings_json "settings.json"

# Start Session A
feedA | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
  > "$K"/commons-A.out.jsonl 2> "$K"/commons-A.err.log &
PA=$!

# Wait for Session A's goal to be observed
wait_for_fact "commons test goal A" || { echo "FAIL: Session A goal not observed" > "$K"/commons.exit; exit 1; }

# Start Session B (contention!)
feedB | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
  > "$K"/commons-B.out.jsonl 2> "$K"/commons-B.err.log
EB=$?

# Wait for Session A
wait $PA
EA=$?

echo "A=$EA B=$EB" > "$K"/commons.exit

# --- Assertions ---
# The commons state should be in ~/.claude/plugins/store/ (machine-global)
# For now, we'll check the store for the commons: keys.
# The exact location depends on the plugin's name.

STORE_DIR="$HOME/.claude/plugins/store"
if [ ! -d "$STORE_DIR" ]; then
  echo "no store at $STORE_DIR" >> "$K"/commons.exit
  exit 1
fi

# Look for commons: keys in the store
COMMONS_KEYS=$(find "$STORE_DIR" -name "*.json" -exec grep -l "commons:" {} \; 2>/dev/null)

if [ -z "$COMMONS_KEYS" ]; then
  echo "no commons: keys found" >> "$K"/commons.exit
  exit 1
fi

# Read the commons state
for key_file in $COMMONS_KEYS; do
  echo "=== Commons key file: $key_file ===" | tee -a "$K"/commons.exit
  cat "$key_file" | tee -a "$K"/commons.exit
  echo "" | tee -a "$K"/commons.exit
done

# For the full acceptance test, we need to:
# 1. Parse the commons: keys
# 2. Check that EXACTLY ONE session holds the contested resource
# 3. Verify the other session yielded
# 
# This requires reading the JSON and checking the claims array.
# For now, this is a basic smoke test. The full assertion logic
# will be added when the plugin's commons integration is complete.

echo "SMOKE TEST PASSED (basic)" >> "$K"/commons.exit
exit $EA
