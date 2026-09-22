#!/usr/bin/env bash
# Live test: v2 Section 0 item 2, the stop-path defect. A live incident
# showed a bash wrapper TERMed while the claude.exe process underneath it
# survived, still holding the persona claim, until the pre-gate timed out.
#
# An MSYS pid's WINPID (preferably /proc/<pid>/winpid; the `ps` row as a
# fallback, read at the offset that row's own shift dictates - this
# environment's `ps` has no `-o` support) must be resolved BEFORE the MSYS pid
# is signaled - once it exits, both reads find nothing. A genuine native Windows child process (not an
# MSYS-forked one, which does not expose a discoverable Win32 parent) is
# exactly what Get-CimInstance Win32_Process's ParentProcessId walk
# correctly finds and kills. And the snapshot must be taken before ANY
# phase signals the wrapper, not after Phase 1/2's own kill -0 check
# fails - the live incident's exact shape (TERM kills the wrapper, the
# real child survives) is invisible to a check that only ever asks about
# the wrapper's own pid.
#
# This proves the real fix against real processes, not fakes or unit-
# tested stand-ins, without launching a full claude session (which the
# live-* suites already do, at real cost and real contention with any
# other live session on the box).
#
# The functions under test are extracted verbatim from bin/supervise.sh (a sed
# range between each function's own opening and closing brace) rather than
# duplicated here, so this test exercises the actual shipped functions and not
# a copy that can drift. Which functions those are is derived from the bodies
# themselves: the cases name their entry points, and everything those bodies
# call is walked in.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SUPERVISE="$PLUGIN_DIR/bin/supervise.sh"
# A real temp dir, not this repo's own run/ (the live supervisor's
# default RUNDIR) - a concurrent supervised run must never share this
# test's scratch files.
RUNDIR="$(mktemp -d)"
trap 'rm -rf "$RUNDIR"' EXIT

# This suite launches no claude session and holds no persona claim, so it
# runs on its own beside a live fleet, and .kit/live-all.sh does not run it.
# SUITE_DIR is the convention the live suites read their scratch dir from
# when a runner drives them; a standalone run (no SUITE_DIR set) falls back
# to its own mktemp -d.
SUITE_DIR="${SUITE_DIR:-$(mktemp -d)}"
mkdir -p "$SUITE_DIR"
EXIT_FILE="$SUITE_DIR/stopprocesstree-test.exit"

FAIL_COUNT=0
CHECK_COUNT=0
pass() { echo "OK: $1"; CHECK_COUNT=$((CHECK_COUNT + 1)); }
failed() { echo "FAIL: $1"; CHECK_COUNT=$((CHECK_COUNT + 1)); FAIL_COUNT=$((FAIL_COUNT + 1)); }

# The extractor and the closure walker are shared with the other suite that
# drives the supervisor's own function bodies, so the two cannot disagree
# about what gets extracted. The withheld-callee control below runs against
# that shared copy.
. "$SCRIPT_DIR/supervisor-fn-extract.sh"

# The suite's own call shape over the shared extractor: a failed extraction is
# an extraction problem and ends the run, never a quietly missing function.
extract_fn() {
  local fn_name="$1"
  local out_file="$2"
  local file="${3:-$SUPERVISE}"
  if ! supervisor_extract_fn "$file" "$fn_name" "$out_file"; then
    echo "FAIL: could not extract ${fn_name}() from $file - the sed range or the upstream function name has drifted"
    exit 1
  fi
}

# STOP_PS_SENTINEL is a global the extracted functions close over, not
# part of any single function body - sourced from supervise.sh's own
# assignment line rather than retyped here, so the two can't drift.
STOP_PS_SENTINEL=$(grep '^STOP_PS_SENTINEL=' "$SUPERVISE" | head -1 | cut -d= -f2- | tr -d '"')
if [ -z "$STOP_PS_SENTINEL" ]; then
  echo "FAIL: could not read STOP_PS_SENTINEL's value from $SUPERVISE"
  exit 1
fi
# SUPERVISOR_PS_BOUND_S is the same shape of global the extracted
# functions close over - its default value is read from supervise.sh's
# own line rather than hardcoded here.
SUPERVISOR_PS_BOUND_S=$(grep '^SUPERVISOR_PS_BOUND_S="\${supervisorPsBoundS:-' "$SUPERVISE" | head -1 | sed -n 's/.*:-\([0-9]*\)}"/\1/p')
if [ -z "$SUPERVISOR_PS_BOUND_S" ]; then
  echo "FAIL: could not read SUPERVISOR_PS_BOUND_S's default value from $SUPERVISE"
  exit 1
fi

# The entry points the cases below call. Everything those reach is added by
# the closure walk, so a helper the supervisor grows under one of them is
# extracted without a line here.
SEED_FNS="stop_child snapshot_process_tree check_snapshot_survivors kill_process_snapshot resolve_windows_pid run_bounded_powershell_capture run_bounded_powershell run_bounded_native"
# `log` and `log_diag` are stubbed below, so the walk stops at them and the
# real ones stay out of the extracted file.
SUPERVISOR_CLOSURE_STUBS=" log log_diag "
EXTRACTED_FNS=$(supervisor_fn_closure "$SUPERVISE" $SEED_FNS)

FN_FILE="$RUNDIR/stop-process-tree-fns.sh"
: > "$FN_FILE"
for fn in $EXTRACTED_FNS; do
  extract_fn "$fn" "$FN_FILE"
done
# The real functions shell out to `log` and read $RUNDIR (already set,
# above, to this test's own scratch dir - real, not stubbed, since
# kill_process_snapshot writes to "$RUNDIR/supervisor.err").
log() { echo "[log] $*"; }
log_diag() { echo "[log_diag] $*" >&2; }
# The supervisor's own globals the extracted functions close over. Under
# `set -u` a bare expansion of one that was never assigned aborts this suite,
# and CHILD_INDEX names the child in every line sweep_child_tree logs.
CHILD_INDEX="${CHILD_INDEX:-0}"
CHILD_TREE_WALKED="${CHILD_TREE_WALKED:-}"
CHILD_TREE_SEEN_WINPIDS="${CHILD_TREE_SEEN_WINPIDS:-}"
CHILD_TREE_WINPIDS="${CHILD_TREE_WINPIDS:-}"
CHILD_TREE_SNAPSHOT="${CHILD_TREE_SNAPSHOT:-}"
CHILD_TREE_READ_FAILED="${CHILD_TREE_READ_FAILED:-}"
CHILD_TREE_DESCENDANT_SEEN="${CHILD_TREE_DESCENDANT_SEEN:-}"
CHILD_TREE_CONFIRMED_AT="${CHILD_TREE_CONFIRMED_AT:-}"
source "$FN_FILE"

# A truncated extraction (a sed range mismatch, a renamed function
# upstream) must fail as an extraction problem, not silently produce a
# no-op function that passes every check by doing nothing. Check each
# function actually landed before trusting any of them. The list checked here
# is the same one the extraction ran over, so the two cannot disagree.
FN_COUNT=$(echo "$EXTRACTED_FNS" | wc -w)
for fn in $EXTRACTED_FNS; do
  if ! declare -F "$fn" > /dev/null; then
    echo "FAIL: extraction did not define $fn - the sed range or the upstream function name has drifted"
    exit 1
  fi
done
pass "setup: all $FN_COUNT functions extracted and defined"

# --- Case: the walk reaches a callee no line of this suite names ---
# The guard above is an absence check: it passes when nothing is undefined,
# which is also how it reads when the walk never reached a function at all.
# So put a callee the walk has to find in front of it. The name is built at
# run time from this run's own pid, so it appears in no literal here and is
# matched on its shape as a declaration under an extracted caller. The seed
# list has to miss it and the closure has to carry it.
CONTROL_SUPERVISE="$RUNDIR/supervise-with-withheld-callee.sh"
CONTROL_FN="withheld_callee_$$"
awk -v fn="$CONTROL_FN" '
  { print }
  /^sweep_child_tree\(\) \{$/ { print "  " fn " \"$1\" || true" }
' "$SUPERVISE" > "$CONTROL_SUPERVISE"
printf '%s() {\n  echo "withheld $1"\n}\n' "$CONTROL_FN" >> "$CONTROL_SUPERVISE"
if grep -q "^  ${CONTROL_FN} " "$CONTROL_SUPERVISE" && grep -q "^${CONTROL_FN}() {$" "$CONTROL_SUPERVISE"; then
  pass "control: the withheld callee is declared and called in the control copy"
else
  failed "control: the withheld callee was not injected into $CONTROL_SUPERVISE"
fi
case " $SEED_FNS " in
  *" $CONTROL_FN "*) failed "control: the seed list names the withheld callee, so it is not withheld" ;;
  *) pass "control: the seed list does not name the withheld callee" ;;
esac
CONTROL_CLOSURE=$(supervisor_fn_closure "$CONTROL_SUPERVISE" $SEED_FNS)
case " $(echo "$CONTROL_CLOSURE" | tr '\n' ' ') " in
  *" $CONTROL_FN "*) pass "control: the closure walk picks the withheld callee up from its caller's body" ;;
  *) failed "control: the closure walk missed the withheld callee, so the extraction is still a typed list" ;;
esac

# --- Case: a walk that reaches this supervisor's own process is refused whole ---
# The walk follows Windows ParentProcessId, which Windows recycles, so a
# recycled id can pull this process into a tree it is no part of. Everything
# the walk reached through this process sits under it, so dropping that one row
# and keeping the rest hands a caller a kill list built out of an unrelated
# tree. The walk's own result is stood in for by shadowing the single seam
# snapshot_process_tree calls through, so the case turns on the refusal rather
# than on what happens to be running on the box.
SELF_WINPID=$(resolve_windows_pid "$$")
if [ -z "$SELF_WINPID" ]; then
  failed "setup: this suite's own Windows pid does not resolve, so the self-pid refusal cannot be driven"
else
  eval "$(declare -f run_bounded_powershell_capture | sed '1s/run_bounded_powershell_capture/_real_rbpc_for_selfpid/')"
  run_bounded_powershell_capture() {
    printf '%s\n' "4242,111" "$SELF_WINPID,222" "4243,333" "$STOP_PS_SENTINEL"
  }
  SELFPID_OUT=$(snapshot_process_tree 999999)
  SELFPID_RC=$?
  if [ "$SELFPID_RC" -eq 1 ] && [ -z "$SELFPID_OUT" ]; then
    pass "self pid: a completed walk carrying this supervisor's own Windows pid is refused whole, every row with it (rc=$SELFPID_RC)"
  else
    failed "self pid: the walk returned rc=$SELFPID_RC and [$(echo "$SELFPID_OUT" | tr '\n' ' ')] - the rows reached through this process were kept"
  fi
  run_bounded_powershell_capture() {
    printf '%s\n' "4242,111" "4243,333" "$STOP_PS_SENTINEL"
  }
  SELFPID_CONTROL_OUT=$(snapshot_process_tree 999999)
  SELFPID_CONTROL_RC=$?
  if [ "$SELFPID_CONTROL_RC" -eq 0 ] && [ "$(printf '%s' "$SELFPID_CONTROL_OUT" | tr '\n' ' ')" = "4242,111 4243,333" ]; then
    pass "self pid: control: the same walk with no self pid in it is reported whole, so the refusal above is the self pid and not a dead instrument"
  else
    failed "self pid: control failed (rc=$SELFPID_CONTROL_RC, out=[$(echo "$SELFPID_CONTROL_OUT" | tr '\n' ' ')]) - the instrument cannot be trusted for the refusal above"
  fi
  eval "$(declare -f _real_rbpc_for_selfpid | sed '1s/_real_rbpc_for_selfpid/run_bounded_powershell_capture/')"
fi

# --- Case: a root pid that is not a number never reaches PowerShell ---
# snapshot_process_tree interpolates its argument into a PowerShell command, so
# a value that is not a Windows pid has no safe reading there. The seam it
# would spawn through records that it ran, so this asserts the refusal landed
# ahead of the spawn rather than that the spawn merely failed afterwards.
SPAWN_MARKER="$RUNDIR/snapshot-spawn-marker"
rm -f "$SPAWN_MARKER"
eval "$(declare -f run_bounded_powershell_capture | sed '1s/run_bounded_powershell_capture/_real_rbpc_for_badpid/')"
run_bounded_powershell_capture() {
  : > "$SPAWN_MARKER"
  printf '%s\n' "$STOP_PS_SENTINEL"
}
BADPID_OUT=$(snapshot_process_tree '1234; Write-Output reached')
BADPID_RC=$?
if [ "$BADPID_RC" -eq 1 ] && [ -z "$BADPID_OUT" ] && [ ! -f "$SPAWN_MARKER" ]; then
  pass "bad root pid: a root that is not digits only is refused before any PowerShell command is built from it (rc=$BADPID_RC)"
else
  failed "bad root pid: rc=$BADPID_RC, out=[$BADPID_OUT], the spawn seam was reached=$([ -f "$SPAWN_MARKER" ] && echo yes || echo no)"
fi
rm -f "$SPAWN_MARKER"
BADPID_CONTROL_OUT=$(snapshot_process_tree 4242)
BADPID_CONTROL_RC=$?
if [ "$BADPID_CONTROL_RC" -eq 0 ] && [ -f "$SPAWN_MARKER" ] && [ -z "$BADPID_CONTROL_OUT" ]; then
  pass "bad root pid: control: a digits-only root does reach the spawn seam, so the refusal above is the validation and not a function that never spawns"
else
  failed "bad root pid: control failed (rc=$BADPID_CONTROL_RC, the spawn seam was reached=$([ -f "$SPAWN_MARKER" ] && echo yes || echo no))"
fi
rm -f "$SPAWN_MARKER"
eval "$(declare -f _real_rbpc_for_badpid | sed '1s/_real_rbpc_for_badpid/run_bounded_powershell_capture/')"

# Production runs every extracted call under real shell semantics,
# including a pipeline whose upstream command fails silently unless
# pipefail is set - run this test under the same semantics its
# production callers actually use.
set -o pipefail

# --- Case: run_bounded_powershell actually holds its bound (a bare
# `kill -9` on the tail-exec subshell's own pid does not hold under
# load, so a 3s bound around a 40s sleep can return long after 3-5s) ---
# Run exactly as production calls it: through run_bounded_powershell_capture,
# inside a command substitution, since that combination - not a bare direct
# call - is what the reproduction actually needed to surface the hang.
R79_START=$(date +%s)
# Asserting only that the sleep's own late output never reached the
# caller is vacuous once the caller reads a file rather than a pipe,
# since the outfile is deleted at about bound+5s and "done-late" lands
# at 40s in a file nobody is still reading; that leg passes whether or
# not the process was actually killed. `TESTPID:$PID` is the test's own
# marker (distinct from run_bounded_powershell's internal `PSPID:`
# bookkeeping line, which is stripped before the caller ever sees it) -
# it survives into R79_OUT and gives this case the real powershell.exe
# pid to assert dead afterward, by pid AND start time, the same standard
# the rest of this file holds every other kill to.
R79_OUT=$(run_bounded_powershell_capture 3 "Write-Output (\"TESTPID:\" + \$PID + \",\" + (Get-Process -Id \$PID).StartTime.Ticks); Start-Sleep -Seconds 40; Write-Output 'done-late'")
R79_RC=$?
R79_ELAPSED=$(( $(date +%s) - R79_START ))
# A 3s-bound call can legitimately take up to about 23s of helper time
# under load: winpid poll up to 5s, wait loop up to bound, reap poll up
# to 5s, plus two taskkill calls each capped at 5s. A flat ceiling near
# that computed worst path, with no slack for scheduling variance, flakes
# red on nothing but timing noise, so the ceiling is scaled off the bound
# itself with slack built in.
R79_CEILING=$((3 + 30))
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
  R79_SURVIVORS_RC=$?
  if [ "$R79_SURVIVORS_RC" -ne 0 ] || [ -n "$R79_SURVIVORS" ]; then
    failed "R79 regression: the real powershell.exe process (pid,ticks=$R79_REAL_SNAPSHOT) SURVIVED the bound, or the check could not be verified (rc=$R79_SURVIVORS_RC) - the stub was killed, the native process was not confirmed dead"
  else
    pass "R79 regression: the real powershell.exe process (pid,ticks=$R79_REAL_SNAPSHOT), not just the MSYS stub, is confirmed dead after the bound"
  fi
fi

# --- Case: the wrapper's own exec target is killed by its recorded pid and
# start ticks ---
# A bash subshell that tail-execs directly into a native binary with
# nothing after it collapses into one process. The kill is
# `kill_process_snapshot` over the snapshot recorded while that process was
# confirmed alive, so it reaches that process only while the pid still holds
# the start ticks the snapshot recorded. A bare `taskkill //F //PID` on a pid
# read before a PowerShell call bounded at 30s would kill whatever holds the
# number by then, and a tree kill re-walks live parent ids that Windows keeps
# in orphans and reuses. A bare `kill -9` on the MSYS pid itself can block
# for minutes and return "Permission denied" instead, which is why
# `run_bounded_powershell` does not use it either. `resolve_windows_pid` must
# run before any termination attempt, same as production - once the pid
# exits, the read finds nothing.
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
  # Asserts the actual descendant pid, not just "some Get-Process -Id
  # $DIRECT_WINPID query returns nothing" - that query alone cannot tell
  # a genuinely dead process from one whose pid is simply not what got
  # walked. Snapshot the whole tree from DIRECT_WINPID (the same helper
  # production uses) before the kill and check every entry, matched by
  # pid and start time, afterward.
  DIRECT_SNAPSHOT=$(snapshot_process_tree "$DIRECT_WINPID")
  # An empty $DIRECT_SNAPSHOT reads exactly like "the walk found nothing"
  # whether the cause is a genuinely gone process or a timed-out/failed
  # walk. Guarded before use, same as every dead-assertion below.
  if [ -z "$DIRECT_SNAPSHOT" ]; then
    failed "setup: snapshot_process_tree returned nothing for a confirmed-live winpid ($DIRECT_WINPID) - the walk itself failed, this case cannot proceed"
  else
    kill_process_snapshot "$DIRECT_SNAPSHOT" > /dev/null 2>&1
    sleep 2
    DIRECT_SURVIVORS=$(check_snapshot_survivors "$DIRECT_SNAPSHOT")
    DIRECT_SURVIVORS_RC=$?
    if [ -z "$DIRECT_SURVIVORS" ] && [ "$DIRECT_SURVIVORS_RC" -eq 0 ]; then
      pass "direct-exec case: the ticks-matched snapshot kill ends the real Windows process (every snapshotted pid, matched by start time, confirmed dead)"
    else
      failed "direct-exec case: the real Windows process SURVIVED the ticks-matched snapshot kill, or the check could not be verified (rc=$DIRECT_SURVIVORS_RC, survivors=$DIRECT_SURVIVORS)"
      kill_process_snapshot "$DIRECT_SNAPSHOT" > /dev/null 2>&1
    fi
  fi
fi

# --- Case: stop_child itself, not just the raw tree-kill helper,
# actually stops a wrapper whose real child survives it
# --- This is the shape the spec's own acceptance criterion asks for: a
# child whose claude.exe outlives its wrapper is still fully stopped by
# stop_child, end to end.
CHILD_IN=""  # stop_child checks this; empty means Phase 1's EOF close is a no-op
SUPERVISOR_STOP_GRACE_MS=2000  # short grace so this test doesn't wait a full minute per phase
STOP_PATH=""
( powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90" & echo $! > "$RUNDIR/child.pid"; wait ) &
CHILD_LAUNCH_PID=$!  # the variable stop_child reads the child's pid from
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
  # Recorded before stop_child runs, so a cleanup after a failure below kills
  # only this child, matched by its start ticks, and never a process that has
  # taken its pid since.
  REAL_CHILD_SNAPSHOT=$(snapshot_process_tree "$REAL_CHILD_WINPID")
  stop_child "test"
  sleep 2
  if [ -z "$(powershell -NoProfile -Command "Get-Process -Id $REAL_CHILD_WINPID -ErrorAction SilentlyContinue" 2>/dev/null)" ]; then
    pass "stop_child: the real child is gone after stop_child returns (STOP_PATH=$STOP_PATH) - the exact defect this fixes"
  else
    failed "stop_child: the real child SURVIVED stop_child (STOP_PATH=$STOP_PATH) - the orphan defect is not fixed"
    kill_process_snapshot "$REAL_CHILD_SNAPSHOT" > /dev/null 2>&1
  fi
fi

# --- Case: a wrapper that ignores TERM forces stop_child to Phase 3, the
# path where the CRLF bug actually lived ---
# The prior case above only ever reaches Phase 2 (a plain bash wrapper
# dies to TERM on its own). Phase 3's own kill_process_snapshot is where
# `Stop-Process` and the per-pid survivor probe both take a snapshot built
# from `snapshot_process_tree`'s own output - exactly the path that broke
# on an unstripped `\r` when this was reproduced live.
CHILD_IN=""
SUPERVISOR_STOP_GRACE_MS=2000
STOP_PATH=""
( trap '' TERM; powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90" & echo $! > "$RUNDIR/child3.pid"; wait ) &
CHILD_LAUNCH_PID=$!
disown "$CHILD_LAUNCH_PID" 2>/dev/null
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

  # A `\r` landing on the ticks field (not the pid) makes the kill list
  # valid, lets Stop-Process succeed, and only silently drops the ticks
  # comparison downstream - the child ends up dead either way, so a case
  # that only checks the child died would never notice the comparison
  # itself is broken. Asserts the snapshot's own shape and a positive
  # control (this live child reads as a survivor before the kill) so a
  # regression here fails on its own signal, not by accident.
  PRE_KILL_SNAPSHOT=$(snapshot_process_tree "$REAL_CHILD_WINPID")
  # The glob `[0-9]*,[0-9]*` would accept `1234,63837\r` (the trailing
  # `\r` falls inside the second `*`) and `1234,6x` (same reason), so it
  # does not actually pin the intended shape. `grep -Eqx` anchors both
  # ends of the line and pins the exact two shapes this function can
  # legitimately emit (a numeric ticks value, or the literal
  # `UNREADABLE` marker), catching both a stray CR and a mid-file garbage
  # character a glob would silently pass.
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
  # A timed-out probe (empty output, rc 1) would pass this check exactly
  # like a genuinely absent survivor if read from output alone. rc is
  # read explicitly at every one of this file's own
  # check_snapshot_survivors call sites instead.
  PRE_KILL_SURVIVORS=$(check_snapshot_survivors "$PRE_KILL_SNAPSHOT")
  PRE_KILL_SURVIVORS_RC=$?
  if [ "$PRE_KILL_SURVIVORS_RC" -eq 0 ] && echo "$PRE_KILL_SURVIVORS" | grep -qx "$REAL_CHILD_WINPID"; then
    pass "Phase-3 case: positive control - the live child reads as a survivor before any kill runs"
  else
    failed "Phase-3 case: positive control failed (rc=$PRE_KILL_SURVIVORS_RC) - the live child ($REAL_CHILD_WINPID) was not reported as a survivor before the kill; the instrument cannot be trusted for the assertion below"
  fi

  stop_child "test-phase3"
  if [ "$STOP_PATH" = "kill" ]; then
    pass "Phase-3 case: stop_child actually escalated to Phase 3 (STOP_PATH=kill), the path this test needs to exercise"
  else
    failed "Phase-3 case: stop_child never reached Phase 3 (STOP_PATH=$STOP_PATH) - the TERM-ignoring wrapper did not force escalation, this case did not reproduce"
  fi
  sleep 2
  # Checks pid AND start time, not pid alone - a bare "is this pid gone"
  # check cannot tell "the same process is dead" from "a different
  # process now holds a recycled pid", the same hazard guarded against
  # elsewhere in this file.
  POST_KILL_SURVIVORS=$(check_snapshot_survivors "$PRE_KILL_SNAPSHOT")
  POST_KILL_SURVIVORS_RC=$?
  if [ "$POST_KILL_SURVIVORS_RC" -eq 0 ] && ! echo "$POST_KILL_SURVIVORS" | grep -qx "$REAL_CHILD_WINPID"; then
    pass "Phase-3 case: the real child (matched by pid and start time) is gone after stop_child's own tree kill (the CRLF bug's exact path)"
  else
    failed "Phase-3 case: the real child SURVIVED Phase 3's tree kill, or the check could not be verified (rc=$POST_KILL_SURVIVORS_RC) - the CRLF bug or an equivalent is back"
    kill_process_snapshot "$PRE_KILL_SNAPSHOT" > /dev/null 2>&1
  fi
fi

# --- Case: a CIM failure during the descendant walk is reported as
# unverified, not a false-clean root-only tree ---
# `Get-CimInstance` is shadowed with a throw by redefining `run_bounded_
# powershell_capture` (the one seam `snapshot_process_tree` calls through)
# to prepend a shadow function definition ahead of its real script - a
# PowerShell function in the same -Command scope resolves before a
# same-named cmdlet, so the process table read fails exactly like a
# real WMI outage would, without touching `snapshot_process_tree`'s own
# extracted body at all. Asserts rc 1 (unverified): a CIMFAIL marker that
# never reached real stdout would report a false-clean root-only tree,
# rc 0, instead.
#
# The sleeper this case walks is launched, resolved and recorded as its pid
# and start ticks before the shadow goes in, since the shadowed walk cannot
# record it. The cleanup kills that record through `kill_process_snapshot`,
# so it ends the sleeper only while its pid still holds the recorded start
# ticks, never whatever process holds the number by then.
( exec powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30" ) &
CIMFAIL_PID=$!
sleep 2
CIMFAIL_WINPID=$(resolve_windows_pid "$CIMFAIL_PID")
CIMFAIL_PAIR=""
if [ -n "$CIMFAIL_WINPID" ]; then
  CIMFAIL_PAIR=$(snapshot_process_tree "$CIMFAIL_WINPID" | grep -E "^${CIMFAIL_WINPID},[0-9]+$" | head -1)
fi
eval "$(declare -f run_bounded_powershell_capture | sed '1s/run_bounded_powershell_capture/_real_run_bounded_powershell_capture_for_r105/')"
run_bounded_powershell_capture() {
  local bound="$1"
  local script="$2"
  _real_run_bounded_powershell_capture_for_r105 "$bound" "function Get-CimInstance { throw 'R105_SIMULATED_CIM_FAILURE' }
$script"
}
if [ -z "$CIMFAIL_WINPID" ]; then
  failed "setup: could not resolve a winpid for the R105 CIM-failure case"
else
  snapshot_process_tree "$CIMFAIL_WINPID" > /dev/null
  CIMFAIL_SNAP_RC=$?
  if [ "$CIMFAIL_SNAP_RC" -eq 1 ]; then
    pass "R101/R104/R105: snapshot_process_tree returns 1 (unverified) when the CIM walk itself fails, not a false-clean root-only tree"
  else
    failed "R101/R104/R105: snapshot_process_tree returned rc=$CIMFAIL_SNAP_RC (expected 1) when the CIM walk fails - R104's exact defect is back"
  fi
fi
# Restore the real implementation for anything that runs after this case.
eval "$(declare -f _real_run_bounded_powershell_capture_for_r105 | sed '1s/_real_run_bounded_powershell_capture_for_r105/run_bounded_powershell_capture/')"
# kill -9 on $CIMFAIL_PID hits the MSYS stub only, not the live native
# powershell.exe underneath it. The sleeper is ended by the pid and start
# ticks recorded while it was alive. With no record there is nothing to match
# a kill against, and the sleeper ends on its own within 30s.
if [ -n "$CIMFAIL_PAIR" ]; then
  kill_process_snapshot "$CIMFAIL_PAIR" > /dev/null 2>&1
else
  echo "  NOTE: no pid and start ticks were recorded for the R105 sleeper, so it is left to end on its own"
fi

# --- Cases: the patient stop ---
# Under the restart_passive label alone, stop_child keeps waiting after the
# EOF grace while the child's own stdout.jsonl reads busy, up to
# SUPERVISOR_STOP_BUSY_CAP_MS from the EOF close. The cases below drive the
# real stop_child against a stub that reads its input to end of file, as the
# production child does, so the EOF close inside stop_child is what the stub
# sees. The stream the reader consults is a scratch stdout.jsonl under
# SUITE_DIR, named through OUT exactly as the poll loop names the child's.
#
# The stub is a coproc, which is what production launches: CHILD_IN holds the
# coproc's write fd so stop_child's own `exec $CHILD_IN>&-` is the EOF. The
# stub records the moment it saw end of input, and the log stub below stamps
# each line, so the time from the EOF close to a TERM is read off the run
# itself rather than off a clock started before stop_child's snapshot walk.
patient_log() { echo "[log] $(date +%s%3N) $*"; }
eval "$(declare -f log | sed '1s/^log/_plain_log_before_patient/')"
eval "$(declare -f patient_log | sed '1s/^patient_log/log/')"
PATIENT_DIR="$SUITE_DIR/patient-stop"
mkdir -p "$PATIENT_DIR"
# What the snapshot rebuild after a wait may cost before the TERM: two tree
# walks, measured at about six seconds on this box, with headroom.
REBUILD_ALLOWANCE_MS=12000
USER_TOOL_RESULT='{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}'
ASSISTANT_TOOL_USE='{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}'
# A text-only reply whose own timestamp is six minutes old at the moment it is
# built, so the reader ages it past the five minute idle bound at once.
stale_assistant_text() {
  local ts
  ts=$(date -u -d '@'"$(( $(date +%s) - 360 ))" +%Y-%m-%dT%H:%M:%S.000Z)
  printf '{"type":"assistant","timestamp":"%s","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}' "$ts"
}
# Usage: start_stub <name> <seconds to live after end of input>
# Sets CHILD_LAUNCH_PID and CHILD_IN, and records the stub's EOF moment in
# $PATIENT_DIR/<name>.eof once the stub sees it. The sleeper that keeps the
# stub alive past its EOF starts only after the stop's entry snapshot was
# built, exactly as a tool call the child runs during the wait does, and its
# pid lands in $PATIENT_DIR/<name>.sleeper so a case can ask whether the tree
# kill reached it.
start_stub() {
  local name="$1" live_s="$2"
  rm -f "$PATIENT_DIR/$name.eof" "$PATIENT_DIR/$name.sleeper"
  coproc PATIENT_STUB { cat > /dev/null; date +%s%3N > "$PATIENT_DIR/$name.eof"; sleep "$live_s" & echo $! > "$PATIENT_DIR/$name.sleeper"; wait; }
  CHILD_LAUNCH_PID="$PATIENT_STUB_PID"
  CHILD_IN="${PATIENT_STUB[1]}"
  eval "exec ${PATIENT_STUB[0]}<&-"
  disown "$CHILD_LAUNCH_PID" 2>/dev/null
  STUB_NAME="$name"
  sleep 2
}
# Usage: stamp_of <log file> <pattern> - the first stamped line matching.
stamp_of() { grep -m1 "$2" "$1" | sed -n 's/^\[log\] \([0-9]*\) .*/\1/p'; }
# Usage: sleeper_alive - 0 when the current stub's sleeper is still running.
sleeper_alive() {
  local sp
  sp=$(cat "$PATIENT_DIR/$STUB_NAME.sleeper" 2>/dev/null)
  [ -n "$sp" ] && kill -0 "$sp" 2>/dev/null
}
end_stub() {
  local sp
  sp=$(cat "$PATIENT_DIR/$STUB_NAME.sleeper" 2>/dev/null)
  kill -9 "$CHILD_LAUNCH_PID" ${sp:+"$sp"} 2>/dev/null
  CHILD_LAUNCH_PID=""
  CHILD_IN=""
  OUT=""
}

# --- Case: restart_passive, busy stream, the stub exits on end of input ---
# The stream ends in a tool_use record, so the reader answers busy for the
# whole wait. The stub lives ninety seconds past the EOF close, well past the
# grace and short of the cap, so the wait has to end on the stub's own exit:
# no TERM line, and STOP_PATH is eof. The absence is grepped for the TERM
# predicate every Phase 2 line carries; the stop_complete case below is the
# control where the same predicate matches.
OUT="$PATIENT_DIR/busy-exits.jsonl"
printf '%s\n%s\n' "$USER_TOOL_RESULT" "$ASSISTANT_TOOL_USE" > "$OUT"
SUPERVISOR_STOP_GRACE_MS=2000
SUPERVISOR_STOP_BUSY_CAP_MS=120000
STOP_PATH=""
start_stub busy-exits 90
P1_LOG="$PATIENT_DIR/busy-exits.log"
stop_child "restart_passive" > "$P1_LOG" 2>&1
P1_RC=$?
if grep -q "sending TERM" "$P1_LOG"; then
  failed "patient stop: restart_passive on a busy stub that exits on EOF sent TERM (STOP_PATH=$STOP_PATH rc=$P1_RC): $(grep 'sending TERM' "$P1_LOG" | head -1)"
else
  pass "patient stop: restart_passive on a busy stub that exits on EOF logged no TERM line"
fi
if [ "$STOP_PATH" = "eof" ] && [ "$P1_RC" -eq 0 ]; then
  pass "patient stop: the stub's own exit inside the wait reaches STOP_PATH=eof (rc=$P1_RC)"
else
  failed "patient stop: expected STOP_PATH=eof rc=0 after the stub exited on EOF, got STOP_PATH=$STOP_PATH rc=$P1_RC"
fi
if grep -q "the child is inside a turn, waiting for it to end" "$P1_LOG" && grep -q "the child exited during the patient wait" "$P1_LOG"; then
  pass "patient stop: the wait logged its entry and its exit by the child's own exit"
else
  failed "patient stop: the entry or exit line of the wait is missing: $(tr '\n' '|' < "$P1_LOG")"
fi
end_stub

# --- Case: restart_passive, busy stream, the stub never exits ---
# The wait runs to the cap. The first TERM line has to be the cap's own, and
# the cap line has to land at or past the cap, with the Phase 2 TERM following
# it inside the rebuild allowance. The lower bound counts from a clock read
# taken before stop_child runs, which is no later than the close stop_child
# measures from, so a cap met on time can never read as early. The upper
# bound counts from the moment the stub saw its input close, which is no
# earlier than that close, so a late cap can never read as on time. The cap
# is four times the grace, so a TERM at the grace reds the timing leg. The
# sleeper started after the entry snapshot, so it is dead afterwards only if
# the snapshot was rebuilt after the wait.
OUT="$PATIENT_DIR/busy-never-exits.jsonl"
printf '%s\n%s\n' "$USER_TOOL_RESULT" "$ASSISTANT_TOOL_USE" > "$OUT"
SUPERVISOR_STOP_GRACE_MS=2000
SUPERVISOR_STOP_BUSY_CAP_MS=8000
STOP_PATH=""
start_stub busy-never-exits 180
P2_LOG="$PATIENT_DIR/busy-never-exits.log"
P2_BEFORE=$(date +%s%3N)
stop_child "restart_passive" > "$P2_LOG" 2>&1
P2_RC=$?
P2_EOF=$(cat "$PATIENT_DIR/busy-never-exits.eof" 2>/dev/null)
P2_CAP=$(stamp_of "$P2_LOG" "the busy cap of ${SUPERVISOR_STOP_BUSY_CAP_MS}ms was reached")
P2_TERM=$(stamp_of "$P2_LOG" "EOF grace expired, sending TERM")
if [ -z "$P2_EOF" ] || [ -z "$P2_CAP" ] || [ -z "$P2_TERM" ]; then
  failed "patient stop: cap case could not read the EOF moment ($P2_EOF), the cap line ($P2_CAP) or the TERM line ($P2_TERM): $(tr '\n' '|' < "$P2_LOG")"
else
  P2_AFTER=$((P2_CAP - P2_EOF))
  if [ $((P2_CAP - P2_BEFORE)) -ge "$SUPERVISOR_STOP_BUSY_CAP_MS" ] && [ "$P2_AFTER" -le $((SUPERVISOR_STOP_BUSY_CAP_MS + 7000)) ]; then
    pass "patient stop: a busy stub that never exits reaches the cap ${P2_AFTER}ms after its input closed, at the ${SUPERVISOR_STOP_BUSY_CAP_MS}ms cap and not before"
  else
    failed "patient stop: the cap was reached ${P2_AFTER}ms after the input closed and $((P2_CAP - P2_BEFORE))ms after the stop began, against a ${SUPERVISOR_STOP_BUSY_CAP_MS}ms cap (expected at the cap, within one poll)"
  fi
  # The TERM follows the cap line by the snapshot rebuild; a TERM later than
  # the allowance means the rebuild hung.
  if [ $((P2_TERM - P2_CAP)) -ge 0 ] && [ $((P2_TERM - P2_CAP)) -le "$REBUILD_ALLOWANCE_MS" ]; then
    pass "patient stop: TERM follows the cap line by $((P2_TERM - P2_CAP))ms, inside the ${REBUILD_ALLOWANCE_MS}ms rebuild allowance"
  else
    failed "patient stop: TERM followed the cap line by $((P2_TERM - P2_CAP))ms, outside the ${REBUILD_ALLOWANCE_MS}ms rebuild allowance"
  fi
fi
if sleeper_alive; then
  failed "patient stop: the sleeper the stub started during the wait survived the stop (STOP_PATH=$STOP_PATH), so the tree kill ran on the entry snapshot"
else
  pass "patient stop: the sleeper the stub started during the wait is dead after the stop, so the tree kill saw the rebuilt snapshot"
fi
if grep -m1 "sending TERM" "$P2_LOG" | grep -q "the busy cap of ${SUPERVISOR_STOP_BUSY_CAP_MS}ms was reached"; then
  pass "patient stop: the first TERM line is the cap's own, so no TERM was logged before the cap"
else
  failed "patient stop: the first TERM line is not the cap's: $(grep -m1 'sending TERM' "$P2_LOG")"
fi
if [ "$STOP_PATH" = "term" ] || [ "$STOP_PATH" = "kill" ]; then
  pass "patient stop: the existing phases follow the cap (STOP_PATH=$STOP_PATH rc=$P2_RC)"
else
  failed "patient stop: expected the TERM or KILL phase after the cap, got STOP_PATH=$STOP_PATH rc=$P2_RC"
fi
end_stub

# --- Case: restart_passive, the stream reads idle ---
# A stale text-only reply is the newest record, so the reader answers idle at
# once and no wait begins: TERM after the ordinary grace, as for every other
# label. The cap sits at the minimum, below the grace, so it extends nothing.
OUT="$PATIENT_DIR/idle.jsonl"
printf '%s\n%s\n' "$USER_TOOL_RESULT" "$(stale_assistant_text)" > "$OUT"
SUPERVISOR_STOP_GRACE_MS=2000
SUPERVISOR_STOP_BUSY_CAP_MS=1000
STOP_PATH=""
start_stub idle 180
P3_LOG="$PATIENT_DIR/idle.log"
stop_child "restart_passive" > "$P3_LOG" 2>&1
P3_EOF=$(cat "$PATIENT_DIR/idle.eof" 2>/dev/null)
P3_TERM=$(stamp_of "$P3_LOG" "EOF grace expired, sending TERM")
if grep -q "inside a turn" "$P3_LOG"; then
  failed "patient stop: an idle stream still began the patient wait: $(grep 'inside a turn' "$P3_LOG")"
elif [ -n "$P3_EOF" ] && [ -n "$P3_TERM" ] && [ $((P3_TERM - P3_EOF)) -lt $((SUPERVISOR_STOP_GRACE_MS + 3000)) ]; then
  pass "patient stop: restart_passive on an idle stream sends TERM $((P3_TERM - P3_EOF))ms after the input closed, on the ordinary grace, with no wait begun"
else
  failed "patient stop: restart_passive on an idle stream did not TERM on the ordinary grace (eof=$P3_EOF term=$P3_TERM): $(tr '\n' '|' < "$P3_LOG")"
fi
end_stub

# --- Cases: the other labels on the busy stub ---
# The label guard in the negative direction: the same busy stream that holds a
# restart_passive stop to the cap is stopped on the ordinary grace under
# stop_complete and restart. These are also the control for the first case's
# absence check: the TERM predicate it grepped for matches here.
for other_label in stop_complete restart; do
  OUT="$PATIENT_DIR/busy-$other_label.jsonl"
  printf '%s\n%s\n' "$USER_TOOL_RESULT" "$ASSISTANT_TOOL_USE" > "$OUT"
  SUPERVISOR_STOP_GRACE_MS=2000
  SUPERVISOR_STOP_BUSY_CAP_MS=1000
  STOP_PATH=""
  start_stub "busy-$other_label" 180
  P4_LOG="$PATIENT_DIR/busy-$other_label.log"
  stop_child "$other_label" > "$P4_LOG" 2>&1
  P4_EOF=$(cat "$PATIENT_DIR/busy-$other_label.eof" 2>/dev/null)
  P4_TERM=$(stamp_of "$P4_LOG" "sending TERM")
  if grep -q "inside a turn" "$P4_LOG"; then
    failed "patient stop: the $other_label label began the patient wait, which belongs to restart_passive alone: $(grep 'inside a turn' "$P4_LOG")"
  elif [ -n "$P4_EOF" ] && [ -n "$P4_TERM" ] && [ $((P4_TERM - P4_EOF)) -lt $((SUPERVISOR_STOP_GRACE_MS + 3000)) ]; then
    pass "patient stop: $other_label on a busy stub sends TERM $((P4_TERM - P4_EOF))ms after the input closed, on the ordinary grace"
  else
    failed "patient stop: $other_label on a busy stub did not TERM on the ordinary grace (eof=$P4_EOF term=$P4_TERM): $(tr '\n' '|' < "$P4_LOG")"
  fi
  end_stub
done

# --- Case: the turn ends during the wait, and the stub never exits ---
# The stream reads busy when the wait begins. Once the entry line is logged, a
# stale text-only reply is appended, so the reader's next poll answers idle.
# The wait has to end within one five second poll of that append, allowing
# two seconds for the reader's own process, and far short of a cap that would
# red this case if the wait ran to it. TERM follows the wait's end by the
# snapshot rebuild, inside REBUILD_ALLOWANCE_MS.
OUT="$PATIENT_DIR/turn-ends.jsonl"
printf '%s\n%s\n' "$USER_TOOL_RESULT" "$ASSISTANT_TOOL_USE" > "$OUT"
SUPERVISOR_STOP_GRACE_MS=2000
SUPERVISOR_STOP_BUSY_CAP_MS=60000
STOP_PATH=""
start_stub turn-ends 180
P5_LOG="$PATIENT_DIR/turn-ends.log"
P5_APPENDED="$PATIENT_DIR/turn-ends.appended"
rm -f "$P5_APPENDED"
: > "$P5_LOG"
(
  tries=0
  until grep -q "inside a turn" "$P5_LOG" 2>/dev/null || [ "$tries" -ge 120 ]; do
    sleep 0.5
    tries=$((tries + 1))
  done
  sleep 3
  stale_assistant_text >> "$OUT"
  printf '\n' >> "$OUT"
  date +%s%3N > "$P5_APPENDED"
) &
P5_APPENDER=$!
stop_child "restart_passive" > "$P5_LOG" 2>&1
wait "$P5_APPENDER" 2>/dev/null
P5_AT=$(cat "$P5_APPENDED" 2>/dev/null)
P5_IDLE=$(stamp_of "$P5_LOG" "the reader returned idle after")
P5_TERM=$(stamp_of "$P5_LOG" "EOF grace expired, sending TERM")
if [ -z "$P5_AT" ] || [ -z "$P5_IDLE" ] || [ -z "$P5_TERM" ]; then
  failed "patient stop: turn-end case could not read the append moment ($P5_AT), the idle line ($P5_IDLE) or the TERM line ($P5_TERM): $(tr '\n' '|' < "$P5_LOG")"
elif [ $((P5_IDLE - P5_AT)) -ge 0 ] && [ $((P5_IDLE - P5_AT)) -le 7000 ] && [ $((P5_TERM - P5_IDLE)) -le "$REBUILD_ALLOWANCE_MS" ]; then
  pass "patient stop: the reader's idle ends the wait $((P5_IDLE - P5_AT))ms after the turn ended, within one poll and not at the ${SUPERVISOR_STOP_BUSY_CAP_MS}ms cap, and TERM follows it by $((P5_TERM - P5_IDLE))ms inside the rebuild allowance"
else
  failed "patient stop: the wait ended $((P5_IDLE - P5_AT))ms after the turn ended (expected 0 to 7000ms, ended by the reader) and TERM followed by $((P5_TERM - P5_IDLE))ms (allowance ${REBUILD_ALLOWANCE_MS}ms): $(tr '\n' '|' < "$P5_LOG")"
fi
if sleeper_alive; then
  failed "patient stop: the sleeper the stub started during the wait survived the idle-ended stop (STOP_PATH=$STOP_PATH), so the tree kill ran on the entry snapshot"
else
  pass "patient stop: the sleeper the stub started during the wait is dead after the idle-ended stop, so the tree kill saw the rebuilt snapshot"
fi
end_stub

eval "$(declare -f _plain_log_before_patient | sed '1s/^_plain_log_before_patient/log/')"

rm -f "$RUNDIR/child.pid" "$RUNDIR/child3.pid"
kill -9 "$DIRECT_PID" "$CHILD_LAUNCH_PID" 2>/dev/null  # best-effort cleanup

echo ""
echo "$CHECK_COUNT checks run, $FAIL_COUNT failed"
echo "$FAIL_COUNT" > "$EXIT_FILE"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "live-stopprocesstree-test.sh: FAIL"
  exit 1
fi
echo "live-stopprocesstree-test.sh: PASS"
exit 0
