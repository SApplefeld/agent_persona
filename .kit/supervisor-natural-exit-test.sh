#!/usr/bin/env bash
# supervisor-natural-exit-test.sh - harness case for bin/supervise.sh's
# natural-exit path: what the supervisor does after a child exits on its own
# rather than through a decide-unit stop. This is the coverage for the
# untracked_work branch of that path and for the backfilled root_complete
# branch, which reads the lines an old store still carries. Case (g) covers the other
# route to RESTART_PASSIVE, the decide path acting on a real root_complete
# while the child is still alive.
#
# The real bin/supervise.sh is driven with no real claude: an isolated HOME
# holding an empty installed-mode commons store (so the pre-launch gate
# passes), a stub `claude` first on PATH, and a temp workdir and rundir per
# case. The stub reads a per-case plan, one action per launch, and each plan
# ends the supervisor on its own: a shutdown_requested decision, a
# park_requested decision, or the crash limit set to 1.
#
# Cases (a), (b), (b2), (e), (uw), (uw2), (uw7) and (pk) launch with --prompt. The supervisor then waits for the
# priming turn's result line, and a child that exits without writing one is
# seen dead before the poll loop starts, so the exit is handled by the
# natural-exit path and never by a decide-unit read of the same store.
#
# Static pin, read from the files rather than restated here: the substring
# get_root_complete tests for is absent from every root_complete detail in
# hooks/index.ts, so no completion the hooks write reads as backfilled.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SUP="$ROOT/bin/supervise.sh"
HOOKS="$ROOT/hooks/index.ts"
PERSONA_NAME="natexit"

failed=0
check() {
  # A check belonging to a case this process did not run reads whatever the
  # previous case left in RC, LOG and LAUNCHES, so it is suppressed rather
  # than evaluated. drive() clears the flag for every case it does run.
  if [ "${SKIP_CASE:-0}" = 1 ]; then return 0; fi
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

TMP="$(mktemp -d)"
# Seconds spent inside each driven supervisor run, one line per case, printed as
# a profile at the end. This suite's cost is the driven runs rather than the
# case count, so a run that gets slower needs to say which case grew.
CASE_TIMES="$TMP/case-times"
: > "$CASE_TIMES"
# Seconds spent in each stretch of the unit blocks, which are the suite's cost
# when the driven cases are not running. They are one straight-line region, so
# this is the only way to see inside them without splitting them up.
UNIT_MARKS="$TMP/unit-marks"
: > "$UNIT_MARKS"
UNIT_T0=$(date +%s)
mark() {  # <label for the stretch that just finished>
  local now
  now=$(date +%s)
  printf '%s %s\n' "$(( now - UNIT_T0 ))" "$1" >> "$UNIT_MARKS"
  UNIT_T0=$now
}

# Which part of the suite this process runs. With no arguments it runs
# everything, which is what a plain invocation and every existing caller gets.
# The split exists so several processes can cover the suite at once: each one
# makes its own temp root, so the stub directory every case writes its current
# case into is per-process and cannot be raced.
#   --units          the extracted-function unit blocks only, no driven runs
#   --cases a b g    only the named driven cases, no unit blocks
RUN_UNITS=1
WANT_CASES=""
if [ "${1:-}" = "--units" ]; then
  WANT_CASES="__none__"
elif [ "${1:-}" = "--cases" ]; then
  shift
  RUN_UNITS=0
  WANT_CASES=" $* "
  [ -n "$*" ] || { echo "ERROR: --cases needs at least one case name" >&2; exit 2; }
fi
# True when the named driven case is in this process's share of the suite.
want() {
  [ -z "$WANT_CASES" ] && return 0
  case "$WANT_CASES" in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# The extractor and the closure walker are shared with the other suite that
# drives the supervisor's own function bodies, so the two cannot disagree
# about what gets extracted. That shared copy carries the withheld-callee
# control, in .kit/live-stopprocesstree-test.sh.
. "$HERE/supervisor-fn-extract.sh"
# `log` and `log_diag` are this suite's own, so the walk stops at them.
SUPERVISOR_CLOSURE_STUBS=" log log_diag "

# This suite's own call shape over the shared extractor: bin/supervise.sh is
# the only script it reads from.
extract_supervisor_fn() {  # <function name> <out file>
  supervisor_extract_fn "$SUP" "$1" "$2"
}

# Extracts one function into a file of its own, for a driver that stubs
# everything that function calls.
extract_supervisor_fn_alone() {  # <function name> <out file>
  local fn="$1" out="$2"
  : > "$out"
  extract_supervisor_fn "$fn" "$out" || return 1
  bash -n "$out"
}

# The supervisor's own stop-path helpers, run by this suite against real
# processes: the survivor a stub leaves behind is killed through the same
# ticks-matched functions the supervisor is required to use, so a pid Windows
# has recycled onto an unrelated process is refused here exactly as it is
# there. `log` and `log_diag` are the suite's own, since the real ones append
# to a log file a case is reading.
log() { echo "[supervisor helper] $*" >&2; }
log_diag() { echo "[supervisor helper] $*" >&2; }
STOP_PS_SENTINEL=$(grep '^STOP_PS_SENTINEL=' "$SUP" | head -1 | cut -d= -f2- | tr -d '"')
SUPERVISOR_PS_BOUND_S=$(grep '^SUPERVISOR_PS_BOUND_S="\${supervisorPsBoundS:-' "$SUP" | head -1 | sed -n 's/.*:-\([0-9]*\)}"/\1/p')
RUNDIR="$TMP/helpers"
mkdir -p "$RUNDIR"
HELPER_STUBS=" log log_diag "
KILL_FNS="$TMP/kill-fns.sh"
: > "$KILL_FNS"
KILL_FN_NAMES=$(supervisor_fn_closure "$SUP" snapshot_process_tree check_snapshot_survivors kill_process_snapshot)
KILL_FN_COUNT=0
for fn in $KILL_FN_NAMES; do
  case "$HELPER_STUBS" in *" $fn "*) continue ;; esac
  extract_supervisor_fn "$fn" "$KILL_FNS" || { echo "FAIL: could not extract $fn from $SUP"; exit 1; }
  KILL_FN_COUNT=$((KILL_FN_COUNT + 1))
done
bash -n "$KILL_FNS" || { echo "FAIL: the extracted stop-path helpers do not parse"; exit 1; }
. "$KILL_FNS"
for fn in $KILL_FN_NAMES; do
  declare -F "$fn" > /dev/null || { echo "FAIL: $fn is called by an extracted body and is neither extracted nor stubbed"; exit 1; }
done
[ -n "$STOP_PS_SENTINEL" ] && [ -n "$SUPERVISOR_PS_BOUND_S" ] && [ "$KILL_FN_COUNT" -ge 3 ]
V=$?
check "setup: $KILL_FN_COUNT stop-path helpers extracted from bin/supervise.sh ($(echo $KILL_FN_NAMES | tr '\n' ' '))" "$V"

# The same helpers with quiet logging and their own globals, for a stub child
# to record the process it leaves behind as a "pid,ticks" pair.
STUB_FNS="$TMP/stub-fns.sh"
{
  printf "STOP_PS_SENTINEL='%s'\n" "$STOP_PS_SENTINEL"
  printf 'SUPERVISOR_PS_BOUND_S=%s\n' "$SUPERVISOR_PS_BOUND_S"
  printf 'log() { :; }\nlog_diag() { :; }\n'
  cat "$KILL_FNS"
} > "$STUB_FNS"

# A case whose stub leaves a native Windows process behind records it as the
# "pid,ticks" pair the supervisor's own stop path works in. The supervisor is
# what should kill it; this kills whatever survived a failing run, and a pair
# whose start ticks no longer match is left alone.
kill_leaked_survivors() {
  local f snapshot alive rc
  for f in "$TMP"/*/survivor.snapshot; do
    [ -f "$f" ] || continue
    snapshot=$(grep -E '^[0-9]+,[0-9]+$' "$f")
    [ -n "$snapshot" ] || continue
    alive=$(check_snapshot_survivors "$snapshot")
    rc=$?
    if [ "$rc" -eq 0 ] && [ -z "$alive" ]; then
      continue
    fi
    kill_process_snapshot "$snapshot" > /dev/null 2>&1
  done
}
trap 'kill_leaked_survivors; rm -rf "$TMP"' EXIT

if [ "$RUN_UNITS" = 1 ]; then
# --- What this suite's own survivor kill does with a pid that moved on ---
# Every recorded survivor is a pid and the start ticks of the process that
# held it. A pid Windows has already recycled onto something else no longer
# matches those ticks, and the pair is what decides: the same comparison in
# kill_process_snapshot that refuses a recycled pid in the supervisor refuses
# it here, against a live process this suite owns and can assert on.
( exec powershell.exe -NoProfile -Command "Start-Sleep -Seconds 40" ) &
RECYCLE_PID=$!
sleep 2
RECYCLE_WINPID=$(resolve_windows_pid "$RECYCLE_PID")
RECYCLE_PAIR=""
if [ -n "$RECYCLE_WINPID" ]; then
  RECYCLE_PAIR=$(snapshot_process_tree "$RECYCLE_WINPID" | grep -E "^${RECYCLE_WINPID},[0-9]+$" | head -1)
fi
[ -n "$RECYCLE_PAIR" ]; check "kill: setup: a live process this suite owns is recorded as pid and start ticks ($RECYCLE_PAIR)" "$?"
if [ -n "$RECYCLE_PAIR" ]; then
  RECYCLE_MISMATCH="${RECYCLE_PAIR%%,*},$(( ${RECYCLE_PAIR#*,} + 1 ))"
  kill_process_snapshot "$RECYCLE_MISMATCH" > /dev/null 2>&1
  sleep 1
  R_ALIVE=$(check_snapshot_survivors "$RECYCLE_PAIR")
  R_RC=$?
  [ "$R_RC" -eq 0 ] && [ "$R_ALIVE" = "$RECYCLE_WINPID" ]
  check "kill: a recorded survivor whose start ticks no longer match is left running rather than killed" "$?"
  kill_process_snapshot "$RECYCLE_PAIR" > /dev/null 2>&1
  sleep 1
  R_ALIVE=$(check_snapshot_survivors "$RECYCLE_PAIR")
  R_RC=$?
  [ "$R_RC" -eq 0 ] && [ -z "$R_ALIVE" ]
  check "kill: control: the same pair with its own start ticks kills the process, so the refusal above is the ticks and not a dead instrument" "$?"
fi

mark setup-and-survivor-kill
fi  # end of the survivor-kill unit block

# The literals below are read by the stub child rather than only pinned here,
# so they are extracted whatever this process is running. Their pins are
# checks and stay in the unit part. Leaving the extraction inside that part is
# what made a case run alone behave differently from the same case run in the
# whole suite: the stub wrote an empty detail and the supervisor read it as a
# different decision.
# --- Pin: the backfill literal, reader against the hooks ---
# get_root_complete's node script is the one place bin/supervise.sh tests a
# decision's detail with includes(); more than one match fails the pin below.
READER_SUBSTR=$(sed -n "s/.*newest\.detail\.includes('\([^']*\)').*/\1/p" "$SUP")
# Every root_complete detail literal in the hooks. The search for a detail
# ends at the next `action:` line, so a root_complete whose detail is written
# in another shape yields no detail at all rather than taking the following
# decision's detail as its own.
DETAILS=$(awk '
  /action: "root_complete",/ { want = 1; next }
  /action:/ { want = 0; next }
  want && /detail: `/ {
    s = $0; sub(/^[^`]*`/, "", s); sub(/`.*$/, "", s)
    print s
    want = 0
  }' "$HOOKS")
# An old store's line: the detail of the backfilled root_complete the hook
# wrote for work with no open goal before it logged untracked_work instead,
# with its root id filled in. No writer produces it now, and a store written
# before still carries such lines until they roll off its decision log, so
# cases (a) and (e) drive the supervisor's reader with it.
BACKSTOP_DETAIL='Root root-r1 marked complete - backfilled, work already done'

if [ "$RUN_UNITS" = 1 ]; then
[ -n "$READER_SUBSTR" ] && [ "$(printf '%s\n' "$READER_SUBSTR" | wc -l)" -eq 1 ]
check "pin: exactly one backfill substring test is found in bin/supervise.sh ('$READER_SUBSTR')" "$?"
[ -n "$DETAILS" ]; check "pin: a root_complete detail is found in hooks/index.ts" "$?"
# The awk above pairs a root_complete decision with the backtick detail line
# inside that same decision. A decision whose detail is written in any other
# shape yields no pair, so this count is what turns that silence into a
# failure: it is the check that says every root_complete in the file was
# actually examined by the pin below, rather than skipped unnoticed.
ROOT_COMPLETE_WRITES=$(grep -c 'action: "root_complete",' "$HOOKS")
DETAIL_COUNT=$(printf '%s\n' "$DETAILS" | grep -c .)
[ "$ROOT_COMPLETE_WRITES" -gt 0 ] && [ "$DETAIL_COUNT" -eq "$ROOT_COMPLETE_WRITES" ]
check "pin: every root_complete decision in hooks/index.ts yielded a detail (${DETAIL_COUNT}/${ROOT_COMPLETE_WRITES})" "$?"
R=1
if [ -n "$READER_SUBSTR" ] && [ -n "$DETAILS" ]; then
  R=0
  while IFS= read -r d; do
    case "$d" in *"$READER_SUBSTR"*) R=1 ;; esac
  done <<< "$DETAILS"
fi
check "pin: no root_complete detail in hooks/index.ts carries the reader's substring, so a completion the hooks write never reads as backfilled" "$R"

mark backfill-pins
# --- Unit pins, run before any case drives a supervisor ---
# The child-tree closure decides which processes a sweep kills, so a closure
# that names a process outside the child's own subtree kills whatever else is
# running on the box. These pins run first, against synthetic process tables,
# so that property is settled before a real supervisor is ever launched.
UNIT="$TMP/unit"
mkdir -p "$UNIT"

extract_supervisor_fn_alone refresh_child_tree "$UNIT/refresh.sh"
check "unit: refresh_child_tree extracted from bin/supervise.sh and parses" "$?"
: > "$UNIT/sweep.sh"
extract_supervisor_fn child_tree_stale_reason "$UNIT/sweep.sh" &&
  extract_supervisor_fn child_tree_record_state "$UNIT/sweep.sh" &&
  extract_supervisor_fn child_tree_record_age_s "$UNIT/sweep.sh" &&
  extract_supervisor_fn sweep_child_tree "$UNIT/sweep.sh" &&
  bash -n "$UNIT/sweep.sh"
check "unit: sweep_child_tree and the record-state helpers it reads extracted from bin/supervise.sh and parse" "$?"
extract_supervisor_fn_alone get_rate_limit_reset "$UNIT/ratelimit.sh"
check "unit: get_rate_limit_reset extracted from bin/supervise.sh and parses" "$?"
extract_supervisor_fn_alone resolve_windows_pid "$UNIT/resolve.sh"
check "unit: resolve_windows_pid extracted from bin/supervise.sh and parses" "$?"

# Process tables in Cygwin ps shape: PID PPID PGID WINPID TTY UID STIME COMMAND.
cat > "$UNIT/ps-sibling.txt" <<'PSEOF'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
      100       1     100      15588  ?         197613 22:20:40 /usr/bin/bash
      101     100     100      15589  ?         197613 22:20:41 /usr/bin/env
      102     101     100      15590  ?         197613 22:20:42 /c/Users/x/claude
      200       1     200      15600  ?         197613 22:20:40 /usr/bin/bash
      201     200     200      15601  ?         197613 22:20:41 /c/Users/x/claude
        1       0       1          1  ?         197613 22:20:00 /usr/bin/init
PSEOF
# The same shape with a state character ahead of pid 102, which Cygwin ps
# prints for a stopped or an orphaned process, and a descendant under it.
cat > "$UNIT/ps-state.txt" <<'PSEOF'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
      100       1     100      15588  ?         197613 22:20:40 /usr/bin/bash
      101     100     100      15589  ?         197613 22:20:41 /usr/bin/env
S     102     101     100      15590  ?         197613 22:20:42 /c/Users/x/claude
      103     102     100      15591  ?         197613 22:20:43 /usr/bin/node
      200       1     200      15600  ?         197613 22:20:40 /usr/bin/bash
PSEOF
# A parent-child cycle, the shape a recycled pid pointing back into the tree
# takes. The closure must settle on the two members and terminate.
cat > "$UNIT/ps-cycle.txt" <<'PSEOF'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
      300     301     300      15700  ?         197613 22:20:40 /usr/bin/bash
      301     300     300      15701  ?         197613 22:20:41 /usr/bin/env
      400       1     400      15800  ?         197613 22:20:40 /usr/bin/bash
PSEOF
printf '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND\n' > "$UNIT/ps-empty.txt"
# One process and nothing under it, and the same tree grown by two.
cat > "$UNIT/ps-launch.txt" <<'PSEOF'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
      100       1     100      15588  ?         197613 22:20:40 /usr/bin/bash
PSEOF
cat > "$UNIT/ps-grown.txt" <<'PSEOF'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
      100       1     100      15588  ?         197613 22:20:40 /usr/bin/bash
      101     100     100      15589  ?         197613 22:20:41 /usr/bin/env
      102     101     100      15590  ?         197613 22:20:42 /c/Users/x/claude
PSEOF

mark unit-pins
# --- Which column of a ps row the Windows pid sits in ---
# `/proc/<pid>/winpid` answers for a pid that has an entry; the `ps` row is the
# fallback for one that does not. A stopped or an orphaned process carries a
# state character in column 1, which shifts every column right by one: WINPID
# sits in column 4 on an ordinary row and column 5 on a shifted one, and column
# 4 of a shifted row is the process group id, which is digits and so passes
# every check a fixed-column read would apply. The pid is one no /proc entry
# exists for, so the fallback is what answers.
cat > "$UNIT/ps-p-plain.txt" <<'PSEOF'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
   999999     100     777      15590  ?         197613 22:20:42 /c/Users/x/claude
PSEOF
cat > "$UNIT/ps-p-state.txt" <<'PSEOF'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
S  999999     100     777      15590  ?         197613 22:20:42 /c/Users/x/claude
PSEOF
cat > "$UNIT/resolve-driver.sh" <<'DRVEOF'
set -u
FN_FILE="$1"; TABLE="$2"
ps() { cat "$TABLE"; }
. "$FN_FILE"
resolve_windows_pid 999999
DRVEOF
RW=$(bash "$UNIT/resolve-driver.sh" "$UNIT/resolve.sh" "$UNIT/ps-p-plain.txt")
[ "$RW" = "15590" ]; check "unit: an ordinary ps row resolves to the Windows pid its own columns carry (got [$RW])" "$?"
RW=$(bash "$UNIT/resolve-driver.sh" "$UNIT/resolve.sh" "$UNIT/ps-p-state.txt")
[ "$RW" = "15590" ]; check "unit: a row carrying a state character resolves to the Windows pid rather than to the process group id sitting where it would be (got [$RW])" "$?"

cat > "$UNIT/closure-driver.sh" <<'DRVEOF'
# Runs refresh_child_tree against a synthetic process table with every
# Windows-side call stubbed, and prints the MSYS pid set it closed over.
set -u
FN_FILE="$1"; TABLE="$2"; ROOT="$3"
ps() { cat "$TABLE"; }
resolve_windows_pid() { echo "9$1"; }
snapshot_process_tree() { echo "$1,111"; return 0; }
walk_msys_process_tree() { snapshot_process_tree "$2"; }
log() { :; }
CHILD_LAUNCH_PID="$ROOT"
CHILD_INDEX=1
CHILD_TREE_MSYS_PIDS=""
CHILD_TREE_WINPIDS=""
CHILD_TREE_SEEN_WINPIDS=""
CHILD_TREE_SNAPSHOT=""
CHILD_TREE_WALKED=""
CHILD_TREE_READ_FAILED=""
CHILD_TREE_DESCENDANT_SEEN=""
CHILD_TREE_CONFIRMED_AT=""
. "$FN_FILE"
refresh_child_tree
echo "$CHILD_TREE_MSYS_PIDS"
DRVEOF
closure() { bash "$UNIT/closure-driver.sh" "$1" "$UNIT/$2" "$3"; }

CL=$(closure "$UNIT/refresh.sh" ps-sibling.txt 100)
[ "$CL" = "100 101 102" ]; check "unit: the closure names the child's own subtree and neither the sibling tree nor init (got [$CL])" "$?"
CL=$(closure "$UNIT/refresh.sh" ps-state.txt 100)
[ "$CL" = "100 101 102 103" ]; check "unit: a row carrying a state character keeps its parent link, so the process under it stays in the closure (got [$CL])" "$?"
CL=$(closure "$UNIT/refresh.sh" ps-cycle.txt 300)
[ "$CL" = "300 301" ]; check "unit: a parent-child cycle settles on its own members and terminates (got [$CL])" "$?"
# A chain deeper than any fixed pass count, so the passes are what close the
# chain rather than a number chosen in advance.
node -e '
const fs = require("fs");
const rows = ["      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND"];
for (let i = 0; i < 20; i++) {
  const pid = 500 + i;
  const ppid = i === 0 ? 1 : 500 + i - 1;
  rows.push("      " + pid + "     " + ppid + "     500      " + (16000 + i) + "  ?         197613 22:20:40 /usr/bin/bash");
}
fs.writeFileSync(process.argv[1], rows.join("\n") + "\n");
' "$UNIT/ps-deep.txt"
CL=$(closure "$UNIT/refresh.sh" ps-deep.txt 500)
[ "$(echo "$CL" | wc -w)" -eq 20 ]; V=$?; check "unit: a chain twenty processes deep is closed over whole (members=$(echo "$CL" | wc -w))" "$V"
CL=$(closure "$UNIT/refresh.sh" ps-sibling.txt 999)
[ -z "$CL" ]; check "unit: a root absent from the table closes over nothing (got [$CL])" "$?"
CL=$(closure "$UNIT/refresh.sh" ps-empty.txt 100)
[ -z "$CL" ]; check "unit: an empty table closes over nothing (got [$CL])" "$?"

# Control: the membership test read by value is what keeps the closure bounded.
# A bare subscript lookup creates the parent's own entry as a side effect, so
# every parent in the table joins the set. Run against the same sibling table,
# whose members the shipped closure refuses.
sed -e 's/if ((p in keep) && !(id in keep)) { keep\[id\] = 1; added = 1 }/if (keep[p]) keep[id] = 1/' \
    -e 's/for (id in keep) { if (keep\[id\] == 1 && (id in winpid)) print id }/for (id in keep) { if (id in winpid) print id }/' \
    "$UNIT/refresh.sh" > "$UNIT/refresh-bare.sh"
! cmp -s "$UNIT/refresh.sh" "$UNIT/refresh-bare.sh"
check "unit: control: the bare-subscript mutation applied to the extracted closure" "$?"
CL=$(closure "$UNIT/refresh-bare.sh" ps-sibling.txt 100)
case " $CL " in *" 200 "*) R=0 ;; *) R=1 ;; esac
check "unit: control: the bare-subscript form pulls in the sibling tree the shipped form refuses (got [$CL])" "$R"

cat > "$UNIT/sweep-driver.sh" <<'DRVEOF'
# Refreshes the child tree once or twice against synthetic tables, with each
# walk told whether to complete, then sweeps and prints the sweep's own return
# code and what it left for the retry backstop.
#
# RESOLVE names which Windows pids resolve: `all`, `no_self` for a run where
# this process's own pid cannot be resolved, and `no_win` for one where the
# child's pids cannot. BACKDATE ages the record's own confirmation stamp by
# that many seconds before the sweep reads it. FAILPOLLS runs that many further
# polls that cannot confirm the record, by making this process's own Windows
# pid unresolvable for them, and CONFIRM_AFTER set to `confirm` runs one
# ordinary poll after those, which finds the child on the pid set the record
# was walked from. BACKDATE set to `clear` drops the stamp instead of ageing
# it, which is the record no poll is known to have confirmed at all.
set -u
REFRESH_FN="$1"; SWEEP_FN="$2"; TABLE1="$3"; WALK1="$4"; TABLE2="$5"; WALK2="$6"; ROOT="$7"
RESOLVE="${8:-all}"; BACKDATE="${9:-0}"; FAILPOLLS="${10:-0}"; CONFIRM_AFTER="${11:-none}"
TABLE="$TABLE1"; WALK="$WALK1"
SUPERVISOR_POLL_MS=10000
ps() { cat "$TABLE"; }
resolve_windows_pid() {
  case "$RESOLVE" in
    no_self) if [ "$1" = "$$" ]; then return 0; fi ;;
    no_win)  if [ "$1" != "$$" ]; then return 0; fi ;;
  esac
  echo "9$1"
}
snapshot_process_tree() { if [ "$WALK" = "ok" ]; then echo "$1,111"; return 0; fi; return 124; }
walk_msys_process_tree() { snapshot_process_tree "$2"; }
check_snapshot_survivors() { return 0; }
kill_process_snapshot() { return 0; }
log() { echo "$*"; }
CHILD_LAUNCH_PID="$ROOT"
CHILD_INDEX=1
CHILD_TREE_MSYS_PIDS=""
CHILD_TREE_WINPIDS=""
CHILD_TREE_SEEN_WINPIDS=""
CHILD_TREE_SNAPSHOT=""
CHILD_TREE_WALKED=""
CHILD_TREE_READ_FAILED=""
CHILD_TREE_DESCENDANT_SEEN=""
CHILD_TREE_CONFIRMED_AT=""
CHILD_TREE_FAILED_CONFIRMS=0
LAST_STOP_SNAPSHOT=""
. "$REFRESH_FN"
. "$SWEEP_FN"
refresh_child_tree
if [ "$TABLE2" != "-" ]; then TABLE="$TABLE2"; WALK="$WALK2"; refresh_child_tree; fi
FAILED=0
while [ "$FAILED" -lt "$FAILPOLLS" ]; do
  RESOLVE=no_self
  refresh_child_tree
  FAILED=$(( FAILED + 1 ))
done
RESOLVE="${8:-all}"
if [ "$CONFIRM_AFTER" = "confirm" ]; then refresh_child_tree; fi
if [ "$BACKDATE" = "clear" ]; then
  CHILD_TREE_CONFIRMED_AT=""
elif [ "$BACKDATE" != "0" ] && [ -n "$CHILD_TREE_CONFIRMED_AT" ]; then
  CHILD_TREE_CONFIRMED_AT=$(( CHILD_TREE_CONFIRMED_AT - BACKDATE ))
fi
echo "FAILED_CONFIRMS=${CHILD_TREE_FAILED_CONFIRMS:-unset}"
sweep_child_tree "unit"
echo "RC=$?"
echo "BACKSTOP=[$LAST_STOP_SNAPSHOT]"
DRVEOF
sweep() { bash "$UNIT/sweep-driver.sh" "$UNIT/refresh.sh" "$UNIT/sweep.sh" "$@"; }
# The same driver with a live survivor in the record and a kill that cannot
# confirm it dead, which is the one sweep leg that names a process still
# running.
sed -e 's/^check_snapshot_survivors() { return 0; }$/check_snapshot_survivors() { echo 9100; return 0; }/' \
    -e 's/^kill_process_snapshot() { return 0; }$/kill_process_snapshot() { return 1; }/' \
    "$UNIT/sweep-driver.sh" > "$UNIT/sweep-driver-survivor.sh"
! cmp -s "$UNIT/sweep-driver.sh" "$UNIT/sweep-driver-survivor.sh"
check "unit: setup: the survivor driver differs from the clean one in its survivor and kill stubs" "$?"
# The same driver with a survivor check that cannot complete, which is the leg
# that refuses to read a record nothing could verify as a clean result.
sed -e 's/^check_snapshot_survivors() { return 0; }$/check_snapshot_survivors() { return 1; }/' \
    "$UNIT/sweep-driver.sh" > "$UNIT/sweep-driver-unverified.sh"
! cmp -s "$UNIT/sweep-driver.sh" "$UNIT/sweep-driver-unverified.sh"
check "unit: setup: the unverified driver differs from the clean one in its survivor check" "$?"

# Each leg is read by the stable token its log line opens with, so the prose
# beside it stays free to change without moving what a caller keys on.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100)
printf '%s\n' "$SW" | grep -q '^RC=0$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] clean:'
check "unit: a record walked from the child's current pid set, naming a process under the wrapper and holding no survivor, reads as clean" "$?"
printf '%s\n' "$SW" | grep -qE 'SWEEP\[unit\] clean:.*confirmed [0-9]+s ago'
check "unit: the clean line names how long ago a poll confirmed the record it was read off" "$?"
# A record naming only the process the launch pid itself runs as has never
# held anything that ran under the wrapper. The first refresh takes one in the
# instant after the coproc starts, before the agent process exists, so a child
# that dies inside its first poll interval is swept against exactly that. The
# walk completed and named nothing, so there is nothing to sweep, which is the
# no-tree answer rather than a tree no reading could account for.
SW=$(sweep "$UNIT/ps-launch.txt" ok - ok 100)
printf '%s\n' "$SW" | grep -q '^RC=2$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] record_no_descendant:'
check "unit: a record that never named anything under the wrapper leaves nothing to sweep, and says which reading it was" "$?"
# What makes a record stale is mostly polls that stopped confirming it, and a
# poll body's own work varies by tens of seconds on a loaded box. So a record
# every poll confirmed is a clean verdict at an age no poll interval predicts,
# and reading that as stale is what ends a natural exit at exit 5 on a child
# that left nothing behind. The driver polls every 10s, so this age is twelve
# intervals past the last confirmation and still inside the ceiling.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100 all 120)
printf '%s\n' "$SW" | grep -q '^RC=0$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] clean:' \
  && printf '%s\n' "$SW" | grep -q '^FAILED_CONFIRMS=0$'
check "unit: a record every poll confirmed is a clean verdict however long the poll that confirmed it took" "$?"
# The count alone cannot see a box that suspends between the poll that last
# confirmed the record and the child's death: one poll runs on resume, the
# count reaches 1, and a record walked hours ago reads clean. So the
# confirmation itself expires, well past any poll body's own variance.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100 all 9999)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] record_stale:' \
  && printf '%s\n' "$SW" | grep -q '^FAILED_CONFIRMS=0$'
check "unit: a confirmation older than the ceiling leaves the record stale even where no poll ever failed to confirm it" "$?"
printf '%s\n' "$SW" | grep -q 'record_stale: no poll has confirmed .* inside the 300s ceiling'
check "unit: that line names the ceiling the record aged past rather than a count of failed confirms" "$?"
# A record with no stamp at all is the same answer, and its line says which
# reading it was rather than reporting a failed-confirm count of zero.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100 all clear)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'record_stale: no poll is known to have confirmed'
check "unit: a record no poll is known to have confirmed at all is stale, and its line names that rather than a count" "$?"
! printf '%s\n' "$SW" | grep -q '0 polls in a row'
check "unit: that line does not claim zero polls in a row ran without confirming a record no poll ever confirmed" "$?"
# Three polls in a row that ran and could not confirm the record is what the
# stale verdict counts, and the sweep's own line names the count.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100 all 0 3)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] record_stale:' \
  && printf '%s\n' "$SW" | grep -q '^FAILED_CONFIRMS=3$'
check "unit: three polls in a row that could not confirm the record leave it stale, which is not a clean verdict" "$?"
# One short of the bound, so the refusal above is the third failed confirm
# rather than any failed confirm at all.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100 all 0 2)
printf '%s\n' "$SW" | grep -q '^RC=0$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] clean:' \
  && printf '%s\n' "$SW" | grep -q '^FAILED_CONFIRMS=2$'
check "unit: control: two failed confirms leave the record clean, so the stale verdict is the third one" "$?"
# A poll that confirms the record puts the count back to zero, so a run of
# failed confirms a later poll healed never reaches the bound.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100 all 0 3 confirm)
printf '%s\n' "$SW" | grep -q '^RC=0$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] clean:' \
  && printf '%s\n' "$SW" | grep -q '^FAILED_CONFIRMS=0$'
check "unit: a poll that confirms the record clears the failed confirms behind it" "$?"
# Two readings that could not be taken at all. Both leave the record empty,
# which is also what a child that genuinely ran no Windows process leaves, and
# only one of those is a tree there is nothing to sweep.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100 no_self)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] tree_unread:'
check "unit: a poll that cannot resolve this supervisor's own Windows pid leaves a tree that could not be read, not a child with no tree" "$?"
# A closure whose processes resolve to no Windows pid at all is a failed read
# while any process it names still runs. The launch pid here is gone and the
# process under it is this suite's own shell, which is running, so the wrapper
# dying is not taken as the tree having ended.
printf '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND\n      100       1     100      15588  ?         197613 22:20:40 /usr/bin/bash\n%9s     100     100      15589  ?         197613 22:20:41 /usr/bin/env\n      102 %7s     100      15590  ?         197613 22:20:42 /c/Users/x/claude\n' "$$" "$$" > "$UNIT/ps-unresolved-live.txt"
SW=$(sweep "$UNIT/ps-unresolved-live.txt" ok - ok 100 no_win)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] tree_unread:'
check "unit: a closure whose processes resolve to no Windows pid at all, one of them still running, leaves a tree that could not be read, not a child with no tree" "$?"
# An unresolved closure is not a failed read where every process it names has
# stopped running: the process table is read once and each pid's Windows id a
# moment later, so a child that exits at once can leave a closure whose members
# are all gone by the lookup, and nothing is left that the lookup failed to
# name. Each mirror swaps one member for this suite's own shell, which is
# running, so liveness is the only thing that differs.
! kill -0 100 2>/dev/null
check "unit: setup: pid 100, the synthetic launch pid, is not a running process" "$?"
! kill -0 101 2>/dev/null
check "unit: setup: pid 101, the synthetic process under the launch pid, is not a running process" "$?"
SW=$(sweep "$UNIT/ps-launch.txt" ok - ok 100 no_win)
printf '%s\n' "$SW" | grep -q '^RC=2$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] no_tree:'
check "unit: a closure naming only a launch pid that has already exited, with nothing resolving, is a child with no tree" "$?"
printf '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND\n%9s       1 %7s      15588  ?         197613 22:20:40 /usr/bin/bash\n' "$$" "$$" > "$UNIT/ps-launch-live.txt"
SW=$(sweep "$UNIT/ps-launch-live.txt" ok - ok "$$" no_win)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] tree_unread:'
check "unit: a closure naming only a launch pid that is still running, with nothing resolving, leaves a tree that could not be read" "$?"
cat > "$UNIT/ps-launch-dead-member.txt" <<'PSEOF'
      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
      100       1     100      15588  ?         197613 22:20:40 /usr/bin/bash
      101     100     100      15589  ?         197613 22:20:41 /c/Users/x/claude
PSEOF
SW=$(sweep "$UNIT/ps-launch-dead-member.txt" ok - ok 100 no_win)
printf '%s\n' "$SW" | grep -q '^RC=2$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] no_tree:'
check "unit: a closure naming the launch pid and a process under it, neither still running, with nothing resolving, is a child with no tree" "$?"
printf '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND\n      100       1     100      15588  ?         197613 22:20:40 /usr/bin/bash\n%9s     100     100      15589  ?         197613 22:20:41 /c/Users/x/claude\n' "$$" > "$UNIT/ps-launch-live-member.txt"
SW=$(sweep "$UNIT/ps-launch-live-member.txt" ok - ok 100 no_win)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] tree_unread:'
check "unit: a closure naming a launch pid that has exited and a process under it that is still running, with nothing resolving, leaves a tree that could not be read" "$?"
SW=$(sweep "$UNIT/ps-launch.txt" ok "$UNIT/ps-grown.txt" fail 100)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] record_behind_tree:'
check "unit: a record older than the child's pid set is neither a clean verdict nor a survivor, even with no survivor in it" "$?"
printf '%s\n' "$SW" | grep -q '^BACKSTOP=\[\]$'
check "unit: that partial record is kept out of the retry backstop, which could otherwise confirm it dead and call the tree clean" "$?"
SW=$(sweep "$UNIT/ps-launch.txt" fail - ok 100)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] tree_unread:'
check "unit: a child whose tree was never walked cannot be read as clean, and names no survivor either" "$?"
SW=$(sweep "$UNIT/ps-empty.txt" ok - ok 100)
printf '%s\n' "$SW" | grep -q '^RC=2$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] no_tree:'
check "unit: a child no Windows process was ever seen under has no tree to have outlived it" "$?"
# A survivor the kill cannot confirm dead is the leg that carries a live
# process. It shares the one failure return with every reading that could
# not account for the tree, since a caller ends the run on either.
SW=$(bash "$UNIT/sweep-driver-survivor.sh" "$UNIT/refresh.sh" "$UNIT/sweep.sh" "$UNIT/ps-sibling.txt" ok - ok 100)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] survivors_alive:'
check "unit: a survivor still alive after the kill is the one leg that reports a survivor" "$?"
# A survivor check that could not be completed says nothing about the record it
# was handed, so the sweep neither kills from it nor calls it clean. The record
# is left for the retry backstop, which is the one reading that can still settle
# it. Reached through the sweep the same way every caller reaches it: with the
# leg gone the same run reads the empty survivor list as a clean tree.
SW=$(bash "$UNIT/sweep-driver-unverified.sh" "$UNIT/refresh.sh" "$UNIT/sweep.sh" "$UNIT/ps-sibling.txt" ok - ok 100)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] record_unverified:'
check "unit: a survivor check that did not complete leaves the record unverified rather than clean" "$?"
printf '%s\n' "$SW" | tr '\n' ' ' | grep -q 'BACKSTOP=\[9100,111 9101,111 9102,111\]'
V=$?
check "unit: that unverified record is left for the retry backstop, which can still settle it (BACKSTOP=$(printf '%s\n' "$SW" | sed -n 's/^BACKSTOP=//p'))" "$V"
# Control: the same run with the check completing reads the record clean, so
# the refusal above is the check that could not complete and not the record.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100)
printf '%s\n' "$SW" | grep -q '^RC=0$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] clean:'
check "unit: control: the same record with the survivor check completing is clean, so the refusal above is the check" "$?"

mark ps-column-and-closure
# --- What stop_child verifies and kills, against the live launch shape ---
# The real launch runs `claude.exe` under `env.exe`, and `env.exe`'s Windows
# parent is a Cygwin fork intermediate that has already exited. A Windows walk
# from the coproc wrapper therefore reaches the wrapper alone. These drivers run
# the real stop_child with every process read, walk, survivor check, kill and
# signal stubbed over files in a state directory, so nothing real is signaled:
# a Windows pid is alive while its "pid,ticks" line is in win-alive, and an
# MSYS pid while it is in msys-alive.
STOP_FN_NAMES=$(SUPERVISOR_CLOSURE_STUBS=" log log_diag resolve_windows_pid snapshot_process_tree check_snapshot_survivors kill_process_snapshot run_bounded_native " supervisor_fn_closure "$SUP" stop_child refresh_child_tree retry_stop_escalation)
: > "$UNIT/stop.sh"
R=0
for fn in $STOP_FN_NAMES; do
  extract_supervisor_fn "$fn" "$UNIT/stop.sh" || R=1
done
[ "$R" -eq 0 ] && bash -n "$UNIT/stop.sh"
V=$?
check "unit: stop_child and what it calls extracted from bin/supervise.sh and parse ($(echo $STOP_FN_NAMES))" "$V"

cat > "$UNIT/stop-driver.sh" <<'DRVEOF'
# Records the child's tree with one poll, arms the state directory's on-walk
# effects, runs stop_child, and prints its return code, STOP_PATH, the Windows
# pids still alive, every "pid,ticks" line a survivor check or a kill was
# handed, and what it left for the retry backstop.
#
# In a state directory: ps-table (Cygwin ps shape), msys-alive, win-alive,
# walks ("<winpid>|<line>;<line>"), ps-table-stop (the table once armed, where
# present), noterm-<msys pid> (a process no signal ends), heal-before-retry
# (every armed walk failure clears before the retry), exit-before-stop (MSYS pids that exit, with their Windows pids,
# the moment the driver arms), nokill-<winpid> (a process no kill ends), and
# per Windows pid, once armed:
# fail-<winpid> fails that walk, emptywalk-<winpid> completes that walk over
# nothing at all, impostor-<winpid> adds its lines to that walk,
# on-walk-<winpid> is a shell snippet run as that walk is taken, on-signal-<msys
# pid> is a snippet run as that process is signaled, and self-in-
# <winpid> adds this process's own Windows pid to that walk. MODE no_self makes
# this process's own Windows pid unresolvable once armed, MODE retry runs
# retry_stop_escalation on the stop's own return code after the stop and
# prints what is alive after it, and MODE refresh arms
# before the poll and prints the record that poll took instead of stopping.
set -u
FN_FILE="$1"; ST="$2"; MODE="${3:-plain}"
. "$FN_FILE"
SUPERVISOR_POLL_MS=10000
SUPERVISOR_STOP_GRACE_MS=2000
CHILD_IN=""
ps() {
  local table="$ST/ps-table"
  if [ -f "$ST/armed" ] && [ -f "$ST/ps-table-stop" ]; then table="$ST/ps-table-stop"; fi
  awk -v alive="$(tr '\n' ' ' < "$ST/msys-alive")" '
    BEGIN { n = split(alive, a, " "); for (i = 1; i <= n; i++) live[a[i]] = 1 }
    NR == 1 || ($1 in live)' "$table"
}
kill() {
  local sig="$1" target="$2"
  if [ "$sig" = "-0" ]; then
    grep -qx "$target" "$ST/msys-alive"
    return $?
  fi
  echo "$sig $target" >> "$ST/signals"
  # The snippet runs as the signal is delivered, so a case can move a process's
  # Windows pid in the window between the stop's own entry and a later phase.
  [ -f "$ST/on-signal-$target" ] && . "$ST/on-signal-$target"
  [ -f "$ST/noterm-$target" ] && return 0
  grep -vx "$target" "$ST/msys-alive" > "$ST/msys-alive.new"; mv "$ST/msys-alive.new" "$ST/msys-alive"
  grep -v "^9$target," "$ST/win-alive" > "$ST/win-alive.new"; mv "$ST/win-alive.new" "$ST/win-alive"
  return 0
}
resolve_windows_pid() {
  if [ "$1" = "$$" ]; then
    if [ "$MODE" = "no_self" ] && [ -f "$ST/armed" ]; then return 0; fi
    echo "9$1"
    return 0
  fi
  if [ -f "$ST/moved-$1" ]; then cat "$ST/moved-$1"; return 0; fi
  if grep -qx "$1" "$ST/msys-alive" || [ -f "$ST/zombie-$1" ]; then echo "9$1"; fi
  return 0
}
snapshot_process_tree() {
  echo "$1" >> "$ST/walked"
  if [ -f "$ST/armed" ]; then
    # The snippet runs as the walk is taken, ahead of the result the walk
    # returns, so a case can hold a process that exits inside a walk that also
    # fails.
    [ -f "$ST/on-walk-$1" ] && . "$ST/on-walk-$1"
    [ -f "$ST/fail-$1" ] && return 1
    # A walk that completes and names nothing at all, not even its own root,
    # which is what a process table read that missed the root yields.
    [ -f "$ST/emptywalk-$1" ] && return 0
    [ -f "$ST/impostor-$1" ] && cat "$ST/impostor-$1"
    [ -f "$ST/self-in-$1" ] && echo "9$$,5"
  fi
  grep "^$1|" "$ST/walks" | cut -d'|' -f2 | tr ';' '\n' | grep -v '^$'
  return 0
}
check_snapshot_survivors() {
  printf '%s\n' "$1" >> "$ST/handed"
  local line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    grep -qx "$line" "$ST/win-alive" && echo "${line%%,*}"
  done <<< "$1"
  return 0
}
kill_process_snapshot() {
  printf '%s\n' "$1" >> "$ST/handed"
  local line left=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ -f "$ST/nokill-${line%%,*}" ]; then
      grep -qx "$line" "$ST/win-alive" && left=1
      continue
    fi
    grep -vx "$line" "$ST/win-alive" > "$ST/win-alive.new"; mv "$ST/win-alive.new" "$ST/win-alive"
  done <<< "$1"
  return "$left"
}
run_bounded_native() { echo "$*" >> "$ST/native"; return 0; }
sleep() { :; }
log() { echo "$*"; }
# The supervisor's own log_diag writes to stderr and the log file, never to
# stdout, and a function whose output a caller captures is why: a diagnostic on
# stdout rides into `walk_msys_process_tree`'s captured "pid,ticks" lines. The
# stub keeps that split, and the runner merges the two streams back.
log_diag() { echo "$*" >&2; }
CHILD_LAUNCH_PID=100
CHILD_INDEX=1
CHILD_TREE_MSYS_PIDS=""
CHILD_TREE_WINPIDS=""
CHILD_TREE_SEEN_WINPIDS=""
CHILD_TREE_SNAPSHOT=""
CHILD_TREE_WALKED=""
CHILD_TREE_READ_FAILED=""
CHILD_TREE_DESCENDANT_SEEN=""
CHILD_TREE_CONFIRMED_AT=""
CHILD_TREE_FAILED_CONFIRMS=0
LAST_STOP_SNAPSHOT=""
STOP_PATH=""
: > "$ST/handed"
if [ "$MODE" = "refresh" ]; then
  : > "$ST/armed"
  refresh_child_tree
  echo "WALKED=[$CHILD_TREE_WALKED]"
  echo "RECORD=[$(printf '%s' "$CHILD_TREE_SNAPSHOT" | tr '\n' ' ')]"
  echo "WINPIDS=[$CHILD_TREE_WINPIDS]"
  echo "SEEN=[$CHILD_TREE_SEEN_WINPIDS]"
  exit 0
fi
refresh_child_tree
: > "$ST/armed"
if [ -f "$ST/exit-before-stop" ]; then
  for gone in $(cat "$ST/exit-before-stop"); do
    grep -vx "$gone" "$ST/msys-alive" > "$ST/msys-alive.new"; mv "$ST/msys-alive.new" "$ST/msys-alive"
    grep -v "^9$gone," "$ST/win-alive" > "$ST/win-alive.new"; mv "$ST/win-alive.new" "$ST/win-alive"
  done
fi
stop_child "unit"
STOP_RC=$?
echo "RC=$STOP_RC"
echo "STOP_PATH=$STOP_PATH"
echo "ALIVE=[$(cut -d, -f1 "$ST/win-alive" | sort -n | tr '\n' ' ')]"
echo "HANDED=[$(grep -v '^$' "$ST/handed" | sort -u | tr '\n' ' ')]"
echo "BACKSTOP=[$(printf '%s' "$LAST_STOP_SNAPSHOT" | tr '\n' ' ')]"
if [ "$MODE" = "retry" ]; then
  if [ -f "$ST/heal-before-retry" ]; then rm -f "$ST"/fail-*; fi
  retry_stop_escalation "unit" "$STOP_RC"
  echo "RETRY_RC=$?"
  echo "RETRY_ALIVE=[$(cut -d, -f1 "$ST/win-alive" | sort -n | tr '\n' ' ')]"
fi
DRVEOF

# Builds a state directory holding the child the live launch runs: wrapper 100
# on Windows pid 9100, env 101 on 9101 and claude 102 on 9102, where a walk
# from 9100 reaches 9100 alone. `launch` holds the wrapper and nothing under it.
stop_state() {  # <case name> <chain|launch>
  local st="$UNIT/stop-$1"
  rm -rf "$st"; mkdir -p "$st"
  if [ "$2" = "chain" ]; then
    printf '%s\n' \
      '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND' \
      '      100       1     100       9100  ?         197613 22:20:40 /usr/bin/bash' \
      '      101     100     100       9101  ?         197613 22:20:41 /usr/bin/env' \
      '      102     101     100       9102  ?         197613 22:20:42 /c/Users/x/claude' > "$st/ps-table"
    printf '%s\n' 100 101 102 > "$st/msys-alive"
    printf '%s\n' 9100,1 9101,2 9102,3 > "$st/win-alive"
    printf '%s\n' '9100|9100,1' '9101|9101,2;9102,3' '9102|9102,3' > "$st/walks"
  else
    printf '%s\n' \
      '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND' \
      '      100       1     100       9100  ?         197613 22:20:40 /usr/bin/bash' > "$st/ps-table"
    printf '%s\n' 100 > "$st/msys-alive"
    printf '%s\n' 9100,1 > "$st/win-alive"
    printf '%s\n' '9100|9100,1' > "$st/walks"
  fi
  printf '%s' "$st"
}
stop_run() {  # <state dir> [mode]
  bash "$UNIT/stop-driver.sh" "$UNIT/stop.sh" "$@" 2>&1
}
stop_field() {  # <output> <field>
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -1
}

ST=$(stop_state chain chain)
SO=$(stop_run "$ST")
[ "$(stop_field "$SO" RC)" = "0" ] && [ "$(stop_field "$SO" STOP_PATH)" = "term" ] && [ "$(stop_field "$SO" ALIVE)" = "[]" ]
V=$?
check "unit: a TERM that ends the wrapper while claude.exe runs under a dead fork intermediate kills claude.exe before the stop reports clean (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) ALIVE=$(stop_field "$SO" ALIVE))" "$V"
case "$(stop_field "$SO" HANDED)" in *" 9102,3 "*|"[9102,3 "*) R=0 ;; *) R=1 ;; esac
check "unit: claude.exe reaches the stop's kill list by its own pid and start ticks (HANDED=$(stop_field "$SO" HANDED))" "$R"
grep -q '//T' "$ST/native" 2>/dev/null
[ "$?" -ne 0 ]
V=$?
check "unit: the stop issues no tree kill (native calls: $(cat "$ST/native" 2>/dev/null | tr '\n' ';'))" "$V"

# The last poll saw the wrapper alone, and claude.exe started under it before
# the stop. The stop reads the tree as it stands when the stop begins.
ST=$(stop_state grown chain)
cp "$ST/ps-table" "$ST/ps-table-stop"
head -2 "$ST/ps-table-stop" > "$ST/ps-table"
SO=$(stop_run "$ST")
[ "$(stop_field "$SO" RC)" = "0" ] && [ "$(stop_field "$SO" STOP_PATH)" = "term" ] && [ "$(stop_field "$SO" ALIVE)" = "[]" ]
V=$?
check "unit: a child whose tree grew after the last poll is stopped from its tree as it stands at the stop (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) ALIVE=$(stop_field "$SO" ALIVE))" "$V"

# The wrapper exits before the stop begins and claude.exe outlives it, where no
# kill ends it. The stop reports the failure under its own name.
ST=$(stop_state gone-survivor chain)
printf '%s\n' 100 > "$ST/exit-before-stop"
: > "$ST/nokill-9102"
SO=$(stop_run "$ST")
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "gone_kill_failed" ] && [ "$(stop_field "$SO" ALIVE)" = "[9102 ]" ]
V=$?
check "unit: a wrapper gone before the stop, leaving a claude.exe no kill ends, reports gone_kill_failed (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) ALIVE=$(stop_field "$SO" ALIVE))" "$V"
ST=$(stop_state gone-clean chain)
printf '%s\n' 100 > "$ST/exit-before-stop"
SO=$(stop_run "$ST")
[ "$(stop_field "$SO" RC)" = "0" ] && [ "$(stop_field "$SO" STOP_PATH)" = "gone" ] && [ "$(stop_field "$SO" ALIVE)" = "[]" ]
V=$?
check "unit: control: the same wrapper gone before the stop, with claude.exe killable, reports gone with nothing alive (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) ALIVE=$(stop_field "$SO" ALIVE))" "$V"

# A record that never named a process under the wrapper is not a whole record,
# so the stop cannot call the tree clean, however cleanly the wrapper ends.
ST=$(stop_state no-descendant launch)
SO=$(stop_run "$ST")
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "unverified" ] && [ "$(stop_field "$SO" BACKSTOP)" = "[]" ]
V=$?
check "unit: a stop whose tree record is not whole fails closed as unverified and leaves nothing for the retry backstop (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) BACKSTOP=$(stop_field "$SO" BACKSTOP))" "$V"

# The retry backstop after a stop that failed closed. The last poll saw the
# wrapper alone, claude.exe then started behind the dead fork intermediate,
# the walk that would record it fails, and the wrapper survives every signal.
# The stop leaves no snapshot, so the retry builds its own, and a snapshot of
# the wrapper alone would kill bash and report the tree dead.
retry_state() {  # <case name>
  local st
  st=$(stop_state "$1" chain)
  cp "$st/ps-table" "$st/ps-table-stop"
  head -2 "$st/ps-table-stop" > "$st/ps-table"
  : > "$st/fail-9102"
  : > "$st/noterm-100"
  printf '%s' "$st"
}
ST=$(retry_state retry-unverified)
SO=$(stop_run "$ST" retry)
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "unverified" ] && [ "$(stop_field "$SO" RETRY_RC)" = "1" ] && [ "$(stop_field "$SO" RETRY_ALIVE)" = "[9100 9101 9102 ]" ]
V=$?
check "unit: the retry after a stop that failed closed, with the wrapper alive and claude.exe unrecorded, reports failure rather than a dead tree (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) RETRY_RC=$(stop_field "$SO" RETRY_RC) RETRY_ALIVE=$(stop_field "$SO" RETRY_ALIVE))" "$V"
ST=$(retry_state retry-healed)
: > "$ST/heal-before-retry"
SO=$(stop_run "$ST" retry)
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" RETRY_RC)" = "0" ] && [ "$(stop_field "$SO" RETRY_ALIVE)" = "[]" ]
V=$?
check "unit: control: the same retry once the failed walk completes records claude.exe and kills it before reporting the tree dead (RC=$(stop_field "$SO" RC) RETRY_RC=$(stop_field "$SO" RETRY_RC) RETRY_ALIVE=$(stop_field "$SO" RETRY_ALIVE))" "$V"

# A walk from a closure member that does not complete leaves that member's
# tree unaccounted for, even where the record from the last poll names it.
ST=$(stop_state walk-fails chain)
: > "$ST/fail-9102"
SO=$(stop_run "$ST")
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "unverified" ] && [ "$(stop_field "$SO" BACKSTOP)" = "[]" ]
V=$?
check "unit: a stop whose walk from a closure member fails is unverified rather than clean (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH))" "$V"

# The walk from env's Windows pid reads back an unrelated process, and by the
# time it returns env's MSYS pid runs as another Windows pid. That walk's lines
# describe whatever held the id, so none of them reaches a kill list. The
# process itself is still running, now under a Windows pid no walk in this
# stop reached, so the stop has a live member of the child's closure it cannot
# account for and reports unverified rather than clean. The log line naming
# the discarded walk is read, since several other refusals in stop_child reach
# the same STOP_PATH.
ST=$(stop_state moved chain)
printf '9999,9\n' > "$ST/impostor-9101"
printf '%s\n' '9999,9' >> "$ST/win-alive"
printf 'echo 9555 > "$ST/moved-101"\n' > "$ST/on-walk-9101"
SO=$(stop_run "$ST")
case "$(stop_field "$SO" HANDED)" in *9999*) R=1 ;; *) R=0 ;; esac
[ "$R" -eq 0 ] && [ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "unverified" ] \
  && [ "$(stop_field "$SO" ALIVE)" = "[9101 9102 9999 ]" ]
V=$?
check "unit: a walk whose MSYS pid maps to another Windows pid once it returns leaves that process unaccounted for, so the stop is unverified and the process the walk read is never checked or killed (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) HANDED=$(stop_field "$SO" HANDED) ALIVE=$(stop_field "$SO" ALIVE))" "$V"
case "$SO" in *"(MSYS pid 101) did not complete or was discarded (rc=4)"*) R=0 ;; *) R=1 ;; esac
check "unit: that refusal is the moved walk's own discard rather than another of the stop's refusals" "$R"

# The same walk where env's MSYS pid has exited by the time it returns, with
# its old Windows pid mapping still readable.
ST=$(stop_state exited chain)
printf '9999,9\n' > "$ST/impostor-9101"
printf '%s\n' '9999,9' >> "$ST/win-alive"
printf '%s\n' ': > "$ST/zombie-101"' 'grep -vx 101 "$ST/msys-alive" > "$ST/msys-alive.new"; mv "$ST/msys-alive.new" "$ST/msys-alive"' > "$ST/on-walk-9101"
SO=$(stop_run "$ST")
case "$(stop_field "$SO" HANDED)" in *9999*) R=1 ;; *) R=0 ;; esac
[ "$R" -eq 0 ] && [ "$(stop_field "$SO" RC)" = "0" ] && [ "$(stop_field "$SO" ALIVE)" = "[9999 ]" ]
V=$?
check "unit: a walk whose MSYS pid is gone once it returns is discarded, so the process it read is never checked or killed (HANDED=$(stop_field "$SO" HANDED) ALIVE=$(stop_field "$SO" ALIVE))" "$V"

# A walk that completes and names nothing at all, not even its own root, while
# the MSYS process that root runs as is alive and still maps to the Windows pid
# walked. A completed walk always names its own root, so a walk that named
# nothing read a table that did not cover a process living across its own
# reading. That tree is unaccounted for, and reading it as an empty one is what
# lets a stop report clean over a `claude.exe` the table never named.
ST=$(stop_state empty-walk chain)
: > "$ST/emptywalk-9102"
SO=$(stop_run "$ST")
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "unverified" ]
V=$?
check "unit: a walk that named nothing while its own root is alive leaves the stop unverified rather than clean (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH))" "$V"
case "$SO" in *"named no process at all while MSYS pid 102 still runs as that pid"*) R=0 ;; *) R=1 ;; esac
check "unit: that refusal is the empty walk under a live root rather than another of the stop's refusals" "$R"

# The same empty walk where the MSYS process exited inside it. That process is
# no part of the tree any more and the Windows pid the walk read is not its own,
# so the walk is discarded and the stop reads the rest of the tree.
ST=$(stop_state empty-walk-exited chain)
: > "$ST/emptywalk-9102"
printf '%s\n' 'grep -vx 102 "$ST/msys-alive" > "$ST/msys-alive.new"; mv "$ST/msys-alive.new" "$ST/msys-alive"' > "$ST/on-walk-9102"
SO=$(stop_run "$ST")
[ "$(stop_field "$SO" RC)" = "0" ] && [ "$(stop_field "$SO" ALIVE)" = "[]" ]
V=$?
check "unit: control: the same empty walk whose MSYS pid has exited is discarded rather than refused, so the refusal above is the live root (RC=$(stop_field "$SO" RC) ALIVE=$(stop_field "$SO" ALIVE))" "$V"

# The wrapper's Windows pid at the force kill. The pid was resolved at stop
# entry, two grace windows back, and Windows hands a dead process's id out
# again, so a force kill on the entry value can land on a process the child
# never started. The wrapper here moves to another Windows pid as the TERM
# reaches it, which is the window the two grace periods open.
ST=$(stop_state kill-moved chain)
: > "$ST/noterm-100"
printf 'echo 9555 > "$ST/moved-100"\n' > "$ST/on-signal-100"
SO=$(stop_run "$ST")
! grep -q 'taskkill' "$ST/native" 2>/dev/null
V=$?
check "unit: a wrapper whose Windows pid moved between the stop's entry and its force kill is not force-killed on the entry value (native calls: $(tr '\n' ';' < "$ST/native" 2>/dev/null))" "$V"
case "$SO" in *"runs as Windows pid 9555 now, not the 9100 "*) R=0 ;; *) R=1 ;; esac
check "unit: the stop names the Windows pid the wrapper moved to rather than killing the number it held at entry" "$R"
grep -qx -- "-9 100" "$ST/signals"
V=$?
check "unit: that stop still signals the wrapper's own MSYS pid (signals: $(tr '\n' ';' < "$ST/signals" 2>/dev/null))" "$V"
# The snapshot was walked from the pid the wrapper has left, so whatever it
# started under the new one is in no snapshot and a kill from that list cannot
# report the tree dead. The stop fails closed and leaves no snapshot behind.
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "unverified" ] && [ "$(stop_field "$SO" BACKSTOP)" = "[]" ]
V=$?
check "unit: a stop whose wrapper moved to a Windows pid the snapshot was never walked from fails closed rather than reporting a kill (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) BACKSTOP=$(stop_field "$SO" BACKSTOP))" "$V"
case "$SO" in *"cannot be confirmed dead from it"*) R=0 ;; *) R=1 ;; esac
check "unit: the stop says the snapshot it holds cannot settle the tree the wrapper moved to" "$R"

# The same moved wrapper through the retry backstop every caller runs after a
# failed stop, where a walk from the Windows pid the wrapper moved to completes.
# The stop still kills every process its snapshot names, ticks-matched, since
# those are the child's own and nothing else will reach them. The retry then
# fails without a re-snapshot: one built from the same record plus that walk
# would confirm the list dead and turn the refusal into a clean rc 0.
ST=$(stop_state kill-moved-retry chain)
: > "$ST/noterm-100"
printf 'echo 9555 > "$ST/moved-100"\n' > "$ST/on-signal-100"
printf '%s\n' '9555|9555,7' >> "$ST/walks"
SO=$(stop_run "$ST" retry)
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "unverified" ] && [ "$(stop_field "$SO" ALIVE)" = "[]" ]
V=$?
check "unit: a stop whose wrapper moved Windows pid still kills every process its snapshot names before failing closed (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) ALIVE=$(stop_field "$SO" ALIVE))" "$V"
[ "$(stop_field "$SO" RETRY_RC)" = "1" ]
V=$?
check "unit: the retry after that refusal fails rather than rebuilding a snapshot and reporting the tree dead (RETRY_RC=$(stop_field "$SO" RETRY_RC))" "$V"
case "$SO" in *"no retry can confirm that tree dead, failing without a re-snapshot"*) R=0 ;; *) R=1 ;; esac
check "unit: that retry failure is the moved-wrapper refusal rather than a re-snapshot that could not verify" "$R"
case "$SO" in *"attempting one re-snapshot"*) R=1 ;; *) R=0 ;; esac
check "unit: that retry never attempts a re-snapshot" "$R"

# A wrapper the stop can still signal but whose Windows pid no reading names is
# a failed read, not a move: nothing says the entry value has been handed to
# another process, so the ticks-matched snapshot kill still runs.
ST=$(stop_state kill-unresolved chain)
: > "$ST/noterm-100"
printf 'printf "" > "$ST/moved-100"\n' > "$ST/on-signal-100"
SO=$(stop_run "$ST")
case "$SO" in *"no Windows pid could be read for wrapper pid 100 at the force kill"*) R=0 ;; *) R=1 ;; esac
check "unit: a wrapper whose Windows pid no reading names at the force kill is reported as a failed read rather than a move" "$R"
[ "$(stop_field "$SO" RC)" = "0" ] && [ "$(stop_field "$SO" STOP_PATH)" = "kill" ] && [ "$(stop_field "$SO" ALIVE)" = "[]" ]
V=$?
check "unit: that stop signals the wrapper and still kills the recorded tree (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) ALIVE=$(stop_field "$SO" ALIVE))" "$V"
! grep -q 'taskkill' "$ST/native" 2>/dev/null
V=$?
check "unit: that stop force-kills no Windows pid number, since none was read (native calls: $(tr '\n' ';' < "$ST/native" 2>/dev/null))" "$V"
case "$SO" in *"is still present after the kill -9"*) R=0 ;; *) R=1 ;; esac
check "unit: a wrapper that outlives the force kill is named, since every caller then waits on it" "$R"

ST=$(stop_state kill-held chain)
: > "$ST/noterm-100"
SO=$(stop_run "$ST")
grep -q 'taskkill //F //PID 9100' "$ST/native" 2>/dev/null
V=$?
check "unit: control: a wrapper still running as the Windows pid the stop resolved at entry is force-killed on it, so the refusal above is the move (native calls: $(tr '\n' ';' < "$ST/native" 2>/dev/null))" "$V"

# The merged snapshot is where the self filter reads, so a walk the stop takes
# itself that names this process refuses the stop.
ST=$(stop_state self-in-walk chain)
: > "$ST/self-in-9102"
SO=$(stop_run "$ST")
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "unverified" ]
V=$?
check "unit: a merged snapshot naming this process's own Windows pid is unverified rather than killed from (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH) HANDED=$(stop_field "$SO" HANDED))" "$V"
ST=$(stop_state no-self chain)
SO=$(stop_run "$ST" no_self)
[ "$(stop_field "$SO" RC)" = "1" ] && [ "$(stop_field "$SO" STOP_PATH)" = "unverified" ]
V=$?
check "unit: a stop that cannot resolve this process's own Windows pid is unverified, since the merged snapshot cannot be cleared of it (RC=$(stop_field "$SO" RC) STOP_PATH=$(stop_field "$SO" STOP_PATH))" "$V"

# The poll that records the tree discards a walk the same way, keeping the
# standing record rather than taking one built on a mapping that moved.
ST=$(stop_state refresh-moved chain)
printf 'echo 9555 > "$ST/moved-101"\n' > "$ST/on-walk-9101"
SO=$(stop_run "$ST" refresh)
[ "$(stop_field "$SO" WALKED)" = "[]" ] && [ "$(stop_field "$SO" RECORD)" = "[]" ]
V=$?
check "unit: a poll whose walk ends with its MSYS pid mapped to another Windows pid records nothing from that poll (WALKED=$(stop_field "$SO" WALKED) RECORD=$(stop_field "$SO" RECORD))" "$V"
ST=$(stop_state refresh-control chain)
SO=$(stop_run "$ST" refresh)
[ "$(stop_field "$SO" WALKED)" = "[1]" ] && [ "$(stop_field "$SO" RECORD)" = "[9100,1 9101,2 9102,3]" ]
V=$?
check "unit: control: the same poll with every mapping held records the whole tree (WALKED=$(stop_field "$SO" WALKED) RECORD=$(stop_field "$SO" RECORD))" "$V"

# A closure member that exits inside its own walk is a different discard from
# one that moved. The agent's own short-lived helpers do this on nearly every
# poll, and a poll that read each of them as a tree it could not walk would
# leave the record permanently behind the child's pid set, which is the state
# that refuses every later stop and sweep. So the member drops out of the
# poll's pid set and the rest of the tree is still recorded.
ST=$(stop_state refresh-exited chain)
printf '%s\n' 'grep -vx 101 "$ST/msys-alive" > "$ST/msys-alive.new"; mv "$ST/msys-alive.new" "$ST/msys-alive"' > "$ST/on-walk-9101"
SO=$(stop_run "$ST" refresh)
[ "$(stop_field "$SO" WALKED)" = "[1]" ] && [ "$(stop_field "$SO" RECORD)" = "[9100,1 9102,3]" ] \
  && [ "$(stop_field "$SO" WINPIDS)" = "[9100 9102]" ] && [ "$(stop_field "$SO" SEEN)" = "[9100 9102]" ]
V=$?
check "unit: a poll whose closure member exits inside its own walk records the rest of the tree and leaves that member's Windows pid out of the pid set (WALKED=$(stop_field "$SO" WALKED) RECORD=$(stop_field "$SO" RECORD) WINPIDS=$(stop_field "$SO" WINPIDS) SEEN=$(stop_field "$SO" SEEN))" "$V"

# The same drop where that member's walk also did not complete. An exited
# process no longer holds the Windows pid the walk read, so an unverified
# reading of that pid is no more evidence about the child's tree than a clean
# one, and the liveness check is what runs first to say so.
ST=$(stop_state refresh-exited-failed chain)
printf '%s\n' 'grep -vx 101 "$ST/msys-alive" > "$ST/msys-alive.new"; mv "$ST/msys-alive.new" "$ST/msys-alive"' > "$ST/on-walk-9101"
: > "$ST/fail-9101"
SO=$(stop_run "$ST" refresh)
[ "$(stop_field "$SO" WALKED)" = "[1]" ] && [ "$(stop_field "$SO" RECORD)" = "[9100,1 9102,3]" ] \
  && [ "$(stop_field "$SO" WINPIDS)" = "[9100 9102]" ]
V=$?
check "unit: a poll whose closure member exits inside a walk that also failed drops that member rather than reading the poll as a failed walk (WALKED=$(stop_field "$SO" WALKED) RECORD=$(stop_field "$SO" RECORD) WINPIDS=$(stop_field "$SO" WINPIDS))" "$V"

# Control, the direction the drop must not swallow: the walk fails while its
# MSYS process is still running as the Windows pid walked. That member is part
# of the tree and this poll has no reading of it, so the standing record is
# kept and the pid set seen under the child runs ahead of it.
ST=$(stop_state refresh-live-walk-fails chain)
: > "$ST/fail-9101"
SO=$(stop_run "$ST" refresh)
[ "$(stop_field "$SO" WALKED)" = "[]" ] && [ "$(stop_field "$SO" RECORD)" = "[]" ] \
  && [ "$(stop_field "$SO" WINPIDS)" = "[]" ] && [ "$(stop_field "$SO" SEEN)" = "[9100 9101 9102]" ]
V=$?
check "unit: control: a poll whose walk fails under a live MSYS process records nothing and leaves the pid set seen ahead of the record (WALKED=$(stop_field "$SO" WALKED) RECORD=$(stop_field "$SO" RECORD) SEEN=$(stop_field "$SO" SEEN))" "$V"

# Every member of the closure exiting inside its own walk is the shape a child
# that dies at its own launch leaves. There is nothing left for the poll to
# have read, so it records nothing and leaves the pid set seen under the child
# as it was, rather than marking a tree that could not be read.
ST=$(stop_state refresh-all-exited launch)
printf '%s\n' 'grep -vx 100 "$ST/msys-alive" > "$ST/msys-alive.new"; mv "$ST/msys-alive.new" "$ST/msys-alive"' > "$ST/on-walk-9100"
SO=$(stop_run "$ST" refresh)
[ "$(stop_field "$SO" WALKED)" = "[]" ] && [ "$(stop_field "$SO" RECORD)" = "[]" ] && [ "$(stop_field "$SO" SEEN)" = "[]" ]
V=$?
check "unit: a poll whose whole closure exits inside its own walks records nothing and leaves the pid set seen under the child as it was (WALKED=$(stop_field "$SO" WALKED) RECORD=$(stop_field "$SO" RECORD) SEEN=$(stop_field "$SO" SEEN))" "$V"

# The rate limit reader, against the record shape a parked child writes: a
# `system` record with subtype `api_retry`, `error_status` 429 and the
# remaining wait in `retry_delay_ms`, one every 30 seconds while the park runs.
node -e '
const fs = require("fs");
const dir = process.argv[1];
const at = (n) => dir + "/" + n;
const retry = (delay, status) => JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 300, retry_delay_ms: delay, error_status: status, error: "rate_limit", session_id: "s", uuid: "u" });
const work = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "back at work" }] } });
const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s" });
fs.writeFileSync(at("rl-parked.jsonl"), init + "\n" + retry(600000, 429) + "\n");
fs.writeFileSync(at("rl-worked-past.jsonl"), retry(600000, 429) + "\n" + work + "\n");
fs.writeFileSync(at("rl-other-status.jsonl"), retry(600000, 500) + "\n");
fs.writeFileSync(at("rl-working.jsonl"), init + "\n" + work + "\n");
// The child is mid-write: the newest COMPLETE line is the park, and the bytes
// after it are not a record yet.
fs.writeFileSync(at("rl-partial.jsonl"), retry(600000, 429) + "\n" + work.slice(0, 40));
// The same park with a half-written record ahead of it, which is what the tail
// of a long stream looks like where the read begins mid-line.
fs.writeFileSync(at("rl-lead-partial.jsonl"), work.slice(40) + "\n" + retry(600000, 429) + "\n");
fs.writeFileSync(at("rl-empty.jsonl"), "");
' "$UNIT"
cat > "$UNIT/ratelimit-driver.sh" <<'DRVEOF'
set -u
FN_FILE="$1"; STREAM="$2"
RUNDIR="$(dirname "$STREAM")"
. "$FN_FILE"
get_rate_limit_reset "$STREAM"
DRVEOF
ratelimit() { bash "$UNIT/ratelimit-driver.sh" "$UNIT/ratelimit.sh" "$UNIT/$1"; }
# The reading's first field is a clock value no fixture can name in advance, so
# these check it lands inside the window the record's own remaining wait names.
rl_ms() { printf '%s' "$1" | cut -d' ' -f1; }
rl_iso() { printf '%s' "$1" | cut -d' ' -f2; }
rl_in_window() {  # <reading> <expected remaining wait ms>
  local ms; ms=$(rl_ms "$1")
  case "$ms" in ''|*[!0-9]*) return 1 ;; esac
  local now; now=$(node -e "console.log(Date.now())")
  [ "$ms" -le "$(( now + $2 ))" ] && [ "$ms" -gt "$(( now + $2 - 120000 ))" ]
}

RL=$(ratelimit rl-parked.jsonl)
rl_in_window "$RL" 600000 && printf '%s' "$(rl_iso "$RL")" | grep -q '^[0-9][0-9]*-[0-9][0-9]-[0-9][0-9]T'
check "unit: the newest record being a 429 api_retry names the moment its remaining wait ends, in epoch milliseconds and ISO 8601 (got [$RL])" "$?"
RL=$(ratelimit rl-worked-past.jsonl)
[ "$RL" = "- -" ]; check "unit: control: a park the child wrote a record of its own after is over, so nothing is reported (got [$RL])" "$?"
RL=$(ratelimit rl-other-status.jsonl)
[ "$RL" = "- -" ]; check "unit: a retry the engine made for something other than a 429 is not a rate limit park (got [$RL])" "$?"
RL=$(ratelimit rl-working.jsonl)
[ "$RL" = "- -" ]; check "unit: a child whose newest record is its own work reports no park (got [$RL])" "$?"
RL=$(ratelimit rl-partial.jsonl)
rl_in_window "$RL" 600000
check "unit: a half-written record at the end of the stream is not read as the child's newest word, so the park behind it still reports (got [$RL])" "$?"
RL=$(ratelimit rl-lead-partial.jsonl)
rl_in_window "$RL" 600000
check "unit: a half-written record at the head of what was read does not break the reading behind it (got [$RL])" "$?"
RL=$(ratelimit rl-empty.jsonl)
[ "$RL" = "- -" ]; check "unit: an empty stream reports no park (got [$RL])" "$?"
RL=$(ratelimit rl-absent.jsonl)
[ "$RL" = "- -" ]; check "unit: a stream that does not exist yet reports no park (got [$RL])" "$?"
mark stop-child-and-ratelimit
fi  # end of the unit blocks

# --- The stub child ---
# ${...} placeholders in the extracted literal become a fixed root id. The
# untracked_work detail is the shape the hook writes, and no reader parses it.
STUB="$TMP/stub"
mkdir -p "$STUB" "$TMP/home/.claude/plugins/store"
printf '{}' > "$TMP/home/.claude/plugins/store/agentic-plugin_agent-persona-natexit.json"
printf '%s' "$BACKSTOP_DETAIL" > "$STUB/detail-backfilled"
printf '%s\n' "${DETAILS:-}" | head -n 1 | tr -d '\n' | sed 's/\${[^}]*}/root-r1/g' > "$STUB/detail-real"
printf '%s' 'x1: stub goal' > "$STUB/detail-untracked"
cat > "$STUB/claude" <<EOF
#!/usr/bin/env bash
# Reads its action for this launch from the current case's plan, one line per
# launch, and records the launch before acting on it.
S="$STUB"
CASE_DIR=\$(cat "\$S/case")
n=\$(( \$(wc -l < "\$CASE_DIR/launches" 2>/dev/null || echo 0) + 1 ))
echo "\$n" >> "\$CASE_DIR/launches"
action=\$(sed -n "\${n}p" "\$CASE_DIR/plan")
record() {  # <decision action> <detail file, or empty>
  node -e '
const fs = require("fs");
const [act, detailFile, persona] = process.argv.slice(1);
const f = ".agentic-personas.json";
let s = {};
try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
s[persona] = s[persona] || { decisions: [] };
const detail = detailFile ? fs.readFileSync(detailFile, "utf8") : "stub";
s[persona].decisions.push({ timestamp: Date.now(), loop: "goal", action: act, detail });
fs.writeFileSync(f, JSON.stringify(s));
' "\$1" "\$2" "$PERSONA_NAME"
}
# The stream-json init line the supervisor reads this child's session id from.
emit_init() {
  echo '{"type":"system","subtype":"init","session_id":"stub-sess-1"}'
}
# A heartbeat sidecar this child owns, stamped at the moment it is written,
# which is what the real writer produces.
write_heartbeat() {
  node -e '
const fs = require("fs");
const [file, persona] = process.argv.slice(1);
fs.writeFileSync(file, JSON.stringify({ [persona]: { sessionId: "stub-sess-1", epoch: 1, lastSeen: Date.now() } }));
' ".agentic-heartbeat.json" "$PERSONA_NAME"
}
# The same sidecar rewritten on a cadence in the background, each write
# stamping the moment of the write. This is what a session that is held keeps
# doing while the child itself does nothing, since the stamp is on a timer.
# The writer also stops at the first tick that finds the heartbeat-stop file,
# so a child that waits on the supervisor rather than on a fixed time can end
# its writer and wait for it before exiting, leaving nothing running behind it.
write_heartbeat_repeatedly() {  # <writes> <interval seconds>
  node -e '
const fs = require("fs");
const [file, persona, writes, interval, marker, stop] = process.argv.slice(1);
let written = 0;
const tick = () => {
  if (fs.existsSync(stop)) return;
  fs.writeFileSync(file, JSON.stringify({ [persona]: { sessionId: "stub-sess-1", epoch: 1, lastSeen: Date.now() } }));
  written += 1;
  fs.appendFileSync(marker, String(Date.now()) + "\n");
  if (written < Number(writes)) setTimeout(tick, Number(interval) * 1000);
};
tick();
' ".agentic-heartbeat.json" "$PERSONA_NAME" "\$1" "\$2" "\$CASE_DIR/heartbeat-writes" "\$CASE_DIR/heartbeat-stop" &
}
# Blocks until the supervisor's log carries its liveness line for the named
# poll, in either the waiting or the rate-limited form, so a case asserting on
# that line holds the child up for as many polls as the supervisor takes on
# this box rather than for a fixed time. Any form ends the wait, which leaves
# the case's own assertion to say whether it was the right one. Bounded, so a
# supervisor that never writes the line still lets the case end and fail.
wait_for_poll_line() {  # <poll number> <bound seconds>
  local waited=0
  until grep -q "(poll \$1)\$" "\$CASE_DIR/rd/supervisor.log" 2>/dev/null; do
    [ "\$waited" -ge "\$2" ] && return 1
    sleep 1
    waited=\$((waited + 1))
  done
  return 0
}
# Blocks until the supervisor's log carries a line matching the pattern, so a
# case that has to act after the supervisor read something waits on the reading
# itself rather than on a time that assumes how long a poll takes. Bounded, so a
# supervisor that never writes the line still lets the case end and fail.
wait_for_log_line() {  # <grep pattern> <bound seconds>
  local waited=0
  until grep -q "\$1" "\$CASE_DIR/rd/supervisor.log" 2>/dev/null; do
    [ "\$waited" -ge "\$2" ] && return 1
    sleep 1
    waited=\$((waited + 1))
  done
  return 0
}
# The heartbeat file only this child writes, <rundir>/heartbeat.json, stamped
# once at the moment it is written. Stamped once and never again, it goes
# stale after staleAfterMs, which is what earns a probe in the mailbox.
write_child_heartbeat() {
  node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({ sessionId: "stub-sess-1", lastSeen: Date.now(), turnStartedAt: null }));
' "\$CASE_DIR/rd/heartbeat.json"
}
# Blocks until the supervisor has written a probe to the mailbox, which it
# does only once it reads this child's heartbeat as stale. Bounded, so a
# supervisor that never probes still lets the case end and fail.
wait_for_probe() {  # <bound seconds>
  local waited=0
  until grep -q '"kind":"probe"' "\$CASE_DIR/rd/mailbox.jsonl" 2>/dev/null; do
    [ "\$waited" -ge "\$1" ] && return 1
    sleep 1
    waited=\$((waited + 1))
  done
  return 0
}
# Ends this child's heartbeat writer and waits for it to exit.
stop_heartbeat() {
  : > "\$CASE_DIR/heartbeat-stop"
  wait
}
# A record of a kind the child writes when it is working. Any record that is
# not a rate limit report is the child writing, which is what marks a limit
# reported before it as one the child went on past.
emit_work() {
  echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"back at work"}]}}'
}
# Leaves a live native Windows process behind and records it as the
# "pid,ticks" pair the supervisor's own stop path works in, through that same
# path's own snapshot helper. Native rather than an MSYS binary, because an
# MSYS one is spawned through a forked intermediate that exits, and a walk
# over live processes never reaches past that dead parent to find it.
leave_survivor() {
  powershell.exe -NoProfile -Command "Start-Sleep -Seconds 90" &
  sp=\$!
  sleep 1
  sp_winpid=\$(tr -d '\r\n' < "/proc/\$sp/winpid" 2>/dev/null)
  RUNDIR="\$CASE_DIR"
  . "$TMP/stub-fns.sh"
  snapshot_process_tree "\$sp_winpid" > "\$CASE_DIR/survivor.snapshot"
}
# The record the engine writes every 30 seconds while a child is parked on a
# rate limit: a retry carrying the 429 and how much of the wait is left.
emit_rate_limit() {  # <remaining wait milliseconds>
  node -e '
console.log(JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 300, retry_delay_ms: Number(process.argv[1]), error_status: 429, error: "rate_limit", session_id: "stub-sess-1", uuid: "u" }));
' "\$1"
}
case "\$action" in
  startup) exit 1 ;;
  crash7) IFS= read -r _; sleep 3; exit 7 ;;
  backfilled) IFS= read -r _; record root_complete "\$S/detail-backfilled"; exit 0 ;;
  backfilled7) IFS= read -r _; record root_complete "\$S/detail-backfilled"; exit 7 ;;
  real) IFS= read -r _; record root_complete "\$S/detail-real"; exit 0 ;;
  # Work with no open goal: the hook's untracked_work line, then an exit.
  untracked) IFS= read -r _; record untracked_work "\$S/detail-untracked"; exit 0 ;;
  untracked7) IFS= read -r _; record untracked_work "\$S/detail-untracked"; exit 7 ;;
  # A clean exit that records nothing.
  clean) IFS= read -r _; exit 0 ;;
  # The coordinator's restart request, written the way fleet_restart writes
  # it: one file in the run directory, with no store fact beside it.
  request) IFS= read -r _; node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ at: Date.now(), by: "coordinator", reason: "stub" }))' "\$CASE_DIR/rd/restart.request"; exit 0 ;;
  # A real root_complete with the child still alive: the supervisor's decide
  # path, not the natural-exit path, must act on it. The loop blocks on stdin
  # until the supervisor's EOF stop closes it.
  real_live) IFS= read -r _; record root_complete "\$S/detail-real"; while IFS= read -r _; do :; done; exit 0 ;;
  shutdown) IFS= read -r _; record shutdown_requested ""; exit 0 ;;
  # The persona's own park for an update window, then an exit.
  park) IFS= read -r _; record park_requested ""; exit 0 ;;
  # The same park with the child still alive, so the decide path acts on it.
  # The loop blocks on stdin until the supervisor's EOF stop closes it.
  park_live) IFS= read -r _; record park_requested ""; while IFS= read -r _; do :; done; exit 0 ;;
  # A process left running when this child exits: the shape a \`claude.exe\`
  # outliving its wrapper takes. The child then stays up across two polls, the
  # way a real one does, since the supervisor records a child's process tree
  # while it runs and nothing can name that tree afterwards.
  survivor)
    IFS= read -r _
    leave_survivor
    sleep 11
    exit 0
    ;;
  # The same process left behind, with the operator's own shutdown recorded
  # before this child exits.
  survivor_shutdown)
    IFS= read -r _
    leave_survivor
    record shutdown_requested ""
    exit 0
    ;;
  # The same again, held across two polls so the supervisor records the tree the
  # survivor is in. A child that exits inside its first poll interval is swept
  # against a record taken before the agent process existed, which names nothing
  # to sweep.
  survivor_shutdown_held)
    IFS= read -r _
    leave_survivor
    # The record and the exit land in the tail of a poll the supervisor has
    # already read its facts on, which is the shape that reaches the
    # natural-exit path with a shutdown recorded: a poll that reads the fact
    # while the child still runs takes the decide path's own stop instead.
    wait_for_log_line "TAILWINDOW" 90
    record shutdown_requested ""
    exit 0
    ;;
  # The same held survivor with a park recorded in place of the shutdown.
  survivor_park_held)
    IFS= read -r _
    leave_survivor
    wait_for_log_line "TAILWINDOW" 90
    record park_requested ""
    exit 0
    ;;
  # The same held survivor and park with the child still alive after it, so
  # the decide path's stop_park stops it. The loop blocks on stdin until the
  # supervisor's EOF stop closes it.
  survivor_park_live)
    IFS= read -r _
    leave_survivor
    wait_for_log_line "TAILWINDOW" 90
    record park_requested ""
    while IFS= read -r _; do :; done
    exit 0
    ;;
  # A child that runs for two polls and exits on its own, leaving nothing
  # behind. Paired with a supervisor whose poll body is slow, it is the shape a
  # loaded box produces: every poll confirmed the tree, and the wall clock
  # between the last confirmation and the sweep ran long anyway.
  slow)
    IFS= read -r _
    # A process under this child that outlives a whole poll, so the record the
    # sweep later reads names something that ran under the wrapper. A transient
    # helper is dropped by the poll that meets it exiting inside its own walk,
    # which leaves the record naming the wrapper alone.
    sleep 60 &
    slow_helper=\$!
    wait_for_log_line "runs as Windows pid(s) [0-9][0-9]* [0-9]" 90
    kill "\$slow_helper" 2>/dev/null
    exit 0
    ;;
  # Parked on a rate limit: the newest record this child writes is the engine's
  # own 429 retry, and it writes nothing after it. Held until the liveness
  # cadence has reported on the sixth poll, which is the line the case reads.
  # The shared sidecar heartbeat these two keep moving is read by nothing in
  # the poll; the silence bound is left at its default, so no liveness verdict
  # can end either run.
  rate_limited) IFS= read -r _; emit_init; write_heartbeat_repeatedly 200 3; emit_rate_limit 600000; wait_for_poll_line 6 300; stop_heartbeat; record shutdown_requested ""; exit 0 ;;
  # Control: the same park with the child's own work written after it, which is
  # how a park ends. The newest record is that work, not the retry.
  rate_limited_worked_past) IFS= read -r _; emit_init; write_heartbeat_repeatedly 200 3; emit_rate_limit 600000; emit_work; wait_for_poll_line 6 300; stop_heartbeat; record shutdown_requested ""; exit 0 ;;
  # A park with every other signal silent: the child's own heartbeat stamped
  # once and gone stale, its transcript an hour old, and nothing written after
  # the retry. The child holds until the supervisor has probed it and taken
  # eighteen polls past that, far past the probe's window and the silence
  # bound, then ends the run itself.
  rate_limited_quiet) IFS= read -r _; emit_init; write_child_heartbeat; emit_rate_limit 600000; wait_for_probe 180; wait_for_poll_line 18 300; record shutdown_requested ""; exit 0 ;;
  # The child's own heartbeat stamped once and never again, while the case
  # keeps its transcript moving. The child holds until the supervisor has
  # probed it and taken eighteen polls past that, then ends the run itself. A
  # supervisor that restarts it instead closes this stdin first, so the case
  # ends either way.
  alive_transcript) IFS= read -r _; emit_init; write_child_heartbeat; wait_for_probe 180; wait_for_poll_line 18 300; record shutdown_requested ""; exit 0 ;;
  # A child whose plugin never writes its own heartbeat file. It holds until
  # the supervisor has named the missing file and then taken eighteen polls,
  # each of which reads the file absent, then ends the run itself.
  no_heartbeat) IFS= read -r _; emit_init; wait_for_log_line "HEARTBEAT_ABSENT child-1" 180; wait_for_poll_line 18 300; record shutdown_requested ""; exit 0 ;;
  # The same stamped-once heartbeat with a stream that grows once the final ask
  # is logged. The child holds until the ask is cleared, then ends the run.
  frozen_answers) IFS= read -r _; emit_init; write_child_heartbeat; wait_for_log_line "FINAL_ASK child-1:" 180; emit_work; wait_for_log_line "FINAL_ASK_CLEARED child-1" 120; record shutdown_requested ""; exit 0 ;;
  # The same stamped-once heartbeat with every other signal silent too. The
  # child blocks until the supervisor's frozen restart closes its stdin.
  hung_quiet) IFS= read -r _; emit_init; write_child_heartbeat; while IFS= read -r _; do :; done; exit 0 ;;
  # The same, with the child exiting non-zero when its stdin closes, so the
  # decide path's frozen restart counts as a crash.
  hung_quiet7) IFS= read -r _; emit_init; write_child_heartbeat; while IFS= read -r _; do :; done; exit 7 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$STUB/claude"

# Usage: drive <case> <plan actions, comma-separated> <restart budget> [extra supervise.sh args...]
# Runs the supervisor to its own exit (bounded at 420s) and sets RC, LOG, OUT.
# The bound is a backstop against a supervisor that never ends, not a schedule.
# It is sized for the longest case rather than the average one: the rate-limit
# cases hold their child until the supervisor's liveness cadence reports on its
# sixth poll, and a poll body that spawns PowerShell walks takes tens of seconds
# while the box carries other work, which has put that sixth poll past a minute
# and a half. A bound those cases can cross reports a timeout as the case's own
# exit code, which reads as a defect in whatever the case was about.
# The crash limit is always 1. The restart budget is per case, because the
# natural-exit path checks the budget before the crash limit.
# SUP_OVERRIDE runs a case against a copy of the supervisor instead of the
# tracked one, and DRIVE_CRASH_LIMIT raises the crash limit for a case that
# needs to see a relaunch. Both are reset by their case.
# DRIVE_ENV carries environment a case needs the supervisor to run under, such
# as its own USERPROFILE or a shorter staleAfterMs. Reset by its case.
SUP_OVERRIDE=""
DRIVE_CRASH_LIMIT=1
DRIVE_ENV=()
# The poll interval every driven run takes, and the single biggest term in this
# suite's wall clock. Most cases here do not wait a fixed number of seconds:
# they wait for the supervisor to reach its Nth poll, so the whole suite scales
# with this value. 1000 is the floor rather than a preference. bin/supervise.sh
# sleeps a whole number of seconds (`sleep $((SUPERVISOR_POLL_MS / 1000))`) and
# refuses anything under 1000 outright, because a smaller value divides to zero
# and polls with no wait at all. Going below a second is therefore a change to
# the supervisor's own sleep granularity, not a change a case may make.
DRIVE_POLL_MS=1000
drive() {
  local name="$1" plan="$2" budget="$3"; shift 3
  # A case outside this process's share is not run, and every check that
  # follows it is suppressed until the next driven case begins. The checks a
  # case makes before its own drive (that an injected copy parses, that an
  # anchor appears once) do not depend on the run and are left to run here, so
  # they are covered by every process rather than by exactly one.
  # The assertions after a skipped case still run, and this suite runs under
  # `set -u`, so they are given a harmless state to read rather than the
  # previous case's. An empty log makes every `grep -q` fail and a zero rc
  # makes every comparison decide something; check() discards the verdicts
  # either way. Without this the first assertion after a skipped case aborts
  # the whole process on an unbound RC.
  if ! want "$name"; then
    SKIP_CASE=1
    RC=0; OUT=""; LAUNCHES=0; LOG="$TMP/skipped.log"; : > "$LOG"
    return 0
  fi
  SKIP_CASE=0
  local dir="$TMP/$name"
  mkdir -p "$dir/wd" "$dir/rd"
  printf '%s\n' "$plan" | tr ',' '\n' > "$dir/plan"
  printf '%s' "$dir" > "$STUB/case"
  local _t0=$(date +%s)
  OUT=$(env -i PATH="$STUB:$PATH" HOME="$TMP/home" "${DRIVE_ENV[@]}" \
    supervisorPollMs="$DRIVE_POLL_MS" supervisorCrashLimit="$DRIVE_CRASH_LIMIT" supervisorMaxRestartsPerHour="$budget" \
    timeout 420 bash "${SUP_OVERRIDE:-$SUP}" "$dir/wd" "$PERSONA_NAME" default --rundir "$dir/rd" --no-channel "$@" 2>&1)
  RC=$?
  printf '%s %s\n' "$(( $(date +%s) - _t0 ))" "$name" >> "$CASE_TIMES"
  LOG="$dir/rd/supervisor.log"
  [ -f "$LOG" ] || : > "$LOG"
  LAUNCHES=$(wc -l < "$dir/launches" 2>/dev/null || echo 0)
}

# --- (a) backfilled root_complete, exit 0: relaunched unaccounted ---
# supervisorMaxRestartsPerHour=1 makes an accounted relaunch end the run with
# STOP_BUDGET, so its absence shows the relaunch was not counted.
drive a "backfilled,shutdown" 1 --prompt "stub goal"
[ "$RC" -eq 0 ]; check "(a) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(a) child-1's exit is handled by the natural-exit path with code 0" "$?"
grep -q 'is backfilled' "$LOG"; check "(a) the NOTE line names the backfilled root" "$?"
grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(a) a second child launches (stub launches=$LAUNCHES)" "$?"
! grep -q 'RESTART_PASSIVE:' "$LOG"; check "(a) no 'RESTART_PASSIVE:' line anywhere in supervisor.log" "$?"
! grep -q -e 'STOP_BUDGET' -e 'STOP_CRASH_LOOP' "$LOG"; check "(a) no STOP_BUDGET or STOP_CRASH_LOOP line, so the relaunch was not accounted" "$?"
grep -qE 'SWEEP\[natural_exit\] (clean|survivors|survivors_dead|survivors_alive|no_tree|tree_unread|record_behind_tree|record_no_descendant|record_stale|record_unverified):' "$LOG"
check "(a) the natural-exit sweep runs ahead of the relaunch and names its verdict" "$?"

# --- (b) control: a real root_complete, exit 0, takes RESTART_PASSIVE ---
drive b "real,shutdown" 1 --prompt "stub goal"
[ "$RC" -eq 0 ]; check "(b) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(b) child-1's exit is handled by the natural-exit path with code 0" "$?"
grep -q 'RESTART_PASSIVE: root_complete at [0-9]* > child start [0-9]* (no shutdown requested)' "$LOG"; check "(b) the natural-exit RESTART_PASSIVE line is present" "$?"
! grep -q 'is backfilled' "$LOG"; check "(b) no backfilled NOTE line" "$?"
grep -q 'LAUNCH child-2' "$LOG"; check "(b) a second child launches" "$?"

# --- (b2) a restart request file, exit 0, takes RESTART_PASSIVE ---
# Case (b) with the coordinator's restart.request in the run directory in
# place of the store fact, and no store fact at all. The natural-exit path
# reads the file as the same restart_requested fact and relaunches
# unaccounted, so the restart budget of 1 is not spent. The file is left in
# place, and the second child starts after it, so the request it carries is
# stale for that child and does not restart it again.
drive b2 "request,shutdown" 1 --prompt "stub goal"
[ "$RC" -eq 0 ]; check "(b2) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(b2) child-1's exit is handled by the natural-exit path with code 0" "$?"
grep -q 'RESTART_PASSIVE: restart_requested at [0-9]* > child start [0-9]* (no shutdown requested)' "$LOG"; check "(b2) the natural-exit RESTART_PASSIVE line names the restart request" "$?"
! grep -q -e 'STOP_BUDGET' -e 'STOP_CRASH_LOOP' "$LOG"; check "(b2) no STOP_BUDGET or STOP_CRASH_LOOP line, so the relaunch was not accounted" "$?"
grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(b2) exactly two children launch, so the served request did not restart the second (stub launches=$LAUNCHES)" "$?"

# --- (g) a real root_complete while the child is still alive: the decide path ---
# No --prompt, so the launch writes only the priming line and the poll loop
# starts at once. The stub records a real root_complete and stays alive, so
# the natural-exit path never sees child-1; the decide unit maps the newer
# root_complete to restart_passive, the supervisor stops child-1 through
# stop_child and relaunches. The decide path's line carries no
# "(no shutdown requested)" suffix, which is how it is told from the
# natural-exit line case (b) asserts.
drive g "real_live,shutdown" 1
[ "$RC" -eq 0 ]; check "(g) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'RESTART_PASSIVE: root_complete at [0-9]* > child start [0-9]*$' "$LOG"; check "(g) the decide path's RESTART_PASSIVE line is present (no natural-exit suffix)" "$?"
G_RP=$(grep -n 'RESTART_PASSIVE: root_complete' "$LOG" | head -n 1 | cut -d: -f1)
G_EXIT1=$(grep -n 'EXIT child-1 code=' "$LOG" | head -n 1 | cut -d: -f1)
[ -n "$G_RP" ] && [ -n "$G_EXIT1" ] && [ "$G_RP" -lt "$G_EXIT1" ]; check "(g) child-1's EXIT line follows the RESTART_PASSIVE line, so the stop was the decide path's (lines $G_RP < $G_EXIT1)" "$?"
! grep -q 'EXIT child-1 code=[0-9]* (natural)' "$LOG"; check "(g) no natural-exit EXIT line for child-1" "$?"
grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(g) a second child launches (stub launches=$LAUNCHES)" "$?"

# --- (pk) a recorded park, then the child's own exit: the supervisor exits 6 ---
# The persona parks for an update window: the child records park_requested and
# exits on its own. The keeper reads exit 6 as a park and launches the persona
# again at its next start, where exit 0 would hold it down until a hand
# release. Launched with --prompt, so the natural-exit path handles the exit.
# The plan holds one launch and the restart budget is 1, so a supervisor that
# reads no park counts the exit against that budget and ends at exit 4.
drive pk "park" 1 --prompt "stub goal"
[ "$RC" -eq 6 ]; check "(pk) supervisor exits 6 on the child's park_requested (rc=$RC)" "$?"
grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(pk) child-1's exit is handled by the natural-exit path with code 0" "$?"
grep -q 'STOP_PARK: park_requested at [0-9]* > child start [0-9]*' "$LOG"; check "(pk) the log names the park the child recorded" "$?"
grep -qE 'SWEEP\[park\] (clean|survivors|survivors_dead|survivors_alive|no_tree|tree_unread|record_behind_tree|record_no_descendant|record_stale|record_unverified):' "$LOG"
check "(pk) the park sweeps the child's tree under its own label and names its verdict" "$?"
! grep -q 'SWEEP\[natural_exit\]' "$LOG"; check "(pk) the natural-exit sweep does not also run once the park is read" "$?"
! grep -q 'STOP_COMPLETE' "$LOG"; check "(pk) no STOP_COMPLETE line, so the park is not reported as a shutdown" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(pk) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (pkd) a recorded park while the child is still alive: the decide path ---
# Case (g)'s shape with a park in place of the root_complete: no --prompt, and
# the stub stays alive, so the decide unit maps the newer park_requested to
# stop_park and the supervisor stops child-1 through stop_child. The decide
# path's STOP_PARK line comes ahead of child-1's EXIT line, and that EXIT line
# names the stop path rather than a natural exit.
drive pkd "park_live" 6
[ "$RC" -eq 6 ]; check "(pkd) supervisor exits 6 on the decide path's park (rc=$RC)" "$?"
grep -q 'STOP_PARK: park_requested at [0-9]* > child start [0-9]*' "$LOG"; check "(pkd) the decide path's STOP_PARK line is present" "$?"
PKD_SP=$(grep -n 'STOP_PARK: park_requested' "$LOG" | head -n 1 | cut -d: -f1)
PKD_EXIT1=$(grep -n 'EXIT child-1 code=' "$LOG" | head -n 1 | cut -d: -f1)
[ -n "$PKD_SP" ] && [ -n "$PKD_EXIT1" ] && [ "$PKD_SP" -lt "$PKD_EXIT1" ]; check "(pkd) child-1's EXIT line follows the STOP_PARK line, so the stop was the decide path's (lines $PKD_SP < $PKD_EXIT1)" "$?"
! grep -q 'EXIT child-1 code=[0-9]* (natural)' "$LOG"; check "(pkd) no natural-exit EXIT line for child-1" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(pkd) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (c) a child exiting 7 during the poll loop: recorded and counted ---
# supervisorCrashLimit=1, so one counted crash ends the run with exit 3.
drive c "crash7,shutdown" 6
[ "$RC" -eq 3 ]; check "(c) supervisor exits 3 on the crash limit (rc=$RC)" "$?"
grep -q 'EXIT child-1 code=7 (natural)' "$LOG"; check "(c) child-1 is recorded as code=7, natural" "$?"
grep -q 'STOP_CRASH_LOOP: 1 crashes' "$LOG"; check "(c) the exit counts toward the crash limit" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(c) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (e) a backfilled root_complete with a non-zero exit takes the crash path ---
# The unaccounted relaunch in (a) is gated on both the backfilled flag and a
# clean exit. This case holds the flag and flips the exit code, so it shows the
# second half of that gate: the run is accounted as a crash, and the NOTE line
# (a) asserts is absent here.
drive e "backfilled7" 6 --prompt "stub goal"
grep -q 'EXIT child-1 code=7 (natural)' "$LOG"; check "(e) child-1 is recorded as code=7, natural" "$?"
! grep -q 'is backfilled' "$LOG"; check "(e) no backfilled NOTE line, so the unaccounted relaunch was not taken" "$?"
! grep -q 'RESTART_PASSIVE:' "$LOG"; check "(e) no 'RESTART_PASSIVE:' line" "$?"
[ "$RC" -eq 3 ] && grep -q 'STOP_CRASH_LOOP: 1 crashes' "$LOG"; check "(e) the exit is counted as a crash and ends the run (rc=$RC)" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(e) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (uw) untracked_work, exit 0: relaunched unaccounted ---
# The hook's line for work with no open goal. supervisorMaxRestartsPerHour=1
# makes an accounted relaunch end the run with STOP_BUDGET, so its absence
# shows the relaunch was not counted.
drive uw "untracked,shutdown" 1 --prompt "stub goal"
[ "$RC" -eq 0 ]; check "(uw) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(uw) child-1's exit is handled by the natural-exit path with code 0" "$?"
grep -q 'NOTE: untracked_work at [0-9]* > child start [0-9]* is untracked work' "$LOG"; check "(uw) the NOTE line names the untracked work" "$?"
grep -q 'PASSIVE: relaunching unaccounted after untracked work' "$LOG"; check "(uw) the PASSIVE line names the unaccounted relaunch" "$?"
! grep -q 'is backfilled' "$LOG"; check "(uw) no backfilled NOTE line" "$?"
grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(uw) a second child launches (stub launches=$LAUNCHES)" "$?"
! grep -q 'RESTART_PASSIVE:' "$LOG"; check "(uw) no 'RESTART_PASSIVE:' line anywhere in supervisor.log" "$?"
! grep -q -e 'STOP_BUDGET' -e 'STOP_CRASH_LOOP' "$LOG"; check "(uw) no STOP_BUDGET or STOP_CRASH_LOOP line, so the relaunch was not accounted" "$?"
grep -qE 'SWEEP\[natural_exit\] (clean|survivors|survivors_dead|survivors_alive|no_tree|tree_unread|record_behind_tree|record_no_descendant|record_stale|record_unverified):' "$LOG"
check "(uw) the natural-exit sweep runs ahead of the relaunch and names its verdict" "$?"

# --- (uw2) an untracked_work line older than the child's start is accounted ---
# Child-1 records untracked_work and relaunches unaccounted as in (uw). Child-2
# exits 0 recording nothing, so the newest untracked_work predates its start,
# and its exit is accounted: with a budget of 1 that ends the run at exit 4.
drive uw2 "untracked,clean" 1 --prompt "stub goal"
[ "$RC" -eq 4 ] && grep -q 'STOP_BUDGET' "$LOG"; check "(uw2) child-2's clean exit is accounted and ends the run on the budget (rc=$RC)" "$?"
[ "$(grep -c 'is untracked work' "$LOG")" -eq 1 ]; check "(uw2) exactly one untracked NOTE line, child-1's" "$?"
[ "$LAUNCHES" -eq 2 ]; check "(uw2) two children launch (stub launches=$LAUNCHES)" "$?"

# --- (uw7) untracked_work with a non-zero exit takes the crash path ---
# The unaccounted relaunch in (uw) is gated on a clean exit. This case keeps
# the line and flips the exit code: the run is accounted as a crash, and the
# NOTE line (uw) asserts is absent here.
drive uw7 "untracked7" 6 --prompt "stub goal"
grep -q 'EXIT child-1 code=7 (natural)' "$LOG"; check "(uw7) child-1 is recorded as code=7, natural" "$?"
! grep -q 'is untracked work' "$LOG"; check "(uw7) no untracked NOTE line, so the unaccounted relaunch was not taken" "$?"
! grep -q 'RESTART_PASSIVE:' "$LOG"; check "(uw7) no 'RESTART_PASSIVE:' line" "$?"
[ "$RC" -eq 3 ] && grep -q 'STOP_CRASH_LOOP: 1 crashes' "$LOG"; check "(uw7) the exit is counted as a crash and ends the run (rc=$RC)" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(uw7) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (f) a child whose stdin is already gone at launch ---
# The window between the coproc and the copy of its write fd is too narrow for
# a real child to die inside, so the state is injected: a copy of the
# supervisor with the coproc array unset immediately after the launch. What
# this case holds is the handling. An unusable stdin skips the two writes and
# nothing more: the child's death is recorded, counted as a crash, and the
# supervisor relaunches instead of ending the run.
ANCHORS=$(grep -c '^  CHILD_LAUNCH_PID=\$!$' "$SUP")
[ "$ANCHORS" -eq 1 ]; check "(f) the launch line the injection keys on appears once in bin/supervise.sh (found $ANCHORS)" "$?"
if [ "$ANCHORS" -eq 1 ]; then
  mkdir -p "$TMP/inject/bin"
  cp "$ROOT"/bin/*.sh "$ROOT"/bin/*.mjs "$TMP/inject/bin/"
  awk '{ print }
       /^  CHILD_LAUNCH_PID=\$!$/ { print "  unset CHILD" }' "$SUP" > "$TMP/inject/bin/supervise.sh"
  SUP_OVERRIDE="$TMP/inject/bin/supervise.sh"
  DRIVE_CRASH_LIMIT=2
  drive f "startup,startup" 6
  SUP_OVERRIDE=""
  DRIVE_CRASH_LIMIT=1
  [ "$(grep -c 'exited before its stdin could be written to' "$LOG")" -eq 2 ]; check "(f) both children report the skipped stdin writes" "$?"
  grep -q 'EXIT child-1 code=1 (natural)' "$LOG"; check "(f) child-1's death is recorded" "$?"
  grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(f) the supervisor survives to relaunch (stub launches=$LAUNCHES)" "$?"
  [ "$RC" -eq 3 ] && grep -q 'STOP_CRASH_LOOP: 2 crashes' "$LOG"; check "(f) both deaths are counted as crashes and end the run (rc=$RC)" "$?"
fi

# --- (h) a process that outlives the child is killed before the relaunch ---
# The stub leaves a live native Windows process behind and exits, so the
# natural-exit path meets exactly the shape a \`claude.exe\` under a dead
# wrapper takes: the pid the wrapper ran as does not resolve, and only the
# pid stored at launch can find the tree.
drive h "survivor,shutdown" 6
SURV_PAIR=$(grep -E '^[0-9]+,[0-9]+$' "$TMP/h/survivor.snapshot" 2>/dev/null | head -1)
[ -n "$SURV_PAIR" ]; R=$?
check "(h) setup: the stub left a native Windows process behind and recorded it as pid and start ticks (${SURV_PAIR:-none})" "$R"
grep -q "SWEEP\[natural_exit\] survivors: processes from child-1 outlived it" "$LOG"; check "(h) the natural-exit sweep names the surviving process" "$?"
grep -q "SWEEP\[natural_exit\] survivors_dead:" "$LOG"; check "(h) the sweep confirms the tree dead" "$?"
H_SWEEP=$(grep -n 'SWEEP\[natural_exit\] survivors_dead:' "$LOG" | head -n 1 | cut -d: -f1)
H_LAUNCH2=$(grep -n 'LAUNCH child-2' "$LOG" | head -n 1 | cut -d: -f1)
[ -n "$H_SWEEP" ] && [ -n "$H_LAUNCH2" ] && [ "$H_SWEEP" -lt "$H_LAUNCH2" ]; check "(h) the kill lands before the next child launches (lines $H_SWEEP < $H_LAUNCH2)" "$?"
if [ "$R" -eq 0 ]; then
  # Matched by pid and start ticks, so a pid Windows recycled onto another
  # process during the run cannot read as the survivor still being alive.
  H_ALIVE=$(check_snapshot_survivors "$SURV_PAIR")
  H_RC=$?
  [ "$H_RC" -eq 0 ] && [ -z "$H_ALIVE" ]; check "(h) the survivor, matched by pid and start ticks, is dead after the run" "$?"
fi

# The harness transcript path for a case, derived here from the rule the
# harness itself uses: the launch directory in Windows form with every
# character outside A-Za-z0-9 replaced by a hyphen. Derived independently of
# the supervisor rather than read back from it, so a supervisor that resolves
# the key any other way finds no file and the cases below say so.
transcript_path() {  # <workdir> <profile dir> <session id>
  local key
  key=$(node -e 'console.log(process.argv[1].replace(/[^A-Za-z0-9]/g, "-"))' "$(cygpath -w "$1")")
  printf '%s\n' "$2/.claude/projects/$key/$3.jsonl"
}
# Appends one turn record to a transcript, its timestamp the given number of
# seconds ago. The liveness verdict reads the record's own timestamp and
# never the file's modification time, so this is how a case sets the
# transcript's age.
write_turn_aged() {  # <path> <age seconds>
  mkdir -p "$(dirname "$1")"
  node -e '
const fs = require("fs");
const [file, age] = process.argv.slice(1);
fs.appendFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() - Number(age) * 1000).toISOString() }) + "\n");
' "$1" "$2"
}
# The bounds every liveness case runs under: a five-second silence bound and
# heartbeat bound, a one-second controller tick so a probe's window is three
# seconds at the one-second poll, a two-second probe interval, and a
# three-second final ask. A case that needs the ask's window longer sets its
# own. Each case adds its own USERPROFILE.
LIVENESS_ENV=(staleAfterMs=5000 supervisorSilenceBoundMs=5000 supervisorProbeMs=2000 supervisorFinalAskMs=3000 controllerTickMs=1000)
# How many FINAL_ASK lines for child-1 sit ahead of the first line matching
# the pattern, so a case can assert the ask was written once before its end.
asks_before() {  # <grep pattern>
  local stop
  stop=$(grep -n "$1" "$LOG" | head -n 1 | cut -d: -f1)
  [ -n "$stop" ] || { echo 0; return; }
  head -n "$stop" "$LOG" | grep -c 'FINAL_ASK child-1:'
}

# --- (i) the decide path's restart stops at the restart budget ---
# A frozen child takes the decide path's restart branch: its own heartbeat is
# stamped once and never again, its transcript's newest turn record is an
# hour old, its stream is silent after the init line, the probe the stale
# heartbeat earns goes unacknowledged, and the walk finds its process live.
# That reads frozen, the final ask is written once, and the ask's window
# closes silent. The budget is 1, so this restart reaches it. The
# discriminating assertion is the launch count: a run that relaunches first
# and stops at the next child's first poll exits 4 as well, one child later.
# The stopped child exits on its own stdin closing, so nothing counts as a
# crash. The limit is raised for symmetry with (j), where the raise can decide
# the case. Here it cannot: the decide path reads the restart budget before
# the crash limit, and the budget is 1, so no crash count reaches its own
# check ahead of the exit 4 this case asserts.
mkdir -p "$TMP/i/wd" "$TMP/i/profile"
write_turn_aged "$(transcript_path "$TMP/i/wd" "$TMP/i/profile" "stub-sess-1")" 3600
DRIVE_CRASH_LIMIT=2
DRIVE_ENV=("${LIVENESS_ENV[@]}" USERPROFILE="$TMP/i/profile")
drive i "hung_quiet,shutdown" 1
DRIVE_ENV=()
DRIVE_CRASH_LIMIT=1
[ "$RC" -eq 4 ]; check "(i) supervisor exits 4 at the restart budget (rc=$RC)" "$?"
grep -q '"kind":"probe"' "$TMP/i/rd/mailbox.jsonl"; check "(i) setup: the stale heartbeat earned a probe in the mailbox" "$?"
grep -q 'RESTART: frozen: the final ask at [0-9]* went unanswered' "$LOG"; check "(i) the decide path took the restart branch on a final ask that went unanswered" "$?"
I_ASKS=$(asks_before 'RESTART: frozen')
[ "$I_ASKS" -eq 1 ]; check "(i) the final ask was written once before the restart (asks=$I_ASKS)" "$?"
grep -q 'STOP_BUDGET: 1/1 restarts in the hour' "$LOG"; check "(i) the budget line names the limit it stopped at" "$?"
! grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 1 ]; check "(i) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (j) control: one below the budget, the decide path still relaunches ---
mkdir -p "$TMP/j/wd" "$TMP/j/profile"
write_turn_aged "$(transcript_path "$TMP/j/wd" "$TMP/j/profile" "stub-sess-1")" 3600
DRIVE_CRASH_LIMIT=2
DRIVE_ENV=("${LIVENESS_ENV[@]}" USERPROFILE="$TMP/j/profile")
drive j "hung_quiet,shutdown" 2
DRIVE_ENV=()
DRIVE_CRASH_LIMIT=1
[ "$RC" -eq 0 ]; check "(j) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'RESTART: frozen' "$LOG"; check "(j) the decide path took the restart branch" "$?"
! grep -q 'STOP_BUDGET' "$LOG"; check "(j) no STOP_BUDGET line one below the budget" "$?"
grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(j) a second child launches (stub launches=$LAUNCHES)" "$?"

# --- (k) the decide path's restart stops at the crash limit ---
# The same decide-path restart, with the child exiting 7 when its stdin
# closes, so the stop counts as a crash against a limit of 1.
mkdir -p "$TMP/k/wd" "$TMP/k/profile"
write_turn_aged "$(transcript_path "$TMP/k/wd" "$TMP/k/profile" "stub-sess-1")" 3600
DRIVE_ENV=("${LIVENESS_ENV[@]}" USERPROFILE="$TMP/k/profile")
drive k "hung_quiet7,shutdown" 6
DRIVE_ENV=()
[ "$RC" -eq 3 ]; check "(k) supervisor exits 3 at the crash limit (rc=$RC)" "$?"
grep -q 'STOP_CRASH_LOOP: 1 crashes' "$LOG"; check "(k) the crash-loop line names the limit it stopped at" "$?"
! grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 1 ]; check "(k) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (o) a parked child's log says it is parked, not that it is waiting ---
# The newest record in the child's stream is the engine's own 429 retry, which
# is the whole reading. Without it the log carries WAITING for as long as the
# park runs and the operator cannot tell a park from an idle child.
DRIVE_ENV=(staleAfterMs=5000)
drive o "rate_limited,shutdown" 6
DRIVE_ENV=()
grep -q '"subtype":"api_retry"' "$TMP/o/rd/child-1/stdout.jsonl"; check "(o) setup: the stub's retry record reached the child's stream" "$?"
[ "$RC" -eq 0 ]; check "(o) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
grep -q 'RATE_LIMITED until [0-9][0-9]*-[0-9][0-9]-[0-9][0-9]T' "$LOG"; check "(o) the log names the park and when the wait ends" "$?"
grep -q 'RATE_LIMITED until .*(poll 6)' "$LOG"; check "(o) the liveness cadence reports the park rather than plain waiting" "$?"
! grep -q 'WAITING:' "$LOG"; check "(o) no WAITING line while the child is parked" "$?"
O_PARK=$(grep -c 'is waiting out a rate limit' "$LOG")
[ "$O_PARK" -eq 1 ]; check "(o) the park is named once rather than on every poll (lines=$O_PARK)" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(o) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (p) control: the same child once it has gone back to work ---
# A park ends by itself the moment the child writes a record of its own, so the
# newest record being that work is what the log has to read as ordinary
# waiting. This is the direction that decides whether the reader is keyed on
# the newest record at all.
DRIVE_ENV=(staleAfterMs=5000)
drive p "rate_limited_worked_past,shutdown" 6
DRIVE_ENV=()
grep -q '"subtype":"api_retry"' "$TMP/p/rd/child-1/stdout.jsonl"; check "(p) setup: the stub's retry record reached the child's stream, so the case turns on the reading rather than on an absent record" "$?"
grep -q '"type":"assistant"' "$TMP/p/rd/child-1/stdout.jsonl"; check "(p) setup: the stub wrote a record of its own after the retry" "$?"
[ "$RC" -eq 0 ]; check "(p) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
grep -q 'WAITING: child-1 alive' "$LOG"; check "(p) the log reads a child that has gone back to work as waiting" "$?"
! grep -q 'RATE_LIMITED' "$LOG"; check "(p) no RATE_LIMITED line for a retry the child has already worked past" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(p) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (t) a parked child is not read as frozen ---
# A usage limit is read ahead of every other signal. This child's newest
# stream record is the engine's 429 retry, and every other signal is silent:
# its own heartbeat stamped once and gone stale, its transcript an hour old,
# the probe the stale heartbeat earns unacknowledged, and the walk finding its
# process live. That reads alive with the reason usage_limit and never
# reaches the final ask, however many polls it holds for.
mkdir -p "$TMP/t/wd" "$TMP/t/profile"
write_turn_aged "$(transcript_path "$TMP/t/wd" "$TMP/t/profile" "stub-sess-1")" 3600
DRIVE_ENV=("${LIVENESS_ENV[@]}" USERPROFILE="$TMP/t/profile")
drive t "rate_limited_quiet" 6
DRIVE_ENV=()
grep -q '"subtype":"api_retry"' "$TMP/t/rd/child-1/stdout.jsonl"; check "(t) setup: the stub's retry record reached the child's stream" "$?"
T_RECORDS=$(grep -cv '"subtype":"api_retry"' "$TMP/t/rd/child-1/stdout.jsonl" 2>/dev/null); T_RECORDS=${T_RECORDS:-0}
[ "$T_RECORDS" -eq 1 ]; check "(t) setup: the only record the child wrote after the retry is the init line before it (other records=$T_RECORDS)" "$?"
grep -q '"kind":"probe"' "$TMP/t/rd/mailbox.jsonl"; check "(t) setup: the stale heartbeat earned a probe, so every signal but the stream's newest record was silent" "$?"
[ "$RC" -eq 0 ]; check "(t) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
grep -q 'RATE_LIMITED until [0-9][0-9]*-[0-9][0-9]-[0-9][0-9]T' "$LOG"; check "(t) the log names the park and when the wait ends" "$?"
grep -q 'LIVENESS child-1: alive usage_limit' "$LOG"; check "(t) the liveness verdict names the usage limit as what holds the child alive" "$?"
! grep -q 'FINAL_ASK' "$LOG"; check "(t) a parked child never reaches the final ask" "$?"
! grep -q 'RESTART:' "$LOG"; check "(t) a parked child is not restarted" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(t) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (aa) a stale heartbeat beside a moving transcript stays alive ---
# The child's own heartbeat is stamped once and goes stale, so the supervisor
# probes it and the probe goes unacknowledged, and its stream is silent after
# the init line. The case keeps appending a fresh turn record to its
# transcript, which is the one signal still moving, and that holds the child
# alive through eighteen polls past the probe.
mkdir -p "$TMP/aa/wd" "$TMP/aa/profile"
AA_TRANSCRIPT=$(transcript_path "$TMP/aa/wd" "$TMP/aa/profile" "stub-sess-1")
write_turn_aged "$AA_TRANSCRIPT" 0
( until [ -f "$TMP/aa/touch-stop" ]; do write_turn_aged "$AA_TRANSCRIPT" 0; sleep 1; done ) &
AA_TOUCHER=$!
DRIVE_ENV=("${LIVENESS_ENV[@]}" USERPROFILE="$TMP/aa/profile")
drive aa "alive_transcript" 6
: > "$TMP/aa/touch-stop"
wait "$AA_TOUCHER" 2>/dev/null
DRIVE_ENV=()
[ -f "$AA_TRANSCRIPT" ]; check "(aa) setup: a transcript sits under the launch directory's own project key" "$?"
grep -q '"kind":"probe"' "$TMP/aa/rd/mailbox.jsonl"; check "(aa) setup: the stale heartbeat earned a probe in the mailbox" "$?"
grep -q 'LIVENESS child-1: alive signal' "$LOG"; check "(aa) the liveness verdict reads the child alive on a moving signal" "$?"
! grep -q 'FINAL_ASK' "$LOG"; check "(aa) a child whose transcript is moving is never asked" "$?"
! grep -q 'RESTART:' "$LOG"; check "(aa) a child whose transcript is moving is not restarted on its still heartbeat" "$?"
[ "$RC" -eq 0 ]; check "(aa) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(aa) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (ab) a frozen child that answers inside the final ask's window ---
# Every signal silent reads frozen and the final ask is written. The stub then
# writes one record to its stream, which is a signal moving inside the
# window, so the next poll reads alive and clears the ask, and the child is
# never restarted. The window is a minute here, so the answer lands inside
# it however slowly this box polls.
mkdir -p "$TMP/ab/wd" "$TMP/ab/profile"
write_turn_aged "$(transcript_path "$TMP/ab/wd" "$TMP/ab/profile" "stub-sess-1")" 3600
DRIVE_ENV=("${LIVENESS_ENV[@]}" supervisorFinalAskMs=60000 USERPROFILE="$TMP/ab/profile")
drive ab "frozen_answers" 6
DRIVE_ENV=()
grep -q 'FINAL_ASK child-1: frozen: every signal is silent and the walk found a live process' "$LOG"; check "(ab) every signal silent with a live process reads frozen and takes the final ask" "$?"
AB_ASKS=$(asks_before 'FINAL_ASK_CLEARED child-1')
[ "$AB_ASKS" -eq 1 ]; check "(ab) the final ask is written once, not on every frozen poll inside the window (asks=$AB_ASKS)" "$?"
grep -q 'FINAL_ASK_CLEARED child-1: a signal moved inside the final ask' "$LOG"; check "(ab) the stream moving inside the window returns the child to alive and clears the ask" "$?"
! grep -q 'RESTART:' "$LOG"; check "(ab) a frozen child that answered inside the window is not restarted" "$?"
[ "$RC" -eq 0 ]; check "(ab) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(ab) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (ac) fail closed: no transcript to read at all ---
# A transcript the supervisor cannot read is the state a profile it cannot
# resolve and a project key it derives wrong both produce, and reading either
# as silence would kill working children. So an unreadable transcript reads
# alive, whatever the other signals say.
mkdir -p "$TMP/ac/wd" "$TMP/ac/profile"
DRIVE_ENV=("${LIVENESS_ENV[@]}" USERPROFILE="$TMP/ac/profile")
drive ac "alive_transcript" 6
DRIVE_ENV=()
[ ! -e "$TMP/ac/profile/.claude/projects" ]; check "(ac) setup: no transcript exists anywhere under this case's USERPROFILE" "$?"
grep -q '"kind":"probe"' "$TMP/ac/rd/mailbox.jsonl"; check "(ac) setup: the stale heartbeat earned a probe in the mailbox" "$?"
grep -q 'LIVENESS child-1: alive transcript_unreadable' "$LOG"; check "(ac) the verdict names the unreadable transcript as what holds the child alive" "$?"
! grep -q -e 'FINAL_ASK' -e 'RESTART:' "$LOG"; check "(ac) a child with no readable transcript is neither asked nor restarted" "$?"
[ "$RC" -eq 0 ]; check "(ac) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(ac) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (ha) a heartbeat file never written is named once ---
# Past the startup grace, every poll reads the child's own heartbeat file
# absent, and the supervisor names that once per child rather than on each of
# those polls. The file never written is not silent, so the child is neither
# asked nor restarted.
mkdir -p "$TMP/ha/wd" "$TMP/ha/profile"
DRIVE_ENV=("${LIVENESS_ENV[@]}" USERPROFILE="$TMP/ha/profile")
drive ha "no_heartbeat" 6
DRIVE_ENV=()
[ ! -e "$TMP/ha/rd/heartbeat.json" ]; check "(ha) setup: no heartbeat file was ever written" "$?"
grep -q '(poll 18)$' "$LOG"; check "(ha) setup: the supervisor ran eighteen polls, most of them past the grace" "$?"
HA_LINES=$(grep -c 'HEARTBEAT_ABSENT child-1' "$LOG" 2>/dev/null); HA_LINES=${HA_LINES:-0}
[ "$HA_LINES" -eq 1 ]; check "(ha) HEARTBEAT_ABSENT is named once across every poll that read the file absent (lines=$HA_LINES)" "$?"
! grep -q -e 'FINAL_ASK' -e 'RESTART:' "$LOG"; check "(ha) a child whose heartbeat file was never written is neither asked nor restarted" "$?"
[ "$RC" -eq 0 ]; check "(ha) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(ha) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (r) a survivor that cannot be killed stops the run instead of relaunching ---
# The stub leaves the same native Windows process behind that case (h) uses,
# against a supervisor whose tree kill never confirms anything dead. A relaunch
# here would put the next child beside a process still holding the persona
# claim, which is the failure the natural-exit sweep exists to prevent.
KILL_ANCHORS=$(grep -c '^kill_process_snapshot() {$' "$SUP")
[ "$KILL_ANCHORS" -eq 1 ]; check "(r) the kill function the injection keys on appears once in bin/supervise.sh (found $KILL_ANCHORS)" "$?"
if [ "$KILL_ANCHORS" -eq 1 ]; then
  mkdir -p "$TMP/injectkill/bin"
  cp "$ROOT"/bin/*.sh "$ROOT"/bin/*.mjs "$TMP/injectkill/bin/"
  awk '{ print }
       /^kill_process_snapshot\(\) \{$/ { print "  log \"STOP: injected kill failure\"; return 1" }' "$SUP" > "$TMP/injectkill/bin/supervise.sh"
  SUP_OVERRIDE="$TMP/injectkill/bin/supervise.sh"
  drive r "survivor,shutdown" 6
  SUP_OVERRIDE=""
  grep -q 'injected kill failure' "$LOG"; check "(r) setup: the injected kill ran and reported failure" "$?"
  [ "$RC" -eq 5 ]; check "(r) the supervisor exits 5 rather than relaunching beside a survivor (rc=$RC)" "$?"
  grep -q 'alive or unverifiable after every sweep retry' "$LOG"; check "(r) the exit line names what the sweep could not clear" "$?"
  ! grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 1 ]; check "(r) no second child launches (stub launches=$LAUNCHES)" "$?"

  # --- (u) a requested shutdown sweeps the child's tree and still exits 0 ---
  # The ordinary way a persona goes down is its own shutdown tool: the child
  # records shutdown_requested and exits. The keeper reads exit 0 as the
  # shutdown being honored and holds the persona down; any other code
  # relaunches it. Nothing downstream ever reaches this child's tree again, so
  # the sweep has to run here or a process it left goes on holding the persona
  # claim with nobody left to kill it, and the run still has to report the
  # shutdown. Driven against the same kill failure that makes case (r) exit 5,
  # so the exit code turns on the shutdown rather than on a sweep that
  # happened to succeed. The child is held across a poll and launched with
  # no --prompt, so a poll records the tree the survivor is in: a child that
  # dies inside its first poll interval is swept against the record taken in
  # the instant after the coproc started, which names the wrapper alone and
  # leaves the sweep nothing to find. The survivors token is what says this
  # case reached the leg it is about, so it is read before the exit code.
  #
  # Which of two paths a recorded shutdown takes is decided by where in a poll
  # the child exits, and both are real: a poll that reads the fact while the
  # child runs takes the decide path's stop, and a child that exits after that
  # reading reaches the natural-exit path, which is the one this case is about.
  # So the copy driven here holds each poll open after its own readings and
  # names the window in the log, and the child exits inside it.
  mkdir -p "$TMP/injectkilltail/bin"
  cp "$TMP/injectkill/bin/"* "$TMP/injectkilltail/bin/"
  TAIL_ANCHORS=$(grep -c '^    DECIDE_ERR=\$?$' "$TMP/injectkill/bin/supervise.sh")
  [ "$TAIL_ANCHORS" -eq 1 ]; check "(u) the decide call the tail injection keys on appears once in the injected copy (found $TAIL_ANCHORS)" "$?"
  awk '{ print }
       /^    DECIDE_ERR=\$\?$/ { print "    log \"TAILWINDOW: poll $POLL_COUNT read its facts\""; print "    sleep 8" }' \
    "$TMP/injectkill/bin/supervise.sh" > "$TMP/injectkilltail/bin/supervise.sh"
  bash -n "$TMP/injectkilltail/bin/supervise.sh"
  check "(u) setup: the injected copy parses" "$?"
  SUP_OVERRIDE="$TMP/injectkilltail/bin/supervise.sh"
  drive u "survivor_shutdown_held" 6
  SUP_OVERRIDE=""
  U_PAIR=$(grep -E '^[0-9]+,[0-9]+$' "$TMP/u/survivor.snapshot" 2>/dev/null | head -1)
  [ -n "$U_PAIR" ]; check "(u) setup: the stub left a process behind and recorded it as pid and start ticks (${U_PAIR:-none})" "$?"
  grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(u) child-1's exit is handled by the natural-exit path" "$?"
  grep -q 'STOP_COMPLETE: shutdown_requested' "$LOG"; check "(u) the log names the shutdown the child recorded" "$?"
  grep -q 'SWEEP\[shutdown\] survivors: processes from child-1 outlived it' "$LOG"
  check "(u) the shutdown sweep reads the tree a poll recorded and names the surviving process" "$?"
  grep -q 'SWEEP\[shutdown\] survivors_alive:' "$LOG"
  check "(u) the injected kill leaves that survivor alive, so the exit code below turns on the shutdown alone" "$?"
  [ "$RC" -eq 0 ]; check "(u) the supervisor reports the requested shutdown as exit 0 (rc=$RC)" "$?"
  ! grep -q 'SWEEP\[natural_exit\]' "$LOG"; check "(u) the natural-exit sweep does not also run once the shutdown is read" "$?"
  [ "$LAUNCHES" -eq 1 ]; check "(u) no second child launches (stub launches=$LAUNCHES)" "$?"

  # --- (pku) a park that leaves a survivor exits 5, not 6 ---
  # Case (u) with a park recorded in place of the shutdown, against the same
  # injected kill failure and the same held tail window. A park is not a stop
  # for good, so a survivor it cannot clear ends the run at exit 5, as it does
  # on every other stop. The survivors tokens under the park's own label say
  # the case reached the park's sweep, which is what separates this exit 5 from
  # the one the natural-exit sweep gives a supervisor that reads no park.
  SUP_OVERRIDE="$TMP/injectkilltail/bin/supervise.sh"
  drive pku "survivor_park_held" 6
  SUP_OVERRIDE=""
  PKU_PAIR=$(grep -E '^[0-9]+,[0-9]+$' "$TMP/pku/survivor.snapshot" 2>/dev/null | head -1)
  [ -n "$PKU_PAIR" ]; check "(pku) setup: the stub left a process behind and recorded it as pid and start ticks (${PKU_PAIR:-none})" "$?"
  grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(pku) child-1's exit is handled by the natural-exit path" "$?"
  grep -q 'STOP_PARK: park_requested' "$LOG"; check "(pku) the log names the park the child recorded" "$?"
  grep -q 'SWEEP\[park\] survivors: processes from child-1 outlived it' "$LOG"
  check "(pku) the park sweep reads the tree a poll recorded and names the surviving process" "$?"
  grep -q 'SWEEP\[park\] survivors_alive:' "$LOG"
  check "(pku) the injected kill leaves that survivor alive, so the exit code below turns on the park's own sweep" "$?"
  [ "$RC" -eq 5 ]; check "(pku) the supervisor exits 5 rather than reporting the park as honored (rc=$RC)" "$?"
  grep -q 'alive or unverifiable after every sweep retry' "$LOG"; check "(pku) the exit line names what the sweep could not clear" "$?"
  ! grep -q 'SWEEP\[natural_exit\]' "$LOG"; check "(pku) the natural-exit sweep does not also run once the park is read" "$?"
  [ "$LAUNCHES" -eq 1 ]; check "(pku) no second child launches (stub launches=$LAUNCHES)" "$?"

  # --- (pkdu) a decide-path park that leaves a survivor exits 5, not 6 ---
  # Case (pkd)'s decide-path park against the kill failure (pku) uses. The
  # child leaves a process behind, holds past a poll so the tree record names
  # it, records the park and stays alive, so the next poll's stop_park stops
  # it. The injected kill leaves the survivor alive through every stop retry,
  # and a tree still alive outranks the park.
  SUP_OVERRIDE="$TMP/injectkilltail/bin/supervise.sh"
  drive pkdu "survivor_park_live" 6
  SUP_OVERRIDE=""
  PKDU_PAIR=$(grep -E '^[0-9]+,[0-9]+$' "$TMP/pkdu/survivor.snapshot" 2>/dev/null | head -1)
  [ -n "$PKDU_PAIR" ]; check "(pkdu) setup: the stub left a process behind and recorded it as pid and start ticks (${PKDU_PAIR:-none})" "$?"
  grep -q 'injected kill failure' "$LOG"; check "(pkdu) setup: the injected kill ran and reported failure" "$?"
  PKDU_SP=$(grep -n 'STOP_PARK: park_requested' "$LOG" | head -n 1 | cut -d: -f1)
  PKDU_EXIT1=$(grep -n 'EXIT child-1 code=' "$LOG" | head -n 1 | cut -d: -f1)
  [ -n "$PKDU_SP" ] && [ -n "$PKDU_EXIT1" ] && [ "$PKDU_SP" -lt "$PKDU_EXIT1" ]; check "(pkdu) child-1's EXIT line follows the STOP_PARK line, so the stop was the decide path's (lines $PKDU_SP < $PKDU_EXIT1)" "$?"
  ! grep -q 'EXIT child-1 code=[0-9]* (natural)' "$LOG"; check "(pkdu) no natural-exit EXIT line for child-1" "$?"
  grep -q 'EXIT child-1: a process from this child is alive or unverifiable despite every stop retry' "$LOG"; check "(pkdu) the exit line names what the stop could not clear" "$?"
  [ "$RC" -eq 5 ]; check "(pkdu) the supervisor exits 5 rather than reporting the park as honored (rc=$RC)" "$?"
  [ "$LAUNCHES" -eq 1 ]; check "(pkdu) no second child launches (stub launches=$LAUNCHES)" "$?"

fi

# --- The two relaunch branches, against a stop that leaves a survivor and
# against one whose reading never completes ---
# A relaunch beside a process the last child left running puts two children on
# one persona claim, and the pre-launch gate then spends its whole ceiling
# waiting for a claim the next child can never win. A reading that did not
# complete cannot tell that case from a clean one, so it ends the run the same
# way.
#
# The survivor check decides which of the two a stop met, so that is what these
# cases vary: one copy of the supervisor reports a survivor from it, the other
# reports a check that could not be completed. Nothing else differs, and every
# step between the decide unit's own action and the branch's exit runs for
# real.
CHECK_ANCHORS=$(grep -c '^check_snapshot_survivors() {$' "$SUP")
[ "$CHECK_ANCHORS" -eq 1 ]; check "the survivor check the injections key on appears once in bin/supervise.sh (found $CHECK_ANCHORS)" "$?"
if [ "$CHECK_ANCHORS" -eq 1 ]; then
  mkdir -p "$TMP/injectsurvivor/bin" "$TMP/injectcheck/bin"
  cp "$ROOT"/bin/*.sh "$ROOT"/bin/*.mjs "$TMP/injectsurvivor/bin/"
  cp "$ROOT"/bin/*.sh "$ROOT"/bin/*.mjs "$TMP/injectcheck/bin/"
  # A pid no process on this box holds, so the kill that follows the report
  # matches nothing and touches nothing.
  awk '{ print }
       /^check_snapshot_survivors\(\) \{$/ { print "  log_diag \"STOP: injected survivor report\"; echo 999999; return 0" }' "$SUP" > "$TMP/injectsurvivor/bin/supervise.sh"
  awk '{ print }
       /^check_snapshot_survivors\(\) \{$/ { print "  log_diag \"STOP: injected survivor check failure\"; return 1" }' "$SUP" > "$TMP/injectcheck/bin/supervise.sh"
  bash -n "$TMP/injectsurvivor/bin/supervise.sh" && bash -n "$TMP/injectcheck/bin/supervise.sh"
  check "setup: both injected copies of the supervisor parse" "$?"

  # --- (v) a passive relaunch refuses to run beside a confirmed survivor ---
  SUP_OVERRIDE="$TMP/injectsurvivor/bin/supervise.sh"
  drive v "real_live,shutdown" 6
  SUP_OVERRIDE=""
  grep -q 'injected survivor report' "$LOG"; check "(v) setup: the injected survivor check ran and named a process" "$?"
  grep -q 'RESTART_PASSIVE: root_complete' "$LOG"; check "(v) the decide path took the passive relaunch branch" "$?"
  [ "$RC" -eq 5 ]; check "(v) the supervisor exits 5 rather than relaunching beside a survivor (rc=$RC)" "$?"
  grep -q 'EXIT child-1: a process from this child is alive or unverifiable despite every stop retry' "$LOG"; check "(v) the exit line names what the stop could not clear" "$?"
  ! grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 1 ]; check "(v) no second child launches (stub launches=$LAUNCHES)" "$?"

  # --- (x) an accounted restart refuses to run beside a confirmed survivor ---
  # The same refusal on the decide path's other relaunch branch, sitting ahead
  # of that branch's own limit checks so a survivor is reported as one rather
  # than under a budget or crash-limit code.
  mkdir -p "$TMP/x/wd" "$TMP/x/profile"
  write_turn_aged "$(transcript_path "$TMP/x/wd" "$TMP/x/profile" "stub-sess-1")" 3600
  SUP_OVERRIDE="$TMP/injectsurvivor/bin/supervise.sh"
  DRIVE_ENV=("${LIVENESS_ENV[@]}" USERPROFILE="$TMP/x/profile")
  drive x "hung_quiet,shutdown" 6
  DRIVE_ENV=()
  SUP_OVERRIDE=""
  grep -q 'RESTART: frozen' "$LOG"; check "(x) the decide path took the accounted restart branch" "$?"
  [ "$RC" -eq 5 ]; check "(x) the supervisor exits 5 rather than relaunching beside a survivor (rc=$RC)" "$?"
  ! grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 1 ]; check "(x) no second child launches (stub launches=$LAUNCHES)" "$?"

  # --- (y) a reading that never completed refuses the relaunch too ---
  # Nothing confirmed the tree dead, so the next child would meet whatever the
  # reading could not account for. Exit 5 is the one answer to a tree that is
  # alive or unverifiable, and this case is the unverifiable half of it.
  SUP_OVERRIDE="$TMP/injectcheck/bin/supervise.sh"
  drive y "real_live,shutdown" 6
  SUP_OVERRIDE=""
  grep -q 'injected survivor check failure' "$LOG"; check "(y) setup: the injected survivor check ran and reported failure" "$?"
  grep -q 'RESTART_PASSIVE: root_complete' "$LOG"; check "(y) the decide path took the passive relaunch branch" "$?"
  ! grep -q "NOTE: child-1's tree could not be read" "$LOG"; check "(y) no note proceeds past a tree nothing could account for" "$?"
  [ "$RC" -eq 5 ]; check "(y) the supervisor exits 5 rather than relaunching on a reading that did not complete (rc=$RC)" "$?"
  ! grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 1 ]; check "(y) no second child launches (stub launches=$LAUNCHES)" "$?"
fi

# --- (s) a slow poll body does not forge a stale tree record ---
# A poll body's own work varies by tens of seconds on a loaded box, and the
# record is confirmed at the top of each poll. So a record every poll confirmed
# can still be older than any bound derived from the poll interval by the time
# the sweep reads it, and reading that as a tree no poll has confirmed ends a
# natural exit at exit 5 on a child that left nothing behind. The slow poll is
# injected rather than waited for, since a box fast enough to run this suite
# will not produce one on its own.
POLL_ANCHORS=$(grep -c '^    refresh_child_tree$' "$SUP")
[ "$POLL_ANCHORS" -eq 1 ]; check "(s) the poll-loop refresh the injection keys on appears once in bin/supervise.sh (found $POLL_ANCHORS)" "$?"
if [ "$POLL_ANCHORS" -eq 1 ]; then
  mkdir -p "$TMP/injectslow/bin"
  cp "$ROOT"/bin/*.sh "$ROOT"/bin/*.mjs "$TMP/injectslow/bin/"
  awk '{ print }
       /^    refresh_child_tree$/ { print "    sleep 33" }' "$SUP" > "$TMP/injectslow/bin/supervise.sh"
  bash -n "$TMP/injectslow/bin/supervise.sh"
  check "(s) setup: the injected copy parses" "$?"
  SUP_OVERRIDE="$TMP/injectslow/bin/supervise.sh"
  drive s "slow,shutdown" 6
  SUP_OVERRIDE=""
  grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(s) child-1's exit is handled by the natural-exit path" "$?"
  ! grep -q 'SWEEP\[natural_exit\] record_stale:' "$LOG"
  check "(s) a record every poll confirmed is not read as stale, however long the poll body took" "$?"
  grep -q 'SWEEP\[natural_exit\] clean:' "$LOG"; check "(s) the natural-exit sweep reads that record as clean" "$?"
  [ "$RC" -eq 0 ]; check "(s) the run ends at the second child's shutdown rather than at exit 5 (rc=$RC)" "$?"
  grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(s) a second child launches (stub launches=$LAUNCHES)" "$?"
fi

if [ -s "$UNIT_MARKS" ]; then
  echo "unit-block profile (seconds per stretch, in the order they run):"
  while read -r secs label; do printf '  %5ss  %s\n' "$secs" "$label"; done < "$UNIT_MARKS"
  awk '{t+=$1} END {printf "  total %ss in the unit blocks\n", t}' "$UNIT_MARKS"
fi

if [ -s "$CASE_TIMES" ]; then
  echo "driven-run profile (seconds, slowest first, poll interval ${DRIVE_POLL_MS}ms):"
  sort -rn "$CASE_TIMES" | while read -r secs name; do printf '  %5ss  %s\n' "$secs" "$name"; done
  awk '{t+=$1; n++} END {printf "  total %ss across %s driven runs\n", t, n}' "$CASE_TIMES"
fi

if [ "$failed" -eq 0 ]; then
  echo "supervisor-natural-exit-test.sh: PASS"
  exit 0
fi
echo "supervisor-natural-exit-test.sh: FAIL"
exit 1
