#!/usr/bin/env node
// adjudicate.mjs: builds one question's gold from its two labellings.
//
// Usage:
//   node .kit/jev-gold/adjudicate.mjs --question <id> [--in <dir>]
//
// --in defaults to .kit/jev-gold/out/<question> and must hold sample.jsonl,
// labels-a.jsonl and labels-b.jsonl. A record both labellers gave the same
// label joins gold.jsonl as it stands. The rest go to disagreements.jsonl,
// and a third labeller, the same CLI call and rubric label.mjs runs, labels
// those alone into labels-c.jsonl. A disagreement the third labeller settles
// by agreeing with one of the two joins gold with `adjudicated: true`; a
// three-way split stays out of gold and is listed in splits.jsonl for the
// main thread to read. No record is labelled by hand here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QUESTIONS } from "./sample.mjs";
import { commandLine, readSample, runLabeller, writeJsonLines } from "./label.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readLabels(file) {
  const rows = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return new Map(rows.map((r) => [r.id, r]));
}

// Splits the sample into agreements and disagreements, runs the third
// labeller over the disagreements, and returns every file's rows and the
// counts. A sample record either labelling lacks fails here rather than
// dropping out of gold unseen.
export function adjudicate(question, records, labelsA, labelsB, opts = {}) {
  const missing = records.filter((r) => !labelsA.has(r.id) || !labelsB.has(r.id)).map((r) => r.id);
  if (missing.length > 0) throw new Error(`labels are missing for ${missing.length} sample record(s): ${missing.join(", ")}`);
  const goldOf = (r, label, adjudicated, labels) => ({
    id: r.id,
    stampId: r.stampId,
    question,
    persona: r.persona,
    split: r.split,
    label,
    adjudicated,
    labels,
  });
  const gold = [];
  const disagreements = [];
  for (const r of records) {
    const a = labelsA.get(r.id).label;
    const b = labelsB.get(r.id).label;
    if (a === b) gold.push(goldOf(r, a, false, { a, b }));
    else disagreements.push(r);
  }
  const splits = [];
  let labelsC = [];
  let adjudicated = 0;
  if (disagreements.length > 0) {
    // Printed once, before the third labeller's first batch, so a stale
    // JEV_GOLD_LABELLER shows in the output.
    (opts.log || ((line) => process.stdout.write(line + "\n")))(commandLine(opts.env || process.env));
    labelsC = runLabeller("c", question, disagreements, opts).labels;
    const cOf = new Map(labelsC.map((l) => [l.id, l.label]));
    for (const r of disagreements) {
      const a = labelsA.get(r.id).label;
      const b = labelsB.get(r.id).label;
      const c = cOf.get(r.id);
      if (c === a || c === b) {
        gold.push(goldOf(r, c, true, { a, b, c }));
        adjudicated += 1;
      } else {
        splits.push({ id: r.id, stampId: r.stampId, a, b, c, notes: { a: labelsA.get(r.id).note ?? null, b: labelsB.get(r.id).note ?? null } });
      }
    }
  }
  const order = new Map(records.map((r, i) => [r.id, i]));
  gold.sort((x, y) => order.get(x.id) - order.get(y.id));
  const counts = {
    question,
    sample: records.length,
    agreed: records.length - disagreements.length,
    disagreements: disagreements.length,
    adjudicated,
    splits: splits.length,
    gold: gold.length,
    goldUnclear: gold.filter((g) => g.label === "unclear").length,
  };
  return {
    gold,
    disagreements: disagreements.map((r) => ({ id: r.id, stampId: r.stampId, a: labelsA.get(r.id).label, b: labelsB.get(r.id).label })),
    labelsC,
    splits,
    counts,
  };
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`bad argument: ${a}`);
    if (a === "--question") flags.question = v;
    else if (a === "--in") flags.in = v;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!flags.question || !QUESTIONS[flags.question]) throw new Error(`--question must be one of ${Object.keys(QUESTIONS).join(", ")}`);
  return flags;
}

export function main(argv) {
  const flags = parseArgs(argv);
  const dir = flags.in || path.join(HERE, "out", flags.question);
  const result = adjudicate(
    flags.question,
    readSample(dir),
    readLabels(path.join(dir, "labels-a.jsonl")),
    readLabels(path.join(dir, "labels-b.jsonl")),
  );
  writeJsonLines(path.join(dir, "gold.jsonl"), result.gold);
  writeJsonLines(path.join(dir, "disagreements.jsonl"), result.disagreements);
  writeJsonLines(path.join(dir, "labels-c.jsonl"), result.labelsC);
  writeJsonLines(path.join(dir, "splits.jsonl"), result.splits);
  process.stdout.write(JSON.stringify(result.counts) + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`adjudicate: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  }
}
