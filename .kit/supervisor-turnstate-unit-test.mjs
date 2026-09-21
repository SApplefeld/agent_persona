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
const systemThinkingTokens = () => JSON.stringify({ type: 'system', subtype: 'thinking_tokens' });
// A system record of a subtype the reader never treats specially, used
// wherever a fixture needs "a system record that changes nothing" without
// colliding with the two turn-start subtypes (init, thinking_tokens) or the
// rate-limit subtype (api_retry), all three of which now carry meaning.
const systemOther = () => JSON.stringify({ type: 'system', subtype: 'status' });
// The record a channel-driven child's turn ends with; carries no timestamp,
// as seen on the architect's child-3 stream.
const resultSuccess = () => JSON.stringify({ type: 'result', subtype: 'success' });
// A result record with no assistant record in the same turn: the first API
// call failed after retries, so the turn produced no conversational record
// at all.
const resultErrorDuringExecution = () => JSON.stringify({ type: 'result', subtype: 'error_during_execution' });
const systemRateLimit = () => JSON.stringify({
  type: 'system', subtype: 'api_retry', error_status: 429, retry_delay_ms: 60000,
});
// A rate_limit_event record as the child actually emits it: routine quota
// info on almost every response, most of it not blocking at all. Passing no
// status models a record whose rate_limit_info.status this reader cannot
// read as a string. overage, when given, adds isUsingOverage and/or
// overageStatus onto rate_limit_info, which models a child proceeding past
// its included quota on overage rather than actually parked.
const rateLimitEvent = (status, overage) => JSON.stringify({
  type: 'rate_limit_event',
  resets_at: CLOCK + 60000,
  ...(status === undefined ? {} : { rate_limit_info: { status, ...(overage || {}) } }),
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

  ['the same record, mtime six minutes old: idle', () => {
    const p = writeStream('text-only-old', [assistantText()], { mtimeMs: CLOCK - 360000 });
    assert.equal(run(p), 'idle');
  }],

  ['a text-only record at exactly five minutes old still reads busy (the boundary is > 5min, not >=)', () => {
    const p = writeStream('text-only-boundary', [assistantText()], { mtimeMs: CLOCK - 300000 });
    assert.equal(run(p), 'busy');
  }],

  ['a text-only record whose own timestamp is 150 seconds old, file mtime fresh, reads busy: the model can still be generating a large tool input for the same response', () => {
    const ts = new Date(CLOCK - 150000).toISOString();
    const p = writeStream('text-only-ts-mid-band', [assistantTextTs(ts), systemOther()], { mtimeMs: CLOCK });
    assert.equal(run(p), 'busy');
  }],

  ['a system record of a subtype other than a rate-limit or turn-start one, after the newest conversational record, does not change a busy verdict', () => {
    const p = writeStream('system-after-busy', [assistantToolUse(), systemOther(), systemOther()], { mtimeMs: CLOCK - 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['a system record of a subtype other than a rate-limit or turn-start one, after the newest conversational record, does not change an idle verdict', () => {
    const p = writeStream('system-after-idle', [assistantText(), systemOther()], { mtimeMs: CLOCK - 360000 });
    assert.equal(run(p), 'idle');
  }],

  ['a system init record after a stale text reply reads busy: the child has started a new turn, not gone quiet after the last one', () => {
    const oldTs = new Date(CLOCK - 360000).toISOString();
    const p = writeStream('marker-after-old-reply-init-only', [assistantTextTs(oldTs), resultSuccess(), systemInit()], { mtimeMs: CLOCK });
    assert.equal(run(p), 'busy');
  }],

  ['a stale text reply followed by a turn-end result, an init and a run of thinking_tokens records reads busy, matching the architect child-3 sequence', () => {
    const oldTs = new Date(CLOCK - 360000).toISOString();
    const p = writeStream('marker-after-old-reply-full-sequence', [
      assistantTextTs(oldTs), resultSuccess(), systemInit(), systemThinkingTokens(), systemThinkingTokens(), systemThinkingTokens(),
    ], { mtimeMs: CLOCK });
    assert.equal(run(p), 'busy');
  }],

  ['init and thinking_tokens records with no conversational record anywhere in the tail read busy: a child in its first turn', () => {
    const p = writeStream('marker-no-conversational', [systemInit(), systemThinkingTokens()], { mtimeMs: CLOCK - 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['a stale text reply, a result, an init, then a second result with no assistant record after it (the first API call failed after retries) reads idle: the second result clears the marker the init set, so a child quiet between turns is not read busy for the whole patient cap', () => {
    const oldTs = new Date(CLOCK - 360000).toISOString();
    const p = writeStream('marker-cleared-by-trailing-result', [
      assistantTextTs(oldTs), resultSuccess(), systemInit(), resultErrorDuringExecution(),
    ], { mtimeMs: CLOCK });
    assert.equal(run(p), 'idle');
  }],

  ['control: a stale text reply followed by a turn-end result and a system record of another subtype, no init, reads idle', () => {
    const oldTs = new Date(CLOCK - 360000).toISOString();
    const p = writeStream('marker-control-no-init', [assistantTextTs(oldTs), resultSuccess(), systemOther()], { mtimeMs: CLOCK });
    assert.equal(run(p), 'idle');
  }],

  ['a single thinking_tokens record after a stale text reply, with no init anywhere in the tail, still reads busy: a thinking_tokens record after a text reply marks the model generating, mid-response or at a turn start, and reads busy either way, so it has to mark this on its own and not only alongside init', () => {
    const oldTs = new Date(CLOCK - 360000).toISOString();
    const p = writeStream('marker-thinking-tokens-alone', [assistantTextTs(oldTs), systemThinkingTokens()], { mtimeMs: CLOCK });
    assert.equal(run(p), 'busy');
  }],

  ['newest record of any type is rate_limit_event with rate_limit_info.status rejected and no overage fields at all (the child is actually parked): idle. Hand-built and unobserved in the fleet: every rejected record measured there carried overage fields (see the live cases below); this pins the bare-rejected fallback rather than a shape seen live.', () => {
    const p = writeStream('rate-limit-event-rejected', [userToolResult(), rateLimitEvent('rejected')], { mtimeMs: CLOCK - 5000 });
    assert.equal(run(p), 'idle');
  }],

  ['rejected with overageStatus allowed and isUsingOverage true, behind user+tool_result, mtime five seconds old: busy. This is the shape a child writes when its included quota is exhausted and it is proceeding on overage, not parked.', () => {
    const p = writeStream('rate-limit-event-rejected-overage-user', [userToolResult(), rateLimitEvent('rejected', { overageStatus: 'allowed', isUsingOverage: true })], { mtimeMs: CLOCK - 5000 });
    assert.equal(run(p), 'busy');
  }],

  ['the same overage shape behind an assistant tool_use record, mtime five seconds old: busy. A rejected-with-overage record commonly sits between an assistant tool_use record and the user tool_result that follows it, so the rate-limit record is the newest of any type for the whole length of that tool call.', () => {
    const p = writeStream('rate-limit-event-rejected-overage-tooluse', [assistantToolUse(), rateLimitEvent('rejected', { overageStatus: 'allowed', isUsingOverage: true })], { mtimeMs: CLOCK - 5000 });
    assert.equal(run(p), 'busy');
  }],

  ['rejected with overageStatus rejected and isUsingOverage false, behind user+tool_result, mtime five seconds old: idle. Hand-built and unobserved in the fleet: this models a child that has exhausted overage too, so both overage fields read as "not proceeding".', () => {
    const p = writeStream('rate-limit-event-rejected-overage-exhausted', [userToolResult(), rateLimitEvent('rejected', { overageStatus: 'rejected', isUsingOverage: false })], { mtimeMs: CLOCK - 5000 });
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

  ['a rate-limit record present but not the newest record is not the override: verdict rests on the true newest. The leading record is a bare rejected with no overage fields, which the predicate does classify as blocking, so this pins position rather than pinning nothing.', () => {
    const p = writeStream('rate-limit-not-newest', [rateLimitEvent('rejected'), assistantToolUse()], { mtimeMs: CLOCK - 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['last line is partial, behind a complete assistant+tool_use record: busy, the partial line is skipped', () => {
    const p = writeStream('partial-last-line', [assistantToolUse(), '{"type":"assistant","message":{"role":"assist'],
      { trailingNewline: false, mtimeMs: CLOCK - 1000 });
    assert.equal(run(p), 'busy');
  }],

  ['a plain-garbage last line (not JSON at all) is skipped the same way: verdict rests on the record before it', () => {
    const p = writeStream('garbage-last-line', [assistantText(), 'not json at all'],
      { trailingNewline: false, mtimeMs: CLOCK - 360000 });
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
    const p = writeStream('no-conversational-record', [systemOther(), 'garbage', systemOther()]);
    assert.equal(run(p), 'idle');
  }],

  ['about 300 KB of non-marker system records and no conversational record anywhere: idle. This forces one doubling past the 256 KB base window and then the start-of-file exit, unlike the three-line case above whose base window already reaches the start.', () => {
    const trailer = [];
    let trailerBytes = 0;
    while (trailerBytes < 300000) {
      const line = systemOther();
      trailer.push(line);
      trailerBytes += line.length;
    }
    const p = writeStream('wide-no-conversational-record', trailer);
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
    // the base tail window lands entirely inside this one line. This pins
    // that an oversized record never reads idle: the base window alone
    // cannot tell whether busy comes from widening actually finding the
    // user record behind it, or from the window simply failing to reach the
    // start of the file and falling through the past-ceiling branch, since
    // both give busy here. The idle-direction case below (a stale reply
    // behind a wide run of trailing filler) is what pins widening itself.
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

  ['the only conversational record sits at the head of a file bigger than the widening ceiling, with only non-marker system records after it, and it is six minutes stale by its own timestamp: busy, not idle. Whole-file truth would be idle -- the head record is old and nothing since it is a tool call -- but the tail cannot reach it: widening stopped at the ceiling without reaching the start of the file, so the reader cannot rule out a record still being written behind it, and reads busy on purpose.', () => {
    const dir = join(root, 'conversational-record-past-ceiling');
    fs.mkdirSync(dir, { recursive: true });
    const streamPath = join(dir, 'stdout.jsonl');
    const fd = fs.openSync(streamPath, 'w');
    // The file's only conversational record, at its very head, unreachable
    // once the window has widened all the way to the 8 MiB ceiling. The
    // filler is a subtype the reader treats as ordinary, so this case turns
    // purely on the ceiling rule and not on the turn-start marker rule.
    const oldTs = new Date(CLOCK - 360000).toISOString();
    fs.writeSync(fd, assistantTextTs(oldTs) + '\n');
    const filler = systemOther() + '\n';
    const target = 9 * 1024 * 1024; // past SCAN_BYTES_MAX (8 MiB)
    let written = 0;
    while (written < target) {
      fs.writeSync(fd, filler);
      written += filler.length;
    }
    fs.closeSync(fd);
    fs.utimesSync(streamPath, new Date(CLOCK - 1000), new Date(CLOCK - 1000));
    assert.equal(run(streamPath), 'busy');
  }],

  ['a user record larger than the widening ceiling (9 MiB), followed by a short trailing record: busy, not idle (the ceiling giving up must not drop to idle just because a short record survived behind the oversized one)', () => {
    const dir = join(root, 'past-ceiling-with-trailer');
    fs.mkdirSync(dir, { recursive: true });
    const streamPath = join(dir, 'stdout.jsonl');
    // The oversized record itself exceeds the 8 MiB ceiling, so no widened
    // window ever reaches a full copy of it and it is always dropped as a
    // partial. The short trailing record (a routine rate_limit_event, as
    // commonly follows) survives inside every widened window, so the old
    // rule (busy only when the window holds zero lines) answered idle here.
    const bigUser = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(9 * 1024 * 1024) }] },
    });
    fs.writeFileSync(streamPath, bigUser + '\n' + rateLimitEvent('allowed') + '\n');
    fs.utimesSync(streamPath, new Date(CLOCK - 1000), new Date(CLOCK - 1000));
    assert.equal(run(streamPath), 'busy');
  }],

  ['a widening chain that doubles all the way to the 8 MiB ceiling (the head-record-past-ceiling layout above) returns in under 5000 ms', () => {
    const dir = join(root, 'ceiling-widening-timed');
    fs.mkdirSync(dir, { recursive: true });
    const streamPath = join(dir, 'stdout.jsonl');
    const fd = fs.openSync(streamPath, 'w');
    fs.writeSync(fd, assistantToolUse() + '\n');
    const filler = systemOther() + '\n';
    const target = 9 * 1024 * 1024;
    let written = 0;
    while (written < target) {
      fs.writeSync(fd, filler);
      written += filler.length;
    }
    fs.closeSync(fd);
    fs.utimesSync(streamPath, new Date(CLOCK - 1000), new Date(CLOCK - 1000));
    const started = Date.now();
    const verdict = run(streamPath);
    const elapsed = Date.now() - started;
    assert.equal(verdict, 'busy');
    // Widened to 5000 ms to match the ten-megabyte case below: both bounds
    // cover a spawned process's own startup cost under machine contention,
    // on top of the widening chain's own doubling work, and this is the
    // heavier of the two paths since it forces every doubling up to the
    // ceiling.
    assert.ok(elapsed < 5000, 'took ' + elapsed + 'ms');
  }],

  ['newest is a text-only assistant record whose own timestamp is six minutes old, followed by enough non-marker system records to push the base window past 256 KB: idle. This is what actually pins the widening loop: with it removed, the base window alone finds neither a conversational record nor a marker and reaches the past-ceiling branch, which returns busy; only widening back to the head finds the finished stale reply and lets the age rule answer idle.', () => {
    const oldTs = new Date(CLOCK - 360000).toISOString();
    const filler = systemOther() + '\n';
    let trailerBytes = 0;
    const trailer = [];
    while (trailerBytes < 300000) {
      trailer.push(systemOther());
      trailerBytes += filler.length;
    }
    const p = writeStream('trailer-past-256kb-widen-to-idle', [assistantTextTs(oldTs), ...trailer], { mtimeMs: CLOCK });
    assert.equal(run(p), 'idle');
  }],

  ['newest is a text-only assistant record whose own timestamp is six minutes old, followed by fifty non-marker system records, file mtime fresh: idle (age comes from the record, not the file write time)', () => {
    const oldTs = new Date(CLOCK - 360000).toISOString();
    const trailer = new Array(50).fill(0).map(() => systemOther());
    const p = writeStream('text-only-ts-old-fresh-mtime', [assistantTextTs(oldTs), ...trailer], { mtimeMs: CLOCK });
    assert.equal(run(p), 'idle');
  }],

  ['the same shape with the record\'s own timestamp ten seconds old: busy', () => {
    const youngTs = new Date(CLOCK - 10000).toISOString();
    const trailer = new Array(50).fill(0).map(() => systemOther());
    const p = writeStream('text-only-ts-young-fresh-mtime', [assistantTextTs(youngTs), ...trailer], { mtimeMs: CLOCK });
    assert.equal(run(p), 'busy');
  }],

  ['an empty-string clock argument falls back to real time: a record ten seconds old by the wall clock reads busy (the idle direction would pass whether or not the fallback worked)', () => {
    // The record's own timestamp is set relative to real Date.now(), not the
    // suite's fixed 2023 CLOCK, so the verdict actually turns on the
    // fallback: a stale 2023 mtime would read idle regardless of what
    // parseClock('') did, which is why the idle direction cannot pin this.
    const youngTs = new Date(Date.now() - 10000).toISOString();
    const p = writeStream('empty-clock-busy-stream', [assistantTextTs(youngTs)], { mtimeMs: CLOCK - 360000 });
    assert.equal(run(p, ''), 'busy');
  }],

  ['a text-only record whose own timestamp is six minutes AHEAD of the clock argument reads busy: a negative age is a young record, not a discarded implausible one', () => {
    const aheadTs = new Date(CLOCK + 360000).toISOString();
    const p = writeStream('timestamp-ahead-of-clock', [assistantTextTs(aheadTs)], { mtimeMs: CLOCK - 400000 });
    assert.equal(run(p), 'busy');
  }],

  // Every clock read in bin/supervise.sh is in seconds (date +%s), so a
  // caller reaching for the nearest habit passes seconds where this reader
  // documents milliseconds. Taken at face value as milliseconds that puts
  // the clock roughly fifty-five years behind the record, which reads as a
  // hugely negative age -- wrongly busy under the ordinary comparison,
  // whatever the record's true age. Falling back to Date.now() instead of
  // trusting the mis-scaled value is the guard. The pair below pins the
  // discrimination: a seconds-valued clock against real time still reads
  // busy for a genuinely young record, and ordinary skew against a record
  // written an instant ago still reads busy too.
  ['a seconds-valued clock against a record timestamped ten seconds before real time reads busy, matching what a correct millisecond clock would give', () => {
    const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();
    const p = writeStream('seconds-clock', [assistantTextTs(tenSecondsAgo)], { mtimeMs: CLOCK - 360000 });
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
    // one second with no regression in the reader itself. The tool_use
    // record sits in the base 256 KB window here, so this case never
    // exercises widening; the case above forces every doubling instead.
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
