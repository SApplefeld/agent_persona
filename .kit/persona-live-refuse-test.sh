#!/usr/bin/env bash
# persona-live-refuse-test.sh - harness case for bin/agentic-common.sh's
# refuse_if_persona_live (Section 5, Contention guards). This is the
# start-only refuse check .kit/live-all.sh runs beside the .kit/RUNNING
# lock: no polling, refuse the moment any given store holds a live
# persona: claim.
#
# Driven with stub commons-store files this script writes with node,
# never a real claude child. Every case sources the real, current
# bin/agentic-common.sh; the OK/FAIL lines decide this suite's exit code.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REAL="$ROOT/bin/agentic-common.sh"

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NOW=$(node -e 'console.log(Date.now())')

# Writes a commons-store fixture with node: $1 = output path, $2 = a JS
# object-literal source (evaluated against a closure that defines `now`,
# so each fixture states its claims' ages relative to the real clock).
write_store() {
  NOW="$NOW" node -e '
const fs = require("fs");
const now = Number(process.env.NOW);
const obj = eval("(" + process.argv[2] + ")");
fs.writeFileSync(process.argv[1], JSON.stringify(obj));
' "$1" "$2"
}

STORE_A1="$TMP/a1.json"; write_store "$STORE_A1" '{"commons:s1":{lastSeen: now-1000, claims:[{resource:"persona:worker-x"}]}}'
STORE_A2="$TMP/a2.json"; write_store "$STORE_A2" '{"commons:s1":{lastSeen: now-1000, claims:[]}}'

STORE_B1="$TMP/b1.json"; write_store "$STORE_B1" '{"commons:s1":{lastSeen: now-200000, claims:[{resource:"persona:worker-x"}]}}'
STORE_B2="$TMP/b2.json"; write_store "$STORE_B2" '{"commons:s1":{lastSeen: now-200000, claims:[{resource:"persona:worker-y"}]},"commons:s2":{lastSeen: now-1000, claims:[{resource:"reader:dev"}]}}'

STORE_C1="$TMP/c1.json"; write_store "$STORE_C1" '{"commons:s1":{lastSeen: now-1000, claims:[]}}'
STORE_C2="$TMP/c2.json"; write_store "$STORE_C2" '{"commons:s1":{lastSeen: now-1000, claims:[{resource:"persona:worker-z"}]}}'

STORE_D1="$TMP/d1.json"; write_store "$STORE_D1" '{"commons:s1":{lastSeen: now-1000, claims:[]}}'
STORE_D2_MISSING="$TMP/d2-does-not-exist.json"

STORE_E="$TMP/e.json"
printf '%s' '{not json' > "$STORE_E"

STORE_H1_MISSING="$TMP/h1-does-not-exist.json"
STORE_H2_MISSING="$TMP/h2-does-not-exist.json"

STORE_I="$TMP/i.json"; write_store "$STORE_I" '{"commons:s1":{lastSeen: now-1000, claims:[]}}'

STORE_J_LIVE="$TMP/j-live.json"; write_store "$STORE_J_LIVE" '{"commons:s1":{lastSeen: "soon", claims:[{resource:"persona:worker-j"}]}}'
STORE_J_CTRL="$TMP/j-ctrl.json"; write_store "$STORE_J_CTRL" '{"commons:s1":{lastSeen: now-1000, claims:[]}}'

# (k) a stub plugin store directory: one inline store and three installed
# stores, so the discovery filter has both classes to tell apart.
STUB_HOME="$TMP/home"
STUB_STORE_DIR="$STUB_HOME/.claude/plugins/store"
mkdir -p "$STUB_STORE_DIR"
for name in agentic-plugin_inline-abc agentic-plugin_agent-persona-1 agentic-plugin_agent-persona-2 agentic-plugin_zzz-3; do
  write_store "$STUB_STORE_DIR/$name.json" '{"commons:s1":{lastSeen: now-1000, claims:[]}}'
done

# Runs every case once, reporting each result through the function named
# by $1 ("check", which counts toward this suite's exit).
run_cases() {
  local report="$1"

  OUT=$(refuse_if_persona_live 90000 "$STORE_A1" "$STORE_A2" 2>&1); RC=$?
  R=1
  if [ "$RC" -eq 1 ] && echo "$OUT" | grep -qF "$STORE_A1" && echo "$OUT" | grep -q 'persona:worker-x'; then R=0; fi
  "$report" "(a) a live claim in the first store, second store clean: returns 1 naming the store and resource" "$R"

  OUT=$(refuse_if_persona_live 90000 "$STORE_B1" "$STORE_B2" 2>&1); RC=$?
  R=1
  if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q 'refuse-check passed'; then R=0; fi
  "$report" "(b) control: only stale claims and one live non-persona claim: returns 0" "$R"

  OUT=$(refuse_if_persona_live 90000 "$STORE_C1" "$STORE_C2" 2>&1); RC=$?
  R=1
  if [ "$RC" -eq 1 ] && echo "$OUT" | grep -qF "$STORE_C2" && echo "$OUT" | grep -q 'persona:worker-z'; then R=0; fi
  "$report" "(c) the claim is live only in the second (installed-store leg) store: returns 1" "$R"

  OUT=$(refuse_if_persona_live 90000 "$STORE_D1" "$STORE_D2_MISSING" 2>&1); RC=$?
  R=1
  if [ "$RC" -eq 0 ] && echo "$OUT" | grep -qF "$STORE_D2_MISSING" && echo "$OUT" | grep -q 'passed'; then R=0; fi
  "$report" "(d) a missing second store path: skipped, returns 0 when the first is clean" "$R"

  T0=$(date +%s)
  OUT=$(refuse_if_persona_live 90000 "$STORE_E" 2>&1); RC=$?
  T1=$(date +%s); ELAPSED_E=$((T1 - T0))
  R=1
  if [ "$RC" -eq 1 ] && echo "$OUT" | grep -qF "$STORE_E" && echo "$OUT" | grep -q 'after 3 attempts'; then R=0; fi
  "$report" "(e) an unparsable store: fails after 3 attempts, naming the store" "$R"

  R=1
  [ "$RC" -eq 1 ] && [ "$ELAPSED_E" -lt 3 ] && R=0
  "$report" "(e) control: the three failed reads complete within 3 seconds, so the re-read carries no wait (elapsed ${ELAPSED_E}s)" "$R"

  OUT=$(refuse_if_persona_live 90000 "$STORE_H1_MISSING" "$STORE_H2_MISSING" 2>&1); RC=$?
  R=1
  if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q 'no store was read'; then R=0; fi
  "$report" "(h) zero readable stores (both paths missing): returns 1 naming the cause" "$R"

  OUT=$(refuse_if_persona_live abc "$STORE_I" 2>&1); RC=$?
  R=1
  if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q 'abc'; then R=0; fi
  "$report" "(i) a non-numeric stale bound: returns 1 naming the bound" "$R"

  OUT=$(refuse_if_persona_live 90000 "$STORE_J_LIVE" 2>&1); RC=$?
  R=1
  if [ "$RC" -eq 1 ] && echo "$OUT" | grep -q 'lastSeen is not a number'; then R=0; fi
  "$report" "(j) a live persona claim under a string lastSeen: fails closed, returns 1" "$R"

  OUT=$(refuse_if_persona_live 90000 "$STORE_J_CTRL" 2>&1); RC=$?
  R=1
  if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q 'refuse-check passed'; then R=0; fi
  "$report" "(j) control: the same store with a numeric lastSeen and no persona claim returns 0" "$R"

  LIST=$(HOME="$STUB_HOME" list_installed_stores 2>&1)
  R=1
  if [ "$(echo "$LIST" | grep -c .)" -eq 3 ] && ! echo "$LIST" | grep -q 'inline' && echo "$LIST" | grep -q 'zzz-3'; then R=0; fi
  "$report" "(k) list_installed_stores names every installed store and no inline store (3 of 4 files)" "$R"

  FIRST=$(HOME="$STUB_HOME" find_global_store 0)
  R=1
  if [ -n "$FIRST" ] && [ "$FIRST" = "$(echo "$LIST" | head -n 1)" ]; then R=0; fi
  "$report" "(k) control: find_global_store 0 returns the first store list_installed_stores names" "$R"
}

source "$REAL"
run_cases check

# --- (f) a fresh live claim refuses within 3 seconds, with no polling wait ---
# The fixture is written immediately before the timed call, with a freshly
# read clock, so the number of cases that ran earlier in this suite cannot
# push its age toward the stale bound.
STORE_F_LIVE="$TMP/f-live.json"
NOW_F=$(node -e 'console.log(Date.now())')
node -e '
const fs = require("fs");
const now = Number(process.argv[2]);
fs.writeFileSync(process.argv[1], JSON.stringify({"commons:s1":{lastSeen: now - 500, claims:[{resource:"persona:worker-f"}]}}));
' "$STORE_F_LIVE" "$NOW_F"
T0=$(date +%s)
refuse_if_persona_live 90000 "$STORE_F_LIVE" >/dev/null 2>&1
RC=$?
T1=$(date +%s)
ELAPSED=$((T1 - T0))
R=1
[ "$RC" -eq 1 ] && [ "$ELAPSED" -lt 3 ] && R=0
check "(f) a fresh live claim refuses within 3 seconds (elapsed ${ELAPSED}s, rc ${RC})" "$R"

if [ "$failed" -eq 0 ]; then
  echo "persona-live-refuse-test.sh: PASS"
  exit 0
fi
echo "persona-live-refuse-test.sh: FAIL"
exit 1
