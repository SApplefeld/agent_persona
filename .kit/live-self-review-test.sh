#!/usr/bin/env bash
# Live test: self-review (lessons from the decision log).
# Reuses live-errorstreak-test.sh induction (tool denials produce error turns).
# Assertions on persisted facts: F1-F6.
# Usage: PROFILE=short bash .kit/live-self-review-test.sh
# Exits 0 on success, 1 on failure.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/self-review}"
PROFILE="${PROFILE:-short}"
SELF_REVIEW_EVERY_TURNS=3
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
export SELF_REVIEW_EVERY_TURNS
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OUT="$SUITE_DIR/self-review-test.out.jsonl"
ERR="$SUITE_DIR/self-review-test.err.log"
EXIT="$SUITE_DIR/self-review-test.exit"
RUNNING="$SUITE_DIR/RUNNING"
trap 'rm -f "$RUNNING"' EXIT

rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

feed() {
  # Induction: reuse errorstreak pattern (tool denials produce error turns).
  # A turn counts as an error turn when reason === "error" or toolErrors > 0 (agent-state.ts:519).
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"no bash: Write one haiku\" and maxRounds 5. Then reply ok."}}'
  wait_turn 1
  wait_activation
  # Three tool-forcing prompts (denied -> error turns)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Use the Bash tool now to run exactly: echo hello. Make the tool call even if you expect it to be denied; do not explain, report the result in one line."}}'
  wait_turn 2
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Use the Bash tool now to run exactly: echo world. Make the tool call even if you expect it to be denied; do not explain, report the result in one line."}}'
  wait_turn 3
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Use the Bash tool now to run exactly: echo third. Make the tool call even if you expect it to be denied; do not explain, report the result in one line."}}'
  wait_turn 4
  # Tick window: let the tick fire the error-streak branch + self-review
  sleep $((TICK_MS/1000 + 20))
  # Extra turn so lesson_inject can fire on the next prompt.submit
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  wait_turn 5
  sleep 20
}

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json for this suite (short profile: selfReviewEveryTurns=3)
emit_settings_json "settings.json"
echo "settings.json: $(cat settings.json)"

feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity,Bash" \
  --model haiku \
  > "$OUT" 2> "$ERR"
EXIT_CODE=$?
echo $EXIT_CODE > "$EXIT"

# --- Assertions (F1-F6, on persisted facts) ---
RESULT=0

if [ -f .agentic-personas.json ]; then
  # Write .decisions.log for inspection
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('self-review.decisions.log', d.join('\n') + '\n');
"

  # F1: an error_streak decision exists (proves the streak reached >= 3 and was handled)
  # Note: consecutiveErrorTurns is reset by turn.complete (applyTurnToErrors), so
  # the live value at assertion time may be 0. The error_streak decision is the
  # durable proof that the streak triggered.
  F1=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).filter(x => x.action === 'error_streak');
console.log(d.length > 0 ? 'YES' : 'NO');
")
  if [ "$F1" = "YES" ]; then
    echo "F1: PASS (error_streak decision found, streak reached >= 3)"
  else
    echo "F1: FAIL (no error_streak decision)"
    RESULT=1
  fi

  # F2: decisions log contains action=self-review
  F2=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).filter(x => x.action === 'self-review');
console.log(d.length > 0 ? 'YES' : 'NO');
")
  if [ "$F2" = "YES" ]; then
    echo "F2: PASS (self-review decision found)"
  else
    echo "F2: FAIL (no self-review decision)"
    RESULT=1
  fi

  # F3: memory array contains MemoryEntry with source=self-review and provenance
  F3=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const m = (s[p].memory||[]).filter(x => x.source === 'self-review' && x.provenance && Array.isArray(x.provenance.decisionTimestamps) && x.provenance.decisionTimestamps.length > 0);
console.log(m.length > 0 ? 'YES' : 'NO');
")
  if [ "$F3" = "YES" ]; then
    echo "F3: PASS (self-review lesson with provenance found)"
  else
    echo "F3: FAIL (no self-review lesson with provenance)"
    RESULT=1
  fi

  # F4: decisions log contains action=lesson_inject
  F4=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).filter(x => x.action === 'lesson_inject');
console.log(d.length > 0 ? 'YES' : 'NO');
")
  if [ "$F4" = "YES" ]; then
    echo "F4: PASS (lesson_inject decision found)"
  else
    echo "F4: FAIL (no lesson_inject decision)"
    RESULT=1
  fi

  # F5: monitor.selfReview.count >= 1
  F5=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
console.log((s[p].monitor && s[p].monitor.selfReview && s[p].monitor.selfReview.count) || 0);
")
  if [ "$F5" -ge 1 ] 2>/dev/null; then
    echo "F5: PASS (selfReview.count=$F5)"
  else
    echo "F5: FAIL (selfReview.count=${F5:-missing})"
    RESULT=1
  fi

  # F6: monitor.selfReview.lastAt > 0 (a review was executed and lastAt was set)
  F6=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
console.log((s[p].monitor && s[p].monitor.selfReview && s[p].monitor.selfReview.lastAt) || 0);
")
  if [ "$F6" -ge 1 ] 2>/dev/null; then
    echo "F6: PASS (selfReview.lastAt=$F6, review was executed)"
  else
    echo "F6: FAIL (selfReview.lastAt=${F6:-missing}, no review executed)"
    RESULT=1
  fi

  # Dump decisions log tail for the completion entry
  echo ""
  echo "--- decisions log (last 15 lines) ---"
  tail -15 "self-review.decisions.log" 2>/dev/null || echo "(no decisions log)"
else
  echo "F1-F6: FAIL (no .agentic-personas.json found)"
  RESULT=1
fi

echo ""
echo "RESULT: exit $RESULT"
exit $RESULT
