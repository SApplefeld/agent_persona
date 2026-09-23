# Ask bookkeeping cleanup

Status: Draft
Commit Model: Branch-and-PR
Created: 2026-09-22

This is a plan shell. The DEV-PERSONA worker, which owns the agent_persona clone, drafted it. The architect reviews it, answers the open questions, finalizes it and moves the header to `Ready`.

## Goal

When this is done, a persona's record of its open operator question always agrees with the goal tree and with the ask records in the store. Three paths break that agreement today, and each leaves a worker stuck behind a question nobody can see or answer, or holding an active entry its own pointer does not name. It matters because a stuck ask stops all new work on the persona until the ask expires, 60 minutes by default and never where the wait is set to 0.

## Dispatch Authorization

The operator approved this candidate on 2026-09-22. The coordinator, the STEWARD persona, relayed the ruling to DEV-PERSONA the same day in record `DEV-PERSONA-8d67c288-dd78-478d-a565-e390d50027b0-10`, quoting the operator: "I think both are great. I agree with both of those. Please proceed." DEV-PERSONA has not seen the operator's own message, so this section is reported rather than confirmed. The candidate as approved was the three backlog defects below, fixed in one plan.

Execution waits on the architect finalizing this document. Under the operator's standing default, a finalized plan merged to the trunk is the go to queue it.

## Intent

Done means each of the three paths closes or keeps its ask the way `goal_resume` already does, and a tick-suite case proves each one.

Done does not need a new ask status, a new store key or a change to how long an ask waits. `closeAskOnNode` in `hooks/index.ts` and the ask record's existing `resumed` status already carry what the fixes need.

## Approach

**What exists today.** Each point below was read at `origin/main` `3b1823b` on 2026-09-22. Line numbers move as other plans merge, so find the code by the names given.

- `pendingAskId` is one slot on the persona state. Only one ask can be open at a time, because the slot holds only one id.
- `closeAskOnNode` (`hooks/index.ts:1943`) closes the ask `pendingAskId` names when it is open on the node passed in. It sets the record's status to `resumed` and logs `ask_answered` naming the tool that closed it. The caller clears `pendingAskId`.
- `goal_resume` (`hooks/index.ts:7368`) is the reference behavior. It sets the entry `active`, sets `activeGoalId` to it, and closes an ask on it through `closeAskOnNode`.

**The three defects.** Each was found by an earlier plan's review and parked in the backlog. This plan moves them out of the backlog.

1. **An error streak overwrites an open ask.** The controller tick's error-streak branch (the block opening `// 2a. C3: error streak branch`, around `hooks/index.ts:4305`) sets `pendingAskId` to a new ask on its active-node arm without checking the slot. A leaf can be active while an ask is open, because the ASK-marker path pauses only the node it names. The first ask record then stays `open` in the store, and no answer can reach it. The no-goal-idle plan's Section 1 review found this.
2. **`goal_create` leaves a stale ask.** A replacing `goal_create` (`hooks/index.ts:6705`) resets `activeGoalId` and nothing else that names a node. `pendingAskId` can still name an open ask on an entry that now lives only in `.agentic-goal-history.jsonl`. While it does, `goal_add`'s no-active-leaf branch reads the ask as a hold and activates nothing on the new tree. The goal tree curation plan's Section 4 found this.
3. **A thread reply reactivates without the pointer.** The ask close in the `prompt.submit` handler (the block opening `D5b (bullet 1)`, around `hooks/index.ts:7985`) sets the asked entry's status to `active` and never sets `activeGoalId`. Until the next store load runs `enforceInvariants`, anything that keys on the pointer misreads the tree. `goal_done` with no nodeId is one such reader. The goal tree curation plan's Section 3 found this.

**The design.** DEV-PERSONA proposes it, and the architect settles it.

1. The error-streak branch checks `pendingAskId` before opening an ask. With an ask already open, it logs `error_streak` with a detail naming the open ask, and opens no second ask. See Open Question 1 for whether it still pauses the leaf.
2. A replacing `goal_create` closes an open ask the way `goal_resume` does, with the decision detail naming `goal_create`, and clears `pendingAskId`. The ask's node is gone from the tree, so this close does not go through `closeAskOnNode`'s node match. It closes whatever open ask the slot names.
3. The thread-reply close sets `activeGoalId` to the asked entry beside its status, as `goal_resume` does. It first pauses any other active entry, as `goal_resume` does, so the tree never holds two active entries.

## Open Questions

For the architect to answer before this is `Ready`. Each carries DEV-PERSONA's recommendation.

1. **With an ask already open, does an error streak still pause the active leaf?** Two ways to settle it. One: log the streak and leave the leaf running. The operator already has an open question, and the streak re-fires only after a new error, so a leaf that keeps failing is logged again. Two: pause the leaf with no ask of its own. It then has nothing to resume it except `goal_resume` or an answer to the other ask, which the thread-reply close would route to the other node. Recommendation: the first. A paused leaf with no ask is the stuck state this plan exists to remove.
2. **Should the old ask be closed as superseded instead?** The backlog entry offered it as the second remedy for defect 1. It needs a new `AskStatus` value, `superseded`, in `hooks/operator.ts`, and it drops the operator's first question in favor of the streak. Recommendation: no. Keeping the first ask costs nothing and keeps the operator's pending question in front of them.
3. **Does defect 3's close pause another active entry, or refuse to reactivate?** An operator answer arriving while a different entry is active is possible, because a leaf can be active while an ask on another node is open. Recommendation: pause the other entry with a `blockedReason` naming the reply, exactly as `goal_resume` does, so the answered entry resumes as the operator expects.

## Sections of Work

Sketched for the architect to finalize. The tier is DEV-PERSONA's proposal.

### 1. Close or keep the ask on all three paths
Model: sonnet

The three changes above, in `hooks/index.ts`, each with a case in `.kit/controller-tick-test.mjs` written first and watched red. The README's Ask wait section and the ask lifecycle account say what each path now does.

Acceptance (draft):
- An error streak on an active leaf while an ask is open leaves exactly one open ask record in the store, and `pendingAskId` still names it.
- A replacing `goal_create` over a tree with an open ask leaves that ask record `resumed`, `pendingAskId` unset, and one `ask_answered` decision naming `goal_create`. A `goal_add` on the new tree then activates the new entry.
- A thread reply closing an ask on a paused entry leaves that entry active with `activeGoalId` naming it, before any store reload.
- The whole tick suite passes, with its count up by at least three cases.

## Out of Scope

- How long an ask waits, and what happens when it expires.
- The ASK-marker path's choice to pause only the node it names.
- Any other backlog entry about asks, including the operator's pending kaizen node about asks that run out the clock.

## Assumptions

- assumed 2026-09-22 (the repository's other plans): the commit model is Branch-and-PR; reversal: one header line.
- assumed 2026-09-22 (the size of the change): one section, because the three fixes share one file, one helper and one test file; reversal: split the section in three.
