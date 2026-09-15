#!/usr/bin/env bash
# Shared live-test helpers. Sourced by every live suite.
# Requires: $OUT set to the stream-json output file before use.
# Sources bin/agentic-common.sh for wait_persona_free and emit_settings_json (Y7).

# Source the shared helper by a path relative to this file's directory, not the caller's cwd.
_LC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_AGENTIC_COMMON="$_LC_DIR/../bin/agentic-common.sh"
if [ -f "$_AGENTIC_COMMON" ]; then
  # shellcheck source=../bin/agentic-common.sh
  source "$_AGENTIC_COMMON"
else
  echo "live-common.sh: FATAL: cannot find bin/agentic-common.sh at $_AGENTIC_COMMON" >&2
  exit 1
fi

# The live lane's model and effort. Every gated suite that launches
# bin/supervise.sh sources this file, and the supervisor is a separate
# process, so the values are exported here once rather than in each suite.
# The exports are unconditional: a supervisor-launched shell already carries
# MODEL=opus, and a gate run from one would otherwise launch the
# restartrequest child at that model with nothing in the run saying so.
export MODEL="haiku"
export EFFORT="medium"

# --- Helpers ---

wait_turn() {  # $1 = number of result lines to wait for
  local n=0
  local count
  until [ "${count:-0}" -ge "$1" ]; do
    count=$(grep -c '"type":"result"' "$OUT" 2>/dev/null || true)
    count="${count:-0}"
    sleep 2; n=$((n+2)); [ $n -ge 180 ] && return 1
  done
  sleep 3
}

# find_global_store is defined in bin/agentic-common.sh (sourced above),
# shared with bin/supervise.sh so both callers filter on dev_mode the same
# way rather than carrying their own copies (a drift between two such
# copies is what caused 6 suites to fail on the 20260911T183849Z run
# stamp: one copy resolved to the installed store while every child in
# this harness runs under --plugin-dir, so the pre-gate read the wrong
# store's claims). wait_persona_free is likewise in bin/agentic-common.sh.

# Plan item 5 ("a proof child is stopped when its proof ends"): escalate
# EOF -> TERM -> KILL and verify death, mirroring bin/supervise.sh's own
# stop_child. A suite's cleanup trap on an early-exit path (an assertion
# failure, a killed suite) must not leave the claude coproc it launched
# still holding this persona's commons claim into the next proof - a second
# proof child that finds the first still holding "default" comes up as a
# reader and proves less than it seems to.
# Usage: stop_coproc_pid <pid> [write-fd] [grace-seconds, default 5]
stop_coproc_pid() {
  local pid="${1:-}" fd="${2:-}" grace="${3:-5}" n
  [ -z "$pid" ] && return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0  # already dead
  fi
  # Phase 1: EOF - close the write end so the child can finish its turn and exit 0.
  if [ -n "$fd" ]; then
    eval "exec $fd>&-" 2>/dev/null || true
  fi
  n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt "$grace" ]; do sleep 1; n=$((n+1)); done
  kill -0 "$pid" 2>/dev/null || return 0
  # Phase 2: TERM.
  kill -TERM "$pid" 2>/dev/null
  n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt "$grace" ]; do sleep 1; n=$((n+1)); done
  kill -0 "$pid" 2>/dev/null || return 0
  # Phase 3: KILL, then verify.
  kill -KILL "$pid" 2>/dev/null
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "stop_coproc_pid: WARNING pid $pid still alive after KILL" >&2
    return 1
  fi
  return 0
}
