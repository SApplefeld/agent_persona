# Backlog

## Arm the plugin's hooks only for sessions that want them (operator feedback, 2026-09-12)

Promoted into `docs/plans/agent_persona_coordinator_v2.md` Section 6 (Reviewer Round 105 R5): every session loading this plugin fires its hooks and reminders every turn regardless of intent, and v2 adds more such sessions. No longer a separate future brainstorm; retire this entry when v2's Section 6 closes.

## Suite hardening

_No open items. Resolved items are archived in `docs/archive/backlog-2026-09-11.md`._

## Commons claim staleness (found and fixed working agent_persona_passive-supervisor_v1.md, Items 2-3)

Fixed in Item 3 (Chapter 3): `agentic_identity`'s handler now releases its previous persona's commons claim on every switch, before claiming the new one.

The root cause: a session's commons entry (`hooks/commons.ts`, `claimResource`/`releaseResource`) keys liveness on one `lastSeen` field shared across every resource that session has ever claimed. Any commons write the session makes for its *current* persona refreshes that one field, which also refreshes the apparent liveness of every other claim the session is still carrying, including a `persona:X` claim for a persona it switched away from and never released - `agentic_identity` claimed the new persona but never released the old one, so a session that started as `default` and switched to `dev` kept a `persona:default` claim alive in commons for as long as it kept heartbeating as `dev`. Reproduced three times across two sessions (this session's own residue in Item 2, then an unrelated live sibling session's residue in Items 2 and 3), each time permanently demoting a fresh scratch child to a passive reader (`sess.isOwner = false`, one-way for the life of that session) the moment it tried to persist under `default`.

Residual caveat: the fix only takes effect for a session running the updated code. A session already live with the old code in memory (observed: one holding `persona:default`, `persona:relay`, `persona:dev`, and `reader:dev` simultaneously) keeps its already-leaked stale claim until it restarts. This is not mine to clear directly - it's another session's own commons state. If Item 7's `default`-persona live suites still see a wedged pre-gate after this fix lands, check for a live sibling session running pre-fix code before assuming a new regression.

## Kit-side lesson: executing-work should say a fix round takes the reviewer pair too

Not this repo's fix - a pointer to the kit plugin repo. A worker that never loads `operating-instructions` or `executing-work` can claim a fix landed in a Chapter sentence when the fix is not actually in the diff, because a fix round inside a review loop is never treated as its own section needing a fresh-context adversarial and blind reviewer pair before posting (see `agent_persona_passive-supervisor_v1.md`'s "worker launch discipline" addendum, which fixes the priming-turn gap on this repo's side). The `executing-work` skill itself should say in words that a fix round inside a review loop is a section under its own dispatch rules, not an exception to them - carry this lesson to that skill's own repo when next working there.

## A KILL-path variant of live-restartpassive-test.sh's F2 leg (Reviewer Round 126 R76 ruling, worded per R93, 2026-09-12)

`.kit/live-restartpassive-test.sh` F2 proves the persona-claim-free and pre-gate-pass observables for a child that stops cleanly on the EOF path. `.kit/live-stopprocesstree-test.sh`'s own Phase-3 shape - a child that ignores both EOF and TERM, forcing `stop_child` to its final KILL escalation - has no equivalent live leg proving those same two observables; it only proves process death. Add an F2-shaped variant driving an EOF-and-TERM-ignoring child through the same claim-free/pre-gate-pass assertions when this is next picked up.

## The supervisor treats a rate-limited child as merely quiet, and a credential swap never reaches it

A running child never re-reads credentials, so a 429 carrying a `five_hour` limit parks it in a retry backoff (`retryInMs` up to 75 minutes, `maxRetries` 300) that survives an account swap the operator has already made. The supervisor sees only a live process and logs `WAITING`, so nothing distinguishes a working child from one asleep for over an hour. Two changes: read the child's `stdout.jsonl` for `api_error` records carrying `rateLimits.rateLimitType` and `resetsAt`, and log one `RATE_LIMITED until HH:MMZ` line in place of `WAITING`; and when the credential file's mtime is newer than the child's start, treat the child as restartable and take the `restart_passive` path. Not in item 3's PR.

## A reader session cannot write restart_requested when the owner is the stuck process

`restart_requested` is writable by the owner alone. When the owner is itself the wedged child, the one session that can see the wedge (a reader holding the same persona) is refused by the tool, and the only remaining lever is killing the process from outside. Allow a reader to write the fact when the owner's heartbeat is stale, on the same staleness bound the stale-owner arbitration already uses. Not in item 3's PR.

## live-restartpassive-test.sh F5 and F6 have never been observed green, and the NOTE they grep for is on a path the suite never reaches

F5 greps the backfill supervisor log for `NOTE:.*backfilled`. The only line matching that pattern is emitted on `bin/supervise.sh`'s natural-exit path, which runs when the child process exits on its own. The suite's backfill child does its one tool turn and then sits waiting on stdin, so the supervisor's own cleanup stops it at the leg's timeout and the natural-exit path never runs. The backstop itself is working: the leg's own store carries `root_complete ... marked complete - backfilled, work already done`, and the poll loop correctly returns `continue` rather than `restart_passive`, which is the behavior F5 exists to prove. What is missing is an observable the leg can actually read. Either emit the NOTE from the poll-loop path as well as the exit path, or drive the backfill child to a real exit before asserting. This is item 1's leg, not item 3's, and it has been authored-but-unrun since Round 119.

## Both running supervisors are still on pre-pull code, so the one-pid stop path and the aios sonnet pinning both survive until relaunch

The runtime clone at `/d/DeepSeekHarness/agentic-plugin` is current at `0fc66d2`, but a running `bin/supervise.sh` keeps reading its original open file handle and never picks up a pull. Both supervisors live on this machine were launched before it, so two things outlive the fix. Their `stop_child` still signals one pid rather than the whole Windows process tree, and a restart taken through either still hits the `GATE TIMEOUT` PR #17 removes. The `aios` supervisor also holds `MODEL=sonnet` in its own environment from the launcher line that has since been dropped, so every child it starts stays on `sonnet` rather than taking the new `opus` default.

Nothing to fix in the tree. The remedy is relaunching each supervisor, then dropping this entry. Relaunching is destructive to whatever that supervisor's child is mid-way through, so it is taken at a quiet point rather than on sight of this entry. This is the narrowed remainder of the `aios` launcher entry and the stale-dev-clone entry, both retired in item 3's runtime-clone addendum.

## live-stopprocesstree-test.sh runs 15 checks that the gate summary never collects

In the whole-gate run `20260913T085812Z` this suite was the only one of seventeen whose
summary line read `assert=[missing]`. Its checks are not missing. The suite's own log ends
`15 checks run, 0 failed` and `live-stopprocesstree-test.sh: PASS`, and its assertions are
substantive, covering that the real child is gone after `stop_child` returns on the TERM
path and after the tree kill.

The gap is collection, not coverage. `.kit/live-stopprocesstree-test.sh` has its
`pass` and `failed` helpers print to stdout and bump their own counters, which is what
produces the `15 checks run, 0 failed` line, but neither writes a file, while
`.kit/live-all.sh:132` collects `$suite_dir/<suite>.assert.log`, a file this suite never
writes. Its exit file is collected, which is why `exitfile=[0 ]` is populated beside an
empty `assert=`.

Fix: have `pass` and `failed` tee to `$SUITE_DIR/stopprocesstree.assert.log` as the other
suites do. No new assertions are needed, and no control has to be built: the suite already
fails if `stop_child` leaves the real child alive, so a mutation to signal a single pid
would turn it red today. The effect of this gap is that a whole-gate summary understates
the evidence for item 2's process-tree stop, which is exactly the fix that gate exists to
validate.

## Section 0 item 4's whole gate was run without its own precondition, and owes one re-run

Item 4 conditions its whole-gate run on the operator confirming every other live `claude`
process is stopped. The run `20260913T085812Z` was taken without that confirmation, with
both supervisors and their children live, and with foreign `.NET` test runs going before
and during it. Sixteen of seventeen suites passed clean, so the contention does not appear
to have bitten, and the single failure is explained independently by the F5/F6 entry.

What is owed is narrow: one re-run of `live-restartpassive-test.sh` on a genuinely quiet
box, so its result rests on the condition the item sets rather than on a run that did not
meet it. The whole gate does not need repeating for this. Drop this entry once that run is
recorded in item 4's Chapter.
