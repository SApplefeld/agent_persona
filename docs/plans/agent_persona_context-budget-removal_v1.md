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
