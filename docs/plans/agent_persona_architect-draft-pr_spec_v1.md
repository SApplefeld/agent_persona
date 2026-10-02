# The architect's charter says a plan branch gets a draft pull request the worker finishes, so the habit survives a restart

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-02

## Dispatch Authorization

The ARCHITECT persona wrote this plan on 2026-10-02 on the operator's word of that day on the ARCHITECT's channel, asking whether the branch, draft pull request, worker and finishing flow should be codified in the architect seat, and answering the ARCHITECT's recommendation with "Please do!". It has one precondition, on dispatch: `agent_persona_kit-name-tolerance_spec_v1.md` has merged, since that plan rewrites the same charter line and two edits to one line is a merge conflict. The coordinator queues it for this repository's worker then. While this repository is public, no commit, pull request, Chapter or brief on this plan spells any word on the banned list or the path of a file that leaks one.

## Goal

The architect's charter, the instruction text the supervisor writes into the architect's first turn, says that every plan branch the architect pushes gets a draft pull request against the trunk, reported by number with the branch and the filename, and that the worker executing the plan pushes its Chapters to that branch and marks the pull request ready and merges it at its finishing pass, so the architect never marks one ready. It also says that when a plan the architect wrote is no longer to run, whether a later plan supersedes it or the architect or the operator drops it, the architect marks the plan Abandoned naming the successor or the reason, closes its draft pull request with a note saying the same, and tells the coordinator, which may have queued the plan for a worker, all in the stretch that reaches the decision. The injection ledger's baseline and the architecture reference's size row read the new charter's size, and the offline gate is green.

## Intent

The frame, in the operator's words of 2026-10-02: "Do we need to make a small doctrine or skill edit to the Architect seat to codify the branch to draft pr to worker effort and finalization you've been doing?" and, on the recommendation, "Please do!".

What done needs to do. Four sentences in the charter, after the sentence that reports the branch and the filename: the draft pull request for every plan branch and its number in the report, the worker's ownership of that pull request through to ready and merge, that a review, a consult or a finishing judgment opens none, and that a plan no longer to run is abandoned, its draft closed and the coordinator told, by the architect, in the stretch that decides it. The ledger baseline and the size row follow the charter.

What done does not need to do. It does not touch the doctrine, whose branch-and-PR commit model already names the default and whose text is cross-seat principle rather than seat mechanics. It does not change the worker side: the kit's finishing pass already opens a pull request only where none is open for the branch, and this engine opens none itself. It does not change how a record or a channel message reaches the architect.

Alternatives refused. A doctrine bullet: refused, since the doctrine owns principle for every seat and the charter owns this seat's mechanics, which is where the clone, worktree, push and report sentences already sit. A kit skill edit: refused for the same reason, and because the kit is shared by seats that open no plan branch. Leaving it to memory: refused on the operator's word, since a restart loses what only a session remembers.

Rulings after the spec shipped: 2026-10-02, on the ARCHITECT's channel, asked whether abandoning a draft whose plan is no longer relevant would be written anywhere, after the ARCHITECT had named the rename as superseding the hook-tolerance plan without closing that plan's draft, which the coordinator then had to ask for: the fourth sentence, on abandonment, is added. Later the same day, on the same channel: "if you're the one drafting the plans and opening the PR drafts, it would make sense for you to also abandon them if you decide that an open draft PR is not relevant" and "you would probably have to tell the coordinator that", so the sentence covers every abandonment the architect decides, not only a supersession, and adds the word to the coordinator.

Provenance: written by the ARCHITECT persona, session 57239bb8, on 2026-10-02, from the charter at `bin/supervise-holder.sh:462` on `origin/main` at 779b391.

## Approach

**The charter sentence, `bin/supervise-holder.sh`.** The architect's role instruction is one single-line assignment, `ARCHITECT_ROLE_INSTRUCTION="..."` at `:462` on `origin/main` at 779b391, and the tolerance plan moves its skill names to `${KIT_SKILL_PREFIX}:` without changing its shape. After the sentence "Where no channel is attached, your record to the coordinator persona is the whole report." the section adds, inside the same assignment and on the same line: "For every plan branch you push, you open a draft pull request against the trunk, titled as the plan and carrying a one-paragraph body, and you report its number with the branch and the filename. That pull request is the worker's to finish: the worker executing the plan pushes its Chapters to the same branch, and its finishing pass marks the pull request ready and merges it, so you never mark one ready and never merge one. A plan review, a consult and a finishing judgment open no pull request, since they produce no file. When a plan you wrote is no longer to run, because a later plan of yours supersedes it or because you or the operator drop it, you mark it Abandoned in its header naming the successor or the reason, you close its draft pull request with a note saying the same, and you tell the coordinator persona, which may have queued that plan for a worker, all in the stretch that reaches the decision, so no draft outlives the plan it carries." The text carries no double quote, since the ledger matches a single-line `NAME="..."` assignment and an internal quote breaks that match, which `.kit/injection-ledger.mjs` reports under `[instruction-count]`.

**The ledger and the size row.** `.kit/injection-ledger.json` carries the architect row at 7,212 characters and 1,275 words on `origin/main`. The refresh is `node .kit/injection-ledger.mjs > .kit/injection-ledger.json`, per the comment at `.kit/injection-ledger.mjs:1684`, and `.kit/injection-duplicate-test.mjs` reads the baseline back. `docs/architecture.md:331`, the row "The architect: reply-tool plus its charter, the other two cleared", carries the sum the ledger reports for that launch shape and takes the new number.

**The worker side, unchanged.** The kit's finishing pass opens a pull request only where none is open for the branch and otherwise refreshes the open one's body, per the finishing-work skill's Apply the commit model step. This engine's hooks and supervisor scripts run no pull request command. So a worker running a plan on an architect's branch adopts the draft, and GitHub refuses a second open pull request from the same head to the same base.

## Sections of Work

### 1. The charter sentence, the ledger baseline and the size row

Model: sonnet

Acceptance:
- `bin/supervise-holder.sh` carries the four sentences above, verbatim, inside the architect's single-line assignment, and `grep -c 'ARCHITECT_ROLE_INSTRUCTION=' bin/supervise-holder.sh` still reads 2.
- `node .kit/injection-ledger.mjs > .kit/injection-ledger.json` refreshes the baseline, and the architect row's `chars` and `words` move by the sentences' own size, recorded in the Chapter with before and after.
- `docs/architecture.md`'s architect row reads the new sum, with the old and new numbers in the Chapter.
- `node .kit/injection-duplicate-test.mjs` passes, red between the charter edit and the refresh and green after, both runs in the Chapter.
- The whole offline gate is green against the baseline recorded before the section's first edit.

Files in scope: `bin/supervise-holder.sh`, `.kit/injection-ledger.json`, `docs/architecture.md`.
Tests: the ledger's size pin, since a charter edit that moves the baseline without the refresh reds the duplicate test and a refresh without the edit records nothing; the single-line shape, since a wrapped or quoted clause is sized as nothing.

## Out of Scope

- The doctrine and the kit's skills.
- The worker's finishing pass and this engine's record handling.
- The other seats' charters.

## Assumptions

- assumed 2026-10-02 (source: finishing-work's Apply the commit model step, and a grep of `hooks/index.ts`, `bin/supervise.sh` and `bin/supervise-holder.sh` on `origin/main` finding no pull request command): a worker adopts the architect's open draft rather than opening a second; reversal: a worker opening its own, which GitHub refuses for the same head and base, so the failure is loud and reopens this plan's Intent.
- assumed 2026-10-02 (default): the blind read and the plan review are skipped, since the plan is one section adding four sentences to one line.

## Operator Verification

- After the installed plugin copy is updated and the architect relaunched: read the architect's first turn carrying the new sentences, and read the next plan the architect ships arriving with a draft pull request number in its report. A report with no number reopens the section.

## Open Questions

- None.

## Related

- `agent_persona_kit-name-tolerance_spec_v1.md`: the plan this one waits on, since both edit the charter line.

## Chapters

