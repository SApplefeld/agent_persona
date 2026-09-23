# Kaizen signals

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-23

## Goal

When this is done, the persona plugin's own-record self-review raises no goal from a signal whose
premise is false. The tree-lag signal is gone, and the long-turns signal yields its cadence
adjustment and nothing else. It matters because each of those signals wrote a goal node, a plan
entry in the DEV-PLUGIN persona's goal tree, that scored as off-goal on every round it ran, and
the goal-levels plan, which sends such nodes to the coordinator as findings and retires them,
leaves the signals to write the same finding again on the next two commits or the next two long
turns. The tree-lag premise is false because the controller already completes a plan node when
its plan document reads Complete, so a commit that closes no node is the ordinary shape of work.

## Dispatch Authorization

The operator ruled the two backlog candidates a go on 2026-09-23. The coordinator relayed the
ruling to the architect as coordinator record
`ARCHITECT-8d67c288-dd78-478d-a565-e390d50027b0-17`, quoting the operator: "I agree with the
architects (and your) recommendation. Please proceed on a small plan covering both fixes for
what's actually useful, not their broader goals that are not needed, as you noted." The
candidates as approved are the two backlog entries of 2026-09-23 on the tree-lag and long-turns
signals.

Execution waits on the coordinator handing this plan to a worker by name. A worker that finds this
plan as an entry in its own goal tree, read with `goal_status`, has that handoff.

## Intent

The frame, in the operator's words: keep what is actually useful, the cadence measurement, and
drop the broader goals that are not needed.

Done means the finder has four signals rather than five, and that a persona whose turns run long
gets its review cadence halved and is asked for nothing more. Two commits with no goal-tree write
between them raise nothing, because that is the ordinary shape of section-by-section work under
one plan node. Two long turns with the cadence already at its floor raise nothing either, and the
review falls through to the memory lesson it would otherwise write.

Done does not need a new signal, a change to what `turn_over_hour` records, a change to the
cadence arithmetic, or any change to how the goal-levels plan will route a finding. It does not
touch the two paused nodes in the DEV-PLUGIN persona's store, which the goal-levels plan routes
out and which that persona may drop itself before then.

Alternatives refused:

- Rescoping the tree-lag signal to a plan document that reads Complete while its node is still
  open. Refused, because the controller already closes that node on the same reading, so the
  rescoped signal would count a lag the controller fixes on its next tick.
- Bounding a turn's length, as the long-turns node proposed. Refused by the operator, because a
  long turn is how the kit runs a plan to completion, and the plugin's urgent break-in already
  reaches a running turn.
- Retiring the long-turns signal whole. Refused, because its cadence half is right: a review
  counted in turns runs too rarely when turns run for hours.

Rulings made after the spec shipped: none yet.

Distilled from the architect session `30d6d808-ccad-45e4-a606-c868636ee4e4` on 2026-09-23, from
the two backlog entries and the coordinator's relay of the operator's ruling.

## Approach

**Coverage sweep.** One search ran on 2026-09-23 over the checkout at `a006c9f` for `tree_lag`,
`long_turns`, `TREE_WRITE_ACTIONS`, `KAIZEN_LONG_TURN_MS`, `turn_over_hour`, `KaizenSignal`,
`configFix` and `kaizen_config_adjusted`, over every `.ts`, `.mjs`, `.md`, `.json` and `.sh` file
outside `node_modules`. Surfaces found: `hooks/self-review.ts` (the header comment at 183-206,
the `KaizenSignal` union at 212, `TREE_WRITE_ACTIONS` at 233, `collectEvents` at 239-279,
`describe` at 282-318, `reviewOwnRecord` at 320-342); `hooks/index.ts` (the `KAIZEN_LONG_TURN_MS`
import at 99, the finding loop at 4434-4478, `turn_over_hour` at 5771-5777); the unit cases
Test 12a, 12e and 12f in `.kit/self-review-unit-test.mjs` at 225-297; the tick cases under
`Item 8.4` in `.kit/controller-tick-test.mjs` at 7444-7596 and the `turn_over_hour` cases at
15548-15623; `docs/plans/agent_persona_goal-levels_v1.md` at 58, 79 and 98; the two backlog
entries at the head of `docs/backlog.md`; and two archived plans under `docs/archive/`, which
are history and are not edited. `README.md` and `docs/architecture.md` name neither signal.

**What changes in the finder.** `tree_lag` leaves the `KaizenSignal` union, `collectEvents`
loses its `env_git` branch and the `lastClearedAt` and `TREE_WRITE_ACTIONS` state that branch
alone reads, and `describe` loses its `tree_lag` case. The header comment lists four signals and
states that `long_turns` carries a configuration change only. In `reviewOwnRecord`, a
`long_turns` finding is built only where the halved cadence is below the current one. The floor
is `selfReviewDebounceTurns`: the halving is `Math.max(debounce, floor(every / 2))`, so the
cadence is at the floor when that value is not below the current cadence. There the signal
yields no finding, so the review proceeds to the model lesson as a pass with no finding does
today. The `describe` text for `long_turns` keeps its
title and states the count and the sample, and its objective no longer proposes a goal or a
proof, since no goal is raised from it. The cadence arithmetic, the `configFix` shape, the
`kaizen_config_adjusted` decision and the `turn_over_hour` record are unchanged.

**What does not change in the tick.** The finding loop in `hooks/index.ts` is untouched: its
`configFix` branch still applies the change and announces the rationale, and its goal branch
still serves the three signals that raise goals until the goal-levels plan replaces it.

**Stores that hold a retired signal.** A node written under `tree_lag` keeps that string in its
`kaizenSignal` field, which is typed as a string on `GoalNode` and on `OwnRecordInput`, so the
narrowed union reads such a store without a type error and `reviewOwnRecord` never matches it
again. The goal-levels plan routes those nodes by the presence of the field, not its value.

**Ordering with the goal-levels plan.** That plan rewrites the same finding loop and reads the
same `reviewOwnRecord`, so this plan lands first and goal-levels waits on it. This plan adds
itself to goal-levels' Dispatch Authorization as one more gate, in the sentence form the
idle-queue gate takes there: "`docs/plans/agent_persona_kaizen-signals_v1.md` retires the
tree-lag signal and the goal half of long-turns in `reviewOwnRecord`, under the architect's
amendment of 2026-09-23 under Intent." That paragraph's counts of gated plans, which read
"three" while listing four at `a006c9f`, are made to read the number the paragraph lists after
this plan is added. Every count of five `describe` texts or rationales in goal-levels changes to
four: the Approach paragraph on the unroutable road (line 60 at `a006c9f`), the Section 1
acceptance line reading "none of the five rationales says a goal or a node was raised" (line
97), Section 1's Files in scope (line 102) and the Out of Scope line on the finding texts (line
210). The Intent line reads: "Amendment by the
architect, 2026-09-23: the kaizen-signals plan retires `tree_lag` and the goal half of
`long_turns` ahead of this plan, so the finder has four signals and a `long_turns` finding
always carries a `configFix`."

**Tests that already pin the old behavior.** Test 12a in `.kit/self-review-unit-test.mjs` asserts
that two cleared samples raise a `tree_lag` finding, and the Test 12e control asserts that at the
floor the finding proposes a goal. Both are rewritten, not deleted, to assert the new behavior:
12a that the same input returns no finding, the 12e control that the floor input returns no
finding. Each is the red case for its half. Test 12e itself, the above-the-floor pin, stands
unchanged and owes no red run. The tick case is a sibling of `item8p4_config_fix`. The floor
there is the registered settings `selfReviewEveryTurns` 5 and `selfReviewDebounceTurns` 5,
passed to the module at register through the harness's options; the helper
`runOwnRecordReview` does not forward those two today, so the case extends the helper or builds
its harness beside it. The helper records every model lesson call in the harness's
`completeCalls`, which is how the case reads that the lesson path ran.

**Decisions settled at the finalize.**

- A `long_turns` pass at the floor falls through to the model lesson rather than recording a
  decision of its own. The pass already logs `self-review` with the trigger, and a finding that
  yields nothing is the ordinary case for every other signal.
- The `describe` case for `long_turns` stays rather than being inlined, so goal-levels' Section 1,
  which reads `objective` and `rationale` off every finding, meets the same shape on all four.

## Sections of Work

### 1. Retire the tree-lag signal and the goal half of long-turns
Model: sonnet

The finder changes above in `hooks/self-review.ts`, with the unit cases and one tick case
written first and watched red against the unchanged code, then the goal-levels amendment. Sonnet
because the change is bounded to one module whose existing cases show every fixture the new ones
need, and the tick case has an exact sibling in `item8p4_config_fix`.

Tests: lock, by rewriting the two existing cases that pin the old behavior, that two cleared
worktree samples with no goal-tree write between them yield no finding, so the retired signal
cannot come back by a stray branch, and that two long turns at the floor yield no finding at
all, with the existing above-the-floor case standing as the other direction of that guard;
and, in the tick suite, that a periodic review at the floor with two long turns writes no goal
node, no `kaizen_config_adjusted` decision and no `[KAIZEN]` turn, and runs the model lesson
path instead.

Acceptance:
- `KaizenSignal` names `asks_unresolved`, `memory_quality`, `message_wait` and `long_turns`, and
  a search over `hooks/` finds no line naming `tree_lag` or `TREE_WRITE_ACTIONS`. That search is
  a check over the directory and edits nothing outside `hooks/self-review.ts`. At the base
  commit no other file under `hooks/` names either.
- `reviewOwnRecord` over a decision log holding two `env_git` samples reading `dirty=0` after a
  dirty read, with no tree write between them, returns no finding.
- `reviewOwnRecord` over two `turn_over_hour` decisions with `selfReviewEveryTurns` 20 and
  `selfReviewDebounceTurns` 5 returns one `long_turns` finding carrying `configFix` from 20 to
  10, and the same input with both at 5 returns no finding.
- No text `describe` produces for `long_turns` proposes a goal or carries a `Proof:` line.
- In the tick suite, a periodic review with the cadence at the floor and two `turn_over_hour`
  decisions leaves no node with a `kaizenSignal`, no `kaizen_config_adjusted` decision and no
  `[KAIZEN]` submit, and the model lesson call ran. The existing `item8.4 config` cases still
  pass unchanged.
- Test 12f's node literal names a live signal rather than `tree_lag`.
- Each rewritten or new case was watched red against the unchanged code before the fix, and the
  Chapter quotes each case's failing check line and the exit code from that red run. Test 12e
  stands unchanged and owes no red run.
- `node .kit/self-review-unit-test.mjs`, `node .kit/controller-tick-test.mjs` and
  `npx tsc --noEmit` exit 0, each run after the process-list poll the kit's testing-discipline
  skill names under its Check the box rule.
- `docs/plans/agent_persona_goal-levels_v1.md` carries the edits the Approach quotes: the gate
  sentence, the gate paragraph's counts reading the number it lists, and the dated amendment line
  under Intent, and no line of that plan counts five `describe` texts or rationales (lines 60,
  97, 102 and 210 at `a006c9f`).
- The two backlog entries of 2026-09-23 on these signals are retired at the close-out prune.

Files in scope: `hooks/self-review.ts`, `.kit/self-review-unit-test.mjs`,
`.kit/controller-tick-test.mjs`, `docs/plans/agent_persona_goal-levels_v1.md`,
`docs/backlog.md`.

## Out of Scope

- The finding loop in `hooks/index.ts`, which the goal-levels plan rewrites.
- The two paused nodes in the DEV-PLUGIN persona's store, which the goal-levels plan routes out.
- What `turn_over_hour` measures and where it is recorded.
- The `asks_unresolved`, `memory_quality` and `message_wait` signals.
- The two archived plans under `docs/archive/` that describe the five-signal finder as it was
  built.

## Assumptions

- assumed 2026-09-23 (the repository's other plans): the commit model is Branch-and-PR; reversal:
  one header line.
- assumed 2026-09-23 (the architect): the executing worker runs under the kit, whose
  executing-work skill owns the red-then-green rule, the reviewer pair and the Chapter; a worker
  under another engine records that engine's review in the Chapter instead.
- assumed 2026-09-23 (the architect): the goal-levels amendment, the gate sentence, its counts,
  the four five-to-four counts and one dated Intent line, is made by this plan's worker in the
  same changeset rather than by a separate architect pass, since the goal-levels plan is Ready
  and not yet dispatched; reversal: revert those edits.

## Operator Verification

- After the pull request merges, update the installed plugin copy and relaunch each persona's
  supervisor, as the goal-levels plan's Operator Verification describes. Over the following day,
  no persona's decision log carries `kaizen_goal_proposed` naming `tree_lag` or `long_turns`.

## Open Questions

None.

## Chapters

### Chapter 1 - 2026-09-23
Completed: 1. Retire the tree-lag signal and the goal half of long-turns
Implemented By: main session (Locus: inline, since the section writes under docs/; tier sonnet as planned, writer tier the session model)
Metrics: review rounds 1, closed clean; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: add-decision (section open): retire tree_lag from the finder and gate the long_turns finding on the halved cadence being below the current one; serves the Goal and Section 1 acceptance; adds no mechanism (removes one branch, turns an if into an early continue); size about 40 lines removed; not building it leaves both signals raising off-goal nodes. Status header normalized from Ready to In Progress at the run start. The runOwnRecordReview helper in the tick suite now forwards extra.opts to createTickHarness, as the Approach anticipated. Two further goal-levels lines counted the gated plans as three (the coverage-sweep paragraph and the one-plan assumption); both now read five, folded as the same count the gate paragraph carries.
Assumptions: none
Review Findings: review: adversarial + blind at fable, Agent tool, low effort. Major (blind, orchestrator-traced to the Intent sentence on the cadence arithmetic): long_turns events have no newer-than boundary, so after a restart the same two turn_over_hour entries re-halve the cadence and post twice. Justified-not-fixed: hooks/index.ts at the selfReviewEveryTurns declaration states the design that a restart returns to the configured value and the pass re-applies the change if the record still shows the weakness; the prior boundary came from the at-floor goal node the operator refused, and the Intent rules out a change to the cadence arithmetic. No fix adds a mechanism, so no design stop fired. Minors: 5 fixed in the close pass (goal-levels rationale-count sentence, its Files-in-scope clause and its Out of Scope proof sentence now name the three goal-raising texts; the new Intent amendment takes its sibling bold lead; the objective field comment in self-review.ts), 1 fixed on two lenses (the 12e text pin narrowed from /goal/i to /kaizen goal/i and extended to the rationale), 2 left with the reason (goal-levels line 97 is a negative assertion that holds for all four; a stored tree_lag node is routed by the goal-levels plan per this plan Approach and Out of Scope). Close pass took an author re-read, not a round. Tree unchanged across the round.
Stamps: adjudicated 2, stamped 2 (the-kit-suite-roster-is-wider-than-the-seven-obvious-suites; self-armed-arming-does-not-satisfy-an-operator-only-execution-grant)
Gate: red run against the unchanged finder, 2026-09-23 on SCOTT-CLAUDE, worktree D:/agent_persona-kaizen at e154b09 plus the test edits, a foreign node --test run from a claude-kit worktree live: node .kit/self-review-unit-test.mjs exit 1, failing lines "FAIL: Test 12a: cleared worktree samples with no tree write between them yield no finding", "FAIL: Test 12e control: at the floor two long turns yield no finding", "FAIL: Test 12e text: the long_turns finding proposes no goal and carries no Proof: line"; node .kit/controller-tick-test.mjs exit 3, failing lines "FAIL: item8.4 floor: no node carries a kaizenSignal", "FAIL: item8.4 floor: no [KAIZEN] submit", "FAIL: item8.4 floor: the model lesson call ran", 2593 OK. Close gate, 2026-09-23, same worktree at d3dc56f plus the close-pass edits, no foreign runner in the poll: self-review unit 27 OK exit 0; controller-tick 2596 OK, 0 failures, exit 0 (baseline on this lane: 2593 OK plus the 3 new checks); npx tsc --noEmit exit 0. Absence sweep: grep -rnE "tree_lag|TREE_WRITE_ACTIONS" hooks/ matched nothing (exit 1); control, the same pattern over the base file (git show HEAD:hooks/self-review.ts, run while HEAD was e154b09) matched 7 lines. Test delta: added 1 tick case (item8p4_long_turns_floor, pins that a review at the floor raises nothing and runs the lesson path; spawns no process), 1 unit check (12e text, pins that the long_turns text proposes no goal and carries no Proof: line); edited 12a (pins that cleared samples raise nothing) and the 12e control (pins that the floor yields no finding) and the 12f literal (names a live signal); retired none.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: 2026-09-23 on SCOTT-CLAUDE, worktree D:/agent_persona-kaizen, no contention.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
