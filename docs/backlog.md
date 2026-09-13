# Backlog

## A provided settings file's persona silently overrides the supervisor's persona argument (found 2026-09-13)

`bin/supervise.sh` hands `$RUNDIR/settings.json` to its child on `--settings` and writes that file only when it is absent. `RUNDIR` defaults to `$WORKDIR/run`, so a second supervisor launched on the same workdir under a different persona reuses the first launch's file. Its child claims the file's persona while the pre-gate and polls watch the supervisor's own argument, and a store check reads a claim for a persona nobody asked for.

The same shape holds under `--plugin-dir` and in installed mode. The narrow exposure today is that every launcher on the box passes its own `--rundir` or runs one persona per workdir. Coordinator v2 Section 6 launches a coordinator beside workers, so check its launch recipe gives every supervisor its own rundir, or refuse a provided file whose persona differs from the argument.

## A supervisor's cadence env overrides never reach its child, so Section 6's coordinator tick would be ignored (found 2026-09-13)

`bin/supervise.sh` sets `TICK_MS`, `NUDGE_IDLE_MS` and `GIT_PROBE_MS` from the `controllerTickMs`, `nudgeIdleMs` and `gitProbeMs` env vars, then sources `bin/agentic-common.sh`. The library's `PROFILE` block reassigns all three without a `${VAR:-}` guard, so the settings file carries the profile's values whatever the caller exported. With `NUDGE_IDLE_MS=600000` set before sourcing the library, the value reads `45000` afterwards.

Two consumers are affected today. `.kit/live-restartrequest-test.sh` exports `nudgeIdleMs=600000` so no controller nudge can pause its plan, and it actually runs with 45-second nudges. Coordinator v2 Sections 5 and 6 set the coordinator's `controllerTickMs` to 60000 at launch through exactly this path, so neither can hold until this is fixed.

Pre-existing since `b5cb8ae`, which moved the helpers into the library. Raised by the Section 0 item 5 review and ruled outside that item's scope. The likely fix is the profile block assigning `TICK_MS="${TICK_MS:-30000}"` and its siblings, but check every `.kit/live-*.sh` caller that sets `PROFILE` expecting it to win over an inherited value first.

## The harness delivers far more turn completions than turn starts, so the open-turn guard is blind for most turns (found 2026-09-13)

Cheap first step, not yet done: neither event is logged with its turn id, so nobody can tell whether the extra completions are unpaired turns or repeated deliveries of the same one. Log `e.turnId` on both `turn.start` and `turn.complete`, run a worker for a while, and read the pairing off a live log. Section 9 leans on that pairing: it derives the published deferral stamp from the open-turn map, so a start whose completion never arrives now pins the stamp instead of being cleared by the next completion, and the claim that this cannot happen is inferred from the map being in-process rather than confirmed from a log.

`run/child-1/claude-debug.log` carries 9 `turn.start` lines against 34 `turn.complete` lines. `run/child-2/claude-debug.log` carries 5 and 5, so the asymmetry is intermittent rather than constant. Counted on a live log while the fleet was running, so the exact numbers move; the ratio is the finding.

Section 11 bounds the goal nudge with an open-turn map keyed by turn id. That map can only hold a turn whose `turn.start` was delivered. On a session in the state above, `turnIsOpen()` reads false while real turns are running, and the controller tick is free to nudge into live work. Section 11 satisfies its own acceptance criterion as written and the guard is still blind for most turns in practice.

Not root-caused. The open question is why `turn.start` goes undelivered while `turn.complete` does not, which is a harness event-delivery question rather than a plugin one. Worth answering before the coordinator leans on the in-flight reading across many workers, since a blind guard there means a coordinator nudging into live turns on every worker at once.

Section 9 deliberately does not fix this. Its own change leaves the absorber in place: `lastTurnComplete` keeps updating on every completion, matched or not, which is what has kept the idle reading roughly honest through this all along.

## A promoted owner inherits the dead owner's idle anchor and can be nudge-eligible on its first tick (found 2026-09-13)

A second, separate defect on the same heartbeat surface: `writeClaimDirect` in `hooks/index.ts` writes the owner's heartbeat entry with `sessionId`, `epoch` and `lastSeen` and no `turnStartedAt`, while the comment above the shared writer claims every owner write site goes through the helper that carries the stamp. A promotion taken mid-turn therefore drops the published stamp until the next tick, and a reader in another session reports no turn running while one is. Pre-existing, and it matters more now that Section 9 makes that stamp the authoritative answer to how long a record has waited.

The heartbeat tick's promotion path in `hooks/index.ts`, the branch that calls `parseState` and takes ownership when the previous owner's claim has gone stale, does not reset `sess.state.monitor.lastTurnComplete`. The two other paths that take ownership both reset it: the `session.start` handler, whose comment says a persisted value would make the first tick look like hours of idle time, and the `identity_set` ownership path. Cited by symbol rather than line, because the line numbers moved under the commit that first wrote this entry.

So a session promoted to owner reads the previous owner's last completion as its own, and where that owner died a while ago the first tick sees a large idle gap and is eligible to nudge immediately. Small, self-contained, and outside Section 9's files.

## commons-unit-test.mjs once died in a libuv teardown assertion after passing (found 2026-09-13)

One run printed `All tests passed` and then exited 127 on
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94`. The crash is in
teardown, after every assertion had completed, so the exit code and the result disagree. It did not
reproduce in seven further runs across two sessions on the same tree, and the change in flight did
not touch that file.

Filed rather than called a flake, because the shape matters more than the frequency: a suite that can
exit non-zero after passing will also read as failing to any gate that trusts the exit code, which is
every gate here. The likely cause is a handle closed twice during teardown. Worth catching the next
occurrence with `--trace-uncaught` rather than hunting it cold.

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

## Design direction: let the outer loops recover a session that stopped, rather than only preventing the stop (operator dialog, 2026-09-13)

Not a defect and not yet a plan. Recorded from a design conversation with the operator so it survives the session that had it.

The problem it addresses, in the operator's own account: sessions are often found parked mid-effort, having declared a next action and then stopped, losing hours of wall-clock progress. The kit's stop hooks were built to prevent exactly that. The proposal is that the supervisor shell, which already launched the session and holds both ends of its pipe, could also recover one after the fact, the way a person at the keyboard types "continue".

What makes it viable: `bin/supervise.sh` runs the child under a bash coproc with stream-json in both directions, so the shell can both type in and read out. The child emits exactly one result line per turn it completes, and the launcher already gates on that line before writing a prompt, because a prompt written earlier is absorbed into the open turn instead of starting its own.

The discriminator is the hard part, because one keystroke helps in one state and harms in another. Idle but alive: typing is right, and is what the operator does by hand. Process gone: typing does nothing and the existing restart is the answer. Mid-turn: typing is actively harmful, because the prompt queues and joins the next turn, which is the nudge pile-up Section 11 exists to stop.

The signal to build the discriminator on should be the shell's own, not the plugin's. The plugin's open-turn reading depends on `turn.start` events that are delivered for a minority of turns, per the entry above. The shell knows when it wrote a prompt and when the result line came back, and observes both halves itself.

Keep the stop hooks beside this rather than replacing them. They cover different failures. A hook prevents a bad stop at no cost when it works, but cannot fire in a session that has died, since whatever killed the process took the hook with it. A loop repairs after the fact and always pays a detection delay plus a resume that re-reads the plan and re-derives what the stopped session already held.

Design against one failure from the start: a loop that types "continue" on every quiet stretch will eventually type it into a session that correctly finished, which is the failure the operator described on a sibling project, many review rounds building features nobody asked for. The loop needs a predicate for whether work should still be happening, not only whether work is happening. The armed kit goal is the natural source, since it already records what the session was meant to finish.

Two limits worth knowing before anyone builds this. There is no working-on-it event in the stream, because the spinner is drawn by the interactive display, so silence during a long tool call is indistinguishable from death on the pipe alone and growth is the honest liveness evidence. And prompts the plugin submits to itself are not echoed into that stream, so a shell-side monitor sees the turn a self-nudge causes but never the nudge.

## A design conversation with the operator has no capture rule, so whether it lands anywhere is a judgment call each time

The outer-loop recovery conversation reached a real design direction and landed in zero
files until the operator asked whether dialog is captured automatically. It is not. Nothing
in the tree names a destination for what a conversation produces, so capture depends on the
session noticing that the conversation was worth capturing, which is exactly the judgment
that failed.

The remedy is a rule keyed on the shape of the conversation rather than on that judgment.
Four shapes, worked out with the operator:

- **Status or steering.** "What are you working on", "check the conflicts on PR 25". The
  plan doc and the work itself are already the record. Nothing to capture.
- **A question.** Capture turns on one check: did answering require establishing a fact
  that was not already written down? If the answer came from reading code, counting log
  lines, or tracing a rule across documents, it is a finding and belongs in memory. If it
  came from what was already on disk, nothing new exists.
- **A correction.** The operator correcting how the session reasons or acts. Belongs in
  memory where it is specific to this project, in the doctrine where it is not.
- **A design direction.** An idea worked out in dialog. Belongs in the backlog or as a plan
  section.

The last three do not end until something durable exists, and the write does not wait for
the conversation to converge. Waiting for agreement before capturing is the same failure in
a slower form.

Open: where the rule itself should live. Project memory holds it for this repo only. The
doctrine holds it everywhere and is the heavier edit. The lean is the doctrine, because the
failure is not specific to this repo. Operator's call.
