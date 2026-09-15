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
# boundary clause that names the kit checkpoint CLI's boundary verb, and the
# three fleet-keeper duties, each pinned by a distinctive fragment and by the
# prompt label the plugin submits it under). Every direction is checked so
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
# The three fleet-keeper duties, one distinctive fragment each rather than a
# whole paragraph, so a wording repair to the sentences around them leaves the
# pin standing while deleting a duty reds it: the tool the fleet-health duty
# reports on, the kit pass the seat duty runs, and the tool argument the
# design-escalation duty routes on. The architect fragment is the argument
# rather than the surrounding prose, so a rewording that drops the persona
# argument reds instead of passing. Each is checked present for the launch
# persona that matches COORDINATOR_PERSONA and absent for a named worker and
# for default, since a duty sentence leaking into a worker's priming would
# have workers probing the machine's registry. The fleet-health fragment is
# what that duty reports on rather than the tool it calls, since the
# design-escalation duty calls that tool too and would hold the pin up on its
# own; the tool name is carried separately, as an absence fragment and as its
# own presence case.
ROLE_FLEET_CONTROL="health class changed"
ROLE_FLEET_TOOL_CONTROL="fleet_status"
ROLE_SEAT_CONTROL="reconciliation pass"
ROLE_ARCHITECT_CONTROL="persona argument set to architect"
# Each duty runs on a prompt the plugin submits rather than on a cadence the
# persona keeps for itself. The labels are pinned beside the fragments above,
# so a duty rewritten back to a per-tick trigger loses its label and reds.
ROLE_FLEET_LABEL_CONTROL="[FLEET]"
ROLE_SEAT_LABEL_CONTROL="[RECONCILE]"
# The fourth health class. An enabled persona that never comes up holds no
# commons entry at all, so it reports a null heartbeat age and matches none of
# held, backing off or stale; without this class a dead persona goes
# unreported, which is the case the duty most exists for.
ROLE_FLEET_CLASS_CONTROL="no live claim while the roster enables it"
# agentic_say accepts a record whether or not a session holds the architect
# persona, so the duty reports a route as delivered only against a live
# architect. The undelivered branch is the half a green send would hide.
ROLE_ARCHITECT_LIVE_CONTROL="the ask is undelivered"
# The steer sentence's escalation clause, present for a worker's launch and
# absent for the coordinator's own, which cannot address itself.
STEER_ESCALATE_CONTROL="through agentic_say with persona set to"

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

# The whole text the priming write sends, which is what an absence case has to
# read. Reading COORDINATOR_ROLE_INSTRUCTION alone only repeats the adjacent
# emptiness check, since any value holding a duty fragment is non-empty; a duty
# sentence arriving through the skill-load, steer or reply variable reaches the
# worker just as surely and passes that narrower read. The variable set here is
# pinned against the real write below, so a fifth variable joining that write
# cannot leave this concatenation quietly short.
priming_concat() {
  printf '%s' "${SKILL_LOAD_INSTRUCTION:-}${COORDINATOR_STEER_INSTRUCTION:-}${COORDINATOR_ROLE_INSTRUCTION:-}${CHANNEL_REPLY_INSTRUCTION:-}"
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
# The absence cases read the four variables priming_concat joins, so the write
# itself is pinned to exactly those four in exactly that order. A fifth
# instruction variable added to the write reds here rather than passing through
# an absence case that never looks at it.
PRIMING_VARS=$(printf '%s\n' "$PRIMING_WRITE" | grep -oE '\$[A-Z_]+' | grep -vE '^\$(PRIMING_BODY|CHILD_IN)$' | tr '\n' ' ')
[ "$PRIMING_VARS" = '$SKILL_LOAD_INSTRUCTION $COORDINATOR_STEER_INSTRUCTION $COORDINATOR_ROLE_INSTRUCTION $CHANNEL_REPLY_INSTRUCTION ' ]
check "the priming write joins exactly the four instruction variables the absence cases read" $?

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
# One case per duty, so a red names the duty that went missing rather than
# the paragraph it sat in.
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the fleet-health duty is present, reporting the personas whose health class changed" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the fleet-health duty is present, reporting the personas whose health class changed" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_TOOL_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the fleet status tool is named for the on-demand read" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the fleet status tool is named for the on-demand read" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_LABEL_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the fleet-health duty runs on the [FLEET] prompt" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the fleet-health duty runs on the [FLEET] prompt" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_CLASS_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the fleet-health duty names the enabled-but-never-up health class" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the fleet-health duty names the enabled-but-never-up health class" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_SEAT_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the kit Coordinator seat duty is present, naming the reconciliation pass" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the kit Coordinator seat duty is present, naming the reconciliation pass" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_SEAT_LABEL_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the reconciliation pass runs on the [RECONCILE] prompt" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the reconciliation pass runs on the [RECONCILE] prompt" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_ARCHITECT_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the design-escalation duty is present, naming the architect persona argument" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the design-escalation duty is present, naming the architect persona argument" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_ARCHITECT_LIVE_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the design-escalation duty raises an ask no live architect received" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the design-escalation duty raises an ask no live architect received" 1 ;;
esac
# Every case above reads one fragment on its own, so reordering the three duty
# sentences leaves all of them green and deleting one reds that one alone.
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
# The emptiness check above covers the duties only while the whole instruction
# stays gated. This one reads the duty fragments against everything the priming
# write sends, so a duty sentence carried in through the skill-load, steer or
# reply variable reds here rather than slipping past a read of the role
# variable alone.
case "$(priming_concat)" in
  *"$ROLE_FLEET_CONTROL"*|*"$ROLE_FLEET_TOOL_CONTROL"*|*"$ROLE_SEAT_CONTROL"*|*"$ROLE_ARCHITECT_CONTROL"*|*"$ROLE_FLEET_LABEL_CONTROL"*|*"$ROLE_SEAT_LABEL_CONTROL"*) check "persona differs from COORDINATOR_PERSONA: no fleet-keeper duty reaches a worker through any part of the priming write" 1 ;;
  *) check "persona differs from COORDINATOR_PERSONA: no fleet-keeper duty reaches a worker through any part of the priming write" 0 ;;
esac

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
# Three cases rather than one ordered pattern: an ordered match reds on a
# reordering of the duty sentences, which changes nothing about what reaches
# the persona, and it names the paragraph rather than the missing duty.
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_CONTROL"*) check "channel not attached, persona matches: the fleet-health duty is present" 0 ;;
  *) check "channel not attached, persona matches: the fleet-health duty is present" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_SEAT_CONTROL"*) check "channel not attached, persona matches: the kit Coordinator seat duty is present" 0 ;;
  *) check "channel not attached, persona matches: the kit Coordinator seat duty is present" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_ARCHITECT_CONTROL"*) check "channel not attached, persona matches: the design-escalation duty is present" 0 ;;
  *) check "channel not attached, persona matches: the design-escalation duty is present" 1 ;;
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
case "$(priming_concat)" in
  *"$ROLE_FLEET_CONTROL"*|*"$ROLE_FLEET_TOOL_CONTROL"*|*"$ROLE_SEAT_CONTROL"*|*"$ROLE_ARCHITECT_CONTROL"*|*"$ROLE_FLEET_LABEL_CONTROL"*|*"$ROLE_SEAT_LABEL_CONTROL"*) check "channel attached, COORDINATOR_PERSONA differs: no fleet-keeper duty reaches the priming write" 1 ;;
  *) check "channel attached, COORDINATOR_PERSONA differs: no fleet-keeper duty reaches the priming write" 0 ;;
esac
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
# A default-persona launch is the other side the duties must not reach: it
# holds no named owner claim, so a fleet probe or a design escalation from it
# would be refused by the reach rule anyway.
case "$(priming_concat)" in
  *"$ROLE_FLEET_CONTROL"*|*"$ROLE_FLEET_TOOL_CONTROL"*|*"$ROLE_SEAT_CONTROL"*|*"$ROLE_ARCHITECT_CONTROL"*|*"$ROLE_FLEET_LABEL_CONTROL"*|*"$ROLE_SEAT_LABEL_CONTROL"*) check "default persona: no fleet-keeper duty reaches the priming write" 1 ;;
  *) check "default persona: no fleet-keeper duty reaches the priming write" 0 ;;
esac
if [ -z "${COORDINATOR_ROLE_INSTRUCTION:-}" ]; then
  check "default persona: coordinator role instruction is empty" 0
else
  check "default persona: coordinator role instruction is empty" 1
fi

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
