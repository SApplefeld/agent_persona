# Supervisor Interrupt for a Stuck Persona Turn

**Status:** Complete
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

## Standing Brief Amendments

- Tests that check the coordinator's role instruction or a tool's result text pin each on stable forms: the tool's name, and the behavior each sentence states. They do not pin an exact prose phrase that a correct rewording would change.
- The supervisor relays an interrupt only while the child's heartbeat shows a turn running whose turnStartedAt is at or before the request's at. Otherwise it records the request served without relaying it, and logs a distinct INTERRUPT_SKIPPED line. The relay's comment names the residual: for up to one heartbeat interval after a turn ends, the published stamp can still show that turn. Section 3 reads the child's heartbeat file during the observed rate-limit wait, and shows the interrupt is still relayed there.

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

- **The interrupt targets the turn that was running when it was asked for** (decided 2026-09-30 by the operator, option A). The coordinator calls fleet_interrupt, then agentic_say, and the relay can land up to one supervisor poll plus one holder poll later. A turn that started after the request is then a different turn, often the urgent record's own, so the supervisor skips it. This supersedes Section 2's "no need to detect an idle child first" for the relay decision.
- **No automatic interrupts in v1** (decided 2026-09-30 by the operator). The supervisor never sends an interrupt on its own. Automatic triggers may come later, once a use case is found. The manual tool covers the rate-limit case that prompted this plan.
- **The rate-limit case is the operator's strong expectation, not yet a fact.** Pressing Escape in an interactive session is known to break the harness's rate-limit wait. The operator strongly suspects the stream-json interrupt does the same. Section 3 settles it.

## Related

- [agent_persona_supervisor-gaps_v1.md](agent_persona_supervisor-gaps_v1.md) built `fleet_restart`, whose gates and request-file shape `fleet_interrupt` copies.
- [agent_persona_supervisor-peer_v1.md](agent_persona_supervisor-peer_v1.md) built the holder this plan extends.

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

### Chapter 1 - 2026-09-30
Completed: 1. Holder Relays an Interrupt
Implemented By: implementer-sonnet, first build and fix round 1, resumed with its context; the close-pass comment fix inline.
Metrics: review rounds 2, closed claim-exit; provenance 1 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 1 findings, 1 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- Section 1 open (2026-09-30): the holder watches a sixth-argument interrupt file and writes one fixed control line for a valid one; serves Section 1's acceptance bullet and the Goal's "end a persona's running turn without killing its process"; adds the mechanism the section names and no other; size roughly 40-70 lines of holder code and 60-100 lines of test; not building it leaves nothing able to send the interrupt, so a stuck turn still costs a restart and the conversation.
- Fix round 1 (2026-09-30): the holder test asserts the pipe's line count is unchanged across every refused interrupt file and grows by exactly one on a valid one, and checks each refused file's removal; serves Section 1's acceptance bullet ("each yield nothing, with the file removed in every case"); adds no mechanism; about 10 test lines; not building it leaves a verbatim relay of the file's content, the leak the spec guards against, green.
- Fix round 1, upgraded Minors (2026-09-30): the holder takes the file by renaming it to a private name before one capped read, validates and extracts in one node call with a bash re-check of the id, and checks the interrupt before the goal write; serves Section 1's "removes the file" and "never relays the file's content" clauses and the Goal's "without killing its process"; adds no mechanism, since the rename is the form of the removal the section names; about 20 holder lines; not building it loses a request that lands mid-read with no log line, can send an empty id, and can interrupt the operator's launch task.
- The Status header changed from "Approved by the operator 2026-09-30, routed to the plugin worker through the Steward" to "In Progress" on starting, recorded in interim board 1.
- The holder takes the request file as `interrupt.request.taken` before reading it, so the launch `rm -f` in `bin/supervise.sh` clears that name too. Section 2's brief carries this.
- The baseline's natural-exit run left its case `(nf)` supervisor, holder and two helpers running, a known defect already in `docs/backlog.md`. They were stopped by hand. The coordinator relayed the architect's ruling to fold an EXIT-trap remedy and a leftover-process pin into that existing entry, done in this section's commit.
- The first implementer run left a bash `until` loop polling a task output for a marker that would never print. It was stopped by hand at the fix round's return.
Failed approaches: none
Assumptions:
- (2026-09-30, section 1) Taking the request by rename to `interrupt.request.taken`, rather than reading it in place, is the form of the removal the section names. Route (b), declared: it closes both the size-check-to-read gap and the read-to-remove gap with one change.
Review Findings: review: adversarial, blind, security and performance at opus, Workflow at high effort, round 1; adversarial at sonnet, Workflow at high effort, round 2. Round 1 Major fixed (adversarial, spec-traceable): the test's "nothing reaches the pipe" check was vacuous once valid lines were on the pipe, so a verbatim relay of the file's content stayed green. It now asserts line counts, with red-first shown against a holder that relays the content and skips the size gate. Round 1 Major justified (blind, trace orchestrator-made to Section 2): nothing writes `interrupt.request` yet, since Section 2 builds the supervisor's writer inside this same pull request. Advisory: the security lens's Major (the size check and the read were two opens, so the "refused unread" comment was false) was covered by the blind lens's read-to-remove race and fixed by the one rename-then-read change. The performance lens's two Minors were covered (one node call now) or deferred to Section 3's timing, which measures from the request write. Minors: 3 upgraded on a stated consequence (a request lost mid-read, an empty id on a failed spawn, an interrupt killing the launch task) and fixed in fix round 1; 5 fixed (the oversized fixture pinning the size gate alone, the C1 and Unicode-separator strip, four stale or journey comments, per-mutation removal checks, and round 2's false JSON claim in the close pass as an author re-read); 2 routed to Section 2 (the adopt path's `INTERRUPT_REQUEST_FILE` in `gate_stage_child` and `gate_drop_child_globals`, and the security model's stdin paragraph, its request-file list and the README's holder-suite line).
Stamps: adjudicated 6, stamped 2 (a-hooks-change-reaches-a-running-child-only-after-the-clone-is-pulled, pulling-the-runtime-clone-leaves-every-running-supervisor-mixed-version, which shaped the old-contract note and Section 3's `--dev` route); the 4 operator-tier reads bore on no choice here.
Gate: targeted lane, measured 2026-09-30 on this machine at `a79b3bb` plus the close-pass comment edit, no foreign runner on the pre-run poll. `supervisor-holder-test.sh` 67 OK, 0 FAIL, exit 0, 46 s. `channel-reply-instruction-test.sh` 173 OK, 0 FAIL, exit 0, 5 s. `injection-duplicate-test.mjs` exit 0. Against the baseline at `5fc62b9` (holder suite exit 0, 26 s): still exit 0, and the added cases account for the 20 s. Test delta: added, in `.kit/supervisor-holder-test.sh`, the valid-relay case pinning the byte-for-byte control line and a one-line pipe growth; the reason-strip case; nine malformed cases pinning no pipe growth, per-file removal and one log line each; the padded-valid oversized case pinning the size gate alone; the interrupt-before-goal order case; and Case 5, a five-argument launch pinning the old shape. None retired. One edited to stay green: Case 1's simulated child sleeps 120 s rather than 30, because the added cases outlast the old lifetime. Spawning tests added: every added case drives the running holder already spawned by Case 1, Case 5 and the order case, three holder spawns in all.
Next: 2. Tool and Supervisor Route the Request
Commit Model: Branch-and-PR
Delta: measured 2026-09-30 on this machine, worktree D:/agent_persona-supervisor-interrupt at a79b3bb, with the close-pass edit and the Chapter uncommitted.

    kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report

### Interim board 2 - 2026-09-30
- Section 2 stage: first-green commit 65ee6e3 pushed. Review round 1 (adversarial, blind, security, performance at opus, Workflow at high) returned, and fix round 1 is dispatched to the section's sonnet implementer, resumed with its context. It covers the driven poll-loop case, the single-read relay, the holder-bound cut, and the Minors on the list at `.kit/scratch/supervisor-interrupt/minors-section-2.md`.
- Held, design stop: the blind lens's Major that a late relay can end the urgent record's own turn. The proposed mechanism relays only while the child heartbeat's turnStartedAt shows a turn begun at or before the request's at. The scope adjudicator ruled ASK, recommending the check gated on Section 3's live proof that a rate-limit wait still relays. The ask went to the operator on the relay with option A recommended. The architect was asked whether turnStartedAt is set during a rate-limit wait, and the coordinator was notified. Section 2 does not close until the operator answers, and the fix round is barred from the turn-state check meanwhile.
- Adopted: the adversarial lens's wording-pin Major, ruled accept-and-declare by the scope adjudicator, is now the one bullet in Standing Brief Amendments. This is approval drift, recorded here and to be recorded again in Chapter 2.
- Gate baseline for Section 2's lanes, at 65ee6e3 on a clean worktree with no foreign runner at the poll: all nine suites exit 0, the model suite at 404 s and the holder suite at 48 s.
- Next: adjudicate fix round 1's report, then round 2 at sonnet. Build the turn check or not per the operator's answer, then close Section 2 and start Section 3.
- The architect answered, reported and read from origin/main: turnStartedAt stays set through a harness rate-limit retry wait. It moves only at turn.start and turn.complete (hooks/index.ts:9566, :9575, :9870, deriveTurnStartedAt at :5261), and the heartbeat tick at :6462 republishes it without clearing it. That the retry happens inside the turn is inferred from the harness type docs, and Section 3 can confirm it by reading the heartbeat file during the observed wait. Residual, if the check is built: the published stamp can stay non-null for up to one heartbeat interval after a turn ends (comment at :9860), so for that one interval the check can still relay into a turn that just ended. It is bounded, and it is named rather than closed.
- Operator's answer, 2026-09-30 on the relay: "option B is fine", conditional on A being unable to tell the targeted turn from a later one ("If that were possible, I would support option A"). The premise does not hold. The check compares the running turn's turnStartedAt with the request's at, so a turn started after the request reads as a different turn. The correction and a re-ask went back on the relay. Section 2 stays held until the operator confirms A or B.
- Operator confirmed option A on the relay, 2026-09-30 ("Let's do A!"). It is recorded under Decisions and as a Standing Brief Amendment. It goes to the implementer as a follow-up once fix round 1 reports.

### Chapter 2 - 2026-09-30
Completed: 2. Tool and Supervisor Route the Request
Implemented By: implementer-sonnet for the first build, fix round 1 with option A as its follow-up, and fix round 2. The docs edits, the controller-tick pin and round 3's sentence-pin fix were made inline in the main thread.
Metrics: review rounds 3, closed claim-exit; provenance 5 spec-traceable, 3 fix-introduced, 0 new-requirement, rulings (0 refused, 1 declared, 1 asked); advisory: 9 findings, 8 fixed or covered, 1 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 1 (the operator's option A ask); consults 0
Decisions / Surprises:
- Section 2 open, fix rounds 1 and 2, the design stop and option A: each add-decision line is in `.kit/scratch/supervisor-interrupt/add-decisions-section-2.md`. The option A line reads: the relay reads the child heartbeat and relays only while turnStartedAt is at or before the request's at, otherwise it records the request served and logs INTERRUPT_SKIPPED once. It serves Urgent Messages and the operator's decision of 2026-09-30. It adds a mechanism, declared by that decision, of about 15 code lines and 40 test lines. Not building it lets a late relay end the urgent record's own turn.
- Approval drift, two items. The Standing Brief Amendments block was added after approval: the stable-form pin bullet (scope adjudicator, accept-and-declare) and the option A relay rule (operator, 2026-09-30). The Decisions section gained the option A bullet, which supersedes Section 2's "no need to detect an idle child first".
- Module added beyond the brief: `bin/supervise-heartbeat.mjs`. It exports `readChildHeartbeat`, moved out of `bin/supervise-poll.mjs`, which runs its CLI on load and so cannot be imported. `supervise-poll.mjs` now imports it, so the turn gate and the liveness verdict read the heartbeat through one reader.
- Fix round 2 added `INTERRUPT_HANDLED_AT`, an in-memory per-child record of the request already relayed or skipped. A served-marker write that fails now retries only that write rather than relaying a second interrupt. The residual is named in the code: a successor supervisor adopting the child before the marker lands can act on the request once more. While the marker cannot be written, the log carries one INTERRUPT_FAILED line naming the relay or skip in place of INTERRUPT: or INTERRUPT_SKIPPED.
- The tick suite's `s6 owner: twenty tools registered` pin had been red since `65ee6e3`, since fleet_interrupt makes 21 tools. It was re-pinned at twenty-one in fix round 1. The lesson is in memory as `a-change-to-a-shared-reader-owes-every-suite-that-pins-its-output`.
- The implementer's round-1 tests carried 13 checks of the form `check "...$(cmd)..." "$?"`, which always pass because the substitution resets `$?`. All 13 were rewritten to capture the exit code first. A pre-existing instance at `.kit/supervisor-model-test.sh:1301` is outside this diff and is in `docs/backlog.md`.
Failed approaches: none
Assumptions:
- (2026-09-30, section 2) The coordinator paragraph lands as sentences in `COORDINATOR_ROLE_INSTRUCTION`, since this repository carries no coordinator skill. Route (a), cited from interim board 1.
Review Findings: review: adversarial, blind, security and performance at opus, Workflow at high effort, round 1; adversarial at sonnet, Workflow at high effort, rounds 2 and 3.
- Round 1 Majors fixed: the supervisor test now drives the real poll loop for ADOPT and LAUNCH; one read of the request decides and writes; by and reason are cut to 64 and 200 on relay.
- Round 1 Major declared: the wording pins, which became the first amendment.
- Round 1 Major asked: a late relay could end the urgent record's own turn. The operator chose option A.
- Round 2, verified in `bin/supervise.sh:2932-2971`: the served-marker re-relay (Major, fixed); the unchecked skip-branch marker write (rated Major, downgraded to Minor since its failure only repeats a log line, fixed); the uncut skip-path log fields (fixed); and the conversation pin passing an inverted sentence (fixed).
- Round 3, APPROVED_WITH_CONCERNS: the new sentence pin refused two correct rewords. Fixed inline: "restart" is no longer refused, and the survival stem accepts keep, retain, preserv, intact, surviv and continu. Two reword controls were added. The old logic returns 1 on both and the new suite passes.
- Advisory: the security Major (a false comment) is covered by the single-read fix. The performance Major (latency) is covered by the tool text now saying up to about 12 seconds at the default poll intervals. The upgrade-check substring skew is deferred to `docs/backlog.md`. The missing `by=` in the log is fixed.
- Minors: the dispositions are in `.kit/scratch/supervisor-interrupt/minors-section-2.md`. Two were left with reasons: the old five-argument holder, which the README states, and the adoption-time `CHILD_START_TS`, which is intended.
Stamps: adjudicated 16, stamped 3 (process-command-line-coverage-is-partial-on-neo-claude, which led to measuring coverage before the gate; operator-on-discord-cannot-read-plan-docs-or-code, which shaped the option A ask; a-trace-target-you-composed-cannot-check-your-own-work, which kept the review trace targets on the plan's own text). The other 13 bore on no choice here. Earlier in the section, a-change-to-a-shared-reader-owes-every-suite-that-pins-its-output was written and stamped.
Gate: targeted lane plus the suites that pin the shared poll reader, measured 2026-09-30 on this machine at `581c0fe` plus fix round 2 uncommitted. Before the run, all 20 node, dotnet and testhost processes exposed a command line and none held over 150 MB. Logs are in `.kit/scratch/supervisor-interrupt/s2-gate-r3/`:
- `fleet-status-unit-test.mjs` exit 0.
- `tool-description-length-test.mjs` exit 0.
- `injection-duplicate-test.mjs` exit 0.
- `channel-reply-instruction-test.sh` exit 0. Re-run after round 3's pin fix: 179 OK, exit 0.
- `supervisor-poll-unit-test.mjs` exit 0.
- `supervisor-unit-test.mjs` exit 0.
- tsc (`node /d/agent_persona/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`) exit 0.
- `supervisor-holder-test.sh` exit 0, 46 s.
- `supervisor-model-test.sh` 319 OK, 0 FAIL, exit 0, 438 s.
- `controller-tick-test.mjs` PASS, 0 failures, exit 0, 135 s.
- `supervisor-natural-exit-test.sh --units` PASS, exit 0, 108 s.
- Against interim board 2's baseline at `65ee6e3` (all nine exit 0, model suite 404 s): still exit 0. The model suite's added cases account for the 34 s. Controller-tick was red at `65ee6e3` on the tool-count pin and is green now.
Test delta: added in `.kit/fleet-status-unit-test.mjs` 5 fleet_interrupt cases; in `.kit/supervisor-poll-unit-test.mjs` 7 reader cases; in `.kit/supervisor-model-test.sh` the extracted relay cases, the turn-gate cases, driven ADOPT and LAUNCH cases through the real loop, the skip case, the writer-reader case, the two unwritable-marker cases and the oversized skip-log case; in `.kit/channel-reply-instruction-test.sh` the fleet_interrupt pins, the inverted-sentence control and the two reword controls. One edited to stay green: the tick suite's tool count, twenty to twenty-one. None retired. Spawning tests added: the driven ADOPT and LAUNCH cases each spawn one supervisor loop with a fake child.
Next: 3. Live Proof on the Real Stuck State
Commit Model: Branch-and-PR
Delta: measured 2026-09-30 on this machine, worktree D:/agent_persona-supervisor-interrupt at 581c0fe, with fix round 2 and this Chapter uncommitted.

    kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report

### Chapter 3 - 2026-09-30
Completed: 3. Live Proof on the Real Stuck State
Implemented By: implementer-opus. The README residual and test-list edits were made inline in the main thread.
Metrics: review rounds 1, closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- Confirmed: the stdin interrupt ends a turn parked in the harness's rate-limit retry wait. A local stub answered every request with a 429 and a four-hour reset. The child logged `api_retry` records with `error_status` 429 and a `retry_delay_ms` near 14,399,000, the stream's form of the retry countdown. It was interrupted inside that wait. The turn's `result` (subtype `error_during_execution`) landed 52 to 66 ms after the holder's relay across three runs, against a 5 s pass line. This settles the Decisions bullet "The rate-limit case is the operator's strong expectation, not yet a fact", and What Is Known bullet 3.
- Confirmed: the conversation survives. A follow-up through the ask path sent a request whose history carries the goal prompt's codeword after two `[Request interrupted by user]` markers. The follow-up text itself holds no codeword.
- Confirmed, per the second amendment: the heartbeat's `turnStartedAt` stays set through the retry wait. The supervisor logged `INTERRUPT:` and no `INTERRUPT_SKIPPED:` in every case.
- Found, a product residual now stated in README: the child writes its heartbeat once per `heartbeatMs`, 30 s by default (`hooks/index.ts:5235`, written only from the periodic tick at `:6408-6414`). A request in about the first interval of a turn therefore finds no turn and is skipped. The implementer's first run hit this 4 s into a wait. A turn stuck long enough to need an interrupt is past the window, so no code change. README's turn-gate paragraph names it beside the end-of-turn residual. Its stale "the next poll tries again" sentence was narrowed to fix round 2's behavior.
- Added beyond the brief, each serving the section's pass line: the script waits for the heartbeat to name the parked turn before writing the request; it records the process tree and tears down by pid and creation time; and `.kit/.gitignore` gains two allow lines so the two new files are tracked. The priming turn is interrupted too, since with a stub that answers nothing it is the only way the goal turn starts.
- Machine note, reported to the operator: the throwaway child's session start printed that this machine's kit memory sync is standing down pending a kit-doctor fix run. It was not touched.
Failed approaches: the implementer's first run wrote the request 4 s into the wait and was skipped, as above. It shaped the heartbeat wait.
Assumptions:
- (2026-09-30, section 3) The proof is a kept script outside `.kit/live-all.sh`, so it is repeatable but is not a gate suite. Route (b), declared.
Review Findings: review: adversarial at sonnet, Workflow at high effort, round 1. APPROVED, no findings at any severity. The reviewer checked the evidence against each claim: the retry wait at request time, the relay-to-result times, the codeword placement and the INTERRUPT line. It also checked that every script assertion has a failing branch, and that teardown is pid and creation-time scoped with a withheld control.
Stamps: adjudicated 0 new since Chapter 2's pass, stamped 0.
Gate: targeted lane, the live proof itself, on this machine at `1cba63d` plus this section's uncommitted files. No foreign runner was on the pre-run poll, with 20 of 20 heavy-named processes readable. Implementer runs A and B: exit 0, relay to result 55/57 ms and 52/66 ms. Main-thread run C: `.kit/live-interrupt-ratelimit-test.sh` PASS, exit 0 read from `.kit/scratch/supervisor-interrupt/s3-runC/run.exit`, relay to result 55 and 60 ms, no survivors after teardown against 12 alive and 3 matched before it. No product file changed, so the section's own suites were not re-run. The finishing gate runs them all.
Test delta: added `.kit/live-interrupt-ratelimit-test.sh` and `.kit/live-interrupt-ratelimit-stub.mjs`, live and outside `.kit/live-all.sh`. None retired or edited. Spawning tests added: one throwaway supervisor, holder and `claude` child per run, plus the stub.
Next: finishing pass
Commit Model: Branch-and-PR
Delta: measured 2026-09-30 on this machine, worktree D:/agent_persona-supervisor-interrupt at 1cba63d, with this section's files and Chapter uncommitted.

    kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report

### Interim board 3 - 2026-09-30
- Finishing pass stage. Base ref `ebbabc9`, the merge-base with main; origin/main has since advanced 19 commits, merged at step 7. Capacity reading before the fable wave: "fable capacity: no reading (stale) -> ladder governs".
- Step 1 QA (qa-verifier): PASS on `06d7a91`. 30 whole-gate lanes exit 0, from `.kit/scratch/supervisor-interrupt/finishing/qa/_summary.txt` (`keeper-register` 116 passed and 1 skipped for an elevated session; an extra exit-2 line is the verifier launching the .mjs with bash, not a suite run). `supervisor-natural-exit-test.sh` exit 0 in 1,893 s, its four known leftovers stopped by pid. `live-all.sh` refused with exit 10 on the live STEWARD claim, which is the operator-only lane. `live-stopprocesstree-test.sh` exit 0. `live-interrupt-ratelimit-test.sh` exit 0. Every Section 1 to 3 acceptance line PASS with a named OK line. The repository defines no contention lane.
- Steps 2 and 3 (performance, security and adversarial at fable, high, run wf_c87c461d-3d0): the tree was unchanged across the round. Security CLEAR. Performance: one Major, the Goal's "about a second" against about 12 s at default polls, recorded as a deviation for the final Chapter. Adversarial CHANGES_REQUIRED: the coordinator trigger conjoins "in turn" with a stale heartbeat, which fleet_status never shows during a rate-limit wait. Verified at hooks/index.ts:3897-3923 and fix-introduced by section 2's first fix round.
- Add-decision, fix round F1 (2026-09-30): the trigger reads turnState 'in turn' with turnRunningMs far past the turn's work, or a persona the operator names. It serves the Intent (a turn parked for hours with nothing able to reach it) and Urgent Messages. It adds no mechanism, about 3 instruction lines and 15 test lines. Not building it leaves the coordinator never reaching for fleet_interrupt on its own for the case the plan exists for.
- F1 also carries eight Minors, and four are deferred to docs/backlog.md. Dispositions: `.kit/scratch/supervisor-interrupt/finishing/dispositions.md`. Brief: `.kit/scratch/supervisor-interrupt/finishing/brief-fix-1.md`.
- Next: F1 by implementer-sonnet, then an adversarial re-read of its delta, the goal read, docs curation, close and archive, the merge from main with the whole gate, and the pull request.

### Chapter 4 - 2026-09-30 (finishing pass)
Completed: finishing pass over Sections 1 to 3. Delivered in this changeset on branch `plan/supervisor-interrupt`, base ref `ebbabc9`.
Implemented By: implementer-sonnet for fix round F1. The re-read's Major and Minors, the README drift items D5 to D7, the README sentences F1 owed and the backlog entry were made inline in the main thread. docs-curator for `docs/`.
Metrics: review rounds 2 (finishing wave; F1 delta re-read), closed claim-exit; provenance 0 spec-traceable, 2 fix-introduced, 0 new-requirement, rulings (0 refused, 7 declared, 0 asked); advisory: 2 lenses, 1 Major dispositioned as a deviation, security CLEAR, 8 Minors fixed in F1, 4 deferred to `docs/backlog.md`, 0 refused; NEEDS_CONTEXT 1 (the goal read's first brief); escalations 0; consults 0
Recap: Goal, verbatim: "Let the fleet end a persona's running turn without killing its process, so the persona keeps its conversation. A stuck turn ends in about a second instead of a restart that loses the session's memory. The same act clears the way for an urgent message, which then arrives as the persona's next prompt."; What the tree does now: the coordinator persona has a new tool, fleet_interrupt, that asks another persona's supervisor to end that persona's running turn. The supervisor passes the request on only while the persona's own heartbeat shows the turn the request meant, and only once it knows the persona's session. The holder process then sends the model harness one fixed "interrupt" message on the persona's input. The turn ends, the conversation stays, and a message sent right after arrives as the next prompt. A live test proves this ends a turn stuck waiting out a rate limit, 69 ms after the relay on the last run, and that the conversation survives. The coordinator is told to use the tool on a turn running far longer than its work needs, or when the operator names a persona; Refinements during the run: the Status header moved from its approval text to In Progress on starting; the Standing Brief Amendment that tests pin stable forms rather than exact prose (scope adjudicator, accept-and-declare, Section 2); the operator's option A (2026-09-30), that an interrupt targets only the turn running when it was asked for, recorded under Decisions and as a second amendment, superseding Section 2's "no need to detect an idle child first"; the coordinator paragraph placed in the coordinator's role instruction because this repository carries no coordinator skill (route a, Section 2); the architect's ruling, relayed by the coordinator, folding an EXIT-trap remedy and a leftover-process pin into the existing natural-exit backlog entry (Section 1); the coordinator trigger reworded in fix round F1 to turnState 'in turn' with turnRunningMs far past the turn's work, since a stale heartbeat never accompanies "in turn"; Operator-pending, in order: relaunch each persona's supervisor after the installed plugin updates, so its holder watches the interrupt file and its child loads fleet_interrupt; run `.kit/live-all.sh` once the fleet is down, since it refuses while the live Steward holds its claim; run the kit doctor's -Fix for this machine's standing-down memory sync.
Decisions / Surprises:
- Deviation, the Goal's latency: the Goal says a stuck turn ends "in about a second". The relay lands up to one supervisor poll plus one holder poll after the call, about 12 s at the default 10 s and 2 s polls, and the tool text says so. Measured on the last live run: request to result 6.5 s, relay to result 69 ms. Section 3's pass line measures from the relay, and holds.
- Precision note on the live times: the relay-to-result figures (52 to 69 ms across runs) are bounded by one watch iteration of the script, not a harness latency measured on its own.
- Fix round F1 add-decision line: interim board 3. The adversarial re-read's Major was fix-introduced: the new absence check passed on an empty sentence, and its control never ran through the extractor. Fixed inline: the extractor anchors on `turnState`, an empty extraction fails, and two controls run through the extractor. Add-decision: serves the first amendment and the trigger fix; adds no mechanism; about 30 test lines; not building it leaves the trigger pin able to pass silently on a reword.
- Known state, declared rather than changed: a child whose stream never carries a session id holds an interrupt request unrelayed and unlogged for its life. A real child records its id about 20 s after launch on every live run, and the relay waits for it so a relaunched child's predecessor heartbeat is never read.
- The goal read's first dispatch returned NEEDS_CONTEXT, because the brief named `## Decisions` and section bodies. The corrected brief ruled. Every item traced to a recorded ruling: the turn gate to Decisions (option A), the coordinator guidance to the route (a) ruling at interim board 1, the backlog remedy rewrite to the architect's ruling in Chapter 1.
- Live proof re-run on `dc83f1f`, after F1 changed the relay's gating: PASS, `INTERRUPT:` logged, heartbeat turnStartedAt 1790821501015 against request at 1790821524885, codeword survived, no survivors after teardown. Evidence under `/d/Temp/agentic-live/interrupt-ratelimit`.
- Partial-substitution check, from each transcript's assistant lines: the three finishing reviewers 36, 35 and 33 lines, all `claude-fable-5-1`; the F1 re-read 43, all fable; the goal read 4 and 32, all fable. No substitution. The docs-curator inherited the session model, `claude-opus-5-5`, 113 lines, as dispatched.
- Drift report: 10 items, all deviations, 0 mistakes, so no pre-change read was owed. D1 to D4 and D8 to D10 the curator documented in `docs/`. D5 to D7 sat in README.md, outside the curator's charter, and were fixed in the main thread: the poll's second `node` process for the interrupt request, the holder and heartbeat-module rows, and the child directory's interrupt files. Hygiene: H1 cross-references added below; H2 resolved by this archive.
- Related plans: `docs/archive/agent_persona_supervisor-gaps_v1.md` built `fleet_restart`, whose gates and request-file shape this plan copies. `docs/archive/agent_persona_supervisor-peer_v1.md` built the holder this plan extends.
Failed approaches: none in the finishing pass.
Assumptions:
- (2026-09-30, section 1) Taking the request by rename to `interrupt.request.taken`, rather than reading it in place, is the form of the removal the section names. Route (b), declared: it closes both the size-check-to-read gap and the read-to-remove gap with one change.
- (2026-09-30, section 2) The coordinator paragraph lands as sentences in `COORDINATOR_ROLE_INSTRUCTION`, since this repository carries no coordinator skill. Route (a), cited from interim board 1.
- (2026-09-30, section 3) The proof is a kept script outside `.kit/live-all.sh`, so it is repeatable but is not a gate suite. Route (b), declared.
Review Findings: review: performance, security and adversarial at fable, Workflow at high effort, finishing wave; adversarial at fable, Workflow at high effort, F1 delta re-read. Goal read: scope-adjudicator at fable, Agent tool, 1 NEEDS_CONTEXT then RULED; BUILT-BUT-UNASKED 6 (1 ask resolved by Decisions, 5 accept-and-declare), ASKED-BUT-UNBUILT 1 (resolved by the route (a) ruling). Wave: adversarial Major (unreachable coordinator trigger, fix-introduced) fixed in F1; performance Major (Goal latency) recorded as the deviation above; security CLEAR; eight Minors fixed in F1 and four deferred to `docs/backlog.md`. Re-read: CHANGES_REQUIRED; its Major and four Minors fixed or declared as above. Dispositions: `.kit/scratch/supervisor-interrupt/finishing/dispositions.md`.
Stamps: adjudicated 0 new since Chapter 3, stamped 0.
Gate: whole gate on the merged branch at `9e4d7b9` (origin/main `0632ed7` merged, five conflicts resolved by hand), measured 2026-10-01 on this machine, run exit 0 read from `.kit/scratch/supervisor-interrupt/finishing/whole-gate/run.exit`. Pre-run poll: the live fleet's supervisors and holders, and one foreign `node` probe-corpus run at 11 MB, named as contention. 33 lanes, each exit 0 from `_summary.txt`: 21 node unit suites; `channel-reply-instruction-test.sh`; `persona-live-refuse-test.sh`; `settings-plugin-key-test.sh`; `supervisor-holder-test.sh` (46 s); `supervisor-model-test.sh` 325 OK, "All tests passed" (448 s); `supervisor-tree-walk-test.sh`; tsc; `check-loader-rule.mjs`; the regenerated injection ledger byte-identical to the committed one; `live-stopprocesstree-test.sh` (372 s); `live-interrupt-ratelimit-test.sh` PASS (89 s); `supervisor-natural-exit-test.sh` (2,052 s), its five known `(nf)` leftovers stopped by pid afterwards with none remaining. Against step 1's QA baseline at `06d7a91` (30 lanes exit 0): still all exit 0. `.kit/live-all.sh` was not run, since it refuses while the live Steward holds its claim. It is operator-pending. The repository defines no contention lane.
Test delta: F1 added the empty-session-id and failing-heartbeat-read cases to `.kit/supervisor-model-test.sh`, and the trigger-sentence absence check with two controls to `.kit/channel-reply-instruction-test.sh`. One edited to stay green: the model suite's LAUNCH stub prints a session id. None retired.
Next: none. Plan complete.
Commit Model: Branch-and-PR
