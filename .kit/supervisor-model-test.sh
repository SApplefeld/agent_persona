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
00 1 REFUSE
12345678901234567890 1 REFUSE
1000000000 1 REFUSE
0 1 REFUSE
abc 1 REFUSE
5abc 1 REFUSE
1 1 PASS
180 1 PASS
999999999 1 PASS
999 1000 REFUSE
1 1000 REFUSE
1000 1000 PASS
60000 1000 PASS"
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

# The call sites, driven through the real bin/supervise.sh. One spawn per
# setting is what proves that setting's own value reaches the shared check and
# that the refusal names it; the clauses themselves are covered above. The two
# settings whose consumer divides by 1000 get a second spawn for the minimum,
# since a value like 500 passes every other clause and still floors to a
# zero-second wait. That the defaults pass every check is covered by the
# gate-passing control above and by the suites that launch a child.
for name in supervisorPrimingWaitS supervisorStopGraceMs supervisorMinRunMs \
  supervisorCrashLimit supervisorMaxRestartsPerHour supervisorPollMs
do
  refused_by "$name 'abc' is refused at its own call site" "ERROR: $name 'abc'" "$name=abc"
done
refused_by "supervisorStopGraceMs '500' is refused by the 1000 minimum" "ERROR: supervisorStopGraceMs '500'" supervisorStopGraceMs=500
refused_by "supervisorPollMs '500' is refused by the 1000 minimum" "ERROR: supervisorPollMs '500'" supervisorPollMs=500
refused_by "staleAfterMs 'abc' is refused at its own call site" "ERROR: staleAfterMs 'abc'" staleAfterMs=abc
# A plain zero is the value that separates the shared rule from the emitter's
# own rule, which admits it. A zero stale bound reads every holder as stale, so
# the pre-launch gate passes while another session still holds the persona.
refused_by "staleAfterMs '0' is refused, which the emitter's rule alone would admit" "ERROR: staleAfterMs '0'" staleAfterMs=0

# supervisorPsBoundS is the one setting on this rule that falls back to 30
# rather than refusing, so its resolution is read by running the script's own
# lines, from the assignment up to the next setting, in a separate process.
PS_BOUND_SNIPPET=$(sed -n '/^SUPERVISOR_PS_BOUND_S=/,/^SUPERVISOR_STOP_GRACE_MS=/p' "$SCRIPT" | sed '$d')
if [ -z "$PS_BOUND_SNIPPET" ] || [ -z "$HELPER_SNIPPET" ]; then
  check "the SUPERVISOR_PS_BOUND_S block and the shared numeric check are found in bin/supervise.sh" 1
else
  printf '%s\n%s\n%s\necho "PS_BOUND=$SUPERVISOR_PS_BOUND_S"\n' "$STUB_OPTIONS" "$HELPER_SNIPPET" "$PS_BOUND_SNIPPET" > "$TMP/psbound.sh"
  for pair in 00:30 abc:30 0500:30 12345678901234567890:30 0:30 45:45; do
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
