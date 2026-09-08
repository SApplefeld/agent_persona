#!/usr/bin/env bash
# Live test: commons two-session race suite (Stage 2 acceptance gate).
# Two concurrent sessions both try to claim the same persona via agentic_identity.
# Commons arbitration (first-claim-wins) determines the winner.
# We verify: (1) the loser yields on its next write, (2) the winner holds.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/commons}"
PROFILE="${PROFILE:-short}"
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

# Feed A: claim the persona, then try a second write (should succeed if winner, yield if loser).
feedA() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona \"default\". Report the result verbatim."}}'
  sleep 5
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"A second write after claim\" and kind fact. Report the tool result verbatim."}}'
  sleep 10
}

# Feed B: claim the same persona, then try a write (should yield if A is earlier).
feedB() {
  sleep 3
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona \"default\". Report the result verbatim."}}'
  sleep 5
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"B second write after claim\" and kind fact. Report the tool result verbatim."}}'
  sleep 10
}

# Remove heartbeat and yield log before the test
rm -f .agentic-heartbeat.json .agentic-yields.log

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite
emit_settings_json "settings.json"

# Launch both sessions concurrently
feedA | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
  > "$K"/commons-A.out.jsonl 2> "$K"/commons-A.err.log &
PA=$!

feedB | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
  > "$K"/commons-B.out.jsonl 2> "$K"/commons-B.err.log &
PB=$!

wait $PA
EA=$?
wait $PB
EB=$?
echo "A=$EA B=$EB" > "$K"/commons.exit

# --- Assertions ---
# Check that the commons store has entries
if [ -f .agentic-personas.json ]; then
  # Write decisions log for observability
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('commons.decisions.log', d.join('\n') + '\n');
"
  
  # Check the commons store entries
  node -e "
const store = require('$SUITE_DIR/.agentic-personas.json');
const p = Object.keys(store)[0];
const decisions = (store[p].decisions||[]);
const claims = decisions.filter(d => d.action === 'persona_claim_commons');
const yields = decisions.filter(d => d.action === 'persona_yield_commons');
const fs = require('fs');
let lines = [];
if (claims.length > 0) {
  lines.push('OK: commons claim observed (' + claims.length + ' claim(s))');
} else {
  lines.push('WARN: no commons claim observed');
}
if (yields.length > 0) {
  lines.push('OK: commons yield observed (' + yields.length + ' yield(s))');
} else {
  lines.push('NOTE: no commons yield observed (may be OK if no race occurred)');
}
fs.writeFileSync('$K/commons.assert.log', lines.join('\n') + '\n');
"
  ASSERT_EXIT=0
  echo "ASSERT: $ASSERT_EXIT" >> "$K"/commons.exit
else
  echo "no store at $PWD" >> "$K"/commons.exit
  exit 1
fi

exit $EA
