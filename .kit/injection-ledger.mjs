#!/usr/bin/env node
// The injection ledger: reads bin/supervise.sh and hooks/index.ts and prints,
// as a JSON array on stdout, one { name, file, chars, words } record per
// injected string those two files write into a child session's context.
//
// Usage: node .kit/injection-ledger.mjs
//
// Each source file is read once, its CRLF line endings normalized to LF
// before any counting, so a size recorded here does not depend on which
// checkout (LF blob vs. CRLF working tree) produced it. See
// docs/plans/agent_persona_lean-injection_v1.md Section 1: `git ls-files
// --eol` reports i/lf w/crlf for both source files, so a worktree count is
// one character higher per line than a blob count.
//
// The extraction below is a fixed table of named rules, one per injected
// string the plan's Approach inventory names, mirroring
// .kit/check-loader-rule.mjs's per-rule regexes rather than a general parser:
// the set of strings is small, named, and shaped differently enough (a shell
// variable, a template literal with interpolation, a tool registration
// object) that one rule per shape reads plainly, where a single generic
// parser covering all three shapes would not.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(__dirname, "..");
const shPath = join(repoRoot, "bin", "supervise.sh");
const tsPath = join(repoRoot, "hooks", "index.ts");

function readNormalized(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

// Standard backslash escapes, decoded to the real character they represent.
// Applied uniformly below to every extracted string regardless of source
// shape (a bash double-quoted assignment, a TS string literal, a TS
// template literal): a shell string and a TS string that both write `\n`
// mean the same one-character newline in the child's context, so both are
// decoded by the same rule rather than two.
const ESCAPE_MAP = {
  "\\": "\\", "'": "'", '"': '"',
  n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0",
};
function decodeEscapes(text) {
  return text.replace(/\\([\\'"nrtbfv0])/g, (_, c) => ESCAPE_MAP[c]);
}

// `${...}` interpolation, stripped from every extracted string regardless
// of source shape: a TS template literal's `${g.objective}` and a bash
// assignment's `${COORDINATOR_PERSONA}` are both per-request or per-launch
// data the ledger cannot size ahead of time, so both are excluded by the
// same rule rather than two (see the plan's Section 1: interpolated
// content is excluded).
function stripInterpolations(text) {
  return text.replace(/\$\{[^}]*\}/g, "");
}

// `text` rides on the returned record so a consumer that needs the literal
// content (the duplicate test's sentence matcher) can read it without
// re-deriving it; the printed ledger and the committed JSON strip it back
// off, since the plan's stated shape is { name, file, chars, words }.
function record(name, file, rawText) {
  const text = decodeEscapes(stripInterpolations(rawText));
  const chars = text.length;
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  return { name, file, chars, words, text };
}

function toPublicShape(entries) {
  return entries.map(({ name, file, chars, words }) => ({ name, file, chars, words }));
}

// --- Shared: a chain of one or more JS/TS string literals joined by `+`,
// starting at `startIdx` in `src`. Handles both quote characters; does not
// handle template literals (those are parsed separately, per site, where
// interpolation must be stripped rather than rejected). Returns null if
// `startIdx` is not the start of a quoted literal.
function parseStringLiteralChain(src, startIdx) {
  let i = startIdx;
  let value = "";
  let any = false;
  while (true) {
    while (/\s/.test(src[i])) i++;
    const quote = src[i];
    if (quote !== '"' && quote !== "'") break;
    let j = i + 1;
    let piece = "";
    while (j < src.length && src[j] !== quote) {
      if (src[j] === "\\") {
        piece += src[j] + src[j + 1];
        j += 2;
      } else {
        piece += src[j];
        j++;
      }
    }
    // Escapes are decoded once, centrally, in record() below - not here -
    // so a chain's raw backslash sequences ride through unchanged.
    value += piece;
    any = true;
    i = j + 1;
    let k = i;
    while (/\s/.test(src[k])) k++;
    if (src[k] === "+") {
      i = k + 1;
      continue;
    }
    break;
  }
  if (!any) return null;
  return { value, endIdx: i };
}

// ---------------------------------------------------------------------------
// bin/supervise.sh: the five *_INSTRUCTION variables and the three priming
// bodies. Every assignment is a single physical line of the shape
// NAME="..." or NAME+="..." with no internal unescaped double quote (checked
// by hand against the base commit this ledger was built at - see the
// Chapter), so a whole-line regex is sufficient and safe; a change that
// wraps one of these onto multiple lines, renames the variable, or
// introduces an internal quote will make this regex miss it. That miss is
// not silent: extractShellInstructions throws below when a named variable
// collects no assignment at all, so a shape change fails the build rather
// than shipping a ledger entry of 0 chars.
// ---------------------------------------------------------------------------
function extractShellInstructions(src) {
  const results = [];
  const lines = src.split("\n");
  const instructionNames = [
    "SKILL_LOAD_INSTRUCTION",
    "COORDINATOR_STEER_INSTRUCTION",
    "CHANNEL_REPLY_INSTRUCTION",
    "COORDINATOR_ROLE_INSTRUCTION",
    "ARCHITECT_ROLE_INSTRUCTION",
  ];
  const collected = new Map(instructionNames.map((n) => [n, []]));
  const assignRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\+?)=\s*"([^\n]*)"\s*$/;
  for (const line of lines) {
    const m = assignRe.exec(line);
    if (!m) continue;
    const [, name, , content] = m;
    if (collected.has(name)) collected.get(name).push(content);
  }
  for (const name of instructionNames) {
    // Every assignment and += continuation found for this name, in source
    // order, concatenated: an empty init followed by one conditional real
    // value yields the real value; a base assignment followed by
    // conditional += clauses (COORDINATOR_ROLE_INSTRUCTION's fleet, seat and
    // architect-routing clauses) yields their sum, which is this variable's
    // worst-case content across every launch shape.
    const assignments = collected.get(name);
    if (assignments.length === 0) {
      throw new Error(
        `no assignment found for ${name} in bin/supervise.sh (renamed, or no longer a single-line NAME="..." assignment?)`,
      );
    }
    const text = assignments.join("");
    results.push(record(name, "bin/supervise.sh", text));
  }

  // The three priming bodies: PRIMING_BODY is assigned once per branch of a
  // three-way if/elif/else (a prompt is pending; a channel is attached and
  // none is; no channel at all), so the three assignments are mutually
  // exclusive at runtime and each is its own ledger entry rather than a
  // concatenation.
  const primingRe = /^\s*PRIMING_BODY="([^\n]*)"\s*$/;
  const primingLabels = [
    "PRIMING_BODY_prompt_pending",
    "PRIMING_BODY_channel_wait",
    "PRIMING_BODY_no_channel_wait",
  ];
  const primingMatches = [];
  for (const line of lines) {
    const m = primingRe.exec(line);
    if (m) primingMatches.push(m[1]);
  }
  if (primingMatches.length !== primingLabels.length) {
    throw new Error(
      `expected ${primingLabels.length} PRIMING_BODY assignments in bin/supervise.sh, found ${primingMatches.length}`,
    );
  }
  primingMatches.forEach((text, idx) => {
    results.push(record(primingLabels[idx], "bin/supervise.sh", text));
  });

  // The goal-prompt framing line: the one line the goal-prompt turn opens
  // with, naming the text behind it as the operator's own trusted task.
  // Written as NAME="..."$'\n\n' - a plain double-quoted body followed by
  // an ANSI-C-quoted two-newline suffix - so it needs its own rule rather
  // than the single-line NAME="..." table above.
  const framingRe = /GOAL_PROMPT_FRAMING="([^\n]*)"\$'((?:\\.)*)'/;
  const framingMatch = framingRe.exec(src);
  if (!framingMatch) throw new Error("GOAL_PROMPT_FRAMING not found in bin/supervise.sh");
  results.push(record("GOAL_PROMPT_FRAMING", "bin/supervise.sh", framingMatch[1] + framingMatch[2]));

  // The [SUPERVISOR-PRIMING] marker, prepended to every priming write.
  const primingMarkerRe = /'(\[SUPERVISOR-PRIMING\] )' \+ prefix \+ body/;
  const primingMarkerMatch = primingMarkerRe.exec(src);
  if (!primingMarkerMatch) throw new Error("SUPERVISOR-PRIMING marker not found in bin/supervise.sh");
  results.push(record("SUPERVISOR_PRIMING_MARKER", "bin/supervise.sh", primingMarkerMatch[1]));

  return results;
}

// ---------------------------------------------------------------------------
// hooks/index.ts: REPLY_INSTRUCTION, each prompt frame's literal text at its
// call site (interpolation excluded), each prompt.submit context block's
// literal text, and every registered tool's description plus its parameter
// descriptions.
// ---------------------------------------------------------------------------

function extractReplyInstruction(src) {
  const m = /const REPLY_INSTRUCTION = "([^\n]*)";/.exec(src);
  if (!m) throw new Error("REPLY_INSTRUCTION not found in hooks/index.ts");
  return record("REPLY_INSTRUCTION", "hooks/index.ts", m[1]);
}

function extractReconcileText(src) {
  const m = /const RECONCILE_TEXT = "([^\n]*)";/.exec(src);
  if (!m) throw new Error("RECONCILE_TEXT not found in hooks/index.ts");
  return record("RECONCILE_TEXT", "hooks/index.ts", m[1]);
}

// The still-waiting re-raise (line 232 at this ledger's base): a nested
// template literal, `${REPLY_INSTRUCTION}${quoteContinuationLines(`[STILL
// WAITING] ${askRecord.question}`)}`. REPLY_INSTRUCTION is counted on its
// own above; askRecord.question is per-ask data excluded as interpolation;
// the one literal fragment this site contributes on top of those is
// whatever text precedes `${askRecord.question}` inside that inner
// backtick, captured from the source rather than hardcoded, so a reword of
// the label is picked up automatically.
function extractStillWaitingReraise(src) {
  const m = /`([^`]*)\$\{askRecord\.question\}`/.exec(src);
  if (!m) throw new Error("still-waiting reraise frame not found in hooks/index.ts");
  return record("STILL_WAITING_RERAISE_TEXT", "hooks/index.ts", m[1]);
}

// fleetPromptText's returned frame: `${REPLY_INSTRUCTION}[FLEET] ${count}
// reading...continue your work:` + "\n" + lines.join("\n"). The trailing
// `+ "\n" + lines.join(...)` is entirely per-reading data and excluded; the
// backtick template before it is this frame's literal text once
// REPLY_INSTRUCTION and ${count} are stripped.
function extractFleetPromptFrame(src) {
  const m = /return `(\$\{REPLY_INSTRUCTION\}\[FLEET\][^`]*)`\s*\+\s*"\\n"\s*\+\s*lines\.join/.exec(src);
  if (!m) throw new Error("fleetPromptText frame not found in hooks/index.ts");
  return record("FLEET_PROMPT_FRAME", "hooks/index.ts", m[1]);
}

// The [KAIZEN] frame: `${REPLY_INSTRUCTION}[KAIZEN] Post each line below...`
// followed by `+ announced.map(...).join("\n")`, which is per-announcement
// data and excluded.
function extractKaizenFrame(src) {
  const m = /`(\$\{REPLY_INSTRUCTION\}\[KAIZEN\][^`]*)`/.exec(src);
  if (!m) throw new Error("kaizen frame not found in hooks/index.ts");
  return record("KAIZEN_FRAME", "hooks/index.ts", m[1]);
}

// The reply backstop: `${REPLY_INSTRUCTION}[REPLY BACKSTOP] Send this exact
// text...unchanged:\n${e.answer}`. e.answer is the operator-facing text
// already composed elsewhere and is excluded as interpolation.
function extractBackstopFrame(src) {
  const m = /`(\$\{REPLY_INSTRUCTION\}\[REPLY BACKSTOP\][^`]*)`/.exec(src);
  if (!m) throw new Error("reply backstop frame not found in hooks/index.ts");
  return record("REPLY_BACKSTOP_FRAME", "hooks/index.ts", m[1]);
}

// The two idle-nudge frames (nudgeText's ternary): each is a chain of plain
// template-literal pieces joined by `+`, with `${g.objective}` and
// `${idleDisplay}` as the only interpolations, both per-goal data and
// excluded.
function extractNudgeFrames(src) {
  const m = /const nudgeText = idleGapConverted\s*\n\s*\?\s*([\s\S]*?)\n\s*:\s*([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("nudgeText ternary not found in hooks/index.ts");
  function literalOfChain(chainSrc) {
    const pieces = chainSrc.match(/`(?:[^`\\]|\\.)*`/g) || [];
    return pieces.map((p) => p.slice(1, -1)).join("");
  }
  return [
    record("NUDGE_TEXT_idle_gap_converted", "hooks/index.ts", literalOfChain(m[1])),
    record("NUDGE_TEXT_idle_timeout", "hooks/index.ts", literalOfChain(m[2])),
  ];
}

// The [GOAL TREE] block. `siblingLine` and `lastNote` are whole-variable
// insertions (not `${}` interpolations inside one template literal), so they
// are excluded by only reading the backtick-delimited pieces of the chain,
// never the bare identifiers between `+`.
function extractGoalTreeBlock(src) {
  const m = /const goalBlock =\s*\n([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("goalBlock not found in hooks/index.ts");
  const pieces = m[1].match(/`(?:[^`\\]|\\.)*`/g) || [];
  const literal = pieces.map((p) => p.slice(1, -1)).join("");
  return record("GOAL_TREE_BLOCK", "hooks/index.ts", literal);
}

function extractGoalTreePausedBlock(src) {
  const m = /const pausedBlock = `([^`]*)`;/.exec(src);
  if (!m) throw new Error("pausedBlock not found in hooks/index.ts");
  return record("GOAL_TREE_PAUSED_BLOCK", "hooks/index.ts", m[1]);
}

// The [NO GOAL] reminder: fully literal, no interpolation at all, written as
// a chain of backtick pieces joined by `+`.
function extractNoGoalBlock(src) {
  const m = /const idleBlock =\s*\n([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("idleBlock not found in hooks/index.ts");
  const pieces = m[1].match(/`(?:[^`\\]|\\.)*`/g) || [];
  if (pieces.length === 0) throw new Error("idleBlock literal chain did not parse");
  const literal = pieces.map((p) => p.slice(1, -1)).join("");
  return record("NO_GOAL_BLOCK", "hooks/index.ts", literal);
}

function extractEnvBlock(src) {
  const m = /const envBlock = `(\[ENV\][^`]*)`;/.exec(src);
  if (!m) throw new Error("envBlock not found in hooks/index.ts");
  return record("ENV_BLOCK", "hooks/index.ts", m[1]);
}

function extractLessonBlock(src) {
  const m = /const lessonBlock = `(\[LESSON\][^`]*)`;/.exec(src);
  if (!m) throw new Error("lessonBlock not found in hooks/index.ts");
  return record("LESSON_BLOCK", "hooks/index.ts", m[1]);
}

// The memory block's first line is a plain, fully literal string; its
// second line (`entries.map(...).join("\n")`) is per-memory data and
// excluded.
function extractMemoryBlock(src) {
  const m = /const memoryBlock =\s*\n\s*"([^"]*)"/.exec(src);
  if (!m) throw new Error("memoryBlock not found in hooks/index.ts");
  return record("MEMORY_BLOCK", "hooks/index.ts", m[1]);
}

// --- Tool registrations: $.tool.register({ ... }), one entry per tool,
// combining its top-level description with every parameter's description.
//
// Both scanners below share one string/comment-aware traversal rule: a
// quote (single, double or backtick) opens a string that swallows braces
// until its unescaped close, and `//`/`/* */` comments are skipped before
// that quote test runs, so an apostrophe inside a comment cannot open a
// phantom string that swallows the real closing brace.
function findMatchingBrace(src, openIdx) {
  let depth = 0;
  let inString = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced braces while scanning a $.tool.register({...}) block");
}

// The property names declared one level inside an object literal's braces
// (`inner` is the substring strictly between the outer `{` and `}`), used
// to check the parameter-description regex below against the schema's own
// declared parameter count rather than trusting the regex to have found
// them all.
function topLevelPropertyNames(inner) {
  const names = [];
  let depth = 0;
  let inString = null;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (inString) {
      if (c === "\\") { i += 2; continue; }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === "/" && inner[i + 1] === "/") {
      const nl = inner.indexOf("\n", i);
      i = nl === -1 ? inner.length : nl + 1;
      continue;
    }
    if (c === "/" && inner[i + 1] === "*") {
      const end = inner.indexOf("*/", i + 2);
      i = end === -1 ? inner.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; i++; continue; }
    if (c === "{" || c === "[") { depth++; i++; continue; }
    if (c === "}" || c === "]") { depth--; i++; continue; }
    if (depth === 0) {
      const km = /^(\w+)\s*:/.exec(inner.slice(i));
      if (km) {
        names.push(km[1]);
        i += km[0].length;
        continue;
      }
    }
    i++;
  }
  return names;
}

function extractToolDescriptions(src) {
  const results = [];
  const registerRe = /\$\.tool\.register\(\{/g;
  let m;
  while ((m = registerRe.exec(src)) !== null) {
    const openIdx = m.index + m[0].length - 1; // index of the opening '{'
    const closeIdx = findMatchingBrace(src, openIdx);
    const block = src.slice(openIdx, closeIdx + 1);

    const nameMatch = /name:\s*"([^"]+)"/.exec(block);
    if (!nameMatch) throw new Error("a $.tool.register block has no name: " + block.slice(0, 80));
    const toolName = nameMatch[1];

    // The top-level description always precedes inputSchema: in every
    // registration at this ledger's base, so slicing the block there
    // isolates it from any parameter description sharing the same key name.
    const schemaIdx = block.indexOf("inputSchema:");
    if (schemaIdx === -1) throw new Error(`tool ${toolName} has no inputSchema`);
    const head = block.slice(0, schemaIdx);
    const descKeyIdx = head.indexOf("description:");
    if (descKeyIdx === -1) throw new Error(`tool ${toolName} has no top-level description`);
    const afterKey = descKeyIdx + "description:".length;
    const chain = parseStringLiteralChain(head, head.slice(afterKey).search(/\S/) + afterKey);
    if (!chain) throw new Error(`tool ${toolName}'s top-level description did not parse as a string literal chain`);
    const topDescription = chain.value;

    // Parameter descriptions: every `<param>: { type: "...", description:
    // ...(chain)... }` inside inputSchema.properties, in declaration order.
    const tail = block.slice(schemaIdx);
    const paramRe = /(\w+):\s*\{\s*type:\s*(?:"[^"]*"|'[^']*'),\s*description:\s*/g;
    const paramDescriptions = [];
    let pm;
    while ((pm = paramRe.exec(tail)) !== null) {
      const pChain = parseStringLiteralChain(tail, pm.index + pm[0].length);
      if (pChain) paramDescriptions.push(pChain.value);
    }

    // paramRe requires `type: "...", description:` with nothing between,
    // so a parameter that gains an `enum`, a `default` or any other field
    // ahead of `description` silently drops out of paramDescriptions above.
    // Counting the schema's own declared property names catches that
    // shortfall rather than shipping a ledger entry missing a parameter's
    // description.
    const propsKeyIdx = tail.indexOf("properties:");
    if (propsKeyIdx === -1) throw new Error(`tool ${toolName} has no inputSchema.properties`);
    const propsOpenIdx = tail.indexOf("{", propsKeyIdx);
    if (propsOpenIdx === -1) throw new Error(`tool ${toolName}'s properties has no opening brace`);
    const propsCloseIdx = findMatchingBrace(tail, propsOpenIdx);
    const propertyNames = topLevelPropertyNames(tail.slice(propsOpenIdx + 1, propsCloseIdx));
    if (paramDescriptions.length < propertyNames.length) {
      throw new Error(
        `tool ${toolName}: found ${paramDescriptions.length} parameter description(s) but inputSchema.properties declares ${propertyNames.length} (${propertyNames.join(", ")}) - a parameter's description regex is no longer matching its shape`,
      );
    }

    const combined = [topDescription, ...paramDescriptions].join(" ");
    results.push(record(`${toolName}_description`, "hooks/index.ts", combined));
  }
  if (results.length === 0) throw new Error("no $.tool.register blocks found in hooks/index.ts");
  return results;
}

function buildLedger() {
  const shSrc = readNormalized(shPath);
  const tsSrc = readNormalized(tsPath);

  const entries = [
    ...extractShellInstructions(shSrc),
    extractReplyInstruction(tsSrc),
    extractReconcileText(tsSrc),
    extractStillWaitingReraise(tsSrc),
    extractFleetPromptFrame(tsSrc),
    extractKaizenFrame(tsSrc),
    extractBackstopFrame(tsSrc),
    ...extractNudgeFrames(tsSrc),
    extractGoalTreeBlock(tsSrc),
    extractGoalTreePausedBlock(tsSrc),
    extractNoGoalBlock(tsSrc),
    extractEnvBlock(tsSrc),
    extractLessonBlock(tsSrc),
    extractMemoryBlock(tsSrc),
    ...extractToolDescriptions(tsSrc),
  ];
  return entries;
}

// The basis every recorded size and every duplicate-check comparison rests
// on: read `git ls-files --eol` for the LF-normalization half of it. The
// interpolation-exclusion and escape-decoding halves are enforced in code
// by stripInterpolations/decodeEscapes above, restated here for a reader of
// the committed JSON who has not read this file.
const LEDGER_BASIS =
  "LF-normalized (CRLF line endings collapsed to LF before counting); " +
  "${...} interpolation stripped uniformly from every source shape (shell " +
  "and TS alike); standard backslash escapes (\\n, \\t, etc.) decoded to " +
  "the one character they represent before counting.";

// Run when invoked directly (not when imported by the duplicate test). The
// printed shape matches the committed .kit/injection-ledger.json's own
// { basis, entries } envelope, so `node .kit/injection-ledger.mjs >
// .kit/injection-ledger.json` is a working refresh command rather than one
// that produces a shape the duplicate test's `baseline.entries` read can't
// parse.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({ basis: LEDGER_BASIS, entries: toPublicShape(buildLedger()) }, null, 2));
}

export { buildLedger, toPublicShape };
