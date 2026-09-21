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
//   2 clock value in epoch milliseconds, used as "now" when aging a quiet
//     text-only reply. Milliseconds, not seconds: a seconds value puts the
//     clock far behind the record it is compared against, and that reading
//     is discarded rather than trusted, so the verdict falls back to idle.
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
// text-only record arrives within thirty seconds almost always. The age is
// taken from that record's own timestamp field, not the file's modification
// time: a run of later system records (a rate-limit retry, an init line) can
// keep the file's mtime fresh long after the turn that produced the text
// reply has ended, and mtime aging would then misread that child as busy.
// The file's modification time is used only when the record carries no
// timestamp field the reader can parse.
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
// effect of loading this one. Unlike that reader, this one widens the
// window when the first pass turns up no conversational record: a single
// record (a large tool_result, say) can exceed the base window on its own,
// and reading no conversational record there is not the same fact as there
// being none in the file.

import fs from 'node:fs';

const SCAN_BYTES = 262144;
// Doubled from SCAN_BYTES up to this ceiling when the base window turns up
// no conversational record. High enough to cover a single oversized record
// running several megabytes; far short of reading a multi-ten-megabyte
// stream whole.
const SCAN_BYTES_MAX = 8 * 1024 * 1024;
const IDLE_AFTER_MS = 30000;

// The tail of the stream as whole lines, plus the file's own modification
// time and size read from the same handle. A missing file, one that cannot
// be opened, and any other read failure all return null, which the caller
// reads as idle.
function readTail(streamPath, scanBytes) {
  let text = '';
  let scanStart = 0;
  let mtimeMs = null;
  let size = 0;
  try {
    const fd = fs.openSync(streamPath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      mtimeMs = Math.floor(stat.mtimeMs);
      size = stat.size;
      if (size > scanBytes) scanStart = size - scanBytes;
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
  return { lines, mtimeMs, scanStart };
}

// The newest record of any type, and the newest conversational one (type
// assistant or user), among a tail's parsed lines. An unparsable line is
// skipped, as is a JSON value that is not an object.
function parseTail(lines) {
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
  return { newestAny, newestConversational };
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

// The age, in milliseconds, of a text-only assistant record: its own
// timestamp field against now where that field parses, the file's
// modification time otherwise. Returns null when neither is usable, which
// the caller reads as idle.
// An age is usable when it is finite and not implausibly negative. A few
// milliseconds of negative are ordinary skew against a record written the
// instant before this ran, and read as a very young record. An age more
// negative than the whole decision window is not skew: it says the clock and
// the record disagree about what time it is, which is what a caller passing
// seconds where this reader documents milliseconds produces. Such a reading
// is discarded rather than used, so the verdict falls through to mtime and
// then to idle, instead of pinning to busy and holding the persona for the
// whole patient cap.
function usableAge(age) {
  return Number.isFinite(age) && age > -IDLE_AFTER_MS;
}

function conversationalAgeMs(record, mtimeMs, now) {
  const raw = record && record.timestamp;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const ts = new Date(raw).getTime();
    if (Number.isFinite(ts)) {
      const age = Number(now) - ts;
      if (usableAge(age)) return age;
    }
  }
  if (mtimeMs === null) return null;
  const age = Number(now) - mtimeMs;
  return usableAge(age) ? age : null;
}

function turnstate(streamPath, now) {
  let scanBytes = SCAN_BYTES;
  let tail = readTail(streamPath, scanBytes);
  if (!tail) return 'idle';
  let { newestAny, newestConversational } = parseTail(tail.lines);

  // The base window found no conversational record. Where the window
  // already covers the whole file, that absence is the true answer. Where
  // it does not, a single record wider than the window could be sitting
  // just behind it, so widen and look again before concluding idle.
  while (!newestConversational && tail.scanStart > 0 && scanBytes < SCAN_BYTES_MAX) {
    scanBytes *= 2;
    tail = readTail(streamPath, scanBytes);
    if (!tail) return 'idle';
    ({ newestAny, newestConversational } = parseTail(tail.lines));
  }

  if (isRateLimitRecord(newestAny)) return 'idle';
  if (!newestConversational) return 'idle';
  if (newestConversational.type === 'user') return 'busy';
  if (hasToolUse(newestConversational)) return 'busy';

  const age = conversationalAgeMs(newestConversational, tail.mtimeMs, now);
  if (age === null) return 'idle';
  return age > IDLE_AFTER_MS ? 'idle' : 'busy';
}

function parseClock(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

// Run unconditionally: this file is only ever launched, never imported, and
// exports nothing. A guard comparing this module's URL against argv would
// turn on how the launch path was spelled, and a mismatch would print
// nothing, which the patient stop would read as a wedged child forever.
const [streamPathArg, clockArg] = process.argv.slice(2);
process.stdout.write(turnstate(streamPathArg, parseClock(clockArg)) + '\n');
