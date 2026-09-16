#!/usr/bin/env bash
# supervisor-natural-exit-test.sh - harness case for bin/supervise.sh's
# natural-exit path: what the supervisor does after a child exits on its own
# rather than through a decide-unit stop. This is the coverage for the
# backfilled root_complete branch of that path. Case (g) covers the other
# route to RESTART_PASSIVE, the decide path acting on a real root_complete
# while the child is still alive.
#
# The real bin/supervise.sh is driven with no real claude: an isolated HOME
# holding an empty installed-mode commons store (so the pre-launch gate
# passes), a stub `claude` first on PATH, and a temp workdir and rundir per
# case. The stub reads a per-case plan, one action per launch, and each plan
# ends the supervisor on its own: a shutdown_requested decision, or the crash
# limit set to 1.
#
# Cases (a), (b) and (e) launch with --prompt. The supervisor then waits for the
# priming turn's result line, and a child that exits without writing one is
# seen dead before the poll loop starts, so the exit is handled by the
# natural-exit path and never by a decide-unit read of the same store.
#
# Static pin, read from the files rather than restated here: the substring
# get_root_complete tests for is inside the backstop's root_complete detail in
# hooks/index.ts and absent from every other root_complete detail there.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SUP="$ROOT/bin/supervise.sh"
HOOKS="$ROOT/hooks/index.ts"
PERSONA_NAME="natexit"

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

TMP="$(mktemp -d)"

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
check "setup: $KILL_FN_COUNT stop-path helpers extracted from bin/supervise.sh ($(echo $KILL_FN_NAMES | tr '\n' ' '))" "$?"

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

# --- Pin: the backfill literal, writer against reader ---
# get_root_complete's node script is the one place bin/supervise.sh tests a
# decision's detail with includes(); more than one match fails the pin below.
READER_SUBSTR=$(sed -n "s/.*newest\.detail\.includes('\([^']*\)').*/\1/p" "$SUP")
# Each root_complete detail literal in the hooks, tagged by whether its
# decision is timestamped backfillNow, which only the backstop uses. The
# search for a detail ends at the next `action:` line, so a root_complete
# whose detail is written in another shape yields no pair at all rather than
# taking the following decision's detail as its own.
DETAILS=$(awk '
  /timestamp:/ { ts = $0 }
  /action: "root_complete",/ { want = 1; next }
  /action:/ { want = 0; next }
  want && /detail: `/ {
    s = $0; sub(/^[^`]*`/, "", s); sub(/`.*$/, "", s)
    print ((ts ~ /timestamp: backfillNow,/) ? "BACKSTOP\t" : "OTHER\t") s
    want = 0
  }' "$HOOKS")
BACKSTOP_DETAIL=$(printf '%s\n' "$DETAILS" | sed -n 's/^BACKSTOP\t//p')
OTHER_DETAILS=$(printf '%s\n' "$DETAILS" | sed -n 's/^OTHER\t//p')

[ -n "$READER_SUBSTR" ] && [ "$(printf '%s\n' "$READER_SUBSTR" | wc -l)" -eq 1 ]
check "pin: exactly one backfill substring test is found in bin/supervise.sh ('$READER_SUBSTR')" "$?"
[ -n "$BACKSTOP_DETAIL" ] && [ "$(printf '%s\n' "$BACKSTOP_DETAIL" | wc -l)" -eq 1 ]
check "pin: exactly one backstop root_complete detail is found in hooks/index.ts ('$BACKSTOP_DETAIL')" "$?"
[ -n "$OTHER_DETAILS" ]; check "pin: a non-backstop root_complete detail is found in hooks/index.ts" "$?"
# The awk above pairs a root_complete decision with the backtick detail line
# inside that same decision. A decision whose detail is written in any other
# shape yields no pair, so this count is what turns that silence into a
# failure: it is the check that says every root_complete in the file was
# actually examined by the pins above, rather than skipped unnoticed.
ROOT_COMPLETE_WRITES=$(grep -c 'action: "root_complete",' "$HOOKS")
DETAIL_COUNT=$(printf '%s\n' "$DETAILS" | grep -c .)
[ "$ROOT_COMPLETE_WRITES" -gt 0 ] && [ "$DETAIL_COUNT" -eq "$ROOT_COMPLETE_WRITES" ]
check "pin: every root_complete decision in hooks/index.ts yielded a detail (${DETAIL_COUNT}/${ROOT_COMPLETE_WRITES})" "$?"
if [ -n "$READER_SUBSTR" ] && [ -n "$BACKSTOP_DETAIL" ]; then
  case "$BACKSTOP_DETAIL" in *"$READER_SUBSTR"*) R=0 ;; *) R=1 ;; esac
else
  R=1
fi
check "pin: the reader's substring is inside the backstop's detail" "$R"
R=1
if [ -n "$READER_SUBSTR" ] && [ -n "$OTHER_DETAILS" ]; then
  R=0
  while IFS= read -r d; do
    case "$d" in *"$READER_SUBSTR"*) R=1 ;; esac
  done <<< "$OTHER_DETAILS"
fi
check "pin: no other root_complete detail carries the reader's substring, so a real completion never reads as backfilled" "$R"

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
[ "$(echo "$CL" | wc -w)" -eq 20 ]; check "unit: a chain twenty processes deep is closed over whole (members=$(echo "$CL" | wc -w))" "$?"
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
# that many seconds before the sweep reads it.
set -u
REFRESH_FN="$1"; SWEEP_FN="$2"; TABLE1="$3"; WALK1="$4"; TABLE2="$5"; WALK2="$6"; ROOT="$7"
RESOLVE="${8:-all}"; BACKDATE="${9:-0}"
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
LAST_STOP_SNAPSHOT=""
. "$REFRESH_FN"
. "$SWEEP_FN"
refresh_child_tree
if [ "$TABLE2" != "-" ]; then TABLE="$TABLE2"; WALK="$WALK2"; refresh_child_tree; fi
if [ "$BACKDATE" != "0" ] && [ -n "$CHILD_TREE_CONFIRMED_AT" ]; then
  CHILD_TREE_CONFIRMED_AT=$(( CHILD_TREE_CONFIRMED_AT - BACKDATE ))
fi
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
# The same record, confirmed long enough ago that a process could have
# appeared under it between the last poll that looked and this sweep.
SW=$(sweep "$UNIT/ps-sibling.txt" ok - ok 100 all 9999)
printf '%s\n' "$SW" | grep -q '^RC=1$' && printf '%s\n' "$SW" | grep -q 'SWEEP\[unit\] record_stale:'
check "unit: a record no poll has confirmed in a long while is not a clean verdict" "$?"
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

# --- The stub child ---
# ${...} placeholders in the extracted literals become a fixed root id.
STUB="$TMP/stub"
mkdir -p "$STUB" "$TMP/home/.claude/plugins/store"
printf '{}' > "$TMP/home/.claude/plugins/store/agentic-plugin_agent-persona-natexit.json"
printf '%s' "${BACKSTOP_DETAIL:-}" | sed 's/\${[^}]*}/root-r1/g' > "$STUB/detail-backfilled"
printf '%s\n' "${OTHER_DETAILS:-}" | head -n 1 | tr -d '\n' | sed 's/\${[^}]*}/root-r1/g' > "$STUB/detail-real"
# The decide unit reads a context_budget_crossed decision whose detail names
# the critical threshold, so the stub's own crossing carries that word.
printf '%s' 'critical: stub crossing' > "$STUB/detail-critical"
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
# Rewrites the profile config \`claude\` itself reads, under this case's own
# USERPROFILE, with the account identity named.
write_account() {  # <account uuid>
  node -e '
const fs = require("fs");
const [file, uuid] = process.argv.slice(1);
fs.writeFileSync(file, JSON.stringify({ numStartups: 7, oauthAccount: { accountUuid: uuid, emailAddress: "stub@example.invalid" } }));
' "\$USERPROFILE/.claude.json" "\$1"
  : > "\$CASE_DIR/account-rewritten"
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
  # A real root_complete with the child still alive: the supervisor's decide
  # path, not the natural-exit path, must act on it. The loop blocks on stdin
  # until the supervisor's EOF stop closes it.
  real_live) IFS= read -r _; record root_complete "\$S/detail-real"; while IFS= read -r _; do :; done; exit 0 ;;
  shutdown) IFS= read -r _; record shutdown_requested ""; exit 0 ;;
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
  # A critical context-budget crossing with the child still alive, so the
  # decide path's restart branch acts on it rather than the natural-exit path.
  critical_live) IFS= read -r _; record context_budget_crossed "\$S/detail-critical"; while IFS= read -r _; do :; done; exit 0 ;;
  # The same crossing, with the child exiting non-zero when its stdin closes,
  # so the decide path's restart counts as a crash.
  critical_live7) IFS= read -r _; record context_budget_crossed "\$S/detail-critical"; while IFS= read -r _; do :; done; exit 7 ;;
  # Alive across a few polls, then a shutdown that ends the run.
  quiet) IFS= read -r _; sleep 15; record shutdown_requested ""; exit 0 ;;
  # The account identity moves to another account while this child runs.
  swap) IFS= read -r _; write_account "22222222-2222-4222-8222-222222222222"; while IFS= read -r _; do :; done; exit 0 ;;
  # The profile config is rewritten with the identity it already carried, the
  # shape an ordinary token refresh leaves behind.
  rewrite_same) IFS= read -r _; write_account "11111111-1111-4111-8111-111111111111"; sleep 15; record shutdown_requested ""; exit 0 ;;
  # Parked on a rate limit: the newest record this child writes is the engine's
  # own 429 retry, and it writes nothing after it. Held until the liveness
  # cadence has reported on the sixth poll, which is the line the case reads.
  rate_limited) IFS= read -r _; emit_init; write_heartbeat_repeatedly 40 3; emit_rate_limit 600000; wait_for_poll_line 6 90; stop_heartbeat; record shutdown_requested ""; exit 0 ;;
  # Control: the same park with the child's own work written after it, which is
  # how a park ends. The newest record is that work, not the retry.
  rate_limited_worked_past) IFS= read -r _; emit_init; write_heartbeat_repeatedly 40 3; emit_rate_limit 600000; emit_work; wait_for_poll_line 6 90; stop_heartbeat; record shutdown_requested ""; exit 0 ;;
  # A park held across several polls with the heartbeat moving on its own
  # timer, which is what a held session keeps doing while the child itself
  # writes nothing.
  rate_limited_quiet) IFS= read -r _; emit_init; write_heartbeat_repeatedly 8 3; emit_rate_limit 600000; sleep 26; record shutdown_requested ""; exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$STUB/claude"

# Usage: drive <case> <plan actions, comma-separated> <restart budget> [extra supervise.sh args...]
# Runs the supervisor to its own exit (bounded at 120s) and sets RC, LOG, OUT.
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
drive() {
  local name="$1" plan="$2" budget="$3"; shift 3
  local dir="$TMP/$name"
  mkdir -p "$dir/wd" "$dir/rd"
  printf '%s\n' "$plan" | tr ',' '\n' > "$dir/plan"
  printf '%s' "$dir" > "$STUB/case"
  OUT=$(env -i PATH="$STUB:$PATH" HOME="$TMP/home" "${DRIVE_ENV[@]}" \
    supervisorPollMs=5000 supervisorCrashLimit="$DRIVE_CRASH_LIMIT" supervisorMaxRestartsPerHour="$budget" \
    timeout 120 bash "${SUP_OVERRIDE:-$SUP}" "$dir/wd" "$PERSONA_NAME" default --rundir "$dir/rd" --no-channel "$@" 2>&1)
  RC=$?
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

# --- (i) the decide path's restart stops at the restart budget ---
# A critical crossing with the child alive takes the decide path's restart
# branch. The budget is 1, so this restart reaches it. The discriminating
# assertion is the launch count: a run that relaunches first and stops at the
# next child's first poll exits 4 as well, one child later.
drive i "critical_live,shutdown" 1
[ "$RC" -eq 4 ]; check "(i) supervisor exits 4 at the restart budget (rc=$RC)" "$?"
grep -q 'RESTART: context_budget_crossed critical' "$LOG"; check "(i) the decide path took the restart branch" "$?"
grep -q 'STOP_BUDGET: 1/1 restarts in the hour' "$LOG"; check "(i) the budget line names the limit it stopped at" "$?"
! grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 1 ]; check "(i) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (j) control: one below the budget, the decide path still relaunches ---
drive j "critical_live,shutdown" 2
[ "$RC" -eq 0 ]; check "(j) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'RESTART: context_budget_crossed critical' "$LOG"; check "(j) the decide path took the restart branch" "$?"
! grep -q 'STOP_BUDGET' "$LOG"; check "(j) no STOP_BUDGET line one below the budget" "$?"
grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(j) a second child launches (stub launches=$LAUNCHES)" "$?"

# --- (k) the decide path's restart stops at the crash limit ---
# The same decide-path restart, with the child exiting 7 when its stdin
# closes, so the stop counts as a crash against a limit of 1.
drive k "critical_live7,shutdown" 6
[ "$RC" -eq 3 ]; check "(k) supervisor exits 3 at the crash limit (rc=$RC)" "$?"
grep -q 'STOP_CRASH_LOOP: 1 crashes' "$LOG"; check "(k) the crash-loop line names the limit it stopped at" "$?"
! grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 1 ]; check "(k) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (l) the account identity changes while the child runs ---
# A running child never re-reads credentials, so only a relaunch picks up a
# swapped account. The identity is read from the profile config claude itself
# reads, under this case's own USERPROFILE.
mkdir -p "$TMP/l/profile"
printf '%s' '{"oauthAccount":{"accountUuid":"11111111-1111-4111-8111-111111111111"}}' > "$TMP/l/profile/.claude.json"
DRIVE_ENV=(USERPROFILE="$TMP/l/profile")
drive l "swap,shutdown" 6
DRIVE_ENV=()
[ -f "$TMP/l/account-rewritten" ]; check "(l) setup: the stub rewrote the profile config" "$?"
[ "$RC" -eq 0 ]; check "(l) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'RESTART_PASSIVE: account_changed' "$LOG"; check "(l) the account change takes RESTART_PASSIVE" "$?"
grep -q 'PASSIVE: the account identity changed since launch' "$LOG"; check "(l) the passive line says why the child is relaunching" "$?"
grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(l) a second child launches (stub launches=$LAUNCHES)" "$?"

# --- (m) control: the profile config is rewritten with the same identity ---
# An ordinary token refresh rewrites that file without moving the account, and
# a supervisor that restarted on the rewrite would restart a healthy child
# every time one happened.
mkdir -p "$TMP/m/profile"
printf '%s' '{"oauthAccount":{"accountUuid":"11111111-1111-4111-8111-111111111111"}}' > "$TMP/m/profile/.claude.json"
DRIVE_ENV=(USERPROFILE="$TMP/m/profile")
drive m "rewrite_same,shutdown" 6
DRIVE_ENV=()
[ -f "$TMP/m/account-rewritten" ]; check "(m) setup: the stub rewrote the profile config" "$?"
! grep -q 'names no account identity' "$LOG"; check "(m) control: no such line where an identity is readable, so that line names the state and not every launch" "$?"
[ "$RC" -eq 0 ]; check "(m) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
! grep -q 'RESTART_PASSIVE:' "$LOG"; check "(m) no RESTART_PASSIVE line for a rewrite that kept the identity" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(m) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (n) control: no profile config under USERPROFILE at all ---
# An absent or unparsable file reads as no identity, which is quiet: the
# supervisor has nothing to compare and relaunches nothing.
mkdir -p "$TMP/n/profile"
DRIVE_ENV=(USERPROFILE="$TMP/n/profile")
drive n "quiet,shutdown" 6
DRIVE_ENV=()
[ ! -f "$TMP/n/profile/.claude.json" ]; check "(n) setup: no profile config exists under this case's USERPROFILE" "$?"
[ "$RC" -eq 0 ]; check "(n) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
! grep -q 'RESTART_PASSIVE:' "$LOG"; check "(n) no RESTART_PASSIVE line with no identity to read" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(n) no second child launches (stub launches=$LAUNCHES)" "$?"
# With no identity readable the swap check has nothing to compare and stays
# quiet for this child's whole life, which otherwise looks exactly like a
# child nobody swapped the account under.
N_QUIET=$(grep -c 'names no account identity' "$LOG")
[ "$N_QUIET" -eq 1 ]; check "(n) the log says once that this child has no account identity to compare a swap against (lines=$N_QUIET)" "$?"

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

# --- (t) a parked child is not read as hung ---
# The heartbeat is stamped on a timer for as long as the session is held, so it
# keeps moving while the child itself writes nothing. That is why a park never
# reaches the hung branch, and this case holds one across several polls with
# the hung check live to show it.
DRIVE_ENV=(staleAfterMs=5000)
drive t "rate_limited_quiet" 6
DRIVE_ENV=()
grep -q '"subtype":"api_retry"' "$TMP/t/rd/child-1/stdout.jsonl"; check "(t) setup: the stub's retry record reached the child's stream" "$?"
T_HB=$(wc -l < "$TMP/t/heartbeat-writes" 2>/dev/null || echo 0)
[ "$T_HB" -ge 3 ]; check "(t) setup: the heartbeat moved $T_HB times while the child ran" "$?"
T_RECORDS=$(grep -cv '"subtype":"api_retry"' "$TMP/t/rd/child-1/stdout.jsonl" 2>/dev/null || echo 0)
[ "$T_RECORDS" -eq 1 ]; check "(t) setup: the only record the child wrote after the retry is the init line before it (other records=$T_RECORDS)" "$?"
[ "$RC" -eq 0 ]; check "(t) supervisor exits 0 on the child's own shutdown_requested (rc=$RC)" "$?"
grep -q 'RATE_LIMITED until [0-9][0-9]*-[0-9][0-9]-[0-9][0-9]T' "$LOG"; check "(t) the log names the park and when the wait ends" "$?"
! grep -q 'RESTART: hung' "$LOG"; check "(t) the parked child is not read as hung while its heartbeat keeps moving" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(t) no second child launches (stub launches=$LAUNCHES)" "$?"

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
  # happened to succeed. The --prompt launch is what puts the exit on the
  # natural-exit path, since a child that dies before writing a result line is
  # seen dead before the poll loop starts.
  SUP_OVERRIDE="$TMP/injectkill/bin/supervise.sh"
  drive u "survivor_shutdown" 6 --prompt "stub goal"
  SUP_OVERRIDE=""
  U_PAIR=$(grep -E '^[0-9]+,[0-9]+$' "$TMP/u/survivor.snapshot" 2>/dev/null | head -1)
  [ -n "$U_PAIR" ]; check "(u) setup: the stub left a process behind and recorded it as pid and start ticks (${U_PAIR:-none})" "$?"
  grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(u) child-1's exit is handled by the natural-exit path" "$?"
  [ "$RC" -eq 0 ]; check "(u) the supervisor reports the requested shutdown as exit 0 (rc=$RC)" "$?"
  grep -q 'STOP_COMPLETE: shutdown_requested' "$LOG"; check "(u) the log names the shutdown the child recorded" "$?"
  grep -qE 'SWEEP\[shutdown\] (clean|survivors|survivors_dead|survivors_alive|no_tree|tree_unread|record_behind_tree|record_no_descendant|record_stale|record_unverified):' "$LOG"
  check "(u) the sweep runs on the shutdown path and names its verdict" "$?"
  ! grep -q 'SWEEP\[natural_exit\]' "$LOG"; check "(u) the natural-exit sweep does not also run once the shutdown is read" "$?"
  [ "$LAUNCHES" -eq 1 ]; check "(u) no second child launches (stub launches=$LAUNCHES)" "$?"

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
  SUP_OVERRIDE="$TMP/injectsurvivor/bin/supervise.sh"
  drive x "critical_live,shutdown" 6
  SUP_OVERRIDE=""
  grep -q 'RESTART: context_budget_crossed critical' "$LOG"; check "(x) the decide path took the accounted restart branch" "$?"
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

# --- (z) an account swap relaunch is counted against the restart budget ---
# The swap signal is a file another process rewrites, so it can differ on every
# poll and drive a relaunch loop no signal from the child itself is behind. The
# budget is what ends one. The discriminating assertion is the launch count: a
# run that relaunches first and stops at the next child's first poll exits 4 as
# well, one child later.
mkdir -p "$TMP/z/profile"
printf '%s' '{"oauthAccount":{"accountUuid":"11111111-1111-4111-8111-111111111111"}}' > "$TMP/z/profile/.claude.json"
DRIVE_ENV=(USERPROFILE="$TMP/z/profile")
drive z "swap,shutdown" 1
DRIVE_ENV=()
[ -f "$TMP/z/account-rewritten" ]; check "(z) setup: the stub rewrote the profile config" "$?"
grep -q 'RESTART_PASSIVE: account_changed' "$LOG"; check "(z) the account change takes RESTART_PASSIVE" "$?"
[ "$RC" -eq 4 ]; check "(z) the supervisor exits 4 at the restart budget (rc=$RC)" "$?"
grep -q 'STOP_BUDGET: 1/1 restarts in the hour' "$LOG"; check "(z) the budget line names the limit it stopped at" "$?"
! grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 1 ]; check "(z) no second child launches (stub launches=$LAUNCHES)" "$?"

if [ "$failed" -eq 0 ]; then
  echo "supervisor-natural-exit-test.sh: PASS"
  exit 0
fi
echo "supervisor-natural-exit-test.sh: FAIL"
exit 1
