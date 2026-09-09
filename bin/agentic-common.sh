#!/usr/bin/env bash
# bin/agentic-common.sh - Shared supervisor/test helpers.
# Sourced by bin/supervise.sh and .kit/live-common.sh.
# Provides: wait_persona_free, emit_settings_json, poll_decisions, poll_heartbeat.
# All functions use W2 read-error semantics: a read error is a transient mid-write
# race, treated as "live" (or "not ready"), never an abort. The timeout is the only exit.

# --- Profiles ---
# Selected by PROFILE=full|short (default: short).
# full: TICK_MS=30000, NUDGE_IDLE_MS=120000, GIT_PROBE_MS=120000
# short: TICK_MS=10000, NUDGE_IDLE_MS=45000, GIT_PROBE_MS=30000
PROFILE="${PROFILE:-short}"
case "$PROFILE" in
  full)
    TICK_MS=30000
    NUDGE_IDLE_MS=120000
    GIT_PROBE_MS=120000
    ;;
  short)
    TICK_MS=10000
    NUDGE_IDLE_MS=45000
    GIT_PROBE_MS=30000
    ;;
  *)
    echo "Unknown PROFILE: $PROFILE (use full or short)" >&2
    exit 1
    ;;
esac

# --- emit_settings_json ---
# Usage: emit_settings_json <output-file>
# Emits the settings.json JSON for the --settings flag.
# Carries: controllerTickMs, nudgeIdleMs, nudgeFloorMs, gitProbeMs, heartbeatMs,
#          staleAfterMs, contextBudgetEnabled, and budget thresholds when set.
emit_settings_json() {
  local out="$1"
  local self_review_opts=""
  if [ -n "${SELF_REVIEW_EVERY_TURNS:-}" ]; then
    self_review_opts=",\"selfReviewEveryTurns\":$SELF_REVIEW_EVERY_TURNS"
  fi
  local budget_opts=""
  if [ -n "${CONTEXT_BUDGET_INFO_TOKENS:-}" ]; then
    budget_opts=",\"contextBudgetEnabled\":true"
    budget_opts="$budget_opts,\"contextBudgetInfoTokens\":$CONTEXT_BUDGET_INFO_TOKENS"
  fi
  if [ -n "${CONTEXT_BUDGET_CLOSEOUT_TOKENS:-}" ]; then
    budget_opts="$budget_opts,\"contextBudgetCloseoutTokens\":$CONTEXT_BUDGET_CLOSEOUT_TOKENS"
  fi
  if [ -n "${CONTEXT_BUDGET_CRITICAL_TOKENS:-}" ]; then
    budget_opts="$budget_opts,\"contextBudgetCriticalTokens\":$CONTEXT_BUDGET_CRITICAL_TOKENS"
  fi
  if [ -n "${CONTEXT_BUDGET_READ_EVERY_N_TICKS:-}" ]; then
    budget_opts="$budget_opts,\"contextBudgetReadEveryNTicks\":$CONTEXT_BUDGET_READ_EVERY_N_TICKS"
  fi
  cat > "$out" <<EOF
{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":$TICK_MS,"nudgeIdleMs":$NUDGE_IDLE_MS,"nudgeFloorMs":${NUDGE_FLOOR_MS:-5000},"gitProbeMs":$GIT_PROBE_MS,"heartbeatMs":${HEARTBEAT_MS:-30000},"staleAfterMs":${STALE_AFTER_MS:-90000}$budget_opts$self_review_opts}}}}
EOF
}

# --- wait_persona_free ---
# T9/V3: pre-gate - wait until no live persona claim exists in the commons store.
# Fails closed on a read error (V3). Prints live=/oldest_age= per poll (V3).
# W2: a read error is a transient mid-write race, not an abort.
# Usage: wait_persona_free <store-path> [timeout-seconds]
wait_persona_free() {
  local store="${1:-.agentic-personas.json}"
  local timeout="${2:-120}"
  local n=0
  local store_w
  store_w=$(cygpath -m "$store" 2>/dev/null || echo "$store")
  [ -f "$store" ] || { echo "pre-gate FAIL: store not found: $store" >&2; return 1; }
  echo "pre-gate: waiting for no live persona claim (store: $store, timeout: ${timeout}s)..."
  while true; do
    local line live rc
    line=$(node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log('ERROR: ' + e.message);
  process.exit(2);
}
const keys = Object.keys(s).filter(k => k.startsWith('commons:'));
const now = Date.now();
const stale = 90000;
let live = 0, oldest = 0;
for (const key of keys) {
  const e = s[key];
  if (e.lastSeen && (now - e.lastSeen) < stale && e.claims) {
    for (const c of e.claims) {
      if (c.resource === 'persona:default') { live++; if (oldest === 0 || e.lastSeen < oldest) oldest = e.lastSeen; }
    }
  }
}
console.log('live=' + live + ' oldest_age=' + (oldest ? Math.round((now - oldest) / 1000) : 0) + 's');
" "$store_w")
    rc=$?
    if [ $rc -ne 0 ] || echo "$line" | grep -q '^ERROR'; then
      # W2: a read error is a transient mid-write race, not an abort.
      # Treat as live=1 for this poll and let the timeout be the only exit.
      echo "pre-gate poll: ERROR (transient read error, retrying): $line"
      n=$((n + 5))
      [ $n -ge $timeout ] && { echo "pre-gate timeout after ${n}s (last: $line)"; return 1; }
      sleep 5
      continue
    fi
    live=$(echo "$line" | sed -n 's/.*live=\([0-9]*\).*/\1/p')
    echo "pre-gate poll: $line"
    if [ "${live:-0}" = "0" ]; then
      echo "pre-gate passed (no live claims)"
      return 0
    fi
    n=$((n + 5))
    [ $n -ge $timeout ] && { echo "pre-gate timeout after ${n}s ($line)"; return 1; }
    sleep 5
  done
}

# --- poll_decisions ---
# Read the decision log from .agentic-personas.json for a given persona key.
# W2: a read error returns "ERROR" and no decisions (treat as not-ready).
# Usage: poll_decisions <store-path> [persona-key]
# Prints JSON: {"decisions":[...], "error": null|"msg"}
poll_decisions() {
  local store="${1:-.agentic-personas.json}"
  local persona="${2:-default}"
  local store_w
  store_w=$(cygpath -m "$store" 2>/dev/null || echo "$store")
  node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log(JSON.stringify({decisions: [], error: e.message}));
  process.exit(0);
}
const key = process.argv[2];
const p = s[key];
if (!p) {
  console.log(JSON.stringify({decisions: [], error: 'persona not found'}));
  process.exit(0);
}
console.log(JSON.stringify({decisions: p.decisions || [], error: null}));
" "$store_w" "$persona"
}

# --- poll_heartbeat ---
# Read the heartbeat sidecar (.agentic-heartbeat.json) for a given persona key.
# W2: a read error returns "ERROR" (treat as not-ready).
# Usage: poll_heartbeat <heartbeat-path> [persona-key]
# Prints JSON: {"sessionId": "...", "epoch": N, "lastSeen": N, "error": null|"msg"}
poll_heartbeat() {
  local hb_path="${1:-.agentic-heartbeat.json}"
  local persona="${2:-default}"
  local hb_w
  hb_w=$(cygpath -m "$hb_path" 2>/dev/null || echo "$hb_path")
  node -e "
const fs = require('fs');
let hb;
try {
  hb = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log(JSON.stringify({sessionId: null, epoch: 0, lastSeen: null, error: e.message}));
  process.exit(0);
}
const key = process.argv[2];
const e = hb[key];
if (!e) {
  console.log(JSON.stringify({sessionId: null, epoch: 0, lastSeen: null, error: 'persona not in heartbeat'}));
  process.exit(0);
}
console.log(JSON.stringify({sessionId: e.sessionId, epoch: e.epoch, lastSeen: e.lastSeen, error: null}));
" "$hb_w" "$persona"
}
