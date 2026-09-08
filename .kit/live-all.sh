#!/usr/bin/env bash
# Live test runner: runs the eight suites in parallel at concurrency 3.
# Usage: live-all.sh [suite...]
#   Suites: errorstreak, health, gitprobe, controller, goaltree, goaltree-stall, planfail, yield
#   Default: all eight.
#
# Concurrency: CONCURRENCY=3 (variable at top).
# Wall clock targets: full <= 25 min, short <= 12 min.

set -u

# --- Configuration ---
CONCURRENCY=3
STAGGER_S=30
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
ALL_SUITES=(errorstreak health gitprobe controller goaltree goaltree-stall planfail yield)
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

# --- Helper: run one suite in its private directory ---
run_suite() {
  local suite="$1"
  local suite_dir="/d/Temp/agentic-live/$suite"
  local script="$SCRIPT_DIR/live-${suite}-test.sh"
  local start_ts end_ts rc

  # Check that the suite script exists and has been refactored (v0.8.0+)
  if [ ! -f "$script" ]; then
    echo "FAIL: suite script not found: $script"
    echo "$suite script_exit=2 started=$start_ts ended=$end_ts exitfile=[missing] assert=[missing]" >> "$SUMMARY"
    return 2
  fi

  # Check for the v0.8.0 refactor marker (SUITE_DIR)
  if ! grep -q "SUITE_DIR" "$script" 2>/dev/null; then
    echo "FAIL: suite not refactored: $suite (missing SUITE_DIR)"
    echo "$suite script_exit=2 started=$start_ts ended=$end_ts exitfile=[not refactored] assert=[not refactored]" >> "$SUMMARY"
    return 2
  fi

  start_ts="$(date -u +%FT%TZ)"

  # Run the suite
  local stdout_log="$RUN_DIR/$suite.stdout.log"
  SUITE_DIR="$suite_dir" PROFILE="$PROFILE" bash "$script" > "$stdout_log" 2>&1
  rc=$?

  end_ts="$(date -u +%FT%TZ)"

  # Read the artifacts the suite wrote
  local exit_file="$suite_dir/$suite.exit"
  local assert_log="$suite_dir/$suite.assert.log"
  local exit_content="missing"
  local assert_content="missing"

  if [ -f "$exit_file" ]; then
    # Replace newlines with spaces for the summary
    exit_content="$(tr '\n' ' ' < "$exit_file")"
  fi
  if [ -f "$assert_log" ]; then
    # Replace newlines with semicolons for the summary
    assert_content="$(tr '\n' ';' < "$assert_log")"
  fi

  # Copy artifacts to the runs directory
  [ -f "$exit_file" ] && cp -f "$exit_file" "$RUN_DIR/$suite.exit"
  [ -f "$assert_log" ] && cp -f "$assert_log" "$RUN_DIR/$suite.assert.log"
  [ -f "$stdout_log" ] && cp -f "$stdout_log" "$RUN_DIR/$suite.stdout.log"
  if [ -f "$suite_dir/.agentic-personas.json" ]; then
    cp -f "$suite_dir/.agentic-personas.json" "$RUN_DIR/$suite.store.json"
  fi

  # Write the summary line
  echo "$suite script_exit=$rc started=$start_ts ended=$end_ts exitfile=[$exit_content] assert=[$assert_content]" >> "$SUMMARY"

  # Remove the suite directory (J4: runner removes, not the suite)
  rm -rf "$suite_dir"

  return $rc
}

# --- Job-slot loop (concurrency 3, 30s stagger) ---
echo "=== live-all.sh start $STAMP ==="
echo "Profile: $PROFILE"
echo "Concurrency: $CONCURRENCY"
echo "Suites: ${SUITES[*]}"
echo ""

running=()
idx=0
failures=0
declare -A suite_rc

while [ $idx -lt ${#SUITES[@]} ] || [ ${#running[@]} -gt 0 ]; do
  # Launch new suites if slots are available
  while [ ${#running[@]} -lt $CONCURRENCY ] && [ $idx -lt ${#SUITES[@]} ]; do
    suite="${SUITES[$idx]}"
    run_suite "$suite" &
    running+=("$!")
    idx=$((idx+1))
    [ $idx -lt ${#SUITES[@]} ] && sleep $STAGGER_S
  done

  # Reap finished jobs
  new_running=()
  for pid in "${running[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      new_running+=("$pid")
    else
      wait "$pid"
      rc=$?
      if [ $rc -ne 0 ]; then
        failures=$((failures+1))
        echo "FAIL: pid=$pid rc=$rc"
      fi
    fi
  done
  running=("${new_running[@]:-}")

  [ ${#running[@]} -gt 0 ] && sleep 5
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
