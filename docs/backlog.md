# Backlog

## The natural-exit relaunch never checks for a surviving claude.exe, because the child's Windows pid is resolved only at stop time (found 2026-09-13)

`bin/supervise.sh` translates the child's MSYS pid to a Windows pid inside `stop_child` alone, and that translation finds nothing once the wrapper has exited. So the `STOP_PATH="gone"` early return, the natural-exit relaunch, and the escalation retry's re-snapshot never look at descendants. If `env.exe` is killed from outside while `claude.exe` under it survives holding the persona claim, the relaunch walks into the 120-second pre-gate and exits 2 with an orphan. The remedy is to resolve and store the Windows pid right after the `coproc` launch, and snapshot from the stored value on every stop and before a natural-exit relaunch. Needs a live proof, which is why it was not folded into Section 0's finishing fix round.

## A backfilled root_complete relaunch has no rate bound, and a newer backfilled root can mask a real completion (found 2026-09-13)

A child that does one backfilled tool turn and exits 0 is relaunched outside both the crash counter and `SUPERVISOR_MAX_RESTARTS_PER_HOUR`, so a child that repeats that shape relaunches without limit. Separately, `get_root_complete` reads only the newest `root_complete`, so a real completion followed within one poll by a backfilled one reads as backfilled and the finished child stays up. Count backfilled relaunches against the hourly restart budget without touching the crash counter, and have the reader report the newest non-backfilled timestamp beside the flag.

## A provided settings file's persona silently overrides the supervisor's persona argument (found 2026-09-13)

`bin/supervise.sh` hands `$RUNDIR/settings.json` to its child on `--settings` and writes that file only when it is absent. `RUNDIR` defaults to `$WORKDIR/run`, so a second supervisor launched on the same workdir under a different persona reuses the first launch's file. Its child claims the file's persona while the pre-gate and polls watch the supervisor's own argument, and a store check reads a claim for a persona nobody asked for.

The same shape holds under `--plugin-dir` and in installed mode. The narrow exposure today is that every launcher on the box passes its own `--rundir` or runs one persona per workdir. Coordinator v2 Section 6 launches a coordinator beside workers, so check its launch recipe gives every supervisor its own rundir, or refuse a provided file whose persona differs from the argument.

`architectPersona` sits on the same assumption and raises what it costs, because the name is a routing target as well as a charter gate. A persona running under `bypassPermissions` can write its own name into its own settings file and take the architect's charter on the next relaunch, which carries design authority the launcher never granted it. The wider case is a persona that can write another persona's run directory: writing `architectPersona` into the steward's settings file sends every design ask the steward routes to the persona that name picks, and the answers come back through the steward as records carrying its delegated authority. The supervisor logs a disagreement between the file's value and the launch environment's, and refuses one persona named for both seats. Neither stops a file the persona itself rewrote, and the log line never fires on a keeper launch at all, since the keeper's roster-to-environment map carries no `architectPersona` and so sets none (`bin/keeper-functions.ps1`, the roster field map). The refuse form below does not close it either: that form resolves the file's `persona` key and refuses when it differs from the launch argument, and a persona that writes only `architectPersona` leaves `persona` equal to the argument, so the file passes. The two refusals also give the same writer a second, cheaper outcome: a settings file naming a coordinator outside the persona character class, or one name for both seats, exits the launch before the pre-launch gate, so the persona never comes up and the keeper's relaunch ladder climbs until it holds. That is a better failure than launching a doctored instruction, and it is still a denial of service one persona can inflict on another. What closes both is refusing an `architectPersona` the launch environment did not supply, or reconciling the file's value against the environment instead of letting the file win unconditionally, together with a run directory a persona other than its own cannot write.

Coordinator v2 Section 8 adds one more consumer of the same assumption: the coordinator-role priming instruction fires when the supervisor's persona argument equals the coordinator name, and a provided file naming a different `persona` primes the wrong session or leaves the right one unprimed. The refuse form, when this entry is taken up, resolves the file's `persona` under the plugin's own rule, where a missing or invalid key resolves to `default`, and refuses when that value differs from the argument; a missing key is a mismatch, never a match, since the launcher refuses an empty argument. That fix reverses the pin in `.kit/settings-plugin-key-test.sh` that drives a differing file persona through to the pre-launch gate, so it takes its own plan line rather than a fix round.

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

## Suite hardening

_No open items. Resolved items are archived in `docs/archive/backlog-2026-09-11.md`._

## Kit-side lesson: executing-work should say a fix round takes the reviewer pair too (parked 2026-09-12, backfilled from git history)

Not this repo's fix - a pointer to the kit plugin repo. A worker that never loads `operating-instructions` or `executing-work` can claim a fix landed in a Chapter sentence when the fix is not actually in the diff, because a fix round inside a review loop is never treated as its own section needing a fresh-context adversarial and blind reviewer pair before posting (see `agent_persona_passive-supervisor_v1.md`'s "worker launch discipline" addendum, which fixes the priming-turn gap on this repo's side). The `executing-work` skill itself should say in words that a fix round inside a review loop is a section under its own dispatch rules, not an exception to them - carry this lesson to that skill's own repo when next working there.

## A KILL-path variant of the restart-passive F2 leg, now the natural-exit suite's `real_live` case (Reviewer Round 126 R76 ruling, worded per R93, 2026-09-12)

`.kit/supervisor-natural-exit-test.sh` case (g), the `real_live` stub action, proves the decide path's `RESTART_PASSIVE` and relaunch for a child that stops cleanly on the EOF path, and `.kit/live-restartrequest-test.sh` proves the claim handover on a real child. `.kit/live-stopprocesstree-test.sh`'s own Phase-3 shape - a child that ignores both EOF and TERM, forcing `stop_child` to its final KILL escalation - has no equivalent live leg proving those same two observables; it only proves process death. Add an F2-shaped variant driving an EOF-and-TERM-ignoring child through the same claim-free/pre-gate-pass assertions when this is next picked up.

## The supervisor treats a rate-limited child as merely quiet, and a credential swap never reaches it (parked 2026-09-13, backfilled from git history)

A running child never re-reads credentials, so a 429 carrying a `five_hour` limit parks it in a retry backoff (`retryInMs` up to 75 minutes, `maxRetries` 300) that survives an account swap the operator has already made. The supervisor sees only a live process and logs `WAITING`, so nothing distinguishes a working child from one asleep for over an hour. Two changes: read the child's `stdout.jsonl` for `api_error` records carrying `rateLimits.rateLimitType` and `resetsAt`, and log one `RATE_LIMITED until HH:MMZ` line in place of `WAITING`; and when the credential file's mtime is newer than the child's start, treat the child as restartable and take the `restart_passive` path. Not in item 3's PR.

## A reader session cannot write restart_requested when the owner is the stuck process (parked 2026-09-13, backfilled from git history)

`restart_requested` is writable by the owner alone. When the owner is itself the wedged child, the one session that can see the wedge (a reader holding the same persona) is refused by the tool, and the only remaining lever is killing the process from outside. Allow a reader to write the fact when the owner's heartbeat is stale, on the same staleness bound the stale-owner arbitration already uses. Not in item 3's PR.

## A running supervisor keeps the script it launched with, so the dev supervisor lacks this branch's later fixes until it is relaunched (parked 2026-09-13, backfilled from git history)

A running `bin/supervise.sh` keeps reading its original open file handle and never picks up a later commit. The `dev` supervisor was relaunched on 2026-09-14 for Section 0 item 5 and the `aios` supervisor started at 2026-09-14 00:11Z, so each runs the script as it stood then and lacks every supervisor change coordinator v2 landed after it: the arming key and settings completion (Section 6), the worker steer instruction (Section 7) and the coordinator role instruction with the settings-file persona read (Section 8) among them. The file under both has been rewritten since they started, and bash reads a script by offset, so code after each one's main loop is no longer what it launched with.

Nothing to fix in the tree. The remedy is relaunching each supervisor, then dropping this entry. Relaunching is destructive to whatever that supervisor's child is mid-way through, so it is taken at a quiet point rather than on sight of this entry. This is the narrowed remainder of the `aios` launcher entry and the stale-dev-clone entry, both retired in item 3's runtime-clone addendum.

## The decide path relaunches once more before a restart or crash limit stops the run (found 2026-09-14)

The decide path's `restart` branch in `bin/supervise.sh` updates the crash and restart counts and relaunches without checking either limit, and `bin/supervise-decide.mjs` sees the counts only at the next child's first poll. So the run that reaches `supervisorMaxRestartsPerHour` or `supervisorCrashLimit` launches one more child, which claims the persona, takes a priming turn and attaches the channel before it is stopped with exit 4 or 3. The natural-exit path checks both limits before relaunching. The remedy is the same two checks in the `restart` branch before it relaunches.

## A `--prompt` goal is dropped when the first child dies before its goal turn (found 2026-09-14)

`bin/supervise.sh` builds the prompt file only for child 1 and clears `PROMPT` after that first launch whether or not the goal turn was written. A child 1 that dies at startup, to a rate limit or a network fault, relaunches as a passive child 2, and the operator's task reaches no child. Only a `NOTE:` line in `supervisor.log` records the skip. The remedy is to keep the prompt until its goal turn is written, or to log the dropped goal as an `ERROR:`.

## The stale bound has no floor against the refresh cadence it measures (found 2026-09-13)

`staleAfterMs` takes the shared numeric check and nothing else, while the holders it measures refresh `lastSeen` every `heartbeatMs` (default 30000) and every controller tick. A validated value below that cadence, such as 5000, reads every live holder as stale at most polls, and the pre-launch gate passes while another session holds the persona. A floor tied to the refresh cadence is a rule across two settings that nothing in the coordinator plan asks for, so it is filed rather than built.

## The context-budget plan's status header is none of the kit's values (found 2026-09-13)

`docs/plans/agentic-plugin_context-budget_v1.md` reads `Status: Independent part Complete; checkpoint section BLOCKED-on-operator (Path C open question resolved).`, which the kit's tooling cannot read as any of its status values. The curating-docs skill rules whether the plan splits into a complete part and an open part, archives, or takes one of the three headers.

## Design direction: let the outer loops recover a session that stopped, rather than only preventing the stop (operator dialog, 2026-09-13)

Not a defect and not yet a plan. Recorded from a design conversation with the operator so it survives the session that had it.

The problem it addresses, in the operator's own account: sessions are often found parked mid-effort, having declared a next action and then stopped, losing hours of wall-clock progress. The kit's stop hooks were built to prevent exactly that. The proposal is that the supervisor shell, which already launched the session and holds both ends of its pipe, could also recover one after the fact, the way a person at the keyboard types "continue".

What makes it viable: `bin/supervise.sh` runs the child under a bash coproc with stream-json in both directions, so the shell can both type in and read out. The child emits exactly one result line per turn it completes, and the launcher already gates on that line before writing a prompt, because a prompt written earlier is absorbed into the open turn instead of starting its own.

The discriminator is the hard part, because one keystroke helps in one state and harms in another. Idle but alive: typing is right, and is what the operator does by hand. Process gone: typing does nothing and the existing restart is the answer. Mid-turn: typing is actively harmful, because the prompt queues and joins the next turn, which is the nudge pile-up Section 11 exists to stop.

The signal to build the discriminator on should be the shell's own, not the plugin's. The plugin's open-turn reading depends on `turn.start` events that are delivered for a minority of turns, per the entry above. The shell knows when it wrote a prompt and when the result line came back, and observes both halves itself.

Keep the stop hooks beside this rather than replacing them. They cover different failures. A hook prevents a bad stop at no cost when it works, but cannot fire in a session that has died, since whatever killed the process took the hook with it. A loop repairs after the fact and always pays a detection delay plus a resume that re-reads the plan and re-derives what the stopped session already held.

Design against one failure from the start: a loop that types "continue" on every quiet stretch will eventually type it into a session that correctly finished, which is the failure the operator described on a sibling project, many review rounds building features nobody asked for. The loop needs a predicate for whether work should still be happening, not only whether work is happening. The armed kit goal is the natural source, since it already records what the session was meant to finish.

Two limits worth knowing before anyone builds this. There is no working-on-it event in the stream, because the spinner is drawn by the interactive display, so silence during a long tool call is indistinguishable from death on the pipe alone and growth is the honest liveness evidence. And prompts the plugin submits to itself are not echoed into that stream, so a shell-side monitor sees the turn a self-nudge causes but never the nudge.

## A design conversation with the operator has no capture rule, so whether it lands anywhere is a judgment call each time (parked 2026-09-13, backfilled from git history)

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

## A v2 or v3 persona store reaches the tick with no cost ledger (found 2026-09-14)

`parseState` in `hooks/agent-state.ts` fills `monitor.cost` at line 393, but its v2 branch returns at 343 and its v3 branch at 361, both before that fill, and the v2 branch copies `old.monitor` whole. `enforceInvariants` never touches `cost`. So a store written before the cost ledger existed is migrated to version 4 with no `monitor.cost`, and the first controller tick reads `monitor.cost.callWindow` on undefined. `.kit/cost-migration-test.mjs` covers a v4 store missing the block and never a v2 or v3 one. The remedy is to move the cost fill above both early returns, or into `enforceInvariants`, with one fixture per old version. Found by Section 13's audit while reading the migration suite; outside that section's goal.

## The hourly cost-cap ask is controller prose of the kind Round 58 finding 3 removed elsewhere (found 2026-09-14)

`hooks/index.ts:2317-2343` opens an operator ask when the per-hour nudge budget is spent, with a question the controller composes. Round 58 finding 3 removed the same shape from the consecutive-nudge cap (`:2251-2258`) on the ground that an ask with no concrete fork from the worker has nothing for the operator to decide, and item 8.2 says asks come only from real forks. Whether the hourly cap is the one legitimate exception, because the operator must choose between raising the budget and waiting, is a design question. `.kit/controller-tick-test.mjs:3214-3216` pins the ask as it stands and stays until that question is answered. Found by Section 13's audit; outside its goal.

## `hooks/cost-ledger.ts` exports `isCapReached`, which no production code calls (found 2026-09-14)

`isCapReached` at `hooks/cost-ledger.ts:31` has no caller under `hooks/` or `bin/` (grep `isCapReached` over `hooks/`, `bin/` and `.kit/`: only its own definition). The controller inlines the same comparison at `hooks/index.ts:2306` (`effectiveWindowCount(...) >= costMaxNudgesPerHour`), so the export is dead code that the test audit exposed when its only caller, a unit-test import, was removed. Delete the export, or route the controller through it, when the cost ledger is next touched. Not done in Section 13 because that section edits tests only.

## `agentic_say` text and `agentic_resolve` note have no shared length bound at the commons store (found 2026-09-14)

`agentic_say` writes its `text` argument whole into the machine-global commons store (`hooks/index.ts`, the `agentic_say` handler), which every live session rewrites whole and polls every tick, and `agentic_resolve` now writes a `note` the same way. Section 12 caps the note at its own handler. The cap is a property of the store boundary rather than of either producer, so it belongs in one exported helper both handlers call, with the bound named in each tool description. Not done in Section 12 because `agentic_say` is outside its files in scope and its text shape is pinned by the live operator suite. Raised by the round 1 security and adversarial lenses over Section 12.

## A pending record to an unheld coordinator is lost when its writer restarts before the coordinator's first tick (found 2026-09-14, revisit with the self-healing supervisor loop)

`hooks/index.ts:1684-1707` judges every `pending` record's ground at the coordinator's tick against the writer's live claim (`deliveryGroundIn` over `readAllClaims`), and marks a writer with no live claim `skipped` under `operator_skipped_no_claim`. A worker relaunch takes a new session id, so a finding sent while no session owns the coordinator, followed by that worker's exit or relaunch before a coordinator ticks, is skipped with one decision-log line and nothing to the worker or the operator. This is the README's Trust boundary working as designed: only a live claim gets text in front of the coordinator. Decided 2026-09-14 by the operator on the supervisor's Discord thread: accept the bound for now, state it in the code comment and README (done in coordinator v2's finishing pass), and revisit it in the self-healing and auto-launch discussion, where worker restarts become routine. The candidate remedy is delivery on the writer's standing at send time for a coordinator-addressed record, labelled `[WORKER:<persona>]` with a since-exited marker, which weakens the boundary (any process on the box can write a record) and so needs its own design pass; a cheaper sibling is surfacing the coordinator-leg `operator_skipped_no_claim` to the operator on the coordinator's channel.

## `read_settings_coordinator_persona` hand-copies the plugin's persona name rule with no cross-pin (found 2026-09-14)

`bin/agentic-common.sh:246-296` (`read_settings_coordinator_persona`, `valid_persona_name`) restates the name rule `hooks/index.ts` applies to `coordinatorPersona` (non-empty after trim, no `:`, bracket-safe, not `default`), and `.kit/settings-plugin-key-test.sh` pins the bash side against its own literals only. The two rules drift silently if either changes. Remedy: one fixture list of names with the expected resolution, run through the bash function and through the TS rule (the tick harness already loads `hooks/` from node), failing on any disagreement. Left out of coordinator v2's finishing pass because it is a new test module spanning shell and node, which owes a review round of its own.

## `currentTurnKind` is one slot, so an overlapping external turn overwrites the reading the completion scores against (found 2026-09-14)

`hooks/index.ts:715` holds `currentTurnKind` as a single `let`, set at `turn.start` (`:3136`, `:3139`) and read then reset at `turn.complete` (`:3277-3278`). Two `turn.start` events before a `turn.complete` leave the second's kind in the slot, so the first turn's completion scores as the second's. Whether the harness ever overlaps turns in one session is not pinned; the open-turn reading Section 11 built assumes it does not. Remedy if it does: key the kind on the turn id (a small map cleared at completion) rather than a slot. Raised as a Minor by the coordinator v2 finishing review and left as unconfirmed reachability.

## The channel-reply backstop submits a turn from `turn.complete`, outside the controller tick the README calls the only submitter (found 2026-09-14)

`README.md` states that the controller is the only thing that calls `$.prompt.submit`. The reply backstop at `hooks/index.ts:3312-3316` submits a `[REPLY BACKSTOP]` turn from the `turn.complete` handler when a channel-origin turn ended with an answer the model never sent through the reply tool, so a second submitter exists outside the tick and its idle gate. The turn is tracked on the plugin's own queued-turn list like every other plugin submit, so the reply-link guard is not affected. Predates coordinator v2 (it landed with the channel-reply backstop, `742015b`). Surfaced by v2's docs curation as a deviation and carried to that plan's pull request; the open question is design rather than defect: either the README's controller-only rule is loosened to name this second site, or the backstop moves onto the tick and accepts one tick of delay on a missed reply.

## Design direction: the kit resolves a session's instructions, memory and leash from the repository it works in, not from its launch directory (operator dialog, 2026-09-15)

Not a defect in this repository and not a plan here. It is a change to the claude-kit plugin, for the session that maintains that repository, recorded so the handoff survives the session that had the conversation.

The problem: a persona binds to a home directory, where its store, its heartbeat and its run logs live, and the kit's hooks and the `memq` CLI resolve the project from the session's launch directory. So a persona homed outside a repository, or working in a worktree of another repository, gets its launch directory's memory tier, instructions and goal leash rather than the target repository's. The operator-tier memory record `kit-goal-inert-when-session-cwd-is-not-project-root` describes the goal half of this. The roaming architect in `docs/plans/agent_persona_steward-architect_v1.md` runs into it directly: its kit memory is its own directory's until this lands.

What the change looks like: the kit resolves the project from the repository the session's current work sits in, the main repository root of the worktree it is editing, read through git, with the launch directory as the fallback where no repository is found; `memq` and the goal CLI take the same resolution; an Expert seat's registry entry names that repository. Order: after the steward-architect plan. Owner: the claude-kit repository's Expert seat, handed off by this repository's Expert session on 2026-09-15 with the two plans above as the context.

## The installed agentic plugin labels every drained inbox record `[OPERATOR]`, so a reader speaks in the operator's voice (found 2026-09-15)

Not a defect in this repository. The installed plugin cache at `~/.claude/plugins/cache/agent-persona/agentic-plugin/0.10.0/hooks/index.ts` prefixes every drained record with `[OPERATOR] ` at its drain site, while the repository source labels by writer (`deliveryGroundIn` in `hooks/operator.ts`, README lines 436 to 442). A reader-written record therefore arrives in a persona's prompt labelled as operator steering. Observed when the Expert seat's plan pointer arrived under `[OPERATOR]` and had to be verified against the commons store before acting. Remedy: update the installed plugin to the repository's version and relaunch every live persona so the new hooks load; until then a persona verifies any plugin-delivered `[OPERATOR]` prompt against the store record's writer before treating it as steering. Owner: the operator, since the update and the relaunch are theirs.
