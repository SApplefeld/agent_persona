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
  // 1. Child exited non-zero, no root_complete, no critical crossing: restart.
  {
    name: 'exit non-zero, no root_complete, no critical: restart',
    input: {
      childExitCode: 1,
      rootCompleteTs: null,
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
    expected: 'restart',
  },
  // 2. Child exited non-zero, root_complete newer than start, no shutdown
  // requested: restart_passive (plan item 4 - the goal is done, but the
  // supervisor stays up for a second goal rather than exiting).
  {
    name: 'exit non-zero, root_complete, no shutdown: restart_passive',
    input: {
      childExitCode: 1,
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
    },
    expected: 'restart_passive',
  },
  // 2b. shutdown_requested newer than start, no root_complete: stop_complete
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
  // 2c. Both root_complete and shutdown_requested newer than start:
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
  // 2d. root_complete is older than childStartTs (a stale fact from a prior
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
  // 3. context_budget_crossed critical newer than start: restart.
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
  // 4. context_budget_crossed closeout (not critical): do not restart.
  {
    name: 'closeout only: no restart',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
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
  // 5. Heartbeat lastSeen older than staleAfterMs, heartbeatSessionId = childSessionId, past grace: restart.
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
  // 6. Heartbeat lastSeen older than staleAfterMs, heartbeatSessionId names another session: do not restart (waiting).
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
  // 7. Heartbeat lastSeen older than staleAfterMs, own session, within grace: do not restart.
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
  // 8. 3 consecutive exits within minRunMs: stop_crash_loop.
  {
    name: 'crash loop (3 within minRunMs): stop_crash_loop',
    input: {
      childExitCode: 1,
      rootCompleteTs: null,
      criticalTs: null,
      crashCount: 3,
      restartCount: 2,
      childStartTs: 1000,
      childSessionId: 'sess-1',
      heartbeatSessionId: 'sess-1',
      heartbeatLastSeen: null,
      launchedAt: 900,
      staleAfterMs: 90000,
      minRunMs: 120000,
    },
    expected: 'stop_crash_loop',
  },
  // 9. Restart budget exhausted (7th in the hour): stop_budget.
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
