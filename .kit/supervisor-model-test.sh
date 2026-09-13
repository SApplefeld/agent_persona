#!/usr/bin/env bash
# supervisor-model-test.sh - harness case for v2 Section 0 item 3 Part B
# (operator decision, DISCUSSION.md Round 136 addendum): the worker's own
# main thread defaults to opus at medium effort, not sonnet, and a caller
# can still override either explicitly. The lines under test are pulled
# out of bin/supervise.sh by anchor text, not hand-copied, so this test
# reads whatever the real script currently says rather than a frozen guess.
# Exits 0 on all-pass, 1 on any failure.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bin/supervise.sh"

SETTINGS_SNIPPET=$(grep -n '^SUPERVISOR_MODEL=\|^SUPERVISOR_EFFORT=' "$SCRIPT" | cut -d: -f2-)
if [ -z "$SETTINGS_SNIPPET" ]; then
  echo "FAIL: could not locate SUPERVISOR_MODEL/SUPERVISOR_EFFORT in $SCRIPT"
  exit 1
fi

MODEL_FLAG_LINE=$(grep -n '\-\-model "\${MODEL:-\$SUPERVISOR_MODEL}"' "$SCRIPT")
if [ -z "$MODEL_FLAG_LINE" ]; then
  echo "FAIL: could not locate the --model flag's resolution in $SCRIPT"
  exit 1
fi

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

# Default: no override at all, settings should be opus / medium.
unset supervisorModel supervisorEffort MODEL EFFORT
eval "$SETTINGS_SNIPPET"
[ "$SUPERVISOR_MODEL" = "opus" ]; check "default SUPERVISOR_MODEL is opus" $?
[ "$SUPERVISOR_EFFORT" = "medium" ]; check "default SUPERVISOR_EFFORT is medium" $?

# A settings-level override changes the default.
supervisorModel=sonnet
supervisorEffort=high
eval "$SETTINGS_SNIPPET"
[ "$SUPERVISOR_MODEL" = "sonnet" ]; check "supervisorModel override changes the setting" $?
[ "$SUPERVISOR_EFFORT" = "high" ]; check "supervisorEffort override changes the setting" $?
unset supervisorModel supervisorEffort

# The launch call's own MODEL env var (what the .kit/live-*-test.sh
# suites and the persona launchers use) still wins over the new default -
# this is the exact mechanism that lets a live suite keep passing haiku
# explicitly with no cost change.
eval "$SETTINGS_SNIPPET"
MODEL=haiku
RESOLVED="${MODEL:-$SUPERVISOR_MODEL}"
[ "$RESOLVED" = "haiku" ]; check "an explicit MODEL override still wins over the opus default" $?
unset MODEL
RESOLVED="${MODEL:-$SUPERVISOR_MODEL}"
[ "$RESOLVED" = "opus" ]; check "with no MODEL override, the launch resolves to the opus default" $?

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
