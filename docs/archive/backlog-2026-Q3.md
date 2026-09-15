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
