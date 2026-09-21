#!/usr/bin/env node
// Unit test for bin/supervise-turnstate.mjs (busy or idle from a child's
// output stream).
// Run: node .kit/supervisor-turnstate-unit-test.mjs
// Exits 0 on all-pass, 1 on any failure.
//
// Each case writes its own stream under its own temp directory, so the cases
// share nothing and the suite runs beside any other.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readerPath = resolve(here, '../bin/supervise-turnstate.mjs');
const root = fs.mkdtempSync(join(os.tmpdir(), 'supervise-turnstate-'));

// A clock fixed well inside the valid Date range, so mtimes set relative to
// it are ordinary calendar dates rather than epoch-adjacent edge cases.
const CLOCK = 1700000000000;

const assistantToolUse = () => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
});
const assistantText = () => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
});
const userToolResult = () => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
});
const userPlain = () => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
});
const assistantTextTs = (timestamp) => JSON.stringify({
  type: 'assistant',
  timestamp,
  message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
});
const systemInit = () => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' });
const systemRateLimit = () => JSON.stringify({
  type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 60000,
});
// A rate_limit_event record as the child actually emits it: routine quota
// info on almost every response, most of it not blocking at all. Passing no
// status models a record whose rate_limit_info.status this reader cannot
// read as a string.
const rateLimitEvent = (status) => JSON.stringify({
  type: 'rate_limit_event',
  resets_at: CLOCK + 60000,
  ...(status === undefined ? {} : { rate_limit_info: { status } }),
});

// Writes a stream from an array of line strings, joined with newlines. A
// trailing newline is included by default, as every complete JSONL write
// leaves one; pass trailingNewline: false to model a write caught mid-record.
function writeStream(name, recordLines, { trailingNewline = true, mtimeMs } = {}) {
  const dir = join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const streamPath = join(dir, 'stdout.jsonl');
  let body = recordLines.join('\n');
  if (trailingNewline && recordLines.length) body += '\n';
  fs.writeFileSync(streamPath, body);
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    fs.utimesSync(streamPath, t, t);
  }
  return streamPath;
}

function run(streamPath, clock = CLOCK) {
  const r = spawnSync(process.execPath, [readerPath, streamPath, String(clock)], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'reader exited ' + r.status + ': ' + r.stderr);
  assert.equal(r.stdout, r.stdout.match(/^(busy|idle)\n$/)?.[0], 'stdout carries one word, got ' + JSON.stringify(r.stdout));
  return r.stdout.trim();
}

const cases = [
  ['newest conversational record is user+tool_result: busy', () => {
    const p = writeStream('user-tool-result', [systemInit(), userToolResult()], { mtimeMs: CLOCK - 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['newest is assistant+tool_use, mtime twenty minutes old: busy (the long silent tool call)', () => {
    const p = writeStream('tool-use-old-mtime', [assistantToolUse()], { mtimeMs: CLOCK - 20 * 60 * 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['newest is assistant text-only, mtime ten seconds old: busy', () => {
    const p = writeStream('text-only-young', [assistantText()], { mtimeMs: CLOCK - 10000 });
    assert.equal(run(p), 'busy');
  }],

  ['the same record, mtime forty seconds old: idle', () => {
    const p = writeStream('text-only-old', [assistantText()], { mtimeMs: CLOCK - 40000 });
    assert.equal(run(p), 'idle');
  }],

  ['a text-only record at exactly thirty seconds old still reads busy (the boundary is > 30s, not >=)', () => {
    const p = writeStream('text-only-boundary', [assistantText()], { mtimeMs: CLOCK - 30000 });
    assert.equal(run(p), 'busy');
  }],

  ['system records other than a rate-limit record after the newest conversational record do not change a busy verdict', () => {
    const p = writeStream('system-after-busy', [assistantToolUse(), systemInit(), systemInit()], { mtimeMs: CLOCK - 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['system records other than a rate-limit record after the newest conversational record do not change an idle verdict', () => {
    const p = writeStream('system-after-idle', [assistantText(), systemInit()], { mtimeMs: CLOCK - 40000 });
    assert.equal(run(p), 'idle');
  }],

  ['newest record of any type is rate_limit_event with rate_limit_info.status rejected (the child is actually parked), behind user+tool_result, mtime five seconds old: idle', () => {
    const p = writeStream('rate-limit-event-rejected', [userToolResult(), rateLimitEvent('rejected')], { mtimeMs: CLOCK - 5000 });
    assert.equal(run(p), 'idle');
  }],

  ['newest record of any type is rate_limit_event with rate_limit_info.status allowed (routine quota info, not parked), behind user+tool_result, mtime five seconds old: busy', () => {
    const p = writeStream('rate-limit-event-allowed', [userToolResult(), rateLimitEvent('allowed')], { mtimeMs: CLOCK - 5000 });
    assert.equal(run(p), 'busy');
  }],

  ['newest record of any type is rate_limit_event with rate_limit_info.status allowed_warning (still routine, not parked), behind user+tool_result, mtime five seconds old: busy', () => {
    const p = writeStream('rate-limit-event-allowed-warning', [userToolResult(), rateLimitEvent('allowed_warning')], { mtimeMs: CLOCK - 5000 });
    assert.equal(run(p), 'busy');
  }],

  ['newest record of any type is rate_limit_event with no readable rate_limit_info.status, behind user+tool_result, mtime five seconds old: busy (an unreadable status errs toward busy, not idle)', () => {
    const p = writeStream('rate-limit-event-unreadable-status', [userToolResult(), rateLimitEvent()], { mtimeMs: CLOCK - 5000 });
    assert.equal(run(p), 'busy');
  }],

  ['newest record of any type is a system api_retry 429, behind user+tool_result, mtime five seconds old: idle', () => {
    const p = writeStream('rate-limit-system-newest', [userToolResult(), systemRateLimit()], { mtimeMs: CLOCK - 5000 });
    assert.equal(run(p), 'idle');
  }],

  ['a rate-limit record present but not the newest record is not the override: verdict rests on the true newest', () => {
    const p = writeStream('rate-limit-not-newest', [rateLimitEvent(), assistantToolUse()], { mtimeMs: CLOCK - 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['last line is partial, behind a complete assistant+tool_use record: busy, the partial line is skipped', () => {
    const p = writeStream('partial-last-line', [assistantToolUse(), '{"type":"assistant","message":{"role":"assist'],
      { trailingNewline: false, mtimeMs: CLOCK - 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['a plain-garbage last line (not JSON at all) is skipped the same way: verdict rests on the record before it', () => {
    const p = writeStream('garbage-last-line', [assistantText(), 'not json at all'],
      { trailingNewline: false, mtimeMs: CLOCK - 40000 });
    assert.equal(run(p), 'idle');
  }],

  ['a missing file reads idle, no throw', () => {
    assert.equal(run(join(root, 'does-not-exist', 'stdout.jsonl')), 'idle');
  }],

  ['an empty file reads idle, no throw', () => {
    const p = writeStream('empty-file', []);
    assert.equal(run(p), 'idle');
  }],

  ['a tail holding no parseable conversational record reads idle, no throw', () => {
    const p = writeStream('no-conversational-record', [systemInit(), 'garbage', systemInit()]);
    assert.equal(run(p), 'idle');
  }],

  ['a user record with plain text content (no tool_result) still reads busy: the model owes a reply either way', () => {
    const p = writeStream('user-plain', [userPlain()], { mtimeMs: CLOCK - 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['newest record is a user record larger than the scan window: busy, not idle (a single oversized record must not blank the tail)', () => {
    const dir = join(root, 'oversized-user-record');
    fs.mkdirSync(dir, { recursive: true });
    const streamPath = join(dir, 'stdout.jsonl');
    // 300,000 bytes of padding, well past SCAN_BYTES (262144) on its own, so
    // the base tail window lands entirely inside this one line and the
    // reader must widen before it can find it.
    const bigUser = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(300000) }] },
    });
    fs.writeFileSync(streamPath, systemInit() + '\n' + bigUser + '\n');
    fs.utimesSync(streamPath, new Date(CLOCK - 1000), new Date(CLOCK - 1000));
    assert.equal(run(streamPath), 'busy');
  }],

  ['newest record is wider than the widening ceiling itself (9 MiB, past the 8 MiB ceiling), no line boundary anywhere in the widened window: busy, not idle (the ceiling giving up must not read a still-writing record as idle)', () => {
    const dir = join(root, 'past-ceiling-record');
    fs.mkdirSync(dir, { recursive: true });
    const streamPath = join(dir, 'stdout.jsonl');
    // No trailing newline: this models the record still being written, and
    // it is wide enough that even the fully widened 8 MiB window holds no
    // newline at all, so the reader cannot find its start no matter how far
    // it widens short of reading the whole file.
    fs.writeFileSync(streamPath, systemInit() + '\n' + 'x'.repeat(9 * 1024 * 1024));
    fs.utimesSync(streamPath, new Date(CLOCK - 1000), new Date(CLOCK - 1000));
    assert.equal(run(streamPath), 'busy');
  }],

  ['the only conversational record sits at the head of a file bigger than the widening ceiling, with only system records after it: idle, the tail reader\'s answer (a whole-file reader would see the head record and answer busy)', () => {
    const dir = join(root, 'conversational-record-past-ceiling');
    fs.mkdirSync(dir, { recursive: true });
    const streamPath = join(dir, 'stdout.jsonl');
    const fd = fs.openSync(streamPath, 'w');
    // The file's only conversational record, at its very head. It carries
    // tool_use, so its own verdict would be busy regardless of age: this
    // case turns on whether the read window reaches it at all, not on aging.
    fs.writeSync(fd, assistantToolUse() + '\n');
    const filler = systemInit() + '\n';
    const target = 9 * 1024 * 1024; // past SCAN_BYTES_MAX (8 MiB)
    let written = 0;
    while (written < target) {
      fs.writeSync(fd, filler);
      written += filler.length;
    }
    fs.closeSync(fd);
    fs.utimesSync(streamPath, new Date(CLOCK - 1000), new Date(CLOCK - 1000));
    assert.equal(run(streamPath), 'idle');
  }],

  ['newest is a text-only assistant record whose own timestamp is forty seconds old, followed by fifty system records, file mtime fresh: idle (age comes from the record, not the file write time)', () => {
    const oldTs = new Date(CLOCK - 40000).toISOString();
    const trailer = new Array(50).fill(0).map(() => systemInit());
    const p = writeStream('text-only-ts-old-fresh-mtime', [assistantTextTs(oldTs), ...trailer], { mtimeMs: CLOCK });
    assert.equal(run(p), 'idle');
  }],

  ['the same shape with the record\'s own timestamp ten seconds old: busy', () => {
    const youngTs = new Date(CLOCK - 10000).toISOString();
    const trailer = new Array(50).fill(0).map(() => systemInit());
    const p = writeStream('text-only-ts-young-fresh-mtime', [assistantTextTs(youngTs), ...trailer], { mtimeMs: CLOCK });
    assert.equal(run(p), 'busy');
  }],

  ['an empty-string clock argument falls back to real time: a record forty seconds old by the wall clock reads idle', () => {
    // The record's own timestamp is set relative to real Date.now(), not the
    // suite's fixed 2023 CLOCK, so the verdict actually turns on the
    // fallback rather than on file mtime aging against a three-year-old
    // fixture, which would read idle regardless of what parseClock('') did.
    const oldTs = new Date(Date.now() - 40000).toISOString();
    const p = writeStream('empty-clock-idle-stream', [assistantTextTs(oldTs)], { mtimeMs: CLOCK - 40000 });
    assert.equal(run(p, ''), 'idle');
  }],

  // bin/supervise.sh reads its clock with date +%s at eight sites, all of
  // them seconds, so a caller reaching for the nearest habit passes seconds
  // where this reader documents milliseconds. Taken at face value as
  // milliseconds that puts the clock roughly fifty-five years behind the
  // record, which reads as a huge negative age, discarded as unusable, and
  // falls through to idle -- holding a dead child's stop no longer, but also
  // reading a genuinely busy child as idle. Falling back to Date.now()
  // instead fixes that. The pair below pins the discrimination: a
  // seconds-valued clock against real time still reads busy for a genuinely
  // young record, and ordinary skew against a record written an instant ago
  // still reads busy too.
  ['a seconds-valued clock against a record timestamped ten seconds before real time reads busy, matching what a correct millisecond clock would give', () => {
    const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();
    const p = writeStream('seconds-clock', [assistantTextTs(tenSecondsAgo)], { mtimeMs: CLOCK - 40000 });
    // A caller reaching for `date +%s` (every clock read in bin/supervise.sh)
    // passes seconds. Falling back to Date.now() instead of trusting the
    // mis-scaled value as milliseconds is what makes this busy rather than
    // fifty-five years stale.
    assert.equal(run(p, Math.floor(Date.now() / 1000)), 'busy');
  }],

  ['a record timestamped a moment after the clock is still young, so it reads busy', () => {
    const p = writeStream('skew-ahead', [assistantTextTs(new Date(CLOCK + 250).toISOString())],
      { mtimeMs: CLOCK });
    assert.equal(run(p), 'busy');
  }],

  ['a ten megabyte file returns in under five seconds', () => {
    const dir = join(root, 'ten-mb');
    fs.mkdirSync(dir, { recursive: true });
    const streamPath = join(dir, 'stdout.jsonl');
    const fd = fs.openSync(streamPath, 'w');
    const filler = systemInit() + '\n';
    const target = 10 * 1024 * 1024;
    let written = 0;
    while (written < target) {
      fs.writeSync(fd, filler);
      written += filler.length;
    }
    fs.writeSync(fd, assistantToolUse() + '\n');
    fs.closeSync(fd);
    fs.utimesSync(streamPath, new Date(CLOCK - 1000), new Date(CLOCK - 1000));
    const started = Date.now();
    const verdict = run(streamPath);
    const elapsed = Date.now() - started;
    assert.equal(verdict, 'busy');
    // Widened from one second: this bound also carries a spawned node
    // process's own startup cost, which a busy machine can push well past
    // one second with no regression in the reader itself. It still fails on
    // a whole-file read of a stream this size.
    assert.ok(elapsed < 5000, 'took ' + elapsed + 'ms');
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
