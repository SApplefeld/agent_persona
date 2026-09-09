#!/usr/bin/env bash
# bin/supervise.sh - Supervisor loop for days-long persona runs.
#
# Usage: bin/supervise.sh <workdir> <persona> <permission-mode> [--prompt TEXT] [--rundir DIR]
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
  echo "Usage: bin/supervise.sh <workdir> <persona> <permission-mode> [--prompt TEXT] [--rundir DIR]" >&2
  exit 1
fi

WORKDIR="$1"
PERSONA="$2"
PERMISSION_MODE="$3"
shift 3

PROMPT=""
RUNDIR=""

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
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

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
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
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
  # Phase 1: EOF - close the write end of the coproc pipe.
  # The child should finish its current turn and exit 0 within a few seconds.
  if [ -n "$CHILD_IN" ]; then
    eval "exec $CHILD_IN>&-"
  fi
  # Poll for up to stopGraceMs for the child to exit on its own.
  local grace=$((SUPERVISOR_STOP_GRACE_MS / 1000))
  local n=0
  while kill -0 "$CHILD_PID" 2>/dev/null && [ $n -lt $grace ]; do
    sleep 1
    n=$((n + 1))
  done
  if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    STOP_PATH="eof"
    return 0
  fi
  # Phase 2: TERM - send SIGTERM after grace expired.
  log "STOP[$label]: EOF grace expired, sending TERM to pid $CHILD_PID"
  kill -TERM "$CHILD_PID" 2>/dev/null
  n=0
  while kill -0 "$CHILD_PID" 2>/dev/null && [ $n -lt $grace ]; do
    sleep 1
    n=$((n + 1))
  done
  if ! kill -0 "$CHILD_PID" 2>/dev/null; then
    STOP_PATH="term"
    return 0
  fi
  # Phase 3: KILL - send SIGKILL after a second grace.
  log "STOP[$label]: TERM grace expired, sending KILL to pid $CHILD_PID"
  kill -9 "$CHILD_PID" 2>/dev/null
  STOP_PATH="kill"
  return 0
}

# --- Helper: find the global commons store ---
find_global_store() {
  local f
  if [ -d "$HOME/.claude/plugins/store" ]; then
    for f in "$HOME/.claude/plugins/store"/agentic-plugin_*.json; do
      if [ -f "$f" ]; then
        echo "$f"
        return 0
      fi
    done
  fi
  echo ""
  return 0
}

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
" "$store" "$persona" "$fact" 2> "$RUNDIR/supervisor.err"
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
  GLOBAL_STORE=$(find_global_store)
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
  
  coproc CHILD { claude -p --input-format stream-json --output-format stream-json --verbose \
    --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
    --settings "$(cygpath -w "$SETTINGS_FILE")" \
    --model "${MODEL:-haiku}" \
    --permission-mode "$PERMISSION_MODE" \
    --debug-file "$DEBUG" \
    > "$OUT" 2> "$ERR"; }
  
  # Copy the fd number now: the array is unset when the coproc exits.
  CHILD_IN=${CHILD[1]}
  
  # Send the first prompt (child 1 only) to the child's stdin.
  if [ -n "$PROMPT_FILE" ] && [ -f "$PROMPT_FILE" ]; then
    node -e "
      const fs = require('fs');
      const p = fs.readFileSync(process.argv[1], 'utf8');
      const json = JSON.stringify({type:'user',role:'user',message:{role:'user',content:[{type:'text',text:p}]}});
      process.stdout.write(json + '\n');
    " "$PROMPT_FILE" >&"$CHILD_IN"
  fi

  # --- Poll loop ---
  STORE="$WORKDIR/.agentic-personas.json"
  HEARTBEAT="$WORKDIR/.agentic-heartbeat.json"
  CHILD_SESSION_ID=""

  while kill -0 "$CHILD_PID" 2>/dev/null; do
    sleep $((SUPERVISOR_POLL_MS / 1000))

    # Read the child's session id from the init line.
    if [ -z "$CHILD_SESSION_ID" ] && [ -f "$OUT" ]; then
      CHILD_SESSION_ID=$(read_child_session_id "$OUT")
    fi

    # Poll the decision log for signals.
    ROOT_COMPLETE_TS=$(get_fact "$WORKDIR" "$PERSONA" "root_complete")
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
console.log(JSON.stringify({
  childExitCode: null,
  rootCompleteTs,
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
" "${ROOT_COMPLETE_TS:-}" "${CRITICAL_TS:-}" "${HEARTBEAT_SESSION_ID:-}" "${HEARTBEAT_LAST_SEEN:-}" "${NOW:-}" "$CHILD_START_TS" "${CHILD_SESSION_ID:-}" "$LAUNCHED_AT" "$STALE_AFTER_MS" "$SUPERVISOR_MIN_RUN_MS" "$SUPERVISOR_MAX_RESTARTS_PER_HOUR" "$CRASH_COUNT" "$RESTART_COUNT" 2>> "$RUNDIR/supervisor.err")

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
" "$DECIDE_INPUT" "$PLUGIN_DIR" 2> "$RUNDIR/supervisor.err")
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
        wait "$CHILD_PID"; EXIT_CODE=$?
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        exit 0
        ;;
      stop_crash_loop)
        log "STOP_CRASH_LOOP: $DECIDE_REASON"
        stop_child "stop_crash_loop"
        wait "$CHILD_PID"; EXIT_CODE=$?
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        exit 3
        ;;
      stop_budget)
        log "STOP_BUDGET: $DECIDE_REASON"
        stop_child "stop_budget"
        wait "$CHILD_PID"; EXIT_CODE=$?
        echo "$EXIT_CODE" > "$EXIT_MARKER"
        log "EXIT child-$CHILD_INDEX code=$EXIT_CODE ($STOP_PATH)"
        exit 4
        ;;
      restart)
        log "RESTART: $DECIDE_REASON"
        stop_child "restart"
        wait "$CHILD_PID"; EXIT_CODE=$?
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
  wait "$CHILD_PID"; EXIT_CODE=$?
  echo "$EXIT_CODE" > "$EXIT_MARKER"

  log "EXIT child-$CHILD_INDEX code=$EXIT_CODE (natural)"

  # Check for root_complete to decide whether to restart.
  ROOT_COMPLETE_TS=$(get_fact "$WORKDIR" "$PERSONA" "root_complete")
  if [ -n "$ROOT_COMPLETE_TS" ] && [ "$ROOT_COMPLETE_TS" -gt "$CHILD_START_TS" ]; then
    log "STOP_COMPLETE: root_complete at $ROOT_COMPLETE_TS > child start $CHILD_START_TS"
    exit 0
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

  # No prompt for subsequent children (D8: let the tick nudge).
  PROMPT=""
done
