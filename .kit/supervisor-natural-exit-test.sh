#!/usr/bin/env bash
# supervisor-natural-exit-test.sh - harness case for bin/supervise.sh's
# natural-exit path: what the supervisor does after a child exits on its own
# rather than through a decide-unit stop. This is the coverage for the
# backfilled root_complete branch of that path.
#
# The real bin/supervise.sh is driven with no real claude: an isolated HOME
# holding an empty installed-mode commons store (so the pre-launch gate
# passes), a stub `claude` first on PATH, and a temp workdir and rundir per
# case. The stub reads a per-case plan, one action per launch, and each plan
# ends the supervisor on its own: a shutdown_requested decision, or the crash
# limit set to 1.
#
# Cases (a), (b) and (e) launch with --prompt. The supervisor then waits for the
# priming turn's result line, and a child that exits without writing one is
# seen dead before the poll loop starts, so the exit is handled by the
# natural-exit path and never by a decide-unit read of the same store.
#
# Static pins, read from the files rather than restated here:
# - the substring get_root_complete tests for is inside the backstop's
#   root_complete detail in hooks/index.ts and absent from every other
#   root_complete detail there;
# - .kit/live-stopprocesstree-test.sh assigns the variable stop_child reads
#   the child's pid from.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SUP="$ROOT/bin/supervise.sh"
HOOKS="$ROOT/hooks/index.ts"
PERSONA_NAME="natexit"

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- Pin: the backfill literal, writer against reader ---
# get_root_complete's node script is the one place bin/supervise.sh tests a
# decision's detail with includes(); more than one match fails the pin below.
READER_SUBSTR=$(sed -n "s/.*newest\.detail\.includes('\([^']*\)').*/\1/p" "$SUP")
# Each root_complete detail literal in the hooks, tagged by whether its
# decision is timestamped backfillNow, which only the backstop uses.
DETAILS=$(awk '
  /timestamp:/ { ts = $0 }
  /action: "root_complete",/ { want = 1; next }
  want && /detail: `/ {
    s = $0; sub(/^[^`]*`/, "", s); sub(/`.*$/, "", s)
    print ((ts ~ /timestamp: backfillNow,/) ? "BACKSTOP\t" : "OTHER\t") s
    want = 0
  }' "$HOOKS")
BACKSTOP_DETAIL=$(printf '%s\n' "$DETAILS" | sed -n 's/^BACKSTOP\t//p')
OTHER_DETAILS=$(printf '%s\n' "$DETAILS" | sed -n 's/^OTHER\t//p')

[ -n "$READER_SUBSTR" ] && [ "$(printf '%s\n' "$READER_SUBSTR" | wc -l)" -eq 1 ]
check "pin: exactly one backfill substring test is found in bin/supervise.sh ('$READER_SUBSTR')" "$?"
[ -n "$BACKSTOP_DETAIL" ] && [ "$(printf '%s\n' "$BACKSTOP_DETAIL" | wc -l)" -eq 1 ]
check "pin: exactly one backstop root_complete detail is found in hooks/index.ts ('$BACKSTOP_DETAIL')" "$?"
[ -n "$OTHER_DETAILS" ]; check "pin: a non-backstop root_complete detail is found in hooks/index.ts" "$?"
# The awk above pairs each root_complete decision with the detail line that
# follows it. Comparing the pair count against the number of root_complete
# decisions in the file is what catches a decision written in a shape the awk
# skips, which would otherwise leave its detail out of the check below in
# silence.
ROOT_COMPLETE_WRITES=$(grep -c 'action: "root_complete",' "$HOOKS")
DETAIL_COUNT=$(printf '%s\n' "$DETAILS" | grep -c .)
[ "$ROOT_COMPLETE_WRITES" -gt 0 ] && [ "$DETAIL_COUNT" -eq "$ROOT_COMPLETE_WRITES" ]
check "pin: every root_complete decision in hooks/index.ts yielded a detail (${DETAIL_COUNT}/${ROOT_COMPLETE_WRITES})" "$?"
if [ -n "$READER_SUBSTR" ] && [ -n "$BACKSTOP_DETAIL" ]; then
  case "$BACKSTOP_DETAIL" in *"$READER_SUBSTR"*) R=0 ;; *) R=1 ;; esac
else
  R=1
fi
check "pin: the reader's substring is inside the backstop's detail" "$R"
R=1
if [ -n "$READER_SUBSTR" ] && [ -n "$OTHER_DETAILS" ]; then
  R=0
  while IFS= read -r d; do
    case "$d" in *"$READER_SUBSTR"*) R=1 ;; esac
  done <<< "$OTHER_DETAILS"
fi
check "pin: no other root_complete detail carries the reader's substring, so a real completion never reads as backfilled" "$R"

# --- Pin: the stop-path test sets the pid variable stop_child reads ---
PID_VAR=$(sed -n '/^stop_child() {/,/^}$/s/^  local pid="\${\([A-Z_]*\):-}"$/\1/p' "$SUP")
[ -n "$PID_VAR" ] && grep -q "^${PID_VAR}=\\\$!" "$ROOT/.kit/live-stopprocesstree-test.sh"
check "pin: live-stopprocesstree-test.sh assigns stop_child's pid variable (${PID_VAR:-not found})" "$?"

# --- The stub child ---
# ${...} placeholders in the extracted literals become a fixed root id.
STUB="$TMP/stub"
mkdir -p "$STUB" "$TMP/home/.claude/plugins/store"
printf '{}' > "$TMP/home/.claude/plugins/store/agentic-plugin_agent-persona-natexit.json"
printf '%s' "${BACKSTOP_DETAIL:-}" | sed 's/\${[^}]*}/root-r1/g' > "$STUB/detail-backfilled"
printf '%s\n' "${OTHER_DETAILS:-}" | head -n 1 | tr -d '\n' | sed 's/\${[^}]*}/root-r1/g' > "$STUB/detail-real"
cat > "$STUB/claude" <<EOF
#!/usr/bin/env bash
# Reads its action for this launch from the current case's plan, one line per
# launch, and records the launch before acting on it.
S="$STUB"
CASE_DIR=\$(cat "\$S/case")
n=\$(( \$(wc -l < "\$CASE_DIR/launches" 2>/dev/null || echo 0) + 1 ))
echo "\$n" >> "\$CASE_DIR/launches"
action=\$(sed -n "\${n}p" "\$CASE_DIR/plan")
record() {  # <decision action> <detail file, or empty>
  node -e '
const fs = require("fs");
const [act, detailFile, persona] = process.argv.slice(1);
const f = ".agentic-personas.json";
let s = {};
try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
s[persona] = s[persona] || { decisions: [] };
const detail = detailFile ? fs.readFileSync(detailFile, "utf8") : "stub";
s[persona].decisions.push({ timestamp: Date.now(), loop: "goal", action: act, detail });
fs.writeFileSync(f, JSON.stringify(s));
' "\$1" "\$2" "$PERSONA_NAME"
}
case "\$action" in
  startup) exit 1 ;;
  crash7) IFS= read -r _; sleep 3; exit 7 ;;
  backfilled) IFS= read -r _; record root_complete "\$S/detail-backfilled"; exit 0 ;;
  backfilled7) IFS= read -r _; record root_complete "\$S/detail-backfilled"; exit 7 ;;
  real) IFS= read -r _; record root_complete "\$S/detail-real"; exit 0 ;;
  shutdown) IFS= read -r _; record shutdown_requested ""; exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$STUB/claude"

# Usage: drive <case> <plan actions, comma-separated> <restart budget> [extra supervise.sh args...]
# Runs the supervisor to its own exit (bounded at 120s) and sets RC, LOG, OUT.
# The crash limit is always 1. The restart budget is per case, because the
# natural-exit path checks the budget before the crash limit.
drive() {
  local name="$1" plan="$2" budget="$3"; shift 3
  local dir="$TMP/$name"
  mkdir -p "$dir/wd" "$dir/rd"
  printf '%s\n' "$plan" | tr ',' '\n' > "$dir/plan"
  printf '%s' "$dir" > "$STUB/case"
  OUT=$(env -i PATH="$STUB:$PATH" HOME="$TMP/home" \
    supervisorPollMs=5000 supervisorCrashLimit=1 supervisorMaxRestartsPerHour="$budget" \
    timeout 120 bash "$SUP" "$dir/wd" "$PERSONA_NAME" default --rundir "$dir/rd" --no-channel "$@" 2>&1)
  RC=$?
  LOG="$dir/rd/supervisor.log"
  [ -f "$LOG" ] || : > "$LOG"
  LAUNCHES=$(wc -l < "$dir/launches" 2>/dev/null || echo 0)
}
# Shared absence checks: the supervisor never died on the child's pid.
no_pid_abort() {  # <label>
  case "$OUT" in
    *"unbound variable"*|*"not set after coproc launch"*) check "$1: no pid-variable abort (out: $(printf '%s' "$OUT" | grep -m1 -e 'unbound variable' -e 'not set after'))" 1 ;;
    *) check "$1: no pid-variable abort" 0 ;;
  esac
}

# --- (a) backfilled root_complete, exit 0: relaunched unaccounted ---
# supervisorMaxRestartsPerHour=1 makes an accounted relaunch end the run with
# STOP_BUDGET, so its absence shows the relaunch was not counted.
drive a "backfilled,shutdown" 1 --prompt "stub goal"
no_pid_abort "(a)"
[ "$RC" -eq 0 ]; check "(a) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(a) child-1's exit is handled by the natural-exit path with code 0" "$?"
grep -q "NOTE: root_complete at [0-9]* > child start [0-9]* is backfilled" "$LOG"; check "(a) the NOTE line names the backfilled root" "$?"
grep -q 'LAUNCH child-2' "$LOG" && [ "$LAUNCHES" -eq 2 ]; check "(a) a second child launches (stub launches=$LAUNCHES)" "$?"
! grep -q 'RESTART_PASSIVE:' "$LOG"; check "(a) no 'RESTART_PASSIVE:' line anywhere in supervisor.log" "$?"
! grep -q -e 'STOP_BUDGET' -e 'STOP_CRASH_LOOP' "$LOG"; check "(a) no STOP_BUDGET or STOP_CRASH_LOOP line, so the relaunch was not accounted" "$?"

# --- (b) control: a real root_complete, exit 0, takes RESTART_PASSIVE ---
drive b "real,shutdown" 1 --prompt "stub goal"
no_pid_abort "(b)"
[ "$RC" -eq 0 ]; check "(b) supervisor exits 0 on the second child's shutdown_requested (rc=$RC)" "$?"
grep -q 'EXIT child-1 code=0 (natural)' "$LOG"; check "(b) child-1's exit is handled by the natural-exit path with code 0" "$?"
grep -q 'RESTART_PASSIVE: root_complete at [0-9]* > child start [0-9]* (no shutdown requested)' "$LOG"; check "(b) the natural-exit RESTART_PASSIVE line is present" "$?"
! grep -q 'is backfilled' "$LOG"; check "(b) no backfilled NOTE line" "$?"
grep -q 'LAUNCH child-2' "$LOG"; check "(b) a second child launches" "$?"

# --- (c) a child exiting 7 during the poll loop: recorded and counted ---
# supervisorCrashLimit=1, so one counted crash ends the run with exit 3.
drive c "crash7,shutdown" 6
no_pid_abort "(c)"
[ "$RC" -eq 3 ]; check "(c) supervisor exits 3 on the crash limit (rc=$RC)" "$?"
grep -q 'EXIT child-1 code=7 (natural)' "$LOG"; check "(c) child-1 is recorded as code=7, natural" "$?"
grep -q 'STOP_CRASH_LOOP: 1 crashes' "$LOG"; check "(c) the exit counts toward the crash limit" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(c) no second child launches (stub launches=$LAUNCHES)" "$?"

# --- (d) a child that dies at startup ---
drive d "startup,shutdown" 6
no_pid_abort "(d)"
grep -q 'EXIT child-1 code=1 (natural)' "$LOG"; check "(d) child-1 is recorded as code=1, natural" "$?"
[ "$RC" -eq 3 ] && grep -q 'STOP_CRASH_LOOP: 1 crashes' "$LOG"; check "(d) the startup death counts toward the crash limit (rc=$RC)" "$?"

# --- (e) a backfilled root_complete with a non-zero exit takes the crash path ---
# The unaccounted relaunch in (a) is gated on both the backfilled flag and a
# clean exit. This case holds the flag and flips the exit code, so it shows the
# second half of that gate: the run is accounted as a crash, and the NOTE line
# (a) asserts is absent here.
drive e "backfilled7" 6 --prompt "stub goal"
no_pid_abort "(e)"
grep -q 'EXIT child-1 code=7 (natural)' "$LOG"; check "(e) child-1 is recorded as code=7, natural" "$?"
! grep -q 'is backfilled' "$LOG"; check "(e) no backfilled NOTE line, so the unaccounted relaunch was not taken" "$?"
! grep -q 'RESTART_PASSIVE:' "$LOG"; check "(e) no 'RESTART_PASSIVE:' line" "$?"
[ "$RC" -eq 3 ] && grep -q 'STOP_CRASH_LOOP: 1 crashes' "$LOG"; check "(e) the exit is counted as a crash and ends the run (rc=$RC)" "$?"
[ "$LAUNCHES" -eq 1 ]; check "(e) no second child launches (stub launches=$LAUNCHES)" "$?"

if [ "$failed" -eq 0 ]; then
  echo "supervisor-natural-exit-test.sh: PASS"
  exit 0
fi
echo "supervisor-natural-exit-test.sh: FAIL"
exit 1
