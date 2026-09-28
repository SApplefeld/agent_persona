#!/usr/bin/env node
// score.mjs: scores one question's gold sample against Jev's v1 answers, and
// against a replay's answers where one is given.
//
// Usage:
//   node .kit/jev-gold/score.mjs --question <id> --gold <file> [--replay <file>]
//
// --gold names gold.jsonl. sample.jsonl, which carries Jev's answer, Haiku's
// value and the outcome lines, is read from the same directory: a gold id
// sample.jsonl does not carry fails the run. --replay names a jsonl file
// replay.mjs writes, one line per sampled record with the version it replayed
// and either its answer or the reason it failed; a failed replay record is
// excluded from every figure.
//
// Prints, per question version present (v1 from the gold join, and each
// version --replay carries): accuracy against gold, per-option precision and
// recall, calibration by top-probability bin, agreement with Haiku, AUC
// against each outcome kind present, and one `bar:` line per bar this tool
// knows about for the question. Where --replay is given, each replayed version
// is printed as `<version>.replay`, each journal baseline version is read on
// the gold records the replay scored, each count printed, and each baseline
// over all of its own records is printed beside it as `<version>.all`. A
// version token is one word, so a `bar:` line keeps its
// `bar: <question> <version> ...` shape.
//
// Reads only. Nothing here writes anywhere.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QUESTIONS } from "./sample.mjs";
import { readSample } from "./label.mjs";

// --- Reading and joining ---

export function readGold(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function readReplay(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// sample.jsonl keyed by id, for the gold join.
export function sampleById(dir) {
  return new Map(readSample(dir).map((r) => [r.id, r]));
}

// One gold record joined to the sample it was drawn from. A gold id the
// sample does not carry fails the run rather than scoring a partial record,
// since a record with no Jev answer, no Haiku value and no outcomes is not
// one this tool can measure.
export function joinGoldSample(question, gold, sample) {
  const missing = gold.filter((g) => !sample.has(g.id)).map((g) => g.id);
  if (missing.length > 0) throw new Error(`gold carries ${missing.length} id(s) sample.jsonl does not: ${missing.join(", ")}`);
  return gold.map((g) => {
    const s = sample.get(g.id);
    return {
      id: g.id,
      question,
      persona: g.persona,
      split: g.split,
      label: g.label,
      adjudicated: g.adjudicated,
      version: s.jev.version,
      value: s.jev.value,
      probabilities: s.jev.probabilities || {},
      haikuValue: s.haikuValue,
      outcomes: s.outcomes || [],
    };
  });
}

// Replaces each replayed record's answer, keeping the gold label, the
// persona, the split and the outcomes the original call carried, since a
// replay measures a re-posed wording against the same turns rather than
// against a different sample. A replay record naming an id outside the gold
// join is ignored: the sampler's sample.jsonl is the one list of ids a run
// measures, and a stray line is not a second sample. Two rows sharing one id,
// such as from a concatenated or re-run output, would otherwise score that
// record twice in every replay figure, so a duplicate id anywhere in the
// file fails the run rather than being silently summed. `missing` counts the
// gold ids the replay file never mentions at all, ok or failed, beside
// `failed`, the ones it mentions but could not answer.
export function withReplay(joined, replayRows) {
  const byId = new Map(joined.map((r) => [r.id, r]));
  const seen = new Set();
  const out = [];
  let failed = 0;
  for (const row of replayRows) {
    if (seen.has(row.id)) throw new Error(`the replay carries more than one row for id ${row.id}`);
    seen.add(row.id);
    const base = byId.get(row.id);
    if (!base) continue;
    if (row.ok !== true) { failed += 1; continue; }
    out.push({ ...base, version: row.version, value: row.value, probabilities: row.probabilities || {} });
  }
  const missing = joined.filter((r) => !seen.has(r.id)).length;
  return { records: out, failed, missing };
}

// --- Folding, filtering ---

// A v1 controller answer of pause is scored as ask-operator: the controller
// converts the two into one verdict, and pause was never in the labeller's
// rubric for it to be scored as its own class.
export function foldedValue(question, value) {
  return question === "controller-decision" && value === "pause" ? "ask-operator" : value;
}

export function topProbability(probabilities) {
  const values = Object.values(probabilities || {});
  return values.length === 0 ? null : Math.max(...values);
}

// A gold record labelled unclear is outside every accuracy denominator.
export function scorable(records) {
  return records.filter((r) => r.label !== "unclear");
}

// --- Accuracy, confusion, precision and recall ---
//
// Each of the three below takes `predictedOf`, a record's predicted value,
// so the same three functions read either Jev's own answer (the default) or
// Haiku's, over the same fold and the same unclear exclusion. Haiku's own
// read filters to the rows that carry one first, through `haikuRows`.

function jevPredictedOf(question) {
  return (r) => foldedValue(question, r.value);
}

// The scorable rows a Haiku-side read takes: gold-scorable, and carrying a
// Haiku value at all, since a plan-health question's rows never do.
export function haikuRows(records) {
  return records.filter((r) => typeof r.haikuValue === "string");
}

function haikuPredictedOf(question) {
  return (r) => foldedValue(question, r.haikuValue);
}

export function accuracyOf(records, question, predictedOf = jevPredictedOf(question)) {
  const rows = scorable(records);
  const correct = rows.filter((r) => predictedOf(r) === r.label).length;
  return { correct, n: rows.length, accuracy: rows.length === 0 ? null : correct / rows.length };
}

// gold label -> predicted value -> count, over the scorable rows.
export function confusionOf(records, question, predictedOf = jevPredictedOf(question)) {
  const out = {};
  for (const r of scorable(records)) {
    const predicted = predictedOf(r);
    out[r.label] = out[r.label] || {};
    out[r.label][predicted] = (out[r.label][predicted] || 0) + 1;
  }
  return out;
}

// One row per label seen in gold or predicted: true positives, false
// positives, false negatives, precision and recall. A label with no
// predictions and no gold rows is left out, since there is nothing to score.
export function precisionRecallOf(records, question, predictedOf = jevPredictedOf(question)) {
  const rows = scorable(records);
  const labels = new Set();
  for (const r of rows) { labels.add(r.label); labels.add(predictedOf(r)); }
  const out = {};
  for (const label of labels) {
    const tp = rows.filter((r) => r.label === label && predictedOf(r) === label).length;
    const fp = rows.filter((r) => r.label !== label && predictedOf(r) === label).length;
    const fn = rows.filter((r) => r.label === label && predictedOf(r) !== label).length;
    out[label] = {
      tp, fp, fn,
      precision: tp + fp === 0 ? null : tp / (tp + fp),
      recall: tp + fn === 0 ? null : tp / (tp + fn),
    };
  }
  return out;
}

// Haiku's own accuracy, confusion and precision/recall against gold, read
// over the rows that carry a Haiku value, pause folded to ask-operator the
// same way Jev's own answer is. Returns null where no row in the group
// carries a Haiku value at all, which is every block-owner record: no
// classifier is asked a plan-health question.
export function haikuAccuracyOf(records, question) {
  const rows = haikuRows(records);
  return rows.length === 0 ? null : accuracyOf(rows, question, haikuPredictedOf(question));
}

export function haikuConfusionOf(records, question) {
  const rows = haikuRows(records);
  return rows.length === 0 ? null : confusionOf(rows, question, haikuPredictedOf(question));
}

export function haikuPrecisionRecallOf(records, question) {
  const rows = haikuRows(records);
  return rows.length === 0 ? null : precisionRecallOf(rows, question, haikuPredictedOf(question));
}

// The raw, unfolded accuracy beside the folded one, for controller-decision
// alone: the fold above scores a pause answer as ask-operator, and this is
// the figure the spec asks to print beside that folded read, since the pause
// rate alone cannot rebuild what accuracy would have read without the fold.
// `valueOf` reads the column (Jev's `value` or Haiku's `haikuValue`); a
// question other than controller-decision, or a column with no rows at all,
// reads null.
export function unfoldedAccuracyOf(records, question, valueOf) {
  if (question !== "controller-decision") return null;
  const rows = records.filter((r) => typeof valueOf(r) === "string");
  return rows.length === 0 ? null : accuracyOf(rows, question, valueOf);
}

// --- Calibration ---

export const CALIBRATION_BIN_COUNT = 5;

// Five equal-width bins over the top probability, [0, 0.2) .. [0.8, 1.0]. A
// record whose probabilities carry nothing lands in no bin. Each bin's
// accuracy is read over its scorable rows alone, so an unclear gold record
// still places into a bin (it has a probability) but never counts toward the
// bin's accuracy.
export function calibrationOf(records, question) {
  const width = 1 / CALIBRATION_BIN_COUNT;
  const bins = Array.from({ length: CALIBRATION_BIN_COUNT }, (_, i) => ({
    low: i * width,
    high: i === CALIBRATION_BIN_COUNT - 1 ? 1 : (i + 1) * width,
    n: 0,
    confidenceSum: 0,
    correct: 0,
    scorable: 0,
  }));
  for (const r of records) {
    const p = topProbability(r.probabilities);
    if (p === null) continue;
    // Math.floor(p / width) misbins an exact edge such as 0.6: 0.6 / 0.2
    // evaluates to 2.9999999999999996, one bin short of where barRows's own
    // p >= 0.6 comparison, and this table's own coverage count, place the
    // same record. The epsilon nudges a value sitting exactly on a bin edge
    // into the bin at or above it, matching that comparison.
    const idx = Math.min(CALIBRATION_BIN_COUNT - 1, Math.floor(p * CALIBRATION_BIN_COUNT + 1e-9));
    const bin = bins[idx];
    bin.n += 1;
    bin.confidenceSum += p;
    if (r.label !== "unclear") {
      bin.scorable += 1;
      if (foldedValue(question, r.value) === r.label) bin.correct += 1;
    }
  }
  return bins.map((b) => ({
    low: b.low,
    high: b.high,
    n: b.n,
    avgConfidence: b.n === 0 ? null : b.confidenceSum / b.n,
    accuracy: b.scorable === 0 ? null : b.correct / b.scorable,
  }));
}

// --- Agreement with Haiku ---

// Over the scorable rows carrying a Haiku value: the share where Jev's
// folded answer equals Haiku's. Haiku never answers a plan-health question,
// so this reads n/a there.
export function agreementOf(records, question) {
  const rows = scorable(records).filter((r) => typeof r.haikuValue === "string");
  const agree = rows.filter((r) => foldedValue(question, r.value) === foldedValue(question, r.haikuValue)).length;
  return { agree, n: rows.length, agreement: rows.length === 0 ? null : agree / rows.length };
}

// --- Outcome kinds and AUC ---

// The block-owner scoring rule this document states: an operator answer is
// true where next_speaker is channel, coordinator and another-plan are true
// where it is delivery, and self-resolving and none are true where it is
// neither.
const BLOCK_OWNER_NEXT_SPEAKER_TRUTH = Object.freeze({
  operator: "channel",
  coordinator: "delivery",
  "another-plan": "delivery",
  "self-resolving": "neither",
  none: "neither",
});

// Whether the outcome line of `kind` observed on a record counts as a true
// case for `optionId`. block-owner's next_speaker kind takes the stated
// mapping above; every other (question, kind) pair takes the outcome's value
// literally, which is what lets a controller-decision record's next_score
// outcome of "complete" count toward the "complete" option's AUC with no
// table of its own, the two questions sharing that one word. A kind whose
// value never equals an option id, such as ask_marker's constant "matched",
// yields no positive case for any option and its AUC reads n/a: this tool
// states no rule for it, since the spec names none.
function outcomeTruth(question, optionId, outcomeKind, outcomeValue) {
  if (question === "block-owner" && outcomeKind === "next_speaker") {
    return BLOCK_OWNER_NEXT_SPEAKER_TRUTH[optionId] === outcomeValue;
  }
  return outcomeValue === optionId;
}

// The probability a record carries for `optionId`, folded the way an
// answer is: on controller-decision, ask-operator's own score is its
// probability plus pause's, since a pause answer scores as ask-operator and
// the seam always offers both together, so scoring ask-operator on its own
// key alone would drop the probability mass Jev put on the option gold can
// never single out from it. Returns null where the record carries neither
// key at all, which is the option itself carries no signal on this record.
function optionProbability(question, record, optionId) {
  const probs = record.probabilities || {};
  if (question === "controller-decision" && optionId === "ask-operator") {
    if (!("ask-operator" in probs) && !("pause" in probs)) return null;
    const a = typeof probs["ask-operator"] === "number" ? probs["ask-operator"] : 0;
    const b = typeof probs.pause === "number" ? probs.pause : 0;
    return a + b;
  }
  return typeof probs[optionId] === "number" ? probs[optionId] : null;
}

export function outcomeKindsPresent(records) {
  const kinds = new Set();
  for (const r of records) for (const o of r.outcomes) kinds.add(o.kind);
  return [...kinds].sort();
}

// The last outcome of `kind` on a record's outcome list, since a record can
// carry more than one line of a kind only where the plugin overwrote it,
// which none of these three questions' sites do; taking the last is the same
// as taking the one where there is one.
function outcomeValueOf(record, kind) {
  const hits = record.outcomes.filter((o) => o.kind === kind);
  return hits.length === 0 ? undefined : hits[hits.length - 1].value;
}

// Cohen-free rank-sum AUC: the probability a record with a true outcome
// scores higher than one with a false outcome, on `probabilities[optionId]`
// as the score and `outcomeTruth` as the label. Ties split the rank evenly.
// Returns null where there is no record of one class or the other, or no
// record carries the option's probability at all, since AUC is undefined
// with nothing to rank against.
export function aucOf(records, question, optionId, outcomeKind) {
  const scored = [];
  for (const r of records) {
    const value = outcomeValueOf(r, outcomeKind);
    if (value === undefined) continue;
    const p = optionProbability(question, r, optionId);
    if (typeof p !== "number") continue;
    scored.push({ p, truth: outcomeTruth(question, optionId, outcomeKind, value) });
  }
  const positives = scored.filter((s) => s.truth);
  const negatives = scored.filter((s) => !s.truth);
  if (positives.length === 0 || negatives.length === 0) return null;
  const ranked = scored.slice().sort((a, b) => a.p - b.p);
  let rank = 1;
  let i = 0;
  const rankOf = new Map();
  while (i < ranked.length) {
    let j = i;
    while (j + 1 < ranked.length && ranked[j + 1].p === ranked[i].p) j += 1;
    const avg = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k++) rankOf.set(ranked[k], avg);
    rank += j - i + 1;
    i = j + 1;
  }
  const rankSum = positives.reduce((s, p) => s + rankOf.get(p), 0);
  const auc = (rankSum - (positives.length * (positives.length + 1)) / 2) / (positives.length * negatives.length);
  return { auc, positives: positives.length, negatives: negatives.length, n: scored.length };
}

// --- Bars ---

// One named place every bar's figures live, so the block-owner operator
// count floor under operator review (40, may become 30) is one edit. Each
// bar reads a metric off the scorable, top-probability-filtered rows: the
// whole-question accuracy, or one option's precision or recall.
export const TOP_PROBABILITY_FLOOR = 0.6;
export const BLOCK_OWNER_OPERATOR_COUNT_FLOOR = 40;
export const DEFAULT_RECALL_COUNT_FLOOR = 10;

// `conditional` marks a per-option recall bar the spec applies only where
// gold holds at least its own countFloor of that option (section 3: "where
// gold holds at least ten of it"; section 4: "on each option the gold sample
// holds at least ten of"). Below the floor, `evalBar` reads the bar as not
// applicable rather than failed. block-owner's operator bars carry no such
// clause; section 5 states their 40 (under review, may become 30) as a plain
// floor, so they stay `not met` below it like the accuracy bars.
export const BARS = Object.freeze({
  "controller-decision": [
    { key: "accuracy", metric: "accuracy", threshold: 0.85, countFloor: 100 },
    { key: "recall:complete", metric: "recall", option: "complete", threshold: 0.6, countFloor: DEFAULT_RECALL_COUNT_FLOOR, conditional: true },
    { key: "recall:ask-operator", metric: "recall", option: "ask-operator", threshold: 0.5, countFloor: DEFAULT_RECALL_COUNT_FLOOR, conditional: true },
  ],
  "turn-score": [
    { key: "accuracy", metric: "accuracy", threshold: 0.85, countFloor: 100 },
    { key: "recall:on-goal", metric: "recall", option: "on-goal", threshold: 0.6, countFloor: DEFAULT_RECALL_COUNT_FLOOR, conditional: true },
    { key: "recall:off-goal-by-instruction", metric: "recall", option: "off-goal-by-instruction", threshold: 0.6, countFloor: DEFAULT_RECALL_COUNT_FLOOR, conditional: true },
    { key: "recall:drift", metric: "recall", option: "drift", threshold: 0.6, countFloor: DEFAULT_RECALL_COUNT_FLOOR, conditional: true },
    { key: "recall:complete", metric: "recall", option: "complete", threshold: 0.6, countFloor: DEFAULT_RECALL_COUNT_FLOOR, conditional: true },
  ],
  "block-owner": [
    { key: "precision:operator", metric: "precision", option: "operator", threshold: 0.75, countFloor: BLOCK_OWNER_OPERATOR_COUNT_FLOOR },
    { key: "recall:operator", metric: "recall", option: "operator", threshold: 0.75, countFloor: BLOCK_OWNER_OPERATOR_COUNT_FLOOR },
  ],
});

// The rows a bar reads: scorable, and at or above the top-probability floor.
function barRows(records) {
  return scorable(records).filter((r) => topProbability(r.probabilities) >= TOP_PROBABILITY_FLOOR);
}

// The coverage floor: a bar reads not met below it even where its own figure
// clears its threshold, so filtering to the confident rows cannot hide a
// question that is rarely sure of anything.
export const COVERAGE_FLOOR = 0.7;

// The share of a question's scorable gold at or above the top-probability
// floor, read once per question and version rather than per option, since it
// is a property of how sure Jev is on the question as a whole.
export function coverageOf(records, question) {
  const total = scorable(records).length;
  const above = barRows(records).length;
  return { total, above, coverage: total === 0 ? null : above / total };
}

// One bar's line: the figure, the count it was read over, coverage, and met
// or not met. A count under the bar's floor, or coverage under its own,
// reads not met whatever the figure, so a thin or overfiltered sample never
// passes on a lucky number. A `conditional` bar below its own floor is not
// applicable rather than failed: the spec states these per-option recall
// bars as gated on gold actually holding the option, not as a floor a thin
// sample fails, so a v2 whose dev bar this tool prints for the options gold
// does hold is not blocked by one it holds too few of to read.
export function evalBar(bar, question, version, records, split) {
  const rows = barRows(records);
  let figure;
  let n;
  if (bar.metric === "accuracy") {
    const acc = accuracyOf(rows, question);
    figure = acc.accuracy;
    n = acc.n;
  } else {
    const pr = precisionRecallOf(rows, question)[bar.option];
    const stat = pr ? pr[bar.metric] : null;
    figure = stat;
    // The bar's own denominator: the gold rows the option actually holds,
    // since "gold holds at least ten (or forty) of it" counts the label, not
    // every scorable row.
    n = rows.filter((r) => r.label === bar.option).length;
  }
  const cov = coverageOf(records, question);
  const printedCoverage = cov.coverage === null ? "n/a" : cov.coverage.toFixed(3);
  const coverageSuffix = `, coverage ${printedCoverage} over ${cov.total}`;
  if (bar.conditional) {
    // Counted over scorable gold before the 0.6 filter: "gold holds" reads
    // the whole sample's own count of the option, not the confident subset
    // the bar's other figures are read over.
    const k = scorable(records).filter((r) => r.label === bar.option).length;
    if (k < bar.countFloor) {
      return `bar: ${question}:${bar.key} ${version} n/a (gold holds ${k}) over ${n} on ${split}${coverageSuffix}`;
    }
  }
  const met = figure !== null && n >= bar.countFloor && figure >= bar.threshold &&
    cov.coverage !== null && cov.coverage >= COVERAGE_FLOOR;
  const printedFigure = figure === null ? "n/a" : figure.toFixed(3);
  return `bar: ${question}:${bar.key} ${version} ${met ? "met" : "not met"} ${printedFigure} over ${n} on ${split}${coverageSuffix}`;
}

// --- Report ---

function formatConfusion(confusion) {
  const lines = [];
  for (const label of Object.keys(confusion).sort()) {
    const row = confusion[label];
    const parts = Object.keys(row).sort().map((p) => `${p}=${row[p]}`).join(" ");
    lines.push(`    ${label}: ${parts}`);
  }
  return lines;
}

function formatPrecisionRecall(pr) {
  const lines = [];
  for (const label of Object.keys(pr).sort()) {
    const s = pr[label];
    lines.push(`  ${label}: precision ${s.precision === null ? "n/a" : s.precision.toFixed(3)}, recall ${s.recall === null ? "n/a" : s.recall.toFixed(3)} (tp=${s.tp} fp=${s.fp} fn=${s.fn})`);
  }
  return lines;
}

function formatUnfolded(acc) {
  return acc === null ? "" : `, pause unfolded: ${acc.accuracy === null ? "n/a" : acc.accuracy.toFixed(3)} (${acc.correct}/${acc.n})`;
}

// A calibration bin's own label: half-open on the low side so a reader can
// tell the bins apart at a glance, closed on the high side only for the last
// one, which is where the highest probability a record can carry actually
// lands.
function formatBinLabel(b, isLast) {
  return isLast ? `[${b.low.toFixed(1)}, ${b.high.toFixed(1)}]` : `[${b.low.toFixed(1)}, ${b.high.toFixed(1)})`;
}

function formatOne(question, version, split, records) {
  const lines = [];
  lines.push(`== ${question} ${version} (n=${records.length}) ==`);
  const acc = accuracyOf(records, question);
  const unclear = records.filter((r) => r.label === "unclear").length;
  lines.push(`accuracy: ${acc.accuracy === null ? "n/a" : acc.accuracy.toFixed(3)} (${acc.correct}/${acc.n}), unclear excluded: ${unclear}${formatUnfolded(unfoldedAccuracyOf(records, question, (r) => r.value))}`);
  lines.push("confusion (gold row, predicted columns):");
  lines.push(...formatConfusion(confusionOf(records, question)));
  lines.push("precision and recall:");
  lines.push(...formatPrecisionRecall(precisionRecallOf(records, question)));
  // Haiku's own read against gold, so the Chapter says whose error a low
  // agreement figure was: gold-vs-Jev above, gold-vs-Haiku here, both under
  // the same fold and the same unclear exclusion. Left out where no record
  // in this group carries a Haiku value, which is every block-owner record.
  const haikuAcc = haikuAccuracyOf(records, question);
  if (haikuAcc !== null) {
    lines.push(`Haiku accuracy against gold: ${haikuAcc.accuracy === null ? "n/a" : haikuAcc.accuracy.toFixed(3)} (${haikuAcc.correct}/${haikuAcc.n})${formatUnfolded(unfoldedAccuracyOf(haikuRows(records), question, (r) => r.haikuValue))}`);
    lines.push("Haiku confusion (gold row, predicted columns):");
    lines.push(...formatConfusion(haikuConfusionOf(records, question)));
    lines.push("Haiku precision and recall:");
    lines.push(...formatPrecisionRecall(haikuPrecisionRecallOf(records, question)));
  }
  lines.push("calibration by top-probability bin:");
  const bins = calibrationOf(records, question);
  bins.forEach((b, i) => {
    lines.push(`  ${formatBinLabel(b, i === bins.length - 1)}: n=${b.n}, avg confidence ${b.avgConfidence === null ? "n/a" : b.avgConfidence.toFixed(3)}, accuracy ${b.accuracy === null ? "n/a" : b.accuracy.toFixed(3)}`);
  });
  const agreement = agreementOf(records, question);
  lines.push(`agreement with Haiku: ${agreement.agreement === null ? "n/a" : agreement.agreement.toFixed(3)} (${agreement.agree}/${agreement.n})`);
  const kinds = outcomeKindsPresent(records);
  if (kinds.length === 0) {
    lines.push("AUC against outcomes: none present");
  } else {
    for (const kind of kinds) {
      lines.push(`AUC against ${kind}:`);
      // Every option any record was offered, not just the ones Jev picked:
      // an option Jev never chose still carries a probability the record's
      // own call assigned it, and that is what an AUC line needs to exist at
      // all. Folded the same way an answer is, so ask-operator's own line
      // covers the pause mass aucOf itself folds in.
      const options = new Set();
      for (const r of records) for (const id of Object.keys(r.probabilities || {})) options.add(foldedValue(question, id));
      for (const option of [...options].sort()) {
        const a = aucOf(records, question, option, kind);
        lines.push(`  ${option}: ${a === null ? "n/a" : `${a.auc.toFixed(3)} (n=${a.n}, ${a.positives} true, ${a.negatives} false)`}`);
      }
    }
  }
  for (const bar of BARS[question] || []) lines.push(evalBar(bar, question, version, records, split));
  return lines;
}

export function report(question, split, versionGroups) {
  const lines = [];
  for (const version of [...versionGroups.keys()].sort()) {
    lines.push(...formatOne(question, version, split, versionGroups.get(version)));
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

// The journal baseline groups restricted to the records the replay scored, so
// each baseline figure is read on the same turns as the replay's: a replay
// row that failed leaves its record out of the replay's groups, and without
// this the baseline would be read over turns the replay never answered. Each
// baseline version is restricted against the replay alone, never against
// another baseline, since a sample drawn across a version change holds
// baselines on disjoint records. The replay groups are restricted to the
// records every replay group scored. Returns the restricted groups, baselines
// and replays together, the count the replay groups share, and each
// baseline's count after the restriction.
export function onSharedRecords(baselineGroups, replayGroups) {
  const replayLists = [...replayGroups.values()];
  const scored = new Set(replayLists.length === 0 ? [] : replayLists[0].map((r) => r.id));
  for (const list of replayLists.slice(1)) {
    const ids = new Set(list.map((r) => r.id));
    for (const id of [...scored]) if (!ids.has(id)) scored.delete(id);
  }
  const groups = new Map();
  const baselineCounts = new Map();
  for (const [version, list] of baselineGroups) {
    const kept = list.filter((r) => scored.has(r.id));
    groups.set(version, kept);
    baselineCounts.set(version, kept.length);
  }
  for (const [version, list] of replayGroups) groups.set(version, list.filter((r) => scored.has(r.id)));
  return { groups, shared: scored.size, baselineCounts };
}

function groupByVersion(records, keyOf = (r) => r.version) {
  const out = new Map();
  for (const r of records) {
    const key = keyOf(r);
    const list = out.get(key);
    if (list) list.push(r); else out.set(key, [r]);
  }
  return out;
}

// The one split every gold row must share: sample.mjs draws one split at a
// time, so mixed splits in one gold.jsonl are a file assembled from more
// than one run, not a shape this tool prints one label over.
function splitOf(joined) {
  const splits = new Set(joined.map((r) => r.split));
  if (splits.size > 1) throw new Error(`gold mixes splits: ${[...splits].sort().join(", ")}`);
  return splits.size === 0 ? "dev" : [...splits][0];
}

// --- The command ---

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`bad argument: ${a}`);
    if (a === "--question") flags.question = v;
    else if (a === "--gold") flags.gold = v;
    else if (a === "--replay") flags.replay = v;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!flags.question || !QUESTIONS[flags.question]) throw new Error(`--question must be one of ${Object.keys(QUESTIONS).join(", ")}`);
  if (!flags.gold) throw new Error("--gold is required");
  return flags;
}

export function main(argv) {
  const flags = parseArgs(argv);
  const gold = readGold(flags.gold);
  const dir = path.dirname(flags.gold);
  const sample = sampleById(dir);
  const joined = joinGoldSample(flags.question, gold, sample);
  const split = splitOf(joined);
  let groups = groupByVersion(joined);
  if (flags.replay) {
    const baseline = groups;
    const { records, failed, missing } = withReplay(joined, readReplay(flags.replay));
    // Keyed apart from the journal baseline's own groups, "v1" among them: a
    // replay record's version, ok or not, never overwrites the baseline it is
    // meant to sit beside.
    const replays = groupByVersion(records, (r) => `${r.version}.replay`);
    if (failed > 0) process.stdout.write(`note: ${failed} replay record(s) failed and are excluded from every figure\n`);
    if (missing > 0) process.stdout.write(`note: ${missing} gold record(s) carry no line in the replay file at all\n`);
    // Each baseline version is read on the records the replay scored, and
    // each baseline over all of its own records is kept beside it as
    // `<version>.all`.
    const restricted = onSharedRecords(baseline, replays);
    const counts = [...restricted.baselineCounts].map(([version, n]) => `${version} on ${n}`).join(", ");
    process.stdout.write(`note: the replay scored ${restricted.shared} gold record(s); each journal version is read on those it holds (${counts}); <version>.all is that version over all of its own records\n`);
    groups = restricted.groups;
    for (const [version, list] of baseline) groups.set(`${version}.all`, list);
  }
  const text = report(flags.question, split, groups);
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`score: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 2;
  }
}
