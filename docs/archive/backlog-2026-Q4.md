# Backlog snapshot 2026-Q4

Backlog items retired during the fourth quarter of 2026, each with the reason it left the active list. The previous quarter's snapshot is `backlog-2026-Q3.md`.

## The natural-exit suite's case (nf) leaves its first supervisor and holder running (found 2026-09-29)

Each whole run of `.kit/supervisor-natural-exit-test.sh` leaves two processes behind: the `bin/supervise.sh` that case `(nf)` starts through `sup_bg`, and its `bin/supervise-holder.sh`. Both keep running after the suite deletes their temp root. They also pin the worktree they ran from, so `git worktree remove` fails with "Permission denied". The deferred gate run's two whole runs, at 22:03Z and 23:12Z on 2026-09-29, each left one such pair, and both were killed by hand. The supervisor interrupt branch's baseline run on 2026-09-30 left the same shape under its temp root's `nf/` directory: the supervisor, its holder, a helper bash and a node process, alive 25 minutes after the suite exited 0. They were stopped by hand. Case `(nf)` is the suspected source from that path, and no trace to the exact line was made.

The cause is inferred, not confirmed. `sup_bg` records `$!` from `env -i ... bash supervise.sh &`, which is the `env` process. Under MSYS that wrapper likely does not exec into bash, so the case's `kill -TERM "$NF_SUP1"` does not reach the supervisor. The holder outlives a supervisor stop by design. Confirming takes one `(nf)` run with the process list read before and after its TERM.

Remedy: the suite records the pid of every supervisor it launches, and kills that set from an EXIT trap, whatever path the run exits by. So a failing case cannot skip the cleanup. The case's own holder is stopped by the pid its run directory records, ticks-matched as `kill_leaked_survivors` does.

Pin: the suite's last step lists the processes whose command line carries the run's own temp path, and fails the run if any remain. That listing is the withheld control that proves the trap ran.

_Retired 2026-10-02: the natural-exit supervisor-tree plan (`docs/archive/agent_persona_natural-exit-supervisor-tree_spec_v1.md`) has the (nf) and (na) cases end the child a TERM detaches, by the holder's Windows pid and start ticks, and the suite's exit listing fails any run that leaves a process naming its temp root. The env-wrapper reading was refuted: the process left under a `bin/supervise.sh` command line was child-1's wrapper, and the first supervisor exits 143. The exit-trap kill remedy was refused in favour of the in-case teardown._
