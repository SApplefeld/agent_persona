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
SCRIPT="$HERE/../bin/supervise.sh"

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

# The real final ask, as bin/supervise.sh writes it: final_ask_json and the
# SUPERVISOR_ASK_TEXT it reads are extracted from the supervisor and run, so
# every ask this suite drops in the ask-request file is the writer's own
# output rather than a fixture typed here. holder_ask_valid is the holder's own
# reader, extracted the same way, so the writer and the reader meet directly
# below as well as through the running holder's relay.
ASK_FN=$(sed -n '/^final_ask_json() {$/,/^}$/p' "$SCRIPT" | tr -d '\r')
ASK_TEXT_LINE=$(grep -m1 '^SUPERVISOR_ASK_TEXT="' "$SCRIPT" | tr -d '\r')
VALID_FN=$(sed -n '/^holder_ask_valid() {/,/^}$/p' "$HOLDER" | tr -d '\r')
[ -n "$ASK_FN" ] && [ -n "$ASK_TEXT_LINE" ] && [ -n "$VALID_FN" ]
check "final_ask_json, SUPERVISOR_ASK_TEXT and holder_ask_valid are found in their scripts" "$?"
eval "$ASK_TEXT_LINE"
eval "$ASK_FN"
eval "$VALID_FN"
ASK_LINE=$(final_ask_json 9)
printf '%s' "$ASK_LINE" | node -e 'const o = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(o.message.content[0].text.startsWith("[SUPERVISOR-ASK id=9] ") ? 0 : 1)' 2>/dev/null
check "the real final_ask_json output is one JSON line whose text opens [SUPERVISOR-ASK id=9]" "$?"

# One deviation from the real ask, applied by name, so each refusal below is
# for exactly the reason its label states and every fixture is the writer's
# own line with one thing changed. Prints the mutated line with a newline
# unless the mutation is the newline's own absence.
mutate_ask() {  # <mutation>
  node -e '
const o = JSON.parse(process.argv[1]);
const m = process.argv[2];
let out;
switch (m) {
  case "foreign_text": o.message.content[0].text = "[COORDINATOR id=1] not an ask"; break;
  case "two_blocks": o.message.content.push({ type: "text", text: "second block" }); break;
  case "image_block": o.message.content[0].type = "image"; break;
  case "block_extra_key": o.message.content[0].extra = 1; break;
  case "envelope_extra_key": o.extra = 1; break;
  case "envelope_no_role": delete o.role; break;
  case "envelope_role_assistant": o.role = "assistant"; break;
  case "message_extra_key": o.message.extra = 1; break;
  case "message_role_assistant": o.message.role = "assistant"; break;
  case "message_no_role": delete o.message.role; break;
  case "trailing_line": out = JSON.stringify(o) + "\nextra line\n"; break;
  case "partial": out = JSON.stringify(o).slice(0, -12); break;
  case "not_json": out = "not json at all\n"; break;
  default: process.exit(2);
}
if (out === undefined) out = JSON.stringify(o) + "\n";
process.stdout.write(out);
' "$ASK_LINE" "$1"
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

# The writer and the reader, directly: the real final_ask_json line passes the
# real holder_ask_valid, and the envelope it carries is the one the holder's
# own priming and goal writers produce, read off the two turns the running
# holder wrote above. So the validator accepts exactly the envelope every
# writer of this pipe produces, and nothing typed here stands in for one.
holder_ask_valid "$ASK_LINE"; check "writer-reader: the real final_ask_json output passes the real holder_ask_valid" "$?"
printf '%s\n' "$ASK_LINE" > "$D/ask.line"
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
const ask = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const keys = (o) => JSON.stringify({ top: Object.keys(o).sort(), type: o.type, role: o.role, message: Object.keys(o.message).sort(), messageRole: o.message.role, blocks: o.message.content.map((c) => [Object.keys(c).sort(), c.type]) });
process.exit(lines.length >= 2 && keys(JSON.parse(lines[0])) === keys(ask) && keys(JSON.parse(lines[1])) === keys(ask) ? 0 : 1);
' "$D/stdout" "$D/ask.line" 2>/dev/null
check "writer-reader: the priming turn and the goal turn the holder wrote carry the same envelope keys, roles and block shape as the real final ask" "$?"

# The final ask the supervisor drops in the ask-request file is relayed to the
# pipe and the file removed.
printf '%s\n' "$ASK_LINE" > "$D/ask.request"
wait_for 60 grep -q 'SUPERVISOR-ASK id=9' "$D/stdout"
check "the holder relays the real final ask from the ask-request file to the pipe, end to end" "$([ "$(grep -c 'SUPERVISOR-ASK id=9' "$D/stdout")" -ge 1 ] && echo 0 || echo 1)"
wait_for 30 test ! -e "$D/ask.request"
check "the holder removes the ask-request file after relaying it" "$([ ! -e "$D/ask.request" ] && echo 0 || echo 1)"
[ "$(grep -Fc "$ASK_LINE" "$D/stdout")" -eq 1 ]; check "the relayed line is the writer's line byte for byte" "$?"

# A file that is not one whole [SUPERVISOR-ASK id=] user turn is never relayed.
# Each fixture is the real ask with one deviation: a partial write (no
# terminating newline), a line that is not JSON, a text that does not open
# with the marker, a second block, a block of another type, a block with a key
# beyond type and text, bytes after the first line, a key beyond type, role and
# message on the envelope, an envelope with no role or a role that is not
# user, a key beyond role and content on the message, and a message role that
# is not user or is missing. Each is refused by the validator directly and by
# the running holder, which logs and removes it unrelayed. The valid ask above
# stays relayed exactly once.
REFUSALS=0
for mutation in partial not_json foreign_text two_blocks image_block block_extra_key trailing_line envelope_extra_key envelope_no_role envelope_role_assistant message_extra_key message_role_assistant message_no_role; do
  REFUSALS=$((REFUSALS + 1))
  mutate_ask "$mutation" > "$D/mutated"
  # The validator sees the first line as the holder reads it; the two
  # mutations the file-whole check refuses (partial, trailing_line) still
  # carry a valid first line where they have one, so they are pinned on the
  # running holder alone.
  case "$mutation" in
    partial|trailing_line) : ;;
    *) ! holder_ask_valid "$(head -n 1 "$D/mutated")"; check "holder_ask_valid refuses the real ask with the deviation $mutation" "$?" ;;
  esac
  cp "$D/mutated" "$D/ask.request"
  wait_for 30 test ! -e "$D/ask.request"
done
[ ! -e "$D/ask.request" ]; check "the holder removes an ask-request file it will not relay" "$?"
# The priming turn names [SUPERVISOR-ASK id=<id>] in its own text, so the
# count keys on the real ask's id, which every deviation of it carries too.
! grep -q 'not json at all\|not an ask\|second block\|extra line\|"extra"\|"image"\|"assistant"' "$D/stdout" && [ "$(grep -c 'SUPERVISOR-ASK id=9' "$D/stdout")" -eq 1 ]; check "no deviated ask-request file is relayed to the pipe" "$?"
[ "$(grep -c 'removed it unrelayed' "$D/err")" -eq "$REFUSALS" ]; CHECK_RC=$?; check "each refused ask-request file is named in the holder's log (refusals=$(grep -c 'removed it unrelayed' "$D/err") of $REFUSALS)" "$CHECK_RC"
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
