#!/usr/bin/env node
// replay.mjs: re-sends a sample's calls to Jev under one catalog version's
// wording, and writes the answers score.mjs reads as that version.
//
// Usage:
//   node .kit/jev-gold/replay.mjs --question <id> --version <label>
//     --state-from <sample.jsonl> [--out <file>]
//
// --out defaults to replay-<version>.jsonl beside --state-from and refuses to
// overwrite an existing file unless --force is given. Each output line is
// appended as its record's call returns, one sampled record's replayed
// answer, or the reason the call failed where it did; a failed call carries
// no answer and score.mjs excludes it from every figure.
//
// This section ships the v1 path alone: v1's own catalog wording, read
// through the same resolver and the same seam function the plugin calls.
// controller-decision and turn-score each offer more than one v1 option set
// (switch only where a pending plan exists; the fourth turn-score option only
// off a nudge), and the set a record's own call offered is read back off
// `record.jev.probabilities`'s own keys, which decision-seam.ts's answer
// validator refuses to carry any id outside the ones the caller offered.
// Sections 3 to 5 add each question's v2 state assembly and a byte-identity
// pin against the plugin's own summary text; nothing here builds a v2 state.
//
// The request goes out through hooks/decision-seam.ts's `ask` and `askAll`,
// the one path a closed question takes to Jev, so nothing here builds a
// request body by hand. `--version` is refused unless this tool can actually
// assemble that wording (v1 alone, today), and every row is stamped with the
// seam's own returned `questionVersion` rather than the flag: an active
// override changes the wording the seam sends without changing `--version`,
// and a mismatch fails the run rather than mislabelling the row. This file
// reads TYPESAFE_API_KEY from the environment only inside `buildHost`'s
// `getApiKey`, which only the seam calls, and nothing here writes, logs or
// prints it.

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
  TURN_SCORE, SCORER_LABELS, SCORER_LABELS_AFTER_NUDGE,
  BLOCK_OWNER, BLOCK_OWNER_OPTIONS, WORKER_BLOCKED, ROUNDS_CONVERGING, WORK_CONTINUES,
  PLAN_HEALTH_STATE_CLOSING, PLAN_HEALTH_STATE_RECENT,
  resolverOf,
} = await import("../../hooks/question-catalog.ts");
const { QUESTIONS, homeDir } = await import("./sample.mjs");

const MODE = "shadow";

// The versions this tool can actually assemble a v1 request for. Only v1
// today; sections 3 to 5 each add their question's v2 assembly and extend
// this list alongside it.
export const REPLAYABLE_VERSIONS = Object.freeze(["v1"]);

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

// The known v1 option sets per question, in the order a request should carry
// them. controller-decision drops or keeps switch; turn-score drops or keeps
// off-goal-by-instruction on a nudged turn (hooks/index.ts:9613, 9623-9625).
const OFFERED_OPTION_SETS = Object.freeze({
  "controller-decision": [CONTROLLER_LABELS, CONTROLLER_LABELS_WITH_SWITCH],
  "turn-score": [SCORER_LABELS_AFTER_NUDGE, SCORER_LABELS],
});

function sameIdSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

// The option ids a sampled record's own v1 call actually offered, recovered
// from its Jev probabilities rather than guessed from the state text:
// decision-seam.ts's choiceAnswerOf refuses any probability key outside the
// ids the caller sent (decision-seam.ts:437), so the key set the sample
// carries is exactly what was offered. Checked against the known v1 sets for
// the question, since more than one exists; a record whose keys match
// neither is a sampler or journal defect this tool refuses to guess past.
export function offeredOptionIds(question, record) {
  const keys = Object.keys((record.jev && record.jev.probabilities) || {});
  const sets = OFFERED_OPTION_SETS[question];
  const match = sets.find((set) => sameIdSet(set, keys));
  if (!match) {
    throw new Error(`record ${record.id}: its Jev probabilities carry [${keys.slice().sort().join(", ")}], which matches no known v1 option set for ${question}`);
  }
  return match;
}

// --- One record's replay ---

// A row's `version` is the seam's own returned `questionVersion`, never the
// `--version` flag blindly: an active override under
// `~/.claude/agentic-questions/<id>/` changes the wording a call sends
// without changing what the operator typed, so trusting the flag would
// mislabel the row's own wording. `actualVersion` is null where the call
// failed before a question resolved (`off`, `no_key`, `no_question`), which
// carries nothing to check.
function checkVersion(record, requestedVersion, actualVersion) {
  if (typeof actualVersion === "string" && actualVersion !== requestedVersion) {
    throw new Error(`record ${record.id}: the seam answered under version "${actualVersion}", not the requested "${requestedVersion}" (an active override may be in force)`);
  }
}

function answerLine(record, requestedVersion, result) {
  checkVersion(record, requestedVersion, result.questionVersion);
  const version = result.questionVersion ?? requestedVersion;
  if (!result.ok) return { id: record.id, stampId: record.stampId, version, ok: false, reason: result.reason, detail: result.detail };
  return {
    id: record.id, stampId: record.stampId, version, ok: true,
    value: result.answer.choice, probabilities: result.answer.probabilities, confidence: result.answer.confidence,
  };
}

// Re-sends one sampled record under `version`'s v1 wording. controller-decision
// and turn-score go through `ask`, one Choice question over the record's own
// v1 state string and the option ids its own call offered. block-owner goes
// through `askAll`, the same four plan-health questions one turn's closing
// text asks in production, since that is the request the plugin actually
// sends and block-owner's answer among the four is the one this tool keeps;
// the other three answers are read and dropped, unrecorded, since sections 3
// to 5 retire the sites that would consume them and section 2 never does. A
// record whose state is not the plan-health JSON is a sampler defect, not an
// answer to score, and throws rather than being written as a seam failure it
// never was.
export async function replayRecord(host, question, version, record) {
  if (question === "controller-decision") {
    const optionIds = offeredOptionIds(question, record);
    const result = await ask(host, CONTROLLER_DECISION, optionIds, record.state, MODE, record.haikuValue, resolverOf(host));
    return answerLine(record, version, result);
  }
  if (question === "turn-score") {
    const optionIds = offeredOptionIds(question, record);
    const result = await ask(host, TURN_SCORE, optionIds, record.state, MODE, record.haikuValue, resolverOf(host));
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
    checkVersion(record, version, answered.questionVersion);
    return {
      id: record.id, stampId: record.stampId, version: answered.questionVersion, ok: true,
      value: answered.answer.choice, probabilities: answered.answer.probabilities, confidence: answered.answer.confidence,
    };
  }
  throw new Error(`unknown question: ${question}`);
}

// Replays every record in order, one call at a time: each call is its own
// network request under the shadow timeout, and nothing here needs the
// concurrency label.mjs's batching buys for a CLI child, since a seam call is
// one request rather than a spawned process. `opts.onRow`, given, is called
// with each row as it completes, before the next record starts, so a caller
// can append it to disk and lose nothing already paid for if a later record
// throws. `opts.log`, given, is called after each record with its zero-based
// index and the total.
export async function replayAll(host, question, version, records, opts = {}) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const row = await replayRecord(host, question, version, records[i]);
    out.push(row);
    if (opts.onRow) opts.onRow(row);
    if (opts.log) opts.log(i, records.length);
  }
  return out;
}

// --- Files ---

export function readRecords(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// --- The command ---

function parseArgs(argv) {
  const flags = { force: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--force") { flags.force = true; i += 1; continue; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`bad argument: ${a}`);
    if (a === "--question") flags.question = v;
    else if (a === "--version") flags.version = v;
    else if (a === "--state-from") flags.stateFrom = v;
    else if (a === "--out") flags.out = v;
    else throw new Error(`unknown flag: ${a}`);
    i += 2;
  }
  if (!flags.question || !QUESTIONS[flags.question]) throw new Error(`--question must be one of ${Object.keys(QUESTIONS).join(", ")}`);
  if (!flags.version) throw new Error("--version is required");
  if (!REPLAYABLE_VERSIONS.includes(flags.version)) {
    throw new Error(`--version must be one of ${REPLAYABLE_VERSIONS.join(", ")}; this section assembles no other wording`);
  }
  if (!flags.stateFrom) throw new Error("--state-from is required");
  return flags;
}

export async function main(argv, env = process.env) {
  const flags = parseArgs(argv);
  const records = readRecords(flags.stateFrom);
  const out = flags.out || path.join(path.dirname(flags.stateFrom), `replay-${flags.version}.jsonl`);
  if (!flags.force && fs.existsSync(out)) {
    throw new Error(`${out} already exists; pass --force to overwrite it`);
  }
  fs.writeFileSync(out, "");
  const host = buildHost(env);
  const rows = await replayAll(host, flags.question, flags.version, records, {
    onRow: (row) => fs.appendFileSync(out, JSON.stringify(row) + "\n"),
    log: (i, total) => process.stdout.write(`replayed ${i + 1}/${total}\n`),
  });
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
