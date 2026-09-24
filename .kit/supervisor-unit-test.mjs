#!/usr/bin/env node
// Unit test for bin/supervise-decide.mjs (the "is a restart due" decision unit)
// and bin/supervise-liveness.mjs (the alive, frozen or gone verdict it reads).
// Run: node .kit/supervisor-unit-test.mjs
// Exits 0 on all-pass, 1 on any failure.

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const decidePath = resolve(here, '../bin/supervise-decide.mjs');

const livenessPath = resolve(here, '../bin/supervise-liveness.mjs');

let decide;
let liveness;
let projectKey;
let transcriptPathsFor;
let isUsageLimitRecord;
try {
  const mod = await import(pathToFileURL(decidePath).href);
  decide = mod.decide;
  ({ liveness, projectKey, transcriptPathsFor, isUsageLimitRecord } = await import(pathToFileURL(livenessPath).href));
} catch (e) {
  console.error('FAIL: could not import ' + decidePath + ' or ' + livenessPath + ': ' + e.message);
  process.exit(1);
}

// A snapshot with no stop, restart or completion in it, so the liveness
// verdict is the only thing that can decide the action.
const QUIET = { childExitCode: null, rootCompleteTs: null, shutdownRequestedTs: null, crashCount: 0, restartCount: 0, childStartTs: 1000 };
const DETAIL = 'transcript 1200s, stream 1200s, heartbeat 600s, probe 60s unacknowledged, walk live';
const FROZEN = { verdict: 'frozen', reason: 'all_silent', detail: DETAIL };
const GONE = { verdict: 'gone', reason: 'all_silent', detail: DETAIL.replace('walk live', 'walk none') };
const ALIVE = { verdict: 'alive', reason: 'signal', detail: DETAIL };

const cases = [
  // shutdown_requested newer than start, no root_complete: stop_complete
  // (the operator asked the supervisor itself to stop).
  {
    name: 'shutdown_requested, no root_complete: stop_complete',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: 2000,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
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
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
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
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
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
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
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
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
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
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
    },
    expected: 'continue',
  },
  // park_requested newer than start, nothing else: stop_park (the persona
  // parked for an update window, and the keeper's next start brings it back).
  {
    name: 'park_requested, no other signal: stop_park',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: null,
      parkRequestedTs: 2000,
      restartRequestedTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
    },
    expected: 'stop_park',
    expectedReasonIncludes: 'park_requested at 2000 > child start 1000',
  },
  // Both shutdown_requested and park_requested newer than start: a stop for
  // good outranks a park, so the persona stays down.
  {
    name: 'shutdown_requested AND park_requested: stop_complete wins',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: 2000,
      parkRequestedTs: 2500,
      restartRequestedTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
    },
    expected: 'stop_complete',
  },
  // Both park_requested and restart_requested newer than start: stopping the
  // supervisor outranks relaunching its child, as it does for a shutdown.
  {
    name: 'park_requested AND restart_requested: stop_park wins',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: null,
      parkRequestedTs: 2000,
      restartRequestedTs: 2500,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
    },
    expected: 'stop_park',
  },
  // park_requested older than childStartTs (the park an earlier supervisor
  // honored, still in the decision log): must not park the relaunched child.
  {
    name: 'stale park_requested (older than child start): continue',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: null,
      parkRequestedTs: 500,
      restartRequestedTs: null,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
    },
    expected: 'continue',
  },
  // Restart budget exhausted (7th in the hour): stop_budget.
  {
    name: 'restart budget exhausted: stop_budget',
    input: {
      childExitCode: 1,
      rootCompleteTs: null,
      crashCount: 0,
      restartCount: 6,
      childStartTs: 1000,
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
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
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
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
      rootCompleteBackfilled: false,
    },
    expected: 'restart_passive',
  },
  // The crash-loop stop counts against the supervisor's own limit, not a
  // fixed 3: three crashes under a limit of five is still a restart.
  {
    name: 'three crashes under crashLimit 5: restart, not stop_crash_loop',
    input: {
      childExitCode: 1,
      rootCompleteTs: null,
      crashCount: 3,
      crashLimit: 5,
      restartCount: 0,
      childStartTs: 1000,
    },
    expected: 'restart',
  },
  // Reaching the limit stops.
  {
    name: 'five crashes under crashLimit 5: stop_crash_loop',
    input: {
      childExitCode: 1,
      rootCompleteTs: null,
      crashCount: 5,
      crashLimit: 5,
      restartCount: 0,
      childStartTs: 1000,
    },
    expected: 'stop_crash_loop',
  },
  // The decide unit has no context-budget input. A snapshot that still carries
  // one, from a caller that kept the field, is a snapshot with no restart
  // trigger in it: the field is read by nothing and the healthy child stays
  // up. The other reachable shape, a crossing an older plugin already wrote
  // into a store on disk, is pinned in .kit/supervisor-poll-unit-test.mjs,
  // where the store read itself lives.
  {
    name: 'a criticalTs newer than the child start is not a restart trigger',
    input: {
      childExitCode: null,
      rootCompleteTs: null,
      shutdownRequestedTs: null,
      criticalTs: 2000,
      crashCount: 0,
      restartCount: 0,
      childStartTs: 1000,
    },
    expected: 'continue',
    expectedReasonIncludes: 'no restart trigger',
  },

  // The liveness verdict's branch. Each pair varies the one input that flips
  // the action, so a branch keyed on anything else reds on one side.
  // frozen with no final ask written yet: the ask, once.
  {
    name: 'liveness frozen, no final ask yet: final_ask',
    input: { ...QUIET, liveness: FROZEN, finalAskAt: null, finalAskMs: 660000, now: 5000000 },
    expected: 'final_ask',
    expectedReasonIncludes: 'frozen: every signal is silent and the walk found a live process (transcript 1200s',
  },
  // The flip: the same snapshot read alive asks nothing.
  {
    name: 'liveness alive, no final ask yet: continue, no ask',
    input: { ...QUIET, liveness: ALIVE, finalAskAt: null, finalAskMs: 660000, now: 5000000 },
    expected: 'continue',
    expectedReasonIncludes: 'no restart trigger',
  },
  // A usage limit reads alive with its own reason, and alive never asks.
  {
    name: 'liveness alive on a usage limit, every signal silent: continue, never final_ask',
    input: { ...QUIET, liveness: { verdict: 'alive', reason: 'usage_limit', detail: 'x' }, finalAskAt: null, now: 5000000 },
    expected: 'continue',
  },
  // Inside the ask's window the frozen child is waited on, not asked again.
  {
    name: 'liveness frozen, final ask exactly finalAskMs old: continue inside the window',
    input: { ...QUIET, liveness: FROZEN, finalAskAt: 5000000 - 660000, finalAskMs: 660000, now: 5000000 },
    expected: 'continue',
    expectedReasonIncludes: 'final_ask_window: the final ask at 4340000 is inside 660000ms',
  },
  // One millisecond past the window with every signal still silent: restart,
  // with the reason naming the ask and the five signals.
  {
    name: 'liveness frozen, final ask one ms past finalAskMs: restart',
    input: { ...QUIET, liveness: FROZEN, finalAskAt: 5000000 - 660001, finalAskMs: 660000, now: 5000000 },
    expected: 'restart',
    expectedReasonIncludes: 'frozen: the final ask at 4339999 went unanswered past 660000ms (transcript 1200s, stream 1200s, heartbeat 600s, probe 60s unacknowledged, walk live)',
  },
  // The same window closed, with the reading alive: no restart. The poll loop
  // clears the ask's time on this reading, and this is the decide unit's half.
  {
    name: 'liveness alive with a final ask past its window: continue',
    input: { ...QUIET, liveness: ALIVE, finalAskAt: 5000000 - 660001, finalAskMs: 660000, now: 5000000 },
    expected: 'continue',
  },
  // gone sweeps and relaunches; alive in the same snapshot does not.
  {
    name: 'liveness gone: sweep_relaunch',
    input: { ...QUIET, liveness: GONE, now: 5000000 },
    expected: 'sweep_relaunch',
    expectedReasonIncludes: 'gone: every signal is silent and the walk found no live process',
  },
  // No reading at all is never a liveness restart.
  {
    name: 'no liveness reading: continue',
    input: { ...QUIET, now: 5000000 },
    expected: 'continue',
  },
  // A backfilled root never pre-empts the liveness branch: a goal-less child
  // that stays frozen past the ask's window still restarts.
  {
    name: 'backfilled root_complete + frozen past the final ask window: still restart',
    input: { ...QUIET, rootCompleteTs: 2000, rootCompleteBackfilled: true, liveness: FROZEN, finalAskAt: 1000, finalAskMs: 660000, now: 5000000 },
    expected: 'restart',
    expectedReasonIncludes: 'frozen: the final ask at 1000 went unanswered',
  },
  // The stops above the liveness branch outrank it.
  {
    name: 'restart budget exhausted outranks a frozen reading: stop_budget',
    input: { ...QUIET, restartCount: 6, maxRestartsPerHour: 6, liveness: FROZEN, now: 5000000 },
    expected: 'stop_budget',
  },
  {
    name: 'a child exit outranks a frozen reading: restart on the exit',
    input: { ...QUIET, childExitCode: 1, liveness: FROZEN, now: 5000000 },
    expected: 'restart',
    expectedReasonIncludes: 'child exited with code 1',
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  try {
    const result = decide(c.input);
    assert.equal(result.action, c.expected, c.name + ': expected ' + c.expected + ', got ' + result.action);
    // A case that names expectedReasonIncludes is asserting on what the
    // operator reads in the log, not only on the action, so the reason is
    // checked as well. Cases without it assert on the action alone.
    if (c.expectedReasonIncludes) {
      assert.ok(
        String(result.reason).includes(c.expectedReasonIncludes),
        c.name + ": expected the reason to contain '" + c.expectedReasonIncludes + "', got '" + result.reason + "'",
      );
    }
    console.log('PASS: ' + c.name);
    pass++;
  } catch (e) {
    console.error('FAIL: ' + c.name + ': ' + e.message);
    fail++;
  }
}

// --- The liveness verdict, bin/supervise-liveness.mjs ---
// Each case writes its own fixture transcripts under its own temp directory,
// with every record's timestamp set explicitly, so a case reads the turn
// records it names and never a real transcript under the home directory.
//
// FROZEN_INPUT is the reading every signal silent gives: a transcript whose
// newest turn record is twenty minutes old, a stream unchanged for twenty
// minutes, a heartbeat ten minutes old against a ninety-second bound, a probe
// a minute past a thirty-second window with no ack, a walk that found a live
// process, and a child launched an hour ago. Each case changes the one input
// it names and asserts the verdict flips, and its twin with that input left
// alone asserts it does not.
const root = fs.mkdtempSync(join(os.tmpdir(), 'supervise-liveness-'));
const NOW = Date.parse('2026-09-23T12:00:00Z');
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const turn = (type, ms, extra = {}) => JSON.stringify({ type, timestamp: iso(ms), ...extra });
const systemLine = (ms) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: iso(ms) });

// Writes a session's own transcript and any subagent transcripts, each a list
// of lines, and returns the two paths the verdict takes.
function session(name, own, subagents = {}) {
  const dir = join(root, name);
  fs.mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
  const transcriptPath = join(dir, 'sess.jsonl');
  if (own !== null) fs.writeFileSync(transcriptPath, own.join('\n') + '\n');
  for (const [file, lines] of Object.entries(subagents)) {
    fs.writeFileSync(join(dir, 'sess', 'subagents', file), lines.join('\n') + '\n');
  }
  return { transcriptPath, subagentsDir: join(dir, 'sess', 'subagents') };
}

const FROZEN_INPUT = {
  heartbeat: { lastSeen: NOW - 10 * MIN },
  streamAgeMs: 20 * MIN,
  streamUsageLimit: false,
  probes: [{ id: 's-1', at: NOW - MIN }],
  acks: [],
  probeWindowMs: 30000,
  walk: 'live',
  silenceBoundMs: 15 * MIN,
  staleAfterMs: 90000,
  launchedAt: NOW - 60 * MIN,
  now: NOW,
};
const oldTranscript = (name) => session(name, [turn('user', NOW - 21 * MIN), turn('assistant', NOW - 20 * MIN)]);
const read = (paths, over = {}) => liveness({ ...FROZEN_INPUT, ...paths, ...over });

const livenessCases = [
  ['every signal silent, walk found a live process: frozen', () => {
    const r = read(oldTranscript('frozen'));
    assert.equal(r.verdict, 'frozen');
    assert.equal(r.reason, 'all_silent');
    assert.equal(r.detail, 'transcript 1200s, stream 1200s, heartbeat 600s, probe 60s unacknowledged, walk live');
  }],
  ['the walk flips it: every signal silent, walk found no live process: gone', () => {
    const r = read(oldTranscript('gone'), { walk: 'none' });
    assert.equal(r.verdict, 'gone');
  }],
  ['the walk flips it: a walk that did not complete reads alive, walk_incomplete', () => {
    const r = read(oldTranscript('walk-failed'), { walk: 'failed' });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.reason, 'walk_incomplete');
  }],

  // The transcript. A stale heartbeat beside a fresh turn record stays alive.
  ['the transcript flips it: a stale heartbeat beside a turn record a minute old: alive', () => {
    const r = read(session('fresh-own', [turn('assistant', NOW - 20 * MIN), turn('user', NOW - MIN)]));
    assert.equal(r.verdict, 'alive');
    assert.equal(r.reason, 'signal');
    assert.equal(r.silent.transcript, false);
    assert.equal(r.silent.heartbeat, true);
  }],
  // A session that ended its turn on WAITING: while a dispatch runs writes
  // nothing of its own, and the dispatch's transcript carries it.
  ['the subagent flips it: own transcript silent, a subagent transcript a minute old: alive', () => {
    const r = read(session('fresh-sub', [turn('assistant', NOW - 20 * MIN)], { 'agent-a.jsonl': [turn('assistant', NOW - MIN)] }));
    assert.equal(r.verdict, 'alive');
    assert.equal(r.silent.transcript, false);
    assert.match(r.detail, /transcript 60s \(subagent\)/);
  }],
  ['control: own transcript and subagent transcript both silent: frozen', () => {
    const r = read(session('stale-sub', [turn('assistant', NOW - 20 * MIN)], { 'agent-a.jsonl': [turn('assistant', NOW - 18 * MIN)] }));
    assert.equal(r.verdict, 'frozen');
  }],
  ['a subagent transcript nested a level deeper counts too: alive', () => {
    const paths = session('nested-sub', [turn('assistant', NOW - 20 * MIN)]);
    fs.mkdirSync(join(paths.subagentsDir, 'workflow-1'), { recursive: true });
    fs.writeFileSync(join(paths.subagentsDir, 'workflow-1', 'agent-b.jsonl'), turn('user', NOW - 2 * MIN) + '\n');
    assert.equal(read(paths).verdict, 'alive');
  }],
  // The bound itself, both sides.
  ['the silence bound: a turn record exactly the bound old is not silent: alive', () => {
    const r = read(session('bound-at', [turn('assistant', NOW - 15 * MIN)]));
    assert.equal(r.verdict, 'alive');
    assert.equal(r.silent.transcript, false);
  }],
  ['the silence bound: a turn record one ms past the bound is silent: frozen', () => {
    const r = read(session('bound-past', [turn('assistant', NOW - 15 * MIN - 1)]));
    assert.equal(r.verdict, 'frozen');
  }],
  // The instrument is the record's own timestamp. A file touched just now
  // whose newest record is old moves nothing.
  ['a transcript touched just now whose newest turn record is old: still frozen', () => {
    const paths = oldTranscript('touched');
    const t = new Date(NOW);
    fs.utimesSync(paths.transcriptPath, t, t);
    assert.equal(read(paths).verdict, 'frozen');
  }],
  ['only assistant and user records count: a fresh system record beside old turns: frozen', () => {
    const r = read(session('system-fresh', [turn('assistant', NOW - 20 * MIN), systemLine(NOW - MIN)]));
    assert.equal(r.verdict, 'frozen');
  }],
  // Fail-closed on the transcript.
  ['an unreadable transcript, no file at the path: alive, transcript_unreadable', () => {
    const r = read(session('missing', null));
    assert.equal(r.verdict, 'alive');
    assert.equal(r.reason, 'transcript_unreadable');
  }],
  ['an unknown transcript path: alive, transcript_unreadable', () => {
    const r = read({ transcriptPath: '', subagentsDir: '' });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.reason, 'transcript_unreadable');
  }],
  ['a transcript whose tail holds only system records: alive, transcript_unreadable', () => {
    const r = read(session('system-only', [systemLine(NOW - 20 * MIN), 'not json at all']));
    assert.equal(r.verdict, 'alive');
    assert.equal(r.reason, 'transcript_unreadable');
  }],
  ['a newest turn record more than five minutes ahead of the clock: alive, transcript_ahead', () => {
    const r = read(session('ahead', [turn('assistant', NOW - 20 * MIN), turn('assistant', NOW + 5 * MIN + 1)]));
    assert.equal(r.verdict, 'alive');
    assert.equal(r.reason, 'transcript_ahead');
  }],
  ['a newest turn record four minutes ahead is skew, read as now: alive on the signal', () => {
    const r = read(session('skew', [turn('assistant', NOW + 4 * MIN)]));
    assert.equal(r.verdict, 'alive');
    assert.equal(r.reason, 'signal');
    assert.equal(r.ages.transcript, 0);
  }],
  // Only the last 256 KiB of a transcript is read, so a turn record behind a
  // larger block is out of reach and the tail decides.
  ['the tail window: an old turn record inside it and a fresh one behind 300 KiB of filler: frozen', () => {
    const filler = JSON.stringify({ type: 'system', subtype: 'filler', text: 'x'.repeat(300 * 1024) });
    const r = read(session('tail', [turn('assistant', NOW - MIN), filler, turn('assistant', NOW - 20 * MIN)]));
    assert.equal(r.verdict, 'frozen');
  }],

  // The stream.
  ['the stream flips it: stdout.jsonl grew ten seconds ago, every other signal silent: alive', () => {
    const r = read(oldTranscript('stream-grew'), { streamAgeMs: 10000 });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.silent.stream, false);
  }],
  ['an unreadable stream has no age, which is not silent: alive', () => {
    const r = read(oldTranscript('stream-none'), { streamAgeMs: null });
    assert.equal(r.verdict, 'alive');
  }],

  // The usage limit, read ahead of every other rule.
  ['a usage-limit record newest in the stream, every signal silent, live process: alive, usage_limit', () => {
    const r = read(oldTranscript('usage'), { streamUsageLimit: true });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.reason, 'usage_limit');
  }],
  ['control: the same usage limit with no live process in the walk is not held alive: gone', () => {
    const r = read(oldTranscript('usage-gone'), { streamUsageLimit: true, walk: 'none' });
    assert.equal(r.verdict, 'gone');
  }],

  // The heartbeat: the child's own file, not the shared sidecar.
  ['the heartbeat flips it: a heartbeat stamped ten seconds ago, every other signal silent: alive', () => {
    const r = read(oldTranscript('hb-fresh'), { heartbeat: { lastSeen: NOW - 10000 } });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.silent.heartbeat, false);
  }],
  ['a heartbeat file never written is not silent: alive', () => {
    const r = read(oldTranscript('hb-never'), { heartbeat: null });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.silent.heartbeat, false);
    assert.match(r.detail, /heartbeat never written/);
  }],
  // Chapter 1's fixture: a session parked on its own BLOCKED: declaration,
  // its transcript silent for over two hours while the operator decides, its
  // plugin still stamping. The heartbeat is what holds it alive.
  ['a session parked on its own BLOCKED: line, transcript silent 139 minutes, heartbeat fresh: alive', () => {
    const blocked = session('blocked', [
      turn('user', NOW - 140 * MIN),
      turn('assistant', NOW - 139 * MIN, { message: { role: 'assistant', content: [{ type: 'text', text: 'BLOCKED: the operator decides whether section 2 may widen its scope.' }] } }),
    ]);
    const r = read(blocked, { heartbeat: { lastSeen: NOW - 20000 }, probes: [], acks: [] });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.silent.transcript, true);
    assert.equal(r.silent.heartbeat, false);
  }],
  ['control: the same BLOCKED: session with its heartbeat stale as well: frozen', () => {
    const blocked = session('blocked-stale', [turn('assistant', NOW - 139 * MIN)]);
    assert.equal(read(blocked).verdict, 'frozen');
  }],

  // The probe.
  ['a probe never written is not silent: alive', () => {
    const r = read(oldTranscript('probe-never'), { probes: [] });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.silent.probe, false);
  }],
  ['a probe inside its window is not silent: alive', () => {
    const r = read(oldTranscript('probe-young'), { probes: [{ id: 's-1', at: NOW - 10000 }] });
    assert.equal(r.verdict, 'alive');
  }],
  ['the ack flips it: the probe past its window acknowledged: alive', () => {
    const r = read(oldTranscript('probe-acked'), { acks: [{ id: 's-1' }] });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.silent.probe, false);
  }],
  // A fresh probe every probe interval must not hold a frozen child alive.
  ['an unacknowledged probe past its window stays silent while a newer probe sits inside its own window: frozen', () => {
    const r = read(oldTranscript('probe-newer'), { probes: [{ id: 's-1', at: NOW - 3 * MIN }, { id: 's-2', at: NOW - 10000 }] });
    assert.equal(r.verdict, 'frozen');
    assert.equal(r.silent.probe, true);
  }],
  ['control: the newer probe acknowledged is the child answering: alive', () => {
    const r = read(oldTranscript('probe-newer-acked'), {
      probes: [{ id: 's-1', at: NOW - 3 * MIN }, { id: 's-2', at: NOW - 10000 }], acks: [{ id: 's-2' }],
    });
    assert.equal(r.verdict, 'alive');
  }],

  // The startup grace.
  ['the startup grace flips it: launched five minutes ago, every signal silent: alive, startup_grace', () => {
    const r = read(oldTranscript('grace'), { launchedAt: NOW - 5 * MIN });
    assert.equal(r.verdict, 'alive');
    assert.equal(r.reason, 'startup_grace');
  }],
  ['control: launched sixteen minutes ago, every signal silent: frozen', () => {
    assert.equal(read(oldTranscript('grace-over'), { launchedAt: NOW - 16 * MIN }).verdict, 'frozen');
  }],

  // The project key, and the path it names.
  ['projectKey: this workdir, whose underscore a separator-only rule misses', () => {
    assert.equal(projectKey('D:\\agent_persona'), 'D--agent-persona');
  }],
  ['projectKey: a live-suite workdir, hyphens and digits kept', () => {
    assert.equal(projectKey('D:\\Temp\\agentic-live-d2d3-forced'), 'D--Temp-agentic-live-d2d3-forced');
  }],
  ['transcriptPathsFor: the transcript and its subagents/ directory under the project key', () => {
    const p = transcriptPathsFor('C:\\Users\\someone', 'D:\\agent_persona', 'a581ce96-0b96');
    assert.equal(p.transcriptPath, join('C:\\Users\\someone', '.claude', 'projects', 'D--agent-persona', 'a581ce96-0b96.jsonl'));
    assert.equal(p.subagentsDir, join('C:\\Users\\someone', '.claude', 'projects', 'D--agent-persona', 'a581ce96-0b96', 'subagents'));
  }],
  ['transcriptPathsFor: no profile, no workdir, or a session id that is not a plain token names nothing', () => {
    for (const args of [['', 'D:\\w', 's1'], ['C:\\p', '', 's1'], ['C:\\p', 'D:\\w', ''], ['C:\\p', 'D:\\w', '..\\x']]) {
      assert.deepEqual(transcriptPathsFor(...args), { transcriptPath: '', subagentsDir: '' }, JSON.stringify(args));
    }
  }],

  // The usage-limit record, both kinds and their near misses.
  ['isUsageLimitRecord: the 429 api_retry counts, a 529 does not', () => {
    assert.equal(isUsageLimitRecord({ type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 60000 }), true);
    assert.equal(isUsageLimitRecord({ type: 'system', subtype: 'api_retry', error_status: 529, retry_delay_ms: 60000 }), false);
  }],
  ['isUsageLimitRecord: the no-usage error, as the assistant record and as the result closing its turn', () => {
    const assistant = { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'limit' }] } };
    assert.equal(isUsageLimitRecord(assistant), true);
    assert.equal(isUsageLimitRecord({ type: 'result', subtype: 'success', is_error: true, result: 'x' }, assistant), true);
    assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: "You've hit your usage limit" }), true);
  }],
  ['isUsageLimitRecord: an ordinary turn end, an unrelated error and a working record do not count', () => {
    assert.equal(isUsageLimitRecord({ type: 'result', subtype: 'success', is_error: false, result: 'done' }), false);
    assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: 'tool failed' }, { type: 'assistant' }), false);
    assert.equal(isUsageLimitRecord({ type: 'assistant', message: { content: [] } }), false);
    assert.equal(isUsageLimitRecord(null), false);
  }],
  // The result-text fallback matches a message that starts with one of the
  // harness's own limit-message openings, or its model-credit pattern, and
  // not the other "limit reached" errors a turn can end on. Each opening is
  // its own case, written as the start of a message the harness completes.
  ...[
    "You've hit your session limit " + '\u00B7' + " resets 3pm",
    "You've reached your Fable limit.",
    "You're out of usage credits. Run /usage",
    'Your org is out of usage \u00B7 add funds to continue',
    'Your org is out of usage \u00B7 contact your admin',
    "Your seat type doesn't include usage credits.",
    "Your seat type doesn't include usage.",
    'Your usage allocation has been disabled by your admin.',
    "Your group's usage limit is set to $0.",
    'Fable 5 requires usage credits.',
    "You're out of extra usage " + '\u00B7' + ' resets 3pm',
    "Your seat type doesn't include extra usage.",
  ].map((text) => ['isUsageLimitRecord: the harness opening counts: ' + text, () => {
    assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: text }), true, text);
    assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: '  ' + text + '\n' }), true, 'trimmed: ' + text);
  }]),
  ['isUsageLimitRecord: the harness model-credit pattern counts, and its near misses do not', () => {
    for (const text of ['Fable requires usage credits.', 'Fable 6 Max requires usage credits. Add credits']) {
      assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: text }), true, text);
    }
    for (const text of ['Fable requires usage credits', 'Fable 5 \u00B7 requires usage credits.', 'The Fable model requires usage credits.']) {
      assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: text }), false, text);
    }
  }],
  // An opening matched anywhere but the start is not the harness's message.
  ['isUsageLimitRecord: an opening that is not at the start of the text does not count', () => {
    assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: "Tool said: You've hit your limit" }), false);
  }],
  // billing_error is the harness's usage limit reached, and like rate_limit
  // its cause is the API.
  ['isUsageLimitRecord: billing_error counts, as the assistant record and as the result closing its turn', () => {
    const assistant = { type: 'assistant', error: 'billing_error', message: { content: [{ type: 'text', text: 'x' }] } };
    assert.equal(isUsageLimitRecord(assistant), true);
    assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: 'x' }, assistant), true);
    assert.equal(isUsageLimitRecord({ type: 'assistant', error: 'overloaded' }), false);
    assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: 'x' }, { type: 'assistant', error: 'server_error' }), false);
  }],
  ['isUsageLimitRecord: "Context limit reached" and "Budget limit reached" do not count', () => {
    for (const text of ['Context limit reached', 'Budget limit reached']) {
      assert.equal(isUsageLimitRecord({ type: 'result', is_error: true, result: text }), false, text);
    }
  }],

  // A subagent transcript last modified before the silence bound began is
  // not read at all, since nothing written before then can read as not
  // silent. The fixture's old-mtime file holds a fresh record anyway, which
  // is what shows it was skipped rather than read and found old.
  ['a subagent transcript modified before the bound is not read, even holding a fresh record: frozen', () => {
    const paths = session('sub-old-mtime', [turn('assistant', NOW - 20 * MIN)], { 'agent-a.jsonl': [turn('assistant', NOW - MIN)] });
    const old = new Date(NOW - 16 * MIN);
    fs.utimesSync(join(paths.subagentsDir, 'agent-a.jsonl'), old, old);
    const r = read(paths);
    assert.equal(r.verdict, 'frozen');
    assert.doesNotMatch(r.detail, /subagent/);
  }],
  ['control: the same subagent transcript modified inside the bound is read: alive', () => {
    const paths = session('sub-fresh-mtime', [turn('assistant', NOW - 20 * MIN)], { 'agent-a.jsonl': [turn('assistant', NOW - MIN)] });
    const fresh = new Date(NOW - 14 * MIN);
    fs.utimesSync(join(paths.subagentsDir, 'agent-a.jsonl'), fresh, fresh);
    const r = read(paths);
    assert.equal(r.verdict, 'alive');
    assert.match(r.detail, /\(subagent\)/);
  }],
  ['the session\'s own transcript is read whatever its modification time', () => {
    const paths = session('own-old-mtime', [turn('assistant', NOW - MIN)]);
    const old = new Date(NOW - 60 * MIN);
    fs.utimesSync(paths.transcriptPath, old, old);
    assert.equal(read(paths).verdict, 'alive');
  }],
];

for (const [name, body] of livenessCases) {
  try {
    body();
    console.log('PASS: ' + name);
    pass++;
  } catch (e) {
    console.error('FAIL: ' + name + ': ' + e.message);
    fail++;
  }
}
fs.rmSync(root, { recursive: true, force: true });

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
