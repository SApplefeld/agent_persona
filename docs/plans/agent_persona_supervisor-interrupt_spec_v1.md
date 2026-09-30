# Supervisor Interrupt for a Stuck Persona Turn

**Status:** In Progress
**Repository:** agent_persona (`D:\agent_persona`)
**Commit Model:** Branch-and-PR
**Author:** ASSISTANT, 2026-09-30

## Goal

Let the fleet end a persona's running turn without killing its process, so the persona keeps its conversation. A stuck turn ends in about a second instead of a restart that loses the session's memory. The same act clears the way for an urgent message, which then arrives as the persona's next prompt.

## Intent

A persona can sit inside one turn for hours with nothing able to reach it. On 2026-09-30 the ARCHITECT child waited out a Fable rate limit from 07:16 to 09:08 Eastern. The account had been swapped and had room, but the child was counting down to a retry at 13:16. The operator's channel message queued behind the turn, unread. The only remedy was a restart, which cost the session its whole conversation.

In `claude -p --input-format stream-json` mode there is no keyboard, so there is no Escape key to press. The harness takes the equivalent as a control message on stdin:

```json
{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}
```

The persona's stdin is the pipe `bin/supervise-holder.sh` writes. Today the holder forwards only one message shape, a `[SUPERVISOR-ASK id=...]` user turn, validated at `supervise-holder.sh:101-124`. So nothing can send the interrupt. This plan adds that one path.

## What Is Known

- **Confirmed:** the interrupt ends a running turn and keeps the conversation. A throwaway Opus child on `claude -p` stream-json was 6 seconds into a long essay when it got the message above. It answered `control_response` success with `still_queued: []`, and emitted a `result` of subtype `error_during_execution` in the same second. The next user prompt asked for a codeword from the first message, and the child answered it correctly.
- **Confirmed:** the supervisor reads a request file per persona already. `fleet_restart` writes `<rundir>/restart.request` as `{at, by, reason}`, and `bin/supervise-restart-request.mjs` reads it, treating a request older than the child's start as served.
- **Inferred, not confirmed:** the interrupt also cancels the harness's rate-limit retry wait, the exact state ARCHITECT was stuck in. The retry loop logged `retryInMs` countdowns under `source: request_retry`. Section 3 owns proving this.
- **Inferred:** the `still_queued` field means queued user messages survive the interrupt and run next. That is what makes the urgent-message case work with no new delivery mechanism.

## Section 1: Holder Relays an Interrupt

**Model:** sonnet

The holder watches a second request file, `<child dir>/interrupt.request`, beside `ask.request`. On finding one, it writes the fixed control line to the child's stdin and removes the file.

- The holder builds the control line itself. It never relays the file's content, so a malformed or hostile file can send nothing but an interrupt.
- The file holds one JSON object, `{id, at, by, reason}`. The `id` becomes the `request_id`, after validation to a short token of letters, digits and hyphens. An invalid file is logged and removed unrelayed, as `ask.request` is today.
- The holder logs each relay with the id and reason.

**Acceptance:** a holder unit test shows a valid file yields exactly one control line with the right id. It also shows a malformed file, an oversized id, and a file with extra keys each yield nothing, with the file removed in every case.

## Section 2: Tool and Supervisor Route the Request

**Model:** sonnet

A new coordinator-only tool, `fleet_interrupt(persona, reason)`, writes `<rundir>/interrupt.request` as `{at, by, reason}`. It clones `fleet_restart`'s gates: coordinator persona only, roster entry enabled, not its own persona, run directory present.

The supervisor reads the file on its poll. Where the request is newer than both the child's start and the last interrupt it served, it writes `<child dir>/interrupt.request` whole by rename, so the holder never reads it half-written. It records the served time so one request sends one interrupt, never one per poll. It logs `INTERRUPT: <reason>` in `supervisor.log`.

A request that lands between children, or while no turn runs, is served as a no-op interrupt. The harness answers it harmlessly, so there's no need to detect an idle child first.

**Acceptance:** a supervisor test drives a request through a fake child and shows one relay across several polls. A second request with a later time relays again. A request older than the child's start relays nothing.

## Section 3: Live Proof on the Real Stuck State

**Model:** opus

Prove the interrupt ends a turn parked in the rate-limit retry wait, not only a turn that is generating.

- Point a throwaway child at a local stub endpoint that answers every request with a 429 carrying a long reset. `ANTHROPIC_BASE_URL` with a dummy API key is the likely route. Confirm the child logs a `request_retry` countdown, then send `fleet_interrupt` through the real supervisor and holder.
- Pass: the turn's `result` lands within 5 seconds of the relay. A follow-up prompt then shows the conversation is intact.
- Where the stub route cannot put the harness into its retry wait, say so in the Chapter and call the rate-limit case unproven. Don't substitute the generating-turn result for it.

## Urgent Messages

No new mechanism. To break in with something critical, the coordinator calls `fleet_interrupt`, then sends the message with `agentic_say` as usual. The interrupt ends the turn, and the waiting record is delivered as the next prompt. The coordinator skill gains one paragraph saying so, and when to reach for it: a turn that has shown no tool call or output past its class's growth window.

## Out of Scope

- **Automatic interrupts by the supervisor.** One example would be firing when a rate limit clears early. The operator ruled this out for v1, per Decisions below.
- **Any change to `agentic_say urgent`.** Urgent still lands only on a tool result, and the documentation above covers the stuck case.
- **Interrupts from the operator's Discord channel directly.** The operator asks the coordinator, which calls the tool.

## Decisions

- **No automatic interrupts in v1** (decided 2026-09-30 by the operator). The supervisor never sends an interrupt on its own. Automatic triggers may come later, once a use case is found. The manual tool covers the rate-limit case that prompted this plan.
- **The rate-limit case is the operator's strong expectation, not yet a fact.** Pressing Escape in an interactive session is known to break the harness's rate-limit wait. The operator strongly suspects the stream-json interrupt does the same. Section 3 settles it.

## Chapters

### Interim board 1 - 2026-09-30

Run started by DEV-PERSONA on branch `plan/supervisor-interrupt`, worktree `D:/agent_persona-supervisor-interrupt`, base `5fc62b9`. Status header changed from "Approved by the operator 2026-09-30, routed to the plugin worker through the Steward" to "In Progress" on starting.

Sections run in order 1, 2, 3, since sections 1 and 2 both touch `bin/supervise.sh` and `bin/supervise-holder.sh`.

Intake gap check, each answer declared (route b) or cited (route a), dated 2026-09-30:

- Section 1: the holder takes the interrupt file's path as a new sixth positional argument, read as `${6:-}`, so a five-argument launch watches nothing. `bin/supervise.sh`'s launch line passes `$CHILD_DIR/interrupt.request` and the launch-time `rm -f` clears it and its `.tmp`.
- Section 1: a valid file parses whole as one JSON object whose keys are exactly `id`, `at`, `by` and `reason`. `id` matches `^[A-Za-z0-9-]{1,64}$`, `at` is a finite number, `by` is a string of at most 64 characters, and `reason` is a string of at most 200. A file over 4096 bytes is refused unread. The file is removed in every case.
- Section 1: the holder checks the interrupt file before the ask file on each poll. It logs each relay to stderr as it logs everything, with the id and the reason stripped of control characters.
- Section 2: `fleet_interrupt` clones `fleet_restart`'s registration (owner tier) and the four gates the spec names. It carries no fifteen-minute interval refusal, since the spec lists four gates and one request is served once. The reason is trimmed and cut at 200, and the file is one write of `{at, by, reason}` as `fleet_restart` writes.
- Section 2: the supervisor reads the run-directory file through a new `bin/supervise-interrupt-request.mjs`, cloned from `bin/supervise-restart-request.mjs` with the same rejection rules. It mints the id as `$SUPERVISOR_START_MS-int-<seq>`, the shape `write_final_ask` uses (`bin/supervise.sh:3066`). It writes `{id, at, by, reason}` to `interrupt.request.tmp` and moves it into place.
- Section 2: the served time is kept as `<child dir>/interrupt.served`, holding the served `at`, so a supervisor that adopts a running child does not serve its predecessor's request again. It relays only where `at` is newer than both the child's start and the served value. It serves launched and adopted children alike.
- Section 2: the coordinator paragraph lands as sentences in `COORDINATOR_ROLE_INSTRUCTION` beside the `fleet_restart` sentence (`bin/supervise-holder.sh:277`), since this repository carries no coordinator skill and that instruction is where the coordinator persona learns its fleet levers. The injection ledger and the role-instruction pins move with it.
- Section 2: README.md, `docs/architecture.md` and `docs/security-model.md` gain the tool and the request file where they describe `fleet_restart`, written in the main thread.
- Section 3: the request is written into a throwaway run directory in the exact shape `fleet_interrupt` writes, rather than through the tool. The tool's gate needs a session holding the coordinator persona, which on this machine is the live Steward, and section 2's unit test pins the tool's write.
- Section 3: the throwaway supervisor runs from this worktree with `--dev`, set up the way `.kit/live-restartrequest-test.sh` sets up, against a local stub with a dummy key, so it spends nothing and touches no fleet store. The stub records every request body. The follow-up prompt's request carrying the first prompt's codeword in its message history is the proof the conversation is intact, since a stub that refuses every request cannot produce a real answer.

Old contract: a holder launched by a supervisor older than this change never watches the interrupt file, and a child loads `fleet_interrupt` only once the installed plugin is updated. Both need a relaunch after install, which the close-out names.

Baseline, measured 2026-09-30 on this machine at `5fc62b9`, clean worktree, no foreign runner on the pre-run poll, each lane's exit code read from its own run: `supervisor-holder-test.sh` 0 (26 s), `channel-reply-instruction-test.sh` 0 (5 s), `settings-plugin-key-test.sh` 0 (33 s), `fleet-status-unit-test.mjs` 0 (2 s), `injection-duplicate-test.mjs` 0, `tool-description-length-test.mjs` 0, `supervisor-unit-test.mjs` 0, `supervisor-poll-unit-test.mjs` 0 (4 s), `supervisor-natural-exit-test.sh` 0 (1,948 s). Logs in `.kit/scratch/supervisor-interrupt/baseline/`.

Next action: section 1 dispatch to implementer-sonnet once the baseline returns.
