# agentic-plugin docs

## Active plans

- `plans/agent_persona_process-keeper_v1.md`: Process keeper (each persona under a Windows scheduled task that starts at boot with no logon, a wrapper that relaunches or holds on the supervisor exit code with a growing delay, and the three supervisor self-heal fixes the keeper depends on). In Progress; handed to the dev persona.
- `plans/agent_persona_steward-architect_v1.md`: Steward and architect (split the Fable coordinator persona into a Sonnet steward that keeps the fleet running and holds the kit Coordinator seat, and a Fable architect with no home repository that does design work when asked). Ready, parked for the operator's read; runs after the process keeper.

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
- `archive/agent_persona_coordinator_v2.md`: Coordinator (a Fable-tier coordinator persona directing many worker personas across repos over the commons-store inbox path: cross-repo status, addressing by persona, provenance labels, the inbox lifecycle, arming tiers, the worker and coordinator standing instructions, the test audit). Complete; the most recent plan.
- `archive/agentic-plugin_context-budget_v1.md`: Context budget (thresholds, the close-out nudge, and the coordinator's compaction-boundary clause in the priming turn). Complete.

## History

- `archive/discussion/`: the review channel between the worker sessions and the reviewer session that built this plugin, every round through 166, with the gate logs the rounds cite. See its README.
- `backlog.md`: open defects and design directions, each with its remedy; retired entries move to a quarterly snapshot, `archive/backlog-2026-Q3.md` (the earlier one-off is `archive/backlog-2026-09-11.md`).
