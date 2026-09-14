#!/usr/bin/env bash
# bin/agentic-common.sh - Shared supervisor/test helpers.
# Sourced by bin/supervise.sh and .kit/live-common.sh.
# Provides: wait_persona_free, emit_settings_json, ensure_settings_plugin_ids,
#           valid_persona_name, find_global_store, poll_decisions, poll_heartbeat.
# All functions use W2 read-error semantics: a read error is a transient mid-write
# race, treated as "live" (or "not ready"), never an abort. The timeout is the only exit.

# --- Plugin ids ---
# The two ids pluginConfigs is keyed by: --plugin-dir load, and installed load.
AGENTIC_PLUGIN_DEV_ID="agentic-plugin"
AGENTIC_PLUGIN_INSTALLED_ID="agentic-plugin@agent-persona"

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
  local cost_opts=""
  if [ -n "${COST_SUMMARY_EVERY_N_TICKS:-}" ]; then
    cost_opts=",\"costSummaryEveryNTicks\":$COST_SUMMARY_EVERY_N_TICKS"
  fi
  if [ -n "${COST_MAX_NUDGES_PER_HOUR:-}" ]; then
    cost_opts="$cost_opts,\"costMaxNudgesPerHour\":$COST_MAX_NUDGES_PER_HOUR"
  fi
  if [ -n "${COST_MAX_PLUGIN_CALLS_PER_HOUR:-}" ]; then
    cost_opts="$cost_opts,\"costMaxPluginCallsPerHour\":$COST_MAX_PLUGIN_CALLS_PER_HOUR"
  fi
  if [ -n "${COST_BACKOFF_AFTER_TICKS:-}" ]; then
    cost_opts="$cost_opts,\"costBackoffAfterTicks\":$COST_BACKOFF_AFTER_TICKS"
  fi
  if [ -n "${COST_BACKOFF_MAX_MS:-}" ]; then
    cost_opts="$cost_opts,\"costBackoffMaxMs\":$COST_BACKOFF_MAX_MS"
  fi
  # Plan item 6: pass the persona the supervisor was given through to the
  # child, so it claims that persona at session.start instead of always
  # falling back to the plugin's hardcoded "default". $PERSONA is supervise.sh's
  # own second positional argument, visible here because this function is
  # sourced into the caller's shell rather than run in a subshell.
  # Every value below is spliced into JSON unescaped, so each is held to a
  # shape that cannot close a string or an object and that JSON accepts:
  # digits with no leading zero for the numbers, letters, digits, underscore
  # and hyphen for the persona.
  local var
  for var in TICK_MS NUDGE_IDLE_MS GIT_PROBE_MS NUDGE_FLOOR_MS HEARTBEAT_MS STALE_AFTER_MS \
    SELF_REVIEW_EVERY_TURNS CONTEXT_BUDGET_INFO_TOKENS CONTEXT_BUDGET_CLOSEOUT_TOKENS \
    CONTEXT_BUDGET_CRITICAL_TOKENS CONTEXT_BUDGET_READ_EVERY_N_TICKS COST_SUMMARY_EVERY_N_TICKS \
    COST_MAX_NUDGES_PER_HOUR COST_MAX_PLUGIN_CALLS_PER_HOUR COST_BACKOFF_AFTER_TICKS COST_BACKOFF_MAX_MS; do
    case "${!var:-0}" in
      ''|*[!0-9]*|0[0-9]*)
        echo "ERROR: emit_settings_json: $var '${!var}' is not a non-negative integer without leading zeros" >&2
        return 1
        ;;
    esac
  done
  if ! valid_persona_name "${PERSONA:-default}"; then
    echo "ERROR: emit_settings_json: PERSONA '$PERSONA' may hold only letters, digits, underscore and hyphen" >&2
    return 1
  fi
  local persona_opt=""
  if [ -n "${PERSONA:-}" ]; then
    persona_opt=",\"persona\":\"$PERSONA\""
  fi
  # pluginConfigs is keyed by plugin id: the manifest name under --plugin-dir,
  # and "<name>@<marketplace>" for the installed copy. The installed form is
  # absent from the engine's type file, and options under the other id are
  # ignored without an error, so the same options are written under both.
  # .kit/settings-plugin-key-test.sh pins both ids against the two manifests.
  local options="{\"controllerTickMs\":$TICK_MS,\"nudgeIdleMs\":$NUDGE_IDLE_MS,\"nudgeFloorMs\":${NUDGE_FLOOR_MS:-5000},\"gitProbeMs\":$GIT_PROBE_MS,\"heartbeatMs\":${HEARTBEAT_MS:-30000},\"staleAfterMs\":${STALE_AFTER_MS:-90000}$budget_opts$self_review_opts$cost_opts$persona_opt}"
  cat > "$out" <<EOF
{"pluginConfigs":{"$AGENTIC_PLUGIN_DEV_ID":{"options":$options},"$AGENTIC_PLUGIN_INSTALLED_ID":{"options":$options}}}
EOF
}

# --- ensure_settings_plugin_ids ---
# Usage: ensure_settings_plugin_ids <settings-file>
# For a settings file the caller already provided: where options sit under only
# one of the two plugin ids, copies them under the other, leaving every option
# as the caller wrote it. An id whose options object is missing or empty counts
# as absent. The file is replaced by rename, so an interrupted write never leaves
# it truncated. Returns 1 when the file is not valid JSON, when it, its
# pluginConfigs, an id entry or an options value is not a plain object, or when
# the write fails.
ensure_settings_plugin_ids() {
  node -e '
const fs = require("fs");
const [file, devId, installedId] = process.argv.slice(1);
const fail = (msg) => { console.error("ERROR: ensure_settings_plugin_ids: " + file + " " + msg); process.exit(1); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
let s;
try { s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (e) { fail("is not valid JSON: " + e.message); }
if (!plain(s)) fail("is not a JSON object");
if (s.pluginConfigs === undefined) process.exit(0);
const pc = s.pluginConfigs;
if (!plain(pc)) fail("has a pluginConfigs value that is not an object");
for (const id of [devId, installedId]) {
  if (pc[id] === undefined) continue;
  if (!plain(pc[id])) fail("has a " + id + " entry that is not an object");
  if (pc[id].options !== undefined && !plain(pc[id].options)) fail("has " + id + " options that are not an object");
}
const has = (id) => pc[id] !== undefined && plain(pc[id].options) && Object.keys(pc[id].options).length > 0;
let from, to;
if (has(devId) && !has(installedId)) { from = devId; to = installedId; }
else if (has(installedId) && !has(devId)) { from = installedId; to = devId; }
else process.exit(0);
pc[to] = Object.assign({}, pc[to], { options: Object.assign({}, pc[from].options) });
const tmp = file + ".tmp-" + process.pid;
try {
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
  fail("could not be rewritten: " + e.message);
}
' "$1" "$AGENTIC_PLUGIN_DEV_ID" "$AGENTIC_PLUGIN_INSTALLED_ID"
}

# --- valid_persona_name ---
# Usage: valid_persona_name <name>; returns 0 for a non-empty name of letters,
# digits, underscore and hyphen, 1 otherwise.
valid_persona_name() {
  case "$1" in
    ''|*[!A-Za-z0-9_-]*) return 1 ;;
  esac
  return 0
}

# --- find_global_store ---
# Plan item 6: the commons store's filename is load-mode-specific -
# "agentic-plugin_inline-<hash>.json" under --plugin-dir, and
# "agentic-plugin_<marketplace-name>-<hash>.json" for an installed plugin
# (confirmed live: "agentic-plugin_agent-persona-<hash>.json" for this
# repo's own marketplace). Once both load modes have ever run on one
# machine, both files can exist at once, and "take the first match"
# silently picks the wrong one for whichever mode this run is in. The
# caller's own dev_mode (whether --dev/--plugin-dir was given) says which
# glob is actually correct, so filter on it rather than guess.
# Single-sourced here for bin/supervise.sh, .kit/live-common.sh (and every
# live-*-test.sh through it), and any future caller - each used to carry
# its own copy, and a live-all.sh run caught the drift live: one caller's
# missing dev_mode filter resolved to the installed store while every
# child in the run used --plugin-dir, so the pre-gate read the wrong
# store's claims and let suites start inside each other's staleness window.
# Default is dev_mode=1: every .kit/*.sh caller runs under --plugin-dir,
# and bin/supervise.sh always passes its own DEV_MODE explicitly.
# Usage: find_global_store [dev_mode: 0|1, default 1]
find_global_store() {
  local dev_mode="${1:-1}"
  local f
  if [ -d "$HOME/.claude/plugins/store" ]; then
    if [ "$dev_mode" -eq 1 ]; then
      for f in "$HOME/.claude/plugins/store"/agentic-plugin_inline-*.json; do
        if [ -f "$f" ]; then
          echo "$f"
          return 0
        fi
      done
    else
      # Installed mode: any agentic-plugin_*.json that is NOT an inline
      # (dev-tree) store.
      for f in "$HOME/.claude/plugins/store"/agentic-plugin_*.json; do
        if [ -f "$f" ]; then
          case "$(basename "$f")" in
            agentic-plugin_inline-*) continue ;;
            *) echo "$f"; return 0 ;;
          esac
        fi
      done
    fi
  fi
  echo ""
  return 0
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

# --- refuse_if_persona_live ---
# Start-only refuse-at-start check, beside wait_persona_free's own wait.
# Reads every given store path once, with no polling, and refuses the moment
# any store holds a live persona: claim of any name (a commons: key whose
# lastSeen is within stale_after_ms, holding a claim whose resource starts
# with "persona:"). A store path that does not exist is skipped (installed
# mode may never have run on this machine). A store that exists and cannot
# be parsed is itself a refusal: a start-only check has no later poll to
# recover on, so it fails closed the same way a live claim does. The caller
# decides the exit code; this function only returns and prints, it never
# exits the shell.
# Usage: refuse_if_persona_live <stale_after_ms> <store-path>...
refuse_if_persona_live() {
  local stale_after_ms="$1"
  shift
  local store checked=0
  for store in "$@"; do
    [ -n "$store" ] || continue
    if [ ! -f "$store" ]; then
      echo "refuse-check: store not present, skipping: $store"
      continue
    fi
    local store_w line rc
    store_w=$(cygpath -m "$store" 2>/dev/null || echo "$store")
    line=$(node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log('ERROR: ' + e.message);
  process.exit(2);
}
const staleAfterMs = Number(process.argv[2]);
const keys = Object.keys(s).filter(k => k.startsWith('commons:'));
const now = Date.now();
for (const key of keys) {
  const e = s[key];
  if (e && e.lastSeen && (now - e.lastSeen) < staleAfterMs && Array.isArray(e.claims)) {
    for (const c of e.claims) {
      if (c && typeof c.resource === 'string' && c.resource.indexOf('persona:') === 0) {
        console.log('LIVE ' + c.resource + ' ' + Math.round((now - e.lastSeen) / 1000));
        process.exit(0);
      }
    }
  }
}
console.log('CLEAN');
" "$store_w" "$stale_after_ms")
    rc=$?
    if [ $rc -ne 0 ] || echo "$line" | grep -q '^ERROR'; then
      echo "refuse-check FAIL: store cannot be parsed: $store ($line)"
      return 1
    fi
    case "$line" in
      LIVE\ *)
        local resource age
        resource=$(echo "$line" | sed -n 's/^LIVE \([^ ]*\) .*/\1/p')
        age=$(echo "$line" | sed -n 's/^LIVE [^ ]* \(.*\)/\1/p')
        echo "refuse-check FAIL: live persona claim in $store: $resource (age ${age}s)"
        return 1
        ;;
    esac
    checked=$((checked + 1))
  done
  echo "refuse-check passed ($checked store(s) read, no live persona claim)"
  return 0
}

# --- wait_persona_free_both ---
# AD2: Wait for the persona to be free in BOTH the commons store AND the
# per-directory heartbeat. The commons check ensures no machine-global claim;
# the heartbeat check ensures the local holder is stale (lastSeen older than
# staleAfterMs) or absent.
# Usage: wait_persona_free_both <workdir> <persona> <timeout-seconds> <stale_after_ms> <global_store>
wait_persona_free_both() {
  local workdir="$1"
  local persona="${2:-default}"
  local timeout="${3:-120}"
  local stale_after_ms="${4:-90000}"
  local global_store="$5"
  local n=0
  local heartbeat_path="$workdir/.agentic-heartbeat.json"
  
  echo "pre-gate: waiting for persona '$persona' free in commons AND heartbeat (timeout: ${timeout}s)..."
  
  while true; do
    # Check 1: commons store (machine-global)
    local commons_ok=false
    if [ -n "$global_store" ] && [ -f "$global_store" ]; then
      local line live rc
      # The persona and the stale bound are passed as arguments rather than
      # spliced into the program text, so a value carrying JavaScript is data
      # the program reads instead of code it runs. A bound that is not a
      # number reads as NaN, which the program takes as no bound at all and
      # counts every claim as live, so the gate waits rather than passing on
      # a bad bound.
      line=$(node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log('ERROR: ' + e.message);
  process.exit(2);
}
const persona = process.argv[2];
const staleAfterMs = Number(process.argv[3]);
const bounded = !Number.isNaN(staleAfterMs);
const keys = Object.keys(s).filter(k => k.startsWith('commons:'));
const now = Date.now();
let live = 0;
for (const key of keys) {
  const e = s[key];
  if (e.lastSeen && (!bounded || (now - e.lastSeen) < staleAfterMs) && e.claims) {
    for (const c of e.claims) {
      if (c.resource === 'persona:' + persona) { live++; }
    }
  }
}
console.log('live=' + live);
" "$global_store" "$persona" "$stale_after_ms" 2>/dev/null)
      rc=$?
      if [ $rc -eq 0 ] && ! echo "$line" | grep -q '^ERROR'; then
        live=$(echo "$line" | sed -n 's/.*live=\([0-9]*\).*/\1/p')
        if [ "${live:-1}" = "0" ]; then
          commons_ok=true
        fi
      fi
    fi
    
    # Check 2: per-directory heartbeat
    local heartbeat_ok=false
    if [ ! -f "$heartbeat_path" ]; then
      heartbeat_ok=true
    else
      local hb_status
      # The persona and the stale bound are passed as arguments rather than
      # spliced into the program text, so a value carrying JavaScript is data
      # the program reads instead of code it runs. A bound that is not a
      # number reads as NaN, every comparison against it is false, and the
      # holder is treated as live, so the gate waits rather than passing on
      # a bad bound.
      hb_status=$(node -e "
const fs = require('fs');
let hb;
try {
  hb = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log('ERROR: ' + e.message);
  process.exit(2);
}
const staleAfterMs = Number(process.argv[2]);
const entry = hb[process.argv[3]];
if (!entry) {
  console.log('absent');
} else {
  const age = Date.now() - entry.lastSeen;
  console.log(age > staleAfterMs ? 'stale:' + Math.round(age / 1000) + 's' : 'live:' + Math.round(age / 1000) + 's');
}
" "$heartbeat_path" "$stale_after_ms" "$persona" 2>/dev/null)
      if echo "$hb_status" | grep -q '^stale\|^absent'; then
        heartbeat_ok=true
      fi
    fi
    
    # Log which conditions are satisfied
    local commons_msg="FAIL" heartbeat_msg="FAIL"
    $commons_ok && commons_msg="OK"
    $heartbeat_ok && heartbeat_msg="OK"
    echo "pre-gate poll: commons=$commons_msg heartbeat=$heartbeat_msg"
    
    if $commons_ok && $heartbeat_ok; then
      echo "pre-gate passed (commons and heartbeat both free)"
      return 0
    fi
    
    n=$((n + 5))
    [ $n -ge $timeout ] && { echo "pre-gate timeout after ${n}s (commons=$commons_msg heartbeat=$heartbeat_msg)"; return 1; }
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
