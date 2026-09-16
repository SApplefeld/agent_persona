# Agentic plugin: drop the manifest version so every install runs the current commit

Status: In Progress
Commit Model: Branch-and-PR
Disjoint: yes
Created: 2026-09-15
Worker: the coordinator persona, on the operator's instruction of 2026-09-16 to run it ahead of the queue rather than wait for the `dev` persona to finish the process keeper plan (`agent_persona_process-keeper_v1.md`), so the coordinator regains a working steer channel sooner.

## Goal

A plugin update installs the commit it fetched. Today the manifest at `.claude-plugin/plugin.json` carries a version string, and Claude Code keys its plugin cache on that string, so an update that ships new commits under an unchanged version advances the marketplace clone and leaves the cache build, the copy every persona runs, at the old commit. The kit plugin has no version field and its cache rebuilds into a hash-named folder on every update. This plugin takes the same shape.

## Decisions taken at scoping (2026-09-15)

**Remove the field rather than bump it per commit.** A bump is a release step a worker forgets, and the failure when one is forgotten is silent: the update reports success and the old code runs. The operator chose removal over the bump on the coordinator's recommendation.

**Nothing in the repository reads the version.** A sweep of the hook source and every script under `bin/` for a read of a version field found none, with the manifest itself as the control that the pattern speaks. The only consumer is Claude Code's own debug log line, which carries no version afterward.

## Sections of Work

### Section 1: remove the version field

Model: inline. One key deleted from one JSON file.

1. Delete the `version` key from `.claude-plugin/plugin.json`. Leave every other key as it is.
2. Search the repository's README and `docs/` for any sentence that tells a reader to bump the version on release, and rewrite it to state the current rule: the manifest carries no version and the cache is keyed by commit.
3. Run the plugin's own test suite as the targeted lane and read its exit code.

### Section 2: prove the install rebuilds

Model: inline, with the operator's hand for the install and the relaunch.

1. After the pull request merges, the operator updates the marketplace and reinstalls the plugin. `~/.claude/plugins/installed_plugins.json` then names an install path under `~/.claude/plugins/cache/agent-persona/agentic-plugin/` whose last segment is a hash rather than `0.10.0`, and whose `gitCommitSha` is the merged commit. Record both values in the Chapter.
2. The operator relaunches the personas. From the coordinator's seat, `agentic_say` with the `persona` argument reaches the dev persona without a reader join. That call is the proof the running copy is the new one, and the Chapter records it.

## Out of Scope

- Pruning old hash folders from the cache. That is the kit's plugin cache sweep plan in the claude-kit repository, `docs/plans/claude-kit_plugin-cache-sweep_spec_v1.md`.
- Any change to the plugin's tools or hooks.

## Operator Verification

After Section 2, the personas run the merged commit, which the coordinator proves by addressing dev directly. The old `0.10.0` cache folder can stay until the sweep plan lands.

## Chapters
