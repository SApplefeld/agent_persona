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

SNIPPET=$(sed -n '/^  SKILL_LOAD_INSTRUCTION="/,/^  fi$/p' "$SCRIPT")
if [ -z "$SNIPPET" ]; then
  echo "FAIL: could not locate the SKILL_LOAD_INSTRUCTION/CHANNEL_REPLY_INSTRUCTION block in $SCRIPT"
  exit 1
fi

CONTROL="Never include round numbers, steer numbers, or session ids."
# v2 Section 0 item 3 Part A: the skill-load sentence must reach every
# child regardless of NO_CHANNEL - checked under both values below,
# alongside the pre-existing CHANNEL_REPLY_INSTRUCTION checks.
SKILL_LOAD_CONTROL="claude-kit:operating-instructions"

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

# Channel attached: the guidance must be present.
NO_CHANNEL=0
eval "$SNIPPET"
case "$CHANNEL_REPLY_INSTRUCTION" in
  *"$CONTROL"*) check "channel attached: prose guidance present" 0 ;;
  *) check "channel attached: prose guidance present" 1 ;;
esac
case "${SKILL_LOAD_INSTRUCTION:-}" in
  *"$SKILL_LOAD_CONTROL"*) check "channel attached: skill-load sentence present" 0 ;;
  *) check "channel attached: skill-load sentence present" 1 ;;
esac

# Channel not attached: the reply-tool guidance is absent, but the
# skill-load sentence must still be present - it is NO_CHANNEL-independent.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION
NO_CHANNEL=1
eval "$SNIPPET"
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
