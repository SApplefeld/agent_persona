# The channel log is written in size-bounded segments, so the harness's 4 MiB file limit can never refuse a roll or a sweep again

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-25

## Dispatch Authorization

DEV-DISCORD surfaced the failure to the operator on 2026-09-25: its `.agentic-channel.jsonl` sits at 4,194,154 bytes, every write to it is refused, and the refusals recur every tick. The operator relayed it to the ARCHITECT on the ARCHITECT thread, asked for a plan, and then asked for the fix to run inline in the ARCHITECT session, as the planner-catch fix did earlier the same day, because DEV-PERSONA is on other immediate fixes. The plan shares `hooks/index.ts` with every in-flight persona plan and is not disjoint from them. It is a live failure in three seats, so it runs ahead of the queued plans, on one branch cut from `origin/main` at `23c841d` after a fetch, landing as one pull request. The line numbers below are as of `23c841d`.

## Goal

When this ships, the channel log is a series of files, `.agentic-channel.0001.jsonl`, `.agentic-channel.0002.jsonl` and so on, and an append lands in the highest-numbered one until that file plus the batch would pass 1 MiB, at which point the next number is opened. No segment ever reaches the harness's 4 MiB read or write refusal, so a window roll, a TTL sweep, a decision-cap roll and a memory-cap roll land every time. The existing `.agentic-channel.jsonl` in each work directory is left as it stands, a frozen archive the plugin never writes again. Every harness case that reads the log reads it through the segments.

## Intent

The frame: DEV-DISCORD reported the file at the plugin's 4 MB write limit, every write refused, the window roll and the expired-record sweep failing each tick, and a self-review lesson about the 4MB limit repeating in its record.

What the ARCHITECT confirmed at the source. The channel log is the one append-only overflow log every capped store writes to, and the comment above `CHANNEL_LOG_PATH` (`hooks/index.ts:1034`) says it grows without bound by design. The harness gives a plugin no append: `$.fs` is `read`, `write`, `list`, `exists` and `stat` (`.claude/types/claude-code.d.ts`, the `fs` block at 2867). So `appendLines` (`hooks/index.ts:1135`) reads the whole file, concatenates and writes it back whole. The typings say a read over 4 MiB rejects, and the recorded refusal names the write bound: `$.fs.write: D:\discord-channels\.agentic-channel.jsonl refused: 4246661 bytes is over the 4194304-byte limit`. Three work directories hold a log at that cap: `D:\discord-channels` (4,194,154 bytes), `D:\agent_persona` (4,194,069) and `D:\personas\ASSISTANT` (4,194,092). DEV-DISCORD's filled in 2.6 days, 16,702 of its 16,708 lines rolled decisions, 15,401 of those `self-review` and `planning_fired`.

The cascade past the refusal. `persist` keeps a refused decision overflow in memory to retry, and pushes one `channel_window_roll_failed` decision per refusal (`hooks/index.ts:2247-2255`), so the retry grows by about 6 KB per tick, the persona file creeps past `DECISIONS_MAX` (DEV-DISCORD holds 212 against 200), and the self-review read that spam as a lesson. The sweep never lands, so expired records stay in the commons store.

What done needs to do: make an append land whatever the log's total size. What done does not need to do: change what rolls or how often, which is the parked self-review-flood plan's subject; change the refusal paths in `persist` or the tick, which become unreachable short of a real filesystem error; delete, rename or rewrite the existing 4 MB files, which the plugin cannot do and a reader still uses as evidence; touch the yield log or the decision journal, whose day files have the same read-and-rewrite shape and a backlog entry of their own.

Alternatives refused:
- Day-named files, as the decision journal keeps. Refused: DEV-DISCORD wrote 1.6 MB a day at its worst, so a heavy day can pass 4 MiB, and the size bound is needed anyway.
- Stop rolling decisions to the log. Refused: the smallest change, but it loses the trail DEV-DISCORD used the same day to pin the reply-backstop bug.
- Drop the overflow on a refused roll instead of retrying. Refused for this plan: with segments the refusal is a real filesystem error, and the retry is the right response to one of those.

Rulings: none at the write.

Provenance: the operator's relay of DEV-DISCORD's report and the ARCHITECT's read of the three work directories and `hooks/index.ts` on 2026-09-25.

## Approach

**Segments, chosen by listing.** `appendToChannelLog(dp, lines)` lists the working directory with `dp.fs.list()`, takes the entries whose name matches `.agentic-channel.<digits>.jsonl` with at least four digits, and picks the highest number with its size. Where none exists, or where the highest's size plus one separator byte plus the batch's UTF-8 byte count passes `CHANNEL_SEGMENT_MAX_BYTES` (1,048,576), it writes the batch alone to the next number, four digits zero-padded. Otherwise it reads the highest, appends under the one-object-per-line rule `appendLines` keeps, and writes it back. It returns the path it wrote, and the tick's `channel_window_rolled` detail names that path. The legacy `.agentic-channel.jsonl` has no digits, so the pattern never selects it and nothing writes it again. The bound sits far under the harness cap because each append rewrites the whole segment, so a smaller segment is a cheaper append; 1 MiB is four times the day's largest batch seen and 1,024 lines of the ordinary size.

**The line loses `logPath`.** The decision and memory lines in `persist` carried `logPath: CHANNEL_LOG_PATH`. A line cannot know its segment before the write chooses it, and a reader has the file in hand, so the field goes.

**The harness gains `list`.** The tick harness's fake `$.fs` gains `list(path?)` over its map: with no path or `.`, the entries whose key holds no separator; with a path, the entries under it. Each entry is `{ name, kind: "file", size, isLink: false }` with `size` the UTF-8 byte count, the shape the typings declare.

## Sections of Work

### 1. Pin the segments in the tick harness
Model: fable, inline
Add `channelLogLines(h)` to `.kit/controller-tick-test.mjs`, returning the parsed-ready lines of every segment in number order, and route the seven sites that read `.agentic-channel.jsonl` from the fake map through it. Retarget the section 12.4 refusal predicate and its "nothing in the log yet" check to the segment pattern. Add two cases beside the Item 5 window case. The rollover case seeds `.agentic-channel.0001.jsonl` with one line and `.agentic-channel.0002.jsonl` within 200 bytes of the bound, rolls three records through the window, and finds `.agentic-channel.0003.jsonl` holding the three lines, `0002` and `0001` byte-for-byte as seeded. The frozen-legacy case seeds `.agentic-channel.jsonl` with one line and no segment, rolls, and finds the legacy file byte-for-byte as seeded and `0001` holding the rolled lines. The control is the existing window and sweep cases, which after this section find their lines in `0001`.
Acceptance: on `23c841d` with the trunk `hooks/index.ts` swapped in, the two new cases and the retargeted sites are red; on the changeset every case is green.
Files in scope: `.kit/controller-tick-test.mjs`, `.kit/tick-harness.mjs`.

### 2. The segment writer, and the documents
Model: fable, inline
Replace `CHANNEL_LOG_PATH` and `appendToChannelLog` as the Approach states, drop `logPath` from the two `persist` lines, and name the written path in the tick's `channel_window_rolled` detail. Rewrite the comment above the constants to state the harness bound and the segment rule as present fact. Update the three README sentences that name `.agentic-channel.jsonl` (lines 649, 653 and 655) and the artifact copy in `.kit/live-operator-test.sh:505` to the segment names.
Acceptance: section 1's cases green; `npx tsc --noEmit` exit 0; `.kit/controller-tick-test.mjs` exit 0 at or above the baseline count recorded on the untouched worktree; `.kit/injection-duplicate-test.mjs` exit 0.
Files in scope: `hooks/index.ts`, `README.md`, `.kit/live-operator-test.sh`.

## Out of Scope

- The rate at which decisions roll, which the self-review-flood plan owns.
- The `persist` retry on a refused roll and the failure decision it pushes.
- The decision journal's day-file rewrite, `docs/backlog.md` "The decision journal rewrites its whole day file for every line".
- The existing 4 MB files, which stay as they are, and the `File size exceeds 4MB limit` lesson in DEV-DISCORD's memory, which the operator or DEV-DISCORD removes.

## Assumptions

- `dp.fs.list()` with no argument lists the working directory, as the typings state; the fleet's personas run with the work directory as the process's working directory, which is where the legacy log sits.
- The harness's write cap is 4,194,304 bytes, read from the recorded refusal; the typings state the read cap in the same figure.

## Operator Verification

After the fleet restart, each persona's next window roll or decision-cap roll writes `.agentic-channel.0001.jsonl` beside the frozen `.agentic-channel.jsonl`, and the `channel_window_roll_failed` and `sweep_expired_records_failed` decisions stop.

## Open Questions

None.

## Related

- `docs/archive/agent_persona_passive-supervisor_v1.md`, item 5, which built the log and recorded that the engine offered no append.
- `docs/archive/agent_persona_planner-catch_spec_v1.md`, whose Intent named the roll refusal as a separate item.

## Chapters

### Chapter 1: sections 1 and 2, shipped together as an emergency fix (2026-09-25)

The operator asked the ARCHITECT on its channel to write this plan and implement it inline, in one session, as the planner-catch fix ran the same morning, because DEV-PERSONA is on other immediate fixes. Both sections shipped as one changeset on branch `channel-log-segments`, cut from `origin/main` at `23c841d`. Commit model Branch-and-PR, one pull request, delivered in this changeset.

What shipped. `CHANNEL_LOG_PATH` is gone. `CHANNEL_SEGMENT_PREFIX`, `CHANNEL_SEGMENT_SUFFIX`, `CHANNEL_SEGMENT_PATTERN`, `CHANNEL_SEGMENT_MAX_BYTES` (1,048,576) and `channelSegmentPath` sit where it sat in `hooks/index.ts`. `appendToChannelLog` lists the working directory through `dp.fs.list()`, skips entries that are not files, takes the highest `.agentic-channel.<nnnn>.jsonl`, appends there through `appendLines` where the listing's size plus one separator byte plus the batch's UTF-8 bytes stays under the bound, else writes the batch alone to the next number, and returns the path written. The two `persist` lines lost `logPath`, the sweep's callback awaits the append and returns void, and the tick's `channel_window_rolled` detail names the segment written. The tick harness's fake `$.fs` gained `list`. `channelSegments` and `channelLogLines` read the log in `.kit/controller-tick-test.mjs`, the seven former single-file reads go through them, the section 12.4 refusal predicate and its empty check target the segment pattern, and the Item 5 window case also pins the first segment's name and the decision naming it. Three README sentences and the live-operator artifact copy name the segments.

Tests. Two cases beside the Item 5 window case: `caseChannelLog_segmentOpensPastTheBound` seeds `0001` with one line and `0002` at exactly 200 bytes under the bound, rolls three records, and finds `0003` holding the three, both seeded segments byte-for-byte as seeded, no fourth segment, and the decision naming `0003`. `caseChannelLog_legacyFileIsFrozen` seeds `.agentic-channel.jsonl` alone, rolls, and finds it byte-for-byte as seeded with `0001` holding the three. Runs, each read from its own exit marker and summary line. Baseline on a detached worktree at `23c841d`, untouched: exit 0, `PASS: 0 failure(s)`, 3,666 OK lines. Red, the changeset's two test files copied onto that trunk worktree: exit 22, `FAIL: 22 failure(s)`, every failure in a channel-log case (the two new cases, Item 5 window, decision cap and memory cap, section 12.4, 12.5, 12.F2 and the close sweep), the trunk writing the legacy name where the tests read segments. Green on the changeset after the review round: exit 0, `PASS: 0 failure(s)`, 3,679 OK lines, 13 over the baseline for the 13 checks added. `tsc --noEmit` exit 0 against the 2.1.282 typings. `.kit/injection-duplicate-test.mjs` exit 0. The first green attempt failed 6 checks in the rollover case, all from the seed defect the reviewers found; the counts above are the run after the fix. Another session's tick suite ran beside the baseline and the green runs in other checkouts, which shares the box's memory and CPU and touched wall clock only.

Reviews. The adversarial and blind reviewers were dispatched over the whole changeset before the green run; both returned CHANGES_REQUIRED on one finding, confirmed by that run. Dispositions, each checked against the code:
- Accepted, both: the rollover seed used `line.repeat(floor(target / lineBytes))`, which discards up to one line's remainder, so `0002` landed 1,026 bytes under the bound and the 925-byte roll fit. The seed now sizes its last line to land at exactly 200 under, and the sanity check pins equality.
- Accepted, both: the segment choice skips entries whose `kind` is not `file`.
- Accepted, adversarial: the code comment said "harness" where the README said "engine". Both say engine, and the comment names the read bound as the typings' and the write bound as the refusal `$.fs.write` returns, since the typings state the read bound only.
- Discarded, blind: chunk a batch larger than the 4 MiB write cap. Every batch is built from a store the plugin reads whole under the same cap, so no batch can exceed it.
- Discarded, blind: two sessions racing on one segment. `persist` returns before the roll for a session that does not own the persona, and one work directory has one owner.
- Discarded, adversarial: the empty-batch return of `""`. Unreachable from both callers, and the guard is what keeps an empty batch from opening an empty segment.

Surprises. The write bound is absent from the typings; only the recorded refusal names it. The Assumptions section says so.

Next: none. Operator verification after the fleet restart is stated above.
