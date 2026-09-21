// bin/supervise-turnstate.mjs - Is the child inside a turn, or between them.
//
// bin/supervise.sh's patient restart_passive stop reads this before it lets
// an extended wait end: a child mid-turn gets more time, a child that has
// finished one and gone quiet does not. It takes the child's own
// child-<n>/stdout.jsonl and a clock value, and answers from the newest
// conversational record it can find, touching nothing else the child wrote.
//
// Arguments, both positional:
//   1 path to child-<n>/stdout.jsonl
//   2 clock value in epoch milliseconds, compared against the file's own
//     modification time to age a quiet text-only reply
//
// Prints exactly one word, busy or idle, and nothing else. Every failure path
// -- a missing file, an unreadable one, a tail with no parseable conversational
// record -- reads idle, so a fault in this reader falls back to the stop
// phases' behavior before this module existed, rather than holding a dead
// child's persona for the patient cap.
//
// Conversational records are of type assistant and user; system records and
// rate_limit_event records are skipped when looking for the newest one. A
// user record reads busy (the model owes a reply). An assistant record
// carrying a tool_use block reads busy (a tool is running). An assistant
// record with no tool_use block reads busy while younger than thirty seconds
// and idle once older, since inside a turn the reply that follows a
// text-only record arrives within thirty seconds all but about two times in
// a hundred: 2,937 of 3,004 such records on one measured 43MB stream
// (counts in .kit/scratch/supervisor-gaps/section-1/remeasure.md).
// Ahead of every other rule: the newest record of ANY type, not only the
// newest conversational one, is checked for a rate-limit shape first, and if
// it is one this reads idle regardless of what sits under it. A rate-limit
// record is a rate_limit_event record, or a system record of subtype
// api_retry with error_status 429. A child parked on a limit rewrites such a
// record every thirty seconds, so its stream never goes quiet on its own,
// and it has nothing left to finish.
//
// It reads the file's tail and not the whole file: a real stream reaches
// tens of megabytes. The tail read mirrors readRateLimitReset in
// bin/supervise-poll.mjs (same scan window, same first/last partial-line
// drop), since that is the tree's only other reader of this same hostile
// path and there is nothing here to import: that file runs its own poll
// unconditionally at load, so importing it would run a poll as a side
// effect of loading this one.

import fs from 'node:fs';

const SCAN_BYTES = 262144;
const IDLE_AFTER_MS = 30000;

// The tail of the stream as whole lines, plus the file's own modification
// time read from the same handle. A missing file, one that cannot be opened,
// and any other read failure all return null, which the caller reads as idle.
function readTail(streamPath) {
  let text = '';
  let scanStart = 0;
  let mtimeMs = null;
  try {
    const fd = fs.openSync(streamPath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      mtimeMs = Math.floor(stat.mtimeMs);
      const size = stat.size;
      if (size > SCAN_BYTES) scanStart = size - SCAN_BYTES;
      const len = size - scanStart;
      const buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, scanStart);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }
  const lines = text.split('\n');
  // The tail can start mid-line, and the file can end mid-line while the
  // child is writing. Neither partial is a record, exactly as in
  // readRateLimitReset.
  if (scanStart > 0) lines.shift();
  lines.pop();
  return { lines, mtimeMs };
}

function isRateLimitRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.type === 'rate_limit_event') return true;
  return record.type === 'system'
    && record.subtype === 'api_retry'
    && Number(record.error_status) === 429;
}

function hasToolUse(record) {
  const content = record.message && record.message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && block.type === 'tool_use');
}

function turnstate(streamPath, now) {
  const tail = readTail(streamPath);
  if (!tail) return 'idle';
  const { lines, mtimeMs } = tail;

  let newestAny = null;
  let newestConversational = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    newestAny = record;
    if (record.type === 'assistant' || record.type === 'user') newestConversational = record;
  }

  if (isRateLimitRecord(newestAny)) return 'idle';
  if (!newestConversational) return 'idle';
  if (newestConversational.type === 'user') return 'busy';
  if (hasToolUse(newestConversational)) return 'busy';
  if (mtimeMs === null) return 'idle';

  const age = Number(now) - mtimeMs;
  if (!Number.isFinite(age)) return 'idle';
  return age > IDLE_AFTER_MS ? 'idle' : 'busy';
}

function parseClock(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : Date.now();
}

// Run unconditionally: this file is only ever launched, never imported, and
// exports nothing. A guard comparing this module's URL against argv would
// turn on how the launch path was spelled, and a mismatch would print
// nothing, which the patient stop would read as a wedged child forever.
const [streamPathArg, clockArg] = process.argv.slice(2);
process.stdout.write(turnstate(streamPathArg, parseClock(clockArg)) + '\n');
