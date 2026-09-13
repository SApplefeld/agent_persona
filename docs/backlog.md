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

## Kit-side lesson: executing-work should say a fix round takes the reviewer pair too (found 2026-09-13, this session's own PR #17 review chain)

Not this repo's fix - a pointer to the kit plugin repo. Two Chapter sentences in this session (Round 132's R100, Round 134's R104) claimed a fix had landed when it had not, because a fix round inside a review loop was never treated as its own section needing a fresh-context adversarial and blind reviewer pair before posting - the worker never loaded `operating-instructions` or `executing-work` at all this session (see `agent_persona_passive-supervisor_v1.md`'s "worker launch discipline" addendum, which fixes the priming-turn gap on this repo's side). The `executing-work` skill itself should say in words that a fix round inside a review loop is a section under its own dispatch rules, not an exception to them - carry this lesson to that skill's own repo when next working there.

## The aios persona launcher still exports MODEL=sonnet, pointed at a stale runtime clone (found 2026-09-13, v2 Section 0 item 3 Part B)

`/d/personas/aios/relaunch-wait.sh:12` (outside this repo) launches `/d/DeepSeekHarness/agentic-plugin/bin/supervise.sh`, a runtime clone confirmed at `1911a83` as of this entry - far behind `main` and missing item 3's own `SUPERVISOR_MODEL`/`SUPERVISOR_EFFORT` fix entirely. Dropping the launcher's `MODEL=sonnet` export now, before that clone is updated, would silently fall through to the clone's own pre-fix bare default (`haiku`), downgrading the `aios` worker rather than upgrading it to `opus` as item 3 intends. Update that runtime clone to a commit carrying item 3's fix, then drop the launcher's `MODEL=sonnet` export in the same pass; verify with `.kit/supervisor-model-test.sh` against the clone's own `bin/supervise.sh` before trusting the new default there.
