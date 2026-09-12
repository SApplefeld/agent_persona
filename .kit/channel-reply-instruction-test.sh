#!/usr/bin/env bash
# channel-reply-instruction-test.sh - harness case for steer 63: the
# reply-tool prose guidance folded into bin/supervise.sh's
# CHANNEL_REPLY_INSTRUCTION must be present when a channel is attached
# (NO_CHANNEL=0) and the whole instruction absent when it is not
# (NO_CHANNEL=1). Both directions are checked so this cannot pass by
# always finding the string true. The block under test is pulled out of
# the real script by its start/end lines, not hand-copied, so this test
# reads whatever bin/supervise.sh currently says rather than a frozen guess.
# Exits 0 on all-pass, 1 on any failure.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../bin/supervise.sh"

SNIPPET=$(sed -n '/^  CHANNEL_REPLY_INSTRUCTION=""$/,/^  fi$/p' "$SCRIPT")
if [ -z "$SNIPPET" ]; then
  echo "FAIL: could not locate the CHANNEL_REPLY_INSTRUCTION block in $SCRIPT"
  exit 1
fi

CONTROL="Never include round numbers, steer numbers, or session ids."

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

# Channel not attached: the whole instruction, guidance included, is absent.
unset CHANNEL_REPLY_INSTRUCTION
NO_CHANNEL=1
eval "$SNIPPET"
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
