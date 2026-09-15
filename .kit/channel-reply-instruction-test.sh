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
# prompt label the plugin submits it under) plus the architect's own charter
# (ARCHITECT_ROLE_INSTRUCTION, present when the launch persona equals
# ARCHITECT_PERSONA and empty otherwise, including for every persona while
# that setting is unset, riding the same priming write and pinned one clause
# at a time). Every direction is checked so
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
# assignments, which is dropped from the range: five `if ... fi` blocks sit
# inside it (the worker-launch guard around the steer sentence's escalation
# clause, the NO_CHANNEL guard around CHANNEL_REPLY_INSTRUCTION, the
# COORDINATOR_PERSONA guard around COORDINATOR_ROLE_INSTRUCTION, the
# ARCHITECT_PERSONA guard around the design-escalation clause nested inside it,
# and the ARCHITECT_PERSONA guard around ARCHITECT_ROLE_INSTRUCTION), so the
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
# argument reds instead of passing, and it is read as an ordered pair with the
# ARCHITECT_PERSONA of the eval, since the routing target is built from that
# setting and a hardcoded name reaches a persona nothing holds. Each is checked present for the launch
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
# One literal for the agentic_say persona argument, shared by the steward's
# design-escalation duty and by the architect's own answer clause, which are two
# sends of the same shape. The coupling binds every absence case that reads it:
# a case asserting this fragment absent proves the duty absent only while the
# architect's charter is unbuilt in that eval, so an eval whose launch persona
# matches ARCHITECT_PERSONA reads the duty by another fragment.
SAY_PERSONA_ARG_CONTROL="the persona argument set to"
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
# The kinds of ask the duty routes. The plan's Goal names five kinds of
# architect work, and the finishing judgment is the one a shorter list leaves
# unrouted, so it is the fragment pinned. The list ends open as well, since a
# closed list reads as exhaustive to the persona following it.
ROLE_ARCHITECT_KINDS_CONTROL="the finishing judgment on a high-stakes effort"
ROLE_ARCHITECT_KINDS_OPEN_CONTROL="A design ask none of those names goes to the architect as well"
# The five classes as one literal, so a class dropped or renamed reds here
# while the per-class pins below stay readable. The fourth class is pinned
# again on its own above, since it is the one a green fleet never exercises.
ROLE_FLEET_CLASSES_CONTROL="The health classes are held, backing off, stale, no live claim while the roster enables it, and healthy."
# The fleet status tool reports claimHeld false in two unlike situations: a
# persona with no commons entry, whose heartbeat age is null, and a persona
# whose session died leaving its entry behind, whose heartbeat age is a number.
# Each is routed to its own class by name, and the pins are ordered pairs so
# that a rewrite which keeps the condition but renames the class reds here.
ROLE_FLEET_NULL_CONTROL="whose heartbeat age is null"
ROLE_FLEET_STALE_CONTROL="holds no live claim but reports a heartbeat age"
ROLE_FLEET_STALE_CLASS_CONTROL="it is stale"
# The tool's action field carries values the five classes do not name, stopped
# and relaunching and unknown among them, so the duty says the field is the
# keeper's record rather than a class and routes the off-list values by the
# claim and heartbeat the two sentences above already read. This is an ordered
# pair for the same reason the two above are: a rewrite that keeps the routing
# and drops the statement that the field is not a class reds here.
ROLE_FLEET_ACTION_CONTROL="is not itself a health class"
ROLE_FLEET_ACTION_ROUTE_CONTROL="A row reading stopped or unknown"
# The fleet duty tells the persona it polls the fleet at no point, so every
# call the other duties make is named beside that duty's own carve-out. The
# carve-out is bounded by the instruction rather than closed at two cases, and
# it names the two this duty makes. The architect liveness check is named in the
# design duty rather than here, since that duty is built only on a fleet that
# names an architect, and a carve-out closed at two would contradict it: a
# persona honouring the closed reading skips the liveness check and reports an
# undelivered ask as routed. The two-case sentence and the cases it names are
# pinned separately, so a carve-out that keeps the bound and drops the cases
# reds on its own line.
ROLE_FLEET_CARVEOUT_CONTROL="checking whether the architect is live"
ROLE_FLEET_CARVEOUT_TWO_CONTROL="You call fleet_status only in the cases this instruction names, and none of them is polling."
ROLE_FLEET_CARVEOUT_CASES_CONTROL="The operator asks for fleet state, and you need the whole picture behind a change."
# fleet_status returns rows only for the personas the roster carries, and
# returns no rows at all with a top-level problem while the fleetRoster setting
# names no roster. Neither reply says the architect is not live, so the duty
# separates that answer from an architect row that holds no claim: the record
# was written either way, and only the row proves nobody received it.
ROLE_ARCHITECT_NOROW_CONTROL="no row for that persona at all"
ROLE_ARCHITECT_UNCONFIRMED_CONTROL="its delivery is unconfirmed"
# Section 2: the architect's own standing instruction, gated on the launch
# persona matching ARCHITECT_PERSONA. One fragment per clause of its charter,
# so a red names the clause that went missing: the seat itself, the two ways
# an ask arrives, the worktree rule, the clone the worktree is cut from, the
# commit-and-report rule, the ask that names no repository, the steer rule this
# seat overrides, and the never-execute rule. None of these strings appears in the coordinator's own
# instruction, so the absence cases below read the architect's charter alone.
# ARCHITECT_PERSONA carries no default, so the unset cases prove that a fleet
# naming no architect builds this instruction for no persona at all.
ARCH_SEAT_CONTROL="design work only"
ARCH_ASK_CONTROL="normally reaches you in one of two ways"
# The two ways are how a design ask arrives and not the only text that reaches
# the seat: a reader session delivers a [READER:<persona> ...] record and the
# supervisor writes a launch prompt as a second turn. The charter places that
# text rather than denying it exists, so this fragment is read beside the two
# ways above.
ARCH_OTHER_PATH_CONTROL="is information rather than an ask"
ARCH_WORKTREE_CONTROL="cut a worktree of that repository under your own directory"
ARCH_REPORT_CONTROL="report the branch and the filename"
ARCH_NEVER_CONTROL="never execute a plan you write"
# Half the architect's work produces no file: a plan review, a consult and a
# finishing judgment are answered in the record or on its own channel. The
# worktree, commit and report rules above are scoped to the other half, so this
# fragment is what keeps them from reading as a rule for every ask.
ARCH_NOFILE_CONTROL="you cut no branch for it"
# An ask that produces a file and names no repository has no worktree to go in,
# and the charter has just said this persona's own directory is not a
# repository, so the charter says where that file lands.
ARCH_NOREPO_CONTROL="names no repository is worked under your own directory"
# git worktree add runs inside an existing clone, and the only other clones on
# the machine are the checkouts live personas commit in, so the charter says
# which clone the architect cuts from. The clone is taken from the repository's
# remote URL, since a clone of a local checkout shares that checkout's object
# store and carries it as origin: the push then lands inside another persona's
# repository and never reaches the remote, which is the shape a green push
# hides. The fetch is pinned beside it, because a clone made once and never
# refreshed branches every later spec off a stale trunk.
ARCH_CLONE_CONTROL="cloning its remote URL under your own directory"
ARCH_CLONE_EXCLUSIVE_CONTROL="never from a checkout another persona is working in"
ARCH_FETCH_CONTROL="fetch that clone before each ask"
# A repository name travels to this seat inside a record, which can carry
# content a worker read rather than the operator's own words, and the push runs
# under the machine's stored credentials. The charter names the clone target
# and the remote before the push for that reason.
ARCH_PUSH_BOUND_CONTROL="you name the clone target and the remote the push goes to"
# The report clause names the operator, and the charter is built independently
# of NO_CHANNEL, so a launch with no channel has no reply tool to report
# through. The fallback is the coordinator persona, the hop the steer sentence
# already uses for its own operator leg.
ARCH_NOCHANNEL_CONTROL="Where no channel is attached, your record to the coordinator persona is the whole report"
# The skill-load sentence rides this same priming write and sends every session
# to the kit's plan-execution skill before plan work. Writing a spec is plan
# work, so without this clause the charter's own never-execute rule is
# contradicted by the sentence above it. The charter names the skills a design
# ask takes instead, in the shape the steer override beside it uses.
ARCH_SKILLS_CONTROL="claude-kit:brainstorming"
ARCH_SKILLS_OVERRIDE_CONTROL="That leg of it does not govern you either"
# The steer sentence rides every priming write, including this one, and tells a
# persona to put a [COORDINATOR ...] prompt that ties to no goal node to the
# operator or to decline it. This seat holds no plan and no goal node, so the
# charter names that rule and overrides it; without this clause the architect
# bounces every ask the coordinator persona routes.
ARCH_STEER_CONTROL="your own work item"
# The architect answers the coordinator persona by name, the way a worker
# does, so the send names the same value the reach rule matches on. It uses
# SAY_PERSONA_ARG_CONTROL, the literal the steward's own routing duty carries.
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
  printf '%s' "${SKILL_LOAD_INSTRUCTION:-}${COORDINATOR_STEER_INSTRUCTION:-}${COORDINATOR_ROLE_INSTRUCTION:-}${ARCHITECT_ROLE_INSTRUCTION:-}${CHANNEL_REPLY_INSTRUCTION:-}"
}

# Every persona name the priming write splices in, read as a class rather than
# as the list of names the source happens to carry. Two shapes carry one: the
# agentic_say target the design duty and the architect's answer clause name, and
# the fleet row the liveness check reads back. Each must be the eval's own
# COORDINATOR_PERSONA or ARCHITECT_PERSONA, both withheld from every literal
# bin/supervise.sh carries, so a seat name hardcoded at any of those sites reds
# here whatever clause it sits in. A pin naming the two sites it knows about
# would answer for those two and stay silent on the next one.
check_spliced_names() {  # <label>
  local label="$1" name count=0 bad=""
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    count=$((count + 1))
    case "$name" in
      "${ARCHITECT_PERSONA:-}"|"${COORDINATOR_PERSONA:-}") ;;
      *) bad="$bad [$name]" ;;
    esac
  done <<EOF
$(priming_concat | grep -o "$SAY_PERSONA_ARG_CONTROL [^,]*," | sed "s/^$SAY_PERSONA_ARG_CONTROL //; s/,\$//")
$(priming_concat | grep -o "the row for [^ ]*" | sed 's/^the row for //')
EOF
  [ "$count" -ge 1 ] && [ -z "$bad" ]
  check "$label (names spliced=$count, off-class=$bad)" "$?"
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
# The architect's own instruction rides that same priming write, for the same
# reason: the value checks below read the variable and never the call site.
case "$PRIMING_WRITE" in
  *ARCHITECT_ROLE_INSTRUCTION*) check "the priming write carries the architect role instruction" 0 ;;
  *) check "the priming write carries the architect role instruction" 1 ;;
esac
case "$GOAL_WRITE" in
  *ARCHITECT_ROLE_INSTRUCTION*) check "the goal-prompt write does not carry the architect role instruction" 1 ;;
  *GOAL_PROMPT_FRAMING*) check "the goal-prompt write does not carry the architect role instruction" 0 ;;
  *) check "the goal-prompt write does not carry the architect role instruction" 1 ;;
esac
# The absence cases read the five variables priming_concat joins, so the write
# itself is pinned to exactly those five in exactly that order. A sixth
# instruction variable added to the write reds here rather than passing through
# an absence case that never looks at it.
PRIMING_VARS=$(printf '%s\n' "$PRIMING_WRITE" | grep -oE '\$[A-Z_]+' | grep -vE '^\$(PRIMING_BODY|CHILD_IN)$' | tr '\n' ' ')
[ "$PRIMING_VARS" = '$SKILL_LOAD_INSTRUCTION $COORDINATOR_STEER_INSTRUCTION $COORDINATOR_ROLE_INSTRUCTION $ARCHITECT_ROLE_INSTRUCTION $CHANNEL_REPLY_INSTRUCTION ' ]
check "the priming write joins exactly the five instruction variables the absence cases read" $?

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
# the launch persona equals COORDINATOR_PERSONA. The fleet names an architect,
# and the name warden is withheld from every literal bin/supervise.sh carries,
# so the routing clause's target is proven to come from the setting.
NO_CHANNEL=0
PERSONA="lead"
COORDINATOR_PERSONA="lead"
ARCHITECT_PERSONA="warden"
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
  *"$SAY_PERSONA_ARG_CONTROL"*"$ARCHITECT_PERSONA"*) check "persona matches COORDINATOR_PERSONA: the design-escalation duty is present, routing to the ARCHITECT_PERSONA name" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the design-escalation duty is present, routing to the ARCHITECT_PERSONA name" 1 ;;
esac
# The same target read adjacently. The case above is an ordered pair, and a
# case glob matches its parts with arbitrary text between them, so the fleet
# row's own interpolation of the same name satisfies it on its own: reverting
# this target to a literal seat name leaves that pair green. The comma belongs
# to the literal, so a match cannot run past the argument into the sentence
# behind it.
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$SAY_PERSONA_ARG_CONTROL $ARCHITECT_PERSONA,"*) check "persona matches COORDINATOR_PERSONA: the agentic_say target is the ARCHITECT_PERSONA name itself" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the agentic_say target is the ARCHITECT_PERSONA name itself" 1 ;;
esac
check_spliced_names "persona matches COORDINATOR_PERSONA: every persona name in the priming write comes from the settings"
# The row the duty reads for a liveness answer is named from the same setting,
# so a steward on a fleet whose design seat carries another name still knows
# which row is the architect's.
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"the row for $ARCHITECT_PERSONA"*) check "persona matches COORDINATOR_PERSONA: the liveness check names the architect's own row by the ARCHITECT_PERSONA name" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the liveness check names the architect's own row by the ARCHITECT_PERSONA name" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_ARCHITECT_LIVE_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the design-escalation duty raises an ask no live architect received" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the design-escalation duty raises an ask no live architect received" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_CLASSES_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the five health classes are named in the plan's own words" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the five health classes are named in the plan's own words" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_NULL_CONTROL"*"$ROLE_FLEET_CLASS_CONTROL"*) check "persona matches COORDINATOR_PERSONA: a null heartbeat age is routed to the no-live-claim class by that class's own name" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: a null heartbeat age is routed to the no-live-claim class by that class's own name" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_STALE_CONTROL"*"$ROLE_FLEET_STALE_CLASS_CONTROL"*) check "persona matches COORDINATOR_PERSONA: a persona whose entry outlived its session is routed to the stale class" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: a persona whose entry outlived its session is routed to the stale class" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_ACTION_CONTROL"*"$ROLE_FLEET_ACTION_ROUTE_CONTROL"*) check "persona matches COORDINATOR_PERSONA: an action the five classes do not name is routed by the claim and heartbeat rather than reported as a class" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: an action the five classes do not name is routed by the claim and heartbeat rather than reported as a class" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_CARVEOUT_TWO_CONTROL"*"$ROLE_FLEET_CARVEOUT_CASES_CONTROL"*"$ROLE_FLEET_CARVEOUT_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the carve-out is bounded by the instruction, names its two cases, and the design duty names the liveness check after them" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the carve-out is bounded by the instruction, names its two cases, and the design duty names the liveness check after them" 1 ;;
esac
# The kinds of ask the design duty routes. The finishing judgment is read on its
# own because a shorter closed list drops it, and the open ending is read beside
# it because a closed list of any length reads as exhaustive.
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_ARCHITECT_KINDS_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the design-escalation duty routes a finishing judgment" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the design-escalation duty routes a finishing judgment" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_ARCHITECT_KINDS_OPEN_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the kinds the design-escalation duty names are not a closed list" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: the kinds the design-escalation duty names are not a closed list" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_ARCHITECT_NOROW_CONTROL"*"$ROLE_ARCHITECT_UNCONFIRMED_CONTROL"*) check "persona matches COORDINATOR_PERSONA: a reply carrying no architect row is reported as sent with delivery unconfirmed" 0 ;;
  *) check "persona matches COORDINATOR_PERSONA: a reply carrying no architect row is reported as sent with delivery unconfirmed" 1 ;;
esac
# The coordinator persona's own launch is one of the personas the architect
# setting must not reach, and the read is over the whole priming write rather
# than the architect variable alone, so a charter clause arriving through any
# other variable reds here too.
if [ -z "${ARCHITECT_ROLE_INSTRUCTION:-}" ]; then
  check "persona matches COORDINATOR_PERSONA: architect role instruction is empty" 0
else
  check "persona matches COORDINATOR_PERSONA: architect role instruction is empty" 1
fi
case "$(priming_concat)" in
  *"$ARCH_SEAT_CONTROL"*|*"$ARCH_ASK_CONTROL"*|*"$ARCH_WORKTREE_CONTROL"*|*"$ARCH_REPORT_CONTROL"*|*"$ARCH_NEVER_CONTROL"*|*"$ARCH_NOREPO_CONTROL"*|*"$ARCH_CLONE_CONTROL"*|*"$ARCH_STEER_CONTROL"*|*"$ARCH_OTHER_PATH_CONTROL"*|*"$ARCH_FETCH_CONTROL"*|*"$ARCH_PUSH_BOUND_CONTROL"*|*"$ARCH_NOCHANNEL_CONTROL"*|*"$ARCH_SKILLS_CONTROL"*) check "persona matches COORDINATOR_PERSONA: no architect charter reaches the priming write" 1 ;;
  *) check "persona matches COORDINATOR_PERSONA: no architect charter reaches the priming write" 0 ;;
esac
# Every case above reads one fragment on its own, so reordering the three duty
# sentences leaves all of them green and deleting one reds that one alone.
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_ESCALATE_CONTROL"*) check "persona matches COORDINATOR_PERSONA: the steer sentence carries no escalation-to-coordinator clause" 1 ;;
  *) check "persona matches COORDINATOR_PERSONA: the steer sentence carries no escalation-to-coordinator clause" 0 ;;
esac

# The same coordinator launch on a fleet that names no architect. The routing
# clause is built from ARCHITECT_PERSONA, so with no name there is nowhere to
# route: the whole clause is withheld rather than sending every design ask to a
# persona nothing holds. The other two duties are read here as well, since a
# clause dropped from the middle of the instruction must not take them with it.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION ARCHITECT_PERSONA
NO_CHANNEL=0
PERSONA="lead"
COORDINATOR_PERSONA="lead"
eval "$VARS_SNIPPET"
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$SAY_PERSONA_ARG_CONTROL"*|*"$ROLE_ARCHITECT_LIVE_CONTROL"*|*"$ROLE_ARCHITECT_NOROW_CONTROL"*|*"$ROLE_ARCHITECT_KINDS_CONTROL"*|*"$ROLE_FLEET_CARVEOUT_CONTROL"*) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: no design-escalation clause is built" 1 ;;
  *) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: no design-escalation clause is built" 0 ;;
esac
# The liveness check rides the design clause above, so a fleet with no architect
# is left with the carve-out naming the two calls its own duties make and no
# case for a call nothing tells it to place.
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_CARVEOUT_TWO_CONTROL"*"$ROLE_FLEET_CARVEOUT_CASES_CONTROL"*) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: the carve-out still names its two cases" 0 ;;
  *) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: the carve-out still names its two cases" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_FLEET_CONTROL"*) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: the fleet-health duty still stands" 0 ;;
  *) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: the fleet-health duty still stands" 1 ;;
esac
case "${COORDINATOR_ROLE_INSTRUCTION:-}" in
  *"$ROLE_SEAT_CONTROL"*) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: the kit Coordinator seat duty still stands" 0 ;;
  *) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: the kit Coordinator seat duty still stands" 1 ;;
esac
case "$(priming_concat)" in
  *"$ARCH_SEAT_CONTROL"*|*"$ARCH_ASK_CONTROL"*|*"$ARCH_WORKTREE_CONTROL"*|*"$ARCH_REPORT_CONTROL"*|*"$ARCH_NEVER_CONTROL"*|*"$ARCH_NOREPO_CONTROL"*|*"$ARCH_CLONE_CONTROL"*|*"$ARCH_STEER_CONTROL"*|*"$ARCH_OTHER_PATH_CONTROL"*|*"$ARCH_FETCH_CONTROL"*|*"$ARCH_PUSH_BOUND_CONTROL"*|*"$ARCH_NOCHANNEL_CONTROL"*|*"$ARCH_SKILLS_CONTROL"*) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: no architect charter reaches the priming write" 1 ;;
  *) check "ARCHITECT_PERSONA unset, persona matches COORDINATOR_PERSONA: no architect charter reaches the priming write" 0 ;;
esac

# Channel not attached: the reply-tool guidance is absent, but the
# skill-load sentence and the coordinator steer sentence must still be
# present - both are NO_CHANNEL-independent. This eval is also the control
# for the coordinator's own instruction: an ordinary worker's launch, whose
# persona differs from COORDINATOR_PERSONA, gets none of it.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION
NO_CHANNEL=1
PERSONA="worker"
COORDINATOR_PERSONA="lead"
ARCHITECT_PERSONA="warden"
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
  *"$ROLE_FLEET_CONTROL"*|*"$ROLE_FLEET_TOOL_CONTROL"*|*"$ROLE_SEAT_CONTROL"*|*"$SAY_PERSONA_ARG_CONTROL"*|*"$ROLE_FLEET_LABEL_CONTROL"*|*"$ROLE_SEAT_LABEL_CONTROL"*|*"$ROLE_FLEET_CLASS_CONTROL"*|*"$ROLE_FLEET_ACTION_ROUTE_CONTROL"*|*"$ROLE_ARCHITECT_LIVE_CONTROL"*) check "persona differs from COORDINATOR_PERSONA: no fleet-keeper duty reaches a worker through any part of the priming write" 1 ;;
  *) check "persona differs from COORDINATOR_PERSONA: no fleet-keeper duty reaches a worker through any part of the priming write" 0 ;;
esac

# The two evals above move NO_CHANNEL and the persona match together, so a
# role assignment nested inside the NO_CHANNEL guard would pass both. These
# two vary one axis each: no channel with a matching persona must still
# carry the instruction, and a channel with a mismatched COORDINATOR_PERSONA
# must not.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION
NO_CHANNEL=1
PERSONA="lead"
COORDINATOR_PERSONA="lead"
ARCHITECT_PERSONA="warden"
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
  *"$SAY_PERSONA_ARG_CONTROL"*"$ARCHITECT_PERSONA"*) check "channel not attached, persona matches: the design-escalation duty is present, routing to the ARCHITECT_PERSONA name" 0 ;;
  *) check "channel not attached, persona matches: the design-escalation duty is present, routing to the ARCHITECT_PERSONA name" 1 ;;
esac
check_spliced_names "channel not attached, persona matches: every persona name in the priming write comes from the settings"
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_ESCALATE_CONTROL"*) check "channel not attached, persona matches: the steer sentence carries no escalation-to-coordinator clause" 1 ;;
  *) check "channel not attached, persona matches: the steer sentence carries no escalation-to-coordinator clause" 0 ;;
esac
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION
NO_CHANNEL=0
PERSONA="lead"
COORDINATOR_PERSONA="worker"
ARCHITECT_PERSONA="warden"
eval "$VARS_SNIPPET"
if [ -z "${COORDINATOR_ROLE_INSTRUCTION:-}" ]; then
  check "channel attached, COORDINATOR_PERSONA differs: coordinator role instruction is empty" 0
else
  check "channel attached, COORDINATOR_PERSONA differs: coordinator role instruction is empty" 1
fi
case "$(priming_concat)" in
  *"$ROLE_FLEET_CONTROL"*|*"$ROLE_FLEET_TOOL_CONTROL"*|*"$ROLE_SEAT_CONTROL"*|*"$SAY_PERSONA_ARG_CONTROL"*|*"$ROLE_FLEET_LABEL_CONTROL"*|*"$ROLE_SEAT_LABEL_CONTROL"*|*"$ROLE_FLEET_CLASS_CONTROL"*|*"$ROLE_FLEET_ACTION_ROUTE_CONTROL"*|*"$ROLE_ARCHITECT_LIVE_CONTROL"*) check "channel attached, COORDINATOR_PERSONA differs: no fleet-keeper duty reaches the priming write" 1 ;;
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
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION
NO_CHANNEL=1
PERSONA="default"
COORDINATOR_PERSONA="lead"
ARCHITECT_PERSONA="warden"
eval "$VARS_SNIPPET"
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_ESCALATE_CONTROL"*) check "default persona: the steer sentence carries no escalation-to-coordinator clause" 1 ;;
  *) check "default persona: the steer sentence carries no escalation-to-coordinator clause" 0 ;;
esac
# A default-persona launch is the other side the duties must not reach: it
# holds no named owner claim, so a fleet probe or a design escalation from it
# would be refused by the reach rule anyway.
case "$(priming_concat)" in
  *"$ROLE_FLEET_CONTROL"*|*"$ROLE_FLEET_TOOL_CONTROL"*|*"$ROLE_SEAT_CONTROL"*|*"$SAY_PERSONA_ARG_CONTROL"*|*"$ROLE_FLEET_LABEL_CONTROL"*|*"$ROLE_SEAT_LABEL_CONTROL"*|*"$ROLE_FLEET_CLASS_CONTROL"*|*"$ROLE_FLEET_ACTION_ROUTE_CONTROL"*|*"$ROLE_ARCHITECT_LIVE_CONTROL"*) check "default persona: no fleet-keeper duty reaches the priming write" 1 ;;
  *) check "default persona: no fleet-keeper duty reaches the priming write" 0 ;;
esac
if [ -z "${COORDINATOR_ROLE_INSTRUCTION:-}" ]; then
  check "default persona: coordinator role instruction is empty" 0
else
  check "default persona: coordinator role instruction is empty" 1
fi

# Section 2: the architect's charter, gated on ARCHITECT_PERSONA the way the
# coordinator's is gated on COORDINATOR_PERSONA. The matching eval below holds
# a persona that is neither the coordinator's nor default, which is what an
# architect launch is, and the name vellum is withheld from every literal
# bin/supervise.sh carries so the gate is proven on the comparison. The
# coordinator name here is quill, withheld from every literal in both files, so
# the answer clause's name pin below cannot pass on a string the source carries.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION
NO_CHANNEL=0
PERSONA="vellum"
COORDINATOR_PERSONA="quill"
ARCHITECT_PERSONA="vellum"
eval "$VARS_SNIPPET"
# One case per charter clause, so a red names the clause that went missing
# rather than the paragraph it sat in.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_SEAT_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the architect instruction is present, naming the design seat" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the architect instruction is present, naming the design seat" 1 ;;
esac
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_ASK_CONTROL"*"$STEER_LABEL_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the two ways an ask arrives are named, one of them the coordinator record's label" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the two ways an ask arrives are named, one of them the coordinator record's label" 1 ;;
esac
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_WORKTREE_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the worktree rule is present" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the worktree rule is present" 1 ;;
esac
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_REPORT_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the commit-and-report rule is present" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the commit-and-report rule is present" 1 ;;
esac
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_NEVER_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the never-execute rule is present" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the never-execute rule is present" 1 ;;
esac
# The worktree, commit and report rules cover an ask whose product is a file.
# A review, a consult and a judgment produce none, and are answered with no
# branch at all, so the charter carries that half too.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_NOFILE_CONTROL"*) check "persona matches ARCHITECT_PERSONA: an ask that produces no file is answered with no branch" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: an ask that produces no file is answered with no branch" 1 ;;
esac
# The third product shape: an ask that does produce a file and names no
# repository, which the worktree rule and the no-file rule both leave out.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_NOREPO_CONTROL"*) check "persona matches ARCHITECT_PERSONA: a file-producing ask that names no repository has a place to land" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: a file-producing ask that names no repository has a place to land" 1 ;;
esac
# The clone the worktree is cut from, read as an ordered pair with the exclusion
# so a charter that says where the repository comes from and drops the exclusion
# reds here: the machine's other clones are checkouts live personas commit in.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_CLONE_CONTROL"*"$ARCH_CLONE_EXCLUSIVE_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the worktree is cut from a clone of the architect's own" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the worktree is cut from a clone of the architect's own" 1 ;;
esac
# The steer sentence is built for every launch, this one included, and it tells
# a persona to put a [COORDINATOR ...] prompt that ties to no goal node to the
# operator or decline it. Read as an ordered pair with the steer label, so the
# override is pinned to the rule it overrides rather than to a loose phrase.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$STEER_LABEL_CONTROL"*"$ARCH_STEER_CONTROL"*) check "persona matches ARCHITECT_PERSONA: a coordinator record is this seat's work item rather than a steer to put to the operator" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: a coordinator record is this seat's work item rather than a steer to put to the operator" 1 ;;
esac
# The rule the clause overrides is present in the same priming write, so the
# contradiction the clause settles is real rather than assumed. The steer
# sentence is read by the label it teaches rather than by a sentence of its own
# prose: that wording belongs to no section of this plan, and pinning it here
# would red on a later effort's defect-free rewording of it.
case "${COORDINATOR_STEER_INSTRUCTION:-}" in
  *"$STEER_LABEL_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the steer rule the charter overrides rides the same priming write" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the steer rule the charter overrides rides the same priming write" 1 ;;
esac
[ -n "${COORDINATOR_STEER_INSTRUCTION:-}" ]
check "persona matches ARCHITECT_PERSONA: the steer sentence itself is non-empty on this launch" "$?"
# The skill-load sentence rides this write too and sends every session to the
# kit's plan-execution skill before plan work, which is what writing a spec is.
# Read as an ordered pair with the override, so the charter names the rule it
# overrides rather than naming three skills beside a sentence it never answers.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_SKILLS_OVERRIDE_CONTROL"*"$ARCH_SKILLS_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the charter overrides the skill-load sentence's plan-execution leg and names the design skills" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the charter overrides the skill-load sentence's plan-execution leg and names the design skills" 1 ;;
esac
case "${SKILL_LOAD_INSTRUCTION:-}" in
  *"claude-kit:executing-work"*) check "persona matches ARCHITECT_PERSONA: the plan-execution skill the charter overrides is named in the same priming write" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the plan-execution skill the charter overrides is named in the same priming write" 1 ;;
esac
# The clone is refreshed before each ask, so a branch cut months after the clone
# was taken still starts from a current trunk.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_FETCH_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the clone is fetched before each ask" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the clone is fetched before each ask" 1 ;;
esac
# A repository name can arrive inside a record rather than from the operator,
# and the push runs under the machine's stored credentials.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_PUSH_BOUND_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the clone target and the remote are named before the push" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the clone target and the remote are named before the push" 1 ;;
esac
# The report clause names the operator and the charter is NO_CHANNEL-
# independent, so the fallback for a launch with no reply tool rides it.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_NOCHANNEL_CONTROL"*) check "persona matches ARCHITECT_PERSONA: the report clause carries its no-channel fallback" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the report clause carries its no-channel fallback" 1 ;;
esac
# The two ways an ask arrives are how a design ask normally comes, not a claim
# that no other text reaches the seat: a reader session's record and the launch
# prompt both do.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_OTHER_PATH_CONTROL"*) check "persona matches ARCHITECT_PERSONA: text arriving any other way is placed rather than denied" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: text arriving any other way is placed rather than denied" 1 ;;
esac
check_spliced_names "persona matches ARCHITECT_PERSONA: every persona name in the priming write comes from the settings"
# An ordered pair, so an answer clause that keeps agentic_say and drops the
# coordinator persona's own name reds here: the name is what the reach rule
# matches on, and a hardcoded one reaches a persona nothing holds.
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ROLE_SAY_CONTROL"*"$SAY_PERSONA_ARG_CONTROL"*"$COORDINATOR_PERSONA"*) check "persona matches ARCHITECT_PERSONA: the architect answers the coordinator persona by name" 0 ;;
  *) check "persona matches ARCHITECT_PERSONA: the architect answers the coordinator persona by name" 1 ;;
esac
# The architect is not the coordinator persona, so it gets none of the
# coordinator's own instruction beside its charter.
if [ -z "${COORDINATOR_ROLE_INSTRUCTION:-}" ]; then
  check "persona matches ARCHITECT_PERSONA: coordinator role instruction is empty" 0
else
  check "persona matches ARCHITECT_PERSONA: coordinator role instruction is empty" 1
fi

# The charter is NO_CHANNEL-independent, like every other part of the priming
# write: an architect launched with no channel still knows what it is.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION
NO_CHANNEL=1
PERSONA="vellum"
COORDINATOR_PERSONA="lead"
ARCHITECT_PERSONA="vellum"
eval "$VARS_SNIPPET"
case "${ARCHITECT_ROLE_INSTRUCTION:-}" in
  *"$ARCH_SEAT_CONTROL"*"$ARCH_NEVER_CONTROL"*) check "channel not attached, persona matches ARCHITECT_PERSONA: the architect instruction is present" 0 ;;
  *) check "channel not attached, persona matches ARCHITECT_PERSONA: the architect instruction is present" 1 ;;
esac

# A named worker launched on a fleet that does name an architect. This is the
# direction a mis-set persona name would break: the charter reaching a session
# that holds a plan to execute.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION
NO_CHANNEL=0
PERSONA="worker"
COORDINATOR_PERSONA="lead"
ARCHITECT_PERSONA="vellum"
eval "$VARS_SNIPPET"
if [ -z "${ARCHITECT_ROLE_INSTRUCTION:-}" ]; then
  check "persona differs from ARCHITECT_PERSONA: architect role instruction is empty" 0
else
  check "persona differs from ARCHITECT_PERSONA: architect role instruction is empty" 1
fi
case "$(priming_concat)" in
  *"$ARCH_SEAT_CONTROL"*|*"$ARCH_ASK_CONTROL"*|*"$ARCH_WORKTREE_CONTROL"*|*"$ARCH_REPORT_CONTROL"*|*"$ARCH_NEVER_CONTROL"*|*"$ARCH_NOREPO_CONTROL"*|*"$ARCH_CLONE_CONTROL"*|*"$ARCH_STEER_CONTROL"*|*"$ARCH_OTHER_PATH_CONTROL"*|*"$ARCH_FETCH_CONTROL"*|*"$ARCH_PUSH_BOUND_CONTROL"*|*"$ARCH_NOCHANNEL_CONTROL"*|*"$ARCH_SKILLS_CONTROL"*) check "persona differs from ARCHITECT_PERSONA: no charter clause reaches a worker through any part of the priming write" 1 ;;
  *) check "persona differs from ARCHITECT_PERSONA: no charter clause reaches a worker through any part of the priming write" 0 ;;
esac

# The coordinator persona on that same fleet holds the other named seat, and
# the two instructions are gated on different settings, so it gets its own and
# not the architect's.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION
NO_CHANNEL=0
PERSONA="lead"
COORDINATOR_PERSONA="lead"
ARCHITECT_PERSONA="vellum"
eval "$VARS_SNIPPET"
if [ -z "${ARCHITECT_ROLE_INSTRUCTION:-}" ] && [ -n "${COORDINATOR_ROLE_INSTRUCTION:-}" ]; then
  check "the coordinator persona on a fleet naming an architect gets its own instruction and not the architect's" 0
else
  check "the coordinator persona on a fleet naming an architect gets its own instruction and not the architect's" 1
fi

# ARCHITECT_PERSONA unset is a fleet with no architect, and it builds the
# charter for no persona at all: not for the very name an architect launch
# would carry, and not for default. The setting has no default value, unlike
# COORDINATOR_PERSONA, so there is nothing for an unset launch to match.
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION ARCHITECT_PERSONA
NO_CHANNEL=0
PERSONA="vellum"
COORDINATOR_PERSONA="lead"
eval "$VARS_SNIPPET"
case "$(priming_concat)" in
  *"$ARCH_SEAT_CONTROL"*|*"$ARCH_ASK_CONTROL"*|*"$ARCH_WORKTREE_CONTROL"*|*"$ARCH_REPORT_CONTROL"*|*"$ARCH_NEVER_CONTROL"*|*"$ARCH_NOREPO_CONTROL"*|*"$ARCH_CLONE_CONTROL"*|*"$ARCH_STEER_CONTROL"*|*"$ARCH_OTHER_PATH_CONTROL"*|*"$ARCH_FETCH_CONTROL"*|*"$ARCH_PUSH_BOUND_CONTROL"*|*"$ARCH_NOCHANNEL_CONTROL"*|*"$ARCH_SKILLS_CONTROL"*) check "ARCHITECT_PERSONA unset: no charter clause reaches the persona an architect launch would carry" 1 ;;
  *) check "ARCHITECT_PERSONA unset: no charter clause reaches the persona an architect launch would carry" 0 ;;
esac
unset CHANNEL_REPLY_INSTRUCTION SKILL_LOAD_INSTRUCTION COORDINATOR_STEER_INSTRUCTION COORDINATOR_ROLE_INSTRUCTION ARCHITECT_ROLE_INSTRUCTION ARCHITECT_PERSONA
NO_CHANNEL=1
PERSONA="default"
COORDINATOR_PERSONA="lead"
eval "$VARS_SNIPPET"
case "$(priming_concat)" in
  *"$ARCH_SEAT_CONTROL"*|*"$ARCH_ASK_CONTROL"*|*"$ARCH_WORKTREE_CONTROL"*|*"$ARCH_REPORT_CONTROL"*|*"$ARCH_NEVER_CONTROL"*|*"$ARCH_NOREPO_CONTROL"*|*"$ARCH_CLONE_CONTROL"*|*"$ARCH_STEER_CONTROL"*|*"$ARCH_OTHER_PATH_CONTROL"*|*"$ARCH_FETCH_CONTROL"*|*"$ARCH_PUSH_BOUND_CONTROL"*|*"$ARCH_NOCHANNEL_CONTROL"*|*"$ARCH_SKILLS_CONTROL"*) check "ARCHITECT_PERSONA unset, default persona: no charter clause reaches the priming write" 1 ;;
  *) check "ARCHITECT_PERSONA unset, default persona: no charter clause reaches the priming write" 0 ;;
esac

echo
if [ "$failed" = "0" ]; then
  echo "All tests passed"
  exit 0
else
  echo "FAILED"
  exit 1
fi
