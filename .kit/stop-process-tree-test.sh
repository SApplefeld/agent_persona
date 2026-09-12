#!/usr/bin/env bash
# Live test: v2 Section 0 item 2, the stop-path defect (Reviewer Round 105
# R2, Round 111 R29, Round 113 R42). A live incident showed a bash wrapper
# TERMed while the claude.exe process underneath it survived, still holding
# the persona claim, until the pre-gate timed out.
#
# Confirmed live, this session, while building this fix: an MSYS pid's
# WINPID (column 4 of plain `ps -p <pid>`, this environment's `ps` has no
# `-o` support) must be resolved BEFORE the MSYS pid is signaled - once it
# exits, `ps -p` finds nothing. And a genuine native Windows child process
# (not an MSYS-forked one, which does not expose a discoverable Win32
# parent) is exactly what Get-CimInstance Win32_Process's ParentProcessId
# walk correctly finds and kills.
#
# This proves the real fix against a real process and a real child, not a
# fake or a unit-tested stand-in, without launching a full claude session
# (which the live-* suites already do, at real cost and real contention
# with any other live session on the box).
#
# Extracts resolve_windows_pid and stop_process_tree verbatim from
# bin/supervise.sh (sed ranges between each function's own opening and
# closing brace) rather than duplicating them, so this test exercises the
# actual shipped functions, not a copy that can drift.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SUPERVISE="$PLUGIN_DIR/bin/supervise.sh"
RUNDIR="$SCRIPT_DIR/../run"
mkdir -p "$RUNDIR"

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
extract_fn "stop_process_tree" "$FN_FILE"
# The real functions shell out to `log`; stub it here (this test checks
# the process tree, not the log file).
log() { :; }
source "$FN_FILE"

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
  pass "setup: direct-exec case resolved a real winpid ($DIRECT_WINPID) before signaling"
  kill -9 "$DIRECT_PID" 2>/dev/null
  sleep 2
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $DIRECT_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    pass "direct-exec case: kill -9 on the MSYS pid alone kills the real Windows process"
  else
    failed "direct-exec case: the real Windows process SURVIVED kill -9 on the MSYS pid"
  fi
fi

# --- Case: a wrapper whose real child survives it needs the tree-kill ---
# Simulates the live incident's actual shape: a wrapper process is signaled
# and dies, while a genuine native Windows child process it launched keeps
# running underneath it - stop_process_tree, not a bare kill, must reach it.
( powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90" & echo $! > "$RUNDIR/child.pid"; wait ) &
WRAPPER_PID=$!
sleep 2
CHILD_PID=$(cat "$RUNDIR/child.pid" 2>/dev/null)
WRAPPER_WINPID=$(resolve_windows_pid "$WRAPPER_PID")
if [ -z "$CHILD_PID" ] || [ -z "$WRAPPER_WINPID" ]; then
  failed "setup: wrapper/child pids did not resolve for the surviving-child case"
else
  CHILD_WINPID=$(resolve_windows_pid "$CHILD_PID")
  pass "setup: wrapper (winpid $WRAPPER_WINPID) and child (winpid $CHILD_WINPID) both resolved before signaling"
  kill -9 "$WRAPPER_PID" 2>/dev/null
  sleep 2
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $WRAPPER_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    pass "surviving-child case: the wrapper is gone after kill -9"
  else
    failed "surviving-child case: the wrapper is STILL ALIVE after kill -9"
  fi
  if [ -n "$(powershell -NoProfile -Command "Get-Process -Id $CHILD_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    pass "surviving-child case: the child survived a bare kill -9 on the wrapper (reproduces the live incident before the fix)"
  else
    failed "setup: the child died on its own before stop_process_tree ran - this case did not reproduce"
  fi
  stop_process_tree "$WRAPPER_WINPID"
  sleep 2
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $CHILD_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    pass "surviving-child case: stop_process_tree kills the surviving child (the exact defect this fixes)"
  else
    failed "surviving-child case: the child SURVIVED stop_process_tree - the orphan defect is not fixed"
  fi
fi

rm -f "$RUNDIR/child.pid" "$FN_FILE"
kill -9 "$DIRECT_PID" "$WRAPPER_PID" "$CHILD_PID" 2>/dev/null  # best-effort cleanup

echo ""
echo "$CHECK_COUNT checks run, $FAIL_COUNT failed"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "stop-process-tree-test.sh: FAIL"
  exit 1
fi
echo "stop-process-tree-test.sh: PASS"
exit 0
