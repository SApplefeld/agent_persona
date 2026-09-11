# Backlog

## Suite hardening

_No open items. Resolved items are archived in `docs/archive/backlog-2026-09-11.md`._

## Commons claim staleness (found working agent_persona_passive-supervisor_v1.md, Item 2)

A session's commons entry (`hooks/commons.ts`, `claimResource`/`releaseResource`) keys liveness on one `lastSeen` field shared across every resource that session has ever claimed. Any commons write the session makes for its *current* persona refreshes that one field, which also refreshes the apparent liveness of every other claim the session is still carrying, including a `persona:X` claim for a persona it switched away from and never released. Two ways this surfaced in one session:

1. `agentic_identity` claims the new persona but never releases the old one. A session that starts as `default` and switches to `dev` keeps a `persona:default` claim alive in commons for as long as it keeps heartbeating as `dev`.
2. Any other live session with the same pattern (observed: a session holding `persona:default`, `persona:relay`, `persona:dev`, and `reader:dev` simultaneously) blocks a fresh child from ever becoming owner of `default`, even though nothing is actually working as `default` right now.

Effect: a fresh child that claims persona `default` (the plugin's hardcoded starting persona, see Item 6's persona-option bullet) always loses the commons arbitration to a stale-but-falsely-live claim and permanently yields ownership (`sess.isOwner = false`, one-way for the life of that session) the first time it tries to persist. This will make Item 7's `default`-persona live suites flaky or wedged the moment any dev session on the machine has ever touched `default` and moved on.

Fix shape (not yet built): either scope `lastSeen` per claim rather than per session, or have `agentic_identity` (and any other persona switch) call `releaseResource` on every claim the session is dropping before claiming the new one.
