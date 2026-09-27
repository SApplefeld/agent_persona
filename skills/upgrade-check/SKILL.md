---
name: upgrade-check
description: "Use when the operator asks for the upgrade check, types upgrade-check, or a new Claude Code build is on disk and no persona has restarted onto it yet. Validates the new build against agentic-plugin on this persona as the canary, restarts it onto the build, and gives the operator one verdict: clear to restart the fleet, or a named list to triage."
---

# Upgrade check

Run this on one persona, the canary, before any other persona restarts onto a new Claude Code build. The function-hooks API is early access and changes between releases without notice, so the plugin can break on an update with no error at install. The check has two halves. The first runs before this session restarts. The second runs in the session that comes back.

`bin/upgrade-check.mjs` under the plugin root does the mechanics. This skill says how to call it, how to read what it prints, and what to tell the operator. Never run the steps by hand, and never judge a verdict the script did not print.

## Inputs

- **The plugin root.** The installed copy under `~/.claude/plugins/cache/agent-persona/agentic-plugin/<hash>/`, or the checkout a `--dev` launch loads. Call the script by its absolute path there.
- **`--repo`.** The checkout the fleet's scheduled tasks start personas from, `D:/agent_persona` on the fleet machine. It must have had `npm install` run once, since the compile step uses its `node_modules/typescript`. The installed plugin copy is never a valid `--repo`, because it carries no `node_modules`.
- **`--results`.** The directory that holds the fleet roster, `D:/personas` on the fleet machine. The rows land in `upgrade-checks.jsonl` there, and `upgrade-checks.md` beside it is regenerated from them. Never point it at a scratch folder for a real run, or the next canary cannot find the record.
- **`--canary`.** This persona's name, so the table says which persona ran it.
- **The run directory.** The folder holding this persona's `heartbeat.json`, `settings.json` and `supervisor.log`. It is the directory of the file `$SUPERVISOR_HEARTBEAT_PATH` names.

## Before the restart

1. Run `pre` in the background, since it can take up to about 21 minutes when every step runs to its three-minute timeout. Have the run write its own exit code, then wait on that file rather than on a fixed sleep:

   ```
   node <plugin root>/bin/upgrade-check.mjs pre --repo D:/agent_persona --results D:/personas --canary <persona> > <tmp>/upgrade-pre.log 2>&1; echo $? > <tmp>/upgrade-pre.exit
   ```

2. Read the exit code from `upgrade-pre.exit`, and the last line of `upgrade-pre.log` for the verdict. The lines above it are one per step, as `<step>: <result> - <evidence>`.
   - **Exit 0, `pre: clear to restart the canary onto <version> (run <id>)`.** Go to step 3.
   - **Exit 1, `pre: triage <steps> (run <id>)`.** Reply to the operator with the verdict line and, for each failing step, its row's evidence. Stop there. Do not restart.
   - **Exit 2, `upgrade-check: cannot run: <reason>`.** Nothing was recorded. Fix what the reason names if it is yours to fix, else send the reason to the operator. A scratch folder refused because it holds files and no `.upgrade-check-scratch` marker was left by something else. Delete it by hand only after reading what is in it, or pass `--scratch` naming an empty folder.
3. Create the goal that carries the second half, with `goal_create`. The new session starts with no memory of this one, and the goal tree is what survives the restart. The objective must carry the run id from the verdict line and the whole `post` command, for example:

   > Finish upgrade check run <id>. Call goal_status, call agentic_inbox on the coordinator persona, and send one relay reply. Then run: node <plugin root>/bin/upgrade-check.mjs post --run <id> --results D:/personas --rundir <run directory> --tools "ok" (or --tools "fail: <which call failed and how>"). Reply to the operator with the post verdict line and the path D:/personas/upgrade-checks.md.

4. Call `supervisor_restart` with the reason "upgrade check run <id>: restarting the canary onto <version>".

## After the restart

The goal tells the new session what to do, and this section says how to read it.

1. Call `goal_status`, `agentic_inbox` on the coordinator persona, and send one relay reply. Pass `--tools "ok"` where all three worked, else `--tools "fail: <reason>"` naming the one that did not.
2. Run the `post` command from the goal. It takes about a heartbeat interval plus five seconds, since it watches the heartbeat advance.
3. Reply to the operator with the verdict line and the table's path. `post: fleet clear to restart onto <version> (run <id>)` means the fleet can restart. `post: triage <list> (run <id>)` means it cannot yet, so add each failing row's evidence.
4. Mark the goal done.

## Reading the results

- **Step 6 reads `gap` on every run today.** The plugin has no engine tests, so there is nothing for `claude plugin test` to run. A gap does not block the verdict. A `pass` would mean tests exist and passed.
- **Step 7 proves only that the plugin loads.** Its hooks stay passive in the empty scratch folder, so the turn hooks get their first real test at the canary restart.
- **The relaunch pre-gate writes `FAIL` lines for about ninety seconds** while the old session's heartbeat ages out. That is expected and is not a failure. Those lines sit before the new `LAUNCH child-` line in `supervisor.log`, and `post` reads only what follows that line, so its count of them usually reads 0.
- **A second run appends.** Rerunning on the same build adds a new run under the same version heading and overwrites nothing, so the table is the record of every attempt.

## What to tell the operator

The operator reads the verdict on Discord and cannot open files. Send the verdict line as printed, one sentence on what it means, and the table's path. On triage, add each failing step's name and its evidence line. Leave out the run id unless the operator asks for it, since the goal and the table already carry it.
