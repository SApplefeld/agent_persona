#!/usr/bin/env bash
# Live test 2: two concurrent sessions on the same persona.
# v0.8.0: per-suite directory, profile-driven timing, --settings.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/yield}"
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
rm -f "$K"/yield-A.out.jsonl "$K"/yield-A.err.log "$K"/yield-B.out.jsonl "$K"/yield-B.err.log "$K"/yield.exit
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE
TOOLS="mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity"

feedA() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"Session A owns default\" and kind fact. Then reply with the single word: ok"}}'
  # Derive from TICK_MS: 2.5 * TICK_MS/1000 (2.5 ticks)
  IDLE_WAIT_S=$(( (25 * TICK_MS) / 10000 ))
  sleep $IDLE_WAIT_S
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

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite
emit_settings_json "settings.json"

feedA | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
  > "$K"/yield-A.out.jsonl 2> "$K"/yield-A.err.log &
PA=$!
# N1: gate Session B on Session A's first write being observed (removes startup race)
wait_for_fact "Session A owns default" || { echo "FAIL: Session A fact not observed" > "$K"/yield.exit; exit 1; }
feedB | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
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
require('fs').writeFileSync('yield.decisions.log', d.join('\n') + '\n');
"
  node "$SCRIPT_DIR/assert-decisions.js" yield .agentic-personas.json "$K/yield.assert.log"
  ASSERT_EXIT=$?
  # M12: yield log must have exactly one line.
  YIELD_LINES=$(wc -l < .agentic-yields.log 2>/dev/null || echo 0)
  if [ "$YIELD_LINES" -eq 1 ]; then
    echo "  OK: yield log has exactly 1 line" >> "$K/yield.assert.log"
  else
    echo "  FAIL: yield log has $YIELD_LINES lines (expected 1)" >> "$K/yield.assert.log"
    ASSERT_EXIT=1
  fi
  echo "ASSERT: $ASSERT_EXIT" >> "$K/yield.exit"
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$K/yield.exit"
    exit 1
  fi
else
  echo "no store at $PWD" >> "$K/yield.exit"
  exit 1
fi
exit $EA
