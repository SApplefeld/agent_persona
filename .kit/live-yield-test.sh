#!/usr/bin/env bash
# Live test: two concurrent sessions on the same persona.
# BJ3: Rewrite to test the refusal semantics (phase 1) and then the takeover semantics (phase 2).
# Since bafeb70 (BC3), a claimant that finds a live earlier holder does not take ownership.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/yield}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
K="$SUITE_DIR"
RUNS_DIR="${RUNS_DIR:-$K}"

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

# L16: remove heartbeat file before the test so the sample loop doesn't race.
rm -f .agentic-heartbeat.json .agentic-yields.log

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite
emit_settings_json "settings.json"

# --- Phase 1: Refusal ---
# A starts and writes; B starts, calls agentic_identity, its tool result names A's session as the live holder.
# No identity_set, no yield line, B's memory_add after the attempt is denied with the "held by a live session" text.
# A's second write persists.

feedA() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"Session A owns default\" and kind fact. Then reply with the single word: ok"}}'
  # Derive from TICK_MS: 2.5 * TICK_MS/1000 (2.5 ticks)
  IDLE_WAIT_S=$(( (25 * TICK_MS) / 10000 ))
  sleep $IDLE_WAIT_S
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call memory_add with text \"Session A second write\" and kind fact. Report the tool result verbatim."}}'
  sleep 20
}
feedB() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Do these three tool calls in order and report each result verbatim: 1) agentic_identity with persona \"default\". 2) memory_add with text \"B after claim\" kind fact. 3) Reply with the single word: done."}}'
  sleep 15
}

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
echo "PHASE1: A=$EA B=$EB" >> "$K"/yield.exit

# --- Phase 2: Takeover ---
# Close A's stdin, poll the global store until A's commons:<A sid> record is older than staleAfterMs.
# Then B calls agentic_identity: persona_claim_commons with winner B, identity_set, B's write persists.

# Extract A's session id from the store.
A_SID=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const sid = s[p].mySessionId;
console.log(sid);
" 2>/dev/null || echo "")

if [ -n "$A_SID" ]; then
  # Poll the global store until A's commons record is older than staleAfterMs.
  # staleAfterMs is 90s by default, but we can check the store's updatedAt field.
  STALE_AFTER_MS=90000
  START_POLL=$(date +%s)
  TIMEOUT=120
  while true; do
    NOW=$(date +%s)
    ELAPSED=$(( NOW - START_POLL ))
    if [ $ELAPSED -ge $TIMEOUT ]; then
      echo "PHASE2: timeout waiting for A to go stale" >> "$K"/yield.exit
      break
    fi
    # Check if A's commons record is older than staleAfterMs.
    IS_STALE=$(node -e "
    const store = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
    const p = Object.keys(store)[0];
    const now = Date.now();
    const updatedAt = store[p].updatedAt || 0;
    const staleAfter = $STALE_AFTER_MS;
    console.log(now - updatedAt > staleAfter ? 'yes' : 'no');
    " 2>/dev/null || echo "no")
    if [ "$IS_STALE" = "yes" ]; then
      echo "PHASE2: A is stale, B can take over" >> "$K"/yield.exit
      break
    fi
    sleep 5
  done
fi

# B takes over (if A went stale).
feedB2() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Do these two tool calls in order and report each result verbatim: 1) agentic_identity with persona \"default\". 2) memory_add with text \"B takeover\" kind fact. Reply with the single word: done."}}'
  sleep 15
}

if [ -n "$A_SID" ]; then
  feedB2 | claude -p --input-format stream-json --output-format stream-json --verbose \
    --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" --settings "$(cygpath -w "$SUITE_DIR/settings.json")" --allowedTools "$TOOLS" --model haiku \
    > "$K"/yield-B2.out.jsonl 2> "$K"/yield-B2.err.log
  EB2=$?
  echo "PHASE2: B2=$EB2" >> "$K"/yield.exit
fi

# --- Assertions ---
# Write .decisions.log and run assertions.
if [ -f .agentic-personas.json ]; then
  node -e "
  const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
  const p = Object.keys(s)[0];
  const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
  require('fs').writeFileSync('yield.decisions.log', d.join('\n') + '\n');
  "
  node "$SCRIPT_DIR/assert-decisions.js" yield .agentic-personas.json "$K/yield.assert.log"
  ASSERT_EXIT=$?
  # BJ3: No yield log line is expected (the design is refusal, not yield).
  # Instead, check that B's identity call did NOT result in identity_set.
  if [ -f .agentic-yields.log ]; then
    YIELD_LINES=$(wc -l < .agentic-yields.log 2>/dev/null || echo 0)
    if [ "$YIELD_LINES" -gt 0 ]; then
      echo "  FAIL: yield log has $YIELD_LINES lines (expected 0, design is refusal not yield)" >> "$K/yield.assert.log"
      ASSERT_EXIT=1
    else
      echo "  OK: yield log has 0 lines (design is refusal, not yield)" >> "$K/yield.assert.log"
    fi
  else
    echo "  OK: yield log does not exist (design is refusal, not yield)" >> "$K/yield.assert.log"
  fi
  echo "ASSERT: $ASSERT_EXIT" >> "$K"/yield.exit
  if [ $ASSERT_EXIT -ne 0 ]; then
    echo "Assertion failed" >> "$K"/yield.exit
    exit 1
  fi
else
  echo "no store at $PWD" >> "$K"/yield.exit
  exit 1
fi
exit $EA
