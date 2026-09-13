#!/usr/bin/env bash
# supervisor-model-test.sh - harness case for v2 Section 0 item 3 Part B
# (operator decision, DISCUSSION.md Round 136 addendum): the worker's own
# main thread defaults to opus at medium effort, not sonnet, and a caller
# can still override either explicitly.
#
# Reviewer Round 141 R110 (Major, reproduced): the first cut of this test
# evaluated the settings and the flag's own resolution in the SAME shell
# process as the test itself, where `MODEL=haiku` (a plain shell
# variable, not exported) is trivially visible to a later `${MODEL:-...}`
# expansion in that same shell - masking exactly the bug R109 found live
# (`.kit/live-supervisor-test.sh`'s own `MODEL="haiku"` was never
# exported, and the suite launches `bin/supervise.sh` as a genuinely
# separate `bash` process, so the unexported variable never reached it).
# Fixed by actually launching a separate bash process for the resolution
# check, matching production's own shape, with a positive control proving
# the distinction the bug turned on: an unexported `MODEL` does NOT
# reach the child; an exported one does.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bin/supervise.sh"

SETTINGS_SNIPPET=$(grep -n '^SUPERVISOR_MODEL=\|^SUPERVISOR_EFFORT=' "$SCRIPT" | cut -d: -f2-)
if [ -z "$SETTINGS_SNIPPET" ]; then
  echo "FAIL: could not locate SUPERVISOR_MODEL/SUPERVISOR_EFFORT in $SCRIPT"
  exit 1
fi

MODEL_FLAG=$(grep -n '\-\-model "\${MODEL:-\$SUPERVISOR_MODEL}"' "$SCRIPT")
if [ -z "$MODEL_FLAG" ]; then
  echo "FAIL: could not locate the --model flag's resolution in $SCRIPT"
  exit 1
fi
EFFORT_FLAG=$(grep -n '\-\-effort "\${EFFORT:-\$SUPERVISOR_EFFORT}"' "$SCRIPT")
if [ -z "$EFFORT_FLAG" ]; then
  echo "FAIL: could not locate the --effort flag's resolution in $SCRIPT"
  exit 1
fi

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

# A tiny stub carrying exactly the settings lines and the two flags'
# resolution, run as its own bash process (not eval'd inline) so the
# check is genuinely about env-var inheritance across a process
# boundary, the same shape production uses.
STUB="$(mktemp)"
trap 'rm -f "$STUB"' EXIT
{
  echo "$SETTINGS_SNIPPET"
  echo 'echo "MODEL_RESOLVED=${MODEL:-$SUPERVISOR_MODEL}"'
  echo 'echo "EFFORT_RESOLVED=${EFFORT:-$SUPERVISOR_EFFORT}"'
} > "$STUB"

# Default: no override at all.
OUT=$(env -i PATH="$PATH" bash "$STUB")
case "$OUT" in
  *"MODEL_RESOLVED=opus"*) check "default resolves to opus in a separate process" 0 ;;
  *) check "default resolves to opus in a separate process" 1 ;;
esac
case "$OUT" in
  *"EFFORT_RESOLVED=medium"*) check "default resolves to medium effort in a separate process" 0 ;;
  *) check "default resolves to medium effort in a separate process" 1 ;;
esac

# A settings-level override changes the default.
OUT=$(env -i PATH="$PATH" supervisorModel=sonnet supervisorEffort=high bash "$STUB")
case "$OUT" in
  *"MODEL_RESOLVED=sonnet"*) check "supervisorModel override changes the setting" 0 ;;
  *) check "supervisorModel override changes the setting" 1 ;;
esac
case "$OUT" in
  *"EFFORT_RESOLVED=high"*) check "supervisorEffort override changes the setting" 0 ;;
  *) check "supervisorEffort override changes the setting" 1 ;;
esac

# R109/R110's own regression shape: an UNEXPORTED MODEL in the calling shell
# must NOT reach a separate child process, and an exported one must.
#
# These two cases have to run under a PRESERVED environment. The earlier
# version ran both under `env -i`, which wipes everything: the unexported
# case then passed because nothing at all was inherited, and the "exported"
# case set MODEL on env's own command line rather than by export, so neither
# case exercised export semantics and the pair proved nothing. `env -u` drops
# only the two settings variables, leaving the real inheritance intact, so
# the pair now flips on exactly the property under test - and would both read
# haiku if bash ever exported plain assignments.
env_stub() { env -u supervisorModel -u supervisorEffort bash "$STUB"; }

# `unset` first, and it is load-bearing: a plain assignment to a name that
# is ALREADY in the exported environment keeps its export attribute, so
# without the unset this case inherits whatever MODEL the calling supervisor
# exported and passes or fails on the environment rather than on the code.
# Caught by this very control running under a supervisor-launched shell that
# had MODEL=opus exported.
unset MODEL
MODEL=haiku
OUT=$(env_stub)
unset MODEL
case "$OUT" in
  *"MODEL_RESOLVED=opus"*) check "an UNEXPORTED MODEL does not reach a separate process (still opus)" 0 ;;
  *) check "an UNEXPORTED MODEL does not reach a separate process (still opus)" 1 ;;
esac

export MODEL=haiku
OUT=$(env_stub)
unset MODEL
case "$OUT" in
  *"MODEL_RESOLVED=haiku"*) check "an EXPORTED MODEL reaches a separate process" 0 ;;
  *) check "an EXPORTED MODEL reaches a separate process" 1 ;;
esac

# The same pair for EFFORT, which reaches the launch flag by the same route
# and was previously never covered at all.
unset EFFORT
EFFORT=high
OUT=$(env_stub)
unset EFFORT
case "$OUT" in
  *"EFFORT_RESOLVED=medium"*) check "an UNEXPORTED EFFORT does not reach a separate process (still medium)" 0 ;;
  *) check "an UNEXPORTED EFFORT does not reach a separate process (still medium)" 1 ;;
esac

export EFFORT=high
OUT=$(env_stub)
unset EFFORT
case "$OUT" in
  *"EFFORT_RESOLVED=high"*) check "an EXPORTED EFFORT reaches a separate process" 0 ;;
  *) check "an EXPORTED EFFORT reaches a separate process" 1 ;;
esac

# --- Startup input checks, driven through the real bin/supervise.sh ---
# HOME is an empty directory, so a value that passes every startup check stops
# at the pre-launch gate with exit 2 and "GATE FAIL". A refused value exits 1
# with an ERROR line naming the setting, before the gate runs. A stub claude
# first on PATH records any launch, and none is expected either way.
TMP="$(mktemp -d)"
trap 'rm -f "$STUB"; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home" "$TMP/wd" "$TMP/stub"
printf '#!/usr/bin/env bash\ntouch "%s"\nexit 1\n' "$TMP/stub/launched" > "$TMP/stub/claude"
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
mkdir -p "$TMP/home-free/.claude/plugins/store" "$TMP/wd-launch"
printf '{}' > "$TMP/home-free/.claude/plugins/store/agentic-plugin_agent-persona-modelprobe.json"
rm -f "$TMP/stub/launched"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home-free" supervisorCrashLimit=1 supervisorPollMs=1000 \
  timeout 120 bash "$SCRIPT" "$TMP/wd-launch" modelprobe default --rundir "$TMP/rd-launch" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 3 ] && [ -e "$TMP/stub/launched" ]
check "control: a gate-passing run reaches the launch and the stub marker appears (rc=$RC)" "$?"
rm -f "$TMP/stub/launched"

# The model shape: a name of lowercase letters, digits, '.' and '-' starting
# with a letter or digit, plus an optional bracketed suffix. '-opus' and
# '--some-flag' hold only allowed characters, so the leading character is the
# only rule that can refuse them. The bracket cases pin that the suffix is
# admitted only as a matched pair at the end of a name.
refused_by "supervisorModel '-opus' is refused by the leading-character rule" "ERROR: supervisorModel '-opus'" supervisorModel=-opus
refused_by "MODEL '--some-flag' is refused by the leading-character rule" "ERROR: MODEL '--some-flag'" MODEL=--some-flag
accepted "supervisorModel 'opus[1m]' passes the startup checks" "supervisorModel=opus[1m]"
accepted "MODEL 'opus[1m]' passes the startup checks" "MODEL=opus[1m]"
refused_by "supervisorModel 'opus]' is refused (unmatched closing bracket)" "ERROR: supervisorModel 'opus]'" "supervisorModel=opus]"
refused_by "supervisorModel 'opus[1m' is refused (unmatched opening bracket)" "ERROR: supervisorModel 'opus[1m'" "supervisorModel=opus[1m"
refused_by "supervisorModel ']' is refused (a bracket is not a name)" "ERROR: supervisorModel ']'" "supervisorModel=]"
refused_by "supervisorModel '[' is refused (a bracket is not a name)" "ERROR: supervisorModel '['" "supervisorModel=["
refused_by "supervisorModel '[1m]' is refused (a suffix with no name before it)" "ERROR: supervisorModel '[1m]'" "supervisorModel=[1m]"
refused_by "supervisorModel 'opus[1m]x' is refused (the suffix is not at the end)" "ERROR: supervisorModel 'opus[1m]x'" "supervisorModel=opus[1m]x"
refused_by "MODEL 'opus]' is refused (unmatched closing bracket)" "ERROR: MODEL 'opus]'" "MODEL=opus]"

# Every numeric setting that ends the run on a bad value is held to one rule:
# digits only, no leading zero, at most nine digits, greater than zero. Each
# clause gets a case per setting. A leading zero is read as octal by the
# shell's own arithmetic, a value past nine digits wraps it, and zero collapses
# whatever wait or count the setting sizes.
for spec in \
  "supervisorPrimingWaitS 180" \
  "supervisorStopGraceMs 5000" \
  "supervisorMinRunMs 120000" \
  "supervisorCrashLimit 3" \
  "supervisorMaxRestartsPerHour 6" \
  "supervisorPollMs 10000"
do
  name="${spec%% *}"
  good="${spec##* }"
  refused_by "$name '0500' is refused by the leading-zero rule" "ERROR: $name '0500'" "$name=0500"
  refused_by "$name '12345678901234567890' is refused by the nine-digit rule" "ERROR: $name '12345678901234567890'" "$name=12345678901234567890"
  refused_by "$name '0' is refused by the greater-than-zero rule" "ERROR: $name '0'" "$name=0"
  refused_by "$name 'abc' is refused by the digits-only rule" "ERROR: $name 'abc'" "$name=abc"
  accepted "$name '$good' passes the startup checks" "$name=$good"
done

# supervisorPsBoundS is the seventh setting on that rule and the one that falls
# back to 30 rather than refusing, so its resolution is read by running the
# script's own lines, from the assignment up to the next setting, in a separate
# process.
PS_BOUND_SNIPPET=$(sed -n '/^SUPERVISOR_PS_BOUND_S=/,/^SUPERVISOR_STOP_GRACE_MS=/p' "$SCRIPT" | sed '$d')
# The block calls the shared check, so the snippet carries the function too.
# An empty extraction here means the shared check was renamed or removed.
HELPER_SNIPPET=$(sed -n '/^positive_number() {/,/^}$/p' "$SCRIPT")
if [ -z "$PS_BOUND_SNIPPET" ] || [ -z "$HELPER_SNIPPET" ]; then
  check "the SUPERVISOR_PS_BOUND_S block and the shared numeric check are found in bin/supervise.sh" 1
else
  printf '%s\n%s\necho "PS_BOUND=$SUPERVISOR_PS_BOUND_S"\n' "$HELPER_SNIPPET" "$PS_BOUND_SNIPPET" > "$TMP/psbound.sh"
  for pair in 00:30 abc:30 0500:30 12345678901234567890:30 0:30 45:45; do
    OUT=$(env -i PATH="$PATH" supervisorPsBoundS="${pair%%:*}" bash "$TMP/psbound.sh" 2>&1)
    case "$OUT" in
      *"PS_BOUND=${pair##*:}") check "supervisorPsBoundS '${pair%%:*}' resolves to ${pair##*:}" 0 ;;
      *) check "supervisorPsBoundS '${pair%%:*}' resolves to ${pair##*:} (out=$OUT)" 1 ;;
    esac
  done
fi

# Every one of the seven numeric settings goes through the shared check, so a
# new call site that hand-rolls its own rule reds this count.
CALLS=$(grep -c 'positive_number "\$SUPERVISOR_' "$SCRIPT")
[ "$CALLS" -eq 7 ]
check "the shared numeric check guards all seven settings (found $CALLS)" "$?"

# --- Every live suite that launches bin/supervise.sh exports MODEL and EFFORT ---
# The suite launches the supervisor as a separate process, so only an exported
# value reaches its launch flags. A suite that names bin/supervise.sh with no
# launch line the scan recognizes is a failure unless it is on the list below,
# which holds the suites that read functions out of the script without running
# it. That keeps a real launcher written in an unrecognized shape from passing
# as a file the scan simply skipped.
NON_LAUNCHERS="live-stopprocesstree-test.sh"
LAUNCHERS=0
for f in "$HERE"/live-*-test.sh; do
  grep -q 'bin/supervise\.sh' "$f" || continue
  base=$(basename "$f")
  if grep -Eq '^[[:space:]]*(bash[[:space:]]+)?("\$SUPERVISE"|[^[:space:]]*bin/supervise\.sh)[[:space:]]' "$f"; then
    LAUNCHERS=$((LAUNCHERS + 1))
    grep -q '^export MODEL=' "$f" && grep -q '^export EFFORT=' "$f"
    rc=$?
    check "$base launches bin/supervise.sh and exports MODEL and EFFORT" "$rc"
  else
    case " $NON_LAUNCHERS " in
      *" $base "*)
        check "$base names bin/supervise.sh without launching it, as listed" 0
        ;;
      *)
        check "$base names bin/supervise.sh with no launch line this scan recognizes" 1
        ;;
    esac
  fi
done
[ "$LAUNCHERS" -gt 0 ]; check "live suites launching bin/supervise.sh were found ($LAUNCHERS)" "$?"

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
