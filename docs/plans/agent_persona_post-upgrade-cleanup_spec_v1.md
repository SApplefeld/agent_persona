# The plugin names its authors and stops asking for the function-hooks flag, which Claude Code 2.1.287 no longer reads

Status: In Progress
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

### Chapter 1 - 2026-10-02
Completed: 1. The author lands, the flag leaves the check, the test, the fixture, the scripts and the README
Implemented By: implementer-sonnet; the round-1 fix inline in the main session
Metrics: review rounds 1, closed major-closed; provenance 4 spec-traceable, 0 fix-introduced, 0 new-requirement, rulings (0 refused, 0 declared, 0 asked); advisory: 0 findings, 0 fixed, 0 deferred, 0 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
- section 1 open: changes the manifest (author object), childEnv and its two callers, the inverted unit case, the README sentence and five script export lines; serves the Goal sentence "When this ships, plugin.json carries an author ... the five live-test scripts no longer export it"; adds no mechanism; size about 10 files, roughly 20 changed lines; not building it leaves every surface claiming a flag 2.1.287 no longer reads.
- round 1 adversarial Major 1: changes the inverted case's predicate from functionHooks === '1' to any non-empty value; serves the Intent clause "a pin that no step sets it is what keeps the flag from returning in a later edit"; adds no mechanism; size 2 lines; not building it lets the flag return under any value but '1' with the test green.
- Status header changed from Ready to In Progress at run start (inside the approval fingerprint).
- Surprise: step 2 of the upgrade check cannot regenerate types on 2.1.287 with or without the flag. `claude -p "/plugin-types"` exits 0, writes no types file, and the engine answers that `/plugin-types` isn't installed. The README's stream-json recipe gets the same answer, and `claude plugin --help` lists no types subcommand. Step 2 passed on 2.1.283 (D:/Temp/verify-results, verify-results2) and already failed on 2.1.287 in the canary's own run (D:/personas/upgrade-checks.jsonl). This predates and is independent of this plan. It was raised to the ARCHITECT persona as a question this plan does not cover, with a separate small plan recommended, and it rides in the pull request body.
- Spec deviation: the Approach says both comments in bin/upgrade-check.mjs name 2.1.287. The header comment at :4 speaks of the early-access API and never named the flag, so only the :291 comment changed.
Failed approaches: tried `upgrade-check pre` with --scratch under .kit/scratch; it refused (exit 2) because a scratch folder it empties may not sit inside the checkout; learned to run it from D:/Temp.
Assumptions:
- assumed 2026-10-02 (section 1, declared): the acceptance bullet "pre passes steps 2 and 7 with the flag absent" is read as "removing the flag changes neither step's verdict", since step 2 cannot pass on 2.1.287 either way; met by the paired runs below; reversal: the ARCHITECT reads the bullet otherwise.
- assumed 2026-10-02 (section 1, declared): the acceptance grep's allowed hits extend to docs/plans/ and the docs/README.md index line, which describe this plan and tell no one to set the flag, so the Goal sentence holds; reversal: reword the index line at finishing.
- assumed 2026-10-02 (section 1, declared): the flag stays in this host's ~/.claude/settings.json env block for now, because every live session here reads it at its next start; the Operator Verification step is left to the operator.
Review Findings: review: code pair at opus, Workflow (high); review: security at opus, Workflow (high). Adversarial Major 1 (pin matched only '1') fixed, with a withheld-value control: the check planted with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS 'true' reds the new case (59 passed, 1 failed, exit 1), and the old predicate would have passed it. Adversarial Major 2 (acceptance grep cannot exclude the plan doc) justified-not-fixed under the declared assumption above. Adversarial Majors 3 and 4 (no live pre evidence, Chapter unwritten) were measured against a stale in-tree log; answered by the paired runs and this Chapter. Blind lens: no Critical or Major; it skipped the six .kit/ paths under its own charter. Security lens: CLEAR. Minors: 1 fixed in the close pass (the security Minor, recorded here), 0 upgraded, 6 left with the reason in .kit/scratch/post-upgrade-cleanup/minors-section-1.md (no engine floor and no stripping of a parent flag value, since each adds a mechanism no clause names; the author wording is the operator's choice under Intent; the index status is finishing's; the header comment carried nothing stale; a README engine floor would decorate a recipe that fails on 2.1.287). The fix delta changed only the test and took an author re-read.
Stamps: adjudicated 5, stamped 1 (relay-status-cadence-is-one-message-per-section-close)
Gate: targeted lane, moment 2026-10-02T01:43Z on this worktree at 1c08a97 plus the round-1 test fix, no foreign test runner in the process poll. `node .kit/upgrade-check-unit-test.mjs`: baseline 60 passed 0 failed exit 0 at f14ffa7, red after the test edit alone 59 passed 1 failed exit 1 (implementer's run), green 60 passed 0 failed exit 0; delta none. Tests edited: the function-hooks case, inverted to pin that no step's child environment carries the flag under any value. Tests added 0, retired 0. `claude plugin validate .claude-plugin/plugin.json` exit 0. `claude plugin validate --strict --json` exit 1, 0 errors, two warnings: "version: No version specified. Consider adding a version following semver (e.g., "1.0.0")" and "root: CLAUDE.md at the plugin root is not loaded as project context. To ship context with your plugin, use a skill (skills/<name>/SKILL.md) instead." Live `upgrade-check pre` on 2.1.287 with --scratch and --results under D:/Temp: flag unset via env -u, exit 1, steps 1 pass, 2 fail, 3 fail, 4 fail (typescript not installed in the worktree), 5 pass, 6 gap, 7 pass, hooks read from the installed agentic-plugin cache; flag set, exit 1, the same verdicts on steps 2, 4 and 7. Sweep `grep -rn CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` outside .git, docs/ and .kit/scratch: the fixture's :17 and :62 and the unit test's :400 and :404 only; the pre-edit tree held it in bin/, README.md and the five scripts. Scripts: `bash -n` exit 0 on all five; preambles to the line after the removed export exit 0 for commons, goaltree, interrupt-ratelimit and restartrequest; operator exit 0 with its exit trap disarmed, since its trap's wait blocks on the tee process substitution in a truncated copy. Wall clock: the unit suite about 3 s.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: moment 2026-10-02T01:43Z; kit-size printed:
```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```
