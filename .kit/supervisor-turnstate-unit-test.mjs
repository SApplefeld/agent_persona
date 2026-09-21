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
const systemInit = () => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' });
const systemRateLimit = () => JSON.stringify({
  type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 60000,
});
const rateLimitEvent = () => JSON.stringify({ type: 'rate_limit_event', resets_at: CLOCK + 60000 });

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

  ['newest record of any type is rate_limit_event, behind user+tool_result, mtime five seconds old: idle', () => {
    const p = writeStream('rate-limit-event-newest', [userToolResult(), rateLimitEvent()], { mtimeMs: CLOCK - 5000 });
    assert.equal(run(p), 'idle');
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

  ['a ten megabyte file returns in under one second', () => {
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
    assert.ok(elapsed < 1000, 'took ' + elapsed + 'ms');
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
