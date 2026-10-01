# A live new-goal verdict waits at most ten seconds for its wording, so a stuck model call cannot hold a message

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-10-01

## Goal

When this ships, the Haiku call that words a new turn record under a live `turn-open` verdict of `new-goal` is raced against a ten-second timer. When the timer wins, the record opens with the message excerpt, exactly as it does today when the call throws or returns no text, and the message goes on to the model. A message therefore waits at most ten seconds for the wording, plus the seam's own bounded live call, before the persona reads it.

## Intent

The operator's frame, on this persona's relay thread on 2026-10-01: they want Jev primary wherever it can be, with Haiku as the fallback, so they can gauge it. The persona named one specific objection to making `turn-open` live: under a live `new-goal` verdict, `wordNewRecordText` in `hooks/index.ts` awaits `$.model.complete` with no bound, ahead of the call that delivers the prompt, so a slow or stuck completion holds the operator's message with no end. The operator chose to fix that first and then make the question live ("Agreed, let's go Option 2"), with a ten-second bound the persona proposed and the operator accepted.

What done needs to do: bound that one completion at ten seconds; fall back to the excerpt on the timeout; keep the billing and the existing fallbacks as they are; prove in the tick suite that a completion that never answers no longer holds the message.

What done does not need to do: no shared bounded-completion wrapper for every model call, since the controller's calls run on a tick rather than in front of a prompt; no change to the seam's own live timer; no new decision or journal line for the timeout; no change to which questions are live, which the fleet roster carries and the operator owns.

Alternatives refused:
- A shared wrapper over every `$.model.complete` site. Refused: the backlog entry names the class, but only this site sits in front of a prompt's delivery, and the operator's objection was about this one.
- Bill nothing on a timeout. Refused: the completion was requested and runs to its end as an orphan, so it costs what an answered one costs, and the reason bucket is the operator's spend line.

Rulings after the spec shipped: none yet.

Provenance: written by DEV-PERSONA on 2026-10-01 from `hooks/index.ts:585-623` and `:779-783`, `hooks/decision-seam.ts:671-696` and `docs/backlog.md:867-877` at `0fb2a08`.

## Approach

**The race copies the seam's.** `hooks/decision-seam.ts:690-696` races `$.http.fetch` against `host.sleep(timeoutMs)`, both mapped so neither promise rejects, and lets the loser run on as an orphan because neither call takes an abort signal. `wordNewRecordText` does the same with `dp.model.complete` and `dp.clock.sleep(WORDING_TIMEOUT_MS)`. A completion that throws keeps today's path: no bill, `null`. A completion that answers keeps today's path: billed, then read. A timeout is billed, since the call was made, and returns `null`.

**The constant sits beside the function.** `WORDING_TIMEOUT_MS = 10_000`, with a one-line comment naming why ten seconds: a one-line Haiku answer normally returns in about a second, and the bound only has to stop a stuck call.

**The documents follow.** `docs/architecture.md:262` gains that the wording waits at most ten seconds and falls back to the excerpt. The backlog entry at `docs/backlog.md:867` is retired, since its remedy is this change for the one site it names, and its class sentence is answered by the first refused alternative above.

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

- assumed 2026-10-01 (source: the operator's reply on the relay thread): ten seconds is the bound; reversal: one constant.
- assumed 2026-10-01 (default): a timed-out call is billed like an answered one, because it ran; reversal: move the bill inside the answered branch.

## Operator Verification

- After the plugin cache updates and `turn-open` is named live on a persona, messages that start new work reach the persona promptly, and the record's text reads as a one-line summary on most of them. A message that waits visibly longer than ten seconds before the persona reacts reopens this plan.

## Open Questions

None.

## Chapters
