#!/usr/bin/env bash
# Live test runner: runs the ten suites serially (V4: CONCURRENCY=1).
# Usage: live-all.sh [suite...]
#   Suites: errorstreak, health, gitprobe, controller, goaltree, goaltree-stall, planfail, yield, budget, commons
#   Default: all ten.
#
# V4: serial execution (one suite at a time, no stagger).
# Wall clock targets: full <= 25 min, short <= 12 min (serial, no overlap).
set -u

# --- Configuration ---
CONCURRENCY=1   # V4: serial - one suite at a time
STAGGER_S=0
PROFILE="${PROFILE:-short}"

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$HARNESS_ROOT/agentic-plugin"
RUNS_DIR="$PLUGIN_DIR/.kit/runs"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$RUNS_DIR/$STAMP"
HEAD_SHORT="$(cd "$PLUGIN_DIR" && git log -1 --format=%h)"

# --- Suite list ---
ALL_SUITES=(errorstreak health gitprobe controller goaltree goaltree-stall planfail yield budget commons)
if [ $# -eq 0 ]; then
  SUITES=("${ALL_SUITES[@]}")
else
  SUITES=("$@")
fi

# --- Setup ---
mkdir -p "$RUN_DIR"
GLOBAL_RUNNING="$PLUGIN_DIR/.kit/RUNNING"
touch "$GLOBAL_RUNNING"
echo "DeepSeekHarness live-all.sh $STAMP" > "$GLOBAL_RUNNING"

# Summary file
SUMMARY="$RUN_DIR/summary.txt"
echo "start $(date -u +%FT%TZ) HEAD $HEAD_SHORT PROFILE $PROFILE" > "$SUMMARY"

# V3: find the global commons store for the pre-gate
source "$SCRIPT_DIR/live-common.sh"
GLOBAL_STORE="$(find_global_store)"
if [ -z "$GLOBAL_STORE" ]; then
  echo "ERROR: no global commons store found (cannot run live suites)" >&2
  rm -f "$GLOBAL_RUNNING"
  exit 9
fi

# --- Helper: run one suite in its private directory ---
run_suite() {
  local suite="$1"
  local suite_dir="/d/Temp/agentic-live/$suite"
  local script="$SCRIPT_DIR/live-${suite}-test.sh"
  local start_ts end_ts rc

  # Check that the suite script exists and has been refactored (v0.8.0+)
  if [ ! -f "$script" ]; then
    echo "FAIL: suite script not found: $script"
    start_ts="$(date -u +%FT%TZ)"
    end_ts="$start_ts"
    echo "$suite script_exit=2 started=$start_ts ended=$end_ts exitfile=[missing] assert=[missing]" >> "$SUMMARY"
    return 2
  fi

  # Check for the v0.8.0 refactor marker (SUITE_DIR)
  if ! grep -q "SUITE_DIR" "$script" 2>/dev/null; then
    echo "FAIL: suite not refactored: $suite (missing SUITE_DIR)"
    start_ts="$(date -u +%FT%TZ)"
    end_ts="$start_ts"
    echo "$suite script_exit=2 started=$start_ts ended=$end_ts exitfile=[not refactored] assert=[not refactored]" >> "$SUMMARY"
    return 2
  fi

  start_ts="$(date -u +%FT%TZ)"

  # V4: pre-gate for every suite (not just the persona suites)
  echo "live-all: pre-gate for $suite..."
  wait_persona_free "$GLOBAL_STORE" 120 || { echo "FAIL: pre-gate for $suite"; return 1; }

  # Run the suite
  local stdout_log="$RUN_DIR/$suite.stdout.log"
  SUITE_DIR="$suite_dir" PROFILE="$PROFILE" bash "$script" > "$stdout_log" 2>&1
  rc=$?

  end_ts="$(date -u +%FT%TZ)"

  # Read the artifacts the suite wrote
  local exit_file=""
  for candidate in "$suite_dir/${suite}-test.exit" "$suite_dir/${suite}.exit" "$suite_dir/ctrl-test.exit"; do
    if [ -f "$candidate" ]; then
      exit_file="$candidate"
      break
    fi
  done
  local assert_log="$suite_dir/${suite}.assert.log"
  local exit_content="missing"
  local assert_content="missing"

  if [ -f "$exit_file" ]; then
    exit_content="$(tr '\n' ' ' < "$exit_file")"
  fi
  if [ -f "$assert_log" ]; then
    assert_content="$(tr '\n' ';' < "$assert_log")"
  fi

  # V4: preserve failure logs before rm -rf (copy key artifacts to RUN_DIR)
  [ -f "$exit_file" ] && cp -f "$exit_file" "$RUN_DIR/$suite.exit"
  [ -f "$assert_log" ] && cp -f "$assert_log" "$RUN_DIR/$suite.assert.log"
  [ -f "$suite_dir/.agentic-personas.json" ] && cp -f "$suite_dir/.agentic-personas.json" "$RUN_DIR/$suite.store.json"
  [ -f "$suite_dir/$suite.decisions.log" ] && cp -f "$suite_dir/$suite.decisions.log" "$RUN_DIR/$suite.decisions.log"
  [ -f "$suite_dir/$suite-test.err.log" ] && cp -f "$suite_dir/$suite-test.err.log" "$RUN_DIR/$suite.err.log"
  [ -f "$suite_dir/$suite-test.out.jsonl" ] && cp -f "$suite_dir/$suite-test.out.jsonl" "$RUN_DIR/$suite.out.jsonl"
  [ -f "$suite_dir/$suite-test.debug.log" ] && cp -f "$suite_dir/$suite-test.debug.log" "$RUN_DIR/$suite.debug.log"

  # Write the summary line
  echo "$suite script_exit=$rc started=$start_ts ended=$end_ts exitfile=[$exit_content] assert=[$assert_content]" >> "$SUMMARY"

  # Remove the suite directory (J4: runner removes, not the suite)
  rm -rf "$suite_dir"

  return $rc
}

# --- Serial loop (V4: CONCURRENCY=1) ---
echo "=== live-all.sh start $STAMP ==="
echo "Profile: $PROFILE"
echo "Concurrency: $CONCURRENCY (serial)"
echo "Suites: ${SUITES[*]}"
echo "Global store: $GLOBAL_STORE"
echo ""

failures=0
total=${#SUITES[@]}
idx=0

while [ $idx -lt $total ]; do
  suite="${SUITES[$idx]}"
  echo "--- [$((idx+1))/$total] $suite ---"
  run_suite "$suite"
  rc=$?
  if [ $rc -ne 0 ]; then
    failures=$((failures+1))
    echo "FAIL: $suite rc=$rc"
  else
    echo "PASS: $suite"
  fi
  idx=$((idx+1))
done

# --- Summary ---
echo "done $(date -u +%FT%TZ)" >> "$SUMMARY"
echo ""
echo "=== Summary ==="
cat "$SUMMARY"
echo ""
echo "Failures: $failures"

# Clean up global RUNNING
rm -f "$GLOBAL_RUNNING"

if [ $failures -gt 0 ]; then
  echo "live-all.sh: FAIL ($failures suite(s) failed)"
  exit 1
fi

echo "live-all.sh: PASS (all suites green)"
exit 0
