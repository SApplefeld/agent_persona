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
// block-owner at v1, over the record's own v1 state; turn-score at v2, over
// the state turnScoreStateText in hooks/question-catalog.ts builds from the
// record's transcript fields; and controller-decision at v2, over the state
// controllerStateText in the same file builds from the record's journaled
// facts and its transcript's final message. The plugin's scorer and its
// controller tick call those same functions, so each pair builds one state
// from the same inputs. Whether a transcript's fields are the plugin's inputs
// is checked twice: sample.mjs admits a record only where its journaled
// answer opens the transcript turn's final message, whitespace set aside,
// and where the journal holds the plugin's own v2 state a v2 replay must
// equal it byte for byte (turnScoreV2State, controllerV2State). A
// v1-journaled record carries no opening text or Tools part the plugin built,
// and no last answer, so those parts go unchecked there. The controller's v1
// state named its pending plans by title alone, each title cut to 30
// characters, so a v1 record's rebuilt Pending plans line differs from the
// plugin's in two ways, no ids and the cut titles; that one line's
// difference is stated at controllerV2State rather than hidden. A v1
// controller record's transcript turn is joined by time alone (sample.mjs
// admits the latest turn ended before the call), while the plugin moves its
// last answer only at the persona's own completed, unskipped turn end and
// reads it only where the tick's node is the entry that turn started on. So
// a transcript turn that was aborted or errored with partial text, ended
// under another process, or worked an entry the tick's node is not, replays
// over a last answer the plugin's line did not carry. Where the record shows
// it, a goal_done call in the turn or a nudge opening line naming another
// objective, the record is refused as answer_on_other_goal; where it does
// not, the limit stands and the count of such records cannot be read.
// controller-decision and turn-score each offer more than one option
// set (switch only where a pending plan exists; the fourth turn-score option
// only off a nudge), and the set a record's own call offered is read back
// off `record.jev.probabilities`'s own keys, which decision-seam.ts's answer
// validator refuses to carry any id outside the ones the caller offered; a
// controller record journaled under v1 offered pause, and replays under the
// v2 set that keeps its switch.
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
const { QUESTIONS, homeDir, scoreStateParts, PROMPT_MAX, FINAL_MAX } = await import("./sample.mjs");
const { foldedValue } = await import("./score.mjs");
const { ask, askAll } = await import("../../hooks/decision-seam.ts");
const {
  CONTROLLER_DECISION, CONTROLLER_LABELS, CONTROLLER_LABELS_WITH_SWITCH,
  controllerStateText, CONTROLLER_LAST_ANSWER_MAX, CONTROLLER_LAST_ANSWER_LABEL, CONTROLLER_PENDING_PLANS_LABEL, CONTROLLER_OPTIONS_LEAD, CONTROLLER_NO_ANSWER, SHIPPED_QUESTIONS, kaizenLine,
  TURN_SCORE, SCORER_LABELS, SCORER_LABELS_AFTER_NUDGE, TURN_SCORE_TOOL_FLAGS, turnScoreStateText, TURN_SCORE_PROMPT_MAX, TURN_SCORE_ANSWER_MAX,
  BLOCK_OWNER, BLOCK_OWNER_OPTIONS, WORKER_BLOCKED, ROUNDS_CONVERGING, WORK_CONTINUES,
  PLAN_HEALTH_STATE_CLOSING, PLAN_HEALTH_STATE_RECENT,
  resolverOf,
} = await import("../../hooks/question-catalog.ts");

const MODE = "shadow";

// The versions this tool can assemble a request for, per question: the one
// version the catalog ships for each. The catalog holds one wording per
// question, so a question's v1 is not replayable while its v2 ships; the v1
// figures are Jev's own journaled answers, which score.mjs reads from the
// sample.
export const REPLAYABLE_VERSIONS = Object.freeze({
  "controller-decision": Object.freeze(["v2"]),
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

// The controller's v1 option sets, which the journal holds and the catalog no
// longer does: the four ids with pause, and the same with switch. The v2 set
// drops pause, which selected the same nudge ask-operator selects, and keeps
// switch on the same condition, so a record that offered one of these
// replays under the v2 set with the same switch.
const CONTROLLER_V1_LABELS = Object.freeze(["nudge", "pause", "complete", "ask-operator"]);
const CONTROLLER_V1_LABELS_WITH_SWITCH = Object.freeze([...CONTROLLER_V1_LABELS, "switch"]);

// The known option sets per question: each set a record's own call may have
// offered, and the set the replay offers for it, in the order a request
// should carry them. controller-decision drops or keeps switch; turn-score
// drops or keeps off-goal-by-instruction on a nudged turn, the choice
// between SCORER_LABELS_AFTER_NUDGE and SCORER_LABELS the scorer in
// hooks/index.ts's turn.complete handler makes, and its v2 offers the same
// two sets its v1 did.
const OFFERED_OPTION_SETS = Object.freeze({
  "controller-decision": [
    { journaled: CONTROLLER_V1_LABELS, offered: CONTROLLER_LABELS },
    { journaled: CONTROLLER_V1_LABELS_WITH_SWITCH, offered: CONTROLLER_LABELS_WITH_SWITCH },
    { journaled: CONTROLLER_LABELS, offered: CONTROLLER_LABELS },
    { journaled: CONTROLLER_LABELS_WITH_SWITCH, offered: CONTROLLER_LABELS_WITH_SWITCH },
  ],
  "turn-score": [
    { journaled: SCORER_LABELS_AFTER_NUDGE, offered: SCORER_LABELS_AFTER_NUDGE },
    { journaled: SCORER_LABELS, offered: SCORER_LABELS },
  ],
});

function sameIdSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

// The option ids the replay offers for a sampled record: the set its own
// call offered, recovered from its Jev probabilities rather than guessed
// from the state text, mapped onto the shipped set that keeps its switch.
// decision-seam.ts's choiceAnswerOf refuses any probability key outside the
// ids the caller sent, so the key set the sample carries is exactly what was
// offered. Checked against the known sets for the question, since more than
// one exists; a record whose keys match none is a sampler or journal defect
// this tool refuses to guess past.
export function offeredOptionIds(question, record) {
  const keys = Object.keys((record.jev && record.jev.probabilities) || {});
  const sets = OFFERED_OPTION_SETS[question];
  const match = sets.find((set) => sameIdSet(set.journaled, keys));
  if (!match) {
    throw new Error(`record ${record.id}: its Jev probabilities carry [${keys.slice().sort().join(", ")}], which matches no known option set for ${question}`);
  }
  return match.offered;
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

// The parts of a journaled turn-score state are read by sample.mjs's
// scoreStateParts, the one reading the sampler's answer match also takes.
export { scoreStateParts };

// The v2 state for one sampled record: the opening text and the final message
// from its transcript turn, the objective from its journaled state, and the
// Tools line from its activity line. The plugin's scorer builds its state
// from the text the turn opened with, which is the transcript turn's opening
// message, so the two meet in turnScoreStateText. A record missing any of the
// four throws, naming the record and the part, since that is a sampler
// defect; an empty final message throws too, since the plugin scores no turn
// without an answer. Otherwise it returns { ok: true, state }, or
// { ok: false, reason } for a record whose state could not be the plugin's
// bytes, which the caller writes as a failure and every figure excludes:
//
// - cut_short: the sampler cut the opening prompt at PROMPT_MAX or the final
//   message at FINAL_MAX raw characters, and the state's part for it came out
//   under the plugin's bound once collapsed. The plugin collapses the whole
//   text before its cut, so its part would have run on to the bound, and the
//   replay's is shorter than what the plugin sent.
// - prompt_mismatch, tools_mismatch and state_mismatch: checked only where the
//   journal holds the plugin's own state, which is a record journaled under
//   v2. There the built state must equal the journaled state byte for byte.
//   A differing opening part is refused as prompt_mismatch, a differing Tools
//   part as tools_mismatch, and any other difference, which is the answer
//   part since the objective is read off the journaled state, as
//   state_mismatch. The equality is the check; the two part names only say
//   where it failed. A transcript final message whose text blocks the
//   transcript reader joins with a line break where the plugin's answer
//   joined them with none is one such answer difference.
// - A v1-journaled record is not compared. Its "User asked:" text is the
//   last prompt the plugin saw submitted, which a message queued mid-turn
//   replaces, so it can differ from the opening message on a turn scored
//   correctly and proves nothing either way; its answer is a raw 1,000
//   character slice; and it carries no Tools part. So a v1-journaled record's
//   opening text, answer and Tools line, rebuilt from the transcript, are not
//   checked against the plugin's inputs, beyond the sampler's own answer
//   match at admission.
export const PROMPT_MISMATCH = "prompt_mismatch";
export const TOOLS_MISMATCH = "tools_mismatch";
export const STATE_MISMATCH = "state_mismatch";
export const CUT_SHORT = "cut_short";
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
  const built = scoreStateParts(state);
  if ((t.prompt.length >= PROMPT_MAX && built.opening.length < TURN_SCORE_PROMPT_MAX)
    || (t.finalMessage.length >= FINAL_MAX && built.answer.length < TURN_SCORE_ANSWER_MAX)) {
    return { ok: false, reason: CUT_SHORT, detail: "the sampler's raw cut left a part shorter than the plugin's bound" };
  }
  if (parts.shape === "v2" && built.opening !== parts.opening) {
    return { ok: false, reason: PROMPT_MISMATCH, detail: "the transcript's opening message is not the text the plugin scored" };
  }
  if (parts.shape === "v2" && built.tools !== parts.tools) {
    return { ok: false, reason: TOOLS_MISMATCH, detail: "the transcript's tool activity is not the activity the plugin read" };
  }
  if (parts.shape === "v2" && state !== record.state) {
    return { ok: false, reason: STATE_MISMATCH, detail: "the built state is not the state the plugin journaled" };
  }
  return { ok: true, state };
}

// --- The controller v2 state, from a sampled record ---

// The parts of a journaled controller state, in either shape, or null for a
// state in neither. The facts are the labelled lines of the block before
// the tail, each copied as `[label, value]` off its first ": ", whatever
// labels the plugin wrote at the time: the journal's controller states
// carry two nudge-count labels and three tail shapes across the plugin's
// versions, and the replay copies the facts rather than re-deriving them. A
// v2 state, one controllerStateText wrote, has its tail at the last blank
// line followed by CONTROLLER_OPTIONS_LEAD, and carries its Last answer and
// Pending plans lines at the end of the block; those two are read off it and
// the facts are the lines before them. A v1 state has its tail at the last
// blank line followed by its idle sentence, which every v1 shape opens on;
// its last answer is unknown to the journal, and its pending plans are the
// titles on the tail's switch line, each cut to 30 characters as the v1
// summary cut them and carrying no id, which is the one part of a v1
// record's rebuilt state that is not the plugin's bytes. The anchors are
// what let a v1 value carrying a blank line, which a LESSON fact holds on a
// fifth of the sampled records, stay inside the block. A block line with no
// ": " continues the value before it, joined with the line break the plugin
// folds to a space in its own state; a continuation line that happens to
// carry ": " reads as a label of its own, which the replay cannot tell from
// one, and a first line with no ": " makes the state unreadable.
const V1_SWITCH_LINE = "switch: switch to a different pending plan: ";
const V1_TAIL_ANCHOR = "\n\nThe session has been idle for ";
const V2_TAIL_ANCHOR = `\n\n${CONTROLLER_OPTIONS_LEAD}\n`;
const PLAN_SEPARATOR = "; ";
export function controllerStateParts(state) {
  if (typeof state !== "string") return null;
  const v2At = state.lastIndexOf(V2_TAIL_ANCHOR);
  const blank = v2At >= 0 ? v2At : state.lastIndexOf(V1_TAIL_ANCHOR);
  if (blank < 0) return null;
  const tail = state.slice(blank + 2);
  const pairs = [];
  for (const line of state.slice(0, blank).split("\n")) {
    const at = line.indexOf(": ");
    if (at < 0) {
      if (pairs.length === 0) return null;
      pairs[pairs.length - 1][1] += `\n${line}`;
      continue;
    }
    pairs.push([line.slice(0, at), line.slice(at + 2)]);
  }
  const answerAt = pairs.findIndex(([label]) => label === CONTROLLER_LAST_ANSWER_LABEL);
  if (v2At >= 0 && answerAt >= 0) {
    const rest = pairs.slice(answerAt + 1);
    if (rest.length > 1 || (rest.length === 1 && rest[0][0] !== CONTROLLER_PENDING_PLANS_LABEL)) return null;
    const pendingPlans = rest.length === 0 ? [] : rest[0][1].split(PLAN_SEPARATOR).map((entry) => {
      const idEnd = entry.indexOf(": ");
      return idEnd < 0 ? { id: null, title: entry } : { id: entry.slice(0, idEnd), title: entry.slice(idEnd + 2) };
    });
    return { shape: "v2", facts: pairs.slice(0, answerAt), lastAnswer: pairs[answerAt][1], pendingPlans };
  }
  if (v2At >= 0 || answerAt >= 0) return null;
  const switchLine = tail.split("\n").find((line) => line.startsWith(V1_SWITCH_LINE));
  const pendingPlans = switchLine === undefined ? [] : switchLine.slice(V1_SWITCH_LINE.length).split(PLAN_SEPARATOR).map((title) => ({ id: null, title }));
  return { shape: "v1", facts: pairs, lastAnswer: null, pendingPlans };
}

// The v2 state for one sampled record: the facts copied off its journaled
// state, the last answer from its transcript turn's final message, the
// pending plans as the journaled state names them, and the option list for
// the set the replay offers it, each option with its description in
// `options`, the resolved question's map as replayRecord reads it and the
// shipped entry's where a caller passes none. The plugin's controller builds
// its state from the answer that ended the worker's last turn on the tick's
// own node, which is the transcript turn's final message where that turn is
// such a turn, so the two meet in controllerStateText; a v2-journaled record
// whose line reads none held no such answer at the tick, and is rebuilt
// over none, the plugin's own bytes, rather than over a transcript turn the
// plugin did not count. A record with no transcript, no final message or no
// activity line throws, naming the record and the part, since that is a
// sampler defect. Otherwise it returns { ok: true, state }, or { ok: false,
// reason } for a record whose state could not be the plugin's bytes, which
// the caller writes as a failure and every figure excludes:
//
// - state_unparsed: the journaled state is in neither shape
//   controllerStateParts reads, so its facts cannot be copied.
// - pending_plans_unknown: a v1-journaled record whose call offered switch
//   and whose state names no pending plan, or the reverse; the Pending plans
//   line cannot be rebuilt from either.
// - answer_on_other_goal: a v1-journaled record whose transcript turn shows
//   it did not end on the tick's node: the turn called goal_done, which
//   completes the entry it started on and activates the next, so the plugin
//   keyed its answer to an entry the tick's node is not; or the turn opened
//   on a nudge whose goal line names an objective other than the state's,
//   read only where the sampler did not cut the prompt. A turn the record
//   cannot place this way is built, which is the limit the header states.
// - cut_short: the sampler cut the final message at FINAL_MAX raw characters
//   and the last answer came out under the plugin's bound once collapsed, so
//   the plugin's part would have run on past the replay's.
// - state_mismatch: checked only where the journal holds the plugin's own
//   state, which is a record journaled under v2. There the built state must
//   equal the journaled state byte for byte, which is also what places the
//   turn, so the two tells above are not read on a v2 record.
// - A v1-journaled record is not compared. Its journal carries no last
//   answer, and its Pending plans line is rebuilt from titles alone, each as
//   the v1 summary cut it at 30 characters, so the plugin's own line, which
//   names each plan by id and full title, is not what a v1 record replays
//   over; every other line is the journaled fact copied.
export const STATE_UNPARSED = "state_unparsed";
export const PENDING_PLANS_UNKNOWN = "pending_plans_unknown";
export const ANSWER_ON_OTHER_GOAL = "answer_on_other_goal";
// The goal line a nudge opens with, as hooks/index.ts writes it ahead of the
// objective, folded the way a state value is folded.
const NUDGE_GOAL_LINE = "(GOAL) The active goal is: ";
const folded = (text) => kaizenLine(text).replace(/\s+/g, " ").trim();
const shippedControllerOptions = () => SHIPPED_QUESTIONS[CONTROLLER_DECISION].options;
export function controllerV2State(record, options = shippedControllerOptions()) {
  const refuse = (part) => new Error(`record ${record.id}: ${part}, so its controller-decision v2 state cannot be built`);
  const t = record.transcript;
  if (!t || typeof t !== "object") throw refuse("it carries no transcript");
  if (typeof t.finalMessage !== "string" || t.finalMessage.length === 0) throw refuse("its transcript carries no final message");
  const tools = parseToolActivity(t.toolActivity);
  if (tools === null) throw refuse("its transcript's toolActivity is not a turn_tool_activity line");
  const optionIds = offeredOptionIds("controller-decision", record);
  const parts = controllerStateParts(record.state);
  if (parts === null) return { ok: false, reason: STATE_UNPARSED, detail: "the journaled state is not a controller summary this tool can copy the facts off" };
  const offersSwitch = optionIds.includes("switch");
  if (parts.shape === "v1" && offersSwitch !== parts.pendingPlans.length > 0) {
    return { ok: false, reason: PENDING_PLANS_UNKNOWN, detail: offersSwitch ? "the call offered switch and its state names no pending plan" : "the state names pending plans and the call offered no switch" };
  }
  if (parts.shape === "v1") {
    if (tools.flags.goal_done) {
      return { ok: false, reason: ANSWER_ON_OTHER_GOAL, detail: "the transcript turn called goal_done, so its answer was keyed to the entry it completed and not to the tick's node" };
    }
    const objective = parts.facts.find(([label]) => label === "Objective");
    const prompt = typeof t.prompt === "string" ? folded(t.prompt) : "";
    if (objective !== undefined && typeof t.prompt === "string" && t.prompt.length < PROMPT_MAX
      && prompt.startsWith(NUDGE_GOAL_LINE) && !prompt.startsWith(`${NUDGE_GOAL_LINE}${folded(objective[1])} `)) {
      return { ok: false, reason: ANSWER_ON_OTHER_GOAL, detail: "the transcript turn opened on a nudge naming another objective than the state's, so its answer was given on another entry" };
    }
  }
  const heldNoAnswer = parts.shape === "v2" && parts.lastAnswer === CONTROLLER_NO_ANSWER;
  const state = controllerStateText(parts.facts, heldNoAnswer ? null : t.finalMessage, parts.pendingPlans, optionIds, options);
  const built = controllerStateParts(state);
  if (!heldNoAnswer && t.finalMessage.length >= FINAL_MAX && built.lastAnswer.length < CONTROLLER_LAST_ANSWER_MAX) {
    return { ok: false, reason: CUT_SHORT, detail: "the sampler's raw cut left the last answer shorter than the plugin's bound" };
  }
  if (parts.shape === "v2" && state !== record.state) {
    return { ok: false, reason: STATE_MISMATCH, detail: "the built state is not the state the plugin journaled" };
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
// goes through `ask`, one Choice question over the v2 state controllerV2State
// builds from the record and the v2 option set for the set its own call
// offered, and turn-score the same way over the v2 state turnScoreV2State
// builds from the record. block-owner goes
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
    // One resolution serves the state's option list and the request's
    // criteria, as the plugin's tick does, so an admitted override reaches
    // both or neither. A v1 record's Haiku value of pause is folded to
    // ask-operator, the one verdict the two selected, under score.mjs's own
    // rule, so the seam's result names a value inside the set it offered.
    const resolved = await resolverOf(host)(CONTROLLER_DECISION);
    const built = controllerV2State(record, resolved.primitive === "choice" ? resolved.options : {});
    if (!built.ok) return { id: record.id, stampId: record.stampId, version, ok: false, reason: built.reason, detail: built.detail };
    const haikuValue = typeof record.haikuValue === "string" ? foldedValue(question, record.haikuValue) : null;
    const result = await ask(host, CONTROLLER_DECISION, optionIds, built.state, MODE, haikuValue, async () => resolved);
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
  const refused = [CUT_SHORT, PROMPT_MISMATCH, TOOLS_MISMATCH, STATE_MISMATCH, STATE_UNPARSED, PENDING_PLANS_UNKNOWN, ANSWER_ON_OTHER_GOAL].map((reason) => `${rows.filter((r) => r.reason === reason).length} refused as ${reason}`);
  process.stdout.write(`${rows.length} record(s) replayed, ${failed} failed (${refused.join(", ")}), written to ${out}\n`);
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
