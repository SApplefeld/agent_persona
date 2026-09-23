# Security model document

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-09-22

## Goal

When this is done, the project has a `docs/security-model.md` that states what the persona plugin
and its process keeper trust, what they defend against, what risks the operator has accepted, and
what each accepted risk rests on. It matters for two reasons. Security reviews of this project have
no written model to measure against, so the last two finishing reviews ran against the README's
Trust boundary section and opened with "threat model: absent". And the operator's 2026-09-15
decision to run the keeper with no permission check lives only in an archived plan, where nobody
reviewing the code will find it.

## Dispatch Authorization

The operator ruled this backlog candidate a go on 2026-09-22. The coordinator relayed the ruling to
the architect as coordinator record `ARCHITECT-8d67c288-dd78-478d-a565-e390d50027b0-14`, quoting
the operator: "I think both are great. I agree with both of those. Please proceed." The candidate
as approved: the worker drafts the document from the README's Trust boundary section and the
backlog's security items, and the operator confirms the trust boundaries, since those are theirs
to state.

Execution waits on the coordinator handing this plan to a worker by name. A worker that finds this
plan in its own queue has that handoff.

## Intent

The frame, in the operator's words of 2026-09-15: the machine is a dedicated sandbox with isolated
permissions reached only by them locally, and the keeper's permission check was a best practice
rather than a requirement. That decision is sound and has no home that outlives the plan it was
made in.

Done means a reviewer can cite one section of `docs/security-model.md` for every trust decision the
code makes, the kit's security reviewer finds a `## Threat model` section in the shape it reads,
and the operator has read and confirmed the boundaries the document states.

Done does not need any code change, any new control, or any live probing of the box. Where writing
the model shows the code doing something the model cannot accept, that is a backlog entry or a new
plan, not a change inside this one. The document records what is true, not what ought to be.

Alternatives refused:

- Writing the model as a section of the README. Refused, because the kit's security reviewer reads
  `docs/security-model.md` by that path, and a section of a 900-line README is not a document a
  blocking review finding can cite.
- Copying the open security backlog entries into the model. Refused, because the backlog is their
  one owner and a copy drifts the day one is retired.
- Describing the relay broker's allowlist mechanics. Refused, because the broker lives in another
  repository, and a description here is a claim about code this project cannot pin.
- Confirming the boundaries at the keyboard. Refused, because the operator is away from it most
  days, and a plan that waits for a keyboard waits for weeks.

Rulings: none at the write.

Provenance: distilled from DEV-PERSONA's draft of 2026-09-22 at `e12a614` and the architect's read
of the sources below at `origin/main` `3b1823b` the same day.

## Related plans

None open. The process keeper plan (archived) is where the 2026-09-15 decision was made and
recorded; this plan gives that decision a home in the curated docs.

## Approach

**Decisions settled at the finalize**, by the architect on 2026-09-22, answering the draft's open
questions.

- The document opens with a `## Threat model` section in the
  fixed shape the kit's security reviewer charter reads: the deployment, the assets, the attacker
  classes in consideration, and the attacker classes out of consideration each with its reason. The
  draft's Assets part folds into it. The remaining parts follow in the order the Approach gives.
- The operator confirms through the worker's own ask path,
  which reaches the operator's phone. The worker's closing text lists one sentence per trust
  boundary and one per accepted risk, and ends with the one ask line the plugin reads. The plan
  holds at section 2 until the answer lands, and a boundary the operator changes is edited before
  the plan closes.
- The architect seat's outward reach is a known gap in the
  model, with a pointer to the backlog entry that carries it, because a reviewer of any
  architect-seat change needs to see it. The gap is that the architect's charter, not any code,
  is what confines its clones to its own directory and its pushes to the remotes it was handed.
- The relay broker's one-account allowlist is an assumption the
  model rests on, stated in the deployment paragraph with a pointer to the discord-channels
  repository, and its mechanics are not described.

**The sources.** Each was read at `origin/main` `3b1823b` on 2026-09-22.

- `README.md`, the `### Trust boundary` section (line 605). It says which writers may reach a
  persona's inbox and on which grounds, that the persona store is writable by any plugin-loaded
  process on the machine, that a peer message reaches the model as the harness delivers it, and how
  the roster is trusted once `fleetRoster` is set.
- `docs/architecture.md`, the sections `### Machine state outside the tree` (line 96), `## Injected
  text and its guard` (line 137) and `### What the guard does not reach` (line 168).
- `docs/archive/agent_persona_process-keeper_v1.md`, line 74 and line 414. These record the
  operator's 2026-09-15 decision: the keeper carries no permission check, because the machine is a
  dedicated sandbox that only the operator reaches, locally.
- The retired backlog entry "The keeper's boot-time execution surface has no security model
  document", now in `docs/archive/backlog-2026-Q3.md`. That entry is the origin of this plan. It
  lists the Password-logon scheduled task, the account's whole DPAPI reach, the password held in
  the LSA vault, and children launched with `bypassPermissions`.
- The kit's security reviewer charter, `agents/security-reviewer.md` under the kit plugin root,
  which on this machine is the newest directory under
  `~/.claude/plugins/cache/applefeld/claude-kit/`. Its paragraph opening **The threat model.** fixes
  the section's content and not its headings, in these words: "the deployment (where the code runs
  and who can reach it), the assets (what is protected and from whom), the attacker classes in
  consideration, and the attacker classes out of consideration with the reason". Four labelled
  paragraphs under `## Threat model`, in that order, meet it.
- `docs/backlog.md`, the open entries the Known gaps part points at. The set is closed at five
  headings: "The PowerShell watchdog's taskkill is the one kill with no identity guard", "A child's
  session id reaches a filesystem path unsanitized", "A roster value carrying a glob character
  reaches bash unquoted", "A provided settings file's persona silently overrides the supervisor's
  persona argument", which carries the `architectPersona` routing assumption and the architect's
  open outward direction, and "Findings the direct-lines finishing pass deferred", for the
  architect charter's missing disposition of a record with no design ask.

**The shape of the document.** Five parts, in this order.

1. **Threat model.** The kit's fixed shape. The deployment: one Windows machine the operator alone
   reaches, every persona running as the operator's own account under a stored-password scheduled
   task, the Discord relay admitting one account by the broker's allowlist in the discord-channels
   repository. The assets: the operator account's credentials and DPAPI reach, the repositories and
   their push rights, the Discord relay's authority, and the fleet's ability to act as the operator.
   Attacker classes in consideration, which are kinds of text and never the parties that send it:
   text that reaches a session as data (tool output, file text, a peer message's body, a channel
   message from an account the allowlist admits), and a roster or store file written by a process
   not running under the operator's account. A peer session is a trusted party under part 2, and
   its message is data under this part; the two statements are about different things. Attacker classes out of
   consideration, each with its reason: any process under the operator's account, whoever started
   it and whatever it reads or writes, because the sandbox decision accepts the account as the
   boundary, and that covers a keyboard session, an operator-run script, a persona acting against
   another persona, and instruction text loaded from the repository tree or a plugin; a message the
   broker refused, because the allowlist is the boundary and the model rests on it as an
   assumption; and a party holding SYSTEM, because the LSA vault is then open by design of the
   platform. The plugin's grounds, the reasons a writer may reach a persona's inbox that the
   README's Trust boundary section lists, are labels rather than permissions, and the model says so
   in this part.
2. **Trust boundaries.** Who is trusted, and why, each with a pointer to where the README states the
   mechanics: the operator's Discord account through the relay allowlist, and the operator at the
   keyboard, who is the local account; the local machine account and any process under it,
   including every persona, every subagent a persona dispatches, and any script the operator runs,
   which can write every store and roster file; the roster at `D:/personas/fleet.json`, the env
   file at `D:/personas/keeper.env` and the repository tree as operator machine state with no
   permission check; peer sessions, whose provenance label comes from the commons claims, the
   `persona:<name>` entries a session writes into the machine-global commons store to say which
   persona it holds; tool output and file text as data. This part names the files a local process
   could write to take over a persona: the persona store `.agentic-personas.json`, the roster, the
   env file, and a persona's `restart.request` in its run directory.
3. **Accepted risks.** Each with the precondition it rests on, as a sentence that could be checked on
   the box. The 2026-09-15 sandbox decision is the first: its preconditions are that the box is a
   dedicated sandbox, that only the operator reaches it, and that the account's password is unique
   to this machine. The DPAPI reach of a Password-logon task is the second, on the same
   preconditions. Children under `bypassPermissions` is the third, on the precondition that each
   GitHub repository the fleet pushes to has branch protection with pull-request review on its
   trunk, checked on GitHub rather than on the box. Part 2 lists each trusted party as its own
   paragraph and part 3 each accepted risk as its own paragraph, so section 2 can put one sentence
   per item to the operator.
4. **Known gaps.** The five backlog headings above, each listed whole as its heading and a pointer
   to `docs/backlog.md`, with one sentence on what surface it touches. Where only one facet of an
   entry is a gap, the sentence names the facet. No remedy text is copied.
5. **What this model does not cover.** The Claude Code harness, the kit plugin, and the Discord
   relay broker, each owned elsewhere, with the repository named for the broker.

The README's `### Trust boundary` section keeps its mechanics and gains one line pointing at the
model. The model points back at it for how each boundary is enforced, rather than restating that.

## Sections of Work

The two sections run in order as commits on one work branch cut from `origin/main`, named by the
worker, with this plan file on it, and finishing-work opens the one pull request.

### 1. Write docs/security-model.md
Model: opus
Audience: the kit's security reviewer, an expert reader who cites the document against code; a
reviewer of an architect-seat or keeper change, an engineer who has read neither the README's
Trust boundary section nor the keeper plan; the operator, who confirms the boundaries from a phone.
Voice: none.
Fact base: the sources listed under Approach, at the paths given there.

Must-answer questions. For the security reviewer: what is the deployment, what are the assets, and
which attacker classes are in and out of consideration with the reason. For the change reviewer:
which files a local process could write to take over a persona, and which risks are accepted on
which preconditions. For the operator: what am I confirming, in one sentence per item.

Write the document in the five-part shape above, from the sources above, with every claim about
the code carrying a file path and every accepted risk's precondition written as a sentence that
could be checked on the box, or on GitHub where the precondition is a repository control. The
prose-register rules apply, since this is a curated document. A sentence that says the code does
something is checked against the code before it is written, because the kit's security reviewer
rates a security document that contradicts the code at least Major. A contradiction that cannot
be resolved by rewording is a new entry in `docs/backlog.md`, the one write this section makes
outside the model file. The section's review is the document pair the `Audience:` line earns under
the kit's executing-work skill, a blind reader per persona named and the prose reviewer, which is
the review the acceptance lines below name.

Acceptance:
- `docs/security-model.md` exists with the five parts in the order above, the first headed
  `## Threat model` and carrying the deployment, the assets, the attacker classes in consideration
  and the classes out of consideration with reasons.
- It names the sandbox precondition, the password-uniqueness precondition, and the
  branch-protection precondition of the `bypassPermissions` risk.
- Part 2 lists each trusted party and part 3 each accepted risk as its own paragraph.
- Each of the five backlog headings is listed by title as a known gap with a pointer and no copied
  remedy.
- Every sentence stating what the code does carries a file path, and the section's review found
  none that the code contradicts.
- The blind reader the section's review dispatches, given only the document, can say which files a
  local process could write to take over a persona.

Files in scope: `docs/security-model.md`, and `docs/backlog.md` only for an entry a found
contradiction earns.

### 2. Point the README and architecture at it, and get the operator's confirmation
Model: sonnet

Runs after section 1. The README's `### Trust boundary` section and `docs/architecture.md`'s
`### Machine state outside the tree` section each gain one line pointing at the model.
`docs/README.md` lists it under `## Reference` (line 3) beside `architecture.md`. Then the worker
raises one ask to the operator through its own ask path. The plugin opens an ask from exactly one
closing line of the form `ASK: <question>? Recommend: <choice>`, and only while no ask is pending
(`hooks/index.ts`, the `askMarkerMatch` read near line 5894). So the worker's closing text lists
one sentence per trust boundary and one per accepted risk, each numbered, and ends with one line
reading `ASK: Do the numbered trust boundaries and accepted risks above stand as written? Recommend:
yes`. The relay posts that closing text to the operator's thread, and the operator answers with a
yes or with the numbers to change and the change for each. The README's `### Ask wait` section
(line 613) states the mechanics: the ask waits `askOperatorWaitMs`, 60 minutes by default, and the
worker sees an expiry as the `ask_timeout` decision on its tree.
The plan holds until the answer lands. An ask that expires unanswered is raised once more; a
second expiry stops the run with BLOCKED naming the unconfirmed boundaries, and the plan does not
close. A boundary or risk the operator changes is
edited in the document before the plan closes, and the Chapter records the answer.

Acceptance:
- Both pointers land on the model, and `docs/README.md` lists it under Reference.
- The Chapter quotes the operator's confirmation, or names each change they asked for and where it
  landed in the document.

Files in scope: `README.md`, `docs/architecture.md`, `docs/README.md`, `docs/security-model.md`.

## Out of Scope

- Any code change, including fixes to the known gaps.
- A penetration test or any live probing of the box.
- The kit plugin's own security model, and the relay broker's.
- Backlog entries the Known gaps part does not name. An entry found later that names a trust or
  execution surface is added to the model's Known gaps by the plan that retires or promotes it.

## Assumptions

- assumed 2026-09-22 (the repository's other plans): the commit model is Branch-and-PR; reversal:
  one header line.
- assumed 2026-09-22 (the kit's security reviewer charter): the file name is
  `docs/security-model.md`, the path that charter reads for a project's threat model; reversal: a
  rename and three pointers.
- assumed 2026-09-22 (the architect): the executing worker runs under the kit, whose
  executing-work skill owns the Chapter and the prose review the section's deliverable takes, and
  whose prose-register skill owns the register; reversal: a paragraph naming each.
- assumed 2026-09-22 (the architect): the worker's own ask path reaches the operator's phone, as
  the README's ask lifecycle and the relay's thread binding state; reversal: the ask goes through
  the coordinator instead.
- assumed 2026-09-22 (the kit's convention): a worker's queue is the persona plugin's queue file
  its priming names; reversal: one line.
- The plan review ran at fable and effort high and returned READY_WITH_FINDINGS, four Major and
  three Minor, all applied; the architect's answers to the draft's questions moved from the Intent
  record's Rulings part, which is the operator's, to the Approach. The blind read returned 6
  questions and 6 comprehension gaps: 11 answered in the spec, 1 assumed above, 0 asked. The gating litmus: 4 definitions after reconciling, the Known gaps set, the
  attacker classes, the trust boundaries and section 1's Files in scope; 2 one-sided, the attacker
  classes and the trust boundaries, which the reader counted and the author did not, and both are
  parts of the bounded document so the reader's count stands; 0 crossed; 4 unplaced, each placed by
  rewriting the part's text (an operator-run script and repository-loaded instruction text are out
  of consideration under the account boundary, a keyboard session and a dispatched subagent are
  inside the local-account boundary); 0 under-length.

## Operator Verification

- Confirm or change each trust boundary and each accepted risk when section 2's ask arrives, one
  answer per line.

## Chapters

### Interim board 1 - 2026-09-23

- Section 1 stage: document written inline on branch `security-model-build` (worktree `D:/agent_persona-security`, cut from origin/main at 57f0224), first-green commit d159c56. Header normalized from `Ready` to `In Progress` at that commit. Round 1 (three blind readers, one per Audience persona, and the prose reviewer, all fable via the Agent tool) adjudicated; the document is rewritten over every finding that held, uncommitted in the worktree. Findings and dispositions: `.kit/scratch/security-model/round1-findings.md` in the main checkout.
- Live dispatches: round 2, the prose reviewer alone at opus/high via Workflow, over the rewrite; added by choice, since a prose-only delta owes no round, because the acceptance asks that the review find no sentence the code contradicts.
- Gate baseline: none on a lane; the section changes documents only.
- Rulings adopted since the last boundary: none.
- Round 1 facts found: a provided `settings.json` is completed on every launch (`bin/supervise.sh`, the provided-file branch), so the "never rewrites it" sentence was false and is fixed. The hand launchers `docs/architecture.md` names under `D:/personas` do not exist there, which section 2 corrects in the same section it points at the model. This repository's `protect-main` ruleset requires one approving review, and the fleet pushes as a GitHub account separate from the approver.
- Next action: adjudicate round 2, close section 1 with its Chapter, then section 2.

### Interim board 2 - 2026-09-23

- Section 1 stage: review round 4 adjudicated; the document is rewritten over its findings and committed with this entry. Round 5 re-raises to round 1's roster (three blind readers, one per Audience persona, and the prose reviewer, all fable via the Agent tool), because round 4 carried a surviving Critical. Round 5 is the review-round backstop's bound: if its adjudication leaves the terminal condition unmet, the section stops on BLOCKED with the phase analysis rather than opening a sixth round.
- Rounds so far: round 2 (prose reviewer, opus/high, Workflow) 5 Critical, 13 Major, 11 Minor, all fixed; round 3 (three readers and the prose reviewer, fable) no Critical, Majors fixed; round 4 (prose reviewer, opus/high, Workflow) 1 Critical, 16 Major, 12 Minor. Round 4's Critical: the document said record bodies are never followed as instructions, which contradicts `COORDINATOR_STEER_INSTRUCTION` in `bin/supervise.sh`; fixed by stating that a coordinator-labelled record carries delegated authority. Findings and dispositions: `.kit/scratch/security-model/round2-findings.md`, `round2-dispositions.md`, `round3-dispositions.md`, `round4-findings.md` in the main checkout.
- Machine facts found by the rounds and written into the document, for the operator ask: Remote Desktop is enabled, its firewall rules admit every network profile, and only the operator's account can sign in through it; Authenticated Users can modify `D:/` and everything under it; the fleet's GitHub account `neo-claude` can push to nine repositories, admin on none; four meet the review precondition by ruleset, four carry classic protection `neo-claude` cannot read, and `Tabletop-Adventure-Simulator` has no protection.
- Section 2 edits drafted and uncommitted in the worktree: the pointer lines in `README.md`, `docs/architecture.md` and `docs/README.md`, and the corrected machine-state list in `docs/architecture.md`.
- Gate baseline: none on a lane; the section changes documents only.
- Rulings adopted since the last boundary: none.
- Next action: dispatch round 5, adjudicate it, then close section 1 or declare the backstop.

### Interim board 3 - 2026-09-23

Written at round 5's adjudication, where the review-round backstop fired.

- **Section 1 stage: stopped at the backstop, ladder at the opening bound, round count 5.** Round 5 ran the full roster (three blind readers and the prose reviewer, all at fable, Agent tool). The tree bracket read no delta. The blind readers returned no Critical. The prose reviewer returned one accuracy Critical, confirmed on the machine: the document said the tasks log on with a stored password, while `Get-ScheduledTask` on SCOTT-CLAUDE lists all six `AgentPersona-*` tasks at LogonType S4U, RunLevel Limited. `bin/Register-PersonaTasks.ps1:328` registers the Password logon, and only ASR-CLAUDE was re-registered to it (`docs/archive/agent_persona_task-password-logon_v1.md`). Interim board 2's machine fact "the task is Password logon" was read off the code, not the scheduler, and is wrong for this host.
- **Critical fixed before the declaration.** The deployment paragraph, the DPAPI asset line, the SYSTEM entry and the credential-reach risk now state the S4U logon on SCOTT-CLAUDE and what it denies. The fix is prose only.
- **Owed and unrun: the re-raised round 6 at round 1's roster.** A surviving correctness Critical re-raises the next round. The backstop opens no round, so round 6 is taken first on the operator's answer, before anything else in the section.
- **Frozen, unfixed: round 5's Majors and Minors.** Majors: the instruction-text sentence under Trust boundaries omits the architect's case; the third attacker class does not name its residual members; the Discord-account class is trusted and defended at once; the gate's real reach is not stated; the five-repository decision names no options; the per-ground enumeration restates the README and leaves `default` undefined; a non-trunk workflow's access to secrets is unstated; the document reads as one host while the fleet also runs on NEO-CLAUDE and ASR-CLAUDE. Checked facts for their fixes: the SSH key authenticates as `neo-claude`; with `keeper.env` absent, `bin/Start-Persona.ps1:646-649` logs and continues.
- **Pre-BLOCKED steps.** Journal entry `kit.review.cap fail` logged. No expert seat is on the roster. The consultant is dispatched on what the declaration recommends.
- Gate baseline: documents only, no suite.
- Next action: adopt the consult ruling, declare the backstop, notify the coordinator, then act on the operator's answer, starting with round 6.
- **Consult ruling adopted (consultant, fable, status RULED).** The one-host framing is the unfinished half of the Critical, not an operator fork. So the deployment paragraph now says the code runs on each fleet host, the measured facts are SCOTT-CLAUDE's, and every other host checks its own preconditions. The Authenticated Users sentence is now scoped to SCOTT-CLAUDE. The sweep behind that edit searched three phrasings ("one Windows machine", "this machine", "the machine") rather than every host-specific claim. The remaining per-host wording under Accepted risks, such as `gh auth status` showing one account, stays with the frozen Majors. The operator gets one fork, continue or stop, with continue recommended.
- **Spec drift, routed.** The plan's Approach states the deployment as "one Windows machine ... under a stored-password scheduled task". Both facts are wrong for SCOTT-CLAUDE, and the document departs from that sentence. The Approach read the deployment from the code's registration rather than from the scheduler. That gap between the spec's fact base and the machine's measured state generated round 5's Critical, so the Critical was spec-generated rather than fix-introduced.

### Interim board 4 - 2026-09-23

- **Operator decision on the backstop, 2026-09-23, on the relay thread: continue.** Their words: "Yes, go ahead and continue. I'm good with one more round for those changes." The review count restarts at this answer, and the ladder's next stage buys three further rounds, declaring again from the third of them.
- **Section 1 stage: fix round over round 5's held findings, done.** Every held Major and the Minors are fixed in `docs/security-model.md`, prose only: the architect's instruction texts, the third class's residual members, the Discord class's real bound, the gate's reach with `default` and a claim defined, the five-repository options, the workflow's secrets, the per-host push-account wording, the roster bound named, the `HOME` fallback, the decision summarised, the group names, the web-page equivalents, the rule-then-reason splits, the credential-store wording and the profile ACL.
- Next action: run the owed round 6 at round 1's roster over the document, adjudicate, then close section 1 or re-declare at this stage's bound.

### Chapter 1 - 2026-09-23
Completed: 1. Write docs/security-model.md
Implemented By: main session (inline, `docs/` write)
Metrics: review rounds 6, closed major-closed; provenance not read, the document pair sitting outside the provenance read; accuracy Criticals by round: r2 5, r4 1 (introduced by r3's fix), r5 1 (generated by the spec's Approach); rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings; NEEDS_CONTEXT 0; escalations 0; consults 1
Decisions / Surprises: section open: write the security model with a Threat model, Trust boundaries, Accepted risks and Known gaps; serves the Goal sentence naming the document; adds no mechanism; one document; not writing it leaves the kit's security reviewer nothing to cite. Header normalized at start from `Ready` to `In Progress`. The takeover-file list runs past the spec's four named files, to every file traced that steers or replaces a persona, with a closing class sentence; a declared deviation that serves the Goal's "which files take over a persona". The spec's Approach sentence "one Windows machine ... under a stored-password scheduled task" is wrong for SCOTT-CLAUDE on both facts (six tasks at S4U, several fleet hosts); the document departs from it and scopes its measured facts to SCOTT-CLAUDE. The review rounds measured the machine rather than the code alone: Remote Desktop enabled on every profile, Authenticated Users holding modify on `D:/`, `neo-claude` pushing to nine repositories and admin on none, four meeting the review precondition, four unknown under classic protection, `Tabletop-Adventure-Simulator` unprotected. `docs/architecture.md` names hand launchers under `D:/personas` that do not exist; section 2 corrects it. Round 5 hit the review-round backstop; the consultant ruled the one-host framing part of the Critical rather than an operator fork, and the operator chose continue on 2026-09-23 (Interim boards 3 and 4). `README.md:613` still says the tasks run under a stored-password logon; section 2 corrects it with its other `README.md` edit.
Assumptions: the `claude-kit-doctrine.md` data rule reaches every session on SCOTT-CLAUDE through the global `CLAUDE.md` import (2026-09-23, section 1, route (a): `~/.claude/CLAUDE.md` line 2 and the doctrine's data bullet).
Review Findings: `review: blind-reader x3 and prose-reviewer at fable, Agent tool` in rounds 1, 3, 5 and 6; `review: prose-reviewer at opus, Workflow (high)` in rounds 2 and 4. Every Critical was an accuracy defect found against code or the live machine, and each was fixed. Round 6 returned no Critical from any lens. Its Majors were fixed as prose: the Discord class recast as channel-message text, per the Approach; reason-in-clause sentences split; the credentials sentence split one file per sentence; the label names and the answer-leg state defined; the data rule's anchor named; the service-account class's acceptance stated; the precondition cadence stated; the re-registration consequence stated; the classic-protection reading named. Major justified-not-fixed: the four-ground enumeration stays, because the change-reviewer persona has read no README and two rounds of blind readers asked for exactly that definition. Minors left with the reason: triadic cadence (the sets are real); the roster-bound citation points at the README's test list, which names the behaviour; the Actions secrets per repository are unreadable to a non-admin account. The fix delta is prose only, so it owes no round; it took the author re-read, with the two new factual sentences checked (`hooks/operator.ts` 695-714 for the labels, `gh api` for classic protection, `~/.claude/CLAUDE.md` for the import).
Stamps: adjudicated 10, stamped 2 (relay-status-cadence-is-one-message-per-section-close, neo-claude-persona-fleet-layout)
Gate: documents only, no lane applies; tree brackets on rounds 5 and 6 read no delta.
Next: 2. Point the README and architecture at it, and get the operator's confirmation
Commit Model: Branch-and-PR
Delta: measured 2026-09-23 on SCOTT-CLAUDE at 94305d4 plus this section's close edits. `kit-size.js report` reads no measured corpus in this repository:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 5 - 2026-09-23
Section 2 stage: pointer edits committed as 83846ba (README.md Trust boundary pointer and the logon sentence at line 613, docs/README.md Reference line, docs/architecture.md machine-state list corrected against D:/personas and the six AgentPersona tasks). Prose-only, so it is treated as trivial under step 3: author re-read, with no review round.
Live dispatches: none.
Gate baseline: unchanged from Chapter 1. No code changed since then.
Pending: the operator confirmation ask, sent on the relay 2026-09-23 with trust boundaries 1-6 and accepted risks 7-9 numbered. The turn closing text carries the plugin ASK marker line.
Next: on a yes, write Chapter 2 quoting the answer; on changes, edit docs/security-model.md for each numbered item, then Chapter 2. First expiry re-raises once; second expiry is BLOCKED naming the unconfirmed items.

### Interim board 6 - 2026-09-23
The confirmation ask expired once unanswered. It was re-raised on the relay 2026-09-23, the one re-raise the plan allows. A second expiry is BLOCKED naming items 1-9 as unconfirmed.
