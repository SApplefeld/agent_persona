#!/usr/bin/env bash
# Shared extraction helpers for the suites that drive bin/supervise.sh's own
# functions rather than a copy of them.
#
# Both helpers live here and nowhere else, so the two suites that source this
# run the same extraction. Two copies of a walker that decides which function
# bodies a suite even sees is a pair that drifts silently: the copy nobody
# proved keeps passing while extracting less than it should.
#
# Sourced, never executed. The sourcing suite owns its own failure reporting.

# Extracts one shell function verbatim from a script, appending it to an out
# file. A function body embeds node and awk scripts whose own braces reach
# column 0, so the closing brace is the last `}` on a line of its own before
# the next top-level function declaration, not the first one after the opening
# line. Returns non-zero when the function is not found or its range cannot be
# read.
# Usage: supervisor_extract_fn <script> <function name> <out file>
supervisor_extract_fn() {
  local file="$1" fn="$2" out="$3" start next end
  start=$(grep -n "^${fn}() {" "$file" | head -1 | cut -d: -f1)
  [ -n "$start" ] || return 1
  next=$(awk -v s="$start" 'NR > s && /^[a-z_][a-z0-9_]*\(\) \{$/ { print NR; exit }' "$file")
  [ -n "$next" ] || next=$(( $(wc -l < "$file") + 1 ))
  end=$(awk -v s="$start" -v n="$next" 'NR > s && NR < n && /^}$/ { last = NR } END { print last }' "$file")
  [ -n "$end" ] || return 1
  sed -n "${start},${end}p" "$file" >> "$out"
}

# The functions a set of entry points calls, closed over their own bodies:
# every name the script declares that appears in an extracted body joins the
# set, and so does everything those bodies call in turn. A suite reads this
# rather than a list typed into it, so a callee added upstream is extracted
# beside its caller instead of resolving against nothing at run time.
# Full-line comments are dropped before the scan, since a name a comment
# merely mentions is not a call. A name in SUPERVISOR_CLOSURE_STUBS stops the
# walk there: the suite defines that one itself and the real body would
# overwrite the stub.
# Prints one name per line, seeds included.
# Usage: supervisor_fn_closure <script> <seed function name...>
supervisor_fn_closure() {
  local file="$1"; shift
  local declared name body callee body_file
  local -a queue=("$@") seen=()
  local stubbed=" ${SUPERVISOR_CLOSURE_STUBS:-} "
  body_file=$(mktemp)
  declared=$(sed -n 's/^\([a-z_][a-z0-9_]*\)() {$/\1/p' "$file")
  while [ "${#queue[@]}" -gt 0 ]; do
    name="${queue[0]}"
    queue=("${queue[@]:1}")
    case " ${seen[*]:-} " in *" $name "*) continue ;; esac
    seen+=("$name")
    : > "$body_file"
    supervisor_extract_fn "$file" "$name" "$body_file" || { rm -f "$body_file"; return 1; }
    body=$(grep -v '^[[:space:]]*#' "$body_file")
    for callee in $declared; do
      [ "$callee" = "$name" ] && continue
      case "$stubbed" in *" $callee "*) continue ;; esac
      case " ${seen[*]:-} ${queue[*]:-} " in *" $callee "*) continue ;; esac
      if printf '%s\n' "$body" | grep -qE "(^|[^A-Za-z0-9_])${callee}([^A-Za-z0-9_]|$)"; then
        queue+=("$callee")
      fi
    done
  done
  rm -f "$body_file"
  printf '%s\n' "${seen[@]}"
}
