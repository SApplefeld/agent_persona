# A turn's end delivers the next waiting record at once

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-24

## Goal

When this is done, a persona whose inbox holds several records drains them back to back: the
controller delivers the oldest, and the moment the turn that carried it completes the controller
delivers the next, with no tick between them, until the inbox is empty. A record that arrives
while a turn is running is delivered when that turn ends rather than at the next tick. A record
that arrives at an idle persona still waits at most one tick, and a persona whose turns the
harness never reports open still drains at tick pace, as today. It matters because on 2026-09-24
eight records from five personas reached the coordinator inside 24 minutes, its tick is five
minutes and each tick delivered one record, so the last four waited 11 to 15 minutes and the
self-review raised `message_wait` four times over a delay the plugin caused by construction.

## Dispatch Authorization

The operator decided this on 2026-09-24 on the architect persona's relay thread, in his words:
"Option 1, definitely. If there are 10 messages in the inbox, there's no reason to wait 10 cycles
to deliver 10 messages. You should deliver all 10 on the next cycle." Option 1 was the code change
this plan carries, offered against a config-only shortening of the coordinator's tick, which he
deferred until the self-review flood plan is installed. The work runs on one branch cut from the
fetched trunk `origin/main` and lands as one pull request. Execution waits on the coordinator
handing this plan to a worker by name. The self-review flood plan edits another block of the same
file and may run in either order with this one. The nudge-state plan changes what an entry in
`openTurns` means, so this plan states its chain condition in terms that hold under either
meaning, and whichever of the two lands second merges the trunk before its pull request and runs
this plan's chain cases against the `openTurns` rule then in force.

## Intent

The frame, in the operator's words: ten waiting messages are delivered on the next cycle, not over
ten cycles. The finding was the coordinator's own `message_wait` self-review on 2026-09-24, traced
by the architect to the one-record-per-tick drain.

**What done needs.** A burst of records drains at turn pace. Each record still arrives as its own
turn, opening with its own provenance label, stamped and scored as one record, exactly as a tick
delivery is today. The tick path itself is unchanged, so a persona with a quiet inbox behaves as
before.

**What done does not need.** A shorter tick for any seat, which is a settings change the operator
holds for later. A change to the break-in path, which injects an old record into a running turn
and is a separate mechanism with its own bound. A change to how many records one turn carries,
since one turn carries one record and the bookkeeping depends on it. A repair of the scoring
path's turn-state reads, which the backlog carries as its own entry. A new decision action for a
delivery made at a turn's end, since the delivery is the same act at a different moment. A fix
for a session whose turns the harness never reports open, which drains at tick pace as today.

**Alternatives refused.** Delivering every waiting record inside one prompt, refused because the
turn matcher, the stamp and the scorer each key one turn to one record, and a ten-record prompt
would break all three. Looping the drain inside one tick, refused because a second submit while
the first turn is open is queued rather than answered, and the record would carry a delivered stamp
with no turn that read it. Draining only after a delivery turn rather than after any turn,
refused because a record that arrives during a long working turn would then still wait for the
tick, and the operator's frame is that a waiting message is delivered at the first moment the
persona is free. Awaiting the submit inside the completion handler, refused because a submit
settles only when the session is next idle and the handler runs before the harness reaches idle,
so the await could hold the hook chain open. Shortening the coordinator's tick alone, deferred by
the operator because each tick today reruns the failing self-review until the flood plan lands,
and because a shorter tick moves the threshold of the failure rather than removing its shape.

**Rulings after the spec shipped.** None yet.

Provenance: distilled from the operator's relay decision of 2026-09-24 and the architect persona's
read of `hooks/index.ts` at trunk `b9e6e28`, and of the coordinator's store, whose 200 most
recent decisions show turns opened only by deliveries and the four-hourly reconcile.

## Approach

The drain is one block of the controller tick in `hooks/index.ts`, marked `D3` and opening with
the comment "drain operator inbox (one record per tick, owner only)". Under `sess.isOwner &&
!turnIsOpen()` it lists the persona's inbox records, closes an open ask where a pending record
answers it, sorts the remaining pending records into those with a live claim and those skipped for
a dead writer, a bad name or a bad record, then takes the oldest with a live claim, marks it
delivered in the store, pushes an `operator_delivered` decision, registers an expected delivery
turn through `expectTurn` and submits the text, and returns with the comment "One record per
tick". The turn that opens on that submit is matched at `turn.start` by text, which sets
`currentTurnKind` to `delivery` and `stampRecordId` to the record. `turn.start` also records the
turn in `openTurns`, keyed by id, and `turn.complete` deletes that entry. Nothing at a completion
looks at the inbox, so a second record waits for the next tick, and a record that arrived during
the turn waits for it too.

**The fix is a turn's completion scheduling the drain.** The `D3` block moves whole into one
local async function in the same scope, `drainInbox()`, that keeps the block's guard, its reads,
its skips, its ask-answer path and its one-record submit, and returns whether it submitted. The
tick calls it where the block sat and returns on `true`, as it does today. The `turn.complete`
handler, just before it returns `next(e)`, schedules one call to `drainInbox()` on the next turn
of the event loop, when three things hold: this session is the owner, this completion removed an
entry from `openTurns`, and `openTurns` is empty once that entry is gone. The call is not awaited
by the handler. Its outcome is handled inside the block as it is today, where a refused submit
goes through `recordFailedDelivery`, and a throw out of the call is caught and written as one
`operator_delivery_error` decision naming the message, so nothing is left unhandled and the hook
chain closes on time. Where the handler's own body submitted the `[REPLY BACKSTOP]` prompt, the
drain is not scheduled, because that prompt's turn is queued but not yet in `openTurns`, and a
delivery queued beside it would pile into one prompt the matcher cannot read as a delivery. The
next tick takes the record instead.

**Why the condition is stated on `openTurns` alone.** Today `openTurns` is opened only by
`turn.start` under the turn's id, so "removed an entry" means this session saw the turn start. A
background subagent's completion reaches the hook with an id `turn.start` never recorded, removes
nothing, and does not schedule the drain, which is what keeps the chain honest under the backlog's
known defect in `currentTurnKind`. The nudge-state plan opens `openTurns` also from `prompt.submit`
and `tool.call`, under the event's id or one synthetic key, and has every completion close the
synthetic key. Under that rule "removed an entry" means this session saw some event of the turn,
and a completion carrying no id that closes the synthetic key schedules the drain too. Both
readings are what this plan intends: the session saw the turn, and no turn remains open. The
chain never reads `currentTurnKind`.

**Why a submit from the completion works, and what the suite cannot prove.** A prompt submitted
while no turn is open opens the next turn, and the expected-turn entry is pushed before the
submit, so `turn.start` matches it exactly as it matches a tick delivery. The break-in path, the
fleet block, the self-review block and the idle branch are untouched. A completion with another
turn still open schedules nothing and leaves the record pending, which the next tick takes, the
same one-tick cost the block already accepts when a turn opens under it. The delivery writes the
same `operator_delivered` action with the same detail, so the decision log, the live restart
test's delivery classification and the `message_wait` measurement read it as they read a tick
delivery. The tick suite's fake `prompt.submit` settles at once, so it proves the chain's logic
and not the harness's acceptance of a submit made right after a completion. The one precedent, the
reply backstop, has never fired on a live persona. The live proof is a deferred gate run per the
deferred-gate-run plan, which owns the policy that live suites run once after the queued plans
merge, and the Operator Verification below.

**A session whose turns are never reported open drains at tick pace.** The handler's own comment
says a turn's start is unseen on a session the harness under-reports, and the nudge-state plan
cites a dev-persona log where `turn.start` does not arrive while `prompt.submit` and `tool.call`
do. On such a session, before nudge-state lands, no completion removes an entry and the chain
never fires, so delivery stays at one record per tick, which is today's behaviour and not a
regression. After nudge-state lands, `tool.call` opens the entry and the chain fires. The plan
declares this rather than fixing it, since the fix is the nudge-state plan's.

**The injection ledger sees no new call site.** `.kit/injection-ledger.mjs` anchors every
`submitExpectedTurn` call in `hooks/index.ts` and declares three `deliveryText` call sites, and
`.kit/injection-duplicate-test.mjs` refuses a fourth. The drain body moves rather than copies, so
the `expectedDeliveryTurn` anchor and the `submittedText` exclusion stay one site each, on one
line ending in a semicolon as the ledger's pattern requires. Both suites pass unchanged, and a red
in either is the implementer's signal that the body was copied.

**What the prose says afterwards.** The `agentic_say` tool's description and its result text say
the owner sees a record on its next quiet tick. Both gain the sentence that a record also
delivers when the owner's running turn ends, and each further record follows as the previous
delivery turn ends. The README's Delivery section says the same in its own words. The README's
Controller line, which calls the controller the only thing that calls `$.prompt.submit`, names the
completion drain as a second submitter beside the reply backstop, and the backlog entry on the
backstop being the only submitter outside the tick names the drain as well. The
`docs/architecture.md` troubleshooting row that judges a writer's claim "before the worker's next
quiet tick" says "before the worker's next delivery, at a quiet tick or a turn's end". The
`message_wait` row of `docs/architecture.md` is unchanged, since the bound it measures is
unchanged.

**Sweep for surfaces that speak the contract this plan changes**, run at authoring from trunk
`b9e6e28`: `grep -rn -i 'quiet tick\|one record per tick\|per tick'` over `hooks/index.ts`,
`docs/`, `README.md`; `grep -n 'operator_delivered'` over `.kit/`; and a read-only Explore sweep
at sonnet over `hooks/`, `.kit/`, `docs/`, `bin/` and `README.md` for the delivery code, its
tests, its prose and its wait measurement, with the plan review's own read adding the README
Controller line, the backlog's only-submitter entry and the architecture row. Found: the `D3`
block and its `turn.start` and `turn.complete` counterparts in `hooks/index.ts`, with `openTurns`
declared beside them and the reply backstop's submit inside the completion handler; the tool
description near the `agentic_say` registration and the tool's result string, both reading "next
quiet tick"; comments in the tick reading "the next quiet tick takes it", which stay true;
`README.md`'s Delivery section and its Controller line; `.kit/controller-tick-test.mjs`, whose
`caseS2_drain` pins one record per tick and a second left pending, whose `caseS2_drain_inflight`
pins no delivery while a turn is open, whose `caseS2_reply_turnid` cases fire the harness's
`turn.complete` handler by hand, whose `caseSection3_workerRecordIsDeliveredToTheCoordinatorOnTick`
drives a labelled tick delivery, and whose `caseSection4_subagentLeftRecordIsDrainedOnTheNextTick`
completes a turn this session saw start with a record pending and then ticks, a case this plan
makes deliver at the completion while its check still holds; `.kit/injection-ledger.mjs` and
`.kit/injection-duplicate-test.mjs`, named above; `.kit/live-restartrequest-test.sh`, which
classifies a delivery by its decision action and is unchanged; `hooks/self-review.ts` and
`docs/architecture.md`'s `message_wait` row, unchanged; `docs/architecture.md`'s troubleshooting
row on an architect answer that never reaches its worker; `docs/backlog.md`'s entries on the
`turn.complete` scoring path and on the break-in gaps, both left in place, and its entry on the
backstop as the only submitter outside the tick, which this plan amends; and the archived
`docs/plans/archive/agentic-plugin_operator-channel_v1.md`, which dropped an earlier "next tick
drains immediately" flag as redundant with the drain running at the top of each tick, a different
question from this plan's.

## Standing Brief Amendments

- A turn's completion drains whatever the reason it ended with. The Goal's "the moment the turn
  that carried it completes" covers an answered, aborted, refused or errored turn alike. The only
  tick-pace case the Goal draws is a session whose turns the harness never reports open.

## Sections of Work

### 1. The drain runs at a turn's completion
Model: opus
Locus: inline

In `hooks/index.ts`, the `D3` inbox block of the controller tick moves into a local async
function `drainInbox()` in the same scope, unchanged inside, returning `true` where it submitted a
record and `false` otherwise. The tick calls it in the block's place and returns on `true`. The
`turn.complete` handler reads, before its `openTurns.delete`, whether the completing id was
present, and just before `return next(e)`, where that read was true, the session is the owner,
`openTurns` is empty and the handler's body did not submit the reply backstop, schedules
`drainInbox()` once on the next turn of the event loop without awaiting it, with a throw out of
the call caught and written as one `operator_delivery_error` decision naming the message. The
`agentic_say` description, its result string, the README's Delivery section and Controller line,
the backlog's only-submitter entry and the architecture troubleshooting row state the new cadence.

Acceptance:
- A tick-suite case with three pending records from a writer holding a live claim: one tick
  delivers the oldest and no other; firing `turn.start` and then `turn.complete` with that
  delivery turn's id delivers the second with no tick; the same for the third; a further
  completion of a seen turn with an empty inbox delivers nothing and pushes no delivery decision.
  Each record is marked delivered in the store once, with its own `operator_delivered` decision
  naming its id.
- A case where a record is seeded pending after a turn this session saw start, and that turn
  completes with no other open, delivers the record at the completion without a tick.
- A case with a record pending and `openTurns` empty, completing a turn id `turn.start` never
  recorded, delivers nothing, and the next tick delivers the record.
- A case where a seen turn completes while a second seen turn is still open delivers nothing, and
  the last open turn's end delivers the record.
- A case where the completing turn is channel-origin, its answer went through no reply-tool call,
  and the direct reply call throws, so the handler submits the reply backstop, delivers nothing at
  that completion, and the next tick delivers the record.
- A case where the fake `prompt.submit` rejects on the scheduled drain leaves one
  `operator_delivery_failed` decision, as the block records a refused submit, and leaves the
  record's status as the block wrote it before the submit. A case where a throw leaves the
  scheduled drain leaves one `operator_delivery_error` decision. A case holding the submit
  shows the handler completing `next(e)` before the submit settles.
- A pending record whose writer holds no live claim is skipped with `operator_skipped_no_claim`
  from the completion path exactly as from the tick.
- Every existing case in `.kit/controller-tick-test.mjs`, `.kit/injection-ledger.mjs` and
  `.kit/injection-duplicate-test.mjs` passes unchanged, the ledger still declaring three
  `deliveryText` call sites.
- `README.md`'s Delivery section, the `agentic_say` tool description and its result string each
  say that a record delivers when the owner's running turn ends and that each further record
  follows as the previous delivery turn ends. `README.md`'s Controller line and the backlog's
  only-submitter entry each name the completion drain as a submitter. The architecture row reads
  "before the worker's next delivery, at a quiet tick or a turn's end".

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `README.md`,
`docs/architecture.md`, `docs/backlog.md`, `bin/supervise-holder.sh`,
`.kit/channel-reply-instruction-test.sh`, `.kit/injection-ledger.json`.

Tests: at minimum, lock the chain in both directions, a seen completion that drains and an unseen
completion that does not with `openTurns` empty in both, since the expensive failure is a record
marked delivered by a completion no turn followed; lock the open-turn skip and the backstop skip,
since a submit beside a queued prompt is unread; lock that the handler returns before a rejected
submit settles, since the expensive failure there is a hook chain held open; and lock that a tick
still delivers exactly one, since the tick path must not change.

References: `.kit/controller-tick-test.mjs`, `caseS2_drain` for the one-per-tick pin,
`caseSection3_workerRecordIsDeliveredToTheCoordinatorOnTick` for a labelled tick delivery with a
live claim, `caseSection4_subagentLeftRecordIsDrainedOnTheNextTick` for a turn completed by hand
with a record pending, and the `caseS2_reply_turnid` cases for firing `h.handlers["turn.complete"]`
by hand.

## Out of Scope

- Any tick length, nudge floor or other value in `fleet.json` or a persona's `run/settings.json`.
  The operator holds the shorter tick for after the self-review flood plan is installed.
- The break-in path and `breakInAfterMs`, and the three break-in gaps the backlog names.
- Carrying more than one record in one turn.
- The `turn.complete` scoring path's reads of `currentTurnKind` and `isPrimingTurn`, which stay
  a backlog entry. This plan keys its chain on `openTurns` so it does not depend on them.
- A new decision action or detail for a delivery made at a turn's end. `operator_delivery_error`
  is a failure record, not a delivery kind, and the live restart test never reads it.
- A session whose turns the harness never reports open. It drains at tick pace, as today, until
  the nudge-state plan opens `openTurns` from `tool.call`.
- `KAIZEN_MESSAGE_WAIT_MS` and the `message_wait` finding.
- The self-review flood plan's block and the nudge-state plan's idle branch and open-turn rule.
- A live run before the section closes. The live proof rides the deferred gate run.

## Assumptions

- assumed 2026-09-24 (the operator's words read against the turn bookkeeping): "deliver all 10 on the next cycle" is met by ten back-to-back turns of one record each, because the matcher, stamp and scorer key one turn to one record; reversal: a batched prompt, which redesigns those three sites.
- assumed 2026-09-24 (default, declared to the operator in the recap): the drain runs at the end of any turn this session saw open, not only a delivery turn, because a record arriving during a working turn would otherwise still wait for the tick; reversal: narrow the condition to a completion matching a recorded delivery turn id, one comparison.
- assumed 2026-09-24 (default): the chain fires only from a completion that removed an entry from `openTurns`, never from `currentTurnKind`; reversal: read the kind instead and inherit the backlog's foreign-completion defect.
- assumed 2026-09-24 (the code's own comment that a submit settles at the next idle): the drain is scheduled after the handler and not awaited, with a throw caught into one decision; reversal: await it, and prove on a live persona that the hook chain still closes.
- assumed 2026-09-24 (default): a completion that finds another turn open, or whose body submitted the reply backstop, schedules nothing and the next tick takes the record, matching the tick block's own rule; reversal: retry on a timer, which adds a clock and a knob.
- assumed 2026-09-24 (the deferred-gate-run plan): the harness's acceptance of a submit right after a completion is proven on the deferred live gate and in Operator Verification, not in this section, because the tick suite's fake submit settles at once; reversal: a live run inside this section, which holds the box during a queued plan.
- assumed 2026-09-24 (brainstorming's one-section allowance): this spec skipped the blind read and the gating litmus, since it is one section over one block with the tests named; the plan review ran at fable and high effort and returned READY_WITH_FINDINGS with eight findings, all taken into the text above; reversal: run the blind read before arming.

## Operator Verification

After the plan lands and the plugin is updated on each persona, a burst of three or more records to
the coordinator inside one tick shows `operator_delivered` decisions seconds apart rather than one
per tick, and `message_wait` does not fire on a burst that arrives at a quiet coordinator. A
`message_wait` finding whose records were pending while the coordinator was idle reopens the work.
A persona whose store shows `operator_delivered` decisions only at tick spacing after a burst,
and whose debug log shows `turn.start` arriving, reopens the work. One whose log shows no
`turn.start` is the declared tick-pace case and waits on the nudge-state plan. An
`operator_delivery_error` decision in any store reopens the work with its message.

## Open Questions

None.

## Related

- `agent_persona_self-review-flood_v1.md`: edits another block of the same tick.
- `agent_persona_nudge-state_v1.md`: changes what an entry in `openTurns` means, which this
  plan's chain condition reads.
- `agent_persona_deferred-gate-run_v1.md`: owns the live gate on which this plan's submit is
  proven.
- `agent_persona_backstop-turn-guard_spec_v1.md`: guards the reply backstop in the same completion
  handler, whose skip this plan's completion drain honors.

## Chapters

### Chapter 1 - 2026-09-25
Completed: 1. The drain runs at a turn's completion
Implemented By: main session (opus, Locus: inline)
Metrics: review rounds 1, closed major-closed; provenance 6 spec-traceable, 0 fix-introduced, 1 new-requirement, rulings (1 refused, 0 declared, 0 asked); advisory: 1 findings, 0 fixed, 0 deferred, 1 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 1 open: moves the D3 inbox block of the controller tick into a registration-scope async drainInbox($) (it cannot stay tick-local, since controllerTick lives inside the session.start hook and the turn.complete handler cannot reach it) and schedules one unawaited call from the turn.complete handler when this completion closed its own openTurns entry, the session owns the persona, no turn is left open and the handler did not submit the reply backstop; adds one reentrancy flag, drainInFlight, mirroring fleetBlockInFlight, so a tick and a completion cannot both list and deliver the same oldest record; serves the Goal sentence "the moment the turn that carried it completes the controller delivers the next, with no tick between them" and the acceptance bullet "Each record is marked delivered in the store once"; the flag is a guard no clause names, routed at intake as a declared default; size about 40 changed lines of code, 1 flag, about 7 tick cases; not building it leaves a burst of records draining one per tick, 11 to 15 minutes behind on the measured coordinator burst.
- Mid-work (inline): drainInFlight, a shared in-flight drain promise a second caller waits on, re-draining where the running drain delivered nothing; serves the acceptance bullet "Each record is marked delivered in the store once, with its own operator_delivered decision naming its id" and the Intent's "the tick path itself is unchanged"; adds a mechanism (a guard) traced to that bullet, so no design stop; about 8 lines, one state; not building it lets an overlapping tick and completion each read the same pending record and submit it twice.
- Round 1 fix (blind Major, subagent completion): the completion drain's condition refuses a completion carrying an agentId, as completesGateTurn does; serves the Approach's "A background subagent's completion ... does not schedule the drain" and the acceptance bullet on an unseen completion delivering nothing; no new mechanism, one clause on the existing guard; 1 line; not building it lets a subagent completion carrying the parent turn's id drain into the running turn.
- Round 1 (blind Major, turn opened during the drain's reads): a re-check of turnIsOpen() just before the delivered mark was written, broke the Section 12 M1 (A) case, and was reverted; the shipped drain keeps the one open-turn check at its top, and the finding is recorded under Review Findings as justified-not-fixed.
- Round 1 fix (Minors, three lenses): a waiter on a rejected running drain catches the rejection and runs its own drain, so one fault is reported by its own drain's caller; the completion's save reads the decision ring by identity as well as length; no new mechanism; 2 lines; not building it logs one fault twice and can leave a skip unsaved after a trim.
- Round 1 fix (adversarial Major, acceptance bullet 6): the bullet is amended to name operator_delivery_failed for a rejected submit, keeping the throw case for operator_delivery_error, per the plan's own Approach; prose only; not building it leaves a bullet no code can meet.
- The Status header was set to In Progress at start; it read Ready.
- The loader rule R3 (`.kit/check-loader-rule.mjs`) refuses a `$`-taking function declared inside `register()`, so `drainInbox` is a no-parameter closure beside the controller tick inside the session.start hook, published to the completion handler through `drainInboxNow`. The section-open line above names the registration-scope shape this replaced. A control run with a `$` parameter planted on the nested closure made R3 fire.
- A first in-flight form returned the running drain's answer to a second caller. It made the Section 12 H1 (B) case miss a record seeded just after a completion, because the joined drain had read the inbox before the seed. A caller that meets a drain which delivered nothing now drains itself.
- Scope widened: `bin/supervise-holder.sh`'s worker steer, its pin in `.kit/channel-reply-instruction-test.sh`, `README.md` and `docs/architecture.md` said a live architect takes one record per controller tick, untrue once a queue drains per turn. The plan's sweep grepped `per tick` and missed `per controller tick`. `.kit/injection-ledger.json`'s two sizes were refreshed for the grown texts. The section's `Files in scope:` line now names the three files. That line and acceptance bullet 6 sit above `## Chapters`, so both edits are approval drift, made deliberately here.
- Acceptance bullet 6 was amended. It named `operator_delivery_error` for a rejected submit, while the plan's own Approach and the code record a refused submit as `operator_delivery_failed`. The bullet now names that, keeps a throw case for `operator_delivery_error`, and a held-submit case for the handler returning first.
- A `## Standing Brief Amendments` block was created above `## Sections of Work`, carrying the scope ruling below as a rule. It is approval drift, recorded here.
- Found and routed out: a tick-suite case that hangs on a never-settled promise ends the Node process with exit 0 part-way through, which a gate reading only the exit code takes as green. Entered in `docs/backlog.md`.
Assumptions:
- assumed 2026-09-25 (intake, section 1): the branch is stacked on the backstop-turn-guard branch rather than cut from origin/main, since that branch edits the same completion handler; reversal: rebase onto main once PR 107 merges.
- assumed 2026-09-25 (intake, section 1): `turn.start` is still the only opener of `openTurns` after the nudge-state plan landed (the one `openTurns.set` in `hooks/index.ts`), so the plan's declared tick-pace case for an under-reporting session stands as written; reversal: none needed.
- assumed 2026-09-25 (intake, section 1): the completion drain skips on the reply-backstop submit attempt, whatever its outcome; reversal: skip only on an accepted re-prompt.
- assumed 2026-09-25 (intake, section 1): the other-open case pins delivery at the last open turn's end rather than at the next tick, since a tick with a turn open skips the drain by its own rule; reversal: none, the bullet is met in substance.
Review Findings:
- review: code pair at fable, Agent tool; security and performance at fable, Agent tool; scope adjudicator at fable, Agent tool. Tree unchanged across the round.
- Refuted at adjudication, one premise under a correctness Critical (adversarial) and an advisory Critical (performance): that `drainInFlight` holds across a submit settling only after the delivered turn completes, so the completion drain inherits the last delivery's answer. The harness contract says a submit resolves once its turn started or it was queued, not when the turn ends (`.claude/types/claude-code.d.ts:7770-7773`). The adversarial Major that a tick meeting a parked drain skips its body rests on the same premise and falls with it. The drain's comment now states the contract, and a case holding the submit until its turn starts proves the chain still fires.
- Fixed: a subagent completion carrying the running turn's id no longer drains (blind Major, orchestrator-made trace to the Approach's subagent sentence; red with the clause removed, green with it); acceptance bullet 6 amended (adversarial Major); the missing held-submit cover added (adversarial Major).
- Held and ruled: the blind Major that error, refusal and aborted completions should not drain, new-requirement, ruled REFUSE by the scope adjudicator on the Goal sentence "the moment the turn that carried it completes" and the Intent's refused alternative "Draining only after a delivery turn". The ground is recorded in the Standing Brief Amendments block.
- Justified-not-fixed: the blind Major that a turn opening during the drain's store reads leaves a delivered stamp nobody reads. The existing Section 12 M1 (A) case pins the designed behaviour: a delivery queued under an opening turn keeps its entry, and its own turn stamps it. The Intent keeps the tick path unchanged. A re-check written for it broke that case and was reverted.
- Minors: 6 fixed in the close pass (the moved comment's "two blocks above"; one fault reported twice by a waiter; the save missing a skip after a trim; the three-record case now opens its turns on their own text and pins the stamps; the README wait sentence; the backlog's submitter count); 0 upgraded; 4 left with the reason (a submit that never settles parks later drains, and the harness contract settles every submit; `drainInFlight` is module-level as `fleetBlockInFlight` is; an external prompt queued during a turn can merge with a delivery, which the deferred live gate observes; the adversarial claim that `drainInboxNow` is set on a reader session is refuted, since the assignment sits inside `if (arming !== "reader")`).
Stamps: adjudicated 6, stamped 3 (an-undelivered-inbox-record-is-normal-for-a-live-idle-owner, updated to the new cadence in the same turn; tick-harness-state-is-loaded-at-creation-drive-handlers-to-change-it; a-chapters-claim-about-its-own-commit-is-unverified-until-diffed), 3 skipped as read without shaping this section.
Gate: targeted lane, measured 2026-09-25 about 15:40 on SCOTT-CLAUDE in this worktree with the fix round uncommitted over a8f0ea4, no foreign-runner poll taken. `.kit/controller-tick-test.mjs` 4432 pass / 0 fail, exit 0, against a baseline of 4407 / 0 recorded on this lane at affdb45. `npx tsc --noEmit` exit 0. `npx tsc -p tsconfig.json` exit 0 at a8f0ea4. `.kit/injection-duplicate-test.mjs` exit 0. `.kit/injection-ledger.mjs` exit 0. `.kit/check-loader-rule.mjs` exit 0. `.kit/tool-description-length-test.mjs` exit 0. `.kit/channel-reply-instruction-test.sh` 173 OK, exit 0 at a8f0ea4, its files unchanged since. Test delta: 11 cases added, 0 retired, 0 existing cases edited. Added: three records drain one per delivery turn, each stamped by its own turn (Goal, bullet 1); a submit settling at its turn's start still chains (Goal); a subagent completion carrying the turn id delivers nothing (Approach); a record arriving mid-turn delivers at its end (bullet 2); an unseen completion delivers nothing (bullet 3); another turn open delivers nothing (bullet 4); the backstop completion delivers nothing (bullet 5); the handler returns before a parked submit settles, a rejected submit is one failed-delivery record, and a throw is one delivery-error record (bullet 6); a dead writer is skipped from the completion (bullet 7). None spawns a process. Wall clock not captured.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: measured 2026-09-25 15:43 on SCOTT-CLAUDE in this worktree; exit 2
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-25
Completed: finishing-work
Implemented By: main session
Metrics: review rounds 1, closed minor-only; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (1 refused, 2 declared, 0 asked); advisory: 8 findings, 2 fixed, 0 deferred, 6 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Recap: Goal: "When this is done, a persona whose inbox holds several records drains them back to back: the controller delivers the oldest, and the moment the turn that carried it completes the controller delivers the next, with no tick between them, until the inbox is empty. A record that arrives while a turn is running is delivered when that turn ends rather than at the next tick. A record that arrives at an idle persona still waits at most one tick, and a persona whose turns the harness never reports open still drains at tick pace, as today. It matters because on 2026-09-24 eight records from five personas reached the coordinator inside 24 minutes, its tick is five minutes and each tick delivered one record, so the last four waited 11 to 15 minutes and the self-review raised `message_wait` four times over a delay the plugin caused by construction."; What the tree does now: a persona's plugin hands it waiting messages from its inbox one per turn, and it now does so at two moments rather than one. The first is a quiet controller tick, as before. The second is the end of a turn this session saw start, provided no other turn is still open, that turn was not a background subagent finishing, and it did not just resend a missed Discord reply. So a burst of messages arrives back to back, each as its own labelled turn, instead of one every tick; a message that arrives mid-turn arrives when that turn ends; a session whose turns the harness never reports open still gets one per tick. One shared guard keeps a tick and a turn end from handing over the same message twice, and a failure in the turn-end delivery is logged as one operator_delivery_error decision; Refinements during the run: the Standing Brief Amendments block records that a turn's completion drains whatever reason it ended with (the scope adjudicator's refusal of a finding that asked otherwise); acceptance bullet 6 now names operator_delivery_failed for a rejected submit, with a throw case and a held-submit case added; acceptance bullet 4 now says the last open turn's end delivers the record, since a tick cannot while a turn is open; the section's Files in scope widened to bin/supervise-holder.sh, its test pin and the injection ledger; drainInbox moved from registration scope into session.start behind drainInboxNow, reversing the section-open shape, because loader rule R3 refuses a $-taking function there; the goal read refused the new tick-suite hang backlog entry as off this plan's goal, so it and two curation findings landed on their own in pull request 108; Operator-pending: 1. approve this plan's pull request and pull request 108; 2. after the merge, update the installed plugin on each persona, relaunch, and run the live burst check under Operator Verification
Decisions / Surprises: Base ref abd826d, the merge-base with origin/main after pull request 107 merged; the changeset listing matched the Files in scope lines plus the plan doc. QA found Chapter 1's Round 1 bullet on a turnIsOpen re-check describing a fix that was reverted; it now states the revert. The goal read refused the tick-suite hang backlog entry as off the goal and ruled its removal to a change of its own, so it left this branch and landed on backlog-tick-suite-hang, pull request 108, ready with auto-merge armed. The Minor pass restated two comments on the harness submit contract, amended acceptance bullet 4 (approval drift, recorded here), reconciled Chapter 1's provenance count to 6 spec-traceable, retitled caseSection4_subagentLeftRecordIsDrainedOnTheNextTick's comment, banner and check text because its record now arrives at the turn's end (one existing case edited for accuracy, still green), and reworded the backlog's submitter count. Drift adjudication: D1, a mistake, six README.md passages still said a record waits for the tick; the code matches the spec, so the fix was to the doc, and eleven phrases now name the drain. D5, a mistake, the Chapter 1 backlog entry absent from disk, is refuted: the goal read moved it to pull request 108. D2 (the submit-at-idle premise in README.md, docs/backlog.md and about eleven older comments) and D6 (the README calling the controller the sole actuator) are pre-existing deviations filed as backlog entries on pull request 108. D3 and D4, the in-flight guard and the subagent clause, are deviations the curator documented in docs/architecture.md, and match the goal read's two declared items. D7 keeps a backlog heading two archived plans cite by title. The curator edited README.md, outside its charter, and reverted it; git diff HEAD -- README.md was empty before the D1 fix. The Intent's refused-alternative sentence still carries the settles-at-idle premise; it is the operator's record and stands as written, with the premise filed under D2. The deferred-gate-run plan does not yet link back here; that link is taken when that plan runs.
Assumptions: assumed 2026-09-25 (intake, section 1): the branch is stacked on the backstop-turn-guard branch rather than cut from origin/main, since that branch edits the same completion handler; reversal: rebase onto main once PR 107 merges. assumed 2026-09-25 (intake, section 1): `turn.start` is still the only opener of `openTurns` after the nudge-state plan landed (the one `openTurns.set` in `hooks/index.ts`), so the plan's declared tick-pace case for an under-reporting session stands as written; reversal: none needed. assumed 2026-09-25 (intake, section 1): the completion drain skips on the reply-backstop submit attempt, whatever its outcome; reversal: skip only on an accepted re-prompt. assumed 2026-09-25 (intake, section 1): the other-open case pins delivery at the last open turn's end rather than at the next tick, since a tick with a turn open skips the drain by its own rule; reversal: none, the bullet is met in substance. declared 2026-09-25 (goal read): the in-flight drain guard changes the tick path's shape, since a tick now waits on a running completion drain and returns early where it delivered, against the Intent's "the tick path itself is unchanged"; reversal: none without losing the once-only delivery bullet. declared 2026-09-25 (goal read): a completion carrying a subagent agentId never drains, whatever turn id it carries; reversal: drop the clause.
Review Findings: review: finishing security + performance + adversarial at fable, Workflow (high), after the capacity reading "fable capacity: scoped 70%, 7d 54%, 5h 29% (account 8, fetched 69s ago) -> dispatch"; goal read at fable, Agent tool (frontmatter high), after "fable capacity: scoped 73%, 7d 56%, 5h 38% (account 8, fetched 203s ago) -> dispatch". Tree unchanged across both rounds. Security CLEAR, threat model present, npm audit 0 vulnerabilities, 2 Minors (the stale submit comments, fixed; the unconditional openTurns.delete on a subagent completion, pre-existing and hypothetical, left). Performance CLEAR, 6 Minors (the stale comments, fixed; a tick-versus-queued-submit gap, completion-path store reads, two back-to-back persists, a joined tick skipping D4 once, and fixed 50 ms settles in the new cases, each a cost note against no stated requirement, left). Adversarial APPROVED_WITH_CONCERNS, 9 Minors: 6 fixed (bullet 4, the provenance count, the stale comments, the retitled case, the backlog wording, the stale Chapter 1 bullet), 3 left (a waiter inheriting a running drain's true while its persist is pending costs at most one tick; the openTurns.delete shape above; a persist throw after a successful submit reads as operator_delivery_error, named in the operator item). Goal read RULED: built-but-unasked 1 refused (the tick-suite hang entry, removed to pull request 108), 2 declared (the in-flight guard, the subagent clause); asked-but-unbuilt none.
Stamps: adjudicated 7 read in this pass, stamped 1 (a-system-checking-review-cannot-catch-a-record-only-defect, which put the record-against-diff reading in the adversarial brief and so caught the Chapter 1 count drift), 6 skipped as read without shaping it.
Gate: GATE-PENDING
Next: none, the plan is complete
Commit Model: Branch-and-PR
Delta: DELTA-PENDING
