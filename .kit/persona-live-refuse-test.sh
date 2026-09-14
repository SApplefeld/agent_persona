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

  OUT=$(refuse_if_persona_live 90000 "$STORE_E" 2>&1); RC=$?
  R=1
  if [ "$RC" -eq 1 ] && echo "$OUT" | grep -qF "$STORE_E" && echo "$OUT" | grep -qi 'cannot be parsed'; then R=0; fi
  "$report" "(e) an unparsable store: returns 1 naming the store and the error" "$R"
}

source "$REAL"
run_cases check

# --- (f) immediately: no polling wait, and no sleep in the function body ---
T0=$(date +%s)
refuse_if_persona_live 90000 "$STORE_A1" "$STORE_A2" >/dev/null 2>&1
T1=$(date +%s)
ELAPSED=$((T1 - T0))
[ "$ELAPSED" -lt 5 ]; check "(f) case (a) completes in under 5 seconds (elapsed ${ELAPSED}s)" "$?"

# Static pin: the function's own line range, from its definition to the
# first line-leading close brace, carries no sleep. wait_persona_free is the
# control - the same extraction technique must find its poll-loop sleep, or
# this grep is not actually looking at function bodies at all.
# Extracts one function's own text by brace balance, since a naive
# "first line starting with }" stops at the closing brace of an embedded
# node -e script's JS object literal, not the bash function's own end.
extract_function() {  # $1 = function name, $2 = file
  awk -v head="$1() {" '
    index($0, head) == 1 { grab=1; depth=0 }
    grab {
      print
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (c == "{") depth++
        else if (c == "}") depth--
      }
      if (depth == 0) exit
    }
  ' "$2"
}
REFUSE_BODY=$(extract_function refuse_if_persona_live "$REAL")
WAIT_BODY=$(extract_function wait_persona_free "$REAL")
[ -n "$REFUSE_BODY" ] && ! echo "$REFUSE_BODY" | grep -q 'sleep'
check "(f) refuse_if_persona_live's own body contains no sleep" "$?"
[ -n "$WAIT_BODY" ] && echo "$WAIT_BODY" | grep -q 'sleep'
check "(f) control: the same extraction finds sleep in wait_persona_free's body" "$?"

if [ "$failed" -eq 0 ]; then
  echo "persona-live-refuse-test.sh: PASS"
  exit 0
fi
echo "persona-live-refuse-test.sh: FAIL"
exit 1
