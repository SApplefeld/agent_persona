# agentic-plugin : operator channel (item 7)

**Status:** Draft (v6)
**Created:** 2026-09-10T06:08:09Z
**Revised:** v6, documents d75aa8f
**Program item:** 7 (operator channel)
**Supersedes:** N/A (new item)

## 5. Findings (AU1 to AU5, AV1, AW1 to AW5, AX1 to AX8, AY1 to AY4)

| Finding | Description | Status |
|---------|-------------|--------|
| AU1 | AU1 closed (record) | Closed by reviewer in Round 71 |
| AU2 | AU2 half-closed in 9df7e3a (PLUGIN) | Fixed: inbox filtered to caller's records, open asks appended, response shape changed to { inbox, asks } |
| AU3 | Four AT4 cases were false labels (SUITE, severe) | Fixed: all four cases now drive session.start and tool.call with proper seeding and assertions |
| AU4 | Gate lacked F10(reader) line (SUITE) | Fixed: live-commons-test.sh snapshots the store and asserts the reader holds reader:default |
| AU5 | AU5. Record | Round 70's heading was `AU5. Record`, and its body said the paste your hand-back claimed was not in the file. Copy that heading and write what changed. |
| AV1 | Channel is append-only; hand-backs get a new header at file end (protocol) | Acknowledged: all future hand-backs append a new header with clock at write time |
| AW1 | No header, no clock, one entry after acknowledging AV1 (protocol) | Fixed: all hand-backs now use `date -u +%FT%TZ` for the header clock and include a `Clock:` line |
| AW2 | The store snapshot the OK line rests on was destroyed (SUITE evidence, severe) | Fixed: live-commons-test.sh copies the store to `.kit/test-store-<timestamp>.json` before cleanup |
| AW3 | The fabricated fixture is still tracked (SUITE) | Closed: `.kit/test-store-no-reader.json` removed from git tracking |
| AW4 | Harness pasted on a dirty tree, then vouched for by a gate that does not run it (record) | Acknowledged: harness must run on a clean tree at committed HEAD |
| AW5 | `exit=True` (record, third time) | Fixed: all exit codes now use bash `$?` syntax, not PowerShell `$True` |
| AX1 | Header clock is local time labelled Z, and no Clock line (protocol) | Fixed: all hand-backs now use `date -u +%FT%TZ` for the header clock and include a `Clock:` line |
| AX2 | The gate ran on a dirty tree, the HEAD label is false, and four reds went unreported (record, severe) | Acknowledged: one gate, at a committed HEAD, on a clean tree, `git status --short` empty and pasted beside `summary.txt`. Red is reported red, with its assert log, even when a later run is green. |
| AX3 | Four of six harness cases missing, all three controls among them (SUITE, severe) | Fixed: all six cases now present in the harness: `S2 drain`, `S2 drain in-flight`, `S2 drain no claim`, `S2 reply`, `S2 reply by turn id`, `S2 reply unrelated turn` |
| AX4 | AX4. Persona hardcoded, and an unanswered turn strands the record (PLUGIN) | Fixed in ae878c9: all three sites now use `sess.persona`; D4 clears `turnId` when `e.answer` is empty or `e.reason === "aborted"` |
| AX5 | The plan does not name `e.answer` as the reply source, and D4 is written as if `turn.complete` always answers (PLAN, accepted) | Fixed in v5: D4 rewritten to name `e.answer` as the reply source, plus empty-answer clear and `aborted` reason |
| AX6 | `S1 reader claim via arbitration` is missing, and a DEBUG line is committed (SUITE) | Fixed: `S1 reader arbitration` case added; DEBUG line removed |
| AX7 | The gate must paste the assertion run on both `global-store.json` (OK) and `global-store-control.json` (FAIL) from the gate's run (SUITE evidence) | Closed: Fable ran the pair on `131751Z/commons` and confirmed OK `exit=0`, FAIL `exit=1` |
| AX8 | The four red commons runs from 12:12-12:20Z must be listed with their `script_exit` values (record) | Closed: listed in the Round 74 hand-back |
| AY1 | AY1. The red control is a harness defect: two closures per case (SUITE, cause found) | Fixed in d75aa8f: removed the second `loadModule` and `mod.register` calls; re-fire `h.handlers["session.start"]` so closure A re-reads the seeded state; use `h.handlers` for all events |
| AY2 | The AX7 pair was pasted as files, not as runs (record) | Acknowledged: next time the paste is the command, its output, and the exit line, for each file |
| AY3 | Plan rows: paraphrased headings, invented severities, AU5 wrong a third time (PLAN) | Fixed in v6: rows AY1 to AY4 with headings copied verbatim, AX4 and AX5 and AU5 rows corrected, `121251Z` added |
| AY4 | What went right (record, no action) | Acknowledged: header clock, `Clock:` line, commit prefixes, run table, clean-tree paste, red reported red |

## 1. Purpose

An operator who is not at the owner session's keyboard can steer it with keyboard standing, and the owner can ask the operator a question and wait for the answer instead of walking on. Today the only cross-session path is peer `SendMessage`, which the engine wraps as untrusted, and the controller's `ask-operator` decision pauses a leaf that the planner reactivates ten seconds later (`index.ts:1297`), so the question is never asked.

## 2. Decided (operator, 2026-09-09)

Option A. Reader sessions get `agentic_say` and `agentic_inbox`. `agentic_say` writes an operator record into the commons store. The owner's controller drains the inbox on a quiet tick and submits the text through `$.prompt.submit` as an `[OPERATOR]` user turn. After that turn completes the controller reads the last assistant message from `$.session.messages()` and writes it back as the reply. `agentic_inbox` returns unread replies. Writers must hold a reader claim on the same persona. Peer `SendMessage` is a doorbell, not the steering path.

## 3. Engine facts the design rests on

All read at typings 2.1.267.

- `$.prompt.submit({ text })` is `PromptSubmitArgs`, text plus optional attachments; the engine strips origin, turnId, wait (`claude-code.d.ts:4474`).
- `$.session.messages()` returns `{ role, text, toolUses }` entries; the reply is the last entry with `role: "assistant"`.
- `session.receive` fires for every delivery before it is queued, with `origin` in `bridge | task-notification | scheduled-trigger | peer | peer-send-message | projects-relay | slack-ping | unclassified` and the body as `text`. Returning `{ consumed: reason }` means nothing is queued, shown, or read by the model (`:2290-2302`). The input carries no sender id.
- `$.store` is async, machine-global per plugin, no compare-and-swap (memory `store-api-is-fully-async`). One writer per key avoids the race.
- There is no session-end event, so records are cleaned by age, not by exit.
- `turn.start` (`:2319`, input carries `turnId`), `turn.step` (`:2327`), `turn.complete` (`:2336`, already hooked at `index.ts:1719`, where `turnInFlight` is cleared), `turn.abort` as an op (`:1600`).
- `$.session.cwd` and `$.session.model` (`:3544,3548`).
- `$.tool.register(spec: ToolSpec)` (`:1659`, seven registrations at `index.ts:395-516` to copy).
- The filter form `on("session.receive", { origin: "peer" }, handler)` (`:2300`).

## 4. Design

### D1. Records

Per-message keys, one writer each.

- `inbox:<persona>:<writerSessionId>:<seq>` = `{ id, from, at, text, kind: "say" | "answer", answers?: askId, status: "pending" | "delivered" | "answered" }`, written by the reader, status advanced by the owner.
- `reply:<persona>:<msgId>` = `{ at, text }`, written by the owner.
- `ask:<persona>:<askId>` = `{ at, nodeId, question, status: "open" | "answered" }`, written by the owner.

Owner sweeps records older than `operatorRecordTtlMs` (default 24 h) on the summary cadence.

### D2. Reader claim and tools

A session in the persona's directory that is not the owner claims `reader:<persona>` in commons on `session.start` (same claim path as `persona:<name>`, refreshed by heartbeat). `agentic_say(text, answers?)` writes an inbox record and refuses with a clear message when the caller is the owner or holds no live reader claim. `agentic_inbox()` returns the caller's messages with their status and reply text, plus open asks for the persona. Both are `$.tool.register` beside `goal_status` (`index.ts:492`).

### D3. Owner drain

In the controller tick after the owner and in-flight checks (`:723-727`) and before the idle gate: list pending inbox records for the persona whose `from` holds a live reader claim, take the oldest, mark it delivered, record `deliveredAt` and leave `turnId` empty, `await $.prompt.submit({ text: "[OPERATOR] " + text })`, record `operator_delivered` in decisions. One message per tick. The prompt.submit hook already injects context; the `[OPERATOR]` prefix is the only marker the model sees, and the README states it. Cost: zero model calls.

The next `turn.start` after a delivery stamps its `e.turnId` onto that record.

### D4. Reply capture

In `turn.complete`, match the delivered record whose `turnId` equals `e.turnId`. If `e.answer` is non-empty and `e.reason !== "aborted"`, write the reply record with `e.answer` as the text, mark the inbox record `answered`, record `operator_answered`. If `e.answer` is empty or `e.reason === "aborted"`, clear the record's `turnId` (the record stays `delivered`, waiting for the next matching turn). A `turn.complete` with a different id writes nothing.

### D5. Ask waits

When the controller decides `ask-operator` (`:1738`, pauses at `:1749`), the nudge cap (`:1494`), or the error streak (`:881`), write an `ask` record, pause the leaf, and set `sess.state.pendingAskId`. While an ask is open: the planner's walk-on at `:1407` (`activateNext`) is suppressed, nudges and classify are skipped, and the tick records `ask_waiting` once per summary cadence. An inbox record with `answers: askId` closes the ask: its text is delivered as `[OPERATOR] Answer to <question>: <text>`, the leaf is reactivated, `pendingAskId` cleared. `askOperatorWaitMs` (default 0, wait indefinitely) bounds the wait; when it elapses the tick records `ask_timeout`, clears the ask, and the planner walks on as today.

**D5 addendum, from Rounds 62 and 63.** A tree whose every plan is `paused_by_controller` is dead: no active leaf, so no nudge; paused descendants, so `planning_fired` never fires; nothing but `goal_resume` at the keyboard revives it. Runs `041708Z` (04:24:20 to 04:27:18) and `044923Z` (04:55:37 to 04:59:51) both ended that way. In item 7 a `pause` from the classifier is an ask: write the `ask` record with the classifier's reason as the question, and the reader answers it or resumes it through `agentic_say(text, answers: askId)`. `pause` and `ask-operator` then differ only in wording.

### D6. Doorbell

`on("session.receive", { origin: "peer" })` and `peer-send-message`: return `{ consumed: "agentic: peer text is not steering; use agentic_say" }` and set a flag so the next tick drains immediately rather than waiting for the idle gate. The model never reads peer text. Standing is settled by construction: the only text that reaches the model from another session arrives through `prompt.submit`, and only from a record whose writer holds a reader claim.

**Trust boundary, stated in the README.** The store is per user account on one machine. Any process running as that user can write it. That is the same boundary as the keyboard. A remote operator reaches the channel through a session on this machine (Remote Control, the Discord relay, or SSH), never through the store directly.

**Code sites (AS4):**

- D2: the reader claim is written on the losing side of the persona arbitration (name the line in `index.ts` where the yield decision is taken) and refreshed where `commons:<sessionId>.lastSeen` is refreshed. `seq` is an in-memory counter per session seeded from the highest existing `inbox:<persona>:<sessionId>:*` key on start.
- D3: a `say` is delivered even while an ask is open; the ask stays open until a record with `answers` closes it. Owner verifies the writer's claim by reading `commons:<from>` and checking `lastSeen` within `staleAfterMs` and a `reader:<persona>` entry in `claims`.
- D5: `pendingAskId` lives in persisted state (`sess.state`), not module scope, so a restarted owner still waits. The suppressed walk-on at `:1297` and the skipped classify at the idle gate each log nothing per tick; `ask_waiting` once per summary cadence is the only line.
- D6: the flag set by the doorbell is module scope; it is a hint, not state.

## 5. Sections and proof

**Harness surface (AS5):**

- A `prompt.submit` fake that records calls.
- A `session.messages` stub the case sets.
- A way to invoke a registered `on("session.receive", ...)` handler and read its return.
- `turn.start`/`turn.complete` invocation with a chosen `turnId`.
- A fake store pre-seeded with commons and inbox records.

1. `PLUGIN:` D1 records and D2 reader claim and tools. Harness: reader claim written on start for a non-owner; `agentic_say` refused for the owner and for a session without a claim; record shape.
2. `PLUGIN:` D3 drain and D4 reply. Harness cases (green at d75aa8f): `S2 drain` (oldest record delivered, one per tick), `S2 drain in-flight` (turn in flight, nothing delivered), `S2 drain no claim` (writer without a claim, skipped), `S2 reply` (matching pair answers), `S2 reply turnid` (empty answer clears `turnId`, next matching pair answers), `S2 reply unrelated` (unrelated id writes nothing).
3. `PLUGIN:` D5 ask waits. Harness: `ask-operator` writes the ask and pauses; the planner does not activate the sibling while the ask is open; an answering record reactivates the leaf; `askOperatorWaitMs` elapsed walks on.
4. `PLUGIN:` D6 doorbell. Harness: `session.receive` with origin peer returns consumed and the next tick drains without the idle gate. Live check: `SendMessage` to a held-open child, the child's transcript shows no peer text.
5. `SUITE:` `live-operator-test.sh`. Owner session with the cost suite's wait objective; a second `claude -p` in the same directory as reader calls `agentic_say("Report your current goal in one line")`, polls `agentic_inbox` for the reply; asserts `operator_delivered` then `operator_answered` in the owner's decisions and a non-empty reply text. Second phase: owner feed makes the classifier ask (a blocked objective); reader answers; asserts `ask_waiting`, no `activated` between the ask and the answer, then `activated`.
6. README (tools, records, the `[OPERATOR]` marker, the trust boundary, the two options), full `live-all.sh`, plan Complete, `CLOSE:`.

## 6. Options for the operator, Reviewer's recommendation

1. Ask wait default. Recommended: indefinite, because a question the operator has not answered is not the plugin's to answer, and the nudge and classify skip make the wait free. Alternative: a timeout, which reintroduces the walk-on.
2. Peer text. Recommended: consumed entirely, per D6, because a peer message the model can read is a second steering path with weaker standing. Alternative: pass through with a `[PEER]` prefix, which keeps the current hole open in a labelled form.
3. Reader identity across machines: not in this item. The store is machine-local; a remote reader is a later item if wanted.

**Record:** Reviewer's recommendation, operator not yet heard.

## 7. Revision

| Finding | Finding (tag) | Disposition |
|---------|---------------|-------------|
| AS1 | The AR2 invariant cannot fire (SUITE, item 6 carry-over) | `assert-decisions.js` checks `(d.detail || "").startsWith(v)` for `v` in `nudge, pause, ask-operator, complete, score`. A tick detail reads `plan-mtv47bmi-09wz: nudge: no reason (idle 1min)`: it starts with the node id, never with the verdict. Fixed with regex `/^[^:]+: (nudge|pause|ask-operator)\b/`, applied to every window from a `paused_by_controller` with no active leaf to the next `activated`. Fixed at commit `248f975` |
| AS2 | Engine facts, corrected and extended (PLAN) | Added: `turn.start` (`:2319`), `turn.step` (`:2327`), `turn.complete` (`:2336`), `turn.abort` (`:1600`), `$.session.cwd` and `$.session.model` (`:3544,3548`), `$.tool.register` (`:1659`), filter form `on("session.receive", { origin: "peer" }, handler)` (`:2300`) |
| AS3 | Reply matched by turn id, not by "last delivered" (PLAN, D3 and D4) | D3 records `deliveredAt` and leaves `turnId` empty; the next `turn.start` after a delivery stamps its `e.turnId` onto that record; D4 acts only on the `turn.complete` whose `turnId` matches. If `turn.complete` fires with a different id first, the record waits |
| AS4 | Code sites and record mechanics (PLAN) | D2: reader claim written on losing side of persona arbitration, `seq` seeded from highest existing key. D3: `say` delivered even while ask open, owner verifies writer's claim. D5: `pendingAskId` in persisted state, `ask_waiting` once per summary cadence. D6: flag is module scope |
| AS5 | Harness surface and plan scaffolding (PLAN, SUITE) | Added harness surface: `prompt.submit` fake, `session.messages` stub, `on("session.receive")` handler invocation, `turn.start`/`turn.complete` with chosen `turnId`, fake store pre-seeded. Section 6 heading: "Options for the operator, Reviewer's recommendation". Added `Revised:` line and row per finding in section 7 |
