# The natural-exit suite's heartbeat writer ends itself, so no run leaves a process behind

Status: Ready
Commit Model: Branch-and-PR
Created: 2026-10-01

## Goal

A run of `.kit/supervisor-natural-exit-test.sh` leaves no process on the machine when it ends, whatever path ended it. Today every run leaves one `node.exe` behind, with the Git Bash wrapper that launched it, looping every two seconds on a heartbeat fixture the run deleted at its exit. Five such pairs sat on this machine on 2026-10-01, one per run since 09:15 local, each writing to a path under a `D:\Temp\tmp.*` folder that no longer exists. When this ships, the writer exits on its own the moment its fixture is gone, and after a fixed lifetime even if the fixture is not, so the kill the suite sends it is a courtesy and never the only thing standing between a run and a leak. The five leftovers are swept as part of the work.

## Intent

The coordinator persona's finding, sent to the architect on 2026-10-01 while starting the time-limit fix's finishing gate: "The natural-exit live test leaves one idle heartbeat-writer process behind on every run. Five sit on this machine now ... each a bash.exe running .kit/supervisor-natural-exit-test.sh with one node.exe child looping on a heartbeat file." The coordinator proposed killing the writer through its Windows process id or having it exit on its own once the fixture is gone, then sweeping the leftovers.

What done needs to do. The heartbeat writer the (ne) and (nh) cases start reads its fixture every two seconds as it does today, and exits with status 0 on the first read that finds the fixture missing. It also exits on its own after a lifetime the caller names, with no help from any kill. The two cases share one writer, started through one shell function, so the fix cannot drift between them. The (ne) and (nh) checks pass as they do today. After a run of either case, no `node.exe` whose command line names that run's fixture path remains, and no Git Bash wrapper remains with it. The five leftovers on this machine are ended.

What done does not need to do. It does not change what the suite proves about the supervisor: the writer is a fixture that simulates a live persona claim, and its cadence and the fixture shape stay as they are. It does not change the supervisor. It does not fix the suite's other reds, which `docs/backlog.md` on branch `backlog/natural-exit-red-on-main` records as three root_complete pin checks and the (pkdu) case, and which this plan's gate therefore does not run. It does not add a general process sweep to the suite's exit trap: `kill_leaked_survivors` kills what a case's stub recorded as a "pid,ticks" pair, and a writer that ends itself needs no entry there.

Alternatives refused. Killing the writer through its Windows process id, the coordinator's first option: refused as the whole fix, because a kill that runs only when the outer subshell reaches it is the shape that leaks today, and a kill from the parent needs the Windows pid read back out of Git Bash, which is one more thing to get wrong. The self-exit closes the leak whatever the kill path does, and the existing kill stays as a faster end. Recording the writer in the survivor snapshot so the exit trap sweeps it: refused, since that mechanism exists for processes the supervisor itself should have killed, and the writer is the suite's own. Leaving the writer as it is and sweeping leftovers by hand: refused, the finding is that this repeats on every run.

Rulings after the spec shipped, each appended dated. None yet.

Provenance: distilled by the ARCHITECT persona on 2026-10-01 from the coordinator's proposal, the suite at origin/main `0fb2a08`, `bin/supervise.sh` at the same commit, and the live process list on this machine read the same day.

## Approach

**Where the writer starts and where it should end.** `.kit/supervisor-natural-exit-test.sh:2381` starts the (ne) writer inside a backgrounded subshell: sleep 8, start `node -e ... &`, write its pid to `hb.pid`, sleep 130, kill that pid. The parent runs the supervisor in the foreground, which ends at `GATE TIMEOUT` after `SUPERVISOR_GATE_WAIT_S`, 120 seconds by default at `bin/supervise.sh:229`, then kills the subshell at `:2385`. So the parent's kill reaches the subshell while it is still inside its `sleep 130`, and the subshell's own kill of the writer never runs. `:2499` starts the (nh) writer the same way with sleep 6 and sleep 60, and the parent kills that subshell about nine seconds in, before its inner kill too. Why (ne) leaks on every run and (nh) left nothing on this machine is not reproduced: the five leftovers are all (ne) writers, and whether the Git Bash signal to a subshell reaches a native child it started is the open question. Section 1 reproduces before it fixes, so the plan's cause is checked and not assumed.

**The writer.** One shell function, `start_heartbeat_writer <fixture> <persona> <delay s> <lifetime s>`, replaces both inline subshells. It backgrounds the same `node -e` loop with two additions: a read whose error code is `ENOENT` ends the process with status 0, and a timer of `<lifetime>` seconds ends it the same way. Any other error on a read, such as a parse error on a half-written file, is swallowed as today, since the fixture is rewritten in place and a torn read is expected. The function writes the writer's pid where the cases read it today, and the cases keep their kills as they are. The lifetimes are the ones the inline subshells name, 130 and 60 seconds.

**The reproduction and the gate.** Before the fix, the (ne) case run alone with `--cases ne` leaves a writer behind, read from the process list by its command line, which names the run's fixture path. After the fix the same run leaves none, and the (ne) checks still pass. The (nh) case takes the same read both ways. The process list is read with the PowerShell `Get-CimInstance Win32_Process` query, since `wmic` is absent on this machine, and the read is keyed on the fixture path under the run's own `TMP`, never on a pid.

**The sweep.** The five leftovers are ended by their current Windows pids after re-reading the process list and confirming each still names a `D:\Temp\tmp.*\ne\wd\.agentic-heartbeat.json` path whose folder does not exist. The node is ended first and its parent bash second. Nothing else on the machine matches that path shape.

## Sections of Work

### 1. The writer ends itself, the two cases share it, and the leftovers go

Model: opus

The reproduction runs first and its reading is recorded in the Chapter. Then the function lands, both cases call it, the reproduction reruns green, and the five leftovers are ended.

Acceptance:
- Before the change, `bash .kit/supervisor-natural-exit-test.sh --cases ne` ends with a `node.exe` still running whose command line names `<TMP>/ne/wd/.agentic-heartbeat.json`, read from the process list within a minute of the run's exit. The Chapter records the reading with the pid and the path.
- After the change, the same run leaves no process whose command line names that path, read the same way, and the two (ne) checks pass. `--cases nh` reads the same both ways and its two checks pass.
- The writer, started by hand against a fixture file that is then deleted, exits with status 0 within four seconds of the deletion. Started against a fixture that stays, with a lifetime of 5, it exits with status 0 within seven seconds.
- `grep -c 'lastSeen=Date.now()' .kit/supervisor-natural-exit-test.sh` reads 1, since both cases call the one function.
- The five leftover pairs on this machine are gone: `Get-CimInstance Win32_Process` filtered on a command line containing `agentic-heartbeat.json` returns nothing whose path sits under `D:\Temp`. The Chapter names the pids ended.
- The suite's `--units` block and the other cases are not run as the gate, since the backlog branch records them red on main for reasons outside this plan. The Chapter says so.

Files in scope: `.kit/supervisor-natural-exit-test.sh`.
Tests: the reproduction both ways on (ne) and (nh); the writer's two self-exits by hand.

## Out of Scope

- The supervisor's own stop path and `kill_leaked_survivors`.
- The suite's reds on main recorded on branch `backlog/natural-exit-red-on-main`.
- A general sweep of orphaned processes in the suite's exit trap.
- `.kit/supervisor-natural-exit-parallel.sh`, which only schedules the suite's cases and does not start the writer.

## Assumptions

- assumed 2026-10-01 (source: the process list on this machine read 2026-10-01, five `node.exe` under five `bash.exe`, both created in the same second, each node naming a `ne/wd` fixture under a deleted `D:\Temp\tmp.*` folder): the leftover bash beside each node is the wrapper Git Bash keeps around a native process it launched, not the outer subshell; reversal: none needed, the self-exit ends the node and the wrapper ends with it.
- assumed 2026-10-01 (inferred from the suite's timing, not reproduced): the parent's kill at `:2385` lands on the outer subshell during its `sleep 130`, so the inner kill never runs; reversal: the section's reproduction reads the real sequence, and the fix holds whichever path orphaned the writer.
- assumed 2026-10-01 (default): the writer's self-exit on a missing fixture reads the error's `code` for `ENOENT` and nothing wider, so a torn read keeps looping; reversal: one condition.
- assumed 2026-10-01 (default): the blind read and the plan review are skipped, since the spec is one section over one test fixture.

## Operator Verification

- After this merges, run the suite once on this machine and read the process list a minute after it exits. No `node.exe` names an `agentic-heartbeat.json` path. One that does reopens section 1.

## Open Questions

- None.

## Chapters
