# agentic-plugin docs

## Reference

- `architecture.md`: how the plugin, the supervisor and the process keeper fit together: each layer's process, what it owns and writes, the boot-time data flow, the keeper's roster, env file, policy and state files, the supervisor self-heal paths the keeper depends on, the external integrations, and the failure modes by layer. `README.md` at the repository root is the operator-facing reference each section points back to.

## Active plans

- `plans/agent_persona_steward-architect_v1.md`: Steward and architect (split the Fable coordinator persona into a Sonnet steward that keeps the fleet running and holds the kit Coordinator seat, and a Fable architect with no home repository that does design work when asked). Ready, parked for the operator's read; next in the running order.
- `plans/agent_persona_supervisor-peer_v1.md`: Supervisor as peer (the supervisor judges its child gone only on five silent signals together and after one final ask, never restarts a child whose output names a usage limit, turns off the harness usage-limit pause for supervised children, puts a deliberate shutdown to the child through a run-directory mailbox it answers at a boundary, launches the child under a holder process so it outlives the supervisor, adopts a live child at start, and keeps the kill as the last rung). Ready, parked behind the steward-architect plan.
- `plans/agent_persona_context-budget-removal_v1.md`: Context-budget monitor removal (the plugin stops estimating a session's context and sending a close-out turn, the supervisor stops restarting a child on a critical crossing, and context is left to the harness's compaction and the kit's gate). Ready, parked behind the steward-architect plan.
- `plans/agent_persona_lean-injection_v1.md`: Lean injection (every prompt the plugin or supervisor writes into a session, and every tool description, says only what its reader cannot already know and points at the owner for the rest, with a duplicate-sentence test and a size ledger as the guard). Ready, parked behind the steward-architect and context-budget-removal plans and ahead of the supervisor-peer plan.
- `plans/agent_persona_deferred-gate-run_v1.md`: Deferred gate run (the runs that hold the box, the live suites and the driven supervisor suite, are deferred from every queued plan to one whole gate after the last of them merges, with each red traced to its plan and fixed or filed; it owns the gate policy the four plans cite). Ready, parked last.

## Archived plans

- `archive/agentic-plugin_goal-tree_v1.md`: Stage 1 goal tree and plan selection (v0.6.4, commit 2ef521d). Complete.
- `archive/agentic-plugin_env-monitor_v1.md`: Stage 2 env monitor (git probe, health run, error streak) (v0.7.0, commit a271805). Complete.
- `archive/agentic-plugin_live-test-runner_v1.md`: Live-test runner (parallel execution, per-suite dirs, cadence profiles) (v0.8.0, commit 3f316ec). Complete.
- `archive/agentic-plugin_commons_v1.md`: Commons (shared claims and coordination, first-claim-wins arbitration, epoch as write fence) (v0.9.0, commit 63a8705). Complete.
- `archive/agentic-plugin_self-review_v1.md`: Self-review (reactive lessons from the decision log, error-streak trigger, injected on the next prompt) (v0.10.0, commit c7722e3). Complete.
- `archive/agentic-plugin_cost-cadence_v1.md`: Cost and cadence (the plugin's own spend ledger, nudge caps, idle backoff) (v13, commit d92b8f2). Complete.
- `plans/archive/agentic-plugin_supervisor_v1.md`: Supervisor (the outer loop that relaunches a persona session across days-long runs). Complete.
- `plans/archive/agentic-plugin_operator-channel_v1.md`: Operator channel (inbox, reply, ask waits, doorbell) (v17, commit e98c20f). Complete.
- `archive/agent_persona_passive-supervisor_v1.md`: Passive supervisor (the plugin persona starts with no goal and waits, takes goals and steering by conversation, returns to waiting between goals, and is reachable from a chat channel). Complete; its close-out ran as the coordinator plan's Section 0.
- `archive/agent_persona_coordinator_v2.md`: Coordinator (a Fable-tier coordinator persona directing many worker personas across repos over the commons-store inbox path: cross-repo status, addressing by persona, provenance labels, the inbox lifecycle, arming tiers, the worker and coordinator standing instructions, the test audit). Complete.
- `archive/agentic-plugin_context-budget_v1.md`: Context budget (thresholds, the close-out nudge, and the coordinator's compaction-boundary clause in the priming turn). Complete.
- `archive/agent_persona_unversioned-manifest_v1.md`: Unversioned manifest (the plugin manifest carries no version field, so each plugin update installs the fetched commit under a hash-named cache folder; proven by the install record and a coordinator steer to the dev persona). Complete.
- `archive/agent_persona_process-keeper_v1.md`: Process keeper (each persona under a Windows scheduled task that starts at boot with no logon, a wrapper that relaunches or holds on the supervisor exit code with a growing delay, and the supervisor self-heal fixes the keeper depends on). Complete; the most recent plan. Registering the tasks is the operator's own elevated act and is listed under its Operator Verification.

## History

- `archive/discussion/`: the review channel between the worker sessions and the reviewer session that built this plugin, every round through 166, with the gate logs the rounds cite. See its README.
- `backlog.md`: open defects and design directions, each with its remedy; retired entries move to a quarterly snapshot, `archive/backlog-2026-Q3.md` (the earlier one-off is `archive/backlog-2026-09-11.md`).
