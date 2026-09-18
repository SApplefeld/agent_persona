# Supervisor poll cost

Status: Complete
Commit Model: Branch-and-PR
Created: 2026-09-18

## Goal

When this is done, one pass of the supervisor's poll loop launches one `node` process instead of fourteen, and its body finishes in about a second on a loaded box instead of fifteen to fifty. Every decision it reaches on a well-formed store, heartbeat and stream is unchanged. Chapter 1 names the three places it departs from the old readings.

## Why

Each persona runs `bin/supervise.sh`, which sleeps ten seconds and then polls. The poll body launched a fresh process for every single reading: fourteen `node` launches and about forty-five other bash forks. A process launch under Git for Windows costs 60 to 840 ms on this machine under load. So the body ran longer than the sleep, and each supervisor spent most of its life launching processes, around the clock.

The operator asked for the evaluation and the fix at the keyboard on 2026-09-18, in the repo Expert's session, with a machine-wide CPU diagnosis attached. That diagnosis named these loops as its third item.

## Approach

The readings move into one script, `bin/supervise-poll.mjs`, run once per poll. It reads the clock and the heartbeat together, reads the decision store once, reads the stream tail and the transcript's modification time, calls the decide unit in-process, and prints four lines. The shell helpers it follows stay in place, because the natural-exit path and the suites still call them.

Three smaller trims ride with it. The transcript directory is resolved once per child instead of on every poll, and the reader adds the session id. `resolve_windows_pid` reads `/proc/<pid>/winpid` with the shell's own `read` instead of launching `cat`. The steady-state tree confirmation stamps its time with the shell's own clock instead of launching `date`.

Weighed and set aside: a long-lived `node` poller replacing the bash loop. It would cut the cost further, and it would also move the stop and sweep machinery, which is where this script's risk lives. A longer poll interval is already a setting, `supervisorPollMs`, and needs no code.

## Sections of Work

### Section 1: One reader per poll

Model: inline, written by the session that measured the loop.

- `bin/supervise-poll.mjs`, new.
- `bin/supervise.sh`: the poll body calls it; `transcript_dir_for` added; `read_transcript_mtime_ms` built on it; the two fork trims.
- `.kit/supervisor-poll-unit-test.mjs`, new, tracked through `.kit/.gitignore`.

Acceptance:
- The unit test passes.
- Old reader chain and new reader agree on a live persona's files.
- The two text anchors the natural-exit suite injects at each appear exactly once: `    refresh_child_tree` and `    DECIDE_ERR=$?`.
- The whole gate is deferred under the gate policy of 2026-09-18 to `docs/plans/agent_persona_deferred-gate-run_v1.md`.

## Out of Scope

- The kit's hook dispatcher and the Defender exclusions, the diagnosis's first two items. Neither lives in this repo.
- The keeper scripts and the pre-launch gate's own polling.

## Operator Verification

- A running supervisor keeps the code it started with. The change takes effect for a persona only when its supervisor is restarted, which is the operator's act to time.
- After a restart, six polls should log a `WAITING` line about every 70 seconds. Before the change they took 150 to 350.

## Related

- `docs/plans/agent_persona_deferred-gate-run_v1.md` owns the gate policy this plan's whole-gate run is deferred under.

## Chapters

### Chapter 1: One reader per poll (2026-09-18)

Shipped: `bin/supervise-poll.mjs`; the poll body in `bin/supervise.sh` calls it once; `transcript_dir_for` added and `read_transcript_mtime_ms` built on it; `resolve_windows_pid` reads with the shell's `read`; the steady-state tree confirmation stamps with the shell's clock; `.kit/supervisor-poll-unit-test.mjs`.

The measurement behind it, taken on SCOTT-CLAUDE under live load. The coordinator supervisor's log put six polls 153 to 356 seconds apart against a nominal 60, and 3,960 polls averaged 27 seconds each. Single launches timed at 60 to 840 ms. The old reader chain took 7,054 ms for ten of its fourteen launches against the live `dev` persona's files. The new reader took 815 ms for every reading and the decision. Both read the same session id and the same transcript and reached `continue`.

Three departures from "every reading unchanged", each deliberate. The reader passes over a stream line that is not a record when looking for the session id, where `read_child_session_id` stops at it. The poll that first reads the session id also reads that session's transcript, where the first build read it one poll late. A setting or count that arrives unparseable takes the decide unit's default, where the old chain sent null. `bin/supervise.sh` validates those at startup, so the case needs a defect upstream to arise.

Review: the blind and adversarial reviewers ran on the first build and agreed on two defects, both fixed. An entry-point guard compared two spellings of the script's path, so a junction or a drive-letter case difference would have printed nothing and failed every poll. It is removed, and the script runs unconditionally. One malformed store entry failed the whole poll where the old chain lost one reading. Each reading now fails alone, and the store predicates match nothing on a malformed entry. Also fixed from review: a failed poll no longer clears the rate-limit state, which would have named one park twice in the log. The heartbeat session id is compared as text. The reviewers did not see the fixes. No second review round ran.

Lanes: `node .kit/supervisor-poll-unit-test.mjs`, 24 passed, 0 failed, exit 0. The malformed-entry case was watched red under a one-line mutation, exit 1, then green on the byte-identical restore. One driven smoke of the real `bin/supervise.sh` with a stub child that records `shutdown_requested`: the supervisor logged `STOP_COMPLETE`, stopped the child by EOF and exited 0 with an empty `supervisor.err`. Both text anchors the natural-exit suite injects at appear once. A four-case filtered run of `.kit/supervisor-natural-exit-test.sh` was started and stopped at eight minutes, still inside its unit prelude, with 53 checks OK and none failed. It reached no driven case and counts for nothing here. The whole gate is deferred under the gate policy of 2026-09-18 to `docs/plans/agent_persona_deferred-gate-run_v1.md`.

Not covered by any run: a rate-limited child, a restart on a hung child, and a relaunch, each through the real script. The unit test covers the reader's side of each. The deferred gate's cases `g`, `i`, `o`, `p`, `t` and `u` cover the script's side.

Next: merge, then the operator restarts each supervisor at a moment of their choosing. Commit model in effect: Branch-and-PR.
