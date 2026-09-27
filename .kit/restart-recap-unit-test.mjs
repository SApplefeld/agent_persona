#!/usr/bin/env node
// Unit test for bin/restart-recap.mjs (the restart recap).
// Run: node .kit/restart-recap-unit-test.mjs
// Exits 0 on all-pass, 1 on any failure.
//
// Each case builds its own working directory and transcript root under its
// own temp directory, from the fixtures in .kit/fixtures/restart-recap, and
// runs the recap as its own process with --projects pointed at that root. No
// case reads a real store or a real transcript folder.
//
// The risk this suite exists for is a recap of the wrong session, so the
// session choice is driven every way it can go: the ring read over a newer
// transcript of another persona, the own session left out of the ring read
// and of the fallback, and the fallback labelled as unrecorded lineage.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const recapPath = resolve(here, '../bin/restart-recap.mjs');
const fixtures = resolve(here, 'fixtures/restart-recap');
const root = fs.mkdtempSync(join(os.tmpdir(), 'restart-recap-'));

let mod = null;
let importError = null;
try {
  mod = await import(pathToFileURL(recapPath).href);
} catch (e) {
  importError = e;
}
const api = () => {
  if (!mod) throw new Error('the recap did not import: ' + (importError && importError.message));
  return mod;
};
// The harness's project key, from the module that owns the rule, so the
// fixture folders cannot drift from it. The rule itself is checked against
// hand-derived names in its own case.
const { projectKey } = await import(pathToFileURL(resolve(here, '../bin/supervise-liveness.mjs')).href);

// The fixture sessions. PREV and OLDER are the persona's own, named by the
// store's ring; OTHER is another persona's session in the same folder; OWN is
// the session running the recap; GONE is named by the ring and has no
// transcript, as a rotated one would not.
const PREV = 'a1a1a1a1-0000-4000-8000-000000000001';
const OLDER = 'b2b2b2b2-0000-4000-8000-000000000002';
const OTHER = 'c3c3c3c3-0000-4000-8000-000000000003';
const OWN = 'd4d4d4d4-0000-4000-8000-000000000004';
const GONE = 'e5e5e5e5-0000-4000-8000-000000000005';
const FIXTURE_FILE = { [PREV]: 'transcript-prev.jsonl', [OLDER]: 'transcript-older.jsonl', [OTHER]: 'transcript-other.jsonl' };
// Far enough back that no fixture record reads as outside the window.
const WIDE_SINCE = '1000000';

const fixtureStore = () => JSON.parse(fs.readFileSync(join(fixtures, 'store.json'), 'utf8'));

// The first record in the previous-session fixture the predicate accepts, as
// a fresh object a case may edit.
function fixtureRecord(accept) {
  const line = fs.readFileSync(join(fixtures, 'transcript-prev.jsonl'), 'utf8').split('\n')
    .find((l) => { try { return accept(JSON.parse(l)); } catch (e) { return false; } });
  return JSON.parse(line);
}

// The one record shape the synthetic transcripts below are cut from: the
// fixture's first operator message, with its text replaced.
function operatorRecord(sessionId, timestamp, text) {
  const line = fs.readFileSync(join(fixtures, 'transcript-prev.jsonl'), 'utf8').split('\n')
    .find((l) => l.includes('"content":"<channel source=\\"plugin:relay:channel-relay\\"'));
  const r = JSON.parse(line);
  r.sessionId = sessionId;
  r.timestamp = timestamp;
  r.message.content = '<channel source="plugin:relay:channel-relay" chat_id="100000000000000001">\n' + text + '\n</channel>';
  return r;
}

// One case's tree. opts.store edits the fixture store, or null leaves no
// store; opts.folderName names the transcript folder from the derived key;
// opts.sessions lists the transcripts written, newest mtime last; opts.own
// writes the running session's own transcript, newest of all.
function makeCase(name, opts = {}) {
  const dir = join(root, name);
  const wd = join(dir, opts.wdName || 'wd');
  const projects = join(dir, 'projects');
  fs.mkdirSync(wd, { recursive: true });
  const key = projectKey(wd);
  const folderName = opts.folderName ? opts.folderName(key) : key;
  const folder = join(projects, folderName);
  fs.mkdirSync(folder, { recursive: true });
  if (opts.store !== null) {
    const store = fixtureStore();
    if (opts.store) opts.store(store);
    fs.writeFileSync(join(wd, '.agentic-personas.json'), JSON.stringify(store, null, 2));
  }
  const sessions = opts.sessions || [OLDER, PREV, OTHER];
  const base = Date.now() / 1000 - 10000;
  sessions.forEach((id, i) => {
    const file = join(folder, id + '.jsonl');
    fs.copyFileSync(join(fixtures, FIXTURE_FILE[id]), file);
    fs.utimesSync(file, base + i * 100, base + i * 100);
  });
  if (opts.own !== false) {
    const file = join(folder, OWN + '.jsonl');
    fs.writeFileSync(file, JSON.stringify(operatorRecord(OWN, '2026-09-27T09:00:00.000Z', 'This is the running session. OWN-SESSION-MARKER')) + '\n');
    fs.utimesSync(file, base + 5000, base + 5000);
  }
  return { dir, wd, projects, folder, key, folderName };
}

// Runs the recap as its own process in the case's working directory. The
// inherited session id is dropped, so a case names the excluded session
// itself or deliberately names none.
function run(paths, args = [], env = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_CODE_SESSION_ID'));
  const r = spawnSync(process.execPath, [recapPath, ...args.map(String)], {
    cwd: paths.wd,
    encoding: 'utf8',
    env: { ...inherited, ...env },
  });
  const lines = String(r.stdout || '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let header = null;
  try { header = JSON.parse(lines[0]); } catch (e) { header = null; }
  return {
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    header,
    digest: lines.slice(1),
  };
}

// The usual invocation: the case's transcript root, the own session excluded,
// and a window wide enough for the fixtures' dates.
const standard = (paths, extra = []) => run(paths, ['--projects', paths.projects, '--exclude', OWN, '--since', WIDE_SINCE, ...extra]);
const linesOf = (r, kind) => r.digest.filter((l) => l.startsWith(kind + ' '));
const sessionLines = (r) => linesOf(r, 'session');

const cases = [
  // --- Which sessions: the ring over the fallback, and the own session out. ---
  ['the ring is read over the fallback: the persona\'s two newest ring sessions, oldest first, never a newer transcript of another persona', () => {
    const paths = makeCase('ring-over-fallback');
    const r = standard(paths);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.header.lineage, 'recorded');
    assert.deepEqual(r.header.sessions, [OLDER, PREV]);
    assert.deepEqual(sessionLines(r).map((l) => l.split(':')[0]), ['session ' + OLDER, 'session ' + PREV]);
    assert.match(r.stdout, /OLDER-OPERATOR/);
    assert.match(r.stdout, /OPERATOR-ONE/);
    // OTHER has the newest mtime of the persona sessions, so the fallback
    // would have taken it; the ring names it nowhere.
    assert.doesNotMatch(r.stdout, /OTHER-/);
    assert.doesNotMatch(r.stdout, /OWN-SESSION-MARKER/);
  }],
  ['the own session is excluded from the ring read, even where the ring names it first', () => {
    const paths = makeCase('exclude-ring', { store: (s) => { s.FIXTURE.previousSessionIds = [OWN, PREV, OLDER]; } });
    const r = standard(paths);
    assert.equal(r.header.lineage, 'recorded');
    assert.deepEqual(r.header.sessions, [OLDER, PREV]);
    assert.doesNotMatch(r.stdout, /OWN-SESSION-MARKER/);
    // Control: with nothing excluded the same store reads the own session,
    // so the exclusion is what kept it out.
    const control = run(paths, ['--projects', paths.projects, '--since', WIDE_SINCE]);
    assert.deepEqual(control.header.sessions, [PREV, OWN]);
    assert.match(control.stdout, /OWN-SESSION-MARKER/);
    assert.match(control.stderr, /no session to exclude/);
  }],
  ['the own session is excluded from the fallback, which takes the newest other transcript and reads unrecorded', () => {
    const paths = makeCase('exclude-fallback', { store: (s) => { s.FIXTURE.previousSessionIds = []; } });
    const r = standard(paths);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.header.lineage, 'unrecorded');
    assert.deepEqual(r.header.sessions, [OTHER]);
    assert.doesNotMatch(r.stdout, /OWN-SESSION-MARKER/);
    // Control: nothing excluded, and the own transcript, the newest, is taken.
    const control = run(paths, ['--projects', paths.projects, '--since', WIDE_SINCE]);
    assert.deepEqual(control.header.sessions, [OWN]);
  }],
  ['the excluded session defaults to CLAUDE_CODE_SESSION_ID', () => {
    const paths = makeCase('exclude-env', { store: (s) => { s.FIXTURE.previousSessionIds = [OWN, PREV]; } });
    const r = run(paths, ['--projects', paths.projects, '--since', WIDE_SINCE], { CLAUDE_CODE_SESSION_ID: OWN });
    assert.deepEqual(r.header.sessions, [PREV]);
    assert.doesNotMatch(r.stdout, /OWN-SESSION-MARKER/);
    assert.doesNotMatch(r.stderr, /no session to exclude/);
  }],
  ['a store written before the ring existed takes the fallback and reads unrecorded', () => {
    const paths = makeCase('ring-absent', { store: (s) => { delete s.FIXTURE.previousSessionIds; } });
    const r = standard(paths);
    assert.equal(r.header.lineage, 'unrecorded');
    assert.deepEqual(r.header.sessions, [OTHER]);
    assert.equal(r.header.activeGoal, true, 'the entry still reads');
  }],
  ['a ring holding only the own session reads as empty: fallback, unrecorded', () => {
    const paths = makeCase('ring-only-own', { store: (s) => { s.FIXTURE.previousSessionIds = [OWN]; } });
    const r = standard(paths);
    assert.equal(r.header.lineage, 'unrecorded');
    assert.deepEqual(r.header.sessions, [OTHER]);
  }],
  ['--sessions reaches a ring session whose transcript is gone, names it on stderr, and still exits 0', () => {
    const paths = makeCase('gone');
    const r = standard(paths, ['--sessions', '3']);
    assert.equal(r.status, 0);
    assert.deepEqual(r.header.sessions, [OLDER, PREV]);
    assert.match(r.stderr, new RegExp('no transcript for session ' + GONE));
    assert.equal(r.header.lineage, 'recorded', 'a rotated transcript does not turn the lineage into a guess');
  }],
  ['a ring entry that is not a session id reaches no path', () => {
    const paths = makeCase('bad-id', { store: (s) => { s.FIXTURE.previousSessionIds = ['..\\..\\escape', PREV]; } });
    const r = standard(paths);
    assert.deepEqual(r.header.sessions, [PREV]);
    assert.match(r.stderr, /not a session id a transcript file can carry/);
  }],

  // --- Which folder. ---
  ['the folder-name rule turns a dot, a colon, a backslash and an underscore into hyphens', () => {
    // Hand-derived names, withheld from the rule's own code.
    assert.equal(projectKey('D:\\personas\\my.persona'), 'D--personas-my-persona');
    assert.equal(projectKey('D:\\personas\\ARCHITECT'), 'D--personas-ARCHITECT');
    assert.equal(projectKey('C:\\a_b.c'), 'C--a-b-c');
    // And end to end, from a working directory whose name carries a dot.
    const paths = makeCase('dot-dir', { wdName: 'wd.dot' });
    assert.ok(paths.wd.includes('.') && paths.wd.includes(':'), 'the control path carries a dot and a colon: ' + paths.wd);
    assert.ok(!paths.key.includes('.') && !paths.key.includes(':'));
    const r = standard(paths);
    assert.deepEqual(r.header.sessions, [OLDER, PREV], r.stderr);
  }],
  ['the lookup finds a folder whose stored name differs from the derived key in case only, and reads it once', () => {
    const swap = (k) => k.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
    const paths = makeCase('case-only', { folderName: swap });
    assert.notEqual(paths.folderName, paths.key, 'the stored name differs from the derived key');
    // The lookup returns the name the listing stores, so it found the folder
    // by listing rather than by the platform opening the derived name.
    const found = api().transcriptFolders(paths.projects, paths.wd);
    assert.deepEqual(found.map((f) => f.name), [paths.folderName]);
    const r = standard(paths);
    assert.deepEqual(r.header.sessions, [OLDER, PREV], r.stderr);
    assert.equal(r.digest.filter((l) => l.includes('OPERATOR-ONE')).length, 1, 'read once');
  }],
  ['a folder whose name differs from the key by more than case is not taken', () => {
    const paths = makeCase('near-miss', { folderName: (k) => k + '-x' });
    assert.deepEqual(api().transcriptFolders(paths.projects, paths.wd), []);
    const r = standard(paths);
    assert.equal(r.status, 0);
    assert.deepEqual(r.header.sessions, []);
    assert.deepEqual(r.digest, []);
    assert.match(r.stderr, /no transcript folder under .* matches/);
  }],

  // --- The caps. ---
  ['a message is cut to RECAP_MESSAGE_CHARS', () => {
    const paths = makeCase('message-cap', { sessions: [], own: false, store: (s) => { s.FIXTURE.previousSessionIds = [PREV]; } });
    const long = 'M'.repeat(api().RECAP_MESSAGE_CHARS * 3);
    fs.writeFileSync(join(paths.folder, PREV + '.jsonl'), JSON.stringify(operatorRecord(PREV, '2026-09-25T10:00:00.000Z', long)) + '\n');
    const r = standard(paths);
    const op = linesOf(r, 'operator');
    assert.equal(op.length, 1);
    assert.equal(op[0].slice('operator 10:00: '.length), 'M'.repeat(api().RECAP_MESSAGE_CHARS));
  }],
  ['the digest is cut to RECAP_DIGEST_CHARS, the oldest message lines dropped first, with a line counting them', () => {
    const paths = makeCase('digest-cap', { sessions: [], own: false, store: (s) => { s.FIXTURE.previousSessionIds = [PREV]; } });
    const cap = api().RECAP_MESSAGE_CHARS;
    const total = Math.ceil(api().RECAP_DIGEST_CHARS / cap) * 2;
    const records = [];
    for (let i = 0; i < total; i += 1) {
      const ts = new Date(Date.UTC(2026, 8, 25, 10, i)).toISOString();
      records.push(JSON.stringify(operatorRecord(PREV, ts, 'IDX' + String(i).padStart(3, '0') + ' ' + 'x'.repeat(cap))));
    }
    fs.writeFileSync(join(paths.folder, PREV + '.jsonl'), records.join('\n') + '\n');
    const r = standard(paths);
    const size = r.digest.reduce((n, l) => n + l.length + 1, 0);
    assert.ok(size <= api().RECAP_DIGEST_CHARS, 'digest ' + size + ' characters');
    const kept = linesOf(r, 'operator');
    assert.ok(kept.length > 0 && kept.length < total, kept.length + ' of ' + total + ' kept');
    const dropped = total - kept.length;
    assert.match(r.digest[0], new RegExp('^dropped ' + dropped + ' of the oldest message line'));
    // The newest survive and the oldest go.
    assert.match(kept[kept.length - 1], new RegExp('IDX' + String(total - 1).padStart(3, '0')));
    assert.doesNotMatch(r.stdout, /IDX000/);
    // The frame lines are kept.
    assert.equal(sessionLines(r).length, 1);
    assert.equal(r.digest.filter((l) => l.startsWith('last words: ')).length, 1);
    assert.match(r.digest[r.digest.length - 1], new RegExp('^count: ' + total + ' operator message'));
  }],

  // --- The header's three fields. ---
  ['the header reads the newest record, the newest operator message and an active goal', () => {
    const paths = makeCase('header-goal');
    const r = standard(paths);
    assert.deepEqual(Object.keys(r.header).sort(), ['activeGoal', 'lastOperatorAt', 'lastRecordAt', 'lineage', 'sessions']);
    assert.equal(r.header.lastRecordAt, '2026-09-25T13:05:01.000Z');
    // The sidechain copy at 12:43 and the other channel at 12:42 are not
    // operator messages; the newest tagged one is at 12:58.
    assert.equal(r.header.lastOperatorAt, '2026-09-25T12:58:00.000Z');
    assert.equal(r.header.activeGoal, true);
  }],
  ['the header reads no active goal where the entry names none, and null where the store or the entry cannot be read', () => {
    const none = standard(makeCase('header-null-goal', { store: (s) => { s.FIXTURE.activeGoalId = null; } }));
    assert.equal(none.header.activeGoal, false);
    assert.equal(none.header.lastRecordAt, '2026-09-25T13:05:01.000Z');
    const absent = standard(makeCase('header-absent-goal', { store: (s) => { delete s.FIXTURE.activeGoalId; } }));
    assert.equal(absent.header.activeGoal, false);
    const noStore = standard(makeCase('header-no-store', { store: null }));
    assert.equal(noStore.status, 0);
    assert.equal(noStore.header.activeGoal, null);
    assert.equal(noStore.header.lineage, 'unrecorded');
    assert.match(noStore.stderr, /the store .* cannot be read/);
    const noEntry = standard(makeCase('header-no-entry'), ['--persona', 'NOBODY']);
    assert.equal(noEntry.header.activeGoal, null);
    assert.match(noEntry.stderr, /holds no entry for NOBODY/);
  }],
  ['a store holding two personas needs --persona, and reads the named one', () => {
    const paths = makeCase('two-personas', { store: (s) => { s.SECOND = { persona: 'SECOND', previousSessionIds: [OTHER], activeGoalId: null }; } });
    const r = standard(paths);
    assert.equal(r.header.activeGoal, null);
    assert.equal(r.header.lineage, 'unrecorded');
    assert.match(r.stderr, /holds 2 personas, so --persona must name one/);
    const named = standard(paths, ['--persona', 'SECOND']);
    assert.deepEqual(named.header.sessions, [OTHER]);
    assert.equal(named.header.activeGoal, false);
  }],
  ['the header and an empty digest print where no transcript root exists at all', () => {
    const paths = makeCase('no-root');
    const r = run(paths, ['--projects', join(paths.dir, 'nowhere'), '--exclude', OWN]);
    assert.equal(r.status, 0);
    assert.deepEqual(r.header, { lineage: 'recorded', sessions: [], lastRecordAt: null, lastOperatorAt: null, activeGoal: true });
    assert.deepEqual(r.digest, []);
    assert.match(r.stderr, /cannot be listed/);
  }],

  // --- What the digest admits. ---
  ['no excluded shape reaches the digest: tool calls and results, priming, injected and coordinator turns, other channels, sidechains, thinking, subagents', () => {
    const paths = makeCase('exclusions', { sessions: [PREV], store: (s) => { s.FIXTURE.previousSessionIds = [PREV]; } });
    // A subagent transcript under the session's own folder, operator-shaped
    // and newer than every other file.
    const sub = join(paths.folder, PREV, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(join(sub, 'agent-1.jsonl'), JSON.stringify(operatorRecord(PREV, '2026-09-25T13:30:00.000Z', 'EXCLUDED-SUBAGENT')) + '\n');
    const r = standard(paths);
    // The instrument speaks: every marker it searches for is read out of the
    // fixture itself rather than listed here, and each is present there.
    const fixtureText = fs.readFileSync(join(fixtures, 'transcript-prev.jsonl'), 'utf8');
    const markers = [...new Set(fixtureText.match(/EXCLUDED-[A-Z-]+/g))];
    assert.ok(markers.length >= 10, 'markers read from the fixture: ' + markers.join(', '));
    for (const m of [...markers, 'EXCLUDED-SUBAGENT']) assert.ok(!r.stdout.includes(m), m + ' reached the digest');
    // The admitted shapes do reach it, so a silent digest is not the reason.
    for (const m of ['OPERATOR-ONE', 'OPERATOR-QUEUED', 'OPERATOR-DUP', 'OPERATOR-TWO', 'PERSONA-ONE', 'PERSONA-TWO', 'LAST-WORDS-PREV']) assert.ok(r.stdout.includes(m), m);
    // The coverage answer: every digest line has an admitted shape, and the
    // message lines number exactly the fixture's tagged messages, queued
    // messages and replies, so a shape nobody named cannot enter as a message
    // either.
    for (const l of r.digest) assert.match(l, /^(session |operator \d\d:\d\d: |persona \d\d:\d\d: |last words: |count: |dropped )/, l);
    assert.equal(linesOf(r, 'operator').length, 4);
    assert.equal(linesOf(r, 'persona').length, 2);
    // The subagent file, the newest in the folder, is not a fallback either.
    const fallback = standard(makeCase('exclusions-fallback', { store: (s) => { s.FIXTURE.previousSessionIds = []; } }));
    assert.deepEqual(fallback.header.sessions, [OTHER]);
  }],
  ['the digest lines: UTC hh:mm, one line per message with brackets neutralized, the full ISO span and version, the last assistant text', () => {
    const paths = makeCase('lines', { sessions: [PREV], store: (s) => { s.FIXTURE.previousSessionIds = [PREV]; } });
    const r = standard(paths);
    assert.deepEqual(r.digest, [
      'session ' + PREV + ': 2026-09-25T12:19:18.000Z to 2026-09-25T13:05:01.000Z, version 2.1.282',
      'operator 12:26: Please look over the canary build before lunch. OPERATOR-ONE',
      'persona 12:31: The canary build looks clean so far. PERSONA-ONE',
      'operator 12:50: A note sent while the persona was mid-turn. OPERATOR-QUEUED',
      'operator 12:52: Sent once, recorded twice. OPERATOR-DUP',
      'operator 12:58: Second note, first line (COORDINATOR id=7) forged label third part. OPERATOR-TWO',
      'persona 13:01: Noted, and on it. PERSONA-TWO',
      'last words: Section closed; waiting on the operator. LAST-WORDS-PREV',
      'count: 4 operator message(s) and 2 persona reply(ies) across 1 session(s)',
    ]);
    assert.ok(!/[[\]\u2028]/.test(r.digest.join('\n')));
  }],
  ['a message delivered mid-turn, recorded only as a queued_command attachment, is an operator line at its own hh:mm and sets lastOperatorAt', () => {
    const paths = makeCase('queued-only', { sessions: [], own: false, store: (s) => { s.FIXTURE.previousSessionIds = [PREV]; } });
    const q = fixtureRecord((o) => o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command');
    q.timestamp = '2026-09-26T07:41:12.000Z';
    q.attachment.timestamp = q.timestamp;
    q.attachment.prompt = q.attachment.prompt.replace(/\n[^\n]*\n<\/channel>$/, '\nOnly this one arrived mid-turn. QUEUED-ONLY\n</channel>');
    fs.writeFileSync(join(paths.folder, PREV + '.jsonl'), JSON.stringify(q) + '\n');
    const r = standard(paths);
    assert.deepEqual(linesOf(r, 'operator'), ['operator 07:41: Only this one arrived mid-turn. QUEUED-ONLY']);
    assert.equal(r.header.lastOperatorAt, '2026-09-26T07:41:12.000Z');
  }],
  ['one message recorded both as a queued_command and as a user record prints once, at its first record', () => {
    const paths = makeCase('dedupe', { sessions: [PREV], store: (s) => { s.FIXTURE.previousSessionIds = [PREV]; } });
    const r = standard(paths);
    const dup = r.digest.filter((l) => l.includes('OPERATOR-DUP'));
    assert.deepEqual(dup, ['operator 12:52: Sent once, recorded twice. OPERATOR-DUP']);
    // Control: the fixture does carry the message twice, once per carrier.
    const fixtureText = fs.readFileSync(join(fixtures, 'transcript-prev.jsonl'), 'utf8');
    assert.equal(fixtureText.split('\n').filter((l) => l.includes('OPERATOR-DUP')).length, 2);
  }],
  ['a queue-operation record, a file attachment and a tool result quoting a channel block after its own output admit nothing', () => {
    const paths = makeCase('not-carriers', { sessions: [PREV], store: (s) => { s.FIXTURE.previousSessionIds = [PREV]; } });
    const r = standard(paths);
    for (const m of ['EXCLUDED-QUEUE-OPERATION', 'EXCLUDED-FILE-ATTACHMENT', 'EXCLUDED-QUOTED-CHANNEL']) {
      assert.ok(fs.readFileSync(join(fixtures, 'transcript-prev.jsonl'), 'utf8').includes(m), m + ' is in the fixture');
      assert.ok(!r.stdout.includes(m), m + ' reached the digest');
    }
  }],
  ['a session outside --since prints one line naming its age and nothing else', () => {
    const paths = makeCase('since');
    const r = run(paths, ['--projects', paths.projects, '--exclude', OWN, '--since', '1']);
    assert.equal(r.status, 0);
    assert.equal(r.digest.length, 3, r.digest.join('\n'));
    assert.match(r.digest[0], new RegExp('^session ' + OLDER + ': last record 2026-09-24T08:30:00.000Z, \\d+ hours ago, outside the 1-hour window$'));
    assert.match(r.digest[1], new RegExp('^session ' + PREV + ': last record .*outside the 1-hour window$'));
    assert.match(r.digest[2], /^count: 0 operator message\(s\) and 0 persona reply\(ies\) across 0 session\(s\)$/);
    assert.equal(r.header.lastRecordAt, '2026-09-25T13:05:01.000Z', 'the header still names what was read');
  }],

  // --- Failure paths. ---
  ['a record that is not JSON is skipped with one line naming it, and the rest still reads', () => {
    const paths = makeCase('bad-record', { sessions: [PREV], store: (s) => { s.FIXTURE.previousSessionIds = [PREV]; } });
    fs.appendFileSync(join(paths.folder, PREV + '.jsonl'), '{"type":"user", this is not json\n');
    const r = standard(paths);
    assert.equal(r.status, 0);
    const notes = r.stderr.split('\n').filter((l) => l.includes('not JSON'));
    assert.equal(notes.length, 1, r.stderr);
    assert.ok(notes[0].includes(PREV + '.jsonl'));
    assert.equal(linesOf(r, 'operator').length, 4);
  }],
  ['a transcript that cannot be read is skipped with one line naming it, and the header still prints', () => {
    const paths = makeCase('unreadable', { sessions: [OLDER], store: (s) => { s.FIXTURE.previousSessionIds = [PREV, OLDER]; } });
    fs.mkdirSync(join(paths.folder, PREV + '.jsonl'));
    const r = standard(paths);
    assert.equal(r.status, 0);
    assert.deepEqual(r.header.sessions, [OLDER]);
    assert.match(r.stderr, new RegExp('the transcript .*' + PREV + '\\.jsonl cannot be read'));
  }],
  ['a tail read drops the line its cut landed inside rather than reporting it', () => {
    const file = join(root, 'tail.jsonl');
    const pad = JSON.stringify({ type: 'x', pad: 'p'.repeat(200) });
    fs.writeFileSync(file, [JSON.stringify({ type: 'first' }), pad, pad, JSON.stringify({ type: 'last' })].join('\n') + '\n');
    // A tail of 30 bytes holds the last record whole and cuts into the pad
    // line before it.
    const read = api().readRecords(file, 30);
    assert.deepEqual(read.bad, []);
    assert.deepEqual(read.records.map((o) => o.type), ['last']);
    assert.equal(api().readRecords(join(root, 'absent.jsonl')), null);
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
