#!/usr/bin/env node
// Unit test for bin/supervise-decide.mjs (the "is a restart due" decision unit).
// Run: node .kit/supervisor-unit-test.mjs
// Exits 0 on all-pass, 1 on any failure.

import { strict as assert } from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const decidePath = resolve(here, '../bin/supervise-decide.mjs');

let decide;
try {
  const mod = await import(pathToFileURL(decidePath).href);
  decide = mod.decide;
} catch (e) {
  console.error('FAIL: could not import ' + decidePath + ': ' + e.message);
  process.exit(1);
}

const cases = [
  // shutdown_requested newer than start, no root_complete: stop_complete
  // (the operator asked the supervisor itself to stop).
  {
    name: 'shutdown_requested, no root_complete: stop_complete',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: 2000,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'stop_complete',
  },
  // Both root_complete and shutdown_requested newer than start:
  // shutdown_requested takes priority over restart_passive.
  {
    name: 'root_complete AND shutdown_requested: stop_complete wins',
    input: {
      childExitCode: null,
      rootCompleteTs: 1500,
      shutdownRequestedTs: 2000,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'stop_complete',
  },
  // root_complete is older than childStartTs (a stale fact from a prior
  // goal, still sitting in the decision log): must not fire restart_passive
  // again on a child that already restarted past it.
  {
    name: 'stale root_complete (older than child start): continue',
    input: {
      childExitCode: null,
      rootCompleteTs: 500,
      shutdownRequestedTs: null,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'continue',
  },
  // restart_requested newer than start (plan item 8.3: a reader asked
  // for the child to be relaunched, the runtime was updated): restart_passive,
  // the same relaunch-and-keep-the-tree path root_complete takes.
  {
    name: 'restart_requested, no root_complete: restart_passive',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: null,
      restartRequestedTs: 2000,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'restart_passive',
  },
  // Both restart_requested and shutdown_requested newer than start:
  // stopping the supervisor outranks relaunching its child.
  {
    name: 'restart_requested AND shutdown_requested: stop_complete wins',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: 2000,
      restartRequestedTs: 2500,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'stop_complete',
  },
  // restart_requested older than childStartTs (the request that launched
  // this very child, still in the decision log): must not relaunch again.
  {
    name: 'stale restart_requested (older than child start): continue',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: null,
      restartRequestedTs: 500,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'continue',
  },
  // context_budget_crossed critical newer than start: restart.
  {
    name: 'critical newer than start: restart',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      criticalTs: 2000,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'restart',
  },
  // Heartbeat lastSeen older than staleAfterMs, heartbeatSessionId = childSessionId, past grace: restart.
  {
    name: 'stale heartbeat, own session, past grace: restart',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: 1000,
      now: 100000,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'restart',
  },
  // Heartbeat lastSeen older than staleAfterMs, heartbeatSessionId names another session: do not restart (waiting).
  {
    name: 'stale heartbeat, other session: no restart (waiting)',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-0',
      heartbeatLastSeen: 1000,
      now: 100000,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'continue',
  },
  // Heartbeat lastSeen older than staleAfterMs, own session, within grace: do not restart.
  {
    name: 'stale heartbeat, own session, within grace: no restart',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: 1000,
      now: 150000,
      launchedAt: 140000,
      staleAfterMs: 90000,
    },
    expected: 'continue',
  },
  // Restart budget exhausted (7th in the hour): stop_budget.
  {
    name: 'restart budget exhausted: stop_budget',
    input: {
      childExitCode: 1,
      rootCompleteTs: null,
      criticalTs: null,
      crashCount: 0,
      restartCount: 6,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
      maxRestartsPerHour: 6,
    },
    expected: 'stop_budget',
  },
  // A backfilled root_complete never triggers a restart: the worker did
  // real work with no active goal tree, not a real completion.
  {
    name: 'backfilled root_complete: no restart',
    input: {
      childExitCode: null,
      rootCompleteTs: 2000,
      shutdownRequestedTs: null,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
      rootCompleteBackfilled: true,
    },
    expected: 'continue',
  },
  // Control: the same shape, but not backfilled - still restarts as
  // it always has (proves the new field only changes behavior when true).
  {
    name: 'real (non-backfilled) root_complete: still restart_passive',
    input: {
      childExitCode: null,
      rootCompleteTs: 2000,
      shutdownRequestedTs: null,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
      rootCompleteBackfilled: false,
    },
    expected: 'restart_passive',
  },
  // A backfilled root must not pre-empt the hung check. A goal-less worker
  // sitting on a backfilled root_complete forever, with a stale own-session
  // heartbeat past grace, still restarts.
  {
    name: 'backfilled root_complete + stale heartbeat past grace: still restart',
    input: {
      childExitCode: null,
      rootCompleteTs: 2000,
      shutdownRequestedTs: null,
      criticalTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: 1000,
      now: 100000,
      launchedAt: 900,
      staleAfterMs: 90000,
      rootCompleteBackfilled: true,
    },
    expected: 'restart',
  },
  // A backfilled root must not pre-empt the critical context-budget check
  // either.
  {
    name: 'backfilled root_complete + critical crossing: still restart',
    input: {
      childExitCode: null,
      rootCompleteTs: 2000,
      shutdownRequestedTs: null,
      criticalTs: 2500,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
      rootCompleteBackfilled: true,
    },
    expected: 'restart',
  },
  // The crash-loop stop counts against the supervisor's own limit, not a
  // fixed 3: three crashes under a limit of five is still a restart.
  {
    name: 'three crashes under crashLimit 5: restart, not stop_crash_loop',
    input: {
      childExitCode: 1,
      rootCompleteTs: null,
      criticalTs: null,
      crashCount: 3,
      crashLimit: 5,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'restart',
  },
  // Reaching the limit stops.
  {
    name: 'five crashes under crashLimit 5: stop_crash_loop',
    input: {
      childExitCode: 1,
      rootCompleteTs: null,
      criticalTs: null,
      crashCount: 5,
      crashLimit: 5,
      restartCount: 0,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
    },
    expected: 'stop_crash_loop',
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  try {
    const result = decide(c.input);
    assert.equal(result.action, c.expected, c.name + ': expected ' + c.expected + ', got ' + result.action);
    console.log('PASS: ' + c.name);
    pass++;
  } catch (e) {
    console.error('FAIL: ' + c.name + ': ' + e.message);
    fail++;
  }
}
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
