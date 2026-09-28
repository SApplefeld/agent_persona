#!/usr/bin/env node
// Jev gold tools unit tests: the sampler's null-state reconstruction, its
// admission counts, its transcript join and hindsight join, its
// stratification counts, the labeller's argument array, its refusal of a
// reply that drops a record, its timeout retry, Cohen's kappa, the
// adjudication into gold, the scorer's accuracy, precision, recall,
// calibration, agreement, AUC and bar lines against a hand-computed fixture,
// and the replay's request shape and failure handling against a stub host.
//
// The sampler reads the synthetic journal and transcripts under
// .kit/fixtures/jev-gold/. The labeller and the adjudicator run as their own
// processes with JEV_GOLD_LABELLER naming .kit/fixtures/jev-gold/stub-labeller.mjs,
// so no case spawns a real `claude`. The replay cases run through an injected
// stub host whose `fetch` never reaches the network. Every output goes under
// a temp directory this suite removes.
//
// Usage: node .kit/jev-gold-unit-test.mjs
// Exits 0 on success, 1 on failure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Registers the resolve hook that lets hooks/question-catalog.ts load its
// extensionless imports, as .kit/question-catalog-unit-test.mjs does.
import "./tick-harness.mjs";
import {
  QUESTIONS, DROP_REASONS, readJournal, indexCalls, resolveState, indexTranscripts, turnsOf, turnBefore,
  opensTurn, toolActivityText, buildCandidates, stratify, personaKey, PERSONA_ALIASES, stateAnswerText, turnProducedAnswer, PROMPT_MAX, FINAL_MAX,
} from "./jev-gold/sample.mjs";
import {
  CLI_FLAGS, rubricText, rubricLabels, labellerView, checkBatch, cohensKappa, kappaLine,
} from "./jev-gold/label.mjs";
import {
  readGold, sampleById, joinGoldSample, withReplay, foldedValue, topProbability, scorable,
  accuracyOf, confusionOf, precisionRecallOf, calibrationOf, agreementOf, aucOf, outcomeKindsPresent,
  haikuAccuracyOf, haikuConfusionOf, haikuPrecisionRecallOf, unfoldedAccuracyOf,
  BARS, TOP_PROBABILITY_FLOOR, COVERAGE_FLOOR, BLOCK_OWNER_OPERATOR_COUNT_FLOOR, DEFAULT_RECALL_COUNT_FLOOR,
  coverageOf, evalBar, report,
} from "./jev-gold/score.mjs";
import * as scoreModule from "./jev-gold/score.mjs";
// Read off the namespace, so a missing export reads as a failed check.
const onSharedRecords = typeof scoreModule.onSharedRecords === "function"
  ? scoreModule.onSharedRecords
  : () => ({ shared: -1, groups: new Map([["v1", []], ["v2 (replay)", []]]) });
import * as replayModule from "./jev-gold/replay.mjs";
import {
  offeredOptionIds, REPLAYABLE_VERSIONS, replayRecord, replayAll, buildHost, main as replayMain,
} from "./jev-gold/replay.mjs";
import { fnv1aHash } from "../hooks/cost-ledger.ts";

const catalog = await import("../hooks/question-catalog.ts");

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name, detail) {
  console.error(`  FAIL: ${name}`);
  if (detail !== undefined) console.error(`        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  failed++;
}
function check(name, cond, detail) { if (cond) ok(name); else fail(name, detail); }
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "jev-gold");
const JOURNAL = path.join(FIXTURE, "journal");
const PROJECTS = path.join(FIXTURE, "projects");
const STUB = path.join(FIXTURE, "stub-labeller.mjs");
const SAMPLE = path.join(HERE, "jev-gold", "sample.mjs");
const LABEL = path.join(HERE, "jev-gold", "label.mjs");
const ADJUDICATE = path.join(HERE, "jev-gold", "adjudicate.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jev-gold-test-"));

function run(script, args, env = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings", script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}
function readLines(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

try {
  // --- The question ids and the rubrics' label lists against the catalog ---
  console.log("\nquestion ids and rubric labels");
  check("the sampler's question ids are the catalog's own",
    same(Object.keys(QUESTIONS).sort(), [catalog.CONTROLLER_DECISION, catalog.TURN_SCORE, catalog.BLOCK_OWNER].sort()), Object.keys(QUESTIONS));
  check("the controller rubric offers the four decisions without pause, plus unclear",
    same(rubricLabels(rubricText("controller-decision")).sort(),
      [...catalog.CONTROLLER_LABELS_WITH_SWITCH.filter((l) => l !== "pause"), "unclear"].sort()),
    rubricLabels(rubricText("controller-decision")));
  check("the turn-score rubric offers the four v1 answers plus unclear",
    same(rubricLabels(rubricText("turn-score")).sort(), [...catalog.SCORER_LABELS, "unclear"].sort()),
    rubricLabels(rubricText("turn-score")));
  check("the block-owner rubric offers the five owners and nothing else",
    same(rubricLabels(rubricText("block-owner")).sort(), [...catalog.BLOCK_OWNER_OPTIONS].sort()),
    rubricLabels(rubricText("block-owner")));
  check("control: a rubric with no Labels heading offers nothing",
    rubricLabels("# x\n\n- `a`: one\n").length === 0);

  // --- The null-state reconstruction ---
  console.log("\nnull-state reconstruction");
  {
    const text = "Objective: fixture\nIdle time: 1min\n";
    const carrier = { stampId: "p.s.1.1", file: "f1", site: "controller", state: text, stateHash: fnv1aHash(text), stateRef: null };
    const repeat = { stampId: "p.s.2.2", file: "f1", site: "controller", state: null, stateHash: fnv1aHash(text), stateRef: "p.s.1.1" };
    const idx = indexCalls([carrier, repeat]);
    check("a call carrying its state keeps it and is not marked reconstructed",
      same(resolveState(carrier, idx), { state: text, reconstructed: false }));
    check("a null state with a stateRef takes the referenced line's text",
      same(resolveState(repeat, idx), { state: text, reconstructed: true }));
    check("the reference is looked up in the same file only",
      resolveState({ ...repeat, file: "f2" }, idx) === null);
    check("the reference must be at the same site",
      resolveState(repeat, indexCalls([{ ...carrier, site: "turn-score" }, repeat])) === null);
    check("the referenced text must hash to the call's own stateHash",
      resolveState({ ...repeat, stateHash: 1 }, idx) === null);
    check("a null state with a null stateRef names no text",
      resolveState({ ...repeat, stateRef: null }, idx) === null);
    check("a stateRef naming no line names no text",
      resolveState({ ...repeat, stateRef: "p.s.9.9" }, idx) === null);
  }

  // --- The transcript turn split ---
  console.log("\ntranscript turns");
  {
    const u = (extra, content = "hello") => ({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content }, ...extra });
    check("a typed prompt opens a turn", opensTurn(u({})));
    check("a task notification opens a turn", opensTurn(u({ origin: { kind: "task-notification" } }, "<task-notification>x</task-notification>")));
    check("a channel message opens a turn although the transcript marks it meta", opensTurn(u({ isMeta: true, origin: { kind: "channel" } })));
    check("a peer message opens a turn although the transcript marks it meta", opensTurn(u({ isMeta: true, origin: { kind: "peer" } })));
    check("any other meta entry does not", !opensTurn(u({ isMeta: true })));
    check("a sidechain entry does not", !opensTurn(u({ isSidechain: true })));
    check("a compaction summary does not", !opensTurn(u({ isCompactSummary: true })));
    check("a tool result does not", !opensTurn(u({}, [{ type: "tool_result", content: "x" }])));
    check("a skill's loaded body does not", !opensTurn(u({}, "Base directory for this skill: C:/x")));
    check("a local command echo does not", !opensTurn(u({}, "<local-command-stdout>x</local-command-stdout>")));
    check("an interruption notice does not", !opensTurn(u({}, [{ type: "text", text: "[Request interrupted by user]" }])) &&
      !opensTurn(u({}, "[Request interrupted by user for tool use]")));

    const turns = turnsOf(path.join(PROJECTS, "D--work-alpha", "s-alpha.jsonl"));
    check("the alpha fixture splits into three turns", turns.length === 3, turns.map((t) => t.promptAt));
    check("the engine's plugin-message line is stripped from the prompt",
      turns[0].prompt === "[GOAL] The active goal is: Write the widget guide", turns[0].prompt);
    check("the final message is the last main-thread assistant text, never a sidechain reply",
      turns[0].final.startsWith("Section 1 of the widget guide landed.\nThe section covers") && !turns[0].final.includes("subagent"), turns[0].final.slice(0, 80));
    check("the sidechain's calls stay out of the tool ring, and the meta and compaction entries stay inside the first turn",
      same(turns[0].tools.map((t) => t.name), ["Read", "Edit", "Bash", "Agent"]), turns[0].tools.map((t) => t.name));
    check("a sidechain reply call inside the turn sets the turn's reply flag, as the hook's tool.call does for any loop",
      turns[0].sidechainReply === true && turns[2].sidechainReply === false, turns.map((t) => t.sidechainReply));
    const betaTurns = turnsOf(path.join(PROJECTS, "D--work-beta", "s-beta.jsonl"));
    check("a reply call in a subagent transcript inside the turn's window sets the flag",
      betaTurns.length === 2 && betaTurns[0].sidechainReply === true, betaTurns.map((t) => t.sidechainReply));
    check("a subagent reply call outside every turn's window sets no flag",
      betaTurns[1] && betaTurns[1].sidechainReply === false, betaTurns.map((t) => t.sidechainReply));
    check("a turn ends at its last main-thread line, not at the system line after it",
      new Date(turns[0].endMs).toISOString() === "2026-01-01T10:00:00.000Z", new Date(turns[0].endMs).toISOString());
    check("the turn before a call is the latest one whose last line precedes it",
      turnBefore(turns, "2026-01-01T10:05:05.000Z") === turns[1], turnBefore(turns, "2026-01-01T10:05:05.000Z"));
    check("a turn still open at the call is never the one taken",
      turnBefore(turns, "2026-01-01T10:05:09.000Z") === turns[1]);
    check("no turn before the first one ends", turnBefore(turns, "2026-01-01T09:59:30.000Z") === null);
  }

  // --- The tool-activity summary ---
  console.log("\ntool activity");
  {
    const t = (name, input = {}) => ({ name, input });
    check("the flags and ring read as hooks/index.ts turnToolActivityText writes them",
      toolActivityText([
        t("Read", { file_path: "D:\\w\\docs\\plans\\a_spec_v1.md" }),
        t("Edit", { file_path: "docs/plans/a_spec_v1.md" }),
        t("Bash", { command: "git -C D:/w commit -m x && git push" }),
        t("Agent"), t("mcp__agentic-plugin__goal_done"), t("mcp__plugin_relay__reply"),
      ]) === "plan_read=yes plan_edited=yes commit=yes push=yes agent_dispatched=yes goal_done=yes reply=yes work_tools=2 tools=Read,Edit,Bash,Agent,mcp__agentic-plugin__goal_done,mcp__plugin_relay__reply");
    check("an empty turn reads every flag no",
      toolActivityText([]) === "plan_read=no plan_edited=no commit=no push=no agent_dispatched=no goal_done=no reply=no work_tools=0 tools=");
    const ten = Array.from({ length: 10 }, (_, i) => t(`T${i}`));
    check("the ring keeps the last eight names", toolActivityText(ten).endsWith("tools=T2,T3,T4,T5,T6,T7,T8,T9"), toolActivityText(ten));
    check("a document outside docs/plans is not a plan read",
      toolActivityText([t("Read", { file_path: "docs/notes/a.md" })]).startsWith("plan_read=no"));
    check("git log naming the word commit later is not a commit",
      toolActivityText([t("Bash", { command: "git log && echo commit" })]).includes("commit=no"));
    // hooks/index.ts noteTurnToolCall sets both plan flags from
    // namesPlanDocument, which reads the path's own docs/plans suffix; the
    // working-directory match planPathUnderCwd serves route one's promotion
    // alone. So a plan document under another checkout still sets the flags.
    check("a plan document under another checkout still reads as a plan read and a plan edit",
      toolActivityText([t("Read", { file_path: "D:/other/docs/plans/b_spec_v1.md" }), t("Write", { file_path: "E:\\x\\docs\\plans\\b_spec_v1.md" })])
        .startsWith("plan_read=yes plan_edited=yes"));
    check("a reply call off the main thread sets the reply flag without joining the ring",
      toolActivityText([t("Read")], true) === "plan_read=no plan_edited=no commit=no push=no agent_dispatched=no goal_done=no reply=yes work_tools=0 tools=Read",
      toolActivityText([t("Read")], true));
  }

  // --- Admission, the joins and the drops, on the fixture journal ---
  console.log("\nadmission and joins on the fixture");
  {
    const journal = readJournal(JOURNAL);
    const transcripts = indexTranscripts(PROJECTS);
    const ts = buildCandidates(journal, transcripts, "turn-score", "dev");
    check("every call is admitted or counted under exactly one reason",
      ts.admitted + Object.values(ts.dropped).reduce((s, v) => s + v, 0) === journal.calls.length, ts);
    check("the drop reasons are the closed set", same(Object.keys(ts.dropped), DROP_REASONS), Object.keys(ts.dropped));
    check("turn-score admits three and drops by reason as the fixture is built",
      ts.admitted === 3 && same(ts.dropped, { other_site: 3, split: 1, no_answer: 1, state_unresolved: 1, no_transcript_turn: 2, answer_mismatch: 1 }), ts.dropped);
    const byAt = new Map(ts.candidates.map((c) => [c.at, c]));
    const a1 = byAt.get("2026-01-01T10:00:05.000Z");
    const a2 = byAt.get("2026-01-01T10:00:30.000Z");
    const b2 = byAt.get("2026-01-01T11:02:00.000Z");
    check("a sampled null-state call carries the referenced text", a2 && a2.stateReconstructed && a2.state === a1.state);
    check("the hindsight is the next call at the same site and persona, skipping the controller call between",
      a1.hindsight.at === "2026-01-01T10:00:30.000Z" && a1.hindsight.state === a1.state, a1.hindsight);
    check("the hindsight takes a held-out successor too, since it is evidence rather than sample",
      a2.hindsight.at === "2026-01-01T10:06:05.000Z", a2.hindsight);
    check("the hindsight takes a successor whose own turn is not on disk, since it is evidence rather than sample",
      b2.hindsight && b2.hindsight.at === "2026-01-01T11:10:00.000Z", b2.hindsight);
    check("an answer cut at 1,000 characters, and joined by other whitespace than the transcript's, still joins its turn",
      a1 && a1.transcript.finalMessage.startsWith("Section 1 of the widget guide landed.\nThe section covers") && a1.transcript.finalMessage.length > 1000,
      a1 && a1.transcript.finalMessage.length);
    check("a channel-opened turn joins with its prompt", b2.transcript.prompt.includes("Please fix the footer"), b2.transcript);
    check("a call whose own turn is absent, with an earlier turn ended before it, is not admitted",
      !ts.candidates.some((c) => c.at === "2026-01-01T11:10:00.000Z"), ts.candidates.map((c) => c.at));
    check("the tool line carries the sidechain reply of the joined turn",
      a1.transcript.toolActivity.includes("reply=yes") && a1.transcript.toolActivity.endsWith("tools=Read,Edit,Bash,Agent"), a1.transcript.toolActivity);
    check("the stratum is persona and Haiku's value", a2.stratum === "alpha|drift", a2.stratum);
    check("the stratum falls back to Jev's value where Haiku has none", b2.stratum === "beta|off-goal-by-instruction", b2.stratum);

    const cd = buildCandidates(journal, transcripts, "controller-decision", "dev");
    check("the controller call joins its next_score outcome",
      cd.admitted === 1 && same(cd.candidates[0].outcomes.map((o) => [o.kind, o.value]), [["next_score", "drift"]]), cd.candidates[0]);
    const bo = buildCandidates(journal, transcripts, "block-owner", "dev");
    check("the plan-health call joins its block-owner answer rather than the other two",
      bo.admitted === 1 && bo.candidates[0].jev.value === "operator" && bo.candidates[0].haikuValue === null, bo.candidates[0] && bo.candidates[0].jev);
    check("a plan-health call whose closing text is not the joined turn's is counted as an answer mismatch, not a lost transcript",
      bo.dropped.answer_mismatch === 1 && bo.dropped.no_transcript_turn === 0 && bo.candidates[0].at === "2026-01-01T10:00:06.000Z", bo.dropped);
    check("the last call of a persona at a site has no hindsight", bo.candidates[0].hindsight === null, bo.candidates[0].hindsight);

    // Persona identity: one persona spelt in two cases, or under the alias
    // the sampler names, is one persona for the joins, the strata and the cap.
    check("a persona name folds to lower case", personaKey("DEV-DISCORD") === "dev-discord" && personaKey("dev-discord") === "dev-discord");
    check("the named alias folds dev into dev-persona", personaKey("dev") === "dev-persona" && personaKey("DEV-PERSONA") === "dev-persona" && PERSONA_ALIASES.dev === "dev-persona");
    check("control: a persona with no alias keeps its folded name", personaKey("Steward") === "steward");
    const mixed = { ...journal, calls: journal.calls.map((c) => (c.at === "2026-01-01T10:00:30.000Z" ? { ...c, persona: "ALPHA" } : c)) };
    const tm = buildCandidates(mixed, transcripts, "turn-score", "dev");
    const m1 = tm.candidates.find((c) => c.at === "2026-01-01T10:00:05.000Z");
    const m2 = tm.candidates.find((c) => c.at === "2026-01-01T10:00:30.000Z");
    check("the hindsight join crosses a case-only spelling of the persona",
      m1 && m1.hindsight && m1.hindsight.at === "2026-01-01T10:00:30.000Z", m1 && m1.hindsight);
    check("a case-only spelling lands in the same persona and stratum, with its own spelling kept",
      m2 && m2.persona === "alpha" && m2.stratum === "alpha|drift" && m2.personaRaw === "ALPHA", m2 && [m2.persona, m2.stratum, m2.personaRaw]);
    check("the cap counts both spellings as one persona",
      stratify(Array.from({ length: 10 }, (_, i) => ({ stampId: `c${i}`, at: `t${i}`, persona: personaKey(i % 2 ? "P" : "p"), stratum: `${personaKey(i % 2 ? "P" : "p")}|x`, jev: { value: "x", version: "v1" } })), 10, 7).records.length === 4);

    const out = path.join(TMP, "sample-ts");
    const r = run(SAMPLE, ["--question", "turn-score", "--journal", JOURNAL, "--projects", PROJECTS, "--out", out]);
    check("sample.mjs exits 0 on the fixture", r.status === 0, r.stderr);
    const counts = JSON.parse(fs.readFileSync(path.join(out, "counts.json"), "utf8"));
    check("counts.json carries the admission, drop, persona and stratum counts",
      counts.admitted === 3 && counts.sampled === 3 && counts.reconstructedStates === 1 &&
      same(counts.sampledByPersona, { alpha: 2, beta: 1 }), counts);
    const rows = readLines(path.join(out, "sample.jsonl"));
    check("each record id is the question prefix and an eight-digit hash of its stamp id",
      rows.length === 3 && rows.every((x) => x.id === `ts-${fnv1aHash(x.stampId).toString(16).padStart(8, "0")}`), rows.map((x) => [x.id, x.stampId]));
    check("sample.jsonl holds its records in time order", rows[0].at < rows[1].at && rows[1].at < rows[2].at, rows.map((x) => x.at));
    const again = path.join(TMP, "sample-ts-again");
    run(SAMPLE, ["--question", "turn-score", "--journal", JOURNAL, "--projects", PROJECTS, "--out", again]);
    check("a re-run writes the same sample byte for byte",
      fs.readFileSync(path.join(out, "sample.jsonl"), "utf8") === fs.readFileSync(path.join(again, "sample.jsonl"), "utf8"));
  }

  // --- Stratification counts ---
  console.log("\nstratification");
  {
    let k = 0;
    const make = (persona, value, count, jevValue = value) => Array.from({ length: count }, () => {
      k += 1;
      return { stampId: `s${k}`, at: `2026-01-01T00:${String(Math.floor(k / 60)).padStart(2, "0")}:${String(k % 60).padStart(2, "0")}.000Z`, persona, stratum: `${persona}|${value}`, jev: { value: jevValue, version: "v1" } };
    });
    const pool = [...make("p1", "on-goal", 60), ...make("p1", "drift", 20), ...make("p2", "on-goal", 30), ...make("p3", "complete", 3), ...make("p4", "drift", 7)];
    const { records, cap } = stratify(pool, 40, 7);
    const by = (key) => records.filter((r) => r.stratum === key).length;
    const perPersona = (p) => records.filter((r) => r.persona === p).length;
    // Hand-computed: the three-record stratum is taken whole; 37 left split
    // over 117 by largest remainder gives p1 6 drift and 19 on-goal, p2 10,
    // p4 2; p1's cap of 16 cuts its on-goal to 10; the 9 freed split over
    // p2 (room 6) and p4 (room 5) as 7 and 2, p2 capped at 6; the last one
    // goes to p4.
    check("the persona cap is 40 percent of n", cap === 16, cap);
    check("the stratum counts are the hand-computed ones",
      by("p1|drift") === 6 && by("p1|on-goal") === 10 && by("p2|on-goal") === 16 && by("p3|complete") === 3 && by("p4|drift") === 5,
      { p1d: by("p1|drift"), p1o: by("p1|on-goal"), p2: by("p2|on-goal"), p3: by("p3|complete"), p4: by("p4|drift") });
    check("no persona passes the cap", perPersona("p1") <= 16 && perPersona("p2") <= 16, [perPersona("p1"), perPersona("p2")]);
    check("the sample is n where the pool allows it", records.length === 40, records.length);
    check("a small stratum contributes every record", by("p3|complete") === 3);
    check("the same seed draws the same records", same(stratify(pool, 40, 7).records.map((r) => r.stampId), records.map((r) => r.stampId)));
    check("another seed draws other records", !same(stratify(pool, 40, 8).records.map((r) => r.stampId), records.map((r) => r.stampId)));
    check("a pool under n is taken whole, capped per persona",
      stratify(pool.slice(80, 120), 150, 7).records.length === 40, stratify(pool.slice(80, 120), 150, 7).records.length);

    k = 0;
    const bo = [...make("q1", "operator", 8), ...make("q1", "none", 50), ...make("q2", "none", 50), ...make("q3", "self-resolving", 50)];
    const os2 = stratify(bo, 30, 7, { value: "operator", version: "v1", max: 60 });
    check("the oversample takes every operator answer first, up to its max",
      os2.oversampled === 8 && os2.records.filter((r) => r.jev.value === "operator").length === 8, os2.oversampled);
    check("the oversample counts toward its persona's cap",
      os2.records.filter((r) => r.persona === "q1").length <= 12, os2.records.filter((r) => r.persona === "q1").length);
    const capped = stratify([...make("q4", "operator", 70), ...make("q5", "operator", 70)], 150, 7, { value: "operator", version: "v1", max: 60 });
    check("the oversample stops at its max", capped.oversampled === 60, capped.oversampled);
    const small = stratify([...make("q6", "operator", 30), ...make("q7", "none", 30)], 20, 7, { value: "operator", version: "v1", max: 60 });
    check("at a small n the oversample takes no more of one persona than the cap",
      small.cap === 8 && small.oversampled === 8 && small.records.filter((r) => r.persona === "q6").length === 8,
      { cap: small.cap, oversampled: small.oversampled, q6: small.records.filter((r) => r.persona === "q6").length });
  }

  // --- What a labeller sees and what it must return ---
  console.log("\nlabeller input and reply checks");
  {
    // A controller record whose next state records the conversion the
    // controller makes only on Haiku's ask-operator or pause.
    const nowState = "Objective: O\nIdle time: 4min\nDecisions tail: goal:score, monitor:nudge_sent\nMemory: 1 entries (self-review lessons: 0)\n";
    const nextState = "Objective: O\nIdle time: 1min\nDecisions tail: monitor:controller_tick, monitor:ask_idle_gap_converted\nMemory: 1 entries (self-review lessons: 0)\n";
    const rec = { id: "x1", question: "controller-decision", site: "controller", state: nowState, transcript: { prompt: "P", finalMessage: "F", toolActivity: "T" }, outcomes: [{ kind: "next_score", value: "drift", at: "t" }], hindsight: { at: "t", state: nextState }, jev: { value: "JEV-VALUE" }, haikuValue: "HAIKU-VALUE" };
    const view = labellerView(rec);
    check("the controller's hindsight carries no decisions tail, so no Haiku-driven conversion reaches a labeller",
      !view.next_state.includes("Decisions tail") && !view.next_state.includes("ask_idle_gap_converted") &&
      view.next_state === "Objective: O\nIdle time: 1min\nMemory: 1 entries (self-review lessons: 0)\n", view.next_state);
    check("the current state reaches the labeller as Jev saw it, tail included", view.state === nowState, view.state);
    const tsRec = { ...rec, question: "turn-score", site: "turn-score", state: "User asked: p\n\nWorker answered: a\n\nGoal objective: o", hindsight: { at: "t", state: "User asked: q\n\nWorker answered: Decisions tail: b\n\nGoal objective: o" } };
    check("control: a turn-score hindsight is passed whole", labellerView(tsRec).next_state === tsRec.hindsight.state, labellerView(tsRec).next_state);
    check("a labeller sees neither Jev's answer nor Haiku's", !JSON.stringify(view).includes("-VALUE") && !("jev" in view) && !("haikuValue" in view), view);
    check("a labeller sees the state, the transcript fields and the hindsight, and no outcome",
      same(Object.keys(view), ["id", "state", "opening_prompt", "final_message", "tool_activity", "next_state"]) && !JSON.stringify(view).includes("next_score"),
      Object.keys(view));
    check("no rubric names an outcome field to its labeller",
      ["controller-decision", "turn-score", "block-owner"].every((q) => !/outcome|next_speaker|next_score|ask_marker/.test(rubricText(q))),
      ["controller-decision", "turn-score", "block-owner"].filter((q) => /outcome|next_speaker|next_score|ask_marker/.test(rubricText(q))));
    const recs = [{ id: "r1" }, { id: "r2" }];
    const allowed = ["on-goal", "drift"];
    let err = null;
    try { checkBatch(recs, [{ id: "r1", label: "on-goal" }], allowed); } catch (e) { err = e.message; }
    check("a reply missing a record is refused, naming it", err !== null && err.includes("r2"), err);
    err = null;
    try { checkBatch(recs, [{ id: "r1", label: "on-goal" }, { id: "r2", label: "pause" }], allowed); } catch (e) { err = e.message; }
    check("a reply carrying a label the rubric does not offer is refused", err !== null && err.includes("pause"), err);
    err = null;
    try { checkBatch(recs, [{ id: "r1", label: "on-goal" }, { id: "r2", label: "drift" }, { id: "r9", label: "drift" }], allowed); } catch (e) { err = e.message; }
    check("a reply naming a record outside the batch is refused", err !== null && err.includes("r9"), err);
    check("control: a whole reply passes", checkBatch(recs, [{ id: "r2", label: "drift" }, { id: "r1", label: "on-goal" }], allowed).map((l) => l.id).join() === "r1,r2");
    err = null;
    try { checkBatch(recs, [{ id: "r1", label: "on-goal" }, { id: "r2", label: "drift" }, { id: "r1", label: "drift" }], allowed); } catch (e) { err = e.message; }
    check("a reply giving one record two different labels is refused, naming it", err !== null && err.includes("r1") && err.includes("drift"), err);
    check("a reply repeating a record with the same label passes",
      checkBatch(recs, [{ id: "r1", label: "on-goal" }, { id: "r2", label: "drift" }, { id: "r1", label: "on-goal" }], allowed).map((l) => l.label).join() === "on-goal,drift");
  }

  // --- Kappa ---
  console.log("\nkappa");
  {
    const la = ["x", "x", "x", "y", "y", "z", "z", "z", "x", "y"].map((label, i) => ({ id: `r${i}`, label }));
    const lb = ["x", "x", "y", "y", "y", "z", "z", "x", "x", "x"].map((label, i) => ({ id: `r${i}`, label }));
    // Observed 7/10. The marginals differ, a at x4 y3 z3 and b at x5 y3 z2, so
    // chance is 0.4*0.5 + 0.3*0.3 + 0.3*0.2 = 0.35 and kappa is 0.35/0.65 = 7/13.
    const k = cohensKappa(la, lb);
    check("kappa is the hand-computed 7/13", Math.abs(k.kappa - 7 / 13) < 1e-12 && k.n === 10 && k.agree === 7, k);
    check("identical labellings read 1", cohensKappa(la, la).kappa === 1);
    check("the kappa line names the figure, the count and the floor",
      kappaLine("turn-score", k) === "kappa: turn-score 0.538 over 10 records, 7 agree, floor 0.8 not met", kappaLine("turn-score", k));
  }

  // --- The labeller and the adjudicator end to end, on the stub ---
  console.log("\nlabel.mjs and adjudicate.mjs through the stub");
  {
    const dir = path.join(TMP, "label-run");
    const r0 = run(SAMPLE, ["--question", "turn-score", "--journal", JOURNAL, "--projects", PROJECTS, "--out", dir]);
    check("the stub run's sample is built", r0.status === 0, r0.stderr);
    const answersFile = path.join(TMP, "answers.json");
    const log = path.join(TMP, "stub.log");
    const env = {
      JEV_GOLD_LABELLER: STUB, JEV_GOLD_STUB_ANSWERS: answersFile, JEV_GOLD_STUB_LOG: log,
      TYPESAFE_API_KEY: "suite-value-0000000000", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "suite",
    };
    const [id1, id2, id3] = readLines(path.join(dir, "sample.jsonl")).map((x) => x.id);
    // The first record agreed, the second settled by the third labeller, the
    // third a three-way split.
    fs.writeFileSync(answersFile, JSON.stringify({
      [id1]: { a: "on-goal", b: "on-goal", c: "drift" },
      [id2]: { a: "on-goal", b: "drift", c: "drift" },
      [id3]: { a: "on-goal", b: "drift", c: "complete" },
    }));
    const r = run(LABEL, ["--question", "turn-score", "--in", dir], env);
    check("the run prints the labeller command it resolved, once",
      (r.stdout.match(/^labeller command: /gm) || []).length === 1 && r.stdout.includes(STUB), r.stdout.split("\n")[0]);
    check("label.mjs exits 0 when every record comes back", r.status === 0, r.stderr);
    const calls = readLines(log);
    check("one child per labeller for a sample under one batch", calls.length === 2 && calls[0].name === "a" && calls[1].name === "b", calls.map((c) => c.name));
    check("the child runs with exactly the pinned flags and the rubric as its system prompt",
      same(calls[0].argv, ["-p", ...CLI_FLAGS, "--system-prompt", rubricText("turn-score")]), calls[0].argv.slice(0, 16));
    check("the flags keep the child off tools, hooks, MCP servers, slash commands, CLAUDE.md files and session files",
      ["--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--safe-mode"].every((f) => CLI_FLAGS.includes(f)) &&
      CLI_FLAGS[CLI_FLAGS.indexOf("--tools") + 1] === "" && CLI_FLAGS[CLI_FLAGS.indexOf("--settings") + 1] === "{\"disableAllHooks\":true}");
    check("the child's environment carries no vendor key and no parent-session markers",
      calls.every((c) => same(c.envPresent, [])), calls.map((c) => c.envPresent));
    const la = readLines(path.join(dir, "labels-a.jsonl"));
    const lb = readLines(path.join(dir, "labels-b.jsonl"));
    check("both label files hold every sample record, in sample order",
      same(la.map((l) => l.id), [id1, id2, id3]) && same(lb.map((l) => l.id), [id1, id2, id3]));
    const kline = fs.readFileSync(path.join(dir, "kappa.txt"), "utf8").trim();
    check("the kappa line is written and printed", kline.startsWith("kappa: turn-score ") && r.stdout.includes(kline), kline);

    fs.writeFileSync(log, "");
    const r2 = run(ADJUDICATE, ["--question", "turn-score", "--in", dir], env);
    check("adjudicate.mjs exits 0", r2.status === 0, r2.stderr);
    const third = readLines(log);
    check("the third labeller sees the disagreements alone", third.length === 1 && third[0].name === "c");
    const gold = readLines(path.join(dir, "gold.jsonl"));
    check("gold holds the agreed record and the settled one",
      same(gold.map((g) => [g.id, g.label, g.adjudicated]), [[id1, "on-goal", false], [id2, "drift", true]]), gold);
    const splits = readLines(path.join(dir, "splits.jsonl"));
    check("a three-way split is kept out of gold and listed", same(splits.map((s) => s.id), [id3]) && !gold.some((g) => g.id === id3));
    const counts = JSON.parse(r2.stdout.trim().split("\n").pop());
    check("the adjudication counts are printed",
      counts.agreed === 1 && counts.disagreements === 2 && counts.adjudicated === 1 && counts.splits === 1 && counts.gold === 2, counts);

    // A label file left from another sample: its ids miss this sample's.
    const labelsA = path.join(dir, "labels-a.jsonl");
    const kept = fs.readFileSync(labelsA, "utf8");
    fs.writeFileSync(labelsA, kept.split("\n").filter((l) => l.trim() && !l.includes(id2)).join("\n") + "\n" +
      JSON.stringify({ id: "ts-00000000", label: "on-goal" }) + "\n");
    fs.rmSync(path.join(dir, "gold.jsonl"));
    fs.writeFileSync(log, "");
    const stale = run(ADJUDICATE, ["--question", "turn-score", "--in", dir], env);
    check("adjudication fails when a labeller file lacks a sample record, naming it, and runs no labeller",
      stale.status === 1 && stale.stderr.includes(id2) && !fs.existsSync(path.join(dir, "gold.jsonl")) && fs.readFileSync(log, "utf8") === "",
      stale.stderr);
  }

  // --- A reply that drops a record fails the run ---
  console.log("\nrefusals");
  {
    const dir = path.join(TMP, "label-missing");
    run(SAMPLE, ["--question", "turn-score", "--journal", JOURNAL, "--projects", PROJECTS, "--out", dir]);
    const answersFile = path.join(TMP, "answers-missing.json");
    const [, idMissing] = readLines(path.join(dir, "sample.jsonl")).map((x) => x.id);
    fs.writeFileSync(answersFile, JSON.stringify({ "*": { a: "on-goal", b: "on-goal" }, [idMissing]: { a: null } }));
    const env = { JEV_GOLD_LABELLER: STUB, JEV_GOLD_STUB_ANSWERS: answersFile };
    const r = run(LABEL, ["--question", "turn-score", "--in", dir], env);
    check("a labeller reply missing a record fails the run", r.status === 1, r.status);
    check("the failure names the labeller, the batch and the record",
      r.stderr.includes("labeller a batch 1") && r.stderr.includes(`missing 1 record(s): ${idMissing}`), r.stderr);
    check("a failed run writes no label file", !fs.existsSync(path.join(dir, "labels-a.jsonl")) && !fs.existsSync(path.join(dir, "kappa.txt")));
    check("control: the same answers with the record present pass",
      (fs.writeFileSync(answersFile, JSON.stringify({ "*": { a: "on-goal", b: "on-goal" } })), run(LABEL, ["--question", "turn-score", "--in", dir], env).status === 0));

    fs.writeFileSync(answersFile, JSON.stringify({ "*": { a: "on-goal", b: "pause" } }));
    const rl = run(LABEL, ["--question", "turn-score", "--in", dir], env);
    check("a label outside the rubric fails the run, naming the batch",
      rl.status === 1 && rl.stderr.includes("labeller b batch 1") && rl.stderr.includes("pause"), rl.stderr);

    fs.writeFileSync(answersFile, JSON.stringify({ "*": { a: "on-goal", b: "on-goal" } }));
    const slow = run(LABEL, ["--question", "turn-score", "--in", dir], { ...env, JEV_GOLD_TIMEOUT_MS: "1500", JEV_GOLD_STUB_SLEEP_MS: "6000" });
    check("a batch that times out twice fails the run, naming the batch",
      slow.status === 1 && slow.stderr.includes("labeller a batch 1") && slow.stderr.includes("timed out twice") &&
      (slow.stdout.match(/timed out after 1500 ms/g) || []).length === 2, [slow.stdout, slow.stderr]);
    const onceFile = path.join(TMP, "slept-once");
    const retried = run(LABEL, ["--question", "turn-score", "--in", dir], { ...env, JEV_GOLD_TIMEOUT_MS: "1500", JEV_GOLD_STUB_SLEEP_MS: "6000", JEV_GOLD_STUB_SLEEP_ONCE: onceFile });
    check("a batch that times out once is retried and the run completes",
      retried.status === 0 && (retried.stdout.match(/timed out after 1500 ms on attempt 1/g) || []).length === 1, [retried.stdout, retried.stderr]);

    const flood = run(LABEL, ["--question", "turn-score", "--in", dir], { ...env, JEV_GOLD_STUB_FLOOD: "1" });
    check("a child killed for another reason than the timeout fails the run at once, naming the reason",
      flood.status === 1 && flood.stderr.includes("labeller a batch 1") && /ENOBUFS|maxBuffer/i.test(flood.stderr) && !flood.stdout.includes("timed out"),
      [flood.stdout.slice(-300), flood.stderr.slice(0, 300)]);

    const dirAdj = path.join(TMP, "adjudicate-missing");
    run(SAMPLE, ["--question", "turn-score", "--journal", JOURNAL, "--projects", PROJECTS, "--out", dirAdj]);
    const idAdj = readLines(path.join(dirAdj, "sample.jsonl"))[2].id;
    fs.writeFileSync(answersFile, JSON.stringify({ "*": { a: "on-goal", b: "drift", c: "drift" }, [idAdj]: { c: null } }));
    run(LABEL, ["--question", "turn-score", "--in", dirAdj], env);
    const ra = run(ADJUDICATE, ["--question", "turn-score", "--in", dirAdj], env);
    check("a third labeller reply missing a record fails adjudication, naming the batch",
      ra.status === 1 && ra.stderr.includes("labeller c batch 1") && ra.stderr.includes(idAdj) && !fs.existsSync(path.join(dirAdj, "gold.jsonl")), ra.stderr);
  }

  // --- The scorer: accuracy, precision, recall, calibration, agreement, AUC, bars ---
  console.log("\nscore.mjs against a hand-computed fixture");
  {
    // Five controller-decision records. r5 is gold-unclear and stays out of
    // every accuracy denominator. r2's Jev answer of pause is folded to
    // ask-operator before it is compared to gold or to Haiku's ask-operator.
    const cdRecords = [
      { id: "r1", question: "controller-decision", label: "nudge", value: "nudge",
        probabilities: { nudge: 0.9, "ask-operator": 0.05, complete: 0.03, switch: 0.02 },
        haikuValue: "nudge", outcomes: [{ kind: "next_score", value: "on-goal" }] },
      { id: "r2", question: "controller-decision", label: "ask-operator", value: "pause",
        probabilities: { nudge: 0.1, "ask-operator": 0.7, complete: 0.1, switch: 0.1 },
        haikuValue: "pause", outcomes: [{ kind: "next_score", value: "drift" }] },
      { id: "r3", question: "controller-decision", label: "complete", value: "complete",
        probabilities: { nudge: 0.1, "ask-operator": 0.1, complete: 0.75, switch: 0.05 },
        haikuValue: null, outcomes: [{ kind: "next_score", value: "complete" }] },
      { id: "r4", question: "controller-decision", label: "nudge", value: "ask-operator",
        probabilities: { nudge: 0.3, "ask-operator": 0.5, complete: 0.1, switch: 0.1 },
        haikuValue: "nudge", outcomes: [] },
      { id: "r5", question: "controller-decision", label: "unclear", value: "nudge",
        probabilities: { nudge: 0.99, "ask-operator": 0.005, complete: 0.003, switch: 0.002 },
        haikuValue: "nudge", outcomes: [] },
    ];
    check("pause folds to ask-operator on controller-decision only",
      foldedValue("controller-decision", "pause") === "ask-operator" && foldedValue("turn-score", "pause") === "pause");
    check("top probability is the max of the probabilities carried",
      topProbability(cdRecords[0].probabilities) === 0.9 && topProbability({}) === null);
    check("an unclear gold record is outside scorable",
      scorable(cdRecords).length === 4 && !scorable(cdRecords).some((r) => r.label === "unclear"));
    // Hand-computed: r1 nudge/nudge, r2 pause->ask-operator/ask-operator, r3
    // complete/complete all correct; r4 ask-operator predicted against a
    // nudge label is wrong; r5 is unclear. 3 of 4 scorable.
    check("accuracy folds pause and excludes unclear",
      same(accuracyOf(cdRecords, "controller-decision"), { correct: 3, n: 4, accuracy: 0.75 }), accuracyOf(cdRecords, "controller-decision"));
    const pr = precisionRecallOf(cdRecords, "controller-decision");
    check("precision and recall are the hand-computed ones",
      same(pr.nudge, { tp: 1, fp: 0, fn: 1, precision: 1, recall: 0.5 }) &&
      same(pr["ask-operator"], { tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1 }) &&
      same(pr.complete, { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 }), pr);
    check("a confusion row is gold label to predicted-value counts, pause folded",
      same(confusionOf(cdRecords, "controller-decision"), { nudge: { nudge: 1, "ask-operator": 1 }, "ask-operator": { "ask-operator": 1 }, complete: { complete: 1 } }),
      confusionOf(cdRecords, "controller-decision"));
    // Haiku's own read against gold, same fold and exclusion, over the rows
    // carrying a Haiku value (r1, r2, r4; r3's is null, r5 is unclear).
    // Hand-computed: r1 nudge/nudge, r2 pause->ask-operator/ask-operator, r4
    // nudge/nudge are all correct against gold (r4's Jev answer was wrong,
    // Haiku's own was not), so Haiku's accuracy here is a perfect 3/3, the
    // shape the "whose error" question needs Jev's own 3/4 read against.
    check("Haiku's own accuracy against gold folds pause and excludes unclear",
      same(haikuAccuracyOf(cdRecords, "controller-decision"), { correct: 3, n: 3, accuracy: 1 }), haikuAccuracyOf(cdRecords, "controller-decision"));
    check("Haiku's own confusion is gold label to Haiku's predicted-value counts, pause folded",
      same(haikuConfusionOf(cdRecords, "controller-decision"), { nudge: { nudge: 2 }, "ask-operator": { "ask-operator": 1 } }),
      haikuConfusionOf(cdRecords, "controller-decision"));
    check("Haiku's own precision and recall are the hand-computed ones",
      same(haikuPrecisionRecallOf(cdRecords, "controller-decision"), {
        nudge: { tp: 2, fp: 0, fn: 0, precision: 1, recall: 1 },
        "ask-operator": { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 },
      }), haikuPrecisionRecallOf(cdRecords, "controller-decision"));
    check("a question with no Haiku value at all, as every block-owner record carries, reads null for Haiku's own three",
      haikuAccuracyOf([{ label: "operator", value: "operator", haikuValue: null }], "block-owner") === null &&
      haikuConfusionOf([{ label: "operator", value: "operator", haikuValue: null }], "block-owner") === null &&
      haikuPrecisionRecallOf([{ label: "operator", value: "operator", haikuValue: null }], "block-owner") === null);
    // The raw, unfolded accuracy the spec asks to print beside the folded
    // one, for controller-decision alone: unfolded, r2's raw "pause" never
    // equals its "ask-operator" gold label, so it turns from a fold-corrected
    // hit into a miss; r1 and r3 are unaffected by the fold and stay correct,
    // r4 is wrong either way, reading 2/4 against the folded read's 3/4.
    // Unfolded on Haiku's own column, r2's raw "pause" is the same miss, so
    // only r1 and r4 stay correct, reading 2/3 against Haiku's folded 3/3.
    check("the unfolded accuracy is read separately for Jev's own column and Haiku's, and only for controller-decision",
      same(unfoldedAccuracyOf(cdRecords, "controller-decision", (r) => r.value), { correct: 2, n: 4, accuracy: 0.5 }) &&
      same(unfoldedAccuracyOf(cdRecords, "controller-decision", (r) => r.haikuValue), { correct: 2, n: 3, accuracy: 2 / 3 }) &&
      unfoldedAccuracyOf(cdRecords, "turn-score", (r) => r.value) === null, {
        jev: unfoldedAccuracyOf(cdRecords, "controller-decision", (r) => r.value),
        haiku: unfoldedAccuracyOf(cdRecords, "controller-decision", (r) => r.haikuValue),
      });
    const bins = calibrationOf(cdRecords, "controller-decision");
    // Hand-computed top probabilities: r1 0.9 (bin 4), r2 0.7 and r3 0.75
    // (bin 3, both correct), r4 0.5 (bin 2, wrong), r5 0.99 (bin 4, unclear
    // so it counts toward the bin's n but not its accuracy).
    check("calibration bins carry the hand-computed n, confidence and accuracy",
      bins[2].n === 1 && bins[2].accuracy === 0 && Math.abs(bins[2].avgConfidence - 0.5) < 1e-9 &&
      bins[3].n === 2 && bins[3].accuracy === 1 && Math.abs(bins[3].avgConfidence - 0.725) < 1e-9 &&
      bins[4].n === 2 && bins[4].accuracy === 1 && Math.abs(bins[4].avgConfidence - 0.945) < 1e-9 &&
      bins[0].n === 0 && bins[0].accuracy === null,
      bins);
    // A record at exactly 0.6, the value that misbinned on plain float
    // division (0.6 / 0.2 evaluates to 2.9999999999999996, one bin short),
    // lands in [0.6, 0.8), the same bin barRows's own p >= 0.6 comparison
    // and coverageOf's own count place it in.
    const edgeRecords = cdRecords.concat([{ id: "r6", question: "controller-decision", label: "nudge", value: "nudge",
      probabilities: { nudge: 0.6, "ask-operator": 0.2, complete: 0.1, switch: 0.1 }, haikuValue: null, outcomes: [] }]);
    const edgeBins = calibrationOf(edgeRecords, "controller-decision");
    check("a top probability of exactly 0.6 lands in the 0.6-0.8 bin, matching the 0.6 floor",
      edgeBins[3].n === 3 && edgeBins[2].n === 1, edgeBins.map((b) => b.n));
    // Hand-computed: r1, r2, r4 carry a Haiku value (r3's is null and is
    // left out); r1 and r2 agree once pause is folded, r4 does not.
    check("agreement with Haiku folds pause and skips a null Haiku value",
      same(agreementOf(cdRecords, "controller-decision"), { agree: 2, n: 3, agreement: 2 / 3 }), agreementOf(cdRecords, "controller-decision"));
    check("the outcome kinds present are read off every record's own list",
      same(outcomeKindsPresent(cdRecords), ["next_score"]));
    // Hand-computed: next_score is "complete" only for r3, whose own
    // probability of "complete" (0.75) outranks r1's and r2's (0.03, 0.1), so
    // the rank-sum AUC is 1. r4 and r5 carry no next_score outcome and are
    // left out of the ranking entirely.
    const aucComplete = aucOf(cdRecords, "controller-decision", "complete", "next_score");
    check("AUC against next_score on complete is the hand-computed 1.0, over the 3 records carrying the outcome",
      aucComplete && aucComplete.auc === 1 && aucComplete.positives === 1 && aucComplete.negatives === 2 && aucComplete.n === 3, aucComplete);
    check("AUC reads null where the outcome's values never carry the option's own id",
      aucOf(cdRecords, "controller-decision", "nudge", "next_score") === null);
    check("AUC reads null for an outcome kind the sample never carries",
      aucOf(cdRecords, "controller-decision", "complete", "next_speaker") === null);
    // Every option a record's own call offered gets an AUC line, not just the
    // ones Jev actually picked: no cdRecords row ever chose switch, but every
    // row's call offered it, so its probability is on the record and the
    // report still lists it.
    const cdReport = report("controller-decision", "dev", new Map([["v1", cdRecords]]));
    const nextScoreBlock = cdReport.split("AUC against next_score:")[1].split("\nbar:")[0];
    check("the AUC block lists an option no record ever chose, since every record's own call offered it",
      /\n {2}switch: /.test(nextScoreBlock), nextScoreBlock);

    // ask-operator's own AUC folds pause's probability into it, the way its
    // accuracy read does: f1 (true) scores 0.1 alone on ask-operator, under
    // f2's (false) 0.5, so an unfolded AUC would rank the positive last and
    // read 0; folded, f1's 0.1 + 0.6 pause = 0.7 outranks f2's 0.5 + 0.0, and
    // the AUC is the hand-computed 1.0.
    const foldRecords = [
      { id: "f1", question: "controller-decision", label: "x", value: "pause",
        probabilities: { nudge: 0.2, "ask-operator": 0.1, pause: 0.6, complete: 0.1 },
        haikuValue: null, outcomes: [{ kind: "test_outcome", value: "ask-operator" }] },
      { id: "f2", question: "controller-decision", label: "x", value: "ask-operator",
        probabilities: { nudge: 0.2, "ask-operator": 0.5, pause: 0, complete: 0.3 },
        haikuValue: null, outcomes: [{ kind: "test_outcome", value: "nudge" }] },
    ];
    const aucFold = aucOf(foldRecords, "controller-decision", "ask-operator", "test_outcome");
    check("ask-operator's AUC scores on ask-operator's probability plus pause's, under the same fold its accuracy read takes",
      aucFold && aucFold.auc === 1, aucFold);
    check("control: the same two records score the reverse without the fold, so the fold is what makes the AUC 1",
      (foldRecords[0].probabilities["ask-operator"] < foldRecords[1].probabilities["ask-operator"]));

    // A tied pair exercises the rank-averaging branch: two records score
    // identically on "complete" against next_score, one true (outcome
    // "complete") and one false (outcome "drift"). Tied at rank 1.5 each
    // (both share ranks 1 and 2), the positive's rank sum is 1.5 against a
    // single negative, giving AUC (1.5 - 1) / 1 = 0.5, neither 1 nor 0.
    const tieRecords = [
      { id: "g1", question: "controller-decision", label: "x", value: "complete",
        probabilities: { nudge: 0.1, "ask-operator": 0.1, complete: 0.4, switch: 0.4 },
        haikuValue: null, outcomes: [{ kind: "next_score", value: "complete" }] },
      { id: "g2", question: "controller-decision", label: "x", value: "nudge",
        probabilities: { nudge: 0.4, "ask-operator": 0.1, complete: 0.4, switch: 0.1 },
        haikuValue: null, outcomes: [{ kind: "next_score", value: "drift" }] },
    ];
    const aucTie = aucOf(tieRecords, "controller-decision", "complete", "next_score");
    check("a tied pair of scores is split evenly between them, reading the hand-computed 0.5",
      aucTie && Math.abs(aucTie.auc - 0.5) < 1e-9, aucTie);

    // Sections 3 and 4 gate a per-option recall bar on gold actually holding
    // ten of the option; below that it is not applicable, not failed.
    // block-owner's own operator bars carry no such gate.
    check("only the per-option recall bars carry the conditional gate, never accuracy or block-owner's",
      BARS["controller-decision"][0].conditional === undefined &&
      BARS["controller-decision"][1].conditional === true &&
      BARS["turn-score"].every((b) => b.key === "accuracy" ? b.conditional === undefined : b.conditional === true) &&
      BARS["block-owner"].every((b) => b.conditional === undefined));
    const completeRecord = (id, correct) => ({
      id, question: "controller-decision", label: "complete", value: correct ? "complete" : "nudge",
      probabilities: correct
        ? { nudge: 0.05, "ask-operator": 0.05, complete: 0.85, switch: 0.05 }
        : { nudge: 0.85, "ask-operator": 0.05, complete: 0.05, switch: 0.05 },
      haikuValue: null, outcomes: [],
    });
    const recallCompleteBar = BARS["controller-decision"].find((b) => b.key === "recall:complete");
    check("the conditional recall bars carry the spec's own ten-record gold-count floor",
      recallCompleteBar.countFloor === DEFAULT_RECALL_COUNT_FLOOR && DEFAULT_RECALL_COUNT_FLOOR === 10);
    const fewComplete = Array.from({ length: 3 }, (_, i) => completeRecord(`fc${i}`, true));
    check("a per-option recall bar below its gold-count floor reads n/a rather than not met",
      evalBar(recallCompleteBar, "controller-decision", "v1", fewComplete, "dev") ===
        "bar: controller-decision:recall:complete v1 n/a (gold holds 3) over 3 on dev, coverage 1.000 over 3",
      evalBar(recallCompleteBar, "controller-decision", "v1", fewComplete, "dev"));
    const tenLowRecall = [...Array.from({ length: 3 }, (_, i) => completeRecord(`lr${i}`, true)), ...Array.from({ length: 7 }, (_, i) => completeRecord(`lw${i}`, false))];
    check("control: at or above the gold-count floor, a real miss still reads not met",
      evalBar(recallCompleteBar, "controller-decision", "v1", tenLowRecall, "dev") ===
        "bar: controller-decision:recall:complete v1 not met 0.300 over 10 on dev, coverage 1.000 over 10",
      evalBar(recallCompleteBar, "controller-decision", "v1", tenLowRecall, "dev"));
    const tenHighRecall = [...Array.from({ length: 8 }, (_, i) => completeRecord(`hr${i}`, true)), ...Array.from({ length: 2 }, (_, i) => completeRecord(`hw${i}`, false))];
    check("control: at or above the gold-count floor, a real pass reads met",
      evalBar(recallCompleteBar, "controller-decision", "v1", tenHighRecall, "dev") ===
        "bar: controller-decision:recall:complete v1 met 0.800 over 10 on dev, coverage 1.000 over 10",
      evalBar(recallCompleteBar, "controller-decision", "v1", tenHighRecall, "dev"));

    // block-owner's next_speaker mapping, this document's own scoring rule:
    // operator is true where next_speaker is channel.
    const boRecords = [
      { id: "b1", question: "block-owner", label: "operator", value: "operator",
        probabilities: { operator: 0.8, coordinator: 0.1, "another-plan": 0.05, "self-resolving": 0.03, none: 0.02 },
        haikuValue: null, outcomes: [{ kind: "next_speaker", value: "channel" }] },
      { id: "b2", question: "block-owner", label: "self-resolving", value: "self-resolving",
        probabilities: { operator: 0.1, coordinator: 0.05, "another-plan": 0.05, "self-resolving": 0.7, none: 0.1 },
        haikuValue: null, outcomes: [{ kind: "next_speaker", value: "neither" }] },
      { id: "b3", question: "block-owner", label: "coordinator", value: "coordinator",
        probabilities: { operator: 0.2, coordinator: 0.5, "another-plan": 0.2, "self-resolving": 0.05, none: 0.05 },
        haikuValue: null, outcomes: [{ kind: "next_speaker", value: "delivery" }] },
    ];
    const aucOperator = aucOf(boRecords, "block-owner", "operator", "next_speaker");
    check("AUC against next_speaker on operator applies the stated mapping and reads the hand-computed 1.0",
      aucOperator && aucOperator.auc === 1 && aucOperator.positives === 1 && aucOperator.negatives === 2, aucOperator);
    check("agreement with Haiku is n/a where no record carries one, as block-owner's own calls do",
      agreementOf(boRecords, "block-owner").agreement === null);

    // A bar line reads not met when the count floor is unmet, whatever the
    // figure. b3's own top probability (0.5) falls under the bar's 0.6
    // floor and is filtered out before the count is taken, so only b1's one
    // operator-labelled row remains, a perfect 1.0 on both precision and
    // recall, well under the 40-record floor.
    const operatorBars = BARS["block-owner"];
    check("the block-owner bars are precision and recall on operator, gated at the named count floor",
      same(operatorBars.map((b) => b.key), ["precision:operator", "recall:operator"]) &&
      operatorBars.every((b) => b.countFloor === BLOCK_OWNER_OPERATOR_COUNT_FLOOR));
    for (const bar of operatorBars) {
      const line = evalBar(bar, "block-owner", "v1", boRecords, "dev");
      check(`bar ${bar.key} reads not met under the count floor although the figure is 1.000`,
        line === `bar: block-owner:${bar.key} v1 not met 1.000 over 1 on dev, coverage 0.667 over 3`, line);
    }
    // b3's own top probability (0.5) is under the coverage floor's own
    // filter too, so of the 3 scorable rows only 2 clear it: coverage 0.667,
    // under the 0.7 floor. A bar whose figure and count both clear their own
    // thresholds still reads not met on coverage alone.
    check("coverageOf reads the hand-computed share of scorable gold at or above the top-probability floor",
      same(coverageOf(boRecords, "block-owner"), { total: 3, above: 2, coverage: 2 / 3 }), coverageOf(boRecords, "block-owner"));
    // Isolates the count floor from the coverage floor: five operator
    // records, all confident, all at or above 0.6, so coverage is a full
    // 1.000, well past the 0.7 floor, yet the count (5) is still under the
    // 40-record floor. With coverage held clear, only the count floor can be
    // the reason this reads not met.
    const fiveConfidentOperators = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`, question: "block-owner", label: "operator", value: "operator",
      probabilities: { operator: 0.9, coordinator: 0.025, "another-plan": 0.025, "self-resolving": 0.025, none: 0.025 },
      haikuValue: null, outcomes: [{ kind: "next_speaker", value: "channel" }],
    }));
    check("coverage alone does not pass a bar the count floor still fails",
      same(coverageOf(fiveConfidentOperators, "block-owner"), { total: 5, above: 5, coverage: 1 }) &&
      evalBar(BARS["block-owner"][1], "block-owner", "v1", fiveConfidentOperators, "dev") ===
        "bar: block-owner:recall:operator v1 not met 1.000 over 5 on dev, coverage 1.000 over 5",
      evalBar(BARS["block-owner"][1], "block-owner", "v1", fiveConfidentOperators, "dev"));
    // Control: the same records padded past the floor with clear negatives
    // read met, so the not-met line above is the floor and not a bug in the
    // metric.
    const padded = boRecords.concat(Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`, question: "block-owner", label: "operator", value: "operator",
      probabilities: { operator: 0.9, coordinator: 0.025, "another-plan": 0.025, "self-resolving": 0.025, none: 0.025 },
      haikuValue: null, outcomes: [{ kind: "next_speaker", value: "channel" }],
    })));
    const paddedLine = evalBar(operatorBars[1], "block-owner", "v1", padded, "dev");
    check("control: the same bar reads met once its own count and its coverage both pass their floors",
      paddedLine.startsWith("bar: block-owner:recall:operator v1 met 1.000 over 41 on dev, coverage 0.977 over 43"), paddedLine);
    check("the top-probability and coverage floors are the spec's own 0.6 and 0.7",
      TOP_PROBABILITY_FLOOR === 0.6 && COVERAGE_FLOOR === 0.7);

    // --- The scorer's own join and CLI, over small on-disk files ---
    const scoreDir = path.join(TMP, "score-cli");
    fs.mkdirSync(scoreDir, { recursive: true });
    const goldRows = [
      { id: "cd-1", stampId: "s1", question: "controller-decision", persona: "p", split: "dev", label: "nudge", adjudicated: false, labels: { a: "nudge", b: "nudge" } },
      { id: "cd-2", stampId: "s2", question: "controller-decision", persona: "p", split: "dev", label: "complete", adjudicated: false, labels: { a: "complete", b: "complete" } },
    ];
    const sampleRows = [
      { id: "cd-1", stampId: "s1", jev: { version: "v1", value: "nudge", probabilities: { nudge: 0.9, "ask-operator": 0.05, complete: 0.03, switch: 0.02 } }, haikuValue: "nudge", outcomes: [] },
      { id: "cd-2", stampId: "s2", jev: { version: "v1", value: "complete", probabilities: { nudge: 0.1, "ask-operator": 0.1, complete: 0.75, switch: 0.05 } }, haikuValue: null, outcomes: [] },
    ];
    fs.writeFileSync(path.join(scoreDir, "gold.jsonl"), goldRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(path.join(scoreDir, "sample.jsonl"), sampleRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const joined = joinGoldSample("controller-decision", readGold(path.join(scoreDir, "gold.jsonl")), sampleById(scoreDir));
    check("the join carries the sample's version, value, probabilities and outcomes onto each gold row",
      joined.length === 2 && joined[0].version === "v1" && joined[0].value === "nudge" && joined[1].haikuValue === null, joined);
    fs.writeFileSync(path.join(scoreDir, "gold-stray.jsonl"), JSON.stringify({ id: "cd-9", stampId: "s9", question: "controller-decision", persona: "p", split: "dev", label: "nudge", adjudicated: false, labels: {} }) + "\n");
    let joinErr = null;
    try { joinGoldSample("controller-decision", readGold(path.join(scoreDir, "gold-stray.jsonl")), sampleById(scoreDir)); } catch (e) { joinErr = e.message; }
    check("a gold id missing from sample.jsonl fails the join, naming it", joinErr !== null && joinErr.includes("cd-9"), joinErr);

    const SCORE = path.join(HERE, "jev-gold", "score.mjs");
    const cliOut = run(SCORE, ["--question", "controller-decision", "--gold", path.join(scoreDir, "gold.jsonl")]);
    check("score.mjs exits 0 and prints the version header, accuracy and a bar line",
      cliOut.status === 0 && cliOut.stdout.includes("== controller-decision v1 (n=2) ==") &&
      cliOut.stdout.includes("accuracy: 1.000 (2/2)") && cliOut.stdout.includes("bar: controller-decision:accuracy v1 not met"),
      cliOut.stdout);
    check("score.mjs prints Haiku's own accuracy, confusion and precision/recall against gold",
      cliOut.stdout.includes("Haiku accuracy against gold: 1.000 (1/1)") &&
      cliOut.stdout.includes("Haiku confusion (gold row, predicted columns):") &&
      cliOut.stdout.includes("Haiku precision and recall:"),
      cliOut.stdout);
    check("calibration bins print half-open except the last, which is closed",
      cliOut.stdout.includes("[0.6, 0.8):") && cliOut.stdout.includes("[0.8, 1.0]:"), cliOut.stdout);

    // withReplay: a v2 answer replaces the record's value under a new
    // version key, and a replay failure is excluded rather than scored.
    const replayed = withReplay(joined, [
      { id: "cd-1", version: "v2", ok: true, value: "complete", probabilities: { nudge: 0.01, "ask-operator": 0.01, complete: 0.97, switch: 0.01 } },
      { id: "cd-2", version: "v2", ok: false, reason: "timeout", detail: null },
      { id: "no-such-id", version: "v2", ok: true, value: "nudge", probabilities: {} },
    ]);
    check("withReplay carries only the ok records, under the replay's own version, and drops a stray id",
      replayed.records.length === 1 && replayed.records[0].version === "v2" && replayed.records[0].value === "complete" && replayed.failed === 1 && replayed.missing === 0,
      replayed);
    const partialReplay = withReplay(joined, [{ id: "cd-1", version: "v2", ok: true, value: "complete", probabilities: {} }]);
    check("withReplay counts a gold id the replay file never mentions at all as missing, beside failed",
      partialReplay.missing === 1 && partialReplay.failed === 0, partialReplay);
    let dupErr = null;
    try {
      withReplay(joined, [
        { id: "cd-1", version: "v2", ok: true, value: "complete", probabilities: {} },
        { id: "cd-1", version: "v2", ok: true, value: "nudge", probabilities: {} },
      ]);
    } catch (e) { dupErr = e.message; }
    check("withReplay refuses a replay file carrying two rows for one id, naming it", dupErr !== null && dupErr.includes("cd-1"), dupErr);

    // A v1 replay is keyed apart from the journal's own v1 group rather than
    // overwriting it, and a failed replay record is noted and excluded.
    fs.writeFileSync(path.join(scoreDir, "replay.jsonl"), [
      JSON.stringify({ id: "cd-1", version: "v1", ok: true, value: "complete", probabilities: { nudge: 0.02, "ask-operator": 0.02, complete: 0.94, switch: 0.02 } }),
      JSON.stringify({ id: "cd-2", version: "v1", ok: false, reason: "timeout", detail: null }),
    ].join("\n") + "\n");
    const replayCli = run(SCORE, ["--question", "controller-decision", "--gold", path.join(scoreDir, "gold.jsonl"), "--replay", path.join(scoreDir, "replay.jsonl")]);
    check("score.mjs prints a v1 replay beside the v1 baseline, under its own header, rather than replacing it",
      replayCli.status === 0 &&
      replayCli.stdout.includes("== controller-decision v1 (replay) (n=1) ==") &&
      replayCli.stdout.includes("note: 1 replay record(s) failed and are excluded from every figure"),
      replayCli.stdout);
    // The same turns: the failed replay record leaves cd-2 out of the replay's
    // group, so the baseline is read on cd-1 alone, the restriction and its
    // count are printed, and the baseline over both of its records stays
    // beside it, labelled.
    check("with a replay, every version is read on the records every version scored, and the count is printed",
      replayCli.stdout.includes("== controller-decision v1 (n=1) ==")
        && replayCli.stdout.includes("note: every version is read on the 1 gold record(s) every present version scored"),
      replayCli.stdout);
    check("with a replay, the unrestricted baseline is printed beside it under its label",
      replayCli.stdout.includes("== controller-decision v1 (all records) (n=2) =="), replayCli.stdout);
    const shared = onSharedRecords(new Map([
      ["v1", [{ id: "a" }, { id: "b" }, { id: "c" }]],
      ["v2 (replay)", [{ id: "b" }, { id: "c" }, { id: "d" }]],
    ]));
    check("onSharedRecords keeps in every group only the ids every group carries",
      shared.shared === 2 && same(shared.groups.get("v1").map((r) => r.id), ["b", "c"]) && same(shared.groups.get("v2 (replay)").map((r) => r.id), ["b", "c"]),
      { shared: shared.shared, v1: shared.groups.get("v1").map((r) => r.id) });
    // Without a replay, nothing is restricted and no note is printed.
    const plainCli = run(SCORE, ["--question", "controller-decision", "--gold", path.join(scoreDir, "gold.jsonl")]);
    check("without a replay, the baseline is read over all of its records and no restriction note is printed (control)",
      plainCli.status === 0 && plainCli.stdout.includes("== controller-decision v1 (n=2) ==") && !plainCli.stdout.includes("every present version scored"),
      plainCli.stdout);

    // score.mjs refuses gold whose rows mix splits rather than printing one
    // split's name over records drawn from more than one.
    fs.writeFileSync(path.join(scoreDir, "gold-mixed.jsonl"), [
      JSON.stringify({ id: "cd-1", stampId: "s1", question: "controller-decision", persona: "p", split: "dev", label: "nudge", adjudicated: false, labels: {} }),
      JSON.stringify({ id: "cd-2", stampId: "s2", question: "controller-decision", persona: "p", split: "holdout", label: "complete", adjudicated: false, labels: {} }),
    ].join("\n") + "\n");
    const mixedCli = run(SCORE, ["--question", "controller-decision", "--gold", path.join(scoreDir, "gold-mixed.jsonl")]);
    check("score.mjs refuses gold that mixes splits, naming them",
      mixedCli.status !== 0 && mixedCli.stderr.includes("dev") && mixedCli.stderr.includes("holdout"), mixedCli.stderr);
  }

  // --- The replay: request shape and failure handling, against a stub host ---
  console.log("\nreplay.mjs against a stub host");
  {
    const stubHost = (fetchImpl, overrides = {}) => ({
      getApiKey: async () => "stub-key-0000000000000000",
      getHome: async () => undefined,
      readFile: async () => { throw new Error("not used in these cases"); },
      fileExists: async () => false,
      sleep: async () => {},
      fetch: fetchImpl,
      ...overrides,
    });
    const choiceReply = (idOf, choiceOf) => async (url, init) => {
      const body = JSON.parse(init.body);
      const answers = {};
      for (const [qid, q] of Object.entries(body.questions)) {
        if (q.type === "choice") {
          const ids = Object.keys(q.criteria);
          const chosen = choiceOf ? choiceOf(qid, ids) : ids[0];
          const probabilities = Object.fromEntries(ids.map((id) => [id, id === chosen ? 0.9 : 0.1 / (ids.length - 1)]));
          answers[qid] = { type: "choice", choice: chosen, probabilities, confidence: 0.8 };
        } else if (q.type === "noul") {
          answers[qid] = { type: "noul", noul: 0.5 };
        } else if (q.type === "score") {
          answers[qid] = { type: "score", score: 1, probabilities: { 0: 0.2, 1: 0.6, 2: 0.2 }, confidence: 0.7 };
        }
      }
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers, model: "jev-latest", usage: {}, __sentBody: body }) };
    };

    // offeredOptionIds recovers the v1 set an individual call actually
    // offered from its own probability keys, since the seam refuses any key
    // outside the ids it sent.
    check("offeredOptionIds reads the controller's own set back off its probability keys, without switch",
      same(offeredOptionIds("controller-decision", { id: "x", jev: { probabilities: { nudge: 0.1, pause: 0.1, complete: 0.1, "ask-operator": 0.7 } } }), catalog.CONTROLLER_LABELS));
    check("offeredOptionIds recovers switch the same way, with no state text to read",
      same(offeredOptionIds("controller-decision", { id: "x", jev: { probabilities: { nudge: 0.1, pause: 0.1, complete: 0.1, "ask-operator": 0.1, switch: 0.6 } } }), catalog.CONTROLLER_LABELS_WITH_SWITCH));
    check("offeredOptionIds reads turn-score's narrower nudged set the same way",
      same(offeredOptionIds("turn-score", { id: "x", jev: { probabilities: { "on-goal": 0.3, drift: 0.3, complete: 0.4 } } }), catalog.SCORER_LABELS_AFTER_NUDGE));
    check("offeredOptionIds reads turn-score's full set off a turn that was not nudged",
      same(offeredOptionIds("turn-score", { id: "x", jev: { probabilities: { "on-goal": 0.25, "off-goal-by-instruction": 0.25, drift: 0.25, complete: 0.25 } } }), catalog.SCORER_LABELS));
    let offeredErr = null;
    try { offeredOptionIds("turn-score", { id: "bad-ids", jev: { probabilities: { foo: 1 } } }); } catch (e) { offeredErr = e.message; }
    check("offeredOptionIds fails a record whose probability keys match no known v1 set, naming it",
      offeredErr !== null && offeredErr.includes("bad-ids"), offeredErr);

    let sentIds = null;
    const captureIds = (url, init) => {
      sentIds = Object.keys(JSON.parse(init.body).questions["controller-decision"].criteria);
      return choiceReply()(url, init);
    };
    const cdResult = await replayRecord(stubHost(captureIds), "controller-decision", "v1", {
      id: "c1", stampId: "s1", state: "irrelevant to the option set now", haikuValue: "nudge",
      jev: { probabilities: { nudge: 0.7, pause: 0.1, complete: 0.1, "ask-operator": 0.1 } },
    });
    check("controller-decision's replay sends exactly the options its own call offered, and stamps the seam's own returned version",
      same(sentIds, catalog.CONTROLLER_LABELS) &&
      cdResult.ok === true && cdResult.id === "c1" && cdResult.version === "v1" && typeof cdResult.probabilities.nudge === "number",
      cdResult);

    let sentIdsSwitch = null;
    const captureIdsSwitch = (url, init) => {
      sentIdsSwitch = Object.keys(JSON.parse(init.body).questions["controller-decision"].criteria);
      return choiceReply()(url, init);
    };
    const cdResultSwitch = await replayRecord(stubHost(captureIdsSwitch), "controller-decision", "v1", {
      id: "c2", stampId: "s2", state: "irrelevant to the option set now", haikuValue: null,
      jev: { probabilities: { nudge: 0.1, pause: 0.1, complete: 0.1, "ask-operator": 0.1, switch: 0.6 } },
    });
    check("a record whose own call offered switch is replayed with switch offered too, recovered from its probability keys alone",
      same(sentIdsSwitch, catalog.CONTROLLER_LABELS_WITH_SWITCH) && cdResultSwitch.ok === true, { sentIdsSwitch, cdResultSwitch });

    // --- turn-score v2: the state a sampled record is replayed over ---
    //
    // A turn-score record as sample.mjs writes one: its v1 state, its Jev
    // probabilities, and the transcript fields the v2 state is built from.
    // Its toolActivity is written by sample.mjs's own toolActivityText, the
    // writer the parse below reads back.
    const v1TurnScoreState = (prompt, answer, objective) =>
      `User asked: ${prompt}\n\nWorker answered: ${answer}\n\nGoal objective: ${objective}\n\nDid the worker's answer advance the goal objective?`;
    const TS_FULL = { "on-goal": 0.25, "off-goal-by-instruction": 0.25, drift: 0.25, complete: 0.25 };
    const TS_NUDGED = { "on-goal": 0.3, drift: 0.3, complete: 0.4 };
    const tsRecord = (id, overrides = {}) => ({
      id, stampId: `s-${id}`, haikuValue: null,
      state: v1TurnScoreState(`Tidy the notes for ${id}.`, `Tidied them for ${id}.`, "Keep the notes tidy"),
      jev: { probabilities: TS_FULL },
      transcript: {
        prompt: `Tidy the notes for ${id}.`,
        finalMessage: `Tidied them for ${id}.`,
        toolActivity: toolActivityText([{ name: "Read", input: { file_path: "docs/plans/x_v1.md" } }, { name: "Bash", input: { command: "git commit -m x" } }]),
      },
      ...overrides,
    });
    const parseToolActivity = replayModule.parseToolActivity;
    const scoreStateParts = replayModule.scoreStateParts;
    const turnScoreV2State = replayModule.turnScoreV2State;
    // The state a record replays over, or the refusal's reason.
    const v2StateOf = (record) => { const built = turnScoreV2State(record); return built.ok ? built.state : `refused: ${built.reason}`; };
    check("replay.mjs exports the turn-score v2 assembly: the activity parse, the state-parts read and the state builder",
      typeof parseToolActivity === "function" && typeof scoreStateParts === "function" && typeof turnScoreV2State === "function",
      [typeof parseToolActivity, typeof scoreStateParts, typeof turnScoreV2State]);
    if (typeof parseToolActivity === "function" && typeof scoreStateParts === "function" && typeof turnScoreV2State === "function") {
      // The round trip: every flag sample.mjs's writer can set, and the ring
      // in call order, read back onto the catalog's flag names.
      const everyFlag = toolActivityText([
        { name: "Read", input: { file_path: "D:/w/docs/plans/x_v1.md" } },
        { name: "Edit", input: { file_path: "docs\\plans\\x_v1.md" } },
        { name: "Bash", input: { command: "git commit -m x" } },
        { name: "Bash", input: { command: "git push origin main" } },
        { name: "Agent", input: {} },
        { name: "mcp__agentic-plugin__goal_done", input: {} },
        { name: "mcp__plugin_relay_channel-relay__reply", input: {} },
      ]);
      const parsedEvery = parseToolActivity(everyFlag);
      check("the activity parse reads every flag sample.mjs's writer sets back as held, on the catalog's names",
        parsedEvery !== null && catalog.TURN_SCORE_TOOL_FLAGS.every((name) => parsedEvery.flags[name] === true), { everyFlag, parsedEvery });
      check("the activity parse reads the ring back as the tool names in call order, repeats kept",
        parsedEvery !== null && same(parsedEvery.calls, ["Read", "Edit", "Bash", "Bash", "Agent", "mcp__agentic-plugin__goal_done", "mcp__plugin_relay_channel-relay__reply"]), parsedEvery);
      const parsedNone = parseToolActivity(toolActivityText([{ name: "Grep", input: {} }, { name: "Read", input: { file_path: "README.md" } }]));
      check("the activity parse reads a flag-free turn as no flag held, with its calls kept",
        parsedNone !== null && catalog.TURN_SCORE_TOOL_FLAGS.every((name) => parsedNone.flags[name] === false) && same(parsedNone.calls, ["Grep", "Read"]), parsedNone);
      const parsedEmpty = parseToolActivity(toolActivityText([]));
      check("the activity parse reads a turn with no tool calls as an empty call list, not one empty name",
        parsedEmpty !== null && same(parsedEmpty.calls, []), parsedEmpty);
      // Refused shapes, each off the writer's shape by one part. The accepted
      // lines above are the withheld control.
      const offShape = [
        ["a flag out of order", "plan_edited=no plan_read=no commit=no push=no agent_dispatched=no goal_done=no reply=no work_tools=0 tools="],
        ["a flag value other than yes or no", "plan_read=maybe plan_edited=no commit=no push=no agent_dispatched=no goal_done=no reply=no work_tools=0 tools="],
        ["no work_tools field", "plan_read=no plan_edited=no commit=no push=no agent_dispatched=no goal_done=no reply=no tools=Read"],
        ["a missing flag", "plan_read=no commit=no push=no agent_dispatched=no goal_done=no reply=no work_tools=0 tools=Read"],
        ["not a string", null],
      ];
      for (const [what, line] of offShape) {
        check(`the activity parse refuses a line with ${what}`, parseToolActivity(line) === null, line);
      }

      // Both journaled shapes: v1, and v2 as turnScoreStateText writes it.
      const noFlags = Object.fromEntries(catalog.TURN_SCORE_TOOL_FLAGS.map((f) => [f, false]));
      const v1Parts = scoreStateParts(v1TurnScoreState("p", "a", "line one\nline two"));
      check("the state parts read a v1 state's opening text and objective, line breaks kept",
        v1Parts !== null && v1Parts.opening === "p" && v1Parts.objective === "line one\nline two", v1Parts);
      const v2Parts = scoreStateParts(catalog.turnScoreStateText("Tidy [it].", "Done.", "Keep it tidy", { flags: noFlags, calls: ["Read"] }));
      check("the state parts read a v2 state's opening text and objective, the objective ending at the Tools part",
        v2Parts !== null && v2Parts.opening === "Tidy (it)." && v2Parts.objective === "Keep it tidy", v2Parts);
      // An objective that itself carries the label is read whole in both
      // shapes, since the anchor is the first label after the answer's.
      const embedded = "Ship it.\n\nGoal objective: the second half";
      const v1Embedded = scoreStateParts(v1TurnScoreState("p", "a", embedded));
      check("a v1 objective carrying its own Goal objective label is read whole",
        v1Embedded !== null && v1Embedded.objective === embedded, v1Embedded);
      const v2Embedded = scoreStateParts(catalog.turnScoreStateText("p", "a", embedded, { flags: noFlags, calls: [] }));
      check("a v2 objective carrying its own Goal objective label is read whole, folded as v2 sends it",
        v2Embedded !== null && v2Embedded.objective === "Ship it. Goal objective: the second half", v2Embedded);
      for (const [what, state] of [
        ["a v1 state with no closing question", "User asked: p\n\nWorker answered: a\n\nGoal objective: o"],
        ["a v2 state with no Tools part", "Turn opened with: p\n\nWorker answered: a\n\nGoal objective: o"],
        ["a state in neither shape", "Something else: p\n\nWorker answered: a\n\nGoal objective: o"],
      ]) check(`the state parts refuse ${what}`, scoreStateParts(state) === null, state);

      // The v2 state is the catalog's builder over the record's transcript
      // fields and its journaled objective, not the v1 state's own cut texts.
      const rec = tsRecord("t-v2");
      const tsFlags = { ...noFlags, plan_read: true, commit: true };
      check("a record's v2 state is turnScoreStateText over its transcript prompt, final message, v1 objective and parsed activity",
        v2StateOf(rec) === catalog.turnScoreStateText("Tidy the notes for t-v2.", "Tidied them for t-v2.", "Keep the notes tidy",
          { flags: tsFlags, calls: ["Read", "Bash"] }),
        v2StateOf(rec));
      // A record journaled under v2 replays too: the objective and the opening
      // text are read off the v2 shape.
      const v2Journaled = tsRecord("t-v2j", { state: catalog.turnScoreStateText("Tidy the notes for t-v2j.", "x", "Keep the notes tidy", { flags: noFlags, calls: [] }) });
      check("a record whose journaled state is v2 replays over the same state a v1-journaled record gets",
        v2StateOf(v2Journaled) === catalog.turnScoreStateText("Tidy the notes for t-v2j.", "Tidied them for t-v2j.", "Keep the notes tidy", { flags: tsFlags, calls: ["Read", "Bash"] }),
        v2StateOf(v2Journaled));

      // The prompt cross-check, which runs only where the journal holds the
      // plugin's own reading of the opening text: a record journaled under v2.
      // A v1 state's "User asked:" text is the last prompt the plugin saw
      // submitted, which a message queued mid-turn replaces, so a v1-journaled
      // record whose transcript opens on another text is built, not refused.
      // A v2-journaled record whose transcript opening builds another opening
      // part is refused as prompt_mismatch, which replayRecord writes as a
      // failure row with no request sent. A trailer and extra whitespace build
      // the same opening part, so they pass.
      const trailer = "This is how Claude Code surfaces a prompt a plugin submits between turns \u2014 it starts this turn in the user's place. Address the message above.";
      const trailed = tsRecord("t-trail", { transcript: { ...rec.transcript, prompt: "Tidy the  notes\nfor t-trail.\n\n" + trailer } });
      check("the builder removes the engine's trailer and collapses whitespace in a transcript prompt",
        v2StateOf(trailed).startsWith("Turn opened with: Tidy the notes for t-trail.\n\n"), v2StateOf(trailed));
      const v1Other = tsRecord("t-v1-other", { transcript: { ...rec.transcript, prompt: "<task-notification> a different message" } });
      check("a v1-journaled record whose transcript opens on another text than User asked is built, since the v1 text proves nothing",
        v2StateOf(v1Other).startsWith("Turn opened with: <task-notification> a different message\n\n"), v2StateOf(v1Other));
      const v2State = (opening) => catalog.turnScoreStateText(opening, "x", "Keep the notes tidy", { flags: noFlags, calls: [] });
      const v2Same = tsRecord("t-v2-same", { state: v2State("The agentic-plugin plugin sent a message:\nTidy the notes for t-v2-same.\n\n" + trailer),
        transcript: { ...rec.transcript, prompt: "Tidy the notes  for t-v2-same." } });
      check("a v2-journaled record whose transcript opening builds the journaled opening part passes the cross-check",
        v2StateOf(v2Same).startsWith("Turn opened with: Tidy the notes for t-v2-same.\n\n"), v2StateOf(v2Same));
      const other = tsRecord("t-other", { state: v2State("Tidy the notes for t-other."), transcript: { ...rec.transcript, prompt: "[SUPERVISOR-PRIMING] a different message" } });
      check("a v2-journaled record whose transcript opens on another text is refused as prompt_mismatch",
        v2StateOf(other) === "refused: prompt_mismatch", v2StateOf(other));
      let sentOnMismatch = 0;
      const mismatchRow = await replayRecord(stubHost(async (url, init) => { sentOnMismatch += 1; return choiceReply()(url, init); }), "turn-score", "v2", other);
      check("replayRecord writes a prompt_mismatch record as a failure row carrying the reason, and sends no request",
        mismatchRow.ok === false && mismatchRow.reason === "prompt_mismatch" && mismatchRow.id === "t-other" && !("value" in mismatchRow) && sentOnMismatch === 0,
        { mismatchRow, sentOnMismatch });
      check("score.mjs's withReplay excludes a prompt_mismatch row from every figure",
        withReplay([{ id: "t-other", label: "on-goal", value: "on-goal", probabilities: {}, haikuValue: null, outcomes: [] }], [mismatchRow]).records.length === 0);

      // The sampler's answer match on a v2 line: the state carries the answer
      // folded, its brackets rewritten and its whitespace collapsed, and the
      // match folds the transcript's final message the same way before the
      // prefix compare. A final message that is another text is the withheld
      // control, and the v1 shape with brackets left raw still matches.
      const bracketed = "Fixed the [flaky]   test\n\nand pushed [main].";
      const v2Answer = stateAnswerText("turn-score", catalog.turnScoreStateText("p", bracketed, "o", { flags: noFlags, calls: [] }));
      check("the sampler reads a v2 state's answer as the folded text v2 sent",
        v2Answer === "Fixed the (flaky) test and pushed (main).", v2Answer);
      check("the sampler matches a v2 answer holding brackets to the raw final message that produced it",
        v2Answer !== null && turnProducedAnswer({ final: bracketed }, v2Answer) === true);
      check("the sampler's v2 match refuses a final message that is another text (control)",
        v2Answer !== null && turnProducedAnswer({ final: "Fixed the flaky test, then stopped." }, v2Answer) === false);
      check("the sampler still matches a v1 answer holding raw brackets",
        turnProducedAnswer({ final: bracketed }, stateAnswerText("turn-score", v1TurnScoreState("p", bracketed, "o"))) === true);

      // The byte pin through sample.mjs's own transcript reader. The fixture
      // turn opens with surrounding whitespace, the engine's wrapper line, a
      // message over 1,200 characters and the engine's trailer, and ends on an
      // assistant entry of two text blocks, which the reader trims and joins
      // with one line break. The plugin holds the turn-start text whole, which
      // is the transcript's opening text as the engine delivered it, and the
      // answer with its own whitespace; the replay's state from what turnsOf
      // returns, cut as sample.mjs cuts a record's fields, must equal the
      // builder over those raw strings.
      const fixtureTurns = turnsOf(path.join(FIXTURE, "turn-score-v2", "s-ts-v2.jsonl"));
      const fixtureTurn = fixtureTurns.length === 1 ? fixtureTurns[0] : null;
      const rawOpening = JSON.parse(fs.readFileSync(path.join(FIXTURE, "turn-score-v2", "s-ts-v2.jsonl"), "utf8").split("\n")[0]).message.content[0].text;
      const pluginAnswer = "  WORKING: tidied the [three] notes.  \n\nCommitted them.\n";
      check("the fixture control: the raw opening text carries surrounding whitespace, the wrapper, over 1,200 characters of message and the trailer, and the reader's final message differs from the plugin's answer",
        fixtureTurn !== null && /^\s/.test(rawOpening) && rawOpening.includes("plugin sent a message:") && rawOpening.includes(trailer)
          && fixtureTurn.prompt.length > 1200 && fixtureTurn.final !== pluginAnswer && fixtureTurn.final.includes("\n"),
        fixtureTurn && { promptLength: fixtureTurn.prompt.length, final: fixtureTurn.final });
      check("sample.mjs's reader removes the wrapper, the trailer and the surrounding whitespace through the catalog's turnOpeningText",
        fixtureTurn !== null && fixtureTurn.prompt === catalog.turnOpeningText(rawOpening) && !fixtureTurn.prompt.includes("plugin sent a message:")
          && !fixtureTurn.prompt.includes("This is how Claude Code") && fixtureTurn.prompt.startsWith("[GOAL] Tidy the [notes]."),
        fixtureTurn && fixtureTurn.prompt.slice(0, 60));
      if (fixtureTurn !== null) {
        const fixtureRecord = {
          id: "ts-fixture", stampId: "s-fixture", haikuValue: null,
          state: v1TurnScoreState(fixtureTurn.prompt.slice(0, 500), pluginAnswer.slice(0, 1000), "Keep the notes tidy"),
          jev: { probabilities: TS_NUDGED },
          transcript: {
            prompt: fixtureTurn.prompt.slice(0, PROMPT_MAX),
            finalMessage: fixtureTurn.final.slice(0, FINAL_MAX),
            toolActivity: toolActivityText(fixtureTurn.tools, fixtureTurn.sidechainReply),
          },
        };
        const pluginState = catalog.turnScoreStateText(rawOpening, pluginAnswer, "Keep the notes tidy", { flags: tsFlags, calls: ["Read", "Bash"] });
        check("the replay's v2 state from turnsOf's reading equals turnScoreStateText over the raw turn-start text and answer the plugin holds",
          v2StateOf(fixtureRecord) === pluginState, { replay: v2StateOf(fixtureRecord).slice(-200), plugin: pluginState.slice(-200) });
        check("the plugin's opening part is cut at 1,200 characters after the wrapper comes off, so it opens on the message and not the wrapper",
          pluginState.startsWith("Turn opened with: (GOAL) Tidy the (notes). Keep going 0.") && pluginState.split("\n\n")[0].length === "Turn opened with: ".length + 1200,
          pluginState.slice(0, 80));
      }

      // The refusals, one per part the state needs. Each names the record and
      // the rule that refused it: no transcript at all, no prompt, an absent or
      // empty final message, an activity line off the writer's shape, and a v1
      // state with no objective. The record above, carrying all four, is the
      // withheld control.
      const refusals = [
        ["no transcript", { transcript: undefined }, "carries no transcript"],
        ["no prompt", { transcript: { ...rec.transcript, prompt: undefined } }, "carries no prompt"],
        ["no final message", { transcript: { ...rec.transcript, finalMessage: undefined } }, "carries no final message"],
        ["an empty final message", { transcript: { ...rec.transcript, finalMessage: "" } }, "carries no final message"],
        ["an activity line off shape", { transcript: { ...rec.transcript, toolActivity: "tools=Read" } }, "not a turn_tool_activity line"],
        ["no activity line", { transcript: { ...rec.transcript, toolActivity: undefined } }, "not a turn_tool_activity line"],
        ["a v1 state with no objective", { state: "User asked: p" }, "carries no goal objective"],
      ];
      for (const [what, overrides, rule] of refusals) {
        let err = null;
        try { turnScoreV2State(tsRecord("t-refused", overrides)); } catch (e) { err = e.message; }
        check(`a record with ${what} is refused by name, as "${rule}"`,
          err !== null && err.includes("t-refused") && err.includes(rule), err);
      }
      // The refusal reaches replayRecord before any request goes out.
      let sentOnRefusal = 0;
      let replayRefusal = null;
      try {
        await replayRecord(stubHost(async (url, init) => { sentOnRefusal += 1; return choiceReply()(url, init); }), "turn-score", "v2",
          tsRecord("t-no-send", { transcript: undefined }));
      } catch (e) { replayRefusal = e.message; }
      check("replayRecord refuses a record it cannot build the v2 state for, and sends no request",
        replayRefusal !== null && replayRefusal.includes("t-no-send") && sentOnRefusal === 0, { replayRefusal, sentOnRefusal });
    }

    let sentTsIds = null;
    let sentTsState = null;
    const captureTsIds = (url, init) => {
      const body = JSON.parse(init.body);
      sentTsIds = Object.keys(body.questions["turn-score"].criteria);
      sentTsState = body.state;
      return choiceReply()(url, init);
    };
    const nudgedRecord = tsRecord("t0", { jev: { probabilities: TS_NUDGED } });
    const nudgedResult = await replayRecord(stubHost(captureTsIds), "turn-score", "v2", nudgedRecord);
    check("a nudged turn's v2 replay offers only the three options its own call offered, never off-goal-by-instruction",
      same(sentTsIds, catalog.SCORER_LABELS_AFTER_NUDGE) && nudgedResult.ok === true, { sentTsIds, nudgedResult });
    check("the v2 replay sends the record's v2 state, not its v1 state, and stamps the seam's own v2",
      typeof turnScoreV2State === "function" && sentTsState === v2StateOf(nudgedRecord) && sentTsState !== nudgedRecord.state
        && nudgedResult.version === "v2",
      { sentTsState, version: nudgedResult.version });

    const boState = JSON.stringify({ closingText: "WAITING: a background suite is running", recentClosingTexts: ["a", "b"] });
    let sentQuestionIds = null;
    const captureAll = (url, init) => {
      const body = JSON.parse(init.body);
      sentQuestionIds = Object.keys(body.questions);
      return choiceReply(null, (qid) => (qid === "block-owner" ? "self-resolving" : undefined))(url, init);
    };
    const boResult = await replayRecord(stubHost(captureAll), "block-owner", "v1", { id: "b1", stampId: "s2", state: boState, haikuValue: null });
    check("block-owner's replay sends the same four plan-health questions the plugin asks and keeps only its own answer",
      same(sentQuestionIds.sort(), ["block-owner", "rounds-converging", "work-continues", "worker-blocked"]) &&
      boResult.ok === true && boResult.value === "self-resolving" && boResult.version === "v1" && !("worker-blocked" in boResult), boResult);

    let boErr = null;
    try { await replayRecord(stubHost(choiceReply()), "block-owner", "v1", { id: "b2", stampId: "s3", state: "not json", haikuValue: null }); } catch (e) { boErr = e.message; }
    check("block-owner's replay refuses a state that is not the plan-health JSON, naming the record", boErr !== null && boErr.includes("b2"), boErr);

    // A failed call is written with its failure reason and is not scored:
    // the seam's own closed reason rides straight through, with no answer.
    const failHost = stubHost(async () => ({ status: 429, ok: false, headers: {}, text: "" }));
    const failResult = await replayRecord(failHost, "turn-score", "v2", tsRecord("t1"));
    check("a failed call carries the seam's reason and no answer",
      failResult.ok === false && failResult.reason === "http_429" && !("value" in failResult), failResult);
    check("score.mjs's withReplay excludes a failed replay record from every figure",
      withReplay([{ id: "t1", label: "on-goal", value: "on-goal", probabilities: {}, haikuValue: null, outcomes: [] }], [failResult]).records.length === 0);

    let order = [];
    const seqHost = stubHost(async (url, init) => { order.push(JSON.parse(init.body).state); return choiceReply()(url, init); });
    const seqResults = await replayAll(seqHost, "turn-score", "v2", [tsRecord("t1"), tsRecord("t2")]);
    check("replayAll replays every record in order and carries each id through",
      seqResults.length === 2 && seqResults[0].id === "t1" && seqResults[1].id === "t2"
        && order.length === 2 && order[0].includes("Tidy the notes for t1.") && order[1].includes("Tidy the notes for t2."),
      seqResults.map((r) => r.id));

    // A throw partway through a batch, such as block-owner's non-JSON state
    // refusal, still leaves onRow fired for every record completed before
    // it, so an appending caller (main's own) keeps what was already paid
    // for rather than losing it to the throw.
    const onRowLog = [];
    let partialErr = null;
    try {
      await replayAll(stubHost(choiceReply()), "block-owner", "v1", [
        { id: "ok1", stampId: "sok1", state: JSON.stringify({ closingText: "WAITING: x", recentClosingTexts: [] }), haikuValue: null },
        { id: "bad1", stampId: "sbad1", state: "not json", haikuValue: null },
      ], { onRow: (row) => onRowLog.push(row.id) });
    } catch (e) { partialErr = e.message; }
    check("a throw partway through replayAll still fires onRow for every row completed before it",
      partialErr !== null && partialErr.includes("bad1") && same(onRowLog, ["ok1"]), { partialErr, onRowLog });

    check("buildHost reads the key from the environment inside getApiKey and nothing else, which is what the header now claims",
      (await buildHost({ TYPESAFE_API_KEY: "the-real-value" }).getApiKey()) === "the-real-value" &&
      (await buildHost({}).getApiKey()) === undefined);

    // --- Version validation and stamping ---
    check("REPLAYABLE_VERSIONS names, per question, the one version the catalog ships: turn-score at v2, the other two at v1",
      same(REPLAYABLE_VERSIONS, { "controller-decision": ["v1"], "turn-score": ["v2"], "block-owner": ["v1"] }), REPLAYABLE_VERSIONS);
    check("each replayable version is the version the catalog ships for that question",
      Object.entries(REPLAYABLE_VERSIONS).every(([q, versions]) => versions.length === 1 && versions[0] === catalog.SHIPPED_QUESTIONS[q]?.version),
      Object.keys(REPLAYABLE_VERSIONS).map((q) => [q, catalog.SHIPPED_QUESTIONS[q]?.version]));

    const stateFile = path.join(TMP, "replay-state.jsonl");
    fs.writeFileSync(stateFile, JSON.stringify({ id: "x1", stampId: "s1" }) + "\n");
    let versionErr = null;
    try { await replayMain(["--question", "controller-decision", "--version", "v2", "--state-from", stateFile], {}); } catch (e) { versionErr = e.message; }
    check("replay.mjs refuses a --version it cannot assemble, before touching the network",
      versionErr !== null && versionErr.includes("v1"), versionErr);
    let tsV1Err = null;
    try { await replayMain(["--question", "turn-score", "--version", "v1", "--state-from", stateFile], {}); } catch (e) { tsV1Err = e.message; }
    check("replay.mjs refuses turn-score v1, whose wording the catalog does not ship, naming v2",
      tsV1Err !== null && tsV1Err.includes("turn-score") && tsV1Err.includes("v2"), tsV1Err);

    const existingOut = path.join(TMP, "replay-out-exists.jsonl");
    fs.writeFileSync(existingOut, "");
    let overwriteErr = null;
    try { await replayMain(["--question", "turn-score", "--version", "v2", "--state-from", stateFile, "--out", existingOut], {}); } catch (e) { overwriteErr = e.message; }
    check("replay.mjs refuses to overwrite an existing --out unless --force is given",
      overwriteErr !== null && overwriteErr.includes("--force"), overwriteErr);

    // An active override changes the wording a call actually sends without
    // changing what --version was asked for; replay catches the mismatch
    // rather than mislabelling the row "v1".
    const overrideHome = path.join(TMP, "override-home");
    const overrideDir = path.join(overrideHome, ".claude", "agentic-questions", "controller-decision");
    fs.mkdirSync(overrideDir, { recursive: true });
    fs.writeFileSync(path.join(overrideDir, "active.json"), JSON.stringify({ version: "v2" }));
    fs.writeFileSync(path.join(overrideDir, "v2.json"), JSON.stringify({
      primitive: "choice",
      instructions: "An overridden controller question.",
      options: { nudge: "n", pause: "p", complete: "c", "ask-operator": "a", switch: "s" },
    }));
    const overrideHost = stubHost(choiceReply(), {
      getHome: async () => overrideHome,
      readFile: async (p) => fs.promises.readFile(p, "utf8"),
      fileExists: async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } },
    });
    let overrideErr = null;
    try {
      await replayRecord(overrideHost, "controller-decision", "v1", {
        id: "ov1", stampId: "sov1", state: "irrelevant to the option set now", haikuValue: null,
        jev: { probabilities: { nudge: 0.1, pause: 0.1, complete: 0.1, "ask-operator": 0.1, switch: 0.6 } },
      });
    } catch (e) { overrideErr = e.message; }
    check("an active override sends a wording that resolves to another version, and replay refuses rather than mislabelling the row v1",
      overrideErr !== null && overrideErr.includes('"v2"') && overrideErr.includes('"v1"'), overrideErr);
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
