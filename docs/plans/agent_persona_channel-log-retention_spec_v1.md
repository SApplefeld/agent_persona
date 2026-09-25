# The supervisor removes channel log segments older than a retention window, so a persona's work directory holds a rolling amount of history on disk

Status: Ready
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

**The sweep is one shell function, `sweep_channel_log_segments <workdir> <days>`, in `bin/supervise.sh`.** It lists the work directory's own entries at depth one whose names match the channel log's names, `.agentic-channel.jsonl` and `.agentic-channel.<digits>.jsonl`, one or more digits, through `find <workdir> -maxdepth 1 -regex '.*/\.agentic-channel\(\.[0-9]+\)?\.jsonl'`, since `-name` cannot express digits. It finds the highest-numbered segment among them, comparing the digit runs as decimal numbers (`10#` in bash arithmetic, so a zero-padded run is not read as octal) rather than as strings, so a fifth digit sorts after four. Where no numbered segment exists, nothing is exempt, which is the state of a directory that predates the segments and has not been written since. It then removes every matching file other than the highest whose modification time is older than `days` whole days, adding `-mmin +$((days * 1440))` to the same `find`. The highest segment is exempt by name, not by age, since a quiet persona can leave its live segment untouched for longer than the window. `find` is expected to resolve to Git's GNU find, as `sed`, `awk` and `grep` already do at the script's 24 call sites under the bash `KEEPER_BASH_EXE` names, and the driven case runs under that same bash, so a `find` that resolves to the Windows one fails the suite rather than the field. Where at least one file was removed it writes one log line, `CHANNEL-LOG SWEEP: removed <n> file(s) older than <days> day(s)`, through `log`; where none was, it writes nothing, so a healthy directory adds no noise. A removal that fails writes `CHANNEL-LOG SWEEP: could not remove <path>` through `log` and stops nothing: the sweep is housekeeping, and the launch it precedes is the work.

**Two call sites.** Once after `GATE PASSED` and before the child index is allocated (`bin/supervise.sh:4104-4110`), so the directory is swept before every launch and every relaunch. And once a day inside the poll loop (`bin/supervise.sh:4306-4308`), gated by a `LAST_CHANNEL_SWEEP_S` epoch-seconds variable, initialised to 0 where the script's other per-run globals are, set to `date +%s` after each sweep, and sweeping again on a poll where `$(date +%s) - LAST_CHANNEL_SWEEP_S` is 86400 or more, so a child that runs for weeks is swept without a restart. The adopt path (`bin/supervise.sh:4043`) enters the poll loop with no launch, so its first sweep is the poll loop's; the variable is 0 there and the first poll sweeps.

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
