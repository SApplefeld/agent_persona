// decision-journal.ts: the append-only record of every shadow question this
// plugin puts to Jev, in the row shape a later bulk load into SQL reads.
//
// One file per persona per UTC day per session:
//   <home>/.claude/agentic-decisions/<persona>/<YYYY-MM-DD>-<session>.jsonl
// A file per day bounds the read-and-rewrite an append costs, and a file per
// session means no two processes ever share one.
//
// Three line kinds and no others: `call` records the request, `answer` records
// what came back beside what Haiku said, and `outcome` records a signal the
// plugin produced later. Every field is present on every line of its kind, and
// a value that does not apply is null, so a load can read a column per field
// without a per-line shape test.
//
// No `import $` and no side effects at load. The engine's loader follows `$`
// only into functions declared in hooks/index.ts and refuses the whole module
// where `$` crosses an import, so this file takes a JournalHost instead: four
// members of the PluginHost that hooks/index.ts builds over `$` in its
// top-level hostOf adapter.
//
// Nothing here throws into a caller. Each writer resolves to true or false,
// and the first failure of a UTC day is flagged so the caller can log it once.
// A tick that cannot write its journal line is still a tick that must finish.
//
// This module is the journal's output channel, so the guard every line crosses
// lives here and is exported rather than kept private: the clamp that bounds a
// field nobody else bounds. A later module that writes a journal line calls it
// rather than writing its own, which is what stops the next boundary from
// being unguarded.
//
// The scrub beside it is exported and is not applied by any writer here. What
// keeps the API key out of a line today is the seam, which holds the only copy
// and scrubs the one field it builds from a message it did not author. The
// journal does not read the key, because reading it would mean one more op
// event per line, observable by any co-loaded hook, and because the value that
// came back would then be used as a substitution pattern over the payload: a
// short or hostile answer would rewrite the measured state rather than leak
// it, in a file nothing rewrites. Which boundary should own the scrub, and
// what a line should record when it did not run, is open.

import type { PluginHost } from "./host";
import type { SeamResult } from "./decision-seam";
import { fnv1aHash } from "./cost-ledger";

// What the journal needs from the host: the home directory and the three file
// calls an append costs.
export type JournalHost = Pick<PluginHost, "getHome" | "writeFile" | "readFile" | "fileExists">;

export const JOURNAL_DIR = ".claude/agentic-decisions";

// One line in five is holdout, which the retraining plan never reads when it
// proposes a wording. The split is a function of the stamp id alone, so it is
// the same answer every time it is asked.
export const HOLDOUT_EVERY = 5;

// The longest a free text field the journal did not author may be. An append
// reads the whole file and rewrites it, so one unbounded message would grow
// that cost for every later line of the day. Every such field is cut to this
// rather than refused: a truncated detail still names what happened.
export const FREE_TEXT_MAX = 512;

// The mark a cut field ends in, so a reader can tell a bounded value from a
// short one.
export const TEXT_CUT_MARK = "...[cut]";

// The longest a path segment built from a persona name or a session id may be.
export const SEGMENT_MAX = 64;

// The closed set of outcome kinds. A `next_score` is the first turn scored
// after a controller call; an `ask_marker` is the first worker ASK: line
// matched after one.
export type OutcomeKind = "next_score" | "ask_marker";
export const OUTCOME_KINDS: readonly OutcomeKind[] = ["next_score", "ask_marker"];

export type JournalSplit = "holdout" | "dev";

// What a writer resolves to. `ok` is whether the line landed. `firstFailureToday`
// is true on the first failed write of a UTC day and never on a write that
// landed, so a caller logging it pushes one decision a day rather than one a
// tick. The latch is in memory, so a restart lets the day's first failure be
// reported again.
export type JournalWrite = { ok: boolean; firstFailureToday: boolean };

// --- The two guards on this boundary ---

// Removes every occurrence of a secret from text bound for a journal line.
// Both the secret as held and its trimmed form are removed, since a producer
// may carry either into a message. Exported because this is the channel's
// guard rather than one producer's: the journal itself holds no secret and
// passes none, and a producer that does holds the only copy that could leak.
export function withoutSecret(text: string, secret: string | null | undefined): string {
  if (typeof secret !== "string") return text;
  let out = text;
  for (const form of new Set([secret, secret.trim()])) {
    if (form.length > 0) out = out.split(form).join("[secret]");
  }
  return out;
}

// The one call every free text field the journal did not author goes through:
// scrub, then bound. `state` is the exception and goes through neither, being
// the measured payload the call line stores once and the one field whose exact
// bytes a later reader needs.
export function journalText(value: unknown, secret?: string | null): string {
  const text = withoutSecret(typeof value === "string" ? value : String(value), secret);
  return text.length <= FREE_TEXT_MAX ? text : text.slice(0, FREE_TEXT_MAX - TEXT_CUT_MARK.length) + TEXT_CUT_MARK;
}

// --- Stamp ids and the split ---

// Per session and never reset, so two ids minted in the same millisecond
// differ. Module state, which is per loaded plugin instance and so per session.
let counter = 0;

// A path segment or an id part built from a caller's string: everything
// outside the safe set becomes an underscore and the result is cut. It is the
// guard on two boundaries at once. On the path it leaves no separator and no
// parent traversal for a persona name or a session id to carry. In the stamp
// id it leaves no dot, so the four parts of an id are the four parts a reader
// splits out. A value that sanitizes away entirely becomes a single underscore,
// since an empty segment would collapse the path.
function segment(value: string): string {
  const out = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, SEGMENT_MAX);
  return out.length > 0 ? out : "_";
}

// The id minted when a call starts rather than when it settles, so a joiner
// always has an id to cite even where the outcome line reaches the file before
// the call line does.
export function newStampId(persona: string, session: string): string {
  counter += 1;
  return `${segment(persona)}.${segment(session)}.${Date.now()}.${counter}`;
}

// Whether a stamp id's lines are holdout or dev. A function of the id alone,
// so an id's split never changes and no line needs to carry a decision made
// elsewhere.
export function splitOf(stampId: string): JournalSplit {
  return fnv1aHash(stampId) % HOLDOUT_EVERY === 0 ? "holdout" : "dev";
}

// --- The path ---

// The join hooks/question-catalog.ts uses for the override layer, and
// hooks/index.ts uses at workdirPathOf: trailing separators off the root, then
// an unconditional forward slash, which Windows resolves as readily as POSIX.
function joined(root: string, ...parts: string[]): string {
  return [root.replace(/[/\\]+$/, ""), ...parts].join("/");
}

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

// The file this session's lines for this UTC day belong in, or null where the
// host could not name a home directory. Both segments are sanitized: a persona
// name and a session id are the caller's strings, and this is the one place
// either one becomes part of a path.
async function journalPath(host: JournalHost, persona: string, session: string, at: number): Promise<string | null> {
  let home: unknown;
  try {
    home = await host.getHome();
  } catch {
    home = undefined;
  }
  if (typeof home !== "string" || home.trim().length === 0) return null;
  return joined(home.trim(), JOURNAL_DIR, segment(persona), `${utcDay(at)}-${segment(session)}.jsonl`);
}

// --- The write chain and the failure latch ---

// One promise chain per path, so two writes started together both land: the
// append reads the whole file and rewrites it, and two of those interleaved
// would drop a line. A Map rather than an object literal because its keys are
// paths built from a caller's strings.
const chains = new Map<string, Promise<void>>();

function chained(path: string, work: () => Promise<boolean>): Promise<boolean> {
  const prior = chains.get(path) ?? Promise.resolve();
  const next = prior.then(work, work);
  // The chain's own tail swallows both settlements, so one failed write never
  // leaves the next one waiting on a rejected promise.
  chains.set(path, next.then(() => undefined, () => undefined));
  return next;
}

// The UTC day the last reported failure fell on. In memory, so a restart lets
// that day's first failure be reported again, which is the shape the plan
// accepts in exchange for a latch that costs no file.
let failureDay: string | null = null;

function failed(at: number): JournalWrite {
  const day = utcDay(at);
  if (failureDay === day) return { ok: false, firstFailureToday: false };
  failureDay = day;
  return { ok: false, firstFailureToday: true };
}

const LANDED: JournalWrite = { ok: true, firstFailureToday: false };

// The append itself, run inside the chain. A file that exists and cannot be
// read is left alone rather than rewritten: a write built on an unreadable
// read would replace the day's lines with one. A line already carrying its
// terminator keeps the one it has.
async function appendLine(host: JournalHost, path: string, line: string): Promise<boolean> {
  try {
    // Read as unknown for the same reason the body below is: a hook above the
    // caller may answer this op event with a value of its own. An answer that
    // is neither true nor false says nothing about the file, and falling
    // through on one would rewrite the day's lines as a single line. The
    // stronger failure is guarded here and the weaker one below.
    const exists: unknown = await host.fileExists(path);
    if (exists !== true && exists !== false) return false;
    let existing = "";
    if (exists === true) {
      const read: unknown = await host.readFile(path);
      if (typeof read !== "string") return false;
      existing = read;
    }
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await host.writeFile(path, existing + sep + (line.endsWith("\n") ? line : line + "\n"));
    return true;
  } catch {
    return false;
  }
}

// Every writer's one path to the file: queue each line on that path's chain
// and report. Nothing here rejects.
async function writeLines(
  host: JournalHost,
  path: string,
  at: number,
  lines: readonly string[],
): Promise<JournalWrite> {
  if (lines.length === 0) return LANDED;
  let allLanded = true;
  for (const line of lines) {
    let landed = false;
    try {
      landed = await chained(path, () => appendLine(host, path, line));
    } catch {
      landed = false;
    }
    if (!landed) allLanded = false;
  }
  return allLanded ? LANDED : failed(at);
}

// --- Field helpers ---

// A count the line may carry: a non-negative integer, else null. The same bar
// the seam holds the vendor's own usage numbers to.
function countOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function finiteOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function textOrNull(v: unknown, secret?: string | null): string | null {
  return typeof v === "string" ? journalText(v, secret) : null;
}

// The probabilities map as a line carries it: prototype-free, since its keys
// are option ids that reach here from a response body, and an ordinary literal
// would swallow a key named __proto__ on the way in and be rewired by a null
// value at that key. Every value is a finite number or null.
function probabilitiesOf(from: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = Object.create(null);
  if (typeof from !== "object" || from === null) return out;
  // The key is bounded like every other text this module did not author. It is
  // the one that arrives as a key rather than a value, and the seam validates
  // each probability as a finite number without checking the key set against
  // the option ids it offered, so an unrequested or unbounded key reaches here.
  // An append rewrites the whole file, so one unbounded key would grow that
  // cost for every later line of the day.
  for (const [id, p] of Object.entries(from as Record<string, unknown>)) out[journalText(id)] = finiteOf(p);
  return out;
}

// --- The three writers ---

// What a call line needs beyond the result the seam returned. `state` is the
// text the question was asked about, which the line stores once per site.
export type CallRecord = {
  stampId: string;
  persona: string;
  session: string;
  site: string;
  questionSet: string;
  mode: string;
  state: string;
  result: SeamResult;
};

// The last state written per site, per file, so a run of calls on an unchanged
// state stores it once. Held in memory rather than read back from the file: a
// restart re-writes the state once per site per file, which is the same shape
// the failure latch has. A Map for the same reason the chain registry is one.
const lastState = new Map<string, { stateHash: number; stampId: string }>();

// One `call` line: the request as it was made and how it ended.
export async function writeCall(host: JournalHost, record: CallRecord): Promise<JournalWrite> {
  const at = Date.now();
  const result = record.result;
  const state = typeof record.state === "string" ? record.state : "";
  const stateHash = fnv1aHash(state);

  let path: string | null;
  try {
    path = await journalPath(host, record.persona, record.session, at);
  } catch {
    path = null;
  }
  if (path === null) return failed(at);

  // The state rides the line only where this site's last state on this file
  // differed. Otherwise the line points at the stamp id that carries it.
  const siteKey = `${path}\u0000${record.site}`;
  const prior = lastState.get(siteKey);
  const repeat = prior !== undefined && prior.stateHash === stateHash;

  const line = {
    // The closed set of line kinds, which an outcome line's own `kind` field
    // does not name: that one is the closed set of outcome kinds.
    lineKind: "call",
    stampId: journalText(record.stampId),
    at: new Date(at).toISOString(),
    persona: journalText(record.persona),
    session: journalText(record.session),
    site: journalText(record.site),
    questionSet: journalText(record.questionSet),
    mode: journalText(record.mode),
    split: splitOf(record.stampId),
    stateHash,
    state: repeat ? null : state,
    stateRef: repeat && prior !== undefined ? prior.stampId : null,
    // Null on a call that made no request, which is what the seam's own null
    // latency already says.
    inputTokens: result.ok ? countOf(result.usage.input_tokens) : null,
    latencyMs: countOf(result.latencyMs),
    result: result.ok ? "ok" : journalText(result.reason),
    // Built from a message the host or the resolver produced, so bounded by
    // neither until it crosses this boundary.
    detail: result.ok ? null : textOrNull(result.detail),
  };
  const written = await writeLines(host, path, at, [JSON.stringify(line) + "\n"]);
  // The reference is recorded only once the line carrying the state is in the
  // file. A line that never landed is one no later stateRef may name, or a
  // repeat would point at a stamp id no load can find and the state would be
  // lost for the rest of the day.
  if (written.ok && !repeat) lastState.set(siteKey, { stateHash, stampId: record.stampId });
  return written;
}

// One answer as it came back, beside the value Haiku gave for the same
// question. `agrees` is computed here rather than passed: agreement is exact
// equality of option id, and it is an agreement record and never a truth.
export type AnswerRecord = {
  callStampId: string;
  questionId: string;
  questionVersion: string;
  overrideRefused: string | null;
  value: string;
  probabilities: Record<string, number>;
  confidence: number;
  haikuValue: string | null;
};

export type AnswersRecord = {
  persona: string;
  session: string;
  answers: readonly AnswerRecord[];
};

// One `answer` line per answer, each with a stamp id of its own and the call's
// id to join on. A record with no answers writes nothing and reports a landed
// write, since a failed call has no answer to record.
export async function writeAnswers(host: JournalHost, record: AnswersRecord): Promise<JournalWrite> {
  const at = Date.now();
  const answers = Array.isArray(record.answers) ? record.answers : [];
  if (answers.length === 0) return LANDED;
  let path: string | null;
  try {
    path = await journalPath(host, record.persona, record.session, at);
  } catch {
    path = null;
  }
  if (path === null) return failed(at);
  const lines = answers.map((answer) => {
    // Agreement is decided on the values as they arrived, before the clamp,
    // so two option ids that differ only past the cut are not recorded as
    // agreeing. Where such a pair is cut, the two stored columns are byte
    // identical while `agrees` is false, and `agrees` is the authoritative
    // one: the stored pair is lossy and the `...[cut]` suffix is the tell.
    const rawValue = typeof answer.value === "string" ? answer.value : null;
    const rawHaiku = typeof answer.haikuValue === "string" ? answer.haikuValue : null;
    const value = textOrNull(answer.value);
    const haikuValue = textOrNull(answer.haikuValue);
    return JSON.stringify({
      lineKind: "answer",
      stampId: newStampId(record.persona, record.session),
      callStampId: journalText(answer.callStampId),
      questionId: journalText(answer.questionId),
      questionVersion: journalText(answer.questionVersion),
      overrideRefused: textOrNull(answer.overrideRefused),
      primitive: "choice",
      value,
      probabilities: probabilitiesOf(answer.probabilities),
      confidence: finiteOf(answer.confidence),
      haikuValue,
      agrees: rawValue !== null && rawHaiku !== null ? rawValue === rawHaiku : null,
    }) + "\n";
  });
  return writeLines(host, path, at, lines);
}

// A signal the plugin produced after the call, joined to it by the call's
// stamp id.
export type OutcomeRecord = {
  persona: string;
  session: string;
  callStampId: string;
  kind: OutcomeKind;
  value: string;
};

// One `outcome` line. A kind outside the closed set is refused rather than
// written, because a load reads this column as a closed vocabulary.
export async function writeOutcome(host: JournalHost, record: OutcomeRecord): Promise<JournalWrite> {
  const at = Date.now();
  // Refused without touching the latch. The latch reports the channel
  // failing, and a kind outside the closed set is the caller being wrong
  // rather than the file being unwritable. Arming it here would silence the
  // day's first real write failure.
  if (!OUTCOME_KINDS.includes(record.kind)) return { ok: false, firstFailureToday: false };
  let path: string | null;
  try {
    path = await journalPath(host, record.persona, record.session, at);
  } catch {
    path = null;
  }
  if (path === null) return failed(at);
  const line = {
    lineKind: "outcome",
    stampId: newStampId(record.persona, record.session),
    callStampId: journalText(record.callStampId),
    kind: record.kind,
    value: textOrNull(record.value),
    at: new Date(at).toISOString(),
  };
  return writeLines(host, path, at, [JSON.stringify(line) + "\n"]);
}
