#!/usr/bin/env node
// sample.mjs: draws a stratified sample of one Jev question's calls from the
// decision journal, each call joined to its answer, its outcome lines, the
// next call at the same site and persona, and the transcript turn that
// produced it.
//
// Usage:
//   node .kit/jev-gold/sample.mjs --question <id> [--n 150] [--split dev]
//     [--out <dir>] [--seed <int>] [--journal <dir>] [--projects <dir>]
//
// --out defaults to .kit/jev-gold/out/<question>. --journal and --projects
// default to the journal and transcript roots under the home the plugin
// resolves: USERPROFILE first, then HOME. The output is sample.jsonl, one
// record per sampled call, and counts.json, the admission and allocation
// counts this script also prints.
//
// Reads only. Nothing here writes outside the output directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fnv1aHash } from "../../hooks/cost-ledger.ts";
import { PLAN_PATH_PATTERN, bracketSafeText, oneLine } from "../../hooks/agent-state.ts";

// Each question this sampler draws: the journal site that asks it, and the
// oversample section 5's floor needs. The ids are the catalog's own, pinned
// against hooks/question-catalog.ts by .kit/jev-gold-unit-test.mjs.
export const QUESTIONS = Object.freeze({
  "controller-decision": { site: "controller", oversample: null },
  "turn-score": { site: "turn-score", oversample: null },
  "block-owner": { site: "plan-health", oversample: { value: "operator", version: "v1", max: 60 } },
});

export const DEFAULT_SEED = 20260926;
export const DEFAULT_N = 150;
// No persona takes more than this share of a sample.
export const PERSONA_CAP_SHARE = 0.4;
// A stratum smaller than this contributes every record it holds.
export const SMALL_STRATUM = 5;
// The longest opening prompt and final message a record carries. Both cover
// the 1,200 and 3,000 characters the re-posed turn-score state will read.
export const PROMPT_MAX = 3000;
export const FINAL_MAX = 4000;

// The reasons a call is not admitted, in the order they are tested. A call
// is counted under the first that applies. `no_transcript_turn` is a call
// with no transcript turn ended before it; `answer_mismatch` is one whose
// state's answer text is not the final message of the turn that did end
// before it, so its own turn is not the one on disk.
export const DROP_REASONS = Object.freeze(["other_site", "split", "no_answer", "state_unresolved", "no_transcript_turn", "answer_mismatch"]);

// --- Persona identity ---

// One persona under another name. The journal's `dev/` folder holds 8 files,
// all dated 2026-09-21, with 236 calls under the persona `dev`, and the
// `DEV-PERSONA/` folder starts on 2026-09-21; both persona's transcripts sit
// under the one project folder D--agent-persona. So `dev` is the dev persona
// before it was renamed. Keys and values are folded names.
export const PERSONA_ALIASES = Object.freeze({ dev: "dev-persona" });

// The identity the sampler keys a persona on: its name folded to lower case,
// then through PERSONA_ALIASES. The journal spells one persona in two cases
// within one folder (`dev-discord/` holds both DEV-DISCORD and dev-discord),
// so the raw name would split one persona's calls across two identities.
export function personaKey(name) {
  const folded = String(name).toLowerCase();
  return Object.hasOwn(PERSONA_ALIASES, folded) ? PERSONA_ALIASES[folded] : folded;
}

// --- Seeded randomness ---

// mulberry32: a 32-bit seeded generator, so a re-run with the same seed draws
// the same sample and the same labeller order.
export function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates over a copy.
export function shuffled(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- The journal ---

function readJsonLines(file) {
  const out = [];
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line is skipped */ }
  }
  return out;
}

// Every line of every file under the journal root, by kind. Answers and
// outcomes are joined to calls by `callStampId` across files, since a line
// written after a UTC day turns lands in the next day's file.
export function readJournal(root) {
  const calls = [];
  const answersByCall = new Map();
  const outcomesByCall = new Map();
  let personas = [];
  try { personas = fs.readdirSync(root).sort(); } catch { personas = []; }
  for (const persona of personas) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, persona)).filter((f) => f.endsWith(".jsonl")).sort(); } catch { continue; }
    for (const f of files) {
      const file = path.join(root, persona, f);
      for (const o of readJsonLines(file)) {
        if (o.lineKind === "call") calls.push({ ...o, file });
        else if (o.lineKind === "answer") push(answersByCall, o.callStampId, o);
        else if (o.lineKind === "outcome") push(outcomesByCall, o.callStampId, o);
      }
    }
  }
  return { calls, answersByCall, outcomesByCall };
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

// A call's state as Jev saw it. hooks/decision-journal.ts writeCall writes
// `state: null` with `stateRef` naming the stamp id of the earlier line at the
// same site in the same file that carries the same text, and it records a
// line as a reference target only when that line carried its state, so one
// hop always reaches the text. The target is taken from the same file and
// site, and the text is accepted only where it hashes to the call's own
// stateHash. A null state with a null stateRef is a call that carried no
// state at all. Returns { state, reconstructed } or null where no text can be
// named.
export function resolveState(call, callsByFileAndStamp) {
  if (typeof call.state === "string") return { state: call.state, reconstructed: false };
  if (typeof call.stateRef !== "string") return null;
  const ref = callsByFileAndStamp.get(`${call.file}\u0000${call.stateRef}`);
  if (!ref || ref.site !== call.site || typeof ref.state !== "string") return null;
  if (fnv1aHash(ref.state) !== call.stateHash) return null;
  return { state: ref.state, reconstructed: true };
}

export function indexCalls(calls) {
  const byFileAndStamp = new Map();
  for (const c of calls) byFileAndStamp.set(`${c.file}\u0000${c.stampId}`, c);
  return byFileAndStamp;
}

// --- The transcripts ---

// Session id to transcript path, over every folder under the projects root.
// A call line carries no working directory, so no folder rule is used. Only
// a folder's own top-level files are read: subagent transcripts sit a level
// down and are not the persona's own turns.
export function indexTranscripts(root) {
  const out = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(root).sort(); } catch { dirs = []; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl") && !out.has(f.slice(0, -6))) out.set(f.slice(0, -6), path.join(root, d, f));
  }
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

function hasToolResult(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === "tool_result");
}

// The origins whose message opens a turn although the transcript marks it
// meta: a channel message and a peer session's message each arrive as a new
// prompt while the persona is idle.
const TURN_OPENING_META_ORIGINS = new Set(["channel", "peer"]);

// Whether a transcript entry opens a main-thread turn: a user entry off the
// sidechain that is not a tool result, not a compaction summary, not a local
// command echo, a skill's loaded body or an interruption notice, and not
// meta unless its origin is one of the two above. Every other meta entry (a
// skill body, stop hook feedback, a re-invocation notice) lands inside a turn
// already open. An interruption notice ("[Request interrupted ...") records
// that the running turn was stopped, and the next prompt opens the next turn.
export function opensTurn(entry) {
  if (!entry || entry.type !== "user" || entry.isSidechain || entry.isCompactSummary) return false;
  const content = entry.message && entry.message.content;
  if (hasToolResult(content)) return false;
  if (entry.isMeta && !(entry.origin && TURN_OPENING_META_ORIGINS.has(entry.origin.kind))) return false;
  const t = textOf(content).trim();
  if (!t || t.startsWith("<local-command") || t.startsWith("<command-name>") || t.startsWith("[Request interrupted") ||
    t.slice(0, 200).includes("Base directory for this skill")) return false;
  return true;
}

// The line the engine puts ahead of a message a plugin sends, which the
// plugin's own view of the prompt does not carry.
const PLUGIN_MESSAGE_WRAPPER = /^The [\w-]+ plugin sent a message:\s*/;

// The paragraph the engine puts after a message a plugin submits between
// turns, which the plugin's own view of the prompt does not carry either. It
// is written with its dash as an escape, the engine's own text being the
// thing matched.
const HARNESS_TRAILER = "This is how Claude Code surfaces a prompt a plugin submits between turns \u2014 it starts this turn in the user's place. Address the message above.";

// A turn's opening text with the engine's trailer paragraph removed from its
// end, and the whitespace before it. A text not ending in the trailer is
// returned as it came. turnsOf applies it to every prompt it reads, and
// .kit/jev-gold/replay.mjs applies it again to a sampled record's prompt, so a
// sample drawn before the reader removed it replays the same.
export function withoutHarnessTrailer(text) {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(HARNESS_TRAILER) ? trimmed.slice(0, -HARNESS_TRAILER.length).trimEnd() : text;
}

function isReplyTool(name) {
  return typeof name === "string" && (name.includes("__reply") || name.endsWith("_reply"));
}

// The times of every reply-tool call made off the main thread in one session:
// sidechain entries in the session's own transcript, and every entry of the
// subagent transcripts under <folder>/<session>/subagents/, at any depth.
// hooks/index.ts sets the turn's reply flag on a reply call from any loop, a
// subagent's included, while the ring and the other flags take the main
// loop's calls alone.
function offThreadReplyTimes(file, entries) {
  const times = [];
  const note = (e) => {
    const content = e && e.type === "assistant" && e.message && e.message.content;
    if (!Array.isArray(content) || !content.some((b) => b && b.type === "tool_use" && isReplyTool(b.name))) return;
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms)) times.push(ms);
  };
  for (const e of entries) if (e.isSidechain) note(e);
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith(".jsonl")) {
        let text = "";
        try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
        // Only a line naming a reply tool can carry one, so the rest of a
        // subagent transcript is never parsed.
        for (const line of text.split("\n")) {
          if (!line.includes("_reply")) continue;
          try { note(JSON.parse(line)); } catch { /* a torn line is skipped */ }
        }
      }
    }
  };
  walk(path.join(file.slice(0, -".jsonl".length), "subagents"));
  return times;
}

// The main-thread turns of one transcript, in file order. A turn runs from
// the entry that opens it to the entry before the next opener. Its lines are
// its main-thread user and assistant entries, its end is the latest timestamp
// among them, its final message is the text of its last assistant entry that
// carried text, and its tools are the tool_use blocks its assistant entries
// made, in order. `sidechainReply` is whether a reply-tool call off the main
// thread fell between the turn's opening line and its end.
export function turnsOf(file) {
  const entries = readJsonLines(file);
  const replyTimes = offThreadReplyTimes(file, entries);
  const starts = [];
  entries.forEach((e, i) => { if (opensTurn(e)) starts.push(i); });
  const turns = [];
  for (let n = 0; n < starts.length; n++) {
    const s = starts[n];
    const end = n + 1 < starts.length ? starts[n + 1] : entries.length;
    let endMs = Date.parse(entries[s].timestamp);
    let final = "";
    const tools = [];
    for (const e of entries.slice(s, end)) {
      if (e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
      const ms = Date.parse(e.timestamp);
      if (Number.isFinite(ms) && !(ms <= endMs)) endMs = ms;
      if (e.type !== "assistant") continue;
      const content = e.message && e.message.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b && b.type === "tool_use" && typeof b.name === "string") tools.push({ name: b.name, input: b.input || {} });
      }
      const t = textOf(content).trim();
      if (t) final = t;
    }
    const startMs = Date.parse(entries[s].timestamp);
    turns.push({
      promptAt: entries[s].timestamp,
      endMs,
      sidechainReply: replyTimes.some((ms) => ms >= startMs && ms <= endMs),
      prompt: withoutHarnessTrailer(textOf(entries[s].message.content).trim().replace(PLUGIN_MESSAGE_WRAPPER, "")),
      final,
      tools,
    });
  }
  return turns;
}

// The most recent turn whose last line precedes `at`: the controller fires
// between turns, and the scorer and the plan-health request fire after a
// turn's last line, so a turn still open at `at` is never the one asked about.
export function turnBefore(turns, at) {
  const atMs = Date.parse(at);
  let best = null;
  for (const t of turns) if (Number.isFinite(t.endMs) && t.endMs < atMs && (best === null || t.endMs >= best.endMs)) best = t;
  return best;
}

// --- The tool-activity summary ---
//
// The shape and flag definitions of turnToolActivityText and noteTurnToolCall
// in hooks/index.ts, read here off a transcript turn's tool_use blocks rather
// than off tool.call events. Those functions are private to hooks/index.ts,
// so they are restated here, and a drift is what the section 4 byte-identity
// pin exists to catch.
export const TURN_TOOL_RING_MAX = 8;
const GIT_OPTION_RUN = String.raw`(?:\s+-\S*(?:\s+(?:"[^"]*"|'[^']*'|[^-\s"']\S*))?)*`;
const GIT_COMMIT_PATTERN = new RegExp(String.raw`\bgit${GIT_OPTION_RUN}\s+commit\b`);
const GIT_PUSH_PATTERN = new RegExp(String.raw`\bgit${GIT_OPTION_RUN}\s+push\b`);

function namesPlanDocument(value) {
  if (typeof value !== "string") return false;
  const suffix = /(^|[\\/])(docs[\\/]plans[\\/][^\\/]+)$/.exec(value);
  return suffix !== null && PLAN_PATH_PATTERN.test(suffix[2].replace(/\\/g, "/"));
}

function isWorkTool(toolName) {
  if (["Write", "Edit", "Bash", "NotebookEdit"].includes(toolName)) return true;
  if (!toolName.startsWith("mcp__")) return false;
  if (toolName.startsWith("mcp__agentic-plugin__")) return false;
  if (toolName.includes("__reply") || toolName.endsWith("_reply")) return false;
  return true;
}

// `tools` is the turn's main-thread calls in order, and `offThreadReply`
// whether a subagent or sidechain made a reply call inside the turn.
export function toolActivityText(tools, offThreadReply = false) {
  const flags = { planRead: false, planEdited: false, committed: false, pushed: false, agentDispatched: false, goalDoneCalled: false };
  let ring = [];
  let workTools = 0;
  let reply = offThreadReply === true;
  for (const { name, input } of tools) {
    ring.push(name);
    if (ring.length > TURN_TOOL_RING_MAX) ring = ring.slice(ring.length - TURN_TOOL_RING_MAX);
    if (isWorkTool(name)) workTools += 1;
    if (name === "Read" && namesPlanDocument(input.file_path)) flags.planRead = true;
    if ((name === "Write" || name === "Edit") && namesPlanDocument(input.file_path)) flags.planEdited = true;
    if (name === "Bash" && typeof input.command === "string") {
      if (GIT_COMMIT_PATTERN.test(input.command)) flags.committed = true;
      if (GIT_PUSH_PATTERN.test(input.command)) flags.pushed = true;
    }
    if (name === "Agent") flags.agentDispatched = true;
    if (name === "mcp__agentic-plugin__goal_done") flags.goalDoneCalled = true;
    if (isReplyTool(name)) reply = true;
  }
  const yn = (held) => (held ? "yes" : "no");
  return `plan_read=${yn(flags.planRead)} plan_edited=${yn(flags.planEdited)} commit=${yn(flags.committed)} push=${yn(flags.pushed)} ` +
    `agent_dispatched=${yn(flags.agentDispatched)} goal_done=${yn(flags.goalDoneCalled)} reply=${yn(reply)} ` +
    `work_tools=${workTools} tools=${ring.join(",")}`;
}

// --- Admission and the joins ---

// The answer text a call's own state carries, where its site puts one there,
// or null. The scorer's state carries its answer between "Worker answered: "
// and "Goal objective: ", each after a blank line, in both of its shapes: v1
// ("User asked: " first, the answer a plain slice of 1,000 characters) and v2
// ("Turn opened with: " first, the answer folded to one line with its
// brackets rewritten and its whitespace collapsed, then cut at 3,000, by
// turnScoreStateText in hooks/question-catalog.ts). The plan-health state is
// the JSON of `{ closingText, recentClosingTexts }`, with the closing text a
// plain slice of 1,000. The controller's state carries no answer.
const ANSWER_OPEN = "\n\nWorker answered: ";
const ANSWER_CLOSE = "\n\nGoal objective: ";
export function stateAnswerText(site, state) {
  if (site === "turn-score") {
    const from = state.indexOf(ANSWER_OPEN);
    const to = state.lastIndexOf(ANSWER_CLOSE);
    return from >= 0 && to > from ? state.slice(from + ANSWER_OPEN.length, to) : null;
  }
  if (site === "plan-health") {
    try {
      const parsed = JSON.parse(state);
      return parsed && typeof parsed.closingText === "string" ? parsed.closingText : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Whether a transcript turn is the one whose answer a call's state carries:
// the state's text opens the turn's final message, both folded to one line
// with their brackets rewritten and their whitespace removed. The state's
// text is a prefix because of its cut. Whitespace is set aside because the
// transcript reader joins a message's text blocks with one line break where
// the hook's answer may join them otherwise, and because v2 collapses it; the
// fold is applied to both sides because v2 folds the answer it carries and
// v1 does not, and folding is idempotent. An empty answer never matches,
// since the hook scores none.
const NO_SPACE = /\s+/g;
const comparableAnswer = (text) => bracketSafeText(oneLine(text)).replace(NO_SPACE, "");
export function turnProducedAnswer(turn, answerText) {
  const want = comparableAnswer(answerText);
  return want.length > 0 && comparableAnswer(turn.final).startsWith(want);
}

// Every call in the journal, admitted into a candidate record for `question`
// or counted under the first drop reason that applies.
export function buildCandidates(journal, transcripts, question, split) {
  const spec = QUESTIONS[question];
  if (!spec) throw new Error(`unknown question: ${question}`);
  const byFileAndStamp = indexCalls(journal.calls);
  const dropped = Object.fromEntries(DROP_REASONS.map((r) => [r, 0]));
  // The hindsight join: each call's successor at the same site and persona,
  // over every file, in `at` order.
  const nextOf = new Map();
  const bySitePersona = new Map();
  for (const c of journal.calls) push(bySitePersona, `${c.site}\u0000${personaKey(c.persona)}`, c);
  for (const list of bySitePersona.values()) {
    list.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
    for (let i = 0; i + 1 < list.length; i++) nextOf.set(list[i], list[i + 1]);
  }
  const turnCache = new Map();
  const candidates = [];
  for (const call of journal.calls) {
    if (call.site !== spec.site) { dropped.other_site += 1; continue; }
    if (call.split !== split) { dropped.split += 1; continue; }
    const answer = (journal.answersByCall.get(call.stampId) || []).find((a) => a.questionId === question);
    if (call.result !== "ok" || !answer) { dropped.no_answer += 1; continue; }
    const resolved = resolveState(call, byFileAndStamp);
    if (!resolved) { dropped.state_unresolved += 1; continue; }
    const tpath = transcripts.get(call.session);
    let turn = null;
    if (tpath) {
      if (!turnCache.has(tpath)) turnCache.set(tpath, turnsOf(tpath));
      turn = turnBefore(turnCache.get(tpath), call.at);
    }
    // The latest turn ended before the call is taken as the call's own only
    // where the state's answer text is that turn's: a scored or plan-health
    // call whose own turn is not in the transcript would otherwise be joined
    // to whichever turn ended before it. The controller's state carries no
    // answer text, so its join rests on timing alone.
    const answerText = stateAnswerText(call.site, resolved.state);
    if (!turn) { dropped.no_transcript_turn += 1; continue; }
    if (answerText !== null && !turnProducedAnswer(turn, answerText)) { dropped.answer_mismatch += 1; continue; }
    const next = nextOf.get(call) || null;
    const nextResolved = next ? resolveState(next, byFileAndStamp) : null;
    const haikuValue = typeof answer.haikuValue === "string" ? answer.haikuValue : null;
    const persona = personaKey(call.persona);
    candidates.push({
      stampId: call.stampId,
      question,
      // The persona's identity, which the strata, the cap and the counts key
      // on, and the spelling the journal line carried.
      persona,
      personaRaw: call.persona,
      session: call.session,
      site: call.site,
      split: call.split,
      at: call.at,
      state: resolved.state,
      stateReconstructed: resolved.reconstructed,
      jev: {
        version: answer.questionVersion,
        value: answer.value,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      },
      haikuValue,
      outcomes: (journal.outcomesByCall.get(call.stampId) || []).map((o) => ({ kind: o.kind, value: o.value, at: o.at })),
      hindsight: next ? { at: next.at, state: nextResolved ? nextResolved.state : null } : null,
      transcript: {
        promptAt: turn.promptAt,
        endAt: new Date(turn.endMs).toISOString(),
        prompt: turn.prompt.slice(0, PROMPT_MAX),
        finalMessage: turn.final.slice(0, FINAL_MAX),
        toolActivity: toolActivityText(turn.tools, turn.sidechainReply),
      },
      stratum: `${persona}|${haikuValue ?? answer.value}`,
    });
  }
  return { candidates, dropped, admitted: candidates.length };
}

// --- Stratification ---

// Largest-remainder split of `total` over `weights` (a Map of key to weight),
// ties broken by key so the split is the same on every run.
function largestRemainder(total, weights) {
  const keys = [...weights.keys()].sort();
  const sum = keys.reduce((s, k) => s + weights.get(k), 0);
  const out = new Map(keys.map((k) => [k, 0]));
  if (sum <= 0 || total <= 0) return out;
  const rema = [];
  let given = 0;
  for (const k of keys) {
    const exact = (total * weights.get(k)) / sum;
    const whole = Math.floor(exact);
    out.set(k, whole);
    given += whole;
    rema.push([k, exact - whole]);
  }
  rema.sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1));
  for (let i = 0; i < total - given; i++) out.set(rema[i][0], out.get(rema[i][0]) + 1);
  return out;
}

// Draws `n` records from `candidates`. A stratum is one persona and one Haiku
// value, or Jev's where Haiku has none. No persona passes PERSONA_CAP_SHARE of
// `n`, the oversample included. The oversample, where the question has one,
// is taken first: candidates whose Jev answer is the named value under the
// named version, in the seeded order, up to its max and skipping any whose
// persona has reached the cap. The rest of `n` then fills by stratum: a
// stratum below SMALL_STRATUM contributes all of it where its persona has
// room, and the others fill in proportion to their share. A share a capped
// persona cannot take goes to the other personas' strata in proportion,
// round by round, until `n` is met or no stratum can take more. Returns the
// chosen records in `at` order.
export function stratify(candidates, n, seed, oversample = null) {
  const rng = rngOf(seed);
  const cap = Math.floor(n * PERSONA_CAP_SHARE);
  const chosen = [];
  const personaTotal = new Map();
  const count = (persona, m) => personaTotal.set(persona, (personaTotal.get(persona) || 0) + m);
  let pool = candidates;
  let oversampled = 0;
  if (oversample) {
    const hits = shuffled(candidates.filter((c) => c.jev.value === oversample.value && c.jev.version === oversample.version), rng);
    const taken = new Set();
    for (const c of hits) {
      if (taken.size >= Math.min(oversample.max, n)) break;
      if ((personaTotal.get(c.persona) || 0) >= cap) continue;
      taken.add(c);
      count(c.persona, 1);
    }
    chosen.push(...taken);
    oversampled = taken.size;
    pool = candidates.filter((c) => !taken.has(c));
  }
  // Each stratum's persona rides on its group, so no key is parsed back.
  const groups = new Map();
  for (const c of pool) {
    const g = groups.get(c.stratum);
    if (g) g.list.push(c); else groups.set(c.stratum, { persona: c.persona, list: [c] });
  }
  for (const g of groups.values()) g.list = shuffled(g.list, rng);
  const quota = new Map([...groups.keys()].map((k) => [k, 0]));
  const size = (k) => groups.get(k).list.length;
  const room = (k) => Math.min(size(k) - quota.get(k), cap - (personaTotal.get(groups.get(k).persona) || 0));
  const add = (k, m) => {
    quota.set(k, quota.get(k) + m);
    count(groups.get(k).persona, m);
  };
  let left = Math.max(0, n - chosen.length);
  // Small strata first, in key order, each whole where its persona has room.
  for (const k of [...groups.keys()].sort()) {
    if (size(k) >= SMALL_STRATUM || left <= 0) continue;
    const m = Math.max(0, Math.min(room(k), left));
    add(k, m);
    left -= m;
  }
  // Then the rest in proportion to share, round by round.
  while (left > 0) {
    const eligible = new Map();
    for (const k of groups.keys()) if (size(k) >= SMALL_STRATUM && room(k) > 0) eligible.set(k, size(k));
    if (eligible.size === 0) break;
    const split = largestRemainder(left, eligible);
    let placed = 0;
    for (const k of [...split.keys()].sort()) {
      const m = Math.max(0, Math.min(split.get(k), room(k)));
      if (m > 0) { add(k, m); placed += m; }
    }
    left -= placed;
    if (placed === 0) {
      // Every share rounded to zero against a cap or a size: place one record
      // in the largest stratum that still has room, so each round moves.
      const k = [...eligible.keys()].sort((x, y) => (eligible.get(y) - eligible.get(x)) || (x < y ? -1 : 1))[0];
      add(k, 1);
      left -= 1;
    }
  }
  for (const [k, g] of groups) chosen.push(...g.list.slice(0, quota.get(k)));
  chosen.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : (x.stampId < y.stampId ? -1 : 1)));
  return { records: chosen, oversampled, cap };
}

// --- Record ids ---

// A record's id: the question's initials and the FNV-1a hash of its call's
// stamp id, as eight hex digits. It is a function of the call alone, so a
// label file written for another sample carries ids this sample's records
// miss, and the adjudicator's missing-label refusal catches the mix.
export function recordId(question, stampId) {
  const prefix = question.split("-").map((w) => w[0]).join("");
  return `${prefix}-${fnv1aHash(stampId).toString(16).padStart(8, "0")}`;
}

// --- Counts ---

export function countBy(records, keyOf) {
  const out = {};
  for (const r of records) { const k = keyOf(r); out[k] = (out[k] || 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort());
}

// --- The command ---

function parseArgs(argv) {
  const flags = { n: DEFAULT_N, split: "dev", seed: DEFAULT_SEED };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (!a.startsWith("--") || v === undefined) throw new Error(`bad argument: ${a}`);
    i += 1;
    const name = a.slice(2);
    if (name === "n" || name === "seed") {
      if (!/^\d+$/.test(v)) throw new Error(`--${name} takes a whole number`);
      flags[name] = Number(v);
    } else if (["question", "split", "out", "journal", "projects"].includes(name)) flags[name] = v;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!flags.question || !QUESTIONS[flags.question]) throw new Error(`--question must be one of ${Object.keys(QUESTIONS).join(", ")}`);
  return flags;
}

export function homeDir(env = process.env) {
  for (const v of [env.USERPROFILE, env.HOME]) if (typeof v === "string" && v.trim()) return v.trim();
  return os.homedir();
}

export function main(argv) {
  const flags = parseArgs(argv);
  const home = homeDir();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const journalRoot = flags.journal || path.join(home, ".claude", "agentic-decisions");
  const projectsRoot = flags.projects || path.join(home, ".claude", "projects");
  const out = flags.out || path.join(here, "out", flags.question);
  const journal = readJournal(journalRoot);
  const transcripts = indexTranscripts(projectsRoot);
  const { candidates, dropped, admitted } = buildCandidates(journal, transcripts, flags.question, flags.split);
  const { records, oversampled, cap } = stratify(candidates, flags.n, flags.seed, QUESTIONS[flags.question].oversample);
  const numbered = records.map((r) => ({ id: recordId(flags.question, r.stampId), ...r }));
  const seen = new Set();
  for (const r of numbered) {
    if (seen.has(r.id)) throw new Error(`two sampled calls share the record id ${r.id}; re-run with another --seed`);
    seen.add(r.id);
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "sample.jsonl"), numbered.map((r) => JSON.stringify(r)).join("\n") + (numbered.length ? "\n" : ""));
  const counts = {
    question: flags.question,
    split: flags.split,
    seed: flags.seed,
    n: flags.n,
    calls: journal.calls.length,
    admitted,
    dropped,
    sampled: records.length,
    oversampled,
    personaCap: cap,
    reconstructedStates: records.filter((r) => r.stateReconstructed).length,
    admittedByPersona: countBy(candidates, (r) => r.persona),
    admittedByStratum: countBy(candidates, (r) => r.stratum),
    sampledByPersona: countBy(records, (r) => r.persona),
    sampledByStratum: countBy(records, (r) => r.stratum),
  };
  fs.writeFileSync(path.join(out, "counts.json"), JSON.stringify(counts, null, 2) + "\n");
  process.stdout.write(JSON.stringify(counts, null, 2) + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`sample: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 2;
  }
}
