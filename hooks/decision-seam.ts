// decision-seam.ts: the one path a closed question takes to Jev, TypeSafe's
// classifier service. Shadow only: the caller passes Haiku's value in, the
// result carries it back out beside Jev's answer, and no branch anywhere
// reads a Jev answer into a decision.
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
// $.http.fetch takes no timeout, so every request is raced against this timer.
export const SHADOW_TIMEOUT_MS = 10_000;
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

// A question as the catalog resolves it: the shipped default, or the active
// override where one is present and valid, with the version label the journal
// records and the refusal reason where an override fell back. `options` is
// the set's superset of option ids with a description per id, null where an
// option needs none. The caller names the ids in force and the request
// carries exactly those, so Jev is never offered a label Haiku was not.
export type ResolvedQuestion = {
  id: string;
  version: string;
  overrideRefused: string | null;
  primitive: "choice";
  instructions: string;
  options: Record<string, string | null>;
};

// The catalog's resolver, which hooks/question-catalog.ts exports, already
// bound to whatever host access it needs. It is meant to fall back to the
// shipped default on every refusal; where it rejects or resolves to a shape
// that is not a question, the seam reads that as no_question.
export type QuestionResolver = (questionSetId: string) => Promise<ResolvedQuestion>;

// The closed set of ways a shadow call ends short of an answer.
//   off         any mode other than the exact string "shadow"; nothing is read or sent
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

// The answer shape the request asks for and the only one the result carries.
// Every shipped set is a Choice, and the request names `type: "choice"`, so
// an answer of any other type fails validation.
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

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

// The first way a resolver's value fails to be a ResolvedQuestion, or null
// where it is one. The detail names the field and never quotes the value.
function questionProblem(v: unknown): string | null {
  if (!isRecord(v)) return "resolver returned no question";
  if (typeof v.id !== "string" || v.id.length === 0) return "resolved question has no id";
  if (typeof v.version !== "string") return "resolved question has no version";
  if (v.overrideRefused !== null && typeof v.overrideRefused !== "string") return "resolved question overrideRefused is not a string or null";
  if (v.primitive !== "choice") return "resolved question is not a choice";
  if (typeof v.instructions !== "string") return "resolved question has no instructions";
  if (!isRecord(v.options)) return "resolved question has no options";
  for (const description of Object.values(v.options)) {
    if (description !== null && typeof description !== "string") return "resolved question has an option description that is not a string or null";
  }
  return null;
}

// The validated ChoiceAnswer built from the body's answer for the asked
// question, or the first field that failed. Only the four fields are copied,
// the choice must be one of the ids the request offered, and every number
// must be finite. The problem text is fixed per field and never quotes the
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
    probabilities[id] = p;
  }
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence)) return { problem: "answer confidence is not a finite number" };
  return { answer: { type: "choice", choice: v.choice, probabilities, confidence: v.confidence } };
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

// Puts one question set to Jev and resolves to a typed result. It never
// rejects: every way the call can end short of an answer is one of the
// closed failure reasons above.
//
// The mode check comes first, so anything but "shadow" reads no key, resolves
// no question and sends nothing. The key check comes second, so a VM with no
// key, or one holding a value too short to be a bearer token, sends nothing
// either. The state is scrubbed third, immediately after that check, so every
// path past it carries the scrubbed text and no caller can reach the vendor or
// the journal with the raw string. The resolver runs fourth, guarded, so a
// catalog that cannot answer sends nothing. The request is raced against the timer;
// both promises are built so they resolve rather than reject, which is what
// keeps the loser of the race from becoming an unhandled rejection when it
// settles later. Latency is measured here, from just before the fetch to the
// moment the race settles.
export async function ask(
  host: SeamHost,
  questionSetId: string,
  optionIds: readonly string[],
  state: string,
  mode: string,
  haikuValue: string | null,
  resolve: QuestionResolver,
): Promise<SeamResult> {
  if (mode !== "shadow") return failure("off", null, questionSetId, null, null, haikuValue, null);

  let key: unknown;
  try {
    key = await host.getApiKey();
  } catch {
    key = undefined;
  }
  if (typeof key !== "string" || key.trim().length < KEY_MIN_CHARS) {
    return failure("no_key", null, questionSetId, null, null, haikuValue, null);
  }

  // The scrub runs here, once, at the last point holding both the text and the
  // key. Everything past this line carries `sent` rather than the caller's own
  // string: the request body, and every result the call can return. So the
  // bytes the vendor receives are the bytes the journal records, and no later
  // module needs a guard it would have to remember to run.
  // `state` is typed a string and every call site is typed, but this is the
  // first call that would reach into it, and a throw here would break the
  // never-rejects contract this module states above. The conversion itself is
  // guarded because it can throw: String() raises a TypeError on an object
  // with a null prototype, and on any object whose toString throws. This file
  // builds null-prototype objects deliberately, so the shape is native here.
  const raw = typeof state === "string" ? state : safeString(state, "");
  const sent = withoutKey(raw, key);

  // The resolver is local and runs before any request, so its failure is
  // no_question rather than parse, and nothing has been sent when it fails.
  let resolved: unknown;
  try {
    resolved = await resolve(questionSetId);
  } catch (err) {
    return failure("no_question", withoutKey(messageOf(err), key), questionSetId, null, null, haikuValue, sent);
  }
  const problem = questionProblem(resolved);
  if (problem !== null) return failure("no_question", problem, questionSetId, null, null, haikuValue, sent);
  const question = resolved as ResolvedQuestion;

  // Exactly the ids in force, each with the catalog's description where the
  // set carries one and null where it does not (the plan switch's pending
  // plan ids are the caller's own and have no catalog entry).
  // Prototype-free for the reason the catalog builds its own maps that way: a
  // literal's __proto__ setter would swallow an option of that id and null the
  // map's prototype for a null description, so what is sent would differ from
  // what was validated. No id in force carries that name today. The guard sits
  // on the channel rather than on the producer that first needed it.
  const criteria: Record<string, string | null> = Object.create(null);
  for (const id of optionIds) {
    criteria[id] = Object.hasOwn(question.options, id) ? question.options[id] : null;
  }
  const body = JSON.stringify({
    state: sent,
    model: JEV_MODEL,
    questions: {
      [question.id]: { type: "choice", instructions: question.instructions, criteria },
    },
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
  // It is bounded at SHADOW_TIMEOUT_MS and there is at most one per call.
  // The per-tick bound this sentence used to give is no longer the real one:
  // the wiring puts two shadow calls on a tick, the controller decision and
  // the plan switch, and two more on a scored turn, the turn score and the
  // memory kind gate, so up to four orphans can be live across a tick and a
  // turn. Still bounded, still harmless, and worth stating truthfully.
  // Its settling is handled here, so it can neither reject nor touch the
  // result.
  const timer: Promise<Settled> = Promise.resolve()
    .then(() => host.sleep(SHADOW_TIMEOUT_MS))
    .then(
      () => ({ kind: "timeout" as const }),
      () => ({ kind: "timeout" as const }),
    );
  const settled = await Promise.race([request, timer]);
  const latencyMs = Date.now() - startedAt;

  if (settled.kind === "timeout") return failure("timeout", null, questionSetId, question, latencyMs, haikuValue, sent);
  if (settled.kind === "network") {
    return failure("network", withoutKey(messageOf(settled.err), key), questionSetId, question, latencyMs, haikuValue, sent);
  }

  // A fetch that resolved with no response object is a fetch that returned
  // nothing usable, which is a network failure rather than a status.
  const res = settled.res;
  if (!isRecord(res)) return failure("network", "no response", questionSetId, question, latencyMs, haikuValue, sent);
  // Reading these two members runs whatever accessors the host put on the
  // object, and a lazily-read body is an ordinary shape for a response
  // wrapper. A throwing accessor here would reject out of ask, and Section 5
  // does not await the ask, so that reject becomes an unhandled rejection and
  // the call's journal line is never written.
  let status: unknown;
  let text: unknown;
  try {
    ({ status, text } = res as { status: unknown; text: unknown });
  } catch {
    return failure("network", "response members could not be read", questionSetId, question, latencyMs, haikuValue, sent);
  }
  // An integer in 200 to 299 and nothing else: NaN is a number that fails
  // both range comparisons, and a fraction or a numeric string is no status.
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 299) {
    // A status that failed the number test is a value this plugin did not
    // author, since a co-loaded hook may answer the fetch. Every other
    // host-supplied detail on this path is scrubbed before it can reach a
    // journal line, and the journal clamps a detail at 512 characters, which
    // is wide enough to hold a whole key. So this one is scrubbed too.
    return failure(httpReason(status), withoutKey(safeString(status, "unconvertible status"), key), questionSetId, question, latencyMs, haikuValue, sent);
  }

  if (typeof text !== "string") return failure("parse", "body is not text", questionSetId, question, latencyMs, haikuValue, sent);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure("parse", "body is not JSON", questionSetId, question, latencyMs, haikuValue, sent);
  }
  const answers = isRecord(parsed) ? parsed.answers : undefined;
  if (!isRecord(parsed) || !isRecord(answers) || !isRecord(answers[question.id])) {
    return failure("parse", `no answer for ${question.id}`, questionSetId, question, latencyMs, haikuValue, sent);
  }
  const validated = choiceAnswerOf(answers[question.id], optionIds);
  if ("problem" in validated) return failure("parse", validated.problem, questionSetId, question, latencyMs, haikuValue, sent);
  const usage = isRecord(parsed.usage) ? parsed.usage : {};
  return {
    ok: true,
    questionSetId,
    questionId: question.id,
    questionVersion: question.version,
    overrideRefused: question.overrideRefused,
    primitive: "choice",
    answer: validated.answer,
    usage: { input_tokens: countOf(usage.input_tokens), output_tokens: countOf(usage.output_tokens) },
    latencyMs,
    model: typeof parsed.model === "string" ? parsed.model.slice(0, MODEL_MAX_CHARS) : null,
    haikuValue,
    state: sent,
  };
}
