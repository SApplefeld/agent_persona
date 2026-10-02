# The plugin is renamed from `agentic-plugin` to `personas`, its tools with it, and the kit is read under `grimoire` alone

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-02

## Dispatch Authorization

The ARCHITECT persona wrote this plan on 2026-10-02 on the operator's ruling of that day on the ARCHITECT's channel: "I would like to rename agentic-plugin to personas. It's what we call it anyway and it feels more descriptive." It is the third of the four plans that rename the kit and this plugin, and it has one precondition, on dispatch: the kit's rename plan, `claude-kit_grimoire-rename_spec_v1.md` in the kit repository, has merged, and the operator has confirmed on the ARCHITECT's channel or the coordinator's that every fleet host runs the kit under `grimoire`. Section 2 drops the old kit name the tolerance plan admitted, so a host still on the old kit would lose its memory calls and skills. The coordinator queues it for this repository's worker once the precondition holds. The whole fleet stops for the cutover under `## Operator Verification`, since the plugin's tool names and its machine-wide store file change with its name.

## Goal

The plugin's name is `personas` everywhere the name is read: the manifest, the marketplace entry, the install id `personas@agent-persona`, the tool names `mcp__personas__<tool>` the engine registers from the manifest name, the `$.state` key and the types file that declares it, the two plugin ids the supervisor writes options under, the store file names the supervisor and the live suites glob for, and the liaison's permission template. The marketplace carries a `renames` map so Claude Code rewrites each host's settings on its own, and the supervisor rewrites each run directory's settings file, which the engine's migration does not reach. The plugin finds the kit under `grimoire@applefeld` alone and the supervisor primes every child with `grimoire:` skills, with the tolerance for the old kit name gone. The offline suites are green under the new names, the live suites launch children under them, and a search for the old token outside history finds only the renames map and the one reader of recorded transcripts that must know both.

## Intent

The frame, in the operator's words of 2026-10-02: "Disagree. I would like to rename agentic-plugin to personas. It's what we call it anyway and it feels more descriptive." The ARCHITECT's reading, sent to him the same day and not contradicted: the plugin's tool names carry the plugin name, so every tool the coordinator and workers call changes its name, and the supervisor's own settings files and the permission lists on each host change with them, a full sweep of this repository rather than a manifest edit. The same plan drops the old kit name once the fleet is on Grimoire, which the operator's four rulings ordered.

What done needs to do. Every tracked file outside history carries `personas` where it carried `agentic-plugin`, the types file moves with it, and the marketplace maps the old name to the new. The supervisor migrates a run directory's settings file from the old plugin ids to the new at launch. The one reader of recorded transcripts classifies tool calls under either prefix, since transcripts from before the rename stay on disk. The kit lookup and the priming text read `grimoire` alone. The cutover steps are written for the operator, host by host.

What done does not need to do. It does not rename the marketplace `agent-persona`, which the operator did not ask for and which no host-side migration covers. It does not touch the client sandbox runbook beyond the install id, since the public marketplace plan rewrites its install section. It does not rewrite archived plans or the gold fixtures under `.kit/fixtures/`, which are recorded history. It does not carry the old store file's claims forward, since the fleet is stopped for the cutover and a stopped fleet holds no live claim.

Alternatives refused. Keeping `agentic-plugin` and setting `displayName` to Personas, which the documentation offers as the rename that breaks nothing: refused, since the operator asked for the name itself and the tool names would stay as they are. Renaming the marketplace too: refused, since it widens the host migration past what the renames map covers for no ruling. Migrating the old store file's contents: refused, since the fleet is down at the cutover and the file holds live claims only.

Rulings after the spec shipped: none yet.

Provenance: written by the ARCHITECT persona, session 57239bb8, on 2026-10-02, with the name run through this machine's installed 2.1.287 validator and the renames mechanism read from the Claude Code host-marketplace documentation the same day.

## Approach

**The token and its exclusions.** The sweep replaces the exact token `agentic-plugin` with `personas` in every tracked file except `docs/archive/`, `docs/plans/archive/`, `.kit/fixtures/`, and this plan. The counts at origin/main 0245191: 88 tracked files carry the token, 55 of them under `docs/`, 20 under `.kit/`, four under `hooks/`, three under `bin/`, two each under `skills/` and `.claude-plugin/`, and `README.md` and `.claude/types/claude-code-mcp.d.ts`. One tracked path spells it, `hooks/agentic-plugin.d.ts`, which `git mv` takes to `hooks/personas.d.ts`, and `.claude-plugin/plugin.json`'s `types` field follows. The recipe, from the repository root under Git Bash: `git mv hooks/agentic-plugin.d.ts hooks/personas.d.ts`, then `git ls-files -z | grep -zv -e '^docs/archive/' -e '^docs/plans/archive/' -e '^.kit/fixtures/' -e '^docs/plans/agent_persona_personas-rename_spec_v1.md$' | xargs -0 sed -i 's/agentic-plugin/personas/g'`. The worker reads `git ls-files --eol` before and after, since Git Bash `sed -i` strips carriage returns from a CRLF file, and restores any file whose endings moved. The hooks are TypeScript compiled by the engine, so `npx tsc --noEmit` is the first gate after the sweep.

**What the engine derives from the name, confirmed on this host.** A tool the plugin registers as `goal_done` is called `mcp__agentic-plugin__goal_done`, so the prefix is `mcp__<manifest name>__`. The store file the engine keeps for the plugin is `~/.claude/plugins/store/agentic-plugin_agent-persona-<hash>.json` for the installed copy and `agentic-plugin_inline-<hash>.json` under `--plugin-dir`, so the prefix is the manifest name. The `$.state` namespace is the manifest name, `$.state.get({ plugin: "agentic-plugin", key: "memqLaunchDir" })` at `hooks/index.ts:5585` and `:5598`, declared in the types file as `PluginState["agentic-plugin"]`. The install id is `<entry name>@<marketplace name>`. All four follow the sweep, and the live suite is what proves the engine agrees.

**The marketplace, `.claude-plugin/marketplace.json`.** The entry's `name` becomes `personas`, `source` stays `.`, and the file gains a top-level `"renames": { "agentic-plugin": "personas" }`. The documentation read on 2026-10-02 states that Claude Code then loads the plugin under the new name, shows the rename notice once, rewrites the old key in `enabledPlugins` and `pluginConfigs` in the user, project and local settings files, and for a git-hosted marketplace reports the plugin not cached until the host runs `claude plugin install personas@agent-persona` once. The marketplace name `agent-persona` stays.

**The supervisor, `bin/agentic-common.sh`.** `AGENTIC_PLUGIN_DEV_ID` and `AGENTIC_PLUGIN_INSTALLED_ID` at `:28` and `:29` become `personas` and `personas@agent-persona`, and the eight sites that take them, `:407` to `:858`, change nothing. `ensure_settings_plugin_ids` at `:420` today copies options from whichever of the two ids carries them to the one that lacks them. It gains the migration the engine does not perform on a `--settings` file: where the file carries options under `agentic-plugin` or `agentic-plugin@agent-persona` and under neither new id, it copies those options to both new ids, every option as written, and leaves the old keys in place, since a key the engine no longer reads costs nothing and deleting it is a second decision. A file already carrying either new id takes the existing copy rule and the old keys are not read. `find_global_store` at `:905` and `list_installed_stores` at `:940` glob `personas_inline-*.json` and `personas_*.json`, and the comment block at `:889` names the new shapes. `bin/supervise.sh:11`, `:4525` and `:4526` and `bin/upgrade-check.mjs:94`'s `PLUGIN_NAME` take the sweep.

**The hooks.** `hooks/index.ts` carries the tool prefix at `:2129`, `:2607` and the twenty-one handlers from `:11155` to `:12880`, and the `$.state` namespace at `:5585` and `:5598`; all take the sweep, since each reads a live event the engine names under the new prefix. `hooks/personas.d.ts` declares `PluginState["personas"]`. `hooks/commons.ts:1` and `hooks/operator.ts:1` are comments. `hooks/question-catalog.ts:389`'s wrapper already matches any plugin name and changes nothing.

**The one reader of recorded transcripts.** `.kit/jev-gold/sample.mjs:383` and `:406` classify tool calls read from transcripts on disk, and the gold fixtures under `.kit/fixtures/jev-gold/` carry the old prefix. Both sites accept either prefix, `mcp__personas__` or `mcp__agentic-plugin__`, with a comment naming the fixtures as the reason. `.kit/jev-gold-unit-test.mjs` keeps its old-prefix inputs at `:182`, `:1392`, `:1494` and `:1501` as the pin that the old prefix still classifies, and gains the same four under the new prefix.

**The liaison template, `docs/liaison-settings.template.json`.** The five `mcp__agentic-plugin__` tool names in `allow` take the sweep. A host running a liaison carries a copy of this file, which the operator re-makes at the cutover.

**The tests.** `.kit/settings-plugin-key-test.sh` seeds `pluginConfigs` under the two ids throughout, 65 lines, and takes the sweep; it gains cases for the migration: a file with options under the old dev id only ends with those options under both new ids and the old key kept; the same for the old installed id; a file with options under an old id and a new id leaves every key byte for byte; a file with neither is created as today. `.kit/controller-tick-test.mjs`, 295 lines carrying the token as tool names and in `tick-harness.mjs:270`'s plugin name, takes the sweep. The live suites `.kit/live-commons-test.sh:92`, `live-goaltree-test.sh:47`, `live-operator-test.sh:98` and `:99`, `live-restartrequest-test.sh:131` pass tool names on `--allowedTools` and take the sweep, as do the store names in `live-all.sh:78`, `persona-live-refuse-test.sh:66`, `supervisor-model-test.sh` and `supervisor-natural-exit-test.sh`. `.kit/fleet-status-unit-test.mjs` and `.kit/question-catalog-unit-test.mjs` take the sweep.

**The kit's name, section 2.** `KIT_PLUGIN_KEYS` in `hooks/index.ts`, which the tolerance plan introduced, returns to one constant `KIT_PLUGIN_KEY = "grimoire@applefeld"`, and `kitInstallPathOf` walks one key with the three narrower skips the tolerance plan collapsed restored under the new name. `kit_skill_prefix` leaves `bin/agentic-common.sh`, and the four sentences in `bin/supervise-holder.sh` spell `grimoire:` in place of `${KIT_SKILL_PREFIX}:`. The tick suite's old-key cases retire and the new-key cases stay. `.kit/channel-reply-instruction-test.sh` runs under one prefix and its `kit_skill_prefix` case retires. `README.md`'s two lookup sentences name one key.

**The sweep's control.** After the sweep, `git grep -n -- 'agentic-plugin'` outside the four exclusions must find only the marketplace renames line, the two sites in `.kit/jev-gold/sample.mjs` with their comment, the four old-prefix pins in `.kit/jev-gold-unit-test.mjs`, the migration in `ensure_settings_plugin_ids` and its cases in `.kit/settings-plugin-key-test.sh`. The control is a tracked file carrying the token, written under `skills/` and added to the index before the sweep is re-run, which the sweep must change; the worker removes it before the commit and the Chapter records both.

## Sections of Work

### 1. The plugin, its tools, its store and the supervisor's settings carry the new name

Model: opus

Acceptance:
- `claude plugin validate .` ends `Validation passed`, exit 0, on 2.1.287, and `npx tsc --noEmit` exits 0.
- The offline suites, `node .kit/controller-tick-test.mjs`, `sh .kit/settings-plugin-key-test.sh`, `node .kit/fleet-status-unit-test.mjs`, `node .kit/jev-gold-unit-test.mjs`, `node .kit/question-catalog-unit-test.mjs`, `sh .kit/supervisor-model-test.sh`, `sh .kit/persona-live-refuse-test.sh` and `sh .kit/channel-reply-instruction-test.sh`, are green against the baseline recorded before the section's first edit, with counts and any failing names in the Chapter.
- The four migration cases in `.kit/settings-plugin-key-test.sh` are red against the unedited `ensure_settings_plugin_ids` and green after, both runs in the Chapter.
- The four new-prefix cases in `.kit/jev-gold-unit-test.mjs` are red against the unedited `sample.mjs` and green after, and the four old-prefix pins stay green throughout.
- `sh .kit/live-commons-test.sh` and `sh .kit/live-goaltree-test.sh`, run under `--plugin-dir` on this checkout with every persona stopped, pass, and the store file the run leaves under `~/.claude/plugins/store/` is named `personas_inline-<hash>.json`, its name in the Chapter. The live run is the proof that the engine derives the tool prefix, the store name and the state namespace from the manifest name.
- `git grep -n -- 'agentic-plugin'` outside the four exclusions finds only the sites `## Approach` lists under the sweep's control, each in the Chapter.
- `git ls-files --eol` reads the same endings per file before and after, both in the Chapter.
- The Chapter carries the exact commands run.

Files in scope: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/agentic-plugin.d.ts` moved to `hooks/personas.d.ts`, `hooks/index.ts`, `hooks/commons.ts`, `hooks/operator.ts`, `bin/agentic-common.sh`, `bin/supervise.sh`, `bin/upgrade-check.mjs`, `.kit/*.sh`, `.kit/*.mjs`, `.kit/jev-gold/sample.mjs`, `.kit/tick-harness.mjs`, `README.md`, `skills/restart-recap/SKILL.md`, `skills/upgrade-check/SKILL.md`, `docs/README.md`, `docs/backlog.md`, `docs/client-sandbox.md`, `docs/liaison-settings.template.json`, `docs/security-model.md`, `.claude/types/claude-code-mcp.d.ts`.
Tests: the settings migration both ways, since a run directory the engine never rewrites would otherwise launch a persona named `default` with default cadences; the transcript reader under both prefixes, since the gold fixtures and every pre-rename transcript carry the old one; the live launch under the new name, since the prefix, the store name and the state namespace are the engine's derivations and no offline test can see them.

### 2. The kit is read under `grimoire` alone

Model: sonnet

Acceptance:
- `node .kit/controller-tick-test.mjs` passes whole, with the old-key cases retired and the new-key cases green, and `sh .kit/channel-reply-instruction-test.sh` passes under the one prefix.
- `git grep -n -- 'claude-kit'` over the tree outside `docs/archive/`, `docs/plans/archive/` and `.kit/fixtures/` returns nothing.
- `git grep -n -- 'KIT_SKILL_PREFIX\|kit_skill_prefix\|KIT_PLUGIN_KEYS' -- bin hooks .kit` returns nothing.
- The offline suites are green against the section 1 baseline.

Files in scope: `hooks/index.ts`, `bin/agentic-common.sh`, `bin/supervise-holder.sh`, `bin/supervise.sh`, `.kit/controller-tick-test.mjs`, `.kit/channel-reply-instruction-test.sh`, `README.md`.
Tests: the new-key cases staying green, since they are the only pin left on the lookup.

## Out of Scope

- The marketplace name `agent-persona`.
- The public marketplace, the publish jobs and the privatizing: the fourth plan, which also rewrites the client sandbox runbook's install section and moves this plugin out of the repository root.
- Archived plans, `docs/plans/archive/`, and the gold fixtures under `.kit/fixtures/`, which are recorded history.
- The old store file each host's engine leaves under `~/.claude/plugins/store/`, orphaned at the cutover and holding no live claim.
- The kit repository's and the relay repository's mentions of `agentic-plugin`: the kit's kaizen inbox note and the relay's test label `agentic-plugin-builder`, which is a session label and not the plugin.

## Assumptions

- assumed 2026-10-02 (source: this host's `~/.claude/plugins/store/` listing, `hooks/index.ts:5585` and the tool names this session calls): the engine derives the tool prefix, the store file name and the `$.state` namespace from the manifest name; reversal: a live run under the new name that registers tools under another prefix, which stops the plan at section 1's live bullet.
- assumed 2026-10-02 (source: the Claude Code host-marketplace documentation, read that day): the renames map rewrites `enabledPlugins` and `pluginConfigs` in the settings scopes and not in a `--settings` file; reversal: an engine that rewrites the run directory's file too, which makes the supervisor's migration a no-op that stays.
- assumed 2026-10-02 (default): old plugin-id keys stay in a migrated run directory settings file; reversal: delete them in a later change if a reader ever trips on them.
- assumed 2026-10-02 (default): the fleet is stopped for the cutover rather than rolled one host at a time, since the coordinator and every worker must agree on the tool names in the same hour; reversal: none needed.
- assumed 2026-10-02 (default): the blind read and the plan review run on this spec, since its reach is every running persona.

## Operator Verification

- The cutover, after this merges, with every supervisor stopped: on each host, run `claude plugin marketplace update agent-persona`, start one session and read the rename notice, run `claude plugin install personas@agent-persona` where the session reports the plugin not cached, re-make any liaison settings file from `docs/liaison-settings.template.json`, then relaunch the supervisors. Each supervisor's launch migrates its run directory's settings file. A persona whose first turn reports tools it cannot find reopens section 1.
- Confirm on the ARCHITECT's channel that every host runs the kit under `grimoire` before the coordinator dispatches this plan.

## Open Questions

- None.

## Related

- `agent_persona_kit-name-tolerance_spec_v1.md`: the first plan, whose tolerance section 2 retires.
- `claude-kit_grimoire-rename_spec_v1.md` in the kit repository: the second plan, which this one waits on.

## Chapters
