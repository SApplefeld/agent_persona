# Direct lines to the architect

Status: Draft
Commit Model: Branch-and-PR
Created: 2026-09-22

This is a plan shell. The DEV-PERSONA worker, which owns the agent_persona clone, drafted it because the architect holds no clone of this repository. The architect reviewed the first draft on 2026-09-22, and this revision carries that review. The architect reads it once more and moves the header to `Ready`.

## Goal

When this is done, a worker can put a design question straight to the architect, and the architect can answer that worker straight back. Any session that owns a named persona can send a record to the architect persona with `agentic_say`. It can read its own records there with `agentic_inbox`. Today both work only with the coordinator persona. The architect treats a worker's design ask as its own work item. It answers the worker with `agentic_say`, over a narrow line that reaches only a persona whose record to the architect it has taken delivery of and not yet resolved. Workers are told the line exists.

Direct lines do not remove the architect's clone gate. The architect still clones only a remote URL the operator wrote on the architect's own channel. A worker's ask about a repository the architect holds no clone of ends in an answer returned in the record, or waits on the operator's URL.

It matters because workers report they cannot reach the architect. Every design question a worker has now goes through the coordinator, who re-sends it and relays the answer back.

## Dispatch Authorization

The operator asked for this on 2026-09-22 on the architect persona's Discord thread. The architect quoted the operator's words from its own channel in its review of the first draft. DEV-PERSONA has that quote from the architect's record and not from the thread itself.

> I believe that the sessions should be able to talk to each other in full, and most especially talk to the steward and talk to the architect... at the very least I think that every session should be able to talk directly to you and to the steward... If we have an `in the fleet.json` named who the coordinator and architect sessions are, there should be direct lines of communication available to those sessions.

Execution waits on the architect setting this plan `Ready` and on the operator's word to run it.

## Intent

The operator's frame is the quote above. Sessions should be able to talk to each other, the architect and the steward most of all. Where the fleet's configuration names the coordinator and architect seats, lines to those seats should exist.

Done means four things. A worker reaches the architect without the coordinator in between. The architect works a worker's design ask as its own. The architect answers that worker directly. The worker's own instructions say the line exists and what it is for.

Done does not need a new store, a new tool or a new configuration file. The existing inbox, its existing labels and the two existing settings carry all of it. Done does not change who may read fleet state or restart a persona. It does not widen what the architect may clone.

Alternatives refused:
- Lines between every pair of sessions, which is the operator's wider wish. Deferred rather than refused. The rule that keeps a session on the `default` persona out of every inbox (`hooks/operator.ts:606-611`) exists so that not every plugin-loaded session on the machine can write into a seat's inbox. Widening that deserves its own plan.
- A new fleet file naming the seats. Refused, because the `coordinatorPersona` and `architectPersona` settings already name both.
- Giving the architect the coordinator's leg to any persona. Refused, because that leg is what carries the coordinator's steering standing, and the architect answers rather than steers.
- The architect answering only through `agentic_resolve`'s note. Refused as the main path, because the note is capped at 2,000 characters, and a plan review or a consult routinely runs past that. It stays the fallback named in Section 1.

Rulings:
- 2026-09-22, the architect, answering the first draft's open questions. The architect answers a worker over a narrow leg. Sessions that own no named persona get no line. The coordinator gets no automatic copy of direct traffic. The steward in the ask is the coordinator persona, which this fleet names STEWARD.
- 2026-09-22, the architect: the coordinator keeps sight of every ask that becomes work, with no copy needed. A plan reaches a worker's queue only through the coordinator, a rule the architect's charter already states.

Provenance: drafted by DEV-PERSONA on 2026-09-22 from the coordinator's relay of the ask and from the code at `origin/main` `dda8afb`. Revised the same day on the architect's plan review, which reached DEV-PERSONA through the coordinator.

## Related plans

- `docs/plans/agent_persona_steward-architect_v1.md` created the architect seat, its `architectPersona` setting and its charter. That plan's Standing Brief Amendments are cited at `hooks/index.ts:3241`.

## Approach

**What exists today.** Each point below was read at `origin/main` `dda8afb` on 2026-09-22. Line numbers move as other plans merge, so find each site by the text quoted or the function named.

- The inbox reach rule has three legs, in `deliveryGroundIn` at `hooks/operator.ts:636-663`, documented at 596-629. A writer reaches a target when it holds a reader claim on that target. It also reaches it when it owns the coordinator persona. Finally, it reaches the coordinator persona when it owns a named persona other than `default`. That last one is the worker leg, and it names the coordinator alone.
- An inbox record lives at `inbox:<persona>:<writerSessionId>:<seq>`, with `from` naming the writer's session and `status` one of `pending`, `delivered`, `answered`, `skipped` or `resolved` (`hooks/operator.ts:9,20,24-39`).
- The architect seat is named in configuration. `.claude-plugin/plugin.json:89-94` declares `architectPersona` beside `coordinatorPersona` at 83-88. Its description says the supervisor is its only reader. `bin/supervise.sh:414-427` reads it and refuses one persona named for both seats.
- `deliveryGroundIn` takes `coordinatorPersona` as a parameter. In `hooks/index.ts`, `agentic_say` reaches it through `mayReachPersona` at 7074, and `agentic_inbox` does the same at 7116. The three delivery sites call it directly at 3826, 3927 and 7427. `fleet_status` at 7179 and `fleet_restart` at 7222 call it with the coordinator as the target.
- Three charters state today's routing, and all three must change together.
  - The architect's charter (`ARCHITECT_ROLE_INSTRUCTION`, `bin/supervise.sh:2987`) says a record from any persona but the coordinator "is information rather than an ask". It also says the architect answers the coordinator "and you never address a worker directly".
  - The coordinator's charter (`bin/supervise.sh:2924`) says "The architect answers you with a record addressed to your persona and never addresses a worker itself, so you relay its answer to the worker that escalated".
  - The worker's steer text (`COORDINATOR_STEER_INSTRUCTION`, `bin/supervise.sh:2822`) names no architect. The idle nudge a worker reads (`hooks/index.ts:5152`) points a genuine fork at an `ASK:` line and nowhere else.
- A worker already reads a `[WORKER:<persona> ...]` prompt as carrying no delegated authority (`bin/supervise.sh:2822`). An answer labelled `WORKER:<architect persona>` therefore grants the architect no standing to steer.

**The design.**

1. The plugin reads `architectPersona` from its options, under the same name rule and `default` refusal `coordinatorPersona` takes at `hooks/index.ts:2095-2099`. A value equal to the coordinator persona reads as unset, the pair the supervisor already refuses.
2. The worker leg widens from "the target is the coordinator persona" to "the target is the coordinator persona or the architect persona". The record is labelled `WORKER:<persona>`, as a worker's record to the coordinator is today.
3. A fourth leg, the answer leg. The writer owns the architect persona. The target persona has a live owner claim, and that owner's session wrote a record to the architect persona whose status is `delivered` or `answered`. Such a record has reached the architect and has not been resolved. The record is labelled `WORKER:<architect persona>`. The leg grants nothing beyond that label, which a worker already reads as a peer's answer. It closes when the architect resolves the record, so the architect sends its answer first and resolves second.
4. `fleet_status` and `fleet_restart` stay gated on the coordinator persona alone, so a `WORKER` ground stays refused there (`hooks/index.ts:7184`).
5. The three charters and the nudge change as Section 2 states.

## Sections of Work

### 1. The worker leg reaches the architect, and the architect answers back
Model: opus

`hooks/index.ts` reads `architectPersona` beside `coordinatorPersona`. `deliveryGroundIn` and `mayReachPersonaIn` in `hooks/operator.ts` take the architect name. The worker leg admits it as a target, and the answer leg in design point 3 is added. The answer leg reads the inbox records addressed to the architect, so `deliveryGroundIn`'s callers pass those records, or a reading form fetches them beside the claims. Every caller passes the architect name. The descriptions of `agentic_say` and `agentic_inbox` name the architect as reachable. The `coordinatorPersona` and `architectPersona` setting descriptions say what the plugin reads, and the latter no longer says the supervisor is its only reader. Each description stays under the length test's bound, and the injection ledger and `docs/architecture.md`'s totals are refreshed.

If reading the record store inside the reach rule proves too invasive for this section, the fallback is the answer path through `agentic_resolve`'s note with its 2,000-character cap raised. The worker leg still lands. The Chapter records the fallback as a declared assumption. It costs a record-sized answer being squeezed into a note, and the note stays unlabelled rather than arriving as a prompt.

Acceptance (draft):
- A session that owns a named persona sends to the architect persona, and the record is delivered labelled `WORKER:<persona>`. The same send with `architectPersona` unset is refused with today's reason.
- That session reads its own records at the architect with `agentic_inbox` and the persona argument set to the architect.
- A session on `default` is refused when sending to the architect.
- The architect's owner sends to a worker whose record to the architect is delivered and unresolved, and the record reaches the worker labelled `WORKER:<architect persona>`. The same send after the architect resolves that record is refused. So is a send to a persona that holds no such record.
- `fleet_status` and `fleet_restart` still refuse a `WORKER` ground.
- An `architectPersona` value equal to the coordinator persona leaves both architect legs closed.
- The existing reach-rule tests pass, edited only where they pin the worker leg's old text.

Files in scope: `hooks/operator.ts`, `hooks/index.ts` (the options read, the reach-rule callers, the `agentic_say` and `agentic_inbox` registrations), `.claude-plugin/plugin.json`, `.kit/controller-tick-test.mjs`, the reach-rule unit tests under `.kit/`, `.kit/injection-ledger.json`, `docs/architecture.md`.

### 2. Three charters and the nudge name the line
Model: opus

The architect's charter at `bin/supervise.sh:2987` changes in three places.
- (a) A prompt labelled `[WORKER:<persona> id=<record id>]` carrying a design ask is the architect's own work item, worked as a coordinator record is.
- (b) The architect answers such a record with `agentic_say` to that worker, before closing it with `agentic_resolve`. It still answers the coordinator's records to the coordinator.
- (c) The clone rule stands as written. A repository named in a worker's record is reported and not cloned. A plan the architect writes for a worker still reaches the worker's queue only through the coordinator.

The coordinator's charter at `bin/supervise.sh:2924` loses the sentence saying the architect never addresses a worker. It keeps routing its own design asks, and the operator's, to the architect.

The worker's steer text at `bin/supervise.sh:2822` gains one sentence. It names the architect persona as the seat for a design question the worker's plan does not cover: a spec gap, an approach fork, a plan review or a consult. Such a question goes by `agentic_say` with the persona argument set to the architect. Everything else keeps the coordinator ask shape. The idle nudge at `hooks/index.ts:5152` names the same line beside its `ASK:` instruction, and the injection ledger is refreshed with it.

`README.md` describes the widened reach rule where it describes the inbox, and names both architect legs.

Acceptance (draft):
- The three charters agree with each other and with Section 1's code. No charter still says the architect never addresses a worker, and none says a worker's record is information only.
- `.kit/supervisor-natural-exit-test.sh`'s priming pins pass, edited only where they pin the sentences this section changes.
- The nudge text and each charter stay under the injection ledger's no-growth test once the ledger is refreshed.

Files in scope: `bin/supervise.sh` (the three charters), `hooks/index.ts` (the nudge text), `.kit/supervisor-natural-exit-test.sh`, `.kit/controller-tick-test.mjs` where it pins the nudge, `.kit/injection-ledger.json`, `README.md`, `docs/architecture.md`.

## Out of Scope

- Any new configuration file. The two existing settings name the seats.
- Lines between every pair of sessions. The Intent defers them to their own plan.
- Any change to who may read fleet state or restart a persona.
- Any change to the architect's clone rule.
- Any change to delivery timing, urgency or the break-in bound.

## Assumptions

- assumed 2026-09-22 (the repository's other plans): the commit model is Branch-and-PR; reversal: one header line.
- assumed 2026-09-22 (the architect's ruling): a record that is `answered` but not `resolved` still opens the answer leg, because an answered record is one the architect replied to in a turn and has not yet closed; reversal: one status in the leg's test.

## Chapters
