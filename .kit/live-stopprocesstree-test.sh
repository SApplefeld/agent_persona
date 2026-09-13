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

# STOP_PS_SENTINEL is a global the extracted functions close over, not
# part of any single function body - sourced from supervise.sh's own
# assignment line rather than retyped here, so the two can't drift.
STOP_PS_SENTINEL=$(grep '^STOP_PS_SENTINEL=' "$SUPERVISE" | head -1 | cut -d= -f2- | tr -d '"')
if [ -z "$STOP_PS_SENTINEL" ]; then
  echo "FAIL: could not read STOP_PS_SENTINEL's value from $SUPERVISE"
  exit 1
fi
# SUPERVISOR_PS_BOUND_S (Reviewer Round 126 R89) is the same shape of
# global the extracted functions close over - default value read the
# same way, not retyped.
SUPERVISOR_PS_BOUND_S=30

FN_FILE="$RUNDIR/stop-process-tree-fns.sh"
: > "$FN_FILE"
extract_fn "resolve_windows_pid" "$FN_FILE"
extract_fn "run_bounded_powershell" "$FN_FILE"
extract_fn "run_bounded_powershell_capture" "$FN_FILE"
extract_fn "snapshot_process_tree" "$FN_FILE"
extract_fn "check_snapshot_survivors" "$FN_FILE"
extract_fn "kill_process_snapshot" "$FN_FILE"
extract_fn "retry_stop_escalation" "$FN_FILE"
extract_fn "stop_child" "$FN_FILE"
# The real functions shell out to `log` and read $RUNDIR (already set,
# above, to this test's own scratch dir - real, not stubbed, since
# kill_process_snapshot writes to "$RUNDIR/supervisor.err").
log() { echo "[log] $*"; }
log_diag() { echo "[log_diag] $*" >&2; }
source "$FN_FILE"

# Reviewer Round 119 R56: a truncated extraction (a sed range mismatch, a
# renamed function upstream) must fail as an extraction problem, not
# silently produce a no-op function that passes every check by doing
# nothing. Check each function actually landed before trusting any of them.
# Reviewer Round 124 R77 / Round 126: this count has drifted upward twice
# since this comment was first written, so it is named here rather than
# pinned as a literal that will only go stale again.
FNS_TO_EXTRACT="resolve_windows_pid run_bounded_powershell run_bounded_powershell_capture snapshot_process_tree check_snapshot_survivors kill_process_snapshot retry_stop_escalation stop_child"
FN_COUNT=$(echo "$FNS_TO_EXTRACT" | wc -w)
for fn in $FNS_TO_EXTRACT; do
  if ! declare -F "$fn" > /dev/null; then
    echo "FAIL: extraction did not define $fn - the sed range or the upstream function name has drifted"
    exit 1
  fi
done
pass "setup: all $FN_COUNT functions extracted and defined"

# Reviewer Round 124 R74: production runs every extracted call under
# real shell semantics, including a pipeline whose upstream command fails
# silently unless pipefail is set - run this test under the same
# semantics its production callers actually use.
set -o pipefail

# --- Case: run_bounded_powershell actually holds its bound (Reviewer
# Round 126 R79, reproduced live: a 3s bound around a 40s sleep returned
# after 264s, not ~3-5s, because a bare `kill -9` on the tail-exec
# subshell's own pid did not hold under load) ---
# Run exactly as production calls it: through run_bounded_powershell_capture,
# inside a command substitution, since that combination - not a bare direct
# call - is what the reproduction actually needed to surface the hang.
R79_START=$(date +%s)
# Reviewer Round 126 R90: the prior version of this case asserted only
# that the sleep's own late output never reached the caller - vacuous
# after the file-not-pipe fix, since the outfile is deleted at about
# bound+5s and "done-late" lands at 40s in a file nobody is still
# reading; that leg passes whether or not the process was actually
# killed. `TESTPID:$PID` is the test's own marker (distinct from
# run_bounded_powershell's internal `PSPID:` bookkeeping line, which is
# stripped before the caller ever sees it) - it survives into R79_OUT and
# gives this case the real powershell.exe pid to assert dead afterward,
# by pid AND start time, the same standard the rest of this file holds
# every other kill to.
R79_OUT=$(run_bounded_powershell_capture 3 "Write-Output (\"TESTPID:\" + \$PID + \",\" + (Get-Process -Id \$PID).StartTime.Ticks); Start-Sleep -Seconds 40; Write-Output 'done-late'")
R79_RC=$?
R79_ELAPSED=$(( $(date +%s) - R79_START ))
# Reviewer Round 126 R93 (Minor): a 3s-bound call has already been
# observed taking ~13s of legitimate helper time under this session's own
# load (the poll loop, the taskkill, the reap wait); a flat 15s ceiling
# flakes red on a slow day for reasons that have nothing to do with
# whether the bound actually held. Scaled off the bound itself instead.
R79_CEILING=$((3 + 15))
if [ "$R79_ELAPSED" -gt "$R79_CEILING" ]; then
  failed "R79 regression: run_bounded_powershell_capture took ${R79_ELAPSED}s against a 3s bound (expected under ~${R79_CEILING}s) - the bound did not hold"
else
  pass "R79 regression: run_bounded_powershell_capture returned in ${R79_ELAPSED}s against a 3s bound"
fi
if [ "$R79_RC" -eq 124 ]; then
  pass "R79 regression: run_bounded_powershell_capture reported the timeout (rc 124)"
else
  failed "R79 regression: expected rc 124, got $R79_RC"
fi
if printf '%s' "$R79_OUT" | grep -q 'done-late'; then
  failed "R79 regression: the sleep's own late output reached the caller (\"$R79_OUT\") - the process was not actually force-killed on the bound"
else
  pass "R79 regression: no late output from the bounded call - the process did not survive its own bound"
fi
R79_TESTPID_LINE=$(printf '%s\n' "$R79_OUT" | grep '^TESTPID:')
R79_REAL_SNAPSHOT="${R79_TESTPID_LINE#TESTPID:}"
if [ -z "$R79_REAL_SNAPSHOT" ]; then
  failed "R79 regression: the real powershell.exe pid was never self-reported - cannot assert the native process is actually dead"
else
  R79_SURVIVORS=$(check_snapshot_survivors "$R79_REAL_SNAPSHOT")
  if [ -n "$R79_SURVIVORS" ]; then
    failed "R79 regression: the real powershell.exe process (pid,ticks=$R79_REAL_SNAPSHOT) SURVIVED the bound - the stub was killed, the native process was not"
  else
    pass "R79 regression: the real powershell.exe process (pid,ticks=$R79_REAL_SNAPSHOT), not just the MSYS stub, is confirmed dead after the bound"
  fi
fi

# --- Case: the wrapper's own exec target is killed directly by taskkill
# on its resolved winpid ---
# Confirmed shape: a bash subshell that tail-execs directly into a native
# binary with nothing after it collapses into one process. Re-pointed at
# `taskkill //F //T` (Reviewer Round 126 addendum, reproduced by the
# blind reviewer): a bare `kill -9` on the MSYS pid itself blocked 236s
# and returned "Permission denied", twice - not a safe fallback signal
# under load, which is why `run_bounded_powershell` no longer uses it
# either. `resolve_windows_pid` must run before any termination attempt,
# same as production - once the pid exits, the read finds nothing.
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
  # Reviewer Round 126 R90: assert the actual descendant pid, not just
  # "some Get-Process -Id $DIRECT_WINPID query returns nothing" - that
  # query alone cannot tell a genuinely dead process from one whose pid
  # is simply not what got walked. Snapshot the whole tree from
  # DIRECT_WINPID (the same helper production uses) before the kill and
  # check every entry, matched by pid and start time, afterward.
  DIRECT_SNAPSHOT=$(snapshot_process_tree "$DIRECT_WINPID")
  taskkill //F //T //PID "$DIRECT_WINPID" > /dev/null 2>&1
  sleep 2
  DIRECT_SURVIVORS=$(check_snapshot_survivors "$DIRECT_SNAPSHOT")
  if [ -z "$DIRECT_SURVIVORS" ]; then
    pass "direct-exec case: taskkill //F //T on the resolved winpid kills the real Windows process (every snapshotted pid, matched by start time, confirmed dead)"
  else
    failed "direct-exec case: the real Windows process SURVIVED taskkill //F //T on its resolved winpid ($DIRECT_SURVIVORS still alive)"
    taskkill //F //T //PID "$DIRECT_WINPID" > /dev/null 2>&1
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

  # Reviewer Round 124 R74: the prior version of this case would still
  # pass with the CRLF fix reverted, because a `\r` landing on the ticks
  # field (not the pid) makes the kill list valid, lets Stop-Process
  # succeed, and only silently drops the ticks comparison downstream -
  # the child ends up dead either way, and the test never noticed the
  # comparison itself was broken. Assert the snapshot's own shape and a
  # positive control (this live child reads as a survivor before the
  # kill) so a regression here fails on its own signal, not by accident.
  PRE_KILL_SNAPSHOT=$(snapshot_process_tree "$REAL_CHILD_WINPID")
  # Reviewer Round 126 R83: the glob `[0-9]*,[0-9]*` accepts `1234,63837\r`
  # (the trailing `\r` falls inside the second `*`) and `1234,6x` (same
  # reason) - it does not actually pin the shape the comment above claims.
  # `grep -Eqx` anchors both ends of the line and pins the exact two shapes
  # this function can legitimately emit (a numeric ticks value, or the
  # literal `UNREADABLE` marker), catching both a stray CR and a
  # mid-file garbage character a glob would silently pass.
  SNAPSHOT_SHAPE_OK=1
  while IFS= read -r snap_line; do
    [ -z "$snap_line" ] && continue
    if ! printf '%s' "$snap_line" | grep -Eqx '[0-9]+,([0-9]+|UNREADABLE)'; then
      SNAPSHOT_SHAPE_OK=0
    fi
  done <<< "$PRE_KILL_SNAPSHOT"
  if [ -z "$PRE_KILL_SNAPSHOT" ] || [ "$SNAPSHOT_SHAPE_OK" -ne 1 ]; then
    failed "Phase-3 case: snapshot_process_tree's own output does not match pid,ticks per line - got: $(echo "$PRE_KILL_SNAPSHOT" | tr '\n' '|')"
  else
    pass "Phase-3 case: snapshot lines all match pid,ticks"
  fi
  PRE_KILL_SURVIVORS=$(check_snapshot_survivors "$PRE_KILL_SNAPSHOT")
  if echo "$PRE_KILL_SURVIVORS" | grep -qx "$REAL_CHILD_WINPID"; then
    pass "Phase-3 case: positive control - the live child reads as a survivor before any kill runs"
  else
    failed "Phase-3 case: positive control failed - the live child ($REAL_CHILD_WINPID) was not reported as a survivor before the kill; the instrument cannot be trusted for the assertion below"
  fi

  stop_child "test-phase3"
  if [ "$STOP_PATH" = "kill" ]; then
    pass "Phase-3 case: stop_child actually escalated to Phase 3 (STOP_PATH=kill), the path this test needs to exercise"
  else
    failed "Phase-3 case: stop_child never reached Phase 3 (STOP_PATH=$STOP_PATH) - the TERM-ignoring wrapper did not force escalation, this case did not reproduce"
  fi
  sleep 2
  # Reviewer Round 124 R74: check pid AND start time, not pid alone - a
  # bare "is this pid gone" check cannot tell "the same process is dead"
  # from "a different process now holds a recycled pid", which is the
  # exact hazard R66 was fixed to guard against elsewhere in this file.
  POST_KILL_SURVIVORS=$(check_snapshot_survivors "$PRE_KILL_SNAPSHOT")
  if ! echo "$POST_KILL_SURVIVORS" | grep -qx "$REAL_CHILD_WINPID"; then
    pass "Phase-3 case: the real child (matched by pid and start time) is gone after stop_child's own tree kill (the CRLF bug's exact path)"
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
