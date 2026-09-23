# Backlog snapshot 2026-Q3

Backlog items retired during the third quarter of 2026, each with the reason it left the active list. The earlier one-off snapshot is `backlog-2026-09-11.md`.

## A supervisor's cadence env overrides never reach its child, so Section 6's coordinator tick would be ignored (found 2026-09-13)

`bin/supervise.sh` sets `TICK_MS`, `NUDGE_IDLE_MS` and `GIT_PROBE_MS` from the `controllerTickMs`, `nudgeIdleMs` and `gitProbeMs` env vars, then sources `bin/agentic-common.sh`. The library's `PROFILE` block reassigns all three without a `${VAR:-}` guard, so the settings file carries the profile's values whatever the caller exported. With `NUDGE_IDLE_MS=600000` set before sourcing the library, the value reads `45000` afterwards.

Two consumers are affected today. `.kit/live-restartrequest-test.sh` exports `nudgeIdleMs=600000` so no controller nudge can pause its plan, and it actually runs with 45-second nudges. Coordinator v2 Sections 5 and 6 set the coordinator's `controllerTickMs` to 60000 at launch through exactly this path, so neither can hold until this is fixed.

Pre-existing since `b5cb8ae`, which moved the helpers into the library. Raised by the Section 0 item 5 review and ruled outside that item's scope. The likely fix is the profile block assigning `TICK_MS="${TICK_MS:-30000}"` and its siblings, but check every `.kit/live-*.sh` caller that sets `PROFILE` expecting it to win over an inherited value first.

_Retired 2026-09-15: fixed by coordinator v2 Section 6 (its Chapter 12). `bin/supervise.sh:333-336` now assigns `TICK_MS`, `NUDGE_IDLE_MS`, `NUDGE_FLOOR_MS` and `GIT_PROBE_MS` from the env after the library is sourced, and `.kit/settings-plugin-key-test.sh` drives a launch with `controllerTickMs=60000` and reads it back from the emitted file._

## Arm the plugin's hooks only for sessions that want them (operator feedback, 2026-09-12)

Promoted into `docs/plans/agent_persona_coordinator_v2.md` Section 6 (Reviewer Round 105 R5): every session loading this plugin fires its hooks and reminders every turn regardless of intent, and v2 adds more such sessions. No longer a separate future brainstorm; retire this entry when v2's Section 6 closes.

_Retired 2026-09-15: shipped by coordinator v2 Section 6 (its Chapter 12) as the `arming` key with `off`, `reader` and `owner`; an `off` session registers no tools, claims nothing and gets no reminders, and the supervisor writes `owner` for every child it launches._

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

_Retired 2026-09-15: the re-run it owed was of `.kit/live-restartpassive-test.sh`, which coordinator v2 Section 13 retired (its Chapter 5, ruling at Interim board 4). Its proof moved offline to `.kit/supervisor-natural-exit-test.sh`, the `real_live` stub case for the restart-passive relaunch and the backfilled case for the F5/F6 path, both run green at every gate since with no quiet-box condition to meet._

## Commons claim staleness (found and fixed working agent_persona_passive-supervisor_v1.md, Items 2-3)

Fixed in Item 3 (Chapter 3): `agentic_identity`'s handler now releases its previous persona's commons claim on every switch, before claiming the new one.

The root cause: a session's commons entry (`hooks/commons.ts`, `claimResource`/`releaseResource`) keys liveness on one `lastSeen` field shared across every resource that session has ever claimed. Any commons write the session makes for its *current* persona refreshes that one field, which also refreshes the apparent liveness of every other claim the session is still carrying, including a `persona:X` claim for a persona it switched away from and never released - `agentic_identity` claimed the new persona but never released the old one, so a session that started as `default` and switched to `dev` kept a `persona:default` claim alive in commons for as long as it kept heartbeating as `dev`. Reproduced three times across two sessions (this session's own residue in Item 2, then an unrelated live sibling session's residue in Items 2 and 3), each time permanently demoting a fresh scratch child to a passive reader (`sess.isOwner = false`, one-way for the life of that session) the moment it tried to persist under `default`.

Residual caveat: the fix only takes effect for a session running the updated code. A session already live with the old code in memory (observed: one holding `persona:default`, `persona:relay`, `persona:dev`, and `reader:dev` simultaneously) keeps its already-leaked stale claim until it restarts. This is not mine to clear directly - it's another session's own commons state. If Item 7's `default`-persona live suites still see a wedged pre-gate after this fix lands, check for a live sibling session running pre-fix code before assuming a new regression.

_Retired 2026-09-15: fixed in the passive-supervisor v1 plan's Item 3, as the entry itself records. Its residual caveat, a live session still running pre-fix code, expired when every session on the box restarted for the move to SCOTT-CLAUDE on 2026-09-13._

## The natural-exit relaunch never checks for a surviving claude.exe, because the child's Windows pid is resolved only at stop time (found 2026-09-13)

`bin/supervise.sh` translates the child's MSYS pid to a Windows pid inside `stop_child` alone, and that translation finds nothing once the wrapper has exited. So the `STOP_PATH="gone"` early return, the natural-exit relaunch, and the escalation retry's re-snapshot never look at descendants. If `env.exe` is killed from outside while `claude.exe` under it survives holding the persona claim, the relaunch walks into the 120-second pre-gate and exits 2 with an orphan. The remedy is to resolve and store the Windows pid right after the `coproc` launch, and snapshot from the stored value on every stop and before a natural-exit relaunch. Needs a live proof, which is why it was not folded into Section 0's finishing fix round.

_Retired 2026-09-17: fixed by the process-keeper plan's Section 4 (its Chapter 4), archived at `docs/archive/agent_persona_process-keeper_v1.md`. The fix follows the code rather than the remedy recorded above: instead of storing a Windows pid at launch, `bin/supervise.sh` keeps a creation-time-guarded process tree record and sweeps it before every natural-exit relaunch, at `sweep_child_tree "natural_exit"` (`bin/supervise.sh:3116`), with the same sweep on the shutdown path at `:3099`._

## The supervisor treats a rate-limited child as merely quiet (parked 2026-09-13, backfilled from git history)

A 429 carrying a `five_hour` limit parks a child in a retry backoff (`retryInMs` up to 75 minutes, `maxRetries` 300). The supervisor sees only a live process and logs `WAITING`, so nothing distinguishes a working child from one asleep for over an hour. Remedy: read the child's `stdout.jsonl` for `api_error` records carrying `rateLimits.rateLimitType` and `resetsAt`, and log one `RATE_LIMITED until HH:MMZ` line in place of `WAITING`. The entry's former credential-swap half is retired on the operator's decision of 2026-09-17: the account swap utility is transparent to a running child, so the supervisor takes no action on a swap. Not in item 3's PR.

_Retired 2026-09-17: fixed by the process-keeper plan's Section 4 (its Chapter 4), archived at `docs/archive/agent_persona_process-keeper_v1.md`. `bin/supervise.sh` reads the newest rate-limit record off the child's output stream and logs `RATE_LIMITED until <ISO>` in place of the bare `WAITING`, at `:2783` and `:2797`. That reading logs and gates nothing by design; the liveness verdict that acts on it is `docs/plans/agent_persona_supervisor-peer_v1.md`'s Section 2. The credential-swap half was already retired on the operator's decision of 2026-09-17, as the entry records._

## The decide path relaunches once more before a restart or crash limit stops the run (found 2026-09-14)

The decide path's `restart` branch in `bin/supervise.sh` updates the crash and restart counts and relaunches without checking either limit, and `bin/supervise-decide.mjs` sees the counts only at the next child's first poll. So the run that reaches `supervisorMaxRestartsPerHour` or `supervisorCrashLimit` launches one more child, which claims the persona, takes a priming turn and attaches the channel before it is stopped with exit 4 or 3. The natural-exit path checks both limits before relaunching. The remedy is the same two checks in the `restart` branch before it relaunches.

_Retired 2026-09-17: fixed by the process-keeper plan's Section 4 (its Chapter 4), archived at `docs/archive/agent_persona_process-keeper_v1.md`. The `restart` branch in `bin/supervise.sh` now reads both limits before it relaunches, at `:3042-3049`, exiting 4 on the budget and 3 on the crash loop, so neither limit is reached one launch late. The decision unit `bin/supervise-decide.mjs` returns the same two stops ahead of every restart action at `:88-100`, which is the second reader of the same counts._

## `README.md`'s persona-store paragraph names the `coordinator` entry that Section 5 replaces (found 2026-09-19)

`README.md` stated that two personas configured with the same working directory share one store file, and named `bin/fleet.example.json` as such a roster because `coordinator` and `dev` were both homed in `D:/agent_persona`. The entry's own remedy was to restate that sentence at Section 5, against whatever pair the example roster then carried, or to state the shared-directory hazard without naming an entry.

_Retired 2026-09-19: fixed by the steward and architect plan's Section 5, which did exactly that. The example roster now gives every entry its own working directory, so it provides no such pair to name, and the sentence takes the second of the two remedies: it states the hazard and that nothing in the code prevents a roster being written that way, naming no entry. The paragraph's closing sentence already said one working directory per persona is a roster property rather than something the code enforces, so the point the entry wanted preserved stands._

## A harness task notification arriving as a prompt is backfilled as a completed root titled with the notification block, in every session the plugin loads under (found 2026-09-16)

When a background task, a dispatched agent or a workflow finishes, the harness delivers its `<task-notification>` block to the session as a prompt. The item 2 backfill treats that turn like any other with no `goal_create` call: it creates a one-round root whose `title` and `objective` are the raw notification text, marks it complete in the same tick, and prunes whatever node was live. Read 2026-09-16 in three stores: `D:/claude-kit/.agentic-personas.json` holds a dozen such roots from one morning, every one titled `<task-notification>`, and the kaizen node the self-review had just raised (`plan-mu407f4t-z539`, activated 11:14:51Z) was gone by the next backfill; the `dev` and `coordinator` entries in this repository's store carry the same shape. Three consequences. The goal tree is unreadable, since every root is a notification block. A node the loop raised on purpose is lost to bookkeeping on the next notification. And under the installed 0.10.0 copy, which predates the arming key, this runs in every interactive session in a directory where the plugin loads, so a kit session that never asked for a goal tree keeps one anyway and sees `activated` lines on its status bar. The channel-reply variant of the same backfill, and the restart it triggers under a supervisor, is recorded in this project's memory as `a-goal-less-worker-restarts-on-every-operator-message`. Remedy: the backfill reads the turn's origin and does not synthesize a root from a task notification, a channel reply on a treeless persona, or any prompt the operator did not type; where a root must exist for scoring, it is one persistent `conversation` root rather than a completed root per turn. Proof: a unit case driving a task-notification prompt through the backfill and asserting no root is created and a live kaizen node survives it.

_Retired 2026-09-22: fixed by the goal tree curation plan's Section 2. A turn that does work with no active root, a task-notification turn among them, no longer builds a root at all. It leaves one `untracked_work` decision line that later such turns collapse into, and the persona's goal tree, live nodes included, is left as it was._

## An error streak on an active leaf overwrites an open ask without closing it (found 2026-09-22)

The controller tick's error-streak branch in `hooks/index.ts`, on its active-node arm, sets `pendingAskId` to a new ask whether or not one is already open. A leaf can stay active while an ask is open, since the ASK-marker path pauses only the node it names. In that state the first ask record stays `open` in the store and no answer can match it. The behaviour predates the no-goal-idle plan, whose section 1 review surfaced it. Remedy: skip opening a second ask while `pendingAskId` is set, or close the old record as superseded before writing the new one. Proof: a tick case with an open ask and an active leaf reaching a streak shows one open ask record afterwards.

_Retired 2026-09-22: promoted into `docs/plans/agent_persona_ask-bookkeeping_v1.md` on the operator's approval, relayed by the coordinator. The plan owns this item now; the work is not yet done._

## goal_create leaves an open ask pointing into the tree it replaced (found 2026-09-22)

When `goal_create` replaces a tree, it resets `activeGoalId` and nothing else that names a node. `pendingAskId` can still name an open ask on an entry that now lives only in `.agentic-goal-history.jsonl`. While it does, `goal_add`'s no-active-leaf branch reads the ask as a hold and activates nothing on the new tree, for as long as the ask stays open. This predates the goal tree curation plan, whose Section 4 made replacement deliberate and left this path as it was. The remedy is to close an ask open on the replaced tree the way `goal_resume` closes one, with the decision detail naming `goal_create`.

_Retired 2026-09-22: promoted into `docs/plans/agent_persona_ask-bookkeeping_v1.md` on the operator's approval, relayed by the coordinator. The plan owns this item now; the work is not yet done._

## A thread reply that closes an ask sets the asked entry active without pointing activeGoalId at it (found 2026-09-22)

The ask close in the `prompt.submit` handler reactivates a paused asked entry by setting its status to `active` alone (`hooks/index.ts`, the block opening "D5b (bullet 1): an open ask never silences the worker"). It never sets `activeGoalId`. Until the next store load, which runs `enforceInvariants` and repairs the pointer, a session can hold an active entry that `activeGoalId` does not name. Anything that keys on the pointer then misreads the tree. `goal_done`'s no-nodeId path is one such reader. Found by the goal tree curation plan's Section 3, whose harness case reaches that stale state through this path. The remedy is to set `activeGoalId` beside the status, as `goal_resume` does.

_Retired 2026-09-22: promoted into `docs/plans/agent_persona_ask-bookkeeping_v1.md` on the operator's approval, relayed by the coordinator. The plan owns this item now; the work is not yet done._

## The keeper's boot-time execution surface has no security model document (found 2026-09-17)

The process keeper adds a surface the README's Trust boundary section does not describe: a scheduled task under the Password logon type at RunLevel Limited, the account's password held by the scheduler, starting at boot with no console, launching children whose `permissionMode` in the shipped roster is `bypassPermissions`. That logon unlocks the account's user-scope DPAPI key for the task, so every persona holds the operator account's whole DPAPI reach on the box: every Windows Credential Manager entry, Git Credential Manager's store, the Azure CLI token cache and any browser-saved password, not only the git credentials the fleet needs. The scheduler holds the password in the LSA vault, recoverable by anyone holding SYSTEM, so the security model's preconditions include that the account's password is unique to this machine. The operator's decision of 2026-09-15 accepts the roster, the environment file and the repository tree as trusted machine state with no permission check, on the ground that the box is a dedicated sandbox only the operator reaches. That decision currently lives in a plan document, which archives when the plan closes. Remedy: a short `docs/security-model.md` recording the surface, the accepted risks and the preconditions each one rests on, so the decision has a home that outlives the plan. Proof: the document exists and names the sandbox precondition, and the README's Trust boundary section points at it.

_Retired 2026-09-22: promoted into `docs/plans/agent_persona_security-model_v1.md` on the operator's approval, relayed by the coordinator. The plan owns this item now; the work is not yet done._

_Done 2026-09-23: `docs/archive/agent_persona_security-model_v1.md` delivered `docs/security-model.md`, confirmed by the operator (branch security-model-build)._
