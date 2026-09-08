#!/usr/bin/env bash
# Shared live-test helpers. Sourced by every live suite.
# Requires: $OUT set to the stream-json output file before use.

# --- Profiles (J2) ---
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
    # Note: exit 1 inside a sourced file terminates the sourcing script.
    # This is the intended behavior: a bad profile is a fatal error.
    exit 1
    ;;
esac

# Emit the settings.json JSON for the suite's --settings flag.
# Usage: emit_settings_json <output-file>
emit_settings_json() {
  local out="$1"
  local self_review_opts=""
  if [ -n "${SELF_REVIEW_EVERY_TURNS:-}" ]; then
    self_review_opts=",\"selfReviewEveryTurns\":$SELF_REVIEW_EVERY_TURNS"
  fi
  cat > "$out" <<EOF
{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":$TICK_MS,"nudgeIdleMs":$NUDGE_IDLE_MS,"gitProbeMs":$GIT_PROBE_MS$self_review_opts}}}}
EOF
}

# --- Helpers ---

wait_turn() {  # $1 = number of result lines to wait for
  local n=0
  local count
  until [ "${count:-0}" -ge "$1" ]; do
    count=$(grep -c '"type":"result"' "$OUT" 2>/dev/null || true)
    count="${count:-0}"
    sleep 2; n=$((n+2)); [ $n -ge 180 ] && return 1
  done
  sleep 3
}

wait_activation() {  # wait for "activated" to appear in the store
  local n=0
  local store=".agentic-personas.json"
  until grep -q '"activated"' "$store" 2>/dev/null; do
    sleep 2; n=$((n+2)); [ $n -ge 90 ] && return 1
  done
}

count_turn_starts() {  # $1 = store path; returns count of turn_start decisions
  local store="${1:-.agentic-personas.json}"
  node -e "
    const s = JSON.parse(require('fs').readFileSync('$store','utf8'));
    const p = Object.keys(s)[0];
    const d = (s[p].decisions||[]).filter(x => x.action === 'turn_start');
    console.log(d.length);
  " 2>/dev/null || echo 0
}

# T9: pre-gate — wait until no live persona claim exists in the commons store.
# Mirrors the commons F13a gate (live-commons-test.sh:147-187).
# Usage: wait_persona_free <store-path> [timeout-seconds]
wait_persona_free() {
  local store="${1:-.agentic-personas.json}"
  local timeout="${2:-120}"
  local n=0
  local store_w
  store_w=$(cygpath -m "$store" 2>/dev/null || echo "$store")
  echo "T9: pre-gate: waiting for no live persona claim (store: $store, timeout: ${timeout}s)..."
  while true; do
    local live
    live=$(node -e "
const fs = require('fs');
try {
  const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const keys = Object.keys(s).filter(k => k.startsWith('commons:'));
  const now = Date.now();
  const stale = 90000;
  let live = 0;
  for (const key of keys) {
    const e = s[key];
    if (e.lastSeen && (now - e.lastSeen) < stale && e.claims) {
      for (const c of e.claims) {
        if (c.resource === 'persona:default') live++;
      }
    }
  }
  console.log(live);
} catch { console.log(0); }
" "$store_w" 2>/dev/null)
    if [ "${live:-0}" = "0" ]; then
      echo "T9: pre-gate passed (no live claims)"
      return 0
    fi
    n=$((n + 5))
    [ $n -ge $timeout ] && { echo "T9: pre-gate timeout after ${n}s (still $live live claims)"; return 1; }
    sleep 5
  done
}

# N1: wait for a specific fact to appear in memory (used by yield suite to gate Session B)
wait_for_fact() {  # $1 = fact text to wait for; $2 = store path (optional)
  local fact="$1"
  local store="${2:-.agentic-personas.json}"
  local n=0
  # Write the check script to a temp file to avoid shell quoting issues
  local script_file
  script_file=$(mktemp)
  cat > "$script_file" <<'NODE'
const fs = require('fs');
const fact = process.argv[2];
const store = process.argv[3];
if (!fs.existsSync(store)) process.exit(1);
const s = JSON.parse(fs.readFileSync(store,'utf8'));
const p = Object.keys(s)[0];
const m = (s[p].memory||[]);
const found = m.some(x => x.text === fact);
process.exit(found ? 0 : 1);
NODE
  until node "$script_file" "$fact" "$store" 2>/dev/null; do
    sleep 2; n=$((n+2)); [ $n -ge 180 ] && { rm -f "$script_file"; return 1; }
  done
  rm -f "$script_file"
}
