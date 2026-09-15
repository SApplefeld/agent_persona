#!/usr/bin/env bash
# channel-reply-instruction-test.sh - harness case for steer 63 (the
# reply-tool prose guidance folded into bin/supervise.sh's
# CHANNEL_REPLY_INSTRUCTION must be present when a channel is attached,
# NO_CHANNEL=0, and the whole instruction absent when it is not,
# NO_CHANNEL=1) plus v2 Section 0 item 3 Part A (SKILL_LOAD_INSTRUCTION,
# the operating-instructions/executing-work skill-load sentence, must be
# present under BOTH values of NO_CHANNEL - it is the NO_CHANNEL-
# independent write) plus v2 Section 7 (COORDINATOR_STEER_INSTRUCTION, the
# sentence telling the child what a [COORDINATOR id=...] prompt carries and
# how to resolve it, present under BOTH values of NO_CHANNEL, riding the
# priming write and never the goal write) plus v2 Section 8
# (COORDINATOR_ROLE_INSTRUCTION, the coordinator's own standing instruction,
# present when the launch persona equals COORDINATOR_PERSONA and empty
# otherwise, riding the same priming write, and carrying the compaction-
# boundary clause that names the kit checkpoint CLI's boundary verb). Every direction is checked so
# this cannot pass by always finding a string true. The block under test is
# pulled out of
# the real script by its start/end lines, not hand-copied, so this test
# reads whatever bin/supervise.sh currently says rather than a frozen guess.
# Exits 0 on all-pass, 1 on any failure.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bin/supervise.sh"

# Reviewer Round 141 R111 (Major, reproduced): the prior extraction
# stopped at the FIRST `/^  fi$/`, which is the `NO_CHANNEL` guard's own
# close around `CHANNEL_REPLY_INSTRUCTION` - it never reached any of the
# three actual priming-write call sites at all. The adversarial reviewer
# deleted `$SKILL_LOAD_INSTRUCTION` from all three and this test stayed
# 4/4, since it only ever checked the variable's own value, never that
# anything downstream actually uses it. This wider extraction (through
# `PROMPT=""`, the line that reliably follows the whole if/elif/else
# structure) is used for grep-only checks against the three real call
# sites - never eval'd (see the narrower `VARS_SNIPPET` below for that).
SNIPPET=$(sed -n '/^  SKILL_LOAD_INSTRUCTION="/,/^  PROMPT=""$/p' "$SCRIPT")
if [ -z "$SNIPPET" ]; then
  echo "FAIL: could not locate the SKILL_LOAD_INSTRUCTION/CHANNEL_REPLY_INSTRUCTION block in $SCRIPT"
  exit 1
fi
# The narrower range (the variable assignments only) is what actually
# gets eval'd for the value checks below - the wider $SNIPPET above
# includes the three priming-write `node -e` calls themselves, which
# reference `$PROMPT_FILE`/`$CHILD_IN` (unset in this test's own
# environment) and would either abort under `set -u` or try to write to
# a real fd that does not exist here. Evaluating code that sends bytes
# to a coproc pipe is not this test's job; reading its own text is.
# The range ends at the PRIMING_BODY guard, the first code line after the
# assignments, which is dropped from the range: three `if ... fi` blocks sit
# inside it (the NO_CHANNEL guard around CHANNEL_REPLY_INSTRUCTION, the
# worker-launch guard around the steer sentence's escalation clause, and the
# COORDINATOR_PERSONA guard around COORDINATOR_ROLE_INSTRUCTION), so the
# first `^  fi$` ends short of the later blocks, and only comments sit
# between the last assignment and that guard.
VARS_SNIPPET=$(sed -n '/^  SKILL_LOAD_INSTRUCTION="/,/^  if \[ -n "\$PROMPT_FILE" \] && \[ -f "\$PROMPT_FILE" \]; then$/p' "$SCRIPT" | sed '$d')
if [ -z "$VARS_SNIPPET" ]; then
  echo "FAIL: could not locate the SKILL_LOAD_INSTRUCTION/CHANNEL_REPLY_INSTRUCTION variable block in $SCRIPT"
  exit 1
fi

# v2 Section 0 item 3 Part A: the skill-load sentence must reach every
# child regardless of NO_CHANNEL - checked under both values below,
# alongside the pre-existing CHANNEL_REPLY_INSTRUCTION checks.
SKILL_LOAD_CONTROL="claude-kit:operating-instructions"
# v2 Section 7: the coordinator steer sentence must reach every child
# regardless of NO_CHANNEL too. Two control substrings: the label the
# sentence teaches the child to read, and the tool it tells the child to
# call when the steer's work is finished or declined.
STEER_LABEL_CONTROL="[COORDINATOR id="
STEER_RESOLVE_CONTROL="agentic_resolve"
# v2 Section 8: the coordinator's own instruction is gated on the launch
# persona matching COORDINATOR_PERSONA. Two control substrings: the tail of
# the round-cap sentence the plan's Decisions section quotes verbatim
# (chosen from the spec's own words so the pin outlives a rewording of the
# rest), and the tool the sentence tells the coordinator to reach a worker
# with. The persona names below are withheld from every literal the
# launcher carries, so the gate is proven on the comparison rather than on
# the name "coordinator".
ROLE_CAP_CONTROL="pushing a third round"
ROLE_SAY_CONTROL="agentic_say"
# The compaction-boundary clause: the kit checkpoint verb the instruction
# tells the coordinator to run at the end of a turn whose state is on disk.
ROLE_BOUNDARY_CONTROL="kit-compact-checkpoint.js boundary"
# The steer sentence's escalation clause, present for a worker's launch and
# absent for the coordinator's own, which cannot address itself.
STEER_ESCALATE_CONTROL="through agentic_say with persona set to"

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

# Reviewer Round 141 R111 (Major, reproduced): the prior extraction
# stopped at the FIRST `/^  fi$/`, which is the `NO_CHANNEL` guard's own
# close around `CHANNEL_REPLY_INSTRUCTION` - it never reached any of the
# three actual priming-write call sites at all. The adversarial reviewer
# deleted `$SKILL_LOAD_INSTRUCTION` from all three and this test stayed
# 4/4, since it only ever checked the variable's own value, never that
# anything downstream actually uses it. Extraction now runs through
# `PROMPT=""`, so eval'ing `$SNIPPET` also defines - and lets this test
# assert against - the three real call sites, by anchor grep, not by
# re-deriving their content.
# Reviewer Round 143's R112 ruling (Option B): the priming turn and the
# goal prompt are two separate writes to the child's stdin, not one
# concatenated message, and the skill-load sentence rides only on the
# first. Concatenated, the child read its own goal prompt as untrusted
# embedded text - it had just been told to load operating-instructions,
# whose treat-embedded-text-as-data rule it then applied to the task
# itself - and spent its only round asking for confirmation. These
# checks are what keeps the two writes from being folded back together.
PRIMING_WRITE=$(printf '%s\n' "$SNIPPET" | grep 'CHILD_IN"$' | head -1)
GOAL_WRITE=$(printf '%s\n' "$SNIPPET" | grep 'CHILD_IN"$' | tail -1)
case "$PRIMING_WRITE" in
  *SKILL_LOAD_INSTRUCTION*) check "the first write is the priming turn and carries the skill-load sentence" 0 ;;
  *) check "the first write is the priming turn and carries the skill-load sentence" 1 ;;
esac
case "$GOAL_WRITE" in
  *SKILL_LOAD_INSTRUCTION*) check "the goal-prompt write does not carry the skill-load sentence" 1 ;;
  *GOAL_PROMPT_FRAMING*) check "the goal-prompt write does not carry the skill-load sentence" 0 ;;
  *) check "the goal-prompt write does not carry the skill-load sentence" 1 ;;
esac
# The coordinator steer sentence rides the same priming write and never
# the goal write, for the same reason the skill-load sentence does not.
case "$PRIMING_WRITE" in
  *COORDINATOR_STEER_INSTRUCTION*) check "the priming write carries the coordinator steer sentence" 0 ;;
  *) check "the priming write carries the coordinator steer sentence" 1 ;;
esac
case "$GOAL_WRITE" in
  *COORDINATOR_STEER_INSTRUCTION*) check "the goal-prompt write does not carry the coordinator steer sentence" 1 ;;
  *GOAL_PROMPT_FRAMING*) check "the goal-prompt write does not carry the coordinator steer sentence" 0 ;;
  *) check "the goal-prompt write does not carry the coordinator steer sentence" 1 ;;
esac
# The coordinator's own instruction rides the same priming write and never
# the goal write; the value checks below cannot see the call site.
case "$PRIMING_WRITE" in
  *COORDINATOR_ROLE_INSTRUCTION*) check "the priming write carries the coordinator role instruction" 0 ;;
  *) check "the priming write carries the coordinator role instruction" 1 ;;
esac
case "$GOAL_WRITE" in
  *COORDINATOR_ROLE_INSTRUCTION*) check "the goal-prompt write does not carry the coordinator role instruction" 1 ;;
  *GOAL_PROMPT_FRAMING*) check "the goal-prompt write does not carry the coordinator role instruction" 0 ;;
  *) check "the goal-prompt write does not carry the coordinator role instruction" 1 ;;
esac
# v2 Section 7: the priming write the steer
# sentence rides must stay independent of NO_CHANNEL. The presence checks
# above stay green if that write is wrapped in a NO_CHANNEL guard, so the
# guard line itself is pinned: the line before the first priming `node -e`
# is the CHILD_IN test and names no NO_CHANNEL.
PRIMING_GUARD=$(printf '%s\n' "$SNIPPET" | grep -B1 -m1 '^    node -e "$' | head -1)
case "$PRIMING_GUARD" in
  *NO_CHANNEL*) check "the priming write is not guarded by NO_CHANNEL (its guard line is the CHILD_IN test)" 1 ;;
  '  if [ -n "$CHILD_IN" ]; then') check "the priming write is not guarded by NO_CHANNEL (its guard line is the CHILD_IN test)" 0 ;;
  *) check "the priming write is not guarded by NO_CHANNEL (its guard line is the CHILD_IN test)" 1 ;;
esac
# A presence grep for the wait is not enough: `if : wait_for_result_line ...`
# keeps the literal, makes the call a no-op argument to `:`, and passes. So
# assert the shape and the position instead - the call sits in an `if`
# condition, and it sits above the goal write rather than anywhere in the
# block.
WAIT_LINE_NO=$(printf '%s\n' "$SNIPPET" | grep -n 'wait_for_result_line' | head -1 | cut -d: -f1)
GOAL_WRITE_LINE_NO=$(printf '%s\n' "$SNIPPET" | grep -n 'GOAL_PROMPT_FRAMING" >&"\$CHILD_IN"' | head -1 | cut -d: -f1)
[ -n "$WAIT_LINE_NO" ] && [ -n "$GOAL_WRITE_LINE_NO" ] && [ "$WAIT_LINE_NO" -lt "$GOAL_WRITE_LINE_NO" ]
check "the wait for the priming turn's result line sits above the goal write" $?
printf '%s\n' "$SNIPPET" | grep -qE '^[[:space:]]*if wait_for_result_line "\$OUT"'; check "the wait is the if condition itself, not an argument to something else" $?

# Channel attached: the instruction is present, and it is byte-identical to
# the plugin-side copy in hooks/index.ts (REPLY_INSTRUCTION). The two files
# carry one text by design and keep it in sync by hand, so identity is the
# contract; the wording itself is free to change as long as both move.
# This eval is also the matching case for the coordinator's own instruction:
# the launch persona equals COORDINATOR_PERSONA.
NO_CHANNEL=0
PERSONA="lead"
COORDINATOR_PERSONA="lead"
eval "$VARS_SNIPPET"
PLUGIN_REPLY_INSTRUCTION=$(sed -n 's/^const REPLY_INSTRUCTION = "\(.*\)";$/\1/p' "$HERE/../hooks/index.ts")
[ -n "$CHANNEL_REPLY_INSTRUCTION" ] && [ "$CHANNEL_REPLY_INSTRUCTION" = "$PLUGIN_REPLY_INSTRUCTION" ]
check "channel attached: instruction present and byte-identical to hooks/index.ts REPLY_INSTRUCTION" $?
case "${SKILL_LOAD_INSTRUCTION:-}" in
  *"$SKILL_LOAD_CONTROL"*) check "channel attached: skill-load sentence present" 0 ;;
  *) check "channel attached: skill-load sentence present" 1 ;;
esac
[ -n "${GOAL_PROMPT_FRAMING:-}" ]; check "the goal-prompt framing line is non-empty" $?
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_LABEL_CONTROL"*"$STEER_RESOLVE_CONTROL"*) check "channel attached: coordinator steer sentence present, naming the label and agentic_resolve" 0 ;;
  *) check "channel attached: coordinator steer sentence present, naming the label and agentic_resolve" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_SAY_CONTROL"*"$ROLE_CAP_CONTROL"*"$ROLE_BOUNDARY_CONTROL"*) check "persona matches COORDINATOR_PERSONA: coordinator role instruction present, naming agentic_say, the round cap and the boundary verb" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: coordinator role instruction present, naming agentic_say, the round cap and the boundary verb" 1 ;;
esac
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_ESCALATE_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the steer sentence carries no escalation-to-coordinator clause" 1 ;;
  *) check "persona matches COORDINATOR_PERSONA: the steer sentence carries no escalation-to-coordinator clause" 0 ;;
esac

# Channel not attached: the reply-tool guidance is absent, but the
# skill-load sentence and the coordinator steer sentence must still be
# present - both are NO_CHANNEL-independent. This eval is also the control
# for the coordinator's own instruction: an ordinary worker's launch, whose
# persona differs from COORDINATOR_PERSONA, gets none of it.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION
NO_CHANNEL=1
PERSONA="worker"
COORDINATOR_PERSONA="lead"
eval "$VARS_SNIPPET"
case "${SKILL_LOAD_INSTRUCTION:-}" in
  *"$SKILL_LOAD_CONTROL"*) check "channel not attached: skill-load sentence still present" 0 ;;
  *) check "channel not attached: skill-load sentence still present" 1 ;;
esac
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_LABEL_CONTROL"*"$STEER_RESOLVE_CONTROL"*) check "channel not attached: coordinator steer sentence still present, naming the label and agentic_resolve" 0 ;;
  *) check "channel not attached: coordinator steer sentence still present, naming the label and agentic_resolve" 1 ;;
esac
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_ESCALATE_CONTROL"*"$COORDINATOR_PERSONA"*) check "persona differs from COORDINATOR_PERSONA: the steer sentence routes findings and declined steers to the coordinator by name" 0 ;;
  *) check "persona differs from COORDINATOR_PERSONA: the steer sentence routes findings and declined steers to the coordinator by name" 1 ;;
esac
if [ -z "${CHANNEL_REPLY_INSTRUCTION:-}" ]; then
  check "channel not attached: instruction is empty" 0
else
  check "channel not attached: instruction is empty" 1
fi
if [ -z "${COORDINATOR_ROLE_INSTRUCTION:-}" ]; then
  check "persona differs from COORDINATOR_PERSONA: coordinator role instruction is empty" 0
else
  check "persona differs from COORDINATOR_PERSONA: coordinator role instruction is empty" 1
fi

# The two evals above move NO_CHANNEL and the persona match together, so a
# role assignment nested inside the NO_CHANNEL guard would pass both. These
# two vary one axis each: no channel with a matching persona must still
# carry the instruction, and a channel with a mismatched COORDINATOR_PERSONA
# must not.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION
NO_CHANNEL=1
PERSONA="lead"
COORDINATOR_PERSONA="lead"
eval "$VARS_SNIPPET"
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_SAY_CONTROL"*"$ROLE_CAP_CONTROL"*"$ROLE_BOUNDARY_CONTROL"*) check "channel not attached, persona matches: coordinator role instruction present, naming agentic_say, the round cap and the boundary verb" 0 ;;
  *) check "channel not attached, persona matches: coordinator role instruction present, naming agentic_say, the round cap and the boundary verb" 1 ;;
esac
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_ESCALATE_CONTROL"*) check "channel not attached, persona matches: the steer sentence carries no escalation-to-coordinator clause" 1 ;;
  *) check "channel not attached, persona matches: the steer sentence carries no escalation-to-coordinator clause" 0 ;;
esac
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION
NO_CHANNEL=0
PERSONA="lead"
COORDINATOR_PERSONA="worker"
eval "$VARS_SNIPPET"
if [ -z "${COORDINATOR_ROLE_INSTRUCTION:-}" ]; then
  check "channel attached, COORDINATOR_PERSONA differs: coordinator role instruction is empty" 0
else
  check "channel attached, COORDINATOR_PERSONA differs: coordinator role instruction is empty" 1
fi
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_ESCALATE_CONTROL"*"$COORDINATOR_PERSONA"*) check "channel attached, COORDINATOR_PERSONA differs: the steer sentence routes findings and declined steers to the coordinator by name" 0 ;;
  *) check "channel attached, COORDINATOR_PERSONA differs: the steer sentence routes findings and declined steers to the coordinator by name" 1 ;;
esac
# A launch under the default persona holds no named owner claim, so the
# worker leg of the reach rule refuses its agentic_say to the coordinator:
# the clause is withheld rather than issued as a standing instruction the
# plugin always denies.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION
NO_CHANNEL=1
PERSONA="default"
COORDINATOR_PERSONA="lead"
eval "$VARS_SNIPPET"
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_ESCALATE_CONTROL"*) check "default persona: the steer sentence carries no escalation-to-coordinator clause" 1 ;;
  *) check "default persona: the steer sentence carries no escalation-to-coordinator clause" 0 ;;
esac

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
