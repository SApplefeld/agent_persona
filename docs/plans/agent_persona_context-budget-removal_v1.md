# Context-budget monitor removal

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-09-17

## Goal

When this is done, the plugin no longer estimates a session's context, logs no budget crossing, sends no `[BUDGET]` close-out turn, and the supervisor no longer restarts a child on a critical crossing. Context is managed by the harness's own compaction and the kit's compaction gate, and nothing in this repository sits above them. The sentence in the priming turn that tells the coordinator when to declare a compaction boundary stays. It matters because the harness compacts every session before the monitor's restart threshold is reached, so the restart either never fires or fires on a wrong estimate against a healthy session.

## Dispatch Authorization

The operator asked for this removal on 2026-09-17 on the coordinator's own Discord thread. Their words on the cut: "I think the native context management in the harness and the kit are preferable to that approach". Their words on its placement: "Sounds like Process Keeper is in finishing pass, so it should probably be a separate plan." That is authorization to author. Execution is armed only on the operator's own word, typed into the executing session's thread or relayed through the coordinator. The executor is the dev persona, as for the process-keeper plan.

## Approach

**What the monitor is.** On its controller tick the plugin reads the whole message history through `$.session.messages()`, sums the characters of every message, tool input and tool result, and divides by four. It logs a `context_budget_crossed` decision at 100,000, 250,000 and 350,000 estimated tokens, each latched and re-armed five percent below its threshold. At the second it submits a `[BUDGET]` close-out turn. The supervisor's poll loop reads the newest critical crossing from the persona store and hands it to `bin/supervise-decide.mjs` as `criticalTs`, and the decide unit restarts a child whose crossing is newer than its start. The plan that built it, `docs/archive/agentic-plugin_context-budget_v1.md`, names compaction as the kit gate's job and built the monitor as a layer above it.

**Why that layer has no job.** The four newest transcripts under `~/.claude/projects/D--agent-persona/` record six compactions on 2026-09-16 and 2026-09-17. Every one was the harness's own, fired between 265,158 and 313,657 tokens, and landed between 21,770 and 28,062. An honest estimate therefore never reaches 350,000. Whether the estimate falls after a compaction is unmeasured. Where it does not, the critical crossing restarts a healthy session, which is the kind of kill `docs/plans/agent_persona_supervisor-peer_v1.md` exists to end. The close-out turn would land just ahead of a compaction the kit's boundary rule already prepares a session for.

**Why the removal changes no running behavior.** The plugin runs the monitor only where the settings file carries `contextBudgetEnabled`. The launcher writes that key only when a threshold is given at launch. Neither live settings file, `D:/agent_persona/run/settings.json` nor `D:/personas/coordinator/run/settings.json`, carries it. Both carry `contextBudgetReadEveryNTicks`, which the launcher writes unconditionally, and a settings file that still carries that key after the removal is harmless because the plugin then reads no such option.

**The removal is whole.** Nothing is left behind a flag, since a disabled monitor is what exists today and it still cost a design question on the supervisor plan. Tests that pin the monitor retire with it rather than being rewritten, and two new cases lock that the removed paths stay removed. One group of tests only borrows the monitor. The process-keeper plan's natural-exit cases (i), (j), (k) and (x) use a stubbed critical crossing as their trigger for a decide-path restart of a live child, and what they pin is the restart accounting and the survivor refusal on that path. Those cases keep their assertions and change their trigger to the hung restart, which is the decide unit's other accounted restart of a live child, reached in the suite by a stub that stays alive and silent under a short `staleAfterMs`. They are rewritten and not retired, because retiring them deletes coverage that has nothing to do with the monitor.

**Words that share only the name.** The restart budget (`supervisorMaxRestartsPerHour`, `STOP_BUDGET`, `stop_budget`), the thirty-second tree-kill retry budget (`RETRY_BUDGET_S`), the nudge budget in `hooks/agent-state.ts`, and the harness's own type declarations under `.claude/types/` are different things and are not touched.

## Sweep

The coordinator swept `origin/main` at d4098fd on 2026-09-17 with `git grep -i` for the monitor's names and then for the bare word `budget`, beside a control search for `heartbeatMs` that spoke. That base predates the process-keeper branch's later commits, and a second reviewer found on that branch the natural-exit cases the Approach names, which is why the executing session's own sweep below is part of the work and not a formality. The second search found three surfaces the first missed: the `budget` entry in the live runner's suite list, the line in `.kit/.gitignore` that keeps the live suite tracked, and README mentions that say only "budget". A fresh-context plan reviewer then read the repository against the file list and found four more README lines and one more line in the live runner. Every file either pass returned is placed in Section 1's Files in scope or named under the Approach's last paragraph. The executing session repeats both searches against its own base before it edits, and amends Files in scope in the section's commit where a file has gained a mention since.

## Sections of Work

### 1. The monitor removed
Model: opus

`hooks/index.ts` loses the five `contextBudget` session fields and the latch, their defaults, the five option reads, the tick's budget block with its `budgetReadInFlight` guard, and the close-out turn with its `context_budget_nudge` and `context_budget_nudge_failed` decisions. `hooks/self-review.ts` loses its mention of those decisions. `bin/supervise-decide.mjs` loses the `criticalTs` input, its doc line, the branch that restarts on it, and the two comment mentions of the critical crossing, in the priority list's restart item and in the passive-restart note. `bin/supervise.sh` loses the four `CONTEXT_BUDGET` variables, the store reader that finds the critical decision, and the argument that hands it to the decide unit, with the inline script's later `process.argv` indices renumbered to match. `.kit/supervisor-natural-exit-test.sh` re-triggers cases (i), (j), (k) and (x) as the Approach states, with each case's assertions unchanged apart from the restart reason it greps for, and loses the critical stubs once no case reads them. `bin/agentic-common.sh` loses the `budget_opts` blob, its header comment's mention, and the variables' place in its export list. `.kit/live-budget-test.sh` is deleted, with its line in `.kit/.gitignore`, the `budget` entry in `.kit/live-all.sh`'s usage line and suite list, and that file's comment line naming the suite's output files. The count "five" in that file's header and default lines, and in the README's roster sentence, becomes four. `.kit/assert-decisions.js` loses its budget profile. `.kit/controller-tick-test.mjs` loses its budget cases. `.kit/supervisor-unit-test.mjs` loses its two cases that set a `criticalTs`, and the `criticalTs: null` field is removed from every surviving snapshot. The `messages()` stub in `.kit/tick-harness.mjs` stays, since the new tick case below reads it, and its comment is restated to name that case. `README.md` is edited at every mention of the monitor: "the budget" in the emitted-options sentence, the Poll Loop paragraph's input list and its priority item 6, the live runner's roster sentence, the `.kit/live-budget-test.sh` line, the "budget latch" in the tick suite's line, and "budget crossings" in the `assert-decisions.js` line. The priming text is not edited, and `.kit/channel-reply-instruction-test.sh` must still pass unchanged. `docs/README.md` moves this plan's index line as the curating-docs skill states at close.

Acceptance: `git grep -n -i -e "context.\?budget" -e "criticalTs" -e "budget_opts"` and `git grep -n -F "[BUDGET]"` over tracked files, outside `docs/archive/`, `docs/plans/`, `docs/backlog.md` and `docs/README.md`, return only the lines of the two new test cases named below, beside a control search for `staleAfterMs` that speaks, and the Chapter lists those lines; every remaining `git grep -i budget` match in a file this section edits is read and is not the context-budget monitor, and the Chapter lists each by file with what it is; `.kit/supervisor-unit-test.mjs` carries one new case, written first and watched red at the section's base, in which a snapshot carrying a `criticalTs` newer than the child's start returns no restart; `.kit/controller-tick-test.mjs` carries one new case, also watched red at the base, in which a session whose `messages()` fixture is past 350,000 estimated tokens, with `contextBudgetEnabled` true in its options, logs no `context_budget_crossed` decision and submits no turn; the natural-exit suite's cases (i), (j), (k) and (x) pass on the hung trigger with the same accounting assertions they carried at the base, and the Chapter shows each one's assertions before and after; the unit, tick, natural-exit, model, settings-key and channel-reply-instruction suites pass, each count reported against a baseline taken at the section's base with the exit code read from the run; and the Chapter names each retired test case by its title.

Files in scope: `hooks/index.ts`, `hooks/self-review.ts`, `bin/supervise-decide.mjs`, `bin/supervise.sh`, `bin/agentic-common.sh`, `.kit/live-budget-test.sh` (deleted), `.kit/.gitignore`, `.kit/live-all.sh`, `.kit/assert-decisions.js`, `.kit/controller-tick-test.mjs`, `.kit/supervisor-unit-test.mjs`, `.kit/supervisor-natural-exit-test.sh`, `.kit/tick-harness.mjs` (one comment), `README.md`, `docs/README.md`, this plan document.

Tests: at minimum, lock that a critical crossing in the store no longer restarts a child and that an enabled option no longer submits a turn, because the silent failure of a half-removed monitor is a healthy session restarted on an estimate nobody reads any more.

## Out of Scope

- The compaction-boundary sentence in the priming turn, and everything else in the priming text.
- `docs/archive/agentic-plugin_context-budget_v1.md` and its index line in `docs/README.md`. They are history and stay as written.
- The backlog entry "The context-budget plan's status header is none of the kit's values". It concerns the archived plan's header and is unaffected by this removal.
- The restart budget, the tree-kill retry budget, the nudge budget, and the harness type declarations, which share only the word.
- Any kit-side change. The kit's compaction gate and boundary rule are used as they are.
- The live settings files under `run/` and `D:/personas/*/run/`. They are machine state, and the leftover key in them is harmless.
- `docs/plans/agent_persona_supervisor-peer_v1.md`. Its edits for this removal ride in the same pull request as this plan document and are not this plan's execution.

## Assumptions

- decided 2026-09-18 by the operator on the coordinator's thread: the runs that hold the box are deferred to one end-run, `docs/plans/agent_persona_deferred-gate-run_v1.md`, which states the gate policy whole. Under it, `.kit/live-all.sh`, every `.kit/live-*-test.sh`, `.kit/supervisor-natural-exit-test.sh` and any check that launches a `claude` child or runs past two minutes of wall clock do not run at this plan's section closes or its finishing pass. Every other check this plan names still runs. A Chapter names each deferred run as deferred, never as passed. Where an acceptance line above names a deferred suite, that clause is met by the end-run.
- decided 2026-09-17 by the operator on the coordinator's thread: the monitor is cut, as its own plan. The words are in the Dispatch Authorization. The coordinator's evidence put to the operator before that answer: every recorded compaction was the harness's own and fired below the restart threshold, and the monitor is off for the running fleet.
- assumed 2026-09-17 (default): this plan runs after `docs/archive/agent_persona_process-keeper_v1.md` closes and before `docs/plans/agent_persona_supervisor-peer_v1.md` is armed, and never beside a plan that edits `bin/supervise.sh`, `bin/supervise-decide.mjs` or `hooks/index.ts`; reversal: the order is the operator's at arming, and running after the supervisor plan instead means that plan's executor meets a `criticalTs` input it leaves alone, which costs nothing.
- assumed 2026-09-17 (sibling plans in this repository): Branch-and-PR; reversal: none, a header edit.
- assumed 2026-09-17 (default): the removal is whole, with no flag left behind; reversal: a flag is a revert of this plan's commit, since the monitor is self-contained.
- assumed 2026-09-17 (default): tests that pin the monitor retire, and tests that only borrow it as a trigger are re-triggered on the hung restart; reversal: where the hung restart cannot be reached inside the suite's time bounds, the executing session stops and reports rather than retiring the four cases.
- assumed 2026-09-17 (default): one section, because the removal is one mechanical delete across files that are only consistent together; reversal: none needed.

## Operator Verification

1. After the merge, the installed plugin copy is updated and each running supervisor relaunched at the operator's convenience, since a running supervisor keeps the script it started with and a child loads the installed plugin. Nothing is urgent, because the monitor is off in both live settings files. The outcome that holds the work: the installed copy of `bin/supervise-decide.mjs` carries no `criticalTs`, the installed plugin's hook module carries no `contextBudget`, and a day of normal use in which a session compacts at least once ends with that session still running under the same supervisor child.

## Open Questions

- Whether the plugin's estimate falls after a harness compaction. It is unmeasured and this plan does not need the answer, since the removal is argued both ways in the Approach. Owner: nobody, unless the monitor is ever proposed again.

## Related

- `docs/archive/agentic-plugin_context-budget_v1.md`: the plan that built the monitor, and the priming sentence that stays.
- `docs/plans/agent_persona_supervisor-peer_v1.md`: its open question about the context-budget restart is retired by this plan.
- `docs/archive/agent_persona_process-keeper_v1.md`: closes before this plan runs.

## Chapters

### Interim board 1 - 2026-09-18

Not a Chapter. No section closed, and no section started.

**Stage.** Section 1 is unstarted. The armed queue's leash advanced to this plan after `docs/plans/agent_persona_supervisor-peer_v1.md` was recorded blocked. The plan was read in full, its arming gate was tested, and the run stopped before any edit. The `Status:` header is deliberately left at `Ready` rather than normalized to `In Progress`, because the run is not starting. The preceding plan's status was flipped ahead of its gate earlier in this queue and had to be reverted, and this entry records the choice not to repeat it.

**The gate, tested rather than assumed.** This plan's Dispatch Authorization states one condition: "Execution is armed only on the operator's own word, typed into the executing session's thread or relayed through the coordinator." That is one condition where the supervisor-peer plan's gate carried two, so the blocker recorded against that plan does not carry over by itself and was re-tested here rather than restated.

The operator's word exists. They asked for all three plans to be armed and run "in order." That authorizes this plan's execution and sequences it third. What is missing is not authorization but permission to depart from the order they gave, since plans 1 and 2 have not closed.

**The Assumptions line's third clause is unmet.** The dated assumption at the head of this plan's `## Assumptions` section bars it from running "never beside a plan that edits `bin/supervise.sh`, `bin/supervise-decide.mjs` or `hooks/index.ts`." `docs/plans/agent_persona_steward-architect_v1.md` edits two of those three and is blocked rather than closed. Its reversal clause hands the ordering to the operator at arming, and it reverses the sequencing clause only. It does not speak to the "beside" clause, so the reversal cannot be read as licensing this.

**The overlap, measured rather than estimated.** Read from `git diff origin/main...HEAD` on branch `steward-architect` at `2923cbe`, searched for the monitor's own identifiers (`contextBudget`, `CONTEXT_BUDGET`, `criticalTs`, `budget_opts`, `context_budget`).

- `bin/supervise.sh`: the steward plan's diff touches no monitor line. Seven monitor lines stand at `origin/main` for this plan to remove. Disjoint.
- `hooks/index.ts`: the steward plan's diff touches no monitor line. Thirty-eight monitor lines stand at `origin/main`. Disjoint.
- `bin/supervise-decide.mjs`: the steward plan does not touch the file at all. Five monitor lines stand. No overlap.
- `bin/agentic-common.sh`: three collision sites. At line 149 the steward plan rewrote the `options` JSON assembly to append its `$architect_opt`, and this plan must remove `$budget_opts` from that same line. At line 56 the monitor's entry in the `emit_settings_json` header comment abuts a steward hunk at lines 57 to 62. At lines 111 and 112 the four `CONTEXT_BUDGET_*` names in the numeric-validation loop abut a steward hunk at lines 107 to 108. The `budget_opts` blob itself, lines 69 to 81, sits clear of every steward hunk and deletes cleanly.

The first count taken here was one site rather than three. It came from searching the steward plan's diff for the monitor's own identifiers, which finds a collision only where both sides name the same thing. Two of the three sites are adjacency inside the three lines of context a merge reads, where the two sides name nothing in common. The method that finds them compares the steward plan's changed line ranges against the monitor's line positions at `origin/main`, and it is the one this entry's figures come from. The identifier search is recorded because it is the one that was wrong, and because it reported the other three files clear on the same evidence the range comparison independently confirms.

So the cost of running the two in parallel is three mechanical conflicts in one file: a comment line, two lines of a name list, and one long assembly line. It is a rebase rather than a structural conflict. That finding argues for running now. It does not decide it, because the order is the operator's.

**Rulings adopted since the last boundary.** One, carried in from the preceding plan and recorded in full in that plan's board: a gate's stated reason is not the gate, and a positional grant covers its stated scope only. That ruling is why this plan's gate was read as written here rather than through its evident purpose. Applying it in the other direction would be the same error: the "beside" clause bars this run on its own text, whatever its purpose, and the fact that the collision turns out to be one line does not narrow the clause.

**Asks in flight.** The operator holds the ordering question, sent to their thread with both options and a marked recommendation to run now. The repository's Expert seat was asked, before this declaration, whether a prior operator decision or memory record already settles whether a blocked plan counts as "beside." That ask does not gate and was unanswered at the time of writing. The coordinator seat holds a routing notice.

**Gate baseline.** None taken. No repository file changed beyond this plan document, so no test lane ran and there is no baseline to diff.

**Live dispatches.** None. No implementer, reviewer or scout is in flight.

**Next action.** Nothing, until the operator answers whether this plan may run out of the order they set. On a yes, Section 1 starts by cutting a branch off `origin/main`, repeating the Sweep section's two searches against that base, and amending Files in scope where a file has gained a mention. On a no, this plan waits for `docs/plans/agent_persona_steward-architect_v1.md` to close.

### Interim board 2 - 2026-09-18

Not a Chapter. Section 1 is still unstarted and no repository code changed.

**Stage.** The armed queue's leash advanced to this plan a second time, after `docs/plans/agent_persona_supervisor-peer_v1.md` was recorded blocked on its own arming gate. Nothing of this plan ran. The `Status:` header stays at `Ready`, for the reason board 1 gives.

**The preceding plan's blocker does not carry, and was tested rather than restated.** That blocker is the supervisor-peer plan's second arming condition, which requires the steward-architect plan to have closed. This plan's Dispatch Authorization carries no such condition. It carries one: the operator's own word. So that blocker stops nothing here and is not the ground below.

**What stops this plan now is the operator's own live instruction, which is a stronger and different ground than board 1 recorded.** Board 1 rested on the `## Assumptions` line's third clause, the bar on running beside a plan that edits `bin/supervise.sh`, `bin/supervise-decide.mjs` or `hooks/index.ts`, and it noted that the clause's reversal hands the order to the operator at arming. The operator has since exercised exactly that reversal. Asked this session whether the run should depart from the order they set, they answered that it should keep going on the steward-architect plan and reach this plan later.

So the ordering question board 1 sent up is answered, and the answer is no. This plan runs third, after the steward-architect plan closes. That word ranks above this plan's own assumption text, so the assumption's clause is no longer the operative bar and the measured overlap is no longer the operative argument.

**The overlap finding from board 1 still stands and is unchanged.** Three mechanical conflict sites in `bin/agentic-common.sh`, all in one file: a header comment line, two lines of a name list, and one long options-assembly line. That is a rebase rather than a structural conflict. It argued for running now and it did not decide it, because the order was the operator's. It now is.

**Gate baseline.** None taken. No repository file changed beyond this plan document, so no test lane ran and there is nothing to diff.

**Live dispatches.** None.

**Asks in flight.** None. Two were open when this entry was begun and both were answered before it was committed. The ordering ask board 1 recorded is answered no: this plan runs third. The steward-architect plan's Section 2 decision is answered no as well, which unblocks that plan rather than this one, so the ordering above is unchanged and that plan resumes ahead of the supervisor-peer plan and of this one.

**Next action.** Nothing, until the two plans ahead of this one close. Section 1 then starts by cutting a branch off `origin/main`, repeating the Sweep section's two searches against that base, and amending Files in scope where a file has gained a mention since.

### Interim board 3 - 2026-09-18

Not a Chapter. Section 1 is still unstarted and no repository code changed.

**Stage.** The armed queue's leash advanced to this plan a third time, after `docs/plans/agent_persona_steward-architect_v1.md` was recorded blocked on the review-round backstop in its Section 6. Nothing of this plan ran. The `Status:` header stays at `Ready`, for the reason board 1 gives.

**The preceding plan's blocker does not carry, and was tested rather than restated.** That blocker is a five-round review backstop inside the steward plan's own Section 6. It is a bound on that section's fix rounds and says nothing about this plan. So it stops nothing here and is not the ground below.

**What stops this plan is the operator's own recorded word, which board 2 already established and which this entry re-tested rather than assumed.** Board 2 recorded the operator answering that the run should keep going on the steward plan and reach this plan later. This run doubted that answer still applied, on the theory that it was given while the steward plan was still advanceable and that the situation had therefore changed. That doubt is wrong on the record. Line 131 of this document states that the steward plan's Section 2 decision was answered in the same exchange, which unblocks that plan. So the steward plan was blocked on an operator decision at the moment the operator was asked whether this plan could run meanwhile, and they said no. The situation is the same one, not a new one.

**A ruling this run relied on was misattributed, and the correction matters.** This run read a consultant ruling holding that the overlap between two plans is "a rebase rather than a block" and placed it in the steward plan's board, as a ruling about the steward plan and this one. It is at `docs/plans/agent_persona_supervisor-peer_v1.md:177`, and it rules on the overlap between the supervisor-peer plan and this one. The phrase appears nowhere in the steward plan. The misreading came from a diff hunk that was editing the supervisor-peer plan file, read as though it were content of the file being diffed against. No ruling licenses this plan to start beside the steward plan.

**The queue's advance is a mechanism and not an authorization.** The goal CLI's own status reports every queued plan's arming as this run's own rather than as an invocation the operator typed. So the leash advancing past a blocked plan moves a pointer. It does not stand in for the operator's word on the order, and this run's contrary reading is recorded here because it was wrong.

**Every plan behind this one is gated on the steward plan by its own text.** Read this session from each plan's own file. `docs/plans/agent_persona_lean-injection_v1.md:33` states "this plan cannot run before steward-architect", and `:27` states its target strings exist only on that plan's branch until it merges. `docs/plans/agent_persona_supervisor-peer_v1.md:13` requires every plan before it to have closed. `docs/plans/agent_persona_deferred-gate-run_v1.md:36` opens Section 1 by confirming the trunk carries the merge of every plan the gate policy covers. So the queue is one chain rather than five independent plans, and blocking here costs no runnable work: no later plan becomes available by skipping this one.

**A defect in this plan's own Section 1, found by this session's sweep and owed whenever the plan runs.** The Sweep section requires the executing session to repeat the searches against its own base and amend Files in scope. Done, against `origin/main` at `266b396`. Two files carry the monitor and are named nowhere in Section 1's Files in scope: `bin/supervise-poll.mjs`, with four lines, and `.kit/supervisor-poll-unit-test.mjs`, with three. The first is load-bearing rather than incidental. Section 1 says `bin/supervise.sh` loses "the store reader that finds the critical decision, and the argument that hands it to the decide unit". At `origin/main` that file carries only the four `CONTEXT_BUDGET_*` assignments at lines 307 to 310, and no `criticalTs`, `crossed` or `supervise-decide` reference at all. The store reader is at `bin/supervise-poll.mjs:100-101`, which selects the newest `context_budget_crossed` decision, and the handoff is at `:201`. So Section 1 as written removes the monitor from a file that does not hold it and leaves the reader standing in a file it never names. Both files join Files in scope, and the acceptance grep would have caught this at the section's end rather than at its start.

**Rulings adopted since the last boundary: one.** A consultant at fable ruled that this plan is declared blocked rather than run, and overturned two of the three legs this run's contrary framing rested on. Its grounds were checked here before adoption rather than taken from the report: the misattributed ruling was located at its true file and line, and the line establishing that the steward plan was blocked when the operator answered was read in this document. Its third correction, that the arming is the run's own, is confirmed from the goal CLI's own status output rather than from this run's failed probe of the goal state file, which used wrong field names and returned nothing. That probe proved nothing and no claim here rests on it. The ruling also holds that no single whole-queue declaration exists, because the Stop hook consumes one declaration per stop and advances one plan.

**Gate baseline.** None taken. No repository file changed beyond this plan document, so no test lane ran and there is nothing to diff.

**Live dispatches.** None. The consultant named above has returned and no implementer, reviewer or scout is in flight.

**Asks in flight.** One, to the repository's Expert seat, asking whether any prior operator decision or memory record settles whether a plan stopped on a blocker counts as running "beside" another. It does not gate and was unanswered at the time of writing. Board 1 records an identical ask to the same seat that also went unanswered.

**Next action.** Nothing, until the operator answers the steward plan's Section 6 backstop brief. That one answer releases this plan and the three behind it. On the operator's word that this plan should instead run in parallel, Section 1 starts by cutting a branch off `origin/main`, repeating the Sweep section's two searches against that base, and amending Files in scope with the two files named above.
