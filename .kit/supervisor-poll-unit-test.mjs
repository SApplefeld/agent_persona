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

// Writes whichever of the files a case names and runs the reader as the
// supervisor does, as its own process, returning its four printed lines. A
// case that seeds a restart request passes the run directory holding it as
// the fifteenth argument, the way bin/supervise.sh does; every other case
// passes the fourteen an older caller passes, so that shape stays exercised.
function run(name, files, overrides = {}) {
  const dir = join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const paths = {
    heartbeat: join(dir, 'heartbeat.json'),
    store: join(dir, 'store.json'),
    stream: join(dir, 'stdout.jsonl'),
    transcript: join(dir, 'transcripts', 'sess-1.jsonl'),
    request: join(dir, 'run', 'restart.request'),
  };
  fs.mkdirSync(join(dir, 'transcripts'), { recursive: true });
  fs.mkdirSync(join(dir, 'run'), { recursive: true });
  for (const [key, body] of Object.entries(files)) {
    fs.writeFileSync(paths[key], typeof body === 'string' ? body : JSON.stringify(body));
  }
  const args = {
    transcriptArg: join(dir, 'transcripts'),
    sessionId: '',
    childStartTs: START,
    launchedAt: START,
    staleAfterMs: 90000,
    minRunMs: 120000,
    maxRestartsPerHour: 6,
    crashCount: 0,
    restartCount: 0,
    crashLimit: 3,
    ...overrides,
  };
  const argv = [pollPath,
    paths.heartbeat, paths.store, PERSONA, paths.stream, args.transcriptArg, args.sessionId,
    args.childStartTs, args.launchedAt, args.staleAfterMs, args.minRunMs,
    args.maxRestartsPerHour, args.crashCount, args.restartCount, args.crashLimit];
  if ('request' in files) argv.push(join(dir, 'run'));
  const r = spawnSync(process.execPath, argv.map(String), { encoding: 'utf8' });
  assert.equal(r.status, 0, 'reader exited ' + r.status + ': ' + r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines.length, 5, 'four lines and a trailing newline, got ' + JSON.stringify(r.stdout));
  return { action: lines[0], reason: lines[1], rateLimit: lines[2], sessionId: lines[3], paths };
}

const decision = (action, timestamp, detail) => ({ action, timestamp, detail });
const store = (...decisions) => ({ [PERSONA]: { decisions } });
const liveHeartbeat = (sessionId) => ({ [PERSONA]: { sessionId, epoch: 1, lastSeen: Date.now() } });
const staleHeartbeat = (sessionId) => ({ [PERSONA]: { sessionId, epoch: 1, lastSeen: Date.now() - 600000 } });
const initLine = (sessionId) => JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n';

const cases = [
  ['no file exists at all: continue, no park, no session', () => {
    const r = run('empty', {});
    assert.equal(r.action, 'continue');
    assert.equal(r.rateLimit, '- -');
    assert.equal(r.sessionId, '');
  }],
  ['the init line names the session once the stream carries it', () => {
    const r = run('init', { stream: initLine('sess-9') });
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
  ['a stale heartbeat for the child\'s own session, no transcript: restart', () => {
    const r = run('hung', { heartbeat: staleHeartbeat('sess-1'), stream: initLine('sess-1') });
    assert.equal(r.action, 'restart');
  }],
  ['the poll that first reads the session id reads its transcript too: a stale heartbeat beside a transcript written just now is corroborated', () => {
    const r = run('hung-corroborated',
      { heartbeat: staleHeartbeat('sess-1'), stream: initLine('sess-1'), transcript: 'x\n' });
    assert.equal(r.action, 'continue');
    assert.match(r.reason, /^hung_corroborated:/);
  }],
  ['a transcript under another session id corroborates nothing: restart', () => {
    const r = run('hung-other-transcript',
      { heartbeat: staleHeartbeat('sess-2'), stream: initLine('sess-2'), transcript: 'x\n' });
    assert.equal(r.action, 'restart');
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
    const r = run('live', { heartbeat: liveHeartbeat('sess-1'), stream: initLine('sess-1') });
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
