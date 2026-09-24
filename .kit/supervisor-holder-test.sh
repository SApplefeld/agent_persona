#!/usr/bin/env bash
# supervisor-holder-test.sh - the holder's own logic, driven alone.
#
# bin/supervise-holder.sh holds a supervised child's stdin pipe. This suite
# drives it with its stdout piped into a plain file and a plain `sleep` as the
# child pid it watches, so nothing here stands in for a Claude child and the
# gate policy allows it to run. It pins that the holder writes the priming turn,
# waits for the priming turn's result line before writing the goal, relays the
# final ask the supervisor drops in the ask-request file and removes it, exits a
# few seconds after the watched pid disappears, exits when it is signaled, and
# does not let its own `sleep` hold the pipe open past its own death.
#
# Every case is a few seconds; the suite runs well under two minutes.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
HOLDER="$HERE/../bin/supervise-holder.sh"

TMP="$(mktemp -d)"
CHILD_PIDS=""
HOLDER_PIDS=""
cleanup() {
  local p
  for p in $CHILD_PIDS $HOLDER_PIDS; do kill -9 "$p" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

# Waits up to <bound> tenths of a second for a condition command to succeed.
wait_for() {  # <bound-tenths> <cmd...>
  local bound="$1"; shift
  local i=0
  while [ "$i" -lt "$bound" ]; do
    if "$@"; then return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# The first stream-json line of a file is a valid priming turn: type user, text
# opening the [SUPERVISOR-PRIMING] marker.
priming_ok() {  # <stdout file>
  node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
if (lines.length < 1) process.exit(1);
const o = JSON.parse(lines[0]);
process.exit(o.type === "user" && o.message.content[0].text.startsWith("[SUPERVISOR-PRIMING] ") ? 0 : 1);
' "$1" 2>/dev/null
}

# --- Case 1: priming, the goal held until the result line, the ask relay, and
#     exit on the child's death ---
D="$TMP/c1"; mkdir -p "$D"
sleep 30 & C1_CHILD=$!; CHILD_PIDS="$CHILD_PIDS $C1_CHILD"
echo "$C1_CHILD" > "$D/child.pid"
printf 'do the operator task' > "$D/goal"
PERSONA=default NO_CHANNEL=1 COORDINATOR_PERSONA=coord ARCHITECT_PERSONA="" CHILD_INDEX=1 SUPERVISOR_HOLDER_POLL_S=1 \
  bash "$HOLDER" "$D/holder.pid" "$D/out.jsonl" "$D/child.pid" "$D/ask.request" "$D/goal" \
  > "$D/stdout" 2> "$D/err" &
C1_HOLDER=$!; HOLDER_PIDS="$HOLDER_PIDS $C1_HOLDER"

wait_for 50 test -s "$D/holder.pid"
check "the holder writes its own MSYS pid to the pid file" "$([ -s "$D/holder.pid" ] && echo 0 || echo 1)"
[ "$(cat "$D/holder.pid" 2>/dev/null)" = "$C1_HOLDER" ]
check "the recorded holder pid is this holder's own pid" "$?"

wait_for 50 test -s "$D/stdout"
priming_ok "$D/stdout"
check "the holder writes the priming turn to its stdout" "$?"
# The goal is held: with no result line in the watched stdout yet, only the
# priming turn has been written.
[ "$(grep -c . "$D/stdout")" -eq 1 ]
check "the goal is held until the priming turn's result line appears (only the priming turn so far)" "$?"

# The result line arrives, and the goal opens its own turn.
printf '{"type":"result"}\n' > "$D/out.jsonl"
wait_for 60 test "$(grep -c . "$D/stdout")" -ge 2
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
if (lines.length < 2) process.exit(1);
const o = JSON.parse(lines[1]);
process.exit(o.message.content[0].text.includes("do the operator task") ? 0 : 1);
' "$D/stdout" 2>/dev/null
check "the holder writes the goal as its own turn once the result line appears" "$?"

# The final ask the supervisor drops in the ask-request file is relayed to the
# pipe and the file removed.
printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[SUPERVISOR-ASK id=9] status?"}]}}\n' > "$D/ask.request"
wait_for 60 grep -q 'SUPERVISOR-ASK id=9' "$D/stdout"
check "the holder relays the final ask from the ask-request file to the pipe" "$([ "$(grep -c 'SUPERVISOR-ASK id=9' "$D/stdout")" -ge 1 ] && echo 0 || echo 1)"
wait_for 30 test ! -e "$D/ask.request"
check "the holder removes the ask-request file after relaying it" "$([ ! -e "$D/ask.request" ] && echo 0 || echo 1)"

# A file that is not one whole [SUPERVISOR-ASK id=] user turn is never relayed:
# a partial write (no terminating newline), a line that is not JSON, and a JSON
# user turn whose text does not open with the marker are each logged and
# removed unrelayed. The valid ask above stays relayed exactly once.
printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[SUPERVISOR-ASK id=partial] cut' > "$D/ask.request"
wait_for 30 test ! -e "$D/ask.request"
printf 'not json at all\n' > "$D/ask.request"
wait_for 30 test ! -e "$D/ask.request"
printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[COORDINATOR id=1] not an ask"}]}}\n' > "$D/ask.request"
wait_for 30 test ! -e "$D/ask.request"
[ ! -e "$D/ask.request" ]; check "the holder removes an ask-request file it will not relay" "$?"
! grep -q 'id=partial\|not json at all\|not an ask' "$D/stdout"; check "a partial, non-JSON or foreign ask-request line is not relayed to the pipe" "$?"
[ "$(grep -c 'removed it unrelayed' "$D/err")" -eq 3 ]; check "each refused ask-request file is named in the holder's log (refusals=$(grep -c 'removed it unrelayed' "$D/err"))" "$?"
[ "$(grep -c 'SUPERVISOR-ASK id=9' "$D/stdout")" -eq 1 ]; check "the valid ask was relayed exactly once" "$?"

# The child's pid disappears; the holder exits within a few seconds.
kill "$C1_CHILD" 2>/dev/null
wait_for 60 sh -c "! kill -0 $C1_HOLDER 2>/dev/null"
check "the holder exits within a few seconds of the watched child pid disappearing" "$([ ! -e /proc/$C1_HOLDER ] && ! kill -0 "$C1_HOLDER" 2>/dev/null && echo 0 || echo 1)"

# --- Case 2: the holder exits when it is signaled ---
D="$TMP/c2"; mkdir -p "$D"
sleep 30 & C2_CHILD=$!; CHILD_PIDS="$CHILD_PIDS $C2_CHILD"
echo "$C2_CHILD" > "$D/child.pid"
PERSONA=default NO_CHANNEL=1 COORDINATOR_PERSONA=coord ARCHITECT_PERSONA="" CHILD_INDEX=1 SUPERVISOR_HOLDER_POLL_S=1 \
  bash "$HOLDER" "$D/holder.pid" "$D/out.jsonl" "$D/child.pid" "$D/ask.request" "" \
  > "$D/stdout" 2> "$D/err" &
C2_HOLDER=$!; HOLDER_PIDS="$HOLDER_PIDS $C2_HOLDER"
wait_for 50 test -s "$D/stdout"
kill -TERM "$C2_HOLDER" 2>/dev/null
wait_for 40 sh -c "! kill -0 $C2_HOLDER 2>/dev/null"
check "the holder exits when it is signaled" "$(! kill -0 "$C2_HOLDER" 2>/dev/null && echo 0 || echo 1)"
kill "$C2_CHILD" 2>/dev/null

# --- Case 3: the holder's own sleep does not hold the pipe past its death ---
# The holder is piped into a reader that copies to a file and marks done on end
# of input. The poll interval is long, so the holder is killed while inside its
# `sleep`. Its sleep redirects its own stdout to /dev/null, so killing the
# holder closes the pipe at once and the reader sees end of input; a sleep that
# inherited the pipe would hold the reader open for the whole interval.
D="$TMP/c3"; mkdir -p "$D"
sleep 60 & C3_CHILD=$!; CHILD_PIDS="$CHILD_PIDS $C3_CHILD"
echo "$C3_CHILD" > "$D/child.pid"
(
  PERSONA=default NO_CHANNEL=1 COORDINATOR_PERSONA=coord ARCHITECT_PERSONA="" CHILD_INDEX=1 SUPERVISOR_HOLDER_POLL_S=30 \
    bash "$HOLDER" "$D/holder.pid" "$D/out.jsonl" "$D/child.pid" "$D/ask.request" "" 2> "$D/err" \
  | { cat > "$D/piped"; echo done > "$D/reader.done"; }
) &
C3_GROUP=$!; HOLDER_PIDS="$HOLDER_PIDS $C3_GROUP"
# Wait until the holder has written its pid and the reader has the priming turn,
# so the holder is in its long sleep.
wait_for 80 sh -c "[ -s '$D/holder.pid' ] && [ -s '$D/piped' ]"
C3_HOLDER=$(cat "$D/holder.pid" 2>/dev/null)
HOLDER_PIDS="$HOLDER_PIDS ${C3_HOLDER:-}"
[ -n "$C3_HOLDER" ]
check "case 3 setup: the holder is running with the reader holding the pipe" "$?"
if [ -n "$C3_HOLDER" ]; then
  kill -TERM "$C3_HOLDER" 2>/dev/null
  # The reader sees end of input promptly; a held pipe would block it for the
  # 30-second poll interval, well past this bound.
  wait_for 50 test -e "$D/reader.done"
  check "killing the holder closes the pipe at once: the reader sees end of input without waiting out the sleep" "$([ -e "$D/reader.done" ] && echo 0 || echo 1)"
fi
kill "$C3_CHILD" 2>/dev/null

echo
if [ "$failed" = "0" ]; then
  echo "supervisor-holder-test.sh: PASS"
  exit 0
fi
echo "supervisor-holder-test.sh: FAIL"
exit 1
