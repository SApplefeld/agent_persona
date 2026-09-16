#!/usr/bin/env bash
# supervisor-tree-walk-test.sh - the process tree walk in bin/supervise.sh
# accepts a child only where it is not older than its parent.
#
# Windows keeps a dead parent's id in every orphan that parent left and hands
# the id out again, so a process whose ParentProcessId names the walk's root
# can be an older, unrelated orphan of an earlier holder of that id. A walk
# that follows the parent id alone puts that orphan, and everything under it,
# on the list every stop path kills.
#
# Every case runs against a synthetic process table, so this suite kills
# nothing, starts no child and reads no live process. The walk is the real
# one: `process_tree_walk_ps` and `snapshot_process_tree` are extracted from
# bin/supervise.sh, and only the two operating-system reads the snapshot
# script makes, `Get-CimInstance` and `Get-Process`, are shadowed with
# PowerShell functions that answer from the table.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SUP="$ROOT/bin/supervise.sh"

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

. "$HERE/supervisor-fn-extract.sh"
# The PowerShell call and the diagnostics are this suite's own, so the
# closure walk stops at them.
SUPERVISOR_CLOSURE_STUBS=" run_bounded_powershell_capture log_diag "
log_diag() { echo "[supervisor helper] $*" >&2; }
STOP_PS_SENTINEL=$(grep '^STOP_PS_SENTINEL=' "$SUP" | head -1 | cut -d= -f2- | tr -d '"')
SUPERVISOR_PS_BOUND_S=30

WALK_FNS="$TMP/walk-fns.sh"
: > "$WALK_FNS"
WALK_FN_NAMES=$(supervisor_fn_closure "$SUP" snapshot_process_tree)
for fn in $WALK_FN_NAMES; do
  supervisor_extract_fn "$SUP" "$fn" "$WALK_FNS" || { echo "  FAIL: could not extract $fn from $SUP"; exit 1; }
done
bash -n "$WALK_FNS" || { echo "  FAIL: the extracted walk functions do not parse"; exit 1; }
. "$WALK_FNS"
case " $(echo $WALK_FN_NAMES) " in
  *" process_tree_walk_ps "*) WIRED=0 ;;
  *) WIRED=1 ;;
esac
# Each verdict is held in a variable before `check` runs, since a command
# substitution inside the message would reset `$?` first.
[ -n "$STOP_PS_SENTINEL" ] && declare -F process_tree_walk_ps > /dev/null && [ "$WIRED" -eq 0 ]
V=$?
check "setup: snapshot_process_tree and the walk it calls are extracted from bin/supervise.sh ($(echo $WALK_FN_NAMES))" "$V"

# The synthetic table. Ids sit above any pid this box hands out, so no row can
# be mistaken for this suite's own process by the snapshot's self-pid refusal.
ROOT_ID=4100000000
CHILD_ID=4100000004
GRANDCHILD_ID=4100000008
ORPHAN_ID=4100000012
ORPHAN_CHILD_ID=4100000016
UNRELATED_ID=4100000020
UNREADABLE_ID=4100000028

# Prints a PowerShell statement assigning `$fixtureRows` for one named table.
#   main           - the root, a younger child and grandchild (the genuine
#                    tree), an orphan created an hour before the root whose
#                    parent id names the root, a child of that orphan created
#                    after the root, and a process under an absent parent
#   unreadable     - main plus a child of the genuine child whose creation
#                    time cannot be read
#   root_absent    - main without the root's own row
#   root_absent_no_children - only the unrelated process, so nothing names
#                    the absent root
table_ps() {
  local rows
  local root_row="Row $ROOT_ID 4 '2026-09-16T10:00:00'"
  local main_rows="Row $CHILD_ID $ROOT_ID '2026-09-16T10:00:05'
Row $GRANDCHILD_ID $CHILD_ID '2026-09-16T10:00:07'
Row $ORPHAN_ID $ROOT_ID '2026-09-16T09:00:00'
Row $ORPHAN_CHILD_ID $ORPHAN_ID '2026-09-16T10:00:30'
Row $UNRELATED_ID 4100000024 '2026-09-16T10:00:01'"
  case "$1" in
    main) rows="$root_row
$main_rows" ;;
    unreadable) rows="$root_row
$main_rows
Row $UNREADABLE_ID $CHILD_ID \$null" ;;
    root_absent) rows="$main_rows" ;;
    root_absent_no_children) rows="Row $UNRELATED_ID 4100000024 '2026-09-16T10:00:01'" ;;
  esac
  cat <<PS
function Row(\$id, \$ppid, \$created) {
  \$when = \$null
  if (\$null -ne \$created) { \$when = [datetime]\$created }
  [pscustomobject]@{ ProcessId = [uint32]\$id; ParentProcessId = [uint32]\$ppid; CreationDate = \$when }
}
\$fixtureRows = @(
$(printf '%s\n' "$rows" | sed 's/^/  (/; s/$/)/')
)
PS
}

# Runs the walk function alone over a named table from the given root and
# prints `ids=<sorted ids> unverified=<True|False>`.
run_walk() {  # <table> <root id>
  powershell -NoProfile -Command "$(process_tree_walk_ps)
$(table_ps "$1")
\$w = Select-ProcessTree \$fixtureRows $2
'ids=' + ((@(\$w.Ids) | Sort-Object) -join ',') + ' unverified=' + \$w.Unverified" 2>&1 | tr -d '\r'
}

# --- The walk alone ---
OUT=$(run_walk main "$ROOT_ID")
[ "$OUT" = "ids=$CHILD_ID,$GRANDCHILD_ID unverified=False" ]
check "walk: the genuine child and grandchild are accepted, and an orphan older than the root whose parent id names the root is left out with everything under it (got: $OUT)" "$?"

# A walk rooted at the orphan shows that the orphan's own younger child is a
# real descendant of the orphan, so its absence above is the orphan's
# exclusion and not a table the walk cannot read.
OUT=$(run_walk main "$ORPHAN_ID")
[ "$OUT" = "ids=$ORPHAN_CHILD_ID unverified=False" ]
check "walk: control: rooted at the orphan, the same table yields the orphan's own child (got: $OUT)" "$?"

OUT=$(run_walk unreadable "$ROOT_ID")
[ "$OUT" = "ids=$CHILD_ID,$GRANDCHILD_ID unverified=True" ]
check "walk: a child whose creation time cannot be read is left out and the walk is marked unverified (got: $OUT)" "$?"

OUT=$(run_walk root_absent "$ROOT_ID")
[ "$OUT" = "ids= unverified=True" ]
check "walk: a root absent from the table accepts nothing that names it and marks the walk unverified (got: $OUT)" "$?"

OUT=$(run_walk root_absent_no_children "$ROOT_ID")
[ "$OUT" = "ids= unverified=False" ]
check "walk: control: an absent root that no row names yields an empty walk that is not marked unverified (got: $OUT)" "$?"

# --- The walk as snapshot_process_tree runs it ---
# The one seam the snapshot calls through runs the snapshot's own script, with
# the table's reads shadowed ahead of it. Every row reads back its creation
# time as its start ticks, except where WIRING_SHIFT moves one: `<id>=<ticks>`
# adds that many ticks to the id's live start time, and `<id>=null` makes it
# unreadable. WIRING_LIVE_ONLY names an id `Get-Process` answers for with no
# row in the table, the shape a pid takes when a new process receives it after
# the table was read.
WIRING_TABLE=main
WIRING_SHIFT=""
WIRING_LIVE_ONLY=""
wiring_shift_ps() {
  local entry id val
  echo '$startShift = @{}'
  for entry in $WIRING_SHIFT; do
    id="${entry%%=*}"; val="${entry#*=}"
    if [ "$val" = "null" ]; then
      echo "\$startShift[[int64]$id] = 'null'"
    else
      echo "\$startShift[[int64]$id] = [int64]$val"
    fi
  done
  echo '$liveOnly = @{}'
  for id in $WIRING_LIVE_ONLY; do
    echo "\$liveOnly[[int64]$id] = [datetime]'2026-09-16T11:00:00'"
  done
}
run_bounded_powershell_capture() {
  local script="$2"
  powershell -NoProfile -Command "$(table_ps "$WIRING_TABLE")
$(wiring_shift_ps)
function Get-CimInstance { \$fixtureRows }
function Get-Process(\$Id, \$ErrorAction) {
  \$key = [int64]\$Id
  if (\$liveOnly.ContainsKey(\$key)) { return [pscustomobject]@{ StartTime = \$liveOnly[\$key] } }
  foreach (\$r in \$fixtureRows) {
    if ([int64]\$r.ProcessId -eq \$key) {
      \$started = \$r.CreationDate
      if (\$startShift.ContainsKey(\$key)) {
        if (\$startShift[\$key] -eq 'null') { \$started = \$null } else { \$started = \$started.AddTicks(\$startShift[\$key]) }
      }
      return [pscustomobject]@{ StartTime = \$started }
    }
  }
}
$script" 2>/dev/null | tr -d '\r'
}
ticks_of() {  # <creation time>
  powershell -NoProfile -Command "([datetime]'$1').Ticks" | tr -d '\r'
}
ROOT_TICKS=$(ticks_of '2026-09-16T10:00:00')
CHILD_TICKS=$(ticks_of '2026-09-16T10:00:05')
GRANDCHILD_TICKS=$(ticks_of '2026-09-16T10:00:07')

SNAP=$(snapshot_process_tree "$ROOT_ID")
RC=$?
EXPECTED=$(printf '%s\n' "$ROOT_ID,$ROOT_TICKS" "$CHILD_ID,$CHILD_TICKS" "$GRANDCHILD_ID,$GRANDCHILD_TICKS" | sort)
[ "$RC" -eq 0 ] && [ "$(printf '%s\n' "$SNAP" | sort)" = "$EXPECTED" ]
V=$?
check "snapshot: the kill list names the root, its child and its grandchild, and neither the older orphan nor its child (rc=$RC, got: $(echo $SNAP))" "$V"

WIRING_TABLE=unreadable
SNAP=$(snapshot_process_tree "$ROOT_ID")
RC=$?
[ "$RC" -eq 1 ] && [ -z "$SNAP" ]
V=$?
check "snapshot: a walk that met a child it could not judge returns unverified with no kill list (rc=$RC, got: $(echo $SNAP))" "$V"

WIRING_TABLE=root_absent_no_children
SNAP=$(snapshot_process_tree "$ROOT_ID")
RC=$?
[ "$RC" -eq 0 ] && [ -z "$SNAP" ]
V=$?
check "snapshot: control: a gone root that nothing names is an empty, completed walk, so the refusal above is the unreadable child (rc=$RC, got: $(echo $SNAP))" "$V"

# --- The start ticks a snapshot records are tied to the table the walk judged ---
# A process table row carries its creation time to the microsecond and a live
# start time carries 100-nanosecond ticks, so a live start time inside the
# row's own microsecond is the process the row describes, recorded at the live
# value the survivor check compares against.
WIRING_TABLE=main
WIRING_SHIFT="$CHILD_ID=7"
SNAP=$(snapshot_process_tree "$ROOT_ID")
RC=$?
EXPECTED=$(printf '%s\n' "$ROOT_ID,$ROOT_TICKS" "$CHILD_ID,$((CHILD_TICKS + 7))" "$GRANDCHILD_ID,$GRANDCHILD_TICKS" | sort)
[ "$RC" -eq 0 ] && [ "$(printf '%s\n' "$SNAP" | sort)" = "$EXPECTED" ]
V=$?
check "ticks: control: a live start time inside its row's microsecond is kept, at the live ticks (rc=$RC, got: $(echo $SNAP))" "$V"

# A live start time a second past the row is a different process holding the
# id since the table was read.
WIRING_SHIFT="$CHILD_ID=10000000"
SNAP=$(snapshot_process_tree "$ROOT_ID")
RC=$?
[ "$RC" -eq 1 ] && [ -z "$SNAP" ]
V=$?
check "ticks: a child whose live start time disagrees with its row makes the snapshot unverified with no kill list (rc=$RC, got: $(echo $SNAP))" "$V"

# One microsecond past the row, on the root, is the smallest disagreement the
# row's precision can show.
WIRING_SHIFT="$ROOT_ID=10"
SNAP=$(snapshot_process_tree "$ROOT_ID")
RC=$?
[ "$RC" -eq 1 ] && [ -z "$SNAP" ]
V=$?
check "ticks: a root whose live start time is one microsecond past its row makes the snapshot unverified with no kill list (rc=$RC, got: $(echo $SNAP))" "$V"

# A live start time that cannot be read is recorded as unreadable, which the
# survivor check reads by existence and the kill never acts on.
WIRING_SHIFT="$CHILD_ID=null"
SNAP=$(snapshot_process_tree "$ROOT_ID")
RC=$?
printf '%s\n' "$SNAP" | grep -qx "$CHILD_ID,UNREADABLE" && [ "$RC" -eq 0 ]
V=$?
check "ticks: a child whose live start time cannot be read is recorded as unreadable rather than with empty ticks (rc=$RC, got: $(echo $SNAP))" "$V"

# The root is the walk's argument rather than a row the walk found, so a root
# absent from the table is a pid the walk never judged. A live process holding
# that id is what makes the absence a partial enumeration rather than an empty
# tree: a process alive both before the table was read and after it must have
# had a row in it. So the walk is unverified, and the diagnostic is read to
# name the rule that refused it, since three other refusals in the same
# function would each produce the same bare non-zero return.
WIRING_SHIFT=""
WIRING_TABLE=root_absent_no_children
WIRING_LIVE_ONLY="$ROOT_ID"
SNAP=$(snapshot_process_tree "$ROOT_ID" 2> "$TMP/root-live-diag")
RC=$?
[ "$RC" -eq 1 ] && [ -z "$SNAP" ]
V=$?
check "ticks: a root with no row in the table while a live process holds its id makes the walk unverified with no kill list (rc=$RC, got: $(echo $SNAP))" "$V"
grep -q 'no process table row for that root while a live process still holds the id' "$TMP/root-live-diag"
V=$?
check "ticks: that refusal is the root's own missing row rather than one of the walk's other refusals (diag: $(tr -d '\n' < "$TMP/root-live-diag"))" "$V"

# The control that makes the refusal above a discrimination rather than a
# blanket refusal of every absent root: the same table with nothing live under
# the root is a root that genuinely exited, which is an honestly empty tree.
WIRING_LIVE_ONLY=""
SNAP=$(snapshot_process_tree "$ROOT_ID" 2> "$TMP/root-gone-diag")
RC=$?
[ "$RC" -eq 0 ] && [ -z "$SNAP" ]
V=$?
check "ticks: control: the same absent root with nothing live holding its id is a completed walk over an empty tree (rc=$RC, got: $(echo $SNAP))" "$V"

if [ "$failed" -ne 0 ]; then
  echo "supervisor-tree-walk-test.sh: FAIL"
  exit 1
fi
echo "supervisor-tree-walk-test.sh: PASS"
exit 0
