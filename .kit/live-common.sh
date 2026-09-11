#!/usr/bin/env bash
# Shared live-test helpers. Sourced by every live suite.
# Requires: $OUT set to the stream-json output file before use.
# Sources bin/agentic-common.sh for wait_persona_free and emit_settings_json (Y7).

# Source the shared helper by a path relative to this file's directory, not the caller's cwd.
_LC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_AGENTIC_COMMON="$_LC_DIR/../bin/agentic-common.sh"
if [ -f "$_AGENTIC_COMMON" ]; then
  # shellcheck source=../bin/agentic-common.sh
  source "$_AGENTIC_COMMON"
else
  echo "live-common.sh: FATAL: cannot find bin/agentic-common.sh at $_AGENTIC_COMMON" >&2
  exit 1
fi

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

# V3: find the global commons store (same lookup as commons F15).
# Echoes the store path, or empty if not found.
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

# wait_persona_free is now in bin/agentic-common.sh (sourced above).

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

# Plan item 5 ("a proof child is stopped when its proof ends"): escalate
# EOF -> TERM -> KILL and verify death, mirroring bin/supervise.sh's own
# stop_child. A suite's cleanup trap on an early-exit path (an assertion
# failure, a killed suite) must not leave the claude coproc it launched
# still holding this persona's commons claim into the next proof - a second
# proof child that finds the first still holding "default" comes up as a
# reader and proves less than it seems to.
# Usage: stop_coproc_pid <pid> [write-fd] [grace-seconds, default 5]
stop_coproc_pid() {
  local pid="${1:-}" fd="${2:-}" grace="${3:-5}" n
  [ -z "$pid" ] && return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0  # already dead
  fi
  # Phase 1: EOF - close the write end so the child can finish its turn and exit 0.
  if [ -n "$fd" ]; then
    eval "exec $fd>&-" 2>/dev/null || true
  fi
  n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt "$grace" ]; do sleep 1; n=$((n+1)); done
  kill -0 "$pid" 2>/dev/null || return 0
  # Phase 2: TERM.
  kill -TERM "$pid" 2>/dev/null
  n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt "$grace" ]; do sleep 1; n=$((n+1)); done
  kill -0 "$pid" 2>/dev/null || return 0
  # Phase 3: KILL, then verify.
  kill -KILL "$pid" 2>/dev/null
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "stop_coproc_pid: WARNING pid $pid still alive after KILL" >&2
    return 1
  fi
  return 0
}
