// bin/supervise-poll.mjs - One poll's readings and its decision, in one process.
//
// bin/supervise.sh runs this once per poll. It reads the clock, the heartbeat
// sidecar, the decision store, the tail of the child's stream and the harness
// transcript's modification time, hands them to the decide unit, and prints
// what the poll loop acts on. Each reading follows the shell helper of the
// same name in bin/supervise.sh and bin/agentic-common.sh, which the paths
// outside the poll loop still call. A process launch under Git for Windows
// costs tenths of a second on a loaded box, so a poll that launches one
// process per reading spends longer reading than it sleeps.
//
// Arguments, all positional so the MSYS launcher converts each path:
//   1 heartbeat path        2 store path           3 persona
//   4 child stream path     5 transcript directory ('' where it cannot be named)
//   6 child session id ('' until the init line names one)
//   7 childStartTs          8 launchedAt           9 staleAfterMs
//  10 minRunMs             11 maxRestartsPerHour  12 crashCount
//  13 restartCount         14 crashLimit
//
// Prints four lines:
//   action
//   reason
//   <rate-limit reset epoch ms> <ISO 8601>, or "- -" where the child is not parked
//   child session id, or an empty line where the stream does not name one yet

import fs from 'node:fs';
import path from 'node:path';
import { decide } from './supervise-decide.mjs';

// A reading off a file reads back through parseInt, and an unparseable one
// reaches the decide unit as null. The supervisor's own settings and counts
// go through intOr instead: bin/supervise.sh validates them at startup, and
// one that still arrives unparseable takes the decide unit's own default
// rather than a null that would fire the hung check or the crash limit.
function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? null : n;
}

function intOr(value, fallback) {
  const n = intOrNull(value);
  return n === null ? fallback : n;
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    return null;
  }
}

// The heartbeat entry for one persona, as poll_heartbeat reads it. A missing
// file, an unreadable one and a persona with no entry all read as no heartbeat.
export function readHeartbeat(heartbeatPath, persona) {
  const hb = heartbeatPath ? readJson(heartbeatPath) : null;
  const entry = hb && typeof hb === 'object' ? hb[persona] : null;
  if (!entry) return { sessionId: null, lastSeen: null };
  return {
    sessionId: entry.sessionId ? String(entry.sessionId) : null,
    lastSeen: entry.lastSeen ? intOrNull(entry.lastSeen) : null,
  };
}

// The newest decision matching a test, as get_fact reads it: last in the
// array, since decisions[] is append-ordered. Null where there is none.
function newestDecision(decisions, test) {
  let newest = null;
  for (const d of decisions) {
    if (test(d)) newest = d;
  }
  return newest;
}

// Every store-borne fact the poll reads, from one read of the store, so no two
// of them can describe different moments.
export function readStoreFacts(storePath, persona) {
  const facts = {
    rootCompleteTs: null,
    rootCompleteBackfilled: false,
    shutdownRequestedTs: null,
    restartRequestedTs: null,
  };
  const store = storePath ? readJson(storePath) : null;
  const p = store && typeof store === 'object' ? store[persona] : null;
  if (!p) return facts;
  const decisions = Array.isArray(p.decisions) ? p.decisions : [];
  const ts = (d) => (d ? intOrNull(d.timestamp || 0) : null);

  // An entry that is not an object, or a detail that is not text, matches
  // nothing rather than throwing, so one malformed entry costs no other fact.
  const is = (action) => (x) => !!x && x.action === action;
  const root = newestDecision(decisions, is('root_complete'));
  facts.rootCompleteTs = ts(root);
  facts.rootCompleteBackfilled = !!(root && typeof root.detail === 'string' && root.detail.includes('backfilled'));
  facts.shutdownRequestedTs = ts(newestDecision(decisions, is('shutdown_requested')));
  facts.restartRequestedTs = ts(newestDecision(decisions, is('restart_requested')));
  return facts;
}

// How much longer a rate-limited child has to wait, as get_rate_limit_reset
// reads it: only the newest complete record in the tail of the stream counts.
export function readRateLimitReset(streamPath) {
  const SCAN_BYTES = 262144;
  const now = Date.now();
  let text = '';
  let scanStart = 0;
  try {
    const fd = fs.openSync(streamPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > SCAN_BYTES) scanStart = size - SCAN_BYTES;
      const len = size - scanStart;
      const buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, scanStart);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) { return '- -'; }
  const lines = text.split('\n');
  // The tail can start mid-line, and the file can end mid-line while the child
  // is writing. Neither partial is a record.
  if (scanStart > 0) lines.shift();
  lines.pop();
  let newest = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch (e) { continue; }
    if (record && typeof record === 'object') newest = record;
  }
  const isRetry = newest
    && newest.type === 'system'
    && newest.subtype === 'api_retry'
    && Number(newest.error_status) === 429
    && Number.isFinite(Number(newest.retry_delay_ms))
    && Number(newest.retry_delay_ms) > 0;
  if (!isRetry) return '- -';
  const until = now + Number(newest.retry_delay_ms);
  return until + ' ' + new Date(until).toISOString();
}

// The child's session id off the stream's init line. Runs only until a poll
// finds one. A line that is not a record is passed over, where
// read_child_session_id stops at it: the hung check needs this id, and a
// stray first line would otherwise leave it unread for the child's whole life.
export function readChildSessionId(streamPath) {
  let lines;
  try {
    lines = fs.readFileSync(streamPath, 'utf8').split('\n');
  } catch (e) { return ''; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    if (o && o.session_id) return String(o.session_id);
  }
  return '';
}

function readMtimeMs(path) {
  if (!path) return null;
  try {
    return Math.floor(fs.statSync(path).mtimeMs);
  } catch (e) {
    return null;
  }
}

export function poll(argv) {
  const [heartbeatPath, storePath, persona, streamPath, transcriptDir, knownSessionId,
    childStartTs, launchedAt, staleAfterMs, minRunMs, maxRestartsPerHour,
    crashCount, restartCount, crashLimit] = argv;

  // The clock and the heartbeat are read together: the staleness the decide
  // unit computes is the gap between the two.
  //
  // Each reading fails on its own. One the reader cannot make reads as absent
  // and the rest still reach the decide unit, so a malformed store entry
  // cannot switch off the hung check.
  const safe = (read, absent) => { try { return read(); } catch (e) { return absent; } };
  const now = Date.now();
  const heartbeat = safe(() => readHeartbeat(heartbeatPath, persona), { sessionId: null, lastSeen: null });
  const rateLimit = safe(() => readRateLimitReset(streamPath), '- -');
  const childSessionId = knownSessionId || safe(() => readChildSessionId(streamPath), '');
  const facts = safe(() => readStoreFacts(storePath, persona), readStoreFacts('', persona));
  // The transcript is addressed by the session id, so the poll that first
  // reads the id off the stream reads the transcript too.
  const transcriptPath = transcriptDir && /^[A-Za-z0-9_-]+$/.test(childSessionId)
    ? path.join(transcriptDir, childSessionId + '.jsonl')
    : '';

  const result = decide({
    childExitCode: null,
    rootCompleteTs: facts.rootCompleteTs,
    shutdownRequestedTs: facts.shutdownRequestedTs,
    restartRequestedTs: facts.restartRequestedTs,
    crashCount: intOr(crashCount, 0),
    crashLimit: intOr(crashLimit, 3),
    restartCount: intOr(restartCount, 0),
    childStartTs: intOr(childStartTs, 0),
    childSessionId: childSessionId || null,
    heartbeatSessionId: heartbeat.sessionId,
    heartbeatLastSeen: heartbeat.lastSeen,
    transcriptLastWriteTs: readMtimeMs(transcriptPath),
    now,
    launchedAt: intOr(launchedAt, 0),
    staleAfterMs: intOr(staleAfterMs, 90000),
    minRunMs: intOr(minRunMs, 120000),
    maxRestartsPerHour: intOr(maxRestartsPerHour, 6),
    rootCompleteBackfilled: facts.rootCompleteBackfilled,
  });

  // One value per line, so a reason carrying a newline cannot shift the lines
  // under it.
  const oneLine = (s) => String(s === undefined || s === null ? '' : s).replace(/[\r\n]+/g, ' ');
  return [oneLine(result.action || 'continue'), oneLine(result.reason || ''), rateLimit, oneLine(childSessionId)];
}

// Run unconditionally: this file is only ever launched, never imported. A
// guard comparing this module's URL against argv would turn on how the launch
// path was spelled, and a mismatch would print nothing, which the poll loop
// reads as a failed poll on every pass.
process.stdout.write(poll(process.argv.slice(2)).join('\n') + '\n');
