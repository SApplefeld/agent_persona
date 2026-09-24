# A failed self-review is retried on the review's own cadence, not every tick

Status: Ready
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

**Rulings after the spec shipped.** None yet.

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

**The fix is the catch writing what the success paths write.** After the decision, the catch
stamps `count += 1`, `windowStart` where zero, `lastAt = now`, `turnsSince = 0` and
`pendingPeriodic = false`, the same five writes. `pendingPeriodic` is cleared because the attempt
consumed the `goal_done` trigger, and the periodic path's other trigger, `turnsSince` reaching
`selfReviewEveryTurns`, brings the review back on its ordinary cadence. Under the defaults,
debounce 5 turns and cap 2 an hour, a review that always throws writes at most two decisions an
hour, and a review that throws once is retried after five turns.

**The decision names the error.** The detail reads `<trigger>: error: <message>`, where the
message is the thrown value's `message` where it has one and its string form otherwise, folded to
one line and cut at 200 characters, since the decision ring is read by `goal_status` and the
fleet board one line at a time. The reason the message was never recorded is the bare `catch`,
and the fix binds the error and reads it.

**Single-sourcing the stamp.** The five writes appear twice today and this plan adds a third
site. They move into one local function inside the block, `stampAttempt(now)`, that the three
paths call, so the next path added cannot forget one field. It is a local function rather than an
export of `self-review.ts` because it mutates `sess.state`, which that module does not touch, and
`shouldSelfReview` stays pure.

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

## Sections of Work

### 1. The catch stamps the attempt and names the error
Model: sonnet

In the `2a2` block of `hooks/index.ts`, the five state writes the two success paths share move
into one local function the block declares before its `try`, and the catch binds its error, writes
the decision `<trigger>: error: <message>` with the message folded to one line and cut at 200
characters, and calls the same function. The `sess.state.updatedAt = now` and `await persist($)`
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
- assumed 2026-09-24 (default): the stamp lives in a local function inside the block rather than an export of `self-review.ts`, because it mutates session state and that module is pure; reversal: export it and pass the state in, one more test file in scope.
- assumed 2026-09-24 (brainstorming's one-section allowance): this spec skipped the blind read, the gating litmus and the plan review, since it is one section over one block with the tests named; reversal: run the three-part review before arming.

## Operator Verification

After the plan lands and the plugin is updated on each persona, the next self-review failure in
any persona's store reads `error: <message>` in its decision log, and the message names what
threw. A store that again shows the same `error` decision more than `selfReviewMaxPerHour` times
in one hour reopens the work.

## Open Questions

None.

## Chapters
