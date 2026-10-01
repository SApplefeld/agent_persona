#!/usr/bin/env bash
# Live proof: the stdin interrupt ends a turn parked in the harness's
# rate-limit retry wait, and the conversation survives it.
#
# A local stub (.kit/live-interrupt-ratelimit-stub.mjs) answers every API
# request 429 with a four-hour reset, so a real `claude -p` child launched by
# the real bin/supervise.sh and held by the real bin/supervise-holder.sh parks
# in the harness's retry wait: its stream carries `system`/`api_retry` records
# with error_status 429 and a retry_delay_ms countdown. The child reaches the
# stub because bin/supervise.sh launches it through `env ... claude` with the
# supervisor's own environment, and this script exports ANTHROPIC_BASE_URL and
# a dummy ANTHROPIC_API_KEY before launching the supervisor. Nothing is spent.
#
# Two turns are interrupted, each while parked in its retry wait: the holder's
# priming turn, which has to end before the holder sends the goal, and the goal
# turn, whose prompt carries a codeword. Each interrupt is requested the way
# fleet_interrupt requests one, a single write of {at, by, reason} to
# <rundir>/interrupt.request. For each, the script reads the child's heartbeat
# during the wait, then times the request write, the supervisor's INTERRUPT:
# line, the holder's relay line and the child's result event. A case passes
# where the supervisor relays rather than skips and the result lands within 5
# seconds of the holder's relay. A follow-up prompt then goes in through the
# holder's ask path, and the request the child sends for it must carry the
# codeword in its message history, since the stub answers nothing.
#
# The holder's relay line, the result event and the api_retry records carry no
# timestamp of their own, so their times are when this script's 0.1-second
# watch first saw them, and the supervisor's line is timed the same way beside
# its own whole-second stamp.
#
# The child launches under this script's own real HOME (nothing here
# overrides it), so it loads the operator's own account settings the same way
# any other persona's child does. The evidence directory's stub log
# ($SUITE_DIR/stub-requests.jsonl) keeps every request body the child sent in
# full, decoded, which carries the whole system prompt and any memory records
# the harness injected into it.
#
# Exit 0 on pass, 1 on fail. The evidence stays under $SUITE_DIR. Not part of
# .kit/live-all.sh: this is a standing, repeatable proof, not a gate suite.
set -u

# --- Configuration ---
SUITE_DIR="${SUITE_DIR:-/d/Temp/agentic-live/interrupt-ratelimit}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELAY_TO_RESULT_MAX_MS=5000

# --- Setup ---
# The guard is read, and the lock claimed, before anything under $SUITE_DIR
# is touched: a second invocation while a run is live must refuse rather than
# clear that run's own files out from under it. Only once the lock is ours is
# the rest of the directory cleared, with the RUNNING file itself spared.
mkdir -p "$SUITE_DIR"
RUNNING="$SUITE_DIR/RUNNING"
[ -f "$RUNNING" ] && { echo "RUNNING exists, refusing: $RUNNING ($(head -1 "$RUNNING")). Remove it if no run is live."; exit 8; }
echo "live-interrupt-ratelimit $0 $(date -u +%FT%TZ)" > "$RUNNING"
find "$SUITE_DIR" -mindepth 1 -maxdepth 1 ! -name "$(basename "$RUNNING")" -exec rm -rf {} +
cd "$SUITE_DIR" || exit 9

source "$SCRIPT_DIR/live-common.sh"

WORKDIR="$SUITE_DIR/workdir"
mkdir -p "$WORKDIR"
SUPERVISE="$PLUGIN_DIR/bin/supervise.sh"
SUPERVISE_LOG="$SUITE_DIR/supervisor.log"
SUPERVISE_ERR="$SUITE_DIR/supervisor.err"
HEARTBEAT="$SUITE_DIR/heartbeat.json"
STUB_LOG="$SUITE_DIR/stub-requests.jsonl"
TIMES="$SUITE_DIR/times.txt"
ASSERT_LOG="$SUITE_DIR/interrupt-ratelimit.assert.log"
: > "$ASSERT_LOG"
: > "$TIMES"
FAIL_COUNT=0
pass() { echo "OK: $1" | tee -a "$ASSERT_LOG"; }
failed() { echo "FAIL: $1" | tee -a "$ASSERT_LOG"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
now_ms() { date +%s%3N; }
stamp() { date -u -d "@$(( $1 / 1000 )).$(printf '%03d' $(( $1 % 1000 )))" +%H:%M:%S.%3NZ; }
note_time() { echo "$1: $2 ($(stamp "$2"))" | tee -a "$TIMES"; }

PERSONA="interrupt-ratelimit-$$"
CODEWORD="KESTREL$(node -e 'console.log(require("crypto").randomBytes(4).toString("hex").toUpperCase())')"

# --- Process helpers ---
# Every process this proof starts descends from the supervisor or is the stub.
# The Windows parent chain does not reach `claude`: it runs under `env.exe`,
# whose Cygwin fork parent has exited, so the chain breaks there. The MSYS
# process table keeps that link, so the snapshot closes over the MSYS table
# from the supervisor first, as bin/supervise.sh's refresh_child_tree does,
# then walks the Windows table down from every Windows pid that closure names,
# which reaches `claude`'s own native children.
SCRIPT_START_MS=$(now_ms)

# Prints the Windows pid of every MSYS process in the closure under <msys pid>,
# the root included.
# Usage: msys_closure_winpids <msys pid>
msys_closure_winpids() {
  ps 2>/dev/null | awk -v root="$1" '
    NR > 1 {
      # Cygwin ps prints a state character ahead of the pid for a stopped or
      # orphaned process, shifting every column right by one.
      if ($1 ~ /^[0-9]+$/) { id = $1; pp = $2; wp = $4 }
      else if ($2 ~ /^[0-9]+$/) { id = $2; pp = $3; wp = $5 }
      else { next }
      parent[id] = pp
      if (wp ~ /^[0-9]+$/) winpid[id] = wp
    }
    END {
      keep[root] = 1
      do {
        added = 0
        for (id in parent) if (!(id in keep) && (parent[id] in keep)) { keep[id] = 1; added = 1 }
      } while (added)
      for (id in keep) if (id in winpid) print winpid[id]
    }'
}

# Each line is "<winpid> <creation ticks> <image>"; a child is taken only where
# it was created no earlier than its parent, so a reused parent pid adds nothing.
# Usage: ps_tree "<winpid> ..."
ps_tree() {
  ROOTS="$1" powershell.exe -NoProfile -NonInteractive -Command '
$roots = @($env:ROOTS -split "\s+" | Where-Object { $_ } | ForEach-Object { [int]$_ })
$all = @(Get-CimInstance Win32_Process)
$byId = @{}; $kids = @{}
foreach ($p in $all) {
  $byId[[int]$p.ProcessId] = $p
  $k = [int]$p.ParentProcessId
  if (-not $kids.ContainsKey($k)) { $kids[$k] = New-Object System.Collections.ArrayList }
  [void]$kids[$k].Add($p)
}
$seen = @{}; $queue = New-Object System.Collections.Queue
foreach ($r in $roots) { if ($byId.ContainsKey($r)) { $queue.Enqueue($byId[$r]) } }
while ($queue.Count -gt 0) {
  $p = $queue.Dequeue(); $id = [int]$p.ProcessId
  if ($seen.ContainsKey($id)) { continue }
  $seen[$id] = 1
  "{0} {1} {2}" -f $id, $p.CreationDate.Ticks, $p.Name
  if ($kids.ContainsKey($id)) { foreach ($c in $kids[$id]) { if ($c.CreationDate -ge $p.CreationDate) { $queue.Enqueue($c) } } }
}' 2>/dev/null | tr -d '\r'
}

# Prints the snapshot lines whose pid is still running with the same creation
# ticks, so a pid the OS has since reused never reads as a survivor.
# Usage: ps_alive "<snapshot lines>"
ps_alive() {
  SNAP="$1" powershell.exe -NoProfile -NonInteractive -Command '
$live = @{}
foreach ($p in @(Get-CimInstance Win32_Process)) { $live[[int]$p.ProcessId] = $p.CreationDate.Ticks }
foreach ($line in ($env:SNAP -split "`n")) {
  $f = $line.Trim() -split " "
  if ($f.Count -lt 3) { continue }
  if ($live.ContainsKey([int]$f[0]) -and [string]$live[[int]$f[0]] -eq $f[1]) { $line.Trim() }
}' 2>/dev/null | tr -d '\r'
}

# Prints "<winpid> <image>" for every process created since this script
# started whose command line names this run's directory, in its MSYS or
# Windows spelling. The pattern reaches PowerShell through the environment, so
# the poll never matches itself, and the creation bound keeps out the shell
# that launched this script, whose own command line may name the directory.
# Usage: ps_cmdline_match
ps_cmdline_match() {
  local win
  win=$(cygpath -m "$SUITE_DIR")
  SINCE_MS="$SCRIPT_START_MS" PAT_MSYS="$SUITE_DIR" PAT_WIN="$win" powershell.exe -NoProfile -NonInteractive -Command '
$a = $env:PAT_MSYS.ToLower(); $b = $env:PAT_WIN.ToLower(); $c = $b.Replace("/", "\")
$since = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$env:SINCE_MS).LocalDateTime
foreach ($p in @(Get-CimInstance Win32_Process)) {
  if ($p.ProcessId -eq $PID) { continue }
  if ($p.CreationDate -lt $since) { continue }
  $cl = [string]$p.CommandLine
  if (-not $cl) { continue }
  $l = $cl.ToLower()
  if ($l.Contains($a) -or $l.Contains($b) -or $l.Contains($c)) { "{0} {1}" -f $p.ProcessId, $p.Name }
}' 2>/dev/null | tr -d '\r'
}

winpid_of() { cat "/proc/$1/winpid" 2>/dev/null; }

# --- Snapshot and teardown ---
SUPERVISE_PID=""
SUPERVISE_WINPID=""
STUB_PID=""
STUB_WINPID=""
SNAPSHOT=""
# Adds this moment's tree to SNAPSHOT, so a process seen at any point is kept.
take_snapshot() {
  local roots s
  roots="$STUB_WINPID"
  if [ -n "$SUPERVISE_PID" ] && kill -0 "$SUPERVISE_PID" 2>/dev/null; then
    roots="$roots $(msys_closure_winpids "$SUPERVISE_PID" | tr '\n' ' ')"
  fi
  s=$(ps_tree "$roots")
  SNAPSHOT=$(printf '%s\n%s\n' "$SNAPSHOT" "$s" | awk 'NF' | sort -u)
}
# A TERM to the supervisor detaches from a live child rather than stopping it,
# and a child stopped first would be relaunched by the supervisor. So the tree
# is snapshotted while the supervisor still links it, the supervisor goes
# first, and then every snapshot process still running under the same
# creation ticks is killed by its own pid, the stub among them.
teardown() {
  local spid _rest
  if [ -n "${SUPERVISE_PID:-}" ] && kill -0 "$SUPERVISE_PID" 2>/dev/null; then
    take_snapshot
    kill -TERM "$SUPERVISE_PID" 2>/dev/null
    for _i in $(seq 1 60); do kill -0 "$SUPERVISE_PID" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$SUPERVISE_PID" 2>/dev/null && kill -KILL "$SUPERVISE_PID" 2>/dev/null
    wait "$SUPERVISE_PID" 2>/dev/null
  fi
  SUPERVISE_PID=""
  [ -n "$SNAPSHOT" ] || take_snapshot
  ps_alive "$SNAPSHOT" | while read -r spid _rest; do
    [ -n "$spid" ] && taskkill //PID "$spid" //F >/dev/null 2>&1
  done
  [ -n "${STUB_PID:-}" ] && kill -KILL "$STUB_PID" 2>/dev/null
  STUB_PID=""
}
cleanup() {
  teardown
  rm -f "$RUNNING"
}
trap cleanup EXIT

# --- Environment ---
# The child must look like a fleet child, not a child of whatever session runs
# this script, so the calling session's own identity variables are dropped.
# CLAUDE_CODE_RETRY_WATCHDOG is dropped with them: on this machine the user
# settings' env block sets it, which is where a fleet child gets it, and the
# proof relies on that source rather than an inherited copy.
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ATTENDED \
  CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN \
  CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_CODE_RETRY_WATCHDOG
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
# No controller nudge may queue a prompt behind a parked turn, since a queued
# prompt runs next after an interrupt and would take the goal's place.
export nudgeIdleMs=600000

# --- Stub ---
node "$SCRIPT_DIR/live-interrupt-ratelimit-stub.mjs" "$SUITE_DIR/stub.port" "$STUB_LOG" 14400 \
  > "$SUITE_DIR/stub.log" 2>&1 &
STUB_PID=$!
for _i in $(seq 1 100); do [ -s "$SUITE_DIR/stub.port" ] && break; sleep 0.1; done
if [ ! -s "$SUITE_DIR/stub.port" ]; then
  failed "S0 the stub is listening"
  echo "live-interrupt-ratelimit-test.sh: FAIL (stub did not start)"
  exit 1
fi
STUB_WINPID=$(winpid_of "$STUB_PID")
export ANTHROPIC_BASE_URL="http://127.0.0.1:$(cat "$SUITE_DIR/stub.port")"
export ANTHROPIC_API_KEY="sk-ant-stub-not-a-real-key"
echo "stub: $ANTHROPIC_BASE_URL (winpid $STUB_WINPID)"

# --- Supervisor ---
PROMPT="Remember this codeword for the rest of this conversation: $CODEWORD. Reply with one short sentence saying you have it."
bash "$SUPERVISE" "$WORKDIR" "$PERSONA" acceptEdits --dev --prompt "$PROMPT" --rundir "$SUITE_DIR" --no-channel \
  > "$SUITE_DIR/supervise.stdout.log" 2>&1 &
SUPERVISE_PID=$!
SUPERVISE_WINPID=$(winpid_of "$SUPERVISE_PID")
echo "supervisor: msys pid $SUPERVISE_PID, winpid $SUPERVISE_WINPID; persona $PERSONA; codeword $CODEWORD"

CHILD_INDEX=""
for _i in $(seq 1 120); do
  CHILD_INDEX=$(grep -o 'LAUNCH child-[0-9]*' "$SUPERVISE_LOG" 2>/dev/null | head -n 1 | grep -o '[0-9]*$')
  [ -n "$CHILD_INDEX" ] && break
  kill -0 "$SUPERVISE_PID" 2>/dev/null || break
  sleep 1
done
if [ -z "$CHILD_INDEX" ]; then
  failed "S1 the supervisor launched a child"
  echo "live-interrupt-ratelimit-test.sh: FAIL (no child launched)"
  exit 1
fi
CHILD_DIR="$SUITE_DIR/child-$CHILD_INDEX"
OUT="$CHILD_DIR/stdout.jsonl"
pass "S1 the supervisor launched child-$CHILD_INDEX"

# --- Stream readers ---
# Line numbers of the 429 api_retry records in the child's stream.
retry_lines() { grep -n '"subtype":"api_retry"' "$OUT" 2>/dev/null | grep '"error_status":429' | cut -d: -f1; }
result_count() { local n; n=$(grep -c '"type":"result"' "$OUT" 2>/dev/null) || true; echo "${n:-0}"; }
last_result_line() { grep -n '"type":"result"' "$OUT" 2>/dev/null | tail -n 1 | cut -d: -f1; }

# Waits for a 429 api_retry record past line <after>, up to <seconds>. Sets
# RETRY_SEEN_MS to when it was first seen and RETRY_RECORD to the record.
wait_retry_after() {
  local after="$1" seconds="$2" deadline ln
  RETRY_SEEN_MS=""; RETRY_RECORD=""
  deadline=$(( $(now_ms) + seconds * 1000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    for ln in $(retry_lines); do
      if [ "$ln" -gt "$after" ]; then
        RETRY_SEEN_MS=$(now_ms)
        RETRY_RECORD=$(sed -n "${ln}p" "$OUT")
        return 0
      fi
    done
    kill -0 "$SUPERVISE_PID" 2>/dev/null || return 1
    sleep 0.1
  done
  return 1
}

# The heartbeat's turnStartedAt, or "null".
heartbeat_turn_started() {
  node -e 'try{const h=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(h.turnStartedAt==null?"null":h.turnStartedAt)}catch(e){console.log("unreadable")}' "$HEARTBEAT"
}

# --- One interrupt case ---
# Usage: interrupt_case <label> <stream line the wait must follow> <previous turnStartedAt>
# Waits for the turn's retry wait, reads the heartbeat, writes the request as
# fleet_interrupt does, and times what follows. Sets HB_TURN_STARTED to the
# heartbeat's turnStartedAt read during the wait.
HB_TURN_STARTED=0
interrupt_case() {
  local label="$1" after="$2" prev_started="$3" hb_started="" request_at relay_base result_base sup_line="" relay_line=""
  local t_sup="" t_relay="" t_result="" t_hb="" deadline id subtype

  if ! wait_retry_after "$after" 180; then
    failed "$label the turn reached a 429 retry wait (no api_retry record seen)"
    return 1
  fi
  note_time "$label first api_retry seen" "$RETRY_SEEN_MS"
  echo "$label api_retry record: $RETRY_RECORD" | tee -a "$TIMES"
  pass "$label the turn is parked in a 429 retry wait"

  # The child publishes its heartbeat on a clock, every heartbeatMs (30 s by
  # default), so for up to one interval the file is absent or still names the
  # turn before this one. The stuck state this proof stands for has sat in its
  # wait far longer than that, so the request waits until the heartbeat names
  # this turn, as it would for any wait worth interrupting.
  deadline=$(( $(now_ms) + 90000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    hb_started=$(heartbeat_turn_started)
    case "$hb_started" in
      ''|null|unreadable|*[!0-9]*) ;;
      *) if [ "$hb_started" -gt "$prev_started" ]; then t_hb=$(now_ms); break; fi ;;
    esac
    sleep 0.5
  done
  [ -n "$t_hb" ] && note_time "$label heartbeat first names this turn" "$t_hb"
  HB_TURN_STARTED="$hb_started"
  # The child must still be parked: its newest stream record is a 429 retry.
  local newest
  newest=$(tail -n 1 "$OUT")
  case "$newest" in
    *'"subtype":"api_retry"'*'"error_status":429'*) pass "$label the child is still parked in its retry wait when the request is written" ;;
    *) failed "$label the child is still parked in its retry wait when the request is written (newest record: $(printf '%s' "$newest" | cut -c1-200))" ;;
  esac
  take_snapshot
  cp "$HEARTBEAT" "$SUITE_DIR/heartbeat-$label.json" 2>/dev/null
  echo "$label heartbeat during the wait: $(cat "$HEARTBEAT" 2>/dev/null)" | tee -a "$TIMES"

  relay_base=$(grep -c 'relayed an interrupt id=' "$SUPERVISE_ERR" 2>/dev/null) || true
  relay_base="${relay_base:-0}"
  result_base=$(result_count)
  local sup_base
  sup_base=$(grep -cE ' INTERRUPT(_SKIPPED|_FAILED)?: ' "$SUPERVISE_LOG" 2>/dev/null) || true
  sup_base="${sup_base:-0}"

  # One write of {at, by, reason}, the shape fleet_interrupt writes.
  request_at=$(node -e '
const fs = require("fs");
const at = Date.now();
fs.writeFileSync(process.argv[1], JSON.stringify({ at, by: "live-interrupt-proof", reason: process.argv[2] }));
console.log(at);
' "$SUITE_DIR/interrupt.request" "live proof: end the turn parked in its rate-limit wait ($label)")
  note_time "$label request written (at)" "$request_at"
  echo "$label heartbeat turnStartedAt: $hb_started (request at $request_at)" | tee -a "$TIMES"
  case "$hb_started" in
    ''|null|unreadable|*[!0-9]*) failed "$label the heartbeat shows a running turn during the wait (turnStartedAt $hb_started)" ;;
    *)
      if [ "$hb_started" -le "$request_at" ]; then
        pass "$label the heartbeat shows the parked turn running, started at or before the request ($hb_started <= $request_at)"
      else
        failed "$label the heartbeat's turnStartedAt $hb_started is after the request at $request_at"
      fi ;;
  esac

  deadline=$(( $(now_ms) + 60000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    if [ -z "$t_sup" ]; then
      sup_line=$(grep -E ' INTERRUPT(_SKIPPED|_FAILED)?: ' "$SUPERVISE_LOG" 2>/dev/null | sed -n "$((sup_base + 1))p")
      [ -n "$sup_line" ] && t_sup=$(now_ms)
    fi
    if [ -z "$t_relay" ]; then
      relay_line=$(grep 'relayed an interrupt id=' "$SUPERVISE_ERR" 2>/dev/null | sed -n "$((relay_base + 1))p")
      [ -n "$relay_line" ] && t_relay=$(now_ms)
    fi
    if [ -z "$t_result" ] && [ "$(result_count)" -gt "$result_base" ]; then
      t_result=$(now_ms)
    fi
    if [ -n "$t_sup" ] && [ -n "$t_relay" ] && [ -n "$t_result" ]; then break; fi
    case "$sup_line" in *INTERRUPT_SKIPPED:*|*INTERRUPT_FAILED:*) [ -n "$t_sup" ] && [ $(( $(now_ms) - t_sup )) -gt 10000 ] && break ;; esac
    sleep 0.1
  done

  echo "$label supervisor line: ${sup_line:-none}" | tee -a "$TIMES"
  echo "$label holder line: ${relay_line:-none}" | tee -a "$TIMES"
  [ -n "$t_sup" ] && note_time "$label supervisor INTERRUPT line seen" "$t_sup"
  [ -n "$t_relay" ] && note_time "$label holder relay line seen" "$t_relay"
  [ -n "$t_result" ] && note_time "$label result event seen" "$t_result"

  case "$sup_line" in
    *' INTERRUPT: '*) pass "$label the supervisor relayed the interrupt (INTERRUPT:, not INTERRUPT_SKIPPED:)" ;;
    *) failed "$label the supervisor relayed the interrupt (got: ${sup_line:-no line})" ;;
  esac
  id=$(printf '%s' "$sup_line" | grep -o 'id=[A-Za-z0-9-]*' | head -n 1 | cut -d= -f2)
  if [ -n "$id" ] && printf '%s' "$relay_line" | grep -q "id=$id "; then
    pass "$label the holder relayed the same id ($id)"
  else
    failed "$label the holder relayed the supervisor's id (supervisor id ${id:-none}, holder line ${relay_line:-none})"
  fi
  if [ -n "$id" ] && grep -q "\"control_response\".*\"$id\"" "$OUT" 2>/dev/null; then
    echo "$label control_response: $(grep "\"control_response\".*\"$id\"" "$OUT" | head -n 1)" | tee -a "$TIMES"
  fi
  if [ -n "$t_relay" ] && [ -n "$t_result" ]; then
    subtype=$(sed -n "$(last_result_line)p" "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).subtype)}catch(e){console.log("?")}})')
    echo "$label relay to result: $(( t_result - t_relay )) ms; request to result: $(( t_result - request_at )) ms; result subtype $subtype" | tee -a "$TIMES"
    if [ $(( t_result - t_relay )) -le "$RELAY_TO_RESULT_MAX_MS" ]; then
      pass "$label the result landed within ${RELAY_TO_RESULT_MAX_MS} ms of the holder's relay ($(( t_result - t_relay )) ms, subtype $subtype)"
    else
      failed "$label the result landed within ${RELAY_TO_RESULT_MAX_MS} ms of the holder's relay ($(( t_result - t_relay )) ms)"
    fi
  else
    failed "$label a result followed the holder's relay (relay ${t_relay:-unseen}, result ${t_result:-unseen})"
  fi
}

# --- Case 1: the priming turn, parked in its retry wait ---
interrupt_case "C1-priming" 0 0
C1_RESULT_LINE=$(last_result_line)

# --- Case 2: the goal turn, carrying the codeword, parked in its retry wait ---
# The holder sends the goal once the priming turn's result is in the stream.

if [ -n "$C1_RESULT_LINE" ]; then
  case "$HB_TURN_STARTED" in ""|*[!0-9]*) HB_TURN_STARTED=0 ;; esac
  interrupt_case "C2-goal" "$C1_RESULT_LINE" "$HB_TURN_STARTED"
  GOAL_SENT=$(node -e '
const cw = process.argv[2];
let n = 0;
try { for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) { if (l && JSON.parse(l).body.includes(cw)) n++; } } catch (e) {}
console.log(n);
' "$STUB_LOG" "$CODEWORD")
  if [ "${GOAL_SENT:-0}" -gt 0 ]; then pass "C2-goal the goal turn's request reached the stub carrying the codeword"; else failed "C2-goal the goal turn's request reached the stub carrying the codeword"; fi
else
  failed "C2-goal skipped: case 1 produced no result, so the goal was never sent"
fi

# --- Follow-up: the conversation survived both interrupts ---
# Sent through the holder's ask path, the one prompt shape it relays: a user
# turn whose one text block opens [SUPERVISOR-ASK id=. The file is written whole
# and moved into place, as the supervisor writes its own final ask.
FOLLOWUP_ID="followup-$(now_ms)"
if [ -n "$(last_result_line)" ] && [ "$(result_count)" -ge 2 ]; then
  node -e '
const text = "[SUPERVISOR-ASK id=" + process.argv[1] + "] What codeword did the task message give you? Answer with the codeword alone.";
process.stdout.write(JSON.stringify({ type: "user", role: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
' "$FOLLOWUP_ID" > "$CHILD_DIR/ask.request.tmp"
  mv -f "$CHILD_DIR/ask.request.tmp" "$CHILD_DIR/ask.request"
  note_time "follow-up ask written" "$(now_ms)"
  FOLLOWUP_VERDICT=""
  for _i in $(seq 1 90); do
    FOLLOWUP_VERDICT=$(node -e '
const [file, id, cw] = process.argv.slice(1);
let found = null;
try { for (const l of require("fs").readFileSync(file, "utf8").split("\n")) { if (!l) continue; const o = JSON.parse(l); if (o.body.includes(id)) { found = o; break; } } } catch (e) {}
if (!found) process.exit(0);
let msgs = null;
try { msgs = JSON.parse(found.body).messages; } catch (e) {}
// The follow-up text never names the codeword, so the codeword in this
// request can only be the prompt of the interrupted goal turn, carried in the
// history. The harness may merge adjacent user turns, so the check is
// over every message rather than those before the last.
const inHistory = Array.isArray(msgs) && JSON.stringify(msgs).includes(cw);
console.log([found.at, inHistory ? "codeword-in-history" : "codeword-missing", Array.isArray(msgs) ? msgs.length : "unparsed"].join(" "));
' "$STUB_LOG" "$FOLLOWUP_ID" "$CODEWORD")
    [ -n "$FOLLOWUP_VERDICT" ] && break
    sleep 1
  done
  echo "follow-up request: ${FOLLOWUP_VERDICT:-none seen} (id $FOLLOWUP_ID)" | tee -a "$TIMES"
  case "$FOLLOWUP_VERDICT" in
    *codeword-in-history*) pass "F1 the follow-up's request carries the goal prompt's codeword in its message history, so the conversation survived" ;;
    *) failed "F1 the follow-up's request carries the goal prompt's codeword in its message history (${FOLLOWUP_VERDICT:-no request seen})" ;;
  esac
  grep "relayed a final ask" "$SUPERVISE_ERR" | tail -n 1 | sed 's/^/holder: /' | tee -a "$TIMES"
else
  failed "F1 skipped: the two interrupted turns did not both end"
fi

# --- Stop and prove nothing survived ---
take_snapshot
printf '%s\n' "$SNAPSHOT" > "$SUITE_DIR/process-snapshot.txt"
CONTROL_ALIVE=$(ps_alive "$SNAPSHOT" | awk 'NF' | wc -l)
CONTROL_CMDLINE=$(ps_cmdline_match | awk 'NF' | wc -l)
echo "before teardown: $(printf '%s\n' "$SNAPSHOT" | awk 'NF' | wc -l) snapshot processes, $CONTROL_ALIVE alive; $CONTROL_CMDLINE command lines name the run directory" | tee -a "$TIMES"
teardown
sleep 3
SURVIVORS=$(ps_alive "$SNAPSHOT" | awk 'NF')
CMDLINE_SURVIVORS=$(ps_cmdline_match | awk 'NF')
echo "after teardown: snapshot survivors [${SURVIVORS}] ; command-line survivors [${CMDLINE_SURVIVORS}]" | tee -a "$TIMES"
if [ "$CONTROL_ALIVE" -gt 0 ] && [ "$CONTROL_CMDLINE" -gt 0 ] && [ -z "$SURVIVORS" ] && [ -z "$CMDLINE_SURVIVORS" ]; then
  pass "T1 no process this run started survives the teardown (controls: $CONTROL_ALIVE alive and $CONTROL_CMDLINE matched before it)"
else
  failed "T1 no process this run started survives the teardown (controls $CONTROL_ALIVE/$CONTROL_CMDLINE; survivors: ${SURVIVORS:-none} / ${CMDLINE_SURVIVORS:-none})"
  # Survivors are this run's own, by pid and creation ticks or by a command
  # line naming this run's directory on a process created since it began, so
  # they are stopped here rather than left holding the machine.
  printf '%s\n%s\n' "$SURVIVORS" "$CMDLINE_SURVIVORS" | while read -r spid _rest; do [ -n "$spid" ] && taskkill //PID "$spid" //F >/dev/null 2>&1; done
fi

echo "evidence: $SUITE_DIR"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "live-interrupt-ratelimit-test.sh: FAIL ($FAIL_COUNT check(s) failed)"
  exit 1
fi
echo "live-interrupt-ratelimit-test.sh: PASS"
exit 0
