# Drop the doorbell: peer messages reach the model as the harness delivers them

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-20

## Goal

When this is done, a message one persona session sends another through the harness's `SendMessage` tool reaches the receiving model exactly as the harness delivers it, under every arming the plugin has. The plugin registers no `session.receive` hook, writes no `peer_consumed` or `receive_passthrough` decision, and raises no toast about peer text. `README.md` states that boundary in the present tense. It matters because on 2026-09-20 nine messages other personas sent the architect were consumed by that hook before the model read them, every sender's send reported success, and the architect answered none.

## Dispatch Authorization

The operator asked for this plan on 2026-09-20 on the architect persona's Discord thread, in the words "Definitely drop the doorbell in its entirety. I wish I'd caught that. The whole point of this solution is to have a small fleet of self learning and self driving agents working together, how can we achieve that if they can't talk to each other?" That is authorization to author the plan and to queue it. Execution is armed on the operator's own word, typed into the executing session's own Discord thread or relayed by the coordinator persona as a `[COORDINATOR id=...]` record that quotes it, as for the sibling plans in this directory. The executor records that word and its date in this plan's first Chapter before it starts. Nothing in this section arms it. The executor is the dev persona.

## Intent

The operator's frame, 2026-09-20, in the words quoted above. The fleet exists so that its personas work together, and a hook that drops what one says to another defeats that.

What done needs to do. A peer message reaches the receiving model under `owner` and `reader` arming exactly as it already does under `off`. Nothing of the hook remains: no registration, no decision line, no toast. The trust boundary section of `README.md` says what now reaches the model and by which path.

What done does not need to do. It gives peer text no label, prefix, record, ask, turn stamp or written-back reply inside the plugin. It changes nothing about `agentic_say`, `agentic_inbox` or the grounds they check. It does not decide what weight a receiving model gives a peer's word, which is the receiving session's own instructions to settle. It touches no supervisor script and no keeper script.

Alternatives refused.

- Pass peer text through with a plugin-added label such as `[PEER]`, the variant `README.md`'s option 2 names. Refused: the harness already delivers the text inside its own `<cross-session-message from=...>` wrapper naming the sending session, and a second label would read as a discount on the sender's word.
- Keep the hook and add an allowlist of personas whose text passes. Refused: every sender is a session on this machine under the operator's account, which is the party set the trust boundary already admits, and a list is a second place to be wrong.
- Turn a peer message into an `agentic_say` record at the hook. Refused: it would put every peer message through the drain's tick cadence and its label bracket, which is the same discount by another door.
- Keep the hook under `reader` arming only. Refused by the operator's words "in its entirety".

Rulings after the spec shipped: none at the write.

Provenance: distilled from the architect persona's exchange with the operator on Discord, 2026-09-20, after the architect found the eight consumed records in its own store.

## Approach

Verified facts, read from the clone at `origin/main` `2da6543` on 2026-09-20.

- The hook is one block, `hooks/index.ts:4828-4860`, opening with the comment `// --- D6: doorbell ---` and closing with the `});` of `on("session.receive", ...)`. It sits after `if (arming === "off") return;` at `:4826`, so it registers under `owner` and `reader` and never under `off`. Its consume branch matches `e.origin` of `peer` or `peer-send-message` as a string or as an object with `kind`, pushes `peer_consumed` with the first 80 characters, persists, toasts, and returns `{ consumed }`. Its other branch pushes `receive_passthrough` and calls `next(e)`.
- The comment at `:4824-4825` reads "An "off" session installs nothing past the session.start hook above: no doorbell, no turn hooks, no tool.call guard, no prompt hook." After the removal, no arming installs a doorbell, so the phrase names nothing.
- Nothing else in `hooks/` or `bin/` reads `peer_consumed` or `receive_passthrough`. The only readers are the three S4 cases in `.kit/controller-tick-test.mjs` (`caseS4_peer_consumed` at `:1898-1929`, `caseS4_peer_send_message_consumed` at `:1931-1955`, `caseS4_other_origin_passes` at `:1957-2010`), invoked at `:3234-3236`. `.kit/tick-harness.mjs:442-464` captures every `on(event, handler)` the module's `register` makes into `h.handlers`, so a registration's absence is readable as `h.handlers["session.receive"] === undefined`.
- `README.md` speaks the hook in three places. `:538`, the Trust boundary paragraph, opens "Text reaches the model **only** through `$.prompt.submit` from a record..." and closes with the sentences from "Peer messages (cross-session `SendMessage`) are consumed by the `session.receive` hook" to "it cannot steer the owner, open an ask, or trigger a nudge." `:558`, option 2 under "Section 6 options", names consumed as the default and a `[PEER]` prefix as the variant, and `:560` says the operator has not ruled. `:565`, the test coverage list, names "S4 (peer doorbell)".
- The harness's own delivery opens the text with `<cross-session-message from="uds:...">`, read from the `peer_consumed` details in the architect's store on 2026-09-20. So the receiving model sees which session spoke without any plugin label.
- `.kit/check-loader-rule.mjs` rule R4 refuses a file that registers one event twice. A removal cannot trip it, and the check runs at close because `hooks/` is edited.
- There is no build step. `package.json` has no `scripts`, and the harness loads `hooks/index.ts` as it stands.

## Sweep

Searches run over the clone, excluding `node_modules`: `doorbell`, `peer_consumed`, `receive_passthrough`, `session.receive`, `peer-send-message`, `peer text`, `use agentic_say`, `SendMessage`, `ListAgents`. Surfaces found: `hooks/index.ts` (the block and the comment above it), `.kit/controller-tick-test.mjs` (the three cases and their invocations), `README.md:538,558,560,565`. `README.md:358` matches `SendMessage` inside a supervisor test description that does not concern this hook. `.claude/types/claude-code.d.ts` is the harness's generated type file and is not edited. `docs/plans/archive/agentic-plugin_operator-channel_v1.md`, `docs/archive/agent_persona_coordinator_v2.md` and `docs/archive/discussion/` describe the hook as it was built and stay as written, since the archive is history. `docs/architecture.md` does not mention the hook. No instruction string in `bin/supervise.sh` mentions `SendMessage` or peer messages.

## Related

- `docs/plans/agent_persona_lean-injection_v1.md` rewrites the instruction strings the supervisor and plugin inject. None of them names the doorbell, so the two plans do not overlap.
- `docs/plans/agent_persona_deferred-gate-run_v1.md` names four plans whose runs holding the box are deferred. This is not one of them, so this plan runs its own suites.
- Two memory records describe the consumed behaviour and go stale when this lands. The operator-tier record `peer-sendmessage-is-consumed-unread-by-an-armed-persona-session` lives in the tier every project on this machine shares, read and written through `memq` with `--operator`, and the executor supersedes it at close. The architect seat's project record `peer-sendmessage-to-a-persona-session-is-consumed-unread` at `C:/Users/LocalAdmin/.claude/projects/D--personas-architect/memory/` is the architect's own, and the architect supersedes it on the coordinator persona's word that the pull request merged.

## Sections of Work

### 1. Remove the hook, pin its absence, and state the boundary

Model: sonnet

Delete `hooks/index.ts:4828-4860` whole, the comment line included, and rewrite the comment at `:4824-4825` so it lists only what an `off` session leaves out: the turn hooks, the tool.call guard and the prompt hook.

Replace the three S4 cases and their three invocation lines with one case, `caseS4_no_receive_hook`, which builds a harness under `OPTS` (`arming: "owner"`) and asserts `h.handlers["session.receive"] === undefined`, then builds a second under `{ ...OPTS, arming: "reader" }` and asserts the same. Each half also asserts `h.handlers["tool.call"]` is a function on the same harness, so an empty handler map from a failed `register` cannot pass as absence. The order is fixed: write the new case and remove the three old ones first, run the suite against the untouched hook and record the red, then delete the hook and run again for the green. The Chapter records both runs by their exit codes.

Bring `README.md` to the present tense.

- `:538`, first sentence: a record's text reaches the model only through the two paths the plugin owns, the drain's `$.prompt.submit` and the break-in's context on a tool result, both gated by the grounds this paragraph names. The sentence as written says all text reaches the model through the submit, which is false once peer text arrives by the harness's own path and was already false for the break-in `:534` describes.
- `:538`, the closing sentences from "Peer messages" onward: the plugin registers no `session.receive` hook, so a peer message reaches the model as the harness delivers it, inside the harness's `<cross-session-message from=...>` wrapper naming the sender. The plugin writes no record for it, adds no label, opens no ask, stamps no turn and writes no reply back, so what came of it is known only through what the receiver says. A peer message comes from a session on this machine, the party set the grounds in this section already admit.
- `:558` and `:560`: option 2 is settled, and `:560` says the operator ruled it by dropping the hook, with no prefix as the plan's own default under the minimum-that-solves rule rather than as part of the ruling. The sentence saying the operator has not ruled now covers option 1 alone.
- `:565`: S4 pins that no `session.receive` hook is registered.

A review finding that proposes keeping any part of the hook, a label, a prefix, an allowlist or a per-persona option is answered by the refused list under `## Intent` and closed as refused, with no consult.

Tests: the absence of the registration under both armings that install hooks, with the tool.call control beside each; nothing else in this plan carries behavioural risk.

Acceptance criteria: `.kit/controller-tick-test.mjs` exits 0 with the new case green and the three old cases gone; `.kit/check-loader-rule.mjs` exits 0; a search of `hooks/`, `bin/`, `README.md` and `docs/architecture.md` for `peer_consumed`, `receive_passthrough`, `session.receive` and `doorbell` finds no sentence saying such a hook exists, and every match is a sentence saying no `session.receive` hook is registered; and no sentence in `README.md` says peer text is consumed or never reaches the model. Both searches are silent checks, so each runs once at the base commit as well, where it speaks, and the Chapter records both runs.

At close, the operator-tier memory record named under `## Related` is superseded per the memory-system skill, pointing at this plan, and `docs/README.md`'s index line for this plan moves as the curating-docs skill directs.

Files in scope: `hooks/index.ts`, `.kit/controller-tick-test.mjs`, `README.md`, `docs/README.md`. The list names what the section's delta touches in the repository. This plan document, which gains its Chapter at close, and the memory store, which sits outside the repository, are edited under the kit's section-close and memory-system rules rather than under this list.

## Gate

- Baseline: before touching anything, the worker runs every `.kit/*-unit-test.mjs` suite, `.kit/controller-tick-test.mjs` and `.kit/check-loader-rule.mjs` on a clean tree at the base commit and records each one's pass and fail counts, exit code and wall clock. Every later run is reported as a delta against that.
- Section 1 closes on `.kit/controller-tick-test.mjs` and `.kit/check-loader-rule.mjs` green, read from their exit codes, with the red-then-green record for the new case in the Chapter.
- The fresh-context reviewer pair runs over the section's delta.
- Before the pull request is marked ready: every `.kit/*-unit-test.mjs` suite, `.kit/controller-tick-test.mjs` and `.kit/check-loader-rule.mjs` green, and `.kit/live-operator-test.sh` green, run alone under the machine's heavy-process claim, since it is the one suite that loads the plugin in real harness processes. The claim protocol, what taking the claim consists of and where its record lives, is owned by `skills/role/SKILL.md` under the kit plugin root, which the executor reads before that run.

## Out of Scope

- The grounds `agentic_say`, `agentic_inbox` and `fleet_status` check, and which persona may address which.
- What a receiving session does with a peer's word. That is the kit doctrine's and the persona's own instructions', not the plugin's.
- The supervisor, the keeper and the instruction strings they inject.
- The archived plan and discussion documents that describe the hook as built.

## Assumptions

- assumed 2026-09-20 (source: every plan header in `docs/plans/`): the commit model is Branch-and-PR; reversal: a header edit before the run starts.
- assumed 2026-09-20 (source: the sibling plans' Dispatch Authorization sections): the dev persona executes; reversal: a header edit.
- assumed 2026-09-20 (default): the plan is born `Ready`; reversal: the run sets `In Progress`.
- assumed 2026-09-20 (source: `.kit/tick-harness.mjs:442-464`, which passes its options object to `register`): `createTickHarness` honours an `arming` passed over `OPTS`; reversal: the case pins `owner` alone and the Chapter says so.
- assumed 2026-09-20 (source: the `peer_consumed` details in the architect's store): the harness wraps peer text in `<cross-session-message from=...>`; reversal: none, since the plan adds no label either way.
- assumed 2026-09-20 (source: `D:/personas/architect/run/keeper.log`, whose LAUNCH lines run `/d/agent_persona/bin/supervise.sh`): the personas load the plugin from the checkout at `D:/agent_persona`, the same one the keeper launches the supervisor from; reversal: the Operator Verification names whichever checkout the child's own command line shows.
- excluded 2026-09-20 (default): a `session.receive` hook for any other origin. The old hook only passed those through, so nothing is lost.

## Operator Verification

The running personas keep the plugin they loaded at launch, so none of this takes effect until the merged trunk is pulled into the runtime checkout and each persona is relaunched at a quiet point. That checkout is `D:/agent_persona`, the one the keeper's LAUNCH lines run `bin/supervise.sh` from, and the operator pulls it, since it is also the dev persona's working tree and a pull under a running executor is the operator's call.

- With the fleet on the new code, have any dev persona send the architect a message through `SendMessage`. The architect's thread carries a reply that names it within the architect's next turn. A new `peer_consumed` line in `D:/personas/architect/.agentic-personas.json` after the relaunch reopens Section 1.

## Open Questions

None.

## Chapters
