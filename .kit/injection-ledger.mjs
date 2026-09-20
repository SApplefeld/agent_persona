#!/usr/bin/env node
// The injection ledger: reads bin/supervise.sh and hooks/index.ts and prints,
// as a JSON envelope on stdout, one { name, file, chars, words } record per
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
//
// Every rule fails closed. An extraction that cannot match its anchor, or
// that matches fewer or more pieces than its table expects, throws with the
// name and both counts; it never records a zero, a partial value or a
// default, because a string that silently shrank in the ledger reads to the
// size check as a trim. Beside the per-string rules, four structural checks
// read each family's shape off the source rather than off this file's list,
// so a member the list does not name fails the build: every *_INSTRUCTION
// variable the supervisor assigns and every variable its priming write
// splices in, every contextBlocks.push in the plugin, every
// submitExpectedTurn call site and every direct .prompt.submit call, and
// every $.tool.register block.
//
// One coverage bound is declared rather than closed. Two submitExpectedTurn
// call sites deliver an inbox record, and their whole text is built by
// deliveryText in hooks/operator.ts, a file this ledger does not read. Two
// of those sites reach the child through submitExpectedTurn and are named in
// PROMPT_CALL_SITES as exclusions; a third hands its record to the running
// turn as tool-result context instead and is reached by no row there. All
// three are counted and asserted by shape, the ledger requiring that none
// contributes literal text in its ground, id or text argument, and the
// duplicate test pins both the named exclusion list and the site count, so a
// fourth site or a literal added at any of them fails rather than slipping
// past. Fixed literals inside interpolated expressions are sized only where
// a rule names them: the [FLEET] prompt's per-row line literals are one such
// rule; the "- " prefix on each [KAIZEN] line and the "Pending siblings: ",
// "Last note: " and "root > " fragments of the [GOAL TREE] block are not
// sized by any rule here, and neither is the authored prose of a [FLEET]
// note's `composed` half, which reaches the prompt through an interpolation
// and is this ledger's largest declared gap.

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

function setDifference(a, b) {
  return [...a].filter((x) => !b.has(x));
}

// --- Shared: a chain of one or more JS/TS string literals joined by `+`,
// starting at `startIdx` in `src`. Handles both quote characters; does not
// handle template literals (those are parsed separately, per site, where
// interpolation must be stripped rather than rejected). Returns null if
// `startIdx` is not the start of a quoted literal.
//
// A `+` followed by anything but another quoted literal throws rather than
// ending the chain. Ending there would record the pieces read so far and
// drop the rest with no signal: the name still resolves, the entry is just
// short, and the size check reports growth alone. `owner` names what the
// chain belongs to so the refusal says which entry would have shrunk.
function parseStringLiteralChain(src, startIdx, owner) {
  let i = startIdx;
  let value = "";
  let any = false;
  let afterPlus = false;
  while (true) {
    while (/\s/.test(src[i])) i++;
    const quote = src[i];
    if (quote !== '"' && quote !== "'") {
      if (afterPlus) {
        const ident = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
        const operand = ident ? ident[0] : JSON.stringify(src.slice(i, i + 16));
        throw new Error(
          `[chain-truncated] ${owner || "string literal chain"}: a \`+\` is followed by ${operand}, which is not a quoted literal, so every piece after it would be dropped from the entry`,
        );
      }
      break;
    }
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
    afterPlus = false;
    i = j + 1;
    let k = i;
    while (/\s/.test(src[k])) k++;
    if (src[k] === "+") {
      i = k + 1;
      afterPlus = true;
      continue;
    }
    break;
  }
  if (!any) return null;
  return { value, endIdx: i };
}

// --- Shared: a chain of template literals joined by `+`, where a rule may
// declare bare identifiers the chain splices in whole.
//
// Reading the backtick pieces alone and ignoring whatever sits between them
// is what let three of these rules fail open. A piece rewritten to a quoted
// literal, or factored into a constant and spliced back by name, left the
// entry short with nothing raised: the name still resolved, and the size
// check reports growth and never a shrink, so the loss read as a trim. This
// tokenizes the chain instead and refuses any operand it was not told to
// expect. `owner` is the entry name, so a refusal says which string would
// have shrunk. Interpolations ride through inside their piece and are
// stripped centrally by record() below.
function literalOfTemplateChain(chainSrc, owner, allowedIdentifiers = []) {
  const allowed = new Set(allowedIdentifiers);
  const declared = allowedIdentifiers.length > 0 ? allowedIdentifiers.join(", ") : "none";
  const pieces = [];
  let i = 0;
  let expectOperand = true;
  while (i < chainSrc.length) {
    while (i < chainSrc.length && /\s/.test(chainSrc[i])) i++;
    if (i >= chainSrc.length) break;
    if (!expectOperand) {
      if (chainSrc[i] !== "+") {
        throw new Error(`[chain-shape] ${owner}: expected \`+\` between operands but found ${JSON.stringify(chainSrc.slice(i, i + 16))}`);
      }
      i += 1;
      expectOperand = true;
      continue;
    }
    if (chainSrc[i] === "`") {
      let j = i + 1;
      let piece = "";
      let closed = false;
      while (j < chainSrc.length) {
        const c = chainSrc[j];
        if (c === "\\") {
          piece += c + chainSrc[j + 1];
          j += 2;
          continue;
        }
        if (c === "`") {
          closed = true;
          break;
        }
        // An interpolation is skipped whole, its braces counted and any
        // template nested inside it consumed, so a backtick within `${...}`
        // cannot close this piece early.
        if (c === "$" && chainSrc[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          while (k < chainSrc.length && depth > 0) {
            const d = chainSrc[k];
            if (d === "{") depth += 1;
            else if (d === "}") depth -= 1;
            else if (d === "`") {
              let t = k + 1;
              while (t < chainSrc.length && chainSrc[t] !== "`") {
                if (chainSrc[t] === "\\") t += 1;
                t += 1;
              }
              k = t;
            }
            k += 1;
          }
          if (depth !== 0) throw new Error(`[chain-shape] ${owner}: an interpolation opened at offset ${j} never closed`);
          piece += chainSrc.slice(j, k);
          j = k;
          continue;
        }
        piece += c;
        j += 1;
      }
      if (!closed) throw new Error(`[chain-shape] ${owner}: a template literal opened at offset ${i} never closed`);
      pieces.push(piece);
      i = j + 1;
      expectOperand = false;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*/.exec(chainSrc.slice(i));
    if (!ident) {
      throw new Error(`[chain-shape] ${owner}: the operand at offset ${i} is neither a template literal nor an identifier (${JSON.stringify(chainSrc.slice(i, i + 16))})`);
    }
    if (!allowed.has(ident[0])) {
      throw new Error(`[chain-shape] ${owner}: the chain carries the operand \`${ident[0]}\`, which is not a template literal and is not one of this rule's declared whole-variable insertions (${declared})`);
    }
    i += ident[0].length;
    expectOperand = false;
  }
  if (expectOperand) throw new Error(`[chain-shape] ${owner}: the chain ends on a \`+\` with no operand after it`);
  if (pieces.length === 0) throw new Error(`[chain-shape] ${owner}: the chain carries no template literal at all`);
  return pieces.join("");
}

// ---------------------------------------------------------------------------
// bin/supervise.sh: the *_INSTRUCTION variables and the three priming
// bodies. Every assignment is a single physical line of the shape
// NAME="..." or NAME+="..." with no internal unescaped double quote, so a
// whole-line regex is what reads it. A change that wraps one of these onto
// multiple lines, renames the variable, or introduces an internal quote
// makes the regex miss that line, and the miss fails closed: the table
// below fixes how many assignment lines each name carries, and a count that
// differs throws rather than summing the lines that still matched.
// ---------------------------------------------------------------------------

// Every *_INSTRUCTION variable this ledger sizes, with the number of
// assignment lines (NAME="..." and NAME+="...", an empty init included) each
// carries in bin/supervise.sh. The count is asserted exactly, the way the
// PRIMING_BODY count below is, because a name whose clauses fell to fewer
// matching lines would otherwise still resolve, still size above zero, and
// read to the size check as a trim. A rewrite that changes a name's clause
// count sets the number here in the same commit, which is the declared-
// growth rule applied to the shape as well as to the size.
const INSTRUCTION_ASSIGNMENT_COUNTS = {
  SKILL_LOAD_INSTRUCTION: 1,
  COORDINATOR_STEER_INSTRUCTION: 2,
  CHANNEL_REPLY_INSTRUCTION: 2,
  COORDINATOR_ROLE_INSTRUCTION: 5,
  ARCHITECT_ROLE_INSTRUCTION: 2,
};
const INSTRUCTION_NAMES = Object.keys(INSTRUCTION_ASSIGNMENT_COUNTS);

function extractShellInstructions(src) {
  const results = [];
  const lines = src.split("\n");
  const tableNames = new Set(INSTRUCTION_NAMES);

  // Structural leg one: every variable named *_INSTRUCTION the script
  // assigns, discovered from the assignment's left-hand side alone, so a
  // sixth instruction variable fails here whatever shape its right-hand
  // side takes, and a renamed one fails as one name gone and one unknown.
  const declaredRe = /^\s*([A-Z][A-Z0-9_]*_INSTRUCTION)\+?=/;
  const declared = new Set();
  for (const line of lines) {
    const m = declaredRe.exec(line);
    if (m) declared.add(m[1]);
  }
  const declaredNotInTable = setDifference(declared, tableNames);
  const tableNotDeclared = setDifference(tableNames, declared);
  if (declaredNotInTable.length > 0 || tableNotDeclared.length > 0) {
    throw new Error(
      `[instruction-set] bin/supervise.sh assigns *_INSTRUCTION variables INSTRUCTION_ASSIGNMENT_COUNTS does not name (${declaredNotInTable.join(", ") || "none"}) or no longer assigns ones it does (${tableNotDeclared.join(", ") || "none"}); add each new variable to that table with its assignment-line count, or retire the missing one from it, in the same commit`,
    );
  }

  // Structural leg two: the variables the priming write itself splices into
  // the child's first turn, read off the write's own argument. A variable
  // written to the child under a name that does not end in _INSTRUCTION
  // fails here, where leg one cannot see it.
  const writeRe = /"\s+"((?:\$[A-Za-z_][A-Za-z0-9_]*)+)"\s+"\$PRIMING_BODY"\s+>&"\$CHILD_IN"/;
  const writeMatch = writeRe.exec(src);
  if (!writeMatch) {
    throw new Error(
      `[priming-write] the priming write ("$A$B..." "$PRIMING_BODY" >&"$CHILD_IN") was not found in bin/supervise.sh; the write's shape changed and this rule must follow it in the same commit`,
    );
  }
  const written = new Set(writeMatch[1].split("$").filter(Boolean));
  const writtenNotInTable = setDifference(written, tableNames);
  const tableNotWritten = setDifference(tableNames, written);
  if (writtenNotInTable.length > 0 || tableNotWritten.length > 0) {
    throw new Error(
      `[priming-write] the priming write in bin/supervise.sh splices variables the ledger does not size (${writtenNotInTable.join(", ") || "none"}) or omits ones it does (${tableNotWritten.join(", ") || "none"}); every variable written to the child's first turn is sized here, so add a rule and a table row for the new one, or retire the row for the dropped one, in the same commit`,
    );
  }

  const collected = new Map(INSTRUCTION_NAMES.map((n) => [n, []]));
  const assignRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\+?)=\s*"([^\n]*)"\s*$/;
  for (const line of lines) {
    const m = assignRe.exec(line);
    if (!m) continue;
    const [, name, , content] = m;
    if (collected.has(name)) collected.get(name).push(content);
  }
  for (const name of INSTRUCTION_NAMES) {
    // Every assignment and += continuation found for this name, in source
    // order, concatenated: an empty init followed by one conditional real
    // value yields the real value; a base assignment followed by
    // conditional += clauses (COORDINATOR_ROLE_INSTRUCTION's fleet, seat and
    // architect-routing clauses) yields their sum, which is this variable's
    // worst-case content across every launch shape.
    const assignments = collected.get(name);
    const expected = INSTRUCTION_ASSIGNMENT_COUNTS[name];
    if (assignments.length !== expected) {
      throw new Error(
        `[instruction-count] ${name} in bin/supervise.sh: expected ${expected} single-line assignment(s) of the shape NAME="..." or NAME+="...", found ${assignments.length}; a clause was wrapped onto more than one line, gained an internal quote, or was added or removed, and the ledger cannot sum what it did not match; restore the single-line shape or set the count in INSTRUCTION_ASSIGNMENT_COUNTS in the same commit`,
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

// The still-waiting re-raise: a nested template literal,
// `${REPLY_INSTRUCTION}${quoteContinuationLines(`[STILL WAITING]
// ${askRecord.question}`)}`. REPLY_INSTRUCTION is counted on its own above;
// askRecord.question is per-ask data excluded as interpolation; the one
// literal fragment this site contributes on top of those is whatever text
// precedes `${askRecord.question}` inside that inner backtick, captured from
// the source rather than hardcoded, so a reword of the label is picked up
// automatically.
function extractStillWaitingReraise(src) {
  const m = /`([^`]*)\$\{askRecord\.question\}`/.exec(src);
  if (!m) throw new Error("still-waiting reraise frame not found in hooks/index.ts");
  return record("STILL_WAITING_RERAISE_TEXT", "hooks/index.ts", m[1]);
}

// fleetPromptText's returned frame: `${REPLY_INSTRUCTION}[FLEET] ${count}
// reading...continue your work:` + "\n" + lines.join("\n"). The backtick
// template is this frame's literal text once REPLY_INSTRUCTION and ${count}
// are stripped. The `lines` joined after it are composed one per fleet row
// from three things rather than two: fixed field labels, per-row data, and
// the authored prose of a note's `composed` half, several of which run to a
// sentence or more. The labels are sized separately by
// extractFleetPromptLineLiterals below. The `composed` prose is not sized by
// any rule here, because it reaches the line through an interpolation and
// this section's extraction excludes interpolated content. It is the
// ledger's largest declared gap and the header above names it as one.
function extractFleetPromptFrame(src) {
  const m = /return `(\$\{REPLY_INSTRUCTION\}\[FLEET\][^`]*)`\s*\+\s*"\\n"\s*\+\s*lines\.join/.exec(src);
  if (!m) throw new Error("fleetPromptText frame not found in hooks/index.ts");
  return record("FLEET_PROMPT_FRAME", "hooks/index.ts", m[1]);
}

// Every string literal in a region of TS source, in the order the scan
// meets its closing delimiter: the content of each single- or double-quoted
// string, and of each template literal with its ${...} interpolations
// removed, recursing into the strings and templates an interpolation itself
// carries, so a label inside a ternary inside an interpolation is read.
// Comments are skipped so an apostrophe in one cannot open a phantom
// string. Escapes ride through raw and are decoded once in record().
function collectStringLiterals(region) {
  const out = [];
  let i = 0;
  function readQuoted(quote) {
    let j = i + 1;
    let piece = "";
    while (j < region.length && region[j] !== quote) {
      if (region[j] === "\\") {
        piece += region[j] + region[j + 1];
        j += 2;
      } else {
        piece += region[j];
        j++;
      }
    }
    if (j >= region.length) throw new Error("unterminated string literal while collecting literals");
    i = j + 1;
    return piece;
  }
  function readTemplate() {
    let j = i + 1;
    let literal = "";
    while (j < region.length && region[j] !== "`") {
      if (region[j] === "\\") {
        literal += region[j] + region[j + 1];
        j += 2;
        continue;
      }
      if (region[j] === "$" && region[j + 1] === "{") {
        i = j + 2;
        let depth = 1;
        while (i < region.length && depth > 0) {
          const c = region[i];
          if (c === '"' || c === "'") { out.push(readQuoted(c)); continue; }
          if (c === "`") { out.push(readTemplate()); continue; }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          i++;
        }
        if (depth !== 0) throw new Error("unterminated ${...} while collecting literals");
        j = i;
        continue;
      }
      literal += region[j];
      j++;
    }
    if (j >= region.length) throw new Error("unterminated template literal while collecting literals");
    i = j + 1;
    return literal;
  }
  while (i < region.length) {
    const c = region[i];
    if (c === "/" && region[i + 1] === "/") {
      const nl = region.indexOf("\n", i);
      i = nl === -1 ? region.length : nl + 1;
      continue;
    }
    if (c === "/" && region[i + 1] === "*") {
      const end = region.indexOf("*/", i + 2);
      i = end === -1 ? region.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") { out.push(readQuoted(c)); continue; }
    if (c === "`") { out.push(readTemplate()); continue; }
    i++;
  }
  return out;
}

// The body of `function NAME(...) {...}`: the text strictly between its
// braces. The parameter list of every function this is applied to carries
// no brace, so the first `{` after the name opens the body.
function functionBody(src, name) {
  const idx = src.indexOf(`function ${name}(`);
  if (idx === -1) throw new Error(`function ${name} not found in hooks/index.ts`);
  const open = src.indexOf("{", idx);
  if (open === -1) throw new Error(`function ${name} has no body`);
  const close = findMatchingBrace(src, open);
  return src.slice(open + 1, close);
}

// The fixed text of the [FLEET] prompt's per-row lines: the field labels
// (`action `, `enabled `, `claim `, ...), the fixed values a field can take
// (`yes`, `no`, `held`, `no commons entry`, `unreadable`, ...), the
// suppressed-changes tail and the hold-reason and note line openers, all
// composed into `lines` before the frame's `return`. Read from the bodies of
// fleetSuppressedTail and fleetPromptText, the latter cut at its return
// statement, which extractFleetPromptFrame sizes. Each literal is its own
// line of the entry, so two fragments cannot glue into one sentence.
function extractFleetPromptLineLiterals(src) {
  const tailBody = functionBody(src, "fleetSuppressedTail");
  const promptBody = functionBody(src, "fleetPromptText");
  const returnIdx = promptBody.indexOf("return `${REPLY_INSTRUCTION}[FLEET]");
  if (returnIdx === -1) throw new Error("fleetPromptText's return statement was not found inside its body; the body was cut short or the frame moved");
  if (!/^return `[^`]*` \+ "\\n" \+ lines\.join\("\\n"\);\s*$/.test(promptBody.slice(returnIdx))) {
    throw new Error("fleetPromptText's body does not end at its return statement; a statement after the return, or a truncated body, would leave line literals unsized");
  }
  const literals = [
    ...collectStringLiterals(tailBody),
    ...collectStringLiterals(promptBody.slice(0, returnIdx)),
  ].filter((s) => s.length > 0);
  if (literals.length === 0) throw new Error("fleetPromptText composes no line literal before its return; the rule no longer reads the function it was written for");
  return record("FLEET_PROMPT_LINE_LITERALS", "hooks/index.ts", literals.join("\n"));
}

// The [KAIZEN] frame: `${REPLY_INSTRUCTION}[KAIZEN] Post each line below...`
// followed by `+ announced.map((line) => `- ${line}`).join("\n")`. Each
// announced line is per-announcement data and excluded; the two-character
// `- ` prefix the map puts on each is fixed text this rule does not size.
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
  // Neither arm splices a whole variable, so no identifier is declared and
  // any operand that is not a template literal refuses.
  return [
    record("NUDGE_TEXT_idle_gap_converted", "hooks/index.ts", literalOfTemplateChain(m[1], "NUDGE_TEXT_idle_gap_converted")),
    record("NUDGE_TEXT_idle_timeout", "hooks/index.ts", literalOfTemplateChain(m[2], "NUDGE_TEXT_idle_timeout")),
  ];
}

// The [GOAL TREE] block. `siblingLine` and `lastNote` are whole-variable
// insertions (not `${}` interpolations inside one template literal), so they
// are declared to the chain reader by name and their content is not sized
// here. Their own fixed openers (`Pending siblings: `, `Last note: `) and the
// `root > ` of `path` are therefore not sized by this rule. Declaring them is
// what lets any other bare identifier refuse rather than vanish.
function extractGoalTreeBlock(src) {
  const m = /const goalBlock =\s*\n([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("goalBlock not found in hooks/index.ts");
  const literal = literalOfTemplateChain(m[1], "GOAL_TREE_BLOCK", ["siblingLine", "lastNote"]);
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
  const literal = literalOfTemplateChain(m[1], "NO_GOAL_BLOCK");
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

// --- Structural check: every context block the prompt.submit hook pushes.
// The identifier each `contextBlocks.push(<identifier>)` names, mapped to
// the ledger entry whose rule sizes that identifier's literal text. A push
// of an identifier this table does not name, a table identifier no push
// names, or one identifier pushed twice, throws, so a seventh block fails
// the build until a rule sizes it.
const CONTEXT_BLOCKS = {
  goalBlock: "GOAL_TREE_BLOCK",
  pausedBlock: "GOAL_TREE_PAUSED_BLOCK",
  idleBlock: "NO_GOAL_BLOCK",
  envBlock: "ENV_BLOCK",
  lessonBlock: "LESSON_BLOCK",
  memoryBlock: "MEMORY_BLOCK",
};

function checkContextBlocks(src, entryNames) {
  const pushRe = /contextBlocks\.push\(([^)]*)\)/g;
  const pushed = [];
  let m;
  while ((m = pushRe.exec(src)) !== null) pushed.push(m[1].trim());
  const known = new Set(Object.keys(CONTEXT_BLOCKS));
  const unknown = pushed.filter((p) => !known.has(p));
  const missing = setDifference(known, new Set(pushed));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `[context-blocks] hooks/index.ts pushes context blocks CONTEXT_BLOCKS does not name (${unknown.join(", ") || "none"}) or no longer pushes ones it does (${missing.join(", ") || "none"}); every contextBlocks.push is sized by a named rule, so add a rule and a CONTEXT_BLOCKS row for the new block, or retire the row for the dropped one, in the same commit`,
    );
  }
  if (pushed.length !== known.size) {
    throw new Error(
      `[context-blocks] hooks/index.ts pushes ${pushed.length} context blocks where CONTEXT_BLOCKS names ${known.size}; one identifier is pushed more than once, and the ledger sizes each block once`,
    );
  }
  for (const [ident, entry] of Object.entries(CONTEXT_BLOCKS)) {
    if (!entryNames.has(entry)) throw new Error(`[context-blocks] CONTEXT_BLOCKS maps ${ident} to ledger entry ${entry}, which no rule produced`);
  }
}

// --- Structural check: every prompt the plugin submits to the child.
// One row per submitExpectedTurn call site in hooks/index.ts, keyed by a
// token of the call's entry argument, naming the ledger entries whose rules
// size that prompt's literal text. A call site matching no row, or two rows,
// throws, as does a row matching no call site, so a new prompt fails the
// build until a rule sizes it and a row names it. Two rows are exclusions
// rather than entries: the two record-delivery sites, whose whole text is
// built by deliveryText in hooks/operator.ts, a file this ledger does not
// read. For each, the check asserts that hooks/index.ts contributes no
// literal text of its own at the site, so the exclusion holds exactly as
// long as the text stays entirely operator.ts's.
// Every call site in hooks/index.ts that hands its text to deliveryText.
// Two reach the child through submitExpectedTurn and carry a row below; the
// third delivers inside a running turn as tool-result context and carries
// none, which is why this class is counted by shape rather than by that
// table. Raising this number declares a new excluded site and owes the same
// change to README.md's coverage sentence.
const DELIVERY_SITE_COUNT = 3;

const PROMPT_CALL_SITES = [
  { anchor: "reraiseEntry", entries: ["STILL_WAITING_RERAISE_TEXT"] },
  { anchor: "fleetPromptText(", entries: ["FLEET_PROMPT_FRAME", "FLEET_PROMPT_LINE_LITERALS"] },
  { anchor: "RECONCILE_TEXT", entries: ["RECONCILE_TEXT"] },
  { anchor: "expectedAnswerTurn", excludedTextVar: "answerText" },
  { anchor: "expectedDeliveryTurn", excludedTextVar: "submittedText" },
  { anchor: "kaizenText", entries: ["KAIZEN_FRAME"] },
  { anchor: "expectedNudgeTurn", entries: ["NUDGE_TEXT_idle_gap_converted", "NUDGE_TEXT_idle_timeout"] },
  { anchor: "backstopText", entries: ["REPLY_BACKSTOP_FRAME"] },
];

// The exclusions above in a public shape, so the duplicate test can pin the
// list: a third exclusion is a coverage change declared there, not here alone.
const EXCLUDED_PROMPT_SITES = PROMPT_CALL_SITES
  .filter((s) => s.excludedTextVar)
  .map((s) => ({ anchor: s.anchor, textVar: s.excludedTextVar, builder: "deliveryText", file: "hooks/operator.ts" }));

function checkPromptCallSites(src, entryNames) {
  const lines = src.split("\n");
  const argRe = /submitExpectedTurn\(\s*[\w$]+\s*,\s*expectedTurns\s*,\s*(.*)\)\s*;\s*$/;
  const matched = new Map();
  lines.forEach((line, idx) => {
    if (!/submitExpectedTurn\(/.test(line)) return;
    if (/function submitExpectedTurn\(/.test(line)) return;
    const lineNo = idx + 1;
    const am = argRe.exec(line);
    if (!am) {
      throw new Error(
        `[prompt-call-sites] hooks/index.ts:${lineNo} calls submitExpectedTurn in a shape this rule cannot read (one line ending in \`, expectedTurns, <entry>);\`): ${line.trim()}`,
      );
    }
    const arg = am[1];
    const hits = PROMPT_CALL_SITES.filter((s) => arg.includes(s.anchor));
    if (hits.length !== 1) {
      throw new Error(
        `[prompt-call-sites] hooks/index.ts:${lineNo} submits a prompt entry (${arg}) matching ${hits.length} PROMPT_CALL_SITES rows; every submitExpectedTurn call site is sized by a named rule or named as an exclusion there, so add a row for this site with the rule that sizes its text in the same commit`,
      );
    }
    const { anchor } = hits[0];
    if (matched.has(anchor)) {
      throw new Error(
        `[prompt-call-sites] hooks/index.ts:${lineNo} and :${matched.get(anchor)} both match the PROMPT_CALL_SITES row ${anchor}; one row sizes one site`,
      );
    }
    matched.set(anchor, lineNo);
  });
  const unmatched = PROMPT_CALL_SITES.filter((s) => !matched.has(s.anchor));
  if (unmatched.length > 0) {
    throw new Error(
      `[prompt-call-sites] no submitExpectedTurn call site in hooks/index.ts matches the PROMPT_CALL_SITES row(s) ${unmatched.map((s) => s.anchor).join(", ")}; the site moved or was removed, so re-anchor or retire its row and its ledger rule in the same commit`,
    );
  }
  for (const site of PROMPT_CALL_SITES) {
    for (const entry of site.entries ?? []) {
      if (!entryNames.has(entry)) throw new Error(`[prompt-call-sites] PROMPT_CALL_SITES names ledger entry ${entry} for ${site.anchor}, which no rule produced`);
    }
  }

  // The one direct .prompt.submit call is the one inside submitExpectedTurn;
  // a second is a prompt that reaches the child past every row above.
  const submitCalls = src.match(/\.prompt\.submit\(/g) || [];
  if (submitCalls.length !== 1) {
    throw new Error(
      `[prompt-submit] expected exactly 1 .prompt.submit( call in hooks/index.ts, the one inside submitExpectedTurn, found ${submitCalls.length}; a prompt submitted outside submitExpectedTurn is a frame no rule here sizes`,
    );
  }

  for (const site of PROMPT_CALL_SITES) {
    if (!site.excludedTextVar) continue;
    const v = site.excludedTextVar;
    const assignRe = new RegExp(`^\\s*const ${v} = deliveryText\\((.*)\\);\\s*$`, "m");
    const am = assignRe.exec(src);
    if (!am) {
      throw new Error(
        `[delivery-exclusion] hooks/index.ts no longer builds ${v} as \`const ${v} = deliveryText(...);\`; the ${site.anchor} site is excluded from the ledger only while hooks/operator.ts's deliveryText builds its whole text, so ledger the text here or restore that shape`,
      );
    }
    if (/["'`]/.test(am[1])) {
      throw new Error(
        `[delivery-exclusion] ${v} carries literal text at its call site in hooks/index.ts (deliveryText(${am[1]})); the ${site.anchor} exclusion holds only while every argument is data, so ledger the literal here or move it into deliveryText`,
      );
    }
    const useRe = new RegExp(`expectTurn\\(\\{[^}]*\\btext: ${v} \\}\\)`);
    if (!useRe.test(src)) {
      throw new Error(
        `[delivery-exclusion] no expectTurn({ ..., text: ${v} }) entry is built from ${v} in hooks/index.ts; the ${site.anchor} site submits text this rule did not trace`,
      );
    }
  }

  // Every deliveryText( call site in this file, found by its shape rather
  // than by a name list. The two rows above are the sites that reach the
  // child through submitExpectedTurn. The third hands a record to the
  // running turn as tool-result context instead, so no prompt-call-site row
  // reaches it and the two rows above cannot be what bounds this class.
  // All three are excluded on one ground, that hooks/operator.ts's
  // deliveryText composes the whole text, so all three owe the same
  // assertion. The ground, id and text arguments must carry no literal. A
  // trailing options object may, because its `mark` and `answerTo` values
  // select a prefix deliveryText composes rather than adding text here.
  const deliveryCalls = [...src.matchAll(/deliveryText\(/g)];
  if (deliveryCalls.length !== DELIVERY_SITE_COUNT) {
    throw new Error(
      `[delivery-exclusion] expected ${DELIVERY_SITE_COUNT} deliveryText( call site(s) in hooks/index.ts, found ${deliveryCalls.length}; every one is excluded from this ledger on the same ground and each owes its own no-literal assertion, so declare the new site here and in README.md's coverage sentence in the same commit`,
    );
  }
  for (const call of deliveryCalls) {
    const open = call.index + call[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < src.length; k += 1) {
      if (src[k] === "(") depth += 1;
      else if (src[k] === ")") {
        depth -= 1;
        if (depth === 0) { close = k; break; }
      }
    }
    if (close === -1) throw new Error(`[delivery-exclusion] a deliveryText( call in hooks/index.ts has no closing parenthesis this rule can find`);
    const args = src.slice(open + 1, close);
    const optsIdx = args.indexOf("{");
    const textArgs = optsIdx === -1 ? args : args.slice(0, optsIdx);
    if (/["'`]/.test(textArgs)) {
      throw new Error(
        `[delivery-exclusion] a deliveryText call in hooks/index.ts carries literal text in its ground, id or text argument (deliveryText(${args.trim()})); the exclusion holds only while those three are data, so ledger the literal here or move it into deliveryText`,
      );
    }
  }
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
    const chain = parseStringLiteralChain(head, head.slice(afterKey).search(/\S/) + afterKey, `tool ${toolName}'s top-level description`);
    if (!chain) throw new Error(`tool ${toolName}'s top-level description did not parse as a string literal chain`);
    const topDescription = chain.value;

    // Parameter descriptions: every `<param>: { type: "...", description:
    // ...(chain)... }` inside inputSchema.properties, in declaration order.
    const tail = block.slice(schemaIdx);
    const paramRe = /(\w+):\s*\{\s*type:\s*(?:"[^"]*"|'[^']*'),\s*description:\s*/g;
    const paramDescriptions = [];
    let pm;
    while ((pm = paramRe.exec(tail)) !== null) {
      const pChain = parseStringLiteralChain(tail, pm.index + pm[0].length, `tool ${toolName}'s \`${pm[1]}\` parameter description`);
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

// The ledger over two source texts, already LF-normalized. Separated from
// the file reads so the duplicate test's controls can hand it a mutated
// copy of the real source and watch a guard fire without touching the tree.
function buildLedgerFrom(shSrc, tsSrc) {
  const entries = [
    ...extractShellInstructions(shSrc),
    extractReplyInstruction(tsSrc),
    extractReconcileText(tsSrc),
    extractStillWaitingReraise(tsSrc),
    extractFleetPromptFrame(tsSrc),
    extractFleetPromptLineLiterals(tsSrc),
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
  const entryNames = new Set(entries.map((e) => e.name));
  if (entryNames.size !== entries.length) throw new Error("two ledger rules produced the same entry name");
  checkContextBlocks(tsSrc, entryNames);
  checkPromptCallSites(tsSrc, entryNames);
  return entries;
}

function buildLedger() {
  return buildLedgerFrom(readNormalized(shPath), readNormalized(tsPath));
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

export { buildLedger, buildLedgerFrom, toPublicShape, EXCLUDED_PROMPT_SITES, DELIVERY_SITE_COUNT };
