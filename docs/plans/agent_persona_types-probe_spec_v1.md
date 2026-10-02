# The upgrade check reads the new build's declarations from a probe plugin the engine writes them beside, since Claude Code 2.1.287 has no `/plugin-types` command

Status: In Progress
Commit Model: Branch-and-PR
Created: 2026-10-02

## Dispatch Authorization

The ARCHITECT persona wrote this plan on 2026-10-02 on a finding from the persona plugin's worker, raised while it ran the post-upgrade cleanup plan: step 2 of the upgrade check fails on Claude Code 2.1.287 because the `/plugin-types` command that step runs no longer exists, and the README's regeneration recipe fails the same way. The ARCHITECT confirmed the replacement mechanism on this machine's installed 2.1.287 build and told the worker and the operator. It has one precondition, on dispatch: the post-upgrade cleanup plan's pull request has merged, since both plans edit step 2 of `bin/upgrade-check.mjs`, its unit test and its fixture, and this plan's line numbers are read off that branch. The coordinator queues it for the persona plugin's worker after that merge, and the operator may veto it on the channel before then.

## Goal

The upgrade check's step 2 regenerates the plugin interface's declarations on the new build the way that build writes them, and the README tells a developer the same way. From 2.1.287 the engine writes the declarations beside any plugin it loads from a folder, as `.claude-plugin/types/claude-code/index.d.ts`, and no slash command writes them anywhere. When this ships, step 2 writes a one-hook probe plugin into the scratch folder, runs the new build headless with `--plugin-dir` on that probe and a config directory inside the scratch folder, and reads the declarations the engine wrote beside the probe. Steps 3 and 4 read that file. The unit test pins the probe's shape and location, the fixture answers the new invocation and no other, the README's recipe is the same run, and `.gitignore` keeps the files the engine writes beside the checkout out of the index.

## Intent

The frame, from the worker's record and the ARCHITECT's own run. On 2.1.287 `claude -p "/plugin-types"` exits 0, writes nothing, and the engine answers that the command is not installed. The README's stream-json recipe gets the same answer, and `claude plugin --help` lists no types subcommand. The engine now writes the declarations itself: the header of the file it writes says it is "written by the engine each time it loads a mod from a folder the person owns, beside that mod as `.claude-plugin/types/claude-code/index.d.ts`". A plugin loaded from the install cache gets no such file, so the check cannot read them off the fleet's installed copy.

What done needs to do. Step 2 makes a probe plugin under the scratch folder, runs the build on it, and reads the file the engine wrote. The probe is the smallest plugin the engine loads: a manifest with a name, a `hooks/hooks.json` naming one module, and a module exporting a `register` function that attaches one `session.start` hook which calls `next`. The run carries `CLAUDE_CONFIG_DIR` set to a directory inside the scratch folder, so no login, no installed plugin and no model call is involved: the engine prints "Not logged in", exits 0, and has already written the files. Steps 3 and 4 read the new path and change nothing else. The fixture's types case keys on `--plugin-dir` and writes the files where the engine writes them. The README's recipe is the same command, with the copy step naming the new source path. `.gitignore` gains `.claude-plugin/types/`.

What done does not need to do. It does not move the committed declarations out of `.claude/types/` or adopt the tsconfig the engine writes beside the probe: step 3's committed path, step 4's compile and the checkout's own `tsconfig.json` stay as they are. It does not regenerate the tool-list mirror `.claude/types/claude-code-mcp.d.ts`: the mirror the engine writes beside the probe lists the MCP tools the session had connected, and the probe run connects none, so the two backlog items on that mirror stay open with their remedy lines corrected. It does not change step 7, which loads the installed plugin and needs no declarations.

Alternatives refused. Passing the checkout itself as `--plugin-dir`: refused, because the engine then writes four files into the fleet's checkout, and the scratch folder is the only place the check writes. Running the probe under the machine's real config directory: refused, because a logged-in session sends `/version` to the model as a prompt, which costs a call and a login for nothing the step reads. Committing the engine's layout and tsconfig: refused as out of this plan's size, and named under `## Out of Scope` for a later plan.

Rulings after the spec shipped: none yet.

Provenance: written by the ARCHITECT persona, session 57239bb8, on 2026-10-02, with the mechanism confirmed by three runs on this machine's installed 2.1.287 build.

## Approach

**What the engine does, confirmed on 2.1.287.** Run with `--plugin-dir <probe>` and `CLAUDE_CONFIG_DIR=<empty dir>`, `claude -p "/version"` prints "Not logged in · Please run /login", exits 0, and writes under `<probe>/.claude-plugin/types/` three files, `claude-code/index.d.ts` (first line "Written by Claude Code 2.1.287", 14916 lines), `claude-code-mcp/index.d.ts` (an empty `McpToolInputs`) and `claude-code-tools/index.d.ts`, plus a `tsconfig.json` in that folder and a `<probe>/tsconfig.json` extending it where none exists. A probe whose module exports nothing, or whose `hooks.json` carries a `module` key instead of `modules`, loads nothing and writes nothing. Passed a copy of the real checkout as the plugin dir, the engine writes the same four files into it and leaves the checkout's existing root `tsconfig.json` unchanged. The declarations file is byte-identical across the probe, the checkout copy, and the predecessor's run of the native 2.1.287 package.

**Step 2, in `bin/upgrade-check.mjs`.** Line numbers are from the cleanup branch at commit 1c08a97. After the scratch folder is made, the step writes `<scratch>/types-probe/.claude-plugin/plugin.json` as `{"name":"upgrade-check-types-probe"}`, `<scratch>/types-probe/hooks/hooks.json` as `{"modules":["./register.js"]}`, and `<scratch>/types-probe/hooks/register.js` as `export function register(on) { on('session.start', async ($, e, next) => next(e)) }`, and makes `<scratch>/config`. The run at `:812` becomes `runClaude(['-p', '/version', '--plugin-dir', probeDir], { cwd: scratch, env: { ...childEnv(), CLAUDE_CONFIG_DIR: configDir } })`, and `newTypesPath` at `:813` becomes `<scratch>/types-probe/.claude-plugin/types/claude-code/index.d.ts`. The three evidence strings at `:819` to `:823` name the new invocation. The header line at `:30` and the comments at `:778` and `:872` say the engine writes the declarations beside a plugin loaded from a folder. The step's pass reads as today: exit 0 and the file present, with its first line as evidence. The child is spawned directly rather than through a shell, so no path conversion touches the leading slash. Steps 3 and 4 read `newTypes` and `newTypesPath` and change nothing else.

**The fixture, `.kit/fixtures/upgrade-check/claude`.** The types case at `:101` keys on `args` carrying `--plugin-dir` with a `-p` of `/version`, and writes `claude-code/index.d.ts` and the `SCRATCH_MIRROR` mirror as `claude-code-mcp/index.d.ts` under `<plugin dir>/.claude-plugin/types/`. The call record at `:62` gains `configDir: env.CLAUDE_CONFIG_DIR || ''`. The comment lines at `:16` to `:22` name the new case. A `-p "/plugin-types"` call falls to the `unknown` branch and exits 64, which is what makes the old invocation fail the suite.

**The unit test, `.kit/upgrade-check-unit-test.mjs`.** A new case reads the types call off the call log: its arguments carry `--plugin-dir` naming a directory under the scratch folder, that directory holds the manifest, `hooks/hooks.json` and `hooks/register.js` the step wrote, and its `configDir` is a directory under the scratch folder. The `mirror-source` case at `:247` reads the scratch mirror and the new engine types at the probe path. The `scratch-emptied` case at `:414` plants its stale file at the probe path. The `no-types` case at `:312` stands as it is.

**The README.** Lines 669 to 675 become: the engine writes the declarations beside any plugin it loads from a folder, so a `--dev` session writes `.claude-plugin/types/` into this checkout, which `.gitignore` keeps out; to regenerate against a new build, run the probe command from the upgrade check's step 2, shown as one line, and copy `claude-code/index.d.ts` to `.claude/types/claude-code.d.ts`; then `npx tsc --noEmit` and the controller suite, as the text already says. The mirror sentence says the mirror is not regenerated by this run.

**The sweep.** `grep -rn plugin-types` over the checkout at origin/main, outside `node_modules` and `docs/archive`, finds `bin/upgrade-check.mjs` at `:30`, `:812`, `:819`, `:821` and `:872`, the fixture at `:20`, `:22` and `:101`, `README.md` at `:672`, `docs/backlog.md` at `:357` and `:948`, and the committed generated files `.claude/types/claude-code.d.ts` and `.claude/types/claude-code-mcp.d.ts`, whose headers name the command that wrote them and which this plan does not edit. The skill at `skills/upgrade-check/SKILL.md:32` says step 2 regenerates the declarations from the new build, which stays true. The backlog's two remedy lines are corrected in this plan's own registration commit, which sits on this plan's branch beneath the section's work.

## Standing Brief Amendments

- Step 2 passes when the probe run spawned and did not time out and the declarations file is present. The exit code and the run's first output line are evidence only. On 2.1.287 the run exits 1 under an empty config directory, since no login exists there, after writing the files. The README states that exit. No check pins the "Not logged in" text. The emptied scratch folder stays the guard against a stale file. This replaces the Approach's "exit 0 and the file present" and reverses Assumption 3. Ruling: the ARCHITECT persona's answer of 2026-10-02 to the worker's record on the exit code.
- The engine writes the declarations as two files, `claude-code/index.d.ts` and `claude-code-tools/index.d.ts`, the second holding the built-in tools' tables that fill `BuiltinToolInputs` and `BuiltinToolResults`. Step 2 joins them into one scratch file in the committed single-file shape, the tools file after the index file, and steps 3 and 4 read the joined file. Step 2 fails when either file is absent, and its evidence names both source files. The README copy step makes the same join into `.claude/types/claude-code.d.ts`. The MCP mirror stays out. This replaces the Approach's "`newTypesPath` becomes `<scratch>/types-probe/.claude-plugin/types/claude-code/index.d.ts`". Ruling: the ARCHITECT persona's answer of 2026-10-02 to the worker's record on the split tables.
- The probe child's environment drops `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`, since a login carried in the environment defeats the empty config directory. `childEnv()` stays as it is for the other steps. A unit case plants a fake key and reads the probe call without it, and the README recipe runs with the three unset. Ruling: the same answer, on the Intent's "no login, no model call".

## Sections of Work

### 1. Step 2 reads the declarations off a probe plugin, and the test, fixture, README and gitignore follow

Model: sonnet

Acceptance:
- `node .kit/upgrade-check-unit-test.mjs` passes whole. The new probe case and the moved paths in `mirror-source` and `scratch-emptied` are red before the check's edit and green after, both runs recorded in the Chapter.
- `node bin/upgrade-check.mjs pre --repo <checkout> --results <a scratch results dir> --scratch <a scratch dir>` on a 2.1.287 build reads step 2 pass with evidence naming `types-probe/.claude-plugin/types/claude-code/index.d.ts` and a first line "Written by Claude Code 2.1.287", step 3 pass or warn, and step 4 pass. The results file's rows for steps 2 to 4 go in the Chapter.
- `grep -rn plugin-types` over the checkout, outside `node_modules`, `docs/archive`, `docs/plans`, `docs/backlog.md` and the committed generated files under `.claude/types/`, returns nothing.
- `.gitignore` carries `.claude-plugin/types/`, and a run of `claude -p "/version" --plugin-dir <checkout>` under an empty `CLAUDE_CONFIG_DIR` leaves `git status --short` in the checkout showing nothing under `.claude-plugin/`.
- The README's types section carries the one-line probe command and the copy step to `.claude/types/claude-code.d.ts`, and no stream-json invocation.

Files in scope: `bin/upgrade-check.mjs`, `.kit/upgrade-check-unit-test.mjs`, `.kit/fixtures/upgrade-check/claude`, `README.md`, `.gitignore`.
Tests: the probe's shape and place, pinned through the call log and the scratch tree, since a probe the engine does not load writes nothing and the step would read fail with no cause; the config directory inside the scratch folder, since a run under the real config costs a model call and depends on login; the old invocation refused by the fixture, so it cannot return.

## Out of Scope

- Moving the committed declarations to the engine's `.claude-plugin/types/` layout and adopting the tsconfig it writes: a later plan, once the fleet has run on this step for a release or two.
- Regenerating `.claude/types/claude-code-mcp.d.ts`: the probe connects no tools, so the backlog's two items on the mirror stay open.
- Step 7, the skill text, and the archived plans that mention `/plugin-types`.
- The committed generated files under `.claude/types/`, whose headers name `/plugin-types` as their writer: the next regeneration rewrites the headers from the engine.
- The kit memory store's operator-tier record that says `/plugin-types` works headless behind the function-hooks flag, which the post-upgrade cleanup plan already names as the operator's own session's to retire.

## Assumptions

- assumed 2026-10-02 (source: three runs on this machine's installed 2.1.287 build, and the predecessor's run of the native package, all byte-identical): the engine writes `.claude-plugin/types/claude-code/index.d.ts` beside a `--plugin-dir` plugin on load, with no login and no flag; reversal: a 2.1.287 run of the probe command that writes nothing reopens the plan before any edit lands.
- assumed 2026-10-02 (default): the probe's module is plain JavaScript exporting `register`, which is the shape confirmed, rather than the checkout's TypeScript shape; reversal: none needed, since the probe is not the plugin under test.
- assumed 2026-10-02 (default): the pass criterion stays exit 0 plus the file present, with the first line as evidence, rather than a match of the first line's version against step 1; reversal: add the match in a later change if a stale file ever reads as the new build's, which the emptied scratch folder already guards.

## Operator Verification

- None. The pre run on the fleet's checkout is the worker's, and the next real upgrade is the live check.

## Open Questions

- None.

## Chapters
