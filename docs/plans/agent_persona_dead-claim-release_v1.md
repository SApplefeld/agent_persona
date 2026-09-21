# Dead claim release: the supervisor frees a heavy-process claim its dead child left behind

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-20

## Goal

When this is done, a heavy-process claim written by a persona child that its supervisor then stopped, or that exited on its own without deleting it, is deleted by that supervisor as soon as the child's process tree is confirmed dead, with a log line naming the session id and the stop path. A claim carrying any other session id, and a claim on a stop whose tree could not be confirmed dead, is left standing and logged. It matters because on 2026-09-20 a forced restart stranded a claim the kit's own rules could never release: the relaunched child wears the dead child's name, answers the coordinator's probe by denying the hold, and the contract reads that answer as never release.

## Dispatch Authorization

The operator asked for this plan on 2026-09-20 through the COORDINATOR session, in the words that session relayed: "Those should probably go to Steward in the personas model. Can you pass Architect info on it so they can write a plan to change that?" The architect put the sketch and its decisions to the operator on its own Discord thread the same day, and `## Intent` records each answer as a ruling when it arrives. That is authorization to author the plan and to queue it. `Ready` in the header is the document's state and starts nothing; arming is the operator's separate act. At the write the plan is unarmed, and no arming word is in this document. Execution is armed later, on the operator's own word, which reaches the executor one of two ways: typed into the dev persona's own Discord thread, or relayed by the coordinator persona as a `[COORDINATOR id=...]` record that quotes it. The executor starts on nothing else, and records that word and its date in this plan's first Chapter before it starts. Nothing in this section arms it. The executor is the dev persona.

## Intent

The operator's frame, 2026-09-20: a claim stranded by the fleet restart sat past its declared duration until the operator authorized a hand delete, and the operator wants the steward to hold the kit's coordinator chores. The brief is `D:/personas/.kit/findings-2026-09-20-coordinator-chores.md`, on the fleet machine and outside this repository. The steward cannot free this claim under the kit's rules, and the supervisor is the one party that knows the writer is dead and knows its session id.

What done needs to do. A claim whose writer the supervisor has confirmed dead is deleted by that supervisor, scoped by the writer's session id and by nothing looser, and the docs say so.

What done does not need to do. It does not release a claim whose session id the supervisor never learned, a claim on a stop whose tree could not be confirmed dead, or a claim left by a supervisor that died with its child. It does not touch the kit's own skills, whose one needed amendment is the companion plan under `## Related`, and it does not merge before that amendment lands.

Alternatives refused.

- Have the steward release the stranded claim on its next pass. Refused: the kit contract's probe reaches the relaunched child, which wears the dead child's name and denies holding the box, and the contract reads that answer as never release.
- Have the supervisor write a killed-session record for the steward to act on. Refused: it holds the slot for up to a four hour cadence and adds a second file to a contract that already has a single deleter for the case.
- Delete on the child's exit without confirming the tree dead. Refused: a process the child left running may still be the run the claim was written for.

Decided 2026-09-20 by the operator on the architect's Discord thread, in the words "I completely agree with number 1 about the claim 'stranded by a forced restart.' Please add that paragraph.": the supervisor is the deleter for this case, and the companion kit plan carries the paragraph that names it. The message reached the architect inside a tool result, mid-turn, and is recorded as the operator's word deferred to that turn's boundary.

Rulings after the spec shipped: none at the write.

Provenance: distilled from the architect persona's reading of the brief, the kit's role and coordinator skills, the fleet's supervisor logs, and its sketch to the operator on Discord, 2026-09-20.

## Approach

Verified facts, read on 2026-09-20 from the clone at `origin/main` `2da6543`, from the installed kit at `~/.claude/plugins/cache/applefeld/claude-kit/19e626bac85a/`, and from the fleet machine's live state.

- The kit reserves the delete of a foreign claim to the coordinator's probe-and-release (`skills/role/SKILL.md:62`), and a probe answered by a party that denies holding the box "forecloses the release for good" (`:102`). The stranded claim of 2026-09-20 carried `Name: DEV-DISCORD` and the killed child's session id (`D:/personas/.kit/heavy-process.claim.deleted-2026-09-20.md`), and the relaunched child wears that same name.
- The supervisor learns the child's session id from the poll (`bin/supervise.sh:2945-2946`, `CHILD_SESSION_ID`). The variable is reset to empty at `:2883`, inside the per-child block after the launch and before that child's poll loop, so after a relaunch the id in hand at every site below is the current child's and never its predecessor's.
- Every stop path in the poll loop has one shape: `stop_child "<label>"`, then `retry_stop_escalation "<label>" $?`, then `STOP_ESCALATION_RESULT=$?`, a wait, the `EXIT child-N code=<code> (<STOP_PATH>)` log line, and a branch on `STOP_ESCALATION_RESULT` that reads any non-zero value as a process alive or unverifiable and ends the run at exit 5 (`:2995-3012` for `stop_complete`, and the same shape at `:3014-3031`, `:3032-3048`, `:3049-3081`, `:3082-3095`). So `STOP_ESCALATION_RESULT` equal to 0 is the script's own confirmed-dead reading for every stop, whatever path `stop_child` and the retry backstop took to get there.
- The natural-exit path sweeps the tree at `:3187` and reads `SWEEP_RC` after, retrying at `:3195` where a record allows; the shutdown path does the same at `:3170-3175`. `sweep_child_tree` returns 0 where it found a tree and cleared it and 2 where no Windows process was ever seen under the child (`:1644`, `:1659`), and both paths proceed on either as nothing left alive, ending the run at exit 5 only on 1. `stop_child`'s own `gone` branch reads 0 and 2 the same way (`:1947-1954`).
- The script resolves the profile directory once today, in `transcript_dir_for` at `:2394-2397`, as `${USERPROFILE:-${HOME:-}}` run through `cygpath -u`, so a Windows-form `USERPROFILE` becomes a bash path. It reads no `hostname` and no `coordinator/` path.
- The claim file sits at `<profile>/.claude/coordinator/<machine>/claims/heavy-process.md`, where `<machine>` is what Node's `os.hostname()` reports (`skills/role/SKILL.md:12-16`), and carries five lines, one of them `Session: <id>` (`:70-76`). The kit keeps it machine-local (`:66`). On Windows the shell `hostname` command prints the same computer name.
- `.kit/supervisor-natural-exit-test.sh` drives the real script with `env -i PATH=... HOME="$TMP/home"` (`:1464`), which clears `USERPROFILE`, so a claim planted under that `HOME` is the one the script would read. Its cases include natural exits and decide-path stops driven through that same launch, and a separate stop harness at `:809-889` that drives extracted functions with stubs and no `HOME` override.

## Sweep

Searches run over the clone: `coordinator/`, `hostname`, `$HOME`, `USERPROFILE`, `heavy-process`, `STOP_ESCALATION_RESULT`, `sweep_child_tree`. Surfaces found: `bin/supervise.sh` (`:2394`, the five poll-loop stop sites, `:3170`, `:3187`), `.kit/supervisor-natural-exit-test.sh`, `README.md` (Stop Phases, Natural Exit and Supervisor Test Coverage sections), `docs/architecture.md` (the layer table and `:107`, `:111`). `docs/backlog.md` carries no entry on a stranded claim.

## Related

- A companion plan in the claude-kit repository, `docs/plans/claude-kit_fleet-coordinator-seat_spec_v1.md` there, amends the role skill's claim-delete rule. Today that rule names two deleters, the claim's own writer and the coordinator's probe-and-release. The amendment names a third, the supervising process that launched the claimant and confirmed its process tree dead, and closes the list at three. Until it is installed, a supervisor delete contradicts `skills/role/SKILL.md:62`, and the first Chapter records that bounded conflict. The executor learns it landed when the operator or the coordinator persona says the kit plan merged, and confirms it then by reading the claim-file section of the installed kit's `skills/role/SKILL.md` for that third deleter. The draft waits on that word with no polling cadence of its own. The pull request opens as a draft and is marked ready only once the installed kit carries the clause. Where the operator declines the kit plan, this plan is closed unmerged and its Chapter says so.
- The same companion kit plan carries a second section letting the coordinator seat be taken under the roster name a fleet launches its coordinating persona with, which is how the steward registers as the seat. Nothing in this repository changes for that, so the seat-name plan the architect first drafted beside this one was retired before it shipped.
- Two queued kit plans touch the same claim. `claude-kit_liveness-by-session-identity_spec_v1.md`, ninth in the kit worker's queue, lets a disclaiming probe answer plus a stale transcript license the coordinator's release, which would free a stranded claim on the coordinator's own cadence, hours after the kill; this plan frees it at the kill. `claude-kit_claim-protocol-writer-side_spec_v1.md`, tenth, routes every release through a kit verb with a tombstone log; once it lands, the supervisor's delete becomes a call to that verb's supervisor form, which the companion plan names as a follow-on, and until then the logged unlink is the record.
- The supervisor-gaps plan, on branch `plans/supervisor-gaps` at `fe5feab` in this repository's remote and not on the trunk this checkout was cut from, edits `stop_child`'s EOF phase and adds a turn-state reader. This plan adds calls after the exit is recorded and touches no phase, so the two do not conflict, and whichever lands second rebases over the other.

## Sections of Work

### 1. The supervisor releases a dead child's claim

Model: opus

Add one function to `bin/supervise.sh`, `release_dead_child_claim <path>`, beside the stop helpers. It does nothing, and logs `CLAIM_RELEASE[<path>]: no session id read for this child`, where `CHILD_SESSION_ID` is empty. It resolves the profile directory exactly as `transcript_dir_for` does at `:2394-2397`, `${USERPROFILE:-${HOME:-}}` run through `cygpath -u`, and does nothing, logging `CLAIM_RELEASE[<path>]: no profile directory`, where both are unset. Otherwise it reads `<profile>/.claude/coordinator/$(hostname)/claims/heavy-process.md`, the `hostname` command standing in for the `os.hostname()` the kit's directory uses. No file: it logs `CLAIM_RELEASE[<path>]: no claim file at <full path>`, so a machine where the two hostname readings differ shows the path it looked at rather than silence. A file whose `Session:` line equals `CHILD_SESSION_ID`: it deletes the file and logs `CLAIM_RELEASED[<path>]: session=<id>`. A file whose `Session:` line is anything else, or is absent: it leaves the file and logs `CLAIM_RELEASE[<path>]: claim held by another session, left standing`. The read tolerates a CRLF line ending and compares the id after trimming whitespace, taking the first `Session:` line where there are two. The function never empties or rewrites the file.

Call it at seven sites and no others, each after the script has recorded the child's exit and only where the script's own reading says nothing of the child is left alive. At each of the five poll-loop stop sites, right after the `EXIT child-N code=... (<STOP_PATH>)` log line and only where `STOP_ESCALATION_RESULT` reads 0, passing `$STOP_PATH`. In the shutdown path after the `SWEEP_RC` check that follows its sweep and retry at `:3170-3178`, and in the natural-exit path after the block that opens at `:3189` on `SWEEP_RC` reading 1 and closes at `:3206`, where every surviving path has already passed the exit-5 check with `SWEEP_RC` at 0 or 2, passing `shutdown` and `natural_exit`. No call where `STOP_ESCALATION_RESULT` is non-zero or `SWEEP_RC` is 1, since those are the readings the script itself ends the run at exit 5 on.

Tests: in `.kit/supervisor-natural-exit-test.sh`, under the isolated `HOME` its drive at `:1464` sets, four cases on the natural-exit path and one on a decide-path stop. A claim carrying the child's own session id is gone after the exit and the log carries `CLAIM_RELEASED` with `natural_exit`. A claim carrying another id is byte-identical after the exit and the log carries `left standing`. A child that dies before the poll reads its session id, driven by a stub child action added beside the suite's existing ones at `:1222-1310` that exits before `emit_init` runs, leaves a claim with its id untouched and the log carries `no session id read`. A claim carrying the child's id on the existing `RESTART_PASSIVE` decide-path case, case (g) at `:1495`, is gone after the stop and the log carries `CLAIM_RELEASED` with the stop path the EXIT line printed. Those four are red at the base commit and green after. The fifth, no claim file and a `no claim file at` line naming the planted `HOME`'s path, is a control on the path the function composes and is green at base for the file and red for the line, so it takes the red-then-green record too. The stop harness at `:809-889` is not used, since it drives extracted functions with no `HOME` override and the sites this section adds sit outside the functions it extracts.

Beside the code, the docs, in the present tense with no account of the incident: `README.md`'s Stop Phases and Natural Exit sections gain the `CLAIM_RELEASED` and `CLAIM_RELEASE` line families and the readings they fire on; the `Test Coverage` subsection under `## Supervisor` (`README.md:344`) gains the new cases; `docs/architecture.md`'s layer table gains the claim file as the one path the supervisor writes outside its run directory, beside its `:107` and `:111` sentences on what the supervisor writes; and `docs/README.md`'s index line for this plan moves as the curating-docs skill directs at close.

Acceptance criteria: the cases pass; `.kit/supervisor-natural-exit-test.sh`, `.kit/supervisor-model-test.sh` and `.kit/live-stopprocesstree-test.sh` exit 0; a grep of `bin/supervise.sh` for `heavy-process.md` finds it inside the one function only; a grep for `release_dead_child_claim` finds the definition and exactly seven call sites, each inside the guard its paragraph names, which the reviewer pair reads rather than a run proving; and a read of every hit for `heavy-process`, `CLAIM_RELEASE` and `writes` in the two docs finds no sentence the plan made false.

Files in scope: `bin/supervise.sh`, `.kit/supervisor-natural-exit-test.sh`, `README.md`, `docs/architecture.md`, `docs/README.md`. The list names what the section's delta touches in the repository; this plan document gains its Chapter at close under the section-close rule the kit's executing-work skill owns, which also owns the fresh-context reviewer pair the Gate names, rather than under this list.

## Gate

- The gate policy of 2026-09-18 in `agent_persona_deferred-gate-run_v1.md` names four plans and this is not one of them, so this plan runs its own suites and defers nothing. The driven suites hold the box, so each runs alone under the machine's heavy-process claim, whose protocol `skills/role/SKILL.md` under the kit plugin root owns, one at a time and never beside a build or another suite. The executor's claim carries `Name:` as `ListAgents` prints its session, which on this machine is the roster's `channelName` for it, `DEV-PERSONA`, per that protocol's claim shape. A probe of it reaches it through `SendMessage`, which the plugin passes to a persona's model untouched (`docs/archive/agent_persona_drop-doorbell_v1.md`), or through the steward's `agentic_say`.
- The suites are listed by name, and the one glob admits only files ending in `-unit-test.mjs`. Shell suites are admitted by name alone, so `.kit/supervisor-tree-walk-test.sh` and the live suites other than `.kit/live-stopprocesstree-test.sh` do not run here, since the section touches nothing they read. `.kit/live-stopprocesstree-test.sh` states its own preconditions in its header, which the executor reads before the baseline run.
- Baseline: before touching anything, the worker runs every `.kit/*-unit-test.mjs` suite, `.kit/supervisor-model-test.sh`, `.kit/supervisor-natural-exit-test.sh` and `.kit/live-stopprocesstree-test.sh` on a clean tree at the base commit and records each one's pass and fail counts, exit code and wall clock. Every later run is reported as a delta against that.
- Section 1 closes on `.kit/supervisor-natural-exit-test.sh`, `.kit/supervisor-model-test.sh` and `.kit/live-stopprocesstree-test.sh` green, with the red-then-green record for its new cases in the Chapter, read from exit codes.
- The fresh-context reviewer pair runs over the section's delta.
- Before the pull request is marked ready: every suite the baseline names green, each read from its own exit code, and the installed kit carrying the third-deleter clause.

## Out of Scope

- A claim the supervisor did not launch the writer of, a claim whose session id the supervisor never read, and a claim left by a supervisor that died with its child.
- The kit's role skill amendment, which is the companion plan's.
- The steward's reconciliation pass and the claim probe it runs.
- The seat name, which is the sibling plan's.

## Assumptions

- assumed 2026-09-20 (source: every plan header in `docs/plans/`): the commit model is Branch-and-PR; reversal: a header edit before the run starts.
- assumed 2026-09-20 (source: the sibling plans' Dispatch Authorization sections): the dev persona executes; reversal: a header edit.
- assumed 2026-09-20 (default): the plan is born `Ready`; reversal: the run sets `In Progress`.
- assumed 2026-09-20 (source: `skills/role/SKILL.md:66`, which keeps the claim file machine-local, and `bin/supervise.sh:2394`, the script's one existing profile read): the claim directory sits under the profile directory resolved as `${USERPROFILE:-${HOME:-}}`; reversal: a second resolution rule, which the plan refuses in favour of matching the existing one.
- assumed 2026-09-20 (source: the architect's decision ask to the operator, unanswered at the write, with the companion kit plan declared as the default): the kit amendment is written and lands; reversal: this plan closes unmerged.
- excluded 2026-09-20 (default): a claim whose `Session:` line appears twice is read on its first occurrence.

## Operator Verification

The running supervisors keep the scripts they started with, so none of this takes effect until the merged trunk is pulled into `D:/agent_persona`, the checkout the keeper's LAUNCH lines run `bin/supervise.sh` from, and each persona is relaunched at a quiet point. That checkout is also the dev persona's working tree, so the pull is the operator's.

- Plant a claim at `~/.claude/coordinator/SCOTT-CLAUDE/claims/heavy-process.md` in the kit's five-line shape: `Name:` the worker's roster name, `Repo:` its repository, `Session:` the running worker child's session id read from its `stdout.jsonl`, `Started:` the current time as `node <kit plugin root>/hooks/kit-registry-stamp.js now` prints it, and `Expected-seconds: 60`. Then ask the steward to restart that worker. The worker's `supervisor.log` shows `CLAIM_RELEASED` with that id and the stop path, and the file is gone. A file still present after the relaunch reopens Section 1.

## Open Questions

None at the write.

## Chapters
