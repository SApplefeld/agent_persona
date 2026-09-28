#!/usr/bin/env node
// replay.mjs: re-sends a sample's calls to Jev under one catalog version's
// wording, and writes the answers score.mjs reads as that version.
//
// Usage:
//   node .kit/jev-gold/replay.mjs --question <id> --version <label>
//     --state-from <sample.jsonl> [--out <file>]
//
// --out defaults to replay-<version>.jsonl beside --state-from. Each output
// line is one sampled record's replayed answer, or the reason the call
// failed where it did; a failed call carries no answer and score.mjs excludes
// it from every figure.
//
// This section ships the v1 path alone: v1's own catalog wording, read
// through the same resolver and the same seam function the plugin calls.
// Sections 3 to 5 add each question's v2 state assembly and a byte-identity
// pin against the plugin's own summary text; nothing here builds a v2 state.
//
// The request goes out through hooks/decision-seam.ts's `ask` and `askAll`,
// the one path a closed question takes to Jev, so nothing here builds a
// request body by hand. It reads TYPESAFE_API_KEY from the environment and
// never writes, logs or prints any part of it: the seam itself is the only
// module that reads the key, and this file never touches it directly.

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// hooks/question-catalog.ts imports hooks/decision-seam.ts with no extension,
// which only a module a resolve hook covers can load standalone; the same
// hook .kit/tick-harness.mjs registers for the test suite, restated here in
// full so replay.mjs, run as its own process, needs no test harness to start.
const resolveHook = (specifier, context, nextResolve) => {
  if (specifier.startsWith("./") && !path.extname(specifier) && context.parentURL && context.parentURL.includes("hooks")) {
    return nextResolve(specifier + ".ts", context);
  }
  return nextResolve(specifier, context);
};
registerHooks({ resolve: resolveHook });

const { ask, askAll } = await import("../../hooks/decision-seam.ts");
const {
  CONTROLLER_DECISION, CONTROLLER_LABELS, CONTROLLER_LABELS_WITH_SWITCH,
  TURN_SCORE, SCORER_LABELS,
  BLOCK_OWNER, BLOCK_OWNER_OPTIONS, WORKER_BLOCKED, ROUNDS_CONVERGING, WORK_CONTINUES,
  PLAN_HEALTH_STATE_CLOSING, PLAN_HEALTH_STATE_RECENT,
  resolverOf,
} = await import("../../hooks/question-catalog.ts");
const { QUESTIONS, homeDir } = await import("./sample.mjs");

const MODE = "shadow";

// --- The host ---

// A real SeamHost and CatalogHost together, built over Node's own fetch and
// the environment, standing in for the plugin's hostOf($). The key is read
// here and reaches only the seam, which never logs it.
export function buildHost(env = process.env) {
  return {
    getApiKey: async () => env.TYPESAFE_API_KEY,
    getHome: async () => homeDir(env),
    readFile: async (p) => fs.promises.readFile(p, "utf8"),
    fileExists: async (p) => {
      try { await fs.promises.access(p); return true; } catch { return false; }
    },
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      const text = await res.text();
      return { status: res.status, ok: res.ok, headers: res.headers, text };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

// --- Which options v1 offers, per record ---

// hooks/index.ts writes this exact line into the controller's summary only
// where a pending plan exists, so its presence is what the replayed record
// itself carries about whether switch was offered at call time.
const SWITCH_MARK = "switch: switch to a different pending plan:";

export function controllerOptionIds(state) {
  return typeof state === "string" && state.includes(SWITCH_MARK) ? CONTROLLER_LABELS_WITH_SWITCH : CONTROLLER_LABELS;
}

// turn-score's v1 state (User asked / Worker answered / Goal objective) never
// names whether the turn was nudged, which is the one fact hooks/index.ts
// uses to choose SCORER_LABELS_AFTER_NUDGE's narrower three over these four.
// A sampled record carries nothing that recovers it, so replay offers the
// catalog's full set on every turn-score record. This is a v1 baseline
// simplification worth weighing before the figure is trusted for a nudged
// turn specifically: the worker's report here for the record and the report
// this file's own top comment gives are where it is named.
export { SCORER_LABELS as TURN_SCORE_OPTION_IDS };

// --- One record's replay ---

function answerLine(record, version, result) {
  if (!result.ok) return { id: record.id, stampId: record.stampId, version, ok: false, reason: result.reason, detail: result.detail };
  return {
    id: record.id, stampId: record.stampId, version, ok: true,
    value: result.answer.choice, probabilities: result.answer.probabilities, confidence: result.answer.confidence,
  };
}

// Re-sends one sampled record under `version`'s v1 wording. controller-decision
// and turn-score go through `ask`, one Choice question over the record's own
// v1 state string. block-owner goes through `askAll`, the same four plan-
// health questions one turn's closing text asks in production, since that is
// the request the plugin actually sends and block-owner's answer among the
// four is the one this tool keeps; the other three answers are read and
// dropped, unrecorded, since sections 3 to 5 retire the sites that would
// consume them and section 2 never does. A record whose state is not the
// plan-health JSON is a sampler defect, not an answer to score, and throws
// rather than being written as a seam failure it never was.
export async function replayRecord(host, question, version, record) {
  if (question === "controller-decision") {
    const optionIds = controllerOptionIds(record.state);
    const result = await ask(host, CONTROLLER_DECISION, optionIds, record.state, MODE, record.haikuValue, resolverOf(host));
    return answerLine(record, version, result);
  }
  if (question === "turn-score") {
    const result = await ask(host, TURN_SCORE, SCORER_LABELS, record.state, MODE, record.haikuValue, resolverOf(host));
    return answerLine(record, version, result);
  }
  if (question === "block-owner") {
    let parsed;
    try {
      parsed = JSON.parse(record.state);
    } catch {
      throw new Error(`record ${record.id}: state is not the plan-health JSON`);
    }
    const asks = [
      { questionSetId: WORKER_BLOCKED, primitive: "noul" },
      { questionSetId: ROUNDS_CONVERGING, primitive: "score" },
      { questionSetId: BLOCK_OWNER, primitive: "choice", optionIds: BLOCK_OWNER_OPTIONS },
      { questionSetId: WORK_CONTINUES, primitive: "noul" },
    ];
    const state = {
      [PLAN_HEALTH_STATE_CLOSING]: parsed[PLAN_HEALTH_STATE_CLOSING],
      [PLAN_HEALTH_STATE_RECENT]: parsed[PLAN_HEALTH_STATE_RECENT],
    };
    const result = await askAll(host, asks, state, MODE, resolverOf(host));
    if (!result.ok) return { id: record.id, stampId: record.stampId, version, ok: false, reason: result.reason, detail: result.detail };
    const answered = result.answers.find((a) => a.questionSetId === BLOCK_OWNER);
    if (!answered) return { id: record.id, stampId: record.stampId, version, ok: false, reason: "parse", detail: "no block-owner answer in the result" };
    return {
      id: record.id, stampId: record.stampId, version, ok: true,
      value: answered.answer.choice, probabilities: answered.answer.probabilities, confidence: answered.answer.confidence,
    };
  }
  throw new Error(`unknown question: ${question}`);
}

// Replays every record in order, one call at a time: each call is its own
// network request under the shadow timeout, and nothing here needs the
// concurrency label.mjs's batching buys for a CLI child, since a seam call is
// one request rather than a spawned process. `opts.log`, given, is called
// after each record with its zero-based index and the total.
export async function replayAll(host, question, version, records, opts = {}) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    out.push(await replayRecord(host, question, version, records[i]));
    if (opts.log) opts.log(i, records.length);
  }
  return out;
}

// --- Files ---

export function readRecords(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function writeJsonLines(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

// --- The command ---

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`bad argument: ${a}`);
    if (a === "--question") flags.question = v;
    else if (a === "--version") flags.version = v;
    else if (a === "--state-from") flags.stateFrom = v;
    else if (a === "--out") flags.out = v;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!flags.question || !QUESTIONS[flags.question]) throw new Error(`--question must be one of ${Object.keys(QUESTIONS).join(", ")}`);
  if (!flags.version) throw new Error("--version is required");
  if (!flags.stateFrom) throw new Error("--state-from is required");
  return flags;
}

export async function main(argv, env = process.env) {
  const flags = parseArgs(argv);
  const records = readRecords(flags.stateFrom);
  const out = flags.out || path.join(path.dirname(flags.stateFrom), `replay-${flags.version}.jsonl`);
  const host = buildHost(env);
  const rows = await replayAll(host, flags.question, flags.version, records, {
    log: (i, total) => process.stdout.write(`replayed ${i + 1}/${total}\n`),
  });
  writeJsonLines(out, rows);
  const failed = rows.filter((r) => !r.ok).length;
  process.stdout.write(`${rows.length} record(s) replayed, ${failed} failed, written to ${out}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`replay: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 2;
  }
}
