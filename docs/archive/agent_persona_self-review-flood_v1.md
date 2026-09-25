# A failed self-review is retried on the review's own cadence, not every tick

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-24

## Goal

When this is done, a periodic or reactive self-review that throws is recorded once, with the
error's message in the decision, and is retried only when the review's own debounce and hourly cap
would admit a fresh review, so a controller whose review keeps failing writes at most a handful of
decisions an hour rather than one every ten seconds. It matters because on 2026-09-23 the
dev-persona persona's store held 174 decisions reading `periodic: pendingPeriodic (goal_done):
error` over 34 minutes, the decision ring holds 200, and the flood evicted the goal loop's own
record, so the nudge-cap events two other findings were traced from are no longer in that store.
The thrown error was swallowed, so what failed is still not known.

## Dispatch Authorization

The operator authorized this plan on 2026-09-24 on the architect persona's relay thread, in his
words: "Agreed, let's turn the self-review flood into a plan and get that dispatched out." The
backlog entry it comes from is "A failed periodic self-review retries every tick and floods the
decision log (found 2026-09-23)" in `docs/backlog.md`, which the close retires. The entry's own
gate, that it runs after the goal-levels plan merges because it edits the tick, is met: goal-levels
merged as pull request 87 and sits under the archive. The work runs on one branch cut from the
fetched trunk `origin/main` and lands as one pull request. Execution waits on the coordinator
handing this plan to a worker by name. The nudge-state plan edits the same file's idle branch and
not this block, so the two may run in either order, and whichever lands second merges the trunk
before its pull request.

## Intent

The frame, in the operator's words on 2026-09-24: turn the self-review flood into a plan and get
it dispatched. The finding is the backlog's, read from the dev-persona store: one review that
throws is retried on every ten-second tick, and every attempt appends a decision.

**What done needs.** A failed review attempt is treated as an attempt. It stamps the same state a
successful one stamps, so the next attempt waits for the debounce and counts against the hourly
cap. The decision it writes names the error, on one line, so the next occurrence tells us what
fails.

**What done does not need.** A fix for whatever threw, because the message is not yet known and
this plan is what surfaces it. A separate failure back-off with its own knobs, because the review
already has a debounce and a cap and a failure can ride them. A repair of the evicted decisions,
which are gone.

**Alternatives refused.** A dedicated retry counter and back-off for failures, refused because it
adds state and two knobs where the existing debounce and cap already bound the rate. Logging the
error and clearing `pendingPeriodic` without stamping the rest, refused because the `turnsSince`
trigger would still fire the review again within the hour on a busy worker.

**Rulings after the spec shipped.** 2026-09-24, consultant ruling in section 1: a failed attempt
that was owed to a `goal_done` leaves `pendingPeriodic` set, so it is retried once the debounce
admits it, as acceptance bullet 2, the Intent and the backlog remedy state. The Approach's earlier
clause clearing the flag for good was the mis-derived half of a contradiction the first review
round found, and is replaced. The stamp also moves before the block's first await, because the
tick timer does not await the tick and an overlapping tick must read the attempt as spent.

Provenance: distilled from the backlog entry of 2026-09-23 and the architect persona's 2026-09-24
read of `hooks/index.ts` block `2a2` and `hooks/self-review.ts` at trunk `a62aadc`.

## Approach

The self-review site is one block, marked `2a2` in `hooks/index.ts`, and runs on every tick when
no turn is open. It asks `shouldSelfReview` from `hooks/self-review.ts` twice, reactive and
periodic. That check admits a review while `pendingPeriodic` is true, which `goal_done` sets,
unless the debounce holds, `lastAt > 0` and `turnsSince` under `selfReviewDebounceTurns`, or the
hourly cap holds, `count` at `selfReviewMaxPerHour` inside the window. The block's two success
paths, a finding made and a lesson judged, each write `count += 1`, `windowStart` where it was
zero, `lastAt = now`, `turnsSince = 0` and `pendingPeriodic = false`. The catch at the end of the
block writes one decision reading `<trigger>: error` and touches none of those five fields. So a
throw leaves the state exactly as it was before the attempt, `shouldSelfReview` answers eligible
again on the next tick, and the loop runs until an attempt succeeds. The store on 2026-09-23 read
`count` 0, `turnsSince` 423, `pendingPeriodic` true, which is that state.

**The fix is every attempt stamping what the success paths stamped.** The attempt stamps
`count += 1`, `windowStart` where zero, `lastAt = now`, `turnsSince = 0` and
`pendingPeriodic = false` once, right after the eligibility check and before the block's first
await, so a failed attempt is spent exactly as a successful one. `pendingPeriodic` is cleared by the stamp so an
overlapping tick reads the attempt as spent, and the catch sets it again where the attempt was
owed to a `goal_done`, so the debounce and the cap are what bound the retry. Under the defaults,
debounce 5 turns and cap 2 an hour, a review that always throws writes at most two decisions in
each hourly window, and a review owed to a `goal_done` that throws once is retried after five turns.

**The decision names the error.** The detail reads `<trigger>: error: <message>`, where the
message is the thrown value's text as the file's `safeErrorText` reads it, the error's name where
that is empty, folded to one line on `LINE_TERMINATOR` and cut at 200 characters, since the decision ring is read by `goal_status` and the
fleet board one line at a time. The reason the message was never recorded is the bare `catch`,
and the fix binds the error and reads it.

**Single-sourcing the stamp.** The five writes appeared on both success paths. They move to one
site at the start of the attempt, so no path, the catch included, can skip a field. They stay in
the block rather than in `self-review.ts` because they mutate `sess.state`, which that module does
not touch, and `shouldSelfReview` stays pure.

**Sweep for surfaces that speak the contract this plan changes**, run at authoring from trunk
`a62aadc`: `git grep -n 'selfReview\|self-review\|pendingPeriodic'` over `hooks/`, `.kit/`,
`docs/` and `bin/`. Found: the block in `hooks/index.ts`, its `turnsSince += 1` writer at the
turn completion, and the `goal_done` writer of `pendingPeriodic`; `hooks/self-review.ts`, which
reads the state and is unchanged; `.kit/self-review-unit-test.mjs`, which pins the pure checks and
is unchanged; `.kit/controller-tick-test.mjs`, which drives the block through `createTickHarness`
with a stubbed `model.complete` and a `selfReview` state override, in the case
`caseItem8p2_memory_quality_self_scoring_vs_proof_backed` and the `BO1-pin` cases; and
`docs/architecture.md`, whose self-review paragraph names the debounce and cap and is where the
failure rule is stated. `docs/backlog.md` carries the entry this plan retires.

## Standing Brief Amendments

- A self-review attempt is stamped once, before the block's first await. A failed attempt that was owed to a `goal_done` leaves `pendingPeriodic` set; a failed reactive-only attempt sets nothing.

## Sections of Work

### 1. The catch stamps the attempt and names the error
Model: sonnet

In the `2a2` block of `hooks/index.ts`, the five state writes the two success paths share move to
one stamp before the block's first await, and the catch binds its error, writes the decision
`<trigger>: error: <message>` with the message folded to one line and cut at 200 characters, and
sets `pendingPeriodic` again where the attempt was owed to a `goal_done`. The `sess.state.updatedAt = now` and `await persist($)`
that follow the try already run on the failure path and stay where they are.

Acceptance:
- A tick-suite case where `model.complete` throws once with `pendingPeriodic` true leaves exactly
  one `self-review` decision whose detail ends with the thrown message, and a second tick under
  the same clock adds no `self-review` decision.
- The same case advanced by `selfReviewDebounceTurns` completed turns, with the model then
  answering `NONE`, runs the review again and writes `periodic: ... : NONE`.
- A case where the model throws on every call and the clock stays inside one hour writes
  `selfReviewMaxPerHour` error decisions and no more, however many ticks run.
- The existing self-review cases in `.kit/controller-tick-test.mjs` and every case in
  `.kit/self-review-unit-test.mjs` pass unchanged.
- `docs/architecture.md`'s self-review paragraph states that a failed attempt stamps the same
  state a successful one does and names its error in the decision.
- The backlog entry moves to the quarter's snapshot under `docs/archive/` at the close, with its
  outcome line naming this plan.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `docs/architecture.md`,
`docs/backlog.md`, `docs/README.md`.

Tests: at minimum, lock both directions of the stamp, a throw that is not retried on the next
tick and a throw that is retried once the debounce admits it, since the expensive failure is a
retry loop that looks like ordinary activity; lock the cap over repeated throws; and lock that the
decision carries the message, since a decision without it reproduces the blindness this plan
exists to end.

References: `.kit/controller-tick-test.mjs`, the `runSelfReview` harness inside
`caseItem8p2_memory_quality_self_scoring_vs_proof_backed`, for driving the block with a
`selfReview` state override and a stubbed model.

## Out of Scope

- Whatever threw. The message this plan records is how it gets found, and the fix is its own plan
  or backlog entry once the message is read.
- Any change to `shouldSelfReview`, its debounce or its cap, or to the settings keys that
  configure them.
- Other tick sites whose catch may leave a trigger state unchanged. This plan reads one block.
  A sibling found during the work is a backlog entry, not a section.
- The decisions the flood evicted from the dev-persona store, which are gone.
- The nudge-state plan's changes to the idle branch of the same file.

## Assumptions

- assumed 2026-09-24 (the backlog entry's remedy): a failed attempt counts against the hourly cap exactly as a successful one does, so a review that always throws is bounded to `selfReviewMaxPerHour` attempts an hour; reversal: exempt failures from the count and accept a failing review retrying every debounce interval instead.
- assumed 2026-09-24 (default): the error message is cut at 200 characters and folded to one line, because the decision ring is read one line at a time; reversal: a different bound, one constant.
- assumed 2026-09-24 (default): the stamp is written inline in the block rather than as an export of `self-review.ts`, because it mutates session state and that module is pure; reversal: export it and pass the state in, one more test file in scope.
- assumed 2026-09-24 (brainstorming's one-section allowance): this spec skipped the blind read, the gating litmus and the plan review, since it is one section over one block with the tests named; reversal: run the three-part review before arming.

## Operator Verification

After the plan lands and the plugin is updated on each persona, the next self-review failure in
any persona's store reads `error: <message>` in its decision log, and the message names what
threw. A store that again shows the same `error` decision more than `selfReviewMaxPerHour` times
in one hour reopens the work.

## Open Questions

None.

## Related

- `docs/plans/agent_persona_nudge-state_v1.md`: edits the same controller tick's idle branch, not this block; whichever lands second merges the trunk first.
- `docs/plans/agent_persona_inbox-drain_v1.md`: moves the tick's inbox drain into a shared function and names this plan as runnable in any order beside it.

## Chapters

### Interim board 1 - 2026-09-24

Section 1 is at step 4, after review round 1 and its fix round. Commits on branch `self-review-flood`: e7da6cd (first green) and 08b2ebc (round 1 fixes), both pushed. No dispatch is in flight.

Held: the adversarial lens found acceptance bullet 2 contradicts the Approach. Clearing `pendingPeriodic` on a failed attempt brings the retry back at `selfReviewEveryTurns` (20 by default), not after the 5-turn debounce the bullet and the "retried after five turns" sentence state. The question went to the architect persona with a lean to keep the mechanism and amend the bullet. The test `caseCatchStampsAttempt_retriedOnceDebounceAdmits` still sets `selfReviewEveryTurns` to 5 and changes with the ruling.

Gate baseline at 08b2ebc, clean worktree: controller tick suite 3383 OK, 0 failures, exit 0 (3365 at 60df823 before the section); self-review unit suite all passed, exit 0; tsc --noEmit exit 0.

Next: apply the architect's ruling to bullet 2, the Approach sentence and the retry test, then run the round 2 review (one adversarial lens), then the close pass, the Chapter and finishing-work.

### Chapter 1 - 2026-09-24
Completed: 1. The catch stamps the attempt and names the error
Implemented By: implementer-sonnet for the first pass; the main session for the two fix rounds
Metrics: review rounds 2, closed major-closed; provenance 3 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 1
Decisions / Surprises:
- open: stamp a failed self-review attempt with the five success-path writes and name its error in the decision; serves Goal sentence 1 and section 1 bullets 1-4; adds no mechanism (moves existing writes, adds a message to an existing decision); about 25 lines; not building it leaves the every-tick flood.
- round 1, blind Major (overlapping ticks): move the attempt stamp to before the block's first await, so a tick overlapping a slow review reads it as spent; serves Goal sentence 1 ("retried only when the review's own debounce and hourly cap would admit a fresh review"); adds no mechanism (moves the stamp and removes the stamped flag); about -12 lines; not building it leaves a slow failing model call relaunching the review on every overlapping tick.
- round 1, adversarial Minor (catch formatting can throw): guard the message conversion with a fallback string; serves Goal sentence 1 (the error named in the decision); adds no mechanism beyond a try around String(); about 6 lines; not building it lets a hostile thrown value skip the decision.
- The spec contradicted itself on the retry cadence: its mechanism clause cleared `pendingPeriodic`, while its outcome sentence, bullet 2, the Intent and the backlog remedy said the retry follows the debounce. The question went to the architect persona, which had not answered by the time the section was otherwise ready. A consultant ruled for the outcome (keep the goal_done request owed on failure), against the orchestrator's lean. The Approach clause, the Intent's rulings line and a new Standing Brief Amendments block record it, which is approval drift above `## Chapters`, made deliberately.
- The first-pass `stampAttempt` helper with a once-only flag became one stamp before the first await, since overlapping ticks made the stamp's position the real fix. The plan's Approach, single-sourcing paragraph and section text were rewritten to match.
- The catch reuses `safeErrorText` and `LINE_TERMINATOR` from the same file rather than a hand-written fold, per the round-2 reuse finding.
- The main session's edit tool wrote `\u2028`-style escapes as literal characters, which broke the test file's parse and, when corrected by a whole-file rewrite, also escaped an unrelated case's deliberate literal U+2028. That line was restored byte for byte in cae0062.
Assumptions: none
Review Findings: review: adversarial + blind at opus, Workflow (round 1); review: adversarial at opus, Workflow (round 2). Round 1: blind Major (overlapping ticks) fixed in 08b2ebc; adversarial Major (bullet 2 against the Approach) resolved by the consultant ruling in 6b9b71d, the architect ask recorded beside it unanswered. Round 2: adversarial Major (fold test pins a choice) fixed in cae0062; adversarial Major (bullet 6 backlog move) is the close's by the bullet's own wording and is done at finishing. Minors: 11 fixed across the fix rounds (fold set, conversion throw, empty message, weak fold checks, wrong-rule comment, doc cap window and default, test pointer, stale plan text, overlap reach check, out-of-scope byte), 0 upgraded, 3 left with the reason: a lone surrogate from the 200-character cut is escaped by JSON and harms no one-line reader; the cost ledger counts completed model calls by design and no bullet names it; arbitrary thrown text in the local decision log is what the spec asks for, now bracket-neutralized and cut at 200. The last fix delta (cae0062) touches no outward action and adds no module, so it took the author's re-read rather than a round.
Stamps: adjudicated 6, stamped 0; none of the six operator-tier reads in the window changed what was built
Gate: targeted lane over the section: `.kit/controller-tick-test.mjs` 3385 OK, 0 failures, exit 0 (baseline 3365 OK, 0 failures, exit 0 at 60df823 on a clean worktree, 77 s); `.kit/self-review-unit-test.mjs` all passed, exit 0 (baseline the same); `tsc --noEmit` exit 0. Measured at cae0062, clean worktree D:/agent_persona-flood, 2026-09-24, no foreign test runner in the node process list. Test delta: 5 cases added, 20 checks, none retired or edited: `caseCatchStampsAttempt_notRetriedNextTick` pins bullet 1 and the owed goal_done request; `caseCatchStampsAttempt_retriedOnceDebounceAdmits` pins bullet 2 on the default settings; `caseCatchStampsAttempt_capBoundsRepeatedThrows` pins bullet 3; `caseCatchStampsAttempt_messageFoldedAndCut` pins the message folded to one line and cut at 200; `caseCatchStampsAttempt_overlappingTickDoesNotRelaunch` pins the stamp before the first await. None spawns a process.
Next: finishing-work
Commit Model: Branch-and-PR

### Interim board 2 - 2026-09-24

Finishing pass, base ref 60df823 (merge-base of `self-review-flood` with `main`). Step 1 QA passed at ae5dad7 on a clean tree: 28 lanes ran, 27 exit 0; `plan-record-unit-test.mjs` exited 127 on the Node teardown assertion the backlog already tracks, after `PASS: 0 failure(s)`, and exited 0 on two standalone reruns; the file is outside this changeset. Acceptance bullets 1 to 5 passed; bullet 6 is the close's. This repo defines no contention lane.

Steps 2 and 3 ran as one folded adversarial dispatch at fable, effort high, through Workflow; the resolved model was claude-fable-5-1 on 34 of 34 turns. Verdict approved with concerns. Tree unchanged across the round.

- Major (spec-traceable, the Standing Brief Amendments line): no case pinned a failed reactive-only attempt leaving `pendingPeriodic` unset. Fixed by `caseCatchStampsAttempt_reactiveOnlySetsNothing`, which builds the streak with three error turns; red with the catch re-setting the flag unconditionally, green on the real code.
- Minor: the cap case used the default cap of 2, so it could not tell a configured cap from the default. Fixed by setting 3.
- Minor: `err.name` was read outside the guard, so a throwing `name` getter escaped the block. Fixed by moving the fallback inside the try, bracket-neutralized.
- Minor: two stale plan sentences (the stamp as a local function; the five-turn retry stated without the goal_done qualifier). Fixed.
- Security advisory Minor: C0 control characters other than line terminators survive into the decision detail. Refused: the tick's outer catch already logs the same text raw, so the detail adds no channel, and no bullet names control-character stripping.
- Performance advisory: clear.

Gate after the fixes, clean worktree apart from these edits: `.kit/controller-tick-test.mjs` 3389 OK, 0 failures, exit 0; `.kit/self-review-unit-test.mjs` exit 0; `tsc --noEmit` exit 0.

Next: the fix delta's one-lens review and the step 4 goal read, then the Minor pass, docs curation, the close and the pull request.

### Chapter 2 - 2026-09-24
Completed: 1. The catch stamps the attempt and names the error (finishing pass)
Implemented By: the main session for the finishing fixes and the close
Metrics: finishing review rounds 2 (whole changeset, then the fix delta), closed minor-closed; provenance 1 spec-traceable Major, 0 fix-introduced, 0 new-requirement; goal read 4 declared, 0 refused, 0 asked, 0 unbuilt; advisory: 2 findings, 0 fixed, 1 deferred, 0 refused, 1 clear; NEEDS_CONTEXT 0; escalations 0; consults 0
Recap: Goal (verbatim): When this is done, a periodic or reactive self-review that throws is recorded once, with the error's message in the decision, and is retried only when the review's own debounce and hourly cap would admit a fresh review, so a controller whose review keeps failing writes at most a handful of decisions an hour rather than one every ten seconds. It matters because on 2026-09-23 the dev-persona persona's store held 174 decisions reading `periodic: pendingPeriodic (goal_done): error` over 34 minutes, the decision ring holds 200, and the flood evicted the goal loop's own record, so the nudge-cap events two other findings were traced from are no longer in that store. The thrown error was swallowed, so what failed is still not known.; What the tree does now: when the supervisor's periodic or error-triggered check of a worker's own activity is about to run, it first records the attempt, so a check that fails waits out the same five-turn pause and counts against the same two-an-hour limit as one that succeeds, and a failed check writes one line to the decision log naming what went wrong, with the error's name or "unprintable error" standing in where the message cannot be read.; Refinements during the run: the consultant ruled that a failed attempt owed to a goal_done keeps that request, so it is retried after five turns rather than twenty; the attempt stamp moved before the review's first await, because overlapping ticks could relaunch a slow failing review; the finishing review added a pin that a failed error-triggered attempt sets nothing and the fallback text pins; operator-pending items: after the plugin update on each persona, read the next self-review failure's decision line and count such lines per hour.
Decisions / Surprises:
- finishing, adversarial Major (spec-traceable, the Standing Brief Amendments line): pin that a failed reactive-only attempt leaves `pendingPeriodic` unset; serves the amendment's second half; adds no mechanism (one test case); about 30 lines; not building it leaves an unconditional re-set invisible to the suite.
- The first seeding of the error streak wrote the store after the harness had loaded it and never reached the session; the case now builds the streak with three real error turns, the same way other cases do.
- Security advisory Minor (C0 control characters survive into the decision detail): first refused on the ground that the tick's outer catch already logs the same text. The docs curator's sweep showed that catch logs nothing (`hooks/index.ts:6381-6383`), so the ground was false. Re-dispositioned as deferred: the text cleaner every decision path shares, `bracketSafeText` behind `safeErrorText`, keeps C0 for every writer, so the strip belongs there. It is a backlog entry. Interim board 2's "Refused" line is superseded by this one.
- Drift adjudication: five items, all deviation. D1 the stamp sits after the eligibility check, before the review's first await rather than the block's, which the architecture paragraph now states. D2 the fallback text (the error's name, `unprintable error`) is documented. D3 the backlog entry falsified by this change is retired at this close. D4 the test count is recorded in this Chapter. D5 `windowStart` is set only where it is zero, now stated. D6 the finding pass sends findings before its summary decision; the pre-change read (`git show 60df823:docs/architecture.md`, line 180) showed the old order predated this effort, and the sentence is corrected. Library hygiene: this plan gained a Related section naming the nudge-state and inbox-drain plans.
Assumptions: none
Review Findings: review: adversarial at fable high, Workflow, performance and security folded (whole changeset, resolved model claude-fable-5-1 on 34 of 34 turns); review: adversarial at fable high, Workflow (fix delta ae5dad7..a6e5d2f); goal read at fable through the Agent tool. Whole changeset: 1 Major fixed in a6e5d2f; 4 Minors fixed in a6e5d2f (cap case at 3, name fallback guarded, two stale plan sentences); security 1 Minor deferred to the backlog; performance clear. Fix delta: 2 Minors fixed in 4ee4376 (the two guarded reads split again, so an Error whose message getter throws still records its name; the two fallbacks pinned); that Minor pass took the author's re-read rather than a round. Goal read: BUILT-BUT-UNASKED 4, all accept-and-declare (the 200-character cut and its fallbacks, the reactive-only pin, the fold-and-cut pin, the two architecture sentences on the cap); ASKED-BUT-UNBUILT none. QA: build pass; 28 lanes, 27 exit 0 and `plan-record-unit-test.mjs` exit 127 on the known Node teardown assertion (backlog, same shape) after 0 failures, exit 0 on two reruns, outside this changeset; bullets 1-5 pass, bullet 6 done at this close.
Stamps: adjudicated 1, stamped 1 (a-trace-target-you-composed-cannot-check-your-own-work, operator tier, applied to the goal read's brief)
Gate: whole offline gate over the closed tree (4ee4376 plus the close edits), `.kit/scratch/self-review-flood/finishing/gate.sh`: 28 lanes, every one exit 0, 686 s; `.kit/controller-tick-test.mjs` 3393 OK, 0 failures (baseline 3365 OK, 0 failures at 60df823); `.kit/self-review-unit-test.mjs` all passed; `tsc --noEmit` exit 0; `injection-ledger.mjs` and `check-loader-rule.mjs` exit 0. Deferred by the operator gate policy: the five `live-*` suites and `supervisor-natural-exit-test.sh`. No contention lane is defined in this repo. No foreign test runner in the process list at start.
Test delta: 7 `caseCatchStampsAttempt_` cases in `.kit/controller-tick-test.mjs`, 28 checks over the base's 3365: the five Chapter 1 names, plus `caseCatchStampsAttempt_reactiveOnlySetsNothing` and `caseCatchStampsAttempt_fallbacksNameTheFailure`.
Next: none; the pull request from branch `self-review-flood`.
Commit Model: Branch-and-PR
