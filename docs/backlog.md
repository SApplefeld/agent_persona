# Backlog

## A `goal_add` plan node doesn't always activate as the leaf before the work it names is done (found 2026-09-12)

Reproduced four times in one session (DISCUSSION.md Rounds 108, 110, 112, 114): `goal_add({kind: "plan", ...})` returns "No active goal; planning or activation will occur at the next tick," and each time, the work named in the node's own objective finished before any controller tick activated that node as the leaf. `goal_done` then fails with "No active goal leaf to complete" - the node sits `pending` forever, never `complete`, even though the work it names is genuinely done.

Not root-caused. Candidate causes, none confirmed: the controller tick may only activate a *new* plan node when the tree has no other active leaf at tick time, and this session's tree already had one; or the tick interval (10s default) may simply not have elapsed between `goal_add` and the work finishing, for work fast enough to complete in one turn. Either way, item 8.1's own "close within one controller tick" acceptance assumes activation happens promptly enough to make `goal_done` usable synchronously, and this session's experience says it does not, at least not reliably for same-turn work.

Worth root-causing before the v2 coordinator's own goal handling depends on the same activation path (Reviewer Round 115, following Round 113's own goal-tree discussion): a coordinator directing many workers leans on the tree closing promptly to reflect status accurately, and this same gap would leave its own nodes stuck `pending` the same way.

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

## The aios persona launcher still exports MODEL=sonnet, pointed at a stale runtime clone

`/d/personas/aios/relaunch-wait.sh:12` (outside this repo) launches `/d/DeepSeekHarness/agentic-plugin/bin/supervise.sh`, a runtime clone confirmed at `1911a83` as of this entry - far behind `main` and missing item 3's own `SUPERVISOR_MODEL`/`SUPERVISOR_EFFORT` fix entirely. Dropping the launcher's `MODEL=sonnet` export now, before that clone is updated, would silently fall through to the clone's own pre-fix bare default (`haiku`), downgrading the `aios` worker rather than upgrading it to `opus` as item 3 intends. Update that runtime clone to a commit carrying item 3's fix, then drop the launcher's `MODEL=sonnet` export in the same pass; verify with `.kit/supervisor-model-test.sh` against the clone's own `bin/supervise.sh` before trusting the new default there.

## A KILL-path variant of live-restartpassive-test.sh's F2 leg (Reviewer Round 126 R76 ruling, worded per R93, 2026-09-12)

`.kit/live-restartpassive-test.sh` F2 proves the persona-claim-free and pre-gate-pass observables for a child that stops cleanly on the EOF path. `.kit/live-stopprocesstree-test.sh`'s own Phase-3 shape - a child that ignores both EOF and TERM, forcing `stop_child` to its final KILL escalation - has no equivalent live leg proving those same two observables; it only proves process death. Add an F2-shaped variant driving an EOF-and-TERM-ignoring child through the same claim-free/pre-gate-pass assertions when this is next picked up.

## The supervisor treats a rate-limited child as merely quiet, and a credential swap never reaches it

A running child never re-reads credentials, so a 429 carrying a `five_hour` limit parks it in a retry backoff (`retryInMs` up to 75 minutes, `maxRetries` 300) that survives an account swap the operator has already made. The supervisor sees only a live process and logs `WAITING`, so nothing distinguishes a working child from one asleep for over an hour. Two changes: read the child's `stdout.jsonl` for `api_error` records carrying `rateLimits.rateLimitType` and `resetsAt`, and log one `RATE_LIMITED until HH:MMZ` line in place of `WAITING`; and when the credential file's mtime is newer than the child's start, treat the child as restartable and take the `restart_passive` path. Not in item 3's PR.

## A reader session cannot write restart_requested when the owner is the stuck process

`restart_requested` is writable by the owner alone. When the owner is itself the wedged child, the one session that can see the wedge (a reader holding the same persona) is refused by the tool, and the only remaining lever is killing the process from outside. Allow a reader to write the fact when the owner's heartbeat is stale, on the same staleness bound the stale-owner arbitration already uses. Not in item 3's PR.

## The dev supervisor still runs the stale runtime clone at /d/DeepSeekHarness/agentic-plugin

That clone predates PR #17, so its `stop_child` still signals one pid rather than the whole Windows process tree, and a restart through it hits the `GATE TIMEOUT` that PR #17 exists to remove. Pull the clone to a commit carrying PR #17 before trusting any restart taken through it. This is the same follow-up the `aios` launcher entry above depends on.

## live-restartpassive-test.sh F5 and F6 have never been observed green, and the NOTE they grep for is on a path the suite never reaches

F5 greps the backfill supervisor log for `NOTE:.*backfilled`. The only line matching that pattern is emitted on `bin/supervise.sh`'s natural-exit path, which runs when the child process exits on its own. The suite's backfill child does its one tool turn and then sits waiting on stdin, so the supervisor's own cleanup stops it at the leg's timeout and the natural-exit path never runs. The backstop itself is working: the leg's own store carries `root_complete ... marked complete - backfilled, work already done`, and the poll loop correctly returns `continue` rather than `restart_passive`, which is the behavior F5 exists to prove. What is missing is an observable the leg can actually read. Either emit the NOTE from the poll-loop path as well as the exit path, or drive the backfill child to a real exit before asserting. This is item 1's leg, not item 3's, and it has been authored-but-unrun since Round 119.
