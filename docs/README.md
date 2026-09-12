# agentic-plugin docs

## Active plans

- `plans/agent_persona_passive-supervisor_v1.md`: the supervisor starts with no goal and waits, takes goals and steering by conversation, returns to waiting between goals, and is reachable from a chat channel. Roadmap for the plugin's own persona working on this clone. In Progress; the close-out finishing pass is v2's own Section 0. See also `plans/agent_persona_coordinator_v2.md`.
- `plans/agent_persona_coordinator_v2.md`: a Fable-tier coordinator persona that directs and assists many Sonnet-tier worker personas across repos, over an extended commons-store inbox path. Builds on v1's persona/commons/channel infrastructure. In Progress.

## Archived plans

- `archive/agentic-plugin_goal-tree_v1.md`: Stage 1 goal tree and plan selection (v0.6.4, commit 2ef521d). Complete.
- `archive/agentic-plugin_env-monitor_v1.md`: Stage 2 env monitor (git probe, health run, error streak) (v0.7.0, commit a271805). Complete.
- `archive/agentic-plugin_live-test-runner_v1.md`: Live-test runner (parallel execution, per-suite dirs, cadence profiles) (v0.8.0, commit 3f316ec). Complete.
- `archive/agentic-plugin_commons_v1.md`: Commons (shared claims and coordination, first-claim-wins arbitration, epoch as write fence) (v0.9.0, commit 63a8705). Complete.
- `archive/agentic-plugin_self-review_v1.md`: Self-review (reactive lessons from the decision log, error-streak trigger, injected on the next prompt) (v0.10.0, commit c7722e3). Complete.
- `archive/agentic-plugin_operator-channel_v1.md`: Operator channel (inbox, reply, ask waits, doorbell) (v17, commit e98c20f). Complete.

## History

- `archive/discussion/`: the review channel between the DeepSeek Harness and the reviewer session that built this plugin, rounds 1 through 101, with the gate logs the rounds cite. See its README.
