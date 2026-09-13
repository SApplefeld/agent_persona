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
#   0 = run complete (root_complete)
#   2 = pre-launch gate timeout
#   3 = crash loop
#   4 = restart budget exhausted
#   5 = stopped, but a process from the child is alive or unverifiable
#       despite every retry

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

# --- Defaults (plan section 6) ---
# A fixed sentinel line every PowerShell probe below writes as its own
# last statement (Reviewer Round 124, found while fixing R72): powershell
# -Command's exit code reflects whether the LAST statement it ran
# succeeded, not an aggregate error count - a script whose real work ends
# on an `if` whose condition is false (exactly what "the pid is gone,
# checked cleanly" looks like) exits 1 with no error printed anywhere,
# reproduced live this session. A trailing Write-Output of this sentinel
# is a statement that always succeeds, so its presence in stdout - not
# PowerShell's own exit code - is what a caller trusts as "the script ran
# to completion", timed-out truncation being the one case that can never
# produce it.
STOP_PS_SENTINEL="___SUPERVISOR_PS_DONE___"

# Reviewer Round 126 R89: the 30s bound every PowerShell call used was a bare
# literal repeated at each call site. Made a setting, sized to this box's own
# measured spawn cost (R79/R92's live runs: 4-11s per call under this
# session's own load) rather than picked arbitrarily; a slower box overrides
# it rather than silently timing out every call. Disagreement with R84's own
# ask, stated rather than dropped: R84 also asked to "collapse the per-stop
# PowerShell calls to as few as the design allows" - that is addressed
# separately this round (kill_process_snapshot's own retry loop is removed
# in favor of retry_stop_escalation's single wall-clock-bounded loop, R88),
# rather than folded into this one setting.
SUPERVISOR_PS_BOUND_S="${supervisorPsBoundS:-30}"
# Reviewer Round 130 R99 (Minor): unvalidated, a non-numeric override
# makes every `[ "$waited" -lt "$bound" ]` comparison error, which reads
# as "already past the bound" and force-kills every PowerShell call
# instantly. Validated once here; falls back to 30 rather than erroring.
# Reviewer Round 132 R103 (Minor): `0` itself passed this validation (it
# is all digits) and force-kills every call at once, just as a bad
# non-numeric override would - rejected the same way.
case "$SUPERVISOR_PS_BOUND_S" in
  ''|*[!0-9]*|0) SUPERVISOR_PS_BOUND_S=30 ;;
esac

SUPERVISOR_STOP_GRACE_MS="${supervisorStopGraceMs:-60000}"
SUPERVISOR_MIN_RUN_MS="${supervisorMinRunMs:-120000}"
SUPERVISOR_CRASH_LIMIT="${supervisorCrashLimit:-3}"
SUPERVISOR_MAX_RESTARTS_PER_HOUR="${supervisorMaxRestartsPerHour:-6}"
SUPERVISOR_POLL_MS="${supervisorPollMs:-10000}"
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
# without this script changing - so the check is on shape. An emptiness test
# would be dead code here: `${supervisorModel:-opus}` substitutes the default
# for an unset OR empty value, so the variable is never empty by the time it
# is read. What a shape check does catch is the realistic typo, `opsu` or a
# stray quote, which reaches `claude -p` as an unknown model.
case "$SUPERVISOR_MODEL" in
  *[!a-z0-9.-]*|'')
    echo "ERROR: supervisorModel '$SUPERVISOR_MODEL' is not a plausible model name (lowercase letters, digits, dots and hyphens)" >&2
    exit 1
    ;;
esac
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
if [ -n "${MODEL:-}" ]; then
  case "$MODEL" in
    *[!a-z0-9.-]*)
      echo "ERROR: MODEL '$MODEL' is not a plausible model name (lowercase letters, digits, dots and hyphens)" >&2
      exit 1
      ;;
  esac
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
# Same reasoning as R113's model/effort validation: a non-numeric wait bound
# turns the priming wait's own arithmetic comparison into a shell error on
# every launch. The numeric test after the digit test is what rejects an
# all-zero string like "00", which passes a digits-only pattern.
case "$SUPERVISOR_PRIMING_WAIT_S" in
  ''|*[!0-9]*)
    echo "ERROR: supervisorPrimingWaitS '$SUPERVISOR_PRIMING_WAIT_S' is not a whole number of seconds" >&2
    exit 1
    ;;
esac
if [ "$SUPERVISOR_PRIMING_WAIT_S" -le 0 ]; then
  echo "ERROR: supervisorPrimingWaitS '$SUPERVISOR_PRIMING_WAIT_S' must be greater than zero" >&2
  exit 1
fi

# --- Plugin values (single-sourced, emitted to settings JSON) ---
HEARTBEAT_MS="${heartbeatMs:-30000}"
STALE_AFTER_MS="${staleAfterMs:-90000}"
TICK_MS="${controllerTickMs:-10000}"
NUDGE_IDLE_MS="${nudgeIdleMs:-45000}"
NUDGE_FLOOR_MS="${nudgeFloorMs:-5000}"
GIT_PROBE_MS="${gitProbeMs:-30000}"

# Budget thresholds (from the test profile, or defaults)
CONTEXT_BUDGET_INFO_TOKENS="${contextBudgetInfoTokens:-}"
CONTEXT_BUDGET_CLOSEOUT_TOKENS="${contextBudgetCloseoutTokens:-}"
CONTEXT_BUDGET_CRITICAL_TOKENS="${contextBudgetCriticalTokens:-}"
CONTEXT_BUDGET_READ_EVERY_N_TICKS="${contextBudgetReadEveryNTicks:-1}"

# --- Paths ---
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "$RUNDIR" ]; then
  RUNDIR="$WORKDIR/run"
fi
mkdir -p "$RUNDIR"

LOG="$RUNDIR/supervisor.log"
SETTINGS_FILE="$RUNDIR/settings.json"

# --- Source the shared helper ---
_COMMON="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agentic-common.sh"
# shellcheck source=agentic-common.sh
source "$_COMMON"

# --- Emit settings JSON (only if not already provided) ---
if [ ! -f "$SETTINGS_FILE" ]; then
  emit_settings_json "$SETTINGS_FILE"
fi

# --- Helper: log a line to supervisor.log ---
log() {
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "$ts $*" >> "$LOG"
  echo "$*"
}

# --- Helper: log a diagnostic line without touching stdout ---
# Reviewer Round 126 R80: a helper whose stdout a caller captures via
# `$(...)` (run_bounded_powershell, check_snapshot_survivors) must never
# call plain `log`, which echoes to stdout as well as the log file - its
# own diagnostic line rides straight into the caller's parsed result,
# read back as a phantom survivor pid. Same log file, same stderr
# visibility in a terminal, just never stdout.
log_diag() {
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "$ts $*" >> "$LOG"
  echo "$*" >&2
}

# --- Trap: clean up on exit ---
CHILD_PID=""
CHILD_IN=""  # coproc write fd number
LAST_STOP_SNAPSHOT=""  # set by stop_child; the process-tree snapshot its own kill acted on
# Reviewer Round 126 R85 (Minor): unset under `set -u`, so the "no child
# to stop" early return's own `log "... ($STOP_PATH)"` aborted the script.
STOP_PATH=""

# --- Helper: run a native command bounded, without inheriting the
# caller's own stdout ---
# Reviewer Round 130 R94 (Major, reproduced): a taskkill watchdog written
# as `( sleep 5; kill -9 "$tk" 2>/dev/null ) &` with no redirection
# inherits whatever fd its parent function's stdout currently is - in
# every production call, that is the caller's own `$(...)` capture pipe.
# The command substitution cannot return until every process holding a
# copy of that pipe's write end closes it, watchdog included, so a call
# that finished in 4s (by the helper's own log) did not hand control back
# to the caller until 9s - a flat 5-10s tax on every expired call, for no
# reason connected to the actual work. Worse, `$tk` is itself a stub for
# a native `taskkill.exe` (bash exec-optimises the subshell), so `kill -9`
# on it is exactly the signal-based hang the R79 addendum banned, one
# level further removed. Fixed once, here: every native command this
# script spawns and bounds goes through this helper, which redirects to
# `/dev/null` at the exec site itself (so nothing it holds can block a
# caller's pipe) and abandons rather than signals a command that outlives
# its bound (no second kill to hang on).
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
  # Stop the child gracefully if it's still running.
  if [ -n "${CHILD_PID:-}" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    log "CLEANUP: stopping child-$CHILD_INDEX (pid $CHILD_PID)"
    stop_child "cleanup"
    retry_stop_escalation "cleanup" $?
  elif [ -n "$LAST_STOP_SNAPSHOT" ]; then
    # Reviewer Round 124 R75: the wrapper pid can be gone (an earlier
    # stop_child call already reaped it) while its own snapshot still
    # shows a live descendant - the exact incident shape, a dead wrapper
    # with a surviving claude.exe. Keying this trap on the wrapper pid
    # alone means that survivor is never revisited on this exit path; key
    # it on the last known snapshot instead.
    #
    # Reviewer Round 130 R96 (Major): the old guard, `[ -n "$(check_
    # snapshot_survivors ...)" ]`, read a timed-out probe (empty output,
    # rc 1) the same as "no survivors" - R72's fail-open class, missed
    # here because this call site checked emptiness, never rc. Call
    # `kill_process_snapshot` unconditionally instead: it is ticks-matched
    # and re-verifies its own kill, so it is never a blind kill on a
    # snapshot that might already be dead, and it fails closed on its own
    # unverifiable read rather than this call site guessing first.
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
# Reviewer Round 119 R55: `/proc/<pid>/winpid` is the primary read - Cygwin
# `ps` prints a state character in column 1 for a stopped or orphaned
# process, which shifts WINPID to column 5 and would feed a stray `?` or a
# state letter into the PowerShell source unquoted below. `ps` column 4 is
# kept only as a fallback for a pid `/proc` has no entry for. Either way
# the result is validated as pure digits before it is trusted - an
# unvalidated read here is exactly what would let a malformed value reach
# an interpolated PowerShell command string. Must be called while the MSYS
# pid is still alive and tracked - once it exits, both reads find nothing.
# Usage: resolve_windows_pid <msys-pid>
resolve_windows_pid() {
  local pid="$1"
  local winpid=""
  if [ -r "/proc/$pid/winpid" ]; then
    winpid=$(cat "/proc/$pid/winpid" 2>/dev/null)
  fi
  if [ -z "$winpid" ]; then
    winpid=$(ps -p "$pid" 2>/dev/null | tail -n +2 | awk '{print $4}')
  fi
  case "$winpid" in
    ''|*[!0-9]*) return 0 ;;  # empty or non-numeric: refuse to interpolate it anywhere
    *) echo "$winpid" ;;
  esac
}

# --- Helper: run a PowerShell -Command script under a real wall-clock bound
# ---
# Reviewer Round 124 R71 (Critical, reproduced): GNU `timeout` does not
# terminate native powershell.exe on this box - `timeout 3 powershell
# -NoProfile -Command "Start-Sleep -Seconds 12; Write-Output done"` prints
# `done` and only then returns 124. GNU timeout signals the MSYS stub
# process it forks; powershell.exe itself ignores that signal, and bash
# waits for the real process regardless - so none of the four call sites
# `timeout` previously wrapped was actually bounded, and a hung CIM query
# still wedges stop_child (and, through the EXIT trap, the supervisor's
# own shutdown) exactly as R53/R67 were meant to prevent.
#
# Reviewer Round 126 R79 (Critical, reproduced in the production call
# shape): a bare `kill -9` on the tail-exec subshell's own pid does not
# hold under load. Extracted verbatim and run inside `$(...)` (the shape
# every caller actually uses), a 3s bound around `Start-Sleep -Seconds 40`
# returned rc 124 after 264s with the sleep's own late output still in the
# result - the native process outlived the kill, and the caller's `$(...)`
# blocked on an inherited pipe handle until it exited on its own. Fixed
# two ways: the caller now supplies `<outfile>` directly and reads it
# itself after this function returns, rather than this function writing
# its own stdout into the caller's `$(...)` capture (a pipe a live,
# possibly-orphaned process can hold open indefinitely; a plain read of a
# file that already exists cannot hang the same way); and the Windows pid
# is resolved right after spawn (polled, not only at the deadline, since
# it is easiest to read while the process is fresh) and killed via
# `taskkill //F //T //PID` on expiry.
#
# Reviewer Round 126 addendum (reproduced by the blind reviewer, twice):
# `kill -9` on the stub itself is not a safe fallback signal here - it
# blocked 236s and then returned "Permission denied", the same shape of
# hang this whole helper exists to prevent, just moved one line down. Do
# not iterate on signal flavours: the stub is no longer signaled at all
# on expiry.
#
# Reviewer Round 126 R92 (Major, inferred, since confirmed by direct
# observation this round): the comment above claiming the tail-exec
# subshell "collapses into one process" is not the whole shape under
# load - a probe showed three: the MSYS stub this function's own `$!`
# names, an intermediate `bash.exe`, and `powershell.exe` itself.
# `taskkill //F //T //PID` on the stub is a tree walk from that stub at
# kill time; if the intermediate has already exited, `//T` has nothing
# to walk through to reach `powershell.exe`, and the two runs that
# validated this fix never hit that gap. Rather than depend on that walk
# working, the launched script's very first statement now writes its own
# real Windows pid (`$PID`, PowerShell's own automatic variable - always
# correct, no CIM query needed) as a `PSPID:<pid>` line, read from the
# output file while waiting rather than only at the deadline. On expiry,
# that self-reported pid is killed directly, `taskkill //T` on the stub
# still runs as a second attempt, and both calls' exit codes are logged
# rather than discarded. Each `taskkill` is itself backgrounded and
# capped at 5s rather than run as an unbounded native spawn inside a
# function that exists to bound exactly that shape of call.
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
      run_bounded_native 5 taskkill //F //T //PID "$ps_winpid"
      rc_stub=$?
    fi
    log_diag "STOP: taskkill on the real powershell pid ${ps_real_pid:-unresolved} rc=$rc_real; taskkill //T on stub winpid ${ps_winpid:-unresolved} rc=$rc_stub"
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
      log_diag "STOP: the stub pid $ps_pid was still present 5s after taskkill //T on winpid ${ps_winpid:-unresolved} - leaving it for the OS to reap rather than blocking on it"
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

# --- Helper: snapshot a Windows pid's whole descendant tree, without
# killing anything ---
# Reviewer Round 119 R50/R52: walking Win32_Process's ParentProcessId
# *after* the root pid has already been signaled reads a tree that may no
# longer exist, or worse, a *recycled* pid the OS reused for an unrelated
# process - Windows keeps a dead process's ParentProcessId association and
# reuses pids quickly, so a late walk from `$winpid` can find and then
# force-kill something that was never part of this tree at all. This
# function only ever reads; the snapshot it returns is what stop_child
# kills, at whatever point stop_child chooses to kill it - never a live
# re-walk. A visited set stops a cycle (a recycled pid pointing back into
# the same tree) from recursing forever.
#
# Reviewer Round 122 R66: a snapshot of bare pids is not enough - up to two
# minutes can pass between this snapshot and the kill/verify that acts on
# it (the EOF and TERM grace periods), during which a short-lived
# descendant (a hook's own `node`, a `git`) can exit and have its pid
# reused by an unrelated process. Each line is `pid,starttickss` -
# `Get-Process`'s own `StartTime.Ticks` for that pid at snapshot time - so
# every later consumer can tell a genuinely surviving process from a
# same-numbered impostor by comparing tick values, not just pid presence.
#
# Reviewer Round 122 R67 / Round 126 R79 (Minor correction, R93): this
# call is bounded like the kill and verify calls below it - a hung CIM
# query here wedges stop_child exactly as one in the kill path would.
# GNU `timeout` (R67's original wrapper) does not actually hold on this
# box (R71/R79); the bound is `run_bounded_powershell`, not `timeout`.
#
# Output is piped through `tr -d '\r'` (Reviewer Round 122 R62/R63):
# PowerShell emits CRLF even under `-NoProfile`, and an unstripped `\r`
# ends up embedded in every pid this function hands to its callers -
# reproduced live, this session, as a `Missing expression after unary
# operator ','` PowerShell parse error at the kill call, and a second,
# quieter failure at the per-pid liveness probe (`-ErrorAction` parsed as
# a second statement). Stripped once, here, at the source, so nothing
# downstream ever sees a `\r` at all.
#
# Reviewer Round 124 R73 (reproduced): a process whose `StartTime` is
# unreadable (access denied, a transient race) used to emit a bare
# `pid,` with nothing after the comma - kept on the kill list, but
# dropped from every survivor check for failing the digit validation
# there, so it was never confirmed dead either way. Emits the literal
# marker `UNREADABLE` in the ticks field instead, so `check_snapshot_
# survivors` below can treat it as an automatic, unconditional survivor
# rather than silently discarding it.
#
# A caller tells a timeout or PowerShell failure apart from a genuinely
# empty tree by this function's own return code (Reviewer Round 124
# R72's ask): `run_bounded_powershell_capture` returns its bound status
# directly, so no local `pipefail` scoping is needed here to preserve it
# through a pipe, unlike an earlier cut of this function.
# Usage: snapshot_process_tree <windows-pid>
snapshot_process_tree() {
  local winpid="$1"
  if [ -z "$winpid" ]; then
    return 0
  fi
  # Reviewer Round 134 R104 (Critical, reproduced by both reviewers): the
  # prior cut's `Write-Output 'CIMFAIL'` sat *inside* `Get-Descendants`,
  # whose own output stream is what `@(Get-Descendants $winpid)` unions
  # into `$ids` - so the marker never reached this script's real stdout at
  # all. It became a string member of `$ids` instead, and the id loop then
  # emitted `"CIMFAIL,<the PREVIOUS iteration's ticks value>"` plus the
  # sentinel - `Get-Process -Id "CIMFAIL"` fails to bind (not an integer)
  # and never assigns `$proc`, so the loop's `$proc` variable kept
  # whatever process object the last successful iteration left in it,
  # combined with the current (wrong) `$thisId`. A CIM failure was, in
  # practice, still a verified root-only tree. Fixed with a script-scope
  # flag set in the catch (invisible to the id loop, immune to this exact
  # bug), a bare `CIMFAIL` line emitted only after that loop finishes and
  # only from the top-level script (never from inside a function whose
  # own output is captured elsewhere), and `$ids` filtered with a
  # numeric-string match (Round 134's own self-caught regression: an
  # `-is [int]` type check silently drops every real descendant pid,
  # since `Get-CimInstance`'s `ProcessId` is `[UInt32]`, not `[int]`) so a
  # stray non-numeric value can never reach `Get-Process -Id` again
  # regardless.
  local raw
  raw=$(run_bounded_powershell_capture "$SUPERVISOR_PS_BOUND_S" "
      \$visited = New-Object 'System.Collections.Generic.HashSet[int]'
      \$script:cimFailed = \$false
      function Get-Descendants(\$parentId) {
        if (-not \$visited.Add(\$parentId)) { return }
        try {
          \$children = Get-CimInstance Win32_Process -Filter \"ParentProcessId=\$parentId\" -ErrorAction Stop
        } catch {
          \$script:cimFailed = \$true
          return
        }
        foreach (\$c in \$children) { \$c.ProcessId; Get-Descendants \$c.ProcessId }
      }
      \$ids = @($winpid) + @(Get-Descendants $winpid) | Where-Object { \$_ -match '^[0-9]+\$' }
      foreach (\$thisId in \$ids) {
        \$proc = Get-Process -Id \$thisId -ErrorAction SilentlyContinue
        if (\$proc) {
          try { Write-Output (\"\$thisId,\" + \$proc.StartTime.Ticks) }
          catch { Write-Output (\"\$thisId,UNREADABLE\") }
        }
      }
      if (\$script:cimFailed) { Write-Output 'CIMFAIL' }
      Write-Output '$STOP_PS_SENTINEL'
    ")
  # Reviewer Round 132 R101 (Major, confidence medium, taken): a CIM query
  # that failed (WMI down, a transient RPC error) used to be swallowed by
  # `-ErrorAction SilentlyContinue`, silently yielding an empty children
  # list - the walk still finished, the sentinel still got written, and a
  # root-only snapshot (missing every real descendant) reported rc 0. The
  # error-shaped sibling of the timeout claim discarded in Round 130: a
  # timed-out walk really does yield nothing (the sentinel gates that), but
  # a *failed* walk was reaching the sentinel anyway. `-ErrorAction Stop`
  # inside a `try`/`catch` now turns that failure into an explicit
  # `CIMFAIL` marker in the output, checked before trusting the snapshot.
  if printf '%s\n' "$raw" | grep -qx 'CIMFAIL'; then
    log_diag "STOP: snapshot_process_tree's own CIM query failed mid-walk - treating the snapshot as unverified rather than trusting a possibly-incomplete tree"
    return 1
  fi
  if printf '%s\n' "$raw" | grep -qx "$STOP_PS_SENTINEL"; then
    printf '%s\n' "$raw" | grep -vx "$STOP_PS_SENTINEL"
    return 0
  fi
  # Reproduced live, this session: `powershell -Command`'s own exit code
  # reflects whether its LAST statement succeeded, not an aggregate error
  # count - a completely normal "the pid is already gone" result made a
  # prior cut of this function's caller misread PowerShell's own exit
  # code as a completion failure. The sentinel line above is what actually
  # decides completion now; its absence here means the call was force-
  # killed on the run_bounded_powershell timeout before reaching it, or
  # genuinely crashed - either way the walk did not finish.
  return 1
}

# --- Helper: which pids in a snapshot are still the SAME live process ---
# Shared by verify_snapshot_dead (does anything need escalating) and
# kill_process_snapshot (did the kill actually work) so the recycled-pid
# comparison (R66) and the CR-stripped, timeout-wrapped read (R62/R63,
# R67) live in exactly one place. A survivor is a pid that is both alive
# right now AND whose current `StartTime.Ticks` still matches the value
# recorded in the snapshot - a live pid with a different start time is a
# different, unrelated process that happens to share a number.
# Reviewer Round 124: R73 (reproduced) - a pid whose `StartTime` came back
# `UNREADABLE` from the snapshot is reported as an unconditional survivor
# here, never dropped, since "cannot tell" must fail closed rather than
# open. R72 (Major) - a timed-out or failed PowerShell call previously
# produced the same empty string a genuinely clean result does, and
# `verify_snapshot_dead` read both as "all gone". Returns non-zero on that
# failure and reports every pid this call meant to check as unresolved,
# so a caller escalates on silence it cannot trust rather than on nothing.
# Reviewer Round 126: R81 (Major) - a pid whose `StartTime` came back
# `UNREADABLE` is now reported as a survivor only while a process with
# that pid still exists (checked by a plain existence probe, since its
# start time cannot be compared), not unconditionally forever - the prior
# cut meant one such pid in a tree failed every check, retry, and
# escalation permanently. R78 (Critical) - on an unverified call (the
# sentinel missing), this now returns nothing and status 1; it no longer
# hands back the full checked-id list as if those were confirmed
# survivors, since a caller that then force-kills that list is killing by
# bare pid number with no start-time match at all - a mass kill of
# whatever now holds those recycled numbers. R80 (Major) - every
# diagnostic here goes through `log_diag` (stderr and the log file only),
# never plain `log`, because this function's own stdout is what a caller
# parses as the survivor list; a `log` call here used to ride into that
# parsed result as a phantom entry.
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
    # Reviewer Round 130 R99 (Minor): reaching here means $snapshot was
    # non-empty (the early `-z "$snapshot"` return above already handles
    # a genuinely empty one) but nothing in it parsed as a valid pid
    # entry - that is a parse failure, not "nothing to check", and should
    # not read as a clean, verified result.
    log_diag "STOP: check_snapshot_survivors got a non-empty snapshot with no parseable pid entries - treating as unverified"
    return 1
  fi
  # Reviewer Round 130 R95 (Major): `StartTime` can throw at read time (a
  # transient race, not just at snapshot time - `snapshot_process_tree`
  # already guards this same read, this call site did not). Under
  # `-Command`, an unguarded throw aborts only that one loop iteration;
  # the loop continues, the sentinel still gets written, and the whole
  # call reports rc-equivalent success with the live process silently
  # omitted - reported dead, never a survivor, never killed. Guarded the
  # same way the snapshot walk already is.
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
# Reviewer Round 119 R53: the previous cut swallowed every PowerShell
# error and reported success unconditionally, so a slow or hung CIM query
# could wedge stop_child - which the EXIT trap also calls, wedging the
# supervisor itself on shutdown. `run_bounded_powershell` bounds the
# PowerShell call (Round 124 R71/R79 replaced GNU `timeout`, which does
# not hold on this box, with that helper); its own exit status is
# captured (not discarded); and every pid in the snapshot is re-checked
# (via check_snapshot_survivors, matching both pid and start time - R66)
# rather than trusted from Stop-Process's own silence. Logs `kill_failed`
# naming exactly which pids survived, if any do, and returns non-zero so
# a caller can tell (Reviewer Round 122 R65).
# Reviewer Round 126 R78 (Critical): this used to strip the start time and
# `Stop-Process -Id $p -Force` on a bare pid number - so an unverified
# probe upstream (which used to hand back every checked pid as if each
# were a confirmed survivor) turned into a kill of whatever now holds
# those pid numbers, recycled or not. Kills only pairs where `Get-Process
# -Id` still finds the pid AND its `StartTime.Ticks` still matches what
# was recorded in the snapshot - the same match `check_snapshot_survivors`
# uses to decide who's a real survivor in the first place.
#
# Reviewer Round 126 R91 (Major): an `UNREADABLE`-ticks pid used to be
# force-killed by bare existence alone - exactly R78's class narrowed to
# one field, since a pid whose start time was unreadable at snapshot time
# and recycled during the grace window then dies by number, not by
# identity. `check_snapshot_survivors` still reports one as a survivor
# (by existence, the only check available for it - R81), but this
# function no longer kills on that report at all.
#
# Reviewer Round 126 R88 (Major): the internal 3-attempt retry loop this
# function used to run, stacked underneath `retry_stop_escalation`'s own
# 6-attempt loop, is what made the worst-case stop take minutes instead
# of the ~30s the comments claimed. One check here now; `retry_stop_
# escalation` is the single place that retries over time, on its own
# wall-clock budget.
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
    # Reviewer Round 130 R95 (Major, corrected per Round 132 R103 - the
    # comment here previously claimed this reports the pid, but the catch
    # below is empty): the same unguarded `StartTime` read here, on the
    # kill side, means a throw makes this loop iteration silently skip a
    # pid that should have been killed - never fatal (the pid just
    # survives to be re-checked), but it should never be read as a ticks
    # mismatch and killed on an unverifiable comparison either. The catch
    # is deliberately empty: this script never claims to report anything
    # on its own, since the caller's own separate `check_snapshot_
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
  log "STOP: kill_failed - these Windows pids are alive or unverifiable: $(echo "$survivors" | tr '\n' ' ')"
  return 1
}

# --- Helper: on a stop_child failure, keep retrying the tree kill on a
# cadence, bounded well under the pre-gate's own ceiling, before the
# caller proceeds ---
# Reviewer Round 124 R75: every stop_child call site discarded its return
# value, so a caller relaunched a child (or a decide-action path walked
# into the persona pre-gate) with a confirmed-alive survivor from the
# stopped child's own tree, still holding the persona claim - the incident
# this whole item exists to fix, reached through the one door left open.
#
# Reviewer Round 126 R82 (Major): a single retry here still let a restart
# path walk blind into the 120s persona pre-gate (`wait_persona_free_both`)
# on a confirmed-alive survivor, spending the whole 120s waiting on a
# heartbeat staleness timeout rather than on the tree actually dying -
# tonight's 21:36Z-21:40Z incident verbatim. Retries the kill on a cadence
# instead of once, then still proceeds either way with the outcome
# logged - this is a backstop, not a substitute for the pre-gate itself.
#
# Reviewer Round 126 R88 (Major): the "30s" this comment used to claim
# was only the sleeps between six fixed attempts - each attempt's own
# `kill_process_snapshot` call could itself run up to `$SUPERVISOR_PS_
# BOUND_S` seconds (plus, before this round, its own internal 3-attempt
# retry loop, now removed - R88's other half, above), so the real
# worst case was minutes, not 30s. This loop is now bounded by actual
# wall clock against `RETRY_BUDGET_S` (a quarter of the 120s pre-gate
# ceiling, same reasoning as before, just enforced for real this time),
# checked before and after each attempt rather than assumed from a sleep
# count.
#
# Reviewer Round 126 R87's second half: a caller can reach this backstop
# with `LAST_STOP_SNAPSHOT` empty (the very first snapshot attempt in
# `stop_child` never resolved), and a healthy backstop should try to
# re-snapshot rather than give up outright - the wrapper's own pid may
# still be resolvable even though the earlier walk failed or timed out.
# Usage: retry_stop_escalation <label> <stop_child's own return code>
retry_stop_escalation() {
  local label="$1"
  local result="$2"
  if [ "$result" -eq 0 ]; then
    return 0
  fi
  # Reviewer Round 130 R98 (Major): a re-snapshot attempt from a dead or
  # zombie `CHILD_PID` reliably resolves to no winpid at all (confirmed by
  # the blind reviewer's own probe) - looping and sleeping through the
  # whole budget on a re-resolve that structurally cannot ever succeed
  # just burns the budget for nothing. Try exactly once, up front; if it
  # still yields nothing, there is nothing this loop can do and it fails
  # fast rather than slow.
  if [ -z "$LAST_STOP_SNAPSHOT" ]; then
    log "STOP[$label]: stop_child reported failure (STOP_PATH=$STOP_PATH) with no snapshot to retry against; attempting one re-snapshot"
    local resnap_rc=1
    if [ -n "${CHILD_PID:-}" ]; then
      local resnap_winpid
      resnap_winpid=$(resolve_windows_pid "$CHILD_PID")
      if [ -n "$resnap_winpid" ]; then
        LAST_STOP_SNAPSHOT=$(snapshot_process_tree "$resnap_winpid")
        resnap_rc=$?
      fi
    fi
    # Reviewer Round 132 R103 (Minor): the walk's own rc was discarded
    # here, so a resolve failure, a walk failure, and a genuinely clean
    # "already gone" empty result all collapsed into the same log line
    # and the same fail-fast return - even though a clean empty result
    # (rc 0) means there is nothing left to retry against, not that the
    # retry failed.
    if [ -z "$LAST_STOP_SNAPSHOT" ]; then
      if [ "$resnap_rc" -eq 0 ]; then
        log "STOP[$label]: re-snapshot ran clean and found nothing (the wrapper's descendants are already gone) - nothing left to retry"
        return 0
      fi
      log "STOP[$label]: re-snapshot found nothing to retry against (rc=$resnap_rc; the wrapper's own pid no longer resolves, or the walk failed) - failing fast rather than sleeping out the budget"
      return 1
    fi
  fi
  local RETRY_BUDGET_S=30
  local deadline
  deadline=$(( $(date +%s) + RETRY_BUDGET_S ))
  local attempt=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    log "STOP[$label]: retrying the tree kill (attempt $attempt, $(( deadline - $(date +%s) ))s left in budget)"
    if kill_process_snapshot "$LAST_STOP_SNAPSHOT"; then
      log "STOP[$label]: retry succeeded on attempt $attempt, tree confirmed dead"
      LAST_STOP_SNAPSHOT=""
      return 0
    fi
    sleep 2
  done
  log "STOP[$label]: every retry FAILED over the ${RETRY_BUDGET_S}s budget - a process from the stopped child may be alive or unverifiable, and may still hold its persona claim; proceeding anyway rather than spending the pre-gate timeout to find out"
  return 1
}

# Usage: stop_child <label>
# Sets STOP_PATH to one of seven values (Reviewer Round 126 R87 adds
# "unverified" to the six R77 named): "eof", "term", or "kill" when the
# tree is confirmed dead at that phase, "eof_kill_failed",
# "term_kill_failed", "kill_failed" when a CONFIRMED survivor from the
# snapshot remained after that phase's own escalation, or "unverified"
# when the snapshot itself could never be resolved or walked in the first
# place - nothing was confirmed either way. Returns 1 in every failed
# case; callers should read that return rather than trusting STOP_PATH's
# clean-looking values by name alone.
stop_child() {
  local label="$1"
  # If CHILD_PID is not set or empty, there's nothing to stop.
  local pid="${CHILD_PID:-}"
  if [ -z "$pid" ]; then
    log "STOP[$label]: no child to stop (CHILD_PID empty or unbound)"
    return 0
  fi
  # Reviewer Round 136 R107 (Major, required): a wrapper that exits on its
  # own in the window between the poll loop's own `kill -0` check and
  # `stop_child` actually running (the decide-unit's own node calls, the
  # `case` dispatch) used to fall all the way through to `unverified` -
  # `resolve_windows_pid` finds nothing for an already-gone pid, so
  # `snap_attempted` stays 0, and a child that ended cleanly reported
  # `exit 5` as if a survivor were still alive. Checked explicitly here,
  # before any snapshot is even attempted: if the wrapper is already gone
  # and no winpid ever resolves for it, there is nothing to verify and
  # nothing to kill - `STOP_PATH="gone"` reports exactly that, distinct
  # from `unverified` (which means "cannot tell"), and `retry_stop_
  # escalation` treats it as nothing to retry.
  if ! kill -0 "$pid" 2>/dev/null; then
    local early_winpid
    early_winpid=$(resolve_windows_pid "$pid")
    if [ -z "$early_winpid" ]; then
      log "STOP[$label]: wrapper gone before stop_child ran (pid $pid already exited, no winpid resolves) - nothing to verify or kill"
      STOP_PATH="gone"
      LAST_STOP_SNAPSHOT=""
      return 0
    fi
  fi

  # Reviewer Round 119 R50/R52: the snapshot is taken HERE, before any
  # signal at all, not after each phase's kill -0 check fails. The live
  # incident this whole section fixes is a bash wrapper TERMed while its
  # real child survives - Phase 1 and Phase 2 used to return the moment
  # `kill -0 $pid` failed, which only ever checks the MSYS-tracked wrapper,
  # never whether a real descendant is still alive. Resolving and walking
  # the tree only in Phase 3 meant Phase 1/2's own "stopped" report was
  # never actually checked against reality on the exact path the incident
  # took. A snapshot taken after killing risks a recycled pid too (Windows
  # reuses pids quickly and keeps ParentProcessId associations after a
  # process exits) - so this list is fixed once, before anything is
  # signaled, and is the same list checked and killed at every phase below.
  local snapshot_winpid
  snapshot_winpid=$(resolve_windows_pid "$pid")
  # Reviewer Round 130 R98 (Major, confidence medium): the walk's own
  # empty output was conflated with a failed walk - a completed walk from
  # a genuinely live winpid always lists at least the root, so an empty
  # snapshot with `snap_rc` 0 means the walk ran fine and found nothing
  # (the process was already gone), not that nothing was looked at.
  # `snap_attempted` tracks whether the walk ran at all, separately from
  # whether it found anything, so "ran clean and found nothing" (verified
  # dead) is no longer read the same as "never ran" or "ran and failed"
  # (genuinely unverified).
  local snapshot="" snap_rc=0 snap_attempted=0
  if [ -n "$snapshot_winpid" ]; then
    snap_attempted=1
    snapshot=$(snapshot_process_tree "$snapshot_winpid")
    snap_rc=$?
  fi
  # Reviewer Round 122 R64 / Round 124 R71: a failed resolve or a
  # non-zero `snap_rc` (the PowerShell walk timed out or errored - errors
  # go only to supervisor.err, never here) must not read as "verified
  # dead" - it means the tree was never actually looked at. Named
  # explicitly so the operator can tell the two apart in the log, rather
  # than a silent, indistinguishable clean report.
  if [ "$snap_attempted" -eq 0 ] || [ "$snap_rc" -ne 0 ]; then
    log "STOP[$label]: tree not verified (no snapshot resolved for pid $pid, or the walk did not complete, rc=$snap_rc) - stop relies on the coproc's own pid alone"
  fi
  LAST_STOP_SNAPSHOT="$snapshot"

  # Usage: verify_snapshot_dead - returns 0 if every process in $snapshot
  # is confirmed gone (matched by pid AND start time, R66 - a recycled pid
  # front does not count as a survivor); escalates via kill_process_snapshot
  # only on a CONFIRMED survivor, returning 1 if that escalation itself
  # still leaves one (Reviewer Round 122 R65 - this return code is read
  # below, not discarded).
  #
  # Reviewer Round 126 R78 (Critical): an unverified check (rc non-zero -
  # the probe timed out or crashed, Reviewer Round 124 R72) used to be
  # escalated exactly like a confirmed survivor, handing the WHOLE
  # snapshot to `kill_process_snapshot`. `kill_process_snapshot` itself is
  # now ticks-matched (this round's own fix, above) so that call is no
  # longer a blind mass kill by pid - but an unverified read still means
  # nothing was actually confirmed alive, so this now logs and returns 1
  # without calling kill_process_snapshot at all: "cannot tell" is not
  # grounds to act, only grounds to fail closed and let the caller retry.
  #
  # Reviewer Round 126 R87 (Major): an EMPTY snapshot (the resolve or the
  # walk itself failed, `snap_rc` non-zero above) used to return 0 here -
  # "verified dead" - which is the exact report a slow-spawn regime (the
  # bound this whole function exists for) produces on a tree that was
  # never actually looked at. Empty is now the same "cannot tell" case as
  # an unverified check: return 1, not 0.
  verify_snapshot_dead() {
    if [ "$snap_attempted" -eq 0 ] || [ "$snap_rc" -ne 0 ]; then
      log "STOP[$label]: no snapshot was ever resolved for this stop (resolve or walk failed) - not confirming dead on an unverified read"
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

  # Phase 1: EOF - close the write end of the coproc pipe.
  # The child should finish its current turn and exit 0 within a few seconds.
  if [ -n "$CHILD_IN" ]; then
    eval "exec $CHILD_IN>&-"
  fi
  # Poll for up to stopGraceMs for the child to exit on its own.
  local grace=$((SUPERVISOR_STOP_GRACE_MS / 1000))
  local n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt $grace ]; do
    sleep 1
    n=$((n + 1))
  done
  if ! kill -0 "$pid" 2>/dev/null; then
    if verify_snapshot_dead; then
      STOP_PATH="eof"
      LAST_STOP_SNAPSHOT=""
      return 0
    fi
    if [ "$snap_attempted" -eq 0 ] || [ "$snap_rc" -ne 0 ]; then
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
      STOP_PATH="unverified"
    else
      log "STOP[$label]: a snapshot survivor could not be killed after the TERM path"
      STOP_PATH="term_kill_failed"
    fi
    return 1
  fi
  # Phase 3: KILL - send SIGKILL to the wrapper, then force-kill the whole
  # snapshot taken at entry (not a fresh walk from a possibly-dead or
  # -recycled pid).
  log "STOP[$label]: TERM grace expired, sending KILL to pid $pid (winpid $snapshot_winpid) and its process tree"
  # Reviewer Round 126 R93 (Minor): a bare `kill -9` on the wrapper's own
  # MSYS pid is the same class of call the addendum above found could
  # block on this box (236s, "Permission denied") - whether `$pid` here is
  # a real bash process or itself a stub for `claude.exe` decides whether
  # it can hang the same way. `taskkill //F //T` on the already-resolved
  # `$snapshot_winpid` is tried first; `kill -9` remains a fallback for
  # the case `resolve_windows_pid` never found a winpid at all.
  # Reviewer Round 130 R94: this call was itself unbounded - a native
  # spawn with nothing capping how long it can run, inside a function
  # whose whole purpose is bounding exactly that shape of call. Routed
  # through `run_bounded_native` like every other native command this
  # script spawns.
  if [ -n "$snapshot_winpid" ]; then
    run_bounded_native 5 taskkill //F //T //PID "$snapshot_winpid"
    # Reviewer Round 132 R102 (Major): a failed or abandoned taskkill left
    # nothing else touching `$pid` at all - every caller of `stop_child`
    # then runs an unbounded `wait "$CHILD_PID"`, which blocks forever on
    # a wrapper that was never actually signaled. `taskkill` reaching the
    # whole tree is still tried first (it is the only mechanism that can
    # reach a `claude.exe` descendant), but the wrapper's own pid is now
    # independently confirmed signaled, falling back to `kill -9` if
    # `taskkill` did not reach it.
    if kill -0 "$pid" 2>/dev/null; then
      log "STOP[$label]: wrapper pid $pid still present after taskkill //T - falling back to kill -9 on it directly"
      kill -9 "$pid" 2>/dev/null
    fi
  else
    kill -9 "$pid" 2>/dev/null
  fi
  # Reviewer Round 126 R87: the same fail-open bug as verify_snapshot_dead's
  # empty-snapshot case, one phase down - `kill_process_snapshot` on an
  # empty snapshot trivially returns 0 (nothing to kill), which read as
  # STOP_PATH="kill", a clean report, on a tree that was never resolved at
  # all. Checked explicitly before trusting that return.
  if [ "$snap_attempted" -eq 0 ] || [ "$snap_rc" -ne 0 ]; then
    log "STOP[$label]: no snapshot was ever resolved for this stop (resolve or walk failed) - not confirming dead on an unverified read"
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

# --- Helper: read a fact from .agentic-personas.json ---
# Usage: get_fact <workdir> <persona> <fact>
# Prints the timestamp of the newest matching decision, or empty.
# --- Wait for a child turn to close ---
# The stream-json child emits exactly one `"type":"result"` line per turn it
# completes. A prompt written before that line appears joins the open turn
# instead of opening its own, so any caller that needs its message to be a
# separate turn gates on this first.
#
# Returns 0 when a result line appeared inside the bound, 1 when it did not
# and 1 when the child died while waiting. The caller decides what a failure
# means; this only reports it.
#
# The liveness check is what keeps a launch failure from being read as a long
# healthy run. A child that dies at startup emits no result line ever, so
# without it the supervisor sleeps the whole bound, and that sleep lands
# inside the child's measured run time - a 2-second crash reads as a
# 181-second run, which is past `supervisorMinRunMs` and resets the crash
# counter instead of incrementing it. A crash loop then never trips its own
# limit.
#
# The result pattern is deliberately not anchored to the start of the line.
# This stream does not put `type` first: a real turn-close record begins
# `{"duration_api_ms":...` and carries `"type":"result"` well inside it, so
# `^{"type":"result"` matches nothing at all and every launch would sit out
# the whole bound. Measured on a real child's stdout.jsonl: 3 matches
# unanchored, 0 anchored.
wait_for_result_line() {
  local out="$1"
  local bound_s="$2"
  local pid="$3"
  local waited=0
  while [ "$waited" -lt "$bound_s" ]; do
    if [ -f "$out" ] && grep -q '"type":"result"' "$out"; then
      return 0
    fi
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  return 1
}

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

# --- Helper: read the newest root_complete decision's timestamp AND
# whether it was backfilled, in one read ---
# v2 Section 0 item 1: the item 2 backstop (hooks/index.ts) writes a
# root_complete decision whose own detail text says "backfilled" when the
# worker did real tool work with no active goal tree - that is not a real
# goal completion, and must never trigger RESTART_PASSIVE. A sibling to
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

# --- Main loop ---
CHILD_INDEX=0
RESTART_COUNT=0
CRASH_COUNT=0
RESTART_TIMES=()  # array of timestamps for rolling-hour budget

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
  CHILD_INDEX=$((CHILD_INDEX + 1))
  CHILD_DIR="$RUNDIR/child-$CHILD_INDEX"
  mkdir -p "$CHILD_DIR"

  OUT="$CHILD_DIR/stdout.jsonl"
  ERR="$CHILD_DIR/stderr.log"
  DEBUG="$CHILD_DIR/claude-debug.log"
  EXIT_MARKER="$CHILD_DIR/.exit"
  rm -f "$EXIT_MARKER"

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

  # --- Launch the child (AD3: coproc stdin, EOF stop) ---
  log "LAUNCH child-$CHILD_INDEX (start_ts=$CHILD_START_TS, prompt=${PROMPT:+set})"
  
  # AD5: Truncate supervisor.err once at launch; append everywhere after.
  : > "$RUNDIR/supervisor.err"

  # Write the prompt to a file if child 1 and PROMPT is set.
  PROMPT_FILE=""
  if [ -n "$PROMPT" ] && [ "$CHILD_INDEX" -eq 1 ]; then
    PROMPT_FILE="$RUNDIR/child-1.prompt"
    printf '%s' "$PROMPT" > "$PROMPT_FILE"
  fi

  # Launch the child via coproc. The coproc gives us:
  # - CHILD_PID: the claude process pid (no holder to leak)
  # - CHILD[1]: the write-end fd number for stdin
  # To stop the child, we close CHILD[1] (EOF), then TERM, then KILL.
  # The child reads its first prompt from the coproc pipe, stays alive with
  # the pipe open, and exits 0 when the write end closes.

  # Plan item 6: --plugin-dir is opt-in (--dev), loading this checkout's own
  # code. Without it the child loads agentic-plugin as an installed plugin
  # (claude plugin install agentic-plugin@agent-persona), the target runtime.
  PLUGIN_DIR_ARGS=()
  if [ "$DEV_MODE" -eq 1 ]; then
    PLUGIN_DIR_ARGS=(--plugin-dir "$(cygpath -w "$PLUGIN_DIR")")
  fi

  # Plan item 5: attach the Discord channel directly to this child (no proxy
  # session, no polling) unless --no-channel was given. --channels loads the
  # relay's installed-plugin entry (confirmed live: this works with a
  # headless `claude -p` stream-json child, same as an interactive one).
  # CHANNEL_SESSION is the stable thread key (set above, once, from
  # $CHANNEL_NAME); CHANNEL_PROCESS_TOKEN is minted fresh for this one child,
  # mirroring the launch wrapper's own per-launch GUID. Mirroring is off:
  # the thread carries operator conversation, not every turn.
  # CHANNEL_LINEAGE carries the same stable $CHANNEL_NAME across every child
  # this supervisor launches, restarts included (discord-channels' rebind
  # spec item 1): the registry rebinds a session announcing a lineage to
  # that lineage's existing thread instead of opening a new one. It is not
  # gated on --dev; a supervisor-launched child always declares its lineage
  # whether or not the channel itself is attached this run.
  CHANNEL_ARGS=()
  CHANNEL_ENV=(CHANNEL_LINEAGE="$CHANNEL_NAME")
  if [ "$NO_CHANNEL" -ne 1 ]; then
    CHANNEL_ARGS=(--name "$CHANNEL_NAME" --channels "plugin:relay@sapplefeld-channels")
    CHILD_PROCESS_TOKEN=$(node -e "console.log(require('crypto').randomUUID())")
    CHANNEL_ENV+=(CHANNEL_SESSION="$CHANNEL_NAME" CHANNEL_PROCESS_TOKEN="$CHILD_PROCESS_TOKEN" CHANNEL_SESSION_MIRROR=off)
  fi

  coproc CHILD { env "${CHANNEL_ENV[@]}" claude -p --input-format stream-json --output-format stream-json --verbose \
    "${PLUGIN_DIR_ARGS[@]}" \
    "${CHANNEL_ARGS[@]}" \
    --settings "$(cygpath -w "$SETTINGS_FILE")" \
    --model "${MODEL:-$SUPERVISOR_MODEL}" \
    --effort "${EFFORT:-$SUPERVISOR_EFFORT}" \
    --permission-mode "$PERMISSION_MODE" \
    --debug-file "$DEBUG" \
    > "$OUT" 2> "$ERR"; }
  
  # Copy the fd number now: the array is unset when the coproc exits.
  CHILD_IN=${CHILD[1]}
  # Reviewer Round 126 R78: a new child's launch is also the point a stale
  # snapshot from the *previous* child must stop being read - it can
  # describe pids hours old by the time anything revisits it, and every
  # one of those numbers is a candidate for pid recycling by now.
  LAST_STOP_SNAPSHOT=""

  # Send the first message to the child's stdin: the real --prompt when one
  # was given (child 1 only), or a priming turn when the channel is attached
  # and there is no real goal to open on (child 1's plain passive start, and
  # every restart_passive child after it - PROMPT is always empty by then).
  #
  # Plan item 5 (found live, see the plan doc's Chapter 5): a headless
  # stream-json child only registers Discord channel notifications after its
  # first completed turn, and anything the operator sends before that turn
  # completes is silently lost, not queued. Without a first turn, a passive
  # child sits deaf to the channel indefinitely. Whichever message is first
  # also carries the channel-reply instruction when the channel is attached,
  # since the child's own conversational reply is never visible to the
  # operator - only a real `reply` tool call is - and a real goal's own
  # opening turn is otherwise the only turn that instruction could ride on.
  # The prose-style clause below is the same text CLAUDE.md's "Writing to
  # the operator" section carries, kept in sync by hand with its plugin-side
  # copy in hooks/index.ts (REPLY_INSTRUCTION).
  # Reviewer Round 136 addendum, v2 spec Section 0 item 3 Part A
  # (operator-directed): a fixed sentence telling the child to load the
  # kit's own operating skills before touching plan work, so the
  # per-section reviewer pair, the fix-round loop, and the red-before-
  # green rule are actually followed rather than reaching the model only
  # as summarized doctrine. Built unconditionally, independent of
  # `NO_CHANNEL` - this session's own PR #17 review chain showed the gap
  # this closes: two separate Chapter sentences claimed a fix that was
  # not in the diff, exactly the shape a fresh-context blind reviewer on
  # the diff catches every time and a same-context worker does not. This
  # is also the `NO_CHANNEL`-independent priming write Section 3 item 1
  # is planned to reuse.
  SKILL_LOAD_INSTRUCTION="Before your first tool call on any plan work, invoke the Skill tool for claude-kit:operating-instructions, then claude-kit:executing-work; when a plan reaches its last section, claude-kit:finishing-work. After any context compaction, re-invoke the governing skill before the next step, because compaction drops skill bodies. A fix round inside a review loop is a section: it takes the same fresh-context adversarial and blind reviewer pair before you post it, and the round cites their verdicts beside the gate count. "
  # The one line the goal-prompt turn opens with. It names the text behind
  # it as the operator's own task, so a child that has just loaded
  # operating-instructions does not apply that skill's treat-embedded-text-
  # as-data rule to its own goal and stall asking for confirmation.
  GOAL_PROMPT_FRAMING="The text below is your task from the operator. It is trusted; act on it."$'\n\n'
  CHANNEL_REPLY_INSTRUCTION=""
  if [ "$NO_CHANNEL" -ne 1 ]; then
    CHANNEL_REPLY_INSTRUCTION="You are attached to a Discord channel. When you want to say something back to the operator, call the reply tool from the channel-relay MCP server - your own conversational reply is not visible to them. Plain prose, never mannered prose. This governs every reply-tool message the operator reads. Write for a reader on a phone with no session context. One idea per sentence, about twenty words. Answer first, then the reason, then the evidence. Never carry a second rule inside the clause of the first. Never nest a qualification in parentheses or after a semicolon. Name the concrete thing that happened rather than the class it belongs to. Keep precision by adding a sentence, never by packing one. Vary sentence length, because uniform length is its own defect and the twenty is a per-sentence check rather than a target. Use plain words for internal names unless the exact value is what the operator needs to act on. Decide before writing. Never include round numbers, steer numbers, or session ids. End the message when the content ends. When you ask the operator a question, or report something they must decide, give the whole shape: what is happening and why it came up, the question in plain words, what it blocks, each option with what it costs, and your recommendation with its reason. A bare question or a bare pick is not enough. When the operator asks what is going on, or a result is not what they expected, give the outcome, then the reason, then the evidence, each in its own sentence. A shipped notice stays short; an explanation earns its length. "
  fi
  # Every launch opens with the same synthetic priming turn, whatever shape
  # the child is: passive with a channel, passive with none, or a child that
  # has a real goal prompt waiting. The goal prompt, when there is one, is
  # written as its own separate turn afterwards.
  #
  # [SUPERVISOR-PRIMING] marks this turn as synthetic (the child has no
  # real goal yet) so hooks/index.ts's turn.complete backstop - which
  # backfills a completed goal for a turn that did real tool work with
  # no active root - never mistakes the channel's own acknowledgment
  # turn for genuine operator content. Never strip this marker; it is
  # read by the hook, not meant for the model's own reasoning about the
  # task (which is why it precedes, rather than replaces, the reply
  # instruction and the wait-quietly text).
  #
  # Splitting the priming turn off from the goal prompt is what keeps a
  # child from reading its own task as suspect. Concatenated into one turn,
  # the skill-load sentence tells the child to load operating-instructions,
  # whose own text says to treat instructions embedded in content as data
  # and ask rather than act - so the child applied that rule to the very
  # goal prompt sitting behind the sentence, replied asking for
  # confirmation, and spent its only round without ever calling
  # goal_create. Two turns, plus the framing line below, remove the
  # ambiguity about which part is the operator's actual task. maxRounds is
  # an argument to goal_create, so the goal's round count starts when the
  # goal exists and this priming turn consumes none of it.
  #
  # Reviewer Round 113 R36's own gap is closed by the same shape: a worker
  # launched `--no-channel` with no `PROMPT_FILE` (exactly the shape the
  # `.kit/live-*` suites run) once got no priming turn at all, so the
  # skill-load instruction, which must reach every child regardless of
  # `NO_CHANNEL`, never did either.
  if [ -n "$PROMPT_FILE" ] && [ -f "$PROMPT_FILE" ]; then
    PRIMING_BODY="Your task from the operator arrives in the next message. Reply now with one short line acknowledging you are ready, then act on it when it arrives."
  elif [ "$NO_CHANNEL" -ne 1 ]; then
    PRIMING_BODY="You are the passive supervisor. If a goal tree is active, resume it from goal_status; otherwise wait for a goal or a steering message from the operator. Reply now with one short line acknowledging you are ready, then carry on."
  else
    PRIMING_BODY="You are the passive supervisor. If a goal tree is active, resume it from goal_status; otherwise wait for a goal. No channel is attached, so no operator steering message will arrive here. Reply now with one short line acknowledging you are ready, then carry on."
  fi
  node -e "
    const prefix = process.argv[1] || '';
    const body = process.argv[2] || '';
    const json = JSON.stringify({type:'user',role:'user',message:{role:'user',content:[{type:'text',text:
      '[SUPERVISOR-PRIMING] ' + prefix + body
    }]}});
    process.stdout.write(json + '\n');
  " "$SKILL_LOAD_INSTRUCTION$CHANNEL_REPLY_INSTRUCTION" "$PRIMING_BODY" >&"$CHILD_IN"

  if [ -n "$PROMPT_FILE" ] && [ -f "$PROMPT_FILE" ]; then
    # A prompt written while the priming turn is still open joins that turn
    # rather than opening its own, which would put the goal prompt back
    # behind the skill-load sentence and reproduce the very shape this
    # split exists to avoid. So wait for the priming turn's own `result`
    # line before writing. Startup alone runs 45-60 seconds, so the bound
    # is generous; on a timeout the goal prompt is written anyway, since a
    # child that never receives its task is worse than one that receives
    # it late, and the NOTE line says which happened.
    GOAL_WRITE_OK=1
    if wait_for_result_line "$OUT" "$SUPERVISOR_PRIMING_WAIT_S" "${CHILD_PID:-}"; then
      log "NOTE: child-$CHILD_INDEX priming turn completed; sending the goal prompt as its own turn"
    elif [ -n "${CHILD_PID:-}" ] && ! kill -0 "$CHILD_PID" 2>/dev/null; then
      # The child died before it ever closed a turn. Writing into its pipe
      # would accomplish nothing, and the poll loop below is what accounts
      # for the crash - reaching it quickly is the point.
      log "NOTE: child-$CHILD_INDEX died before completing its priming turn; not sending the goal prompt"
      GOAL_WRITE_OK=0
    else
      log "NOTE: child-$CHILD_INDEX priming turn produced no result line within ${SUPERVISOR_PRIMING_WAIT_S}s; sending the goal prompt anyway"
    fi
    if [ "$GOAL_WRITE_OK" -eq 1 ]; then
      node -e "
        const fs = require('fs');
        const p = fs.readFileSync(process.argv[1], 'utf8');
        const framing = process.argv[2] || '';
        const json = JSON.stringify({type:'user',role:'user',message:{role:'user',content:[{type:'text',text:framing + p}]}});
        process.stdout.write(json + '\n');
      " "$PROMPT_FILE" "$GOAL_PROMPT_FRAMING" >&"$CHILD_IN"
    fi
  fi
  PROMPT=""

  # --- Poll loop ---
  STORE="$WORKDIR/.agentic-personas.json"
  HEARTBEAT="$WORKDIR/.agentic-heartbeat.json"
  CHILD_SESSION_ID=""
  POLL_COUNT=0

  if [ -z "${CHILD_PID:-}" ]; then
    log "ERROR: CHILD_PID not set after coproc launch"
    exit 1
  fi

  while kill -0 "$CHILD_PID" 2>/dev/null; do
    sleep $((SUPERVISOR_POLL_MS / 1000))
    POLL_COUNT=$((POLL_COUNT + 1))

    # Prove liveness on a cadence: idleness and an empty goal tree are not
    # crash, restart, or completion signals (plan item 1), so this line is
    # the only thing that should appear in the log for a run that is simply
    # waiting on the next chat-delivered goal.
    if [ $((POLL_COUNT % ALIVE_LOG_EVERY_N_POLLS)) -eq 0 ]; then
      log "WAITING: child-$CHILD_INDEX alive, persona held, no restart triggers (poll $POLL_COUNT)"
    fi

    # Read the child's session id from the init line.
    if [ -z "$CHILD_SESSION_ID" ] && [ -f "$OUT" ]; then
      CHILD_SESSION_ID=$(read_child_session_id "$OUT")
    fi

    # Poll the decision log for signals.
    read -r ROOT_COMPLETE_TS ROOT_COMPLETE_BACKFILLED_FLAG <<< "$(get_root_complete "$WORKDIR" "$PERSONA")"
    [ "$ROOT_COMPLETE_BACKFILLED_FLAG" = "1" ] && ROOT_COMPLETE_BACKFILLED=1 || ROOT_COMPLETE_BACKFILLED=""
    # Plan item 4: a distinct signal from root_complete. root_complete means
    # "this goal is done"; shutdown_requested means "the operator asked the
    # supervisor itself to stop" - only the second one should exit the loop.
    SHUTDOWN_REQUESTED_TS=$(get_fact "$WORKDIR" "$PERSONA" "shutdown_requested")
    # Plan item 8.3: a reader asked for the child to be relaunched (written by
    # the supervisor_restart tool). Maps to restart_passive: the goal tree is
    # kept and the fresh child resumes the active plan.
    RESTART_REQUESTED_TS=$(get_fact "$WORKDIR" "$PERSONA" "restart_requested")
    CRITICAL_TS=""
    if [ -f "$STORE" ]; then
      CRITICAL_TS=$(node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) { process.exit(1); }
const p = s[process.argv[2]];
if (!p) process.exit(1);
const d = (p.decisions||[]).filter(x => x.action === 'context_budget_crossed' && x.detail && x.detail.includes('critical'));
if (d.length === 0) process.exit(1);
const newest = d[d.length - 1];
console.log(newest.timestamp || 0);
" "$STORE" "$PERSONA" 2>> "$RUNDIR/supervisor.err")
    fi

    # Poll the heartbeat.
    HEARTBEAT_JSON=""
    if [ -f "$HEARTBEAT" ]; then
      HEARTBEAT_JSON=$(poll_heartbeat "$HEARTBEAT" "$PERSONA")
    fi
    HEARTBEAT_SESSION_ID=""
    HEARTBEAT_LAST_SEEN=""
    if [ -n "$HEARTBEAT_JSON" ]; then
      HEARTBEAT_SESSION_ID=$(echo "$HEARTBEAT_JSON" | node -e "
const o = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(o.sessionId || '');
" 2>> "$RUNDIR/supervisor.err")
      HEARTBEAT_LAST_SEEN=$(echo "$HEARTBEAT_JSON" | node -e "
const o = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(o.lastSeen || '');
" 2>> "$RUNDIR/supervisor.err")
    fi

    NOW=$(node -e "console.log(Date.now())")

    # Build the decide input JSON.
    DECIDE_INPUT=$(node -e "
const rootCompleteTs = process.argv[1] ? parseInt(process.argv[1]) : null;
const criticalTs = process.argv[2] ? parseInt(process.argv[2]) : null;
const hbSession = process.argv[3] || null;
const hbLastSeen = process.argv[4] ? parseInt(process.argv[4]) : null;
const now = process.argv[5] ? parseInt(process.argv[5]) : null;
const childStartTs = process.argv[6] ? parseInt(process.argv[6]) : 0;
const childSessionId = process.argv[7] || null;
const launchedAt = process.argv[8] ? parseInt(process.argv[8]) : 0;
const staleAfterMs = process.argv[9] ? parseInt(process.argv[9]) : 90000;
const minRunMs = process.argv[10] ? parseInt(process.argv[10]) : 120000;
const maxRestartsPerHour = process.argv[11] ? parseInt(process.argv[11]) : 6;
const crashCount = process.argv[12] ? parseInt(process.argv[12]) : 0;
const restartCount = process.argv[13] ? parseInt(process.argv[13]) : 0;
const shutdownRequestedTs = process.argv[14] ? parseInt(process.argv[14]) : null;
const restartRequestedTs = process.argv[15] ? parseInt(process.argv[15]) : null;
const rootCompleteBackfilled = process.argv[16] === '1';
console.log(JSON.stringify({
  childExitCode: null,
  rootCompleteTs,
  shutdownRequestedTs,
  restartRequestedTs,
  criticalTs,
  crashCount,
  restartCount,
  childStartTs,
  childSessionId,
  heartbeatSessionId: hbSession,
  heartbeatLastSeen: hbLastSeen,
  now,
  launchedAt,
  staleAfterMs,
  minRunMs,
  maxRestartsPerHour,
  rootCompleteBackfilled,
}));
" "${ROOT_COMPLETE_TS:-}" "${CRITICAL_TS:-}" "${HEARTBEAT_SESSION_ID:-}" "${HEARTBEAT_LAST_SEEN:-}" "${NOW:-}" "$CHILD_START_TS" "${CHILD_SESSION_ID:-}" "$LAUNCHED_AT" "$STALE_AFTER_MS" "$SUPERVISOR_MIN_RUN_MS" "$SUPERVISOR_MAX_RESTARTS_PER_HOUR" "$CRASH_COUNT" "$RESTART_COUNT" "${SHUTDOWN_REQUESTED_TS:-}" "${RESTART_REQUESTED_TS:-}" "${ROOT_COMPLETE_BACKFILLED:-}" 2>> "$RUNDIR/supervisor.err")

    # Call the decide unit.
    DECIDE_RESULT=$(node -e "
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const pluginDir = process.argv[2];
const decidePath = resolve(pluginDir, 'bin/supervise-decide.mjs');
const mod = await import(pathToFileURL(decidePath).href);
const input = JSON.parse(process.argv[1]);
const result = mod.decide(input);
console.log(JSON.stringify(result));
" "$DECIDE_INPUT" "$PLUGIN_DIR" 2>> "$RUNDIR/supervisor.err")
    DECIDE_ERR=$?

    if [ -z "$DECIDE_RESULT" ] || [ $DECIDE_ERR -ne 0 ]; then
      log "DECIDE ERR $DECIDE_ERR (see supervisor.err)"
      continue
    fi

    DECIDE_ACTION=$(echo "$DECIDE_RESULT" | node -e "
const o = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(o.action || 'continue');
" 2>> "$RUNDIR/supervisor.err")
    DECIDE_REASON=$(echo "$DECIDE_RESULT" | node -e "
const o = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(o.reason || '');
" 2>> "$RUNDIR/supervisor.err")

    case "$DECIDE_ACTION" in
      stop_complete)
        log "STOP_COMPLETE: $DECIDE_REASON"
        stop_child "stop_complete"
        retry_stop_escalation "stop_complete" $?
        STOP_ESCALATION_RESULT=$?
        if [ -n "${CHILD_PID:-}" ]; then
          wait "$CHILD_PID"; EXIT_CODE=$?
        else
          EXIT_CODE=0
        fi
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        # Reviewer Round 126 R82: exiting 0 here when a survivor is still
        # confirmed alive after every retry reads as a clean shutdown when
        # it is not one. Exit 5 instead, a code distinct from every other
        # exit this script uses, so the operator can tell the two apart.
        if [ "${STOP_ESCALATION_RESULT:-0}" -ne 0 ]; then
          log "EXIT child-$CHILD_INDEX: a process from this child is alive or unverifiable despite every stop retry (STOP_PATH=$STOP_PATH)"
          exit 5
        fi
        exit 0
        ;;
      stop_crash_loop)
        log "STOP_CRASH_LOOP: $DECIDE_REASON"
        stop_child "stop_crash_loop"
        retry_stop_escalation "stop_crash_loop" $?
        STOP_ESCALATION_RESULT=$?
        if [ -n "${CHILD_PID:-}" ]; then
          wait "$CHILD_PID"; EXIT_CODE=$?
        else
          EXIT_CODE=0
        fi
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
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
        if [ -n "${CHILD_PID:-}" ]; then
          wait "$CHILD_PID"; EXIT_CODE=$?
        else
          EXIT_CODE=0
        fi
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
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
        if [ -n "${CHILD_PID:-}" ]; then
          wait "$CHILD_PID"; EXIT_CODE=$?
        else
          EXIT_CODE=0
        fi
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        case "$DECIDE_REASON" in
          restart_requested*)
            log "PASSIVE: restart requested; relaunching the child with the goal tree kept, the new child resumes the active plan"
            ;;
          *)
            log "PASSIVE: goal complete; returning to passive state, waiting for the next goal delivered by chat"
            ;;
        esac
        continue 2  # break out of the poll loop and go to the next child; no crash/restart accounting
        ;;
      restart)
        log "RESTART: $DECIDE_REASON"
        stop_child "restart"
        retry_stop_escalation "restart" $?
        if [ -n "${CHILD_PID:-}" ]; then
          wait "$CHILD_PID"; EXIT_CODE=$?
        else
          EXIT_CODE=0
        fi
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"

        # Update crash counter.
        CHILD_RUN_MS=$(( ( $(node -e "console.log(Date.now())") - LAUNCHED_AT ) ))
        if [ $EXIT_CODE -ne 0 ] && [ $CHILD_RUN_MS -lt $SUPERVISOR_MIN_RUN_MS ]; then
          CRASH_COUNT=$((CRASH_COUNT + 1))
        else
          CRASH_COUNT=0
        fi
        RESTART_COUNT=$((RESTART_COUNT + 1))
        RESTART_TIMES+=($(node -e "console.log(Date.now())"))

        # Prune restart times older than 1 hour.
        NOW_MS=$(node -e "console.log(Date.now())")
        PRUNED=()
        for t in "${RESTART_TIMES[@]}"; do
          if [ $((NOW_MS - t)) -lt 3600000 ]; then
            PRUNED+=("$t")
          fi
        done
        RESTART_TIMES=("${PRUNED[@]}")
        RESTART_COUNT=${#RESTART_TIMES[@]}
        continue 2  # break out of the poll loop and go to the next child
        ;;
    esac
  done

  # Child exited on its own (not via decide).
  # With coproc, we can use wait() to get the real exit code.
  if [ -n "${CHILD_PID:-}" ]; then
    wait "$CHILD_PID"; EXIT_CODE=$?
  else
    EXIT_CODE=0
  fi
  echo "$EXIT_CODE" > "$EXIT_MARKER"

  log "EXIT child-$CHILD_INDEX code=$EXIT_CODE (natural)"

  # Check for shutdown_requested / root_complete to decide whether to stop,
  # go passive, or restart (plan item 4: the two are distinct signals).
  SHUTDOWN_REQUESTED_TS=$(get_fact "$WORKDIR" "$PERSONA" "shutdown_requested")
  if [ -n "$SHUTDOWN_REQUESTED_TS" ] && [ "$SHUTDOWN_REQUESTED_TS" -gt "$CHILD_START_TS" ]; then
    log "STOP_COMPLETE: shutdown_requested at $SHUTDOWN_REQUESTED_TS > child start $CHILD_START_TS"
    exit 0
  fi
  RESTART_REQUESTED_TS=$(get_fact "$WORKDIR" "$PERSONA" "restart_requested")
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

  # Update crash counter.
  CHILD_RUN_MS=$(( ( $(node -e "console.log(Date.now())") - LAUNCHED_AT ) ))
  if [ $EXIT_CODE -ne 0 ] && [ $CHILD_RUN_MS -lt $SUPERVISOR_MIN_RUN_MS ]; then
    CRASH_COUNT=$((CRASH_COUNT + 1))
  else
    CRASH_COUNT=0
  fi
  RESTART_COUNT=$((RESTART_COUNT + 1))
  RESTART_TIMES+=($(node -e "console.log(Date.now())"))

  # Prune restart times older than 1 hour.
  NOW_MS=$(node -e "console.log(Date.now())")
  PRUNED=()
  for t in "${RESTART_TIMES[@]}"; do
    if [ $((NOW_MS - t)) -lt 3600000 ]; then
      PRUNED+=("$t")
    fi
  done
  RESTART_TIMES=("${PRUNED[@]}")
  RESTART_COUNT=${#RESTART_TIMES[@]}

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
