# The supervisor removes channel log segments older than a retention window, so a persona's work directory holds a rolling amount of history on disk

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-25

## Dispatch Authorization

The operator asked the ARCHITECT on its channel on 2026-09-25, after the channel-log-segments fix landed as pull request 102, for a retention and cleanup workflow in the supervisor that removes the older channel log files after a number of days, written as a plan, opened as a pull request, and queued at the back of the DEV-PERSONA queue. That queue is the ordered list of plans the coordinator persona hands the DEV-PERSONA worker, the persona that develops this repository. It is not urgent. The plan touches `bin/supervise.sh`, `bin/keeper-functions.ps1` and their suites, and no in-flight persona plan touches those files, so it is disjoint from the queue ahead of it. The line numbers below are as of `931163a`.

## Goal

When this ships, each supervisor removes, from the work directory of the persona it runs, every channel log file whose last write is older than a retention window, and does so once at each launch and once a day while the child runs. The window is a roster field, `channelLogRetentionDays`, default 14, so the operator sets it per persona in `fleet.json` and never edits a script. The segment the plugin is writing now is never removed whatever its age, and no file outside the channel log's own names is ever touched. A work directory that stays running therefore holds about the last two weeks of rolled records and nothing older, and the frozen pre-segment `.agentic-channel.jsonl` leaves on the same rule once it is old enough.

## Intent

The frame, in the operator's words: after the segments fix, "we should do a Retention/Cleanup workflow in the supervisor, so that after X Days (7? 14? 30?) we remove the older files so there's a clean rolling amount on disk", not urgent, something to tackle in the coming days or weeks.

Why the supervisor and not the plugin. The plugin's file API has no delete, so the plugin cannot remove anything it wrote. The supervisor runs in a real shell in the same work directory and already reads its settings from the roster through the keeper, so it is the one process that can both know the window and act on it.

What done needs to do: remove old segments on a window the operator sets in the roster; never remove the live segment; never touch any other file; say in the supervisor log what it removed. What done does not need to do: change what the plugin rolls or how often, which is the self-review-flood plan's subject; compress or archive a segment before removing it; offer a way to switch retention off, since a window of 3650 days is off in every way that matters and `positive_number` is the one rule every supervisor setting takes; read or parse a segment's contents.

Alternatives refused:
- Retention inside the plugin. Refused: the engine's `$.fs` has no delete or rename.
- A scheduled task or a keeper-side sweep. Refused: the keeper already delegates every per-persona act to the supervisor, and the supervisor is the process that knows the work directory and the window at launch.
- Delete by count of segments rather than by age. Refused: the operator asked for days, and age reads the same on a quiet persona and a busy one.

Rulings: none at the write.

Provenance: the operator's channel message on 2026-09-25 and the ARCHITECT's read of `bin/supervise.sh`, `bin/keeper-functions.ps1` and the suites the same day.

## Approach

**The sweep is one shell function, `sweep_channel_log_segments <workdir> <days>`, in `bin/supervise.sh`.** It lists the work directory's own entries at depth one whose names match the channel log's names, `.agentic-channel.jsonl` and `.agentic-channel.<digits>.jsonl`, four to eighteen digits, the plugin writer's floor (`CHANNEL_SEGMENT_PATTERN` in `hooks/index.ts`, four or more) capped where bash arithmetic still holds the value, through `find <workdir> -mindepth 1 -maxdepth 1 -type f -regextype posix-extended -regex '.*/\.agentic-channel(\.[0-9]{4,18})?\.jsonl'`, since `-name` cannot express digits and find's default regex dialect has no interval syntax. It finds the highest-numbered segment among them, comparing the digit runs as decimal numbers (`10#` in bash arithmetic, so a zero-padded run is not read as octal) rather than as strings, so a fifth digit sorts after four. Where no numbered segment exists, nothing is exempt, which is the state of a directory that predates the segments and has not been written since. It then removes every matching file other than the highest whose modification time is older than `days` whole days, adding `-mmin +$((days * 1440))` to the same `find`. The highest segment is exempt by name, not by age, since a quiet persona can leave its live segment untouched for longer than the window. Every numbered name whose value equals the highest is exempt, since the plugin writes the four-digit padded name for a value, so a zero-padded copy such as `00005` never costs the live `0005` its exemption. `find` is expected to resolve to Git's GNU find, as `sed`, `awk` and `grep` already do at the script's 24 call sites under the bash `KEEPER_BASH_EXE` names, and the driven case runs under that same bash, so a `find` that resolves to the Windows one fails the suite rather than the field. Where at least one file was removed it writes one log line, `CHANNEL-LOG SWEEP: removed <n> file(s) older than <days> day(s)`, through `log`; where none was, it writes nothing, so a healthy directory adds no noise. A removal that fails writes `CHANNEL-LOG SWEEP: could not remove <path>` through `log` and stops nothing: the sweep is housekeeping, and the launch it precedes is the work.

**Two call sites.** Once after `GATE PASSED` and before the child index is allocated (`bin/supervise.sh:4104-4110`), so the directory is swept before every launch and every relaunch. And once a day inside the poll loop (`bin/supervise.sh:4306-4308`), gated by a `LAST_CHANNEL_SWEEP_S` epoch-seconds variable, initialised to 0 where the script's other per-run globals are, set to bash's `$EPOCHSECONDS` after each sweep, and sweeping again on a poll where `EPOCHSECONDS - LAST_CHANNEL_SWEEP_S` is 86400 or more, so a child that runs for weeks is swept without a restart. The adopt path (`bin/supervise.sh:4043`) enters the poll loop with no launch, so its first sweep is the poll loop's; the variable is 0 there and the first poll sweeps.

**The window is a roster field.** `channelLogRetentionDays` joins the keeper's roster-to-environment map in `Build-SupervisorInvocation` (`bin/keeper-functions.ps1`, the `$map` table) under the same name, the pattern `controllerTickMs` takes, so an entry that carries it launches the supervisor with `channelLogRetentionDays=<value>` in its environment and one that omits it launches without. The supervisor reads `CHANNEL_LOG_RETENTION_DAYS="${channelLogRetentionDays:-14}"` beside the other supervisor settings (`bin/supervise.sh:196-230`) and checks it with `positive_number` at startup beside them (`bin/supervise.sh:297-340`), refusing with an `ERROR:` line naming the setting and the value, so a typo in the roster stops the launch rather than silently keeping forever or deleting everything. 14 is the default because the operator offered 7, 14 and 30, and two weeks holds the trail a post-mortem reaches for while the flood fix makes a segment a day the ceiling.

**The surfaces that speak this contract**, from a read of the tree rather than a scout sweep, since the contract is new and each surface was opened: `bin/supervise.sh` (the settings block, the startup checks, the launch site, the poll loop), `bin/keeper-functions.ps1` (`Build-SupervisorInvocation`'s map), `.kit/keeper-unit-test.mjs` (the environment-map pin at line 326 and the `full` roster fixture at 256), `.kit/supervisor-model-test.sh` (the `refused_by` call sites, the defaults loop, and the structural pin over `positive_number`), `.kit/supervisor-fn-extract.sh` (the extraction helpers a driven case uses), and `README.md` (the Startup Checks table at 305-323, the roster paragraph at 463, the Bounded store paragraph at 653, and the supervisor Test Coverage entry at 447), and the `.DESCRIPTION` comment of `Build-SupervisorInvocation` (`bin/keeper-functions.ps1:211-213`), which lists the mapped fields.

## Sections of Work

### 1. The sweep function, its two call sites, and their pins
Model: opus
Add `sweep_channel_log_segments` and the `CHANNEL_LOG_RETENTION_DAYS` setting with its startup check to `bin/supervise.sh`, and call the sweep at the two sites the Approach names. Pin it in `.kit/supervisor-model-test.sh` in the shape that suite already uses: a `refused_by` spawn for `channelLogRetentionDays=abc` and for `0`, the default added to the defaults loop with that loop's "five defaults" comment brought to six, and a driven case that extracts the function through `supervisor_extract_fn` and runs it against temp directories. The first directory seeds, with `touch -d`, a legacy `.agentic-channel.jsonl` and segments `0001` and `0002` dated 20 days back, segment `0003` dated 20 days back as the highest, an unrelated `.agentic-personas.json` dated 20 days back, and `.agentic-channel.0002.jsonl.bak` dated 20 days back. The second directory, the age control, seeds segment `0002` dated 1 day back and segment `0003` dated 20 days back, so `0003` stays as the highest and `0002` stays by its age alone. The third directory, the legacy-only control, seeds `.agentic-channel.jsonl` dated 20 days back and no segment. It asserts, at a window of 14: in the first directory the legacy file, `0001` and `0002` are removed, `0003` remains though old, `.agentic-personas.json` and the `.bak` file remain, and the log line names 3 removed; in the second the young `0002` remains and the log line names nothing; in the third the legacy file is removed; and a second run over the first directory removes nothing and logs nothing.
Acceptance:
- `bash -n bin/supervise.sh` exit 0.
- `.kit/supervisor-model-test.sh` exit 0 with the new checks green, and its structural pin still green with the new setting counted as checked.
- A `grep -n 'sweep_channel_log_segments' bin/supervise.sh` shows the definition and exactly two call sites, one before the child index allocation and one inside the poll loop.
Files in scope: `bin/supervise.sh`, `.kit/supervisor-model-test.sh`.
Tests: lock both directions of the highest-segment exemption (an old highest segment stays, an old lower one goes), both directions of the age rule with the highest exemption held constant (a young lower segment stays where an old one goes), and the name pattern's edge (a file outside the pattern stays), since the expensive failure is a sweep that deletes the live segment or a store; lock that the setting's refusal fires at startup before any launch.

### 2. The roster field through the keeper
Model: sonnet
Add `channelLogRetentionDays = 'channelLogRetentionDays'` to the `$map` table in `Build-SupervisorInvocation` (`bin/keeper-functions.ps1`), beside `controllerTickMs`, which is the sibling to mirror, and name the field in that function's `.DESCRIPTION` comment where the mapped fields are listed. In `.kit/keeper-unit-test.mjs`, add the field to the `full` roster fixture at line 256 with a value of 21, add `channelLogRetentionDays: '21'` to the expected environment at line 326, and confirm the existing minimal-entry case still expects no such key.
Acceptance: `.kit/keeper-unit-test.mjs` exit 0; an entry without the field yields an environment without the key; an entry with it yields the key as a string.
Files in scope: `bin/keeper-functions.ps1`, `.kit/keeper-unit-test.mjs`.

### 3. The documents
Model: sonnet
`README.md`: add the `channelLogRetentionDays` row to the Startup Checks table (default 14, shared numeric rule, the channel log sweep's window, days), name the field in the roster paragraph at 463 beside the other optional entry fields, add a `### Channel Log Retention` subsection directly after `### Pre-Launch Gate` stating the sweep as present fact (what it removes, what it never removes, when it runs, both log lines), extend the Bounded store paragraph at 653 with one sentence pointing at that subsection, and extend the `.kit/supervisor-model-test.sh` entry in Test Coverage with the new cases. `docs/architecture.md`: its keeper step at line 30 lists the environment the keeper sets, so `channelLogRetentionDays` joins that list; where it describes the supervisor's launch sequence, add the sweep in one sentence; where it does not, leave it. Every sentence states current behaviour and never the change.
Acceptance: `grep -n channelLogRetentionDays README.md` shows the Startup Checks row, the roster paragraph and the new subsection; `grep -n 'CHANNEL-LOG SWEEP' README.md` shows both log lines in the subsection; `grep -n channelLogRetentionDays docs/architecture.md` shows the keeper step.
Files in scope: `README.md`, `docs/architecture.md`.

## Out of Scope

- What the plugin rolls into the channel log and how often (the self-review-flood plan).
- Retention for the decision journal's day files under the home directory, which are the journal module's and have a backlog entry of their own.
- Retention for the run directory's child transcripts and logs.
- Any change to the plugin, `hooks/`, or the segment writer.

## Assumptions

- assumed 2026-09-25 (default): the default window is 14 days; reversal: one roster value per persona, or one default in the supervisor's assignment line.
- assumed 2026-09-25 (default): the frozen pre-segment `.agentic-channel.jsonl` is swept on the same rule as a numbered segment, by its last write; reversal: one name excluded from the pattern, with a case pinning it.
- assumed 2026-09-25 (the code's own convention): the window travels roster field to environment variable under the same name, as `controllerTickMs` does, rather than under a `supervisor`-prefixed name; reversal: one map entry and one assignment line.
- assumed 2026-09-25 (the code's own convention): `positive_number` with its default minimum of 1 is the check, so there is no off value; reversal: a second rule, which no other supervisor setting has.
- assumed 2026-09-25 (default): the daily sweep runs inside the poll loop on an epoch-seconds comparison rather than on a poll count, so a changed `supervisorPollMs` does not change the cadence; reversal: one comparison.

## Operator Verification

After the merge and a fleet restart, `supervisor.log` under the run directory of a persona whose work directory holds the frozen 4 MB file (`D:\discord-channels`, `D:\agent_persona` and `D:\personas\ASSISTANT` on 2026-09-25) shows one `CHANNEL-LOG SWEEP` line once that file is older than the window, and the file is gone. A work directory whose roster entry carries `channelLogRetentionDays` launches with no `ERROR:` line naming it.

## Open Questions

None.

## Related

- `../archive/agent_persona_channel-log-segments_spec_v1.md`: the fix this plan follows, which made the log a series of segments the plugin can always write and left the total on disk unbounded.
- `docs/backlog.md`, "The decision journal rewrites its whole day file for every line": the journal's day files, whose retention this plan leaves alone.

## Chapters

### Interim board 1 - 2026-09-27

Not a Chapter. The plan has started and no section is in flight, so this entry carries no `Completed:` line.

**Plan start.** Status moved from `Ready` to `In Progress` on starting, the one edit inside the approval fingerprint. The worktree is `D:/agent_persona-log-retention` on branch `plan/channel-log-retention`, cut from origin/main at ccfeb16.

**Approach confirmed against ccfeb16.** The plan's line numbers are as of 931163a and have shifted, and every anchor still exists: `GATE PASSED` at `bin/supervise.sh:4112` with the child index allocation at 4118; the poll loop's sleep at 4315; the settings block from 205; the `positive_number` startup checks at 297 to 351; the `controllerTickMs` read and check at 399 to 408, the sibling to mirror; `log()` at 512; the keeper's `$map` at `bin/keeper-functions.ps1:257`, with `controllerTickMs` at 260. New since the write: `jevLive` has its own branch below the map (line 271), which the retention field does not need, since it is a scalar like `controllerTickMs`.

**Live dispatches.** None.

**Next action.** The intake gap check, then section 1 at opus.

**Rulings adopted since the last boundary.** None.

### Interim board 2 - 2026-09-27

Not a Chapter. Sections 1 and 2 are in flight, so this entry carries no `Completed:` line.

**Intake gap check.** Section 1: `find` resolves to GNU findutils 4.10.0 at `/usr/bin/find` under the keeper's launcher `C:\Program Files\Git\bin\bash.exe` (a run of `type -a find; find --version` there), so the Approach's premise holds; `refused_by` asserts exit 1, the expected text and no launch marker (`.kit/supervisor-model-test.sh:41`), so it locks the refusal-before-launch requirement. Declared defaults, for section 1's Chapter: `LAST_CHANNEL_SWEEP_S=0` beside `CHILD_INDEX=0` (`bin/supervise.sh:3941`); the daily check right after the poll loop's `sleep`; one `rm -f --` per file so a failure names its path. Section 2: current anchors are the fixture at `.kit/keeper-unit-test.mjs:256`, the expected environment at 327, and the `.DESCRIPTION` list at `bin/keeper-functions.ps1:211-213`; the implementer was asked whether the test's environment scrub at line 49 needs the new key.

**Live dispatches.** Section 1 at implementer-opus: the sweep, the setting and its check, two call sites, and the suite's pins. Section 2 at implementer-sonnet, staggered on disjoint files: the keeper map entry, its description, and the unit test's pins.

**Gate baseline.** `.kit/supervisor-model-test.sh` exited 0 on 097503e of the upgrade check branch (whole gate, 2026-09-27, this box, fleet live); no baseline yet on this branch's ccfeb16 base.

**Next action.** Section 1's and section 2's review pairs as each returns; section 3 inline once both have landed.

**Rulings adopted since the last boundary.** None.

### Chapter 1 - 2026-09-27
Completed: 2. The roster field through the keeper
Implemented By: implementer-sonnet
Metrics: review rounds 0, closed clean; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- add-decision (section 2 open): map the roster field `channelLogRetentionDays` to the supervisor's environment under the same name, name it in the function's description, and pin it in the keeper unit test; serves the Goal's "The window is a roster field, `channelLogRetentionDays`, default 14, so the operator sets it per persona in `fleet.json`"; no mechanism, one map entry beside `controllerTickMs`; about 3 lines of script and 3 of test; without it the roster value never reaches the supervisor and every persona keeps the default.
- The plan's `Status:` header moved from `Ready` to `In Progress` when the run started (commit 5365c00). That header sits inside the approval fingerprint, so this first Chapter records the change as deliberate.
- Section 2 ran ahead of section 1. The two sections share no file, so they ran staggered in one worktree. Section 1 is still in flight at this Chapter.
- The implementer added `channelLogRetentionDays` to the test's ambient-environment scrub (`.kit/keeper-unit-test.mjs:49`). Its reason, which I confirmed against that list's own comment: without the scrub, a value set in the runner's shell could make both the full-entry pin and the minimal-entry absence check pass with the map row broken.
- Incident: while cleaning up, the section 2 implementer removed the whole `.kit/scratch/log-retention/` folder, not just its own files. That deleted both sections' add-decision files and any restore copies section 1's implementer kept there. I recreated the two add-decision files from the session record. Section 1's implementer was told to retake its baseline from `git show HEAD:<path>` and to keep scratch under its own subfolder.
Failed approaches: none
Assumptions: none
Review Findings: per-section review skipped as a trivial section (one map row, one comment list, one fixture field, one expected key, one scrub entry, no logic), under the section loop's trivial-section option; the finishing pass reviews the whole changeset. Critical/Major: none. Minors: 0.
Stamps: adjudicated 8, stamped 1; `a-premise-marked-confirmed-in-a-brief-is-never-re-derived-downstream` (operator tier) changed section 1's brief, since the `find` premise was run before it was marked confirmed. The other seven were read, including `the-live-gate-is-operator-only-while-the-fleet-is-up`, and changed nothing built in this stretch.
Gate: targeted lane `node --test .kit/keeper-unit-test.mjs`, 97 PASS lines, 0 FAIL lines, exit 0, run by the orchestrator on the worktree at b0dec06 plus section 1's and section 2's unstaged edits, 2026-09-27, this box, with the fleet live and section 1's implementer active beside it; no earlier baseline on this lane on this branch. The implementer reports a red run first, with the fixture and expectation changed and the map row absent: 96 passed, 1 failed (the full-entry mapping test), exit 1. That red run is reported, not re-run. Test delta: 0 tests added, 0 retired, 1 edited (the full-entry mapping test, which now pins that `channelLogRetentionDays` reaches the supervisor's environment as a string); 0 added tests spawn a process.
Next: 1. The sweep function, its two call sites, and their pins
Commit Model: Branch-and-PR
Delta: 2026-09-27, this box, worktree at b0dec06 with sections 1 and 2 unstaged.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 3 - 2026-09-27

Not a Chapter. Section 1 is in its third review round and section 3 is drafted, so this entry carries no `Completed:` line.

**Section 1 stage.** Round 1 (fable: adversarial, blind, security, performance) returned one blind Major, the segment width, and six Minors. Fix round 1 landed at 70dcb0a. Round 2 (adversarial, opus, high, Workflow) returned a value-tie Major (a zero-padded `00005` beside the live `0005` took the exemption), a spec-contradiction Major disposed by the Approach update in this commit, and four Minors. Fix round 2 landed at c6da770. Round 3 (adversarial, opus, high, Workflow) is in flight over the c6da770 delta. The Approach's pattern and clock sentences now state the as-built form, a deviation section 1's Chapter will flag.

**Section 3 stage.** `README.md` and `docs/architecture.md` are written and pass the section's three acceptance greps; landed in this commit at first green. Its review waits on section 1's close, since section 1's fixes changed behaviour the docs describe.

**Live dispatches.** Round 3 adversarial on section 1 (Workflow wx run w78c3j1zo): asked to review the c6da770 fix delta against the Goal, Intent and section 1's acceptance.

**Gate baseline.** `.kit/supervisor-model-test.sh` 269 OK, 0 FAIL, exit 0 on c6da770 (implementer run, 2026-09-27, this box, fleet live; OK and FAIL counted by the orchestrator from the run's log, exit read from its marker).

**Rulings adopted since the last boundary.** None; every disposition so far is the orchestrator's adjudication, with Minors and add-decision lines in `.kit/scratch/log-retention/`.

**Next action.** Adjudicate round 3; close section 1 with its Chapter; review section 3; finishing.

### Chapter 2 - 2026-09-27
Completed: 1. The sweep function, its two call sites, and their pins
Implemented By: implementer-opus, with two fix rounds at implementer-opus
Metrics: review rounds 3, closed claim-exit; provenance 3 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 3 findings, 2 fixed, 0 deferred, 1 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- add-decision (section 1 open): add `sweep_channel_log_segments`, the `CHANNEL_LOG_RETENTION_DAYS` setting with its startup check, two call sites and their pins; serves the Goal's "each supervisor removes ... every channel log file whose last write is older than a retention window ... once at each launch and once a day"; adds the mechanisms the Goal and Approach name and none other; about 40 lines of script and 60 of test; without it the work directories grow without bound.
- add-decision (round 1, blind Major, segment width): narrow both `find` regexes from one-or-more digits to four through eighteen, the plugin writer's floor (`hooks/index.ts:2659`) and a width bash arithmetic holds, and pin a short-digit stray beside a four-digit segment; serves the Goal's "The segment the plugin is writing now is never removed whatever its age, and no file outside the channel log's own names is ever touched"; no mechanism, a narrowed pattern; 2 regex edits and one test directory; without it a stray short-numbered file outranks the live segment and the live segment can be deleted.
- add-decision (round 2, adversarial Major, value tie): exempt every numbered candidate whose decimal value equals the highest value, not only the first name found at it, so a zero-padded stray such as `00005` beside the live `0005` never costs the live segment its exemption, and pin it with an old `0005` and `00005` pair; serves the Goal's "The segment the plugin is writing now is never removed whatever its age"; no mechanism, the existing exemption keyed on value; about 4 lines and one test directory; without it a stray of equal value deletes the live segment.
- Deviation from the spec, recorded in the Approach: the segment names are four to eighteen digits, not one or more, matched in find's POSIX extended dialect; the daily clock is bash's `$EPOCHSECONDS`, not `date +%s`; and every numbered name at the highest value is exempt, not one name. Each came from a review finding, and the Approach paragraphs now state the as-built form.
- My round 1 fix brief suggested `\{4,18\}` in find's default regex dialect and asked the implementer to confirm it first. It matches nothing there, so as written the sweep would have exempted nothing and removed the live segment. The implementer's check caught it and used `-regextype posix-extended`.
- Commit 70dcb0a's title claimed a stray could no longer unshield the live segment. Round 2 found the equal-value case, `00005` beside `0005`, which that fix did not cover. c6da770 closes it and says so in its body.
- The section 2 implementer removed the whole `.kit/scratch/log-retention/` folder during section 1's first implementation, taking this section's restore copies. The section 1 implementer reported its edits intact and moved to its own subfolder. Chapter 1 records the incident.
- Section 1 closed after section 2 in time. The two share no file.
Failed approaches: tried `\{4,18\}` interval syntax in GNU find's default emacs regex dialect, failed because that dialect has no interval operator and the pattern matched no numbered file, learned that a regex fix to find names its dialect and is run against planted files of every width before it is trusted.
Assumptions: assumed 2026-09-27 (default, section 1): `LAST_CHANNEL_SWEEP_S=0` sits beside `CHILD_INDEX=0`; reversal: move one line. Assumed 2026-09-27 (default, section 1): the daily check runs right after the poll loop's `sleep`; reversal: move the block. Assumed 2026-09-27 (default, section 1): one `rm -f --` per file, so a failed removal names its path; reversal: one `find -delete` with the per-file line dropped.
Review Findings: round 1 `review: adversarial, blind, security, performance at fable, Agent tool`, on "fable capacity: scoped 49%, 7d 44%, 5h 29% (account 7, fetched 59s ago) -> dispatch", and for performance the same reading fetched 165s ago; round 2 `review: adversarial at opus, Workflow, effort high`; round 3 `review: adversarial at opus, Workflow, effort high`. Majors addressed: the segment width (round 1 blind, trace orchestrator-made to the Goal's live-segment and own-names sentences, spec-traceable, fixed at 70dcb0a); the equal-value tie (round 2, spec-traceable, fixed at c6da770); the Approach contradicting the narrowed pattern (round 2, spec-traceable, fixed by the Approach update in dbca428). Advisory: security CLEAR, its 1 Minor covered by the width fix, `npm audit` 0 vulnerabilities; performance CLEAR, the `date` spawn per poll fixed with `$EPOCHSECONDS`, the per-file `rm` refused because it carries the failure line the Approach states. Minors: 8 fixed (the digit overflow by the 18 cap, the failure-branch and width tests, the comment's cap owner, the test's `\n` escapes, the Approach's tie clause, the test comment's wrap, and the two advisory items above), 0 upgraded, 4 left with the reason: a failing `find` is silent (the Approach names the suite as the guard); `$EPOCHSECONDS` needs bash 5 (the keeper's launcher runs 5.3.15, confirmed by a run); a stray of 19 or more digits stalls retention (hand-placed strays only, and a warning line is a mechanism no clause names); the per-file `rm` (above).
Stamps: adjudicated 6, stamped 1; `pr-ready-mark-is-the-reviewers-after-verification` (project tier) confirmed the worker may mark pull request 119 ready once its gates are green. The other five changed nothing built in this stretch.
Gate: targeted lane `.kit/supervisor-model-test.sh`, 269 OK, 0 FAIL, exit 0 read from the run's own marker, wall clock 386 s, on the worktree at c6da770 plus the close pass's comment rewrap and the section 3 prose, 2026-09-27, this box, fleet live, no foreign suite at the poll (a sample, not a clearance). Baseline on this lane: 266 OK and 0 FAIL on 0e733ce, then 268 on 70dcb0a and 269 on c6da770, each 0 FAIL. Test delta: 13 checks added, 0 retired, 1 edited (the defaults loop, now six). Added: two refusals (`channelLogRetentionDays` at `abc` and at `0`, each refused by the new `positive_number` check with no launch); the default of 14; the function's extraction; and nine sweep checks. The sweep checks pin the live-segment exemption and the age rule, the frozen log with and without segments, the name pattern's edge, decimal ordering, strays under four digits, the equal-value tie, the failed-removal line, and the idempotent second run. Each sweep check was seen red against a broken copy or the previous commit before passing. Spawning: the two refusals each spawn `bin/supervise.sh`; the sweep block runs one `bash` child per directory run, 9 runs through one shared driver.
Next: 3. The documents
Commit Model: Branch-and-PR
Delta: 2026-09-27, this box, worktree at c6da770 with the close pass unstaged.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 3 - 2026-09-27
Completed: 3. The documents
Implemented By: main session (Locus: inline, since the section writes under `docs/`)
Metrics: review rounds 1, closed major-closed; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- add-decision (section 3 open): document the retention window and the sweep in README.md (Startup Checks row, roster paragraph, Channel Log Retention subsection, Bounded store pointer, Test Coverage entry) and name the field in docs/architecture.md's keeper step; serves the Goal's "The window is a roster field ... so the operator sets it per persona in `fleet.json` and never edits a script"; no mechanism, prose only; about 27 lines changed across two files; without it the operator has no page naming the field, and the Bounded store paragraph keeps saying the frozen log "stays as it is", which the sweep makes untrue.
- The section was drafted while section 1 was in review, then corrected as section 1's fixes changed what it describes: the four-to-eighteen-digit names and the equal-value exemption. It was reviewed only after section 1's third round approved.
- The Bounded store paragraph said the frozen `.agentic-channel.jsonl` "stays as it is", which the sweep makes untrue. It now points at Channel Log Retention.
- I first read `docs/architecture.md` as having no supervisor launch sequence. Its step 6 is one, and the review's Major put the sweep there.
Failed approaches: none
Assumptions: none
Review Findings: `review: adversarial at fable, Agent tool` on "fable capacity: scoped 50%, 7d 45%, 5h 33% (account 7, fetched 196s ago) -> dispatch"; `blind: no code diff`. Major addressed: architecture step 6 lacked the sweep sentence the section asks for (spec-traceable), fixed with one clause between the gate and the launch. Minors: 2 fixed (the Test Coverage entry now names seven directories and the failed-removal and equal-value cases; the eighteen-digit cap is credited to the sweep, not the plugin), 0 upgraded, 0 left. The fix delta is prose only, so it took an author re-read against `bin/supervise.sh:4172` and the function's header comment rather than a round.
Stamps: none surfaced since Chapter 2.
Gate: the section's acceptance greps on the working copy, 2026-09-27: `grep -n channelLogRetentionDays README.md` shows the Startup Checks row (373), the subsection (394), the Test Coverage entry and the roster paragraph; `grep -n 'CHANNEL-LOG SWEEP' README.md` shows both log lines in the subsection (401, 407); `grep -n channelLogRetentionDays docs/architecture.md` shows the keeper step and the launch walk. No em dash was added: 0 matches in the added lines, and the same pattern matched 1 on a planted sample. Test delta: none.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: 2026-09-27, this box, worktree at c6da770 with the close pass unstaged; the same reading as Chapter 2's.

### Interim board 4 - 2026-09-27

Not a Chapter. The finishing pass is running; no section is open, so this entry carries no `Completed:` line.

**Finishing stage.** Base ref ccfeb161b971fbe2389751ea378229a0568968ed, the branch's merge-base with origin/main; origin/main has not moved since, and the changeset lists only files in the sections' scope plus this plan. Step 1 (qa-verifier) returned PASS on every acceptance criterion of sections 1 to 3 and on the Goal's behaviour claims. Whole gate on 0808410 (`whole-gate.sh`, 2026-09-27, this box, fleet live): 19 offline node suites, 5 short shell suites, supervisor-model (269 OK, 0 FAIL, 389 s), tsc and `claude plugin validate` exit 0; `supervisor-natural-exit-parallel.sh` exit 1, 221 OK and 3 FAIL, the three `root_complete` pins in `hooks/index.ts`, which this changeset does not touch. Contention lane `bash .kit/live-all.sh` exit 10, refusing beside a live persona claim.

**Live dispatches.** The same natural-exit suite at the base ref in a detached worktree `D:/agent_persona-lr-base`, run by the orchestrator (background bohp00u4q, marker `.kit/scratch/log-retention/finishing/base-natexit.exit`), to confirm those three failures are on the base. The finishing review wave (Workflow whqgmjzer): performance, security and adversarial at fable, effort high, over the whole changeset, told what the section reviews cleared.

**Next action.** Read the base run and the wave; step 4 goal read; step 5 docs curator; close and archive; the handoff whole gate; the pull request.

**Rulings adopted since the last boundary.** None.
