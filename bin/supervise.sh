#!/usr/bin/env bash
# bin/supervise.sh - Supervisor loop for days-long persona runs.
#
# Usage: bin/supervise.sh <workdir> <persona> <permission-mode> [--prompt TEXT] [--rundir DIR] [--dev] [--no-channel] [--channel-name NAME]
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
SUPERVISOR_STOP_GRACE_MS="${supervisorStopGraceMs:-60000}"
SUPERVISOR_MIN_RUN_MS="${supervisorMinRunMs:-120000}"
SUPERVISOR_CRASH_LIMIT="${supervisorCrashLimit:-3}"
SUPERVISOR_MAX_RESTARTS_PER_HOUR="${supervisorMaxRestartsPerHour:-6}"
SUPERVISOR_POLL_MS="${supervisorPollMs:-10000}"

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

# --- Trap: clean up on exit ---
CHILD_PID=""
CHILD_IN=""  # coproc write fd number
cleanup() {
  local exit_code=$?
  # Stop the child gracefully if it's still running.
  if [ -n "${CHILD_PID:-}" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    log "CLEANUP: stopping child-$CHILD_INDEX (pid $CHILD_PID)"
    stop_child "cleanup"
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- AD3: Stop the child via EOF (close write end), then TERM, then KILL ---
# Usage: stop_child <label>
# Sets STOP_PATH to "eof" | "term" | "kill" based on what actually worked.
stop_child() {
  local label="$1"
  # If CHILD_PID is not set or empty, there's nothing to stop.
  local pid="${CHILD_PID:-}"
  if [ -z "$pid" ]; then
    log "STOP[$label]: no child to stop (CHILD_PID empty or unbound)"
    return 0
  fi
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
    STOP_PATH="eof"
    return 0
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
    STOP_PATH="term"
    return 0
  fi
  # Phase 3: KILL - send SIGKILL after a second grace.
  log "STOP[$label]: TERM grace expired, sending KILL to pid $pid"
  kill -9 "$pid" 2>/dev/null
  STOP_PATH="kill"
  return 0
}

# find_global_store is defined in bin/agentic-common.sh (sourced above),
# shared with .kit/live-common.sh so both callers filter on dev_mode the
# same way rather than carrying their own copies.

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
  CHANNEL_ARGS=()
  CHANNEL_ENV=()
  if [ "$NO_CHANNEL" -ne 1 ]; then
    CHANNEL_ARGS=(--name "$CHANNEL_NAME" --channels "plugin:relay@sapplefeld-channels")
    CHILD_PROCESS_TOKEN=$(node -e "console.log(require('crypto').randomUUID())")
    CHANNEL_ENV=(CHANNEL_SESSION="$CHANNEL_NAME" CHANNEL_PROCESS_TOKEN="$CHILD_PROCESS_TOKEN" CHANNEL_SESSION_MIRROR=off)
  fi

  coproc CHILD { env "${CHANNEL_ENV[@]}" claude -p --input-format stream-json --output-format stream-json --verbose \
    "${PLUGIN_DIR_ARGS[@]}" \
    "${CHANNEL_ARGS[@]}" \
    --settings "$(cygpath -w "$SETTINGS_FILE")" \
    --model "${MODEL:-haiku}" \
    --permission-mode "$PERMISSION_MODE" \
    --debug-file "$DEBUG" \
    > "$OUT" 2> "$ERR"; }
  
  # Copy the fd number now: the array is unset when the coproc exits.
  CHILD_IN=${CHILD[1]}
  
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
  CHANNEL_REPLY_INSTRUCTION=""
  if [ "$NO_CHANNEL" -ne 1 ]; then
    CHANNEL_REPLY_INSTRUCTION="You are attached to a Discord channel. When you want to say something back to the operator, call the reply tool from the channel-relay MCP server - your own conversational reply is not visible to them. "
  fi
  if [ -n "$PROMPT_FILE" ] && [ -f "$PROMPT_FILE" ]; then
    node -e "
      const fs = require('fs');
      const p = fs.readFileSync(process.argv[1], 'utf8');
      const prefix = process.argv[2] || '';
      const json = JSON.stringify({type:'user',role:'user',message:{role:'user',content:[{type:'text',text:prefix + p}]}});
      process.stdout.write(json + '\n');
    " "$PROMPT_FILE" "$CHANNEL_REPLY_INSTRUCTION" >&"$CHILD_IN"
  elif [ "$NO_CHANNEL" -ne 1 ]; then
    node -e "
      const prefix = process.argv[1] || '';
      const json = JSON.stringify({type:'user',role:'user',message:{role:'user',content:[{type:'text',text:
        prefix + 'You are the passive supervisor, waiting for a goal or a steering message from the operator. Reply now with one short line acknowledging you are ready, then wait.'
      }]}});
      process.stdout.write(json + '\n');
    " "$CHANNEL_REPLY_INSTRUCTION" >&"$CHILD_IN"
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
    ROOT_COMPLETE_TS=$(get_fact "$WORKDIR" "$PERSONA" "root_complete")
    # Plan item 4: a distinct signal from root_complete. root_complete means
    # "this goal is done"; shutdown_requested means "the operator asked the
    # supervisor itself to stop" - only the second one should exit the loop.
    SHUTDOWN_REQUESTED_TS=$(get_fact "$WORKDIR" "$PERSONA" "shutdown_requested")
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
console.log(JSON.stringify({
  childExitCode: null,
  rootCompleteTs,
  shutdownRequestedTs,
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
}));
" "${ROOT_COMPLETE_TS:-}" "${CRITICAL_TS:-}" "${HEARTBEAT_SESSION_ID:-}" "${HEARTBEAT_LAST_SEEN:-}" "${NOW:-}" "$CHILD_START_TS" "${CHILD_SESSION_ID:-}" "$LAUNCHED_AT" "$STALE_AFTER_MS" "$SUPERVISOR_MIN_RUN_MS" "$SUPERVISOR_MAX_RESTARTS_PER_HOUR" "$CRASH_COUNT" "$RESTART_COUNT" "${SHUTDOWN_REQUESTED_TS:-}" 2>> "$RUNDIR/supervisor.err")

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
        if [ -n "${CHILD_PID:-}" ]; then
          wait "$CHILD_PID"; EXIT_CODE=$?
        else
          EXIT_CODE=0
        fi
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        exit 0
        ;;
      stop_crash_loop)
        log "STOP_CRASH_LOOP: $DECIDE_REASON"
        stop_child "stop_crash_loop"
        if [ -n "${CHILD_PID:-}" ]; then
          wait "$CHILD_PID"; EXIT_CODE=$?
        else
          EXIT_CODE=0
        fi
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        exit 3
        ;;
      stop_budget)
        log "STOP_BUDGET: $DECIDE_REASON"
        stop_child "stop_budget"
        if [ -n "${CHILD_PID:-}" ]; then
          wait "$CHILD_PID"; EXIT_CODE=$?
        else
          EXIT_CODE=0
        fi
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
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
        if [ -n "${CHILD_PID:-}" ]; then
          wait "$CHILD_PID"; EXIT_CODE=$?
        else
          EXIT_CODE=0
        fi
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        log "PASSIVE: goal complete; returning to passive state, waiting for the next goal delivered by chat"
        continue 2  # break out of the poll loop and go to the next child; no crash/restart accounting
        ;;
      restart)
        log "RESTART: $DECIDE_REASON"
        stop_child "restart"
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
  ROOT_COMPLETE_TS=$(get_fact "$WORKDIR" "$PERSONA" "root_complete")
  if [ -n "$ROOT_COMPLETE_TS" ] && [ "$ROOT_COMPLETE_TS" -gt "$CHILD_START_TS" ]; then
    log "RESTART_PASSIVE: root_complete at $ROOT_COMPLETE_TS > child start $CHILD_START_TS (no shutdown requested)"
    log "PASSIVE: goal complete; returning to passive state, waiting for the next goal delivered by chat"
    continue  # only the outer loop encloses this point; no crash/restart accounting
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
