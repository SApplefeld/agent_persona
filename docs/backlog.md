# Backlog

## Arm the plugin's hooks only for sessions that want them (operator feedback, 2026-09-12)

The operator's feedback, verbatim in shape: every Claude session with this plugin installed loads its function hooks and fires them on every turn - fine for a session meant to run as a persona under `bin/supervise.sh`, wrong for a plain interactive chat/analysis session that has nothing to do with goal trees, commons claims, or self-review. Wants some kind of arming flag (a `-p` flag, or a skill/command for interactive sessions) so the persona machinery only loads or fires when the session actually intends to use it.

Not investigated yet: whether Claude Code's plugin system supports a per-session opt-out or lazy-registration hook (`register()` firing conditionally on an env var or settings key would be the natural shape, mirroring how `--dev`/`--plugin-dir` already gates load *mode*, not load *at all*). Needs its own brainstorming round before a spec; flagged here rather than acted on, since it's new scope outside both the v1 close-out and the v2 coordinator work in flight.

## Suite hardening

_No open items. Resolved items are archived in `docs/archive/backlog-2026-09-11.md`._

## Commons claim staleness (found and fixed working agent_persona_passive-supervisor_v1.md, Items 2-3)

Fixed in Item 3 (Chapter 3): `agentic_identity`'s handler now releases its previous persona's commons claim on every switch, before claiming the new one.

The root cause: a session's commons entry (`hooks/commons.ts`, `claimResource`/`releaseResource`) keys liveness on one `lastSeen` field shared across every resource that session has ever claimed. Any commons write the session makes for its *current* persona refreshes that one field, which also refreshes the apparent liveness of every other claim the session is still carrying, including a `persona:X` claim for a persona it switched away from and never released - `agentic_identity` claimed the new persona but never released the old one, so a session that started as `default` and switched to `dev` kept a `persona:default` claim alive in commons for as long as it kept heartbeating as `dev`. Reproduced three times across two sessions (this session's own residue in Item 2, then an unrelated live sibling session's residue in Items 2 and 3), each time permanently demoting a fresh scratch child to a passive reader (`sess.isOwner = false`, one-way for the life of that session) the moment it tried to persist under `default`.

Residual caveat: the fix only takes effect for a session running the updated code. A session already live with the old code in memory (observed: one holding `persona:default`, `persona:relay`, `persona:dev`, and `reader:dev` simultaneously) keeps its already-leaked stale claim until it restarts. This is not mine to clear directly - it's another session's own commons state. If Item 7's `default`-persona live suites still see a wedged pre-gate after this fix lands, check for a live sibling session running pre-fix code before assuming a new regression.
