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
# The three defaults, read out of the assignments themselves: fifteen minutes,
# two minutes and eleven minutes. A changed default reds here rather than
# passing every startup check.
for pair in SUPERVISOR_SILENCE_BOUND_MS:supervisorSilenceBoundMs:900000 SUPERVISOR_PROBE_MS:supervisorProbeMs:120000 SUPERVISOR_FINAL_ASK_MS:supervisorFinalAskMs:660000; do
  IFS=: read -r var setting want <<< "$pair"
  grep -q "^$var=\"\\\${$setting:-$want}\"" "$SCRIPT"
  check "$setting defaults to $want in its assignment to $var" "$?"
done

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
  kill "$LIVE_ROOT" 2>/dev/null
  wait "$LIVE_ROOT" 2>/dev/null
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
retry_stop_escalation() { echo "CALL retry_stop_escalation $1 $2"; return 0; }
stop_child() { echo "CALL stop_child $1"; kill "$CHILD_LAUNCH_PID" 2>/dev/null; return 0; }
record_restart_in_hour() { echo "CALL record_restart_in_hour"; RESTART_COUNT=1; }
if [ "${WRAPPER:-dead}" = live ]; then sleep 30 & else ( exit 7 ) & fi
CHILD_LAUNCH_PID=$!
[ "${WRAPPER:-dead}" = live ] || sleep 1
CHILD_INDEX=1; DECIDE_REASON="gone: test"; EXIT_MARKER="$1"; STOP_PATH=eof
LAUNCHED_AT=$(node -e "console.log(Date.now())"); SUPERVISOR_MIN_RUN_MS=120000
CRASH_COUNT=0; RESTART_COUNT=0; SUPERVISOR_MAX_RESTARTS_PER_HOUR=6; SUPERVISOR_CRASH_LIMIT=3
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

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
