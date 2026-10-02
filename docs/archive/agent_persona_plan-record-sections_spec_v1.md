# The plan holder carries the section total and the next line beside its Chapter count

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-10-01

## Goal

A plan entry in the persona store carries three readings of its document after every turn-end read: the Chapter count it carries today, the number of sections the document declares, and the `Next:` line of its latest Chapter. The Discord board card reads the store each tick and today draws a plan's progress from the launch checkout's copy of the document, which a worker in a linked worktree never updates, so the card said `2/11, next: 3.` while the worker was on section 9. With these two fields beside `chapterCount`, the card can draw the worker's own reading, including for a plan that exists only on a branch and has no copy under any folder the card sweeps. The companion plan in the broker's repository, `channels_board-worktree-progress_spec_v1.md`, reads the three fields; this plan writes them.

## Intent

The operator's frame, through the ASSISTANT persona on 2026-10-01: a plan-tracked goal's Chapter count on the Discord card should follow the copy of the plan the worker actually updates. In his words: "let's see if it's a gap we can improve on, even if maybe not fully, deterministically close."

What done needs to do. After every successful turn-end read of a plan document, the plan holder in the store carries the document's section total and its latest Chapter's `Next:` line, each read by the same rules the board card and the external engine already parse the document with, so the three parties agree on the same file. A read that fails leaves both fields as they were, exactly as it leaves the Chapter count. The fields appear in the store's documented shape and in the tick suite.

What done does not need to do. It does not change how the document's directory is found: the live-directory walk is right, and the store on this machine proves it, with the mechanism-cut holder at Chapter 9 and a `plan_progress` decision `8 -> 9` logged at 19:26Z while the launch checkout's copy held two Chapters. It does not record which file an Edit or Write tool touched, enumerate git worktrees, spawn git, or read any directory the plugin does not read today. It does not change the card: that is the broker's plan. It does not log a decision for the two new fields, since neither is progress.

Alternatives refused. Recording the absolute path of every Edit or Write that names the plan file onto the goal node, the ASSISTANT's first direction: refused because the plugin's own count is already current, so the path would be stored and never needed. Enumerating `git worktree list` from the plugin and taking the highest Chapter count, the second direction: refused for the same reason, and it would spawn a process at every turn end. Having the broker enumerate worktrees instead: refused in the broker's own terms, since its plan reader opens no path it did not configure, by a rule stated at the top of `broker/board/plans.ts`, and a path read out of a store or a `.git` file is exactly such a path. Carrying the latest Chapter's `Completed:` line too: refused as unused, since the card counts completed sections by its own rule and the Chapter count is the figure it will draw.

Rulings after the spec shipped, each appended dated. 2026-10-02, the ARCHITECT's ruling on the worker's round 1 findings (record ARCHITECT-016dcefe-7b83-4454-94ad-8ecdc9ca1f7f-6): the parser's five heading patterns are the card's own, so a `## Chapters` heading carrying a suffix no longer opens the block and the Chapter count tightens with it; the Next: value is folded to one line, its whitespace collapsed, then cut, and an empty one reads null; the first Next: line under a Chapter is the one read even where an interim board wrote it; and headings inside a code fence count, as the card counts them. 2026-10-02, the ARCHITECT's ruling on the finishing pass's performance finding (record ARCHITECT-016dcefe-7b83-4454-94ad-8ecdc9ca1f7f-7): the card's block and section patterns are quadratic on a whitespace run ending in a lone CR, U+2028 or U+2029, so the plugin uses linear forms accepting exactly the same lines, proven equal by an exhaustive differential run and pinned by a bounded equality test; the Next: value's fold and cut are the plugin's own bound, not a claim of agreement with the card's value.

Provenance: distilled by the ARCHITECT persona on 2026-10-01 from the ASSISTANT persona's operator-directed record, the plugin sources at `a92b351`, DEV-PLUGIN's persona store read on this machine the same day, and the broker sources at `525c05e`.

## Approach

**Why the plugin and not the card alone.** The card's queue reader already reads each persona's store every tick and keys a plan reading by entry id, and the store entry already carries `chapterCount`. So the card can draw the worker's Chapter count with no plugin change, and the companion plan does that first. What the card cannot draw from the store today is the total it counts out of and the next step, because the store carries neither. For a plan whose document sits under a folder the card sweeps, the card takes both from that copy, whose section list is frozen above `## Chapters` and whose `Next:` line is stale. For a plan that exists only on a branch, the card has no file at all. These two fields close both cases from the one place that reads the worker's own copy: the turn-end read.

**The two readings.** `parsePlanRecord` gains two results beside `complete` and `chapters`. `sections` is the number of `### N.` headings inside the `## Sections of Work` block, where N is one or more digits followed by a period and whitespace, and the block runs from the `## Sections of Work` heading to the next line the card's block pattern takes, `##`, whitespace, then text. A `##` heading inside the block therefore ends it early and drops every later section, which is the frozen contract's own sharp edge and is kept on purpose: the engine and the card read it that way, and a count that disagreed with theirs about the same file would be the wrong one. `next` is the first line opening with `Next:` under the highest-numbered `### Chapter N` heading in the `## Chapters` block, trimmed, cut to 200 characters, and null where the block, the Chapter or the line is absent. Highest-numbered rather than last written, and first `Next:` rather than any, for the same reason: that is how the card reads it. The parser stays pure and its rules stay pinned on strings alone.

**The two fields.** `GoalNode` gains `sectionCount?: number` and `nextSection?: string`. The turn-end read in `hooks/index.ts`, on a reading of kind `read`, writes `sectionCount` where it differs from the stored value and writes or deletes `nextSection` where the parsed value differs, deleting on null. Neither write touches `updatedAt`, logs a decision or counts as progress; `chapterCount` keeps its upward ratchet, its `updatedAt` touch and its `plan_progress` decision unchanged. An unreadable or archived reading writes neither field. The v2-v4 migration leaves both unset, as it leaves `chapterCount`.

**The coverage sweep.** Searches run 2026-10-01 at `a92b351`: `chapterCount`, `parsePlanRecord`, `readPlanRecord`, `resolvePlanDir`, `plan_progress`, `plan_record_unreadable`, `plan_record_dir_resolved` and `GoalNode` over `hooks/`, `.kit/`, `README.md` and `docs/`. Surfaces found: `hooks/agent-state.ts:96` (the `GoalNode` interface) and `:149` (`chapterCount`, with the migration note); `hooks/plan-record.ts:60`, `:102`, `:180`; `hooks/index.ts:70`, `:2110` (the nudge line reading `chapterCount`), `:10480` to `:10519` (the turn-end read); `.kit/plan-record-unit-test.mjs` (parser, reader and resolver pins); `.kit/controller-tick-test.mjs` (the `casePlanRecord2_*` and `caseLive1_*` cases, `plan2Goals` at `:14992`, `plan2Doc` at `:14983`); `.kit/tick-harness.mjs:757` (`makeGoalNode`); `README.md:184` (the `GoalNode` fields the migration leaves unset), `:190` (the turn-end read), `:194` (the unreadable rule); `docs/architecture.md:18` and `:419`. `docs/security-model.md` names none of them.

## Standing Brief Amendments

- The parser's five heading patterns are the card's patterns, or a linear form accepting exactly the same lines (`broker/board/plans.ts` in the broker's repository): a block heading is `^##\s+.+$`, the Sections heading `^##\s+Sections of Work\s*$`, the Chapters heading `^##\s+Chapters\s*$`, a Chapter heading `^###\s+Chapter\s+(\d+)`, a section heading `^###\s+(\d+)\.\s+(.*)$`; the Status loop is unchanged.
- The Next: value is folded through `oneLine`, its whitespace runs collapsed to one space and trimmed, cut to 200 code points, and read null where empty; the first Next: line under the latest Chapter ends the search whatever its value.
- The tick suite pins that a holder whose document now counts fewer Chapters keeps its stored count and logs nothing.
- Only the first `## Sections of Work` heading and the first `## Chapters` heading open a block, as the card's block reader takes the first match; a repeated heading ends the open block and opens nothing.
- A repeated Chapter number reads the later-written Chapter's `Next:` line, a tie-break inside the highest-numbered rule.
- An unchanged or lower Chapter count logs nothing and leaves the stored count as it is, and `README.md` says so beside the turn-end read.
- The docs index carries this plan's Active plans line while it runs.

## Sections of Work

### 1. The parser reads the section total and the next line, and the holder stores both

Model: opus

The parser gains `sections` and `next` under the rules above. The holder gains `sectionCount` and `nextSection`. The turn-end read writes them under the rules above. The docs state the shape.

Acceptance:
- `parsePlanRecord` returns `{ complete, chapters, sections, next }`. On a document with no `## Sections of Work` block, `sections` is 0. On one whose block holds three `### N.` headings and then a `## Out of Scope` heading followed by a fourth `### 4.` line, `sections` is 3. A `### 1.` line above the block, and a `#### 1.` line inside it, count nothing.
- `next` is the first `Next:` line's value under the highest-numbered Chapter, so a document whose Chapter 3 is written above Chapter 2 reads Chapter 3's line. A Chapter with no `Next:` line gives null even where an earlier Chapter has one. A value of 300 characters comes back as its first 200.
- After a turn-end read of kind `read`, the holder carries `sectionCount` equal to the parsed count and `nextSection` equal to the parsed line, and a later read whose document dropped its `Next:` line removes `nextSection` from the holder. A read of kind `unreadable` or `archived` changes neither field. A read whose Chapter count did not rise and whose two values did not change writes nothing and logs nothing.
- `holder.updatedAt` is unchanged by a write of either new field alone. The `plan_progress` decision text is unchanged.
- `.kit/check-loader-rule.mjs` exits 0. `npx tsc --noEmit` exits 0. `node .kit/plan-record-unit-test.mjs` and `node .kit/controller-tick-test.mjs` exit 0 with the new cases present and the prior count of checks not reduced.
- `README.md` names both fields where it names `chapterCount` at `:184`, states the two rules where it states the turn-end read at `:190`, and `docs/architecture.md:18` names the two readings beside the Chapter count.

Files in scope: `hooks/plan-record.ts`, `hooks/agent-state.ts`, `hooks/index.ts`, `.kit/plan-record-unit-test.mjs`, `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs` (only where `makeGoalNode` seeds the holder fields), `README.md`, `docs/architecture.md`, `docs/README.md`.
Tests: the section count under the block rule in both directions, a foreign `##` ending the block and a heading outside it counting nothing; the next line under the highest-numbered Chapter, first line only, null where absent, and the 200-character cut; the two holder writes on a `read` reading and their absence on an `unreadable` and an `archived` reading; the removal of `nextSection` when the document drops the line; `updatedAt` untouched by the two writes.

## Out of Scope

- The card's own reading of the two fields, which is `channels_board-worktree-progress_spec_v1.md` in the broker's repository.
- Any change to how the document's directory is found, to `resolvePlanDir`, or to `sess.workdir`.
- Recording tool-call paths, enumerating worktrees, or spawning a process from the plugin.
- A decision log for the two new fields.
- The `Completed:` line of the latest Chapter.

## Assumptions

- assumed 2026-10-01 (source: DEV-PLUGIN's store read on this machine, holder `plan-muovpehg-ew9q` at `chapterCount` 9 with `plan_progress` `8 -> 9` logged at 19:26Z): the plugin's turn-end read already reads the worktree copy, so the directory walk is not changed; reversal: a session whose store shows a count below its own document's reopens the ASSISTANT's first direction as a plan of its own.
- assumed 2026-10-01 (source: the kit's plan-doc machine contract in `claude-kit`'s `skills/curating-docs/SKILL.md` and the broker's `broker/board/plans.ts`): the section heading is `### N.` with digits, a period and whitespace, the block ends at the next line the card's block pattern takes, `##`, whitespace, then text, and the latest Chapter is the highest-numbered one; reversal: three regular expressions and their pins.
- assumed 2026-10-01 (default): the `Next:` value is cut to 200 characters in the plugin, since the store is read by a card that bounds its intake and a Chapter's `Next:` line is one sentence; reversal: one constant.
- assumed 2026-10-01 (default): the two fields are written without touching `updatedAt`, so a worker's unchanged plan does not look recently updated to any reader of that field; reversal: one line.
- assumed 2026-10-01 (default): the field names are `sectionCount` and `nextSection`, and the companion plan reads those exact names; reversal: rename in both plans before either is armed.

## Operator Verification

- After both plans merge and the plugin cache and broker update, relaunch one persona working a plan in a linked worktree and watch its line on the Discord board card across two section closes. The count moves with the worktree copy and the next line is the latest Chapter's. A card still drawing the launch checkout's count reopens the companion plan; a store entry missing `sectionCount` after a turn end reopens this one.

## Open Questions

- None. The field names are shared with the companion plan and fixed under Assumptions.

## Chapters

### Interim board 1 - 2026-10-02
State: section 1 implementing on `plans/plan-record-sections`, main merged in at 9885c60. Status changed from `Ready` to `In Progress` at the run's start. The first implementer-opus dispatch died on an authentication failure before running any test, leaving about 305 uncommitted lines across the section's code and test files; a second implementer-opus dispatch is finishing from that tree, counted as an environment fault rather than a failed round.
Gate baseline: the natural-exit supervisor-tree plan's whole gate on this machine, 2026-10-02 12:29 to 13:16, on a tree whose code equals 9885c60's (only plan docs and the docs index differ): 31 offline lanes all exit 0, natural-exit parallel `342 OK, 0 FAIL`.
Intake: the spec's line anchors are at a92b351; the brief re-anchors them by symbol at 9885c60. A kit guard refuses a subagent's docs/ write, so docs/architecture.md's line is the main thread's.
Next: verify the implementer's diff, apply the docs/architecture.md text, first-green commit and push, round 1 review at fable.

### Chapter 1 - 2026-10-02
Completed: 1. The parser reads the section total and the next line, and the holder stores both
Implemented By: implementer-opus (first dispatch died on an authentication failure before any test; second dispatch finished from its tree, first green 4f534b7; fix round b618669); the close pass in the main session
Metrics: review rounds 2 (round 1 adversarial, blind, security and performance at fable; round 2 adversarial at opus), closed claim-exit; provenance 3 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 1 declared, 0 asked), the plan's author ruling the held findings; advisory: 1 finding at Major (security), 1 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations none; consults 0
Decisions / Surprises:
- section 1 open: parsePlanRecord gains sections and next, GoalNode gains sectionCount and nextSection, the turn-end read writes them on a read reading; serves the Goal's two new fields and every acceptance bullet; adds no mechanism (two parsed values on an existing read, two optional fields); about 60 lines of code plus tests and three doc lines; not building it leaves the board card unable to draw a worker's own section total and next step.
- r1 fix round (adversarial Majors, ARCHITECT ruling -6): align the parser's five heading patterns with the board card's; serves the Intent's "same rules the board card ... parse the document with"; adds no mechanism (regex swaps in the existing loop); about 10 lines plus pins; not building it leaves the store and the card disagreeing on hand-spaced headings.
- r1 fix round (security advisory Major, adversarial and blind Minors, ruling -6): fold Next: through oneLine, collapse whitespace, cut, null on empty, first Next: ends the search; serves the Intent's agreement clause and the LINE_TERMINATOR guard; adds no mechanism (reuses oneLine); about 8 lines; not building it lets VT, FF and NEL reach the store and stores "" for a bare Next:.
- The spec's Intent asked the plugin to read the document by the board card's rules while its Approach gave slightly different ones; the ARCHITECT ruled for the card (record ARCHITECT-016dcefe-7b83-4454-94ad-8ecdc9ca1f7f-6), which also tightens the Chapter count so a suffixed `## Chapters` heading no longer opens the block. The count's upward ratchet (`hooks/index.ts:10519-10521`, confirmed) keeps any stored count, pinned by a new tick case.
- Declared by the fix round and adopted: only the first Sections and Chapters block is read, as the card's block reader takes the first match.
- The blind lens's interim-board finding matches the card's own Chapter bound and is pinned as intended behavior, on the ruling; headings inside code fences count in both parsers and are left.
- The first implementer dispatch died on an expired sign-in before running anything; the second dispatch verified and finished its tree. Counted as an environment fault, not a failed round.
Failed approaches: none
Assumptions: none
Review Findings: review: adversarial + blind + security + performance at fable, Agent tool (round 1); review: adversarial at opus, Workflow effort high (round 2). Round 1: two adversarial Majors (heading whitespace and the Chapters heading against the card) fixed by ruling -6; the blind Major (interim board) justified-not-fixed on the ruling, as the card reads it the same way; the security advisory Major (terminators reaching the store) fixed by the oneLine fold. Round 2: no Critical or Major; two stale claims fixed in the close pass (the nextSection field comment, one test title), an author re-read. Minors: 10 listed; 8 fixed (empty Next:, whitespace collapse, bracket and terminator pins, the README and plan-record.ts reader pointers, the two stale claims, the README Progress bullet), 2 left with reason: headings in code fences (both parsers, ruled), the worker prompt's section number from chapterCount (note only). Performance: CLEAR, one Minor left (about 1 ms on an oversized Next: line, under any stated requirement).
Stamps: adjudicated 2, stamped 1 (forward-resource-arrangements-into-dispatch-briefs).
Gate: targeted lane at section close, 2026-10-02 18:05 on this machine, worktree at b618669 plus the close pass's two prose edits: `npx tsc --noEmit` exit 0, `node .kit/check-loader-rule.mjs` exit 0, `node .kit/plan-record-unit-test.mjs` exit 0 (89 OK at 9885c60, 135 after the fix round), `node .kit/controller-tick-test.mjs` exit 0 (6477 OK at 9885c60, 6504 after). Tests added: the section-count and next-line parser pins (heading rules, near misses, the fold, collapse, cut and null rules, the first-Next: guard, the interim-board case, CRLF), the two holder-write tick cases, and the ratchet tick case. Edited: one pin flipped by the ruling ("## Chapters (append-only)" no longer opens the block) and one test retitled. Retired: none. Spawning: none added. Delta against the baseline on the same lane: none failing.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: 2026-10-02 18:05, this machine, worktree at b618669. kit-size reports:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
### Chapter 2 - 2026-10-02
Completed: finishing pass
Implemented By: main session (close pass d54e537, docs close); implementer-opus for the linear-pattern fix 9474501; QA, reviews and the goal read by dispatched agents
Metrics: review rounds 2 (security, performance and adversarial at fable; the fix's adversarial re-review at fable), closed claim-exit; provenance 4 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 4 declared, 0 asked); advisory: 1 finding at Major (performance), 1 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 1 (the first goal read, re-dispatched); escalations none; consults 0
Recap: Goal: "A plan entry in the persona store carries three readings of its document after every turn-end read: the Chapter count it carries today, the number of sections the document declares, and the `Next:` line of its latest Chapter." Delivered: `parsePlanRecord` returns `sections` and `next`, the turn-end read writes `sectionCount` and `nextSection` on a `read` reading only, and the heading rules accept exactly the lines the board card's accept.
Decisions / Surprises:
- finishing open: close the plan after the finishing reviews, fixing the performance Major and the Minors; serves the Goal as built; adds no mechanism; about 40 lines of code and tests; not doing it ships a turn-end read that can stall for over 20 seconds on one hostile heading line.
- Base ref: 73eea1a, the merge-base with origin/main.
- QA (qa-verifier): the whole offline gate on the tree before the linear-pattern fix, 2026-10-02 18:07 to 18:53, 31 markers all 0 (30 lanes and the wrapper) and natexit-parallel `342 OK, 0 FAIL`, every acceptance bullet checked.
- The performance lens found the card's block and section patterns quadratic on a whitespace run that ends in a lone CR, U+2028 or U+2029. Re-measured at the 256 KiB cap with `cap-timing.mjs`: 21.8 s and 25.1 s on the card's forms, under 1 ms on the linear forms. The ARCHITECT ruled linear forms accepting exactly the same lines (record ARCHITECT-016dcefe-7b83-4454-94ad-8ecdc9ca1f7f-7). An exhaustive differential run over 7,794,868 strings found 0 differences, re-run at close. Fixed in 9474501 with a bounded equality pin. The same exposure in the broker's card went to STEWARD as a finding.
- The fix's re-review (adversarial at fable) APPROVED with three Minors, closed in d54e537: the parser drops a leading byte-order mark as the card does, the suite's terminator check reads the source files' bytes, and one test comment is corrected. The byte-order-mark pin was red against 9474501's parser and is the only failure there.
- Goal read: 4 built-but-unasked items, all accept-and-declare and added to Standing Brief Amendments: first-block-only, the repeated-Chapter tie-break, the lower-count README sentence with its tick case, and the docs index line. Nothing promised is unbuilt. The first dispatch returned NEEDS_CONTEXT on a truncated extract of the plan's what and was re-dispatched with line-anchored headings.
- Docs curation ran in the main thread, since the kit guard refuses a subagent's write under docs/: `README.md` and `docs/architecture.md` already state the two fields and the rules; the index moves this plan to Archived plans; the backlog carries the operator's board-card check.
Failed approaches: tried writing a test literal holding \n escapes through the edit tool, failed because the escapes landed as live line breaks and the suite failed to parse, learned to build such literals from character codes in a script and to read a red run's log before trusting its exit code.
Assumptions: none
Review Findings: review: security + performance + adversarial at fable, Workflow effort high; re-review: adversarial at fable, Agent tool; goal read: scope-adjudicator at fable, Agent tool, frontmatter effort high. Security: CLEAR, 3 Minors fixed (the first-Next: comment, "200 code points", the pre-slice before Array.from). Performance: one Major fixed (the quadratic patterns); two Minors left as bounded costs (nextValue about 14 ms at the cap before the pre-slice, the holder writes riding the existing persist). Adversarial: APPROVED, 2 Minors fixed (the agreement claim narrowed to the heading rules, the docs index line).
Stamps: none further surfaced beyond the section Chapter's sweep.
Gate: GATE-PENDING
Next: none
Commit Model: Branch-and-PR
