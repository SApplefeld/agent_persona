# A live new-goal verdict waits at most seven seconds for its wording, so a stuck model call cannot hold a message

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-10-01

## Goal

When this ships, the Haiku call that words a new turn record under a live `turn-open` verdict of `new-goal` is raced against a seven-second timer. When the timer wins, the record opens with the message excerpt, exactly as it does today when the call throws or returns no text, and the message goes on to the model. A message therefore waits at most seven seconds for the wording, plus the seam's own bounded live call, before the persona reads it.

## Intent

The operator's frame, on this persona's relay thread on 2026-10-01: they want Jev primary wherever it can be, with Haiku as the fallback, so they can gauge it. The persona named one specific objection to making `turn-open` live: under a live `new-goal` verdict, `wordNewRecordText` in `hooks/index.ts` awaits `$.model.complete` with no bound, ahead of the call that delivers the prompt, so a slow or stuck completion holds the operator's message with no end. The operator chose to fix that first and then make the question live ("Agreed, let's go Option 2"), with a ten-second bound the persona proposed and the operator accepted.

What done needs to do: bound that one completion at ten seconds; fall back to the excerpt on the timeout; keep the billing and the existing fallbacks as they are; prove in the tick suite that a completion that never answers no longer holds the message.

What done does not need to do: no shared bounded-completion wrapper for every model call, since the controller's calls run on a tick rather than in front of a prompt; no change to the seam's own live timer; no new decision or journal line for the timeout; no change to which questions are live, which the fleet roster carries and the operator owns.

Alternatives refused:
- A shared wrapper over every `$.model.complete` site. Refused: the backlog entry names the class, but only this site sits in front of a prompt's delivery, and the operator's objection was about this one.
- Bill nothing on a timeout. Refused: the completion was requested and runs to its end as an orphan, so it costs what an answered one costs, and the reason bucket is the operator's spend line.

Rulings after the spec shipped:
- 2026-10-01, the operator on the relay thread, choosing option one of three: the bound is 7,000 ms, not 10,000 ms. The finishing pass found that a `$.clock` wait runs the hook's own 10,000 ms budget, so a ten-second timer leaves no budget for the hook to open the record once it fires. Seven seconds leaves about one second after the seam's 2,000 ms live timer. This supersedes the ten seconds named above and in the first Assumption.

Provenance: written by DEV-PERSONA on 2026-10-01 from `hooks/index.ts:585-623` and `:779-783`, `hooks/decision-seam.ts:671-696` and `docs/backlog.md:867-877` at `0fb2a08`.

## Approach

**The race copies the seam's.** `hooks/decision-seam.ts:690-696` races `$.http.fetch` against `host.sleep(timeoutMs)`, both mapped so neither promise rejects, and lets the loser run on as an orphan because neither call takes an abort signal. `wordNewRecordText` does the same with `dp.model.complete` and `dp.clock.sleep(WORDING_TIMEOUT_MS)`. A completion that throws keeps today's path: no bill, `null`. A completion that answers keeps today's path: billed, then read. A timeout is billed, since the call was made, and returns `null`.

**The constant sits beside the function.** `WORDING_TIMEOUT_MS = 7_000`, with a comment naming why seven seconds: a one-line Haiku answer normally returns in about a second, and the bound only has to stop a stuck call.

**The documents follow.** `docs/architecture.md:262` gains that the wording waits at most seven seconds and falls back to the excerpt. The backlog entry at `docs/backlog.md:867` is retired, since its remedy is this change for the one site it names, and its class sentence is answered by the first refused alternative above.

## Standing Brief Amendments

- The wording timer is 7,000 ms, per the operator's ruling of 2026-10-01 under Intent.
- A timer that rejects or cannot be started reads as a timeout.
- The backlog entry on the unbounded completion is deleted whole, its class answered by the first refused alternative under Intent.
- `docs/architecture.md:262` states the bound.
- The hung-wording tick case also pins that the completion was issued, and that an answer arriving after the timer neither rewrites the record nor bills again.

## Sections of Work

### 1. The wording call is raced against a ten-second timer, and the suite proves a stuck call no longer holds the message
Model: opus
Locus: inline
`wordNewRecordText` in `hooks/index.ts` races the completion against `dp.clock.sleep(WORDING_TIMEOUT_MS)` as described under Approach. Its comment gains one sentence on the bound. `docs/architecture.md:262` and the backlog entry change as described.
Acceptance:
- A new tick case in `caseTurnRecord_everyLiveVerdict`'s family drives a live `new-goal` verdict with a completion that never settles. The submission settles once the harness fires the pending sleeps, one of which asks for 10,000 ms. The record that opens carries the message excerpt, and the reason bucket counts the call once.
- The same case run against the unfixed code leaves the submission unsettled after every pending sleep is fired, which is the red the fix turns green.
- The existing live new-goal cases pass unchanged: a worded record, an unusable result billed and falling back.
- `npx tsc --noEmit` exits 0. `node .kit/controller-tick-test.mjs` exits 0 and prints no `FAIL:` line.
Files in scope: `hooks/index.ts` (`wordNewRecordText` and the constant), `.kit/controller-tick-test.mjs` (the new case and its place in the case list), `docs/architecture.md` (line 262), `docs/backlog.md` (the entry at line 867).
Tests: the new case locks the bound, since removing the race leaves the submission unsettled and the case red.
References: `.kit/controller-tick-test.mjs:25223-25266` is the sibling for the live new-goal setup, and `:23051-23070` for a hung call held open by unfired harness sleeps.

## Out of Scope

- Any other `$.model.complete` site in `hooks/index.ts`.
- The seam's live timer and the backlog entry on the host calls ahead of it.
- Naming `turn-open` in the fleet roster's `jevLive`, which follows this plan's merge as an operator-approved roster edit.

## Assumptions

- assumed 2026-10-01 (source: the operator's reply on the relay thread): ten seconds is the bound; reversal: one constant. Superseded 2026-10-01 by the operator's ruling of seven seconds; a further change touches the constant and its comment, `docs/architecture.md:262` and the test's 7,000 literal.
- assumed 2026-10-01 (default): a timed-out call is billed like an answered one, because it ran; reversal: move the bill inside the answered branch.

## Operator Verification

- After the plugin cache updates and `turn-open` is named live on a persona, messages that start new work reach the persona promptly, and the record's text reads as a one-line summary on most of them. A message that waits visibly longer than about nine seconds, the seven-second bound plus the seam's two, before the persona reacts reopens this plan.

## Open Questions

None.

## Chapters

### Chapter 1 - 2026-10-01
Completed: 1. The wording call is raced against a ten-second timer, and the suite proves a stuck call no longer holds the message
Implemented By: main session (Locus: inline, tier opus, run on the session model)
Metrics: review rounds 1, closed clean; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: section open: race wordNewRecordText's completion against a 10,000 ms dp.clock.sleep and fall back to the excerpt; serves the Goal's first sentence; adds the timer race the Goal names, no unnamed mechanism; about 25 lines of code and 25 of test; not building it leaves a live new-goal verdict able to hold a message indefinitely. The session that opened this section ended while the adversarial reviewer was still out; a successor session read that reviewer's report from the predecessor's transcript, since the task output file was empty, and ran the close pass, close gate and this Chapter.
Failed approaches: none
Assumptions: none beyond the plan's own two
Review Findings: review: adversarial + blind + performance at fable, Agent tool. No Critical or Major from any lens. Minors: 4 fixed in the close pass (the comment now names the orphaned wording timer beside the seam's; the unread err capture in the threw arm is dropped; the hung case pins that the completion was issued; a late-answer leg pins that an answer after the timer neither rewrites the record nor bills again), 0 upgraded, 2 left with the reason (a completion rejecting after the timer is billed, per the plan's assumption that a timed-out call ran; ten seconds against the seam's two is the operator-accepted bound), 1 note-only with no change (the test's 200 x 5 ms poll is a ceiling). The close pass delta took an author re-read rather than a round.
Stamps: adjudicated 10, stamped 0 from the report; 1 stamped directly, a-hooks-module-can-pass-tsc-and-the-harness-and-still-fail-to-load, which added the loader-rule check to this close (PASS, exit 0)
Gate: targeted lane at 2026-10-01T20:03Z on the clean worktree at 54e3b8e plus the close-pass edits, box clear of foreign test runs at start: npx tsc --noEmit exit 0; node .kit/controller-tick-test.mjs exit 0, 6359 OK, 0 FAIL, 168 s, against the same lane's baseline of 6353 OK, 0 FAIL, 153 s at 0fb2a08; red run on the unfixed code: exit 3, three FAIL lines on the new case. Tests added: 6 checks in caseTurnRecord_everyLiveVerdict, all pinning the Goal's ten-second bound and its excerpt and billing fallback; none retired or edited; none spawns a process. node .kit/check-loader-rule.mjs: PASS, exit 0.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: 2026-10-01T20:00Z on this worktree; the reading is below.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 1 - 2026-10-01
Stage: finishing-work, between step 4 (goal read) and the fix path. Base ref 0fb2a08. Steps 1 to 4 have run; the fix path waits on one operator answer.
Live dispatches: none on this plan.
Gate baseline: whole gate at 3c8fb88, 2026-10-01 20:04:11Z to 21:12:31Z on the worktree D:/agent_persona/.claude/worktrees/turn-open-wording-bound, machine SCOTT-CLAUDE: 33 lanes, every one exit 0, runner exit 0; tick lane 6359 OK, 0 FAIL against 6353 at 0fb2a08. Contention lane `.kit/live-all.sh` exit 10, its designed refusal on a live ARCHITECT persona claim. Another session's kit gate (`node --test test/*.test.js`) overlapped part of the run. QA verifier (fable): PASS on every Section 1 criterion.
Reviews: security (fable, high) CLEAR, no findings. Adversarial (fable, high) APPROVED_WITH_CONCERNS, four Minors. Performance (fable, high) one Major and two Minors.
Rulings adopted since the last boundary:
- Goal read (scope-adjudicator, fable): built-but-unasked 4, all accept-and-declare; asked-but-unbuilt 0. Declared: a rejecting or unstartable timer reads as a timeout; the backlog entry deleted whole; docs/architecture.md:262 states the bound; the hung case's issued-call and late-answer checks.
- Performance Major, relevance ruling CONFIRM (scope-adjudicator, fable): WORDING_TIMEOUT_MS of 10,000 ms equals the hook budget of 10,000 ms, and a `$.clock` wait runs that budget (.claude/types/claude-code.d.ts:3075-3077, 4507-4509, 4523), so a timed-out wording likely overruns prompt.submit and the engine runs next(e) on the hook's behalf, dropping its context blocks. Disposition: fix now. The value changes the operator-accepted ten seconds, so it went to the operator on 2026-10-01 with a recommendation of 7,000 ms (the seam's 2,000 ms live timer plus 7,000 ms leaves about one second of budget).
Next action: on the operator's answer, set the constant and its comment, docs/architecture.md:262, the test's 10,000 literal and the plan's Goal, Intent and Assumptions to the chosen value; run the tick lane and tsc; take the adversarial lens over the fix delta; then the Minor pass over .kit/scratch/turn-open-wording-bound/finishing/minors.md, step 5 docs curation, the final Chapter, the archive, the handoff gate and the pull request.
