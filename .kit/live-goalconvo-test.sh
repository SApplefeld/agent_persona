#!/usr/bin/env bash
# Live test: item 2 - a goal arrives by conversation. bin/supervise.sh
# launched with a plain-language --prompt (no tool named) reaches
# goal_create firing on its own and the plan actually running.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/goalconvo}"
PROFILE="${PROFILE:-short}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Setup ---
rm -rf "$SUITE_DIR"
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

RUNNING="$SUITE_DIR/RUNNING"
trap 'rm -f "$RUNNING"' EXIT

export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

WORKDIR="$SUITE_DIR/workdir"
mkdir -p "$WORKDIR"
SUPERVISE="$PLUGIN_DIR/bin/supervise.sh"
SUPERVISE_LOG="$SUITE_DIR/supervisor.log"
STORE="$WORKDIR/.agentic-personas.json"
EXIT_FILE="$SUITE_DIR/goalconvo.exit"
ASSERT_LOG="$SUITE_DIR/goalconvo.assert.log"
: > "$ASSERT_LOG"
FAIL_COUNT=0
pass() { echo "OK: $1" | tee -a "$ASSERT_LOG"; }
failed() { echo "FAIL: $1" | tee -a "$ASSERT_LOG"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Plain-language request, no tool named anywhere - the exact shape item 2 asks for.
# Item 2's own acceptance text requires "no tool named" - an earlier
# version of this prompt named goal_done explicitly, which a haiku-tier
# model sometimes read as license to skip goal_create entirely and just
# do the task (reproduced twice, identically, in isolated retests: F1
# failed, F2 and F4 passed, meaning the file got written with no goal
# tree ever opened). Plain language only; the scorer's own on-goal/
# complete path can close the leaf without an explicit goal_done call.
PROMPT='Please write a short haiku about the ocean to a file named ocean.txt in the working directory.'

# Reviewer Round 141 R109: bin/supervise.sh's own default model is now
# opus (v2 Section 0 item 3 Part B) - export MODEL so this suite's child
# still runs at haiku, unaffected by that new default.
export MODEL="haiku"
# Pinned beside MODEL so the suite holds its own cost and effort steady
# against the opus/medium defaults, and so a default change cannot move
# what these runs measure.
export EFFORT="medium"

bash "$SUPERVISE" "$WORKDIR" "goalconvo-item2-$$" acceptEdits --dev --prompt "$PROMPT" --rundir "$SUITE_DIR" --no-channel \
  > "$SUITE_DIR/supervise.stdout.log" 2>&1 &
SUPERVISE_PID=$!

# --- F1: goal_create fired on its own (decision action "create") from a
# plain sentence, no tool named. ---
F1_FOUND=0
for i in $(seq 1 80); do
  if [ -f "$STORE" ] && node -e "
const s = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions || []);
process.exit(d.some(x => x.action === 'create') ? 0 : 1);
" "$STORE" 2>/dev/null; then
    F1_FOUND=1
    break
  fi
  sleep 3
done
if [ "$F1_FOUND" -eq 1 ]; then pass "F1 goal_create fired from a plain-language request"; else failed "F1 goal_create fired from a plain-language request"; fi

# --- F2: the plan actually ran - the file it names got written. ---
F2_FOUND=0
for i in $(seq 1 80); do
  if [ -f "$WORKDIR/ocean.txt" ] && [ -s "$WORKDIR/ocean.txt" ]; then
    F2_FOUND=1
    break
  fi
  sleep 3
done
if [ "$F2_FOUND" -eq 1 ]; then pass "F2 the requested file was actually written"; else failed "F2 the requested file was actually written"; fi

# --- F3: the goal reached root_complete. ---
F3_FOUND=0
for i in $(seq 1 80); do
  if [ -f "$STORE" ] && node -e "
const s = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const p = Object.keys(s)[0];
const d = (s[p].decisions || []);
process.exit(d.some(x => x.action === 'root_complete') ? 0 : 1);
" "$STORE" 2>/dev/null; then
    F3_FOUND=1
    break
  fi
  sleep 3
done
if [ "$F3_FOUND" -eq 1 ]; then pass "F3 the goal reached completion"; else failed "F3 the goal reached completion"; fi

# --- Stop cleanly ---
kill -TERM "$SUPERVISE_PID" 2>/dev/null
wait "$SUPERVISE_PID" 2>/dev/null
STOP_CODE=$?
if [ "$STOP_CODE" -eq 143 ] || [ "$STOP_CODE" -eq 0 ]; then
  pass "F4 clean stop (exit $STOP_CODE)"
else
  failed "F4 clean stop (got exit $STOP_CODE)"
fi

echo "$FAIL_COUNT" > "$EXIT_FILE"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "live-goalconvo-test.sh: FAIL ($FAIL_COUNT check(s) failed)"
  exit 1
fi
echo "live-goalconvo-test.sh: PASS"
exit 0
