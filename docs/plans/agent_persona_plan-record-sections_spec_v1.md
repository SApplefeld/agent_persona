# The plan holder carries the section total and the next line beside its Chapter count

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-01

## Goal

A plan entry in the persona store carries three readings of its document after every turn-end read: the Chapter count it carries today, the number of sections the document declares, and the `Next:` line of its latest Chapter. The Discord board card reads the store each tick and today draws a plan's progress from the launch checkout's copy of the document, which a worker in a linked worktree never updates, so the card said `2/11, next: 3.` while the worker was on section 9. With these two fields beside `chapterCount`, the card can draw the worker's own reading, including for a plan that exists only on a branch and has no copy under any folder the card sweeps. The companion plan in the broker's repository, `channels_board-worktree-progress_spec_v1.md`, reads the three fields; this plan writes them.

## Intent

The operator's frame, through the ASSISTANT persona on 2026-10-01: a plan-tracked goal's Chapter count on the Discord card should follow the copy of the plan the worker actually updates. In his words: "let's see if it's a gap we can improve on, even if maybe not fully, deterministically close."

What done needs to do. After every successful turn-end read of a plan document, the plan holder in the store carries the document's section total and its latest Chapter's `Next:` line, each read by the same rules the board card and the external engine already parse the document with, so the three parties agree on the same file. A read that fails leaves both fields as they were, exactly as it leaves the Chapter count. The fields appear in the store's documented shape and in the tick suite.

What done does not need to do. It does not change how the document's directory is found: the live-directory walk is right, and the store on this machine proves it, with the mechanism-cut holder at Chapter 9 and a `plan_progress` decision `8 -> 9` logged at 19:26Z while the launch checkout's copy held two Chapters. It does not record which file an Edit or Write tool touched, enumerate git worktrees, spawn git, or read any directory the plugin does not read today. It does not change the card: that is the broker's plan. It does not log a decision for the two new fields, since neither is progress.

Alternatives refused. Recording the absolute path of every Edit or Write that names the plan file onto the goal node, the ASSISTANT's first direction: refused because the plugin's own count is already current, so the path would be stored and never needed. Enumerating `git worktree list` from the plugin and taking the highest Chapter count, the second direction: refused for the same reason, and it would spawn a process at every turn end. Having the broker enumerate worktrees instead: refused in the broker's own terms, since its plan reader opens no path it did not configure, by a rule stated at the top of `broker/board/plans.ts`, and a path read out of a store or a `.git` file is exactly such a path. Carrying the latest Chapter's `Completed:` line too: refused as unused, since the card counts completed sections by its own rule and the Chapter count is the figure it will draw.

Rulings after the spec shipped, each appended dated. None yet.

Provenance: distilled by the ARCHITECT persona on 2026-10-01 from the ASSISTANT persona's operator-directed record, the plugin sources at `a92b351`, DEV-PLUGIN's persona store read on this machine the same day, and the broker sources at `525c05e`.

## Approach

**Why the plugin and not the card alone.** The card's queue reader already reads each persona's store every tick and keys a plan reading by entry id, and the store entry already carries `chapterCount`. So the card can draw the worker's Chapter count with no plugin change, and the companion plan does that first. What the card cannot draw from the store today is the total it counts out of and the next step, because the store carries neither. For a plan whose document sits under a folder the card sweeps, the card takes both from that copy, whose section list is frozen above `## Chapters` and whose `Next:` line is stale. For a plan that exists only on a branch, the card has no file at all. These two fields close both cases from the one place that reads the worker's own copy: the turn-end read.

**The two readings.** `parsePlanRecord` gains two results beside `complete` and `chapters`. `sections` is the number of `### N.` headings inside the `## Sections of Work` block, where N is one or more digits followed by a period and whitespace, and the block runs from the `## Sections of Work` heading to the next line opening with `## `, of any text. A `##` heading inside the block therefore ends it early and drops every later section, which is the frozen contract's own sharp edge and is kept on purpose: the engine and the card read it that way, and a count that disagreed with theirs about the same file would be the wrong one. `next` is the first line opening with `Next:` under the highest-numbered `### Chapter N` heading in the `## Chapters` block, trimmed, cut to 200 characters, and null where the block, the Chapter or the line is absent. Highest-numbered rather than last written, and first `Next:` rather than any, for the same reason: that is how the card reads it. The parser stays pure and its rules stay pinned on strings alone.

**The two fields.** `GoalNode` gains `sectionCount?: number` and `nextSection?: string`. The turn-end read in `hooks/index.ts`, on a reading of kind `read`, writes `sectionCount` where it differs from the stored value and writes or deletes `nextSection` where the parsed value differs, deleting on null. Neither write touches `updatedAt`, logs a decision or counts as progress; `chapterCount` keeps its upward ratchet, its `updatedAt` touch and its `plan_progress` decision unchanged. An unreadable or archived reading writes neither field. The v2-v4 migration leaves both unset, as it leaves `chapterCount`.

**The coverage sweep.** Searches run 2026-10-01 at `a92b351`: `chapterCount`, `parsePlanRecord`, `readPlanRecord`, `resolvePlanDir`, `plan_progress`, `plan_record_unreadable`, `plan_record_dir_resolved` and `GoalNode` over `hooks/`, `.kit/`, `README.md` and `docs/`. Surfaces found: `hooks/agent-state.ts:96` (the `GoalNode` interface) and `:149` (`chapterCount`, with the migration note); `hooks/plan-record.ts:60`, `:102`, `:180`; `hooks/index.ts:70`, `:2110` (the nudge line reading `chapterCount`), `:10480` to `:10519` (the turn-end read); `.kit/plan-record-unit-test.mjs` (parser, reader and resolver pins); `.kit/controller-tick-test.mjs` (the `casePlanRecord2_*` and `caseLive1_*` cases, `plan2Goals` at `:14992`, `plan2Doc` at `:14983`); `.kit/tick-harness.mjs:757` (`makeGoalNode`); `README.md:184` (the `GoalNode` fields the migration leaves unset), `:190` (the turn-end read), `:194` (the unreadable rule); `docs/architecture.md:18` and `:419`. `docs/security-model.md` names none of them.

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
- assumed 2026-10-01 (source: the kit's plan-doc machine contract in `claude-kit`'s `skills/curating-docs/SKILL.md` and the broker's `broker/board/plans.ts`): the section heading is `### N.` with digits, a period and whitespace, the block ends at any `## ` line, and the latest Chapter is the highest-numbered one; reversal: three regular expressions and their pins.
- assumed 2026-10-01 (default): the `Next:` value is cut to 200 characters in the plugin, since the store is read by a card that bounds its intake and a Chapter's `Next:` line is one sentence; reversal: one constant.
- assumed 2026-10-01 (default): the two fields are written without touching `updatedAt`, so a worker's unchanged plan does not look recently updated to any reader of that field; reversal: one line.
- assumed 2026-10-01 (default): the field names are `sectionCount` and `nextSection`, and the companion plan reads those exact names; reversal: rename in both plans before either is armed.

## Operator Verification

- After both plans merge and the plugin cache and broker update, relaunch one persona working a plan in a linked worktree and watch its line on the Discord board card across two section closes. The count moves with the worktree copy and the next line is the latest Chapter's. A card still drawing the launch checkout's count reopens the companion plan; a store entry missing `sectionCount` after a turn end reopens this one.

## Open Questions

- None. The field names are shared with the companion plan and fixed under Assumptions.

## Chapters
