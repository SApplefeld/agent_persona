#!/usr/bin/env node
// Injection duplicate + size guard, per
// docs/plans/agent_persona_lean-injection_v1.md Section 1.
//
// Runs the injection ledger (.kit/injection-ledger.mjs), which reads only
// bin/supervise.sh and hooks/index.ts, and fails on any of:
//   (a) a sentence of eight or more words that appears both in an injected
//       string and in CLAUDE.md, or in two different injected strings;
//   (b) a string whose live chars exceed the number recorded for it in
//       .kit/injection-ledger.json;
//   (c) a string named in the ledger's baseline but no longer produced by a
//       live run, or a live string with no baseline entry to compare
//       against - either shape means the baseline is stale, and the fix is
//       to refresh .kit/injection-ledger.json, not to leave the mismatch
//       unreported;
//   (d) a ledger throw. The ledger fails closed: an extraction whose anchor
//       stopped matching, an instruction clause that left its single-line
//       shape, an instruction variable, context block or prompt call site
//       its tables do not name, or a delivery site that gained literal
//       text, throws out of buildLedger() rather than recording a short
//       value, and that throw ends this run non-zero before any check
//       below reads a partial ledger.
// This check reads two files (bin/supervise.sh, hooks/index.ts). One
// coverage bound inside them is declared and pinned below: the three
// record-delivery prompts whose whole text hooks/operator.ts's deliveryText
// builds are excluded, two of them named in the ledger's call-site list and
// the third reached only by the count the ledger asserts over every
// deliveryText site, since it delivers inside a running turn as tool-result
// context rather than through a prompt call. The ledger asserts that
// hooks/index.ts adds no literal text at any of the three, an assertion
// bounded by the ledger header's own note that a bare reference and a
// hoisted literal are the same shape to a pattern. Among the strings it does
// read, a sentence two prompts both need is a sentence with one owner and
// a pointer, never two copies.
//
// Usage: node .kit/injection-duplicate-test.mjs
// Exits 0 when no condition fires, 1 when any does.
//
// This file also carries its own fixture-based controls (run first, always,
// regardless of the real result below them), each exercising the
// production functions rather than a hand-rolled reimplementation:
//   - a positive/negative pair on the CLAUDE.md-vs-injected path, built
//     from a raw, marker-prefixed CLAUDE.md line read fresh off disk (not
//     copied from the matcher's own normalized output), so the control
//     proves the marker-stripping rule works rather than proving only that
//     the matcher can see a string it was handed as a pattern;
//   - a positive/negative pair on the injected-vs-injected path (two
//     fixture sources sharing a sentence neither CLAUDE.md nor any real
//     injected string carries);
//   - a positive/negative pair on the size guard, with a deliberately
//     undersized and a sufficient baseline entry;
//   - one control per fail-closed ledger guard, each handing
//     buildLedgerFrom() a copy of the real source mutated into a shape the
//     guard's own patterns do not name (a clause wrapped with a line
//     continuation, a new instruction variable, a new context block, a new
//     prompt call site, a literal at a delivery site) and requiring the
//     throw to come from that guard by its tag, so one guard cannot mask
//     another's silence; plus one proving the fleet line-literal collector
//     reads a label nested inside a ternary inside an interpolation.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLedger, buildLedgerFrom, EXCLUDED_PROMPT_SITES, DELIVERY_SITE_COUNT } from "./injection-ledger.mjs";

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
// This suite is red by design until Sections 2 to 4 land, so exit 1 alone
// cannot tell "the real duplicates are still there" from "a control or a
// guard broke". Those are opposite readings: the first is the expected
// state and the second means this suite has stopped checking what it
// claims to. A control or guard failure therefore exits 2, and exit 1 is
// reserved for a run where every control passed and the real check is the
// only thing that failed. A reader of the exit code alone can then tell
// the designed red from a broken instrument.
let instrumentFailed = 0;
// One predicate, read by the classifier below and driven by the self-test
// further down. Two copies of it would let the self-test pass while the
// classifier drifted, since each would be testing its own literal: the
// self-test would then prove only that a regex sorts the labels it was
// handed, which is not the question. `exit-code split` is a member because
// that self-test's own failure is itself a broken instrument, and a
// predicate that did not name it would report the one failure that means
// the split has stopped working as though it were the designed red.
const INSTRUMENT_LABEL_RE = /^(fixture control|guard control|exclusion pin|exit-code split)/;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name) {
  console.error(`  FAIL: ${name}`);
  failed++;
  if (INSTRUMENT_LABEL_RE.test(name)) instrumentFailed++;
}

// The exit-code split rests on one predicate over a label, so it is driven
// rather than asserted. The labels below are the ones this file actually
// prints, taken from both classes: three that must raise the instrument
// flag and three from the real check that must not. A predicate that
// drifted from the labels would otherwise send every failure down one
// branch and the split would read correct while doing nothing.
{
  const isInstrument = (name) => INSTRUMENT_LABEL_RE.test(name);
  const instrumentLabels = [
    "guard control: a fourth deliveryText call site - refused by [delivery-exclusion]",
    "fixture control: silent on a fixture string carrying no CLAUDE.md sentence",
    "exclusion pin: the ledger declares 3 deliveryText call sites and hooks/index.ts holds that many",
    "exit-code split: instrument label read as real check: guard control: something",
  ];
  const realCheckLabels = [
    'duplicate sentence across [CHANNEL_REPLY_INSTRUCTION, REPLY_INSTRUCTION]: "a sentence"',
    "live entry with 0 chars: SOME_INSTRUCTION - extraction found nothing to size or match",
    "size grew without a ledger update: SOME_INSTRUCTION is 40 chars, ledger recorded 30",
    "live entry not in the baseline: SOME_INSTRUCTION - refresh .kit/injection-ledger.json",
    "baseline entry no live run produces: SOME_INSTRUCTION - the extraction that produced it is gone or renamed",
  ];
  const misread = [
    ...instrumentLabels.filter((l) => !isInstrument(l)).map((l) => `instrument label read as real check: ${l}`),
    ...realCheckLabels.filter((l) => isInstrument(l)).map((l) => `real-check label read as instrument: ${l}`),
  ];
  if (misread.length === 0) ok(`exit-code split: the predicate sorts all ${instrumentLabels.length} instrument labels one way and all ${realCheckLabels.length} real-check labels the other`);
  else fail(`exit-code split: ${misread.join("; ")}`);
}

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

// Fixture control 4: the ledger's fail-closed guards. Each case mutates a
// fresh in-memory copy of the real source into a shape the guard under test
// does not name in its own patterns, builds the ledger from it, and requires
// a throw tagged by that guard, naming what the message must carry. A throw
// from any other guard is a failure here, because a refusal by the wrong
// rule reads the same green as a refusal by the right one. A mutation whose
// target is absent throws its own error, so no case passes by mutating
// nothing.
{
  const shSrc = readNormalized(join(repoRoot, "bin", "supervise.sh"));
  const tsSrc = readNormalized(join(repoRoot, "hooks", "index.ts"));

  function mutated(src, find, replacement, label) {
    const idx = src.indexOf(find);
    if (idx === -1) throw new Error(`guard control "${label}": mutation target not found in source: ${find}`);
    return src.slice(0, idx) + replacement + src.slice(idx + find.length);
  }
  function expectRefusal(label, tag, mustName, build) {
    let err = null;
    try { build(); } catch (e) { err = e; }
    if (err === null) { fail(`guard control: ${label} - the ledger built with no throw`); return; }
    const msg = String(err.message);
    if (!msg.startsWith(tag)) { fail(`guard control: ${label} - refused by ${msg.split("]")[0]}] rather than ${tag}: ${msg}`); return; }
    const missing = mustName.filter((s) => !msg.includes(s));
    if (missing.length > 0) { fail(`guard control: ${label} - ${tag} fired but its message lacks ${missing.join(", ")}: ${msg}`); return; }
    ok(`guard control: ${label} - refused by ${tag}, naming ${mustName.join(", ")}`);
  }

  // A += clause wrapped onto two lines with a backslash continuation, which
  // bash reads as the same one string: the name still resolves, the sum is
  // short by that clause, and only the per-name count sees it. The clause
  // is picked by position (the second += line of the name), never by text.
  {
    const lines = shSrc.split("\n");
    const plusLines = lines.map((l, i) => (/^\s*COORDINATOR_ROLE_INSTRUCTION\+="/.test(l) ? i : -1)).filter((i) => i !== -1);
    if (plusLines.length < 2) {
      fail("guard control: a += clause wrapped onto two lines - fewer than two COORDINATOR_ROLE_INSTRUCTION+= lines to pick the second from");
    } else {
      const idx = plusLines[1];
      const cut = lines[idx].indexOf(" ", 80);
      lines[idx] = lines[idx].slice(0, cut) + "\\\n" + lines[idx].slice(cut);
      const wrapped = lines.join("\n");
      expectRefusal("a += clause wrapped onto two lines", "[instruction-count]", ["COORDINATOR_ROLE_INSTRUCTION", "expected 5", "found 4"], () => buildLedgerFrom(wrapped, tsSrc));
    }
  }
  // A PRIMING_BODY clause appended with +=. bash reads it as part of the same
  // body, and bin/supervise.sh writes that body to the child, so the appended
  // sentence is injected text. The three plain assignments still match and
  // still count three, so only a rule that reads the append form sees the
  // clause at all. The line is placed after the last plain assignment by
  // position, never by matching text the rule under test was handed.
  {
    const lines = shSrc.split("\n");
    const plain = lines.map((l, i) => (/^\s*PRIMING_BODY="/.test(l) ? i : -1)).filter((i) => i !== -1);
    if (plain.length < 1) {
      fail("guard control: a PRIMING_BODY clause appended with += - no plain PRIMING_BODY assignment to place it after");
    } else {
      const idx = plain[plain.length - 1];
      lines.splice(idx + 1, 0, '    PRIMING_BODY+="Escalate anything you cannot resolve to the operator without delay."');
      expectRefusal("a PRIMING_BODY clause appended with +=", "[priming-shape]", ["PRIMING_BODY"], () => buildLedgerFrom(lines.join("\n"), tsSrc));
    }
  }
  // A sixth instruction variable, assigned but named in no table.
  expectRefusal("a new *_INSTRUCTION variable", "[instruction-set]", ["STEWARD_ROLE_INSTRUCTION"], () =>
    buildLedgerFrom(mutated(shSrc, '\n  ARCHITECT_ROLE_INSTRUCTION=""\n', '\n  ARCHITECT_ROLE_INSTRUCTION=""\n  STEWARD_ROLE_INSTRUCTION="You hold the steward seat for this machine."\n', "new variable"), tsSrc));
  // A renamed instruction variable, at every assignment and in the write.
  expectRefusal("a renamed *_INSTRUCTION variable", "[instruction-set]", ["LEAD_INSTRUCTION", "COORDINATOR_STEER_INSTRUCTION"], () =>
    buildLedgerFrom(shSrc.split("COORDINATOR_STEER_INSTRUCTION").join("LEAD_INSTRUCTION"), tsSrc));
  // A variable spliced into the priming write that no table names and no
  // *_INSTRUCTION assignment declares, which only the write leg can see.
  expectRefusal("a variable added to the priming write", "[priming-write]", ["STEWARD_CHARTER"], () =>
    buildLedgerFrom(mutated(shSrc, '$CHANNEL_REPLY_INSTRUCTION" "$PRIMING_BODY"', '$CHANNEL_REPLY_INSTRUCTION$STEWARD_CHARTER" "$PRIMING_BODY"', "priming write"), tsSrc));
  // A seventh context block pushed under a name no rule sizes.
  expectRefusal("a new context block", "[context-blocks]", ["fleetBlock"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "contextBlocks.push(memoryBlock);", "contextBlocks.push(memoryBlock);\n      contextBlocks.push(fleetBlock);", "context block")));
  // A context block pushed under a new name while its rule still reads the
  // old one: one name unknown to the table and one table name unpushed.
  expectRefusal("a renamed context block push", "[context-blocks]", ["memoriesBlock", "memoryBlock"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "contextBlocks.push(memoryBlock);", "contextBlocks.push(memoriesBlock);", "renamed push")));
  // A ninth submitExpectedTurn call site whose entry no row anchors.
  expectRefusal("a new prompt call site", "[prompt-call-sites]", ["stewardText", "matching 0"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "text: RECONCILE_TEXT }));", 'text: RECONCILE_TEXT }));\n            await submitExpectedTurn($, expectedTurns, expectTurn({ kind: "plugin", text: stewardText }));', "call site")));
  // A call site removed while its row and rule remain: the row matches no
  // site, so the table is stale rather than the source unsized.
  expectRefusal("a removed prompt call site", "[prompt-call-sites]", ["expectedNudgeTurn", "no submitExpectedTurn call site"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "const nudgeOutcome = await submitExpectedTurn($, expectedTurns, expectedNudgeTurn);", "const nudgeOutcome = { ok: true };", "removed call site")));
  // A .prompt.submit call outside submitExpectedTurn.
  expectRefusal("a direct .prompt.submit call", "[prompt-submit]", ["found 2"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "result = await dp.prompt.submit({ text: entry.text });", 'result = await dp.prompt.submit({ text: entry.text });\n    await dp.prompt.submit({ text: "again" });', "direct submit")));
  // Literal text slipped into an excluded delivery site's arguments.
  expectRefusal("a literal inside an excluded delivery site", "[delivery-exclusion]", ["answerText", "Note: "], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "deliveryText(answerLabel, answer.id, answer.text,", 'deliveryText(answerLabel, answer.id, "Note: " + answer.text,', "delivery literal")));
  // The excluded site rebuilt around deliveryText rather than from it alone.
  expectRefusal("an excluded delivery site prefixed outside deliveryText", "[delivery-exclusion]", ["submittedText"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "const submittedText = deliveryText(", 'const submittedText = "[INBOX] " + deliveryText(', "delivery prefix")));

  // A literal added at the delivery site that reaches the child as
  // tool-result context. This is the coverage case rather than the
  // instrument case: no PROMPT_CALL_SITES row names this site, so before
  // the shape rule existed the two named rows passed and this literal rode
  // in unsized. The mutation targets it by its own shape.
  expectRefusal("a literal at the delivery site no prompt-call-site row names", "[delivery-exclusion]", ["Note: "], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "lines.push(deliveryText(ground, rec.id, rec.text,", 'lines.push(deliveryText(ground, rec.id, "Note: " + rec.text,', "context delivery literal")));
  // A fourth delivery site, which the count is what catches.
  expectRefusal("a fourth deliveryText call site", "[delivery-exclusion]", ["found 4"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "lines.push(deliveryText(ground, rec.id, rec.text,", "lines.push(deliveryText(ground, rec.id, rec.text));\n          lines.push(deliveryText(ground, rec.id, rec.text,", "fourth delivery site")));

  // A chain piece rewritten out of the shape its rule's pattern names. The
  // rules that read a chain refuse an operand they were not told to expect,
  // and the rules that read a single template anchor on what must follow the
  // closing quote, so neither can record a prefix and drop the rest. The
  // controls below drive both halves. Each mutation rewrites a real piece by
  // its shape rather than adding text a rule was told about, because a
  // mutation built from a rule's own literals proves only that the
  // instrument runs.
  expectRefusal("a nudge-frame piece rewritten to a quoted literal", "[chain-shape]", ["NUDGE_TEXT_idle_gap_converted"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "`The controller read this as an idle gap, not a real fork: no concrete blocking question. `", '"The controller read this as an idle gap, not a real fork: no concrete blocking question. "', "nudge piece requoted")));
  // A chain piece factored out into a constant and spliced back in by name,
  // which is what Section 3's one-owner-and-a-pointer rewrite tempts.
  expectRefusal("a goal-tree piece replaced by a bare identifier", "[chain-shape]", ["GOAL_TREE_BLOCK", "pathLine"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "`Path: ${path}\\n` +", "pathLine +", "goal tree piece hoisted")));
  // The same class on the tool-description chain Section 4 rewrites:
  // parseStringLiteralChain stops at the first operand that is not a quoted
  // literal, so a hoisted sentence truncates the entry with no throw.
  expectRefusal("a tool description with a hoisted sentence", "[chain-truncated]", ["agentic_resolve"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, '        "A reply says a turn answered;', '        SHARED_NOTE +\n        "A reply says a turn answered;', "tool description hoisted")));

  // The same class on the four rules that read one template or one quoted
  // string rather than a chain. Each is split into a two-piece chain, which
  // is the shape Section 3's rewrite produces when a frame gains a pointer
  // sentence. An unanchored pattern matches the piece it recognises and
  // records it alone, so the entry shrinks and the size check, which reports
  // growth only, stays silent. The frames are the ones Section 3 rewrites.
  // What these three assert is that the recorded size does not move, which
  // is the invariant the class actually turns on. Refusing a split would be
  // the weaker guard: the shared reader can size a multi-piece template
  // chain correctly, and a rule that threw on one would fail a shape it
  // reads right. What must never happen is the entry silently shrinking.
  function expectSizeHeld(label, entryName, find, replacement) {
    let before;
    let after;
    try {
      before = buildLedgerFrom(shSrc, tsSrc).find((e) => e.name === entryName);
      after = buildLedgerFrom(shSrc, mutated(tsSrc, find, replacement, label)).find((e) => e.name === entryName);
    } catch (e) {
      fail(`guard control: ${label} - the ledger threw rather than reading the split: ${e.message}`);
      return;
    }
    if (!before || !after) { fail(`guard control: ${label} - ${entryName} is missing from one of the two builds`); return; }
    if (before.chars !== after.chars) {
      fail(`guard control: ${label} - ${entryName} moved from ${before.chars} to ${after.chars} chars across a split that changes no text`);
      return;
    }
    ok(`guard control: ${label} - ${entryName} held at ${before.chars} chars across the split`);
  }
  expectSizeHeld("a still-waiting frame split into two pieces", "STILL_WAITING_RERAISE_TEXT",
    "`[STILL WAITING] ${askRecord.question}`", "`[STILL WAITING]` + ` ${askRecord.question}`");
  expectSizeHeld("a kaizen frame split into two pieces", "KAIZEN_FRAME",
    "[KAIZEN] Post each line below to the operator's thread", "[KAIZEN] Post each line below` + ` to the operator's thread");
  expectSizeHeld("a reply-backstop frame split into two pieces", "REPLY_BACKSTOP_FRAME",
    "[REPLY BACKSTOP] Send this exact text to the operator", "[REPLY BACKSTOP] Send this exact text` + ` to the operator");
  // A nested interpolation, which is what a frame gains when a value starts
  // depending on a condition. The literal text is unchanged by the mutation,
  // so the entry must not move. It moves if the stripper that removes
  // interpolated content stops at the first closing brace while the reader
  // that captured the piece counted brace depth, because the two then
  // disagree about where the interpolation ended and the residue lands in
  // the entry as prose the sentence matcher goes on to index.
  expectSizeHeld("a goal-tree interpolation nested inside a ternary", "GOAL_TREE_BLOCK",
    "`Path: ${path}\\n` +", "`Path: ${path ? `${path}` : `none`}\\n` +");
  // The memory block refuses instead, for the reason its rule states: its
  // operands are quoted strings and its real second operand is a call no
  // chain reader can size, so there is no correct reading of a split here.
  expectRefusal("a memory block split into two pieces", "[chain-shape]", ["MEMORY_BLOCK"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, '"Relevant user memories (persisted', '"Relevant user memories" + " (persisted', "memory split")));

  // The delivery-site exclusion, driven on the two shapes a quote-character
  // test cannot see. A hoisted constant spliced into a positional argument
  // carries no quote; and the options object is excluded on the ground that
  // its values select a prefix deliveryText composes, which is true of
  // `mark` and false of `answerTo`, whose value hooks/operator.ts splices
  // into the delivered text verbatim.
  expectRefusal("a delivery text argument spliced from a constant", "[delivery-exclusion]", ["NOTE_PREFIX"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, "lines.push(deliveryText(ground, rec.id, rec.text,", "lines.push(deliveryText(ground, rec.id, NOTE_PREFIX + rec.text,", "delivery identifier splice")));
  // This one is aimed at the third site deliberately. The first two sites
  // are named by an excludedTextVar row whose check reads the whole argument
  // string, options object included, so a literal there is already refused
  // and a control placed at one of them would prove only that the check
  // runs. The third site has no such row, so the structural check is all
  // that reads it, and that check slices the options off at the first brace.
  expectRefusal("a literal answerTo at the site no named row reaches", "[delivery-exclusion]", ["answerTo"], () =>
    buildLedgerFrom(shSrc, mutated(tsSrc, '{ mark: waited ? "waited" : "urgent" }', '{ mark: waited ? "waited" : "urgent", answerTo: "the standing question" }', "literal answerTo")));

  // The fleet line-literal collector reaching a label that sits inside a
  // ternary inside an interpolation: lengthen that label and require the
  // entry to grow by exactly the added characters and to carry the phrase.
  try {
    const before = buildLedgerFrom(shSrc, tsSrc).find((e) => e.name === "FLEET_PROMPT_LINE_LITERALS");
    const added = " recorded for this persona";
    const grown = buildLedgerFrom(shSrc, mutated(tsSrc, '"no commons entry"', `"no commons entry${added}"`, "nested label")).find((e) => e.name === "FLEET_PROMPT_LINE_LITERALS");
    if (grown.chars === before.chars + added.length && grown.text.includes(`no commons entry${added}`)) ok(`guard control: fleet line literals - a label nested in a ternary inside an interpolation is sized (${before.chars} -> ${grown.chars})`);
    else fail(`guard control: fleet line literals - a label nested in a ternary inside an interpolation is not sized (${before.chars} -> ${grown.chars})`);
  } catch (e) {
    fail(`guard control: fleet line literals - ${e.message}`);
  }
}

// The ledger's declared coverage bound, pinned: exactly the two record-
// delivery sites, each excluded because hooks/operator.ts's deliveryText
// builds its whole text. A third exclusion, or one rehomed to another
// builder or file, changes what this suite covers and is declared here.
{
  const expected = ["expectedAnswerTurn", "expectedDeliveryTurn"];
  const anchors = EXCLUDED_PROMPT_SITES.map((s) => s.anchor);
  const shapeHolds = EXCLUDED_PROMPT_SITES.every((s) => s.builder === "deliveryText" && s.file === "hooks/operator.ts");
  if (JSON.stringify(anchors) === JSON.stringify(expected) && shapeHolds) ok(`exclusion pin: the ledger excludes exactly ${expected.join(" and ")}, both built whole by hooks/operator.ts deliveryText`);
  else fail(`exclusion pin: the ledger's excluded prompt sites are ${JSON.stringify(EXCLUDED_PROMPT_SITES)}, expected ${JSON.stringify(expected)} built by hooks/operator.ts deliveryText`);

  // The two rows above are the sites that reach the child through
  // submitExpectedTurn. They are not the whole class: a third call site
  // delivers inside a running turn as tool-result context, so the count the
  // ledger asserts by shape is what bounds this class, and it is pinned
  // here beside the name list rather than left to the rule alone.
  const liveDeliverySites = readNormalized(join(repoRoot, "hooks", "index.ts")).match(/deliveryText\(/g) || [];
  if (DELIVERY_SITE_COUNT === 3 && liveDeliverySites.length === DELIVERY_SITE_COUNT) {
    ok(`exclusion pin: the ledger declares ${DELIVERY_SITE_COUNT} deliveryText call sites and hooks/index.ts holds that many, two of them named above and one reached by no prompt-call-site row`);
  } else {
    fail(`exclusion pin: the ledger declares ${DELIVERY_SITE_COUNT} deliveryText call sites and hooks/index.ts holds ${liveDeliverySites.length}`);
  }
}

// The real check: every injected string the ledger extracts, against
// CLAUDE.md and against each other, plus the size guard and the
// name-reconciliation guard against the committed baseline.
{
  const claudeMdText = readNormalized(claudeMdPath);
  // A refusal out of the real run is a guard speaking, not the designed red.
  // Left uncaught it would end the process on Node's own uncaught-exception
  // code, which is 1, and 1 is exactly the code that means "the duplicates
  // this suite is red for are still there". So a reader of the exit code
  // would see the expected state at the moment a rule started refusing the
  // real source. Catching it routes the refusal through the instrument
  // branch and exits 2 with the tag named.
  let liveEntries;
  try {
    liveEntries = buildLedger(); // [{ name, file, chars, words, text }]
  } catch (e) {
    fail(`guard control: the ledger refused the real source - ${e.message}`);
    console.error(`\nFAILED: ${failed} check(s), ${instrumentFailed} of them a control or guard.`);
    process.exit(2);
  }
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
if (instrumentFailed > 0) {
  console.error(`${instrumentFailed} of those are a control or a guard rather than the real check, so this run says nothing about the duplicates: the instrument is what broke. Exiting 2.`);
}
process.exit(failed === 0 ? 0 : instrumentFailed > 0 ? 2 : 1);
