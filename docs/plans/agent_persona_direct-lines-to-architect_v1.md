# Direct lines to the architect

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-22

This is a plan shell. The DEV-PERSONA worker, which owns the agent_persona clone, drafted it because the architect holds no clone of this repository. The architect reviewed the first draft on 2026-09-22, and this revision carries that review, the fresh-context plan review that followed it, and the architect's own second read.

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
- The architect answering only through `agentic_resolve`'s note. Refused outright, because the note is capped at 2,000 characters (`FREE_TEXT_MAX` in `hooks/index.ts`, a bound the cut lane shares), and a plan review or a consult routinely runs past that. It is not a fallback either: a section that cannot build the answer leg returns to the architect rather than shipping the note as the answer.

Rulings:
- 2026-09-22, the architect, answering the first draft's open questions. The architect answers a worker over a narrow leg. Sessions that own no named persona get no line. The coordinator gets no automatic copy of direct traffic. The steward in the ask is the coordinator persona, which this fleet names STEWARD.
- 2026-09-22, the architect: the coordinator keeps sight of every ask that becomes work, with no copy needed. A plan reaches a worker's queue only through the coordinator, a rule the architect's charter already states.
- 2026-09-22, the architect, on the plan review: there is no resolve-note fallback for the answer leg. The worker's steer sentences and the nudge line exist only where an architect is named, as the coordinator's design clause does today. The coordinator's two relay legs stay.

Provenance: drafted by DEV-PERSONA on 2026-09-22 from the coordinator's relay of the ask and from the code at `origin/main` `dda8afb`. Revised the same day on the architect's review, which reached DEV-PERSONA through the coordinator, and again by the architect on a fresh-context plan review (one Critical, five Majors, three Minors, all applied).

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
- A worker already reads a `[WORKER:<persona> ...]` prompt as carrying no delegated authority (`bin/supervise.sh:2822`). An answer labelled `WORKER:<architect persona>` therefore grants the architect no standing to steer. That same sentence tells the worker to treat such a prompt as information it cannot verify and to take any act it asks for to the operator first, so a worker reading the architect's answer under it alone would escalate the answer instead of using it.
- `COORDINATOR_STEER_INSTRUCTION` is built unconditionally (`bin/supervise.sh:2819-2822`), while the coordinator's own design clause is appended only where `ARCHITECT_PERSONA` is non-empty (`bin/supervise.sh:2923`). `architectPersona` has no default. The injection ledger (`.kit/injection-ledger.mjs`) counts each instruction variable's assignments and fails when the count moves (`docs/architecture.md`, the paragraph opening "The ledger fails closed").
- The charter sentences are pinned by `.kit/channel-reply-instruction-test.sh` (`DESIGN_ARCHITECT_RELAY_CONTROL`, `DESIGN_ARCHITECT_OPERATOR_RELAY_CONTROL`, `ARCH_OTHER_PATH_CONTROL`), not by `.kit/supervisor-natural-exit-test.sh`, which pins no charter sentence.
- The comment above `ARCHITECT_ROLE_INSTRUCTION` (`bin/supervise.sh:2980-2981`) says the supervisor is `architectPersona`'s only reader and the plugin never reads the key, which Section 1 makes false.
- `README.md:58`, describing the steward's duties, ends "so the architect never addresses a worker directly", apart from the inbox passage at `README.md:585-591`.

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

There is no fallback inside this section. If reading the record store inside the reach rule proves too invasive, the section stops on a `BLOCKED:` and the plan returns to the architect, because an answer through `agentic_resolve`'s note would contradict the Goal, Section 2(b) and the Intent's refused list, and that note's cap is `FREE_TEXT_MAX`, which the cut lane shares. The comment above `ARCHITECT_ROLE_INSTRUCTION` in `bin/supervise.sh` no longer says the supervisor is the setting's only reader.

Acceptance (draft):
- A session that owns a named persona sends to the architect persona, and the record is delivered labelled `WORKER:<persona>`. The same send with `architectPersona` unset is refused with today's reason.
- That session reads its own records at the architect with `agentic_inbox` and the persona argument set to the architect.
- A session on `default` is refused when sending to the architect.
- The architect's owner sends to a worker whose record to the architect has status `delivered` or `answered`, and the record reaches the worker labelled `WORKER:<architect persona>`. The same send after the architect resolves that record is refused. So is a send to a persona that holds no such record.
- `fleet_status` and `fleet_restart` still refuse a `WORKER` ground.
- An `architectPersona` value equal to the coordinator persona leaves both architect legs closed.
- The existing reach-rule tests pass, edited only where they pin the worker leg's old text.

Files in scope: `hooks/operator.ts`, `hooks/index.ts` (the options read, the reach-rule callers, the `agentic_say` and `agentic_inbox` registrations), `bin/supervise.sh` (the `architectPersona` reader comment above the architect charter), `.claude-plugin/plugin.json`, `.kit/controller-tick-test.mjs`, the reach-rule unit tests under `.kit/`, `.kit/injection-ledger.json`, `docs/architecture.md`, `README.md` (the `agentic_say`, `agentic_inbox` and Trust boundary passages that state the reach rule).

### 2. Three charters and the nudge name the line
Model: opus

The architect's charter at `bin/supervise.sh:2987` changes in three places.
- (a) A prompt labelled `[WORKER:<persona> id=<record id>]` carrying a design ask is the architect's own work item, worked as a coordinator record is.
- (b) The architect answers such a record with `agentic_say` to that worker, before closing it with `agentic_resolve`. It still answers the coordinator's records to the coordinator.
- (c) The clone rule stands as written. A repository named in a worker's record is reported and not cloned. A plan the architect writes for a worker still reaches the worker's queue only through the coordinator.

The coordinator's charter at `bin/supervise.sh:2924` loses only the clause saying the architect never addresses a worker itself. The sentence's two relay legs stay: the coordinator keeps relaying the architect's answer to the operator where the ask was the operator's own, and to a worker whose ask it forwarded itself. It keeps routing its own design asks, and the operator's, to the architect.

The worker's steer text at `bin/supervise.sh:2822` gains two sentences, appended only where `ARCHITECT_PERSONA` is non-empty, as the coordinator's design clause is at `bin/supervise.sh:2923`. The first names the architect persona as the seat for a design question the worker's plan does not cover: a spec gap, an approach fork, a plan review or a consult. Such a question goes by `agentic_say` with the persona argument set to the architect. Everything else keeps the coordinator ask shape. The second says that a `[WORKER:<architect persona>]` prompt answering a question this session sent is that question's answer, verifiable by the record id it carries, so the existing no-delegated-authority sentence does not send the worker to the operator with the architect's answer. The idle nudge at `hooks/index.ts:5152` names the same line beside its `ASK:` instruction, only where the plugin holds an architect name. The gated append is a second assignment of `COORDINATOR_STEER_INSTRUCTION`, so `.kit/injection-ledger.mjs`'s assignment-count rule for that variable is updated to the new count, and the ledger is refreshed.

`README.md` describes the widened reach rule where it describes the inbox (`README.md:585-591`), and names both architect legs. Its steward paragraph (`README.md:58`) no longer says the architect never addresses a worker directly.

Acceptance (draft):
- The three charters agree with each other and with Section 1's code. No charter, and no `README.md` paragraph describing a seat, still says the architect never addresses a worker, and none says a worker's record is information only. The coordinator's two relay legs are still stated.
- On a launch with no `ARCHITECT_PERSONA`, the steer text and the nudge carry no architect sentence.
- `.kit/channel-reply-instruction-test.sh`'s charter pins pass, edited only where they pin the sentences this section changes (`ARCH_OTHER_PATH_CONTROL`, and the relay controls only if their wording moves).
- The Chapter records each changed ledger entry's character delta against the committed baseline in `.kit/injection-ledger.json`. The refreshed ledger is the record of that growth, not the gate, since the size test compares live text to whatever baseline is committed.

Files in scope: `bin/supervise.sh` (the three charters), `hooks/index.ts` (the nudge text), `.kit/channel-reply-instruction-test.sh`, `.kit/controller-tick-test.mjs` where it pins the nudge, `.kit/injection-ledger.mjs` (the assignment count), `.kit/injection-ledger.json`, `README.md`, `docs/architecture.md`.

## Out of Scope

- Any new configuration file. The two existing settings name the seats.
- Lines between every pair of sessions. The Intent defers them to their own plan.
- Any change to who may read fleet state or restart a persona.
- Any change to the architect's clone rule.
- Any change to delivery timing, urgency or the break-in bound.

## Assumptions

- assumed 2026-09-22 (the repository's other plans): the commit model is Branch-and-PR; reversal: one header line.
- assumed 2026-09-22 (the architect's ruling): a record that is `answered` but not `resolved` still opens the answer leg, because an answered record is one the architect replied to in a turn and has not yet closed; reversal: one status in the leg's test.
- assumed 2026-09-22 (the architect): the answer leg matches the record's writer session against the target persona's current owner session. A worker restarted between its ask and the answer holds a new session id, so the leg is closed for it, and the architect answers that record the way it answers today, through the coordinator, then resolves it. Reversal: match on the persona the writer owned at the write, which the record does not carry today.
- assumed 2026-09-22 (the brainstorming skill): the blind read and gating litmus were not run on this plan, since a worker drafted it and the architect read it twice. The plan review ran at fable and effort high and its findings are applied.

## Chapters

### Chapter 1 - 2026-09-22
Completed: 1. The worker leg reaches the architect, and the architect answers back
Implemented By: implementer-opus for the build and fix round 1; the README and docs/architecture.md edits and the close pass inline in the main session; no tier escalation
Metrics: review rounds 2, closed major-closed; provenance 3 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 1 declared, 0 asked); advisory: 1 findings, 1 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section open (2026-09-22): Section 1 makes the plugin read architectPersona, widens the worker leg of the inbox reach rule to admit the architect persona as a target, and adds the answer leg: the architect's owner reaches a worker whose owner session wrote it a record still delivered or answered, and at delivery also one resolved at or after the answer's write. Serves the Goal sentences "Any session that owns a named persona can send a record to the architect persona with agentic_say ... read its own records there with agentic_inbox" and "It answers the worker with agentic_say, over a narrow line", with design points 1 to 4. Adds mechanism: yes, the answer leg and the architect read, both named by the section. Size: about 60 to 100 lines across hooks/operator.ts and hooks/index.ts, two descriptions, two settings descriptions, one comment, and eight or more harness cases. Cost of not building: every design question and every answer keeps going through the coordinator's relay.
- r1 fix, adversarial Major + blind Major 2 (a sent architect answer is skipped at delivery once the worker's record leaves the architect's inbox or the worker's session changes) (2026-09-22): the send gate stamps an answer admitted on the answer leg with the id of the worker's record that opened it, and delivery honours that stamp while the writer still owns the architect persona, in place of re-reading the architect's inbox at delivery; the declared resolved-at-or-after-the-answer clause goes with the re-read. Serves Section 1's acceptance bullet "The architect's owner sends to a worker whose record to the architect has status delivered or answered, and the record reaches the worker labelled WORKER:<architect persona>". Adds mechanism: yes, a stored field on the answer record and a delivery branch that reads it. Size: one optional field, about 15 lines across hooks/operator.ts and hooks/index.ts, the delivery-time architectLineRecords calls removed, and three or four harness cases. Cost of not building: an answer the send gate admitted is marked skipped when the channel window or the 24-hour sweep rolls the worker's record out, or when the worker relaunches before its next quiet tick, and neither seat sees it.
- The header read `Status: Ready` at the start of this run and now reads `Status: In Progress`.
- Design stop: the fix for round 1's delivery-time Major adds a stamp on the answer record. The scope adjudicator ruled it accept-and-declare under Section 1's fourth acceptance bullet, whose form is a gate judged at send with an admitted send delivered labelled. The declared bound: one optional field, `answersRecord`, written only by the send gate on the answer leg and read only at the delivery sites; no read of the architect's inbox at delivery; the writer-still-owns-the-architect check kept at delivery; no change to delivery timing, urgency, the break-in bound, the channel window or the TTL sweep.
- The resolved-at-or-after-the-answer clause declared at the section's start was replaced by that stamp, so it no longer runs.
- An architect owner holding a reader claim now answers labelled `WORKER:<architect>` unless it reads the target, where `READER:<target>` stands and the answer is still stamped.
- Scope fold: `README.md` joined the section's Files in scope. The security lens found its Trust boundary passage and the `agentic_say` and `agentic_inbox` refusal lists stating three reach grounds after the code had four, and a security document stating what the code does not do is fixed rather than deferred. That edit also delivers Section 2's README bullet on the inbox passage, which Section 2 now verifies rather than writes. `README.md:58`, the steward paragraph, stays Section 2's.
- Section 2 inputs from this section's reviews: the delivered bracket carries the answer's own id, not the question's, so the architect's charter should have the answer quote the id of the worker's record it answers, and the worker's steer sentence should name that id and the `agentic_inbox` status check rather than the bracket id alone.
Assumptions:
- assumed 2026-09-22 (the executing-work intake gap check): `direct-lines-build` is cut from `goal-tree-curation-build` at c81b60e rather than from origin/main, because PR #71 edits the same `hooks/index.ts` regions and waits only on review with auto-merge armed; reversal: rebase onto origin/main once #71 merges (section 1).
Review Findings: design stop: a send-time stamp on the architect's answer, ruling accept-and-declare by the scope adjudicator. review: adversarial + blind + security + performance at fable, Agent tool, round 1; review: adversarial at opus, Workflow, effort high, round 2. Round 1 had three Majors from correctness lenses. The adversarial Major and the blind lens's second Major were one cause: delivery re-judged the answer against the architect's inbox, so a record rolled out by the channel window or the 24-hour sweep, or a worker relaunched before its next quiet tick, dropped an answer the send had admitted. It was fixed in fix round 1 within the ruled form, 11 checks seen red against 4a7376e. The blind lens's first Major, the three charters still forbidding the new lines, was traced by the orchestrator to Section 2's first acceptance bullet and is justified-not-fixed here, since Section 2 rewrites those charters. Advisory: the security Major on README's three-ground passages was fixed (honesty route); performance CLEAR. Round 2's Major, that a worker has nothing to match an answer to its question with, is justified-not-fixed here and carried to Section 2 as a charter and steer wording input above. Minors: 5 fixed (the reader-leg answer now stamped, probed red then green with the restore compared by cmp; `mayReachPersonaIn` removed with no caller left and its README mention; the skip detail naming a missing stamp; README and the `agentic_inbox` shape naming the stamp; the label order, upgraded from Minor on its Section 2 consequence and fixed in fix round 1), 1 upgraded, 3 left with the reason (two store.keys() scans on an architect send, bounded in-memory; the per-record inbox reads, moot once delivery stopped reading the inbox; the channel-window and sweep Minors, closed by the stamp). The close pass owes no round: no outward action, no new module, and its one behavior change is exercised directly by a check probed red.
Stamps: adjudicated 3, stamped 0, over a 3h window covering the section. All three were read by reviewer subagents rather than by this session, and none shaped a choice here.
Gate: targeted lane, SCOTT-CLAUDE, 2026-09-22T21:42Z, the worktree at aee165e plus the uncommitted close pass in hooks/operator.ts, hooks/index.ts, README.md, docs/architecture.md, .kit/controller-tick-test.mjs and .kit/injection-ledger.json. Lanes, each exit code read from its own run: npx tsc --noEmit 0; node .kit/controller-tick-test.mjs 0 at 2533 OK and 0 FAIL; node .kit/check-loader-rule.mjs 0; node .kit/injection-duplicate-test.mjs 0; node .kit/tool-description-length-test.mjs 0; node .kit/fleet-status-unit-test.mjs 0 at 201 OK; node .kit/self-review-unit-test.mjs 0; bash .kit/channel-reply-instruction-test.sh 0 at fix round 1. Delta against the 2489 baseline on the tick lane at c81b60e: +44 at 0 FAIL, all direct-lines checks. Tests added: five caseDirectLines_* cases in .kit/controller-tick-test.mjs, pinning the worker leg to the architect set and unset, the worker's inbox read at the architect, the `default` refusal, the send gate's answer leg open, answered, resolved, unasked and stale-writer, the send-time stamp including a reader claim on the target, delivery of a stamped answer with the architect's inbox emptied, across an owner change and under a reader claim elsewhere, the skip of an unstamped, forged or ownerless answer, the urgent and ask-answer sites, and an unusable architect setting reading as none; one fleet_status case and an architect caller in the fleet_restart refusal list in .kit/fleet-status-unit-test.mjs, pinning that a WORKER ground stays refused there. None spawns a process. Tests retired: none. Tests edited: `seedNamedOwnerHarness` gained an optional options argument. Wall clock about 65 s for the tick lane, against about 65 s at baseline. No foreign runner was up at the section's polls.
Next: 2. Three charters and the nudge name the line
Commit Model: Branch-and-PR
