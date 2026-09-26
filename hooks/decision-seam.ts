// decision-seam.ts: the one path a closed question takes to Jev, TypeSafe's
// classifier service, in one of two modes. In shadow the caller passes
// Haiku's value in, the result carries it back out beside Jev's answer, and
// no branch reads the answer into a decision. In live the same path sends the
// same request under a shorter timeout, because a live call is awaited by the
// wrapper that made it where a shadow call is not; which questions may be
// asked live, and what their answers reach, is that wrapper's rule in
// hooks/index.ts (liveAsk) and never this module's.
//
// No `import $` and no side effects at load. The engine's loader follows `$`
// only into functions declared in hooks/index.ts and refuses the whole module
// where `$` is passed across an import, so this file never sees `$`. It takes
// a SeamHost instead: three members of the PluginHost that hooks/index.ts
// builds over `$` in its top-level hostOf adapter, the same shape as its
// commonsStoreOf. check-loader-rule.mjs is a regex over known shapes and not
// the loader: its R5 reads the bare `$`-as-argument form of the cross-import
// shape, and whether this host shape loads is settled only by a live launch.
//
// The API key is read here and reaches exactly one place: the request's
// Authorization header. No part of its value is journaled, logged, put in a
// result detail or written to a file. Two kinds of text are scrubbed of it
// before they leave: every detail built from a message the host or the
// resolver produced, and the state itself, which is scrubbed once before the
// request body is built and rides the result from there. The state scrub is
// this module's principal guard, and it is here because a guard needing the
// key cannot sit on a boundary that must not hold one.
//
// Every call on the host is an op event a co-loaded plugin's hook may answer
// with a value of its own, so the party that supplies a response body is not
// the vendor alone. The response is therefore validated field by field and
// only the validated fields ride the result.

import type { PluginHost } from "./host";

// The live contract, endpoint included: https://docs.typesafe.ai/api.md
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
// $.http.fetch takes no timeout, so every request is raced against a timer,
// and the timer is the mode's. A shadow call is awaited by nothing, so its
// bound only caps how long an orphaned request stays open. A live call is
// awaited on the path that asked it, a turn end among them, so its bound is
// the longest that path may be delayed.
export const SHADOW_TIMEOUT_MS = 10_000;
export const LIVE_TIMEOUT_MS = 2_000;
// The longest model name the result carries; the vendor's is under 16.
export const MODEL_MAX_CHARS = 64;

// The shortest a key may be and still be sent. A shorter value is treated as an
// absent key: nothing is sent and no state is carried. The floor is the adopted
// ruling's rather than a length the vendor publishes, which is not established
// here, so a real key below it would read as no_key with nothing on the line
// telling that apart from an absent one.
//
// What the floor buys is bounded, and it is worth stating exactly. The scrub
// below uses the key as a search pattern over the state, so a very short key
// would rewrite the text rather than redact it. The floor closes that case and
// no other: a value at or above the floor that happens to occur in the state
// is still replaced wherever it occurs, which is the scrub working as intended
// and not a case this constant guards.
export const KEY_MIN_CHARS = 16;

// What the seam needs from the host: the key, the network and a timer.
export type SeamHost = Pick<PluginHost, "getApiKey" | "fetch" | "sleep">;

// The three question types the vendor takes (https://docs.typesafe.ai/api.md).
// A Choice picks one option of a set and returns a probability per option. A
// Noul answers one yes/no condition and returns the probability of yes. A
// Score rates the state against ordered levels and returns a position on
// them with a probability per level.
export type QuestionPrimitive = "choice" | "noul" | "score";

export const QUESTION_PRIMITIVES: readonly QuestionPrimitive[] = ["choice", "noul", "score"];

// A Score's levels, as the vendor bounds them: at least two, at most ten
// (https://docs.typesafe.ai/primitives/score.md, the request structure).
export const SCORE_MIN_LEVELS = 2;
export const SCORE_MAX_LEVELS = 10;

// A question as the catalog resolves it: the shipped default, or the active
// override where one is present and valid, with the version label the journal
// records and the refusal reason where an override fell back. The primitive
// decides which field carries the answer vocabulary. A Choice carries
// `options`, the set's superset of option ids with a description per id and
// null where an option needs none; the caller names the ids in force and the
// request carries exactly those, so Jev is never offered a label Haiku was
// not. A Score carries `levels`, its level descriptions in order, and a
// level's number is its position in that array. A Noul carries neither: its
// one condition is the instruction itself.
type QuestionHead = {
  id: string;
  version: string;
  overrideRefused: string | null;
  instructions: string;
};

export type ChoiceQuestion = QuestionHead & { primitive: "choice"; options: Record<string, string | null> };
export type NoulQuestion = QuestionHead & { primitive: "noul" };
export type ScoreQuestion = QuestionHead & { primitive: "score"; levels: readonly string[] };

export type ResolvedQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

// One question the caller asks in a request, naming the set to resolve and
// the primitive it expects back. A resolved question of any other primitive
// is refused as no_question, so a catalog whose override layer answered with
// a different shape never reaches a request. A Choice names the option ids in
// force, which are the only ids the request carries and the only ids an
// answer may score.
export type QuestionAsk =
  | { questionSetId: string; primitive: "choice"; optionIds: readonly string[] }
  | { questionSetId: string; primitive: "noul" }
  | { questionSetId: string; primitive: "score" };

// The catalog's resolver, which hooks/question-catalog.ts exports, already
// bound to whatever host access it needs. It is meant to fall back to the
// shipped default on every refusal; where it rejects or resolves to a shape
// that is not a question, the seam reads that as no_question.
export type QuestionResolver = (questionSetId: string) => Promise<ResolvedQuestion>;

// The closed set of ways a call ends short of an answer.
//   off         any mode other than the exact strings "shadow" and "live"; nothing is read or sent
//   no_key      TYPESAFE_API_KEY absent, unreadable, or shorter than KEY_MIN_CHARS
//               once trimmed; nothing is sent and no state is carried
//   no_question the resolver rejected or returned a shape carrying no options; local,
//               before any request, and so distinct from parse
//   timeout     the timer won the race against the request
//   network     the fetch rejected with no HTTP status, or resolved with no response
//   http_401    missing or invalid key
//   http_422    the request body failed validation
//   http_429    rate limited
//   http_529    TypeSafe overloaded
//   http_other  any status outside 200 to 299 the list above does not name
//   parse       a body that is not JSON, or JSON whose answer for the asked
//               question is missing or fails validation
export type SeamFailureReason =
  | "off"
  | "no_key"
  | "no_question"
  | "timeout"
  | "network"
  | "http_401"
  | "http_422"
  | "http_429"
  | "http_529"
  | "http_other"
  | "parse";

export const SEAM_FAILURE_REASONS: readonly SeamFailureReason[] = [
  "off", "no_key", "no_question", "timeout", "network", "http_401", "http_422", "http_429", "http_529", "http_other", "parse",
];

// The answer shapes the request asks for and the only ones a result carries.
// Each answer's `type` must match its question's primitive, so an answer of
// any other type fails validation.
//
// A Choice answers with the chosen option and a probability per option. A
// Score answers with a position on the levels, which can fall between two of
// them, and a probability per level keyed by level number as a string. Both
// carry a confidence derived from that spread. A Noul carries no confidence
// at all, which the vendor states outright: its distribution has two outcomes
// and the one `noul` value describes it whole
// (https://docs.typesafe.ai/primitives/noul.md, under reading a Noul).
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type NoulAnswer = {
  type: "noul";
  noul: number;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
};

export type JevAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

// One question's answer as a result carries it, with the identity a journal
// line joins on.
export type SeamAnswer = {
  questionSetId: string;
  questionId: string;
  questionVersion: string;
  overrideRefused: string | null;
  primitive: QuestionPrimitive;
  answer: JevAnswer;
};

// The state a request evaluates. A plain string, or an object whose fields a
// question's instructions name in backticks, which is the structured form the
// vendor's API takes (https://docs.typesafe.ai/api.md, the request body's
// `state`). Each field is one text or a list of texts.
export type SeamState = string | Readonly<Record<string, string | readonly string[]>>;

// Token usage as the response carries it; null where the body omitted a
// count or carried one that is not a non-negative integer.
export type JevUsage = { input_tokens: number | null; output_tokens: number | null };

export type SeamOk = {
  ok: true;
  questionSetId: string;
  questionId: string;
  questionVersion: string;
  overrideRefused: string | null;
  primitive: "choice";
  // The validated answer for the question asked, and nothing else the body
  // carried.
  answer: ChoiceAnswer;
  usage: JevUsage;
  latencyMs: number;
  // The model name the body named, cut to MODEL_MAX_CHARS; null where absent.
  model: string | null;
  haikuValue: string | null;
  // The state as it was sent, scrubbed of the key by this module, which holds
  // the only copy of it. The journal reads the state from here rather than
  // taking a field of its own, so the same bytes go to the vendor and to the
  // line. Typed nullable with the failure shape's, which a caller reading the
  // union reads as one field.
  state: string | null;
};

export type SeamFailure = {
  ok: false;
  reason: SeamFailureReason;
  // The status for an http reason, the error message for network and for a
  // rejecting resolver, the field that failed for parse and for a malformed
  // question; null otherwise. Never any part of the key.
  detail: string | null;
  questionSetId: string;
  // Null where the failure came before the question was resolved.
  questionId: string | null;
  questionVersion: string | null;
  overrideRefused: string | null;
  // Null where no request was made.
  latencyMs: number | null;
  haikuValue: string | null;
  // The scrubbed state where the call got past the key check. Null on off and
  // on no_key, where no key was read and so nothing could be scrubbed, which
  // is also what a null here tells a reader: the reason field names which.
  state: string | null;
};

export type SeamResult = SeamOk | SeamFailure;

// The result of one request carrying several questions. One request means one
// call line in the journal and one answer line per validated answer, so the
// fields a call line reads (the reason, the detail, the usage, the latency and
// the state) sit here in the same shape they sit on a single result.
//
// An answer that fails validation fails the whole call as `parse`, the way a
// single request's malformed answer does, and the detail names the question
// that failed. So a call either records every answer it asked for or none:
// journaling two of three would leave a row set a load reads as a question
// that was never asked.
export type SeamSetOk = {
  ok: true;
  questionSetIds: readonly string[];
  answers: readonly SeamAnswer[];
  usage: JevUsage;
  latencyMs: number;
  model: string | null;
  // The state as it was sent, scrubbed of the key by this module. A
  // structured state rides as the JSON text the request body carried, so the
  // bytes the vendor received are the bytes a journal line records.
  state: string;
};

export type SeamSetFailure = {
  ok: false;
  reason: SeamFailureReason;
  detail: string | null;
  questionSetIds: readonly string[];
  latencyMs: number | null;
  state: string | null;
};

export type SeamSetResult = SeamSetOk | SeamSetFailure;

// What the race between the request and the timer settles to. `res` is
// whatever the host's fetch resolved with, read as unknown because a hook
// beneath the caller may have answered the call with anything.
type Settled =
  | { kind: "response"; res: unknown }
  | { kind: "network"; err: unknown }
  | { kind: "timeout" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Converts a value this module did not author into a string, or to the given
// fallback where it cannot be converted. String() raises a TypeError on an
// object with a null prototype and on any object whose toString throws, and
// every value below reaches here from the injected host: a rejection reason,
// a status, and the state a caller passed. Each call on that host is an op
// event a co-loaded hook may answer with a value of its own, so a hostile
// shape here is reachable rather than exotic. The guard is exported-shaped
// (one helper, every site) rather than repeated inline, because it is a
// property of the channel and not of the site that first needed it: three of
// the four sites were written by hand without it and the fourth with it.
function safeString(v: unknown, fallback: string): string {
  try {
    return String(v);
  } catch {
    return fallback;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : safeString(err, "unconvertible rejection value");
}

// Removes every occurrence of the key from text leaving this module: a detail
// field, and the state itself. Both the key as read and its trimmed form are
// removed, since the header carries the trimmed form and a host error may echo
// the value as the environment holds it. The floor above is what makes this a redaction rather than a
// rewrite: a degenerate key never reaches it.
function withoutKey(text: string, key: string): string {
  let out = text;
  for (const form of new Set([key, key.trim()])) {
    if (form.length > 0) out = out.split(form).join("[key]");
  }
  return out;
}

// The same scrub over a structured state, field by field: every text the
// object carries, and every text in a list it carries, leaves with the key
// removed. It runs at the one point holding both the state and the key, as
// the string scrub does, so no later module sees the raw text. The map is
// prototype-free for the reason the criteria map is, and a field that is
// neither a text nor a list of texts is converted through the guarded
// conversion rather than dropped: every call site is typed, and this module's
// contract is that it never rejects.
function withoutKeyInFields(state: unknown, key: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  if (!isRecord(state)) return out;
  // Entries are read from a value a caller built, and reading them runs
  // whatever accessors sit on it.
  let entries: [string, unknown][];
  try {
    entries = Object.entries(state);
  } catch {
    return out;
  }
  for (const [name, value] of entries) {
    out[name] = Array.isArray(value)
      ? value.map((item) => withoutKey(typeof item === "string" ? item : safeString(item, ""), key))
      : withoutKey(typeof value === "string" ? value : safeString(value, ""), key);
  }
  return out;
}

function httpReason(status: unknown): SeamFailureReason {
  switch (status) {
    case 401: return "http_401";
    case 422: return "http_422";
    case 429: return "http_429";
    case 529: return "http_529";
    default: return "http_other";
  }
}

function countOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

// Whether a probability the body carried lies in 0 to 1, the range every
// probability the vendor returns runs over (https://docs.typesafe.ai/api.md).
// One helper for every validator that reads one, because the bound is a
// property of the channel and not of the validator that first needed it: a
// live answer is read by comparing a probability against a threshold, so a
// value past 1 admitted by one validator and refused by another would read
// as a certain answer on the path that admitted it.
function inUnitInterval(p: number): boolean {
  return p >= 0 && p <= 1;
}

// The first way a resolver's value fails to be a ResolvedQuestion of the
// primitive the caller asked for, or null where it is one. The detail names
// the field and never quotes the value. A primitive other than the one asked
// for is refused here: the caller's ask decides which answer shape the
// request names and which validator reads the answer, so a question of
// another shape would be sent under the wrong type.
function questionProblem(v: unknown, expected: QuestionPrimitive): string | null {
  if (!isRecord(v)) return "resolver returned no question";
  if (typeof v.id !== "string" || v.id.length === 0) return "resolved question has no id";
  if (typeof v.version !== "string") return "resolved question has no version";
  if (v.overrideRefused !== null && typeof v.overrideRefused !== "string") return "resolved question overrideRefused is not a string or null";
  if (v.primitive !== expected) return `resolved question is not a ${expected}`;
  if (typeof v.instructions !== "string") return "resolved question has no instructions";
  if (expected === "choice") {
    if (!isRecord(v.options)) return "resolved question has no options";
    for (const description of Object.values(v.options)) {
      if (description !== null && typeof description !== "string") return "resolved question has an option description that is not a string or null";
    }
  }
  if (expected === "score") {
    if (!Array.isArray(v.levels)) return "resolved question has no levels";
    for (const level of v.levels) {
      if (typeof level !== "string" || level.trim().length === 0) return "resolved question has a level that is not a non-empty string";
    }
    if (v.levels.length < SCORE_MIN_LEVELS || v.levels.length > SCORE_MAX_LEVELS) {
      return `resolved question has fewer than ${SCORE_MIN_LEVELS} or more than ${SCORE_MAX_LEVELS} levels`;
    }
  }
  return null;
}

// The validated ChoiceAnswer built from the body's answer for the asked
// question, or the first field that failed. Only the four fields are copied,
// the choice must be one of the ids the request offered, every number must
// be finite, and every probability must lie in 0 to 1 on the same ground the
// Noul's value must. The problem text is fixed per field and never quotes the
// body, since the body is a detail bound for the journal.
function choiceAnswerOf(v: unknown, optionIds: readonly string[]): { answer: ChoiceAnswer } | { problem: string } {
  if (!isRecord(v)) return { problem: "answer is not an object" };
  if (v.type !== "choice") return { problem: "answer type is not choice" };
  if (typeof v.choice !== "string" || !optionIds.includes(v.choice)) return { problem: "answer choice is not an offered option" };
  if (!isRecord(v.probabilities)) return { problem: "answer probabilities is not an object" };
  // Prototype-free for the reason the request's criteria map is. This is the
  // inbound half of the same channel and the less trusted one: a co-loaded
  // hook may answer the fetch with a body of its own, and JSON.parse makes
  // __proto__ an own property that a literal would then discard, dropping a
  // probability from the answer the journal records.
  const probabilities: Record<string, number> = Object.create(null);
  for (const [id, p] of Object.entries(v.probabilities)) {
    // A key outside the ids in force is a malformed body, refused on the same
    // ground the choice is. It also bounds the map: the request carries the
    // caller's ids and nothing else, so a body answering with a hundred
    // thousand keys cannot reach a journal line, where one append rewrites the
    // whole day's file and would carry that cost for every later line.
    if (!optionIds.includes(id)) return { problem: "answer probabilities carry an option that was not offered" };
    if (typeof p !== "number" || !Number.isFinite(p)) return { problem: "answer probabilities carry a value that is not a finite number" };
    if (!inUnitInterval(p)) return { problem: "answer probabilities carry a value that is outside 0 to 1" };
    probabilities[id] = p;
  }
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence)) return { problem: "answer confidence is not a finite number" };
  return { answer: { type: "choice", choice: v.choice, probabilities, confidence: v.confidence } };
}

// The validated NoulAnswer, or the field that failed. One field is copied and
// nothing else the body carried. The range is the vendor's own: a Noul runs
// from 0 for no to 1 for yes (https://docs.typesafe.ai/api.md, the Noul
// answer), so a value outside it is a malformed body on the same ground a
// choice outside the offered ids is. There is no confidence to read.
function noulAnswerOf(v: unknown): { answer: NoulAnswer } | { problem: string } {
  if (!isRecord(v)) return { problem: "answer is not an object" };
  if (v.type !== "noul") return { problem: "answer type is not noul" };
  if (typeof v.noul !== "number" || !Number.isFinite(v.noul)) return { problem: "answer noul is not a finite number" };
  if (!inUnitInterval(v.noul)) return { problem: "answer noul is outside 0 to 1" };
  return { answer: { type: "noul", noul: v.noul } };
}

// The validated ScoreAnswer built from the body's answer, or the first field
// that failed. A level's number is its position in the levels the request
// carried, so the probability map may key only those numbers as strings, and
// the score itself may only sit between the lowest and the highest of them
// (https://docs.typesafe.ai/primitives/score.md, the response structure). The
// legend the body also carries is the request's own level text echoed back
// and is not copied. The map is prototype-free for the reason the choice
// map's is: the body reaches here through JSON.parse.
function scoreAnswerOf(v: unknown, levelCount: number): { answer: ScoreAnswer } | { problem: string } {
  if (!isRecord(v)) return { problem: "answer is not an object" };
  if (v.type !== "score") return { problem: "answer type is not score" };
  if (typeof v.score !== "number" || !Number.isFinite(v.score)) return { problem: "answer score is not a finite number" };
  if (v.score < 0 || v.score > levelCount - 1) return { problem: "answer score is outside the levels that were sent" };
  if (!isRecord(v.probabilities)) return { problem: "answer probabilities is not an object" };
  const levelKeys: string[] = [];
  for (let level = 0; level < levelCount; level += 1) levelKeys.push(String(level));
  const probabilities: Record<string, number> = Object.create(null);
  for (const [level, p] of Object.entries(v.probabilities)) {
    // A key outside the level numbers the request carried bounds this map the
    // way the choice validator's id check bounds its own: one append rewrites
    // the whole day's journal file, so a body answering with a hundred
    // thousand keys cannot reach a line.
    if (!levelKeys.includes(level)) return { problem: "answer probabilities carry a level that was not sent" };
    if (typeof p !== "number" || !Number.isFinite(p)) return { problem: "answer probabilities carry a value that is not a finite number" };
    if (!inUnitInterval(p)) return { problem: "answer probabilities carry a value that is outside 0 to 1" };
    probabilities[level] = p;
  }
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence)) return { problem: "answer confidence is not a finite number" };
  return { answer: { type: "score", score: v.score, probabilities, confidence: v.confidence } };
}

function failure(
  reason: SeamFailureReason,
  detail: string | null,
  questionSetId: string,
  question: ResolvedQuestion | null,
  latencyMs: number | null,
  haikuValue: string | null,
  state: string | null,
): SeamFailure {
  return {
    ok: false,
    reason,
    detail,
    questionSetId,
    questionId: question ? question.id : null,
    questionVersion: question ? question.version : null,
    overrideRefused: question ? question.overrideRefused : null,
    latencyMs,
    haikuValue,
    state,
  };
}

// What the one request path settles to, before either public entry point
// shapes it for its own caller. `questions` is null where the failure came
// before the questions were resolved.
type CoreOk = {
  ok: true;
  answers: readonly SeamAnswer[];
  usage: JevUsage;
  latencyMs: number;
  model: string | null;
  state: string;
};

type CoreFailure = {
  ok: false;
  reason: SeamFailureReason;
  detail: string | null;
  questions: readonly ResolvedQuestion[] | null;
  latencyMs: number | null;
  state: string | null;
};

type CoreResult = CoreOk | CoreFailure;

function coreFailure(
  reason: SeamFailureReason,
  detail: string | null,
  questions: readonly ResolvedQuestion[] | null,
  latencyMs: number | null,
  state: string | null,
): CoreFailure {
  return { ok: false, reason, detail, questions, latencyMs, state };
}

// The one request path, whatever the caller asks and however many questions
// it asks at once. It never rejects: every way the call can end short of an
// answer is one of the closed failure reasons above. Both public entry points
// go through here, so the key read, the state scrub, the resolver guard, the
// timeout race and the answer validation are written once and cover every
// primitive.
//
// The mode check comes first, so anything but "shadow" or "live" reads no
// key, resolves no question and sends nothing; the two that send differ only
// in the timer they race. The key check comes second, so a VM with no
// key, or one holding a value too short to be a bearer token, sends nothing
// either. The state is scrubbed third, immediately after that check, so every
// path past it carries the scrubbed text and no caller can reach the vendor or
// the journal with the raw string. The resolvers run fourth, guarded, so a
// catalog that cannot answer sends nothing. The request is raced against the timer;
// both promises are built so they resolve rather than reject, which is what
// keeps the loser of the race from becoming an unhandled rejection when it
// settles later. Latency is measured here, from just before the fetch to the
// moment the race settles.
async function send(
  host: SeamHost,
  asks: readonly QuestionAsk[],
  state: SeamState,
  mode: string,
  resolve: QuestionResolver,
): Promise<CoreResult> {
  // The exact strings and nothing else: a value that is not one of the two
  // folds to off rather than to a default mode, and never to a throw.
  const timeoutMs = mode === "shadow" ? SHADOW_TIMEOUT_MS : mode === "live" ? LIVE_TIMEOUT_MS : null;
  if (timeoutMs === null) return coreFailure("off", null, null, null, null);

  let key: unknown;
  try {
    key = await host.getApiKey();
  } catch {
    key = undefined;
  }
  if (typeof key !== "string" || key.trim().length < KEY_MIN_CHARS) {
    return coreFailure("no_key", null, null, null, null);
  }

  // The scrub runs here, once, at the last point holding both the text and the
  // key. Everything past this line carries `sent` rather than the caller's own
  // state: the request body, and every result the call can return. So the
  // bytes the vendor receives are the bytes the journal records, and no later
  // module needs a guard it would have to remember to run. A structured state
  // is scrubbed field by field and journaled as the JSON text the body
  // carried, so the same rule holds for it.
  // A string state is typed a string at every call site, but this is the
  // first call that would reach into it, and a throw here would break the
  // never-rejects contract this module states above. The conversion itself is
  // guarded because it can throw: String() raises a TypeError on an object
  // with a null prototype, and on any object whose toString throws. This file
  // builds null-prototype objects deliberately, so the shape is native here.
  const sent = typeof state === "string" ? withoutKey(state, key) : withoutKeyInFields(state, key);
  const sentText = typeof sent === "string" ? sent : JSON.stringify(sent);

  // The resolvers are local and run before any request, so their failure is
  // no_question rather than parse, and nothing has been sent when one fails.
  const questions: ResolvedQuestion[] = [];
  for (const wanted of asks) {
    let resolved: unknown;
    try {
      resolved = await resolve(wanted.questionSetId);
    } catch (err) {
      return coreFailure("no_question", withoutKey(messageOf(err), key), null, null, sentText);
    }
    const problem = questionProblem(resolved, wanted.primitive);
    if (problem !== null) return coreFailure("no_question", problem, null, null, sentText);
    questions.push(resolved as ResolvedQuestion);
  }

  // One entry per question, keyed by the id the vendor answers under. The map
  // is prototype-free for the reason the criteria map below is.
  const sentQuestions: Record<string, unknown> = Object.create(null);
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    const wanted = asks[i];
    if (question.primitive === "choice" && wanted.primitive === "choice") {
      // Exactly the ids in force, each with the catalog's description where the
      // set carries one and null where it does not (the plan switch's pending
      // plan ids are the caller's own and have no catalog entry).
      // Prototype-free for the reason the catalog builds its own maps that way: a
      // literal's __proto__ setter would swallow an option of that id and null the
      // map's prototype for a null description, so what is sent would differ from
      // what was validated. No id in force carries that name today. The guard sits
      // on the channel rather than on the producer that first needed it.
      const criteria: Record<string, string | null> = Object.create(null);
      for (const id of wanted.optionIds) {
        criteria[id] = Object.hasOwn(question.options, id) ? question.options[id] : null;
      }
      sentQuestions[question.id] = { type: "choice", instructions: question.instructions, criteria };
    } else if (question.primitive === "score") {
      // The levels in their order, which is their numbering: a level's number
      // is its position in this array, and the answer's probabilities are
      // keyed by those numbers.
      sentQuestions[question.id] = { type: "score", instructions: question.instructions, criteria: [...question.levels] };
    } else {
      // A Noul's one condition is its instruction, so it carries no criteria.
      sentQuestions[question.id] = { type: "noul", instructions: question.instructions };
    }
  }
  const body = JSON.stringify({
    state: sent,
    model: JEV_MODEL,
    questions: sentQuestions,
  });

  const startedAt = Date.now();
  const request: Promise<Settled> = Promise.resolve()
    .then(() => host.fetch(JEV_ENDPOINT, {
      method: "POST",
      // The trimmed form, because the floor above is measured on it. A value
      // padded by a shell export or a copy-paste would otherwise pass the
      // floor on its trimmed length and go out as a header no server accepts,
      // landing every call as http_401 or network with nothing naming why.
      // withoutKey still removes both forms: this is the form that is sent,
      // and the form as read is the one a host error may echo.
      headers: { "Authorization": `Bearer ${key.trim()}`, "Content-Type": "application/json" },
      body,
    }))
    .then(
      (res: unknown) => ({ kind: "response" as const, res }),
      (err: unknown) => ({ kind: "network" as const, err }),
    );
  // A timer that cannot be started or that rejects reads as having fired:
  // an unbounded request is what the timer exists to refuse.
  //
  // When the request wins, the timer is not cancelled: SeamHost.sleep carries
  // no abort signal, so it runs to its end as an orphan. That is accepted.
  // It is bounded at the mode's timeout and there is at most one per call.
  // The count across a tick and a turn is the count of call sites, each of
  // which makes one call: two on a tick, the controller decision and the plan
  // switch, and three on a turn, the turn score, the memory kind gate and the
  // plan health request. Five, read off those sites rather than derived, so a
  // site added later leaves this number checkable against them. Still
  // bounded, still harmless, and worth stating truthfully.
  // The other orphan is the request: $.http.fetch takes no abort signal
  // either, so when the timer wins, the request it raced stays open for as
  // long as the host's own fetch allows.
  // Its settling is handled here, so it can neither reject nor touch the
  // result.
  const timer: Promise<Settled> = Promise.resolve()
    .then(() => host.sleep(timeoutMs))
    .then(
      () => ({ kind: "timeout" as const }),
      () => ({ kind: "timeout" as const }),
    );
  const settled = await Promise.race([request, timer]);
  const latencyMs = Date.now() - startedAt;

  if (settled.kind === "timeout") return coreFailure("timeout", null, questions, latencyMs, sentText);
  if (settled.kind === "network") {
    return coreFailure("network", withoutKey(messageOf(settled.err), key), questions, latencyMs, sentText);
  }

  // A fetch that resolved with no response object is a fetch that returned
  // nothing usable, which is a network failure rather than a status.
  const res = settled.res;
  if (!isRecord(res)) return coreFailure("network", "no response", questions, latencyMs, sentText);
  // Reading these two members runs whatever accessors the host put on the
  // object, and a lazily-read body is an ordinary shape for a response
  // wrapper. A throwing accessor here would reject out of the request path,
  // and no caller awaits a shadow call, so that reject becomes an unhandled
  // rejection and the call's journal line is never written.
  let status: unknown;
  let text: unknown;
  try {
    ({ status, text } = res as { status: unknown; text: unknown });
  } catch {
    return coreFailure("network", "response members could not be read", questions, latencyMs, sentText);
  }
  // An integer in 200 to 299 and nothing else: NaN is a number that fails
  // both range comparisons, and a fraction or a numeric string is no status.
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 299) {
    // A status that failed the number test is a value this plugin did not
    // author, since a co-loaded hook may answer the fetch. Every other
    // host-supplied detail on this path is scrubbed before it can reach a
    // journal line, and the journal clamps a detail at 512 characters, which
    // is wide enough to hold a whole key. So this one is scrubbed too.
    return coreFailure(httpReason(status), withoutKey(safeString(status, "unconvertible status"), key), questions, latencyMs, sentText);
  }

  if (typeof text !== "string") return coreFailure("parse", "body is not text", questions, latencyMs, sentText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return coreFailure("parse", "body is not JSON", questions, latencyMs, sentText);
  }
  const answers = isRecord(parsed) ? parsed.answers : undefined;
  // One answer per question asked, each validated against the primitive its
  // question was sent as. A question the body did not answer, or an answer
  // that fails validation, fails the whole call: the detail names which
  // question it was.
  const validatedAnswers: SeamAnswer[] = [];
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    const wanted = asks[i];
    if (!isRecord(parsed) || !isRecord(answers) || !isRecord(answers[question.id])) {
      return coreFailure("parse", `no answer for ${question.id}`, questions, latencyMs, sentText);
    }
    const raw = answers[question.id];
    const validated = wanted.primitive === "choice"
      ? choiceAnswerOf(raw, wanted.optionIds)
      : question.primitive === "score"
        ? scoreAnswerOf(raw, question.levels.length)
        : noulAnswerOf(raw);
    if ("problem" in validated) return coreFailure("parse", validated.problem, questions, latencyMs, sentText);
    validatedAnswers.push({
      questionSetId: wanted.questionSetId,
      questionId: question.id,
      questionVersion: question.version,
      overrideRefused: question.overrideRefused,
      primitive: question.primitive,
      answer: validated.answer,
    });
  }
  const usage = isRecord(parsed) && isRecord(parsed.usage) ? parsed.usage : {};
  return {
    ok: true,
    answers: validatedAnswers,
    usage: { input_tokens: countOf(usage.input_tokens), output_tokens: countOf(usage.output_tokens) },
    latencyMs,
    model: isRecord(parsed) && typeof parsed.model === "string" ? parsed.model.slice(0, MODEL_MAX_CHARS) : null,
    state: sentText,
  };
}

// Puts one Choice question set to Jev beside the value Haiku gave for the
// same question, and resolves to a typed result. It never rejects: every way
// the call can end short of an answer is one of the closed failure reasons
// above. The request itself goes through the one path `send` owns, so the key
// scrub, the timeout race and the answer validation are the same ones every
// other primitive takes.
export async function ask(
  host: SeamHost,
  questionSetId: string,
  optionIds: readonly string[],
  state: string,
  mode: string,
  haikuValue: string | null,
  resolve: QuestionResolver,
): Promise<SeamResult> {
  // The conversion a non-string state takes, kept here because this entry
  // point's state is typed a string: the shared path takes either a string or
  // a structured state, and an object handed in through this one is the
  // caller being wrong rather than a structured state.
  const asked: string = typeof state === "string" ? state : safeString(state, "");
  const core = await send(host, [{ questionSetId, primitive: "choice", optionIds }], asked, mode, resolve);
  if (!core.ok) {
    const question = core.questions !== null && core.questions.length > 0 ? core.questions[0] : null;
    return failure(core.reason, core.detail, questionSetId, question, core.latencyMs, haikuValue, core.state);
  }
  const answered = core.answers[0];
  return {
    ok: true,
    questionSetId,
    questionId: answered.questionId,
    questionVersion: answered.questionVersion,
    overrideRefused: answered.overrideRefused,
    primitive: "choice",
    answer: answered.answer as ChoiceAnswer,
    usage: core.usage,
    latencyMs: core.latencyMs,
    model: core.model,
    haikuValue,
    state: core.state,
  };
}

// Puts several question sets to Jev in one request, over one state, and
// resolves to a typed result carrying one validated answer per question. It
// never rejects, for the reason `ask` does not: both go through the one
// request path.
//
// There is no Haiku value here. These questions are measured against
// outcomes the plugin observes later rather than against a classifier answer,
// so nothing on the result claims agreement.
export async function askAll(
  host: SeamHost,
  asks: readonly QuestionAsk[],
  state: SeamState,
  mode: string,
  resolve: QuestionResolver,
): Promise<SeamSetResult> {
  const questionSetIds = asks.map((asked) => asked.questionSetId);
  const core = await send(host, asks, state, mode, resolve);
  if (!core.ok) {
    return {
      ok: false,
      reason: core.reason,
      detail: core.detail,
      questionSetIds,
      latencyMs: core.latencyMs,
      state: core.state,
    };
  }
  return {
    ok: true,
    questionSetIds,
    answers: core.answers,
    usage: core.usage,
    latencyMs: core.latencyMs,
    model: core.model,
    state: core.state,
  };
}
