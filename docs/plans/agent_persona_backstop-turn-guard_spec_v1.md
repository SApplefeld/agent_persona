# Guard the reply backstop to the persona's own turn

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-25

## Goal
The persona plugin's reply backstop no longer posts a background subagent's report to the operator's thread. The backstop, and the channel-origin flag reset beside it, fire only when the completing turn is the persona's own gate turn, not when a subagent finishes inside an open channel turn. So a dispatched blind read or review's full report stops reaching the operator as a `📣 Claude · answer`, while the persona's own forgotten-reply backfill still works when its own turn ends.

## Intent
The operator decided on 2026-09-25 to abandon the discord-channels approach and fix this in the persona plugin. The flood is a dispatched subagent's whole report landing on the operator's Discord thread several times a day, which makes the thread hard to read.

What done needs: the reply backstop and the channel-origin flag reset are both guarded to the persona's own turn completion, so a subagent's mid-turn completion neither posts a reply nor clears the channel-origin flag.

What done does not need: any change to the broker or the discord-channels repo, since the broker draws faithfully what the reply tool is handed; and no change to the backstop's behavior on the persona's own turn, since the forgotten-reply backfill is the feature and must stay.

Alternatives refused: gating the broker's answer surface, which was the abandoned discord-channels spec `channels_subagent-thread-flood_spec_v1.md`. Refused because it treats the symptom; the reply tool is being handed the wrong content by the plugin's backstop, so the fix belongs at the source.

Provenance: DEV-DISCORD pinned the cause on 2026-09-25 with the `.agentic-channel.jsonl` `channel_reply_backfilled` evidence and supplied the fix shape; the operator picked the persona-plugin home on the ARCHITECT relay thread; the fix shape is confirmed against the code at 11cd7ea.

## Approach
The reply backstop in the `turn.complete` handler of `hooks/index.ts` posts `e.answer` through `mcp__plugin_relay_channel-relay__reply` when `currentTurnIsChannelOrigin && !replyCalledThisTurn` and the other gates hold, but never checks that the completing turn is the persona's own. A background subagent's completion reaches `turn.complete` while the persona's channel turn is still open (the comment near the `currentGateTurnId` block says so), so it fires the backstop with the subagent's report. DEV-DISCORD confirmed this in the plugin's own `.agentic-channel.jsonl`: a `channel_reply_backfilled` decision for a turn id that no `turn.start` line ever opened, timed 8 seconds after a subagent's completion, and a controlled capture on claude 2.1.281 showing a subagent's finish fires `SubagentStop`, never `Stop`, so no broker hook carries the report.

There are two sites, because a subagent's completion also clears the channel-origin flag unconditionally, which would drop the persona's own backfill even after the backstop is guarded:
1. The backstop condition (near `hooks/index.ts:6689` at 11cd7ea): add the own-turn guard.
2. The channel-origin reset (near `:6715-6716`, `currentTurnIsChannelOrigin = false`): clear the flag only on the persona's own completion, so it survives a subagent's mid-turn completion and the persona's own later completion still backfills.

The guard is `isOwnTurn = (e.turnId === currentGateTurnId)`, captured before the reset block (near `:6660-6664`) that sets `currentGateTurnId = null` when `e.turnId === currentGateTurnId`. Capturing before that reset is required, since reading `e.turnId === currentGateTurnId` after it is always false on the persona's own completion. This is the true-boundary pattern the boundary-compaction plan uses; `turnIsOpen()` being false after the `openTurns.delete` is the recorded alternative. Line numbers move; the implementer pins them against the current tree.

## Sections of Work

### 1. Guard the reply backstop and the channel-origin reset to the persona's own turn
Model: opus
Capture `isOwnTurn = (e.turnId === currentGateTurnId)` before the `currentGateTurnId` reset block in `turn.complete`. Add `isOwnTurn` to the reply backstop's condition, so it fires only on the persona's own completion. Guard the channel-origin reset so `currentTurnIsChannelOrigin` clears only when `isOwnTurn`, preserving `wasChannelOrigin`'s existing downstream use for scoring; the implementer settles the exact placement.

Acceptance: a subagent completing inside an open channel turn does not fire the backstop and does not clear `currentTurnIsChannelOrigin`; the persona's own channel-origin turn completing with an answer and no reply-tool call does fire the backstop and does clear the flag; a non-channel, priming, or nudged turn is unaffected.
Files in scope: hooks/index.ts, .kit/controller-tick-test.mjs, .kit/tick-harness.mjs.
Tests: lock both directions. A subagent's mid-turn completion (a foreign turn id while the channel turn is open) posts no reply and leaves the channel-origin flag set; the persona's own completion backfills the reply and clears the flag. The expensive failure is suppressing the persona's own operator reply, so the own-turn direction must be pinned, not only the subagent direction.

## Out of Scope
- Any broker or discord-channels change; that repo's spec `channels_subagent-thread-flood_spec_v1.md` is abandoned and retired in place.
- The scoring of a subagent's completion beyond the channel-origin flag, unless the guard requires touching `wasChannelOrigin`.
- The other per-turn resets in the same handler (`currentTurnKind`, `toolErrorsThisTurn`, `wasNudged`) that a foreign completion also clobbers. DEV-DISCORD flagged them as the same shape, not needed to stop the flood; a follow-up if they cause misattribution.

## Assumptions
- assumed 2026-09-25 (default): the guard is `isOwnTurn = e.turnId === currentGateTurnId` captured before the reset, matching boundary-compaction's true-boundary pattern; reversal: `turnIsOpen()`-false after the `openTurns.delete`, the recorded alternative, if the id capture proves awkward.
- assumed 2026-09-25 (brainstorming 1-2 section allowance): this one-section fix with a precise, code-confirmed shape skips the blind read, the gating litmus and the plan review; the executing worker's own section reviewers stand in.

## Operator Verification
- Live reproduction on the fleet after the fix ships and the plugin updates: an operator Discord message opens a persona turn, a background subagent is dispatched before any reply-tool call, and it finishes while the turn runs. Before the fix, a `channel_reply_backfilled` decision is written and the subagent's report appears on the thread as a reply; after it, neither. This is the cross-process behavior the unit tests cannot see.

## Open Questions
- Still inferred, to confirm in the live check above by logging the `turn.start` and `turn.complete` ids and `e.answer.length` beside the backfill decision: that a subagent's completion carries an id no `turn.start` opened (the alternative is that it carries the parent's id, which would make the id guard inert and put the fault upstream), and that `e.answer` on that completion is the subagent's report. DEV-DISCORD's evidence supports both: the `channel_reply_backfilled` for turn 0e2d64f0 appears on no `turn.start` line, and its timing sits 8 seconds after a subagent's completion. The controlled run settles them.

## Chapters

### Chapter 1 - 2026-09-25
Completed: 1. Guard the reply backstop and the channel-origin reset to the persona's own turn
Implemented By: implementer-opus; the close pass by the main session
Metrics: review rounds 1, closed major-closed; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: section 1 open: adds completesGateTurn (hooks/index.ts:7112, the own-turn test already captured before the currentGateTurnId reset) to the reply backstop's condition and guards the currentTurnIsChannelOrigin reset with it; serves the Goal sentence "The backstop, and the channel-origin flag reset beside it, fire only when the completing turn is the persona's own gate turn" and section 1's acceptance; adds no mechanism (reuses the existing own-turn guard rather than a new isOwnTurn capture); size about 3 lines of code plus about 3 tick cases; not building it leaves a subagent's full report posted to the operator's thread as a reply several times a day.
  The Status header read `Ready` and now reads `In Progress`, set as this run started. The branch is stacked on `boundary-compaction-build` (PR 106), which already carries `completesGateTurn` and edits the same handler lines; this plan's pull request targets that branch and retargets to main when PR 106 merges. The guard is `completesGateTurn` rather than the spec's `isOwnTurn = e.turnId === currentGateTurnId`: it is that same test plus "no subagent agentId", captured at the same point, so it is the Approach's pattern with one more condition. The spec's Open Question is answered from the engine's type file rather than the live check: `TurnCompleteFields` in `.claude/types/claude-code.d.ts` (about lines 11402-11414) states a subagent's run raises no `turn.start` and its completion carries the subagent's `agentId`, and the `AgentSpawnResult` comment (about line 317) states a subagent's answer is its own `turn.complete`. Implementer concern 1: the "clears the flag" leg cannot go red if the own-turn reset were removed outright, since turn.start re-reads the flag at hooks/index.ts:6947; the reset's own-turn guard is pinned instead by the implementer's mutation probe (reverting it to the unconditional clear reddened 15 checks). Implementer concern 2, declared: the persona's own completion now reads wasChannelOrigin true after a subagent completed earlier in the channel turn, where it read false before, so it is skipped for scoring as "a channel message" and resets the nudge count as any channel turn does; that is the value the acceptance requires the flag to keep, and the earlier false was the defect's side effect.
Assumptions: none
Review Findings: review: adversarial + blind + security at fable, Agent tool (low; medium for security), after the capacity reading "fable capacity: scoped 30%, 7d 23%, 5h 27% (account 4, fetched 288s ago) -> dispatch". Adversarial APPROVED; blind APPROVED_WITH_CONCERNS; security CLEAR. Majors justified-not-fixed: blind M1 (orchestrator-made trace: the Goal sentence on firing only at the persona's own turn end), the backstop reads the channel flag after the handler's awaits, so a turn.start landing inside them would pair one turn's completion with the next turn's flag. The read predates this change, which only narrows the condition, and it rests on a turn starting during turn.complete, which the engine was measured not to do (project memory the-engine-awaits-the-turn-complete-chain-before-starting-the-next-turn; the same ground as the boundary-compaction plan's R5-1 and R5-2). Minors: 3 fixed in the close pass (the engine contract cited from the type file in the test's case comment, in the stale nudgedTurnId comment near hooks/index.ts:2821, and in the backstop comment; this settles the adversarial claim Minor and the blind and security "guard rests on an inferred shape" Minors), 0 upgraded, 4 left with the reason: the flag-survives direction is pinned by proxy (no harness seam on a module-private flag); a subagent's completion still runs scoring, untracked_work and the nudge-count reset (the spec keeps the other per-turn resets and subagent-completion scoring out of scope); a subagent's own reply-tool call suppresses the persona's backfill (routed to docs/backlog.md: a guard no clause names, and the operator does receive a reply); a channel turn whose turn.start this session never saw, such as one open across a plugin reload, is no longer backfilled (a known bound in a rare shape). The close-pass delta is comments only and took the author re-read against the type file.
Stamps: adjudicated 5, stamped 2 (the-engine-awaits-the-turn-complete-chain-before-starting-the-next-turn, stacked-prs-are-safe-here-because-this-repo-merges-rather-than-squashes); the 3 operator-tier reads concern the memory database host and did not steer this section.
Gate: targeted lane at SCOTT-CLAUDE, 2026-09-25T18:25Z, worktree backstop-turn-guard-build at 4f18096 plus the close pass unstaged, no foreign runner on the box: `npx tsc --noEmit` exit 0; `node .kit/controller-tick-test.mjs` 4404 OK lines / 0 FAIL, exit 0 (baseline at cd0b884 on this lane, the implementer's pristine run: 4383 OK / 0 FAIL, exit 0); `node .kit/injection-duplicate-test.mjs` exit 0; `node .kit/check-loader-rule.mjs` exit 0. 120 s wall. Test delta: one case added, caseChannelBackstop_onlyThePersonasOwnTurnEndBackfills, 21 checks over three completion shapes: "calls no tool" and "logs no channel_reply_backfilled" on the subagent's completion pin the subagent direction; "exactly one tool call", "the reply tool carrying the persona's own answer" and "one channel_reply_backfilled naming the persona's own turn" on the persona's own completion pin the own-turn direction and that the flag survived; two after-turn checks pin that nothing leaks to a keyboard turn. Watched red without the fix: 11 FAIL, exit 11. 0 tests retired, 0 edited to stay green, 0 added tests spawn a process. Contention: none.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: SCOTT-CLAUDE, 2026-09-25T18:27Z, no contention.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
