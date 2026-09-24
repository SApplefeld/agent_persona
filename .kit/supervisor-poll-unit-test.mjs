#!/usr/bin/env node
// Unit test for bin/supervise-poll.mjs (one poll's readings and its decision).
// Run: node .kit/supervisor-poll-unit-test.mjs
// Exits 0 on all-pass, 1 on any failure.
//
// Each case writes its own files under its own temp directory, so the cases
// share nothing and the suite runs beside any other.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pollPath = resolve(here, '../bin/supervise-poll.mjs');
const requestModulePath = resolve(here, '../bin/supervise-restart-request.mjs');
const root = fs.mkdtempSync(join(os.tmpdir(), 'supervise-poll-'));

// The restart-request parser, imported rather than spawned: it is a pure
// function the poll imports, and it runs nothing at load. An import that
// fails leaves the parser cases to fail on their own rather than ending the
// run before the poll cases.
let readRestartRequest = null;
let requestImportError = null;
try {
  ({ readRestartRequest } = await import(pathToFileURL(requestModulePath).href));
} catch (e) {
  requestImportError = e;
}
const parser = () => {
  if (typeof readRestartRequest !== 'function') throw new Error('the parser did not import: ' + (requestImportError && requestImportError.message));
  return readRestartRequest;
};

const PERSONA = 'dev';
const START = 1000000;
// The launch directory every case names, in Windows form. Its underscore is
// the character a separator-only project key misses, so a poll that derives
// the key any other way finds no transcript and reads alive.
const WORKDIR = 'C:\\fixture\\agent_persona';
const KEY = 'C--fixture-agent-persona';
const SUPERVISOR_START = 1700000000000;
const MIN = 60000;

// Writes whichever of the files a case names and runs the reader as the
// supervisor does, as its own process, returning its nine printed lines.
// bin/supervise.sh passes all twenty-seven arguments; a case marked short
// passes the fourteen an older caller passes, or fifteen where it seeds a
// restart request, so that shape stays exercised.
function run(name, files, overrides = {}, { short = false } = {}) {
  const dir = join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const project = join(dir, 'profile', '.claude', 'projects', KEY);
  const paths = {
    heartbeat: join(dir, 'run', 'heartbeat.json'),
    sidecar: join(dir, 'wd', '.agentic-heartbeat.json'),
    store: join(dir, 'store.json'),
    stream: join(dir, 'stdout.jsonl'),
    transcript: join(project, 'sess-1.jsonl'),
    otherTranscript: join(project, 'sess-2.jsonl'),
    subagent: join(project, 'sess-1', 'subagents', 'agent-a.jsonl'),
    request: join(dir, 'run', 'restart.request'),
    mailbox: join(dir, 'run', 'mailbox.jsonl'),
    ack: join(dir, 'run', 'mailbox.ack.jsonl'),
  };
  fs.mkdirSync(join(project, 'sess-1', 'subagents'), { recursive: true });
  fs.mkdirSync(join(dir, 'run'), { recursive: true });
  fs.mkdirSync(join(dir, 'wd'), { recursive: true });
  for (const [key, body] of Object.entries(files)) {
    fs.writeFileSync(paths[key], typeof body === 'string' ? body : JSON.stringify(body));
  }
  // A stream a case wants silent carries an old modification time, which is
  // what a first poll ages the stream from.
  if (overrides.streamMtime !== undefined && fs.existsSync(paths.stream)) {
    const t = new Date(overrides.streamMtime);
    fs.utimesSync(paths.stream, t, t);
  }
  const args = {
    profile: join(dir, 'profile'),
    sessionId: '',
    childStartTs: START,
    launchedAt: START,
    staleAfterMs: 90000,
    minRunMs: 120000,
    maxRestartsPerHour: 6,
    crashCount: 0,
    restartCount: 0,
    crashLimit: 3,
    walk: 'live',
    streamSeenSize: '',
    streamChangedAt: '',
    silenceBoundMs: 15 * MIN,
    probeMs: 2 * MIN,
    probeWindowMs: 30000,
    finalAskMs: 11 * MIN,
    finalAskAt: '',
    ...overrides,
  };
  const argv = [pollPath,
    paths.heartbeat, paths.store, PERSONA, paths.stream, args.profile, args.sessionId,
    args.childStartTs, args.launchedAt, args.staleAfterMs, args.minRunMs,
    args.maxRestartsPerHour, args.crashCount, args.restartCount, args.crashLimit];
  if (!short || 'request' in files) argv.push(join(dir, 'run'));
  if (!short) {
    argv.push(WORKDIR, args.walk, args.streamSeenSize, args.streamChangedAt,
      args.silenceBoundMs, args.probeMs, args.probeWindowMs, args.finalAskMs, args.finalAskAt,
      SUPERVISOR_START, paths.mailbox, paths.ack);
  }
  const r = spawnSync(process.execPath, argv.map(String), { encoding: 'utf8' });
  assert.equal(r.status, 0, 'reader exited ' + r.status + ': ' + r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines.length, 10, 'nine lines and a trailing newline, got ' + JSON.stringify(r.stdout));
  return {
    action: lines[0], reason: lines[1], rateLimit: lines[2], sessionId: lines[3],
    liveness: lines[4], streamSize: lines[5], streamChangedAt: lines[6], finalAskAt: lines[7], heartbeatNote: lines[8],
    paths,
  };
}

const decision = (action, timestamp, detail) => ({ action, timestamp, detail });
const store = (...decisions) => ({ [PERSONA]: { decisions } });
const initLine = (sessionId) => JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n';
const childHeartbeat = (sessionId, ageMs) => ({ sessionId, lastSeen: Date.now() - ageMs, turnStartedAt: null });
const sidecar = (sessionId, ageMs) => ({ [PERSONA]: { sessionId, epoch: 1, lastSeen: Date.now() - ageMs } });
const turnRecord = (type, ageMs) => JSON.stringify({ type, timestamp: new Date(Date.now() - ageMs).toISOString() }) + '\n';
const probeLine = (id, ageMs) => JSON.stringify({ id, kind: 'probe', at: Date.now() - ageMs, text: 'probe' }) + '\n';
const ackLine = (id) => JSON.stringify({ id, at: Date.now(), action: 'ack' }) + '\n';

// Every signal silent for the child's own session sess-1: a transcript whose
// newest turn record is twenty minutes old, a stream last modified twenty
// minutes ago that no poll has yet seen, a heartbeat ten minutes old, and a
// probe a minute past its thirty-second window with no ack. The child was
// launched an hour ago, the walk found a live process, and the session id is
// already known. A case spreads this and changes the one signal it is about.
const SILENT_FILES = () => ({
  stream: initLine('sess-1'),
  transcript: turnRecord('user', 21 * MIN) + turnRecord('assistant', 20 * MIN),
  heartbeat: childHeartbeat('sess-1', 10 * MIN),
  mailbox: probeLine(SUPERVISOR_START + '-1', MIN),
});
const SILENT_ARGS = () => ({
  sessionId: 'sess-1',
  launchedAt: Date.now() - 60 * MIN,
  streamMtime: Date.now() - 20 * MIN,
});

const cases = [
  ['no file exists at all: continue, no park, no session', () => {
    const r = run('empty', {});
    assert.equal(r.action, 'continue');
    assert.equal(r.rateLimit, '- -');
    assert.equal(r.sessionId, '');
    assert.equal(r.liveness, 'alive transcript_unreadable');
  }],
  ['an older caller passing fourteen arguments names no workdir and no walk, so alive and never a liveness restart', () => {
    const r = run('short', SILENT_FILES(), SILENT_ARGS(), { short: true });
    assert.equal(r.action, 'continue');
    assert.equal(r.liveness, 'alive transcript_unreadable');
  }],
  ['the init line names the session once the stream carries it', () => {
    const r = run('init', { stream: initLine('sess-9') }, {}, { short: true });
    assert.equal(r.sessionId, 'sess-9');
  }],
  ['a session the supervisor already knows wins over the one the stream names', () => {
    const r = run('known', { stream: initLine('sess-other') }, { sessionId: 'sess-known' });
    assert.equal(r.sessionId, 'sess-known');
  }],
  ['shutdown_requested newer than the child start: stop_complete', () => {
    const r = run('shutdown', { store: store(decision('shutdown_requested', START + 5)) });
    assert.equal(r.action, 'stop_complete');
  }],
  ['shutdown_requested older than the child start: continue', () => {
    const r = run('shutdown-old', { store: store(decision('shutdown_requested', START - 5)) });
    assert.equal(r.action, 'continue');
  }],
  ['park_requested newer than the child start: stop_park', () => {
    const r = run('park-req', { store: store(decision('park_requested', START + 5, 'update window')) });
    assert.equal(r.action, 'stop_park');
    assert.match(r.reason, /^park_requested at /);
  }],
  ['park_requested older than the child start: continue', () => {
    const r = run('park-req-old', { store: store(decision('park_requested', START - 5, 'update window')) });
    assert.equal(r.action, 'continue');
  }],
  ['a malformed store entry beside a park costs no other fact: park_requested still parks', () => {
    const r = run('park-bad-entry', { store: store(
      null,
      decision('nudge_sent', START + 1, 42),
      decision('park_requested', START + 5, 'update window')) });
    assert.equal(r.action, 'stop_park');
  }],
  ['a fact under another persona is not this persona\'s fact', () => {
    const r = run('other-persona', { store: { other: { decisions: [decision('shutdown_requested', START + 5)] } } });
    assert.equal(r.action, 'continue');
  }],
  ['root_complete newer than the child start: restart_passive', () => {
    const r = run('root', { store: store(decision('root_complete', START + 5, 'goal done')) });
    assert.equal(r.action, 'restart_passive');
  }],
  ['a backfilled root_complete is not a completion: continue', () => {
    const r = run('root-backfilled', { store: store(decision('root_complete', START + 5, 'backfilled root')) });
    assert.equal(r.action, 'continue');
  }],
  ['the newest root_complete is the one read, not the first', () => {
    const r = run('root-newest', { store: store(
      decision('root_complete', START + 5, 'goal done'),
      decision('root_complete', START + 9, 'backfilled root')) });
    assert.equal(r.action, 'continue');
  }],
  ['restart_requested newer than the child start: restart_passive, named as requested', () => {
    const r = run('restart-req', { store: store(decision('restart_requested', START + 5)) });
    assert.equal(r.action, 'restart_passive');
    assert.match(r.reason, /^restart_requested/);
  }],
  // The liveness verdict through the real poll. The frozen case is the one
  // every twin below differs from in one signal.
  ['every signal silent, the walk found a live process: final_ask, and the ask\'s time handed back', () => {
    const before = Date.now();
    const r = run('frozen', SILENT_FILES(), SILENT_ARGS());
    assert.equal(r.liveness, 'frozen all_silent');
    assert.equal(r.action, 'final_ask');
    assert.match(r.reason, /^frozen: every signal is silent/);
    assert.ok(Number(r.finalAskAt) >= before && Number(r.finalAskAt) <= Date.now(), 'finalAskAt=' + r.finalAskAt);
  }],
  ['the walk flips it: every signal silent and no live process: sweep_relaunch', () => {
    const r = run('gone', SILENT_FILES(), { ...SILENT_ARGS(), walk: 'none' });
    assert.equal(r.liveness, 'gone all_silent');
    assert.equal(r.action, 'sweep_relaunch');
  }],
  ['the transcript flips it: a stale heartbeat beside a turn record a minute old: alive, no restart', () => {
    const r = run('fresh-transcript', { ...SILENT_FILES(), transcript: turnRecord('assistant', MIN) }, SILENT_ARGS());
    assert.equal(r.liveness, 'alive signal');
    assert.equal(r.action, 'continue');
    assert.equal(r.finalAskAt, '');
  }],
  ['the subagent flips it: the session\'s own transcript silent, a subagent transcript a minute old: alive', () => {
    const r = run('fresh-subagent', { ...SILENT_FILES(), subagent: turnRecord('assistant', MIN) }, SILENT_ARGS());
    assert.equal(r.liveness, 'alive signal');
  }],
  ['the poll that first reads the session id reads its transcript too', () => {
    const { sessionId, ...args } = SILENT_ARGS();
    const r = run('first-id', SILENT_FILES(), args);
    assert.equal(r.sessionId, 'sess-1');
    assert.equal(r.liveness, 'frozen all_silent');
  }],
  ['a transcript under another session id is not this child\'s: alive, transcript_unreadable', () => {
    const { transcript, ...files } = SILENT_FILES();
    const r = run('other-transcript', { ...files, otherTranscript: transcript }, SILENT_ARGS());
    assert.equal(r.liveness, 'alive transcript_unreadable');
    assert.equal(r.action, 'continue');
  }],
  ['the stream flips it: stdout.jsonl changed size since the last poll: alive, and the new size handed back', () => {
    const r = run('stream-grew', SILENT_FILES(), { ...SILENT_ARGS(), streamSeenSize: 3, streamChangedAt: Date.now() - 20 * MIN });
    assert.equal(r.liveness, 'alive signal');
    assert.equal(Number(r.streamSize), initLine('sess-1').length);
    assert.ok(Number(r.streamChangedAt) >= Date.now() - 5000, 'changedAt=' + r.streamChangedAt);
  }],
  ['control: the stream at the size the last poll saw, changed twenty minutes ago: frozen', () => {
    const r = run('stream-same', SILENT_FILES(),
      { ...SILENT_ARGS(), streamSeenSize: initLine('sess-1').length, streamChangedAt: Date.now() - 20 * MIN, streamMtime: Date.now() });
    assert.equal(r.liveness, 'frozen all_silent');
  }],
  ['a first poll ages the stream from its modification time: a stream modified just now reads alive', () => {
    const r = run('stream-first', SILENT_FILES(), { ...SILENT_ARGS(), streamMtime: Date.now() });
    assert.equal(r.liveness, 'alive signal');
  }],

  // The usage limit, for both records, never reaching the final ask.
  ['a 429 retry newest in the stream, every other signal silent: alive usage_limit, no final ask', () => {
    const retry = JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 60000 }) + '\n';
    const r = run('usage-429', { ...SILENT_FILES(), stream: initLine('sess-1') + retry }, SILENT_ARGS());
    assert.equal(r.liveness, 'alive usage_limit');
    assert.equal(r.action, 'continue');
    assert.equal(r.finalAskAt, '');
  }],
  ['the no-usage error a turn ends on, newest in the stream: alive usage_limit, no final ask', () => {
    const ended = JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: 'limit' }] } }) + '\n'
      + JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'limit' }) + '\n'
      + JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }) + '\n';
    const r = run('usage-error', { ...SILENT_FILES(), stream: initLine('sess-1') + ended }, SILENT_ARGS());
    assert.equal(r.liveness, 'alive usage_limit');
    assert.equal(r.action, 'continue');
  }],
  ['control: an ordinary turn end newest in the stream, every signal silent: final_ask', () => {
    const ended = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }) + '\n';
    const r = run('usage-control', { ...SILENT_FILES(), stream: initLine('sess-1') + ended }, SILENT_ARGS());
    assert.equal(r.liveness, 'frozen all_silent');
    assert.equal(r.action, 'final_ask');
  }],

  // The heartbeat: the child's own <rundir>/heartbeat.json, not the sidecar.
  ['a stale shared sidecar beside a fresh <rundir>/heartbeat.json reads the heartbeat fresh: alive', () => {
    const r = run('sidecar-stale', { ...SILENT_FILES(), sidecar: sidecar('sess-1', 10 * MIN), heartbeat: childHeartbeat('sess-1', 5000) }, SILENT_ARGS());
    assert.equal(r.liveness, 'alive signal');
  }],
  ['control: a fresh shared sidecar beside a stale <rundir>/heartbeat.json moves nothing: frozen', () => {
    const r = run('sidecar-fresh', { ...SILENT_FILES(), sidecar: sidecar('sess-1', 5000) }, SILENT_ARGS());
    assert.equal(r.liveness, 'frozen all_silent');
  }],
  ['a heartbeat file an earlier child left under another session id is not this child\'s: never written, alive', () => {
    const r = run('hb-other-session', { ...SILENT_FILES(), heartbeat: childHeartbeat('sess-0', 10 * MIN) }, SILENT_ARGS());
    assert.equal(r.liveness, 'alive signal');
    assert.equal(r.heartbeatNote, 'HEARTBEAT_ABSENT');
  }],
  ['a heartbeat file never written, past the startup grace: alive, and HEARTBEAT_ABSENT for the log', () => {
    const { heartbeat, ...files } = SILENT_FILES();
    const r = run('hb-never', files, SILENT_ARGS());
    assert.equal(r.liveness, 'alive signal');
    assert.equal(r.action, 'continue');
    assert.equal(r.heartbeatNote, 'HEARTBEAT_ABSENT');
  }],
  ['a heartbeat file never written inside the startup grace: no HEARTBEAT_ABSENT yet', () => {
    const { heartbeat, ...files } = SILENT_FILES();
    const r = run('hb-never-grace', files, { ...SILENT_ARGS(), launchedAt: Date.now() - MIN });
    assert.equal(r.heartbeatNote, '-');
  }],
  ['control: a heartbeat file written: no HEARTBEAT_ABSENT', () => {
    const r = run('hb-written', SILENT_FILES(), SILENT_ARGS());
    assert.equal(r.heartbeatNote, '-');
  }],

  // The probe: written on a stale heartbeat, at most once per probe interval,
  // and silent while an overdue one has no ack.
  ['a stale heartbeat with no probe in the mailbox writes one probe, built as JSON', () => {
    const { mailbox, ...files } = SILENT_FILES();
    const r = run('probe-write', files, SILENT_ARGS());
    const lines = fs.readFileSync(r.paths.mailbox, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const p = JSON.parse(lines[0]);
    assert.equal(p.kind, 'probe');
    assert.equal(p.id, SUPERVISOR_START + '-1');
    assert.equal(typeof p.text, 'string');
    assert.ok(Math.abs(p.at - Date.now()) < 10000, 'at=' + p.at);
    // A probe written this poll is inside its window, so it is not silent.
    assert.equal(r.liveness, 'alive signal');
  }],
  ['control: a fresh heartbeat writes no probe', () => {
    const { mailbox, ...files } = SILENT_FILES();
    const r = run('probe-no-write', { ...files, heartbeat: childHeartbeat('sess-1', 5000) }, SILENT_ARGS());
    assert.equal(fs.existsSync(r.paths.mailbox) ? fs.readFileSync(r.paths.mailbox, 'utf8') : '', '');
  }],
  ['a probe written inside the probe interval holds the next one off', () => {
    const r = run('probe-interval', SILENT_FILES(), SILENT_ARGS());
    assert.equal(fs.readFileSync(r.paths.mailbox, 'utf8').split('\n').filter(Boolean).length, 1);
  }],
  ['a probe older than the probe interval earns the next one, numbered after every record in the mailbox', () => {
    const r = run('probe-next', { ...SILENT_FILES(), mailbox: probeLine(SUPERVISOR_START + '-1', 3 * MIN) }, SILENT_ARGS());
    const lines = fs.readFileSync(r.paths.mailbox, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).id, SUPERVISOR_START + '-2');
  }],
  ['an unacknowledged probe past its window stays silent while a newer probe sits inside its own window: frozen', () => {
    const mailbox = probeLine(SUPERVISOR_START + '-1', 3 * MIN) + probeLine(SUPERVISOR_START + '-2', 5000);
    const r = run('probe-newer', { ...SILENT_FILES(), mailbox }, SILENT_ARGS());
    assert.equal(r.liveness, 'frozen all_silent');
    assert.equal(r.action, 'final_ask');
  }],
  ['the ack flips it: the newer probe acknowledged: alive', () => {
    const mailbox = probeLine(SUPERVISOR_START + '-1', 3 * MIN) + probeLine(SUPERVISOR_START + '-2', 5000);
    const r = run('probe-newer-acked', { ...SILENT_FILES(), mailbox, ack: ackLine(SUPERVISOR_START + '-2') }, SILENT_ARGS());
    assert.equal(r.liveness, 'alive signal');
  }],

  // The final ask across polls: asked once, waited on inside its window,
  // cleared by a signal that moves, and a restart where the window closes
  // silent.
  ['a frozen child already asked, inside the window: continue, and the ask\'s time kept', () => {
    const askAt = Date.now() - MIN;
    const r = run('ask-window', SILENT_FILES(), { ...SILENT_ARGS(), finalAskAt: askAt });
    assert.equal(r.action, 'continue');
    assert.match(r.reason, /^final_ask_window:/);
    assert.equal(r.finalAskAt, String(askAt));
  }],
  ['a signal that moves inside the window reads alive and clears the ask\'s time', () => {
    const r = run('ask-cleared', { ...SILENT_FILES(), transcript: turnRecord('assistant', 5000) },
      { ...SILENT_ARGS(), finalAskAt: Date.now() - MIN });
    assert.equal(r.liveness, 'alive signal');
    assert.equal(r.action, 'continue');
    assert.equal(r.finalAskAt, '');
  }],
  ['a window that closes with every signal silent: restart, naming the ask and the five signals', () => {
    const askAt = Date.now() - 11 * MIN - 1000;
    const r = run('ask-closed', SILENT_FILES(), { ...SILENT_ARGS(), finalAskAt: askAt });
    assert.equal(r.action, 'restart');
    assert.match(r.reason, /^frozen: the final ask at \d+ went unanswered past 660000ms \(transcript \d+s, stream \d+s, heartbeat \d+s, probe \d+s unacknowledged, walk live\)$/);
  }],
  ['a stream whose first line is not a record still yields the session id', () => {
    const r = run('init-after-noise', { stream: 'warning: not json\n' + initLine('sess-9') });
    assert.equal(r.sessionId, 'sess-9');
  }],
  ['a malformed store entry costs no other fact: shutdown_requested still stops', () => {
    const r = run('store-bad-entry', { store: store(
      null,
      decision('nudge_sent', START + 1, 42),
      decision('shutdown_requested', START + 5)) });
    assert.equal(r.action, 'stop_complete');
  }],
  // A store an older plugin wrote can still hold a critical context crossing,
  // and that store outlives the supervisor that reads it. The poll reader
  // selects no such fact, so the newest crossing in the store leaves a healthy
  // child up.
  ['a context_budget_crossed decision in the store is no fact the reader selects: continue', () => {
    const r = run('store-crossing', { store: store(decision('context_budget_crossed', START + 5, 'critical: 95%')) });
    assert.equal(r.action, 'continue');
  }],
  ['a live heartbeat: continue', () => {
    const r = run('live', { heartbeat: childHeartbeat('sess-1', 5000), stream: initLine('sess-1') });
    assert.equal(r.action, 'continue');
  }],
  ['an unreadable heartbeat reads as no heartbeat: continue', () => {
    const r = run('hb-garbage', { heartbeat: '{not json', stream: initLine('sess-1') });
    assert.equal(r.action, 'continue');
  }],
  ['an unreadable store reads as no facts: continue', () => {
    const r = run('store-garbage', { store: '{not json' });
    assert.equal(r.action, 'continue');
  }],
  ['a rate-limit park as the newest stream record names when it ends', () => {
    const park = JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 60000 });
    const before = Date.now();
    const r = run('park', { stream: initLine('sess-1') + park + '\n' });
    const [until, iso] = r.rateLimit.split(' ');
    assert.ok(Number(until) >= before + 60000 && Number(until) <= Date.now() + 60000, 'until=' + until);
    assert.equal(new Date(Number(until)).toISOString(), iso);
  }],
  ['a record after the park ends it', () => {
    const park = JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 60000 });
    const r = run('park-over', { stream: initLine('sess-1') + park + '\n' + JSON.stringify({ type: 'assistant' }) + '\n' });
    assert.equal(r.rateLimit, '- -');
  }],
  ['a half-written last line is not a record', () => {
    const park = JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 60000 });
    const r = run('park-partial', { stream: initLine('sess-1') + park });
    assert.equal(r.rateLimit, '- -');
  }],
  ['the restart budget is read from the counts handed in: stop_budget', () => {
    const r = run('budget', {}, { restartCount: 6 });
    assert.equal(r.action, 'stop_budget');
  }],

  // The restart request file fleet_restart writes into the run directory.
  // The poll takes the later of it and the store's restart_requested, and
  // the decide unit's own rule does the rest: a request newer than the child
  // start restarts, an older one is a request an earlier restart served.
  ['a restart request file newer than the child start, no store fact: restart_passive, named as requested', () => {
    const r = run('request-new', { request: { at: START + 5, by: 'coordinator', reason: 'stuck' } });
    assert.equal(r.action, 'restart_passive');
    assert.match(r.reason, /^restart_requested/);
  }],
  ['a restart request file older than the child start, no store fact: continue', () => {
    const r = run('request-old', { request: { at: START - 5, by: 'coordinator', reason: 'stuck' } });
    assert.equal(r.action, 'continue');
  }],
  // The two sources in both orders, so a poll that reads one ahead of the
  // other rather than the later of the two reds on one of these.
  ['an older store fact beside a newer request file: the file is the later, so restart_passive', () => {
    const r = run('request-over-store', {
      store: store(decision('restart_requested', START - 5)),
      request: { at: START + 5, by: 'coordinator', reason: 'stuck' },
    });
    assert.equal(r.action, 'restart_passive');
  }],
  ['a newer store fact beside an older request file: the store is the later, so restart_passive', () => {
    const r = run('store-over-request', {
      store: store(decision('restart_requested', START + 5)),
      request: { at: START - 5, by: 'coordinator', reason: 'stuck' },
    });
    assert.equal(r.action, 'restart_passive');
  }],

  // The parser alone. Each null case is a file the supervisor must read as
  // no request at all, and the control beside them is what shows the parser
  // returns something for a file it should read.
  ['parser control: a well-formed request returns its at', () => {
    const dir = join(root, 'parse-ok');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(join(dir, 'restart.request'), JSON.stringify({ at: now - 1000, by: 'coordinator', reason: 'stuck' }));
    assert.equal(parser()(dir, now), now - 1000);
  }],
  ['parser: a missing file reads as no request', () => {
    const dir = join(root, 'parse-missing');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(parser()(dir, Date.now()), null);
  }],
  ['parser: a file that is not JSON reads as no request, with no throw', () => {
    const dir = join(root, 'parse-garbage');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'restart.request'), '{"at": 17');
    assert.equal(parser()(dir, Date.now()), null);
  }],
  ['parser: JSON that is not an object, or an object with no numeric at, reads as no request', () => {
    const dir = join(root, 'parse-shape');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const body of ['null', '[1]', '5', JSON.stringify({ by: 'coordinator' }), JSON.stringify({ at: String(now - 1000) })]) {
      fs.writeFileSync(join(dir, 'restart.request'), body);
      assert.equal(parser()(dir, now), null, 'body ' + body);
    }
  }],
  // A future-dated request stays newer than every child the supervisor
  // launches, so reading it would restart the persona on every poll forever.
  ['parser: an at ten minutes ahead of the clock reads as no request', () => {
    const dir = join(root, 'parse-future');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(join(dir, 'restart.request'), JSON.stringify({ at: now + 600000, by: 'coordinator', reason: 'stuck' }));
    assert.equal(parser()(dir, now), null);
  }],
];

let pass = 0;
let fail = 0;
for (const [name, body] of cases) {
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
