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
  // 2. Child exited non-zero, root_complete newer than start: stop_complete.
  {
    name: 'exit non-zero, root_complete: stop_complete',
    input: {
      childExitCode: 1,
      rootCompleteTs: 2000,
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
