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
# than a guess. On this box, serially the suite takes 39 minutes and passes
# 218 checks with none failing. Two processes take 31 and pass with none
# failing. Four take 35, which is barely better than serial, and fail 11
# checks: case (aa) hits the suite's own 420-second per-run bound and returns
# rc 124, and the crash-limit and sweep cases miss timing they would otherwise
# make. So the box runs out of room somewhere between two and four, and wider
# trades wall clock for exactly the flaky reds this suite already suffers.
# Raise the width only with a measurement beside it.
#
# For iterative work the bigger win is not this script at all. A single case
# runs in well under a minute:
#   bash .kit/supervisor-natural-exit-test.sh --cases s
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SUITE="$HERE/supervisor-natural-exit-test.sh"
WIDTH="${1:-1}"

# The driven cases, slowest first, from the suite's own printed profile. Groups
# are filled round-robin over this order, which is the usual greedy way to
# balance jobs of known length. When the profile's order changes materially,
# update this line from it rather than guessing.
ORDER="o p s x u y v r j ab ac h g k aa a t i c b b2 f e"

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# Round-robin the cases into WIDTH groups.
i=0
for c in $ORDER; do
  g=$(( i % WIDTH ))
  eval "GROUP_$g=\"\${GROUP_$g:-} $c\""
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
