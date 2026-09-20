#!/usr/bin/env node
// Injection duplicate + size guard, per
// docs/plans/agent_persona_lean-injection_v1.md Section 1.
//
// Runs the injection ledger (.kit/injection-ledger.mjs), which reads only
// bin/supervise.sh and hooks/index.ts, and fails on either:
//   (a) a sentence of eight or more words that appears both in an injected
//       string and in CLAUDE.md, or in two different injected strings;
//   (b) a string whose live chars exceed the number recorded for it in
//       .kit/injection-ledger.json;
//   (c) a string named in the ledger's baseline but no longer produced by a
//       live run, or a live string with no baseline entry to compare
//       against - either shape means the baseline is stale, and the fix is
//       to refresh .kit/injection-ledger.json, not to leave the mismatch
//       unreported.
// This check reads two files (bin/supervise.sh, hooks/index.ts); a third
// injection site outside those two files carries no rule here and is not
// covered. Among the two files it does read, a sentence two prompts both
// need is a sentence with one owner and a pointer, never two copies.
//
// Usage: node .kit/injection-duplicate-test.mjs
// Exits 0 when neither condition fires, 1 when either does.
//
// This file also carries its own fixture-based controls (run first, always,
// regardless of the real result below them), each exercising the
// production findDuplicates()/findSizeViolations() functions rather than a
// hand-rolled reimplementation:
//   - a positive/negative pair on the CLAUDE.md-vs-injected path, built
//     from a raw, marker-prefixed CLAUDE.md line read fresh off disk (not
//     copied from the matcher's own normalized output), so the control
//     proves the marker-stripping rule works rather than proving only that
//     the matcher can see a string it was handed as a pattern;
//   - a positive/negative pair on the injected-vs-injected path (two
//     fixture sources sharing a sentence neither CLAUDE.md nor any real
//     injected string carries);
//   - a positive/negative pair on the size guard, with a deliberately
//     undersized and a sufficient baseline entry.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLedger } from "./injection-ledger.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(__dirname, "..");
const claudeMdPath = join(repoRoot, "CLAUDE.md");
const ledgerJsonPath = join(__dirname, "injection-ledger.json");

function readNormalized(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

// --- The matcher, shared by the real check and the fixture control below ---

// A decoded newline is always a sentence boundary, even with no closing
// punctuation before it: two sentences printed on adjacent source lines
// (a shell string's line break, a template literal's `\n`) are two
// sentences, not one glued together at the seam.
function splitSentences(text) {
  return text
    .split("\n")
    .flatMap((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    );
}

function wordCount(sentence) {
  return sentence.split(/\s+/).filter(Boolean).length;
}

// Strips a leading markdown marker (a heading `#`, a bullet `-`/`*`/`>`, or
// an ordered-list `N.`) from each line, so a CLAUDE.md bullet indexes on
// the same plain-prose shape an injected copy of it carries. Applied only
// to CLAUDE.md, never to an injected string, since the injected strings
// carry no markdown syntax of their own to strip.
function stripMarkdownMarkers(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*>]|\d+\.)\s+/, ""))
    .join("\n");
}

// Builds, from a list of { name, text } sources, a map from each sentence of
// eight or more words to the set of source names it appears in. A sentence
// repeated more than once inside the same source counts that source once.
function sentenceIndex(sources) {
  const index = new Map();
  for (const { name, text } of sources) {
    const seenHere = new Set();
    for (const sentence of splitSentences(text)) {
      if (wordCount(sentence) < 8) continue;
      if (seenHere.has(sentence)) continue;
      seenHere.add(sentence);
      if (!index.has(sentence)) index.set(sentence, new Set());
      index.get(sentence).add(name);
    }
  }
  return index;
}

// injectedSources: [{ name, text }], one per injected string. claudeMdText:
// CLAUDE.md's own content. Returns [{ sentence, sources }] for every
// sentence that appears in an injected string and in CLAUDE.md, or in two
// or more different injected strings.
function findDuplicates(injectedSources, claudeMdText) {
  const CLAUDE_MD = "CLAUDE.md";
  const index = sentenceIndex([...injectedSources, { name: CLAUDE_MD, text: stripMarkdownMarkers(claudeMdText) }]);
  const findings = [];
  for (const [sentence, sourceSet] of index) {
    const sources = [...sourceSet];
    const injectedHits = sources.filter((s) => s !== CLAUDE_MD);
    const inClaudeMd = sources.includes(CLAUDE_MD);
    if (injectedHits.length === 0) continue; // CLAUDE.md-only: not a duplicate this guard reports.
    if (inClaudeMd || injectedHits.length >= 2) {
      findings.push({ sentence, sources });
    }
  }
  return findings;
}

// --- Size guard ---

// liveEntries/baselineEntries: [{ name, chars, ... }]. Returns
// [{ name, liveChars, baselineChars }] for every name present in both whose
// live chars exceed the baseline. Name mismatches (a rename, an addition, a
// removal) are not this function's concern - findNameMismatches below
// reports those - so this only ever compares a name present on both sides.
function findSizeViolations(liveEntries, baselineEntries) {
  const baselineByName = new Map(baselineEntries.map((e) => [e.name, e]));
  const violations = [];
  for (const live of liveEntries) {
    const base = baselineByName.get(live.name);
    if (!base) continue;
    if (live.chars > base.chars) {
      violations.push({ name: live.name, liveChars: live.chars, baselineChars: base.chars });
    }
  }
  return violations;
}

// A live name with no baseline entry, or a baseline name no live run still
// produces, both mean the baseline is stale relative to the ledger's own
// extraction: a rename or a newly-added injected string must be reflected
// in .kit/injection-ledger.json, the one case "growth is declared" exists
// for, rather than silently comparing a live entry against nothing (or
// leaving a baseline entry uncompared against anything live).
function findNameMismatches(liveEntries, baselineEntries) {
  const liveNames = new Set(liveEntries.map((e) => e.name));
  const baselineNames = new Set(baselineEntries.map((e) => e.name));
  const onlyInLive = [...liveNames].filter((n) => !baselineNames.has(n));
  const onlyInBaseline = [...baselineNames].filter((n) => !liveNames.has(n));
  return { onlyInLive, onlyInBaseline };
}

// --- Run ---

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name) { console.error(`  FAIL: ${name}`); failed++; }

// Fixture control 1: CLAUDE.md-vs-injected, on a marker-prefixed line. The
// shared sentence is chosen by shape - a raw line off disk that still
// carries a markdown marker (`#`/`-`/`*`/`>`/`N.`) - rather than taken from
// splitSentences()'s own already-processed output, so the control proves
// the marker-stripping rule in findDuplicates() actually fires rather than
// proving only that the matcher can see a string it was handed as a
// literal pattern.
{
  const claudeMdText = readNormalized(claudeMdPath);
  const markerLineRe = /^\s*(?:#{1,6}|[-*>]|\d+\.)\s+(.*)$/;
  let sharedSentence = null;
  for (const line of claudeMdText.split("\n")) {
    const lm = markerLineRe.exec(line);
    if (!lm) continue;
    const candidates = splitSentences(lm[1]).filter((s) => wordCount(s) >= 8);
    if (candidates.length > 0) { sharedSentence = candidates[0]; break; }
  }
  if (sharedSentence === null) {
    fail("fixture control: CLAUDE.md carries no marker-prefixed line with a matchable 8+ word sentence to build the positive fixture from");
  } else {
    // Positive fixture: an injected-shaped string (plain prose, no
    // markdown marker of its own - the shape a real injected copy of a
    // CLAUDE.md bullet actually takes) carrying the marker-stripped
    // sentence verbatim, plus filler. Compared against the raw,
    // unstripped claudeMdText, so the match can only succeed if
    // findDuplicates() strips the marker off the CLAUDE.md side itself.
    const positiveFixture = [
      { name: "FIXTURE_POSITIVE", text: `This fixture string is not itself part of CLAUDE.md.\n${sharedSentence}\nIt carries one shared sentence and nothing else that matters.` },
    ];
    const positiveResult = findDuplicates(positiveFixture, claudeMdText);
    const spoke = positiveResult.some((f) => f.sentence === sharedSentence && f.sources.includes("FIXTURE_POSITIVE") && f.sources.includes("CLAUDE.md"));
    if (spoke) ok("fixture control: speaks on a fixture string carrying one marker-prefixed CLAUDE.md line's sentence");
    else fail("fixture control: did not speak on a fixture string carrying one marker-prefixed CLAUDE.md line's sentence (" + JSON.stringify(positiveResult) + ")");

    // Negative fixture: an injected string of the same shape and length
    // class, carrying no CLAUDE.md sentence anywhere in it. The matcher
    // must stay silent, and stay silent for the right reason (no shared
    // sentence found), not because the check never ran at all.
    const negativeFixture = [
      { name: "FIXTURE_NEGATIVE", text: "This fixture string shares no sentence with CLAUDE.md, the reply instruction, or any other injected string in this repository at all." },
    ];
    const negativeResult = findDuplicates(negativeFixture, claudeMdText);
    if (negativeResult.length === 0) ok("fixture control: silent on a fixture string carrying no CLAUDE.md sentence");
    else fail("fixture control: spoke on a fixture that shares nothing with CLAUDE.md (" + JSON.stringify(negativeResult) + ")");
  }
}

// Fixture control 2: injected-vs-injected, on two fixture sources sharing
// a sentence that lives in neither CLAUDE.md nor any real injected string,
// so this exercises the injectedHits.length >= 2 branch specifically
// (withheld from the real check's own literals, matched on shape).
{
  const claudeMdText = readNormalized(claudeMdPath);
  const sharedSentence = "This fixture sentence exists only to exercise the injected versus injected duplicate path directly.";
  const twoSourcePositive = [
    { name: "FIXTURE_TWO_SOURCE_A", text: `Filler unique to source A. ${sharedSentence}` },
    { name: "FIXTURE_TWO_SOURCE_B", text: `${sharedSentence} Filler unique to source B.` },
  ];
  const twoSourcePositiveResult = findDuplicates(twoSourcePositive, claudeMdText);
  const spokeTwoSource = twoSourcePositiveResult.some(
    (f) => f.sentence === sharedSentence && f.sources.includes("FIXTURE_TWO_SOURCE_A") && f.sources.includes("FIXTURE_TWO_SOURCE_B") && !f.sources.includes("CLAUDE.md"),
  );
  if (spokeTwoSource) ok("fixture control: speaks on two fixture sources sharing one sentence (injected-vs-injected)");
  else fail("fixture control: did not speak on two fixture sources sharing one sentence (" + JSON.stringify(twoSourcePositiveResult) + ")");

  const twoSourceNegative = [
    { name: "FIXTURE_TWO_SOURCE_C", text: "Filler unique to source C, sharing no sentence with source D." },
    { name: "FIXTURE_TWO_SOURCE_D", text: "Filler unique to source D, sharing no sentence with source C." },
  ];
  const twoSourceNegativeResult = findDuplicates(twoSourceNegative, claudeMdText).filter(
    (f) => f.sources.includes("FIXTURE_TWO_SOURCE_C") || f.sources.includes("FIXTURE_TWO_SOURCE_D"),
  );
  if (twoSourceNegativeResult.length === 0) ok("fixture control: silent on two fixture sources sharing no sentence");
  else fail("fixture control: spoke on two fixture sources sharing no sentence (" + JSON.stringify(twoSourceNegativeResult) + ")");
}

// Fixture control 3: the size guard, with a deliberately undersized and a
// sufficient baseline entry, so both directions of findSizeViolations() are
// proven rather than only the direction the real check happens to hit.
{
  const liveFixture = [
    { name: "FIXTURE_SIZE_GREW", chars: 50 },
    { name: "FIXTURE_SIZE_OK", chars: 20 },
  ];
  const baselineFixture = [
    { name: "FIXTURE_SIZE_GREW", chars: 10 },
    { name: "FIXTURE_SIZE_OK", chars: 20 },
  ];
  const sizeResult = findSizeViolations(liveFixture, baselineFixture);
  const flaggedGrowth = sizeResult.some((v) => v.name === "FIXTURE_SIZE_GREW");
  const silentOnEqual = !sizeResult.some((v) => v.name === "FIXTURE_SIZE_OK");
  if (flaggedGrowth) ok("fixture control: flags a live entry exceeding its undersized baseline");
  else fail("fixture control: did not flag a live entry exceeding its undersized baseline (" + JSON.stringify(sizeResult) + ")");
  if (silentOnEqual) ok("fixture control: silent on a live entry matching its baseline");
  else fail("fixture control: flagged a live entry that matches its baseline (" + JSON.stringify(sizeResult) + ")");
}

// The real check: every injected string the ledger extracts, against
// CLAUDE.md and against each other, plus the size guard and the
// name-reconciliation guard against the committed baseline.
{
  const claudeMdText = readNormalized(claudeMdPath);
  const liveEntries = buildLedger(); // [{ name, file, chars, words, text }]
  const injectedSources = liveEntries.map(({ name, text }) => ({ name, text }));

  const zeroChar = liveEntries.filter((e) => e.chars === 0);
  if (zeroChar.length === 0) {
    ok("zero-length check: no live entry extracted 0 chars");
  } else {
    for (const e of zeroChar) {
      fail(`live entry with 0 chars: ${e.name} - extraction found nothing to size or match`);
    }
  }

  const duplicates = findDuplicates(injectedSources, claudeMdText);
  if (duplicates.length === 0) {
    ok("duplicate check: no sentence of 8+ words shared between an injected string and CLAUDE.md, or between two injected strings");
  } else {
    for (const { sentence, sources } of duplicates) {
      fail(`duplicate sentence across [${sources.join(", ")}]: "${sentence}"`);
    }
    console.error(`\n${duplicates.length} duplicate sentence(s) found.`);
  }

  const baseline = JSON.parse(readNormalized(ledgerJsonPath));

  const mismatches = findNameMismatches(liveEntries, baseline.entries);
  if (mismatches.onlyInLive.length === 0 && mismatches.onlyInBaseline.length === 0) {
    ok("name reconciliation: every live entry has a baseline entry and every baseline entry has a live entry");
  } else {
    for (const n of mismatches.onlyInLive) {
      fail(`live entry not in the baseline: ${n} - refresh .kit/injection-ledger.json (node .kit/injection-ledger.mjs > .kit/injection-ledger.json)`);
    }
    for (const n of mismatches.onlyInBaseline) {
      fail(`baseline entry no live run produces: ${n} - the extraction that produced it is gone or renamed; refresh .kit/injection-ledger.json`);
    }
  }

  const sizeViolations = findSizeViolations(liveEntries, baseline.entries);
  if (sizeViolations.length === 0) {
    ok("size check: no injected string exceeds its recorded ledger size");
  } else {
    for (const v of sizeViolations) {
      fail(`size grew without a ledger update: ${v.name} is ${v.liveChars} chars, ledger recorded ${v.baselineChars}`);
    }
  }
}

const summary = `\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`;
console.log(summary);
process.exit(failed === 0 ? 0 : 1);
