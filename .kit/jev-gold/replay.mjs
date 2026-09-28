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
// Each question replays the one version the catalog ships for it, read
// through the same resolver and the same seam function the plugin calls:
// controller-decision and block-owner at v1, over the record's own v1 state,
// and turn-score at v2, over the state turnScoreStateText in
// hooks/question-catalog.ts builds from the record's transcript fields. The
// plugin's scorer calls that same function, so the two send the same bytes
// for the same turn. controller-decision and turn-score each offer more than
// one option set (switch only where a pending plan exists; the fourth
// turn-score option only off a nudge), and the set a record's own call
// offered is read back off `record.jev.probabilities`'s own keys, which
// decision-seam.ts's answer validator refuses to carry any id outside the
// ones the caller offered.
//
// The request goes out through hooks/decision-seam.ts's `ask` and `askAll`,
// the one path a closed question takes to Jev, so nothing here builds a
// request body by hand. `--version` is refused unless this tool can actually
// assemble that question's wording, and every row is stamped with the
// seam's own returned `questionVersion` rather than the flag: an active
// override changes the wording the seam sends without changing `--version`,
// and a mismatch fails the run rather than mislabelling the row. This file
// reads TYPESAFE_API_KEY from the environment only inside `buildHost`'s
// `getApiKey`, which only the seam calls, and nothing here writes, logs or
// prints it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// sample.mjs is loaded first: it registers the resolve hook that lets
// hooks/question-catalog.ts load its extensionless imports standalone.
const { QUESTIONS, homeDir } = await import("./sample.mjs");
const { ask, askAll } = await import("../../hooks/decision-seam.ts");
const {
  CONTROLLER_DECISION, CONTROLLER_LABELS, CONTROLLER_LABELS_WITH_SWITCH,
  TURN_SCORE, SCORER_LABELS, SCORER_LABELS_AFTER_NUDGE, TURN_SCORE_TOOL_FLAGS, turnScoreStateText,
  BLOCK_OWNER, BLOCK_OWNER_OPTIONS, WORKER_BLOCKED, ROUNDS_CONVERGING, WORK_CONTINUES,
  PLAN_HEALTH_STATE_CLOSING, PLAN_HEALTH_STATE_RECENT,
  resolverOf,
} = await import("../../hooks/question-catalog.ts");

const MODE = "shadow";

// The versions this tool can assemble a request for, per question: the one
// version the catalog ships for each. The catalog holds one wording per
// question, so turn-score's v1 is not replayable while v2 ships; its v1
// figures are Jev's own journaled answers, which score.mjs reads from the
// sample.
export const REPLAYABLE_VERSIONS = Object.freeze({
  "controller-decision": Object.freeze(["v1"]),
  "turn-score": Object.freeze(["v2"]),
  "block-owner": Object.freeze(["v1"]),
});

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

// --- Which options a record's call offered ---

// The known option sets per question, in the order a request should carry
// them. turn-score's v2 offers the same two sets its v1 did. controller-decision
// drops or keeps switch; turn-score drops or keeps off-goal-by-instruction on a
// nudged turn, the choice between SCORER_LABELS_AFTER_NUDGE and SCORER_LABELS
// the scorer in hooks/index.ts's turn.complete handler makes.
const OFFERED_OPTION_SETS = Object.freeze({
  "controller-decision": [CONTROLLER_LABELS, CONTROLLER_LABELS_WITH_SWITCH],
  "turn-score": [SCORER_LABELS_AFTER_NUDGE, SCORER_LABELS],
});

function sameIdSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

// The option ids a sampled record's own call actually offered, recovered
// from its Jev probabilities rather than guessed from the state text:
// decision-seam.ts's choiceAnswerOf refuses any probability key outside the
// ids the caller sent, so the key set the sample
// carries is exactly what was offered. Checked against the known sets for
// the question, since more than one exists; a record whose keys match
// neither is a sampler or journal defect this tool refuses to guess past.
export function offeredOptionIds(question, record) {
  const keys = Object.keys((record.jev && record.jev.probabilities) || {});
  const sets = OFFERED_OPTION_SETS[question];
  const match = sets.find((set) => sameIdSet(set, keys));
  if (!match) {
    throw new Error(`record ${record.id}: its Jev probabilities carry [${keys.slice().sort().join(", ")}], which matches no known option set for ${question}`);
  }
  return match;
}

// --- The turn-score v2 state, from a sampled record ---

// A record's `transcript.toolActivity` line, in the shape .kit/jev-gold/sample.mjs
// writes and hooks/index.ts's turnToolActivityText defines: the seven flags as
// name=yes or name=no in TURN_SCORE_TOOL_FLAGS's order, the work-tool count,
// then the ring as comma-joined tool names. Returns the flags and the tool
// names in the shape turnScoreStateText takes, or null for a line off that
// shape, which the caller refuses rather than guessing past.
const TOOL_ACTIVITY_LINE = new RegExp(`^${TURN_SCORE_TOOL_FLAGS.map((name) => `${name}=(yes|no)`).join(" ")} work_tools=\\d+ tools=([^ ]*)$`);
export function parseToolActivity(line) {
  if (typeof line !== "string") return null;
  const m = TOOL_ACTIVITY_LINE.exec(line);
  if (!m) return null;
  const flags = Object.fromEntries(TURN_SCORE_TOOL_FLAGS.map((name, i) => [name, m[i + 1] === "yes"]));
  const ring = m[TURN_SCORE_TOOL_FLAGS.length + 1];
  return { flags, calls: ring === "" ? [] : ring.split(",") };
}

// The opening text and the goal objective a journaled turn-score state
// carries, read off either shape the scorer has sent. v1 is "User asked: ",
// the answer, "Goal objective: " and a closing question sentence; v2 is
// "Turn opened with: ", the answer, "Goal objective: " and a "Tools: " part.
// The objective is anchored on the first "Goal objective: " part after the
// answer's label, so an objective that itself carries that label is read
// whole. Returns null where the state is in neither shape.
const ANSWER_LABEL = "\n\nWorker answered: ";
const OBJECTIVE_LABEL = "\n\nGoal objective: ";
const V1_OPENING = "User asked: ";
const V1_QUESTION = "\n\nDid the worker's answer advance the goal objective?";
const V2_OPENING = "Turn opened with: ";
const V2_TOOLS_LABEL = "\n\nTools: ";
export function scoreStateParts(state) {
  if (typeof state !== "string") return null;
  const v1 = state.startsWith(V1_OPENING) && state.endsWith(V1_QUESTION);
  const v2 = state.startsWith(V2_OPENING);
  if (!v1 && !v2) return null;
  const answerAt = state.indexOf(ANSWER_LABEL);
  if (answerAt < 0) return null;
  const objectiveAt = state.indexOf(OBJECTIVE_LABEL, answerAt + ANSWER_LABEL.length);
  if (objectiveAt < 0) return null;
  const objectiveFrom = objectiveAt + OBJECTIVE_LABEL.length;
  const objectiveTo = v1 ? state.length - V1_QUESTION.length : state.indexOf(V2_TOOLS_LABEL, objectiveFrom);
  if (objectiveTo < objectiveFrom) return null;
  return {
    shape: v1 ? "v1" : "v2",
    opening: state.slice((v1 ? V1_OPENING : V2_OPENING).length, answerAt),
    objective: state.slice(objectiveFrom, objectiveTo),
  };
}

// The v2 state for one sampled record: the opening text and the final message
// from its transcript turn, the objective from its journaled state, and the
// Tools line from its activity line. The plugin's scorer builds its state
// from the text the turn opened with, which is the transcript turn's opening
// message, so the two meet in turnScoreStateText. A record missing any of the
// four throws, naming the record and the part, since that is a sampler
// defect; an empty final message throws too, since the plugin scores no turn
// without an answer.
//
// The opening text is checked only where the journal holds the plugin's own
// reading of it, which is a record journaled under v2: there the state is
// built and refused as { ok: false, reason: "prompt_mismatch" } where its
// opening part is not the journaled one, since it would not be the plugin's
// bytes. A v1 state's "User asked:" text is the last prompt the plugin saw
// submitted, which a message queued mid-turn replaces, so it can differ from
// the opening message on a turn scored correctly and proves nothing either
// way; a v1-journaled record is not checked. Otherwise returns { ok: true,
// state }. A refused record is written as a failure and excluded from every
// figure.
export const PROMPT_MISMATCH = "prompt_mismatch";
export function turnScoreV2State(record) {
  const refuse = (part) => new Error(`record ${record.id}: ${part}, so its turn-score v2 state cannot be built`);
  const t = record.transcript;
  if (!t || typeof t !== "object") throw refuse("it carries no transcript");
  if (typeof t.prompt !== "string") throw refuse("its transcript carries no prompt");
  if (typeof t.finalMessage !== "string" || t.finalMessage.length === 0) throw refuse("its transcript carries no final message");
  const tools = parseToolActivity(t.toolActivity);
  if (tools === null) throw refuse("its transcript's toolActivity is not a turn_tool_activity line");
  const parts = scoreStateParts(record.state);
  if (parts === null) throw refuse("its journaled state carries no goal objective");
  const state = turnScoreStateText(t.prompt, t.finalMessage, parts.objective, tools);
  if (parts.shape === "v2" && scoreStateParts(state)?.opening !== parts.opening) {
    return { ok: false, reason: PROMPT_MISMATCH, detail: "the transcript's opening message is not the text the plugin scored" };
  }
  return { ok: true, state };
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

// Re-sends one sampled record under `version`'s wording. controller-decision
// goes through `ask`, one Choice question over the record's own v1 state
// string and the option ids its own call offered, and turn-score the same way
// over the v2 state turnScoreV2State builds from the record. block-owner goes
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
    const built = turnScoreV2State(record);
    if (!built.ok) return { id: record.id, stampId: record.stampId, version, ok: false, reason: built.reason, detail: built.detail };
    const result = await ask(host, TURN_SCORE, optionIds, built.state, MODE, record.haikuValue, resolverOf(host));
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
  const replayable = REPLAYABLE_VERSIONS[flags.question];
  if (!replayable.includes(flags.version)) {
    throw new Error(`--version for ${flags.question} must be one of ${replayable.join(", ")}; this tool assembles no other wording for it`);
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
  const mismatched = rows.filter((r) => r.reason === PROMPT_MISMATCH).length;
  process.stdout.write(`${rows.length} record(s) replayed, ${failed} failed (${mismatched} refused as ${PROMPT_MISMATCH}), written to ${out}\n`);
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
