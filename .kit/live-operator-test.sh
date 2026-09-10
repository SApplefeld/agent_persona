#!/usr/bin/env bash
# Live test: operator channel basic smoke test.
# Verifies that the owner can start, create a persona, and remain alive.
#
# The full operator channel test (message/reply, ask/answer, peer probe)
# requires a working reader and is timing-dependent. This smoke test
# verifies the basic owner setup works.
set -u

SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/operator}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Pre-gate: wait for persona:default to have no live claim ---
STORE_FILE=""
if [ -d "$HOME/.claude/plugins/store" ]; then
  for f in "$HOME/.claude/plugins/store"/agentic-plugin_*.json; do
    if [ -f "$f" ]; then STORE_FILE="$f"; break; fi
  done
fi
if [ -n "$STORE_FILE" ] && [ -f "$STORE_FILE" ]; then
  echo "pre-gate: waiting for persona:default to have no live claim..."
  for i in $(seq 1 24); do
    LIVE_COUNT=$(node -e "
      try {
        const s = JSON.parse(require('fs').readFileSync('$STORE_FILE','utf8'));
        const claims = s.claims || {};
        let live = 0;
        for (const [k,v] of Object.entries(claims)) {
          if (k.startsWith('persona:default') && Date.now() - v.at < 90000) live++;
        }
        console.log(live);
      } catch(e) { console.log(0); }
    " 2>/dev/null || echo 0)
    if [ "$LIVE_COUNT" -eq 0 ]; then
      echo "pre-gate passed (no live claims)"
      break
    fi
    echo "pre-gate poll: live=$LIVE_COUNT"
    if [ "$i" -eq 24 ]; then
      echo "pre-gate timeout after 120s, continuing anyway"
    fi
    sleep 5
  done
fi

# --- Setup ---
rm -rf "$SUITE_DIR" 2>/dev/null
mkdir -p "$SUITE_DIR"
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

OUT="$SUITE_DIR/operator-owner.out.jsonl"
ERR="$SUITE_DIR/operator-owner.err.log"
EXIT="$SUITE_DIR/operator.exit"
RUNNING="$SUITE_DIR/RUNNING"

trap 'rm -f "$RUNNING"' EXIT

rm -f "$OUT" "$ERR" "$EXIT"
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
unset CLAUDECODE

# --- Settings ---
export NUDGE_IDLE_MS=60000
export NUDGE_FLOOR_MS=120000
export TICK_MS=10000
export COST_MAX_NUDGES_PER_HOUR=1
export COST_SUMMARY_EVERY_N_TICKS=3
emit_settings_json "settings.json"

[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing"; exit 8; }
echo "DeepSeekHarness $0 $(date -u +%FT%TZ)" > "$RUNNING"

# --- Feed: owner (one message, then sleep infinity) ---
feed() {
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Create a goal: Wait for a signal from the user. The task is to respond to any operator messages. Do not finish."}}'
  sleep infinity
}

feed | claude -p --input-format stream-json --output-format stream-json --verbose \
  --plugin-dir "$(cygpath -w "$PLUGIN_DIR")" \
  --settings "$(cygpath -w "$SUITE_DIR/settings.json")" \
  --allowedTools "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__goal_done,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity,mcp__agentic-plugin__agentic_say,mcp__agentic-plugin__agentic_inbox" \
  --model haiku \
  > "$OUT" 2> "$ERR" &
CLAUDE_PID=$!
sleep 10

if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then
  echo "FAIL: claude died"
  exit 1
fi
echo "owner: alive (pid $CLAUDE_PID)"

# --- Wait for persona creation ---
STORE_BASH="$SUITE_DIR/.agentic-personas.json"
STORE_WIN="$(cygpath -w "$STORE_BASH")"
PERSONA_FOUND=0
for i in $(seq 1 30); do
  if [ -f "$STORE_BASH" ]; then
    FOUND=$(node -e "
      const path = process.argv[1];
      try {
        const s = JSON.parse(require('fs').readFileSync(path, 'utf8'));
        const d = (s.default && s.default.decisions) || [];
        const found = d.find(x => x.action === 'persona_claim_commons' || x.action === 'persona_create');
        console.log(found ? 'yes' : 'no');
      } catch(e) { console.log('no'); }
    " "$STORE_WIN" 2>/dev/null || echo "no")
    if [ "$FOUND" = "yes" ]; then
      PERSONA_FOUND=1
      break
    fi
  fi
  sleep 2
done

if [ "$PERSONA_FOUND" -eq 1 ]; then
  echo "persona: created"
else
  echo "FAIL: persona not created after 60s"
  kill "$CLAUDE_PID" 2>/dev/null
  exit 1
fi

# --- Kill owner (best effort, don't block on wait) ---
kill "$CLAUDE_PID" 2>/dev/null || true
sleep 2
EXIT_CODE=0
echo $EXIT_CODE > "$EXIT"

# --- Evidence retention ---
RETAIN="$PLUGIN_DIR/.kit/runs/$(date -u +%Y%m%dT%H%M%SZ)/operator"
mkdir -p "$RETAIN"
cp "$OUT" "$RETAIN/" 2>/dev/null || true
cp "$ERR" "$RETAIN/" 2>/dev/null || true
cp "$STORE_BASH" "$RETAIN/" 2>/dev/null || true
echo "evidence: retained at $RETAIN"

echo "=== OPERATOR SMOKE TEST COMPLETE ==="
echo "owner: started, persona created, alive"
exit 0
