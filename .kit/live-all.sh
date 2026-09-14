#!/usr/bin/env bash
# Live test runner: runs the five live suites serially, one real claude child at a time.
# Usage: live-all.sh [suite...]
#   Suites: goaltree, budget, commons, operator, restartrequest
#   Default: all five.
#
# Each suite proves one thing the offline lane cannot: the real engine and plugin
# together. The offline suites (controller-tick-test.mjs and its siblings) own the rest.
set -u

# --- Configuration ---
CONCURRENCY=1   # V4: serial - one suite at a time
STAGGER_S=0
PROFILE="${PROFILE:-short}"

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNS_DIR="$PLUGIN_DIR/.kit/runs"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$RUNS_DIR/$STAMP"
HEAD_SHORT="$(cd "$PLUGIN_DIR" && git log -1 --format=%h)"

# --- Suite list ---
ALL_SUITES=(goaltree budget commons operator restartrequest)
if [ $# -eq 0 ]; then
  SUITES=("${ALL_SUITES[@]}")
else
  SUITES=("$@")
fi

# --- Setup ---
# BP2: check for an existing lock before creating a run directory
GLOBAL_RUNNING="$PLUGIN_DIR/.kit/RUNNING"
if [ -f "$GLOBAL_RUNNING" ]; then
  echo "live-all.sh: .kit/RUNNING exists:"
  cat "$GLOBAL_RUNNING"
  echo "live-all.sh: refusing to start (another gate may be running, or a previous run was killed)."
  echo "Recovery: confirm no claude child with --plugin-dir is running, then rm .kit/RUNNING"
  exit 8
fi

mkdir -p "$RUN_DIR"
touch "$GLOBAL_RUNNING"
echo "DeepSeekHarness live-all.sh $STAMP" > "$GLOBAL_RUNNING"

# Summary file
SUMMARY="$RUN_DIR/summary.txt"
ENGINE_VERSION="$(claude --version 2>/dev/null || echo 'unknown')"
echo "start $(date -u +%FT%TZ) HEAD $HEAD_SHORT PROFILE $PROFILE ENGINE $ENGINE_VERSION" > "$SUMMARY"

# V3: find the global commons store for the pre-gate
source "$SCRIPT_DIR/live-common.sh"
GLOBAL_STORE="$(find_global_store)"
if [ -z "$GLOBAL_STORE" ]; then
  echo "ERROR: no global commons store found (cannot run live suites)" >&2
  rm -f "$GLOBAL_RUNNING"
  exit 9
fi
# Store-name control: every child this harness launches runs under
# --plugin-dir, so the pre-gate must be reading the inline (dev-tree)
# store and never the installed one. A silent drift here reads live=0
# against the wrong store while the real one still holds a fresh claim,
# which lets the next suite start early and join default as a reader
# instead of an owner - the exact failure this line exists to catch loudly.
case "$(basename "$GLOBAL_STORE")" in
  agentic-plugin_inline-*) ;;
  *)
    echo "ERROR: pre-gate store is not an inline (dev-tree) store: $GLOBAL_STORE" >&2
    echo "This harness only launches --plugin-dir children; find_global_store should never resolve to an installed-plugin store here." >&2
    rm -f "$GLOBAL_RUNNING"
    exit 9
    ;;
esac

# Refuse-at-start check, beside the .kit/RUNNING lock above. Checks both
# stores (Reviewer Round 113 R32): the inline store this harness's own
# children use, and the installed-mode store Section 0 item 5 moves every
# worker and the coordinator onto. Until Section 6's arming default lands,
# any plugin-loaded session, a plain chat among them, claims persona:default
# at start, so an open plugin-loaded session is enough to trip this check;
# that is the check working, not a bug in it.
INSTALLED_STORE="$(find_global_store 0)"
if [ -n "$INSTALLED_STORE" ]; then
  refuse_if_persona_live 90000 "$GLOBAL_STORE" "$INSTALLED_STORE"
else
  refuse_if_persona_live 90000 "$GLOBAL_STORE"
fi
if [ $? -ne 0 ]; then
  echo "live-all.sh: refusing to start: a live persona claim is present (the whole gate cannot run beside a live fleet)"
  rm -f "$GLOBAL_RUNNING"
  exit 10
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
  # BP1: capture pre-gate output and record failures in the summary
  echo "live-all: pre-gate for $suite..."
  local pregate_log="$RUN_DIR/$suite.pregate.log"
  if ! wait_persona_free "$GLOBAL_STORE" 120 > "$pregate_log" 2>&1; then
    local end_ts
    end_ts="$(date -u +%FT%TZ)"
    local last_line
    last_line=$(tail -1 "$pregate_log" 2>/dev/null || echo "pre-gate FAIL")
    echo "$suite script_exit=1 started=$start_ts ended=$end_ts exitfile=[pre-gate] assert=[pre-gate FAIL: $last_line]" >> "$SUMMARY"
    echo "FAIL: pre-gate for $suite"
    return 1
  fi

  # Run the suite
  local stdout_log="$RUN_DIR/$suite.stdout.log"
  SUITE_DIR="$suite_dir" PROFILE="$PROFILE" RUN_DIR="$RUN_DIR" bash "$script" > "$stdout_log" 2>&1
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
  # AL8: preserve both artifact name shapes
  # Most suites: $suite-test.out.jsonl, $suite-test.err.log, $suite-test.debug.log
  # Budget, goaltree: $suite.out.jsonl, $suite.err.log
  [ -f "$suite_dir/$suite-test.err.log" ] && cp -f "$suite_dir/$suite-test.err.log" "$RUN_DIR/$suite.err.log"
  [ -f "$suite_dir/$suite-test.out.jsonl" ] && cp -f "$suite_dir/$suite-test.out.jsonl" "$RUN_DIR/$suite.out.jsonl"
  [ -f "$suite_dir/$suite-test.debug.log" ] && cp -f "$suite_dir/$suite-test.debug.log" "$RUN_DIR/$suite.debug.log"
  # Fallback: if the -test shape is missing, try the non-test shape
  if [ ! -f "$RUN_DIR/$suite.err.log" ] && [ -f "$suite_dir/$suite.err.log" ]; then
    cp -f "$suite_dir/$suite.err.log" "$RUN_DIR/$suite.err.log"
  fi
  if [ ! -f "$RUN_DIR/$suite.out.jsonl" ] && [ -f "$suite_dir/$suite.out.jsonl" ]; then
    cp -f "$suite_dir/$suite.out.jsonl" "$RUN_DIR/$suite.out.jsonl"
  fi
  if [ ! -f "$RUN_DIR/$suite.debug.log" ] && [ -f "$suite_dir/$suite.debug.log" ]; then
    cp -f "$suite_dir/$suite.debug.log" "$RUN_DIR/$suite.debug.log"
  fi
  # restartrequest's own names (supervisor.log, the reader's transcript, the
  # reader's debug log, the owner's persona store carrying its decision log)
  # match none of the generic patterns above, so the multi-session suite
  # retains them by name.
  if [ "$suite" = "restartrequest" ]; then
    mkdir -p "$RUN_DIR/restartrequest"
    for f in supervisor.log supervise.stdout.log reader.out.jsonl reader.err.log \
             reader-debug.log restartrequest.assert.log restartrequest.exit \
             settings.json reader-p1.json reader-p2.json; do
      [ -f "$suite_dir/$f" ] && cp -f "$suite_dir/$f" "$RUN_DIR/restartrequest/" 2>/dev/null
    done
    [ -f "$suite_dir/workdir/.agentic-personas.json" ] && \
      cp -f "$suite_dir/workdir/.agentic-personas.json" "$RUN_DIR/restartrequest/persona-store.json" 2>/dev/null
    # Round 81: the owner's child transcripts land under $suite_dir/child-N/
    # (bin/supervise.sh writes them there since the suite passes --rundir
    # $SUITE_DIR), which none of the names above match, so they were lost
    # on every exit path same as the gap the block above already closed.
    cp -r "$suite_dir"/child-* "$RUN_DIR/restartrequest/" 2>/dev/null
  fi

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
