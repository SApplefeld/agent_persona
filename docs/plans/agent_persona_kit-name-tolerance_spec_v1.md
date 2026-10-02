# The persona plugin and the supervisor find the kit under either of its names, so the kit's rename to Grimoire breaks no running persona

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-10-02

## Dispatch Authorization

The ARCHITECT persona wrote this plan on 2026-10-02 on the operator's ruling, given on the ARCHITECT's channel the same day, that the kit plugin is renamed from `claude-kit` to `grimoire` because Claude Code 2.1.287's validator refuses the `claude-` prefix. This repository reads the kit by its install name in two places, and both break the moment a host's kit auto-updates under the new name. This plan is the first of the rename's four, and it has no precondition. The coordinator queues it for this repository's worker at once. The kit's own rename plan, `claude-kit_grimoire-rename_spec_v1.md` in the kit repository, must not merge until this plan has merged and the operator has updated the persona plugin on every fleet host.

## Goal

A persona runs the same whether the kit installed on its host is named `claude-kit` or `grimoire`. The plugin's kit lookup, which finds the kit's install folder in the engine's `installed_plugins.json` to run the memory CLI and the compaction boundary command, accepts either install key and prefers the new one. The supervisor's priming text names the kit's skills under whichever name the host has installed, so a session launched after the kit updates loads `grimoire:operating-instructions` and one launched before still loads `claude-kit:operating-instructions`. The unit suites pin both directions and the preference. When this ships and reaches every host, the kit may rename without a persona losing its memory calls, its compaction boundary or its skills.

## Intent

The frame, from the operator's rulings on 2026-10-02, relayed through the kit worker's thread and then decided on the ARCHITECT's channel: "We're going to want to rename the kit", the name chosen as Grimoire from his list of four, and "I would like to rename agentic-plugin to personas", which is a later plan. The ARCHITECT's reading, which the operator accepted in the same exchange: the rename is one effort in four plans, and this one goes first because the consumer must tolerate both names before the producer changes.

What done needs to do. The plugin's kit lookup reads a list of two install keys, `grimoire@applefeld` first and `claude-kit@applefeld` second, and runs from the first key that holds a usable install record. The supervisor computes the kit's skill prefix at launch from the same engine file, `grimoire` where that key is present and `claude-kit` otherwise, and every priming sentence that names a kit skill takes the prefix from that one variable. The README's two sentences on the lookup say both keys. The tick suite and the priming-text suite pin both names and the preference.

What done does not need to do. It does not rename this plugin, which is the third plan. It does not drop the old key, which that plan does once the fleet is on Grimoire. It does not touch the client sandbox runbook's install commands, which the public marketplace plan rewrites. It does not read the kit's name from anywhere but the engine's `installed_plugins.json`, since that file is what the lookup already trusts.

Alternatives refused. Renaming the kit first and accepting a window where personas lose memory and skills: refused, because the kit auto-updates on every host and the window is unbounded until each supervisor relaunches. Reading the kit's name from a setting the supervisor passes: refused, since the engine's file is already the lookup's source and a second source can disagree with it. Making the priming text name both skills and letting the model pick: refused, since a skill the Skill tool cannot find costs a failed call on every launch.

Rulings after the spec shipped: none yet.

Provenance: written by the ARCHITECT persona, session 57239bb8, on 2026-10-02.

## Approach

**The lookup, `hooks/index.ts`.** `KIT_PLUGIN_KEY` at `:2669` becomes `KIT_PLUGIN_KEYS`, the array `["grimoire@applefeld", "claude-kit@applefeld"]`, and the comment at `:2673` names both. `kitInstallPathOf` at `:2679` walks the keys in order and returns the first key's best record, where best is the greatest `lastUpdated` with a string `installPath`, as today. A key that is absent, not an array, empty or without a usable record falls through to the next. When no key yields a record the skip names both keys in one string, `no grimoire@applefeld or claude-kit@applefeld install record is usable`, and the three narrower skips today at `:2705` to `:2719` collapse into that one, since a reader of the decision log needs the file's state rather than which of two keys failed how. Both callers, at `:2744` and `:2854`, change nothing.

**The supervisor, `bin/agentic-common.sh` and `bin/supervise-holder.sh`.** A function `kit_skill_prefix` in `agentic-common.sh`, beside the plugin ids at `:28`, prints `grimoire` when `$HOME/.claude/plugins/installed_plugins.json` is readable and holds the key `"grimoire@applefeld"` as a property name, and `claude-kit` otherwise, the file read with `node -e` the way the holder's other JSON reads are made. `supervise-holder.sh` sets `KIT_SKILL_PREFIX=$(kit_skill_prefix)` before the variable block at `:177`, and the four sentences that name a kit skill, `SKILL_LOAD_INSTRUCTION` at `:177`, the architect's at `:462`, the liaison's at `:503` and the comment at `:412`, write `${KIT_SKILL_PREFIX}:` in place of `claude-kit:`. The comment block at `supervise.sh:7` to `:9` says the host must have the kit installed under either name.

**The tests.** `.kit/controller-tick-test.mjs`'s boundary-compaction cases at `:15760` to `:16500` seed `installed_plugins.json` through `bank2Installed` and `bank2SeedInstalled`. They gain a case per direction: the new key alone runs from its record, the old key alone runs from its record, both keys present run from the new key's record even where the old key's record is newer, and neither key skips with the one decision naming both. The `missing key` miss at `:16480` reads the new token. `.kit/channel-reply-instruction-test.sh` evaluates the holder's variable block from source at `:70`, so it sets `KIT_SKILL_PREFIX` itself: each control string that names a kit skill, `SKILL_LOAD_CONTROL` at `:79`, `ARCH_SKILLS_CONTROL` at `:380`, `ARCH_SKILLS_JUDGMENT_CONTROL` at `:386` and `LIAISON_SKILL_CONTROL` at `:495`, is built from the prefix, and the run is made once under each prefix value. A new case in that suite runs `kit_skill_prefix` against three fixture files under a temporary home, one with the new key, one with only the old, and one unreadable, and reads the three answers.

**The README.** The lookup's two sentences at `README.md:302` and `:867` say the plugin takes the `grimoire@applefeld` record, or the `claude-kit@applefeld` record where the new key is absent.

**The sweep.** `git grep -n claude-kit origin/main` outside `docs/` and `.claude/types/` finds `.kit/channel-reply-instruction-test.sh` at `:79`, `:380`, `:386`, `:495`, `:1808` and `:2140`, `.kit/controller-tick-test.mjs` at `:15760` to `:15764`, `:16457` to `:16483` and `:34891` to `:34904`, `.kit/upgrade-check-unit-test.mjs` at `:336` and `:370`, `README.md` at `:80`, `:90`, `:302` and `:867`, `bin/supervise-holder.sh` at `:177`, `:412`, `:462` and `:503`, `bin/supervise-liveness.mjs:50`, `bin/supervise.sh:7` to `:9`, and `hooks/index.ts` at `:2669` and `:2673`. The upgrade-check fixture lines are an engine log naming another plugin and stay. The README's `:80` and `:90` describe the architect's and liaison's charters and take the same prefix wording as the sentences they describe. `supervise-liveness.mjs:50` names the kit repository, not the plugin, and stays. The tick suite's `:34891` to `:34904` is a helper reading the kit install for a live case and takes the same two-key walk.

## Sections of Work

### 1. The lookup and the priming text accept both kit names and prefer the new one

Model: sonnet

Acceptance:
- `node .kit/controller-tick-test.mjs` passes whole, with the four new boundary-compaction cases, and the two cases that seed the new key are red against the unedited `hooks/index.ts` and green after, both runs recorded in the Chapter.
- `sh .kit/channel-reply-instruction-test.sh` passes under both prefix values, and the `kit_skill_prefix` case reads `grimoire` for a file holding the new key, `claude-kit` for a file holding only the old key, and `claude-kit` for an unreadable file.
- `git grep -n 'claude-kit:' -- bin` returns nothing, and `git grep -n 'KIT_SKILL_PREFIX' -- bin/supervise-holder.sh` finds the four sentences.
- A live launch on this machine, which holds the kit under `claude-kit@applefeld` today, primes its child with `claude-kit:operating-instructions`, read from the priming write the holder makes. The Chapter records the line.
- The whole offline gate is green against the baseline recorded before the section's first edit.

Files in scope: `hooks/index.ts`, `bin/agentic-common.sh`, `bin/supervise-holder.sh`, `bin/supervise.sh`, `.kit/controller-tick-test.mjs`, `.kit/channel-reply-instruction-test.sh`, `README.md`.
Tests: the preference for the new key over a newer old-key record, since a host mid-migration holds both and the old record is the stale one; the old key alone still running, since every host is in that state until the kit renames; the prefix read from an unreadable file, since a launch must prime something rather than nothing; the priming text under each prefix, since a skill the tool cannot find fails every launch.

## Out of Scope

- Renaming this plugin to `personas`, and dropping the old kit key: the third plan of the rename.
- The client sandbox runbook's install commands at `docs/client-sandbox.md:121` to `:129`: the public marketplace plan rewrites them.
- The `.claude/types/claude-code-mcp.d.ts` mirror, which the upgrade check regenerates.

## Assumptions

- assumed 2026-10-02 (source: the Claude Code host-marketplace documentation, read 2026-10-02): a renamed plugin's `installed_plugins.json` key becomes the new name once the host runs one install of it, so the new key appears on a host only after the kit's rename has reached it; reversal: a host carrying the new key before the rename, which cannot happen.
- assumed 2026-10-02 (default): the prefix is read once at launch, not per turn, since a host's installed kit does not change under a running session; reversal: a session that outlives a kit rename on its host keeps the old prefix until relaunch, which the supervisor's relaunch covers.
- assumed 2026-10-02 (default): the blind read and the plan review are skipped, since the spec is one section over two readers of one engine file.

## Operator Verification

- After this merges, update the persona plugin on every fleet host, so each supervisor's next launch runs this code, before the kit's rename plan merges. A host that misses the update loses memory calls and kit skills when its kit renames, until it updates and relaunches.

## Open Questions

- None.

## Chapters

### Chapter 1 - 2026-10-02
Completed: 1. The lookup and the priming text accept both kit names and prefer the new one
Implemented By: the main session (Opus) for the build, both fix rounds and this Chapter
Metrics: review rounds 2, closed major-closed; provenance 7 spec-traceable, 0 fix-introduced, 1 new-requirement, rulings (0 refused, 2 declared, 0 asked); advisory: 4 findings, 3 fixed, 0 deferred, 1 refused; NEEDS_CONTEXT 0; escalations 0; consults 0
Decisions / Surprises:
section 1 open: recorded in the section's add-decision scratch file before the first edit.
round 1 fix (adversarial Major, holder prefix ungated): `.kit/supervisor-holder-test.sh` Case 7 launches the real holder on fixture homes and reads its priming turn; serves the Goal sentence on priming under whichever name the host installed; adds no mechanism, test only; one loop of three launches; not building it leaves a hard-coded prefix green on every gate.
round 1 fix (adversarial Major, 6 of 10 prefixed names pinned under one prefix): a check that no literal kit name precedes a colon anywhere in the holder, with a mutation control per name; serves the Tests line's "the priming text under each prefix"; adds no mechanism; one function and three checks; not building it lets a hard-coded skill name pass both runs.
round 1 fix (blind Major, adversarial and security Minor, readers disagree): `kit_skill_prefix` answers grimoire only for a usable record, the rule `kitInstallPathOf` runs from, and reads `USERPROFILE` before `HOME`; serves the Goal and the Intent's "from the same engine file"; adds no mechanism; about 8 lines; not building it primes grimoire skills while the plugin runs the claude-kit install.
round 1 fix (blind and security Minor, empty prefix): the holder falls back to claude-kit on an empty prefix; serves the function's own "a launch always primes a prefix"; one line; not building it primes a bare ":operating-instructions" when the source fails.
round 2 fix (adversarial Major, no parity pin): the tick case's fixtures also run through `kit_skill_prefix`, which must answer grimoire exactly where the lookup runs the grimoire install, plus fixtures for a bad record before a good one and an unparsable lastUpdated; serves the same Intent sentence; adds no mechanism, test only; 29 lines; not building it lets the two hand copies of the rule drift apart with both suites green.
- Status changed from `Ready` to `In Progress` at the run's start.
- **Declared departure from the Approach and the Intent.** Both say the prefix is grimoire "where that key is present". The prefix now needs a usable record under the key, the rule the lookup uses. The Goal asks for the name "the host has installed", and the Intent's refused alternative rejects a second source because it "can disagree with" the lookup. A bare key with no usable record is exactly where the plugin runs claude-kit. The round-2 reviewer judged the departure right.
- **Declared departure on the home.** The Approach names `$HOME`. The prefix reads `USERPROFILE`, else `HOME`, as `hostOf` in `hooks/index.ts` does, so both readers open the same file under a keeper launch.
- `bin/supervise-holder.sh` now sources `bin/agentic-common.sh`. Its top level writes nothing to stdout, and its one exit is the `PROFILE` check, which `bin/supervise.sh` has already passed under the same environment. The library's header now says so.
- `.kit/injection-ledger.json` was regenerated, outside Files in scope. The ledger strips `${...}` interpolations, so three sizes fell: 278 to 248, 7212 to 7162 and 1541 to 1531. `.kit/supervisor-holder-test.sh` and `docs/security-model.md` were also edited outside Files in scope, as the add-decision file records.
- Accepted gap, routed to the backlog at finishing: both readers count a record whatever its `scope`. A host holding grimoire at project scope for another directory, beside a user-scope claude-kit, would prime grimoire skills its workdir does not load. Neither reader filtered scope before this plan, and no such record was seen on this host.
Failed approaches: tried splicing test-file edits with `node` scripts and heredocs through the Bash tool, which matched nothing or failed to parse four times; the Edit tool and a scratch block file spliced with `head` and `tail` worked.
Assumptions: none.
Review Findings: review: adversarial + blind + security + performance at opus, Workflow (round 1, effort high); review: adversarial at opus, Workflow (round 2, effort high). Round 1: the adversarial Majors on the ungated holder step and the half-pinned names are fixed. The blind Major on the two readers disagreeing is fixed, and the adversarial and security lenses raised it as Minors. The security Major that `docs/security-model.md:66` named only the old key is fixed. Minors fixed: the README's "where the new key is absent", the library header, `USERPROFILE` before `HOME`, the empty-prefix fallback, and the doubled fixture run. Refused: the blind Minor that the ledger and the priming suite would size the literal `${KIT_SKILL_PREFIX}`, because `.kit/injection-ledger.mjs:111` strips interpolations by design and the suite sets the variable itself. Refused: the blind Minor that the diff adds no test, since `caseBank2_bothKitKeysAreAcceptedAndTheNewOnePrefers` and the prefix fixtures are in it. Refused: the blind Minor to split the prefix into its own file, since the `PROFILE` exit cannot newly fire under `bin/supervise.sh`. Round 2: the parity Major is fixed, the plan-ruling Major is answered by the declared departure above, and the scope Major, low confidence and inferred, is declared as an accepted gap. Minors fixed: the security-model sentences moved to the end of their bullet and no longer claim "nothing more", `README.md:80` and `bin/supervise.sh:9-11` now say "usable record", and two fixtures were added. Left: bash does not trim `USERPROFILE` as TypeScript trims the home, and `Date.parse` runs in different engines. Neither matters for the ISO records the engine writes. Performance: CLEAR, one added node read of about 0.13 s per holder launch.
Stamps: adjudicated 1, stamped 1 earlier this session: `the-live-gate-is-operator-only-while-the-fleet-is-up`, which kept `.kit/live-all.sh` out of this section's gate. `memq unstamped --since 8h` listed 0 project-tier and 0 operator-tier records.
Gate: targeted lanes in the kit-name-tolerance worktree on 2026-10-02, with no foreign test runner in the process list, against the baseline recorded before the first edit, where all 30 offline lanes exited 0. `node .kit/controller-tick-test.mjs` PASS with 0 failures at the round-2 fix. `bash .kit/channel-reply-instruction-test.sh` passed all tests under both prefixes. `bash .kit/supervisor-holder-test.sh` PASS. `.kit/persona-live-refuse-test.sh`, `.kit/settings-plugin-key-test.sh`, `.kit/supervisor-model-test.sh`, `.kit/keeper-register-test.mjs` and `.kit/injection-duplicate-test.mjs` exit 0. The regenerated ledger matches `.kit/injection-ledger.json`. `npx tsc --noEmit` exit 0 at 5cfcb7c. Red legs: the four new tick cases ran against the unedited lookup with 9 failures, then 0. Five new prefix fixtures went red against the committed key-presence function. Case 7 went red under a hard-coded `KIT_SKILL_PREFIX=claude-kit` and under a dropped fallback. The parity checks went red under `usable(records[0])` and under a dropped `Date.parse` test, each on its one fixture. `git grep -n 'claude-kit:' -- bin` is empty, and `KIT_SKILL_PREFIX` sits at the four sentences. Live: a real holder launched on this machine, whose `installed_plugins.json` holds only `claude-kit@applefeld`, primed its child with "invoke the Skill tool for claude-kit:operating-instructions, then claude-kit:executing-work", and exited 0.
Next: finishing-work
Commit Model: Branch-and-PR
Delta: 2026-10-02, the kit-name-tolerance worktree. The report reads, quoted whole:

```
kit-size: measured no file at all under the measured roots, no tracked path a root holds was absent from the pathspec-filtered listing, and no untracked file a measured shape reaches was found either, so the corpus is empty rather than hidden and there is no reading to report
```

### Interim board 1 - 2026-10-02
State: finishing pass, base ref 0245191fc01b8397a526e38e4f22f8e9b57b0dda, branch plans/kit-name-tolerance with PR #143 open, last pushed 09c1d01.
Done: step 1 QA PASS, all 30 offline lanes exit 0 against the all-zero baseline; `.kit/live-all.sh` refused with exit 10 on a live persona claim, operator-only. The red leg QA's hook blocked was replayed in the main thread: the base `hooks/index.ts` reds 19 tick checks, the head none. Steps 2 and 3 at fable: security CLEAR, performance CLEAR, adversarial APPROVED_WITH_CONCERNS with one Major (Case 7 pinned the skill-load wording), fixed in 09c1d01 and re-reviewed APPROVED at fable. Step 4 goal read at fable RULED: 8 built-but-unasked items, all accept-and-declare; nothing asked-but-unbuilt.
Minor pass: the README pronoun the re-review found, fixed with this entry. The full disposition list is `.kit/scratch/kit-name-tolerance/finishing/minors.md`.
Next: step 5 docs-curator, then step 6 (final Chapter with the backlog items on install scope and enabledPlugins, Status Complete, archive, index, handoff gate), then step 7 (ready, auto-merge), then tell the coordinator once #143 merges.
