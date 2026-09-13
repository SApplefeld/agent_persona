#!/usr/bin/env bash
# supervisor-model-test.sh - harness case for v2 Section 0 item 3 Part B
# (operator decision, DISCUSSION.md Round 136 addendum): the worker's own
# main thread defaults to opus at medium effort, not sonnet, and a caller
# can still override either explicitly.
#
# Reviewer Round 141 R110 (Major, reproduced): the first cut of this test
# evaluated the settings and the flag's own resolution in the SAME shell
# process as the test itself, where `MODEL=haiku` (a plain shell
# variable, not exported) is trivially visible to a later `${MODEL:-...}`
# expansion in that same shell - masking exactly the bug R109 found live
# (`.kit/live-supervisor-test.sh`'s own `MODEL="haiku"` was never
# exported, and the suite launches `bin/supervise.sh` as a genuinely
# separate `bash` process, so the unexported variable never reached it).
# Fixed by actually launching a separate bash process for the resolution
# check, matching production's own shape, with a positive control proving
# the distinction the bug turned on: an unexported `MODEL` does NOT
# reach the child; an exported one does.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bin/supervise.sh"

SETTINGS_SNIPPET=$(grep -n '^SUPERVISOR_MODEL=\|^SUPERVISOR_EFFORT=' "$SCRIPT" | cut -d: -f2-)
if [ -z "$SETTINGS_SNIPPET" ]; then
  echo "FAIL: could not locate SUPERVISOR_MODEL/SUPERVISOR_EFFORT in $SCRIPT"
  exit 1
fi

MODEL_FLAG=$(grep -n '\-\-model "\${MODEL:-\$SUPERVISOR_MODEL}"' "$SCRIPT")
if [ -z "$MODEL_FLAG" ]; then
  echo "FAIL: could not locate the --model flag's resolution in $SCRIPT"
  exit 1
fi
EFFORT_FLAG=$(grep -n '\-\-effort "\${EFFORT:-\$SUPERVISOR_EFFORT}"' "$SCRIPT")
if [ -z "$EFFORT_FLAG" ]; then
  echo "FAIL: could not locate the --effort flag's resolution in $SCRIPT"
  exit 1
fi

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

# A tiny stub carrying exactly the settings lines and the two flags'
# resolution, run as its own bash process (not eval'd inline) so the
# check is genuinely about env-var inheritance across a process
# boundary, the same shape production uses.
STUB="$(mktemp)"
trap 'rm -f "$STUB"' EXIT
{
  echo "$SETTINGS_SNIPPET"
  echo 'echo "MODEL_RESOLVED=${MODEL:-$SUPERVISOR_MODEL}"'
  echo 'echo "EFFORT_RESOLVED=${EFFORT:-$SUPERVISOR_EFFORT}"'
} > "$STUB"

# Default: no override at all.
OUT=$(env -i PATH="$PATH" bash "$STUB")
case "$OUT" in
  *"MODEL_RESOLVED=opus"*) check "default resolves to opus in a separate process" 0 ;;
  *) check "default resolves to opus in a separate process" 1 ;;
esac
case "$OUT" in
  *"EFFORT_RESOLVED=medium"*) check "default resolves to medium effort in a separate process" 0 ;;
  *) check "default resolves to medium effort in a separate process" 1 ;;
esac

# A settings-level override changes the default.
OUT=$(env -i PATH="$PATH" supervisorModel=sonnet supervisorEffort=high bash "$STUB")
case "$OUT" in
  *"MODEL_RESOLVED=sonnet"*) check "supervisorModel override changes the setting" 0 ;;
  *) check "supervisorModel override changes the setting" 1 ;;
esac
case "$OUT" in
  *"EFFORT_RESOLVED=high"*) check "supervisorEffort override changes the setting" 0 ;;
  *) check "supervisorEffort override changes the setting" 1 ;;
esac

# R109/R110's own regression shape: an UNEXPORTED MODEL in the calling shell
# must NOT reach a separate child process, and an exported one must.
#
# These two cases have to run under a PRESERVED environment. The earlier
# version ran both under `env -i`, which wipes everything: the unexported
# case then passed because nothing at all was inherited, and the "exported"
# case set MODEL on env's own command line rather than by export, so neither
# case exercised export semantics and the pair proved nothing. `env -u` drops
# only the two settings variables, leaving the real inheritance intact, so
# the pair now flips on exactly the property under test - and would both read
# haiku if bash ever exported plain assignments.
env_stub() { env -u supervisorModel -u supervisorEffort bash "$STUB"; }

# `unset` first, and it is load-bearing: a plain assignment to a name that
# is ALREADY in the exported environment keeps its export attribute, so
# without the unset this case inherits whatever MODEL the calling supervisor
# exported and passes or fails on the environment rather than on the code.
# Caught by this very control running under a supervisor-launched shell that
# had MODEL=opus exported.
unset MODEL
MODEL=haiku
OUT=$(env_stub)
unset MODEL
case "$OUT" in
  *"MODEL_RESOLVED=opus"*) check "an UNEXPORTED MODEL does not reach a separate process (still opus)" 0 ;;
  *) check "an UNEXPORTED MODEL does not reach a separate process (still opus)" 1 ;;
esac

export MODEL=haiku
OUT=$(env_stub)
unset MODEL
case "$OUT" in
  *"MODEL_RESOLVED=haiku"*) check "an EXPORTED MODEL reaches a separate process" 0 ;;
  *) check "an EXPORTED MODEL reaches a separate process" 1 ;;
esac

# The same pair for EFFORT, which reaches the launch flag by the same route
# and was previously never covered at all.
unset EFFORT
EFFORT=high
OUT=$(env_stub)
unset EFFORT
case "$OUT" in
  *"EFFORT_RESOLVED=medium"*) check "an UNEXPORTED EFFORT does not reach a separate process (still medium)" 0 ;;
  *) check "an UNEXPORTED EFFORT does not reach a separate process (still medium)" 1 ;;
esac

export EFFORT=high
OUT=$(env_stub)
unset EFFORT
case "$OUT" in
  *"EFFORT_RESOLVED=high"*) check "an EXPORTED EFFORT reaches a separate process" 0 ;;
  *) check "an EXPORTED EFFORT reaches a separate process" 1 ;;
esac

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
