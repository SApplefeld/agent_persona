# The persona plugin publishes its runtime folder to the public marketplace repository on a tag, and the supervisor and the runbook install it from there

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-02

## Dispatch Authorization

The ARCHITECT persona wrote this plan on 2026-10-02 as the persona repository's instance of the public distribution design the kit repository's `claude-kit_public-marketplace_spec_v1.md` carries, on the operator's decisions of 2026-09-28 and his rulings of 2026-10-02. It has one precondition, on dispatch: `agent_persona_personas-rename_spec_v1.md` has merged, so the plugin is `personas`. The coordinator queues it for this repository's worker then. The kit's plan need not have merged, since the two repositories' jobs are independent until the first publish, whose order the kit's plan states. While this repository is public, no commit, pull request, Chapter or brief on this plan spells any word on the banned list or the path of a file that leaks one.

## Goal

This repository carries a GitHub Actions workflow that runs on a pushed tag matching `publish-*` and on a manual run, assembles the plugin's runtime files from a committed allowlist, fails on any forbidden path and on any word from the list held as a repository secret, and pushes one commit replacing `plugins/personas/` in `SApplefeld/plugins` over the deploy key. The supervisor's installed plugin id is `personas@applefeld`, the id a host holds once it installs from the public marketplace, and its settings migration carries options written under `personas@agent-persona` forward. The README's install commands and the client sandbox runbook install all three plugins from the public marketplace. The two publish scripts are byte for byte the kit's, and the assembler's tests run here too.

## Intent

The frame, in the operator's words of 2026-10-01: "a singular plugin that was installable for the full functionality of personas, plus Discord channels, plus what is currently named Claude Kit (but without any of the documentation, docs, plans, backlog, or history, just the core functionality of the plugin in a singular public repo with three entries that is all installable from one place)." And of 2026-10-02: "we will uninstall everything from Claude and reinstall only the public plugin. We'll keep the private repos clones locally for work."

What done needs to do. The job, from the kit's design, with this repository's allowlist: the manifest, `hooks/`, `bin/`, `skills/`, the package files and `tsconfig.json`, which is the plugin's whole runtime, the supervisor included, since the engine runs `bin/restart-recap.mjs` from the installed folder and the operator runs the supervisor from it. The installed id the supervisor writes options under moves to the public marketplace's, with the migration from the previous id. The README and the runbook install from the public marketplace.

What done does not need to do. It does not move the plugin out of the repository root: the allowlist is what keeps `docs/` and `.kit/` out of the snapshot, which retires the backlog's prerequisite (2). It does not change the private marketplace file, which `--dev` loads and the live suites keep using. It does not publish the fixtures, the tests or the committed types mirror.

Alternatives refused. Moving the plugin into a subfolder so a root snapshot would be clean: refused, since the allowlist does the same with no path change for the supervisor or the live suites. Keeping `personas@agent-persona` and registering the public marketplace under that name: refused, since one marketplace serves all three plugins and its name is the kit's.

Rulings after the spec shipped: none yet.

Provenance: written by the ARCHITECT persona, session 57239bb8, on 2026-10-02.

## Approach

**The job and the scripts.** `tools/publish/assemble.mjs` and `tools/publish/leak-gate.mjs` are the kit plan's two scripts, copied byte for byte from the kit repository's `tools/publish/` at the commit its plan landed, with a header line naming that origin. `tools/publish/allowlist.txt` is: `.claude-plugin/plugin.json`, `hooks/**`, `bin/**`, `skills/**`, `package.json`, `package-lock.json`, `tsconfig.json`. The forbidden set in the assembler covers `docs/`, `.kit/`, `test/`, `tools/` and `.test.` names, so `.claude/types/` is kept out by the list alone and `hooks/*.test.*`, were any to appear, by the set. `.github/workflows/publish.yml` is the kit's workflow with `personas` for the plugin, `plugins/personas` for the folder, `agent_persona` for the repository name in the commit title, and no seed step. The snapshot's `bin/fleet.example.json` ships, since it is the supervisor's example roster and names no host.

**The installed id, `bin/agentic-common.sh`.** `AGENTIC_PLUGIN_INSTALLED_ID` at `:29` becomes `personas@applefeld`. `ensure_settings_plugin_ids`, which the personas rename plan taught to carry options from the former ids `agentic-plugin` and `agentic-plugin@agent-persona`, takes `personas@agent-persona` as one more former id, so a run directory written before the fleet's reinstall still launches with its options. The store globs `personas_inline-*.json` and `personas_*.json` already match any marketplace. `README.md:13`'s install line and `:417`'s id sentence, `bin/supervise.sh:4526`'s comment, `skills/restart-recap/SKILL.md:18` and `skills/upgrade-check/SKILL.md:16`'s lookups, and `.kit/upgrade-check-unit-test.mjs:378` and `:795` take the new id. `.kit/settings-plugin-key-test.sh` gains a case for the new former id.

**The runbook, `docs/client-sandbox.md`.** The "Plugins and Kit" section at `:116` to `:148` becomes: add the public marketplace, `claude plugin marketplace add SApplefeld/plugins`; install `personas@applefeld`, `grimoire@applefeld` and `relay@applefeld`; the doctrine import line names `@grimoire-doctrine.md`; the doctor path reads `applefeld\grimoire\*`; the relay's host install runs from the installed relay folder's `install/` scripts, with the relay plan's README section as the reference. The checks under it read the new file names.

**The README.** `README.md:10` to `:16`'s install block names the public marketplace and the id. A release section says how a tag is cut and what the job refuses, as the kit's does.

**The tests.** `.kit/publish-assemble-test.mjs` and `.kit/publish-leak-gate-test.mjs` are the kit's two test files adapted to this repository's test shape, pinning the same cases, and `.kit/settings-plugin-key-test.sh` gains the former-id case.

## Sections of Work

### 1. The publish job, the installed id and the public install text

Model: opus

Acceptance:
- `node tools/publish/assemble.mjs --allowlist tools/publish/allowlist.txt --out <tmp>` on this checkout copies exactly the files `git ls-files .claude-plugin/plugin.json hooks bin skills package.json package-lock.json tsconfig.json` lists, the count in the Chapter, and no path under `docs/`, `.kit/` or `.claude/` is in the output.
- `cmp tools/publish/assemble.mjs <kit checkout>/tools/publish/assemble.mjs` and the same for the gate read identical below the origin header line, recorded in the Chapter with the kit commit copied from.
- `node .kit/publish-assemble-test.mjs` and `node .kit/publish-leak-gate-test.mjs` pass, and the planted-word case is red against a gate stub before the copy.
- `sh .kit/settings-plugin-key-test.sh` passes with the former-id case, red before the edit and green after.
- `node tools/publish/leak-gate.mjs --root <tmp> --words-file <a temporary list from the operator>` passes over the assembled snapshot, the run in the Chapter with no word.
- `git grep -n -- 'personas@agent-persona' -- bin hooks skills README.md .kit docs/client-sandbox.md` finds only the former-id migration and its test case.
- The offline suites are green against the baseline recorded before the section's first edit.

Files in scope: `tools/publish/assemble.mjs`, `tools/publish/leak-gate.mjs`, `tools/publish/allowlist.txt`, `.github/workflows/publish.yml`, `bin/agentic-common.sh`, `bin/supervise.sh`, `README.md`, `skills/restart-recap/SKILL.md`, `skills/upgrade-check/SKILL.md`, `docs/client-sandbox.md`, `.kit/settings-plugin-key-test.sh`, `.kit/upgrade-check-unit-test.mjs`, `.kit/publish-assemble-test.mjs`, `.kit/publish-leak-gate-test.mjs`.
Tests: the former-id migration, since every run directory on the fleet carries the old id at the reinstall; the allowlist's output holding no document or scratch path, since the root is the plugin and the list is the only wall.

## Out of Scope

- The public repository's catalog and README, which the kit's job seeds.
- The private marketplace file and the `--dev` load path.
- The persona memory and fixture trees under `.kit/`, which never ship.

## Assumptions

- assumed 2026-10-02 (source: the kit's public marketplace plan): the public marketplace is named `applefeld`; reversal: another name, which changes the installed id here.
- assumed 2026-10-02 (source: `hooks/index.ts:3110`, which runs `bin/restart-recap.mjs` from the plugin root, and `docs/client-sandbox.md`, which runs the supervisor from the installed folder): `bin/` ships whole; reversal: none needed.
- assumed 2026-10-02 (default): the blind read and the plan review are skipped, since the design is the kit plan's and this spec is one section instancing it.

## Operator Verification

- The fleet's reinstall, under the kit plan's steps: each host's supervisors relaunch after the install, and a persona whose first turn names its plugin options as defaults reopens the former-id migration.
- The clean-machine install, under the kit plan.

## Open Questions

- None.

## Related

- `claude-kit_public-marketplace_spec_v1.md` in the kit repository: the design this plan instances.
- `agent_persona_personas-rename_spec_v1.md`: the rename this plan waits on.
- `docs/backlog.md`, "Plugins-only public distribution: this repo's marketplace entry ships docs/ and .kit/ (2026-09-28)": retired by this plan's allowlist at its close-out.

## Chapters
