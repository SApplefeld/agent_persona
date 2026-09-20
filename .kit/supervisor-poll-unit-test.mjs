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
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pollPath = resolve(here, '../bin/supervise-poll.mjs');
const root = fs.mkdtempSync(join(os.tmpdir(), 'supervise-poll-'));

const PERSONA = 'dev';
const START = 1000000;

// Writes whichever of the four files a case names and runs the reader as the
// supervisor does, as its own process, returning its four printed lines.
function run(name, files, overrides = {}) {
  const dir = join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const paths = {
    heartbeat: join(dir, 'heartbeat.json'),
    store: join(dir, 'store.json'),
    stream: join(dir, 'stdout.jsonl'),
    transcript: join(dir, 'transcripts', 'sess-1.jsonl'),
  };
  fs.mkdirSync(join(dir, 'transcripts'), { recursive: true });
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
  const r = spawnSync(process.execPath, [pollPath,
    paths.heartbeat, paths.store, PERSONA, paths.stream, args.transcriptArg, args.sessionId,
    args.childStartTs, args.launchedAt, args.staleAfterMs, args.minRunMs,
    args.maxRestartsPerHour, args.crashCount, args.restartCount, args.crashLimit].map(String),
  { encoding: 'utf8' });
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
