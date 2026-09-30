#!/usr/bin/env bash
# supervisor-natural-exit-parallel.sh - runs .kit/supervisor-natural-exit-test.sh
# as several concurrent processes instead of one long serial run.
#
# Why this exists: the suite's cost is its driven supervisor runs, which are
# flat at roughly seventy seconds each with no slow one left to fix. Serial,
# that is about forty minutes, which is long enough that an edit to
# bin/supervise.sh cannot be checked in one sitting.
#
# Each process makes its own temp root, so the stub directory a case writes
# its current case into is per-process and cannot be raced. That is what makes
# the split safe, and it is why the split is by process rather than by
# backgrounding cases inside one run.
#
# Usage: supervisor-natural-exit-parallel.sh [width]
# Width is the number of case groups, each of which runs alongside one
# unit-block process, so the process count is width plus one.
#
# The default is 1, meaning two processes, and that is a measurement rather
# than a guess. On this box the suite takes about 32 minutes serially and
# about 31 across two processes, with none failing. Two processes print one
# check more than serial: the setup check before the first case runs in both.
# Four processes took 35 minutes and failed 11 checks when this runner still
# scheduled only 22 cases: case (aa) hit the suite's own 420-second per-run
# bound and returned rc 124, and the crash-limit and sweep cases missed timing
# they would otherwise make. So the box ran out of room somewhere between two
# and four, and wider trades wall clock for exactly the flaky reds this suite
# already suffers. Raise the width only with a measurement beside it.
#
# For iterative work the bigger win is not this script at all. A single case
# runs in well under a minute:
#   bash .kit/supervisor-natural-exit-test.sh --cases s
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SUITE="$HERE/supervisor-natural-exit-test.sh"
WIDTH="${1:-1}"
case "$WIDTH" in
  ''|*[!0-9]*|0) echo "ERROR: width must be a whole number above zero, got '$WIDTH'" >&2; exit 2 ;;
esac

# Every driven case the suite defines, read from the suite itself so a case
# added later is scheduled without an edit here. A case is a name the suite
# passes to `drive`, or a name it gates with `if want`. Each case is one slot
# of the schedule, and a gate nested inside another gate's block joins that
# gate's slot, since it runs only in a process that also owns the outer case.
# Any line calling `drive` or `want` with a literal name in a shape this
# reader does not know stops the run, as does a suite that yields no case,
# since either would otherwise print a PASS over part of the suite.
SLOTS=$(set -o pipefail
  tr -d '\r' < "$SUITE" | awk '
    /^[[:space:]]*#/ { next }
    !/^[[:space:]]*(if[[:space:]]+(![[:space:]]+)?)?(drive|want)[[:space:]]+[^"$[:space:]]/ { next }
    /^[[:space:]]*drive[[:space:]]+[A-Za-z0-9_]+([[:space:]]|$)/ {
      n = $0; sub(/^[[:space:]]*drive[[:space:]]+/, "", n); sub(/[[:space:]].*$/, "", n)
      if (!(n in seen)) { seen[n] = 1; slot[++k] = n }
      next
    }
    /^if want[[:space:]]+[A-Za-z0-9_]+;/ {
      n = $0; sub(/^if want[[:space:]]+/, "", n); sub(/;.*$/, "", n)
      if (!(n in seen)) { seen[n] = 1; slot[++k] = n; gate = k }
      next
    }
    gate && /^[[:space:]]+if want[[:space:]]+[A-Za-z0-9_]+;/ {
      n = $0; sub(/^[[:space:]]+if want[[:space:]]+/, "", n); sub(/;.*$/, "", n)
      if (!(n in seen)) { seen[n] = 1; slot[gate] = slot[gate] "," n }
      next
    }
    { print "ERROR: unreadable case line: " $0 > "/dev/stderr"; bad = 1 }
    END { if (bad) exit 3; for (i = 1; i <= k; i++) print slot[i] }')
if [ $? -ne 0 ] || [ -z "$SLOTS" ]; then
  echo "ERROR: the driven cases could not be read from $SUITE" >&2
  exit 2
fi

# A balancing hint: known cases, slowest first, from the suite's own printed
# profile. Groups are filled round-robin over the schedule, which is the usual
# greedy way to balance jobs of known length. A name here the suite no longer
# defines is dropped, and a suite case missing here runs after the listed ones.
# When the profile's order changes materially, update this line from it rather
# than guessing.
ORDER="o p s x u y v r j ab ac h g k aa a t i c b b2 e"

SCHEDULE=""
for c in $ORDER; do
  for s in $SLOTS; do
    case ",$s," in *",$c,"*) SCHEDULE="$SCHEDULE $s" ;; esac
  done
done
for s in $SLOTS; do
  case " $SCHEDULE " in *" $s "*) ;; *) SCHEDULE="$SCHEDULE $s" ;; esac
done

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# Round-robin the slots into WIDTH groups, a slot's cases staying together.
i=0
for s in $SCHEDULE; do
  g=$(( i % WIDTH ))
  eval "GROUP_$g=\"\${GROUP_$g:-} ${s//,/ }\""
  i=$(( i + 1 ))
done

started=""
# The unit blocks are one straight-line region and cannot be split further, so
# they run as their own process. They are the critical path once the cases are
# spread wide enough.
bash "$SUITE" --units > "$OUT/units.out" 2>&1 &
echo $! > "$OUT/units.pid"
started="units"

g=0
while [ "$g" -lt "$WIDTH" ]; do
  eval "cases=\$GROUP_$g"
  # shellcheck disable=SC2086
  bash "$SUITE" --cases $cases > "$OUT/g$g.out" 2>&1 &
  echo $! > "$OUT/g$g.pid"
  started="$started g$g"
  g=$(( g + 1 ))
done

# Each process's own exit status, read by waiting on its pid rather than
# inferred from its output. A process that writes a PASS line and then dies is
# not a pass.
rc_total=0
for name in $started; do
  pid=$(cat "$OUT/$name.pid")
  if wait "$pid"; then rc=0; else rc=$?; fi
  echo "$rc" > "$OUT/$name.exit"
  [ "$rc" -eq 0 ] || rc_total=1
done

ok=0
fail=0
for name in $started; do
  echo "--- $name (exit $(cat "$OUT/$name.exit")) ---"
  grep -E '^  (OK|FAIL):' "$OUT/$name.out" || true
  ok=$(( ok + $(grep -c '^  OK:' "$OUT/$name.out" || true) ))
  fail=$(( fail + $(grep -c '^  FAIL:' "$OUT/$name.out" || true) ))
  sed -n '/driven-run profile/,/^  total/p' "$OUT/$name.out"
done

echo "natexit-parallel: $ok OK, $fail FAIL across $(echo "$started" | wc -w) processes"
if [ "$rc_total" -eq 0 ] && [ "$fail" -eq 0 ]; then
  echo "supervisor-natural-exit-parallel.sh: PASS"
  exit 0
fi
echo "supervisor-natural-exit-parallel.sh: FAIL"
exit 1
