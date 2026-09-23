# Ask bookkeeping cleanup

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

When this is done, a persona's record of its open operator question always agrees with the goal
tree and with the ask records in the store. Three paths break that agreement today, and each leaves
a worker stuck behind a question nobody can see or answer, or holding an active entry its own
pointer does not name. It matters because a stuck ask stops all new work on the persona until the
ask expires. The wait is `askOperatorWaitMs`, 60 minutes by default, and an ask never expires where
that option is 0.

## Dispatch Authorization

The operator ruled this backlog candidate a go on 2026-09-22. The coordinator relayed the ruling to
the architect as coordinator record `ARCHITECT-8d67c288-dd78-478d-a565-e390d50027b0-14`, quoting
the operator: "I think both are great. I agree with both of those. Please proceed." The candidate
as approved was the three backlog defects below, fixed in one plan.

Execution waits on the coordinator handing this plan to a worker by name. A worker that finds this
plan in its own queue has that handoff.

## Intent

The frame, in the operator's standing words: an idle worker's target is an empty tree and an empty
queue, and a worker escalates only on genuine confusion. An ask the operator cannot see, or an
active entry the pointer does not name, is a worker stuck for a reason nobody chose.

Done means each of the three paths below leaves exactly one truth: the ask the slot names is the
one open ask in the store, and the entry marked active is the one `activeGoalId` names. Each path
has a case in the tick suite that fails on the code as it stands today.

Done does not need a new ask status, a new store key, a change to how long an ask waits, or any
change to which node the ASK-marker path pauses. That path is the worker's turn-final `ASK:` line,
which the plugin turns into an ask record while pausing only the node the line names.
`closeAskOnNode` in `hooks/index.ts` and the ask record's existing `resumed` and `answered` statuses
carry what the fixes need.

Alternatives refused:

- Closing the first ask as superseded when an error streak opens a second. Refused, because it
  needs a new `AskStatus` value in `hooks/operator.ts` and drops the operator's own pending
  question in favor of a streak notice.
- Pausing the leaf on an error streak while an ask is already open, with no ask of its own.
  Refused, because a paused leaf with no ask has nothing to resume it, which is the stuck state
  this plan exists to remove.
- Refusing the thread-reply reactivation when another entry is active. Refused, because the
  operator answered the asked entry's question and expects that entry to resume, as `goal_resume`
  already delivers.
- Three plans, one per path. Refused, because the three fixes share one file, one helper and one
  test file, and each is a few lines.

Rulings: none at the write, and one after it.

- Ruling by the architect, 2026-09-22, on the worker's scope question: the reader-answer drain at the D5 close is a fourth path and is fixed here.

Provenance: distilled from DEV-PERSONA's draft of 2026-09-22 at `e12a614` and the architect's read
of `hooks/index.ts` at `origin/main` `3b1823b` the same day.

## Related plans

None open touches these paths. The no-goal-idle plan (archived, PR 73) changed the error-streak
branch's no-active-node arm and left the active-node arm as it is; this plan changes that arm.
The goal tree curation plan (archived, PR 71) made `goal_create`'s replacement deliberate and left
the ask slot untouched. The goal levels plan (`../plans/agent_persona_goal-levels_v1.md`, Ready)
adds a `goal_create` refusal, which has to sit ahead of this plan's ask close, since a refused
`goal_create` touches the slot on no path.

## Approach

**Decisions settled at the finalize**, by the architect on 2026-09-22, answering the draft's open
questions.

- With an ask already open, an error streak logs and does not
  pause. The `error_streak` decision detail names the open ask id, no second ask record is written,
  and the leaf stays active. The streak re-fires only after a new error, so a leaf that keeps
  failing is logged again rather than silenced.
- A `goal_create` that resets the tree closes whatever open ask
  the slot names, whether or not `replace` was passed and whether or not the ask's node is on the
  tree being replaced. The record is set to `resumed`, the `ask_answered` decision names
  `goal_create`, and the slot is cleared. This does not go through `closeAskOnNode`'s node match,
  because the ask's node is leaving the tree.
- The thread-reply close pauses every entry whose status is
  `active` and is not the asked one, then reactivates the asked entry and sets `activeGoalId` to
  it. `goal_resume` reads the pointer to find the entry it pauses; this close reads status, because
  a stale or null pointer is the very state defect 3 leaves, and the Goal's one-active-entry truth
  has to hold on the way out whatever the pointer said on the way in. The pause writes one
  decision, action `paused_by_reply`, in the shape of `goal_resume`'s `paused_by_resume`.

**What exists today.** Each point below was read at `origin/main` `3b1823b` on 2026-09-22. Line
numbers move as other plans merge, so find the code by the names and comment text given.

- `pendingAskId` is one slot on the persona state. Only one ask can be open at a time, because the
  slot holds only one id.
- `closeAskOnNode` (`hooks/index.ts:1943`) closes the ask `pendingAskId` names when that ask is
  `open` and its `nodeId` is the node passed in. It sets the record's status to `resumed` and logs
  `ask_answered` naming the tool that closed it. The caller clears `pendingAskId`.
- `goal_resume` (`hooks/index.ts:7368`) is the reference behavior for reactivation. Where
  `activeGoalId` names a different entry whose status is `active`, it pauses that one entry with a
  `blockedReason` and a `paused_by_resume` decision. It then sets the target `active`, sets
  `activeGoalId` to it, and closes an ask on it through `closeAskOnNode`.
- `enforceInvariants` in `hooks/agent-state.ts` runs on every store load and repairs a pointer that
  does not name the active entry. It is the backstop this plan leaves in place, not the fix.
- `goal_add`'s no-active-leaf branch (the handler for `mcp__agentic-plugin__goal_add`, the comment
  reading `goal_add's no-active-leaf branch reads` near `hooks/index.ts:7178`) treats an open ask as
  a hold: with an ask open it activates nothing on the tree.
- The tick suite is `.kit/controller-tick-test.mjs`, run as `node .kit/controller-tick-test.mjs`.
  It drives the real controller through a fake harness with a stubbed clock and asserts through
  `check(...)` lines. Its existing error-streak cases are the sibling shape for the new ones.

**The three defects.** Each was found by an earlier plan's review and parked in the backlog. The
draft's commit moved the three entries to `docs/archive/backlog-2026-Q3.md` with a retirement line
naming this plan, so this plan owns them and retires nothing further.

1. **An error streak overwrites an open ask.** The controller tick's error-streak branch (the block
   opening `// 2a. C3: error streak branch`, `hooks/index.ts:4305`) sets `pendingAskId` to a new ask
   on its active-node arm without checking the slot. A leaf can be active while an ask is open,
   because the ASK-marker path pauses only the node it names. The first ask record then stays
   `open` in the store, and no answer can reach it.
2. **`goal_create` leaves a stale ask.** A `goal_create` that resets the tree (the handler for
   `mcp__agentic-plugin__goal_create`, the lines `sess.state.goals = [root]` and
   `sess.state.activeGoalId = null`) resets `activeGoalId` and nothing else that names a node.
   `pendingAskId` can still name an open ask on an entry that now lives only in
   `.agentic-goal-history.jsonl`. While it does, `goal_add`'s no-active-leaf branch reads the ask as
   a hold and activates nothing on the new tree.
3. **A thread reply reactivates without the pointer.** The ask close in the `prompt.submit` handler
   (the block opening `// D5b (bullet 1)`, `hooks/index.ts:7985`) sets the record `answered`, sets
   the asked entry's status to `active` where it was paused, and never sets `activeGoalId`. Until
   the next store load runs `enforceInvariants`, anything that keys on the pointer misreads the
   tree. `goal_done` with no `nodeId` is one such reader.

**The design.**

1. The error-streak branch's active-node arm checks `pendingAskId` first. With an ask open, it
   pushes one `error_streak` decision whose detail reads `<nodeId>: Error streak <n> turns; ask
   <askId> already open, no second ask`, where `Error streak <n> turns` is the `streakHead` string
   the branch already builds. It writes no ask record, opens no toast, and leaves the leaf active.
   `handledAt` is still stamped, so the re-fire rule is unchanged. With no ask open, the arm behaves
   as today.
2. `goal_create` closes an open ask the slot names on the one path that resets the tree, after
   every refusal (state not loaded, not owner, empty objective, unfinished tree with no `replace`,
   failed history copy) and immediately before `sess.state.goals = [root]`. A finished tree replaced
   with no `replace` takes the same path. The close reads the record, and where it is `open` sets
   it `resumed`, writes it back, pushes an `ask_answered` decision reading `ask <askId> closed by
   goal_create (status: resumed)`, and clears the slot. A slot naming a record that is missing or
   not `open` is cleared with no decision. A refused `goal_create` touches the slot on no path.
3. The thread-reply close, where the asked entry is paused, first pauses every entry whose status
   is `active` and is not the asked entry, at most one on a well-formed tree, with `blockedReason`
   reading `Paused by thread reply to ask <askId>` and a `paused_by_reply` decision whose detail
   reads `<id> paused (thread reply to ask <askId>)`. It then sets the asked entry `active` and
   `activeGoalId` to it. Where the asked entry is not paused, nothing about the pointer changes, as
   today.
4. The tick's answer-record close, added by the architect's ruling above, reactivates the asked
   entry through the same body as item 3, lifted into one helper, with `blockedReason` reading
   `Paused by answer <recordId> to ask <askId>` and the decision details naming the answer record.

The README's `### Ask wait` section (line 613) states what each path now does, in the present
tense. The failure-modes row in `docs/architecture.md` (line 223) for `error_streak` decisions with
no ask, no toast and no paused entry is restated to name both no-escalation cases and both detail
prefixes, `no-active-node:` and the node id with `already open`, since its sentence that an active
entry always opens an ask becomes false. The `### Test coverage` section that follows it under `## Operator channel` (line 633) has
one bullet for `.kit/controller-tick-test.mjs` opening `S3 (ask lifecycle)`; that bullet names the
three new cases. The second `### Test coverage` heading, under `## Decision seam`, is not touched.

## Sections of Work

The section runs as commits on one work branch cut from `origin/main`, named by the worker, with
this plan file on it, and finishing-work opens the one pull request.

### 1. Close or keep the ask on all three paths
Model: opus
Locus: inline

The three design changes above in `hooks/index.ts`, each with a case in
`.kit/controller-tick-test.mjs` written first and watched red against the unchanged code, then the
README edits named above. Opus rather than sonnet because the three sites sit in an 8,000-line
handler file, share the pointer invariants `enforceInvariants` repairs, and are proven through a
fake-clock harness whose existing cases are the only guide to its fixtures.

Tests: lock that an error streak on an active leaf while an ask is open writes no second ask record
and leaves the leaf active, and that the same streak with no ask open still opens one, so the
guard is proven in both directions; that a tree-resetting `goal_create` over an open ask leaves the
record `resumed` and the slot clear, and that a following `goal_add` activates the new entry; that
a thread reply closing an ask on a paused entry leaves `activeGoalId` naming that entry before any
store reload, and that another entry active at the time is paused with the reply named as reason;
and the same for an answer record drained at the tick, with the answer named as reason.

Acceptance:
- An error streak on an active leaf while an ask is open leaves exactly one open ask record in the
  store, `pendingAskId` still names it, the leaf is still `active`, and the `error_streak` decision
  detail carries the open ask id.
- A tree-resetting `goal_create` over an open ask leaves that ask record `resumed`, `pendingAskId`
  unset, and one `ask_answered` decision naming `goal_create`. A `goal_add` on the new tree then
  activates the new entry.
- A thread reply closing an ask on a paused entry leaves that entry `active` with `activeGoalId`
  naming it, read from the in-memory state before any store reload. Where another entry was active,
  it is `paused` with a `blockedReason` naming the reply and one `paused_by_reply` decision.
- Each new case was watched red against the unchanged code before the fix, and the Chapter quotes
  each case's failing check line and the exit code from that red run.
- `node .kit/controller-tick-test.mjs` exits 0, and `npx tsc --noEmit` exits 0.
- The README's `### Ask wait` section states the three behaviors and the reader-answer path's, and the `S3 (ask lifecycle)`
  bullet under the `### Test coverage` heading at line 633 names each new case, however many the
  Tests line yields. The architecture row at line 223 reads true against the new branch.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `README.md`,
`docs/architecture.md`.

## Out of Scope

- How long an ask waits, and what happens when it expires.
- The ASK-marker path's choice to pause only the node it names.
- The `enforceInvariants` repair on store load, which stays as the backstop it is.
- Every open backlog entry that is not one of the three this plan's draft commit retired. The
  operator's pending kaizen node about asks that run out the clock is one of those and stays where
  it is.

## Assumptions

- assumed 2026-09-22 (the repository's other plans): the commit model is Branch-and-PR; reversal:
  one header line.
- assumed 2026-09-22 (the architect): the executing worker runs under the kit, whose executing-work
  and testing-discipline skills own the red-first proof, the baseline captured on the same command
  before a change, and the Chapter; reversal: a paragraph naming each.
- assumed 2026-09-22 (the architect): the tick suite's whole gate is `node
  .kit/controller-tick-test.mjs` alone, since the three sites touch no supervisor or keeper code
  and the README lists the live suites as the supervisor's own; reversal: name the further suites.
- assumed 2026-09-22 (the kit's convention): this plan file is in every section's scope for its
  Chapter, and a worker's queue is the persona plugin's queue file its priming names; reversal: a
  line each.
- The plan review ran at fable and effort high and returned READY_WITH_FINDINGS, one Major and
  three Minor, all applied. The blind read returned 6 questions and 5 comprehension gaps: 9
  answered in the spec, 2 assumed above, 0 asked. The gating litmus: 1 definition, the Files in scope list; 1 one-sided, the Out of
  Scope backlog line the reader counted and the author did not, rewritten as a closed statement;
  0 crossed, 0 unplaced, 0 under-length.

## Operator Verification

- None. Every claim is proven by the tick suite on the worker's box.

## Chapters

### Chapter 1 - 2026-09-22
Completed: 1. Close or keep the ask on all three paths
Implemented By: main session (Locus: inline, since the section writes `docs/architecture.md`; tier opus, the session's model)
Metrics: review rounds 1, closed major-closed; provenance 2 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: section open: guard the error-streak active arm on pendingAskId, close the slot's open ask on a tree-resetting goal_create, and pause other active entries plus set activeGoalId on the thread-reply close; serves the Goal's "a persona's record of its open operator question always agrees with the goal tree and with the ask records in the store" and the three acceptance bullets; adds no mechanism no clause names (each branch is named in the Approach's design list); size about 45 lines in hooks/index.ts across three sites plus three tick cases; not building it leaves a worker stuck behind an ask nobody can answer, or holding an active entry its pointer does not name. Status header normalized from `Ready` to `In Progress` at start, and a `Locus: inline` line added under the section's `Model:` line. Surprise: setting `activeGoalId` on a thread reply makes `prompt.submit` build the `[GOAL TREE]` block for the reactivated entry, which reads `title` and `notes.length` on the active node and its parent. 34 hand-built fixture nodes in `.kit/controller-tick-test.mjs` (26 leaves, 8 roots) lacked both fields, which every real node carries (`hooks/agent-state.ts` node builders, `goal_add` and `goal_create`), so they gained `title` copied from their own `objective` and `notes: []`. Surprise: the goal tree curation case "by name keeps active" reached its stale-pointer state through defect 3 itself; its setup check now asserts the pointer is set and its label reads "(after a reply reactivation)". The null-pointer-beside-an-active-entry state is no longer reachable by any path the suite drives, since the reply no longer produces it and every store load repairs it. Red run of the three new cases on the unchanged code, exit 15 (`node .kit/controller-tick-test.mjs`, 2026-09-22 before the first-green commit 14297ea, 65 s, branch ask-bookkeeping-build at 9d0e317 plus the uncommitted test edits), failing checks quoted: "abk1 streak ask open: exactly one ask record in the store, still open" (detail: two open records, the seeded one and `ask-g-active-1700000010000`), "abk1 streak ask open: pendingAskId still names the first ask", "abk1 streak ask open: the active leaf is still active", "abk1 streak ask open: one error_streak decision naming the leaf and the open ask", "abk1 streak ask open: no ask_opened or paused_by_controller", "abk1 streak ask open: no toast", "abk1 create: the ask record is resumed", "abk1 create: pendingAskId is unset", "abk1 create: one ask_answered decision naming goal_create", "abk1 create then add: the new entry is activated", "abk1 create, slot naming no record: accepted, slot cleared, no ask_answered", "abk1 reply: the asked entry is active and activeGoalId names it", "abk1 reply: the other active entry is paused with the reply named as the reason", "abk1 reply: one paused_by_reply decision naming the other entry and the ask", "abk1 reply lone: the asked entry is active and activeGoalId names it". The streak control, the refused-create checks and the lone-reply no-pause check passed on the unchanged code, as they should.
Assumptions: none
Review Findings: `review: adversarial + blind at fable, Agent tool`; `review: performance at fable, Agent tool`. Blind Major (goal_create's ask close is unguarded after the history append), trace orchestrator-made to the Goal, downgraded to Minor on its consequence: a store throw aborts with the old tree standing, the ask open and the slot naming it, which is a consistent state, and the only harm is a duplicate history line on retry; both fix forms are excluded, a try/catch being a guard no clause names and a move ahead of the history copy breaking design item 2's "a refused `goal_create` touches the slot on no path". Adversarial Major (the Chapter quoting the red check lines was absent) met by this Chapter. Minors: 2 fixed in the close pass (the answered-record branch of the goal_create close gained a check; the stale case label renamed), 1 claim fixed in the close pass (README now says every accepted `goal_create` replaces the tree and clears the slot whatever the record's status), 2 routed to `docs/backlog.md` as one entry (ask closes flip the record before persist; the reply close leaves `blockedReason`, `pausedByNudgeCap` and a blocked lead), 3 left with the reason (the performance note on the unguarded close, covered by the downgrade above; `handledAt` stamped on the ask-open arm, which design item 1 orders; the blind lens's unverified coverage sentence, confirmed by the orchestrator). The close-pass delta took the author's re-read against the findings it answers. A separate backlog entry records the operator-raised gap that no goal verb returns a paused entry to pending.
Stamps: adjudicated 7, stamped 1 (`self-armed-arming-does-not-satisfy-an-operator-only-execution-grant`, which sent this run to check both plans' committed grants before running a self-armed queue).
Gate: targeted lane `node .kit/controller-tick-test.mjs`, exit 0, 2588 OK and 0 FAIL, 74 s wall clock, 2026-09-23T02:58Z, this box with the fleet's own idle node processes and no foreign test runner (`tasklist`), tree at 14297ea plus the close-pass edits; baseline on the same lane 2566 OK and 0 FAIL, exit 0, at 9d0e317, so +22 checks and no new failure. `npx tsc --noEmit` exit 0. Test delta: 3 cases added (`caseAbk1_errorStreakKeepsTheOpenAsk` pins acceptance bullet 1 and its no-ask control; `caseAbk1_goalCreateClosesTheOpenAsk` pins bullet 2 plus the refused, missing-record and answered-record branches of design item 2; `caseAbk1_threadReplySetsThePointer` pins bullet 3 in both the other-active and lone shapes); 0 retired; edited to stay green: `caseD5b_replyClosesAsk` and 33 more fixture nodes (title and notes, the real node shape), and `caseGtc3_completingByNameNeverMovesTheActiveEntry`'s after-reply setup check (pins that the reply sets the pointer). Added tests spawning a process: 0. Contention lane: not run, since the delta touched no machine-shared state.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: taken 2026-09-23T02:59Z on this box at 14297ea plus the close-pass edits, no contention.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-23
Completed: 1. Close or keep the ask on all three paths (finishing pass)
Implemented By: main session (finishing-work, inline fixes)
Metrics: finishing review rounds 2 (round 1 performance, security and adversarial at fable/high via Workflow; round 2 adversarial over the fix delta at fable/high via Workflow), closed on Minors only; provenance 1 new-requirement Major (the answer-record path, ruled in scope by the architect), 1 advisory Major (the priming turn, relevance CONFIRM, then refuted on reachability), 1 fix-introduced Major (the priming guard, removed); advisory: 2 findings, 1 fixed, 0 deferred, 1 refused on evidence; goal read 1; escalations 0; consults 0
Recap: Goal, verbatim: "When this is done, a persona's record of its open operator question always agrees with the goal tree and with the ask records in the store. Three paths break that agreement today, and each leaves a worker stuck behind a question nobody can see or answer, or holding an active entry its own pointer does not name. It matters because a stuck ask stops all new work on the persona until the ask expires. The wait is `askOperatorWaitMs`, 60 minutes by default, and an ask never expires where that option is 0."; What the tree does now: when a worker is already waiting on a question to the operator, a run of failing turns logs itself and leaves that one question standing instead of replacing it with a second one nobody can answer; starting a fresh goal tree closes any question left open on the old tree, so new work is no longer held behind it; and when the operator's answer arrives, whether as a thread reply or as an answer record a reader wrote, the plugin resumes the entry the question was about, pauses anything else running, and points its record of the active entry at the resumed one; Refinements during the run: the answer-record path was added as a fourth path by the architect's ruling of 2026-09-22 on this run's scope question, and fixed through one helper shared with the thread-reply close; a guard against the supervisor's priming turn closing an open ask was added on a confirmed security finding, then removed when the fix-delta review showed an owner start already expires every open ask before that turn lands; Operator-pending: none
Decisions / Surprises: Base ref 9d0e3176a7f5cc859000cbf612c2b730ed779902 (merge-base with origin/main). QA verifier: PASS on every acceptance bullet and the whole 26-item gate, each exit 0, tick 2588 OK, at 9653ea9. Finishing round 1: performance CLEAR; security returned `threat model: absent` and one Major, that the reply close fires on the supervisor's `[SUPERVISOR-PRIMING]` turn; adversarial APPROVED_WITH_CONCERNS with one Major, that the tick's answer-record drain (`hooks/index.ts`, the D5 close) reactivates the asked entry without setting `activeGoalId` or pausing another active entry. The adversarial Major traced to no bullet; the ask went to the architect, who ruled it in scope as a fourth path under the Goal's "always agrees" (ruling line in the Intent, design item 4 and the Tests line added). The security Major took the relevance ruling, CONFIRM on the Goal and Intent. Fix: `reactivateAskedEntry` lifted from the reply close and called from both closes, preserving the reply close's strings and order byte for byte; the answer path's `activated` detail now reads `reactivated (answer <record id> to ask <ask id>)`, which no caller or test read in its old form. Red run of `caseAbk2_answerRecordSetsThePointer` and the priming case on the unchanged code, exit 7 (`node .kit/controller-tick-test.mjs`, at 9653ea9 plus the test edits), failing checks: "abk2 answer: the asked entry is active and activeGoalId names it", "abk2 answer: the other active entry is paused with the answer named as the reason", "abk2 answer: one paused_by_reply decision naming the other entry, the answer and the ask", and the four priming checks. Round 2 found the priming guard answers a state that cannot occur: owner `session.start` runs `expireOpenAsks` over every open ask before any prompt lands (`hooks/index.ts:3057-3072`), and the reply close acts only on an open record, so the security finding's inferred leg, "an open ask persists across a relaunch", is false. Guard, its case and its README sentence removed; the error was acting on the finding's inferred leg before checking it. Goal read: fixture `title`/`notes` fields refused on the ground that no code reads them, with the judge's own stated condition for accept-and-declare, that the tick gate depends on them, met by Chapter 1's `title.slice` TypeError, so accept-and-declare; the stale-slot clear on `goal_create` and the two backlog entries accept-and-declare; the asked-but-unbuilt note (flip-before-persist and the reply close's leftover fields) is the backlog entry already written. Docs curator: 7 drift items, all deviation, none mistake; D1 met by this Chapter, D2 by the index refresh, D3 and D4 and D5 fixed in `docs/README.md` and `README.md` ("Changing the goal tree" now names the ask close; the Bounded store closed list now names every close), D6 pre-existing on the reply path, D7 the curator's own backlog edit, read and kept; H1 met by a pointer to the goal levels plan under Related plans. Scope: `docs/backlog.md` and `docs/README.md` sit outside Files in scope, declared here. The fix-round capture excludes `docs/plans/` by rule, so the plan's own hunks ride only in git. The section heading keeps "all three paths" because Chapter 1's Completed line matches it exactly.
Assumptions: none
Review Findings: `review: performance, security, adversarial at fable/high, Workflow`; `review: adversarial fix delta at fable/high, Workflow`; `goal read at fable, Agent tool`. Minors: 5 fixed (architecture row symptom wording, the backlog stale-slot entry, the plan record of the fourth path, the README priming sentence by removal, the index line), 1 folded into the backlog (the streak guard reads the slot alone), 7 left with the reason in `.kit/scratch/ask-bookkeeping/finishing/minors.md` (the fixed 20 ms settle mirrors the S13 convention; no baseline wall clock on Chapter 1; `parseState` does not normalize `notes`, which no reachable store lacks; the capture excludes the plan doc by rule; whole-string pins on a single-sourced reason; the pointer fallback feeding the helper needs an in-memory stale pointer beside an off-tree ask node; the backlog file's scope, declared above).
Gate: GATE-PENDING
Next: none
Commit Model: Branch-and-PR
