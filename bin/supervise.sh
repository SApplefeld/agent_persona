#!/usr/bin/env bash
# bin/supervise.sh - Supervisor loop for days-long persona runs.
#
# Usage: bin/supervise.sh <workdir> <persona> <permission-mode> [--prompt TEXT] [--rundir DIR] [--dev] [--no-channel] [--channel-name NAME]
#
# The priming turn's skill-load instruction (SKILL_LOAD_INSTRUCTION below)
# assumes the claude-kit plugin is installed globally on the host running
# this script, since it names claude-kit:operating-instructions and
# claude-kit:executing-work by their plugin-qualified skill names.
#
# By default the child loads agentic-plugin as an installed plugin (plan
# item 6: the target runtime, installed from this repo's own marketplace
# manifest). Pass --dev to load it from this checkout instead via
# --plugin-dir, for working on the plugin's own code.
#
# By default the child is also directly reachable from Discord (plan item
# 5: the native channel, no proxy session): --channels loads the relay
# plugin (D:\discord-channels), CHANNEL_SESSION names the thread (stable
# across restarts so the whole supervisor lifetime is one conversation),
# and a fresh CHANNEL_PROCESS_TOKEN is minted per child. Pass --no-channel
# to skip this (a scratch/proof run with no Discord side effects).
#
# Exit codes:
#   0 = shutdown_requested honored
#   1 = usage, or a setting refused at startup
#   2 = no commons store for the load mode, or pre-launch gate timeout
#   3 = crash loop
#   4 = restart budget exhausted
#   5 = stopped, but a process from the child is alive or unverifiable
#       despite every retry
#   6 = park_requested honored: the keeper's next start launches the persona
#       again

set -u
set -o pipefail

# --- Parse arguments ---
if [ $# -lt 3 ]; then
  echo "Usage: bin/supervise.sh <workdir> <persona> <permission-mode> [--prompt TEXT] [--rundir DIR] [--dev]" >&2
  exit 1
fi

ORIG_PWD="$(pwd)"

WORKDIR="$1"
PERSONA="$2"
PERMISSION_MODE="$3"
shift 3

# The persona is spliced into the child's settings JSON, so it is held to
# the same shape valid_persona_name enforces in
# bin/agentic-common.sh, checked here before anything touches the disk.
case "$PERSONA" in
  ''|*[!A-Za-z0-9_-]*)
    echo "ERROR: persona '$PERSONA' may hold only letters, digits, underscore and hyphen" >&2
    exit 1
    ;;
esac

PROMPT=""
RUNDIR=""
DEV_MODE=0
NO_CHANNEL=0
CHANNEL_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --prompt)
      PROMPT="$2"
      shift 2
      ;;
    --rundir)
      RUNDIR="$2"
      shift 2
      ;;
    --dev)
      DEV_MODE=1
      shift 1
      ;;
    --no-channel)
      NO_CHANNEL=1
      shift 1
      ;;
    --channel-name)
      CHANNEL_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# --- Resolve workdir to an absolute path, then change into it (plan item 1) ---
# The plugin's hooks resolve their store and heartbeat sidecar paths relative
# to the child process's own cwd, while this script's poll loop reads them as
# "$WORKDIR/...". Launching the supervisor from anywhere but WORKDIR used to
# split those two: the child wrote its store next to wherever the caller's
# shell happened to be, and the poll loop kept reading an empty WORKDIR. The
# supervisor now owns that cd itself, so any caller cwd works.
if [ ! -d "$WORKDIR" ]; then
  echo "workdir not found: $WORKDIR" >&2
  exit 1
fi
WORKDIR="$(cd "$WORKDIR" && pwd)"

# A --rundir given as a relative path is relative to the caller's original
# cwd, not to WORKDIR: resolve it before the cd below changes what "relative"
# means. The default rundir (unset here) is computed from WORKDIR after the cd.
if [ -n "$RUNDIR" ]; then
  case "$RUNDIR" in
    /*) : ;;  # already absolute
    *) RUNDIR="$ORIG_PWD/$RUNDIR" ;;
  esac
fi

cd "$WORKDIR"

# Plan item 5: one Discord thread for the supervisor's whole lifetime, not
# one per child. CHANNEL_SESSION is the broker's binding key and must stay
# identical across every child a restart launches; only CHANNEL_PROCESS_TOKEN
# (minted per launch, below) changes. Default derived from the persona so two
# supervisors on one machine don't collide on one thread name.
if [ -z "$CHANNEL_NAME" ]; then
  CHANNEL_NAME="supervisor-$PERSONA"
fi

# The shared check for the numeric settings this script reads itself. The
# plugin values further down are, with one exception, a different set on a
# different rule, the one emit_settings_json applies in bin/agentic-common.sh,
# since those are spliced into JSON rather than used in arithmetic here. The
# exception is staleAfterMs, which this script also reads for itself, so it
# takes this check too, at its own assignment below.
#
# The rule: digits only, no leading zero, at most nine digits, and at least
# the given minimum, which defaults to 1. Each clause stops a distinct way a
# bad value corrupts a run instead of failing loudly. A non-numeric value
# turns every `[ "$a" -lt "$b" ]` comparison into a shell error, which the
# caller reads as "the bound is already passed". A leading zero makes the
# shell read the value as octal, so `$((0500 / 1000))` is 0 and `$((0089))`
# aborts the script with "value too great for base". A digit string longer
# than nine digits is past any plausible bound or count, and a long enough one
# wraps the shell's 64-bit arithmetic to an unrelated value. Zero collapses
# every grace loop and poll interval to no wait at all.
#
# The minimum exists for the millisecond settings whose consumer divides them
# by 1000 before use: anything under 1000 floors to a zero-second wait there,
# which is the same failure a zero produces, reached from a value that looks
# reasonable. Those two callers pass 1000.
#
# Usage: positive_number <value> [minimum]
# Returns 0 when the value passes. Each caller decides what a failure means:
# the PowerShell bound falls back to its default, every other setting ends
# the run with an ERROR line naming the setting.
positive_number() {
  case "${1:-}" in
    ''|*[!0-9]*|0*) return 1 ;;
  esac
  [ "${#1}" -le 9 ] || return 1
  [ "$1" -ge "${2:-1}" ]
}

# --- Defaults (plan section 6) ---
# A fixed sentinel line every PowerShell probe below writes as its own
# last statement: powershell -Command's exit code reflects whether the
# LAST statement it ran succeeded, not an aggregate error count - a
# script whose real work ends on an `if` whose condition is false
# (exactly what "the pid is gone, checked cleanly" looks like) exits 1
# with no error printed anywhere. A trailing Write-Output of this
# sentinel is a statement that always succeeds, so its presence in
# stdout - not PowerShell's own exit code - is what a caller trusts as
# "the script ran to completion", timed-out truncation being the one
# case that can never produce it.
STOP_PS_SENTINEL="___SUPERVISOR_PS_DONE___"

# The bound every PowerShell call uses is one setting rather than a bare
# literal repeated at each call site, sized to this box's own measured
# spawn cost (4-11s per call under this session's own load) rather than
# picked arbitrarily; a slower box overrides it rather than silently
# timing out every call. Collapsing the per-stop PowerShell calls to as
# few as the design allows is handled separately, by removing
# kill_process_snapshot's own retry loop in favor of
# retry_stop_escalation's single wall-clock-bounded loop, not by this
# setting.
SUPERVISOR_PS_BOUND_S="${supervisorPsBoundS:-30}"
# An unusable bound force-kills every PowerShell call the moment it starts,
# because `[ "$waited" -lt "$bound" ]` either errors or is false at once.
# This is the one numeric setting that falls back instead of ending the run:
# a bad bound costs process-tree verification, not the run itself.
if ! positive_number "$SUPERVISOR_PS_BOUND_S"; then
  SUPERVISOR_PS_BOUND_S=30
fi

SUPERVISOR_STOP_GRACE_MS="${supervisorStopGraceMs:-60000}"
# The cap on how long a requested restart (the restart_passive label in
# stop_child) keeps waiting past the grace for a child that is inside a turn,
# measured from the moment its input is closed. Eleven minutes: the harness
# caps one tool call at ten minutes, and the extra minute covers the reply the
# model writes once that call returns. Only that one label reads it.
SUPERVISOR_STOP_BUSY_CAP_MS="${supervisorStopBusyCapMs:-660000}"
SUPERVISOR_MIN_RUN_MS="${supervisorMinRunMs:-120000}"
SUPERVISOR_CRASH_LIMIT="${supervisorCrashLimit:-3}"
SUPERVISOR_MAX_RESTARTS_PER_HOUR="${supervisorMaxRestartsPerHour:-6}"
SUPERVISOR_POLL_MS="${supervisorPollMs:-10000}"
# The liveness verdict's three bounds, read by bin/supervise-liveness.mjs
# through the poll and never written to the plugin's options. The silence
# bound is how long the transcript and the output stream may be silent, and
# the startup grace: fifteen minutes, the harness's ten-minute tool-call cap
# plus a margin. The probe interval is the least time between two probes of a
# child whose heartbeat is stale. The final ask's window is how long a frozen
# child has to move any signal after the one status prompt, the tool-call cap
# plus a minute.
SUPERVISOR_SILENCE_BOUND_MS="${supervisorSilenceBoundMs:-900000}"
SUPERVISOR_PROBE_MS="${supervisorProbeMs:-120000}"
SUPERVISOR_FINAL_ASK_MS="${supervisorFinalAskMs:-660000}"
# How long a shutdown ask waits for the child to bank its state and record
# shutdown_requested before the stop proceeds through the stop phases: twenty
# minutes, run from the moment the ask is written. The plugin delivers the ask
# from a controller tick that finds the session idle, so a child that is idle
# inside the window banks its state and stops itself, and one whose turn
# outlasts the window is stopped through the phases. Read by the decide unit
# through the poll, and never written to the plugin's options.
SUPERVISOR_ASK_GRACE_MS="${supervisorAskGraceMs:-1200000}"
# v2 spec Section 0 item 3 Part B (operator decision, DISCUSSION.md Round
# 136 addendum): the worker's own main thread - where PR #17's kill path
# was actually written - defaults to opus at medium effort, not sonnet.
# Per-section implementer tier is unaffected; a dispatched section still
# takes whatever tier the plan doc's own `Model:` line names, under
# executing-work. `MODEL` (below) still overrides this default when a
# caller sets it explicitly - the `.kit/live-*` suites keep doing exactly
# that to pass `haiku` and hold their own cost steady.
SUPERVISOR_MODEL="${supervisorModel:-opus}"
SUPERVISOR_EFFORT="${supervisorEffort:-medium}"
# How long a launch waits for the priming turn's own `result` line before
# writing the goal prompt anyway. Child startup alone is 45-60 seconds, so
# this is deliberately generous; it bounds a wait, it does not schedule one.
SUPERVISOR_PRIMING_WAIT_S="${supervisorPrimingWaitS:-180}"
# An unvalidated typo in either setting is an opaque crash loop: the child
# never launches, `claude -p` rejecting an unknown model or effort value, and
# the supervisor retries until it trips the crash-loop limit with nothing in
# the log naming the cause. Both are checked once at startup instead.
#
# The model cannot be validated against a known set - new model names ship
# without this script changing - so the check is on shape: a name of lowercase
# letters, digits, `.` and `-` that starts with a letter or a digit, plus an
# optional bracketed suffix such as the `[1m]` of `opus[1m]`. Requiring the
# brackets to come as a matched pair at the end is what a case glob cannot
# express, so the check is a regex. Starting on a letter or digit keeps a
# value like `--some-flag` from reaching `claude -p --model` as a flag. A
# stray quote or other character is the realistic typo the pattern catches.
plausible_model_name() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9.-]*(\[[a-z0-9.-]+\])?$ ]]
}
if ! plausible_model_name "$SUPERVISOR_MODEL"; then
  echo "ERROR: supervisorModel '$SUPERVISOR_MODEL' is not a plausible model name (lowercase letters, digits, '.' and '-', starting with a letter or digit, with an optional bracketed suffix such as '[1m]')" >&2
  exit 1
fi
case "$SUPERVISOR_EFFORT" in
  low|medium|high|xhigh|max) : ;;
  *)
    echo "ERROR: supervisorEffort '$SUPERVISOR_EFFORT' is not one of low|medium|high|xhigh|max" >&2
    exit 1
    ;;
esac
# The env overrides are what actually reach the launch flags, and they bypass
# both checks above, so they are validated on the same rules. A live suite
# exporting a bad `MODEL` or `EFFORT` would otherwise produce the same silent
# crash loop the settings checks exist to prevent.
if [ -n "${MODEL:-}" ] && ! plausible_model_name "$MODEL"; then
  echo "ERROR: MODEL '$MODEL' is not a plausible model name (lowercase letters, digits, '.' and '-', starting with a letter or digit, with an optional bracketed suffix such as '[1m]')" >&2
  exit 1
fi
if [ -n "${EFFORT:-}" ]; then
  case "$EFFORT" in
    low|medium|high|xhigh|max) : ;;
    *)
      echo "ERROR: EFFORT '$EFFORT' is not one of low|medium|high|xhigh|max" >&2
      exit 1
      ;;
  esac
fi
# The settings that end the run on a bad value, each checked against the one
# rule positive_number states. A bad value here is always a typo in the
# settings file or in an exported override, and the symptom it produces is
# remote from its cause: the priming wait bounds an arithmetic comparison,
# the stop grace sizes both of stop_child's grace loops so a zero-iteration
# loop skips EOF and TERM and goes straight to KILL, the minimum run time
# decides what counts as a crash, the crash limit and the restart budget
# decide when the run gives up, and the poll interval feeds `sleep`.
#
# The stop grace and the poll interval are the two the consumer divides by
# 1000, so they take the 1000 minimum; the minimum run time is compared in
# milliseconds as written and stays on the plain rule. The stop's busy cap
# takes the same 1000 minimum as the grace it extends.
if ! positive_number "$SUPERVISOR_PRIMING_WAIT_S"; then
  echo "ERROR: supervisorPrimingWaitS '$SUPERVISOR_PRIMING_WAIT_S' is not a whole number of seconds greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_STOP_GRACE_MS" 1000; then
  echo "ERROR: supervisorStopGraceMs '$SUPERVISOR_STOP_GRACE_MS' is not a whole number of milliseconds of at least 1000, written with digits only, no leading zero and at most 9 digits. The stop grace is divided by 1000, so anything smaller is a zero-second grace." >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_STOP_BUSY_CAP_MS" 1000; then
  echo "ERROR: supervisorStopBusyCapMs '$SUPERVISOR_STOP_BUSY_CAP_MS' is not a whole number of milliseconds of at least 1000, written with digits only, no leading zero and at most 9 digits. The busy cap is measured against a poll that runs every five seconds, so anything smaller cannot extend a wait." >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_MIN_RUN_MS"; then
  echo "ERROR: supervisorMinRunMs '$SUPERVISOR_MIN_RUN_MS' is not a whole number of milliseconds greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_CRASH_LIMIT"; then
  echo "ERROR: supervisorCrashLimit '$SUPERVISOR_CRASH_LIMIT' is not a whole number of crashes greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_MAX_RESTARTS_PER_HOUR"; then
  echo "ERROR: supervisorMaxRestartsPerHour '$SUPERVISOR_MAX_RESTARTS_PER_HOUR' is not a whole number of restarts greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_POLL_MS" 1000; then
  echo "ERROR: supervisorPollMs '$SUPERVISOR_POLL_MS' is not a whole number of milliseconds of at least 1000, written with digits only, no leading zero and at most 9 digits. The poll interval is divided by 1000, so anything smaller polls with no wait at all." >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_SILENCE_BOUND_MS"; then
  echo "ERROR: supervisorSilenceBoundMs '$SUPERVISOR_SILENCE_BOUND_MS' is not a whole number of milliseconds greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_PROBE_MS"; then
  echo "ERROR: supervisorProbeMs '$SUPERVISOR_PROBE_MS' is not a whole number of milliseconds greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_FINAL_ASK_MS"; then
  echo "ERROR: supervisorFinalAskMs '$SUPERVISOR_FINAL_ASK_MS' is not a whole number of milliseconds greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi
if ! positive_number "$SUPERVISOR_ASK_GRACE_MS"; then
  echo "ERROR: supervisorAskGraceMs '$SUPERVISOR_ASK_GRACE_MS' is not a whole number of milliseconds greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi

# --- Plugin values (single-sourced, emitted to settings JSON) ---
HEARTBEAT_MS="${heartbeatMs:-30000}"
STALE_AFTER_MS="${staleAfterMs:-90000}"
# This one is read by the supervisor itself, not only emitted: it is the stale
# bound the pre-launch gate hands wait_persona_free_both, and it reaches the
# decide unit too. So it takes the same check the settings above take, rather
# than only the emitter's rule, which is skipped whenever the rundir already
# holds a settings file. It is compared against an age in milliseconds as
# written, so it stays on the plain rule with no minimum.
if ! positive_number "$STALE_AFTER_MS"; then
  echo "ERROR: staleAfterMs '$STALE_AFTER_MS' is not a whole number of milliseconds greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi

# --- Paths ---
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "$RUNDIR" ]; then
  RUNDIR="$WORKDIR/run"
fi
if ! mkdir -p "$RUNDIR"; then
  echo "ERROR: cannot create rundir $RUNDIR" >&2
  exit 1
fi

LOG="$RUNDIR/supervisor.log"
SETTINGS_FILE="$RUNDIR/settings.json"
# The heartbeat file only this run's child writes, and the mailbox pair: the
# supervisor's own records, and the plugin's acknowledgements of them. One of
# each per run directory rather than per child, and both mailbox files are
# truncated at each launch.
CHILD_HEARTBEAT="$RUNDIR/heartbeat.json"
MAILBOX_FILE="$RUNDIR/mailbox.jsonl"
MAILBOX_ACK_FILE="$RUNDIR/mailbox.ack.jsonl"
# The file that stops this persona on purpose. The operator writes it, and a
# keeper that writes it is a follow-on; the poll reads it and asks the child
# to stop, and a launch that finds it
# ends the run without launching. Whatever it contains, a present file is the
# request, and each exit 0 the request leads to removes it.
SHUTDOWN_REQUEST_FILE="$RUNDIR/shutdown.request"
# The three paths the child's plugin is handed in the settings file, exported
# once here so both settings branches below write them: the mailbox it drains,
# the workdir sidecar the pre-launch gate reads, and the heartbeat file only
# the child writes. The child is a Windows process, so each is handed over in
# absolute mixed form (D:/...), which it resolves and which a JSON string
# carries without escaping; the plugin derives the ack file from the mailbox.
export SUPERVISOR_MAILBOX="$(cygpath -m -a "$MAILBOX_FILE" 2>/dev/null || echo "$MAILBOX_FILE")"
export HEARTBEAT_PATH="$(cygpath -m -a "$WORKDIR/.agentic-heartbeat.json" 2>/dev/null || echo "$WORKDIR/.agentic-heartbeat.json")"
export SUPERVISOR_HEARTBEAT_PATH="$(cygpath -m -a "$CHILD_HEARTBEAT" 2>/dev/null || echo "$CHILD_HEARTBEAT")"

# --- Source the shared helper ---
_COMMON="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agentic-common.sh"
# shellcheck source=agentic-common.sh
source "$_COMMON"

# Sourcing agentic-common.sh above assigns these four from its own PROFILE
# case. They are set here, after the source, so this launch's env overrides
# apply instead of being clobbered by the library's defaults.
TICK_MS="${controllerTickMs:-10000}"
NUDGE_IDLE_MS="${nudgeIdleMs:-45000}"
NUDGE_FLOOR_MS="${nudgeFloorMs:-5000}"
GIT_PROBE_MS="${gitProbeMs:-30000}"
# The controller tick is emitted for the plugin and also read here, since a
# probe's window is two ticks plus the poll interval, so it takes the same
# check the settings the script reads for itself take. The emitter's own rule
# is skipped whenever the rundir already holds a settings file.
if ! positive_number "$TICK_MS"; then
  echo "ERROR: controllerTickMs '$TICK_MS' is not a whole number of milliseconds greater than zero (digits only, no leading zero, at most 9 digits)" >&2
  exit 1
fi
# How long a probe waits for the plugin's ack before it reads silent: an idle
# child's tick acknowledges within one tick, and the second tick and the poll
# interval are the margin for the tick and the poll landing out of step.
PROBE_WINDOW_MS=$(( 2 * TICK_MS + SUPERVISOR_POLL_MS ))

# --- Emit settings JSON (only if not already provided) ---
# A provided file keeps its options, and gains whichever plugin id it lacks,
# so a rundir written for one load mode still reaches the plugin in the other.
if [ ! -f "$SETTINGS_FILE" ]; then
  if ! emit_settings_json "$SETTINGS_FILE" 2>>"$LOG"; then
    echo "ERROR: could not write $SETTINGS_FILE; see $LOG" | tee -a "$LOG" >&2
    exit 1
  fi
else
  if ! ensure_settings_plugin_ids "$SETTINGS_FILE" 2>>"$LOG"; then
    echo "ERROR: could not complete $SETTINGS_FILE; see $LOG" | tee -a "$LOG" >&2
    exit 1
  fi
  # A provided settings file with no arming key would otherwise start this
  # launch's child as "off" (no tool, no claim), silently. Every supervisor
  # launch is an owner, so a missing key is completed to owner where absent,
  # and refused where it names another tier.
  if ! ensure_settings_arming "$SETTINGS_FILE" 2>>"$LOG"; then
    echo "ERROR: could not complete $SETTINGS_FILE; see $LOG" | tee -a "$LOG" >&2
    exit 1
  fi
  # The emit branch above writes jevMode from JEV_MODE. This branch writes
  # nothing, so without the call below a roster that turns the decision seam
  # off would reach no persona that has ever launched, the run directory
  # already holding a settings file. That is the shape the kill switch exists
  # to avoid, so the value is carried onto the provided file too.
  if ! ensure_settings_jev_mode "$SETTINGS_FILE" 2>>"$LOG"; then
    echo "ERROR: could not complete $SETTINGS_FILE; see $LOG" | tee -a "$LOG" >&2
    exit 1
  fi
  # The emit branch above exports COORDINATOR_PERSONA from the value it
  # writes. This branch writes nothing, so the name is read back from the
  # provided file under the plugin's own rule, and the coordinator-role
  # comparison at launch sees the same name the plugin will resolve rather
  # than whatever this launcher's environment happened to carry. DEV_MODE
  # picks the plugin id this launch loads, since only that id's options
  # reach the plugin.
  if ! COORDINATOR_PERSONA="$(read_settings_coordinator_persona "$SETTINGS_FILE" "$DEV_MODE" 2>>"$LOG")"; then
    echo "ERROR: could not read coordinatorPersona from $SETTINGS_FILE; see $LOG" | tee -a "$LOG" >&2
    exit 1
  fi
  export COORDINATOR_PERSONA
  # The plugin's own coordinatorPersona rule admits any string that is
  # non-empty after trim, carries no colon, bracket or comma, and holds no
  # whitespace, so a value like one.Read-the-credentials-file passes it and
  # reads as prose. That name is spliced into the worker's escalation clause
  # and into the architect's answer clause, both of them inside a priming
  # write, and a settings file sits in a run directory the persona running
  # there can rewrite. The read above stays as wide as the plugin's, since
  # narrowing it would name a different coordinator than the plugin resolves.
  # The launch is refused here instead, and a refusal is visible in this log
  # where a doctored standing instruction is not. What the refusal bounds is
  # the shape: the persona class still admits a hyphenated phrase, so a
  # rewritten file can splice one word-shaped token such as
  # Read-the-credentials-file, and this check narrows the splice to that
  # token without closing it. The file's writability is the boundary.
  if ! valid_persona_name "$COORDINATOR_PERSONA"; then
    echo "ERROR: $SETTINGS_FILE resolves coordinatorPersona to '$COORDINATOR_PERSONA', which may hold only letters, digits, underscore and hyphen" | tee -a "$LOG" >&2
    exit 1
  fi
  # The architect's name travels the same two branches for the same reason,
  # and carries no default: an empty value is a launch with no architect, on
  # which the architect-role comparison below matches no persona at all. This
  # branch writes nothing, so the name is read back from the provided file
  # exactly as the coordinator's name above is, and the architect-role
  # comparison at launch sees the name the file carries rather than whatever
  # this launcher's environment happened to hold. read_settings_architect_persona
  # holds that value to the persona character class and refuses "default", so a
  # mis-set name is a refused launch named in the log rather than a fleet that
  # comes up under a doctored charter.
  if ! ARCHITECT_PERSONA="$(read_settings_architect_persona "$SETTINGS_FILE" "$DEV_MODE" 2>>"$LOG")"; then
    echo "ERROR: could not read architectPersona from $SETTINGS_FILE; see $LOG" | tee -a "$LOG" >&2
    exit 1
  fi
  export ARCHITECT_PERSONA
  # One name for both seats builds the coordinator's role instruction and the
  # architect's charter into a single priming write, each telling that session
  # what the other denies: route design asks to the architect, and answer the
  # coordinator by naming yourself. emit_settings_json refuses the pair on the
  # other branch, and on this branch both names are read back from the same
  # provided file, so the pair is refused here too.
  if [ -n "$ARCHITECT_PERSONA" ] && [ "$ARCHITECT_PERSONA" = "$COORDINATOR_PERSONA" ]; then
    echo "ERROR: $SETTINGS_FILE resolves '$ARCHITECT_PERSONA' as both coordinatorPersona and architectPersona; one persona cannot hold both seats" | tee -a "$LOG" >&2
    exit 1
  fi
fi

# --- Helper: log a line to supervisor.log ---
log() {
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "$ts $*" >> "$LOG"
  echo "$*"
}

# --- Helper: log a diagnostic line without touching stdout ---
# A helper whose stdout a caller captures via `$(...)`
# (run_bounded_powershell, check_snapshot_survivors) must never call
# plain `log`, which echoes to stdout as well as the log file - its own
# diagnostic line would ride straight into the caller's parsed result,
# read back as a phantom survivor pid. Same log file, same stderr
# visibility in a terminal, just never stdout.
log_diag() {
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "$ts $*" >> "$LOG"
  echo "$*" >&2
}

# --- Trap: clean up on exit ---
# The launched child's pid, `$!` of the `holder | child &` pipeline, which is
# the child stage. Every read of the child's pid goes through this variable.
# The child's stdin is held by bin/supervise-holder.sh; there is no descriptor
# to close, so the graceful stop kills the holder instead.
CHILD_LAUNCH_PID=""
# The holder that holds this child's stdin pipe: its MSYS and Windows pids and
# start ticks, recorded at launch or read from the handle at adoption, so the
# pipe-close phase kills the holder by an identity-guarded, ticks-matched kill.
HOLDER_LAUNCH_PID=""
HOLDER_WINPID=""
HOLDER_TICKS=""
# The current child's handle path, for clear_handle and the cleanup trap's
# detach route. Set per child at launch or adoption.
HANDLE_FILE=""
# The live child's own processes, recorded while it runs by refresh_child_tree:
# the MSYS pids of its process tree, the Windows pids those map to, and a
# "pid,ticks" snapshot of the Windows trees under them. Every read of this has
# to happen while the child is alive - `resolve_windows_pid` and the MSYS
# process table both lose a process the moment it exits - and after the wrapper
# is gone this snapshot is the only thing that can name what outlived it.
#
# CHILD_TREE_WINPIDS is the Windows pid set the standing snapshot was walked
# from, and CHILD_TREE_SEEN_WINPIDS is the newest set seen under a child that
# was still running it at the end of the poll that saw it, recorded whether or
# not its walk completed. The two differ exactly while the snapshot describes
# an older shape of the tree than the one the child has now, which is what
# `sweep_child_tree` refuses to read as a clean result. A closure member that
# exited inside its own walk is in neither set, since the pid it ran as is no
# longer its own and nothing the walk read of that pid is evidence about it.
# CHILD_TREE_WALKED is set once a walk has completed, so "no walk ever ran" is
# distinguishable from "a walk ran and found nothing alive".
#
# CHILD_TREE_READ_FAILED is set by a refresh that could read nothing at all,
# so a child whose tree was never readable is told from one that genuinely ran
# no Windows process. CHILD_TREE_DESCENDANT_SEEN is set once a walk has named
# a process other than the one the launch pid runs as, and
# CHILD_TREE_CONFIRMED_AT is when a poll last found the child running as the
# pid set the record was walked from, which the sweep's own lines report.
# `child_tree_record_state` reads every one of them, and each names a way a
# record falls short: the walked flag tells a record that exists from one no
# walk ever took, the two pid sets tell a record the child's pid set has moved
# past, the descendant flag tells a record naming only the wrapper, and the
# failed-confirm count and the stamp are the two bounds on how far back a
# confirmation can sit. None of those is a record a clean verdict can rest on.
#
# CHILD_TREE_SEEN_PAIRS is the latest poll's closure as "msys:winpid" pairs,
# which `stop_child` walks again when it stops the child. A pair whose MSYS
# process has since exited is walked there too and discarded there, so a stale
# pair costs a walk and never reaches the snapshot.
CHILD_TREE_MSYS_PIDS=""
CHILD_TREE_WINPIDS=""
CHILD_TREE_SEEN_WINPIDS=""
CHILD_TREE_SEEN_PAIRS=""
CHILD_TREE_SNAPSHOT=""
CHILD_TREE_WALKED=""
CHILD_TREE_READ_FAILED=""
CHILD_TREE_DESCENDANT_SEEN=""
CHILD_TREE_CONFIRMED_AT=""
# How many polls in a row have run without confirming the standing record
# against the live process table. This is what `child_tree_record_state` reads
# to call a record stale, since the record falls behind by polls that failed to
# confirm it and not by time: a poll body that takes a minute confirms the
# record just as a poll body that takes a second does.
CHILD_TREE_FAILED_CONFIRMS=0
LAST_STOP_SNAPSHOT=""  # the process-tree snapshot a stop or a sweep acted on, left for the retry and the EXIT trap
STOP_TREE_MOVED=""  # set where stop_child refused because the wrapper moved to a Windows pid no snapshot was walked from; the retry fails on it
STOP_SNAPSHOT_BUILT=""  # the merged snapshot build_stop_snapshot last built, empty where it could not verify one
# Initialized here so it is never unset under `set -u`: the "no child to
# stop" early return's own `log "... ($STOP_PATH)"` would otherwise abort
# the script.
STOP_PATH=""

# --- Helper: run a native command bounded, without inheriting the
# caller's own stdout ---
# A taskkill watchdog written as `( sleep 5; kill -9 "$tk" 2>/dev/null ) &`
# with no redirection inherits whatever fd its parent function's stdout
# currently is - in every production call, that is the caller's own
# `$(...)` capture pipe. The command substitution cannot return until
# every process holding a copy of that pipe's write end closes it,
# watchdog included, so a call that finishes its real work in 4s does not
# hand control back to the caller until 9s - a flat 5-10s tax on every
# expired call, for no reason connected to the actual work. Worse, `$tk`
# is itself a stub for a native `taskkill.exe` (bash exec-optimises the
# subshell), so `kill -9` on it is the same signal-based hang one level
# further removed. So every native command this script spawns and bounds
# goes through this helper, which redirects to `/dev/null` at the exec
# site itself (so nothing it holds can block a caller's pipe) and
# abandons rather than signals a command that outlives its bound (no
# second kill to hang on).
# Usage: run_bounded_native <bound-seconds> <command...>
run_bounded_native() {
  local bound="$1"
  shift
  ( exec "$@" ) > /dev/null 2>&1 &
  local npid=$!
  local nwaited=0
  while kill -0 "$npid" 2>/dev/null && [ "$nwaited" -lt "$bound" ]; do
    sleep 1
    nwaited=$((nwaited + 1))
  done
  if kill -0 "$npid" 2>/dev/null; then
    log_diag "STOP: a native call ($*) did not finish within ${bound}s - abandoning it rather than risking a second signal-based hang"
    return 124
  fi
  wait "$npid" 2>/dev/null
  return $?
}

cleanup() {
  local exit_code=$?
  # A signal that reaches a live child either detaches from it or stops it. A
  # handled child the instrument does not read gone is detached: the child and
  # its holder are left running for the next supervisor to adopt, which is the
  # operator's decision of 2026-09-17 (a scheduled-task stop leaves the session
  # running; the shutdown request file is the deliberate stop). Today's stop is
  # kept on a child with no readable handle and on one that reads gone.
  if [ -n "$CHILD_LAUNCH_PID" ] && kill -0 "$CHILD_LAUNCH_PID" 2>/dev/null; then
    local cleanup_verdict cleanup_readable cleanup_route
    cleanup_verdict="${POLL_LIVENESS%% *}"
    [ -n "$cleanup_verdict" ] || cleanup_verdict="alive"
    if [ -n "${HANDLE_FILE:-}" ] && [ -f "$HANDLE_FILE" ]; then cleanup_readable=1; else cleanup_readable=0; fi
    cleanup_route=$(handle_trap_route "$cleanup_readable" "$cleanup_verdict")
    if [ "$cleanup_route" = "DETACH" ]; then
      log "DETACH child-$CHILD_INDEX: signaled with a live handled child (verdict $cleanup_verdict); leaving it and its holder running for the next supervisor to adopt"
      exit "$exit_code"
    fi
    log "CLEANUP: stopping child-$CHILD_INDEX (pid $CHILD_LAUNCH_PID)"
    stop_child "cleanup"
    retry_stop_escalation "cleanup" $?
  elif [ -n "$LAST_STOP_SNAPSHOT" ]; then
    # The wrapper pid can be gone (an earlier stop_child call already
    # reaped it) while its own snapshot still shows a live descendant - a
    # dead wrapper with a surviving claude.exe. Keying this trap on the
    # wrapper pid alone would mean that survivor is never revisited on
    # this exit path, so it is keyed on the last known snapshot instead.
    #
    # `kill_process_snapshot` is called unconditionally rather than
    # guarded by a check for survivors: a guard that reads a timed-out
    # probe (empty output, rc 1) the same as "no survivors" is fail-open.
    # `kill_process_snapshot` is ticks-matched and re-verifies its own
    # kill, so it is never a blind kill on a snapshot that might already
    # be dead, and it fails closed on its own unverifiable read rather
    # than this call site guessing first.
    log "CLEANUP: wrapper already gone; re-verifying its last known process tree before exit"
    if kill_process_snapshot "$LAST_STOP_SNAPSHOT"; then
      log "CLEANUP: tree confirmed dead"
    else
      log "CLEANUP: tree could not be confirmed dead (survivor or unverifiable read) - exiting anyway"
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- AD3: Stop the child via EOF (close write end), then TERM, then KILL ---
# --- Helper: resolve an MSYS pid's current Windows pid ---
# `/proc/<pid>/winpid` is the primary read, and `ps` is the fallback for a
# pid `/proc` has no entry for. Cygwin `ps` prints a state character in
# column 1 for a stopped or an orphaned process, which shifts every column
# right by one: WINPID sits in column 4 on an ordinary row and column 5 on
# a shifted one, while column 4 of a shifted row is the process group id,
# which is digits and so passes every validation a bare column read would
# apply. So the row is tested for the shift and read at the offset that
# row actually uses. The result is validated as pure digits before it is
# trusted - an unvalidated read here is exactly what would let a malformed
# value reach an interpolated PowerShell command string. Must be called
# while the MSYS pid is still alive and tracked - once it exits, both
# reads find nothing.
# Usage: resolve_windows_pid <msys-pid>
resolve_windows_pid() {
  local pid="$1"
  local winpid=""
  # Read with the shell's own `read`, which launches nothing: this runs for
  # every process under the child on every poll.
  if [ -r "/proc/$pid/winpid" ]; then
    { IFS= read -r winpid < "/proc/$pid/winpid"; } 2>/dev/null || true
  fi
  if [ -z "$winpid" ]; then
    winpid=$(ps -p "$pid" 2>/dev/null | tail -n +2 | awk '
      $1 ~ /^[0-9]+$/ { print $4; exit }
      $2 ~ /^[0-9]+$/ { print $5; exit }')
  fi
  case "$winpid" in
    ''|*[!0-9]*) return 0 ;;  # empty or non-numeric: refuse to interpolate it anywhere
    *) echo "$winpid" ;;
  esac
}

# --- Helper: run a PowerShell -Command script under a real wall-clock bound
# ---
# GNU `timeout` does not terminate native powershell.exe on this box -
# `timeout 3 powershell -NoProfile -Command "Start-Sleep -Seconds 12;
# Write-Output done"` prints `done` and only then returns 124. GNU
# timeout signals the MSYS stub process it forks; powershell.exe itself
# ignores that signal, and bash waits for the real process regardless -
# so wrapping a PowerShell call in `timeout` does not actually bound it,
# and a hung CIM query would still wedge stop_child (and, through the
# EXIT trap, the supervisor's own shutdown). This helper exists instead.
#
# A bare `kill -9` on the tail-exec subshell's own pid does not hold
# under load: run inside `$(...)` (the shape every caller uses), a 3s
# bound around a long sleep can return rc 124 long after the bound with
# the sleep's own late output still in the result, because the native
# process outlives the kill and the caller's `$(...)` blocks on an
# inherited pipe handle until it exits on its own. So the caller supplies
# `<outfile>` directly and reads it itself after this function returns,
# rather than this function writing its own stdout into the caller's
# `$(...)` capture (a pipe a live, possibly-orphaned process can hold
# open indefinitely; a plain read of a file that already exists cannot
# hang the same way); and the Windows pid is resolved right after spawn
# (polled, not only at the deadline, since it is easiest to read while
# the process is fresh) and killed via `taskkill //F //PID` on expiry.
#
# `kill -9` on the stub itself is not a safe fallback signal here - it
# can block for minutes and then return "Permission denied", the same
# shape of hang this whole helper exists to prevent, just moved one line
# down. So the stub is never signaled at all on expiry.
#
# The tail-exec subshell does not always collapse into one process under
# load: it can be three - the MSYS stub this function's own `$!` names,
# an intermediate `bash.exe`, and `powershell.exe` itself. No tree kill
# reaches from the stub to `powershell.exe`: `taskkill //T` re-walks the
# live parent ids at kill time, Windows keeps a dead parent's id in the
# orphans it left and reuses the id, so a walk from the stub can reach a
# process that was never started here. So the launched script's very
# first statement writes its own real Windows pid (`$PID`, PowerShell's
# own automatic variable - always correct, no CIM query needed) as a
# `PSPID:<pid>` line, read from the output file while waiting rather than
# only at the deadline. On expiry, that self-reported pid is killed
# directly, the stub's own Windows pid is killed as a second call, and
# both calls' exit codes are logged rather than discarded. A
# `powershell.exe` that never wrote its `PSPID` line is not killed at all
# and is left running, since nothing names it but a parent-id walk; the
# caller reads the output file and is not blocked by it. Each `taskkill`
# is itself backgrounded and capped at 5s rather than run as an unbounded
# native spawn inside a function that exists to bound exactly that shape
# of call.
# Usage: run_bounded_powershell <bound-seconds> <script> <outfile>
run_bounded_powershell() {
  local bound="$1"
  local script="$2"
  local outfile="$3"
  local errfile start_ts
  errfile=$(mktemp)
  start_ts=$(date +%s)
  ( exec powershell -NoProfile -Command "Write-Output (\"PSPID:\" + \$PID); $script" >"$outfile" 2>"$errfile" ) &
  local ps_pid=$!
  local ps_winpid="" wpoll=0
  while [ -z "$ps_winpid" ] && [ "$wpoll" -lt 5 ] && kill -0 "$ps_pid" 2>/dev/null; do
    ps_winpid=$(resolve_windows_pid "$ps_pid")
    [ -z "$ps_winpid" ] && sleep 1
    wpoll=$((wpoll + 1))
  done
  # Self-reported real pid of the launched powershell.exe process itself -
  # read opportunistically from the output file as it becomes available,
  # not just at the deadline, since the file may not have its first line
  # yet this early.
  local ps_real_pid=""
  local waited=0
  while kill -0 "$ps_pid" 2>/dev/null && [ "$waited" -lt "$bound" ]; do
    if [ -z "$ps_real_pid" ] && [ -s "$outfile" ]; then
      ps_real_pid=$(head -1 "$outfile" 2>/dev/null | tr -d '\r' | sed -n 's/^PSPID:\([0-9]*\)$/\1/p')
    fi
    sleep 1
    waited=$((waited + 1))
  done
  local status elapsed
  if kill -0 "$ps_pid" 2>/dev/null; then
    [ -z "$ps_winpid" ] && ps_winpid=$(resolve_windows_pid "$ps_pid")
    [ -z "$ps_real_pid" ] && [ -s "$outfile" ] && ps_real_pid=$(head -1 "$outfile" 2>/dev/null | tr -d '\r' | sed -n 's/^PSPID:\([0-9]*\)$/\1/p')
    local rc_real="n/a" rc_stub="n/a"
    if [ -n "$ps_real_pid" ]; then
      run_bounded_native 5 taskkill //F //PID "$ps_real_pid"
      rc_real=$?
    fi
    if [ -n "$ps_winpid" ]; then
      run_bounded_native 5 taskkill //F //PID "$ps_winpid"
      rc_stub=$?
    fi
    log_diag "STOP: taskkill on the real powershell pid ${ps_real_pid:-unresolved} rc=$rc_real; taskkill on stub winpid ${ps_winpid:-unresolved} rc=$rc_stub"
    # Bounded reap, not a blocking `wait`: taskkill is the only
    # termination attempted (see the addendum above). `wait`'s own exit
    # status is never used here (status is already 124, unconditionally,
    # in this branch), so it is skipped entirely once the stub is
    # confirmed gone or the bound below expires - never called
    # unconditionally, which is exactly what could block indefinitely on
    # a stub that will not die.
    local reap_wait=0
    while kill -0 "$ps_pid" 2>/dev/null && [ "$reap_wait" -lt 5 ]; do
      sleep 1
      reap_wait=$((reap_wait + 1))
    done
    if ! kill -0 "$ps_pid" 2>/dev/null; then
      wait "$ps_pid" 2>/dev/null
    else
      log_diag "STOP: the stub pid $ps_pid was still present 5s after taskkill on winpid ${ps_winpid:-unresolved} - leaving it for the OS to reap rather than blocking on it"
    fi
    status=124
    elapsed=$(( $(date +%s) - start_ts ))
    log_diag "STOP: a PowerShell call exceeded its ${bound}s bound (elapsed ${elapsed}s) and was force-killed"
  else
    wait "$ps_pid"
    status=$?
    elapsed=$(( $(date +%s) - start_ts ))
    log_diag "STOP: a PowerShell call completed in ${elapsed}s (bound ${bound}s)"
  fi
  cat "$errfile" >> "$RUNDIR/supervisor.err"
  rm -f "$errfile"
  return "$status"
}

# --- Helper: run_bounded_powershell, but return CR-stripped stdout as text
# ---
# The three callers below each want the same thing: bound the call, get its
# stdout back as a string, and get the same status back. Written once here
# rather than three times so R79's file-not-pipe fix (above) can't drift
# out of sync in one of the three copies.
# Usage: run_bounded_powershell_capture <bound-seconds> <script>
run_bounded_powershell_capture() {
  local bound="$1"
  local script="$2"
  local outfile status
  outfile=$(mktemp)
  run_bounded_powershell "$bound" "$script" "$outfile"
  status=$?
  # The self-reported "PSPID:<pid>" line (R92, above) is run_bounded_
  # powershell's own bookkeeping, never part of the script's own output -
  # stripped here so no caller's sentinel or pair parsing ever sees it.
  tr -d '\r' < "$outfile" | grep -v '^PSPID:[0-9]*$'
  rm -f "$outfile"
  return "$status"
}

# --- Helper: the PowerShell descendant walk, over a process table it is
# handed ---
# Prints the definition of a PowerShell function, `Select-ProcessTree
# <rows> <rootId>`. `<rows>` is a process table, one object per process
# carrying `ProcessId`, `ParentProcessId` and `CreationDate`, the shape
# `Get-CimInstance Win32_Process` returns. The function returns an object
# whose `Ids` are the root's descendants, root excluded, and whose
# `Unverified` is true where the walk met a candidate it could not judge.
#
# A process is accepted as a child only where its own creation time is not
# earlier than its parent's. Windows keeps a dead parent's id in every
# orphan that parent left and hands the id out again, so a process whose
# ParentProcessId names a tree member but which was created before that
# member is an orphan of an earlier holder of the id. It is no part of this
# tree, and neither is anything under it. Following the parent id alone
# would put it on the kill list every caller of the snapshot acts on.
#
# A candidate whose own creation time, or whose parent's, cannot be read is
# not accepted, since nothing tells it apart from such an orphan. That
# includes every row naming a root that is absent from the table. Leaving
# it out keeps it off the kill list, and `Unverified` reports that the walk
# could not account for it, so a caller reads the tree as unverified rather
# than as complete.
#
# The table is an argument rather than a query inside the function so that
# a test can drive this exact walk against a synthetic table.
# Usage: process_tree_walk_ps
process_tree_walk_ps() {
  cat <<'PS'
    function Select-ProcessTree($rows, $rootId) {
      $created = @{}
      $byParent = @{}
      foreach ($r in @($rows)) {
        $rid = [int64]$r.ProcessId
        $created[$rid] = $r.CreationDate
        $rpp = [int64]$r.ParentProcessId
        if (-not $byParent.ContainsKey($rpp)) { $byParent[$rpp] = New-Object System.Collections.ArrayList }
        [void]$byParent[$rpp].Add($r)
      }
      $accepted = New-Object 'System.Collections.Generic.List[long]'
      $seen = New-Object 'System.Collections.Generic.HashSet[long]'
      $pending = New-Object 'System.Collections.Generic.Queue[long]'
      $unverified = $false
      [void]$seen.Add([int64]$rootId)
      $pending.Enqueue([int64]$rootId)
      while ($pending.Count -gt 0) {
        $parentId = $pending.Dequeue()
        if (-not $byParent.ContainsKey($parentId)) { continue }
        $parentCreated = $created[$parentId]
        foreach ($c in $byParent[$parentId]) {
          $cid = [int64]$c.ProcessId
          if ($cid -eq $parentId) { continue }
          if ($null -eq $parentCreated -or $null -eq $c.CreationDate) {
            $unverified = $true
            continue
          }
          if ($c.CreationDate -lt $parentCreated) { continue }
          if (-not $seen.Add($cid)) { continue }
          $accepted.Add($cid)
          $pending.Enqueue($cid)
        }
      }
      [pscustomobject]@{ Ids = $accepted.ToArray(); Unverified = $unverified }
    }
PS
}

# --- Helper: snapshot a Windows pid's whole descendant tree, without
# killing anything ---
# Walking Win32_Process's ParentProcessId *after* the root pid has
# already been signaled would read a tree that may no longer exist, or
# worse, a *recycled* pid the OS reused for an unrelated process -
# Windows keeps a dead process's ParentProcessId association and reuses
# pids quickly, so a late walk from `$winpid` could find and then
# force-kill something that was never part of this tree at all. This
# function only ever reads; the snapshot it returns is what stop_child
# kills, at whatever point stop_child chooses to kill it - never a live
# re-walk. The walk itself is `process_tree_walk_ps`, which accepts a child
# only where it is not older than its parent and marks a walk that met a
# child it could not judge; this function reads that mark as an unverified
# snapshot. A visited set stops a cycle (a recycled pid pointing back into
# the same tree) from looping forever.
#
# A snapshot of bare pids is not enough - up to two minutes can pass
# between this snapshot and the kill/verify that acts on it (the EOF and
# TERM grace periods), during which a short-lived descendant (a hook's
# own `node`, a `git`) can exit and have its pid reused by an unrelated
# process. Each line is `pid,startticks`, so every later consumer can tell a
# genuinely surviving process from a same-numbered impostor by comparing tick
# values, not just pid presence.
#
# The ticks are tied to the process table the walk judged. A pid is listed
# only where that table holds a row for it, the root included, and only where
# `Get-Process`'s `StartTime` for the pid agrees with that row's
# `CreationDate`. `CreationDate` carries microseconds and `StartTime` carries
# 100-nanosecond ticks, so the two agree where the live ticks, floored to a
# whole microsecond, equal the row's. The line records the live ticks, which
# is the value `check_snapshot_survivors` and `kill_process_snapshot` compare
# against. A pid whose live start time disagrees with its row is held by a
# process the walk never judged, so the whole snapshot reads as unverified. A
# pid with no row is not in the table the walk judged, and is left out.
#
# This call is bounded like the kill and verify calls below it - a hung
# CIM query here wedges stop_child exactly as one in the kill path would.
# GNU `timeout` does not actually hold on this box; the bound is
# `run_bounded_powershell`, not `timeout`.
#
# Output is piped through `tr -d '\r'`: PowerShell emits CRLF even under
# `-NoProfile`, and an unstripped `\r` embedded in a pid produces a
# `Missing expression after unary operator ','` PowerShell parse error at
# the kill call, and a second, quieter failure at the per-pid liveness
# probe (`-ErrorAction` parsed as a second statement). Stripped once,
# here, at the source, so nothing downstream ever sees a `\r` at all.
#
# A process whose `StartTime` is unreadable (access denied, a transient
# race, or a protected process that reads back no start time), or whose row
# carries no `CreationDate`, emits the literal marker `UNREADABLE` in the
# ticks field rather
# than a bare `pid,` with nothing after the comma, so `check_snapshot_
# survivors` below can treat it as an automatic, unconditional survivor
# rather than silently discarding it: kept on the kill list but dropped
# from a digit-validated survivor check would leave it never confirmed
# dead either way.
#
# A caller tells a timeout or PowerShell failure apart from a genuinely
# empty tree by this function's own return code:
# `run_bounded_powershell_capture` returns its bound status directly, so
# no local `pipefail` scoping is needed here to preserve it through a
# pipe.
#
# This is the single place a snapshot is produced, so it is where this
# supervisor's own Windows pid is refused: the walk follows Windows
# ParentProcessId, Windows recycles that id, and a recycled parent id is
# enough to pull a process that is no part of the tree being walked into
# the result a caller will later kill. A self pid appearing anywhere in
# the walk refuses the whole snapshot rather than dropping that one row,
# since every process the walk reached through this one is under it in a
# tree this process is no part of. A self pid this cannot resolve at all
# is refused the same way, since a filter that cannot name what it must
# exclude has nothing to exclude it by, and every caller already reads a
# non-zero return as a tree it may not act on.
#
# The root pid is validated as digits at entry, the way the two functions
# that consume this output validate every pair they are handed: this
# builds a PowerShell command with that value interpolated into it, so a
# value that is not a number has no safe reading here.
# Usage: snapshot_process_tree <windows-pid>
snapshot_process_tree() {
  local winpid="$1"
  if [ -z "$winpid" ]; then
    return 0
  fi
  case "$winpid" in
    *[!0-9]*)
      log_diag "STOP: a walk was asked for from '$winpid', which is not a Windows pid - refusing to build a process walk around it"
      return 1
      ;;
  esac
  local self_winpid
  self_winpid=$(resolve_windows_pid "$$")
  if [ -z "$self_winpid" ]; then
    log_diag "STOP: this supervisor's own Windows pid does not resolve, so a walk under $winpid cannot be filtered of it - reporting the snapshot unverified rather than recording one that may name this process"
    return 1
  fi
  if [ "$winpid" = "$self_winpid" ]; then
    log_diag "STOP: a walk was asked for from this supervisor's own Windows pid $winpid - refusing to snapshot this process's own tree"
    return 1
  fi
  # The process table is read once, in one query, and the walk runs over
  # that table, so every creation time the walk compares comes from the
  # same reading. A failed query sets a flag and the script emits a bare
  # `CIMFAIL` line after the id loop, from the top-level script, so the
  # marker reaches real stdout rather than joining the id list. A walk that
  # met a child it could not judge emits `WALKUNVERIFIED` the same way, and a
  # root that has no row while a live process still holds its id emits
  # `ROOTUNJUDGED`. The id list is filtered with a numeric-string match rather than an
  # `-is [int]` type check, so a stray non-numeric value never reaches
  # `Get-Process -Id`.
  local raw
  raw=$(run_bounded_powershell_capture "$SUPERVISOR_PS_BOUND_S" "
      $(process_tree_walk_ps)
      \$cimFailed = \$false
      \$rows = @()
      try {
        \$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop)
      } catch {
        \$cimFailed = \$true
      }
      \$walk = Select-ProcessTree \$rows $winpid
      \$rowCreated = @{}
      foreach (\$r in \$rows) { \$rowCreated[[int64]\$r.ProcessId] = \$r.CreationDate }
      \$ticksMismatch = \$false
      \$rootUnjudged = \$false
      \$ids = @($winpid) + @(\$walk.Ids) | Where-Object { \$_ -match '^[0-9]+\$' }
      foreach (\$thisId in \$ids) {
        if (-not \$rowCreated.ContainsKey([int64]\$thisId)) {
          if ([int64]\$thisId -eq [int64]$winpid) {
            \$rootProc = Get-Process -Id \$thisId -ErrorAction SilentlyContinue
            if (\$rootProc) { \$rootUnjudged = \$true }
          }
          continue
        }
        \$rowWhen = \$rowCreated[[int64]\$thisId]
        \$proc = Get-Process -Id \$thisId -ErrorAction SilentlyContinue
        if (-not \$proc) { continue }
        \$started = \$null
        try { \$started = \$proc.StartTime } catch {}
        if (\$null -eq \$rowWhen -or \$null -eq \$started) {
          Write-Output (\"\$thisId,UNREADABLE\")
          continue
        }
        \$liveTicks = [int64]\$started.Ticks
        \$rowTicks = [int64]\$rowWhen.Ticks
        if (\$liveTicks -ne \$rowTicks -and (\$liveTicks - (\$liveTicks % 10)) -ne \$rowTicks) {
          \$ticksMismatch = \$true
          continue
        }
        Write-Output (\"\$thisId,\" + \$liveTicks)
      }
      if (\$cimFailed) { Write-Output 'CIMFAIL' }
      if (\$walk.Unverified) { Write-Output 'WALKUNVERIFIED' }
      if (\$ticksMismatch) { Write-Output 'TICKSMISMATCH' }
      if (\$rootUnjudged) { Write-Output 'ROOTUNJUDGED' }
      Write-Output '$STOP_PS_SENTINEL'
    ")
  # A CIM query that fails (WMI down, a transient RPC error) under
  # `-ErrorAction SilentlyContinue` would silently yield an empty children
  # list - the walk still finishes, the sentinel still gets written, and a
  # root-only snapshot (missing every real descendant) reports rc 0. A
  # timed-out walk really does yield nothing (the sentinel gates that),
  # but a *failed* walk should not read the same way. `-ErrorAction Stop`
  # inside a `try`/`catch` turns that failure into an explicit `CIMFAIL`
  # marker in the output, checked before trusting the snapshot.
  if printf '%s\n' "$raw" | grep -qx 'CIMFAIL'; then
    log_diag "STOP: snapshot_process_tree's own CIM query failed mid-walk - treating the snapshot as unverified rather than trusting a possibly-incomplete tree"
    return 1
  fi
  # A child left out because its creation time, or its parent's, could not
  # be read is off the kill list, and the tree it may belong to is not
  # accounted for. So the snapshot is unverified, which every caller already
  # reads as a tree it may neither kill from nor call clean.
  if printf '%s\n' "$raw" | grep -qx 'WALKUNVERIFIED'; then
    log_diag "STOP: the walk under $winpid met a process whose creation time, or its parent's, could not be read - treating the snapshot as unverified rather than trusting a tree that leaves it out"
    return 1
  fi
  # A pid whose live start time disagrees with the row the walk judged is held
  # by a different process than the one the walk accepted, so the snapshot
  # cannot say which of the two its line would name.
  if printf '%s\n' "$raw" | grep -qx 'TICKSMISMATCH'; then
    log_diag "STOP: the walk under $winpid names a pid whose live start time disagrees with the process table the walk judged - treating the snapshot as unverified rather than recording a process the walk never judged"
    return 1
  fi
  # The root is this walk's argument rather than a row the walk found, so a
  # root with no row in the table is a pid the walk never judged and is left
  # off the kill list. Whether that is the whole answer depends on the pid: a
  # root that exited between the walk and the table read leaves an honestly
  # empty tree, while a root a live process still holds cannot have been
  # missing from a table read across its own lifetime. That reading is a
  # partial enumeration, so the tree under it is unaccounted for and the whole
  # walk is unverified rather than an empty result a caller would call clean.
  if printf '%s\n' "$raw" | grep -qx 'ROOTUNJUDGED'; then
    log_diag "STOP: the walk under $winpid found no process table row for that root while a live process still holds the id - treating the snapshot as unverified rather than reporting an empty tree under a root the table never named"
    return 1
  fi
  if printf '%s\n' "$raw" | grep -qx "$STOP_PS_SENTINEL"; then
    if printf '%s\n' "$raw" | grep -q "^$self_winpid,"; then
      log_diag "STOP: the tree walked under $winpid reaches this supervisor's own Windows pid $self_winpid, so every process in it was reached through this process - reporting the whole walk unverified rather than the part of it that sits outside this tree"
      return 1
    fi
    local line
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      [ "$line" = "$STOP_PS_SENTINEL" ] && continue
      printf '%s\n' "$line"
    done <<< "$raw"
    return 0
  fi
  # `powershell -Command`'s own exit code reflects whether its LAST
  # statement succeeded, not an aggregate error count, so a completely
  # normal "the pid is already gone" result cannot be trusted as
  # completion on its own. The sentinel line above is what actually
  # decides completion; its absence here means the call was force-killed
  # on the run_bounded_powershell timeout before reaching it, or
  # genuinely crashed - either way the walk did not finish.
  return 1
}

# --- Helper: which pids in a snapshot are still the SAME live process ---
# Shared by verify_snapshot_dead (does anything need escalating) and
# kill_process_snapshot (did the kill actually work) so the recycled-pid
# comparison and the CR-stripped, timeout-wrapped read live in exactly
# one place. A survivor is a pid that is both alive right now AND whose
# current `StartTime.Ticks` still matches the value recorded in the
# snapshot - a live pid with a different start time is a different,
# unrelated process that happens to share a number.
#
# A pid whose `StartTime` came back `UNREADABLE` from the snapshot is
# reported as a survivor only while a process with that pid still exists
# (checked by a plain existence probe, since its start time cannot be
# compared), never unconditionally: a pid this cannot resolve at all must
# fail closed rather than open, but one that no longer exists is
# genuinely gone. On an unverified call (the sentinel missing), this
# returns nothing and status 1 rather than the full checked-id list,
# since a caller that force-kills a returned list as confirmed survivors
# is killing by bare pid number with no start-time match at all - a mass
# kill of whatever now holds those recycled numbers. A caller escalates
# on silence it cannot trust rather than on nothing.
#
# Every diagnostic here goes through `log_diag` (stderr and the log file
# only), never plain `log`, because this function's own stdout is what a
# caller parses as the survivor list; a `log` call here would ride into
# that parsed result as a phantom entry.
# Usage: check_snapshot_survivors <snapshot, "pid,ticks" per line>
check_snapshot_survivors() {
  local snapshot="$1"
  if [ -z "$snapshot" ]; then
    return 0
  fi
  local pairs="" unreadable="" sid sticks
  while IFS=',' read -r sid sticks; do
    case "$sid" in ''|*[!0-9]*) continue ;; esac
    case "$sticks" in
      ''|*[!0-9]*) unreadable="$unreadable,$sid"; continue ;;
    esac
    pairs="$pairs,@{Id=$sid;Ticks=$sticks}"
  done <<< "$snapshot"
  pairs="${pairs#,}"
  unreadable="${unreadable#,}"
  if [ -z "$pairs" ] && [ -z "$unreadable" ]; then
    # Reaching here means $snapshot was non-empty (the early
    # `-z "$snapshot"` return above already handles a genuinely empty
    # one) but nothing in it parsed as a valid pid entry - that is a
    # parse failure, not "nothing to check", and does not read as a
    # clean, verified result.
    log_diag "STOP: check_snapshot_survivors got a non-empty snapshot with no parseable pid entries - treating as unverified"
    return 1
  fi
  # `StartTime` can throw at read time - a transient race, not just at
  # snapshot time. Under `-Command`, an unguarded throw would abort only
  # that one loop iteration; the loop would continue, the sentinel would
  # still get written, and the whole call would report rc-equivalent
  # success with the live process silently omitted - reported dead, never
  # a survivor, never killed. Guarded the same way the snapshot walk
  # already is.
  local raw
  raw=$(run_bounded_powershell_capture "$SUPERVISOR_PS_BOUND_S" "
      foreach (\$e in @($pairs)) {
        \$proc = Get-Process -Id \$e.Id -ErrorAction SilentlyContinue
        try {
          if (\$proc -and \$proc.StartTime.Ticks -eq \$e.Ticks) { Write-Output \$e.Id }
        } catch { if (\$proc) { Write-Output \$e.Id } }
      }
      foreach (\$u in @($unreadable)) {
        \$proc = Get-Process -Id \$u -ErrorAction SilentlyContinue
        if (\$proc) { Write-Output \$u }
      }
      Write-Output '$STOP_PS_SENTINEL'
    ")
  if ! printf '%s\n' "$raw" | grep -qx "$STOP_PS_SENTINEL"; then
    log_diag "STOP: check_snapshot_survivors's powershell call did not complete - reporting failure, not a survivor list"
    return 1
  fi
  printf '%s\n' "$raw" | grep -vx "$STOP_PS_SENTINEL"
  return 0
}

# --- Helper: force-kill every pid in a snapshot, with a bounded wait and
# a verified result ---
# A PowerShell error swallowed unconditionally would report success even
# when a slow or hung CIM query wedges stop_child - which the EXIT trap
# also calls, wedging the supervisor itself on shutdown. So
# `run_bounded_powershell` bounds the PowerShell call; its own exit
# status is captured (not discarded); and every pid in the snapshot is
# re-checked (via check_snapshot_survivors, matching both pid and start
# time) rather than trusted from Stop-Process's own silence. Logs
# `kill_failed` naming exactly which pids survived, if any do, and
# returns non-zero so a caller can tell.
#
# Stripping the start time and running `Stop-Process -Id $p -Force` on a
# bare pid number would turn an unverified probe upstream into a kill of
# whatever now holds those pid numbers, recycled or not. Kills only pairs
# where `Get-Process -Id` still finds the pid AND its `StartTime.Ticks`
# still matches what was recorded in the snapshot - the same match
# `check_snapshot_survivors` uses to decide who's a real survivor in the
# first place.
#
# Force-killing an `UNREADABLE`-ticks pid by bare existence alone would
# kill by number, not by identity, once that pid is recycled during the
# grace window: its start time was unreadable at snapshot time, so
# existence is the only check available for it. `check_snapshot_
# survivors` still reports one as a survivor by existence, but this
# function never kills on that report.
#
# A single check here, rather than an internal retry loop stacked
# underneath `retry_stop_escalation`'s own 6-attempt loop, keeps the
# worst-case stop from taking minutes instead of the ~30s bound this
# comment names. `retry_stop_escalation` is the single place that
# retries over time, on its own wall-clock budget.
#
# Returns 0 when every pid in the snapshot is confirmed gone, and 1 when a
# pid is confirmed alive after the kill or the re-check itself could not be
# completed. Both are the same answer to a caller: nothing in this snapshot
# is confirmed dead.
# Usage: kill_process_snapshot <snapshot, "pid,ticks" per line>
kill_process_snapshot() {
  local snapshot="$1"
  if [ -z "$snapshot" ]; then
    return 0
  fi
  local pairs="" sid sticks
  while IFS=',' read -r sid sticks; do
    case "$sid" in ''|*[!0-9]*) continue ;; esac
    case "$sticks" in ''|*[!0-9]*) continue ;; esac
    pairs="$pairs,@{Id=$sid;Ticks=$sticks}"
  done <<< "$snapshot"
  pairs="${pairs#,}"
  if [ -z "$pairs" ]; then
    log "STOP: kill_process_snapshot has no ticks-matched pairs to act on (any UNREADABLE entries are reported, per R91, never killed)"
  else
    # The same unguarded `StartTime` read here, on the kill side, means a
    # throw makes this loop iteration silently skip a pid that should
    # have been killed - never fatal (the pid just survives to be
    # re-checked), but it should never be read as a ticks mismatch and
    # killed on an unverifiable comparison either. The catch is
    # deliberately empty: this script never claims to report anything on
    # its own here, since the caller's own separate `check_snapshot_
    # survivors` call afterward re-examines the same pid independently.
    local raw
    raw=$(run_bounded_powershell_capture "$SUPERVISOR_PS_BOUND_S" "
      foreach (\$e in @($pairs)) {
        \$proc = Get-Process -Id \$e.Id -ErrorAction SilentlyContinue
        try {
          if (\$proc -and \$proc.StartTime.Ticks -eq \$e.Ticks) {
            try { Stop-Process -Id \$e.Id -Force -ErrorAction SilentlyContinue } catch {}
          }
        } catch {}
      }
      Write-Output '$STOP_PS_SENTINEL'
    ")
    if ! printf '%s\n' "$raw" | grep -qx "$STOP_PS_SENTINEL"; then
      log "STOP: kill_process_snapshot's powershell call did not complete (timeout or error)"
    fi
  fi
  local survivors rc
  survivors=$(check_snapshot_survivors "$snapshot")
  rc=$?
  if [ -z "$survivors" ] && [ "$rc" -eq 0 ]; then
    return 0
  fi
  if [ "$rc" -ne 0 ]; then
    log "STOP: kill_unverified - the re-check after the kill did not complete, so nothing in this snapshot is confirmed alive or dead"
    return 1
  fi
  log "STOP: kill_failed - these Windows pids still hold a live process after the kill: $(echo "$survivors" | tr '\n' ' ')"
  return 1
}

# --- Helper: walk an MSYS process's Windows tree, and keep the walk only while
# the MSYS process still runs as that Windows pid ---
# An MSYS pid is resolved to a Windows pid and walked one PowerShell spawn
# later. Windows hands a dead process's id out again, so where the MSYS
# process exits in between, the walk can read whatever now holds that id, and
# every line it returns names a process the child never started. So after the
# walk returns, the MSYS pid must still be running and must still resolve to
# the Windows pid that was walked. Otherwise the walk's lines are discarded.
#
# The liveness check runs ahead of the walk's own return code, and that order
# is what tells two discards apart. An MSYS process that has exited is no part
# of the tree any more, whatever its walk said: the walk read a Windows pid the
# process no longer holds, so an unverified reading of that pid is no more
# evidence about the child's tree than a clean one would be. An MSYS process
# that is still running and now holds a different Windows pid is the other
# case: the process is part of the tree and this walk says nothing about it.
#
# Prints the walk's "pid,ticks" lines on success.
# Returns 0 for a walk that holds, 3 where the MSYS process exited during the
# walk, 4 where it is still running under a different Windows pid, 1 where the
# walk completed and named nothing at all under a root the MSYS pid still
# holds, and the walk's own non-zero code for a walk that did not complete
# under an MSYS process that is still running as the pid walked.
# Usage: walk_msys_process_tree <msys-pid> <windows-pid>
walk_msys_process_tree() {
  local msys_pid="$1" winpid="$2" walked rc now_winpid
  walked=$(snapshot_process_tree "$winpid")
  rc=$?
  if ! kill -0 "$msys_pid" 2>/dev/null; then
    log_diag "CHILDTREE: MSYS pid $msys_pid exited while Windows pid $winpid was walked - discarding that walk, which may have read a process that reused the id"
    return 3
  fi
  if [ "$rc" -ne 0 ]; then
    return "$rc"
  fi
  now_winpid=$(resolve_windows_pid "$msys_pid")
  if [ "$now_winpid" != "$winpid" ]; then
    log_diag "CHILDTREE: MSYS pid $msys_pid runs as Windows pid ${now_winpid:-none} after its walk of Windows pid $winpid - discarding that walk"
    return 4
  fi
  # A completed walk always names its own root, since the root's line is
  # written from the same table row the walk judged it by. So a walk that named
  # nothing at all, while the MSYS process is alive and still runs as the
  # Windows pid that was walked, read a table that did not cover a process
  # living across its own reading. That is a partial enumeration and the tree
  # under it is unaccounted for, the same answer `snapshot_process_tree` gives
  # a root it could not judge, rather than an empty tree a caller would call
  # clean.
  if [ -z "$walked" ]; then
    log_diag "CHILDTREE: the walk of Windows pid $winpid named no process at all while MSYS pid $msys_pid still runs as that pid - reporting the walk unverified rather than an empty tree under a live root"
    return 1
  fi
  printf '%s\n' "$walked"
  return 0
}

# --- Helper: record the live child's process tree, pids and start ticks ---
# The Windows parent chain does not reach the child. `claude` is launched
# through `env`, and the chain read upward from the live child runs `claude`
# under a live `env.exe` under a process id nothing holds any more, the Cygwin
# fork intermediate above `env` having exited: a Win32 walk from the launch pid's
# own Windows pid finds that pid and nothing else. The MSYS process table is where the link survives,
# since it keeps the launch pid as the parent of the `claude` process and
# carries each one's Windows pid beside it. So the tree is read from there, and
# only while the child is alive: an exited process is in neither table.
#
# The Windows pids are then snapshotted the way every other stop-path consumer
# wants them, "pid,ticks" per line, so `check_snapshot_survivors` and
# `kill_process_snapshot` can match a genuine survivor against a recycled pid
# without any further identity check here.
#
# What a poll costs: one `ps` read, plus one `/proc/<pid>/winpid` read per MSYS
# pid in the closure and one for this supervisor itself. The PowerShell walk
# runs only where the Windows pid set differs from the set the standing
# snapshot was walked from, so a child whose tree has settled pays no walk,
# while a child whose walk keeps failing pays one on every poll until a walk
# completes.
refresh_child_tree() {
  local pid="${CHILD_LAUNCH_PID:-}"
  # What this call's walk found, for the liveness verdict: live where it
  # completed and named a live process, none where it completed and found
  # every process gone, failed where it did not complete. Set to failed first,
  # so every return that is not a completed walk reads as one.
  CHILD_TREE_POLL_WALK="failed"
  if [ -z "$pid" ]; then
    return 0
  fi
  # This poll's closure as "msys:winpid" pairs, cleared of this supervisor's
  # own Windows pid. `stop_child` walks each pair again at the stop. Emptied
  # here first, so a poll that cannot name the closure leaves no pairs from an
  # earlier poll standing in for it.
  CHILD_TREE_SEEN_PAIRS=""
  # Descendants are closed over the MSYS table rather than read one level
  # deep: the chain from the launch pid to `claude` is two MSYS processes on some
  # launch shapes and one on others, and a wrapper script adds another.
  local msys_pids
  msys_pids=$(ps 2>/dev/null | awk -v root="$pid" '
    NR > 1 {
      # Cygwin ps prints a state character ahead of the pid for a stopped or
      # an orphaned process, which shifts every column right by one. A row read
      # at the unshifted offsets yields a parent id that is really a pid, so
      # that pid and every descendant under it fall out of the closure, and an
      # orphaned process is exactly what this closure exists to catch. So the
      # shift is detected and the row re-indexed rather than discarded.
      if ($1 ~ /^[0-9]+$/) { id = $1; pp = $2; wp = $4 }
      else if ($2 ~ /^[0-9]+$/) { id = $2; pp = $3; wp = $5 }
      else { next }
      parent[id] = pp
      if (wp ~ /^[0-9]+$/) winpid[id] = wp
    }
    END {
      # Membership is tested with `in` on both sides. A bare `keep[parent[id]]`
      # would create an entry for the parent as a side effect of looking it
      # up, which is how every pid in the table, this supervisor included,
      # ends up in a set that is about to be killed.
      #
      # The passes run until one adds nothing, so a chain of any depth is
      # closed over rather than cut at a fixed count. Each pass adds at least
      # one entry or ends the loop, and the table is finite, so this
      # terminates; a parent-child cycle settles once both its members are in.
      keep[root] = 1
      do {
        added = 0
        for (id in parent) {
          p = parent[id]
          if ((p in keep) && !(id in keep)) { keep[id] = 1; added = 1 }
        }
      } while (added)
      for (id in keep) { if (keep[id] == 1 && (id in winpid)) print id }
    }' | sort -n | tr '\n' ' ')
  msys_pids="${msys_pids% }"
  local winpids="" root_winpid="" pairs=""
  local one
  for one in $msys_pids; do
    local resolved
    resolved=$(resolve_windows_pid "$one")
    if [ -n "$resolved" ]; then
      winpids="$winpids $resolved"
      pairs="$pairs $one:$resolved"
      [ "$one" = "$pid" ] && root_winpid="$resolved"
    fi
  done
  winpids="${winpids# }"
  # This list is what a later sweep kills, so the supervisor's own Windows pid
  # is refused outright rather than trusted to be absent. The closure is rooted
  # at the launch pid, which is this process's child, so a self entry can only come
  # from a misread of the process table, and the cost of acting on one is the
  # supervisor killing itself and every session sharing its tree.
  local self_winpid
  self_winpid=$(resolve_windows_pid "$$")
  if [ -z "$self_winpid" ]; then
    log "CHILDTREE: this supervisor's own Windows pid does not resolve on this poll, so child-$CHILD_INDEX's pid set cannot be cleared of it and nothing is recorded from this poll"
    CHILD_TREE_READ_FAILED=1
    CHILD_TREE_FAILED_CONFIRMS=$(( ${CHILD_TREE_FAILED_CONFIRMS:-0} + 1 ))
    return 0
  fi
  local safe="" safe_pairs=""
  for one in $pairs; do
    if [ "${one#*:}" = "$self_winpid" ]; then
      log "CHILDTREE: refusing this supervisor's own Windows pid ${one#*:} in child-$CHILD_INDEX's tree"
      continue
    fi
    safe="$safe ${one#*:}"
    safe_pairs="$safe_pairs $one"
  done
  winpids="${safe# }"
  pairs="${safe_pairs# }"
  CHILD_TREE_SEEN_PAIRS="$pairs"
  if [ -z "$winpids" ]; then
    # A poll that resolves no Windows pid at all reads as "nothing to add":
    # the standing record is what the child was last seen running as, and a
    # momentary gap in the process table is not evidence the tree changed.
    #
    # Where the closure did name MSYS processes and none of them resolved,
    # the child's own processes are there and this poll could not name any of
    # them in Windows terms. That is a failed read rather than a child with no
    # Windows process, and the two have to stay apart: only the second is a
    # tree there is nothing to sweep.
    #
    # A closure whose every process has stopped running is not a failed read.
    # The process table is read once at the top of this function and each
    # pid's Windows id a moment later, so a child that exits at once can leave
    # a closure naming the launch pid and a short-lived process under it, all
    # gone by the lookup, which then resolves to nothing. With none of them
    # running there is nothing left for this poll to have failed to name, and a
    # child that dies at launch reaches the crash path rather than exit 5.
    #
    # Each member is checked, not only the launch pid. The wrapper dying says
    # nothing about the processes under it, and a live one that did not resolve
    # is a survivor nothing here can name. An MSYS pid reused by an unrelated
    # process reads as running too, which keeps this a failed read.
    #
    # For the liveness verdict, this poll's walk reads none only where every
    # member of the closure and the launch pid itself have exited. A member or
    # a launch pid that still answers makes it failed, a walk that did not
    # complete, so a live child is never read as gone.
    CHILD_TREE_POLL_WALK="none"
    if [ -n "$msys_pids" ]; then
      for one in $msys_pids; do
        if kill -0 "$one" 2>/dev/null; then
          CHILD_TREE_READ_FAILED=1
          CHILD_TREE_POLL_WALK="failed"
          break
        fi
      done
    fi
    if [ "$CHILD_TREE_POLL_WALK" = "none" ] && kill -0 "$pid" 2>/dev/null; then
      CHILD_TREE_POLL_WALK="failed"
    fi
    CHILD_TREE_FAILED_CONFIRMS=$(( ${CHILD_TREE_FAILED_CONFIRMS:-0} + 1 ))
    return 0
  fi
  if [ "$winpids" = "${CHILD_TREE_WINPIDS:-}" ]; then
    # The child is running as the pid set the standing record was walked
    # from, which is this poll confirming that record still describes the
    # tree. The stamp is what `child_tree_record_state` reads to tell a
    # record confirmed a moment ago from one no poll has confirmed in a
    # while.
    CHILD_TREE_SEEN_WINPIDS="$winpids"
    # The shell's own clock rather than `date`: this branch is the one a
    # settled child takes on every poll, and it launches nothing.
    printf -v CHILD_TREE_CONFIRMED_AT '%(%s)T' -1
    CHILD_TREE_FAILED_CONFIRMS=0
    CHILD_TREE_POLL_WALK="live"
    return 0
  fi
  # A closure member that exited inside its own walk is left out of this poll
  # rather than read as a walk this poll could not complete. The child's own
  # short-lived helpers - a `node` the agent spawns, a hook's `git` - come and
  # go inside one poll, and every one of them lands here. Treating each as an
  # unreadable tree would leave the record permanently behind the pid set,
  # which is the state that refuses every later stop and sweep. What the
  # member left behind, if anything, is an orphan no walk can name once its
  # MSYS parent is gone, and the next launch's own persona gate is what meets
  # that, exactly as it meets one under a record that never named a
  # descendant.
  local snapshot="" walked rc live_pairs="" live_winpids="" live_msys=""
  for one in $pairs; do
    walked=$(walk_msys_process_tree "${one%%:*}" "${one#*:}")
    rc=$?
    if [ "$rc" -eq 3 ]; then
      log "CHILDTREE: MSYS pid ${one%%:*} exited inside its own walk, so child-$CHILD_INDEX's pid set for this poll leaves out the Windows pid ${one#*:} it ran as"
      continue
    fi
    if [ "$rc" -ne 0 ]; then
      # A walk that did not complete under a live MSYS process, or one
      # discarded because that process now runs as another Windows pid, would
      # leave a partial record standing in for the whole tree, which is what a
      # later sweep would then call clean. The standing record is kept
      # instead, the next poll tries again, and CHILD_TREE_SEEN_WINPIDS is
      # what tells a sweep that the record is behind the tree.
      CHILD_TREE_SEEN_WINPIDS="$winpids"
      CHILD_TREE_FAILED_CONFIRMS=$(( ${CHILD_TREE_FAILED_CONFIRMS:-0} + 1 ))
      log "CHILDTREE: the walk under Windows pid ${one#*:} did not complete or was discarded (rc=$rc) - the standing tree record is kept and is now older than child-$CHILD_INDEX's Windows pid set"
      return 0
    fi
    live_pairs="$live_pairs ${one}"
    live_winpids="$live_winpids ${one#*:}"
    live_msys="$live_msys ${one%%:*}"
    if [ -n "$walked" ]; then
      snapshot="$snapshot$walked
"
    fi
  done
  live_pairs="${live_pairs# }"
  live_winpids="${live_winpids# }"
  live_msys="${live_msys# }"
  if [ -z "$live_winpids" ]; then
    # Every member of this poll's closure exited inside its own walk, which is
    # the shape a child that dies at launch leaves: there is nothing left for
    # this poll to have read, so it adds nothing and the standing record and
    # the pid set seen under the child both stand as they were.
    log "CHILDTREE: every process in child-$CHILD_INDEX's closure exited inside its own walk on this poll, so this poll records nothing"
    CHILD_TREE_FAILED_CONFIRMS=$(( ${CHILD_TREE_FAILED_CONFIRMS:-0} + 1 ))
    # Every member exited inside its walk. A launch pid that still answers is
    # a closure this poll could not read whole, not a child with nothing live.
    CHILD_TREE_POLL_WALK="none"
    if kill -0 "$pid" 2>/dev/null; then
      CHILD_TREE_POLL_WALK="failed"
    fi
    return 0
  fi
  # `snapshot_process_tree` refuses this supervisor's own Windows pid inside
  # every tree it walks, so what arrives here is already clear of it.
  snapshot=$(printf '%s' "$snapshot" | grep -v '^$' | sort -u)
  # The pid set this poll walked, and so the set the record now describes. A
  # member that exited inside its own walk is out of all four.
  CHILD_TREE_MSYS_PIDS="$live_msys"
  CHILD_TREE_SEEN_PAIRS="$live_pairs"
  CHILD_TREE_SEEN_WINPIDS="$live_winpids"
  CHILD_TREE_WINPIDS="$live_winpids"
  CHILD_TREE_SNAPSHOT="$snapshot"
  CHILD_TREE_WALKED=1
  CHILD_TREE_CONFIRMED_AT=$(date +%s)
  CHILD_TREE_FAILED_CONFIRMS=0
  CHILD_TREE_POLL_WALK="live"
  # Whether any walk has yet named a Windows process other than the one the
  # child's own launch pid runs as. The first refresh runs in the instant
  # after the launch, before the agent process under it exists, so a
  # record taken then names the wrapper and nothing else. A child that dies
  # inside the first poll interval would otherwise be swept against that
  # record and reported clean while the process the sweep exists to catch was
  # never in it.
  if [ -z "${CHILD_TREE_DESCENDANT_SEEN:-}" ]; then
    local snap_line snap_pid
    while IFS= read -r snap_line; do
      snap_pid="${snap_line%%,*}"
      if [ -n "$snap_pid" ] && [ "$snap_pid" != "$root_winpid" ]; then
        CHILD_TREE_DESCENDANT_SEEN=1
        break
      fi
    done <<< "$snapshot"
  fi
  log "CHILDTREE: child-$CHILD_INDEX runs as Windows pid(s) $live_winpids (MSYS $live_msys)"
}

# --- Helper: why the recorded child tree reads stale, if it does ---
# Prints the reason, in the words the sweep's own line carries, and prints
# nothing at all while the record still holds. `child_tree_record_state`'s
# verdict is read off this same call, so the verdict and the line that
# explains it can never name different reasons.
#
# There are two bounds, and they answer different failures.
#
# The first is polls that stopped confirming the record. Three is that bound,
# because the child can die just after a poll and the poll that finds it dead
# runs a full round of its own work first, which leaves two ordinary polls
# between the last confirmation and the sweep.
#
# The second is the age of the confirmation itself. A count alone cannot see a
# box that suspends for hours between the poll that last confirmed the record
# and the child's death: one poll runs on resume, the counter reaches 1, and a
# record walked hours ago reads clean. So a confirmation also expires, at ten
# poll intervals or five minutes, whichever is longer. Ten rather than three,
# because a poll body's own work varies by tens of seconds on a loaded box and
# a three-interval bound fired on a run where every poll confirmed the record.
# Ten intervals and the five-minute floor both sit far outside that variance
# and far inside any suspend.
child_tree_stale_reason() {
  if [ "${CHILD_TREE_FAILED_CONFIRMS:-0}" -ge 3 ]; then
    echo "${CHILD_TREE_FAILED_CONFIRMS} polls in a row ran without confirming child-$CHILD_INDEX's recorded tree against the live process table"
    return 0
  fi
  # A walked record carries the stamp of the poll that walked it. One without a
  # stamp is a record no poll is known to have confirmed at all, which is the
  # same answer as one nothing has confirmed in three polls.
  if [ -z "${CHILD_TREE_CONFIRMED_AT:-}" ]; then
    echo "no poll is known to have confirmed child-$CHILD_INDEX's recorded tree at all"
    return 0
  fi
  local ceiling=$(( (${SUPERVISOR_POLL_MS:-10000} / 1000) * 10 ))
  if [ "$ceiling" -lt 300 ]; then
    ceiling=300
  fi
  if [ "$(( $(date +%s) - CHILD_TREE_CONFIRMED_AT ))" -ge "$ceiling" ]; then
    echo "no poll has confirmed child-$CHILD_INDEX's recorded tree inside the ${ceiling}s ceiling this poll interval sets"
    return 0
  fi
  return 0
}

# --- Helper: what the recorded child tree is worth right now ---
# Every reader of `CHILD_TREE_SNAPSHOT` needs the same three-way answer before
# it acts on that record, so the reading lives here rather than at each call
# site: a record read without it stands in for the whole tree when it covers
# part of one, and a partial record verified clean is how a `claude.exe` that
# the record never named goes unnoticed while it holds the persona claim.
#
# Only `whole` licenses a clean verdict. Everything else names a way the
# record falls short of the tree it claims to describe, and each one is a
# separate state so the sweep's own line says which.
#
# Prints one of:
#   none          - no Windows process was ever seen under this child, and
#                   every reading this child got completed
#   unread        - a reading failed, or a Windows pid set was seen and no
#                   walk of it ever completed
#   no_descendant - a walk completed and named only the process the child's
#                   own launch pid runs as, so nothing under the wrapper has
#                   ever been in the record
#   stale         - the record was walked from the child's pid set and
#                   nothing has confirmed it against the live tree since,
#                   either for three polls in a row or for longer than the
#                   age ceiling, so a process could have appeared under it
#                   unseen
#   behind        - the record was walked from one pid set and the child
#                   moved to another afterwards, so it describes part of the
#                   tree
#   whole         - the record was walked from the pid set the child is
#                   running as, a poll confirmed that recently, and it names
#                   a process under the wrapper
child_tree_record_state() {
  if [ -z "${CHILD_TREE_WALKED:-}" ]; then
    if [ -n "${CHILD_TREE_SEEN_WINPIDS:-}" ] || [ -n "${CHILD_TREE_READ_FAILED:-}" ]; then
      echo "unread"
      return 0
    fi
    echo "none"
    return 0
  fi
  if [ "${CHILD_TREE_SEEN_WINPIDS:-}" != "${CHILD_TREE_WINPIDS:-}" ]; then
    echo "behind"
    return 0
  fi
  if [ -z "${CHILD_TREE_DESCENDANT_SEEN:-}" ]; then
    echo "no_descendant"
    return 0
  fi
  # Both stale bounds live in `child_tree_stale_reason`, which the sweep's own
  # line reads too, so the verdict here and the reason printed there are one
  # reading rather than two that can drift apart.
  if [ -n "$(child_tree_stale_reason)" ]; then
    echo "stale"
    return 0
  fi
  echo "whole"
}

# --- Helper: how long ago a poll last confirmed the recorded child tree ---
# Printed in the sweep's own clean line, since a clean verdict is only worth
# the age of the record it was read off.
child_tree_record_age_s() {
  if [ -z "${CHILD_TREE_CONFIRMED_AT:-}" ]; then
    echo "unknown"
    return 0
  fi
  echo "$(( $(date +%s) - CHILD_TREE_CONFIRMED_AT ))s"
}

# --- Helper: kill whatever outlived the child, from the recorded tree ---
# A `claude.exe` whose wrapper died still holds the persona claim, and the next
# child would spend the whole 120s pre-launch gate waiting on that claim and
# then exit 2. Nothing can name that process once its wrapper is gone, so this
# reads the record taken while the child ran; every entry carries the start
# ticks of the process it named, so a pid Windows has recycled onto something
# else is neither reported as a survivor nor killed.
#
# Where a retry of the same record can still settle the question, the snapshot
# is left in LAST_STOP_SNAPSHOT, so `retry_stop_escalation` retries that tree
# and the EXIT trap re-verifies it. A record that is behind the tree is the one
# failure that is left out of LAST_STOP_SNAPSHOT: retrying it would confirm the
# processes it does name dead and report a clean tree, which is the verdict
# that branch exists to refuse.
#
# Each leg opens with a stable token after the label, so a caller or a test
# reads the outcome from that token rather than from the prose beside it.
#
# Returns 0 when nothing of the child is left alive or every survivor was
# confirmed dead, 2 when there is no tree for anything to have outlived, which
# covers a child no Windows process was ever seen under and a completed walk
# that found nothing under the wrapper, and 1 for every outcome where a process
# is alive or no reading could account for the tree: a survivor the kill did
# not settle, a walk that never completed, a record no poll has confirmed in a
# while, and a record the child's pid set moved past.
# `child_tree_record_state` names those ways one by one and the log line
# carries the one that fired.
# Usage: sweep_child_tree <label>
sweep_child_tree() {
  local label="$1"
  case "$(child_tree_record_state)" in
    none)
      log "SWEEP[$label] no_tree: no Windows process was ever seen under child-$CHILD_INDEX, so there is no tree it could have left behind"
      return 2
      ;;
    unread)
      log "SWEEP[$label] tree_unread: child-$CHILD_INDEX ran as Windows pid(s) ${CHILD_TREE_SEEN_WINPIDS:-none that resolved} and no walk of that tree ever completed, so what it left behind cannot be read"
      return 1
      ;;
    no_descendant)
      # The walk completed and found nothing under the wrapper. A child that
      # exits inside its first poll interval is swept against exactly that
      # record, since the walk taken right after the launch runs before
      # the agent process exists. Nothing named means nothing to sweep, and a
      # process that did appear and outlive the wrapper is met by the next
      # launch's own persona gate, which waits on the claim and ends the run
      # rather than running a second child beside the first.
      log "SWEEP[$label] record_no_descendant: child-$CHILD_INDEX's recorded tree names only the process its own launch pid runs as, so nothing that ran under that wrapper was ever in it"
      return 2
      ;;
    stale)
      log "SWEEP[$label] record_stale: $(child_tree_stale_reason), last confirmed $(child_tree_record_age_s) ago, so a process could have appeared under it unseen and no reading of it is a clean result"
      return 1
      ;;
    behind)
      # The record was walked from one Windows pid set and the child moved to
      # another before any later walk completed, so it describes part of the
      # tree. Reading an empty survivor list off it would call the child clean
      # while a process the record never named holds the persona claim.
      log "SWEEP[$label] record_behind_tree: child-$CHILD_INDEX's recorded tree was walked from Windows pid(s) ${CHILD_TREE_WINPIDS} and its pid set moved to ${CHILD_TREE_SEEN_WINPIDS} after that, so this record covers part of the tree and no reading of it is a clean result"
      if [ -n "${CHILD_TREE_SNAPSHOT:-}" ]; then
        if kill_process_snapshot "$CHILD_TREE_SNAPSHOT"; then
          log "SWEEP[$label] record_behind_tree: every process that partial record names is confirmed dead, and whatever it never named is unaccounted for"
        else
          log "SWEEP[$label] record_behind_tree: a process that partial record names is alive or unverifiable after the kill"
        fi
      fi
      return 1
      ;;
  esac
  local alive rc
  alive=$(check_snapshot_survivors "${CHILD_TREE_SNAPSHOT:-}")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "SWEEP[$label] record_unverified: child-$CHILD_INDEX's recorded tree could not be verified - not killing on an unverified read"
    LAST_STOP_SNAPSHOT="$CHILD_TREE_SNAPSHOT"
    return 1
  fi
  if [ -z "$alive" ]; then
    # What this line claims is bounded by the record it was read off. A native
    # process a child spawned after the last walk is in no record, so the
    # reading covers the processes the record names and nothing wider.
    log "SWEEP[$label] clean: every process child-$CHILD_INDEX's recorded tree names is dead, read off a tree record a poll confirmed $(child_tree_record_age_s) ago"
    return 0
  fi
  log "SWEEP[$label] survivors: processes from child-$CHILD_INDEX outlived it: $(echo "$alive" | tr '\n' ' ') - killing them before anything else runs"
  LAST_STOP_SNAPSHOT="$CHILD_TREE_SNAPSHOT"
  if kill_process_snapshot "$CHILD_TREE_SNAPSHOT"; then
    log "SWEEP[$label] survivors_dead: the surviving tree is confirmed dead"
    LAST_STOP_SNAPSHOT=""
    return 0
  fi
  log "SWEEP[$label] survivors_alive: a process from child-$CHILD_INDEX is alive or unverifiable after the kill"
  return 1
}

# --- Helper: build the snapshot a stop verifies and kills ---
# A Windows walk from the wrapper does not reach the child. The live launch
# runs `claude.exe` under `env.exe`, whose Windows parent is a Cygwin fork
# intermediate that has already exited, so the wrapper's own walk names the
# wrapper alone. The snapshot is therefore the union of three readings: the
# wrapper's own walk, a walk from the Windows pid of every process in the
# MSYS closure the latest refresh read, and the tree record, which must be
# `whole`. Lines are deduplicated on pid and start ticks together, so a pid
# recorded under two different processes keeps both lines and each is
# matched against its own start time.
#
# Every other record state names a way the record falls short of the tree,
# and a union built on it could verify part of the tree dead while a
# process it never named runs on. So any other state is unverified, the same
# answer a walk that did not complete gives. A walk whose MSYS pid has exited
# is discarded rather than failed, since that process is no part of the tree
# any more and the pid the walk read is not its own. A walk whose MSYS pid is
# still running under a different Windows pid is the other case and fails the
# build: that process is part of the tree, it now holds a Windows pid no walk
# here reached, and the union names only the pid it used to run as. Discarding
# such a walk would report a stop verified while a live member of the closure
# sits outside every line the snapshot carries.
# The union is cleared of this supervisor's own Windows pid the way
# `snapshot_process_tree` clears a single walk: a union naming it, or a self
# pid that cannot be resolved, is unverified as a whole.
#
# `stop_child` and `retry_stop_escalation` both build their snapshot here, each
# after a `refresh_child_tree`, so the retry backstop never kills from a
# narrower tree than the stop itself would.
#
# Sets STOP_SNAPSHOT_BUILT to the snapshot, "pid,ticks" per line, and to empty
# on every unverified result. Returns 0 where the snapshot is verified, which
# includes a verified empty one, and non-zero where it is not.
# Usage: build_stop_snapshot <label>
build_stop_snapshot() {
  local label="$1"
  local pid="${CHILD_LAUNCH_PID:-}"
  STOP_SNAPSHOT_BUILT=""
  STOP_SNAPSHOT_WRAPPER_WINPID=""
  local record_state
  record_state=$(child_tree_record_state)
  if [ "$record_state" != "whole" ]; then
    log "STOP[$label]: tree_record_$record_state: child-$CHILD_INDEX's tree record is not whole, so no snapshot built on it can confirm the tree dead"
    return 1
  fi
  local union="$CHILD_TREE_SNAPSHOT" walk_pairs="" pair walked walk_rc wrapper_winpid=""
  if [ -n "$pid" ]; then
    wrapper_winpid=$(resolve_windows_pid "$pid")
  fi
  # The wrapper's Windows pid this build walked from, for a caller that
  # compares a later resolve against the pid its list was walked from.
  STOP_SNAPSHOT_WRAPPER_WINPID="$wrapper_winpid"
  if [ -n "$wrapper_winpid" ]; then
    walk_pairs="$pid:$wrapper_winpid"
  fi
  for pair in ${CHILD_TREE_SEEN_PAIRS:-}; do
    case " $walk_pairs " in *" $pair "*) continue ;; esac
    walk_pairs="$walk_pairs $pair"
  done
  for pair in $walk_pairs; do
    walked=$(walk_msys_process_tree "${pair%%:*}" "${pair#*:}")
    walk_rc=$?
    # Only an exited MSYS process (rc 3) drops out of the union. Its walk read
    # a Windows pid it no longer holds, and the process itself is gone, so
    # there is nothing left of it for the snapshot to have missed. Every other
    # non-zero code, rc 4 among them, leaves a member of the closure alive and
    # unaccounted for, which is the same answer `refresh_child_tree` gives the
    # two codes.
    if [ "$walk_rc" -eq 3 ]; then
      continue
    fi
    if [ "$walk_rc" -ne 0 ]; then
      log "STOP[$label]: the walk under Windows pid ${pair#*:} (MSYS pid ${pair%%:*}) did not complete or was discarded (rc=$walk_rc)"
      return "$walk_rc"
    fi
    if [ -n "$walked" ]; then
      union="$union
$walked"
    fi
  done
  local snapshot self_winpid
  snapshot=$(printf '%s\n' "$union" | grep -v '^$' | sort -u)
  self_winpid=$(resolve_windows_pid "$$")
  if [ -z "$self_winpid" ]; then
    log "STOP[$label]: this supervisor's own Windows pid does not resolve, so the stop's snapshot cannot be cleared of it"
    return 1
  fi
  if printf '%s\n' "$snapshot" | grep -q "^$self_winpid,"; then
    log "STOP[$label]: the stop's snapshot names this supervisor's own Windows pid $self_winpid, so every process in it may have been reached through this process"
    return 1
  fi
  STOP_SNAPSHOT_BUILT="$snapshot"
  return 0
}

# --- Helper: on a stop_child failure, keep retrying the tree kill on a
# cadence, bounded well under the pre-gate's own ceiling, before the
# caller proceeds ---
# Every stop_child call site reads this return value: a caller that
# discarded it could relaunch a child, or a decide-action path could walk
# into the persona pre-gate, with a confirmed-alive survivor from the
# stopped child's own tree still holding the persona claim.
#
# A single retry here can still let a restart path walk blind into the
# 120s persona pre-gate (`wait_persona_free_both`) on a confirmed-alive
# survivor, spending the whole 120s waiting on a heartbeat staleness
# timeout rather than on the tree actually dying. So the kill is retried
# on a cadence instead of once, and the caller still proceeds either way
# with the outcome logged - this is a backstop, not a substitute for the
# pre-gate itself.
#
# A fixed number of attempts with sleeps between them names only the
# sleep time, not the real bound: each attempt's own
# `kill_process_snapshot` call can itself run up to `$SUPERVISOR_PS_
# BOUND_S` seconds, so a sleep-counted budget understates the real
# worst case. This loop is bounded by actual wall clock against
# `RETRY_BUDGET_S` (a quarter of the 120s pre-gate ceiling), checked
# before and after each attempt rather than assumed from a sleep count.
#
# A caller can reach this backstop with `LAST_STOP_SNAPSHOT` empty, where
# `stop_child` could not verify a snapshot. This backstop re-snapshots once
# rather than give up outright, through the same refresh and merged build
# `stop_child` uses, since a snapshot of the wrapper alone would confirm bash
# dead while the `claude.exe` behind it runs on. A build that still cannot
# verify the tree returns failure.
# Usage: retry_stop_escalation <label> <stop_child's own return code>
retry_stop_escalation() {
  local label="$1"
  local result="$2"
  if [ "$result" -eq 0 ]; then
    return 0
  fi
  # A stop that met its wrapper under a Windows pid no snapshot was walked from
  # has already run the ticks-matched kill over the processes a verified
  # snapshot names. A snapshot built here comes from the same record plus a
  # walk of the new pid, which cannot name what the wrapper started between
  # the two, so no retry can confirm that tree dead and this fails without
  # building one.
  if [ -n "${STOP_TREE_MOVED:-}" ]; then
    log "STOP[$label]: stop_child refused because the wrapper moved to a Windows pid its snapshot was never walked from (STOP_PATH=$STOP_PATH) - no retry can confirm that tree dead, failing without a re-snapshot"
    return 1
  fi
  # A re-snapshot attempt from a dead or zombie `CHILD_LAUNCH_PID`
  # reliably resolves to no winpid at all, so looping and sleeping
  # through the whole budget on a re-resolve that structurally cannot
  # ever succeed just burns the budget for nothing. Try exactly once, up
  # front; if it still yields nothing, there is nothing this loop can do
  # and it fails fast rather than slow.
  if [ -z "$LAST_STOP_SNAPSHOT" ]; then
    log "STOP[$label]: stop_child reported failure (STOP_PATH=$STOP_PATH) with no snapshot to retry against; attempting one re-snapshot"
    local resnap_rc=1
    if [ -n "${CHILD_LAUNCH_PID:-}" ]; then
      refresh_child_tree
      build_stop_snapshot "$label"
      resnap_rc=$?
      LAST_STOP_SNAPSHOT="$STOP_SNAPSHOT_BUILT"
    fi
    # Only a snapshot the merged build verified can end the retry: an
    # unverified build fails fast, since sleeping out the budget cannot make it
    # verifiable, and a verified empty build means nothing of the child is left
    # to retry against.
    if [ "$resnap_rc" -ne 0 ]; then
      log "STOP[$label]: re-snapshot could not verify the child's tree (rc=$resnap_rc; no child pid, a record that is not whole, a walk that did not complete, or a self pid it could not clear) - failing fast rather than sleeping out the budget"
      return 1
    fi
    if [ -z "$LAST_STOP_SNAPSHOT" ]; then
      log "STOP[$label]: re-snapshot was verified and found nothing - nothing left to retry"
      return 0
    fi
  fi
  local RETRY_BUDGET_S=30
  local deadline
  deadline=$(( $(date +%s) + RETRY_BUDGET_S ))
  local attempt=0 kill_rc=1
  while [ "$(date +%s)" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    log "STOP[$label]: retrying the tree kill (attempt $attempt, $(( deadline - $(date +%s) ))s left in budget)"
    kill_process_snapshot "$LAST_STOP_SNAPSHOT"
    kill_rc=$?
    if [ "$kill_rc" -eq 0 ]; then
      log "STOP[$label]: retry succeeded on attempt $attempt, tree confirmed dead"
      LAST_STOP_SNAPSHOT=""
      return 0
    fi
    sleep 2
  done
  log "STOP[$label]: every retry FAILED over the ${RETRY_BUDGET_S}s budget - a process from the stopped child is alive or unverifiable and may still hold its persona claim"
  return 1
}

# Whether the child is inside a turn, read off the tail of its own
# stdout.jsonl by bin/supervise-turnstate.mjs. Prints busy or idle. Every
# fault reads idle: an empty path (a caller with no stream to name), a reader
# that fails, and any output but the two words. Idle is the fall-through to
# the stop phases as they run for every other label, so a broken reader
# costs the patient wait and never holds a persona. The call is the poll
# loop's own shape, a plain capture with stderr on supervisor.err, since
# run_bounded_native discards the stdout this verdict rides on.
# Usage: child_turn_state <stdout.jsonl path>
child_turn_state() {
  local stream="$1" verdict
  if [ -z "$stream" ]; then
    echo idle
    return 0
  fi
  verdict=$(node "$PLUGIN_DIR/bin/supervise-turnstate.mjs" "$stream" "$(date +%s%3N)" 2>> "$RUNDIR/supervisor.err")
  verdict="${verdict%$'\r'}"
  case "$verdict" in
    busy|idle) echo "$verdict" ;;
    *) echo idle ;;
  esac
}

# Usage: stop_child <label>
# Sets STOP_PATH to one of nine values: "eof", "term", or "kill" when the
# tree is confirmed dead at that phase, "eof_kill_failed",
# "term_kill_failed", "kill_failed" when a survivor from the snapshot was
# alive or unverifiable after that phase's own escalation, "unverified" when
# nothing was confirmed either way: the snapshot could never be built in the
# first place, because a walk did not complete, the tree record is not whole,
# or the snapshot could not be cleared of this supervisor's own pid, or the
# wrapper reached the force kill running as a Windows pid the snapshot was
# never walked from -
# "gone" when the wrapper had already
# exited and the tree recorded while the child ran leaves nothing alive, or
# "gone_kill_failed" when that record holds a process that is alive or that no
# reading could account for.
# Returns 1 in every failed case; callers should read that
# return rather than trusting STOP_PATH's clean-looking values by name alone.
stop_child() {
  local label="$1"
  STOP_TREE_MOVED=""
  # If CHILD_LAUNCH_PID is empty, there's nothing to stop.
  local pid="${CHILD_LAUNCH_PID:-}"
  if [ -z "$pid" ]; then
    log "STOP[$label]: no child to stop (CHILD_LAUNCH_PID empty)"
    return 0
  fi
  # The record is refreshed before anything reads it, so the stop works from
  # the child's tree as it stands now rather than as the last poll saw it.
  refresh_child_tree
  # A wrapper that exits on its own in the window between the poll
  # loop's own `kill -0` check and `stop_child` actually running (the
  # decide-unit's own node calls, the `case` dispatch) would otherwise
  # fall all the way through to `unverified`: `resolve_windows_pid` finds
  # nothing for an already-gone pid, so a child that ended cleanly would
  # report as if a survivor were still alive. Checked explicitly here,
  # before any snapshot is even attempted: where the wrapper is already
  # gone and no winpid resolves for it, the only thing that can still name
  # what ran under it is the tree recorded while the child was alive, so
  # that record is what the sweep verifies. `STOP_PATH="gone"` reports a
  # sweep that left nothing of the child running, distinct from
  # `unverified` (which means "cannot tell"), and `retry_stop_escalation`
  # treats it as nothing to retry.
  if ! kill -0 "$pid" 2>/dev/null; then
    local early_winpid
    early_winpid=$(resolve_windows_pid "$pid")
    if [ -z "$early_winpid" ]; then
      # The wrapper being gone says nothing about what ran under it: a
      # `claude.exe` can be alive and still holding the persona claim. Nothing
      # live can name that process any more, so the tree recorded while the
      # child ran is what gets verified here, rather than reporting a clean
      # stop on a tree nothing looked at.
      log "STOP[$label]: wrapper gone before stop_child ran (pid $pid already exited, no winpid resolves) - verifying the tree recorded while the child ran"
      LAST_STOP_SNAPSHOT=""
      sweep_child_tree "$label"
      local sweep_rc=$?
      # A sweep that found a tree and cleared it, and one that reports no
      # Windows process was ever seen under this child, both leave nothing of
      # the child running, which is what "gone" says. Every other reading
      # leaves a process that is alive or that nothing accounted for, which is
      # the one failure this reports.
      if [ "$sweep_rc" -eq 0 ] || [ "$sweep_rc" -eq 2 ]; then
        STOP_PATH="gone"
        return 0
      fi
      STOP_PATH="gone_kill_failed"
      return 1
    fi
  fi

  # The snapshot is taken HERE, before any signal at all, not after each
  # phase's kill -0 check fails. A bash wrapper TERMed while its real
  # child survives is exactly the shape resolving and walking the tree
  # only in a later phase would miss: `kill -0 $pid` only ever checks the
  # MSYS-tracked wrapper, never whether a real descendant is still alive,
  # so an earlier phase's own "stopped" report would never actually be
  # checked against reality. A snapshot taken after killing risks a
  # recycled pid too (Windows reuses pids quickly and keeps
  # ParentProcessId associations after a process exits) - so this list is
  # fixed before anything is signaled, and is the same list checked and
  # killed at every phase below. The one rebuild is the patient wait's,
  # below, which still sits before the first signal.
  #
  # A Windows walk from the wrapper does not reach the child, so the snapshot
  # is the merged one `build_stop_snapshot` builds from the record the refresh
  # at entry took.
  local snapshot_winpid
  snapshot_winpid=$(resolve_windows_pid "$pid")
  # `snap_attempted` stays 1 once the build has run, and `snap_rc` carries its
  # verdict, so "built and found nothing alive" (verified dead) is not read the
  # same as "the build could not verify the tree" (unverified).
  local snapshot="" snap_rc=0 snap_attempted=1
  build_stop_snapshot "$label"
  snap_rc=$?
  snapshot="$STOP_SNAPSHOT_BUILT"
  # A failed resolve or a non-zero `snap_rc` (the PowerShell walk timed
  # out or errored - errors go only to supervisor.err, never here) does
  # not read as "verified dead" - it means the tree was never actually
  # looked at. Named explicitly so the operator can tell the two apart in
  # the log, rather than a silent, indistinguishable clean report.
  if [ "$snap_attempted" -eq 0 ] || [ "$snap_rc" -ne 0 ]; then
    log "STOP[$label]: tree not verified (no snapshot resolved for pid $pid, or the walk did not complete, rc=$snap_rc) - stop relies on the child's own launch pid alone"
  fi
  LAST_STOP_SNAPSHOT="$snapshot"

  # Usage: verify_snapshot_dead - returns 0 if every process in $snapshot
  # is confirmed gone (matched by pid AND start time - a recycled pid
  # alone does not count as a survivor); escalates via kill_process_snapshot
  # only on a CONFIRMED survivor, returning 1 if that escalation itself
  # still leaves one (this return code is read below, not discarded).
  #
  # An unverified check (rc non-zero - the probe timed out or crashed) is
  # never escalated like a confirmed survivor, handing the WHOLE snapshot
  # to `kill_process_snapshot`: `kill_process_snapshot` itself is
  # ticks-matched, so that call is never a blind mass kill by pid, but an
  # unverified read still means nothing was actually confirmed alive, so
  # this logs and returns 1 without calling kill_process_snapshot at all -
  # "cannot tell" is not grounds to act, only grounds to fail closed and
  # let the caller retry.
  #
  # An EMPTY snapshot (the resolve or the walk itself failed, `snap_rc`
  # non-zero above) is the same "cannot tell" case as an unverified
  # check, not "verified dead": returning 0 here on an empty snapshot
  # would be the exact report a slow-spawn regime (the bound this whole
  # function exists for) produces on a tree that was never actually
  # looked at.
  # Usage: kill_stale_entry_list - the one unverified case that still holds
  # a verified list: the patient wait's rebuild failed and `snapshot` is the
  # entry list. That list is killed, ticks-matched, so nothing it names
  # outlives the stop, while the verdict stays unverified because nothing
  # the child started during the wait is on it. Every other unverified case
  # holds an empty list and this does nothing.
  kill_stale_entry_list() {
    if [ -n "$snapshot" ]; then
      if kill_process_snapshot "$snapshot"; then
        log "STOP[$label]: every process the entry list names is confirmed dead; what the child started during the wait is unaccounted for"
      else
        log "STOP[$label]: a process the entry list names is alive or unverifiable after the kill"
      fi
    fi
  }
  verify_snapshot_dead() {
    if [ "$snap_attempted" -eq 0 ] || [ "$snap_rc" -ne 0 ]; then
      log "STOP[$label]: no verified snapshot covers this stop (the entry resolve or walk failed, or the post-wait rebuild did) - not confirming dead on an unverified read"
      return 1
    fi
    local alive rc
    alive=$(check_snapshot_survivors "$snapshot")
    rc=$?
    if [ "$rc" -ne 0 ]; then
      log "STOP[$label]: the wrapper is gone but its own snapshot could not be verified - not killing on an unverified read"
      return 1
    fi
    if [ -z "$alive" ]; then
      return 0
    fi
    log "STOP[$label]: the wrapper is gone but its own snapshot shows a confirmed survivor: $(echo "$alive" | tr '\n' ' ') - escalating the tree kill"
    kill_process_snapshot "$snapshot"
    return $?
  }

  # Phase 1: end of input - kill the holder so the child reads end of input.
  # The holder holds the child's stdin pipe; killing it closes the write end,
  # and the child finishes its current turn and exits 0 within a few seconds.
  kill_holder
  # The moment the input closed, which the patient wait below measures its
  # cap from, so the ordinary grace counts toward that cap.
  local eof_closed_ms
  eof_closed_ms=$(date +%s%3N)
  # Logged so the suite can bound the cap from the close on the log's own
  # clock rather than from the wait's arithmetic.
  log "STOP[$label]: input closed (eof_closed)"
  # Poll for up to stopGraceMs for the child to exit on its own.
  local grace=$((SUPERVISOR_STOP_GRACE_MS / 1000))
  local n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt $grace ]; do
    sleep 1
    n=$((n + 1))
  done
  # The patient wait. A requested restart of a live child, and that label
  # alone, keeps waiting past the grace while the child is inside a turn: a
  # closed input ends the child when its turn ends, and a TERM before then
  # kills a session seconds after it wrote a file. Every other label stops on
  # the grace as before, since a shutdown, a crash-loop stop, a budget stop
  # and a hung restart have nothing a turn's end would save, and a hung child
  # read as busy would hold its persona for the whole cap. The wait ends on
  # the first of three: the child exits, the reader answers idle, or
  # SUPERVISOR_STOP_BUSY_CAP_MS has passed since the input closed. On the
  # last two, TERM follows once the tree snapshot is rebuilt, with no further
  # grace, since the ordinary grace has already run. Each exit lands on the
  # same check below the EOF loop reaches, so a child that exits inside the
  # wait is verified dead and reported on the eof path as one that exited
  # inside the grace is.
  if [ "$label" = "restart_passive" ] && kill -0 "$pid" 2>/dev/null; then
    local turn waited_ms left_ms
    turn=$(child_turn_state "${OUT:-}")
    if [ "$turn" = "busy" ]; then
      log "STOP[$label]: the child is inside a turn, waiting for it to end"
      while :; do
        # Five seconds a poll, cut short to what is left before the cap, so
        # the cap is met when it falls rather than a poll late.
        waited_ms=$(( $(date +%s%3N) - eof_closed_ms ))
        left_ms=$((SUPERVISOR_STOP_BUSY_CAP_MS - waited_ms))
        [ "$left_ms" -gt 5000 ] && left_ms=5000
        if [ "$left_ms" -gt 0 ]; then
          sleep "$((left_ms / 1000)).$(printf '%03d' $((left_ms % 1000)))"
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
          log "STOP[$label]: the child exited during the patient wait (wait_ended=exit)"
          break
        fi
        waited_ms=$(( $(date +%s%3N) - eof_closed_ms ))
        if [ "$waited_ms" -ge "$SUPERVISOR_STOP_BUSY_CAP_MS" ]; then
          log "STOP[$label]: the busy cap of ${SUPERVISOR_STOP_BUSY_CAP_MS}ms was reached after ${waited_ms}ms, ending the wait (wait_ended=cap)"
          break
        fi
        turn=$(child_turn_state "${OUT:-}")
        if [ "$turn" = "idle" ]; then
          log "STOP[$label]: the reader returned idle after $((waited_ms / 1000))s, ending the wait (wait_ended=idle)"
          break
        fi
      done
      # A wait that ends with the child alive, on idle or on the cap, has let
      # the child run tool calls for up to the cap since the entry snapshot
      # was built, and each of those spawned processes the entry never saw.
      # Nothing has been signaled yet, so the rule above (one list, fixed
      # before any signal) still holds, and the list is rebuilt here, at the
      # last point before the TERM. A wait the child's own exit ended keeps
      # the entry snapshot, as the ordinary EOF exit does, since a walk after
      # an exit reads recycled pids.
      # The rebuilt list is the union of the entry list and the new walk,
      # since a descendant alive at entry whose parent exited during the
      # wait is unreachable from the wrapper's parent chain and would drop
      # out of a fresh walk alone. Every entry is ticks-matched, so a pid the
      # entry list named that has since exited and been reused confirms as
      # gone rather than as a survivor. The wrapper's Windows pid becomes the
      # one the rebuild walked from, so the KILL phase compares against the
      # pid the rebuilt list was walked from.
      if kill -0 "$pid" 2>/dev/null; then
        refresh_child_tree
        build_stop_snapshot "$label"
        snap_rc=$?
        if [ "$snap_rc" -ne 0 ]; then
          # The entry list stays in `snapshot`, so the phases below still
          # run the ticks-matched kill over what it names, but nothing the
          # child started during the wait is on it, so the stop reports
          # unverified and leaves no list for the retry, which then takes
          # its own re-snapshot.
          LAST_STOP_SNAPSHOT=""
          log "STOP[$label]: tree not verified after the patient wait (the walk did not complete, rc=$snap_rc) - the entry list is still killed, ticks-matched, and the stop reports unverified"
        else
          snapshot=$(printf '%s\n%s\n' "$snapshot" "$STOP_SNAPSHOT_BUILT" | grep -v '^$' | sort -u)
          snapshot_winpid="$STOP_SNAPSHOT_WRAPPER_WINPID"
          log "STOP[$label]: the tree snapshot was rebuilt after the wait, before any signal"
          LAST_STOP_SNAPSHOT="$snapshot"
        fi
      fi
    fi
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    if verify_snapshot_dead; then
      STOP_PATH="eof"
      LAST_STOP_SNAPSHOT=""
      return 0
    fi
    if [ "$snap_attempted" -eq 0 ] || [ "$snap_rc" -ne 0 ]; then
      kill_stale_entry_list
      STOP_PATH="unverified"
    else
      log "STOP[$label]: a snapshot survivor could not be killed after the EOF path"
      STOP_PATH="eof_kill_failed"
    fi
    return 1
  fi
  # Phase 2: TERM - send SIGTERM after grace expired.
  log "STOP[$label]: EOF grace expired, sending TERM to pid $pid"
  kill -TERM "$pid" 2>/dev/null
  n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt $grace ]; do
    sleep 1
    n=$((n + 1))
  done
  if ! kill -0 "$pid" 2>/dev/null; then
    if verify_snapshot_dead; then
      STOP_PATH="term"
      LAST_STOP_SNAPSHOT=""
      return 0
    fi
    if [ "$snap_attempted" -eq 0 ] || [ "$snap_rc" -ne 0 ]; then
      kill_stale_entry_list
      STOP_PATH="unverified"
    else
      log "STOP[$label]: a snapshot survivor could not be killed after the TERM path"
      STOP_PATH="term_kill_failed"
    fi
    return 1
  fi
  # Phase 3: KILL - send SIGKILL to the wrapper, then force-kill the whole
  # snapshot this stop holds, taken at entry or rebuilt after the patient
  # wait (not a fresh walk from a possibly-dead or -recycled pid).
  log "STOP[$label]: TERM grace expired, sending KILL to pid $pid (winpid $snapshot_winpid) and its process tree"
  # A bare `kill -9` on the wrapper's own MSYS pid is the same class of
  # call that can block on this box with a "Permission denied" - whether
  # `$pid` here is a real bash process or itself a stub for `claude.exe`
  # decides whether it can hang the same way. `taskkill //F` on
  # `$snapshot_winpid` is tried first, and only while the wrapper still runs as
  # that pid; `kill -9` is what a wrapper with no winpid, or one whose winpid
  # moved since the stop began, is signaled with instead.
  # Routed through `run_bounded_native`, like every other native command
  # this script spawns, rather than left as a native spawn with nothing
  # capping how long it can run.
  # `$snapshot_winpid` was resolved two grace windows back, at stop entry or
  # at the patient wait's rebuild, whichever came last. The
  # guard above proves the wrapper lives; it does not prove the wrapper still
  # runs as that Windows pid, and Windows hands a dead process's id out again,
  # so a force kill on the entry value can land on an unrelated process. The
  # pid is resolved again here and the two are compared, the same match
  # `walk_msys_process_tree` makes on both sides of a walk.
  local kill_winpid
  kill_winpid=$(resolve_windows_pid "$pid")
  if [ -n "$snapshot_winpid" ] && [ "$kill_winpid" = "$snapshot_winpid" ]; then
    # The wrapper's own pid alone, with no `//T`. A tree kill re-walks the
    # live parent ids at kill time rather than the snapshot, and Windows
    # keeps a dead parent's id in the orphans it left and reuses the id, so
    # it can reach a process that was never part of this tree. The tree
    # below the wrapper is `kill_process_snapshot`'s, which kills only the
    # processes the snapshot recorded, each matched against its start time.
    run_bounded_native 5 taskkill //F //PID "$snapshot_winpid"
    # A failed or abandoned taskkill leaves nothing else touching `$pid`
    # at all: every caller of `stop_child` then runs an unbounded
    # `wait "$CHILD_LAUNCH_PID"`, which would block forever on a wrapper
    # that was never actually signaled. So the wrapper's own pid is
    # independently confirmed signaled here, falling back to `kill -9` if
    # `taskkill` did not reach it.
    if kill -0 "$pid" 2>/dev/null; then
      log "STOP[$label]: wrapper pid $pid still present after taskkill - falling back to kill -9 on it directly"
      kill -9 "$pid" 2>/dev/null
    fi
  elif [ -n "$snapshot_winpid" ] && [ -n "$kill_winpid" ]; then
    # The wrapper is running as a Windows pid this stop has never walked. The
    # snapshot describes the tree under the pid it held at entry, so anything
    # started under the new one is in no snapshot: a kill from that snapshot
    # confirms the processes it does name dead and says nothing of the rest,
    # so reading its result as the stop's verdict is the same fail-open
    # `build_stop_snapshot` refuses with rc 4 when it meets this condition.
    # So the wrapper's own MSYS pid is signaled, the ticks-matched snapshot
    # kill still runs over the processes a verified snapshot names, and the
    # stop fails closed whatever that kill reports. STOP_TREE_MOVED marks the
    # refusal for `retry_stop_escalation`, which fails on it rather than
    # rebuilding a snapshot from the same record and reporting that partial
    # tree dead as a clean stop.
    log "STOP[$label]: wrapper pid $pid runs as Windows pid $kill_winpid now, not the $snapshot_winpid this stop resolved before signaling - not force-killing that number, signaling the wrapper's own pid instead"
    kill -9 "$pid" 2>/dev/null
    if kill -0 "$pid" 2>/dev/null; then
      log "STOP[$label]: wrapper pid $pid is still present after the kill -9, so a caller's wait on it can block until it ends on its own"
    fi
    if [ "$snap_rc" -eq 0 ]; then
      if kill_process_snapshot "$snapshot"; then
        log "STOP[$label]: every process the snapshot walked from Windows pid $snapshot_winpid names is confirmed dead, and whatever the wrapper started under $kill_winpid is unaccounted for"
      else
        log "STOP[$label]: a process the snapshot walked from Windows pid $snapshot_winpid names is alive or unverifiable after the kill"
      fi
    else
      # A failed post-wait rebuild leaves the verified entry list in
      # `snapshot`, and this arm is where a moved wrapper lands after one.
      # That list is killed here as at every other unverified exit.
      kill_stale_entry_list
    fi
    log "STOP[$label]: the snapshot this stop holds was walked from Windows pid $snapshot_winpid and names nothing the wrapper started under $kill_winpid, so the tree cannot be confirmed dead from it"
    STOP_PATH="unverified"
    STOP_TREE_MOVED=1
    LAST_STOP_SNAPSHOT=""
    return 1
  else
    # No Windows pid could be read for a wrapper that is still running, which
    # is a failed read rather than a move: nothing says the entry value has
    # been handed to another process, and `kill_process_snapshot` matches every
    # process it kills against the start ticks recorded with its pid, so the
    # snapshot kill below is still the right escalation.
    log "STOP[$label]: no Windows pid could be read for wrapper pid $pid at the force kill, so its recorded pid ${snapshot_winpid:-none} is left to the ticks-matched snapshot kill, and the wrapper's own pid is signaled"
    kill -9 "$pid" 2>/dev/null
    if kill -0 "$pid" 2>/dev/null; then
      log "STOP[$label]: wrapper pid $pid is still present after the kill -9, so a caller's wait on it can block until it ends on its own"
    fi
  fi
  # The same fail-open shape as verify_snapshot_dead's empty-snapshot
  # case, one phase down: `kill_process_snapshot` on an empty snapshot
  # trivially returns 0 (nothing to kill), which would read as
  # STOP_PATH="kill", a clean report, on a tree that was never resolved
  # at all. Checked explicitly before trusting that return.
  if [ "$snap_attempted" -eq 0 ] || [ "$snap_rc" -ne 0 ]; then
    kill_stale_entry_list
    log "STOP[$label]: no verified snapshot covers this stop (the entry resolve or walk failed, or the post-wait rebuild did) - not confirming dead on an unverified read"
    STOP_PATH="unverified"
    return 1
  fi
  if kill_process_snapshot "$snapshot"; then
    STOP_PATH="kill"
    LAST_STOP_SNAPSHOT=""
    return 0
  fi
  log "STOP[$label]: a snapshot survivor could not be killed after the KILL path - the last escalation this function has"
  STOP_PATH="kill_failed"
  return 1
}

# find_global_store is defined in bin/agentic-common.sh (sourced above),
# shared with .kit/live-common.sh so both callers filter on dev_mode the
# same way rather than carrying their own copies.

# --- Helper: the final ask as the one stream-json line the child reads ---
# Usage: final_ask_json <id> > "$ASK_REQUEST_FILE"
# The priming turn and the goal are written by bin/supervise-holder.sh, which
# holds the child's stdin pipe. The final ask is written to the child-N
# ask-request file instead, which the holder's poll writes into the pipe and
# removes, so a supervisor that adopted a child it did not launch can still
# reach its input. This user-turn line opens [SUPERVISOR-ASK id=<id>], which
# the plugin reads as neither the operator nor task work, followed by the one
# request the ask makes.
SUPERVISOR_ASK_TEXT="Every liveness signal from this session reads silent to the launcher. Reply with one line saying what you are doing now."
final_ask_json() {
  node -e "
    const id = process.argv[1] || '';
    const text = process.argv[2] || '';
    const json = JSON.stringify({type:'user',role:'user',message:{role:'user',content:[{type:'text',text:
      '[SUPERVISOR-ASK id=' + id + '] ' + text
    }]}});
    process.stdout.write(json + '\n');
  " "$1" "$SUPERVISOR_ASK_TEXT"
}

# --- The shutdown ask's text ---
# The text of the shutdown record the poll writes to the mailbox once a
# shutdown request is present. The child's plugin submits it as a turn opening
# [SUPERVISOR id=<id>], and the priming turn says what such a prompt carries.
# Held here and handed to the poll, so the injection ledger sizes it.
SUPERVISOR_SHUTDOWN_TEXT="The launcher is ending this session. Bank your state now, with the plan doc, the goal tree and any owed message on disk, then call supervisor_shutdown."

# --- Helper: read a fact from .agentic-personas.json ---
# Usage: get_fact <workdir> <persona> <fact>
# Prints the timestamp of the newest matching decision, or empty.
get_fact() {
  local workdir="$1"
  local persona="$2"
  local fact="$3"
  local store="$workdir/.agentic-personas.json"
  node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  process.exit(1);
}
const p = s[process.argv[2]];
if (!p) process.exit(1);
const d = (p.decisions||[]).filter(x => x.action === process.argv[3]);
if (d.length === 0) process.exit(1);
const newest = d[d.length - 1];
console.log(newest.timestamp || 0);
" "$store" "$persona" "$fact" 2>> "$RUNDIR/supervisor.err"
}

# --- Helper: read the restart request the coordinator left in the run directory ---
# The coordinator's fleet_restart tool writes <rundir>/restart.request rather
# than a restart_requested decision, since this persona's store has one
# writer. It is the same fact, read through the parser the poll imports
# (bin/supervise-restart-request.mjs), so the two paths cannot disagree on
# what a request is. Prints its timestamp, or nothing where the parser reads
# no request.
get_restart_request() {
  node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const { readRestartRequest } = await import(pathToFileURL(process.argv[1]).href);
const at = readRestartRequest(process.argv[2], Date.now());
if (at !== null) console.log(Math.floor(at));
" "$PLUGIN_DIR/bin/supervise-restart-request.mjs" "$RUNDIR" 2>> "$RUNDIR/supervisor.err"
}

# --- Helper: read the newest root_complete decision's timestamp AND
# whether it was backfilled, in one read ---
# v2 Section 0 item 1: a root_complete decision whose own detail text says
# "backfilled" records real tool work with no active goal tree - that is not
# a real goal completion, and must never trigger RESTART_PASSIVE. The hook
# now logs such work as an untracked_work decision and writes no such line,
# so this flag reads the lines a store written before that still carries
# until they roll off its decision log. A sibling to
# get_fact rather than a change to it: get_fact's existing single-token
# output feeds bare numeric comparisons elsewhere (the -gt checks below),
# and a two-word answer there would fail those silently. The timestamp and
# the flag come from the SAME read, not two separate store reads at two
# different moments - a root_complete decision appended between two calls
# would otherwise pair a real timestamp with a stale flag, or the reverse.
# "Newest" here is last-in-array, not max-by-timestamp: holds today
# because decisions[] is append-ordered and capped with
# slice(-DECISIONS_MAX), so a future out-of-order writer would break this
# and get_fact identically.
# Usage: get_root_complete <workdir> <persona>
# Prints "<timestamp> <flag>" where <flag> is "1" (backfilled) or "0", or
# empty when there is no root_complete decision at all.
get_root_complete() {
  local workdir="$1"
  local persona="$2"
  local store="$workdir/.agentic-personas.json"
  node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  process.exit(1);
}
const p = s[process.argv[2]];
if (!p) process.exit(1);
const d = (p.decisions||[]).filter(x => x.action === 'root_complete');
if (d.length === 0) process.exit(1);
const newest = d[d.length - 1];
const backfilled = (typeof newest.detail === 'string' && newest.detail.includes('backfilled')) ? '1' : '0';
console.log((newest.timestamp || 0) + ' ' + backfilled);
" "$store" "$persona" 2>> "$RUNDIR/supervisor.err"
}

# --- Helper: how much longer a rate-limited child has to wait ---
# A child that meets a rate limit parks in the engine's own retry backoff. From
# outside it is a live process writing nothing, which reads as WAITING in the
# log for as long as the park runs, so the operator cannot tell an hours-long
# park from an idle child. The stream carries the fact: a `system` record with
# subtype `api_retry` and `error_status` 429, whose `retry_delay_ms` names how
# much of the wait is left. One is written every 30 seconds while the park
# runs, each naming a smaller remaining wait than the last.
#
# Only the newest record in the stream is read. Every other record is the child
# working, so a park ends by itself the moment the child writes one, and no
# separate expiry is needed. The newest record is the last COMPLETE line: the
# child may be mid-write at the end of the file, and a half-written line is not
# a record yet.
#
# Prints "<epoch milliseconds> <ISO 8601>" for the moment the wait ends, or
# "- -" when the newest record is anything else. Only the tail of the stream is
# read, since a long-running child's stdout.jsonl reaches megabytes and this
# runs on every poll.
# Usage: get_rate_limit_reset <stdout.jsonl path>
get_rate_limit_reset() {
  local out_file="$1"
  if [ ! -f "$out_file" ]; then
    echo "- -"
    return 0
  fi
  node -e "
const fs = require('fs');
const SCAN_BYTES = 262144;
const now = Date.now();
let text = '';
let scanStart = 0;
try {
  const fd = fs.openSync(process.argv[1], 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > SCAN_BYTES) scanStart = size - SCAN_BYTES;
    const len = size - scanStart;
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, scanStart);
    text = buf.toString('utf8');
  } finally { fs.closeSync(fd); }
} catch (e) { console.log('- -'); process.exit(0); }
const lines = text.split('\n');
// The tail can start mid-line, and the file can end mid-line while the child
// is writing. Neither partial is a record.
if (scanStart > 0) lines.shift();
lines.pop();
let newest = null;
for (const line of lines) {
  if (!line.trim()) continue;
  let record;
  try { record = JSON.parse(line); } catch (e) { continue; }
  if (record && typeof record === 'object') newest = record;
}
const isRetry = newest
  && newest.type === 'system'
  && newest.subtype === 'api_retry'
  && Number(newest.error_status) === 429
  && Number.isFinite(Number(newest.retry_delay_ms))
  && Number(newest.retry_delay_ms) > 0;
if (!isRetry) { console.log('- -'); process.exit(0); }
const until = now + Number(newest.retry_delay_ms);
console.log(until + ' ' + new Date(until).toISOString());
" "$out_file" 2>> "$RUNDIR/supervisor.err"
}

# --- Helper: read child session id from stream-json init line ---
read_child_session_id() {
  local out_file="$1"
  node -e "
const fs = require('fs');
try {
  const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.session_id) {
      console.log(o.session_id);
      process.exit(0);
    }
  }
} catch (e) { /* not found yet */ }
process.exit(1);
" "$out_file" 2>> "$RUNDIR/supervisor.err"
}

# --- Helper: count a relaunch against the rolling-hour restart budget ---
# Each relaunch is stamped, stamps older than an hour are dropped, and
# RESTART_COUNT is what is left. Every relaunch whose trigger sits outside the
# child's own exit counts here as well as the ones that follow a crash, since
# a trigger that keeps firing would otherwise relaunch the child at poll
# cadence with nothing to stop it.
record_restart_in_hour() {
  local now_ms t
  now_ms=$(node -e "console.log(Date.now())")
  RESTART_TIMES+=("$now_ms")
  local pruned=()
  for t in "${RESTART_TIMES[@]}"; do
    if [ $((now_ms - t)) -lt 3600000 ]; then
      pruned+=("$t")
    fi
  done
  RESTART_TIMES=("${pruned[@]}")
  RESTART_COUNT=${#RESTART_TIMES[@]}
}

# --- Helper: sweep a child the liveness verdict read gone, and account it ---
# Every signal is silent and the walk found no live process. The tree the
# child was last recorded as is swept, and the relaunch is accounted exactly
# as a restart is, so the restart budget still bounds a persona that keeps
# dying. A sweep that cannot clear the tree takes the retry backstop the
# restart branch takes, which re-snapshots once where the sweep left no
# record to retry, and a backstop that fails ends the run at exit 5, since a
# relaunch beside a survivor puts two children on one persona claim. Returns
# once the child is accounted and the run goes on; every stop the budget, the
# crash limit or a survivor calls for exits from here.
sweep_gone_child() {
  log "SWEEP_RELAUNCH: $DECIDE_REASON"
  sweep_child_tree "sweep_relaunch"
  SWEEP_RC=$?
  if [ "$SWEEP_RC" -eq 1 ]; then
    retry_stop_escalation "sweep_relaunch" "$SWEEP_RC"
    SWEEP_RC=$?
    if [ "$SWEEP_RC" -ne 0 ]; then
      log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable after every sweep retry"
      exit 5
    fi
  fi
  # The walk read the child gone, but the wrapper can outlive that
  # reading: a walk that raced the wrapper's own exit, or a sweep with
  # nothing to kill. A wait on a live wrapper would block this loop for
  # as long as the child lives, so a wrapper still running takes the
  # ordinary stop phases first, and its failure ends the run at exit 5
  # as it does on the restart branch.
  if [ -n "$CHILD_LAUNCH_PID" ] && kill -0 "$CHILD_LAUNCH_PID" 2>/dev/null; then
    log "SWEEP_RELAUNCH: child-$CHILD_INDEX's wrapper is still running after the sweep, so it is stopped before the relaunch"
    stop_child "sweep_relaunch"
    retry_stop_escalation "sweep_relaunch" $?
    STOP_ESCALATION_RESULT=$?
    if [ "${STOP_ESCALATION_RESULT:-0}" -ne 0 ]; then
      log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable despite every stop retry (STOP_PATH=$STOP_PATH)"
      exit 5
    fi
  fi
  # The holder is killed so it stops holding the pipe: `wait` on the pipeline
  # would otherwise block on the holder as long as it runs.
  kill_holder
  wait "$CHILD_LAUNCH_PID" 2>/dev/null
  CHILD_LAUNCH_PID=""
  EXIT_CODE=$(read_exit_marker "$EXIT_MARKER")
  clear_handle
  log "EXIT child-$CHILD_INDEX code=$EXIT_CODE (sweep_relaunch)"

  CHILD_RUN_MS=$(( ( $(node -e "console.log(Date.now())") - LAUNCHED_AT ) ))
  if [ $EXIT_CODE -ne 0 ] && [ $CHILD_RUN_MS -lt $SUPERVISOR_MIN_RUN_MS ]; then
    CRASH_COUNT=$((CRASH_COUNT + 1))
  else
    CRASH_COUNT=0
  fi
  record_restart_in_hour

  if [ $RESTART_COUNT -ge $SUPERVISOR_MAX_RESTARTS_PER_HOUR ]; then
    log "STOP_BUDGET: $RESTART_COUNT/$SUPERVISOR_MAX_RESTARTS_PER_HOUR restarts in the hour"
    exit 4
  fi
  if [ $CRASH_COUNT -ge $SUPERVISOR_CRASH_LIMIT ]; then
    log "STOP_CRASH_LOOP: $CRASH_COUNT crashes within $SUPERVISOR_MIN_RUN_MS ms"
    exit 3
  fi
}

# --- Helper: carry one poll's liveness state to the next, and log it ---
# The poll process is fresh every poll, so the stream's size and the moment it
# last changed, and the final ask's time, come back from it as the POLL_*
# values and are held here for the next poll to hand in. A cleared ask is
# named, since it is a frozen child a signal showed alive. A heartbeat file
# the child never wrote is named once per child, however many polls read it
# absent, and the liveness reading is named whenever it changes. The caller
# runs this only for a poll that ran: a failed one says nothing about the
# stream or the ask, so the last reading of each stands.
note_liveness_poll() {
  STREAM_SEEN_SIZE="$POLL_STREAM_SIZE"
  STREAM_CHANGED_AT="$POLL_STREAM_CHANGED_AT"
  if [ -n "$FINAL_ASK_AT" ] && [ -z "$POLL_FINAL_ASK_AT" ]; then
    log "FINAL_ASK_CLEARED child-$CHILD_INDEX: a signal moved inside the final ask's window (liveness: $POLL_LIVENESS)"
  fi
  FINAL_ASK_AT="$POLL_FINAL_ASK_AT"
  if [ "$POLL_HEARTBEAT_NOTE" = "HEARTBEAT_ABSENT" ] && [ -z "$HEARTBEAT_ABSENT_LOGGED" ]; then
    log "HEARTBEAT_ABSENT child-$CHILD_INDEX: $CHILD_HEARTBEAT has not been written past the startup grace, so the heartbeat reads as not silent for this child"
    HEARTBEAT_ABSENT_LOGGED=1
  fi
  if [ -n "$POLL_LIVENESS" ] && [ "$POLL_LIVENESS" != "$LIVENESS_LOGGED" ]; then
    log "LIVENESS child-$CHILD_INDEX: $POLL_LIVENESS"
    LIVENESS_LOGGED="$POLL_LIVENESS"
  fi
}

# --- Helper: carry the shutdown ask from one poll to the next, and log it ---
# The poll writes the ask once, where a shutdown request is present and no ask
# to this child is open, and hands its id and time back as the POLL_SHUTDOWN_*
# values. They are held here for the next poll to hand in, which is what keeps
# a second record from being written while one is open and what the grace is
# measured from. The ask is named on the poll that writes it. The caller runs
# this only for a poll that ran.
note_shutdown_ask() {
  if [ -n "$POLL_SHUTDOWN_ASK_ID" ] && [ "$POLL_SHUTDOWN_ASK_ID" != "$SHUTDOWN_ASK_ID" ]; then
    log "ASK[shutdown] id=$POLL_SHUTDOWN_ASK_ID child-$CHILD_INDEX: $SHUTDOWN_REQUEST_FILE asks this persona to stop, and the child has ${SUPERVISOR_ASK_GRACE_MS}ms to bank its state and call supervisor_shutdown"
  fi
  SHUTDOWN_ASK_ID="$POLL_SHUTDOWN_ASK_ID"
  SHUTDOWN_ASK_AT="$POLL_SHUTDOWN_ASK_AT"
}

# --- Helper: remove the shutdown request once the stop it asked for is done ---
# Run before each exit 0 a shutdown leads to, so the next start in this run
# directory launches rather than reading the request again. A request that
# cannot be removed is named, since that next start will exit 0 on it.
clear_shutdown_request() {
  [ -f "$SHUTDOWN_REQUEST_FILE" ] || return 0
  rm -f "$SHUTDOWN_REQUEST_FILE" 2>/dev/null
  if [ -f "$SHUTDOWN_REQUEST_FILE" ]; then
    log "NOTE: $SHUTDOWN_REQUEST_FILE could not be removed, so the next start in this run directory reads it again and exits 0 without launching"
  fi
}

# --- Helper: stop a child that did not honor the shutdown ask ---
# The grace has passed with no shutdown_requested from the child, so the stop
# proceeds through the stop phases as every decide-path stop does, under a
# label of its own, and the run ends at exit 0, which the keeper reads as the
# shutdown done. A process from the child left alive or unverifiable outranks
# that and ends the run at exit 5, as it does on every other stop, and the
# request stays in place for the next start.
ask_timeout_stop() {
  log "ASK TIMEOUT id=$SHUTDOWN_ASK_ID child-$CHILD_INDEX: $DECIDE_REASON"
  stop_child "ask_timeout"
  retry_stop_escalation "ask_timeout" $?
  STOP_ESCALATION_RESULT=$?
  wait "$CHILD_LAUNCH_PID" 2>/dev/null
  CHILD_LAUNCH_PID=""
  EXIT_CODE=$(read_exit_marker "$EXIT_MARKER")
  clear_handle
  log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
  if [ "${STOP_ESCALATION_RESULT:-0}" -ne 0 ]; then
    log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable despite every stop retry (STOP_PATH=$STOP_PATH)"
    exit 5
  fi
  clear_shutdown_request
  exit 0
}

# --- Helper: read the child's exit code from the .exit marker ---
# The launch shape writes the child's own exit code into the marker, so both
# the launching supervisor and one that adopted a child it did not launch read
# how the child ended from the same place rather than from `wait`, which a
# non-parent cannot use. A missing or non-numeric marker reads as 0.
# Usage: read_exit_marker <marker-path>
read_exit_marker() {
  local v
  v=$(cat "$1" 2>/dev/null)
  v="${v%$'\r'}"
  v="${v//[[:space:]]/}"
  case "$v" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$v" ;;
  esac
}

# --- Helper: kill the holder so the child reads end of input ---
# The graceful stop's pipe close. The launching supervisor's own holder is a
# live child in its own MSYS job table, so a fast MSYS signal closes its stdout
# with no pid-reuse risk. A holder read from a handle at adoption, or one whose
# MSYS pid is gone, is killed by its recorded Windows pid through the
# ticks-matched kill_process_snapshot, so a Windows pid recycled onto another
# process is never signaled and any supervisor can do it without an MSYS signal.
kill_holder() {
  if [ -n "${HOLDER_LAUNCH_PID:-}" ] && kill -0 "$HOLDER_LAUNCH_PID" 2>/dev/null; then
    kill -TERM "$HOLDER_LAUNCH_PID" 2>/dev/null || true
    return 0
  fi
  if [ -n "${HOLDER_WINPID:-}" ] && [ -n "${HOLDER_TICKS:-}" ]; then
    kill_process_snapshot "$HOLDER_WINPID,$HOLDER_TICKS" || true
  fi
  return 0
}

# --- Helper: this supervisor's own Windows pid and start ticks, computed once ---
# Recorded into every handle: the pair an adopting supervisor checks to decide
# whether this supervisor is still running. Computed lazily and cached, so a run
# that never writes a handle (a request-at-launch exit, a GATE FAIL) pays no
# PowerShell for it. snapshot_process_tree refuses this process's own pid, so
# the ticks are read directly.
SELF_WINPID=""
SELF_TICKS=""
SELF_TICKS_DONE=""
ensure_self_ticks() {
  [ -n "$SELF_TICKS_DONE" ] && return 0
  SELF_TICKS_DONE=1
  SELF_WINPID="$(resolve_windows_pid "$$")"
  if [ -n "$SELF_WINPID" ]; then
    SELF_TICKS="$(resolve_windows_start_ticks "$SELF_WINPID")"
  fi
  return 0
}

# --- Helper: a Windows pid's process start ticks ---
# The pair check_snapshot_survivors matches against, for a single pid rather
# than a walked tree: snapshot_process_tree refuses this supervisor's own pid,
# so the handle's own supervisor pid cannot be recorded through it. Prints the
# ticks, or nothing where the pid does not resolve or the walk did not complete.
# Usage: resolve_windows_start_ticks <windows-pid>
resolve_windows_start_ticks() {
  local winpid="$1" raw
  case "$winpid" in ''|*[!0-9]*) return 0 ;; esac
  raw=$(run_bounded_powershell_capture "$SUPERVISOR_PS_BOUND_S" "
    \$p = Get-Process -Id $winpid -ErrorAction SilentlyContinue
    if (\$p) { try { Write-Output ([int64]\$p.StartTime.Ticks) } catch {} }
    Write-Output '$STOP_PS_SENTINEL'
  ")
  printf '%s\n' "$raw" | grep -qx "$STOP_PS_SENTINEL" || return 1
  printf '%s\n' "$raw" | grep -E '^[0-9]+$' | head -1
}

# --- Helper: write <rundir>/child-<n>/handle.json ---
# The record an adopting supervisor reads: the child's session id once the init
# line names it, the holder's and the child's MSYS and Windows pids and start
# ticks, this supervisor's own Windows pid and start ticks (the pair the tree
# walk uses against pid reuse, which an adopting supervisor checks to see
# whether the writer is still running), and the launch timestamp. Rewritten as
# its own once a supervisor adopts the child.
# Usage: write_handle <session-id>
write_handle() {
  local sess="$1"
  ensure_self_ticks
  node -e '
const fs = require("fs");
const [file, sessionId, holderPid, holderWinPid, holderTicks, childPid, childWinPid, childTicks, supWinPid, supTicks, launchedAt, childIndex] = process.argv.slice(1);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const h = {
  sessionId: sessionId || "",
  holderPid: num(holderPid), holderWinPid: num(holderWinPid), holderTicks: num(holderTicks),
  childPid: num(childPid), childWinPid: num(childWinPid), childTicks: num(childTicks),
  supervisorWinPid: num(supWinPid), supervisorTicks: num(supTicks),
  launchedAt: num(launchedAt), childIndex: num(childIndex),
};
fs.writeFileSync(file, JSON.stringify(h));
' "$HANDLE_FILE" "$sess" "${HOLDER_LAUNCH_PID:-}" "${HOLDER_WINPID:-}" "${HOLDER_TICKS:-}" \
  "${CHILD_LAUNCH_PID:-}" "${CHILD_WINPID:-}" "${CHILD_TICKS:-}" "${SELF_WINPID:-}" "${SELF_TICKS:-}" \
  "${LAUNCHED_AT:-}" "$CHILD_INDEX" 2>>"$RUNDIR/supervisor.err"
}

# --- Helper: remove the current child's handle once it is accounted for ---
# A handle on disk always names a child nobody has yet accounted for, so it is
# removed once the child's exit has been read or its tree swept. Never fails.
clear_handle() {
  [ -n "${HANDLE_FILE:-}" ] && rm -f "$HANDLE_FILE" 2>/dev/null
  return 0
}

# --- Helper: the pre-launch gate's route on a readable handle ---
# Two readings and nothing else: whether the writing supervisor is still
# running, and the instrument's verdict for the session the handle names. A
# handle that cannot be read falls to today's wait. Prints ADOPT, WAIT or
# SWEEP_LAUNCH.
# Usage: handle_gate_route <readable:0|1> <writer_running:0|1> <verdict>
handle_gate_route() {
  local readable="$1" writer="$2" verdict="$3"
  if [ "$readable" != "1" ]; then echo "WAIT"; return 0; fi
  if [ "$writer" = "1" ]; then echo "WAIT"; return 0; fi
  case "$verdict" in
    alive|frozen) echo "ADOPT" ;;
    gone) echo "SWEEP_LAUNCH" ;;
    *) echo "WAIT" ;;
  esac
}

# --- Helper: the cleanup trap's route on a signal to a live child ---
# A signal detaches from a handled child the instrument reads alive or frozen,
# leaving it and its holder running for the next supervisor to adopt; it keeps
# today's stop on a child with no readable handle or one that reads gone.
# Prints DETACH or STOP.
# Usage: handle_trap_route <readable:0|1> <verdict>
handle_trap_route() {
  local readable="$1" verdict="$2"
  if [ "$readable" = "1" ] && { [ "$verdict" = "alive" ] || [ "$verdict" = "frozen" ]; }; then
    echo "DETACH"
  else
    echo "STOP"
  fi
}

# --- Helper: is the supervisor that wrote a handle still running ---
# The handle records that supervisor's Windows pid and start ticks, the pair
# the tree walk uses against pid reuse, so an id Windows recycled onto another
# process does not read as the writer still alive. An unverifiable read (a
# PowerShell hiccup) reads as running, so this supervisor waits and times out
# rather than launching beside a child another session may still hold.
# Usage: handle_writer_running <handle-file>
handle_writer_running() {
  local win tick out rc
  win=$(handle_field "$1" supervisorWinPid)
  tick=$(handle_field "$1" supervisorTicks)
  case "$win" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  case "$tick" in ''|*[!0-9]*) echo 0; return 0 ;; esac
  out=$(check_snapshot_survivors "$win,$tick"); rc=$?
  if [ "$rc" -ne 0 ]; then echo 1; return 0; fi
  if [ -n "$out" ]; then echo 1; else echo 0; fi
}

# --- Helper: one poll of the child, into the POLL_* globals ---
# The single place the poll process is called, so the pre-launch gate's
# adoption verdict and the poll loop read the child through the same call. Reads
# every per-child global the loop holds and sets DECIDE_ACTION, DECIDE_REASON,
# DECIDE_ERR and the POLL_* values, each stripped of a trailing CR.
run_child_poll() {
    POLL_RESULT=$(node "$PLUGIN_DIR/bin/supervise-poll.mjs" \
      "$CHILD_HEARTBEAT" "$STORE" "$PERSONA" "$OUT" "$PROFILE_ROOT" "${CHILD_SESSION_ID:-}" \
      "$CHILD_START_TS" "$LAUNCHED_AT" "$STALE_AFTER_MS" "$SUPERVISOR_MIN_RUN_MS" \
      "$SUPERVISOR_MAX_RESTARTS_PER_HOUR" "$CRASH_COUNT" "$RESTART_COUNT" "$SUPERVISOR_CRASH_LIMIT" \
      "$RUNDIR" \
      "$WORKDIR_WINDOWS" "${CHILD_TREE_POLL_WALK:-failed}" "$STREAM_SEEN_SIZE" "$STREAM_CHANGED_AT" \
      "$SUPERVISOR_SILENCE_BOUND_MS" "$SUPERVISOR_PROBE_MS" "$PROBE_WINDOW_MS" \
      "$SUPERVISOR_FINAL_ASK_MS" "$FINAL_ASK_AT" "$SUPERVISOR_START_MS" \
      "$MAILBOX_FILE" "$MAILBOX_ACK_FILE" \
      "$SUPERVISOR_ASK_GRACE_MS" "$SHUTDOWN_ASK_ID" "$SHUTDOWN_ASK_AT" "$SUPERVISOR_SHUTDOWN_TEXT" \
      2>> "$RUNDIR/supervisor.err")
    DECIDE_ERR=$?
    DECIDE_ACTION=""; DECIDE_REASON=""; POLL_RATE_LIMIT=""; POLL_SESSION_ID=""
    POLL_LIVENESS=""; POLL_STREAM_SIZE=""; POLL_STREAM_CHANGED_AT=""; POLL_FINAL_ASK_AT=""; POLL_HEARTBEAT_NOTE=""
    POLL_SHUTDOWN_ASK_ID=""; POLL_SHUTDOWN_ASK_AT=""
    {
      IFS= read -r DECIDE_ACTION
      IFS= read -r DECIDE_REASON
      IFS= read -r POLL_RATE_LIMIT
      IFS= read -r POLL_SESSION_ID
      IFS= read -r POLL_LIVENESS
      IFS= read -r POLL_STREAM_SIZE
      IFS= read -r POLL_STREAM_CHANGED_AT
      IFS= read -r POLL_FINAL_ASK_AT
      IFS= read -r POLL_HEARTBEAT_NOTE
      IFS= read -r POLL_SHUTDOWN_ASK_ID
      IFS= read -r POLL_SHUTDOWN_ASK_AT
    } <<< "$POLL_RESULT"
    DECIDE_ACTION="${DECIDE_ACTION%$'\r'}"
    DECIDE_REASON="${DECIDE_REASON%$'\r'}"
    POLL_RATE_LIMIT="${POLL_RATE_LIMIT%$'\r'}"
    POLL_SESSION_ID="${POLL_SESSION_ID%$'\r'}"
    POLL_LIVENESS="${POLL_LIVENESS%$'\r'}"
    POLL_STREAM_SIZE="${POLL_STREAM_SIZE%$'\r'}"
    POLL_STREAM_CHANGED_AT="${POLL_STREAM_CHANGED_AT%$'\r'}"
    POLL_FINAL_ASK_AT="${POLL_FINAL_ASK_AT%$'\r'}"
    POLL_HEARTBEAT_NOTE="${POLL_HEARTBEAT_NOTE%$'\r'}"
    POLL_SHUTDOWN_ASK_ID="${POLL_SHUTDOWN_ASK_ID%$'\r'}"
    POLL_SHUTDOWN_ASK_AT="${POLL_SHUTDOWN_ASK_AT%$'\r'}"
}

# --- Main loop ---
CHILD_INDEX=0
RESTART_COUNT=0
CRASH_COUNT=0
RESTART_TIMES=()  # array of timestamps for rolling-hour budget

# This supervisor's start time, which prefixes every probe id it writes, so
# ids stay unique across supervisors sharing a run directory.
SUPERVISOR_START_MS=$(node -e "console.log(Date.now())")
# How many final asks this supervisor has written, which numbers each ask's id.
FINAL_ASK_SEQ=0

# Where the harness keeps its transcripts, and the launch directory that names
# the child's project under it. The poll derives the transcript from these and
# the child's session id. The profile is USERPROFILE, falling back to HOME, and
# both are handed over in Windows form, which is the form the harness's
# project key is taken from. An unknown profile leaves the transcript
# unreadable, which the liveness verdict reads as alive.
PROFILE_ROOT="${USERPROFILE:-${HOME:-}}"
if [ -n "$PROFILE_ROOT" ]; then
  PROFILE_ROOT="$(cygpath -w "$PROFILE_ROOT" 2>/dev/null || echo "$PROFILE_ROOT")"
fi
WORKDIR_WINDOWS="$(cygpath -w "$WORKDIR" 2>/dev/null || echo "$WORKDIR")"

# The persona store the poll reads, one path for the whole run.
STORE="$WORKDIR/.agentic-personas.json"

# Whether the FIRST child got no --prompt at all (passive start, plan item 1).
# Captured before the loop, since PROMPT is cleared after it is sent to
# child 1 and every restart afterward launches with an empty PROMPT anyway.
if [ -z "$PROMPT" ]; then
  log "PASSIVE: no prompt given at start; child will idle with its persona claimed and heartbeating, waiting for a goal delivered by chat"
fi

# How many poll iterations between "still alive" log lines while idle. At the
# default 10s poll this is once a minute, so a ten-minute passive run leaves
# roughly ten WAITING lines proving liveness without flooding the log.
ALIVE_LOG_EVERY_N_POLLS=6

while true; do
  # --- Pre-launch adoption on the newest handle ---
  # The gate reads the newest handle before its held check and before the
  # request-at-launch check below, so a request beside a detached live child
  # adopts that child and asks it, and only with no handle does the request end
  # the run before any launch. A readable handle routes on two readings and
  # nothing else: whether the supervisor that wrote it is still running, and the
  # instrument's verdict for the session it names. A running writer is a child
  # this supervisor may not take, so the gate falls to today's wait and a double
  # launch still ends in GATE TIMEOUT.
  ADOPTED=0
  GATE_ROUTE="WAIT"
  VERDICT=""
  HANDLE_FOUND=$(newest_handle "$RUNDIR")
  if [ -n "$HANDLE_FOUND" ] && [ "$(handle_writer_running "$HANDLE_FOUND")" = "0" ]; then
    # Read the handle's child so the instrument can be run against it. The
    # mailbox is not truncated here: adoption is not a launch, and an open
    # shutdown ask in it is this child's.
    CHILD_INDEX=$(handle_field "$HANDLE_FOUND" childIndex)
    CHILD_DIR="$RUNDIR/child-$CHILD_INDEX"
    OUT="$CHILD_DIR/stdout.jsonl"
    ERR="$CHILD_DIR/stderr.log"
    DEBUG="$CHILD_DIR/claude-debug.log"
    EXIT_MARKER="$CHILD_DIR/.exit"
    HANDLE_FILE="$CHILD_DIR/handle.json"
    HOLDER_PID_FILE="$CHILD_DIR/holder.pid"
    CHILD_PID_FILE="$CHILD_DIR/child.pid"
    ASK_REQUEST_FILE="$CHILD_DIR/ask.request"
    CHILD_LAUNCH_PID=$(handle_field "$HANDLE_FOUND" childPid)
    CHILD_WINPID=$(handle_field "$HANDLE_FOUND" childWinPid)
    CHILD_TICKS=$(handle_field "$HANDLE_FOUND" childTicks)
    HOLDER_LAUNCH_PID=$(handle_field "$HANDLE_FOUND" holderPid)
    HOLDER_WINPID=$(handle_field "$HANDLE_FOUND" holderWinPid)
    HOLDER_TICKS=$(handle_field "$HANDLE_FOUND" holderTicks)
    CHILD_SESSION_ID=$(handle_field "$HANDLE_FOUND" sessionId)
    LAUNCHED_AT=$(handle_field "$HANDLE_FOUND" launchedAt)
    CHILD_START_TS="$LAUNCHED_AT"
    LAST_STOP_SNAPSHOT=""; STOP_TREE_MOVED=""
    CHILD_TREE_MSYS_PIDS=""; CHILD_TREE_WINPIDS=""; CHILD_TREE_SEEN_WINPIDS=""
    CHILD_TREE_SEEN_PAIRS=""; CHILD_TREE_SNAPSHOT=""; CHILD_TREE_WALKED=""
    CHILD_TREE_READ_FAILED=""; CHILD_TREE_DESCENDANT_SEEN=""; CHILD_TREE_CONFIRMED_AT=""
    CHILD_TREE_FAILED_CONFIRMS=0
    STREAM_SEEN_SIZE=""; STREAM_CHANGED_AT=""; FINAL_ASK_AT=""
    refresh_child_tree
    run_child_poll
    VERDICT="${POLL_LIVENESS%% *}"
    [ -n "$VERDICT" ] || VERDICT="alive"
    GATE_ROUTE=$(handle_gate_route 1 0 "$VERDICT")
  fi

  case "$GATE_ROUTE" in
    ADOPT)
      log "ADOPT child-$CHILD_INDEX: adopting a live handled child of this persona (verdict $VERDICT), entering the poll loop with no launch"
      if [ -z "$CHILD_SESSION_ID" ] && [ -n "$POLL_SESSION_ID" ]; then CHILD_SESSION_ID="$POLL_SESSION_ID"; fi
      # Rewrite the handle's supervisor pid and ticks as this supervisor's own,
      # so the next supervisor reads the current owner.
      write_handle "$CHILD_SESSION_ID"
      ADOPTED=1
      ;;
    SWEEP_LAUNCH)
      log "SWEEP_RELAUNCH: child-$CHILD_INDEX read gone at the gate; sweeping its tree, the holder included, before a fresh launch"
      if [ -n "$HOLDER_WINPID" ] && [ -n "$HOLDER_TICKS" ]; then
        kill_process_snapshot "$HOLDER_WINPID,$HOLDER_TICKS" || true
      fi
      sweep_child_tree "gate_gone" || true
      clear_handle
      ;;
    WAIT) : ;;
  esac

  if [ "$ADOPTED" != 1 ]; then
    # A shutdown request found with no handle to adopt has no child to ask: the
    # run ends at exit 0 with the request removed, before the next child's
    # directory is made, before the gate's wait and before any launch, so a
    # persona still held by another session cannot turn the request into a gate
    # timeout the keeper retries. A request beside an adoptable child is asked
    # by the poll loop instead, so it is not read here.
    if [ -f "$SHUTDOWN_REQUEST_FILE" ] && [ -z "$HANDLE_FOUND" ]; then
      log "SHUTDOWN_REQUEST: $SHUTDOWN_REQUEST_FILE is present at launch and no child was launched to ask, so the run ends without launching one; a child an earlier stop left running, if any, is not asked"
      clear_shutdown_request
      exit 0
    fi

    CHILD_INDEX=$((CHILD_INDEX + 1))
    CHILD_DIR="$RUNDIR/child-$CHILD_INDEX"
    mkdir -p "$CHILD_DIR"

    OUT="$CHILD_DIR/stdout.jsonl"
    ERR="$CHILD_DIR/stderr.log"
    DEBUG="$CHILD_DIR/claude-debug.log"
    EXIT_MARKER="$CHILD_DIR/.exit"
    HANDLE_FILE="$CHILD_DIR/handle.json"
    HOLDER_PID_FILE="$CHILD_DIR/holder.pid"
    CHILD_PID_FILE="$CHILD_DIR/child.pid"
    ASK_REQUEST_FILE="$CHILD_DIR/ask.request"
    rm -f "$EXIT_MARKER" "$HANDLE_FILE" "$HOLDER_PID_FILE" "$CHILD_PID_FILE" "$ASK_REQUEST_FILE"

    # --- D3: Pre-launch gate (AD2: check both commons AND heartbeat) ---
    GLOBAL_STORE=$(find_global_store "$DEV_MODE")
    if [ -z "$GLOBAL_STORE" ]; then
      log "GATE FAIL: no global commons store found"
      exit 2
    fi
    if ! wait_persona_free_both "$WORKDIR" "$PERSONA" 120 "$STALE_AFTER_MS" "$GLOBAL_STORE" 2>&1 | tee -a "$LOG"; then
      log "GATE TIMEOUT: persona not free after 120s"
      exit 2
    fi
    log "GATE PASSED: no live persona claims (commons and heartbeat both free)"

    # --- Take the child start timestamp BEFORE the launch call (Z6) ---
    CHILD_START_TS=$(node -e "console.log(Date.now())")
    LAUNCHED_AT=$CHILD_START_TS

    # --- Launch the child (the holder holds its stdin pipe) ---
    log "LAUNCH child-$CHILD_INDEX (start_ts=$CHILD_START_TS, prompt=${PROMPT:+set})"

    # AD5: Truncate supervisor.err once at launch; append everywhere after.
    : > "$RUNDIR/supervisor.err"
    # The mailbox pair starts empty for each child, so a probe an earlier child
    # never acknowledged cannot read as this child's silence.
    : > "$MAILBOX_FILE"
    : > "$MAILBOX_ACK_FILE"

    # Write the prompt to a file if child 1 and PROMPT is set.
    PROMPT_FILE=""
    if [ -n "$PROMPT" ] && [ "$CHILD_INDEX" -eq 1 ]; then
      PROMPT_FILE="$RUNDIR/child-1.prompt"
      printf '%s' "$PROMPT" > "$PROMPT_FILE"
    fi

    # The child's standard input is a pipe from bin/supervise-holder.sh, which
    # writes the priming turn and the goal and holds the pipe open until it is
    # killed or the child dies. Section 1 measured the form: `holder | child &`
    # with no `disown`, so the child and the holder survive this supervisor's
    # exit, `$!` names the child (the pipeline's last stage) which `wait` reaps,
    # and killing the holder gives the child end of input. The launch shape
    # writes the child's own exit code into the .exit marker, so a supervisor
    # that adopted this child can read how it ended without `wait`.

    # Plan item 6: --plugin-dir is opt-in (--dev), loading this checkout's own
    # code. Without it the child loads agentic-plugin as an installed plugin
    # (claude plugin install agentic-plugin@agent-persona), the target runtime.
    PLUGIN_DIR_ARGS=()
    if [ "$DEV_MODE" -eq 1 ]; then
      PLUGIN_DIR_ARGS=(--plugin-dir "$(cygpath -w "$PLUGIN_DIR")")
    fi

    # Plan item 5: attach the Discord channel directly to this child (no proxy
    # session, no polling) unless --no-channel was given. --channels loads the
    # relay's installed-plugin entry. CHANNEL_SESSION is the stable thread key;
    # CHANNEL_PROCESS_TOKEN is minted fresh for this one child. CHANNEL_LINEAGE
    # carries the same stable $CHANNEL_NAME across every child this supervisor
    # launches, restarts included, so the registry rebinds to the one thread.
    CHANNEL_ARGS=()
    CHANNEL_ENV=(CHANNEL_LINEAGE="$CHANNEL_NAME")
    if [ "$NO_CHANNEL" -ne 1 ]; then
      CHANNEL_ARGS=(--name "$CHANNEL_NAME" --channels "plugin:relay@sapplefeld-channels")
      CHILD_PROCESS_TOKEN=$(node -e "console.log(require('crypto').randomUUID())")
      CHANNEL_ENV+=(CHANNEL_SESSION="$CHANNEL_NAME" CHANNEL_PROCESS_TOKEN="$CHILD_PROCESS_TOKEN" CHANNEL_SESSION_MIRROR=off)
    fi

    HOLDER_LAUNCH_PID=""; HOLDER_WINPID=""; HOLDER_TICKS=""
    CHILD_WINPID=""; CHILD_TICKS=""
    PERSONA="$PERSONA" NO_CHANNEL="$NO_CHANNEL" \
    COORDINATOR_PERSONA="${COORDINATOR_PERSONA:-}" ARCHITECT_PERSONA="${ARCHITECT_PERSONA:-}" \
    CHILD_INDEX="$CHILD_INDEX" SUPERVISOR_HOLDER_POLL_S="${SUPERVISOR_HOLDER_POLL_S:-2}" \
      bash "$PLUGIN_DIR/bin/supervise-holder.sh" \
        "$HOLDER_PID_FILE" "$OUT" "$CHILD_PID_FILE" "$ASK_REQUEST_FILE" "${PROMPT_FILE:-}" "$SUPERVISOR_PRIMING_WAIT_S" \
        2>> "$RUNDIR/supervisor.err" \
      | { env "${CHANNEL_ENV[@]}" claude -p --input-format stream-json --output-format stream-json --verbose \
          "${PLUGIN_DIR_ARGS[@]}" \
          "${CHANNEL_ARGS[@]}" \
          --settings "$(cygpath -w "$SETTINGS_FILE")" \
          --model "${MODEL:-$SUPERVISOR_MODEL}" \
          --effort "${EFFORT:-$SUPERVISOR_EFFORT}" \
          --permission-mode "$PERMISSION_MODE" \
          --debug-file "$DEBUG" \
          > "$OUT" 2> "$ERR"; echo "$?" > "$EXIT_MARKER"; } &
    CHILD_LAUNCH_PID=$!
    # The child's own MSYS pid, for the holder to watch and exit when it dies.
    echo "$CHILD_LAUNCH_PID" > "$CHILD_PID_FILE"

    # A new child's launch is also the point a stale snapshot from the
    # *previous* child must stop being read. This runs before anything else in
    # the launch block that can end the iteration.
    LAST_STOP_SNAPSHOT=""
    STOP_TREE_MOVED=""
    CHILD_TREE_MSYS_PIDS=""
    CHILD_TREE_WINPIDS=""
    CHILD_TREE_SEEN_WINPIDS=""
    CHILD_TREE_SEEN_PAIRS=""
    CHILD_TREE_SNAPSHOT=""
    CHILD_TREE_WALKED=""
    CHILD_TREE_READ_FAILED=""
    CHILD_TREE_DESCENDANT_SEEN=""
    CHILD_TREE_CONFIRMED_AT=""
    CHILD_TREE_FAILED_CONFIRMS=0
    refresh_child_tree

    # Read the holder's own pid back (the pipeline's $! is the child), resolve
    # both Windows pids and their start ticks, and write the handle. A holder
    # pid that never appears leaves the pipe-close stop to signal the holder if
    # one is known; the poll loop accounts for a child that died at launch.
    HOLDER_LAUNCH_PID=""
    holder_wait_i=0
    while [ "$holder_wait_i" -lt 100 ]; do
      if [ -s "$HOLDER_PID_FILE" ]; then HOLDER_LAUNCH_PID=$(cat "$HOLDER_PID_FILE" 2>/dev/null); break; fi
      kill -0 "$CHILD_LAUNCH_PID" 2>/dev/null || break
      sleep 0.1 >/dev/null 2>&1
      holder_wait_i=$((holder_wait_i + 1))
    done
    if [ -z "$HOLDER_LAUNCH_PID" ]; then
      log "NOTE: child-$CHILD_INDEX holder pid was not recorded; the pipe-close stop falls back to a signal on the holder if one is known"
    fi
    # The child's Windows pid is read cheaply from /proc; its start ticks are
    # left unrecorded, since an adopting supervisor re-walks the child's tree
    # rather than reading the child's ticks from the handle. The holder's start
    # ticks are recorded (one PowerShell read), for the adopter's ticks-matched
    # holder kill.
    CHILD_WINPID=$(resolve_windows_pid "$CHILD_LAUNCH_PID")
    CHILD_TICKS=""
    if [ -n "$HOLDER_LAUNCH_PID" ]; then
      HOLDER_WINPID=$(resolve_windows_pid "$HOLDER_LAUNCH_PID")
      HOLDER_TICKS=$(resolve_windows_start_ticks "$HOLDER_WINPID")
    fi
    # The session id is filled in from the init line once the poll reads it.
    write_handle ""
  fi

  PROMPT=""

  # --- Poll loop ---
  STORE="$WORKDIR/.agentic-personas.json"
  CHILD_SESSION_ID=""
  POLL_COUNT=0
  # The end of the wait this child is parked on, and the value the log last
  # named. Both belong to one child: a fresh child's stream is its own.
  RATE_LIMIT_LOGGED=""
  RATE_LIMIT_RESET=""
  RATE_LIMIT_RESET_ISO=""
  # The liveness state this child's polls carry from one to the next, since
  # the poll process is fresh every poll: the stream's size as last seen and
  # the moment it last changed, on this supervisor's clock, and the time of
  # the final ask for the current silence. All three start empty for each
  # child, so the first poll ages the stream from the file's own modification
  # time.
  STREAM_SEEN_SIZE=""
  STREAM_CHANGED_AT=""
  FINAL_ASK_AT=""
  # The liveness reason the log last named, so the line is written when the
  # reason changes rather than on every poll, and whether this child's missing
  # heartbeat file has been named.
  LIVENESS_LOGGED=""
  HEARTBEAT_ABSENT_LOGGED=""
  # The shutdown ask to this child, its id and when it was written, carried
  # poll to poll. Both start empty for each child, since the mailbox was
  # truncated at its launch.
  SHUTDOWN_ASK_ID=""
  SHUTDOWN_ASK_AT=""

  if [ -z "$CHILD_LAUNCH_PID" ]; then
    log "ERROR: CHILD_LAUNCH_PID not set after launch"
    exit 1
  fi

  while kill -0 "$CHILD_LAUNCH_PID" 2>/dev/null; do
    sleep $((SUPERVISOR_POLL_MS / 1000))
    POLL_COUNT=$((POLL_COUNT + 1))

    # The child's own processes, recorded while they can still be read. A
    # `claude.exe` appears under the wrapper a few seconds after the launch,
    # and nothing can name it once its wrapper exits.
    refresh_child_tree

    # Every reading this poll takes, and the decision on them, in one process:
    # the store, the child's own heartbeat file, the stream, the transcript and
    # the mailbox pair, with the walk above handed in. The store is read once,
    # so every fact off it describes the same moment. The same process writes a
    # probe to the mailbox where the heartbeat is stale, and the shutdown ask
    # where a shutdown request is present and no ask to this child is open.
    # run_child_poll is the one place the poll process is called, shared with
    # the pre-launch gate's adoption verdict.
    run_child_poll

    # The liveness state and the shutdown ask carried to the next poll, taken
    # only from a poll that ran: a failed one says nothing about the stream or
    # either ask, so the last reading of each stands.
    if [ -n "$DECIDE_ACTION" ] && [ $DECIDE_ERR -eq 0 ]; then
      note_liveness_poll
      note_shutdown_ask
    fi

    # The child's session id, off the init line of its stream.
    if [ -z "$CHILD_SESSION_ID" ] && [ -n "$POLL_SESSION_ID" ]; then
      CHILD_SESSION_ID="$POLL_SESSION_ID"
    fi

    # How much longer this child is parked on a rate limit, read off the newest
    # record in its stream. A reading with no park prints "-" in the first
    # field, which is cleared here so everything downstream reads an empty
    # value as no park. A poll whose reader failed says nothing about the park
    # either way, so it leaves the last reading standing: clearing it would
    # name the same park in the log a second time on the next poll.
    if [ -n "$DECIDE_ACTION" ] && [ $DECIDE_ERR -eq 0 ]; then
      read -r RATE_LIMIT_RESET RATE_LIMIT_RESET_ISO <<< "$POLL_RATE_LIMIT"
      case "${RATE_LIMIT_RESET:-}" in
        ''|*[!0-9]*) RATE_LIMIT_RESET=""; RATE_LIMIT_RESET_ISO="" ;;
      esac
    fi

    # Named the moment the park is seen, rather than only on the liveness
    # cadence below: a child can sit in a rate limit's backoff for hours, and
    # the log is where the operator tells that from a working child. Named once
    # per park, since the child rewrites the remaining wait every 30 seconds
    # and keying on that value would put a line in the log on every poll.
    if [ -n "${RATE_LIMIT_RESET:-}" ]; then
      if [ -z "$RATE_LIMIT_LOGGED" ]; then
        log "RATE_LIMITED until $RATE_LIMIT_RESET_ISO: child-$CHILD_INDEX is waiting out a rate limit"
        RATE_LIMIT_LOGGED=1
      fi
    else
      RATE_LIMIT_LOGGED=""
    fi

    # Prove liveness on a cadence: idleness and an empty goal tree are not
    # crash, restart, or completion signals (plan item 1), so this line is
    # the only thing that should appear in the log for a run that is simply
    # waiting on the next chat-delivered goal. A rate-limited child says so
    # instead, since "waiting" on its own is what hid an hour-long backoff.
    if [ $((POLL_COUNT % ALIVE_LOG_EVERY_N_POLLS)) -eq 0 ]; then
      if [ -n "${RATE_LIMIT_RESET_ISO:-}" ]; then
        log "RATE_LIMITED until $RATE_LIMIT_RESET_ISO: child-$CHILD_INDEX alive, persona held, waiting out the limit (poll $POLL_COUNT)"
      else
        log "WAITING: child-$CHILD_INDEX alive, persona held, no restart triggers (poll $POLL_COUNT)"
      fi
    fi

    if [ -z "$DECIDE_ACTION" ] || [ $DECIDE_ERR -ne 0 ]; then
      log "DECIDE ERR $DECIDE_ERR (see supervisor.err)"
      continue
    fi

    case "$DECIDE_ACTION" in
      stop_complete)
        # A shutdown the child recorded while the shutdown ask was open is
        # that ask honored, and the log says so.
        if [ -n "$SHUTDOWN_ASK_ID" ]; then
          log "STOP_COMPLETE: $DECIDE_REASON (the shutdown ask id=$SHUTDOWN_ASK_ID is honored)"
        else
          log "STOP_COMPLETE: $DECIDE_REASON"
        fi
        stop_child "stop_complete"
        retry_stop_escalation "stop_complete" $?
        STOP_ESCALATION_RESULT=$?
        wait "$CHILD_LAUNCH_PID" 2>/dev/null
        CHILD_LAUNCH_PID=""
        EXIT_CODE=$(read_exit_marker "$EXIT_MARKER")
        clear_handle
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        # Exiting 0 here when a process from the child is alive, or when no
        # reading could account for its tree, would read as a clean shutdown
        # when it is not one. Exit 5 instead, a code distinct from every other
        # exit this script uses, so the operator can tell the two apart.
        if [ "${STOP_ESCALATION_RESULT:-0}" -ne 0 ]; then
          log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable despite every stop retry (STOP_PATH=$STOP_PATH)"
          exit 5
        fi
        clear_shutdown_request
        exit 0
        ;;
      ask_timeout)
        ask_timeout_stop
        ;;
      stop_park)
        log "STOP_PARK: $DECIDE_REASON"
        stop_child "stop_park"
        retry_stop_escalation "stop_park" $?
        STOP_ESCALATION_RESULT=$?
        wait "$CHILD_LAUNCH_PID" 2>/dev/null
        CHILD_LAUNCH_PID=""
        EXIT_CODE=$(read_exit_marker "$EXIT_MARKER")
        clear_handle
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        # Exit 6 is what the keeper reads as a park, and it launches the
        # persona again at its next start. A tree that is alive or unverifiable
        # outranks the park, as it outranks every other decide-path stop, and
        # reports as exit 5.
        if [ "${STOP_ESCALATION_RESULT:-0}" -ne 0 ]; then
          log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable despite every stop retry (STOP_PATH=$STOP_PATH)"
          exit 5
        fi
        exit 6
        ;;
      stop_crash_loop)
        log "STOP_CRASH_LOOP: $DECIDE_REASON"
        stop_child "stop_crash_loop"
        retry_stop_escalation "stop_crash_loop" $?
        STOP_ESCALATION_RESULT=$?
        wait "$CHILD_LAUNCH_PID" 2>/dev/null
        CHILD_LAUNCH_PID=""
        EXIT_CODE=$(read_exit_marker "$EXIT_MARKER")
        clear_handle
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        # A tree that is alive or unverifiable outranks the crash loop this
        # path reports, since it is the one state the next launch cannot work
        # around.
        if [ "${STOP_ESCALATION_RESULT:-0}" -ne 0 ]; then
          log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable despite every stop retry (STOP_PATH=$STOP_PATH)"
          exit 5
        fi
        exit 3
        ;;
      stop_budget)
        log "STOP_BUDGET: $DECIDE_REASON"
        stop_child "stop_budget"
        retry_stop_escalation "stop_budget" $?
        STOP_ESCALATION_RESULT=$?
        wait "$CHILD_LAUNCH_PID" 2>/dev/null
        CHILD_LAUNCH_PID=""
        EXIT_CODE=$(read_exit_marker "$EXIT_MARKER")
        clear_handle
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        # A tree that is alive or unverifiable outranks the restart budget
        # this path reports, for the same reason.
        if [ "${STOP_ESCALATION_RESULT:-0}" -ne 0 ]; then
          log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable despite every stop retry (STOP_PATH=$STOP_PATH)"
          exit 5
        fi
        exit 4
        ;;
      restart_passive)
        # Plan item 4: root_complete with no shutdown requested. The goal is
        # done; the supervisor stays up and returns to item 1's passive state
        # for a second goal, rather than exiting. Stopped the same graceful
        # way as stop_complete (EOF path), but this is expected, healthy
        # behavior, not a crash: it must never count toward the crash-loop or
        # restart-budget limits meant for actual failures.
        log "RESTART_PASSIVE: $DECIDE_REASON"
        stop_child "restart_passive"
        retry_stop_escalation "restart_passive" $?
        STOP_ESCALATION_RESULT=$?
        wait "$CHILD_LAUNCH_PID" 2>/dev/null
        CHILD_LAUNCH_PID=""
        EXIT_CODE=$(read_exit_marker "$EXIT_MARKER")
        clear_handle
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        # Launching the next child beside a process this one left running puts
        # two children on one persona claim, so a tree that is alive or that
        # no reading could account for refuses the relaunch and ends the run
        # at exit 5. The natural-exit path draws the same line.
        if [ "${STOP_ESCALATION_RESULT:-0}" -ne 0 ]; then
          log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable despite every stop retry (STOP_PATH=$STOP_PATH)"
          exit 5
        fi
        case "$DECIDE_REASON" in
          restart_requested*)
            log "PASSIVE: restart requested; relaunching the child with the goal tree kept, the new child resumes the active plan"
            ;;
          *)
            log "PASSIVE: goal complete; returning to passive state, waiting for the next goal delivered by chat"
            ;;
        esac
        continue 2  # break out of the poll loop and go to the next child
        ;;
      restart)
        log "RESTART: $DECIDE_REASON"
        stop_child "restart"
        retry_stop_escalation "restart" $?
        STOP_ESCALATION_RESULT=$?
        wait "$CHILD_LAUNCH_PID" 2>/dev/null
        CHILD_LAUNCH_PID=""
        EXIT_CODE=$(read_exit_marker "$EXIT_MARKER")
        clear_handle
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        # A tree from this child that is alive or unverifiable is one terminal
        # state, and it reports as exit 5 here as it does on every other path,
        # ahead of the limit checks below: those end the run for a different
        # reason and would report it under a different code.
        if [ "${STOP_ESCALATION_RESULT:-0}" -ne 0 ]; then
          log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable despite every stop retry (STOP_PATH=$STOP_PATH)"
          exit 5
        fi

        # Update crash counter.
        CHILD_RUN_MS=$(( ( $(node -e "console.log(Date.now())") - LAUNCHED_AT ) ))
        if [ $EXIT_CODE -ne 0 ] && [ $CHILD_RUN_MS -lt $SUPERVISOR_MIN_RUN_MS ]; then
          CRASH_COUNT=$((CRASH_COUNT + 1))
        else
          CRASH_COUNT=0
        fi
        record_restart_in_hour

        # Both limits are read here, before the relaunch, on the same counts
        # the natural-exit path checks and with the same exit codes. A limit
        # read only at the next child's first poll stops the run one launch
        # late, and that launch claims the persona, takes a priming turn and
        # attaches the channel before anything stops it.
        if [ $RESTART_COUNT -ge $SUPERVISOR_MAX_RESTARTS_PER_HOUR ]; then
          log "STOP_BUDGET: $RESTART_COUNT/$SUPERVISOR_MAX_RESTARTS_PER_HOUR restarts in the hour"
          exit 4
        fi
        if [ $CRASH_COUNT -ge $SUPERVISOR_CRASH_LIMIT ]; then
          log "STOP_CRASH_LOOP: $CRASH_COUNT crashes within $SUPERVISOR_MIN_RUN_MS ms"
          exit 3
        fi
        continue 2  # break out of the poll loop and go to the next child
        ;;
      final_ask)
        # Every signal is silent and the child's process is live. The poll has
        # already handed back the ask's time, so the window runs from this poll
        # and the next frozen reading waits inside it rather than asking again:
        # this branch runs once per frozen reading, never on a cadence. The ask
        # is one user turn on the child's input asking for a line of status. A
        # turn the child answers moves its stream and transcript, and a window
        # that closes with every signal still silent restarts. Where the input
        # cannot be written, the window is a wait all the same.
        FINAL_ASK_SEQ=$((FINAL_ASK_SEQ + 1))
        FINAL_ASK_ID="$SUPERVISOR_START_MS-ask-$FINAL_ASK_SEQ"
        # The ask is written to the child-N ask-request file, which the holder's
        # poll writes into the pipe and removes. Writing it there rather than
        # straight to the pipe is what lets a supervisor that adopted this child
        # reach its input, since only the holder holds the pipe. The file is
        # written whole and the holder relays its one line.
        if final_ask_json "$FINAL_ASK_ID" > "$ASK_REQUEST_FILE" 2>>"$RUNDIR/supervisor.err"; then
          log "FINAL_ASK child-$CHILD_INDEX: $DECIDE_REASON (ask id=$FINAL_ASK_ID written to $ASK_REQUEST_FILE for the holder to relay)"
        else
          log "FINAL_ASK child-$CHILD_INDEX: $DECIDE_REASON (ask id=$FINAL_ASK_ID could not be written to $ASK_REQUEST_FILE, so the window is a wait)"
        fi
        ;;
      sweep_relaunch)
        sweep_gone_child
        continue 2  # break out of the poll loop and go to the next child
        ;;
      continue)
        ;;
    esac
  done

  # Child exited on its own (not via decide). The launch shape wrote the child's
  # own exit code into the .exit marker, so `wait` here only reaps the pipeline
  # (and does nothing for a child this supervisor adopted rather than launched),
  # and the exit code is read from the marker. The holder is killed first: it
  # holds the pipe until the child dies, and `wait` on the pipeline would block
  # on the holder as long as it runs.
  kill_holder
  wait "$CHILD_LAUNCH_PID" 2>/dev/null
  CHILD_LAUNCH_PID=""
  EXIT_CODE=$(read_exit_marker "$EXIT_MARKER")
  clear_handle

  log "EXIT child-$CHILD_INDEX code=$EXIT_CODE (natural)"

  # The shutdown the operator asked for is read before anything else this path
  # does. It is the ordinary way a persona goes down: the child records
  # shutdown_requested and exits on its own, and the answer the keeper needs
  # from that is exit 0, which is what writes the hold marker and keeps the
  # persona down. A reading taken after the sweep below could end that run on
  # a code that relaunches instead.
  SHUTDOWN_REQUESTED_TS=$(get_fact "$WORKDIR" "$PERSONA" "shutdown_requested")
  if [ -n "$SHUTDOWN_REQUESTED_TS" ] && [ "$SHUTDOWN_REQUESTED_TS" -gt "$CHILD_START_TS" ]; then
    if [ -n "$SHUTDOWN_ASK_ID" ]; then
      log "STOP_COMPLETE: shutdown_requested at $SHUTDOWN_REQUESTED_TS > child start $CHILD_START_TS (the shutdown ask id=$SHUTDOWN_ASK_ID is honored)"
    else
      log "STOP_COMPLETE: shutdown_requested at $SHUTDOWN_REQUESTED_TS > child start $CHILD_START_TS"
    fi
    # The run ends here whatever the sweep finds, since exit 0 is what the
    # keeper reads as the shutdown being honored and any other code brings the
    # persona back. The sweep still runs, because nothing downstream ever
    # reaches this child's tree again: the keeper writes its hold and stops, so
    # a process left alive here goes on holding the persona claim with nothing
    # left to kill it.
    sweep_child_tree "shutdown"
    SWEEP_RC=$?
    if [ "$SWEEP_RC" -eq 1 ] && [ -n "$LAST_STOP_SNAPSHOT" ]; then
      retry_stop_escalation "shutdown" "$SWEEP_RC"
      SWEEP_RC=$?
    fi
    if [ "$SWEEP_RC" -eq 1 ]; then
      log "NOTE: child-$CHILD_INDEX leaves a process that is alive or a tree that could not be read, and the shutdown the operator asked for is still what this run reports"
    fi
    clear_shutdown_request
    exit 0
  fi

  # A park is read next, the same way, and a shutdown read above outranks it.
  # The child records park_requested and exits on its own, and the answer the
  # keeper needs from that is exit 6, which is what writes the park marker so
  # its next start launches the persona again.
  PARK_REQUESTED_TS=$(get_fact "$WORKDIR" "$PERSONA" "park_requested")
  if [ -n "$PARK_REQUESTED_TS" ] && [ "$PARK_REQUESTED_TS" -gt "$CHILD_START_TS" ]; then
    log "STOP_PARK: park_requested at $PARK_REQUESTED_TS > child start $CHILD_START_TS"
    # Swept here for the same reason the shutdown is: no relaunch follows in
    # this run. Unlike the shutdown, a process left alive or a tree that could
    # not be read ends the run at exit 5, as it does on every stop but the
    # shutdown. The keeper relaunches on that code after its delay, which is
    # what a park asks for anyway, and the next child meets the survivor at the
    # pre-launch gate.
    sweep_child_tree "park"
    SWEEP_RC=$?
    if [ "$SWEEP_RC" -eq 1 ] && [ -n "$LAST_STOP_SNAPSHOT" ]; then
      retry_stop_escalation "park" "$SWEEP_RC"
      SWEEP_RC=$?
    fi
    if [ "$SWEEP_RC" -eq 1 ]; then
      log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable after every sweep retry"
      exit 5
    fi
    exit 6
  fi

  # A child that exits on its own was never stopped, so nothing has looked at
  # what it left running. Anything still alive holds the persona claim, and the
  # next child would spend the whole pre-launch gate waiting on that claim
  # before exiting 2. Swept here, ahead of every branch below, so no relaunch
  # and no exit leaves one behind.
  sweep_child_tree "natural_exit"
  SWEEP_RC=$?
  if [ "$SWEEP_RC" -eq 1 ]; then
    # The retry backstop runs on the record the sweep left standing, which the
    # sweep sets only where retrying that same record can still settle the
    # question. A sweep with nothing to retry against has already said so, and
    # sending it through the backstop would only re-derive that same nothing.
    if [ -n "$LAST_STOP_SNAPSHOT" ]; then
      retry_stop_escalation "natural_exit" "$SWEEP_RC"
      SWEEP_RC=$?
    fi
    # Relaunching beside a survivor is what makes the next child spend the
    # whole pre-launch gate waiting on a persona claim it can never win. Exit 5
    # instead, the same code every other stop path uses for a child whose tree
    # is alive or unverifiable after every retry.
    if [ "$SWEEP_RC" -ne 0 ]; then
      log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable after every sweep retry"
      exit 5
    fi
  fi
  RESTART_REQUESTED_TS=$(get_fact "$WORKDIR" "$PERSONA" "restart_requested")
  # The coordinator's request file is the same fact, and the later of the two
  # is the one compared against this child's start, as the poll compares it.
  RESTART_REQUEST_FILE_TS=$(get_restart_request)
  if [ -n "$RESTART_REQUEST_FILE_TS" ] && { [ -z "$RESTART_REQUESTED_TS" ] || [ "$RESTART_REQUEST_FILE_TS" -gt "$RESTART_REQUESTED_TS" ]; }; then
    RESTART_REQUESTED_TS="$RESTART_REQUEST_FILE_TS"
  fi
  if [ -n "$RESTART_REQUESTED_TS" ] && [ "$RESTART_REQUESTED_TS" -gt "$CHILD_START_TS" ]; then
    log "RESTART_PASSIVE: restart_requested at $RESTART_REQUESTED_TS > child start $CHILD_START_TS (no shutdown requested)"
    log "PASSIVE: restart requested; relaunching the child with the goal tree kept, the new child resumes the active plan"
    continue  # only the outer loop encloses this point; no crash/restart accounting
  fi
  read -r ROOT_COMPLETE_TS ROOT_COMPLETE_BACKFILLED_FLAG <<< "$(get_root_complete "$WORKDIR" "$PERSONA")"
  if [ -n "$ROOT_COMPLETE_TS" ] && [ "$ROOT_COMPLETE_TS" -gt "$CHILD_START_TS" ]; then
    if [ "$ROOT_COMPLETE_BACKFILLED_FLAG" = "1" ] && [ "$EXIT_CODE" -eq 0 ]; then
      # v2 Section 0 item 1: a backfilled root_complete is real tool work
      # with no active goal tree, not a real completion, and falling
      # through to the accounted restart path counts a clean, expected
      # exit against the restart budget; children exit naturally after
      # backfilled turns routinely, so a chatty hour of operator steers
      # would trip stop_budget and kill a healthy supervisor. Relaunch
      # unaccounted instead, the same as restart_requested and a real
      # root_complete above - but only when the child's own exit was
      # actually clean: the unaccounted path exists to stop counting a
      # healthy exit against the budget, not to exempt every backfilled
      # turn regardless of how the child died. A child that does one
      # backfilled tool turn and then exits non-zero falls through to the
      # accounted path below like any other crash.
      log "NOTE: root_complete at $ROOT_COMPLETE_TS > child start $CHILD_START_TS is backfilled, not a real completion (exit $EXIT_CODE); not taking RESTART_PASSIVE"
      log "PASSIVE: relaunching unaccounted after a backfilled root; the child exited clean, not a failure"
      continue  # only the outer loop encloses this point; no crash/restart accounting
    elif [ "$ROOT_COMPLETE_BACKFILLED_FLAG" != "1" ]; then
      log "RESTART_PASSIVE: root_complete at $ROOT_COMPLETE_TS > child start $CHILD_START_TS (no shutdown requested)"
      log "PASSIVE: goal complete; returning to passive state, waiting for the next goal delivered by chat"
      continue  # only the outer loop encloses this point; no crash/restart accounting
    fi
  fi
  # A turn that did real tool work with no open goal logs an untracked_work
  # decision, and the hook re-pushes that one line with a fresh clock on each
  # such turn, so a line newer than this child's start means the child did
  # work this life. A clean exit after it is a healthy child between
  # requests, so it relaunches unaccounted, the same as the backfilled branch
  # above: counting it would let a chatty hour of operator steers trip
  # stop_budget and kill a healthy supervisor. A real root_complete newer
  # than the start has already been taken above. A non-zero exit falls
  # through to the accounted path below like any other crash.
  UNTRACKED_WORK_TS=""
  if [ "$EXIT_CODE" -eq 0 ]; then
    UNTRACKED_WORK_TS=$(get_fact "$WORKDIR" "$PERSONA" "untracked_work")
  fi
  if [ "$EXIT_CODE" -eq 0 ] && [ -n "$UNTRACKED_WORK_TS" ] && [ "$UNTRACKED_WORK_TS" -gt "$CHILD_START_TS" ]; then
    log "NOTE: untracked_work at $UNTRACKED_WORK_TS > child start $CHILD_START_TS is untracked work with no open goal, not a completion (exit $EXIT_CODE); not taking RESTART_PASSIVE"
    log "PASSIVE: relaunching unaccounted after untracked work; the child exited clean, not a failure"
    continue  # only the outer loop encloses this point; no crash/restart accounting
  fi

  # Update crash counter.
  CHILD_RUN_MS=$(( ( $(node -e "console.log(Date.now())") - LAUNCHED_AT ) ))
  if [ $EXIT_CODE -ne 0 ] && [ $CHILD_RUN_MS -lt $SUPERVISOR_MIN_RUN_MS ]; then
    CRASH_COUNT=$((CRASH_COUNT + 1))
  else
    CRASH_COUNT=0
  fi
  record_restart_in_hour

  # Check budget.
  if [ $RESTART_COUNT -ge $SUPERVISOR_MAX_RESTARTS_PER_HOUR ]; then
    log "STOP_BUDGET: $RESTART_COUNT/$SUPERVISOR_MAX_RESTARTS_PER_HOUR restarts in the hour"
    exit 4
  fi

  # Check crash loop.
  if [ $CRASH_COUNT -ge $SUPERVISOR_CRASH_LIMIT ]; then
    log "STOP_CRASH_LOOP: $CRASH_COUNT crashes within $SUPERVISOR_MIN_RUN_MS ms"
    exit 3
  fi

done
