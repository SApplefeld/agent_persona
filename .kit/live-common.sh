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
  cat > "$out" <<EOF
{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":$TICK_MS,"nudgeIdleMs":$NUDGE_IDLE_MS,"gitProbeMs":$GIT_PROBE_MS}}}}
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
