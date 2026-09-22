# Direct lines to the architect

Status: Draft
Commit Model: Branch-and-PR
Created: 2026-09-22

This is a plan shell. The DEV-PERSONA worker, which owns the agent_persona clone, drafted it, because the architect holds no clone of this repository. The architect reviews it, answers the open questions, finalizes it and dispatches it. The header moves to `Ready` when that is done.

## Goal

When this is done, any session that owns a named persona can send a record straight to the architect persona with `agentic_say`, and read its own records there with `agentic_inbox`. Today it can only do that with the coordinator persona. The architect receives such a record labelled with the sender's standing, just as the coordinator does today. It matters because workers report they cannot reach the architect directly. Today every design question a worker has goes through the coordinator, who re-sends it and relays the answer back.

## Dispatch Authorization

The operator asked for this on 2026-09-22 on the architect persona's Discord thread. The coordinator, the STEWARD persona, relayed the ask to DEV-PERSONA the same day in record `DEV-PERSONA-8d67c288-dd78-478d-a565-e390d50027b0-2`. DEV-PERSONA has not seen the operator's own wording, so this section is reported rather than confirmed. The ask as relayed: "every session should be able to talk directly to the architect and the steward - workers currently report they can't contact ARCHITECT directly." The candidate shape relayed with it: a fleet file names the coordinator and architect sessions, and the persona plugin opens direct lines to them.

Execution waits on the architect finalizing this document and on the operator's word to run it.

## Intent

Done means a worker reaches the architect without going through the coordinator. Both seats keep being named in one place, and nothing new is configured per worker.

Done does not need a new store, a new tool or a new label. The existing inbox, the existing `WORKER:<persona>` label and the existing settings already carry everything this needs.

## Approach

**What exists today.** Each point below was read in this repository at `origin/main` `dda8afb` on 2026-09-22.

- The inbox reach rule has three legs, in `deliveryGroundIn` at `hooks/operator.ts:636-663`, documented at 596-629. A writer reaches a target when it holds a reader claim on that target. It also reaches the target when it owns the coordinator persona. Finally, it reaches the target when the target is the coordinator persona and the writer owns a named persona other than `default`. That third leg is the worker leg, and it names the coordinator alone.
- The architect seat is already named in configuration. `.claude-plugin/plugin.json:89-94` declares an `architectPersona` user setting beside `coordinatorPersona` at 83-88. Its description says the supervisor is its only reader. `bin/supervise.sh:414-427` reads it and refuses a settings file that names one persona for both seats. So the "fleet file names both seats" in the candidate shape already exists as these two settings. This plan reads the existing setting and adds no new file.
- Routing through the coordinator is a written design today, not an accident. The coordinator's role text at `bin/supervise.sh:2924` says: "The architect answers you with a record addressed to your persona and never addresses a worker itself, so you relay its answer to the worker that escalated". This plan changes that rule, and the role text has to change with it.
- `deliveryGroundIn` takes `coordinatorPersona` as a parameter. In `hooks/index.ts`, `agentic_say` reaches it through `mayReachPersona` at 7074, and `agentic_inbox` does the same at 7116. The three delivery sites call it directly at 3826, 3927 and 7427. `fleet_status` at 7179 and `fleet_restart` at 7222 call it with the coordinator as the target. These line numbers move as other plans merge, so find the functions by name.

**The design.** DEV-PERSONA proposes it, and the architect settles it.

1. The plugin reads `architectPersona` from its options, under the same name rule and the same `default` refusal that `coordinatorPersona` takes at `hooks/index.ts:2095-2099`. It also treats a value equal to the coordinator persona as unset, as the supervisor already refuses that pair.
2. The worker leg widens from "the target is the coordinator persona" to "the target is the coordinator persona or the architect persona". Nothing else in the reach rule changes. A record to the architect is labelled `WORKER:<persona>`, the ground a worker already gets today.
3. `fleet_status` and `fleet_restart` stay gated on the coordinator persona alone. The worker leg keeps not granting fleet reads, per the refusal text at `hooks/index.ts:7184`.
4. The descriptions of `agentic_say` and `agentic_inbox`, the `coordinatorPersona` and `architectPersona` setting descriptions, and the coordinator role text in `bin/supervise.sh` say the architect is reachable directly. The role text changes only where it states the relay rule.

## Open Questions

For the architect to answer before this is `Ready`. Each carries DEV-PERSONA's recommendation.

1. **Can the architect answer a worker directly?** Today it cannot address a worker, and the widening above only lets a worker address it. There are three ways to settle it. One: the architect answers through `agentic_resolve`'s note, which the worker reads with `agentic_inbox`. That needs no new reach. Two: give the architect the coordinator's any-persona leg. That also gives it `[ARCHITECT ...]`-style standing to steer workers, which the priming text reserves for the coordinator. Three: a narrow leg where the architect reaches any persona that holds a live, undelivered or unresolved record addressed to the architect. Recommendation: the first, for this plan. It adds no authority, and the resolve note is already the sanctioned answer channel. The third is a later plan if a note turns out too small.
2. **Does "every session" include sessions that own no named persona?** A reader-tier session, or one still on `default`, cannot use the worker leg today, and this plan keeps that. Recommendation: keep it. Letting a `default` session reach a seat would let every plugin-loaded session on the machine write into that seat's inbox, which is why the rule excludes `default` today (`hooks/operator.ts:606-611`).
3. **Should the coordinator be told when a worker went to the architect directly?** The coordinator currently sees every design escalation because it relays them. Recommendation: no automatic copy. The architect can tell the coordinator when a record changes a worker's plan, and the coordinator reads each worker's store for plan state anyway.
4. **Is the steward in the ask the coordinator persona?** The ask names "the architect and the steward". This draft reads STEWARD as the coordinator persona, because that is the name the fleet's priming gives the coordinator. The worker leg already reaches it. Recommendation: confirm that the fleet's `coordinatorPersona` setting reads STEWARD. If the steward is a separate seat, it needs its own setting and this plan adds one more name.

## Sections of Work

Sketched for the architect to finalize. The tiers are DEV-PERSONA's proposal.

### 1. The worker leg reaches the architect persona
Model: opus

`hooks/index.ts` reads `architectPersona` beside `coordinatorPersona`. `deliveryGroundIn` and `mayReachPersonaIn` in `hooks/operator.ts` take the architect name, and the worker leg admits it as a target. Every caller passes it. The two tool descriptions and the two setting descriptions are updated, each description staying under the length test's bound and the injection ledger regenerated.

Acceptance (draft):
- A session that owns a named persona sends to the architect persona and the record is delivered labelled `WORKER:<persona>`. The same send with `architectPersona` unset is refused with today's reason.
- A session on `default` is refused when sending to the architect.
- `fleet_status` still refuses a `WORKER` ground.
- A settings value naming the coordinator persona as the architect leaves the architect leg closed.
- The existing reach-rule unit tests pass unedited except where they pin the leg's old text.

### 2. The coordinator's role text drops the relay rule
Model: sonnet

The sentence at `bin/supervise.sh:2924` that says the architect never addresses a worker is rewritten to match the answer to Open Question 1. The coordinator keeps routing its own design asks to the architect. `README.md` describes the widened leg where it describes the inbox reach rule.

## Out of Scope

- Any new configuration file. The two existing settings name the seats.
- Any change to who may read fleet state or restart a persona.
- Any change to delivery timing, urgency or the break-in bound.

## Assumptions

- assumed 2026-09-22 (the repository's other plans): the commit model is Branch-and-PR; reversal: one header line.

## Chapters
