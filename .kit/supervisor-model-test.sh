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
log() { :; }
CHILD_LAUNCH_PID="$1"; CHILD_INDEX=1; CHILD_TREE_WINPIDS=""; CHILD_TREE_FAILED_CONFIRMS=0
refresh_child_tree
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
  # pid its handle recorded: a root resolving to another pid is a walk that
  # did not complete, and the recorded pid itself is a walk that found it.
  LIVE_ROW="$(printf '%9s %7s %7s %10s  pty0     197609 12:00:00 /usr/bin/sleep' "$LIVE_ROOT" 1 "$LIVE_ROOT" "9$LIVE_ROOT")"
  OUT=$(CHILD_ADOPTED=1 CHILD_WINPID=555 TABLE_ROW="$LIVE_ROW" bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  [ "$OUT" = "WALK=failed" ]; check "an adopted child whose launch pid runs as a Windows pid other than the one its handle recorded reads as a walk that did not complete (got $OUT)" "$?"
  OUT=$(CHILD_ADOPTED=1 CHILD_WINPID="9$LIVE_ROOT" TABLE_ROW="$LIVE_ROW" bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  [ "$OUT" = "WALK=live" ]; check "control: an adopted child whose launch pid runs as the recorded Windows pid reads as a walk that found it (got $OUT)" "$?"
  OUT=$(CHILD_ADOPTED= CHILD_WINPID=555 TABLE_ROW="$LIVE_ROW" bash "$TMP/refresh.sh" "$LIVE_ROOT" 2>&1)
  [ "$OUT" = "WALK=live" ]; check "control: a launched child's walk is not checked against a recorded Windows pid (got $OUT)" "$?"
  kill "$LIVE_ROOT" 2>/dev/null
  wait "$LIVE_ROOT" 2>/dev/null
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
'"$EXITM_SNIPPET"'
if [ "${WRAPPER:-dead}" = live ]; then sleep 30 & else ( exit 7 ) & fi
CHILD_LAUNCH_PID=$!
[ "${WRAPPER:-dead}" = live ] || sleep 1
CHILD_INDEX=1; DECIDE_REASON="gone: test"; EXIT_MARKER="$1"; STOP_PATH=eof
echo "${MARKER_CODE:-7}" > "$EXIT_MARKER"
LAUNCHED_AT="${LAUNCHED_AT_STUB-$(node -e "console.log(Date.now())")}"; SUPERVISOR_MIN_RUN_MS=120000
CRASH_COUNT="${CRASH_COUNT_START:-0}"; RESTART_COUNT=0; SUPERVISOR_MAX_RESTARTS_PER_HOUR=6; SUPERVISOR_CRASH_LIMIT=3
sweep_gone_child
echo "RETURNED crash=$CRASH_COUNT restarts=$RESTART_COUNT marker=$(cat "$1")"' > "$TMP/sweep.sh"
  sweep_run() { timeout 60 bash "$TMP/sweep.sh" "$TMP/sweep.exit" 2>&1; }
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
  wr_i=0
  while [ -n "$WR_INNER" ] && kill -0 "$WR_INNER" 2>/dev/null && [ "$wr_i" -lt 20 ]; do sleep 0.5; wr_i=$((wr_i + 1)); done
  [ -n "$WR_INNER" ] && ! kill -0 "$WR_INNER" 2>/dev/null; check "child_wrapper: the inner process (pid ${WR_INNER:-unknown}) is gone within a few seconds of the wrapper's TERM" "$?"
  kill -9 "$WR_INNER" 2>/dev/null; true
  # stdin reaches the inner process through the pipe.
  printf '%s\n%s\nchild_wrapper "$1" bash -c '"'"'IFS= read -r l; printf "%%s" "$l" > "$1"'"'"' _ "$2"\n' "$STUB_OPTIONS" "$WRAP_SNIPPET" > "$TMP/wrap2.sh"
  printf 'from-the-pipe\n' | bash "$TMP/wrap2.sh" "$WR_DIR/marker2" "$WR_DIR/seen"
  [ "$(cat "$WR_DIR/seen" 2>/dev/null)" = "from-the-pipe" ] && [ "$(cat "$WR_DIR/marker2" 2>/dev/null)" = "0" ]; check "child_wrapper: the inner process reads the pipeline's stdin and a clean exit records 0" "$?"
  # The TERM trap is installed before the fork, so a signal landing between
  # the two is not lost: the trap's line precedes the fork's in the body.
  WR_TRAP_LINE=$(printf '%s\n' "$WRAP_SNIPPET" | grep -n "^  trap 'kill -TERM" | head -1 | cut -d: -f1)
  WR_FORK_LINE=$(printf '%s\n' "$WRAP_SNIPPET" | grep -n '^  "\$@" <&0 &$' | head -1 | cut -d: -f1)
  [ -n "$WR_TRAP_LINE" ] && [ -n "$WR_FORK_LINE" ] && [ "$WR_TRAP_LINE" -lt "$WR_FORK_LINE" ]; check "child_wrapper: the TERM trap is installed before the child is forked (trap line ${WR_TRAP_LINE:-none} < fork line ${WR_FORK_LINE:-none})" "$?"
fi

# --- The writer-running and child-identity checks ---
# Each is extracted and driven with handle_field and check_snapshot_survivors
# stubbed from the environment. A writer pair that is absent or not numeric
# reads as running, so the gate waits; a child pair that is absent or not
# numeric reads unverified, so the gate waits rather than adopting.
WRITER_SNIPPET=$(sed -n '/^handle_writer_running() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
IDENT_SNIPPET=$(sed -n '/^handle_child_identity() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$WRITER_SNIPPET" ] && [ -n "$IDENT_SNIPPET" ]; check "handle_writer_running and handle_child_identity are found in bin/supervise.sh" "$?"
if [ -n "$WRITER_SNIPPET" ] && [ -n "$IDENT_SNIPPET" ]; then
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$WRITER_SNIPPET" '
handle_field() { case "$2" in supervisorWinPid) printf "%s" "${WIN:-}" ;; supervisorTicks) printf "%s" "${TICK:-}" ;; esac; }
check_snapshot_survivors() { printf "%s" "${SURV_OUT:-}"; return "${SURV_RC:-0}"; }
handle_writer_running /any' > "$TMP/writer.sh"
  wr() { env "$@" bash "$TMP/writer.sh"; }
  [ "$(wr WIN= TICK=)" = 1 ]; check "writer-running: an absent supervisor pair reads as running" "$?"
  [ "$(wr WIN=x TICK=5)" = 1 ]; check "writer-running: a non-numeric supervisor pid reads as running" "$?"
  [ "$(wr WIN=4 TICK=5 SURV_OUT= SURV_RC=0)" = 0 ]; check "writer-running: a numeric pair with no survivor reads as dead" "$?"
  [ "$(wr WIN=4 TICK=5 SURV_OUT=4 SURV_RC=0)" = 1 ]; check "writer-running: a numeric pair still live reads as running" "$?"
  [ "$(wr WIN=4 TICK=5 SURV_OUT= SURV_RC=1)" = 1 ]; check "writer-running: an unverifiable check reads as running" "$?"
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$IDENT_SNIPPET" '
check_snapshot_survivors() { printf "%s" "${SURV_OUT:-}"; return "${SURV_RC:-0}"; }
handle_child_identity "${WIN:-}" "${TICK:-}"' > "$TMP/ident.sh"
  id() { env "$@" bash "$TMP/ident.sh"; }
  [ "$(id WIN= TICK=)" = unverified ]; check "child identity: an absent pair reads unverified" "$?"
  [ "$(id WIN=4 TICK=5 SURV_RC=1)" = unverified ]; check "child identity: a check that did not complete reads unverified" "$?"
  [ "$(id WIN=4 TICK=5 SURV_OUT=)" = gone ]; check "child identity: a pair no live process holds reads gone" "$?"
  [ "$(id WIN=4 TICK=5 SURV_OUT=4)" = live ]; check "child identity: a pair a live process holds reads live" "$?"
fi

# --- The gate's handle read, driven with the path shape production produces ---
# newest_handle is the real function from bin/agentic-common.sh, run over a
# real directory: node prints a joined path with backslashes on this box, so
# the function prints the child directory's name alone and the gate builds the
# path in bash. gate_read_handle is then driven on that name with the real
# read_handle_fields over a real handle.json; identity, the claim, the walk
# and the poll are stubbed. The claim is written only once the identity reads
# live, is read back, and is read back again after the gate poll.
# Both node scripts close a loop with a brace at column 0, so each is
# extracted through the shared brace-aware extractor rather than a sed range
# that ends at the first bare brace.
. "$HERE/supervisor-fn-extract.sh"
: > "$TMP/nh.fn"; supervisor_extract_fn "$COMMON" newest_handle "$TMP/nh.fn" || true
NH_SNIPPET=$(tr -d '\r' < "$TMP/nh.fn")
: > "$TMP/rhf.fn"; supervisor_extract_fn "$COMMON" read_handle_fields "$TMP/rhf.fn" || true
RHF_SNIPPET=$(tr -d '\r' < "$TMP/rhf.fn")
GATEREAD_SNIPPET=$(sed -n '/^gate_read_handle() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$GATEREAD_SNIPPET" ] && [ -n "$NH_SNIPPET" ] && [ -n "$RHF_SNIPPET" ]; check "gate_read_handle, newest_handle and read_handle_fields are found in their scripts" "$?"
if [ -n "$GATEREAD_SNIPPET" ] && [ -n "$NH_SNIPPET" ] && [ -n "$RHF_SNIPPET" ] && [ -n "$GATE_ROUTE_SNIPPET" ]; then
  GR_DIR=$(mktemp -d "$TMP/gateread.XXXXXX"); mkdir -p "$GR_DIR/child-1" "$GR_DIR/child-2" "$GR_DIR/child-3" "$GR_DIR/notachild"
  printf '{"sessionId":"sess-old","childPid":1,"childWinPid":1,"childTicks":1,"holderPid":1,"holderWinPid":1,"holderTicks":1,"supervisorWinPid":1,"supervisorTicks":1,"launchedAt":1000}' > "$GR_DIR/child-1/handle.json"
  printf '{"sessionId":"sess-1","childPid":77,"childWinPid":4,"childTicks":5,"holderPid":88,"holderWinPid":6,"holderTicks":7,"supervisorWinPid":9,"supervisorTicks":9,"launchedAt":2000}' > "$GR_DIR/child-2/handle.json"
  printf '{"sessionId":"sess-3","childPid":"x77","childWinPid":4,"childTicks":5}' > "$GR_DIR/child-3/handle.json"
  : > "$GR_DIR/notachild/handle.json"
  printf '%s\n%s\nnewest_handle "$1"\n' "$STUB_OPTIONS" "$NH_SNIPPET" > "$TMP/nh.sh"
  NH_NAME=$(bash "$TMP/nh.sh" "$GR_DIR" 2>"$TMP/nh.err")
  [ "$NH_NAME" = "child-2" ]; check "newest_handle over a real directory prints the newest child directory's name and nothing of the path (got '$NH_NAME')" "$?"
  grep -qx 'OLDER child-1' "$TMP/nh.err"; check "newest_handle names the older handle it passed over" "$?"
  printf '%s\n%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$GATE_ROUTE_SNIPPET" "$RHF_SNIPPET" "$GATEREAD_SNIPPET" '
log() { echo "LOG $*"; }
write_handle() { echo "CALL write_handle sess=$1"; }
CLAIMS=0
claim_is_ours() { CLAIMS=$((CLAIMS + 1)); if [ "$CLAIMS" -eq 2 ] && [ "${CLAIM2:-1}" = 0 ]; then return 1; fi; [ "${CLAIM:-1}" = 1 ]; }
handle_child_identity() { echo "IDENT($1,$2)" >&2; echo "${IDENT:-live}"; }
refresh_child_tree() { echo "CALL refresh"; }
run_child_poll() { echo "CALL poll"; DECIDE_ACTION="continue"; DECIDE_ERR="${POLL_ERR:-0}"; POLL_LIVENESS="${LIVE:-alive signal}"; }
RUNDIR="$1"; CHILD_LAUNCH_PID=""; CHILD_INDEX=0
gate_read_handle "$2"
echo "ROUTE=$GATE_ROUTE VERDICT=$VERDICT INDEX=$CHILD_INDEX PID=[$CHILD_LAUNCH_PID] HANDLE=${HANDLE_FILE:-} LAUNCHED=[${LAUNCHED_AT:-}] CLAIMS=$CLAIMS"' > "$TMP/gateread.sh"
  gr() { env "$@" bash "$TMP/gateread.sh" "$GR_DIR" "$NH_NAME" 2>&1; }
  OUT=$(gr IDENT=live LIVE="alive signal")
  printf '%s\n' "$OUT" | grep -q 'ROUTE=ADOPT VERDICT=alive INDEX=2 PID=\[77\] HANDLE=.*/child-2/handle.json LAUNCHED=\[2000\] CLAIMS=2'; CHECK_RC=$?; check "gate read on the name newest_handle printed: a live identity and an alive verdict adopt, with the index from the name, the fields from one read, and the claim read back twice (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  printf '%s\n' "$OUT" | grep -q 'IDENT(4,5)'; check "gate read: the identity check runs on the child pair the handle records" "$?"
  I_LINE=$(printf '%s\n' "$OUT" | grep -n 'IDENT(' | head -1 | cut -d: -f1)
  W_LINE=$(printf '%s\n' "$OUT" | grep -n '^CALL write_handle' | head -1 | cut -d: -f1)
  P_LINE=$(printf '%s\n' "$OUT" | grep -n '^CALL poll' | head -1 | cut -d: -f1)
  [ -n "$I_LINE" ] && [ -n "$W_LINE" ] && [ -n "$P_LINE" ] && [ "$I_LINE" -lt "$W_LINE" ] && [ "$W_LINE" -lt "$P_LINE" ]; check "gate read: the claim is written after the identity reads live and before the verdict poll (lines $I_LINE < $W_LINE < $P_LINE)" "$?"
  OUT=$(gr IDENT=live LIVE="frozen x"); printf '%s\n' "$OUT" | grep -q 'ROUTE=ADOPT VERDICT=frozen'; check "gate read: a frozen verdict adopts" "$?"
  OUT=$(gr IDENT=gone); printf '%s\n' "$OUT" | grep -q 'ROUTE=SWEEP_LAUNCH VERDICT=gone INDEX=2 PID=\[\]' && ! printf '%s\n' "$OUT" | grep -q '^CALL poll\|^CALL write_handle' && printf '%s\n' "$OUT" | grep -q 'unswept beyond the recorded pair 4,5'; CHECK_RC=$?; check "gate read: a gone identity clears the trusted pid, routes to the sweep with no claim and no poll, and names the unswept pair (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(gr IDENT=unverified); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD' && ! printf '%s\n' "$OUT" | grep -q '^CALL poll\|^CALL write_handle'; CHECK_RC=$?; check "gate read: an unverifiable child pair holds the gate with no claim and no poll (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(gr IDENT=live POLL_ERR=1); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD'; check "gate read: a gate poll that fails holds the gate, not an adoption" "$?"
  OUT=$(gr IDENT=live CLAIM=0); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD' && ! printf '%s\n' "$OUT" | grep -q '^CALL poll' && printf '%s\n' "$OUT" | grep -q 'another supervisor claimed it'; CHECK_RC=$?; check "gate read: a claim that reads back as not this supervisor's holds the gate before any poll (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(gr IDENT=live CLAIM2=0); printf '%s\n' "$OUT" | grep -q 'ROUTE=HOLD' && printf '%s\n' "$OUT" | grep -q '^CALL poll' && printf '%s\n' "$OUT" | grep -q 'rewritten by another supervisor during the gate'; CHECK_RC=$?; check "gate read: a claim overwritten during the gate poll holds the gate after it (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(env IDENT=live bash "$TMP/gateread.sh" "$GR_DIR" child-3 2>&1); printf '%s\n' "$OUT" | grep -q 'ROUTE=ADOPT VERDICT=alive INDEX=3 PID=\[\] .*LAUNCHED=\[\]'; CHECK_RC=$?; check "gate read: a non-numeric pid and an absent launchedAt are read as empty rather than trusted (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  OUT=$(bash "$TMP/gateread.sh" "$GR_DIR" notachild 2>&1); printf '%s\n' "$OUT" | grep -q 'ROUTE=WAIT VERDICT= INDEX=0' && ! printf '%s\n' "$OUT" | grep -q '^CALL write_handle'; CHECK_RC=$?; check "gate read: a name that is not child-<n> is not read and not claimed (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"

  # claim_is_ours, real, over a real handle: this supervisor's pair passes,
  # another's or an unknown own pair is refused.
  CLAIM_SNIPPET=$(sed -n '/^claim_is_ours() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  printf '%s\n%s\n%s\nSELF_WINPID="${SW:-}"; SELF_TICKS="${ST:-}"\nclaim_is_ours "$1"; echo "rc=$?"\n' "$STUB_OPTIONS" "$RHF_SNIPPET" "$CLAIM_SNIPPET" > "$TMP/claim.sh"
  [ "$(SW=9 ST=9 bash "$TMP/claim.sh" "$GR_DIR/child-2/handle.json")" = "rc=0" ]; check "claim_is_ours: a handle carrying this supervisor's pair is its claim" "$?"
  [ "$(SW=8 ST=9 bash "$TMP/claim.sh" "$GR_DIR/child-2/handle.json")" = "rc=1" ]; check "claim_is_ours: a handle carrying another pair is not (the refusal: the pair is not this supervisor's)" "$?"
  [ "$(SW= ST= bash "$TMP/claim.sh" "$GR_DIR/child-2/handle.json")" = "rc=1" ]; check "claim_is_ours: an own pair this supervisor could not read proves no claim" "$?"

  # gate_hold_on_handle: a handle that stays ends the run at GATE TIMEOUT after
  # the bound; one its holder accounts for while the gate waits lets it go on.
  HOLD_SNIPPET=$(sed -n '/^gate_hold_on_handle() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  HD_DIR=$(mktemp -d "$TMP/hold.XXXXXX"); mkdir -p "$HD_DIR/child-1"
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$HOLD_SNIPPET" '
log() { echo "LOG $*"; }
SLEEPS=0
sleep() { SLEEPS=$((SLEEPS + 1)); if [ "$SLEEPS" -ge "${CLEAR_AT:-999}" ]; then rm -f "$RUNDIR/child-1/handle.json"; fi; }
RUNDIR="$1"; SUPERVISOR_GATE_WAIT_S=10
gate_hold_on_handle child-1; echo "RETURNED"' > "$TMP/hold.sh"
  : > "$HD_DIR/child-1/handle.json"
  OUT=$(bash "$TMP/hold.sh" "$HD_DIR" 2>&1); HD_RC=$?
  [ "$HD_RC" -eq 2 ] && printf '%s\n' "$OUT" | grep -q 'GATE TIMEOUT: child-1 still holds a handle this supervisor may not take' && ! printf '%s\n' "$OUT" | grep -q RETURNED; check "gate hold: a handle that stays past the bound ends the run at GATE TIMEOUT with no launch (rc=$HD_RC)" "$?"
  : > "$HD_DIR/child-1/handle.json"
  OUT=$(CLEAR_AT=1 bash "$TMP/hold.sh" "$HD_DIR" 2>&1); HD_RC=$?
  [ "$HD_RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -q RETURNED; check "gate hold: a handle its holder accounts for while the gate waits lets the gate go on (rc=$HD_RC)" "$?"
  # The gate's notes file is per process, since supervisors share the run
  # directory and two starting together would otherwise write one file.
  grep -q '^  HANDLE_NOTES="\$RUNDIR/.handle-notes.\$\$"$' "$SCRIPT"; check "the gate's handle notes file is named per supervisor process" "$?"

  # ensure_self_ticks caches the pair only once it read one; write_handle
  # names a write made with no pair.
  SELFT_SNIPPET=$(sed -n '/^ensure_self_ticks() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$SELFT_SNIPPET" '
SELF_WINPID=""; SELF_TICKS=""; SELF_TICKS_DONE=""; READS_FILE="$1"; echo 0 > "$READS_FILE"
resolve_windows_pid() { echo 4; }
resolve_windows_start_ticks() { local n; n=$(( $(cat "$READS_FILE") + 1 )); echo "$n" > "$READS_FILE"; if [ "$n" -ge 2 ]; then echo 5; fi; }
ensure_self_ticks; echo "after1 done=[$SELF_TICKS_DONE] ticks=[$SELF_TICKS]"
ensure_self_ticks; echo "after2 done=[$SELF_TICKS_DONE] ticks=[$SELF_TICKS]"
ensure_self_ticks; echo "reads=$(cat "$READS_FILE")"' > "$TMP/selft.sh"
  OUT=$(bash "$TMP/selft.sh" "$TMP/selft.reads")
  printf '%s\n' "$OUT" | grep -q '^after1 done=\[\] ticks=\[\]$' && printf '%s\n' "$OUT" | grep -q '^after2 done=\[1\] ticks=\[5\]$' && printf '%s\n' "$OUT" | grep -q '^reads=2$'; CHECK_RC=$?; check "ensure_self_ticks: an empty read is not cached, the next call retries and caches a pair it read, and no call follows (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
  WH_SNIPPET=$(sed -n '/^write_handle() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  WH_DIR=$(mktemp -d "$TMP/wh.XXXXXX")
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$WH_SNIPPET" '
log() { echo "LOG $*"; }
ensure_self_ticks() { :; }
SELF_WINPID=""; SELF_TICKS=""; RUNDIR="$1"; HANDLE_FILE="$1/handle.json"; CHILD_INDEX=1; LAUNCHED_AT=1000
write_handle sess-1' > "$TMP/wh.sh"
  OUT=$(bash "$TMP/wh.sh" "$WH_DIR" 2>&1)
  printf '%s\n' "$OUT" | grep -q 'no supervisor pid and ticks pair' && grep -q '"supervisorTicks":null' "$WH_DIR/handle.json"; CHECK_RC=$?; check "write_handle: a write with no supervisor pair is named in the log (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"

  # ensure_child_ticks retries the child's ticks each poll until they land,
  # names the gap while empty, and rewrites the handle once.
  CHT_SNIPPET=$(sed -n '/^ensure_child_ticks() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
  printf '%s\n%s\n%s\n' "$STUB_OPTIONS" "$CHT_SNIPPET" '
log() { echo "LOG $*"; }
write_handle() { echo "CALL write_handle $1"; }
READS_FILE="$1"; echo 0 > "$READS_FILE"
resolve_windows_start_ticks() { local n; n=$(( $(cat "$READS_FILE") + 1 )); echo "$n" > "$READS_FILE"; if [ "$n" -ge 2 ]; then echo 5; fi; }
CHILD_INDEX=1; CHILD_WINPID=4; CHILD_TICKS=""; CHILD_SESSION_ID=sess-1
ensure_child_ticks; ensure_child_ticks; ensure_child_ticks
echo "reads=$(cat "$READS_FILE") ticks=[$CHILD_TICKS]"' > "$TMP/cht.sh"
  OUT=$(bash "$TMP/cht.sh" "$TMP/cht.reads")
  [ "$(printf '%s\n' "$OUT" | grep -c 'still unread')" -eq 1 ] && [ "$(printf '%s\n' "$OUT" | grep -c '^CALL write_handle sess-1$')" -eq 1 ] && printf '%s\n' "$OUT" | grep -q 'landed on a later read' && printf '%s\n' "$OUT" | grep -q '^reads=2 ticks=\[5\]$'; CHECK_RC=$?; check "ensure_child_ticks: the gap is named while empty, the pair is retried until it lands, the handle is rewritten once, and no read follows (out=$(printf '%s' "$OUT" | tr '\n' '|'))" "$CHECK_RC"
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
  OUT=$(kh HP=9 HW=4 HT=5 OWN=1 ALIVE=1); printf '%s\n' "$OUT" | grep -q '^CALL kill -TERM 9$' && ! printf '%s\n' "$OUT" | grep -q 'CALL snapshot'; check "kill_holder: this supervisor's own live holder takes the MSYS signal first, with no PowerShell (out=$OUT)" "$?"
  OUT=$(kh HP=9 HW=4 HT=5 OWN= ALIVE=1); printf '%s\n' "$OUT" | grep -q '^CALL snapshot 4,5$' && ! printf '%s\n' "$OUT" | grep -q 'CALL kill -TERM'; check "kill_holder: an adopted live holder is killed ticks-matched only (out=$OUT)" "$?"
  OUT=$(kh HP=9 HW=4 HT=5 OWN=1 ALIVE=0); ! printf '%s\n' "$OUT" | grep -q 'CALL' && printf '%s\n' "$OUT" | grep -q 'already gone, so nothing is killed'; check "kill_holder: a holder already gone is not killed at all, so a natural exit spends no PowerShell (out=$OUT)" "$?"
  OUT=$(kh HP=9 OWN= ALIVE=1); ! printf '%s\n' "$OUT" | grep -q 'CALL' && printf '%s\n' "$OUT" | grep -q 'not signalled on an unverified pid'; check "kill_holder: an adopted holder with no recorded pair is not signalled, and the refusal is named (out=$OUT)" "$?"
fi

# --- The cleanup trap with no poll reading yet ---
# A signal between the launch and the first poll finds POLL_LIVENESS unset. The
# trap reads it empty, routes on alive, and detaches a handled live child; the
# same trap with no handle takes today's stop. Run under set -u.
CLEANUP_SNIPPET=$(sed -n '/^cleanup() {/,/^}$/p' "$SCRIPT" | tr -d '\r')
[ -n "$CLEANUP_SNIPPET" ]; check "cleanup is found in bin/supervise.sh" "$?"
if [ -n "$CLEANUP_SNIPPET" ] && [ -n "$TRAP_ROUTE_SNIPPET" ]; then
  CU_DIR=$(mktemp -d "$TMP/cleanup.XXXXXX"); : > "$CU_DIR/handle.json"
  printf '%s\n%s\n%s\n%s\n' "$STUB_OPTIONS" "$TRAP_ROUTE_SNIPPET" "$CLEANUP_SNIPPET" '
log() { echo "LOG $*"; }
stop_child() { echo "CALL stop_child $1"; return 0; }
retry_stop_escalation() { echo "CALL retry $1 $2"; return 0; }
kill_process_snapshot() { return 0; }
sleep 30 & CHILD_LAUNCH_PID=$!
printf "%s" "$CHILD_LAUNCH_PID" > "${PIDF}"
CHILD_INDEX=1; LAST_STOP_SNAPSHOT=""; HANDLE_FILE="${HF:-}"
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
printf '{"sessionId":"s","holderPid":1,"holderWinPid":1,"holderTicks":1,"childPid":1,"childWinPid":1,"childTicks":1,"supervisorWinPid":"x","supervisorTicks":"x","launchedAt":1000,"childIndex":1}' > "$RD_LIVE/child-1/handle.json"
printf '11\n' > "$RD_LIVE/child-1/holder.pid"; printf '12\n' > "$RD_LIVE/child-1/child.pid"; printf 'ask\n' > "$RD_LIVE/child-1/ask.request"
rm -f "$TMP/stub/launched"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" supervisorGateWaitS=3 bash "$SCRIPT" "$TMP/wd" modelprobe default --rundir "$RD_LIVE" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 2 ] && case "$OUT" in *"GATE TIMEOUT"*) true ;; *) false ;; esac; check "held handle: a handle whose writer cannot be ruled out ends the run at GATE TIMEOUT (rc=$RC)" "$?"
grep -q 'still running' "$RD_LIVE/supervisor.log" && grep -q 'may not take' "$RD_LIVE/supervisor.log"; check "held handle: the log names the handle held and the timeout's reason" "$?"
[ "$(cat "$RD_LIVE/child-1/holder.pid")" = 11 ] && [ "$(cat "$RD_LIVE/child-1/child.pid")" = 12 ] && [ "$(cat "$RD_LIVE/child-1/ask.request")" = ask ] && grep -q '"supervisorWinPid":"x"' "$RD_LIVE/child-1/handle.json"
check "held handle: the live child's handle, pid files and ask.request are untouched, so no claim was written" "$?"
! grep -q 'ADOPT\|LAUNCH child-' "$RD_LIVE/supervisor.log" && [ ! -e "$TMP/stub/launched" ] && [ ! -d "$RD_LIVE/child-2" ]; check "held handle: nothing is adopted and no child is launched beside it" "$?"

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
