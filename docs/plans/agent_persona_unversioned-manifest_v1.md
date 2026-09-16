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

### Chapter 1 - 2026-09-16
Completed: 1. Remove the version field
Implemented By: main session (the coordinator persona, inline; the section is one key and one README paragraph)
Metrics: review rounds 1, closed claim-exit; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The header was normalized from `Status: Ready` to `Status: In Progress` at start. The worker line changed from the queued `dev` persona to the coordinator persona on the operator's instruction of 2026-09-16, so the coordinator regains a labelled steer channel before the process keeper plan closes; the plan is disjoint and ran in its own worktree at `D:/agent_persona-wt/unversioned-manifest` on branch `unversioned-manifest`, so the `dev` persona's checkout was never touched. The plugin manifest's one `version` line is deleted and every other key stands. The step 2 sweep found no sentence in README or `docs/` telling a reader to bump the version, so nothing was rewritten on that ground; what the README did carry was a promise at its install paragraph that the installed runtime always tracks merged main, which the version field made false, so that paragraph now states the observed cache shape: a versioned manifest installs under a folder named by the version and is rebuilt only when it changes, an unversioned one installs under the fetched commit's hash, one folder per update, the shape the kit plugin already uses. That shape is read from this machine, where the kit plugin's manifest carries no version and its cache holds one twelve-hex folder per update with the install record naming the hash as the version, while this plugin's cache holds a single `0.10.0` folder built at a commit before the steer tool's persona argument merged. Two README labels still naming `v0.11.0` were dropped in the close pass so the file does not contradict its own no-version paragraph. The security lens was not dispatched: the manifest key is package metadata no hook or script reads, which the adversarial and blind lenses each confirmed by sweep, and nothing in the delta touches a boundary the trigger list names.
Assumptions: none
Review Findings: `review: code pair at fable, Agent tool`; Critical/Major none; Minors: 4 raised, 3 fixed in the close pass (the README cache-keying sentence restated as the observed folder shape in short sentences, which closed the adversarial lens's unverifiable-claim and long-sentence findings and the blind lens's matching claim finding together; the two `v0.11.0` labels dropped), 1 left with the reason (the adversarial lens's reminder that the Chapter must carry the lane and exit code, which this Chapter does). The close-pass delta is README prose only and was read by its author, not by a review round.
Stamps: adjudicated 4 (3 project, 1 operator), stamped 1 project (the-installed-plugin-cache-can-lag-the-repo-source-at-the-same-version-number, which named the trap and the fallback route weighed against the peer channel); the rest were read for the coordinator's other work in the window and did not shape this section.
Gate: targeted lane, `tsc --noEmit` exit 0 and `bash .kit/settings-plugin-key-test.sh` PASS exit 0, measured by the main session on 2026-09-16 in the worktree at 869c818 plus the close-pass README edits, run beside the `dev` persona's live heavy-process claim (its implementer, expected 1800 seconds) on the ground that both lanes complete in seconds. Baseline on the same lanes at f3ca687 before any edit: settings suite PASS exit 0; the typecheck could not run at baseline because the worktree carried no node_modules, and the post-edit run used the main checkout's TypeScript, so the typecheck has a green reading and no baseline of its own. Contention lane: not run; the delta writes no machine-shared state. The live suites were not run; they are operator-only while the fleet is up.
Next: 2. Prove the install rebuilds, which is the operator's hand: merge the pull request, run the plugin update and reinstall, relaunch the personas, then the coordinator proves the new copy by steering `dev` through `agentic_say` with the persona argument and records both `installed_plugins.json` values here.
Commit Model: Branch-and-PR
Delta: measured by the main session on 2026-09-16 in the worktree at 869c818 plus the close-pass edits, no machine or contention of its own since the verb reads the tree.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Chapter 2 - 2026-09-16
Completed: 2. Prove the install rebuilds
Implemented By: main session (the coordinator persona, inline; the operator's hand did the merge, the plugin update and the relaunch, and the coordinator took the readings)
Metrics: review rounds 0, closed clean; provenance 0 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises: The install record at `~/.claude/plugins/installed_plugins.json`, read by the main session on 2026-09-16, names `installPath` ending `cache\agent-persona\agentic-plugin\bd2dc3594573`, `version` `bd2dc3594573`, and `gitCommitSha` `bd2dc3594573b647b3c366aeb0d689ec454e1075`, which is the merge commit of pull request 34 on `main`. Its `installedAt` reads `2026-09-14T13:41:20.469Z`, a date before either update, so that field is the first install's and not the update's. The cache directory `~/.claude/plugins/cache/agent-persona/agentic-plugin/` holds three folders: `0.10.0`, `ee03b48057da` and `bd2dc3594573`. Two updates since the manifest lost its version each produced a folder named by the fetched commit, which is the shape the Goal asks for. The goal record that launched this session stated the install path and sha as `ee03b48057da`, read by the operator on 2026-09-16; that is the earlier of the two hash folders, and the install record moved to `bd2dc35` when pull request 34 merged and the plugin was updated again, so the goal's values are the prior reading and this Chapter records the current one. The probe: `agentic_say` with `persona` `dev` and a text naming itself a delivery probe returned `Message sent to owner of dev (id: dev-<this session>-1)`, a delivery rather than a refusal. The `0.10.0` build predates the `persona` argument, so the delivery is the proof the plan asked for that the running copy is a post-merge build. The record was left unresolved by design, as a probe. Which cache folder this session's own plugin process loaded could not be read from the process list, since no process command line on the box matched the plugin's path; the folder is inferred to be `bd2dc3594573` from the install record, and the delivery does not depend on which of the two hash folders it is. The worktree `D:/agent_persona-wt/unversioned-manifest-s2` on branch `unversioned-manifest-s2` off `origin/main` at `bd2dc35` was cut before this session and found clean at start. The section's delta is this Chapter alone; no code changed, so its review rides the finishing pass's combined lens rather than a round of its own.
Assumptions: none
Review Findings: none of its own; the finishing pass's lenses read this Chapter with the rest of the changeset (`blind: no code diff`)
Stamps: adjudicated 36 (18 project, 18 operator) from `memq unstamped --since 2d`, stamped 0: every listed read belongs to the `dev` persona's process-keeper run in the same window, and none shaped this section, whose facts came from the install record, the cache directory and the probe
Gate: targeted lane, `tsc --noEmit -p .` exit 0 (the worktree has no `node_modules`, so the main checkout's TypeScript ran it) and `bash .kit/settings-plugin-key-test.sh` PASS exit 0, measured by the main session on 2026-09-16 in the worktree at `bd2dc35` before this Chapter's edit, run beside the `dev` persona's live heavy-process claim (`implementer-s4-r5`, expected 1500 seconds) on the ground both lanes complete in seconds. Baseline on the same lanes: Chapter 1's readings at `869c818`, both green, so the delta is green to green. The section's own edit is prose, which neither lane reads. Contention lane: not run; the delta writes no machine-shared state.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: measured by the main session on 2026-09-16 in the worktree at `bd2dc35` before this Chapter's edit, no machine or contention of its own since the verb reads the tree.
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
