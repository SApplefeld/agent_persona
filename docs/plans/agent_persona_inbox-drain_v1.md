# A turn's end delivers the next waiting record at once

Status: Ready
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

## Sections of Work

### 1. The drain runs at a turn's completion
Model: opus

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
  the next tick delivers the record.
- A case where the completing turn is channel-origin, its answer went through no reply-tool call,
  and the direct reply call throws, so the handler submits the reply backstop, delivers nothing at
  that completion, and the next tick delivers the record.
- A case where the fake `prompt.submit` rejects on the scheduled drain leaves one
  `operator_delivery_error` decision, leaves the record's status as the block wrote it before the
  submit, and completes the handler's `next(e)` before the rejection.
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
`docs/architecture.md`, `docs/backlog.md`.

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

## Chapters
