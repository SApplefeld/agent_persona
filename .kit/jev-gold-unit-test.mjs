#!/usr/bin/env node
// Jev gold tools unit tests: the sampler's null-state reconstruction, its
// admission counts, its transcript join and hindsight join, its
// stratification counts, the labeller's argument array, its refusal of a
// reply that drops a record, its timeout retry, Cohen's kappa, and the
// adjudication into gold.
//
// The sampler reads the synthetic journal and transcripts under
// .kit/fixtures/jev-gold/. The labeller and the adjudicator run as their own
// processes with JEV_GOLD_LABELLER naming .kit/fixtures/jev-gold/stub-labeller.mjs,
// so no case spawns a real `claude`. Every output goes under a temp directory
// this suite removes.
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
  opensTurn, toolActivityText, buildCandidates, stratify, personaKey, PERSONA_ALIASES,
} from "./jev-gold/sample.mjs";
import {
  CLI_FLAGS, rubricText, rubricLabels, labellerView, checkBatch, cohensKappa, kappaLine,
} from "./jev-gold/label.mjs";
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
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
