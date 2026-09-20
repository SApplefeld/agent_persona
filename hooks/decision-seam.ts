// decision-seam.ts: the one path a closed question takes to Jev, TypeSafe's
// classifier service. Shadow only: the caller passes Haiku's value in, the
// result carries it back out beside Jev's answer, and no branch anywhere
// reads a Jev answer into a decision.
//
// No `import $` and no side effects at load. The engine's loader follows `$`
// only into functions declared in hooks/index.ts and refuses the whole module
// where `$` is passed across an import, so this file never sees `$`. It takes
// a SeamHost instead: three closures hooks/index.ts builds over `$` in a
// top-level adapter, the same shape as its commonsStoreOf. Covered by
// check-loader-rule.mjs (scans every hooks/*.ts).
//
// The API key is read here and reaches exactly one place: the request's
// Authorization header. No part of its value is journaled, logged, put in a
// result detail or written to a file.

import type { HttpInit, HttpResponse } from "claude-code";

// The live contract, endpoint included: https://docs.typesafe.ai/api.md
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
// $.http.fetch takes no timeout, so every request is raced against this timer.
export const SHADOW_TIMEOUT_MS = 10_000;

// What the seam needs from the host, built in hooks/index.ts over `$`:
//   getApiKey  () => $.env.get("TYPESAFE_API_KEY"), the literal spelled there
//   fetch      (url, init) => $.http.fetch(url, init)
//   sleep      (ms) => $.clock.sleep(ms)
export interface SeamHost {
  getApiKey(): Promise<string | undefined>;
  fetch(url: string, init?: HttpInit): Promise<HttpResponse>;
  sleep(ms: number): Promise<void>;
}

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
// bound to whatever host access it needs. It falls back to the shipped
// default on every refusal, so it resolves rather than rejects.
export type QuestionResolver = (questionSetId: string) => Promise<ResolvedQuestion>;

// The closed set of ways a shadow call ends short of an answer.
//   off        any mode other than the exact string "shadow"; nothing is read or sent
//   no_key     TYPESAFE_API_KEY absent, empty, or unreadable; nothing is sent
//   timeout    the timer won the race against the request
//   network    the fetch rejected with no HTTP status
//   http_401   missing or invalid key
//   http_422   the request body failed validation
//   http_429   rate limited
//   http_529   TypeSafe overloaded
//   http_other any status outside 200 to 299 the list above does not name
//   parse      a body that is not JSON, or JSON missing the answer that was asked for
export type SeamFailureReason =
  | "off"
  | "no_key"
  | "timeout"
  | "network"
  | "http_401"
  | "http_422"
  | "http_429"
  | "http_529"
  | "http_other"
  | "parse";

export const SEAM_FAILURE_REASONS: readonly SeamFailureReason[] = [
  "off", "no_key", "timeout", "network", "http_401", "http_422", "http_429", "http_529", "http_other", "parse",
];

// The three answer shapes the API returns, keyed by the question's `type`.
// Every shipped set is a Choice; the other two are admitted so a later
// question can use them without widening this type.
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type NoulAnswer = { type: "noul"; noul: number };
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type JevAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

// Token usage as the response carries it; null where the body omitted a count.
export type JevUsage = { input_tokens: number | null; output_tokens: number | null };

export type SeamOk = {
  ok: true;
  questionSetId: string;
  questionId: string;
  questionVersion: string;
  overrideRefused: string | null;
  primitive: "choice";
  // Every answer the response carried, under the ids the request used.
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  latencyMs: number;
  model: string | null;
  haikuValue: string | null;
};

export type SeamFailure = {
  ok: false;
  reason: SeamFailureReason;
  // The status for an http reason, the error message for network, the
  // parse reason for parse; null otherwise. Never any part of the key.
  detail: string | null;
  questionSetId: string;
  // Null where the failure came before the question was resolved.
  questionId: string | null;
  questionVersion: string | null;
  overrideRefused: string | null;
  // Null where no request was made.
  latencyMs: number | null;
  haikuValue: string | null;
};

export type SeamResult = SeamOk | SeamFailure;

// What the race between the request and the timer settles to.
type Settled =
  | { kind: "response"; res: HttpResponse }
  | { kind: "network"; err: unknown }
  | { kind: "timeout" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function httpReason(status: number): SeamFailureReason {
  switch (status) {
    case 401: return "http_401";
    case 422: return "http_422";
    case 429: return "http_429";
    case 529: return "http_529";
    default: return "http_other";
  }
}

function countOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function failure(
  reason: SeamFailureReason,
  detail: string | null,
  questionSetId: string,
  question: ResolvedQuestion | null,
  latencyMs: number | null,
  haikuValue: string | null,
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
  };
}

// Puts one question set to Jev and resolves to a typed result. It never
// rejects: every way the call can end short of an answer is one of the
// closed failure reasons above.
//
// The mode check comes first, so anything but "shadow" reads no key, resolves
// no question and sends nothing. The key check comes second, so a VM with no
// key sends nothing either. The request is raced against the timer; both
// promises are built so they resolve rather than reject, which is what keeps
// the loser of the race from becoming an unhandled rejection when it settles
// later. Latency is measured here, from just before the fetch to the moment
// the race settles.
export async function ask(
  host: SeamHost,
  questionSetId: string,
  optionIds: readonly string[],
  state: string,
  mode: string,
  haikuValue: string | null,
  resolve: QuestionResolver,
): Promise<SeamResult> {
  if (mode !== "shadow") return failure("off", null, questionSetId, null, null, haikuValue);

  let key: unknown;
  try {
    key = await host.getApiKey();
  } catch {
    key = undefined;
  }
  if (typeof key !== "string" || key.length === 0) {
    return failure("no_key", null, questionSetId, null, null, haikuValue);
  }

  const question = await resolve(questionSetId);

  // Exactly the ids in force, each with the catalog's description where the
  // set carries one and null where it does not (the plan switch's pending
  // plan ids are the caller's own and have no catalog entry).
  const criteria: Record<string, string | null> = {};
  for (const id of optionIds) {
    criteria[id] = Object.hasOwn(question.options, id) ? question.options[id] : null;
  }
  const body = JSON.stringify({
    state,
    model: JEV_MODEL,
    questions: {
      [question.id]: { type: "choice", instructions: question.instructions, criteria },
    },
  });

  const startedAt = Date.now();
  const request: Promise<Settled> = Promise.resolve()
    .then(() => host.fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body,
    }))
    .then(
      (res: HttpResponse) => ({ kind: "response" as const, res }),
      (err: unknown) => ({ kind: "network" as const, err }),
    );
  // A timer that cannot be started or that rejects reads as having fired:
  // an unbounded request is what the timer exists to refuse.
  const timer: Promise<Settled> = Promise.resolve()
    .then(() => host.sleep(SHADOW_TIMEOUT_MS))
    .then(
      () => ({ kind: "timeout" as const }),
      () => ({ kind: "timeout" as const }),
    );
  const settled = await Promise.race([request, timer]);
  const latencyMs = Date.now() - startedAt;

  if (settled.kind === "timeout") return failure("timeout", null, questionSetId, question, latencyMs, haikuValue);
  if (settled.kind === "network") {
    return failure("network", messageOf(settled.err), questionSetId, question, latencyMs, haikuValue);
  }

  const { status, text } = settled.res;
  if (typeof status !== "number" || status < 200 || status > 299) {
    return failure(httpReason(status), String(status), questionSetId, question, latencyMs, haikuValue);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure("parse", "body is not JSON", questionSetId, question, latencyMs, haikuValue);
  }
  const answers = isRecord(parsed) ? parsed.answers : undefined;
  if (!isRecord(parsed) || !isRecord(answers) || !isRecord(answers[question.id])) {
    return failure("parse", `no answer for ${question.id}`, questionSetId, question, latencyMs, haikuValue);
  }
  const usage = isRecord(parsed.usage) ? parsed.usage : {};
  return {
    ok: true,
    questionSetId,
    questionId: question.id,
    questionVersion: question.version,
    overrideRefused: question.overrideRefused,
    primitive: "choice",
    answers: answers as Record<string, JevAnswer>,
    usage: { input_tokens: countOf(usage.input_tokens), output_tokens: countOf(usage.output_tokens) },
    latencyMs,
    model: typeof parsed.model === "string" ? parsed.model : null,
    haikuValue,
  };
}
