#!/usr/bin/env bash
# channel-reply-instruction-test.sh - harness case for steer 63 (the
# reply-tool prose guidance folded into bin/supervise.sh's
# CHANNEL_REPLY_INSTRUCTION must be present when a channel is attached,
# NO_CHANNEL=0, and the whole instruction absent when it is not,
# NO_CHANNEL=1) plus v2 Section 0 item 3 Part A (SKILL_LOAD_INSTRUCTION,
# the operating-instructions/executing-work skill-load sentence, must be
# present under BOTH values of NO_CHANNEL - it is the NO_CHANNEL-
# independent write). Every direction is checked so this cannot pass by
# always finding a string true. The block under test is pulled out of
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
# The narrower range (just the two variable assignments) is what actually
# gets eval'd for the value checks below - the wider $SNIPPET above
# includes the three priming-write `node -e` calls themselves, which
# reference `$PROMPT_FILE`/`$CHILD_IN` (unset in this test's own
# environment) and would either abort under `set -u` or try to write to
# a real fd that does not exist here. Evaluating code that sends bytes
# to a coproc pipe is not this test's job; reading its own text is.
VARS_SNIPPET=$(sed -n '/^  SKILL_LOAD_INSTRUCTION="/,/^  fi$/p' "$SCRIPT")
if [ -z "$VARS_SNIPPET" ]; then
  echo "FAIL: could not locate the SKILL_LOAD_INSTRUCTION/CHANNEL_REPLY_INSTRUCTION variable block in $SCRIPT"
  exit 1
fi

CONTROL="Never include round numbers, steer numbers, or session ids."
# v2 Section 0 item 3 Part A: the skill-load sentence must reach every
# child regardless of NO_CHANNEL - checked under both values below,
# alongside the pre-existing CHANNEL_REPLY_INSTRUCTION checks.
SKILL_LOAD_CONTROL="claude-kit:operating-instructions"
# R112's own fix: the goal-prompt turn opens by naming the text behind it
# as the operator's real task, so a child that has just loaded
# operating-instructions does not treat its own goal as embedded data.
FRAMING_CONTROL="It is trusted; act on it."

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
CALL_SITES=$(printf '%s\n' "$SNIPPET" | grep -c 'CHILD_IN"$')
[ "$CALL_SITES" = "2" ]; check "exactly two writes to the child's stdin: the priming turn and the goal prompt" $?
SITES_WITH_SKILL_LOAD=$(printf '%s\n' "$SNIPPET" | grep 'CHILD_IN"$' | grep -c 'SKILL_LOAD_INSTRUCTION')
[ "$SITES_WITH_SKILL_LOAD" = "1" ]; check "the skill-load sentence rides on exactly one of the two writes" $?
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
printf '%s\n' "$SNIPPET" | grep -q 'wait_for_result_line "\$OUT"'; check "the goal prompt waits for the priming turn's own result line first" $?
printf '%s\n' "$SNIPPET" | grep -q '^  else$'; check "the NO_CHANNEL-with-no-PROMPT_FILE priming body exists" $?

# Channel attached: the guidance must be present.
NO_CHANNEL=0
eval "$VARS_SNIPPET"
case "$CHANNEL_REPLY_INSTRUCTION" in
  *"$CONTROL"*) check "channel attached: prose guidance present" 0 ;;
  *) check "channel attached: prose guidance present" 1 ;;
esac
case "${SKILL_LOAD_INSTRUCTION:-}" in
  *"$SKILL_LOAD_CONTROL"*) check "channel attached: skill-load sentence present" 0 ;;
  *) check "channel attached: skill-load sentence present" 1 ;;
esac
case "${GOAL_PROMPT_FRAMING:-}" in
  *"$FRAMING_CONTROL"*) check "the goal-prompt framing line names the task as the operator's own" 0 ;;
  *) check "the goal-prompt framing line names the task as the operator's own" 1 ;;
esac

# Channel not attached: the reply-tool guidance is absent, but the
# skill-load sentence must still be present - it is NO_CHANNEL-independent.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION
NO_CHANNEL=1
eval "$VARS_SNIPPET"
case "${SKILL_LOAD_INSTRUCTION:-}" in
  *"$SKILL_LOAD_CONTROL"*) check "channel not attached: skill-load sentence still present" 0 ;;
  *) check "channel not attached: skill-load sentence still present" 1 ;;
esac
if [ -z "${CHANNEL_REPLY_INSTRUCTION:-}" ]; then
  check "channel not attached: instruction is empty" 0
else
  check "channel not attached: instruction is empty" 1
fi

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
