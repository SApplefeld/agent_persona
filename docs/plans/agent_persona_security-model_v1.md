# Security model document

Status: Draft
Commit Model: Branch-and-PR
Created: 2026-09-22

This is a plan shell. The DEV-PERSONA worker, which owns the agent_persona clone, drafted it. The architect reviews it, answers the open questions, finalizes it and moves the header to `Ready`.

## Goal

When this is done, the project has a `docs/security-model.md` that states what the persona plugin and its process keeper trust, what they defend against, what risks the operator has accepted, and what each accepted risk rests on. It matters for two reasons. Security reviews of this project currently have no written model to measure against, so the last two finishing reviews ran against the README's Trust boundary section and opened with "threat model: absent". And the operator's 2026-09-15 decision to run the keeper with no permission check lives only in an archived plan, where nobody reviewing the code will find it.

## Dispatch Authorization

The operator approved this candidate on 2026-09-22. The coordinator, the STEWARD persona, relayed the ruling to DEV-PERSONA the same day in record `DEV-PERSONA-8d67c288-dd78-478d-a565-e390d50027b0-10`, quoting the operator: "I think both are great. I agree with both of those. Please proceed." DEV-PERSONA has not seen the operator's own message, so this section is reported rather than confirmed. The candidate as approved: DEV-PERSONA drafts the document from the README's Trust boundary section and the backlog's security items, and the operator confirms the trust boundaries, since those are theirs to state.

Execution waits on the architect finalizing this document. Under the operator's standing default, a finalized plan merged to the trunk is the go to queue it.

## Intent

Done means a reviewer can cite one section of `docs/security-model.md` for every trust decision the code makes, and the operator has read and confirmed the boundaries it states.

Done does not need any code change. Where writing the model shows the code doing something the model cannot accept, that is a backlog entry or a new plan, not a change inside this one.

## Approach

**The sources.** Each was read at `origin/main` `3b1823b` on 2026-09-22.

- `README.md`, the Trust boundary section (`### Trust boundary`, around line 605). It says which writers may reach a persona's inbox, how the persona store is shared by any process in the same working directory, and how the roster is trusted once `fleetRoster` is set.
- `docs/architecture.md`, the sections `Machine state outside the tree`, `Injected text and its guard` and `What the guard does not reach`.
- `docs/archive/agent_persona_process-keeper_v1.md`, line 74 and around line 414. These record the operator's 2026-09-15 decision. The keeper carries no permission check, because the machine is a dedicated sandbox that only the operator reaches, locally.
- The retired backlog entry "The keeper's boot-time execution surface has no security model document", now in `docs/archive/backlog-2026-Q3.md`. That entry is the origin of this plan. It lists the Password-logon scheduled task, the account's whole DPAPI reach, the password held in the LSA vault, and children launched with `bypassPermissions`. `docs/backlog.md` holds the other open security entries: the watchdog's unguarded `taskkill`, the child session id reaching a path unsanitized, a roster value with a glob character reaching bash unquoted, and the architect seat's `architectPersona` routing assumption.

**The shape of the document.** DEV-PERSONA proposes it, and the architect settles it.

1. **Assets.** What an attacker would want on this machine: the operator account's credentials and DPAPI reach, the repositories and their push rights, the Discord relay's authority, and the fleet's ability to act as the operator.
2. **Trust boundaries.** Who is trusted, and why. The operator's Discord account, through the relay allowlist. The local machine account and any process running under it, which can write every store and roster file. The roster, env file and repository tree, which are trusted machine state with no permission check. Peer sessions, labeled by their commons claims. Tool output and file text, which are data and never instructions.
3. **Accepted risks.** Each one with the precondition it rests on. The 2026-09-15 sandbox decision is the first: its preconditions are that the box is a dedicated sandbox, that only the operator reaches it, and that the account's password is unique to this machine.
4. **Known gaps.** The backlog's open security entries, each with a pointer rather than a copy, so the backlog stays their one owner.
5. **What this model does not cover.** The Claude Code harness itself, the kit plugin, and the Discord relay broker, each owned elsewhere.

The README's Trust boundary section keeps its mechanics and gains one line pointing at the model. The model points back at it for how each boundary is enforced, rather than restating that.

## Open Questions

For the architect to answer before this is `Ready`. Each carries DEV-PERSONA's recommendation.

1. **How does the operator confirm the boundaries?** The operator is away from the keyboard most of the time, on a phone. Recommendation: after Section 1, send the operator the Trust boundaries and Accepted risks sections as a short relay message, each boundary as one sentence with a yes or change. Record the answer in a Chapter. The plan does not close without it.
2. **Does the model cover the architect's outward reach?** The backlog's architect entries note that the architect's charter tells it to clone under its own directory, and that the outward direction is not closed. Recommendation: yes, as a known gap with a pointer, because a reviewer of any architect-seat change needs to see it.
3. **Is the relay broker's one-account allowlist in scope?** It is the root of the operator's authority on every channel message, but it lives in another repository. Recommendation: state it as an assumption the model rests on, with a pointer, and do not describe its mechanics.

## Sections of Work

Sketched for the architect to finalize. The tiers are DEV-PERSONA's proposal.

### 1. Write docs/security-model.md
Model: opus

Write the document in the shape above, from the sources above, with every claim about the code carrying a file path. Name each accepted risk's precondition as a sentence that could be checked on the box. The prose-register rules apply, since this is a curated document.

Acceptance (draft):
- The document exists and has the five parts above.
- It names the sandbox precondition and the password-uniqueness precondition.
- Each open security entry in `docs/backlog.md` is listed by title as a known gap.
- A blind reader given only the document can say which files a local process could write to take over a persona.

### 2. Point the README and architecture at it, and get the operator's confirmation
Model: sonnet

The README's Trust boundary section and `docs/architecture.md`'s `Machine state outside the tree` section each gain a pointer to the model. `docs/README.md` lists it among the about-the-solution docs. The operator confirms the boundaries per Open Question 1, and the Chapter records the answer. A boundary the operator changes is edited before the plan closes.

Acceptance (draft):
- Both pointers land on the right section.
- The Chapter quotes the operator's confirmation, or names each change they asked for and where it landed.

## Out of Scope

- Any code change, including fixes to the known gaps.
- A penetration test or any live probing of the box.
- The kit plugin's own security model.

## Assumptions

- assumed 2026-09-22 (the repository's other plans): the commit model is Branch-and-PR; reversal: one header line.
- assumed 2026-09-22 (the kit's security reviewer): the file name is `docs/security-model.md`, the path the kit's reviewers read for a project's threat model; reversal: a rename and two pointers.
