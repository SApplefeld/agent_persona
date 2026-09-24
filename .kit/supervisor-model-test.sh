#!/usr/bin/env bash
# supervisor-model-test.sh - harness case for v2 Section 0 item 3 Part B:
# the worker's model and effort come from supervisorModel and
# supervisorEffort, and an exported MODEL or EFFORT in the launching
# environment overrides the setting at the launch flag. The proof is the
# argv the stub claude records when a gate-passing run reaches the launch,
# so the pin is on what reaches `claude -p --model/--effort` across the
# real process boundary rather than on a default value or on a shell
# expansion evaluated inline.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bin/supervise.sh"

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

# --- Startup input checks, driven through the real bin/supervise.sh ---
# HOME is an empty directory, so a value that passes every startup check stops
# at the pre-launch gate with exit 2 and "GATE FAIL". A refused value exits 1
# with an ERROR line naming the setting, before the gate runs. A stub claude
# first on PATH records any launch, and none is expected either way.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home" "$TMP/wd" "$TMP/stub"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s"\ntouch "%s"\nexit 1\n' "$TMP/stub/argv" "$TMP/stub/launched" > "$TMP/stub/claude"
chmod +x "$TMP/stub/claude"
drive_sup() {  # env assignments...
  # Each case gets its own rundir. A shared one carries the previous case's
  # settings.json, which sends the next case down the completion branch
  # instead of the emit branch, so results would depend on case order.
  local rd
  rd=$(mktemp -d "$TMP/rd.XXXXXX")
  env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" "$@" bash "$SCRIPT" "$TMP/wd" modelprobe default --rundir "$rd" --no-channel 2>&1
}
refused_by() {  # <label> <expected output text> env assignments...
  local label="$1" token="$2" out rc
  shift 2
  out=$(drive_sup "$@")
  rc=$?
  if [ "$rc" -eq 1 ] && [ ! -e "$TMP/stub/launched" ] && case "$out" in *"$token"*) true ;; *) false ;; esac; then
    check "$label" 0
  else
    check "$label (rc=$rc, out=$out)" 1
  fi
}
accepted() {  # <label> env assignments...
  local label="$1" out rc
  shift
  out=$(drive_sup "$@")
  rc=$?
  if [ "$rc" -eq 2 ] && [ ! -e "$TMP/stub/launched" ] && case "$out" in *"GATE FAIL"*) true ;; *) false ;; esac; then
    check "$label" 0
  else
    check "$label (rc=$rc, out=$out)" 1
  fi
}

# Control for the marker every case below reads as absent: with a commons
# store that leaves the persona free, the same drive passes the gate, reaches
# the launch, and the stub records it. Without this, "the stub never launched"
# would be satisfied by a marker that can never appear at all.
# The same drive carries the resolution proof. supervisorModel and
# supervisorEffort are both set, and MODEL is exported beside them, so the
# recorded argv shows an exported MODEL winning over its setting at the
# --model flag and supervisorEffort reaching the --effort flag on its own.
mkdir -p "$TMP/home-free/.claude/plugins/store" "$TMP/wd-launch"
printf '{}' > "$TMP/home-free/.claude/plugins/store/agentic-plugin_agent-persona-modelprobe.json"
rm -f "$TMP/stub/launched" "$TMP/stub/argv"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home-free" supervisorCrashLimit=1 supervisorPollMs=1000 \
  MODEL=haiku supervisorModel=sonnet supervisorEffort=high \
  timeout 120 bash "$SCRIPT" "$TMP/wd-launch" modelprobe default --rundir "$TMP/rd-launch" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 3 ] && [ -e "$TMP/stub/launched" ]
check "control: a gate-passing run reaches the launch and the stub marker appears (rc=$RC)" "$?"
ARGV=" $(tr '\n' ' ' < "$TMP/stub/argv" 2>/dev/null)"
case "$ARGV" in
  *" --model haiku "*) check "an exported MODEL wins over supervisorModel at the launch flag (--model haiku)" 0 ;;
  *) check "an exported MODEL wins over supervisorModel at the launch flag (argv:$ARGV)" 1 ;;
esac
case "$ARGV" in
  *" --effort high "*) check "supervisorEffort reaches the launch flag (--effort high)" 0 ;;
  *) check "supervisorEffort reaches the launch flag (argv:$ARGV)" 1 ;;
esac
rm -f "$TMP/stub/launched" "$TMP/stub/argv"

# The mirror drive closes the other direction of each flag: EFFORT is
# exported with no MODEL, so the argv shows supervisorModel reaching the
# --model flag on its own and an exported EFFORT winning over its setting.
rm -f "$TMP/stub/launched" "$TMP/stub/argv"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home-free" supervisorCrashLimit=1 supervisorPollMs=1000 \
  EFFORT=low supervisorModel=sonnet supervisorEffort=high \
  timeout 120 bash "$SCRIPT" "$TMP/wd-launch" modelprobe default --rundir "$TMP/rd-launch-mirror" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 3 ] && [ -e "$TMP/stub/launched" ]
check "mirror control: the EFFORT-exported drive reaches the launch (rc=$RC)" "$?"
ARGV=" $(tr '\n' ' ' < "$TMP/stub/argv" 2>/dev/null)"
case "$ARGV" in
  *" --model sonnet "*) check "supervisorModel reaches the launch flag when no MODEL is exported (--model sonnet)" 0 ;;
  *) check "supervisorModel reaches the launch flag when no MODEL is exported (argv:$ARGV)" 1 ;;
esac
case "$ARGV" in
  *" --effort low "*) check "an exported EFFORT wins over supervisorEffort at the launch flag (--effort low)" 0 ;;
  *) check "an exported EFFORT wins over supervisorEffort at the launch flag (argv:$ARGV)" 1 ;;
esac
rm -f "$TMP/stub/launched" "$TMP/stub/argv"

# The model shape: a name of lowercase letters, digits, '.' and '-' starting
# with a letter or digit, plus an optional bracketed suffix. '-opus' and
# '--some-flag' hold only allowed characters, so the leading character is the
# only rule that can refuse them. The bracket pair pins that the suffix is
# admitted as a matched pair and refused unmatched.
refused_by "supervisorModel '-opus' is refused by the leading-character rule" "ERROR: supervisorModel '-opus'" supervisorModel=-opus
refused_by "MODEL '--some-flag' is refused by the leading-character rule" "ERROR: MODEL '--some-flag'" MODEL=--some-flag
accepted "supervisorModel 'opus[1m]' passes the startup checks" "supervisorModel=opus[1m]"
refused_by "supervisorModel 'opus]' is refused (unmatched closing bracket)" "ERROR: supervisorModel 'opus]'" "supervisorModel=opus]"

# The shared check is extracted once and exercised in one process. A clause of
# the rule is a property of that function, so driving the whole supervisor to
# prove each clause against each setting would spawn dozens of processes to
# test one function. The call sites get their own cases further down.
# An empty extraction means the check was renamed or removed.
HELPER_SNIPPET=$(sed -n '/^positive_number() {/,/^}$/p' "$SCRIPT")
# Both generated stubs below run under the same shell options as
# bin/supervise.sh, so an unset expansion or a failed pipe stage in the
# extracted region fails here the way it fails in production.
STUB_OPTIONS='set -u
set -o pipefail'
[ -n "$HELPER_SNIPPET" ]; check "the shared numeric check is found in bin/supervise.sh" "$?"
if [ -n "$HELPER_SNIPPET" ]; then
  # value, minimum, expected verdict.
  HELPER_CASES="0500 1 REFUSE
1000000000 1 REFUSE
0 1 REFUSE
abc 1 REFUSE
1 1 PASS
999999999 1 PASS
1 1000 REFUSE
1000 1000 PASS"
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$HELPER_SNIPPET" \
    'while read -r v m x; do if positive_number "$v" "$m"; then echo "$v $m PASS"; else echo "$v $m REFUSE"; fi; done' \
    > "$TMP/helper.sh"
  HELPER_OUT=$(printf '%s\n' "$HELPER_CASES" | bash "$TMP/helper.sh" 2>&1)
  while read -r v m want; do
    # The concatenations force a string comparison. awk compares two operands
    # that both look numeric as numbers, which makes '0' and '00' the same row.
    got=$(printf '%s\n' "$HELPER_OUT" | awk -v v="$v" -v m="$m" '($1 "") == (v "") && ($2 "") == (m "") { print $3 }')
    [ "$got" = "$want" ]
    check "the shared check ${want}s '$v' at minimum $m (got ${got:-nothing})" "$?"
  done <<< "$HELPER_CASES"
fi

# The call sites, driven through the real bin/supervise.sh. One spawn proves
# that a refused value exits 1 with an ERROR line naming the setting, before
# any launch; the structural pin further down proves every numeric setting is
# named in a positive_number call, and the clauses themselves are covered
# above. The two settings whose consumer divides by 1000 get a spawn for the
# minimum, since a value like 500 passes every other clause and still floors
# to a zero-second wait. The stop's busy cap takes the same minimum and gets
# the same spawn. That the defaults pass every check is covered by the
# gate-passing control above and by the suites that launch a child.
refused_by "supervisorCrashLimit 'abc' is refused at its own call site" "ERROR: supervisorCrashLimit 'abc'" supervisorCrashLimit=abc
refused_by "supervisorStopGraceMs '500' is refused by the 1000 minimum" "ERROR: supervisorStopGraceMs '500'" supervisorStopGraceMs=500
refused_by "supervisorStopBusyCapMs '500' is refused by the 1000 minimum" "ERROR: supervisorStopBusyCapMs '500'" supervisorStopBusyCapMs=500
refused_by "supervisorPollMs '500' is refused by the 1000 minimum" "ERROR: supervisorPollMs '500'" supervisorPollMs=500
# The liveness verdict's three bounds, each read from the supervisor's own
# environment and refused at its own call site, and the controller tick the
# probe's window is computed from, which the supervisor now reads for itself.
refused_by "supervisorSilenceBoundMs 'abc' is refused at its own call site" "ERROR: supervisorSilenceBoundMs 'abc'" supervisorSilenceBoundMs=abc
refused_by "supervisorProbeMs '0' is refused at its own call site" "ERROR: supervisorProbeMs '0'" supervisorProbeMs=0
refused_by "supervisorFinalAskMs '0660000' is refused at its own call site" "ERROR: supervisorFinalAskMs '0660000'" supervisorFinalAskMs=0660000
refused_by "controllerTickMs 'abc' is refused at its own call site" "ERROR: controllerTickMs 'abc'" controllerTickMs=abc
# The shutdown ask's grace, read from the supervisor's own environment and
# refused at its own call site.
refused_by "supervisorAskGraceMs '0' is refused at its own call site" "ERROR: supervisorAskGraceMs '0'" supervisorAskGraceMs=0
# The gate's wait bound, read from the supervisor's own environment and
# refused at its own call site.
refused_by "supervisorGateWaitS '0' is refused at its own call site" "ERROR: supervisorGateWaitS '0'" supervisorGateWaitS=0
# The five defaults, read out of the assignments themselves: fifteen minutes,
# two minutes, eleven minutes, twenty minutes and the gate's two minutes. A
# changed default reds here rather than passing every startup check.
for pair in SUPERVISOR_SILENCE_BOUND_MS:supervisorSilenceBoundMs:900000 SUPERVISOR_PROBE_MS:supervisorProbeMs:120000 SUPERVISOR_FINAL_ASK_MS:supervisorFinalAskMs:660000 SUPERVISOR_ASK_GRACE_MS:supervisorAskGraceMs:1200000 SUPERVISOR_GATE_WAIT_S:supervisorGateWaitS:120; do
  IFS=: read -r var setting want <<< "$pair"
  grep -q "^$var=\"\\\${$setting:-$want}\"" "$SCRIPT"
  check "$setting defaults to $want in its assignment to $var" "$?"
done
# Every reader of the grace is handed it: the poll receives the setting as an
# argument, and a reader never handed it would take its own default silently.
# That the poll passes the grace it receives on to the decide unit is pinned
# by the poll suite's case "the grace handed in is the one read".
grep -q '"\$SUPERVISOR_ASK_GRACE_MS" "\$SHUTDOWN_ASK_ID" "\$SHUTDOWN_ASK_AT" "\$SUPERVISOR_SHUTDOWN_TEXT"' "$SCRIPT"
check "bin/supervise.sh hands supervisorAskGraceMs, the carried ask and the shutdown text to the poll" "$?"

# --- A shutdown request present at launch ends the run before the gate ---
# Driven through the real bin/supervise.sh with the empty HOME the refusal
# cases use, where a run that reached the gate would exit 2 with GATE FAIL. A
# request in the run directory ends the run at exit 0 first, with the file
# removed and no launch. The control is accepted() above: the same drive with
# no request reaches the gate.
RD_REQ=$(mktemp -d "$TMP/rd-req.XXXXXX")
printf 'stop\n' > "$RD_REQ/shutdown.request"
rm -f "$TMP/stub/launched"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" bash "$SCRIPT" "$TMP/wd" modelprobe default --rundir "$RD_REQ" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 0 ]; check "a shutdown request present at launch ends the run at exit 0 (rc=$RC)" "$?"
[ ! -e "$TMP/stub/launched" ] && ! grep -q 'LAUNCH child-' "$RD_REQ/supervisor.log" 2>/dev/null
check "a shutdown request present at launch launches no child and logs no LAUNCH line" "$?"
! grep -q -e 'GATE' "$RD_REQ/supervisor.log" 2>/dev/null
check "a shutdown request present at launch ends the run before the gate" "$?"
grep -q 'SHUTDOWN_REQUEST: .*shutdown.request is present at launch' "$RD_REQ/supervisor.log" 2>/dev/null
check "the log names the request found at launch" "$?"
[ ! -e "$RD_REQ/shutdown.request" ]; check "the request found at launch is removed" "$?"
[ ! -e "$RD_REQ/child-1" ]; check "the run ends before the first child's directory is made, so no empty child-1 is left" "$?"
grep -q 'no child was launched to ask' "$RD_REQ/supervisor.log" 2>/dev/null
check "the log says no child was launched to ask, rather than that none is running" "$?"
# A directory under the request's name is not a request, which the poll
# reads the same way, so the same drive reaches the gate.
RD_DIR=$(mktemp -d "$TMP/rd-reqdir.XXXXXX")
mkdir "$RD_DIR/shutdown.request"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" bash "$SCRIPT" "$TMP/wd" modelprobe default --rundir "$RD_DIR" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 2 ] && case "$OUT" in *"GATE FAIL"*) true ;; *) false ;; esac
check "a directory named shutdown.request is not a request: the run reaches the gate (rc=$RC)" "$?"

# --- Two liveness helpers, extracted and driven in one process each ---
# This suite is the one that runs at every section close and already drives
# bin/supervise.sh's own function bodies, so the two liveness helpers whose
# behavior a driven supervisor run is needed to reach otherwise are pinned
# here. An empty extraction means the function was renamed or removed.
#
# refresh_child_tree's walk result for the liveness verdict. A process table
# that names nothing under a launch pid still answering is a read that failed,
# since a live launch pid is always its own closure's first member, and must
# never read as a child with no live process, which is the gone verdict.
REFRESH_SNIPPET=$(sed -n '/^refresh_child_tree() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$REFRESH_SNIPPET" ]; check "refresh_child_tree is found in bin/supervise.sh" "$?"
if [ -n "$REFRESH_SNIPPET" ]; then
  # The table stub prints a header only, or a header and one row naming the
  # root, which is the empty closure and the one-member closure. Windows pids
  # resolve as 9 followed by the MSYS pid.
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$REFRESH_SNIPPET" '
TABLE_ROW="${TABLE_ROW:-}"
ps() { echo "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND"; [ -n "$TABLE_ROW" ] && echo "$TABLE_ROW"; return 0; }
resolve_windows_pid() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && echo "9$1"; return 0; }
walk_msys_process_tree() { [ "${WALK_RC:-0}" = 3 ] && return 3; echo "$2,111"; return 0; }
log() { [ -n "${LOG_ON:-}" ] && echo "$*"; return 0; }
CHILD_LAUNCH_PID="$1"; CHILD_INDEX=1; CHILD_TREE_WINPIDS=""; CHILD_TREE_FAILED_CONFIRMS=0; CHILD_ROOT_MISMATCH_LOGGED=""
refresh_child_tree
[ -n "${TWICE:-}" ] && refresh_child_tree
echo "WALK=$CHILD_TREE_POLL_WALK"' > "$TMP/refresh.sh"
  sleep 60 &
  LIVE_ROOT=$!
  ( exit 0 ) &
  DEAD_ROOT=$!
  wait "$DEAD_ROOT"
  OUT=$(bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  [ "$OUT" = "WALK=failed" ]; check "an empty process table under a launch pid that still answers reads as a walk that did not complete (got $OUT)" "$?"
  OUT=$(bash "$TMP/refresh.sh" "$DEAD_ROOT" 2>&1)
  [ "$OUT" = "WALK=none" ]; check "control: an empty process table under a launch pid that has exited reads as a walk that found nothing (got $OUT)" "$?"
  OUT=$(TABLE_ROW="$(printf '%9s %7s %7s %10s  pty0     197609 12:00:00 /usr/bin/sleep' "$LIVE_ROOT" 1 "$LIVE_ROOT" "9$LIVE_ROOT")" bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  [ "$OUT" = "WALK=live" ]; check "control: a table naming the live launch pid reads as a walk that found a live process (got $OUT)" "$?"
  # A closure naming a member that has exited, but not the launch pid, while
  # the launch pid still answers: every named member is gone, and the table
  # still could not be read whole, so the walk did not complete.
  ( exit 0 ) &
  DEAD_MEMBER=$!
  wait "$DEAD_MEMBER"
  MEMBER_ROW="$(printf '%9s %7s %7s %10s  pty0     197609 12:00:00 /usr/bin/node' "$DEAD_MEMBER" "$LIVE_ROOT" "$LIVE_ROOT" "9$DEAD_MEMBER")"
  OUT=$(TABLE_ROW="$MEMBER_ROW" bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  [ "$OUT" = "WALK=failed" ]; check "a closure naming only exited members under a launch pid that still answers reads as a walk that did not complete (got $OUT)" "$?"
  MEMBER_ROW="$(printf '%9s %7s %7s %10s  pty0     197609 12:00:00 /usr/bin/node' "$DEAD_MEMBER" "$DEAD_ROOT" "$DEAD_ROOT" "9$DEAD_MEMBER")"
  OUT=$(TABLE_ROW="$MEMBER_ROW" bash "$TMP/refresh.sh" "$DEAD_ROOT" 2>&1)
  [ "$OUT" = "WALK=none" ]; check "control: the same closure under a launch pid that has exited reads as a walk that found nothing (got $OUT)" "$?"
  # Every member exiting inside its own walk, under a launch pid that still
  # answers, is the same unread closure.
  OUT=$(WALK_RC=3 TABLE_ROW="$(printf '%9s %7s %7s %10s  pty0     197609 12:00:00 /usr/bin/sleep' "$LIVE_ROOT" 1 "$LIVE_ROOT" "9$LIVE_ROOT")" bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  [ "$OUT" = "WALK=failed" ]; check "every member exiting inside its walk under a launch pid that still answers reads as a walk that did not complete (got $OUT)" "$?"
  # An adopted child's launch pid is trusted only while it runs as the Windows
  # pid its handle recorded: a root resolving to another pid is a process the
  # handle never named, so the child reads gone (a walk that found nothing),
  # logged once across polls, and the recorded pid itself is a walk that found
  # it.
  LIVE_ROW="$(printf '%9s %7s %7s %10s  pty0     197609 12:00:00 /usr/bin/sleep' "$LIVE_ROOT" 1 "$LIVE_ROOT" "9$LIVE_ROOT")"
  OUT=$(CHILD_ADOPTED=1 CHILD_WINPID=555 TABLE_ROW="$LIVE_ROW" LOG_ON=1 TWICE=1 bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  printf '%s\n' "$OUT" | grep -qx 'WALK=none' && [ "$(printf '%s\n' "$OUT" | grep -c 'not the 555 its handle recorded, so the recorded child is no longer under that pid and reads gone')" -eq 1 ]; CHECK_RC=$?; check "an adopted child whose launch pid runs as a Windows pid other than the one its handle recorded reads gone, logged once across two polls (got $(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(CHILD_ADOPTED=1 CHILD_WINPID="9$LIVE_ROOT" TABLE_ROW="$LIVE_ROW" bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  [ "$OUT" = "WALK=live" ]; check "control: an adopted child whose launch pid runs as the recorded Windows pid reads as a walk that found it (got $OUT)" "$?"
  OUT=$(CHILD_ADOPTED= CHILD_WINPID=555 TABLE_ROW="$LIVE_ROW" bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  [ "$OUT" = "WALK=live" ]; check "control: a launched child's walk is not checked against a recorded Windows pid (got $OUT)" "$?"
  kill "$LIVE_ROOT" 2>/dev/null
  wait "$LIVE_ROOT" 2>/dev/null
fi

# child_present, the one liveness reading the poll loop, the trap and the
# gone sweep key on. A launched child answers `kill -0` on its launch pid. An
# adopted child's launch pid is an MSYS pid this supervisor never held, so its
# liveness never keys on `kill -0`: it is present while its marker is absent
# and the walk did not complete finding nothing. The stand-in adopted pid here
# has exited, so `kill -0` on it answers no; the adopted readings must ignore
# that.
PRESENT_SNIPPET=$(sed -n '/^child_present() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$PRESENT_SNIPPET" ]; check "child_present is found in bin/supervise.sh" "$?"
if [ -n "$PRESENT_SNIPPET" ]; then
  CP_DIR=$(mktemp -d "$TMP/present.XXXXXX")
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$PRESENT_SNIPPET" '
( exit 0 ) & DEAD=$!; wait "$DEAD"
sleep 30 & LIVE=$!
EXIT_MARKER="$1/.exit"; rm -f "$EXIT_MARKER"
CHILD_ADOPTED=1; CHILD_LAUNCH_PID=$DEAD
CHILD_TREE_POLL_WALK=live; child_present; echo "adopted dead-msys-pid walk-live present=$?"
CHILD_TREE_POLL_WALK=failed; child_present; echo "adopted dead-msys-pid walk-failed present=$?"
CHILD_TREE_POLL_WALK=none; child_present; echo "adopted walk-none present=$?"
CHILD_TREE_POLL_WALK=live; echo 0 > "$EXIT_MARKER"; child_present; echo "adopted marker present=$?"
rm -f "$EXIT_MARKER"; CHILD_ADOPTED=""; CHILD_LAUNCH_PID=$DEAD; CHILD_TREE_POLL_WALK=live; child_present; echo "launched dead-pid present=$?"
CHILD_LAUNCH_PID=$LIVE; CHILD_TREE_POLL_WALK=none; child_present; echo "launched live-pid walk-none present=$?"
CHILD_LAUNCH_PID=""; child_present; echo "no pid present=$?"
kill "$LIVE" 2>/dev/null' > "$TMP/present.sh"
  OUT=$(bash "$TMP/present.sh" "$CP_DIR" 2>&1)
  printf '%s\n' "$OUT" | grep -qx 'adopted dead-msys-pid walk-live present=0' && printf '%s\n' "$OUT" | grep -qx 'adopted dead-msys-pid walk-failed present=0'; CHECK_RC=$?; check "adopted liveness: a stand-in MSYS pid that does not answer kill -0 still reads present while the walk reads live or did not complete, so the poll loop does not end on it (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  printf '%s\n' "$OUT" | grep -qx 'adopted walk-none present=1' && printf '%s\n' "$OUT" | grep -qx 'adopted marker present=1'; check "adopted liveness: the child reads gone on the walk finding nothing or on the marker, which is what ends the poll loop" "$?"
  printf '%s\n' "$OUT" | grep -qx 'launched dead-pid present=1' && printf '%s\n' "$OUT" | grep -qx 'launched live-pid walk-none present=0' && printf '%s\n' "$OUT" | grep -qx 'no pid present=1'; check "control: a launched child keys on kill -0 of its own launch pid and not on the walk, and no pid is never present" "$?"
fi

# read_exit_marker, extracted once for every driver below that reads the
# child's exit through it, so the drivers run the real reader rather than a
# retyped copy.
EXITM_SNIPPET=$(sed -n '/^read_exit_marker() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
# child_exit_code is what every accounting site reads the code through; for a
# launched child it is read_exit_marker with no wait, so the drivers carry both.
EXITM_SNIPPET="$EXITM_SNIPPET
$(sed -n '/^child_exit_code() {/,/^}$/p' "$SCRIPT" | tr -d '\r')"
[ -n "$EXITM_SNIPPET" ]; check "read_exit_marker is found in bin/supervise.sh" "$?"
# child_exit_code waits briefly for an adopted child's marker, which its
# wrapper writes in the instant after the child exits, and reads a launched
# child's marker at once. The wait is bounded: a marker that never lands is
# read as absent after fifty polls.
if [ -n "$EXITM_SNIPPET" ]; then
  CEC_DIR=$(mktemp -d "$TMP/cec.XXXXXX")
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$EXITM_SNIPPET" '
log_diag() { :; }
SLEEPS=0
sleep() { SLEEPS=$((SLEEPS + 1)); if [ "$SLEEPS" -ge "${MARK_AT:-999}" ]; then printf "7\n" > "$EXIT_MARKER"; fi; return 0; }
EXIT_MARKER="$1/.exit"; CHILD_ADOPTED="${ADOPTED:-}"
child_exit_code > "$1/code"
echo "code=$(cat "$1/code") sleeps=$SLEEPS"' > "$TMP/cec.sh"
  OUT=$(ADOPTED=1 MARK_AT=3 bash "$TMP/cec.sh" "$CEC_DIR"); rm -f "$CEC_DIR/.exit"
  [ "$OUT" = "code=7 sleeps=3" ]; check "child_exit_code: an adopted child's marker that lands after the exit was seen is waited for and read (got $OUT)" "$?"
  OUT=$(ADOPTED= MARK_AT=3 bash "$TMP/cec.sh" "$CEC_DIR"); rm -f "$CEC_DIR/.exit"
  [ "$OUT" = "code=1 sleeps=0" ]; check "control: a launched child's marker is read at once with no wait (got $OUT)" "$?"
  OUT=$(ADOPTED=1 bash "$TMP/cec.sh" "$CEC_DIR")
  [ "$OUT" = "code=1 sleeps=50" ]; check "child_exit_code: an adopted child's marker that never lands is read as absent after a bounded wait (got $OUT)" "$?"
fi

# read_holder_pid, extracted and driven on real files. Its value reaches
# kill -0 and kill -TERM, where a negative number names a process group, so
# anything but digits must read as no pid.
HPID_SNIPPET=$(sed -n '/^read_holder_pid() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$HPID_SNIPPET" ]; check "read_holder_pid is found in bin/supervise.sh" "$?"
grep -q 'HOLDER_LAUNCH_PID=$(read_holder_pid "$HOLDER_PID_FILE")' "$SCRIPT"; check "the launch reads holder.pid through read_holder_pid" "$?"
if [ -n "$HPID_SNIPPET" ]; then
  HPID_DIR=$(mktemp -d "$TMP/hpid.XXXXXX")
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$HPID_SNIPPET" '
for f in "$1"/*; do printf "%s=[%s]\n" "${f##*/}" "$(read_holder_pid "$f")"; done' > "$TMP/hpid.sh"
  printf -- '-1\n' > "$HPID_DIR/neg"; printf '12x\n' > "$HPID_DIR/mixed"; : > "$HPID_DIR/empty"; printf '4242\n' > "$HPID_DIR/good"
  OUT=$(bash "$TMP/hpid.sh" "$HPID_DIR")
  printf '%s\n' "$OUT" | grep -qx 'neg=\[\]' && printf '%s\n' "$OUT" | grep -qx 'mixed=\[\]' && printf '%s\n' "$OUT" | grep -qx 'empty=\[\]'; CHECK_RC=$?; check "read_holder_pid: a holder.pid holding -1, 12x or nothing reads as no pid, so no process group is signalled (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  printf '%s\n' "$OUT" | grep -qx 'good=\[4242\]'; CHECK_RC=$?; check "control: read_holder_pid reads a holder.pid holding 4242 as 4242 (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
fi

# sweep_gone_child, the sweep_relaunch branch's body. Every function it calls
# is stubbed and records its call, and the wrapper is a real process the
# driver starts, so the `wait` it reaches is a real wait on a real child. A
# sweep that cannot clear the tree takes the retry backstop, a wrapper still
# running after a sweep that killed nothing is stopped before any wait, and a
# dead wrapper is waited on and accounted as a restart.
SWEEP_SNIPPET=$(sed -n '/^sweep_gone_child() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$SWEEP_SNIPPET" ]; check "sweep_gone_child is found in bin/supervise.sh" "$?"
if [ -n "$SWEEP_SNIPPET" ]; then
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$SWEEP_SNIPPET" '
# SWEEP_RC_STUB is what the sweep returns, WRAPPER is live or dead.
log() { echo "$*"; }
sweep_child_tree() { echo "CALL sweep_child_tree $1"; return "${SWEEP_RC_STUB:-0}"; }
# RETRY_RC_STUB and STOP_RC_STUB are what the backstop and the stop return,
# RESTART_COUNT_STUB is the count record_restart_in_hour leaves, and
# CRASH_COUNT_START is the crash count the child is accounted from.
retry_stop_escalation() { echo "CALL retry_stop_escalation $1 $2"; return "${RETRY_RC_STUB:-0}"; }
stop_child() { echo "CALL stop_child $1"; kill "$CHILD_LAUNCH_PID" 2>/dev/null; return "${STOP_RC_STUB:-0}"; }
record_restart_in_hour() { echo "CALL record_restart_in_hour"; RESTART_COUNT="${RESTART_COUNT_STUB:-1}"; }
# The launch shape, not sweep_gone_child, writes the child exit into the marker;
# the driver stands in for it. read_exit_marker is the real function, extracted
# below this stub block; clear_handle and kill_holder are stubbed since the
# driver extracts only sweep_gone_child.
log_diag() { echo "$*" >&2; }
clear_handle() { :; }
kill_holder() { :; }
refresh_child_tree() { echo "CALL refresh"; CHILD_TREE_POLL_WALK="${WALK_STUB:-failed}"; }
'"$EXITM_SNIPPET"'
'"$PRESENT_SNIPPET"'
# An adopted stand-in is a process this driver did not launch (started under a
# subshell that has exited), so `wait` on it returns at once as it does for a
# real adopted child, while `kill -0` on it still answers.
case "${WRAPPER:-dead}" in
  live) sleep 30 & CHILD_LAUNCH_PID=$! ;;
  foreign) CHILD_LAUNCH_PID=$( (sleep 30 >/dev/null 2>&1 & echo $!) ) ;;
  *) ( exit 7 ) & CHILD_LAUNCH_PID=$! ;;
esac
[ "${WRAPPER:-dead}" = dead ] && sleep 1
CHILD_ADOPTED="${ADOPTED_STUB:-}"; CHILD_TREE_POLL_WALK="failed"
CHILD_INDEX=1; DECIDE_REASON="gone: test"; EXIT_MARKER="$1"; STOP_PATH=eof
echo "${MARKER_CODE:-7}" > "$EXIT_MARKER"
LAUNCHED_AT="${LAUNCHED_AT_STUB-$(node -e "console.log(Date.now())")}"; SUPERVISOR_MIN_RUN_MS=120000
CRASH_COUNT="${CRASH_COUNT_START:-0}"; RESTART_COUNT=0; SUPERVISOR_MAX_RESTARTS_PER_HOUR=6; SUPERVISOR_CRASH_LIMIT=3
sweep_gone_child
echo "RETURNED crash=$CRASH_COUNT restarts=$RESTART_COUNT marker=$(cat "$1")"
[ "${WRAPPER:-dead}" = foreign ] && kill "$CHILD_LAUNCH_PID" 2>/dev/null; true' > "$TMP/sweep.sh"
  sweep_run() { timeout 60 bash "$TMP/sweep.sh" "$TMP/sweep.exit" 2>&1; }
  # An adopted child whose MSYS pid still answers `kill -0` is not stopped on
  # that answer: with the marker present and a fresh walk reading none, it is
  # accounted at once, with no stop_child and no blocking wait.
  OUT=$(SWEEP_RC_STUB=0 WRAPPER=foreign ADOPTED_STUB=1 WALK_STUB=none sweep_run)
  printf '%s\n' "$OUT" | grep -qx 'CALL refresh' && ! printf '%s\n' "$OUT" | grep -q '^CALL stop_child' && printf '%s\n' "$OUT" | grep -qx 'EXIT child-1 code=7 (sweep_relaunch)' && printf '%s\n' "$OUT" | grep -q '^RETURNED '
  R=$?
  check "an adopted child is re-walked after the sweep and, with its marker present and the walk reading none, accounted with no stop on its MSYS pid answering kill -0 (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$R"
  # A sweep returning 1 takes the retry backstop before anything else.
  OUT=$(SWEEP_RC_STUB=1 WRAPPER=dead sweep_run)
  printf '%s\n' "$OUT" | grep -qx 'CALL retry_stop_escalation sweep_relaunch 1'
  R=$?
  check "a sweep that cannot clear the tree takes retry_stop_escalation (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$R"
  # A wrapper still running after a sweep that killed nothing is stopped
  # before the wait, so the wait returns rather than blocking on it.
  OUT=$(SWEEP_RC_STUB=2 WRAPPER=live sweep_run)
  STOP_LINE=$(printf '%s\n' "$OUT" | grep -n '^CALL stop_child sweep_relaunch$' | head -n 1 | cut -d: -f1)
  EXIT_LINE=$(printf '%s\n' "$OUT" | grep -n '^EXIT child-1 code=' | head -n 1 | cut -d: -f1)
  [ -n "$STOP_LINE" ] && [ -n "$EXIT_LINE" ] && [ "$STOP_LINE" -lt "$EXIT_LINE" ] && printf '%s\n' "$OUT" | grep -q '^RETURNED '
  R=$?
  check "a wrapper still running after a sweep that killed nothing takes stop_child before any wait (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$R"
  # A dead wrapper is waited on for its real exit code, and accounted as a
  # restart: a non-zero exit inside the minimum run is a crash, and the
  # relaunch counts against the restart budget.
  OUT=$(SWEEP_RC_STUB=0 WRAPPER=dead sweep_run)
  printf '%s\n' "$OUT" | grep -qx 'EXIT child-1 code=7 (sweep_relaunch)' \
    && ! printf '%s\n' "$OUT" | grep -q '^CALL stop_child' \
    && printf '%s\n' "$OUT" | grep -qx 'CALL record_restart_in_hour' \
    && printf '%s\n' "$OUT" | grep -qx 'RETURNED crash=1 restarts=1 marker=7'
  R=$?
  check "a dead wrapper is waited on and accounted as a restart (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$R"
  # An adopted child whose handle carried no launch timestamp has no known
  # run length, so the minimum-run crash rule is skipped for it: the same
  # non-zero exit resets the crash count while the restart still counts.
  OUT=$(SWEEP_RC_STUB=0 WRAPPER=dead LAUNCHED_AT_STUB= sweep_run)
  printf '%s\n' "$OUT" | grep -qx 'EXIT child-1 code=7 (sweep_relaunch)' \
    && printf '%s\n' "$OUT" | grep -qx 'RETURNED crash=0 restarts=1 marker=7'
  R=$?
  check "a child with no known launch time is not accounted as a crash on a non-zero exit, and its relaunch still counts against the budget (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$R"
  # Each stop the function makes ends the run on its own code, before the
  # function returns: a sweep the backstop cannot clear and a live wrapper
  # the stop cannot clear exit 5, the restart budget reached exits 4, and the
  # crash limit reached exits 3.
  sweep_exits() {  # <label> <expected code> <expected line> env assignments...
    local label="$1" want="$2" line="$3" out rc
    shift 3
    out=$(env "$@" timeout 60 bash "$TMP/sweep.sh" "$TMP/sweep.exit" 2>&1)
    rc=$?
    if [ "$rc" -eq "$want" ] && ! printf '%s\n' "$out" | grep -q '^RETURNED ' && printf '%s\n' "$out" | grep -q "$line"; then
      check "$label" 0
    else
      check "$label (rc=$rc, out=$(printf '%s' "$out" | tr '\n' '|'))" 1
    fi
  }
  sweep_exits "a sweep the retry backstop cannot clear exits 5 before any relaunch" 5 \
    'alive or unverifiable after every sweep retry' SWEEP_RC_STUB=1 RETRY_RC_STUB=1 WRAPPER=dead
  sweep_exits "a live wrapper whose stop cannot be cleared exits 5 before any relaunch" 5 \
    'alive or unverifiable despite every stop retry' SWEEP_RC_STUB=2 STOP_RC_STUB=1 RETRY_RC_STUB=1 WRAPPER=live
  sweep_exits "a relaunch that reaches the restart budget exits 4" 4 \
    'STOP_BUDGET: 6/6 restarts in the hour' RESTART_COUNT_STUB=6 WRAPPER=dead
  sweep_exits "a non-zero exit inside the minimum run that reaches the crash limit exits 3" 3 \
    'STOP_CRASH_LOOP: 3 crashes' CRASH_COUNT_START=2 WRAPPER=dead
fi

# note_liveness_poll, which carries a poll's liveness state to the next and
# logs it. HEARTBEAT_ABSENT is named once per child however many polls read the
# file absent, and FINAL_ASK_CLEARED only on the poll that clears the ask.
NOTE_SNIPPET=$(sed -n '/^note_liveness_poll() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$NOTE_SNIPPET" ]; check "note_liveness_poll is found in bin/supervise.sh" "$?"
if [ -n "$NOTE_SNIPPET" ]; then
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$NOTE_SNIPPET" '
log() { echo "$*"; }
CHILD_INDEX=1; CHILD_HEARTBEAT=/rd/heartbeat.json
FINAL_ASK_AT=""; HEARTBEAT_ABSENT_LOGGED=""; LIVENESS_LOGGED=""
POLL_STREAM_SIZE=10; POLL_STREAM_CHANGED_AT=5; POLL_LIVENESS="alive signal"; POLL_HEARTBEAT_NOTE=HEARTBEAT_ABSENT
# Four polls reading the heartbeat absent, the second of which asks and the
# third of which carries the ask unchanged, and the fourth clears it.
POLL_FINAL_ASK_AT=""; note_liveness_poll
POLL_FINAL_ASK_AT=100; note_liveness_poll
POLL_FINAL_ASK_AT=100; note_liveness_poll
POLL_FINAL_ASK_AT=""; note_liveness_poll
echo "STATE=$STREAM_SEEN_SIZE:$STREAM_CHANGED_AT:[$FINAL_ASK_AT]"' > "$TMP/note.sh"
  OUT=$(bash "$TMP/note.sh" 2>&1)
  N=$(printf '%s\n' "$OUT" | grep -c 'HEARTBEAT_ABSENT child-1')
  [ "$N" -eq 1 ]; check "HEARTBEAT_ABSENT is logged once across four polls that read the file absent (lines=$N)" "$?"
  N=$(printf '%s\n' "$OUT" | grep -c 'FINAL_ASK_CLEARED child-1')
  [ "$N" -eq 1 ]; check "FINAL_ASK_CLEARED is logged once, on the poll that clears the ask, not on the poll that carries it (lines=$N)" "$?"
  N=$(printf '%s\n' "$OUT" | grep -c 'LIVENESS child-1: alive signal')
  [ "$N" -eq 1 ]; check "an unchanged liveness reading is named once (lines=$N)" "$?"
  printf '%s\n' "$OUT" | grep -qx 'STATE=10:5:\[\]'; check "the stream state and the cleared ask are carried to the next poll" "$?"
fi

# note_shutdown_ask, which carries the shutdown ask the poll wrote to the next
# poll and names it once, on the poll that wrote it.
ASKNOTE_SNIPPET=$(sed -n '/^note_shutdown_ask() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$ASKNOTE_SNIPPET" ]; check "note_shutdown_ask is found in bin/supervise.sh" "$?"
if [ -n "$ASKNOTE_SNIPPET" ]; then
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$ASKNOTE_SNIPPET" '
log() { echo "$*"; }
CHILD_INDEX=1; SHUTDOWN_REQUEST_FILE=/rd/shutdown.request; SUPERVISOR_ASK_GRACE_MS=1200000
SHUTDOWN_ASK_ID=""; SHUTDOWN_ASK_AT=""
# A poll with no ask, the poll that writes one, and two that carry it.
POLL_SHUTDOWN_ASK_ID=""; POLL_SHUTDOWN_ASK_AT=""; note_shutdown_ask
POLL_SHUTDOWN_ASK_ID=17-3; POLL_SHUTDOWN_ASK_AT=500; note_shutdown_ask
POLL_SHUTDOWN_ASK_ID=17-3; POLL_SHUTDOWN_ASK_AT=500; note_shutdown_ask
POLL_SHUTDOWN_ASK_ID=17-3; POLL_SHUTDOWN_ASK_AT=500; note_shutdown_ask
echo "STATE=$SHUTDOWN_ASK_ID:$SHUTDOWN_ASK_AT"' > "$TMP/asknote.sh"
  OUT=$(bash "$TMP/asknote.sh" 2>&1)
  N=$(printf '%s\n' "$OUT" | grep -c '^ASK\[shutdown\] id=17-3 child-1: .* has 1200000ms to bank its state')
  [ "$N" -eq 1 ]; check "ASK[shutdown] is logged once, naming the id and the grace, across the poll that writes the ask and two that carry it (lines=$N)" "$?"
  N=$(printf '%s\n' "$OUT" | grep -c 'ASK\[shutdown\]')
  [ "$N" -eq 1 ]; check "no other ASK[shutdown] line is logged, so the poll with no ask named nothing (ASK lines=$N)" "$?"
  printf '%s\n' "$OUT" | grep -qx 'STATE=17-3:500'; check "the ask's id and time are carried to the next poll" "$?"
fi

# ask_timeout_stop, the ask_timeout branch's body, with clear_shutdown_request
# beside it. Every function it calls is stubbed and records its call, and the
# wrapper is a real process that has exited, so the `wait` it reaches is a
# real wait. Past the grace the child is stopped through the stop phases
# under the ask_timeout label and the run exits 0 with the request removed;
# a stop that leaves a process alive or unverifiable exits 5 and keeps the
# request for the next start.
TIMEOUT_SNIPPET=$(sed -n '/^ask_timeout_stop() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
CLEAR_SNIPPET=$(sed -n '/^clear_shutdown_request() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$TIMEOUT_SNIPPET" ] && [ -n "$CLEAR_SNIPPET" ]; check "ask_timeout_stop and clear_shutdown_request are found in bin/supervise.sh" "$?"
if [ -n "$TIMEOUT_SNIPPET" ] && [ -n "$CLEAR_SNIPPET" ]; then
  printf '%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$CLEAR_SNIPPET" "$TIMEOUT_SNIPPET" '
log() { echo "$*"; }
stop_child() { echo "CALL stop_child $1"; STOP_PATH=eof; return 0; }
retry_stop_escalation() { echo "CALL retry_stop_escalation $1 $2"; return "${RETRY_RC_STUB:-0}"; }
# The launch shape writes the exit marker; the driver stands in for it, and
# read_exit_marker is the real function, extracted below.
log_diag() { echo "$*" >&2; }
'"$EXITM_SNIPPET"'
( exit 0 ) &
CHILD_LAUNCH_PID=$!
sleep 1
CHILD_INDEX=1; SHUTDOWN_ASK_ID=17-3; DECIDE_REASON="the shutdown ask at 5 went unanswered past 2000ms"
EXIT_MARKER="$1/.exit"; SHUTDOWN_REQUEST_FILE="$1/shutdown.request"
echo 0 > "$EXIT_MARKER"
ask_timeout_stop
echo "RETURNED"' > "$TMP/timeout.sh"
  timeout_run() {  # <state dir> env assignments...
    local dir="$1"; shift
    rm -rf "$dir"; mkdir -p "$dir"; printf 'stop\n' > "$dir/shutdown.request"
    env "$@" timeout 60 bash "$TMP/timeout.sh" "$dir" 2>&1
  }
  OUT=$(timeout_run "$TMP/timeout-ok"); RC=$?
  ASK_LINE=$(printf '%s\n' "$OUT" | grep -n '^ASK TIMEOUT id=17-3 child-1: the shutdown ask at 5 went unanswered' | head -n 1 | cut -d: -f1)
  STOP_LINE=$(printf '%s\n' "$OUT" | grep -n '^CALL stop_child ask_timeout$' | head -n 1 | cut -d: -f1)
  [ "$RC" -eq 0 ] && [ -n "$ASK_LINE" ] && [ -n "$STOP_LINE" ] && [ "$ASK_LINE" -lt "$STOP_LINE" ] \
    && printf '%s\n' "$OUT" | grep -qx 'EXIT child-1 code=0 (eof)' && ! printf '%s\n' "$OUT" | grep -q '^RETURNED'
  R=$?
  check "past the grace: ASK TIMEOUT, then stop_child under the ask_timeout label, then exit 0 (rc=$RC, out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$R"
  [ ! -e "$TMP/timeout-ok/shutdown.request" ]; check "the exit 0 after an ask timeout removes the shutdown request" "$?"
  OUT=$(timeout_run "$TMP/timeout-alive" RETRY_RC_STUB=1); RC=$?
  [ "$RC" -eq 5 ] && printf '%s\n' "$OUT" | grep -q 'alive or unverifiable despite every stop retry'
  check "an ask timeout whose stop leaves a process alive or unverifiable exits 5 (rc=$RC)" "$?"
  [ -e "$TMP/timeout-alive/shutdown.request" ]; check "the exit 5 keeps the shutdown request for the next start" "$?"
fi

# supervisorPsBoundS is the one setting on this rule that falls back to 30
# rather than refusing, so its resolution is read by running the script's own
# lines, from the assignment up to the next setting, in a separate process.
PS_BOUND_SNIPPET=$(sed -n '/^SUPERVISOR_PS_BOUND_S=/,/^SUPERVISOR_STOP_GRACE_MS=/p' "$SCRIPT" | sed '$d')
if [ -z "$PS_BOUND_SNIPPET" ] || [ -z "$HELPER_SNIPPET" ]; then
  check "the SUPERVISOR_PS_BOUND_S block and the shared numeric check are found in bin/supervise.sh" 1
else
  printf '%s\n%s\n%s\necho "PS_BOUND=$SUPERVISOR_PS_BOUND_S"\n' "$STUB_OPTIONS" "$HELPER_SNIPPET" "$PS_BOUND_SNIPPET" > "$TMP/psbound.sh"
  for pair in abc:30 45:45; do
    OUT=$(env -i PATH="$PATH" supervisorPsBoundS="${pair%%:*}" bash "$TMP/psbound.sh" 2>&1)
    case "$OUT" in
      *"PS_BOUND=${pair##*:}") check "supervisorPsBoundS '${pair%%:*}' resolves to ${pair##*:}" 0 ;;
      *) check "supervisorPsBoundS '${pair%%:*}' resolves to ${pair##*:} (out=$OUT)" 1 ;;
    esac
  done
fi

# Which settings must be checked is derived from the script rather than listed
# here. Every assignment of the shape NAME="${setting:-...}" is a setting,
# whatever its default, so one written with an empty or non-numeric default
# is enumerated too. Two shapes sit outside the pattern's reach: a default
# that itself contains a closing brace, and an assignment with no double
# quotes around the expansion. A setting is numeric unless the exclusion list below
# names it, which is what makes a new setting get classified on purpose
# rather than escape the pin by its punctuation. Each numeric setting has to
# be named in a positive_number call in this script, or be a plugin value
# emit_settings_json checks on its own rule in bin/agentic-common.sh.
#
# That second excuse reaches only a name the supervisor never reads for
# itself. emit_settings_json is skipped whenever the rundir already holds a
# settings file, so a name the supervisor expands anywhere but its own
# assignment carries a positive_number call whatever the emitter checks. The
# last leg proves the narrowing has a subject, so it cannot go quiet by
# having nothing to bite on.
#
# A setting added with a hand-rolled case, or with no check at all, is in
# neither list and reds this pin; a count of calls would not notice it.
COMMON="$HERE/../bin/agentic-common.sh"
NON_NUMERIC_NAMES="SUPERVISOR_MODEL SUPERVISOR_EFFORT"
SETTING_NAMES=$(sed -n 's/^\([A-Z][A-Z0-9_]*\)="\${[A-Za-z][A-Za-z0-9]*:-[^}]*}".*/\1/p' "$SCRIPT")
GUARDED_NAMES=$(grep -o 'positive_number "\$[A-Z][A-Z0-9_]*"' "$SCRIPT" | sed 's/^.*"\$\([A-Z0-9_]*\)"$/\1/')
EMITTED_NAMES=$(sed -n '/^  for var in /,/; do$/p' "$COMMON" | tr -c 'A-Za-z0-9_' '\n' | grep '^[A-Z][A-Z0-9_]*$')
SETTING_COUNT=$(printf '%s\n' "$SETTING_NAMES" | grep -c .)
# True when bin/supervise.sh reads the name anywhere but its own assignment,
# a comment, the positive_number call for that name, or the ERROR line beside
# that call. The match is on the bare identifier, so an arithmetic read like
# $((NAME / 1000)) counts as well as $NAME and ${NAME}. Leaving the guard and
# its ERROR line out keeps the narrowing from being satisfied by the very
# guard it exists to require.
reads_itself() {
  grep -Ev "^[[:space:]]*#|^$1=|positive_number \"\\\$$1\"|ERROR: [A-Za-z]+ '\\\$$1'" "$SCRIPT" \
    | grep -Eq "(^|[^A-Za-z0-9_])$1([^A-Za-z0-9_]|\$)"
}
UNCHECKED=""
SELF_READ_EMITTED=""
NUMERIC_COUNT=0
for n in $SETTING_NAMES; do
  case " $NON_NUMERIC_NAMES " in *" $n "*) continue ;; esac
  NUMERIC_COUNT=$((NUMERIC_COUNT + 1))
  emitted=false
  printf '%s\n' "$EMITTED_NAMES" | grep -qx "$n" && emitted=true
  self_read=false
  reads_itself "$n" && self_read=true
  $emitted && $self_read && SELF_READ_EMITTED="$SELF_READ_EMITTED $n"
  printf '%s\n' "$GUARDED_NAMES" | grep -qx "$n" && continue
  $emitted && ! $self_read && continue
  UNCHECKED="$UNCHECKED $n"
done
[ -n "$GUARDED_NAMES" ] && [ -n "$EMITTED_NAMES" ] && [ "$SETTING_COUNT" -ge 8 ]
check "the settings, the checked names and the emitted names all read out of the sources ($SETTING_COUNT settings found, $NUMERIC_COUNT numeric)" "$?"
[ -z "$UNCHECKED" ]
check "every numeric setting is named in a positive_number call, or is emitted and never read by the supervisor itself (unchecked:${UNCHECKED:- none})" "$?"
[ -n "$SELF_READ_EMITTED" ]
check "the narrowing has a subject: an emitted setting the supervisor also reads for itself (${SELF_READ_EMITTED# })" "$?"

# --- The pre-launch gate's adoption routing and the trap's detach routing ---
# handle_gate_route and handle_trap_route are pure, so each is extracted and
# driven in one process, every branch both ways. An empty extraction means the
# function was renamed or removed.
GATE_ROUTE_SNIPPET=$(sed -n '/^handle_gate_route() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$GATE_ROUTE_SNIPPET" ]; check "handle_gate_route is found in bin/supervise.sh" "$?"
if [ -n "$GATE_ROUTE_SNIPPET" ]; then
  printf '%s\n%s\nhandle_gate_route "$@"\n' "$STUB_OPTIONS" "$GATE_ROUTE_SNIPPET" > "$TMP/gate.sh"
  route() { bash "$TMP/gate.sh" "$@"; }
  [ "$(route 0 0 alive)" = WAIT ]; check "gate route: an unreadable handle falls to today's wait" "$?"
  [ "$(route 1 1 alive)" = WAIT ]; check "gate route: a handle whose writer is still running waits, so a double launch times out" "$?"
  [ "$(route 1 0 alive)" = ADOPT ]; check "gate route: a dead-writer handle read alive is adopted" "$?"
  [ "$(route 1 0 frozen)" = ADOPT ]; check "gate route: a dead-writer handle read frozen is adopted" "$?"
  [ "$(route 1 0 gone)" = SWEEP_LAUNCH ]; check "gate route: a dead-writer handle read gone is swept then launched" "$?"
  [ "$(route 1 0 reading_failed)" = WAIT ]; check "gate route: a dead-writer handle whose verdict is neither alive, frozen nor gone waits" "$?"
fi
TRAP_ROUTE_SNIPPET=$(sed -n '/^handle_trap_route() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$TRAP_ROUTE_SNIPPET" ]; check "handle_trap_route is found in bin/supervise.sh" "$?"
if [ -n "$TRAP_ROUTE_SNIPPET" ]; then
  printf '%s\n%s\nhandle_trap_route "$@"\n' "$STUB_OPTIONS" "$TRAP_ROUTE_SNIPPET" > "$TMP/trap.sh"
  trap_route() { bash "$TMP/trap.sh" "$@"; }
  [ "$(trap_route 1 alive)" = DETACH ]; check "trap route: a signal to a live handled child read alive detaches" "$?"
  [ "$(trap_route 1 frozen)" = DETACH ]; check "trap route: a signal to a live handled child read frozen detaches" "$?"
  [ "$(trap_route 0 alive)" = STOP ]; check "trap route: a signal to a child with no readable handle keeps today's stop" "$?"
  [ "$(trap_route 1 gone)" = STOP ]; check "trap route: a signal to a handled child read gone keeps today's stop" "$?"
fi

# --- The handle is removed once its child is accounted for ---
# clear_handle removes the current child's handle, so a handle on disk always
# names a child nobody has yet accounted for.
CLEARH_SNIPPET=$(sed -n '/^clear_handle() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$CLEARH_SNIPPET" ]; check "clear_handle is found in bin/supervise.sh" "$?"
if [ -n "$CLEARH_SNIPPET" ]; then
  CH_DIR=$(mktemp -d "$TMP/clearh.XXXXXX"); echo '{}' > "$CH_DIR/handle.json"
  printf '%s\nHANDLE_FILE="%s/handle.json"\n%s\nclear_handle\n' "$STUB_OPTIONS" "$CH_DIR" "$CLEARH_SNIPPET" > "$TMP/clearh.sh"
  bash "$TMP/clearh.sh"
  [ ! -e "$CH_DIR/handle.json" ]; check "clear_handle removes the current child's handle" "$?"
  printf '%s\nHANDLE_FILE=""\n%s\nclear_handle; echo rc=$?\n' "$STUB_OPTIONS" "$CLEARH_SNIPPET" > "$TMP/clearh2.sh"
  [ "$(bash "$TMP/clearh2.sh")" = "rc=0" ]; check "clear_handle with no handle set is a no-op" "$?"
fi

# --- The exit marker's absent and malformed cases ---
# The wrapper skips the marker when it is force-killed, and a marker that is
# absent or not an exit code must never read as a clean exit 0.
if [ -n "$EXITM_SNIPPET" ]; then
  printf '%s\nlog_diag() { echo "DIAG $*" >&2; }\n%s\nread_exit_marker "$1"\n' "$STUB_OPTIONS" "$EXITM_SNIPPET" > "$TMP/exitm.sh"
  EM_DIR=$(mktemp -d "$TMP/exitm.XXXXXX")
  OUT=$(bash "$TMP/exitm.sh" "$EM_DIR/missing" 2>"$EM_DIR/err")
  [ "$OUT" = "1" ] && grep -q 'marker absent' "$EM_DIR/err"; check "read_exit_marker: an absent marker reads as a non-zero exit and names the absence (got $OUT)" "$?"
  printf '7\n' > "$EM_DIR/seven"; OUT=$(bash "$TMP/exitm.sh" "$EM_DIR/seven" 2>/dev/null)
  [ "$OUT" = "7" ]; check "read_exit_marker: a marker holding 7 reads 7 (got $OUT)" "$?"
  printf 'x\n' > "$EM_DIR/bad"; OUT=$(bash "$TMP/exitm.sh" "$EM_DIR/bad" 2>"$EM_DIR/err2")
  [ "$OUT" = "1" ] && grep -q 'not an exit code' "$EM_DIR/err2"; check "read_exit_marker: a marker that is not an exit code reads as a non-zero exit and says so (got $OUT)" "$?"
fi

# --- The launch pipeline's child stage ---
# child_wrapper runs the child in the background with its stdin kept, forwards
# TERM to it, waits again after the trap, and writes the child's real exit
# code. A plain sleep stands in for the child (a sleep is not a Claude
# stand-in, so this runs). TERM to the wrapper ends the inner sleep and the
# marker records 143.
WRAP_SNIPPET=$(sed -n '/^child_wrapper() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$WRAP_SNIPPET" ]; check "child_wrapper is found in bin/supervise.sh" "$?"
if [ -n "$WRAP_SNIPPET" ]; then
  WR_DIR=$(mktemp -d "$TMP/wrap.XXXXXX")
  # The inner process records its own pid and then becomes a plain sleep, so
  # the check below is on that pid rather than on a process-table text match,
  # which any command line carrying the words would satisfy.
  printf '%s\n%s\nchild_wrapper "$1" bash -c '"'"'echo $$ > "$1"; exec sleep 61'"'"' _ "$2"\n' "$STUB_OPTIONS" "$WRAP_SNIPPET" > "$TMP/wrap.sh"
  bash "$TMP/wrap.sh" "$WR_DIR/marker" "$WR_DIR/inner.pid" &
  WR_PID=$!
  wr_i=0
  until [ -s "$WR_DIR/inner.pid" ] || [ "$wr_i" -ge 50 ]; do sleep 0.1; wr_i=$((wr_i + 1)); done
  WR_INNER=$(cat "$WR_DIR/inner.pid" 2>/dev/null)
  kill -TERM "$WR_PID" 2>/dev/null
  wait "$WR_PID" 2>/dev/null; WR_RC=$?
  [ "$(cat "$WR_DIR/marker" 2>/dev/null)" = "143" ]; CHECK_RC=$?; check "child_wrapper: TERM to the wrapper ends the inner process and the marker records 143 (marker=$(cat "$WR_DIR/marker" 2>/dev/null), rc=$WR_RC)" "$CHECK_RC"
  # The marker the real wrapper wrote is read back through the real reader,
  # so the writer and the reader are joined on a file neither test typed.
  if [ -f "$TMP/exitm.sh" ]; then
    OUT=$(bash "$TMP/exitm.sh" "$WR_DIR/marker" 2>/dev/null)
    [ "$OUT" = "143" ]; check "child_wrapper and read_exit_marker: the marker the wrapper wrote reads back as 143 through read_exit_marker (got $OUT)" "$?"
  fi
  wr_i=0
  while [ -n "$WR_INNER" ] && kill -0 "$WR_INNER" 2>/dev/null && [ "$wr_i" -lt 20 ]; do sleep 0.5; wr_i=$((wr_i + 1)); done
  [ -n "$WR_INNER" ] && ! kill -0 "$WR_INNER" 2>/dev/null; check "child_wrapper: the inner process (pid ${WR_INNER:-unknown}) is gone within a few seconds of the wrapper's TERM" "$?"
  kill -9 "$WR_INNER" 2>/dev/null; true
  # stdin reaches the inner process through the pipe.
  printf '%s\n%s\nchild_wrapper "$1" bash -c '"'"'IFS= read -r l; printf "%%s" "$l" > "$1"'"'"' _ "$2"\n' "$STUB_OPTIONS" "$WRAP_SNIPPET" > "$TMP/wrap2.sh"
  printf 'from-the-pipe\n' | bash "$TMP/wrap2.sh" "$WR_DIR/marker2" "$WR_DIR/seen"
  [ "$(cat "$WR_DIR/seen" 2>/dev/null)" = "from-the-pipe" ] && [ "$(cat "$WR_DIR/marker2" 2>/dev/null)" = "0" ]; check "child_wrapper: the inner process reads the pipeline's stdin and a clean exit records 0" "$?"
  # A TERM never reaches the launching shell's own last background job. The
  # driver starts a sentinel job before the wrapper, so `$!` names it in the
  # window before the fork, and lands the TERM in one of two places. Before
  # the fork: a `trap` function shadows the builtin and, the instant the
  # wrapper installs its TERM handler, runs that handler string exactly as
  # the shell runs it at the command boundary after a TERM lands, so it runs
  # with no inner pid yet; the wrapper must hold the signal and forward it
  # once the inner process exists. (A real self-signal is delivered
  # asynchronously on this host and can land after the fork, which is the
  # other case.) After the fork: a real TERM lands while the inner process
  # runs. Before the fork the wrapper sends exactly one TERM, and never to
  # the sentinel. Whether the inner process then ends is the stop's next
  # rung's concern, not the wrapper's. After the fork the inner process ends
  # with 143. In both the sentinel is untouched.
  printf '%s\n' "$STUB_OPTIONS" > "$TMP/wrap3.sh"
  cat >> "$TMP/wrap3.sh" <<'EOF'
trap() {
  builtin trap "$@"
  if [ "${2:-}" = TERM ] && [ "${TERM_BEFORE_FORK:-}" = 1 ]; then eval "$1"; fi
}
# The sentinel records a TERM it receives, since `kill -0` answers for an
# unreaped job and would read a signalled sentinel as alive. It arms its
# trap through the builtin, so the shadow above never runs its handler,
# says when it is armed, so no TERM can reach it before then, and holds no
# copy of the driver's stdout, so its sleep cannot hold a capture pipe open.
( sleep 61 & s=$!; builtin trap 'kill "$s" 2>/dev/null; echo term > "$2.term"; exit 143' TERM; echo armed > "$2.armed"; wait "$s" ) >/dev/null 2>&1 & SENTINEL=$!
echo "$SENTINEL" > "$2"
until [ -e "$2.armed" ]; do sleep 0.05; done
# Every TERM the wrapper sends is recorded by its target. The shadow is
# defined after the sentinel is forked, so the sentinel's own handler keeps
# the builtin.
KLOG="$2.kills"
kill() {
  if [ "${WRAP_LOG_ON:-}" = 1 ] && [ "${1:-}" = -TERM ]; then echo "$2" >> "$KLOG"; fi
  builtin kill "$@"
}
EOF
  printf '%s\n' "$WRAP_SNIPPET" >> "$TMP/wrap3.sh"
  printf '%s\n' 'WRAP_LOG_ON=1 child_wrapper "$1" sleep "${INNER_S:-4}"; echo "rc=$?"; sleep 0.5; if [ -e "$2.term" ]; then echo "sentinel=signalled"; else echo "sentinel=alive"; fi; kill -TERM "$SENTINEL" 2>/dev/null; wait "$SENTINEL" 2>/dev/null; true' >> "$TMP/wrap3.sh"
  OUT=$(TERM_BEFORE_FORK=1 timeout 30 bash "$TMP/wrap3.sh" "$WR_DIR/marker3" "$WR_DIR/sentinel3" 2>&1)
  kill -9 "$(cat "$WR_DIR/sentinel3" 2>/dev/null)" 2>/dev/null
  WR_SENT=$(wc -l < "$WR_DIR/sentinel3.kills" 2>/dev/null | tr -d ' ')
  WR_TARGET=$(head -1 "$WR_DIR/sentinel3.kills" 2>/dev/null)
  [ "${WR_SENT:-0}" = 1 ] && [ -n "$WR_TARGET" ] && [ "$WR_TARGET" != "$(cat "$WR_DIR/sentinel3" 2>/dev/null)" ] && printf '%s\n' "$OUT" | grep -qx 'sentinel=alive'; CHECK_RC=$?; check "child_wrapper: a TERM landing before the fork is held and forwarded exactly once, to the inner process, and the launching shell's last background job is not signalled (sends=${WR_SENT:-0}, out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Run directly rather than under timeout, so the pid signalled is the
  # wrapper's own shell; the inner sleep bounds the run by itself.
  bash "$TMP/wrap3.sh" "$WR_DIR/marker4" "$WR_DIR/sentinel4" > "$WR_DIR/out4" 2>&1 &
  WR4_PID=$!
  wr_i=0
  until [ -s "$WR_DIR/sentinel4" ] || [ "$wr_i" -ge 50 ]; do sleep 0.1; wr_i=$((wr_i + 1)); done
  sleep 1
  kill -TERM "$WR4_PID" 2>/dev/null
  wait "$WR4_PID" 2>/dev/null
  kill -9 "$(cat "$WR_DIR/sentinel4" 2>/dev/null)" 2>/dev/null
  [ "$(cat "$WR_DIR/marker4" 2>/dev/null)" = "143" ] && grep -qx 'sentinel=alive' "$WR_DIR/out4"; CHECK_RC=$?; check "child_wrapper: a TERM landing after the fork reaches the inner process (marker 143) and the launching shell's last background job is not signalled (marker=$(cat "$WR_DIR/marker4" 2>/dev/null), out=$(tr '\n' '|' < "$WR_DIR/out4"))" "$CHECK_RC"
fi

# --- The writer-running and child-identity checks ---
# Each is extracted and driven with check_snapshot_survivors stubbed from the
# environment. A writer pair that is absent or not numeric reads as running,
# so the gate waits; a child pair that is absent or not numeric reads
# unverified, so the gate waits rather than adopting. The pair reaches the
# survivor check as the 18-digit string it was read as, and the writer check
# takes the pair as arguments from the gate's one read rather than reading the
# handle a second time.
WRITER_SNIPPET=$(sed -n '/^handle_writer_running() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
IDENT_SNIPPET=$(sed -n '/^handle_child_identity() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$WRITER_SNIPPET" ] && [ -n "$IDENT_SNIPPET" ]; check "handle_writer_running and handle_child_identity are found in bin/supervise.sh" "$?"
if [ -n "$WRITER_SNIPPET" ] && [ -n "$IDENT_SNIPPET" ]; then
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$WRITER_SNIPPET" '
read_handle_fields() { echo "NEVER read_handle_fields" >&2; }
handle_field() { echo "NEVER handle_field" >&2; }
check_snapshot_survivors() { printf "CHECK(%s)\n" "$1" >&2; printf "%s" "${SURV_OUT:-}"; return "${SURV_RC:-0}"; }
handle_writer_running "${WIN:-}" "${TICK:-}"' > "$TMP/writer.sh"
  wr() { env "$@" bash "$TMP/writer.sh" 2>"$TMP/writer.err"; }
  [ "$(wr WIN= TICK=)" = 1 ]; check "writer-running: an absent supervisor pair reads as running" "$?"
  [ "$(wr WIN=x TICK=639012345678900011)" = 1 ]; check "writer-running: a non-numeric supervisor pid reads as running" "$?"
  [ "$(wr WIN=34870 TICK=639012345678900011 SURV_OUT= SURV_RC=0)" = 0 ] && grep -q 'CHECK(34870,639012345678900011)' "$TMP/writer.err" && ! grep -q NEVER "$TMP/writer.err"; check "writer-running: a numeric pair with no survivor reads as dead, checked as the exact 18-digit string handed in, with no read of the handle of its own" "$?"
  [ "$(wr WIN=34870 TICK=639012345678900011 SURV_OUT=34870 SURV_RC=0)" = 1 ]; check "writer-running: a numeric pair still live reads as running" "$?"
  [ "$(wr WIN=34870 TICK=639012345678900011 SURV_OUT= SURV_RC=1)" = 1 ]; check "writer-running: an unverifiable check reads as running" "$?"
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$IDENT_SNIPPET" '
check_snapshot_survivors() { printf "CHECK(%s)\n" "$1" >&2; printf "%s" "${SURV_OUT:-}"; return "${SURV_RC:-0}"; }
handle_child_identity "${WIN:-}" "${TICK:-}"' > "$TMP/ident.sh"
  id() { env "$@" bash "$TMP/ident.sh" 2>"$TMP/ident.err"; }
  [ "$(id WIN= TICK=)" = unverified ]; check "child identity: an absent pair reads unverified" "$?"
  [ "$(id WIN=35124 TICK=639012345678901237 SURV_RC=1)" = unverified ]; check "child identity: a check that did not complete reads unverified" "$?"
  [ "$(id WIN=35124 TICK=639012345678901237 SURV_OUT=)" = gone ]; check "child identity: a pair no live process holds reads gone" "$?"
  [ "$(id WIN=35124 TICK=639012345678901237 SURV_OUT=35124)" = live ] && grep -q 'CHECK(35124,639012345678901237)' "$TMP/ident.err"; check "child identity: a pair a live process holds reads live, checked as the exact 18-digit string" "$?"
fi

# --- The gate's handle read, driven with the path shape production produces ---
# newest_handle is the real function from bin/agentic-common.sh, run over a
# real directory through the native node on this box, which prints a joined
# path with backslashes: the function prints the child directory's name alone
# and the gate builds the path in bash. gate_read_handle is then driven on that
# name with the real read_handle_fields over a real handle.json, and the real
# staging, dropping and pair helpers; identity, the writer check, the claim,
# the walk and the poll are stubbed. Every fixture carries the shape
# production writes: pids and ticks as digit strings, ticks 18 digits wide.
# Each case prints the route, what was written, and every per-child global,
# so each row of the function's state table is read off one run.
# Both node scripts close a loop with a brace at column 0, so each is
# extracted through the shared brace-aware extractor rather than a sed range
# that ends at the first bare brace.
. "$HERE/supervisor-fn-extract.sh"
: > "$TMP/nh.fn"; supervisor_extract_fn "$COMMON" newest_handle "$TMP/nh.fn" || true
NH_SNIPPET=$(tr -d '\r' < "$TMP/nh.fn")
: > "$TMP/rhf.fn"; supervisor_extract_fn "$COMMON" read_handle_fields "$TMP/rhf.fn" || true
RHF_SNIPPET=$(tr -d '\r' < "$TMP/rhf.fn")
GATEREAD_SNIPPET=$(sed -n '/^gate_read_handle() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
STAGE_SNIPPET=$(sed -n '/^gate_stage_child() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
DROP_SNIPPET=$(sed -n '/^gate_drop_child_globals() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
PAIRS_SNIPPET=$(sed -n '/^gate_sweep_pairs() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
CLEANUP_SNIPPET=$(sed -n '/^cleanup() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$GATEREAD_SNIPPET" ] && [ -n "$NH_SNIPPET" ] && [ -n "$RHF_SNIPPET" ] && [ -n "$STAGE_SNIPPET" ] && [ -n "$DROP_SNIPPET" ] && [ -n "$PAIRS_SNIPPET" ]; check "gate_read_handle, its staging, dropping and pair helpers, newest_handle and read_handle_fields are found in their scripts" "$?"
# The 18-digit ticks and five-digit Windows pids every handle fixture below
# carries, at or above the width production records.
T_CHILD=639012345678901237; T_HOLDER=639012345678901180; T_SUP=639012345678900011; T_SELF=639012345678999999
W_CHILD=35124; W_HOLDER=35088; W_SUP=34870; W_SELF=34999
if [ -n "$GATEREAD_SNIPPET" ] && [ -n "$NH_SNIPPET" ] && [ -n "$RHF_SNIPPET" ] && [ -n "$GATE_ROUTE_SNIPPET" ] && [ -n "$STAGE_SNIPPET" ] && [ -n "$DROP_SNIPPET" ] && [ -n "$PAIRS_SNIPPET" ] && [ -n "$PRESENT_SNIPPET" ] && [ -n "$TRAP_ROUTE_SNIPPET" ] && [ -n "$CLEANUP_SNIPPET" ]; then
  GR_DIR=$(mktemp -d "$TMP/gateread.XXXXXX"); mkdir -p "$GR_DIR/child-1" "$GR_DIR/child-2" "$GR_DIR/child-3" "$GR_DIR/child-4" "$GR_DIR/child-5" "$GR_DIR/notachild"
  printf '{"sessionId":"sess-old","holderPid":"40011","holderWinPid":"30011","holderTicks":"639012345678900100","childPid":"40012","childWinPid":"30012","childTicks":"639012345678900101","supervisorWinPid":"30010","supervisorTicks":"639012345678900001","launchedAt":1000,"childIndex":1}' > "$GR_DIR/child-1/handle.json"
  H2_JSON='{"sessionId":"sess-1","holderPid":"41180","holderWinPid":"'$W_HOLDER'","holderTicks":"'$T_HOLDER'","childPid":"41236","childWinPid":"'$W_CHILD'","childTicks":"'$T_CHILD'","supervisorWinPid":"'$W_SUP'","supervisorTicks":"'$T_SUP'","launchedAt":2000,"childIndex":2}'
  printf '%s' "$H2_JSON" > "$GR_DIR/child-2/handle.json"
  # child-3: a dead writer whose child pid is not a pid at all but whose child
  # Windows pair is recorded; child-4: a handle that cannot be read; child-5:
  # a dead writer with no child identity at all. None is newer than child-2.
  H3_JSON='{"sessionId":"sess-3","childPid":"x77","childWinPid":"'$W_CHILD'","childTicks":"'$T_CHILD'","holderWinPid":"'$W_HOLDER'","holderTicks":"'$T_HOLDER'","supervisorWinPid":"'$W_SUP'","supervisorTicks":"'$T_SUP'","launchedAt":1500}'
  printf '%s' "$H3_JSON" > "$GR_DIR/child-3/handle.json"
  : > "$GR_DIR/child-4/handle.json"
  H5_JSON='{"sessionId":"sess-5","childPid":null,"childWinPid":null,"childTicks":null,"supervisorWinPid":"'$W_SUP'","supervisorTicks":"'$T_SUP'","launchedAt":1200}'
  printf '%s' "$H5_JSON" > "$GR_DIR/child-5/handle.json"
  : > "$GR_DIR/notachild/handle.json"
  NEXTIDX_SNIPPET=$(sed -n '/^next_child_index() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  KEEPIDX_SNIPPET=$(sed -n '/^gate_keep_swept_index() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  [ -n "$NEXTIDX_SNIPPET" ] && [ -n "$KEEPIDX_SNIPPET" ]; check "next_child_index and gate_keep_swept_index are found in bin/supervise.sh" "$?"
  printf '%s\n%s\nnewest_handle "$1"\n' "$STUB_OPTIONS" "$NH_SNIPPET" > "$TMP/nh.sh"
  NH_NAME=$(bash "$TMP/nh.sh" "$GR_DIR" 2>"$TMP/nh.err")
  [ "$NH_NAME" = "child-2" ]; check "newest_handle over a real directory, through the native node, prints the newest child directory's name and nothing of the backslash path (got '$NH_NAME')" "$?"
  grep -qx 'OLDER child-1' "$TMP/nh.err" && grep -qx 'OLDER child-3' "$TMP/nh.err"; check "newest_handle names each older handle it passed over" "$?"
  printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$GATE_ROUTE_SNIPPET" "$RHF_SNIPPET" "$PRESENT_SNIPPET" "$TRAP_ROUTE_SNIPPET" "$CLEANUP_SNIPPET" "$STAGE_SNIPPET" "$DROP_SNIPPET" "$PAIRS_SNIPPET" "$NEXTIDX_SNIPPET" "$KEEPIDX_SNIPPET" "$GATEREAD_SNIPPET" '
log() { echo "LOG $*"; }
log_diag() { echo "DIAG $*"; }
WRITES=0
write_handle() { WRITES=$((WRITES + 1)); echo "CALL write_handle sess=$1"; }
CLAIMS=0
claim_is_ours() { CLAIMS=$((CLAIMS + 1)); if [ "$CLAIMS" -eq 2 ] && [ "${CLAIM2:-1}" = 0 ]; then return 1; fi; [ "${CLAIM:-1}" = 1 ]; }
handle_child_identity() { echo "IDENT($1,$2)" >&2; echo "${IDENT:-live}"; }
handle_writer_running() { echo "CALL writer_check($1,$2)" >&2; echo "${WRITER:-0}"; }
ensure_self_ticks() { :; }
refresh_child_tree() { echo "CALL refresh"; CHILD_TREE_POLL_WALK="${WALK:-live}"; CHILD_TREE_SNAPSHOT="${TREE:-}"; }
run_child_poll() { echo "CALL poll"; DECIDE_ACTION="continue"; DECIDE_ERR="${POLL_ERR:-0}"; POLL_LIVENESS="${LIVE:-alive signal}"; }
stop_child() { echo "CALL stop_child $1"; return 0; }
retry_stop_escalation() { echo "CALL retry $1 $2"; return 0; }
kill_process_snapshot() { echo "CALL snapshot $1"; return 0; }
kill() { echo "CALL kill $*"; return 1; }
SELF_WINPID="${SW-'$W_SELF'}"; SELF_TICKS="${ST-'$T_SELF'}"; SELF_TICKS_DONE="${SD-1}"
RUNDIR="$1"; CHILD_LAUNCH_PID=""; CHILD_INDEX=0; CHILD_ADOPTED=""; HANDLE_FILE=""; EXIT_MARKER=""
HOLDER_LAUNCH_PID=""; HOLDER_WINPID=""; HOLDER_TICKS=""; CHILD_WINPID=""; CHILD_TICKS=""; CHILD_SESSION_ID=""; LAUNCHED_AT=""
# A stale reading and snapshot from an earlier child, which every pass must clear.
POLL_LIVENESS="gone stale"; LAST_STOP_SNAPSHOT="1,2"; CHILD_TREE_POLL_WALK="failed"
gate_read_handle "$2"
echo "ROUTE=$GATE_ROUTE VERDICT=$VERDICT INDEX=$CHILD_INDEX PID=[$CHILD_LAUNCH_PID] HANDLE=${HANDLE_FILE:-} LAUNCHED=[${LAUNCHED_AT:-}] CLAIMS=$CLAIMS WRITES=$WRITES"
echo "GLOBALS ADOPTED=[$CHILD_ADOPTED] HP=[$HOLDER_LAUNCH_PID] HW=[$HOLDER_WINPID] HT=[$HOLDER_TICKS] CW=[$CHILD_WINPID] CT=[$CHILD_TICKS] SESS=[$CHILD_SESSION_ID] MARKER=[${EXIT_MARKER:-}] LIVENESS=[$POLL_LIVENESS] SNAP=[$LAST_STOP_SNAPSHOT]"
echo "SWEEP PAIRS=[$(printf "%s" "$GATE_SWEEP_PAIRS" | tr "\n" "|")] HANDLE=[$GATE_SWEEP_HANDLE]"
# The launch that follows a sweep: the main loop clears the swept handle and
# next_child_index allocates from CHILD_INDEX as the gate left it.
if [ "${THEN_LAUNCH:-}" = 1 ] && [ "$GATE_ROUTE" = SWEEP_LAUNCH ]; then rm -f "$GATE_SWEEP_HANDLE"; echo "LAUNCHES child-$(next_child_index "$RUNDIR" "$CHILD_INDEX")"; fi
if [ "${RUN_CLEANUP:-}" = 1 ]; then trap cleanup EXIT; exit 0; fi' > "$TMP/gateread.sh"
  gr() { env "$@" bash "$TMP/gateread.sh" "$GR_DIR" "$NH_NAME" 2>&1; }
  NO_GLOBALS='GLOBALS ADOPTED=\[\] HP=\[\] HW=\[\] HT=\[\] CW=\[\] CT=\[\] SESS=\[\] MARKER=\[\] LIVENESS=\[\] SNAP=\[\]'
  NO_SWEEP='SWEEP PAIRS=\[\] HANDLE=\[\]'
  # Row: alive or frozen. The claim is written, every per-child global is
  # committed, and the route is ADOPT.
  OUT=$(gr IDENT=live LIVE="alive signal")
  printf '%s\n' "$OUT" | grep -q "ROUTE=ADOPT VERDICT=alive INDEX=2 PID=\[41236\] HANDLE=.*/child-2/handle.json LAUNCHED=\[2000\] CLAIMS=2 WRITES=1" \
    && printf '%s\n' "$OUT" | grep -q "GLOBALS ADOPTED=\[1\] HP=\[41180\] HW=\[$W_HOLDER\] HT=\[$T_HOLDER\] CW=\[$W_CHILD\] CT=\[$T_CHILD\] SESS=\[sess-1\] MARKER=\[.*/child-2/.exit\] LIVENESS=\[alive signal\] SNAP=\[\]" \
    && printf '%s\n' "$OUT" | grep -q "$NO_SWEEP"; CHECK_RC=$?
  check "row alive: on the name newest_handle printed, a live identity and an alive verdict write the claim once, commit every per-child global with the 18-digit pair byte-equal, and adopt (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  printf '%s\n' "$OUT" | grep -q "IDENT($W_CHILD,$T_CHILD)"; check "gate read: the identity check runs on the exact 18-digit child pair the handle records" "$?"
  I_LINE=$(printf '%s\n' "$OUT" | grep -n 'IDENT(' | head -1 | cut -d: -f1)
  W_LINE=$(printf '%s\n' "$OUT" | grep -n '^CALL write_handle' | head -1 | cut -d: -f1)
  P_LINE=$(printf '%s\n' "$OUT" | grep -n '^CALL poll' | head -1 | cut -d: -f1)
  C_LINE=$(printf '%s\n' "$OUT" | grep -n '^CALL writer_check' | head -1 | cut -d: -f1)
  [ -n "$C_LINE" ] && [ -n "$I_LINE" ] && [ -n "$W_LINE" ] && [ -n "$P_LINE" ] && [ "$C_LINE" -lt "$I_LINE" ] && [ "$I_LINE" -lt "$W_LINE" ] && [ "$W_LINE" -lt "$P_LINE" ]; check "gate read: the writer check, the identity check, the claim and the verdict poll run in that order (lines ${C_LINE:-none} < ${I_LINE:-none} < ${W_LINE:-none} < ${P_LINE:-none})" "$?"
  printf '%s\n' "$OUT" | grep -q "^CALL writer_check($W_SUP,$T_SUP)$"; check "gate read: the writer check is handed the supervisor pair off the gate's one read of the handle" "$?"
  OUT=$(gr IDENT=live LIVE="frozen x"); printf '%s\n' "$OUT" | grep -q 'ROUTE=ADOPT VERDICT=frozen' && printf '%s\n' "$OUT" | grep -q 'GLOBALS ADOPTED=\[1\]'; check "row frozen: a frozen verdict adopts with the globals committed" "$?"
  # Row: writer running. Nothing is written, no identity check runs, no
  # global is set, and the route is HOLD.
  OUT=$(gr WRITER=1)
  printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD VERDICT= INDEX=0 PID=\[\] HANDLE= LAUNCHED=\[\] CLAIMS=0 WRITES=0' && ! printf '%s\n' "$OUT" | grep -q 'IDENT(\|^CALL poll' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS" && printf '%s\n' "$OUT" | grep -q 'still running (or one that cannot be ruled out)'; CHECK_RC=$?
  check "row writer running: no claim, no identity check, no poll, no global set, the stale reading cleared, route HOLD (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # A handle carrying this supervisor's own pair is its claim from an earlier
  # pass: the writer check is skipped and the pass goes on to ADOPT, which is
  # what lets a hold that claimed and then failed its poll re-read to ADOPT.
  OUT=$(gr WRITER=1 SW="$W_SUP" ST="$T_SUP")
  printf '%s\n' "$OUT" | grep -q 'ROUTE=ADOPT VERDICT=alive' && ! printf '%s\n' "$OUT" | grep -q '^CALL writer_check' && printf '%s\n' "$OUT" | grep -q 'own claim from an earlier pass'; CHECK_RC=$?
  check "gate read: a handle carrying this supervisor's own pair skips the writer check as its own earlier claim and goes on to adopt (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Row: gone (identity). No claim, no poll, no per-child global; the sweep is
  # handed the holder's and the child's pairs and the handle, the child index
  # is raised to the swept index, and the route is SWEEP_LAUNCH.
  OUT=$(gr IDENT=gone)
  printf '%s\n' "$OUT" | grep -q 'ROUTE=SWEEP_LAUNCH VERDICT=gone INDEX=2 PID=\[\] HANDLE= LAUNCHED=\[\] CLAIMS=0 WRITES=0' && ! printf '%s\n' "$OUT" | grep -q '^CALL poll\|^CALL write_handle' && printf '%s\n' "$OUT" | grep -q "unswept beyond the recorded pair $W_CHILD,$T_CHILD" && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS" && printf '%s\n' "$OUT" | grep -q "SWEEP PAIRS=\[$W_HOLDER,$T_HOLDER|$W_CHILD,$T_CHILD\] HANDLE=\[.*/child-2/handle.json\]"; CHECK_RC=$?
  check "row gone (identity): no claim, no poll, no per-child global set; the sweep is handed the holder's and the child's ticks-matched pairs and the handle, the index is raised to the swept child's, and the unswept pair is named (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Row: gone (verdict). The claim was written; the sweep is handed the pairs
  # and the walked tree, the index is raised to the swept index, and every
  # other global is dropped.
  OUT=$(gr IDENT=live LIVE="gone silent" TREE="777,639012345678901300")
  printf '%s\n' "$OUT" | grep -q 'ROUTE=SWEEP_LAUNCH VERDICT=gone INDEX=2 PID=\[\] HANDLE= LAUNCHED=\[\] CLAIMS=2 WRITES=1' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS" && printf '%s\n' "$OUT" | grep -q "SWEEP PAIRS=\[$W_HOLDER,$T_HOLDER|$W_CHILD,$T_CHILD|777,639012345678901300\] HANDLE=\[.*/child-2/handle.json\]"; CHECK_RC=$?
  check "row gone (verdict): the claim was written, the sweep is handed the pairs plus the walked tree, the index is raised to the swept child's, and every other global is dropped (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # The sweep of child-1 launches child-2: in a run directory holding only
  # child-1's handle, the gate sweeps it, the main loop clears the handle, and
  # the real next_child_index then allocates child-2 rather than handing the
  # swept directory out again. The control is the same allocation from an
  # index the gate never raised, which reuses child-1.
  S1_DIR=$(mktemp -d "$TMP/sweep1.XXXXXX"); mkdir -p "$S1_DIR/child-1"
  printf '%s' "$H2_JSON" > "$S1_DIR/child-1/handle.json"
  OUT=$(env IDENT=gone THEN_LAUNCH=1 bash "$TMP/gateread.sh" "$S1_DIR" child-1 2>&1)
  printf '%s\n' "$OUT" | grep -q 'ROUTE=SWEEP_LAUNCH VERDICT=gone INDEX=1 ' && printf '%s\n' "$OUT" | grep -qx 'LAUNCHES child-2' && [ ! -e "$S1_DIR/child-1/handle.json" ]; CHECK_RC=$?
  check "the sweep of child-1 launches child-2: the swept directory is never handed out again (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  printf '%s\nlog_diag() { :; }\n%s\nnext_child_index "$1" 0\n' "$STUB_OPTIONS" "$NEXTIDX_SNIPPET" > "$TMP/nextidx0.sh"
  [ "$(bash "$TMP/nextidx0.sh" "$S1_DIR" 2>/dev/null)" = 1 ]; check "control: the same allocation from an index the sweep did not raise hands child-1 out again" "$?"
  printf '%s\n%s\nCHILD_INDEX="$1"; gate_keep_swept_index "$2"; echo "$CHILD_INDEX"\n' "$STUB_OPTIONS" "$KEEPIDX_SNIPPET" > "$TMP/keepidx.sh"
  [ "$(bash "$TMP/keepidx.sh" 0 1)" = 1 ] && [ "$(bash "$TMP/keepidx.sh" 3 1)" = 3 ] && [ "$(bash "$TMP/keepidx.sh" 2 7)" = 7 ]; check "gate_keep_swept_index raises the index to the swept one and never lowers it (0,1->1; 3,1->3; 2,7->7)" "$?"
  # Row: unverified. Nothing written, nothing set, HOLD.
  OUT=$(gr IDENT=unverified); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD .*CLAIMS=0 WRITES=0' && ! printf '%s\n' "$OUT" | grep -q '^CALL poll\|^CALL write_handle' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?; check "row unverified: an unverifiable child pair holds the gate with no claim, no poll and no global set (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Row: poll failed. The claim was written, then every global dropped.
  OUT=$(gr IDENT=live POLL_ERR=1); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD VERDICT= INDEX=0 PID=\[\] HANDLE= LAUNCHED=\[\] CLAIMS=1 WRITES=1' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?; check "row poll failed: the claim was written, the gate holds, and every per-child global is dropped (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Row: claim read-back foreign, at once and after the poll.
  OUT=$(gr IDENT=live CLAIM=0); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD .*CLAIMS=1 WRITES=1' && ! printf '%s\n' "$OUT" | grep -q '^CALL poll' && printf '%s\n' "$OUT" | grep -q 'another supervisor claimed it' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?; check "row claim foreign at once: the gate holds before any poll and drops every global (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(gr IDENT=live CLAIM2=0); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD .*CLAIMS=2 WRITES=1' && printf '%s\n' "$OUT" | grep -q '^CALL poll' && printf '%s\n' "$OUT" | grep -q 'rewritten by another supervisor during the gate' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?; check "row claim foreign after the poll: the gate holds after it and drops every global (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Row: verdict not recognized. The claim was written; HOLD, globals dropped.
  OUT=$(gr IDENT=live LIVE="odd reading"); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD VERDICT=odd .*CLAIMS=2 WRITES=1' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS" && printf '%s\n' "$OUT" | grep -q 'verdict it does not route on'; CHECK_RC=$?; check "row verdict not recognized: the gate holds rather than launching beside a claimed child, and drops every global (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Row: own pair unknown. No claim is written and the route is HOLD, with
  # the reason logged.
  OUT=$(gr IDENT=live SW= ST= SD=); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD .*CLAIMS=0 WRITES=0' && ! printf '%s\n' "$OUT" | grep -q '^CALL poll' && printf '%s\n' "$OUT" | grep -q 'no claim is written' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?; check "row own pair unknown: no claim is written, no poll runs, no global is set, and the gate holds naming why (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Row: dead writer, no child identity. The handle is cleared, the directory
  # named, nothing set, and the route is today's gate (WAIT).
  OUT=$(env IDENT=live bash "$TMP/gateread.sh" "$GR_DIR" child-5 2>&1)
  printf '%s\n' "$OUT" | grep -q 'ROUTE=WAIT VERDICT= INDEX=0 PID=\[\] HANDLE= LAUNCHED=\[\] CLAIMS=0 WRITES=0' && ! printf '%s\n' "$OUT" | grep -q 'IDENT(\|^CALL poll' && printf '%s\n' "$OUT" | grep -q "names nothing to adopt or sweep; the handle in $GR_DIR/child-5 is cleared" && [ ! -e "$GR_DIR/child-5/handle.json" ] && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?
  check "row dead writer with no child identity: the handle is cleared, the log names its directory, nothing is set, and the gate falls to today's wait (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  printf '%s' "$H5_JSON" > "$GR_DIR/child-5/handle.json"
  # A dead writer's handle with no MSYS child pid but a recorded child pair is
  # routed on that pair's identity: live holds, since nothing can poll under
  # it; gone sweeps the recorded pairs; unverified holds. The handle is never
  # cleared on any of the three.
  OUT=$(env IDENT=live bash "$TMP/gateread.sh" "$GR_DIR" child-3 2>&1)
  printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD VERDICT= INDEX=0 PID=\[\] HANDLE= LAUNCHED=\[\] CLAIMS=0 WRITES=0' && printf '%s\n' "$OUT" | grep -q "IDENT($W_CHILD,$T_CHILD)" && ! printf '%s\n' "$OUT" | grep -q '^CALL poll' && printf '%s\n' "$OUT" | grep -q 'records no MSYS pid to poll it under, so it can be neither adopted nor swept; the gate holds' && [ -e "$GR_DIR/child-3/handle.json" ] && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?
  check "row live identity with no MSYS pid: the identity is checked on the recorded pair, the gate holds naming why, nothing is set and the handle stays (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(env IDENT=gone bash "$TMP/gateread.sh" "$GR_DIR" child-3 2>&1)
  printf '%s\n' "$OUT" | grep -q 'ROUTE=SWEEP_LAUNCH VERDICT=gone INDEX=3 PID=\[\] HANDLE= LAUNCHED=\[\] CLAIMS=0 WRITES=0' && printf '%s\n' "$OUT" | grep -q "SWEEP PAIRS=\[$W_HOLDER,$T_HOLDER|$W_CHILD,$T_CHILD\] HANDLE=\[.*/child-3/handle.json\]" && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?
  check "row gone identity with no MSYS pid: the recorded holder and child pairs go to the sweep and the route is SWEEP_LAUNCH (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(env IDENT=unverified bash "$TMP/gateread.sh" "$GR_DIR" child-3 2>&1)
  printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD .*CLAIMS=0 WRITES=0' && [ -e "$GR_DIR/child-3/handle.json" ] && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?
  check "row unverified identity with no MSYS pid: the gate holds and the handle stays (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Row: unreadable. Nothing written, nothing set, WAIT.
  OUT=$(bash "$TMP/gateread.sh" "$GR_DIR" child-4 2>&1); printf '%s\n' "$OUT" | grep -q 'ROUTE=WAIT VERDICT= INDEX=0 .*CLAIMS=0 WRITES=0' && printf '%s\n' "$OUT" | grep -q 'cannot be read' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS" && [ -e "$GR_DIR/child-4/handle.json" ]; CHECK_RC=$?; check "row unreadable: a handle that cannot be read is not claimed, not cleared, sets nothing, and falls to today's wait (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Row: name not child-<n>.
  OUT=$(bash "$TMP/gateread.sh" "$GR_DIR" notachild 2>&1); printf '%s\n' "$OUT" | grep -q 'ROUTE=WAIT VERDICT= INDEX=0 .*WRITES=0' && printf '%s\n' "$OUT" | grep -q "$NO_GLOBALS"; CHECK_RC=$?; check "row name not child-<n>: the handle is not read, not claimed, and nothing is set (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # After any HOLD route, the real cleanup trap sends no signal to the
  # handle's pids: no stop, no kill, no snapshot kill.
  for hold_case in "WRITER=1" "IDENT=unverified" "IDENT=live POLL_ERR=1" "IDENT=live CLAIM=0" "IDENT=live CLAIM2=0" "IDENT=live SW= ST= SD="; do
    # shellcheck disable=SC2086
    OUT=$(gr $hold_case RUN_CLEANUP=1); RC=$?
    printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD' && ! printf '%s\n' "$OUT" | grep -q '^CALL stop_child\|^CALL kill\|^CALL snapshot\|^CALL retry\|DETACH\|CLEANUP:' && [ "$RC" -eq 0 ]; CHECK_RC=$?
    check "HOLD then cleanup ($hold_case): the trap stops, signals and kills nothing of the foreign pids (rc=$RC, out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  done

  # claim_is_ours, real, over a real handle: this supervisor's pair passes,
  # another's or an unknown own pair is refused, and a pair differing in the
  # last digit of 18 is another's.
  CLAIM_SNIPPET=$(sed -n '/^claim_is_ours() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  printf '%s\n%s\n%s\nSELF_WINPID="${SW:-}"; SELF_TICKS="${ST:-}"\nclaim_is_ours "$1"; echo "rc=$?"\n' "$STUB_OPTIONS" "$RHF_SNIPPET" "$CLAIM_SNIPPET" > "$TMP/claim.sh"
  [ "$(SW=$W_SUP ST=$T_SUP bash "$TMP/claim.sh" "$GR_DIR/child-2/handle.json")" = "rc=0" ]; check "claim_is_ours: a handle carrying this supervisor's exact 18-digit pair is its claim" "$?"
  [ "$(SW=$W_SUP ST=639012345678900010 bash "$TMP/claim.sh" "$GR_DIR/child-2/handle.json")" = "rc=1" ]; check "claim_is_ours: a pair differing only in the last digit is not (the refusal: the pair is not this supervisor's)" "$?"
  [ "$(SW= ST= bash "$TMP/claim.sh" "$GR_DIR/child-2/handle.json")" = "rc=1" ]; check "claim_is_ours: an own pair this supervisor could not read proves no claim" "$?"

  # gate_hold_on_handle: each pass sleeps at most five seconds and re-runs the
  # gate read inside the bound, so a handle that turns adoptable during the
  # hold reaches ADOPT before the bound; one that stays held ends the run at
  # GATE TIMEOUT; one its holder accounts for lets the gate go on.
  HOLD_SNIPPET=$(sed -n '/^gate_hold_on_handle() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  HD_DIR=$(mktemp -d "$TMP/hold.XXXXXX"); mkdir -p "$HD_DIR/child-1"
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$HOLD_SNIPPET" '
log() { echo "LOG $*"; }
SLEEPS=0; READS=0
sleep() { SLEEPS=$((SLEEPS + 1)); echo "SLEEP $1"; if [ "$SLEEPS" -ge "${CLEAR_AT:-999}" ]; then rm -f "$RUNDIR/child-1/handle.json"; fi; }
gate_read_handle() { READS=$((READS + 1)); if [ "$READS" -ge "${ADOPT_AT:-999}" ]; then GATE_ROUTE=ADOPT; else GATE_ROUTE=HOLD; fi; }
RUNDIR="$1"; SUPERVISOR_GATE_WAIT_S="${BOUND:-10}"; GATE_ROUTE=HOLD
gate_hold_on_handle child-1; echo "RETURNED route=$GATE_ROUTE sleeps=$SLEEPS reads=$READS"' > "$TMP/hold.sh"
  : > "$HD_DIR/child-1/handle.json"
  OUT=$(bash "$TMP/hold.sh" "$HD_DIR" 2>&1); HD_RC=$?
  [ "$HD_RC" -eq 2 ] && printf '%s\n' "$OUT" | grep -q 'GATE TIMEOUT: child-1 still holds a handle this supervisor may not take' && ! printf '%s\n' "$OUT" | grep -q RETURNED && [ "$(printf '%s\n' "$OUT" | grep -c '^SLEEP 5$')" -eq 2 ]; CHECK_RC=$?; check "gate hold: a handle that stays held on every re-read ends the run at GATE TIMEOUT after the bound (rc=$HD_RC, out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  : > "$HD_DIR/child-1/handle.json"
  OUT=$(CLEAR_AT=1 bash "$TMP/hold.sh" "$HD_DIR" 2>&1); HD_RC=$?
  [ "$HD_RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -q 'RETURNED route=WAIT sleeps=1 reads=0'; check "gate hold: a handle its holder accounts for while the gate waits lets the gate go on with no re-read (rc=$HD_RC)" "$?"
  : > "$HD_DIR/child-1/handle.json"
  OUT=$(ADOPT_AT=2 BOUND=30 bash "$TMP/hold.sh" "$HD_DIR" 2>&1); HD_RC=$?
  [ "$HD_RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -q 'RETURNED route=ADOPT sleeps=2 reads=2' && printf '%s\n' "$OUT" | grep -q 'routes ADOPT on a re-read'; CHECK_RC=$?; check "gate hold: a handle that turns adoptable during the hold reaches ADOPT on the re-read that finds it, before the bound (rc=$HD_RC, out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(BOUND=7 bash "$TMP/hold.sh" "$HD_DIR" 2>&1); HD_RC=$?
  [ "$HD_RC" -eq 2 ] && [ "$(printf '%s\n' "$OUT" | grep '^SLEEP' | tr '\n' ' ')" = "SLEEP 5 SLEEP 2 " ]; CHECK_RC=$?; check "gate hold: each pass sleeps min(5, remaining), so a 7s bound sleeps 5 then 2 (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"

  # ensure_self_ticks caches the pair only once it read one; write_handle
  # names a write made with no pair and records whether the pair was written.
  SELFT_SNIPPET=$(sed -n '/^ensure_self_ticks() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$SELFT_SNIPPET" '
SELF_WINPID=""; SELF_TICKS=""; SELF_TICKS_DONE=""; READS_FILE="$1"; echo 0 > "$READS_FILE"
resolve_windows_pid() { echo 34999; }
resolve_windows_start_ticks() { local n; n=$(( $(cat "$READS_FILE") + 1 )); echo "$n" > "$READS_FILE"; if [ "$n" -ge 2 ]; then echo 639012345678999999; fi; }
ensure_self_ticks; echo "after1 done=[$SELF_TICKS_DONE] ticks=[$SELF_TICKS]"
ensure_self_ticks; echo "after2 done=[$SELF_TICKS_DONE] ticks=[$SELF_TICKS]"
ensure_self_ticks; echo "reads=$(cat "$READS_FILE")"' > "$TMP/selft.sh"
  OUT=$(bash "$TMP/selft.sh" "$TMP/selft.reads")
  printf '%s\n' "$OUT" | grep -q '^after1 done=\[\] ticks=\[\]$' && printf '%s\n' "$OUT" | grep -q '^after2 done=\[1\] ticks=\[639012345678999999\]$' && printf '%s\n' "$OUT" | grep -q '^reads=2$'; CHECK_RC=$?; check "ensure_self_ticks: an empty read is not cached, the next call retries and caches a pair it read, and no call follows (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  WH_SNIPPET=$(sed -n '/^write_handle() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  WH_DIR=$(mktemp -d "$TMP/wh.XXXXXX")
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$WH_SNIPPET" '
log() { echo "LOG $*"; }
ensure_self_ticks() { :; }
SELF_WINPID="${SW:-}"; SELF_TICKS="${ST:-}"; RUNDIR="$1"; HANDLE_FILE="$1/handle.json"; CHILD_INDEX=1; LAUNCHED_AT=1000
HOLDER_LAUNCH_PID="${HP:-}"; HOLDER_WINPID="${HW:-}"; HOLDER_TICKS="${HT:-}"; CHILD_LAUNCH_PID="${CP:-}"; CHILD_WINPID="${CW:-}"; CHILD_TICKS="${CT:-}"
write_handle sess-1; echo "HAS_SELF_PAIR=[${HANDLE_HAS_SELF_PAIR:-}]"' > "$TMP/wh.sh"
  OUT=$(bash "$TMP/wh.sh" "$WH_DIR" 2>&1)
  printf '%s\n' "$OUT" | grep -q 'no supervisor pid and ticks pair' && grep -q '"supervisorTicks":null' "$WH_DIR/handle.json" && printf '%s\n' "$OUT" | grep -q '^HAS_SELF_PAIR=\[\]$'; CHECK_RC=$?; check "write_handle: a write with no supervisor pair is named in the log and recorded as carrying no pair (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Precision: the 18-digit pair and the pids reach the file as the digit
  # strings they arrived as, and read back byte-equal through the real reader.
  OUT=$(SW=$W_SELF ST=$T_SELF HP=41180 HW=$W_HOLDER HT=$T_HOLDER CP=41236 CW=$W_CHILD CT=$T_CHILD bash "$TMP/wh.sh" "$WH_DIR" 2>&1)
  grep -q "\"childTicks\":\"$T_CHILD\"" "$WH_DIR/handle.json" && grep -q "\"supervisorTicks\":\"$T_SELF\"" "$WH_DIR/handle.json" && grep -q "\"holderTicks\":\"$T_HOLDER\"" "$WH_DIR/handle.json" && grep -q "\"childWinPid\":\"$W_CHILD\"" "$WH_DIR/handle.json" && grep -q '"launchedAt":1000' "$WH_DIR/handle.json" && printf '%s\n' "$OUT" | grep -q '^HAS_SELF_PAIR=\[1\]$'; CHECK_RC=$?
  check "precision: write_handle records every pid and start ticks as the digit string it was given, 18 digits intact, and the launch timestamp as a number (file=$(cat "$WH_DIR/handle.json" 2>/dev/null))" "$CHECK_RC"
  printf '%s\n%s\nread_handle_fields "$1"\n' "$STUB_OPTIONS" "$RHF_SNIPPET" > "$TMP/rhf.sh"
  OUT=$(bash "$TMP/rhf.sh" "$WH_DIR/handle.json" | tr '\t' '=' | tr '\n' ' ')
  case "$OUT" in
    *"childTicks=$T_CHILD "*"supervisorWinPid=$W_SELF "*"supervisorTicks=$T_SELF "*) check "precision: read_handle_fields returns the written pair byte-equal (got $OUT)" 0 ;;
    *) check "precision: read_handle_fields returns the written pair byte-equal (got $OUT)" 1 ;;
  esac
  # A pair that lost its last digit, which is what Number(v) does to an
  # 18-digit tick, is a different pair to the reader.
  ! printf '%s' "$OUT" | grep -q "childTicks=${T_CHILD%??}00 "; check "precision: the read-back does not carry the Number-rounded value ${T_CHILD%??}00" "$?"
  # The handle is written whole. A rewrite lands a new file under the name
  # rather than truncating the old one in place, so the file's identity
  # changes on every write and no temporary name is left beside it; and a
  # reader polling the file across a run of rewrites never meets an empty or
  # unparsable handle. The identity check is the deterministic one: an
  # in-place truncate keeps the identity, a rename into place cannot.
  WH_INODE_1=$(stat -c %i "$WH_DIR/handle.json" 2>/dev/null)
  bash "$TMP/wh.sh" "$WH_DIR" >/dev/null 2>&1
  WH_INODE_2=$(stat -c %i "$WH_DIR/handle.json" 2>/dev/null)
  [ -n "$WH_INODE_1" ] && [ -n "$WH_INODE_2" ] && [ "$WH_INODE_1" != "$WH_INODE_2" ] && [ -z "$(ls "$WH_DIR" | grep 'handle.json.')" ]; CHECK_RC=$?; check "write_handle writes whole: a rewrite lands a new file under the name ($WH_INODE_1 -> $WH_INODE_2) and leaves no temporary file beside it (dir: $(ls "$WH_DIR" | tr '\n' ' '))" "$CHECK_RC"
  node -e '
const fs = require("fs");
const [file, stop, out] = process.argv.slice(1);
let reads = 0, bad = 0;
while (!fs.existsSync(stop)) {
  let s = "";
  try { s = fs.readFileSync(file, "utf8"); } catch (e) { bad++; reads++; continue; }
  reads++;
  try { if (s.length === 0 || JSON.parse(s).childIndex !== 1) bad++; } catch (e) { bad++; }
}
fs.writeFileSync(out, "reads=" + reads + " bad=" + bad + "\n");
' "$WH_DIR/handle.json" "$WH_DIR/stop" "$WH_DIR/reader.out" &
  WH_READER=$!
  for wh_i in $(seq 1 25); do bash "$TMP/wh.sh" "$WH_DIR" >/dev/null 2>&1; done
  : > "$WH_DIR/stop"
  wait "$WH_READER" 2>/dev/null
  WH_READS=$(tr -d '\r\n' < "$WH_DIR/reader.out" 2>/dev/null)
  case "$WH_READS" in
    "reads="*" bad=0") [ "${WH_READS#reads=}" != "0 bad=0" ]; check "write_handle writes whole: a reader polling the handle across 25 rewrites never meets an empty or unparsable file ($WH_READS)" "$?" ;;
    *) check "write_handle writes whole: a reader polling the handle across 25 rewrites never meets an empty or unparsable file ($WH_READS)" 1 ;;
  esac

  # ticks_retry_due: a read is due on a doubling gap of polls, capped, so a
  # persistent miss costs a bounded number of spawns rather than one per poll.
  RETRY_SNIPPET=$(sed -n '/^TICKS_RETRY_GAP_MAX=/,/^}$/p' "$SCRIPT" | tr -d '\r')
  [ -n "$RETRY_SNIPPET" ]; check "ticks_retry_due is found in bin/supervise.sh" "$?"
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$RETRY_SNIPPET" '
DUE=""
for POLL_COUNT in $(seq 1 200); do if ticks_retry_due X; then DUE="$DUE $POLL_COUNT"; fi; done
echo "DUE=${DUE# }"' > "$TMP/retry.sh"
  OUT=$(bash "$TMP/retry.sh")
  [ "$OUT" = "DUE=1 2 4 8 16 32 64 128 192" ]; check "ticks_retry_due: due on polls 1, 2, 4, ... doubling to a 64-poll gap, so 200 polls cost 9 reads rather than 200 (got $OUT)" "$?"

  # ensure_child_ticks retries the child's ticks on the polls the gap names
  # until they land, names the gap while empty, and rewrites the handle once.
  CHT_SNIPPET=$(sed -n '/^ensure_child_ticks() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  printf '%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$RETRY_SNIPPET" "$CHT_SNIPPET" '
log() { echo "LOG $*"; }
write_handle() { echo "CALL write_handle $1"; }
READS_FILE="$1"; echo 0 > "$READS_FILE"
resolve_windows_start_ticks() { local n; n=$(( $(cat "$READS_FILE") + 1 )); echo "$n" > "$READS_FILE"; echo "READ on poll $POLL_COUNT" >&2; if [ "$n" -ge 3 ]; then echo 639012345678901237; fi; }
CHILD_INDEX=1; CHILD_WINPID=35124; CHILD_TICKS=""; CHILD_SESSION_ID=sess-1
for POLL_COUNT in 1 2 3 4 5 6 7 8; do ensure_child_ticks; done
echo "reads=$(cat "$READS_FILE") ticks=[$CHILD_TICKS]"' > "$TMP/cht.sh"
  OUT=$(bash "$TMP/cht.sh" "$TMP/cht.reads" 2>&1)
  [ "$(printf '%s\n' "$OUT" | grep -c 'still unread')" -eq 2 ] && [ "$(printf '%s\n' "$OUT" | grep -c '^CALL write_handle sess-1$')" -eq 1 ] && printf '%s\n' "$OUT" | grep -q 'landed on a later read' && printf '%s\n' "$OUT" | grep -q 'retrying on poll 2' && printf '%s\n' "$OUT" | grep -q 'retrying on poll 4' && printf '%s\n' "$OUT" | grep -q '^reads=3 ticks=\[639012345678901237\]$'; CHECK_RC=$?; check "ensure_child_ticks: retried on polls 1, 2 and 4 with the gap named, the 18-digit pair kept whole when it lands, the handle rewritten once, and no read after (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # ensure_self_pair_recorded retries the own pair the same way for a handle
  # written without it, and rewrites the handle once it lands.
  SPR_SNIPPET=$(sed -n '/^ensure_self_pair_recorded() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  [ -n "$SPR_SNIPPET" ]; check "ensure_self_pair_recorded is found in bin/supervise.sh" "$?"
  printf '%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$RETRY_SNIPPET" "$SPR_SNIPPET" '
log() { echo "LOG $*"; }
CALLS=0
ensure_self_ticks() { CALLS=$((CALLS + 1)); echo "CALL ensure_self_ticks on poll $POLL_COUNT"; if [ "$CALLS" -ge 3 ]; then SELF_WINPID=34999; SELF_TICKS=639012345678999999; SELF_TICKS_DONE=1; fi; }
write_handle() { echo "CALL write_handle $1"; HANDLE_HAS_SELF_PAIR=1; }
SELF_WINPID=""; SELF_TICKS=""; SELF_TICKS_DONE=""; HANDLE_HAS_SELF_PAIR=""; HANDLE_FILE=/rd/child-1/handle.json; CHILD_INDEX=1; CHILD_SESSION_ID=sess-1
for POLL_COUNT in 1 2 3 4 5 6 7 8; do ensure_self_pair_recorded; done
echo "calls=$CALLS has=[$HANDLE_HAS_SELF_PAIR]"' > "$TMP/spr.sh"
  OUT=$(bash "$TMP/spr.sh" 2>&1)
  [ "$(printf '%s\n' "$OUT" | grep -c 'still unread')" -eq 2 ] && [ "$(printf '%s\n' "$OUT" | grep -c '^CALL write_handle sess-1$')" -eq 1 ] && printf '%s\n' "$OUT" | grep -q 'own pid and start ticks landed on a later read (34999,639012345678999999)' && printf '%s\n' "$OUT" | grep -q '^calls=3 has=\[1\]$'; CHECK_RC=$?; check "ensure_self_pair_recorded: the own pair is retried on polls 1, 2 and 4 with the gap named, the handle rewritten once it lands, and no read after (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  printf '%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$RETRY_SNIPPET" "$SPR_SNIPPET" '
ensure_self_ticks() { echo "NEVER"; }
write_handle() { echo "NEVER"; }
HANDLE_HAS_SELF_PAIR=1; HANDLE_FILE=/rd/child-1/handle.json; CHILD_INDEX=1; CHILD_SESSION_ID=sess-1; POLL_COUNT=1
ensure_self_pair_recorded; echo "done"' > "$TMP/spr2.sh"
  [ "$(bash "$TMP/spr2.sh" 2>&1)" = "done" ]; check "ensure_self_pair_recorded: control: a handle already carrying the pair spends no read" "$?"
  # ensure_holder_ticks retries an own-launched holder's ticks the same way,
  # names the gap while empty, rewrites the handle once they land, and never
  # reads for an adopted holder or one whose Windows pid is unknown.
  HLT_SNIPPET=$(sed -n '/^ensure_holder_ticks() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  [ -n "$HLT_SNIPPET" ]; check "ensure_holder_ticks is found in bin/supervise.sh" "$?"
  printf '%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$RETRY_SNIPPET" "$HLT_SNIPPET" '
log() { echo "LOG $*"; }
write_handle() { echo "CALL write_handle $1"; }
READS_FILE="$1"; echo 0 > "$READS_FILE"
resolve_windows_start_ticks() { local n; n=$(( $(cat "$READS_FILE") + 1 )); echo "$n" > "$READS_FILE"; echo "READ on poll $POLL_COUNT" >&2; if [ "$n" -ge 3 ]; then echo 639012345678901180; fi; }
CHILD_INDEX=1; HOLDER_WINPID="${HW-35088}"; HOLDER_TICKS=""; HOLDER_OWN_LAUNCH="${OWN-1}"; CHILD_SESSION_ID=sess-1
# The holder is still running: this driver itself stands in for it.
HOLDER_LAUNCH_PID=$$
for POLL_COUNT in 1 2 3 4 5 6 7 8; do ensure_holder_ticks; done
echo "reads=$(cat "$READS_FILE") ticks=[$HOLDER_TICKS]"' > "$TMP/hlt.sh"
  OUT=$(bash "$TMP/hlt.sh" "$TMP/hlt.reads" 2>&1)
  [ "$(printf '%s\n' "$OUT" | grep -c 'holder start ticks are still unread')" -eq 2 ] && [ "$(printf '%s\n' "$OUT" | grep -c '^CALL write_handle sess-1$')" -eq 1 ] && printf '%s\n' "$OUT" | grep -q 'holder start ticks landed on a later read (35088,639012345678901180)' && printf '%s\n' "$OUT" | grep -q 'retrying on poll 2' && printf '%s\n' "$OUT" | grep -q 'retrying on poll 4' && printf '%s\n' "$OUT" | grep -q '^reads=3 ticks=\[639012345678901180\]$'; CHECK_RC=$?; check "ensure_holder_ticks: retried on polls 1, 2 and 4 with the gap named, the 18-digit pair kept whole when it lands, the handle rewritten once, and no read after (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(OWN= bash "$TMP/hlt.sh" "$TMP/hlt.reads" 2>&1)
  [ "$OUT" = "reads=0 ticks=[]" ]; check "ensure_holder_ticks: an adopted holder's ticks are never read fresh, since a recorded Windows pid may have been reused (got $OUT)" "$?"
  OUT=$(HW= bash "$TMP/hlt.sh" "$TMP/hlt.reads" 2>&1)
  [ "$OUT" = "reads=0 ticks=[]" ]; check "ensure_holder_ticks: a holder with no Windows pid spends no read (got $OUT)" "$?"
  # The three retries are seeded on different polls, read off the launch's
  # own seeding line, so two PowerShell misses never share one poll: over 400
  # polls no poll is due for two of them, and each is due on at least eight.
  # The control seeds all three alike and sees the sharing the seeds prevent.
  SEED_LINE=$(grep -m1 '^    CHILD_TICKS_RETRY_NEXT=' "$SCRIPT" | tr -d '\r')
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$RETRY_SNIPPET" '
'"${SEED_LINE#    }"'
if [ "${ALIKE:-}" = 1 ]; then CHILD_TICKS_RETRY_NEXT=1; SELF_TICKS_RETRY_NEXT=1; HOLDER_TICKS_RETRY_NEXT=1; fi
SHARED=0; C=0; S=0; H=0
for POLL_COUNT in $(seq 1 400); do
  due=0
  if ticks_retry_due CHILD_TICKS; then due=$((due + 1)); C=$((C + 1)); fi
  if ticks_retry_due SELF_TICKS; then due=$((due + 1)); S=$((S + 1)); fi
  if ticks_retry_due HOLDER_TICKS; then due=$((due + 1)); H=$((H + 1)); fi
  [ "$due" -gt 1 ] && SHARED=$((SHARED + 1))
done
echo "shared=$SHARED child=$C self=$S holder=$H"' > "$TMP/seeds.sh"
  OUT=$(bash "$TMP/seeds.sh" 2>&1)
  case "$OUT" in
    "shared=0 child="*) C_N=$(printf '%s' "$OUT" | sed 's/.*child=\([0-9]*\).*/\1/'); S_N=$(printf '%s' "$OUT" | sed 's/.*self=\([0-9]*\).*/\1/'); H_N=$(printf '%s' "$OUT" | sed 's/.*holder=\([0-9]*\).*/\1/'); [ "$C_N" -ge 8 ] && [ "$S_N" -ge 8 ] && [ "$H_N" -ge 8 ]; check "the three ticks retries, seeded as the launch seeds them, never fall due on one poll across 400 polls, and each falls due on at least eight ($OUT; seeds: ${SEED_LINE#    })" "$?" ;;
    *) check "the three ticks retries, seeded as the launch seeds them, never fall due on one poll across 400 polls ($OUT; seeds: ${SEED_LINE#    })" 1 ;;
  esac
  OUT=$(ALIKE=1 bash "$TMP/seeds.sh" 2>&1)
  case "$OUT" in "shared=0 "*) check "control: seeded alike, the three retries share polls (got $OUT)" 1 ;; "shared="*) check "control: seeded alike, the three retries share polls (got $OUT)" 0 ;; *) check "control: seeded alike, the three retries share polls (got $OUT)" 1 ;; esac
fi

# --- An own holder that is gone never has a stranger's ticks recorded ---
# ensure_holder_ticks and everything it calls run as written: the retry gap,
# the ticks read, this supervisor's own pair and the handle write through node.
# Only the PowerShell leaf is stubbed, and it answers a ticks read for the
# holder's Windows pid, as it would where Windows had handed that pid to
# another process. The holder's launch pid is a real process of this suite's:
# one that has exited, or, for the control, one still running.
: > "$TMP/hlt-real.fn"
for fn in $(SUPERVISOR_CLOSURE_STUBS="log log_diag run_bounded_powershell_capture" supervisor_fn_closure "$SCRIPT" ensure_holder_ticks); do
  supervisor_extract_fn "$SCRIPT" "$fn" "$TMP/hlt-real.fn" || true
done
HLT_REAL="$(grep -m1 '^TICKS_RETRY_GAP_MAX=' "$SCRIPT" | tr -d '\r')
$(tr -d '\r' < "$TMP/hlt-real.fn")"
printf '%s\n' "$HLT_REAL" | grep -q '^TICKS_RETRY_GAP_MAX=[0-9]*$' && printf '%s\n' "$HLT_REAL" | grep -q '^write_handle() {$' && printf '%s\n' "$HLT_REAL" | grep -q '^resolve_windows_start_ticks() {$' && ! printf '%s\n' "$HLT_REAL" | grep -q '^run_bounded_powershell_capture() {$'; check "ensure_holder_ticks's real closure carries write_handle and the ticks read, and not the PowerShell leaf it stubs" "$?"
if [ -n "$HLT_REAL" ]; then
  HLR_DIR=$(mktemp -d "$TMP/hltreal.XXXXXX")
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$HLT_REAL" '
log() { echo "LOG $*"; }
log_diag() { :; }
READS="$1/reads"; : > "$READS"
run_bounded_powershell_capture() {
  local id
  id=$(printf "%s\n" "$2" | sed -n "s/.*Get-Process -Id \([0-9]*\) -ErrorAction.*/\1/p" | head -1)
  echo "TICKS_READ $id" >> "$READS"
  if [ "$id" = 35088 ]; then echo 639012345678901180; else echo 639012345678999999; fi
  echo "$STOP_PS_SENTINEL"
}
SUPERVISOR_PS_BOUND_S=30; STOP_PS_SENTINEL=___SUPERVISOR_PS_DONE___
RUNDIR="$1"; HANDLE_FILE="$1/handle.json"; rm -f "$HANDLE_FILE"; CHILD_INDEX=1; LAUNCHED_AT=1000; CHILD_SESSION_ID=sess-1
SELF_WINPID=""; SELF_TICKS=""; SELF_TICKS_DONE=""; HANDLE_HAS_SELF_PAIR=""
( exit 0 ) & DEAD=$!; wait "$DEAD"
command sleep 30 & LIVE=$!
if [ "${HOLDER_ALIVE:-}" = 1 ]; then HOLDER_LAUNCH_PID="$LIVE"; else HOLDER_LAUNCH_PID="$DEAD"; fi
HOLDER_OWN_LAUNCH=1; HOLDER_WINPID=35088; HOLDER_TICKS=""
CHILD_LAUNCH_PID=41236; CHILD_WINPID=35124; CHILD_TICKS=639012345678901237
HOLDER_TICKS_RETRY_NEXT=1; HOLDER_TICKS_RETRY_GAP=1
write_handle "$CHILD_SESSION_ID"
for POLL_COUNT in 1 2 3 4 5 6 7 8; do ensure_holder_ticks; done
builtin kill "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null
echo "HOLDER_TICKS=[$HOLDER_TICKS]"
echo "HANDLE $(node -e "const h = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")); console.log(h.holderWinPid + \",\" + h.holderTicks)" "$HANDLE_FILE")"
echo "HOLDER_READS=$(grep -c "^TICKS_READ 35088$" "$READS")"' > "$TMP/hltreal.sh"
  OUT=$(timeout 60 bash "$TMP/hltreal.sh" "$HLR_DIR" 2>&1)
  printf '%s\n' "$OUT" | grep -qx 'HOLDER_TICKS=\[\]' && printf '%s\n' "$OUT" | grep -qx 'HANDLE 35088,null' && printf '%s\n' "$OUT" | grep -qx 'HOLDER_READS=0' && [ "$(printf '%s\n' "$OUT" | grep -c 'no longer answers')" -eq 1 ]; CHECK_RC=$?; check "ensure_holder_ticks: an own holder whose launch pid no longer answers has no ticks read for its Windows pid over eight polls, the handle keeps holderTicks null, and the gone holder is logged once (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(HOLDER_ALIVE=1 timeout 60 bash "$TMP/hltreal.sh" "$HLR_DIR" 2>&1)
  printf '%s\n' "$OUT" | grep -qx 'HOLDER_TICKS=\[639012345678901180\]' && printf '%s\n' "$OUT" | grep -qx 'HANDLE 35088,639012345678901180' && printf '%s\n' "$OUT" | grep -qx 'HOLDER_READS=1' && ! printf '%s\n' "$OUT" | grep -q 'no longer answers'; CHECK_RC=$?; check "control: an own holder still running has its ticks read once and recorded in the handle (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
fi

# --- kill_holder's identity guard ---
KILLH_SNIPPET=$(sed -n '/^kill_holder() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$KILLH_SNIPPET" ]; check "kill_holder is found in bin/supervise.sh" "$?"
if [ -n "$KILLH_SNIPPET" ]; then
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$KILLH_SNIPPET" '
log() { echo "LOG $*"; }
kill_process_snapshot() { echo "CALL snapshot $1"; return 0; }
kill() { case "$1" in -0) [ "${ALIVE:-1}" = 1 ] && return 0 || return 1 ;; esac; echo "CALL kill $*"; return 0; }
HOLDER_LAUNCH_PID="${HP:-}"; HOLDER_WINPID="${HW:-}"; HOLDER_TICKS="${HT:-}"; HOLDER_OWN_LAUNCH="${OWN:-}"
kill_holder' > "$TMP/killh.sh"
  kh() { env "$@" bash "$TMP/killh.sh"; }
  # Ticks-first for every holder with a recorded pair, own-launched included;
  # `kill -0` is only an own-launch skip; the MSYS TERM survives only for an
  # own holder with no ticks; an adopted holder with no ticks is left alone.
  OUT=$(kh HP=41180 HW=35088 HT=639012345678901180 OWN=1 ALIVE=1); printf '%s\n' "$OUT" | grep -q '^CALL snapshot 35088,639012345678901180$' && ! printf '%s\n' "$OUT" | grep -q 'CALL kill -TERM'; check "kill_holder: this supervisor's own live holder with ticks goes to the ticks-matched kill, not the MSYS signal (out=$OUT)" "$?"
  OUT=$(kh HP=41180 HW=35088 HT=639012345678901180 OWN=1 ALIVE=0); ! printf '%s\n' "$OUT" | grep -q 'CALL' && printf '%s\n' "$OUT" | grep -q 'already gone, so nothing is killed'; check "kill_holder: an own holder that no longer answers is skipped, not killed, so a natural exit spends no PowerShell (out=$OUT)" "$?"
  OUT=$(kh HP=41180 OWN=1 ALIVE=1); printf '%s\n' "$OUT" | grep -q '^CALL kill -TERM 41180$' && ! printf '%s\n' "$OUT" | grep -q 'CALL snapshot'; check "kill_holder: an own holder whose ticks were never read gets the MSYS TERM, the one case that signal survives for (out=$OUT)" "$?"
  OUT=$(kh HP=41180 HW=35088 HT=639012345678901180 OWN= ALIVE=0); printf '%s\n' "$OUT" | grep -q '^CALL snapshot 35088,639012345678901180$' && ! printf '%s\n' "$OUT" | grep -q 'CALL kill -TERM\|already gone'; check "kill_holder: an adopted holder with ticks goes to the ticks-matched kill even where its MSYS pid does not answer kill -0 (out=$OUT)" "$?"
  OUT=$(kh HP=41180 HW=35088 HT=639012345678901180 OWN= ALIVE=1); printf '%s\n' "$OUT" | grep -q '^CALL snapshot 35088,639012345678901180$' && ! printf '%s\n' "$OUT" | grep -q 'CALL kill -TERM'; check "kill_holder: an adopted live holder is killed ticks-matched only (out=$OUT)" "$?"
  OUT=$(kh HP=41180 OWN= ALIVE=1); ! printf '%s\n' "$OUT" | grep -q 'CALL' && printf '%s\n' "$OUT" | grep -q 'not signalled on an unverified pid'; check "kill_holder: an adopted holder with no recorded pair is left alone, and the refusal is named (out=$OUT)" "$?"
  OUT=$(kh HP=41180 OWN= ALIVE=0); ! printf '%s\n' "$OUT" | grep -q 'CALL\|already gone' && printf '%s\n' "$OUT" | grep -q 'not signalled on an unverified pid'; check "kill_holder: an adopted holder with no pair whose MSYS pid does not answer is still left alone, never read as gone off that pid (out=$OUT)" "$?"
fi

# --- An adopted child's stop never signals its MSYS pid ---
# stop_child is extracted with child_present and driven with every helper it
# calls stubbed to record its call. The adopted stand-in pid is a process that
# has exited, so any MSYS signal to it would be a signal to a number nothing
# of the child holds. On every label a stop can carry, an adopted stop sends
# no MSYS signal and no taskkill to that pid: the pipe close is kill_holder,
# the grace waits key on the marker and the walk, and both escalation rungs
# are the ticks-matched snapshot kill over the recorded child pair and the
# walked tree. The own-launch control still signals its own live job.
STOPC_SNIPPET=$(sed -n '/^stop_child() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
STOP_LABELS=$(grep -o 'stop_child "[a-z_]*"' "$SCRIPT" | sed 's/stop_child "\(.*\)"/\1/' | sort -u)
[ -n "$STOPC_SNIPPET" ] && [ -n "$PRESENT_SNIPPET" ] && [ "$(printf '%s\n' "$STOP_LABELS" | grep -c .)" -ge 9 ]; check "stop_child and child_present are found, and the stop labels read out of the script ($(printf '%s' "$STOP_LABELS" | tr '\n' ' '))" "$?"
if [ -n "$STOPC_SNIPPET" ] && [ -n "$PRESENT_SNIPPET" ]; then
  SC_DIR=$(mktemp -d "$TMP/stopc.XXXXXX")
  printf '%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$PRESENT_SNIPPET" "$STOPC_SNIPPET" '
log() { echo "LOG $*"; }
log_diag() { :; }
sleep() { :; }
# The clock advances 600ms a read, so the patient wait meets its cap.
DATE_FILE="$1/clock"; echo 1000 > "$DATE_FILE"
date() { local n; n=$(( $(cat "$DATE_FILE") + 600 )); echo "$n" > "$DATE_FILE"; echo "$n"; }
kill() { case "$1" in -0) return 1 ;; esac; echo "CALL kill $*"; return 0; }
run_bounded_native() { echo "CALL native $*"; return 0; }
taskkill() { echo "CALL taskkill $*"; return 0; }
resolve_windows_pid() { echo "CALL resolve $1" >&2; echo "9$1"; }
kill_holder() { echo "CALL kill_holder"; }
child_turn_state() { echo "${TURN:-idle}"; }
SNAPKILLS=0
kill_process_snapshot() { SNAPKILLS=$((SNAPKILLS + 1)); echo "CALL snapshot [$(printf "%s" "$1" | tr "\n" "|")]"; if [ "$SNAPKILLS" -ge "${GONE_AT:-999}" ]; then WALK_NOW=none; fi; return 0; }
check_snapshot_survivors() { printf ""; return 0; }
sweep_child_tree() { echo "CALL sweep $1"; return 0; }
WALK_NOW="${WALK:-live}"
refresh_child_tree() { CHILD_TREE_POLL_WALK="$WALK_NOW"; }
build_stop_snapshot() { STOP_SNAPSHOT_BUILT="777,639012345678901300"; STOP_SNAPSHOT_WRAPPER_WINPID="${SNAP_WINPID:-}"; return 0; }
( exit 0 ) & DEAD=$!; wait "$DEAD"
CHILD_LAUNCH_PID="$DEAD"; CHILD_ADOPTED="${ADOPTED-1}"; CHILD_INDEX=1
CHILD_WINPID=35124; CHILD_TICKS=639012345678901237; EXIT_MARKER="$1/.exit"; rm -f "$EXIT_MARKER"
[ "${MARKER:-}" = 1 ] && echo 0 > "$EXIT_MARKER"
CHILD_TREE_POLL_WALK="$WALK_NOW"; OUT=""; STOP_TREE_MOVED=""; LAST_STOP_SNAPSHOT=""; STOP_PATH=""
SUPERVISOR_STOP_GRACE_MS=2000; SUPERVISOR_STOP_BUSY_CAP_MS=1000
stop_child "$2"; echo "RC=$? PATH=$STOP_PATH PID=$CHILD_LAUNCH_PID"' > "$TMP/stopc.sh"
  sc() { env "$@" timeout 60 bash "$TMP/stopc.sh" "$SC_DIR" "$SC_LABEL" 2>"$SC_DIR/err"; }
  SC_FAILED=0
  for SC_LABEL in $STOP_LABELS; do
    # The child stays present through both graces, so the stop runs every
    # rung: no MSYS signal, no taskkill, no resolve of the launch pid, and the
    # snapshot kill carries the recorded child pair.
    OUT=$(sc)
    if ! { printf '%s\n' "$OUT" | grep -q '^RC=0 PATH=kill ' && ! printf '%s\n' "$OUT" | grep -q '^CALL kill \|^CALL native\|^CALL taskkill' && ! grep -q 'CALL resolve' "$SC_DIR/err" 2>/dev/null && printf '%s\n' "$OUT" | grep -q '^CALL kill_holder$' && [ "$(printf '%s\n' "$OUT" | grep -c '^CALL snapshot \[.*35124,639012345678901237.*\]')" -eq 2 ]; }; then
      SC_FAILED=1; echo "  detail [$SC_LABEL present]: $(printf '%s' "$OUT" | tr '\n' '|')"
    fi
    # The first snapshot kill ends the child (the walk reads none after it):
    # the stop confirms it on the TERM rung with one kill.
    OUT=$(sc GONE_AT=1)
    if ! { printf '%s\n' "$OUT" | grep -q '^RC=0 PATH=term ' && ! printf '%s\n' "$OUT" | grep -q '^CALL kill \|^CALL native\|^CALL taskkill' && [ "$(printf '%s\n' "$OUT" | grep -c '^CALL snapshot')" -eq 1 ]; }; then
      SC_FAILED=1; echo "  detail [$SC_LABEL term]: $(printf '%s' "$OUT" | tr '\n' '|')"
    fi
    # The marker is present at entry: the child is accounted through the
    # recorded tree with nothing resolved or signalled.
    OUT=$(sc MARKER=1)
    if ! { printf '%s\n' "$OUT" | grep -q '^RC=0 PATH=gone ' && printf '%s\n' "$OUT" | grep -q "^CALL sweep $SC_LABEL$" && ! printf '%s\n' "$OUT" | grep -q '^CALL kill \|^CALL native\|^CALL taskkill\|^CALL snapshot\|^CALL kill_holder' && ! grep -q 'CALL resolve' "$SC_DIR/err" 2>/dev/null; }; then
      SC_FAILED=1; echo "  detail [$SC_LABEL marker]: $(printf '%s' "$OUT" | tr '\n' '|')"
    fi
    # The unverified build is pinned below through the real build and retry,
    # where the kill is read at the Stop-Process leaf; a stubbed builder
    # cannot stand in for it.
  done
  check "adopted stop: on every stop label, with the child present through both graces, ended by the first snapshot kill, or accounted by its marker at entry, stop_child sends no MSYS signal and no taskkill to the child pid, never resolves it, closes the pipe through kill_holder, and kills the recorded pair ticks-matched" "$SC_FAILED"
  # The patient wait on restart_passive keys on the same reading: a busy child
  # that the cap ends is then killed ticks-matched, never signalled.
  SC_LABEL=restart_passive; OUT=$(sc TURN=busy)
  printf '%s\n' "$OUT" | grep -q 'wait_ended=cap' && printf '%s\n' "$OUT" | grep -q '^RC=0 PATH=kill ' && ! printf '%s\n' "$OUT" | grep -q '^CALL kill \|^CALL native\|^CALL taskkill' && ! grep -q 'CALL resolve' "$SC_DIR/err" 2>/dev/null; CHECK_RC=$?; check "adopted stop: restart_passive's patient wait ends on the cap and the escalation is the ticks-matched kill with no MSYS signal (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Control: this supervisor's own launch is signalled as before. The stand-in
  # is a live job of the driver, `kill -0` on it is the real builtin, and the
  # stubbed TERM and KILL never end it, so the stop runs every rung.
  printf '%s\n' "$STUB_OPTIONS" "$PRESENT_SNIPPET" "$STOPC_SNIPPET" '
log() { echo "LOG $*"; }
log_diag() { :; }
sleep() { :; }
date() { echo 1000; }
kill() { case "$1" in -0) builtin kill "$@" ;; *) echo "CALL kill $*"; return 0 ;; esac; }
run_bounded_native() { echo "CALL native $*"; return 0; }
resolve_windows_pid() { echo "9$1"; }
kill_holder() { echo "CALL kill_holder"; }
child_turn_state() { echo idle; }
kill_process_snapshot() { echo "CALL snapshot [$(printf "%s" "$1" | tr "\n" "|")]"; return 0; }
check_snapshot_survivors() { printf ""; return 0; }
sweep_child_tree() { echo "CALL sweep $1"; return 0; }
refresh_child_tree() { CHILD_TREE_POLL_WALK=live; }
build_stop_snapshot() { STOP_SNAPSHOT_BUILT="777,639012345678901300"; STOP_SNAPSHOT_WRAPPER_WINPID="9$CHILD_LAUNCH_PID"; return 0; }
command sleep 30 & LIVE=$!
CHILD_LAUNCH_PID="$LIVE"; CHILD_ADOPTED=""; CHILD_INDEX=1; CHILD_WINPID=""; CHILD_TICKS=""; EXIT_MARKER="$1/.exit"; rm -f "$EXIT_MARKER"
CHILD_TREE_POLL_WALK=live; OUT=""; STOP_TREE_MOVED=""; LAST_STOP_SNAPSHOT=""; STOP_PATH=""
SUPERVISOR_STOP_GRACE_MS=2000; SUPERVISOR_STOP_BUSY_CAP_MS=1000
stop_child stop_complete; echo "RC=$? PATH=$STOP_PATH"
builtin kill -9 "$LIVE" 2>/dev/null; wait "$LIVE" 2>/dev/null; true' > "$TMP/stopc-own.sh"
  OUT=$(timeout 60 bash "$TMP/stopc-own.sh" "$SC_DIR" 2>&1)
  printf '%s\n' "$OUT" | grep -q '^CALL kill -TERM [0-9]*$' && printf '%s\n' "$OUT" | grep -q '^CALL native 5 taskkill //F //PID 9[0-9]*$' && printf '%s\n' "$OUT" | grep -q '^CALL kill -9 [0-9]*$' && printf '%s\n' "$OUT" | grep -q '^RC=0 PATH=kill$'; CHECK_RC=$?; check "control: this supervisor's own launched child still takes the TERM, the guarded taskkill and the KILL on its own live job (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
fi

# --- An adopted child's stop through the real stop_child, build and retry ---
# stop_child, build_stop_snapshot, retry_stop_escalation, refresh_child_tree and
# everything they call run as written. Only the leaves are stubbed: the MSYS
# process table (`ps`, which resolve_windows_pid falls back to for a pid /proc
# does not list), the PowerShell call (the walk, the survivor read and the
# Stop-Process kill), the MSYS `kill` and the native taskkill. The child's MSYS
# pids are real pids of this suite that have exited, so /proc has no entry for
# them and every resolve of one reaches the `ps` leaf, which records the
# function that asked. A world of files stands in for the box: the MSYS table,
# the MSYS pids that answer `kill -0`, the live Windows pids with their start
# ticks, and each Windows pid's walked descendants. Every Stop-Process pair is
# recorded, and a pair whose pid is live under the same ticks dies alone, since
# Stop-Process ends the one process it names and Windows kills no tree with it.
: > "$TMP/astop.fn"
for fn in $(SUPERVISOR_CLOSURE_STUBS="log log_diag run_bounded_powershell_capture run_bounded_native" supervisor_fn_closure "$SCRIPT" stop_child retry_stop_escalation refresh_child_tree child_present); do
  supervisor_extract_fn "$SCRIPT" "$fn" "$TMP/astop.fn" || true
done
ASTOP_REAL=$(tr -d '\r' < "$TMP/astop.fn")
AS_HAVE=1
for fn in stop_child build_stop_snapshot retry_stop_escalation refresh_child_tree walk_msys_process_tree snapshot_process_tree check_snapshot_survivors kill_process_snapshot resolve_windows_pid kill_holder; do
  printf '%s\n' "$ASTOP_REAL" | grep -q "^$fn() {\$" || AS_HAVE=0
done
printf '%s\n' "$ASTOP_REAL" | grep -q '^run_bounded_powershell_capture() {$' && AS_HAVE=0
[ "$AS_HAVE" = 1 ]; check "the adopted stop's real closure carries the stop, the build, the retry, the refresh, the walks, the kill and the resolve, and not the leaves it stubs" "$?"
if [ "$AS_HAVE" = 1 ]; then
  AS_DIR=$(mktemp -d "$TMP/astop.XXXXXX")
  printf '%s\n%s\n' "$STUB_OPTIONS" "$ASTOP_REAL" > "$TMP/astop.sh"
  cat >> "$TMP/astop.sh" <<'DRIVER'
log() { echo "LOG $*"; }
log_diag() { :; }
sleep() { :; }
W="$1"; CALLS="$W/calls"; : > "$CALLS"; rm -f "$W"/walkfail.* "$W/refused"
T_CHILD=639012345678901237; T_CLAUDE=639012345678901300; T_HOLDER=639012345678901180
T_F=639012345678902001; T_F2=639012345678902002; T_OTHER=639012345678903001; T_X=639012345678903002
T_NODE=639012345678901400
( exit 0 ) & P=$!; wait "$P"
( exit 0 ) & C=$!; wait "$C"
( exit 0 ) & H=$!; wait "$H"
row() { printf '%9s %7s %7s %10s  pty0     197609 12:00:00 %s\n' "$1" "$2" "$1" "$3" "$4"; }
{ row "$P" 1 35124 /usr/bin/bash; row "$C" "$P" 35200 /usr/bin/claude; } > "$W/table"
printf '%s\n' "$P" "$C" > "$W/msys"
printf '%s\n' "35124 $T_CHILD" "35200 $T_CLAUDE" "35088 $T_HOLDER" > "$W/alive"
: > "$W/desc"
ps() {
  echo "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND"
  if [ "${1:-}" = "-p" ]; then
    echo "RESOLVE $2 ${FUNCNAME[*]:1}" >> "$CALLS"
    awk -v p="$2" '$1 == p' "$W/table"
    return 0
  fi
  cat "$W/table"
}
kill() {
  if [ "$1" = "-0" ]; then
    grep -qx "$2" "$W/msys" && return 0
    builtin kill -0 "$2" 2>/dev/null
    return $?
  fi
  echo "SIGNAL $*" >> "$CALLS"
  return 0
}
run_bounded_native() { echo "NATIVE $*" >> "$CALLS"; return 0; }
ticks_of() { awk -v p="$1" '$1 == p { print $2; exit }' "$W/alive"; }
drop_alive() { grep -v "^$1 " "$W/alive" > "$W/alive.n"; mv "$W/alive.n" "$W/alive"; }
# The child ends on its own: the wrapper and claude are gone from both tables.
# Where the input closed, the wrapper wrote its marker. REUSE_MSYS hands the wrapper's
# MSYS pid to a foreign process running as Windows pid 48000, with a Windows
# child of its own; REUSE_WIN hands the wrapper's Windows pid to a foreign
# process with a Windows child of its own.
child_ends() {
  drop_alive 35124; drop_alive 35200
  rm -f "$W/walkfail.35124"
  : > "$W/table"; : > "$W/msys"; : > "$W/desc"
  [ "${1:-}" = eof ] && echo 0 > "$EXIT_MARKER"
  if [ -n "${REUSE_MSYS:-}" ]; then
    row "$P" 1 48000 /usr/bin/foreign > "$W/table"; echo "$P" > "$W/msys"
    printf '%s\n' "48000 $T_F" "48001 $T_F2" >> "$W/alive"; echo "48000 48001 $T_F2" >> "$W/desc"
  fi
  if [ -n "${REUSE_WIN:-}" ]; then
    printf '%s\n' "35124 $T_OTHER" "35300 $T_X" >> "$W/alive"; echo "35124 35300 $T_X" >> "$W/desc"
  fi
}
# A killed process leaves the MSYS table too: the row running as that Windows
# pid goes, and its MSYS pid stops answering `kill -0`. Windows ends the one
# process Stop-Process names and nothing under it, so every other row stays.
msys_ends() {
  local m o one
  m=$(awk -v w="$1" '$4 == w { print $1 }' "$W/table")
  # WALK_CLEARS: a walk from the ended process's Windows pid now completes and
  # names nothing, rather than failing, since the process is gone.
  [ -n "${WALK_CLEARS:-}" ] && rm -f "$W/walkfail.$1"
  awk -v w="$1" '$4 != w' "$W/table" > "$W/table.n"; mv "$W/table.n" "$W/table"
  if [ -n "$m" ]; then grep -vx "$m" "$W/msys" > "$W/msys.n"; mv "$W/msys.n" "$W/msys"; fi
  # ORPHANS_UNLISTED: the MSYS table lists nothing under the ended process
  # either, so the closure from a dead wrapper reads empty while the Windows
  # process under it still runs.
  if [ -n "$m" ] && [ -n "${ORPHANS_UNLISTED:-}" ]; then
    o=$(awk -v p="$m" '$2 == p { print $1 }' "$W/table")
    awk -v p="$m" '$2 != p' "$W/table" > "$W/table.n"; mv "$W/table.n" "$W/table"
    for one in $o; do grep -vx "$one" "$W/msys" > "$W/msys.n"; mv "$W/msys.n" "$W/msys"; done
  fi
}
alive_ids() { awk '{ print $1 }' "$W/alive" | sort -n | tr '\n' ' '; }
pairs_in() { printf '%s' "$1" | grep -o '@{Id=[0-9]*;Ticks=[0-9]*}' | sed 's/@{Id=\([0-9]*\);Ticks=\([0-9]*\)}/\1,\2/'; }
run_bounded_powershell_capture() {
  local script="$2" id t pair
  case "$script" in
    *Stop-Process*)
      for pair in $(pairs_in "$script"); do
        echo "KILL $pair" >> "$CALLS"
        [ -n "${STUBBORN:-}" ] && continue
        id="${pair%%,*}"; t=$(ticks_of "$id")
        [ -n "$t" ] && [ "$t" = "${pair#*,}" ] || continue
        # REFUSE names a pid whose first REFUSE_N kills (every kill, with no
        # REFUSE_N) leave it running.
        if [ "$id" = "${REFUSE:-}" ]; then
          echo "$id" >> "$W/refused"
          [ "$(grep -c . "$W/refused")" -le "${REFUSE_N:-999999}" ] && continue
        fi
        drop_alive "$id"
        if [ "$id" = 35088 ] && [ -n "${EOF_ENDS:-}" ]; then child_ends eof; fi
        if [ -n "${KILL_ENDS:-}" ]; then msys_ends "$id"; fi
      done
      ;;
    *Get-CimInstance*)
      id=$(printf '%s\n' "$script" | sed -n 's/.*Select-ProcessTree [^ ]* \([0-9][0-9]*\).*/\1/p' | head -1)
      echo "WALK $id" >> "$CALLS"
      [ -f "$W/walkfail.$id" ] && return 1
      t=$(ticks_of "$id")
      if [ -n "$t" ]; then
        echo "$id,$t"
        awk -v r="$id" '$1 == r { print $2 "," $3 }' "$W/desc"
      fi
      ;;
    *'Write-Output $e.Id'*)
      for pair in $(pairs_in "$script"); do
        id="${pair%%,*}"; t=$(ticks_of "$id")
        [ -n "$t" ] && [ "$t" = "${pair#*,}" ] && echo "$id"
      done
      ;;
    *)
      id=$(printf '%s\n' "$script" | sed -n 's/.*Get-Process -Id \([0-9]*\) -ErrorAction.*/\1/p' | head -1)
      t=$(ticks_of "$id"); [ -n "$t" ] && echo "$t"
      ;;
  esac
  echo "$STOP_PS_SENTINEL"
  return 0
}
EXIT_MARKER="$W/.exit"; rm -f "$EXIT_MARKER"
SUPERVISOR_PS_BOUND_S=30; STOP_PS_SENTINEL=___SUPERVISOR_PS_DONE___; RUNDIR="$W"; PLUGIN_DIR="$W"
SUPERVISOR_STOP_GRACE_MS=2000; SUPERVISOR_STOP_BUSY_CAP_MS=1000; SUPERVISOR_POLL_MS=10000
CHILD_INDEX=1; CHILD_LAUNCH_PID="$P"; CHILD_ADOPTED="${ADOPTED-1}"; CHILD_WINPID=35124; CHILD_TICKS="$T_CHILD"
HOLDER_LAUNCH_PID=""; HOLDER_WINPID=""; HOLDER_TICKS=""; HOLDER_OWN_LAUNCH=""
if [ -n "${EOF_ENDS:-}" ]; then HOLDER_LAUNCH_PID=41180; HOLDER_WINPID=35088; HOLDER_TICKS="$T_HOLDER"; fi
CHILD_TREE_MSYS_PIDS=""; CHILD_TREE_WINPIDS=""; CHILD_TREE_SEEN_WINPIDS=""; CHILD_TREE_SEEN_PAIRS=""
CHILD_TREE_SNAPSHOT=""; CHILD_TREE_WALKED=""; CHILD_TREE_READ_FAILED=""; CHILD_TREE_DESCENDANT_SEEN=""
CHILD_TREE_CONFIRMED_AT=""; CHILD_TREE_FAILED_CONFIRMS=0; CHILD_TREE_POLL_WALK=failed; CHILD_ROOT_MISMATCH_LOGGED=""
STOP_SNAPSHOT_BUILT=""; STOP_SNAPSHOT_WRAPPER_WINPID=""; STOP_TREE_MOVED=""; LAST_STOP_SNAPSHOT=""; STOP_PATH=""; OUT=""
# The poll that recorded the tree, before the stop. Only the stop's own calls
# are asserted, so the record is cleared of the poll's. NORECORD skips that
# poll, so the stop meets a child no walk has recorded a tree for.
[ -n "${NORECORD:-}" ] || refresh_child_tree
echo "POLL WALK=$CHILD_TREE_POLL_WALK TREE=[$(printf '%s' "$CHILD_TREE_SNAPSHOT" | tr '\n' '|')]"
: > "$CALLS"
[ -n "${WALKFAIL:-}" ] && : > "$W/walkfail.35124"
# STALE_POLLS empties the MSYS table, so every poll from here reads a closure
# that names nothing while the launch pid still answers, and runs that many
# polls before the stop. Each one fails to confirm the record and counts
# toward the stale bound through the refresh's own counting, so the stop's
# entry refresh is the third and reads the record stale.
if [ -n "${STALE_POLLS:-}" ]; then : > "$W/table"; fi
for ((i = 0; i < ${STALE_POLLS:-0}; i++)); do refresh_child_tree; done
# BEHIND puts a third MSYS process under claude after the record was walked,
# running as Windows pid 35300, so the child's pid set has moved past the
# record and the stop's entry refresh reads the record behind the tree.
if [ -n "${BEHIND:-}" ]; then row "$H" "$C" 35300 /usr/bin/node >> "$W/table"; echo "$H" >> "$W/msys"; echo "35300 $T_NODE" >> "$W/alive"; fi
: > "$CALLS"
stop_child stop_complete; rc=$?
echo "STOP RC=$rc PATH=$STOP_PATH"
echo "ALIVE STOP=[$(alive_ids)]"
if [ -n "${RETRY:-}" ]; then retry_stop_escalation stop_complete "$rc"; echo "RETRY RC=$?"; fi
echo "ALIVE END=[$(alive_ids)]"
echo "MSYS P=$P C=$C"
DRIVER
  as() { env "$@" timeout 60 bash "$TMP/astop.sh" "$AS_DIR" 2>&1; }
  # Every Stop-Process pair outside the recorded holder, the recorded child
  # pair and the recorded tree, and every resolve of the child's MSYS pids by
  # anything but the refresh's identity check against the recorded Windows pid.
  as_foreign_kills() { grep '^KILL ' "$AS_DIR/calls" | grep -vx -e 'KILL 35088,639012345678901180' -e 'KILL 35124,639012345678901237' -e 'KILL 35200,639012345678901300'; }
  as_stray_resolves() { local p c; p=$(printf '%s\n' "$OUT" | sed -n 's/^MSYS P=\([0-9]*\) C=.*/\1/p'); c=$(printf '%s\n' "$OUT" | sed -n 's/^MSYS P=[0-9]* C=\([0-9]*\)$/\1/p'); grep -E "^RESOLVE ($p|$c) " "$AS_DIR/calls" | grep -v "^RESOLVE [0-9]* resolve_windows_pid refresh_child_tree "; }
  # The stop's walk does not complete, the input close ends the child, and
  # before the retry re-snapshots, the wrapper's MSYS pid is running again as a
  # foreign process under Windows pid 48000. The retry builds from the recorded
  # pair and the walk from its Windows pid: no MSYS pid is resolved outside the
  # refresh's identity check, and nothing foreign is killed.
  OUT=$(as WALKFAIL=1 EOF_ENDS=1 REUSE_MSYS=1 RETRY=1)
  printf '%s\n' "$OUT" | grep -qx 'POLL WALK=live TREE=\[35124,639012345678901237|35200,639012345678901300\]' && printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && printf '%s\n' "$OUT" | grep -qx 'RETRY RC=0' && [ -z "$(as_foreign_kills)" ] && [ -z "$(as_stray_resolves)" ] && grep -q '^KILL 35124,639012345678901237$' "$AS_DIR/calls" && ! grep -q '^SIGNAL \|^NATIVE ' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted stop, real build and retry: a wrapper MSYS pid reused by a foreign process before the retry is never resolved outside the refresh's identity check, and every kill names only the recorded holder, child pair and tree (foreign kills: $(as_foreign_kills | tr '\n' ' '); stray resolves: $(as_stray_resolves | tr '\n' ' '); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # The instrument speaks: the refresh's identity check did resolve the reused
  # MSYS pid to the foreign Windows pid during the retry, so an empty stray
  # list above is the build not asking rather than a leaf nobody reached.
  P_NOW=$(printf '%s\n' "$OUT" | sed -n 's/^MSYS P=\([0-9]*\) C=.*/\1/p')
  grep -q "^RESOLVE $P_NOW resolve_windows_pid refresh_child_tree retry_stop_escalation" "$AS_DIR/calls" && grep -q 'not the 35124 its handle recorded' <<< "$OUT"; CHECK_RC=$?; check "control: the retry's refresh resolved the reused MSYS pid through the ps leaf and read it as a process the handle never named (calls: $(tr '\n' '|' < "$AS_DIR/calls"))" "$CHECK_RC"
  # The same, with the wrapper's Windows pid also handed to a foreign process:
  # the walk from the recorded Windows pid names a root under other start ticks
  # and a foreign child, and neither is killed.
  OUT=$(as WALKFAIL=1 EOF_ENDS=1 REUSE_MSYS=1 REUSE_WIN=1 RETRY=1)
  printf '%s\n' "$OUT" | grep -qx 'RETRY RC=0' && [ -z "$(as_foreign_kills)" ] && [ -z "$(as_stray_resolves)" ] && grep -q '^WALK 35124$' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted stop, real build and retry: a recorded Windows pid now held under other start ticks is walked, and neither it nor its foreign child is killed (foreign kills: $(as_foreign_kills | tr '\n' ' '); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Control: this supervisor's own launch still resolves its wrapper's MSYS pid
  # in the build, and the ps leaf records that the build asked.
  OUT=$(as ADOPTED= WALKFAIL=1)
  P_NOW=$(printf '%s\n' "$OUT" | sed -n 's/^MSYS P=\([0-9]*\) C=.*/\1/p')
  grep -q "^RESOLVE $P_NOW resolve_windows_pid build_stop_snapshot " "$AS_DIR/calls"; CHECK_RC=$?; check "control: an own-launch stop's build resolves the wrapper's MSYS pid, and the ps leaf names build_stop_snapshot as the caller (calls: $(tr '\n' '|' < "$AS_DIR/calls"))" "$CHECK_RC"
  # A walk that does not complete leaves the adopted stop its kill rungs: the
  # recorded pair joins the snapshot, the TERM rung and the KILL rung each kill
  # it ticks-matched, and the stop reports the tree unverified.
  OUT=$(as WALKFAIL=1 STUBBORN=1)
  printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && [ "$(grep -c '^KILL 35124,639012345678901237$' "$AS_DIR/calls")" -eq 2 ] && [ -z "$(as_foreign_kills)" ] && printf '%s\n' "$OUT" | grep -q 'tree not verified' && printf '%s\n' "$OUT" | grep -q 'TERM grace expired for adopted child-1' && ! grep -q '^SIGNAL \|^NATIVE ' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted stop, failed entry walk: the TERM and KILL rungs both kill the recorded pair ticks-matched, no MSYS signal or taskkill is sent, and the stop logs the tree unverified (calls: $(tr '\n' '|' < "$AS_DIR/calls"); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # The TERM rung's kill ends the child: the stop still reports unverified
  # rather than a confirmed stop, since no walk ever completed. Each kill ends
  # only the pid it names, so the child ends at that rung only where the rung
  # names claude as well as the wrapper, and no KILL rung follows.
  OUT=$(as WALKFAIL=1 KILL_ENDS=1)
  printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && [ "$(grep -c '^KILL 35124,639012345678901237$' "$AS_DIR/calls")" -ge 1 ] && printf '%s\n' "$OUT" | grep -qx 'ALIVE STOP=\[35088 \]' && ! printf '%s\n' "$OUT" | grep -q 'TERM grace expired for adopted child-1' && ! grep -q '^SIGNAL \|^NATIVE ' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted stop, failed entry walk: a child the TERM rung's ticks-matched kill ends is reported unverified, not stopped (calls: $(tr '\n' '|' < "$AS_DIR/calls"); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # The failed entry walk leaves the tree record whole, so both rungs kill the
  # claude pair it names beside the recorded wrapper pair. Claude refuses every
  # kill here, so both rungs run and each names it.
  OUT=$(as WALKFAIL=1 KILL_ENDS=1 REFUSE=35200)
  printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && [ "$(grep -c '^KILL 35200,639012345678901300$' "$AS_DIR/calls")" -eq 2 ] && [ "$(grep -c '^KILL 35124,639012345678901237$' "$AS_DIR/calls")" -eq 2 ] && [ -z "$(as_foreign_kills)" ] && printf '%s\n' "$OUT" | grep -q 'TERM grace expired for adopted child-1' && ! grep -q '^SIGNAL \|^NATIVE ' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted stop, failed entry walk: both rungs kill the claude pair from the whole tree record as well as the wrapper pair, ticks-matched, and the stop reports unverified (calls: $(tr '\n' '|' < "$AS_DIR/calls"); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Claude outlives both rungs and the walk from the dead wrapper still does not
  # complete, so the retry cannot verify its re-snapshot. It kills the record
  # and the recorded pair before it fails closed, and claude is dead when it
  # returns.
  OUT=$(as WALKFAIL=1 KILL_ENDS=1 REFUSE=35200 REFUSE_N=2 RETRY=1)
  printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && printf '%s\n' "$OUT" | grep -qx 'RETRY RC=1' && printf '%s\n' "$OUT" | grep -qx 'ALIVE END=\[35088 \]' && [ "$(grep -c '^KILL 35200,639012345678901300$' "$AS_DIR/calls")" -eq 3 ] && [ -z "$(as_foreign_kills)" ] && ! grep -q '^SIGNAL \|^NATIVE ' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted retry, dead recorded wrapper: the unverified re-snapshot kills the claude pair the rungs left alive, ticks-matched, before it fails closed (calls: $(tr '\n' '|' < "$AS_DIR/calls"); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # The instrument speaks: claude was alive when the stop returned, and the
  # wrapper was not, so the retry above met the survivor it is pinned to end.
  printf '%s\n' "$OUT" | grep -qx 'ALIVE STOP=\[35088 35200 \]'; CHECK_RC=$?; check "control: claude survived both rungs and the wrapper did not, before the retry ran (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # Control: the same stubborn child under a walk that completes reaches both
  # rungs and fails as kill_failed, with no unverified line.
  OUT=$(as STUBBORN=1)
  printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=kill_failed' && [ "$(grep -c '^KILL 35124,639012345678901237$' "$AS_DIR/calls")" -eq 2 ] && ! printf '%s\n' "$OUT" | grep -q 'tree not verified'; CHECK_RC=$?; check "control: a stubborn adopted child under a walk that completes takes both rungs and fails as kill_failed, with no unverified line (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # A record that is not whole still names the claude pair, and every kill is
  # ticks-matched, so the rungs kill it whatever the record's state. Two polls
  # under the failed walk and the stop's own entry refresh are the three that
  # read the record stale, through the refresh's own count.
  for rec in stale behind; do
    if [ "$rec" = stale ]; then AS_REC="STALE_POLLS=2"; else AS_REC="BEHIND=1"; fi
    OUT=$(as "$AS_REC" WALKFAIL=1 REFUSE=35200)
    printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && printf '%s\n' "$OUT" | grep -q "tree_record_$rec:" && [ "$(grep -c '^KILL 35200,639012345678901300$' "$AS_DIR/calls")" -eq 2 ] && [ "$(grep -c '^KILL 35124,639012345678901237$' "$AS_DIR/calls")" -eq 2 ] && [ -z "$(as_foreign_kills)" ] && printf '%s\n' "$OUT" | grep -q 'TERM grace expired for adopted child-1' && ! grep -q '^SIGNAL \|^NATIVE ' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted stop, failed entry walk, $rec record: both rungs kill the claude pair the record names as well as the wrapper pair, ticks-matched, nothing outside the record, and the stop reports unverified (calls: $(tr '\n' '|' < "$AS_DIR/calls"); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
    # Claude outlives both rungs. The retry's re-snapshot cannot verify under
    # the same record, and it kills what the record names plus the recorded
    # pair before it fails closed, naming the record's state in its line.
    OUT=$(as "$AS_REC" WALKFAIL=1 REFUSE=35200 REFUSE_N=2 RETRY=1)
    printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && printf '%s\n' "$OUT" | grep -qx 'RETRY RC=1' && printf '%s\n' "$OUT" | grep -qx 'ALIVE STOP=\[35088 35200 [0-9 ]*\]' && ! printf '%s\n' "$OUT" | grep -q '^ALIVE END=\[[0-9 ]*35200' && [ "$(grep -c '^KILL 35200,639012345678901300$' "$AS_DIR/calls")" -eq 3 ] && [ -z "$(as_foreign_kills)" ] && printf '%s\n' "$OUT" | grep -q "adopted_unverified_kill: record=$rec entries=2" && ! grep -q '^SIGNAL \|^NATIVE ' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted retry, $rec record: the unverified re-snapshot kills the claude pair the rungs left alive, ticks-matched, before it fails closed, and its line names the record's state (calls: $(tr '\n' '|' < "$AS_DIR/calls"); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
    # The instrument speaks: the behind record's pid set moved to a process
    # the record never named, and that process is neither killed nor read as
    # dead. Read inside the behind iteration, so its subject is that run.
    if [ "$rec" = behind ]; then
      printf '%s\n' "$OUT" | grep -qx 'ALIVE END=\[35088 35300 \]' && ! grep -q '^KILL 35300,' "$AS_DIR/calls"; CHECK_RC=$?; check "control: the process the behind record never named is left alive and never killed (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
    fi
  done
  # The record is whole at the stop's entry and the TERM rung's kill ends the
  # wrapper, after which the MSYS table lists nothing under it. The refresh
  # inside the rung's grace, the one after it and the retry's own each read an
  # empty closure and count against the record, so the retry reads it stale.
  # Claude outlived the one rung that ran, and the retry's kill still reaches
  # it through the record.
  OUT=$(as WALKFAIL=1 KILL_ENDS=1 ORPHANS_UNLISTED=1 REFUSE=35200 REFUSE_N=1 RETRY=1)
  printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && printf '%s\n' "$OUT" | grep -qx 'RETRY RC=1' && printf '%s\n' "$OUT" | grep -qx 'ALIVE STOP=\[35088 35200 \]' && printf '%s\n' "$OUT" | grep -qx 'ALIVE END=\[35088 \]' && [ "$(grep -c '^KILL 35200,639012345678901300$' "$AS_DIR/calls")" -eq 2 ] && [ "$(printf '%s\n' "$OUT" | grep -c 'tree_record_stale:')" -eq 1 ] && [ -z "$(as_foreign_kills)" ] && printf '%s\n' "$OUT" | grep -q 'adopted_unverified_kill: record=stale entries=2' && ! grep -q '^SIGNAL \|^NATIVE ' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted retry, wrapper killed by the TERM rung and nothing listed under it: the record turns stale through the three refreshes before the retry's read, and the retry still kills the claude pair the record names (calls: $(tr '\n' '|' < "$AS_DIR/calls"); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # The wrapper the TERM rung kills leaves the MSYS table, and this time the
  # walk from its dead Windows pid completes and names nothing rather than
  # failing. The grace refreshes re-walk the closure that is left, claude
  # alone, so the record is whole with that one entry when the retry builds.
  # The retry's build then verifies on the record, the recorded pair and the
  # empty walk, its kill ends the claude the rungs left alive, and it returns
  # 0 with no unverified kill.
  OUT=$(as WALKFAIL=1 KILL_ENDS=1 WALK_CLEARS=1 REFUSE=35200 REFUSE_N=2 RETRY=1)
  printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && printf '%s\n' "$OUT" | grep -qx 'RETRY RC=0' && printf '%s\n' "$OUT" | grep -qx 'ALIVE STOP=\[35088 35200 \]' && printf '%s\n' "$OUT" | grep -qx 'ALIVE END=\[35088 \]' && printf '%s\n' "$OUT" | grep -q 'retry succeeded' && ! printf '%s\n' "$OUT" | grep -q 'adopted_unverified_kill:' && [ "$(grep -c '^KILL 35200,639012345678901300$' "$AS_DIR/calls")" -eq 3 ] && [ -z "$(as_foreign_kills)" ] && ! grep -q '^SIGNAL \|^NATIVE ' "$AS_DIR/calls"; CHECK_RC=$?; check "adopted retry, wrapper killed by the TERM rung and its walk completing empty: the retry's build verifies on the record and the recorded pair, its kill ends the claude pair the rungs left alive, and it returns 0 with no unverified kill (calls: $(tr '\n' '|' < "$AS_DIR/calls"); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # The record is the only place the claude pair comes from: with no record at
  # all, the same stop kills the wrapper pair alone and the retry's line says
  # so rather than naming a record.
  OUT=$(as NORECORD=1 WALKFAIL=1 REFUSE=35200 REFUSE_N=2 RETRY=1)
  printf '%s\n' "$OUT" | grep -qx 'STOP RC=1 PATH=unverified' && printf '%s\n' "$OUT" | grep -qx 'RETRY RC=1' && ! grep -q '^KILL 35200,' "$AS_DIR/calls" && [ "$(grep -c '^KILL 35124,639012345678901237$' "$AS_DIR/calls")" -eq 3 ] && printf '%s\n' "$OUT" | grep -q 'adopted_unverified_kill: record=empty'; CHECK_RC=$?; check "control: with an empty tree record the adopted stop and its retry kill the recorded pair alone, and the retry's line reports the pair rather than a record (calls: $(tr '\n' '|' < "$AS_DIR/calls"); out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
fi

# --- The cleanup trap with no poll reading yet ---
# A signal between the launch and the first poll finds POLL_LIVENESS unset. The
# trap reads it empty, routes on alive, and detaches a handled live child; the
# same trap with no handle takes today's stop. Run under set -u.
CLEANUP_SNIPPET=$(sed -n '/^cleanup() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$CLEANUP_SNIPPET" ]; check "cleanup is found in bin/supervise.sh" "$?"
if [ -n "$CLEANUP_SNIPPET" ] && [ -n "$TRAP_ROUTE_SNIPPET" ]; then
  CU_DIR=$(mktemp -d "$TMP/cleanup.XXXXXX"); : > "$CU_DIR/handle.json"
  printf '%s\n%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$TRAP_ROUTE_SNIPPET" "$PRESENT_SNIPPET" "$CLEANUP_SNIPPET" '
log() { echo "LOG $*"; }
stop_child() { echo "CALL stop_child $1"; return 0; }
retry_stop_escalation() { echo "CALL retry $1 $2"; return 0; }
kill_process_snapshot() { return 0; }
if [ "${DEAD_PID:-}" = 1 ]; then ( exit 0 ) & CHILD_LAUNCH_PID=$!; wait "$CHILD_LAUNCH_PID"; else sleep 30 & CHILD_LAUNCH_PID=$!; fi
printf "%s" "$CHILD_LAUNCH_PID" > "${PIDF}"
CHILD_INDEX=1; LAST_STOP_SNAPSHOT=""; HANDLE_FILE="${HF:-}"; CHILD_ADOPTED="${ADOPTED:-}"; CHILD_TREE_POLL_WALK="${WALK:-failed}"; EXIT_MARKER="${MARKER:-}"
trap cleanup EXIT
exit 143' > "$TMP/cleanup.sh"
  # Each run's stand-in child is killed by the pid it recorded, never by a
  # command-line match that would reach other suites' or the box's processes.
  OUT=$(HF="$CU_DIR/handle.json" PIDF="$CU_DIR/pid1" bash "$TMP/cleanup.sh" 2>&1); CU_RC=$?
  kill -9 "$(cat "$CU_DIR/pid1" 2>/dev/null)" 2>/dev/null
  [ "$CU_RC" -eq 143 ] && printf '%s\n' "$OUT" | grep -q 'DETACH child-1' && ! printf '%s\n' "$OUT" | grep -q 'unbound variable'; CHECK_RC=$?; check "cleanup: with no poll reading yet, a signal detaches a handled live child and keeps the signal's exit code (rc=$CU_RC, out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(HF="$CU_DIR/absent.json" PIDF="$CU_DIR/pid2" bash "$TMP/cleanup.sh" 2>&1); CU_RC=$?
  kill -9 "$(cat "$CU_DIR/pid2" 2>/dev/null)" 2>/dev/null
  printf '%s\n' "$OUT" | grep -q 'CALL stop_child cleanup' && ! printf '%s\n' "$OUT" | grep -q 'DETACH'; CHECK_RC=$?; check "cleanup: with no handle, the same signal takes today's stop (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  # An adopted child whose MSYS pid does not answer kill -0 is still a live
  # handled child while the walk reads it live: the trap detaches from it,
  # and with the walk reading none it has nothing to stop or detach from.
  OUT=$(HF="$CU_DIR/handle.json" PIDF="$CU_DIR/pid3" ADOPTED=1 DEAD_PID=1 WALK=live MARKER="$CU_DIR/.exit" bash "$TMP/cleanup.sh" 2>&1); CU_RC=$?
  [ "$CU_RC" -eq 143 ] && printf '%s\n' "$OUT" | grep -q 'DETACH child-1' && ! printf '%s\n' "$OUT" | grep -q 'CALL stop_child'; CHECK_RC=$?; check "cleanup: an adopted child whose MSYS pid does not answer kill -0 is detached from on the walk reading live, never stopped off that pid (rc=$CU_RC, out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(HF="$CU_DIR/handle.json" PIDF="$CU_DIR/pid4" ADOPTED=1 DEAD_PID=1 WALK=none MARKER="$CU_DIR/.exit" bash "$TMP/cleanup.sh" 2>&1); CU_RC=$?
  [ "$CU_RC" -eq 143 ] && ! printf '%s\n' "$OUT" | grep -q 'DETACH\|CALL stop_child'; CHECK_RC=$?; check "cleanup: an adopted child the walk read gone is neither detached from nor stopped (rc=$CU_RC, out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
fi

# --- The session id is recorded in the handle once ---
NOTESESS_SNIPPET=$(sed -n '/^note_child_session_id() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$NOTESESS_SNIPPET" ]; check "note_child_session_id is found in bin/supervise.sh" "$?"
if [ -n "$NOTESESS_SNIPPET" ]; then
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$NOTESESS_SNIPPET" '
log() { echo "LOG $*"; }
write_handle() { echo "CALL write_handle $1"; }
CHILD_INDEX=1; CHILD_SESSION_ID=""
POLL_SESSION_ID=""; note_child_session_id
POLL_SESSION_ID="sess-9"; note_child_session_id
POLL_SESSION_ID="sess-9"; note_child_session_id
echo "SESS=$CHILD_SESSION_ID"' > "$TMP/notesess.sh"
  OUT=$(bash "$TMP/notesess.sh")
  [ "$(printf '%s\n' "$OUT" | grep -c '^CALL write_handle sess-9$')" -eq 1 ] && printf '%s\n' "$OUT" | grep -q '^SESS=sess-9$'; CHECK_RC=$?; check "the handle is rewritten with the session id on the poll that first reads it, and once only (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
fi

# --- The child index is allocated past any directory still holding a handle ---
# A handle on disk names a child nobody has accounted for, whatever its writer's
# state: a dead writer's live child among them. No writer check is consulted.
NEXTIDX_SNIPPET=$(sed -n '/^next_child_index() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$NEXTIDX_SNIPPET" ]; check "next_child_index is found in bin/supervise.sh" "$?"
if [ -n "$NEXTIDX_SNIPPET" ]; then
  NI_DIR=$(mktemp -d "$TMP/nextidx.XXXXXX"); mkdir -p "$NI_DIR/child-1" "$NI_DIR/child-2"
  printf '{"supervisorWinPid":null,"supervisorTicks":null}' > "$NI_DIR/child-1/handle.json"; : > "$NI_DIR/child-2/handle.json"
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$NEXTIDX_SNIPPET" '
log_diag() { echo "DIAG $*" >&2; }
handle_writer_running() { echo "NEVER CALLED" >&2; echo 0; }
next_child_index "$1" 0' > "$TMP/nextidx.sh"
  OUT=$(bash "$TMP/nextidx.sh" "$NI_DIR" 2>"$TMP/nextidx.err")
  [ "$OUT" = 3 ] && ! grep -q 'NEVER CALLED' "$TMP/nextidx.err" && [ "$(grep -c 'still holds a handle nobody has accounted for' "$TMP/nextidx.err")" -eq 2 ]; check "next_child_index skips every directory holding a handle, a dead writer's included, and consults no writer check (got $OUT)" "$?"
  rm -f "$NI_DIR/child-1/handle.json" "$NI_DIR/child-2/handle.json"
  [ "$(bash "$TMP/nextidx.sh" "$NI_DIR" 2>/dev/null)" = 1 ]; check "next_child_index: control: a directory whose handle was cleared is reused" "$?"
fi

# --- A held handle ends the run at GATE TIMEOUT with nothing launched ---
# A handle whose supervisor pair is not numeric reads as a running writer, so
# the gate holds on it for the gate bound (three seconds here) and ends the run
# at GATE TIMEOUT: no claim is written, no child is launched, and child-1's
# handle, pid files and ask.request are exactly as they were. This is the real
# bin/supervise.sh, driven through its own gate.
RD_LIVE=$(mktemp -d "$TMP/rd-live.XXXXXX"); mkdir -p "$RD_LIVE/child-1"
printf '{"sessionId":"s","holderPid":"41180","holderWinPid":"35088","holderTicks":"639012345678901180","childPid":"41236","childWinPid":"35124","childTicks":"639012345678901237","supervisorWinPid":"x","supervisorTicks":"x","launchedAt":1000,"childIndex":1}' > "$RD_LIVE/child-1/handle.json"
printf '41180\n' > "$RD_LIVE/child-1/holder.pid"; printf '41236\n' > "$RD_LIVE/child-1/child.pid"; printf 'ask\n' > "$RD_LIVE/child-1/ask.request"
rm -f "$TMP/stub/launched"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" supervisorGateWaitS=3 bash "$SCRIPT" "$TMP/wd" modelprobe default --rundir "$RD_LIVE" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 2 ] && case "$OUT" in *"GATE TIMEOUT"*) true ;; *) false ;; esac; check "held handle: a handle whose writer cannot be ruled out ends the run at GATE TIMEOUT (rc=$RC)" "$?"
grep -q 'still running' "$RD_LIVE/supervisor.log" && grep -q 'may not take' "$RD_LIVE/supervisor.log"; check "held handle: the log names the handle held and the timeout's reason" "$?"
[ "$(cat "$RD_LIVE/child-1/holder.pid")" = 41180 ] && [ "$(cat "$RD_LIVE/child-1/child.pid")" = 41236 ] && [ "$(cat "$RD_LIVE/child-1/ask.request")" = ask ] && grep -q '"supervisorWinPid":"x"' "$RD_LIVE/child-1/handle.json"
check "held handle: the live child's handle, pid files and ask.request are untouched, so no claim was written" "$?"
! grep -q 'ADOPT\|LAUNCH child-' "$RD_LIVE/supervisor.log" && [ ! -e "$TMP/stub/launched" ] && [ ! -d "$RD_LIVE/child-2" ]; check "held handle: nothing is adopted and no child is launched beside it" "$?"

# --- A shutdown request present after a sweep ends the run before any launch ---
# The real bin/supervise.sh, with the empty HOME the refusal cases use, meets a
# handle whose writer pair and child pair both name no live process (the
# 18-digit ticks match nothing on this box, checked through the real
# PowerShell survivor check), so the gate sweeps the pairs and clears the
# handle. The shutdown request beside it then ends the run at exit 0 with the
# request removed, before the persona gate a run with no request would reach
# (exit 2, GATE FAIL) and before any launch.
RD_SWEEP=$(mktemp -d "$TMP/rd-sweepreq.XXXXXX"); mkdir -p "$RD_SWEEP/child-1"
printf '{"sessionId":"s","holderPid":"41180","holderWinPid":"35088","holderTicks":"639012345678901180","childPid":"41236","childWinPid":"35124","childTicks":"639012345678901237","supervisorWinPid":"34870","supervisorTicks":"639012345678900011","launchedAt":1000,"childIndex":1}' > "$RD_SWEEP/child-1/handle.json"
printf 'stop\n' > "$RD_SWEEP/shutdown.request"
rm -f "$TMP/stub/launched"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" timeout 120 bash "$SCRIPT" "$TMP/wd" modelprobe default --rundir "$RD_SWEEP" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 0 ] && grep -q 'SWEEP_RELAUNCH: child-1 read gone at the gate' "$RD_SWEEP/supervisor.log" && grep -q 'SHUTDOWN_REQUEST: .*shutdown.request is present at launch' "$RD_SWEEP/supervisor.log"; CHECK_RC=$?; check "a shutdown request beside a handle the gate sweeps ends the run at exit 0 after the sweep (rc=$RC, out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
[ ! -e "$RD_SWEEP/shutdown.request" ] && [ ! -e "$RD_SWEEP/child-1/handle.json" ] && [ ! -e "$TMP/stub/launched" ] && ! grep -q 'LAUNCH child-\|GATE FAIL\|GATE PASSED' "$RD_SWEEP/supervisor.log"; check "after the sweep the request and the swept handle are removed, and no child is launched and no persona gate is reached" "$?"

# --- Precision through the real chain: write, read back, identity on a live process ---
# A real process of this suite's own, its Windows pid off /proc and its start
# ticks off one PowerShell read, go through the real write_handle, the real
# read_handle_fields, and the real handle_child_identity with its real
# survivor check. The exact 18-digit pair reads live; the pair differing only
# in its last digit reads gone. A pair rounded through Number would fail the
# first, since 2^53 sits below every current tick value.
: > "$TMP/identreal.fn"
for fn in $(SUPERVISOR_CLOSURE_STUBS="log log_diag" supervisor_fn_closure "$SCRIPT" handle_child_identity); do
  supervisor_extract_fn "$SCRIPT" "$fn" "$TMP/identreal.fn" || true
done
IDENT_REAL=$(tr -d '\r' < "$TMP/identreal.fn")
[ -n "$IDENT_REAL" ] && [ -n "${WH_SNIPPET:-}" ] && [ -n "${RHF_SNIPPET:-}" ]; check "handle_child_identity's real closure, write_handle and read_handle_fields are found for the precision chain" "$?"
if [ -n "$IDENT_REAL" ] && [ -n "${WH_SNIPPET:-}" ] && [ -n "${RHF_SNIPPET:-}" ]; then
  PR_DIR=$(mktemp -d "$TMP/prec.XXXXXX")
  sleep 90 & PR_PID=$!
  PR_WIN=$(tr -d '\r\n' < "/proc/$PR_PID/winpid" 2>/dev/null)
  PR_TICKS=$(powershell -NoProfile -Command "(Get-Process -Id $PR_WIN).StartTime.Ticks" 2>/dev/null | tr -d '\r\n')
  case "$PR_TICKS" in *[!0-9]*|'') PR_TICKS="" ;; esac
  [ -n "$PR_WIN" ] && [ "${#PR_TICKS}" -ge 18 ] && [ "$PR_TICKS" -ge 639012345678901237 ]; check "precision setup: a live process's Windows pid and 18-digit start ticks were read (${PR_WIN:-none},${PR_TICKS:-none})" "$?"
  PR_LAST="${PR_TICKS: -1}"; PR_OTHER="${PR_TICKS%?}$(( (PR_LAST + 1) % 10 ))"
  printf '%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$WH_SNIPPET" "$RHF_SNIPPET" "$IDENT_REAL" '
log() { :; }; log_diag() { :; }; ensure_self_ticks() { :; }
SUPERVISOR_PS_BOUND_S=30; STOP_PS_SENTINEL=___SUPERVISOR_PS_DONE___
RUNDIR="$1"; HANDLE_FILE="$1/handle.json"; CHILD_INDEX=1; LAUNCHED_AT=1000
SELF_WINPID="$2"; SELF_TICKS="$3"; HOLDER_LAUNCH_PID=41180; HOLDER_WINPID="$2"; HOLDER_TICKS="$3"; CHILD_LAUNCH_PID=41236; CHILD_WINPID="$2"; CHILD_TICKS="$3"
write_handle sess-p
win=""; tick=""
while IFS=$'"'"'\t'"'"' read -r key val; do case "$key" in childWinPid) win="$val" ;; childTicks) tick="$val" ;; esac; done < <(read_handle_fields "$HANDLE_FILE")
echo "READBACK $win,$tick"
echo "EXACT $(handle_child_identity "$win" "$tick")"
echo "LASTDIGIT $(handle_child_identity "$win" "$4")"' > "$TMP/prec.sh"
  OUT=$(timeout 200 bash "$TMP/prec.sh" "$PR_DIR" "$PR_WIN" "$PR_TICKS" "$PR_OTHER" 2>&1)
  printf '%s\n' "$OUT" | grep -qx "READBACK $PR_WIN,$PR_TICKS"; CHECK_RC=$?; check "precision chain: the live pair written through write_handle reads back byte-equal through read_handle_fields (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  printf '%s\n' "$OUT" | grep -qx 'EXACT live'; check "precision chain: the exact 18-digit pair, read back off the handle, passes the real identity check as live" "$?"
  printf '%s\n' "$OUT" | grep -qx 'LASTDIGIT gone'; check "precision chain: the pair differing only in its last digit ($PR_OTHER) fails the real identity check as gone" "$?"
  kill "$PR_PID" 2>/dev/null; wait "$PR_PID" 2>/dev/null
fi

# --- Waiting on a marker in a file, bounded, never a fixed sleep ---
# Usage: wait_for_line <file> <grep pattern> <max tenths of a second>
wait_for_line() {
  local i=0
  while [ "$i" -lt "$3" ]; do
    grep -q -e "$2" "$1" 2>/dev/null && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
# Usage: wait_for_exit <pid> <max tenths of a second>
wait_for_exit() {
  local i=0
  while [ "$i" -lt "$2" ]; do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}

# --- A frozen child the gate adopts receives the final ask, and a prompt an
# --- ADOPT start cannot send is logged dropped ---
# The real bin/supervise.sh, driven through its own gate onto a handle whose
# writer pair names no process and whose child pair names a live process of
# this suite's own: a sleep, its Windows pid off /proc and its start ticks off
# one PowerShell read, as the precision chain reads them. The gate's poll
# reads that child frozen on real fixtures rather than a stubbed verdict: the
# transcript's newest turn record and the stream's modification time are
# years old, the child's heartbeat file is stamped at epoch 1000, the mailbox
# holds an unacknowledged probe from epoch 1000, and the real walk finds the
# sleep live. The run is then signaled, which detaches from the child (the
# handle is readable and the verdict is not gone) at exit 143, so the sleep is
# still this suite's to kill and nothing the ask wrote is removed.
FA_DIR=$(mktemp -d "$TMP/rd-frozenadopt.XXXXXX"); mkdir -p "$FA_DIR/child-1" "$TMP/home-adopt"
sleep 120 & FA_PID=$!
FA_WIN=$(tr -d '\r\n' < "/proc/$FA_PID/winpid" 2>/dev/null)
FA_TICKS=$(powershell -NoProfile -Command "(Get-Process -Id $FA_WIN).StartTime.Ticks" 2>/dev/null | tr -d '\r\n')
case "$FA_TICKS" in *[!0-9]*|'') FA_TICKS="" ;; esac
[ -n "$FA_WIN" ] && [ "${#FA_TICKS}" -ge 18 ]; check "frozen adopt setup: a live sleep's Windows pid and 18-digit start ticks were read (${FA_WIN:-none},${FA_TICKS:-none})" "$?"
printf '{"sessionId":"sess-frozen","holderPid":"41180","holderWinPid":"35088","holderTicks":"639012345678901180","childPid":"%s","childWinPid":"%s","childTicks":"%s","supervisorWinPid":"34870","supervisorTicks":"639012345678900011","launchedAt":1000,"childIndex":1}' "$FA_PID" "$FA_WIN" "$FA_TICKS" > "$FA_DIR/child-1/handle.json"
: > "$FA_DIR/child-1/stdout.jsonl"; touch -d '2020-01-01 00:00:00' "$FA_DIR/child-1/stdout.jsonl"
printf '{"sessionId":"sess-frozen","lastSeen":1000}' > "$FA_DIR/heartbeat.json"
printf '{"id":"1-1","kind":"probe","at":1000,"text":"probe"}\n' > "$FA_DIR/mailbox.jsonl"
# The transcript sits where the real reader derives it: under the profile the
# run is handed as HOME, keyed by the workdir's Windows path through the real
# projectKey, named by the session id the handle carries.
FA_KEY=$(node --input-type=module -e "import { pathToFileURL } from 'node:url'; const m = await import(pathToFileURL(process.argv[1]).href); console.log(m.projectKey(process.argv[2]));" "$HERE/../bin/supervise-liveness.mjs" "$(cygpath -w "$TMP/wd")" 2>/dev/null)
mkdir -p "$TMP/home-adopt/.claude/projects/$FA_KEY"
printf '{"type":"assistant","timestamp":"2020-01-01T00:00:00.000Z"}\n' > "$TMP/home-adopt/.claude/projects/$FA_KEY/sess-frozen.jsonl"
rm -f "$TMP/stub/launched"
env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home-adopt" supervisorPollMs=1000 supervisorGateWaitS=3 \
  bash "$SCRIPT" "$TMP/wd" modelprobe default --rundir "$FA_DIR" --no-channel --prompt "a goal the adopted child never receives" > "$FA_DIR/drive.out" 2>&1 &
FA_SUP=$!
# The window the ask is pinned once across: the adoption, then six polls of
# the loop, which is the first WAITING line and follows the adoption within
# about ten seconds at the one second poll.
wait_for_line "$FA_DIR/supervisor.log" 'ADOPT child-1' 900; FA_ADOPTED=$?
wait_for_line "$FA_DIR/supervisor.log" 'WAITING: child-1 alive' 300; FA_POLLED=$?
kill -TERM "$FA_SUP" 2>/dev/null
wait "$FA_SUP" 2>/dev/null; FA_RC=$?
kill "$FA_PID" 2>/dev/null; wait "$FA_PID" 2>/dev/null
[ "$FA_ADOPTED" -eq 0 ] && [ "$FA_POLLED" -eq 0 ] && grep -q 'ADOPT child-1: .*verdict frozen' "$FA_DIR/supervisor.log" && [ "$FA_RC" -eq 143 ] && grep -q 'DETACH child-1' "$FA_DIR/supervisor.log"; CHECK_RC=$?
check "frozen adopt control: the gate adopted the sleep as child-1 on a frozen verdict, the loop polled it six times, and the signal detached at 143 (adopted=$FA_ADOPTED polled=$FA_POLLED rc=$FA_RC, log=$(tr '\n' '|' < "$FA_DIR/supervisor.log" 2>/dev/null | tail -c 1500))" "$CHECK_RC"
FA_ASK_ID=$(sed -n 's/.*FINAL_ASK child-1: .*(ask id=\([^ ]*\) written to .*/\1/p' "$FA_DIR/supervisor.log" 2>/dev/null | head -1)
[ "$(grep -c 'FINAL_ASK child-1' "$FA_DIR/supervisor.log" 2>/dev/null)" -eq 1 ] && [ -n "$FA_ASK_ID" ] && [ "$(wc -l < "$FA_DIR/child-1/ask.request" 2>/dev/null | tr -d ' ')" = 1 ] && grep -q "\[SUPERVISOR-ASK id=$FA_ASK_ID\]" "$FA_DIR/child-1/ask.request" 2>/dev/null; CHECK_RC=$?
check "frozen adopt: the ADOPT of a frozen child logs FINAL_ASK once across six polls and writes ask.request once, carrying the logged id in the [SUPERVISOR-ASK id=] marker (ask lines: $(grep -c 'FINAL_ASK child-1' "$FA_DIR/supervisor.log" 2>/dev/null), id=${FA_ASK_ID:-none}, file=$(tr '\n' '|' < "$FA_DIR/child-1/ask.request" 2>/dev/null | head -c 200))" "$CHECK_RC"
grep -q 'PROMPT_DROPPED child-1' "$FA_DIR/supervisor.log" 2>/dev/null && ! ls "$FA_DIR"/child-*.prompt >/dev/null 2>&1 && ! grep -q 'PASSIVE: no prompt given' "$FA_DIR/supervisor.log" 2>/dev/null; CHECK_RC=$?
check "frozen adopt: an ADOPT start given --prompt logs the prompt dropped and writes no prompt file (log=$(grep -c 'PROMPT_DROPPED child-1' "$FA_DIR/supervisor.log" 2>/dev/null), files=$(ls "$FA_DIR"/child-*.prompt 2>/dev/null | tr '\n' ' '))" "$CHECK_RC"
[ ! -e "$TMP/stub/launched" ] && ! grep -q 'LAUNCH child-' "$FA_DIR/supervisor.log" 2>/dev/null; check "frozen adopt: nothing was launched beside the adopted child" "$?"

# --- The prompt reaches the run's first launch whatever its index ---
# The gate sweeps a handle whose pairs name nothing (the real PowerShell
# survivor check over 18-digit ticks that match no process), which raises the
# index so the run's first launch is child-2. With --prompt given, the prompt
# file is written for that child, named by the index the LAUNCH line carries,
# and the LAUNCH line's prompt=set is true. The stub claude exits 1 at once,
# so the run ends at the crash limit as the launch control does.
P2_DIR=$(mktemp -d "$TMP/rd-prompt2.XXXXXX"); mkdir -p "$P2_DIR/child-1"
printf '{"sessionId":"s","holderPid":"41180","holderWinPid":"35088","holderTicks":"639012345678901180","childPid":"41236","childWinPid":"35124","childTicks":"639012345678901237","supervisorWinPid":"34870","supervisorTicks":"639012345678900011","launchedAt":1000,"childIndex":1}' > "$P2_DIR/child-1/handle.json"
rm -f "$TMP/stub/launched"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home-free" supervisorCrashLimit=1 supervisorPollMs=1000 timeout 120 bash "$SCRIPT" "$TMP/wd-launch" modelprobe default --rundir "$P2_DIR" --no-channel --prompt "the goal for the first launch" 2>&1)
RC=$?
P2_IDX=$(sed -n 's/.*LAUNCH child-\([0-9]*\) (start_ts=.*/\1/p' "$P2_DIR/supervisor.log" 2>/dev/null | head -1)
[ "$RC" -eq 3 ] && [ -e "$TMP/stub/launched" ] && grep -q 'SWEEP_RELAUNCH: child-1 read gone at the gate' "$P2_DIR/supervisor.log" && [ "${P2_IDX:-1}" -ge 2 ] && grep -q "LAUNCH child-$P2_IDX (start_ts=[0-9]*, prompt=set)" "$P2_DIR/supervisor.log"; CHECK_RC=$?
check "first launch child-2 or later, control: the sweep raised the index, the first launch is child-${P2_IDX:-?} with prompt=set, and the run ends at the crash limit (rc=$RC)" "$CHECK_RC"
[ -n "$P2_IDX" ] && [ "$(cat "$P2_DIR/child-$P2_IDX.prompt" 2>/dev/null)" = "the goal for the first launch" ]; CHECK_RC=$?
check "first launch child-2 or later: the prompt file is written for the child the LAUNCH line names, child-${P2_IDX:-?}, with the prompt's text (files: $(ls "$P2_DIR"/child-*.prompt 2>/dev/null | tr '\n' ' '))" "$CHECK_RC"

# --- A shutdown the child records while a restart_passive stop is stopping it
# --- is honored at the loop head, before any launch ---
# The real bin/supervise.sh launches a stub claude that writes one user
# record to its stream and then sleeps, so the child reads busy. A
# restart.request written after the launch takes restart_passive on the next
# poll, and its stop enters the patient wait, capped at three seconds here.
# During that wait the persona store gains a shutdown_requested newer than
# the child's start, which no poll can see because no poll runs inside a
# stop. The loop head reads it and ends the run at exit 0 with no second
# launch. The leftover pids are killed by the pid files the launch wrote,
# never by name.
mkdir -p "$TMP/stub-hold" "$TMP/wd-hold"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "{\\"type\\":\\"user\\",\\"message\\":{\\"role\\":\\"user\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"work\\"}]}}"\nexec sleep 40\n' > "$TMP/stub-hold/claude"
chmod +x "$TMP/stub-hold/claude"
RP_DIR=$(mktemp -d "$TMP/rd-passive.XXXXXX")
env -i PATH="$TMP/stub-hold:$PATH" HOME="$TMP/home-free" supervisorPollMs=1000 supervisorStopGraceMs=1000 supervisorStopBusyCapMs=3000 supervisorCrashLimit=1 supervisorGateWaitS=3 \
  bash "$SCRIPT" "$TMP/wd-hold" modelprobe default --rundir "$RP_DIR" --no-channel > "$RP_DIR/drive.out" 2>&1 &
RP_SUP=$!
wait_for_line "$RP_DIR/supervisor.log" 'LAUNCH child-1' 600; RP_LAUNCHED=$?
# Both timestamps come off the shell's own date, as the stop's clock does,
# rather than a node spawn, so the store write lands well inside the three
# second cap the patient wait runs to.
printf '{"at":%s,"by":"suite","reason":"restart"}' "$(date +%s%3N)" > "$RP_DIR/restart.request"
wait_for_line "$RP_DIR/supervisor.log" 'STOP\[restart_passive\]: the child is inside a turn' 600; RP_WAITING=$?
printf '{"modelprobe":{"decisions":[{"action":"shutdown_requested","timestamp":%s,"detail":"the child banked its state during the stop"}]}}' "$(date +%s%3N)" > "$TMP/wd-hold/.agentic-personas.json"
wait_for_exit "$RP_SUP" 900; RP_ENDED=$?
if [ "$RP_ENDED" -ne 0 ]; then kill -TERM "$RP_SUP" 2>/dev/null; fi
wait "$RP_SUP" 2>/dev/null; RP_RC=$?
for f in "$RP_DIR"/child-*/child.pid "$RP_DIR"/child-*/holder.pid; do
  RP_PID=$(cat "$f" 2>/dev/null | tr -d '\r\n')
  case "$RP_PID" in *[!0-9]*|'') ;; *) kill -9 "$RP_PID" 2>/dev/null ;; esac
done
[ "$RP_LAUNCHED" -eq 0 ] && [ "$RP_WAITING" -eq 0 ] && grep -q 'RESTART_PASSIVE: restart_requested at' "$RP_DIR/supervisor.log" && grep -q 'wait_ended=cap' "$RP_DIR/supervisor.log"; CHECK_RC=$?
check "loop-head shutdown control: the request took restart_passive and its stop ran the patient wait to the cap while the store gained the shutdown (launched=$RP_LAUNCHED waiting=$RP_WAITING, log=$(tr '\n' '|' < "$RP_DIR/supervisor.log" 2>/dev/null | tail -c 1500))" "$CHECK_RC"
RP_RESTART_LINE=$(grep -n 'RESTART_PASSIVE: restart_requested' "$RP_DIR/supervisor.log" 2>/dev/null | head -1 | cut -d: -f1)
RP_STOP_LINE=$(grep -n 'STOP_COMPLETE: shutdown_requested at' "$RP_DIR/supervisor.log" 2>/dev/null | head -1 | cut -d: -f1)
[ "$RP_ENDED" -eq 0 ] && [ "$RP_RC" -eq 0 ] && [ -n "$RP_RESTART_LINE" ] && [ -n "$RP_STOP_LINE" ] && [ "$RP_RESTART_LINE" -lt "$RP_STOP_LINE" ] && [ "$(grep -c 'LAUNCH child-' "$RP_DIR/supervisor.log" 2>/dev/null)" -eq 1 ]; CHECK_RC=$?
check "loop-head shutdown: a shutdown_requested recorded during a restart_passive stop is honored at the loop head, exit 0 with STOP_COMPLETE after RESTART_PASSIVE and no second launch (ended=$RP_ENDED rc=$RP_RC launches=$(grep -c 'LAUNCH child-' "$RP_DIR/supervisor.log" 2>/dev/null))" "$CHECK_RC"

# --- A signal to a relaunched child routes on that child's own liveness
# --- reading, never on the reading the swept child earned ---
# The real bin/supervise.sh launches a stub claude that names a session id on
# its first line and then waits on its input, which the holder holds open,
# until a marker file ends it. The child reads frozen on real fixtures: the
# transcript the suite seeds under the profile is years old, the child's
# heartbeat file is stamped at epoch 1000, the silence bound is three seconds
# and the probe's window four, so the second poll writes the final ask. The
# marker then ends the stub inside the next poll's three second sleep, so that
# poll's walk completes and finds nothing while every signal stays silent: the
# reading is gone, the loop sweeps child-1 and launches child-2. The run is
# signaled once child-2's handle is written and before its first poll. The
# trap routes on the liveness reading, and with no reading yet for child-2 it
# reads alive and detaches; a trap still carrying child-1's gone reading stops
# child-2 instead. The control signals after child-2's first poll, where the
# trap reads that poll's verdict. Both drives leave the stub and its holder
# running, and end them by the marker and the pid files the launch wrote,
# never by name.
mkdir -p "$TMP/stub-relaunch" "$TMP/wd-relaunch" "$TMP/home-relaunch/.claude/plugins/store"
printf '{}' > "$TMP/home-relaunch/.claude/plugins/store/agentic-plugin_agent-persona-modelprobe.json"
RL_DIE="$TMP/relaunch-die"
# The stub reads its input with a timeout rather than sleeping, so it spawns
# no process of its own and the child's tree record holds still across polls.
# End of input ends it too, which is the pipe-close stop the unfixed code takes.
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"sess-relaunch\\"}"\nwhile [ ! -f "%s" ]; do read -r -t 0.2 line; rc=$?; [ "$rc" -gt 128 ] || [ "$rc" -eq 0 ] || exit 0; done\nexit 0\n' "$RL_DIE" > "$TMP/stub-relaunch/claude"
chmod +x "$TMP/stub-relaunch/claude"
RL_KEY=$(node --input-type=module -e "import { pathToFileURL } from 'node:url'; const m = await import(pathToFileURL(process.argv[1]).href); console.log(m.projectKey(process.argv[2]));" "$HERE/../bin/supervise-liveness.mjs" "$(cygpath -w "$TMP/wd-relaunch")" 2>/dev/null)
mkdir -p "$TMP/home-relaunch/.claude/projects/$RL_KEY"
printf '{"type":"assistant","timestamp":"2020-01-01T00:00:00.000Z"}\n' > "$TMP/home-relaunch/.claude/projects/$RL_KEY/sess-relaunch.jsonl"
# Usage: wait_for_file <path> <max tenths of a second>
wait_for_file() {
  local i=0
  while [ "$i" -lt "$2" ]; do
    [ -f "$1" ] && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
# Usage: relaunch_drive <rundir> <before|after>, the moment the TERM is sent
# relative to child-2's first poll. Sets RL_FROZEN, RL_DIED, RL_RELAUNCHED,
# RL_READY (each 0 where the wait it names landed), RL_RC (the run's exit
# code), RL_ALIVE (0 where child-2's launch pid still answers after the run
# ended) and RL_LOG.
relaunch_drive() {
  local rd="$1" when="$2" f p
  rm -f "$RL_DIE"
  mkdir -p "$rd"
  RL_LOG="$rd/supervisor.log"
  printf '{"sessionId":"sess-relaunch","lastSeen":1000}' > "$rd/heartbeat.json"
  env -i PATH="$TMP/stub-relaunch:$PATH" HOME="$TMP/home-relaunch" supervisorPollMs=3000 controllerTickMs=500 supervisorSilenceBoundMs=3000 supervisorProbeMs=60000 supervisorStopGraceMs=1000 supervisorStopBusyCapMs=1000 supervisorGateWaitS=3 \
    bash "$SCRIPT" "$TMP/wd-relaunch" modelprobe default --rundir "$rd" --no-channel > "$rd/drive.out" 2>&1 &
  RL_SUP=$!
  wait_for_line "$RL_LOG" 'FINAL_ASK child-1' 600; RL_FROZEN=$?
  # The poll that asked returns to the loop head and sleeps three seconds; the
  # stub ends about a second and a half in, so the next poll's walk finds it
  # gone. The marker is cleared once the wrapper has written the exit marker,
  # before child-2 can launch and read it.
  sleep 1.5
  : > "$RL_DIE"
  wait_for_file "$rd/child-1/.exit" 100; RL_DIED=$?
  rm -f "$RL_DIE"
  wait_for_line "$RL_LOG" 'LAUNCH child-2' 600; RL_RELAUNCHED=$?
  if [ "$when" = before ]; then
    wait_for_file "$rd/child-2/handle.json" 300; RL_READY=$?
  else
    wait_for_line "$RL_LOG" 'LIVENESS child-2:' 300; RL_READY=$?
  fi
  kill -TERM "$RL_SUP" 2>/dev/null
  wait "$RL_SUP" 2>/dev/null; RL_RC=$?
  p=$(tr -d '\r\n' < "$rd/child-2/child.pid" 2>/dev/null)
  case "$p" in *[!0-9]*|'') RL_ALIVE=2 ;; *) if kill -0 "$p" 2>/dev/null; then RL_ALIVE=0; else RL_ALIVE=1; fi ;; esac
  : > "$RL_DIE"
  # The stub polls the marker on a 0.2 s read timeout, and the next drive
  # removes the marker first, so the stub is given time to see it and exit.
  sleep 0.5
  for f in "$rd"/child-*/child.pid "$rd"/child-*/holder.pid; do
    p=$(tr -d '\r\n' < "$f" 2>/dev/null)
    case "$p" in *[!0-9]*|'') ;; *) kill -9 "$p" 2>/dev/null ;; esac
  done
}
relaunch_drive "$(mktemp -d "$TMP/rd-relaunch.XXXXXX")" before
[ "$RL_FROZEN" -eq 0 ] && [ "$RL_DIED" -eq 0 ] && [ "$RL_RELAUNCHED" -eq 0 ] && grep -q 'LIVENESS child-1: gone' "$RL_LOG" && grep -q 'EXIT child-1 code=0 (sweep_relaunch)' "$RL_LOG"; CHECK_RC=$?
check "relaunch signal control: child-1 read frozen on real fixtures, the marker ended it inside a poll's sleep, that poll read it gone, and the loop swept it and launched child-2 (frozen=$RL_FROZEN died=$RL_DIED relaunched=$RL_RELAUNCHED, log=$(tr '\n' '|' < "$RL_LOG" 2>/dev/null | tail -c 1500))" "$CHECK_RC"
[ "$RL_READY" -eq 0 ] && [ "$RL_RC" -eq 143 ] && grep -q 'DETACH child-2' "$RL_LOG" && ! grep -q 'CLEANUP: stopping child-2' "$RL_LOG" && ! grep -q 'LIVENESS child-2:' "$RL_LOG" && [ "$RL_ALIVE" -eq 0 ]; CHECK_RC=$?
check "relaunch signal: a TERM after child-2's handle is written and before its first poll detaches at 143 and leaves child-2 running, rather than stopping it on child-1's gone reading (ready=$RL_READY rc=$RL_RC alive=$RL_ALIVE, log=$(tr '\n' '|' < "$RL_LOG" 2>/dev/null | tail -c 1500))" "$CHECK_RC"
relaunch_drive "$(mktemp -d "$TMP/rd-relaunch.XXXXXX")" after
RL_VERDICT=$(sed -n 's/.*LIVENESS child-2: \([a-z]*\) .*/\1/p' "$RL_LOG" 2>/dev/null | head -1)
RL_LIVE_LINE=$(grep -n 'LIVENESS child-2:' "$RL_LOG" 2>/dev/null | head -1 | cut -d: -f1)
RL_DETACH_LINE=$(grep -n 'DETACH child-2' "$RL_LOG" 2>/dev/null | head -1 | cut -d: -f1)
[ "$RL_RELAUNCHED" -eq 0 ] && grep -q 'EXIT child-1 code=0 (sweep_relaunch)' "$RL_LOG" && [ "$RL_READY" -eq 0 ] && [ "$RL_RC" -eq 143 ] && [ -n "$RL_VERDICT" ] && [ -n "$RL_LIVE_LINE" ] && [ -n "$RL_DETACH_LINE" ] && [ "$RL_LIVE_LINE" -lt "$RL_DETACH_LINE" ] && grep -q "DETACH child-2: .*(verdict $RL_VERDICT)" "$RL_LOG" && ! grep -q 'CLEANUP: stopping child-2' "$RL_LOG" && [ "$RL_ALIVE" -eq 0 ]; CHECK_RC=$?
check "relaunch signal control: after the same sweep and relaunch, a TERM after child-2's first poll detaches on child-2's own reading, the verdict the DETACH line names being the one its LIVENESS line logged (verdict=${RL_VERDICT:-none} ready=$RL_READY rc=$RL_RC alive=$RL_ALIVE, log=$(tr '\n' '|' < "$RL_LOG" 2>/dev/null | tail -c 1500))" "$CHECK_RC"

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
