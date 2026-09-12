#!/usr/bin/env bash
# Live test: v2 Section 0 item 2, the stop-path defect (Reviewer Round 105
# R2, Round 111 R29, Round 113 R42, Round 119 R50-R56). A live incident
# showed a bash wrapper TERMed while the claude.exe process underneath it
# survived, still holding the persona claim, until the pre-gate timed out.
#
# Confirmed live, this session, while building this fix: an MSYS pid's
# WINPID (preferably /proc/<pid>/winpid; ps -p's column 4 as a fallback -
# this environment's `ps` has no `-o` support) must be resolved BEFORE the
# MSYS pid is signaled - once it exits, both reads find nothing. A genuine
# native Windows child process (not an MSYS-forked one, which does not
# expose a discoverable Win32 parent) is exactly what Get-CimInstance
# Win32_Process's ParentProcessId walk correctly finds and kills. And
# (Round 119 R50) the snapshot must be taken before ANY phase signals the
# wrapper, not after Phase 1/2's own kill -0 check fails - the live
# incident's exact shape (TERM kills the wrapper, the real child survives)
# is invisible to a check that only ever asks about the wrapper's own pid.
#
# This proves the real fix against real processes, not fakes or unit-
# tested stand-ins, without launching a full claude session (which the
# live-* suites already do, at real cost and real contention with any
# other live session on the box).
#
# Extracts resolve_windows_pid, snapshot_process_tree, kill_process_snapshot,
# and stop_child verbatim from bin/supervise.sh (sed ranges between each
# function's own opening and closing brace) rather than duplicating them,
# so this test exercises the actual shipped functions, not a copy that can
# drift.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SUPERVISE="$PLUGIN_DIR/bin/supervise.sh"
# Reviewer Round 119 R56: a real temp dir, not this repo's own run/ (the
# live supervisor's default RUNDIR) - a concurrent supervised run must
# never share this test's scratch files.
RUNDIR="$(mktemp -d)"
trap 'rm -rf "$RUNDIR"' EXIT

# Reviewer Round 122 R69: registered in .kit/live-all.sh's ALL_SUITES as
# "stopprocesstree" - it launches no claude session and holds no persona
# claim, so it fits the runner cheaply, and the whole gate's own summary
# now covers it. SUITE_DIR is the convention every other live-*-test.sh
# reads its own scratch dir from when live-all.sh drives it; standalone
# runs (no SUITE_DIR set) fall back to their own mktemp -d.
SUITE_DIR="${SUITE_DIR:-$(mktemp -d)}"
mkdir -p "$SUITE_DIR"
EXIT_FILE="$SUITE_DIR/stopprocesstree-test.exit"

FAIL_COUNT=0
CHECK_COUNT=0
pass() { echo "OK: $1"; CHECK_COUNT=$((CHECK_COUNT + 1)); }
failed() { echo "FAIL: $1"; CHECK_COUNT=$((CHECK_COUNT + 1)); FAIL_COUNT=$((FAIL_COUNT + 1)); }

extract_fn() {
  local fn_name="$1"
  local out_file="$2"
  local start end
  start=$(grep -n "^${fn_name}() {" "$SUPERVISE" | head -1 | cut -d: -f1)
  if [ -z "$start" ]; then
    echo "FAIL: could not find ${fn_name}() in $SUPERVISE"
    exit 1
  fi
  end=$(tail -n "+$start" "$SUPERVISE" | grep -n '^}' | head -1 | cut -d: -f1)
  end=$((start + end - 1))
  sed -n "${start},${end}p" "$SUPERVISE" >> "$out_file"
}

FN_FILE="$RUNDIR/stop-process-tree-fns.sh"
: > "$FN_FILE"
extract_fn "resolve_windows_pid" "$FN_FILE"
extract_fn "snapshot_process_tree" "$FN_FILE"
extract_fn "check_snapshot_survivors" "$FN_FILE"
extract_fn "kill_process_snapshot" "$FN_FILE"
extract_fn "stop_child" "$FN_FILE"
# The real functions shell out to `log` and read $RUNDIR (already set,
# above, to this test's own scratch dir - real, not stubbed, since
# kill_process_snapshot writes to "$RUNDIR/supervisor.err").
log() { echo "[log] $*"; }
source "$FN_FILE"

# Reviewer Round 119 R56: a truncated extraction (a sed range mismatch, a
# renamed function upstream) must fail as an extraction problem, not
# silently produce a no-op function that passes every check by doing
# nothing. Check each function actually landed before trusting any of them.
for fn in resolve_windows_pid snapshot_process_tree check_snapshot_survivors kill_process_snapshot stop_child; do
  if ! declare -F "$fn" > /dev/null; then
    echo "FAIL: extraction did not define $fn - the sed range or the upstream function name has drifted"
    exit 1
  fi
done
pass "setup: all five functions extracted and defined"

# --- Case: the wrapper's own exec target is killed directly by kill -9 ---
# Confirmed shape: a bash subshell that tail-execs directly into a native
# binary with nothing after it collapses into one process; `kill -9` on
# the MSYS pid alone reaches it.
( exec powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90" ) &
DIRECT_PID=$!
sleep 2
DIRECT_WINPID=$(resolve_windows_pid "$DIRECT_PID")
if [ -z "$DIRECT_WINPID" ]; then
  failed "setup: could not resolve a winpid for the direct-exec case"
else
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $DIRECT_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    failed "setup: the direct-exec process was not alive at resolve time - the instrument is not proven"
  else
    pass "setup: direct-exec case resolved a real, live winpid ($DIRECT_WINPID) before signaling"
  fi
  kill -9 "$DIRECT_PID" 2>/dev/null
  sleep 2
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $DIRECT_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    pass "direct-exec case: kill -9 on the MSYS pid alone kills the real Windows process"
  else
    failed "direct-exec case: the real Windows process SURVIVED kill -9 on the MSYS pid"
    kill -9 "$DIRECT_WINPID" 2>/dev/null
  fi
fi

# --- Case: stop_child itself (Reviewer Round 119 R51), not just the raw
# tree-kill helper, actually stops a wrapper whose real child survives it
# --- This is the shape the spec's own acceptance criterion asks for: a
# child whose claude.exe outlives its wrapper is still fully stopped by
# stop_child, end to end.
CHILD_IN=""  # stop_child checks this; empty means Phase 1's EOF close is a no-op
SUPERVISOR_STOP_GRACE_MS=2000  # short grace so this test doesn't wait a full minute per phase
STOP_PATH=""
( powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90" & echo $! > "$RUNDIR/child.pid"; wait ) &
CHILD_PID=$!
sleep 2
REAL_CHILD_PID=$(cat "$RUNDIR/child.pid" 2>/dev/null)
if [ -z "$REAL_CHILD_PID" ]; then
  failed "setup: stop_child case's real child pid never appeared"
else
  REAL_CHILD_WINPID=$(resolve_windows_pid "$REAL_CHILD_PID")
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $REAL_CHILD_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    failed "setup: stop_child case's real child was not alive before stop_child ran"
  else
    pass "setup: stop_child case's real child (winpid $REAL_CHILD_WINPID) confirmed alive before stop_child runs"
  fi
  stop_child "test"
  sleep 2
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $REAL_CHILD_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    pass "stop_child: the real child is gone after stop_child returns (STOP_PATH=$STOP_PATH) - the exact defect this fixes"
  else
    failed "stop_child: the real child SURVIVED stop_child (STOP_PATH=$STOP_PATH) - the orphan defect is not fixed"
    kill -9 "$REAL_CHILD_WINPID" 2>/dev/null
  fi
fi

# --- Case: a wrapper that ignores TERM forces stop_child to Phase 3, the
# path where the CRLF bug (Reviewer Round 122 R62/R63) actually lived ---
# The prior case above only ever reaches Phase 2 (a plain bash wrapper
# dies to TERM on its own). Phase 3's own kill_process_snapshot is where
# `Stop-Process` and the per-pid survivor probe both take a snapshot built
# from `snapshot_process_tree`'s own output - exactly the path that broke
# on an unstripped `\r` when this was reproduced live.
CHILD_IN=""
SUPERVISOR_STOP_GRACE_MS=2000
STOP_PATH=""
( trap '' TERM; powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90" & echo $! > "$RUNDIR/child3.pid"; wait ) &
CHILD_PID=$!
disown "$CHILD_PID" 2>/dev/null
sleep 2
REAL_CHILD_PID=$(cat "$RUNDIR/child3.pid" 2>/dev/null)
if [ -z "$REAL_CHILD_PID" ]; then
  failed "setup: Phase-3 case's real child pid never appeared"
else
  REAL_CHILD_WINPID=$(resolve_windows_pid "$REAL_CHILD_PID")
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $REAL_CHILD_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    failed "setup: Phase-3 case's real child was not alive before stop_child ran"
  else
    pass "setup: Phase-3 case's real child (winpid $REAL_CHILD_WINPID) confirmed alive before stop_child runs"
  fi
  stop_child "test-phase3"
  if [ "$STOP_PATH" = "kill" ]; then
    pass "Phase-3 case: stop_child actually escalated to Phase 3 (STOP_PATH=kill), the path this test needs to exercise"
  else
    failed "Phase-3 case: stop_child never reached Phase 3 (STOP_PATH=$STOP_PATH) - the TERM-ignoring wrapper did not force escalation, this case did not reproduce"
  fi
  sleep 2
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $REAL_CHILD_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    pass "Phase-3 case: the real child is gone after stop_child's own tree kill (the CRLF bug's exact path)"
  else
    failed "Phase-3 case: the real child SURVIVED Phase 3's tree kill - the CRLF bug or an equivalent is back"
    kill -9 "$REAL_CHILD_WINPID" 2>/dev/null
  fi
fi

rm -f "$RUNDIR/child.pid" "$RUNDIR/child3.pid"
kill -9 "$DIRECT_PID" "$CHILD_PID" 2>/dev/null  # best-effort cleanup

echo ""
echo "$CHECK_COUNT checks run, $FAIL_COUNT failed"
echo "$FAIL_COUNT" > "$EXIT_FILE"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "live-stopprocesstree-test.sh: FAIL"
  exit 1
fi
echo "live-stopprocesstree-test.sh: PASS"
exit 0
