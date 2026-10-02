# The plugin names its authors and stops asking for the function-hooks flag, which Claude Code 2.1.287 no longer reads

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-01

## Dispatch Authorization

The ARCHITECT persona checked the plugin against the mods API of Claude Code 2.1.287 on 2026-10-01 at the operator's ask, relayed by the ASSISTANT persona, and found nothing that must change before the upgrade and two cleanups worth doing after it. The operator approved this plan for those two on 2026-10-01 through the same relay, with one change to the ask: no `version` field in the manifest, since it would need a bump on every commit, and chose the author wording recorded under `## Intent`. It has one precondition, on dispatch: the fleet's Claude Code is 2.1.287 or later, read by `claude --version` on the machine the run uses, since on 2.1.283 the flag this plan retires is still what makes the engine load the plugin's module. The ASSISTANT persona queues it through the coordinator for the persona plugin's worker after the 2.1.287 restart.

## Goal

The plugin's manifest names who made it, and no file in the repository tells a reader or a script to set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`. From 2.1.287 a plugin whose `hooks/hooks.json` names a module loads with no flag, so every place that sets or documents the flag is a claim about a build the fleet no longer runs. When this ships, `.claude-plugin/plugin.json` carries an `author`, the README's types section no longer asks for the flag, the upgrade check's steps 2 and 7 run in the plain environment, its unit test pins that no step sets the flag, and the five live-test scripts no longer export it.

## Intent

The operator's rulings of 2026-10-01, relayed by the ASSISTANT persona. On the manifest: add `author`, no `version`, because a `version` "pins the plugin to that version until you change it" and only `name` is required, so a missing version is a validator warning and nothing more. On the author's wording, chosen from three the ASSISTANT offered: `"author": { "name": "Dreamed up by Scott Applefeld, built by Claude" }`, a single object with a `name`, since the manifest's `author` is an object and not an array. On the flag: retire it from the README, from the upgrade check's steps 2 and 7 with their unit test and fixture, and from the five live-test scripts. On the validator: no gate adopts `--strict`, since strict validation warns on the missing version and, as the ASSISTANT reports, on the `CLAUDE.md` at the plugin root; plain `claude plugin validate`, which fails on errors only, stays the check.

What done needs to do. The manifest gains the author object and nothing else. The README's sentence at line 669 that says to set the flag before regenerating the types is gone, and the invocation beneath it stands. `bin/upgrade-check.mjs` runs every step in this process's environment, with its `childEnv` helper and its comments no longer naming the flag. `.kit/upgrade-check-unit-test.mjs` keeps a case on the flag, inverted: no step's child environment carries it, read through the fixture's call log, which still records whether the flag reached it. The five scripts drop their `export` line. `claude plugin validate` on the manifest exits 0.

What done does not need to do. It does not remove the flag from `~/.claude/settings.json`'s `env` block or from the machine's environment on any fleet host: that is machine state outside the repository, named under `## Operator Verification` as a step for the operator or the worker after the upgrade. It does not touch the archived plans and discussions that mention the flag, which are history. It does not make any gate run `--strict`. It does not touch the hooks' own code, which the mods check found unchanged between 2.1.283 and 2.1.287.

Alternatives refused. A `version` field in the manifest: refused by the operator, since it would need a bump on every commit and buys nothing the fleet reads. Adopting `--strict` in the upgrade check's step 5 so the validator's warnings are seen: refused, since two of its warnings are about choices this plan makes on purpose, and a gate that warns on purpose teaches readers to ignore it. Removing the flag's case from the unit test rather than inverting it: refused, since the fixture already records whether the flag reached a call, and a pin that no step sets it is what keeps the flag from returning in a later edit.

## Approach

**The manifest.** `.claude-plugin/plugin.json` is a JSON object whose first key is `name`. The author object is inserted after `description`, so the manifest reads name, description, author, types, and then the user configuration keys as today. Plain `claude plugin validate <manifest>` is run on the result, and once `claude plugin validate --strict --json <manifest>` so the Chapter records its warnings as they stand on the build, which the ASSISTANT reports are the missing version and the root `CLAUDE.md`.

**The upgrade check.** `childEnv(functionHooks)` at `bin/upgrade-check.mjs:294` returns the process environment plus the flag when its argument is true, and steps 2 and 7 pass true; the comment at `:291` and the header comment at `:4` say why. The helper becomes a plain copy of the process environment with no argument, its two callers drop theirs, and both comments say the plugin loads with no flag from 2.1.287. The unit test at `.kit/upgrade-check-unit-test.mjs:400` reads the fixture's call log, where `.kit/fixtures/upgrade-check/claude:62` records `functionHooks` from the environment, and asserts that steps 2 and 7 carried the flag; it is inverted to assert that no call carried it, keeping the cleared launch environment the case already uses so a machine that still sets the flag globally cannot pass it through. The fixture's comment at `:17` keeps its line, since the log field stays and the inverted case reads it.

**The scripts.** `.kit/live-commons-test.sh:91`, `.kit/live-goaltree-test.sh:25`, `.kit/live-interrupt-ratelimit-test.sh:233`, `.kit/live-operator-test.sh:88` and `.kit/live-restartrequest-test.sh:56` each hold one `export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` line, and each loses it. The interrupt script's line sits under an `unset` list at `:230` to `:232` that names no flag, and that list stays as it is.

**The README.** Line 669 says "After any engine update, regenerate with the stream-json invocation. Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment first:" and the invocation follows. The second sentence goes, and the first keeps its colon so the invocation still reads as what follows it.

## Sections of Work

### 1. The author lands, the flag leaves the check, the test, the fixture, the scripts and the README

Model: sonnet

Acceptance:
- `.claude-plugin/plugin.json` parses, carries `"author": { "name": "Dreamed up by Scott Applefeld, built by Claude" }` after `description`, carries no `version`, and `claude plugin validate` on it exits 0. The Chapter records the warnings `claude plugin validate --strict --json` prints on this build.
- `grep -rn CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` over the repository, excluding `docs/archive/`, returns only the unit test's inverted case and the fixture's log field and comment.
- `node .kit/upgrade-check-unit-test.mjs` passes whole, with the inverted case red before the check's edit and green after, both runs recorded in the Chapter.
- `node bin/upgrade-check.mjs pre` on this checkout, on a 2.1.287 build, passes steps 2 and 7 with the flag absent from the environment, recorded in the Chapter with the results file's lines.
- Each of the five scripts runs its own preamble to the line after the removed export with no error, or the Chapter records that the script cannot be run that far on this machine and names why.

Files in scope: `.claude-plugin/plugin.json`, `README.md`, `bin/upgrade-check.mjs`, `.kit/upgrade-check-unit-test.mjs`, `.kit/fixtures/upgrade-check/claude`, `.kit/live-commons-test.sh`, `.kit/live-goaltree-test.sh`, `.kit/live-interrupt-ratelimit-test.sh`, `.kit/live-operator-test.sh`, `.kit/live-restartrequest-test.sh`.
Tests: the inverted unit case both ways, the unit suite whole, one run of the upgrade check's pre steps.

## Out of Scope

- The flag in `~/.claude/settings.json` and in the machine environment of each fleet host: machine state, named below.
- `docs/archive/` mentions of the flag: history.
- The upgrade-check skill's text, which the sweep of 2026-10-01 found names no flag.
- The kit memory store's operator-tier record that says the function-hooks prototype ships behind a flag, which the upgrade makes stale; the operator's own session retires or rewrites it, since the tier is the operator's.
- Any change to the hooks' code or to `hooks/hooks.json`.

## Assumptions

- assumed 2026-10-01 (source: the 2.1.287 declarations written by that build's own binary, read by the ARCHITECT on 2026-10-01, and the mods check it ran): a plugin whose `hooks/hooks.json` names a module loads with no flag from 2.1.287; reversal: a 2.1.287 session with the flag unset whose debug log shows the module not loaded reopens the plan before any edit lands.
- assumed 2026-10-01 (reported by the ASSISTANT persona from the manifest reference at code.claude.com, not read by the ARCHITECT): `author` is a single object with a required `name` and optional `email` and `url`, `version` is optional and pins the plugin, and `--strict` warns on the missing version and the root `CLAUDE.md`; reversal: the Chapter's recorded `--strict` output, which the section reads first.
- assumed 2026-10-01 (default): the unit case is inverted rather than removed; reversal: remove it, where the fixture's log field goes too.

## Operator Verification

- After the upgrade and before or after this merges, remove `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` from the `env` block of `~/.claude/settings.json` on each fleet host and from any machine-level environment that sets it, then start a session and read the debug log for the module loaded at tier user. The worker may do this on the host it runs on and must say so in the Chapter; the operator does the rest.
- Read the Chapter's recorded `--strict` warnings once, and decide whether the root `CLAUDE.md` warning earns a later change.

## Open Questions

- None.

## Chapters
