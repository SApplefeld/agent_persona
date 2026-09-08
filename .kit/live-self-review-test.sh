#!/usr/bin/env bash
# Live test: self-review (reactive trigger, streak 3 denials).
# Induction: goal_create, then 3 Bash-forcing turns (each denied by root constraint).
# The streak reaches 3, the tick fires the reactive self-review, and the next prompt
# gets the lesson injected.
#
# V1: feed() sends no stdout into the child's stdin. All diagnostics go to >&2.
# V2: no selfReviewEveryTurns set (default 20; periodic cannot fire in 5 turns).
#     The only review that can happen is reactive: streak 3 >= selfReviewStreak 3.
# V3: pre-gate fails closed on read error; prints live=/oldest_age= per poll;
#     missing global store is a failure, not a skip.
# V4: pre-gate called after emit_settings_json (per V4 order in Round 33).
#
# Usage: PROFILE=short bash .kit/live-self-review-test.sh
# Exits 0 on success, 1 on failure.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/self-review}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OUT="$SUITE_DIR/self-review-test.out.jsonl"
ERR="$SUITE_DIR/self-review-test.err.log"
EXIT="$SUITE_DIR/self-review-test.exit"
RUNNING="$SUITE_DIR/RUNNING"
DEBUG="$SUITE_DIR/self-review-test.debug.log"
trap 'rm -f "$RUNNING"' EXIT

rm -f "$OUT" "$ERR" "$EXIT" "$DEBUG"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# Emit settings.json (V2: no selfReviewEveryTurns override - default 20, periodic cannot fire)
emit_settings_json "settings.json"
echo "settings.json: $(cat settings.json)" >&2

# V3: pre-gate - wait for no live persona claim (fails closed on read error)
GLOBAL_STORE="$(find_global_store)"
if [ -z "$GLOBAL_STORE" ]; then
  echo "T9: pre-gate FAIL: no global store found (lookup broken)" >&2
  exit 9
fi
wait_persona_free "$GLOBAL_STORE" 120 || { echo "T9: pre-gate timeout, aborting" >&2; exit 9; }

# --- Feed: wait_turn between prompts (errorstreak-style) ---
# V1: ALL output goes to >&2 so nothing corrupts the child's stdin.
feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Call goal_create with objective \"no bash: Write one haiku\" and maxRounds 5. Then reply ok."}}'
  wait_turn 1
  wait_activation
  # 3 Bash-forcing prompts (error turns, each denied by root constraint)
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Use the Bash tool now to run exactly: echo hello. Make the tool call even if you expect it to be denied; do not explain, report the result in one line."}}'
  wait_turn 2
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Use the Bash tool now to run exactly: echo world. Make the tool call even if you expect it to be denied; do not explain, report the result in one line."}}'
  wait_turn 3
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Use the Bash tool now to run exactly: echo third. Make the tool call even if you expect it to be denied; do not explain, report the result in one line."}}'
  wait_turn 4
  # Poll for error_streak (the streak must be recorded before the reactive review)
  echo "feed: waiting for error_streak..." >&2
  N=0
  until node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).some(x => x.action === 'error_streak');
process.exit(d ? 0 : 1);
" 2>/dev/null; do
    sleep 3; N=$((N+3)); [ $N -ge 120 ] && { echo "feed: error_streak poll timed out" >&2; return 1; }
  done
  # Poll for self-review with reactive: prefix (V2)
  echo "feed: waiting for reactive self-review..." >&2
  M=0
  until node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).some(x => x.action === 'self-review' && (x.detail||'').startsWith('reactive:'));
process.exit(d ? 0 : 1);
" 2>/dev/null; do
    sleep 3; M=$((M+3)); [ $M -ge 120 ] && { echo "feed: reactive self-review poll timed out" >&2; return 1; }
  done
  # One more prompt for lesson_inject
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with the single word: done"}}'
  wait_turn 5
  # Poll for lesson_inject
  echo "feed: waiting for lesson_inject..." >&2
  K=0
  until node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).some(x => x.action === 'lesson_inject');
process.exit(d ? 0 : 1);
" 2>/dev/null; do
    sleep 3; K=$((K+3)); [ $K -ge 120 ] && { echo "feed: lesson_inject poll timed out" >&2; return 1; }
  done
}

# T8: --debug-file for loader diagnostics
feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity,Bash" \
  --model haiku \
  --debug-file "$DEBUG" \
  > "$OUT" 2> "$ERR"
EXIT_CODE=$?
echo $EXIT_CODE > "$EXIT"
echo "claude exit: $EXIT_CODE" >&2

# --- Loader check: fail fast if the plugin failed to load (T8) ---
if [ -f "$DEBUG" ] && grep -q "failed to load" "$DEBUG"; then
  echo "F0-LOADER: FAIL: plugin failed to load" >&2
  grep "failed to load" "$DEBUG" >&2
  echo "RESULT: exit 1" >&2
  exit 1
fi
echo "LOADER: clean (no 'failed to load')" >&2

# V1: fail the run when the child exits non-zero
if [ $EXIT_CODE -ne 0 ]; then
  echo "CHILD EXIT: FAIL (claude exit $EXIT_CODE, non-zero)" >&2
  tail -20 "$ERR" >&2
  echo "RESULT: exit 1" >&2
  exit 1
fi

# --- Assertions (F0-F6, on persisted facts) ---
RESULT=0

if [ -f .agentic-personas.json ]; then
  # Write decisions log for inspection
  node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).map(x => new Date(x.timestamp).toISOString().slice(11,19) + ' ' + x.loop + ' | ' + x.action + ' | ' + x.detail);
require('fs').writeFileSync('self-review.decisions.log', d.join('\n') + '\n');
"

  # F0: no yield decisions (U4: check both real names)
  F0=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).some(x => x.action === 'yield' || x.action === 'persona_yield' || x.action === 'persona_yield_commons');
console.log(d ? 'FAIL' : 'PASS');
")
  if [ "$F0" = "PASS" ]; then
    echo "F0: PASS (no yield decision - owner held the persona)"
  else
    echo "F0: FAIL (yield decision found - persona was yielded)"
    RESULT=1
  fi

  # F1: an error_streak decision exists (proves the streak reached >= 3)
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

  # F2: decisions log contains action=self-review with reactive: prefix (V2)
  F2=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions||[]).filter(x => x.action === 'self-review' && (x.detail||'').startsWith('reactive:'));
console.log(d.length > 0 ? 'YES' : 'NO');
")
  if [ "$F2" = "YES" ]; then
    echo "F2: PASS (reactive self-review decision found)"
  else
    echo "F2: FAIL (no reactive self-review decision)"
    RESULT=1
  fi

  # F3: memory array contains MemoryEntry with source=self-review and provenance
  # V5: print the lesson text (truncated to 80 chars) on the PASS line
  F3_DATA=$(node -e "
const s = JSON.parse(require('fs').readFileSync('.agentic-personas.json','utf8'));
const p = Object.keys(s)[0];
const m = (s[p].memory||[]).filter(x => x.source === 'self-review' && x.provenance && Array.isArray(x.provenance.decisionTimestamps) && x.provenance.decisionTimestamps.length > 0);
if (m.length > 0) {
  const t = (m[0].text||m[0].content||'').replace(/\n/g,' ').slice(0,80);
  console.log('YES:' + t);
} else {
  console.log('NO');
}
")
  F3=$(echo "$F3_DATA" | cut -d: -f1)
  F3_TEXT=$(echo "$F3_DATA" | cut -d: -f2-)
  if [ "$F3" = "YES" ]; then
    echo "F3: PASS (self-review lesson with provenance, text: ${F3_TEXT:-n/a})"
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

  # F6: monitor.selfReview.lastAt > 0
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

  # Dump decisions log tail
  echo ""
  echo "--- decisions log (last 15 lines) ---"
  tail -15 "self-review.decisions.log" 2>/dev/null || echo "(no decisions log)"
else
  echo "F0-F6: FAIL (no .agentic-personas.json found)"
  RESULT=1
fi

echo ""
echo "RESULT: exit $RESULT"
exit $RESULT
