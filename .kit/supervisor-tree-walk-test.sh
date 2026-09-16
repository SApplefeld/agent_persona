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
# time as its start ticks.
WIRING_TABLE=main
run_bounded_powershell_capture() {
  local script="$2"
  powershell -NoProfile -Command "$(table_ps "$WIRING_TABLE")
function Get-CimInstance { \$fixtureRows }
function Get-Process(\$Id, \$ErrorAction) {
  foreach (\$r in \$fixtureRows) {
    if ([int64]\$r.ProcessId -eq [int64]\$Id) { return [pscustomobject]@{ StartTime = \$r.CreationDate } }
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

if [ "$failed" -ne 0 ]; then
  echo "supervisor-tree-walk-test.sh: FAIL"
  exit 1
fi
echo "supervisor-tree-walk-test.sh: PASS"
exit 0
