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
// string, covering the plan's Approach inventory plus the per-prompt context
// blocks and tool descriptions Section 1 names beyond it, mirroring
// .kit/check-loader-rule.mjs's per-rule regexes rather than a general parser:
// the set of strings is small, named, and shaped differently enough (a shell
// variable, a template literal with interpolation, a tool registration
// object) that one rule per shape reads plainly, where a single generic
// parser covering all three shapes would not.
//
// Each rule reads the source shape its own comment names, and refuses the
// shape changes that comment names. An extraction that cannot match its
// anchor, or that matches fewer or more pieces than its table expects, throws
// with the name and both counts; it never records a zero, a partial value or
// a default, because a string that silently shrank in the ledger reads to the
// size check as a trim.
//
// What no rule here reaches is a rewrite into a shape no rule names, and the
// largest case of that is a name. This tool reads text with patterns and
// resolves no identifier, so it cannot tell a variable carrying data from one
// carrying prose hoisted out of a literal. Every exclusion below that accepts
// a bare reference accepts a hoisted string on the same terms. That bound is
// declared rather than closed, because closing it needs a parser rather than
// a further pattern. What stands in its place is the plan's own design: each
// section that rewrites these sources carries this file in its own files in
// scope and re-anchors the rules it moves, under that section's reviewers,
// and each such section's acceptance is its sentence accounting rather than a
// size. Beside the per-string rules, four structural checks
// read each family's shape off the source rather than off this file's list,
// so a member the list does not name fails the build: every *_INSTRUCTION
// variable the supervisor assigns and every variable its priming write
// splices in, every contextBlocks.push in the plugin, every
// submitExpectedTurn call site and every direct .prompt.submit call, and
// every $.tool.register block.
//
// A second coverage bound is declared rather than closed. Three call sites
// deliver an inbox record, and their whole text is built by
// deliveryText in hooks/operator.ts, a file this ledger does not read. Two
// of those sites reach the child through submitExpectedTurn and are named in
// PROMPT_CALL_SITES as exclusions; the third hands its record to the running
// turn as tool-result context instead and is reached by no row there. All
// three are counted and asserted by shape, the ledger requiring that none
// contributes literal text in its ground, id or text argument, and the
// duplicate test pins both the named exclusion list and the site count, so a
// fourth site or a literal added at any of them fails rather than slipping
// past. Fixed literals inside interpolated expressions are sized only where
// a rule names them: the [FLEET] prompt's per-row line literals are one such
// rule, and the authored prose of a [FLEET] note's `composed` half is
// another. The "- " prefix on each [KAIZEN] line and the "Pending siblings: ",
// "Last note: " and "root > " fragments of the [GOAL TREE] block are not
// sized by any rule here. Neither is prose a fleet note splices into its
// own template through an interpolation whose value is not itself a
// literal: a state key or well-state reading named as a constant, a
// helper's return, or a value read off another note. A literal inside an
// interpolation is sized, both arms of a ternary included, because the
// collector recurses into an interpolation and reads the literals it
// carries. What the composed-prose rule below cannot size is what it
// cannot resolve, so the bound is the shape rather than a count of
// today's sites, and a new unresolvable splice is unsized the moment it
// is written rather than falsifying a number here.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(__dirname, "..");
const shPath = join(repoRoot, "bin", "supervise.sh");
const holderPath = join(repoRoot, "bin", "supervise-holder.sh");
const tsPath = join(repoRoot, "hooks", "index.ts");

function readNormalized(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

// Standard backslash escapes, decoded to the real character they represent.
// Applied uniformly below to every extracted string regardless of source
// shape (a bash double-quoted assignment, a TS string literal, a TS
// template literal). One rule rather than two is a simplification, not an
// equivalence, and the difference runs the undercounting way. A TS `\n` is
// one newline in the child. A bash double-quoted `\n` is two characters
// there, since bash performs no such decoding and the priming write hands
// the string to node argv and through JSON.stringify unchanged. So a shell
// clause carrying a backslash escape is sized one character short per
// escape. No assignment line carries one at this base, which is what keeps
// the simplification harmless today rather than correct. Deciding by source
// shape is the fix, and it changes what the rule reads rather than what a
// comment claims, so it belongs to a section that carries this file in its
// own files in scope and re-anchors under that section's reviewers.
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
// Brace depth is counted, and a template literal nested inside the
// interpolation is consumed whole, so `${a ? `${b}` : "c"}` is removed as
// one unit. A pattern that stopped at the first closing brace would remove
// the inner interpolation and leave the rest of the expression behind as
// prose, which then rides in the entry, inflates its size and is indexed by
// the duplicate check as injected text no prompt actually carries. The scan
// below and the one literalOfTemplateChain uses to skip an interpolation
// while tokenizing are two copies of one algorithm rather than one shared
// function, and they differ deliberately at exactly one case: an
// interpolation that never closes throws there, where the source is a chain
// this ledger must size, and drops the remainder here, where emitting it
// would be the residue this scan exists to prevent. Neither shape occurs in
// source that parses. Two copies can drift where one cannot, so a change to
// either is made to both.
function stripInterpolations(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && text[i + 1] === "{") {
      let depth = 1;
      let k = i + 2;
      while (k < text.length && depth > 0) {
        const c = text[k];
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        else if (c === "`") {
          let t = k + 1;
          while (t < text.length && text[t] !== "`") {
            if (text[t] === "\\") t += 1;
            t += 1;
          }
          k = t;
        }
        k += 1;
      }
      // An unterminated interpolation drops the remainder rather than
      // emitting it as prose: the alternative is the residue this scan
      // exists to prevent, and the shape cannot occur in source that parses.
      i = k;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
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
          `[chain-truncated] ${owner || "string literal chain"}: a \`+\` is followed by ${operand}, which is not a quoted literal, so every piece after it would be dropped from the entry. A line comment sitting between two pieces reads this way too, and is a legitimate shape rather than a malformed chain; move it above the statement.`,
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
  SKILL_LOAD_INSTRUCTION: 2,
  COORDINATOR_STEER_INSTRUCTION: 4,
  CHANNEL_REPLY_INSTRUCTION: 2,
  COORDINATOR_ROLE_INSTRUCTION: 5,
  ARCHITECT_ROLE_INSTRUCTION: 2,
  SUPERVISOR_MAILBOX_INSTRUCTION: 1,
};
const INSTRUCTION_NAMES = Object.keys(INSTRUCTION_ASSIGNMENT_COUNTS);

function extractHolderInstructions(src) {
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
      `[instruction-set] bin/supervise-holder.sh assigns *_INSTRUCTION variables INSTRUCTION_ASSIGNMENT_COUNTS does not name (${declaredNotInTable.join(", ") || "none"}) or no longer assigns ones it does (${tableNotDeclared.join(", ") || "none"}); add each new variable to that table with its assignment-line count, or retire the missing one from it, in the same commit`,
    );
  }

  // Structural leg two: the variables the priming write itself splices into
  // the child's first turn, read off the write's own argument. A variable
  // written to the child under a name that does not end in _INSTRUCTION
  // fails here, where leg one cannot see it.
  // The holder writes the priming turn to its own stdout, which is the child's
  // stdin pipe, so the write ends in "$PRIMING_BODY" with no fd redirect.
  const writeRe = /"\s+"((?:\$[A-Za-z_][A-Za-z0-9_]*)+)"\s+"\$PRIMING_BODY"/;
  const writeMatch = writeRe.exec(src);
  if (!writeMatch) {
    throw new Error(
      `[priming-write] the priming write ("$A$B..." "$PRIMING_BODY") was not found in bin/supervise-holder.sh; the write's shape changed and this rule must follow it in the same commit`,
    );
  }
  const written = new Set(writeMatch[1].split("$").filter(Boolean));
  const writtenNotInTable = setDifference(written, tableNames);
  const tableNotWritten = setDifference(tableNames, written);
  if (writtenNotInTable.length > 0 || tableNotWritten.length > 0) {
    throw new Error(
      `[priming-write] the priming write in bin/supervise-holder.sh splices variables the ledger does not size (${writtenNotInTable.join(", ") || "none"}) or omits ones it does (${tableNotWritten.join(", ") || "none"}); every variable written to the child's first turn is sized here, so add a rule and a table row for the new one, or retire the row for the dropped one, in the same commit`,
    );
  }

  // The sum below models `+=` and nothing else, so the collector reads the
  // `+` and refuses the one assignment shape the sum would misread: a bare
  // `NAME="..."` carrying text where some earlier assignment of that name
  // already carried text. Such a line replaces the variable at runtime and is
  // summed here as though it appended, so text moved out of the earlier
  // assignment into it leaves the total unchanged while every launch shape
  // taking the earlier one loses that text, and a size check that refuses
  // only growth stays silent through the whole move.
  //
  // Two bare shapes stay legal because neither bends the sum. An empty init
  // followed by one conditional value is how most of these variables are
  // built, and replacing an empty string is the same operation as appending
  // to it. An empty clear (`NAME=""` in the architect's block, which takes
  // neither the skill-load nor the steer sentence) contributes nothing to the
  // sum either way.
  const collected = new Map(INSTRUCTION_NAMES.map((n) => [n, []]));
  const assignRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\+?)=\s*"([^\n]*)"\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = assignRe.exec(lines[i]);
    if (!m) continue;
    const [, name, plus, content] = m;
    if (!collected.has(name)) continue;
    const priorText = collected.get(name).filter((c) => c !== "").length;
    if (plus !== "+" && content !== "" && priorText > 0) {
      throw new Error(
        `[instruction-reassign] ${name} in bin/supervise-holder.sh line ${i + 1}: this line carries text under the bare shape NAME="..." and ${priorText} earlier assignment(s) of that name already carry text, so it replaces the variable where the ledger's sum reads it as appending and the recorded size would not move if a clause were carried across; expected NAME+="..." for a clause that adds to the shapes before it, or the empty NAME="" for an init or for a launch shape that withholds the variable. Write the line as NAME+="..." where it appends, and where the variable really is replaced for one launch shape, give this name its own extraction rule that sizes each shape rather than their sum, in the same commit.`,
      );
    }
    collected.get(name).push(content);
  }
  for (const name of INSTRUCTION_NAMES) {
    // Every assignment and += continuation found for this name, in source
    // order, concatenated: an empty init followed by one conditional real
    // value yields the real value; a base assignment followed by
    // conditional += clauses (COORDINATOR_ROLE_INSTRUCTION's fleet, seat and
    // architect-routing clauses) yields their sum, which is this variable's
    // worst-case content across every launch shape. A later `NAME=""` that
    // clears a variable for one launch shape (the architect's, which takes
    // neither the skill-load nor the steer sentence) adds nothing to that sum,
    // so the worst case still reads the shape that carries the text. The only
    // other reassignment shape, a later bare assignment carrying text, would
    // break that reading and the collector above refuses it.
    const assignments = collected.get(name);
    const expected = INSTRUCTION_ASSIGNMENT_COUNTS[name];
    if (assignments.length !== expected) {
      throw new Error(
        `[instruction-count] ${name} in bin/supervise-holder.sh: expected ${expected} single-line assignment(s) of the shape NAME="..." or NAME+="...", found ${assignments.length}; a clause was wrapped onto more than one line, gained an internal quote, or was added or removed, and the ledger cannot sum what it did not match; restore the single-line shape or set the count in INSTRUCTION_ASSIGNMENT_COUNTS in the same commit`,
      );
    }
    const text = assignments.join("");
    results.push(record(name, "bin/supervise-holder.sh", text));
  }

  // The three priming bodies: PRIMING_BODY is assigned once per branch of a
  // three-way if/elif/else (a prompt is pending; a channel is attached and
  // none is; no channel at all), so the three assignments are mutually
  // exclusive at runtime and each is its own ledger entry rather than a
  // concatenation.
  // The append form is read here rather than passed over. A
  // `PRIMING_BODY+="..."` clause is part of the same body bash writes to the
  // child, so its text reaches the session exactly as a plain assignment's
  // does. A rule matching `=` alone would leave the three plain assignments
  // matching and the count still three, and nothing else in this file would
  // see the clause. The three entries are one per branch of a mutually
  // exclusive if/elif/else, so an appended clause belongs to no single branch
  // and is refused rather than guessed at. The instruction table above reads
  // `(\+?)=` for the same reason, where a concatenation does have one owner.
  const primingRe = /^\s*PRIMING_BODY(\+?)="([^\n]*)"\s*$/;
  const primingLabels = [
    "PRIMING_BODY_prompt_pending",
    "PRIMING_BODY_channel_wait",
    "PRIMING_BODY_no_channel_wait",
  ];
  const primingMatches = [];
  for (const line of lines) {
    const m = primingRe.exec(line);
    if (!m) continue;
    if (m[1] === "+") {
      throw new Error(
        "[priming-shape] PRIMING_BODY: a clause is appended with `+=`, which bash writes to the child as part of the same body, so its text is injected text. The three entries here are one per branch of a mutually exclusive if/elif/else, so an appended clause belongs to no single branch and no rule sizes it. Size it explicitly or restore one plain assignment per branch.",
      );
    }
    primingMatches.push(m[2]);
  }
  if (primingMatches.length !== primingLabels.length) {
    throw new Error(
      `expected ${primingLabels.length} PRIMING_BODY assignments in bin/supervise-holder.sh, found ${primingMatches.length}`,
    );
  }
  primingMatches.forEach((text, idx) => {
    results.push(record(primingLabels[idx], "bin/supervise-holder.sh", text));
  });

  // The goal-prompt framing line: the one line the goal-prompt turn opens
  // with, naming the text behind it as the operator's own trusted task.
  // Written as NAME="..."$'\n\n' - a plain double-quoted body followed by
  // an ANSI-C-quoted two-newline suffix - so it needs its own rule rather
  // than the single-line NAME="..." table above.
  const framingRe = /GOAL_PROMPT_FRAMING="([^\n]*)"\$'((?:\\.)*)'/;
  const framingMatch = framingRe.exec(src);
  if (!framingMatch) throw new Error("GOAL_PROMPT_FRAMING not found in bin/supervise-holder.sh");
  results.push(record("GOAL_PROMPT_FRAMING", "bin/supervise-holder.sh", framingMatch[1] + framingMatch[2]));

  // The [SUPERVISOR-PRIMING] marker, prepended to every priming write.
  const primingMarkerRe = /'(\[SUPERVISOR-PRIMING\] )' \+ prefix \+ body/;
  const primingMarkerMatch = primingMarkerRe.exec(src);
  if (!primingMarkerMatch) throw new Error("SUPERVISOR-PRIMING marker not found in bin/supervise-holder.sh");
  results.push(record("SUPERVISOR_PRIMING_MARKER", "bin/supervise-holder.sh", primingMarkerMatch[1]));

  return results;
}

// The two ask texts, which stay in bin/supervise.sh: the final ask the
// supervisor writes to the child-N ask-request file, and the shutdown ask it
// hands the poll. The priming text moved into the holder, so it is sized by
// extractHolderInstructions above; these two are read from the supervisor.
function extractSupervisorAskTexts(src) {
  const results = [];
  // The final ask: final_ask_json writes '[SUPERVISOR-ASK id=' + id + '] ' +
  // text, where text is SUPERVISOR_ASK_TEXT, a single-line assignment. The
  // entry is the marker's two literal halves and the text, the id being data
  // the supervisor mints. Both anchors are required, so a reworded marker or a
  // text moved out of the variable fails here rather than recording short.
  const askTextRe = /^SUPERVISOR_ASK_TEXT="([^\n"]*)"\s*$/m;
  const askTextMatch = askTextRe.exec(src);
  if (!askTextMatch) throw new Error("SUPERVISOR_ASK_TEXT not found in bin/supervise.sh as a single-line assignment");
  const askMarkerRe = /'(\[SUPERVISOR-ASK id=)' \+ id \+ '(\] )' \+ text/;
  const askMarkerMatch = askMarkerRe.exec(src);
  if (!askMarkerMatch) throw new Error("the [SUPERVISOR-ASK id=<id>] marker of final_ask_json not found in bin/supervise.sh");
  results.push(record("SUPERVISOR_ASK_TEXT", "bin/supervise.sh", askMarkerMatch[1] + askMarkerMatch[2] + askTextMatch[1]));

  // The shutdown ask's text: SUPERVISOR_SHUTDOWN_TEXT, a single-line
  // assignment the poll is handed and writes into the mailbox record the
  // plugin submits after its [SUPERVISOR id=<id>] label. The label is sized in
  // hooks/index.ts as SUPERVISOR_SHUTDOWN_FRAME, so this entry is the text
  // alone. Both anchors are required: the assignment, and the variable handed
  // to the poll, so a text the poll no longer receives fails here rather than
  // recording prose nothing injects.
  const shutdownTextRe = /^SUPERVISOR_SHUTDOWN_TEXT="([^\n"]*)"\s*$/m;
  const shutdownTextMatch = shutdownTextRe.exec(src);
  if (!shutdownTextMatch) throw new Error("SUPERVISOR_SHUTDOWN_TEXT not found in bin/supervise.sh as a single-line assignment");
  if (!/supervise-poll\.mjs"[^\n]*(?:\\\n[^\n]*)*"\$SUPERVISOR_SHUTDOWN_TEXT"/.test(src)) {
    throw new Error("SUPERVISOR_SHUTDOWN_TEXT is not handed to bin/supervise-poll.mjs in bin/supervise.sh's poll call");
  }
  results.push(record("SUPERVISOR_SHUTDOWN_TEXT", "bin/supervise.sh", shutdownTextMatch[1]));

  return results;
}

// ---------------------------------------------------------------------------
// hooks/index.ts: each prompt frame's literal text at its call site
// (interpolation excluded), the authored prose of a fleet note, each
// prompt.submit context block's literal text, and every registered tool's
// description plus its parameter descriptions.
// ---------------------------------------------------------------------------

function extractReconcileText(src) {
  const m = /const RECONCILE_TEXT = "([^\n]*)";/.exec(src);
  if (!m) throw new Error("RECONCILE_TEXT not found in hooks/index.ts");
  return record("RECONCILE_TEXT", "hooks/index.ts", m[1]);
}

// The status-line request both idle-nudge frames close with:
// NUDGE_STATUS_LINE_TEXT, a single-line double-quoted constant. The frames
// splice it by name, which extractNudgeFrames declares, so it is sized once
// here rather than twice inside the frames, and the duplicate check reads
// one copy of its sentences.
function extractNudgeStatusLineText(src) {
  const m = /const NUDGE_STATUS_LINE_TEXT = "([^\n"]*)";/.exec(src);
  if (!m) throw new Error("NUDGE_STATUS_LINE_TEXT not found in hooks/index.ts as a single-line double-quoted constant");
  return record("NUDGE_STATUS_LINE_TEXT", "hooks/index.ts", m[1]);
}

// The hold sentence a nudge on a plan entry adds after the status-line
// request: NUDGE_LEAD_HOLD_TEXT, a single-line double-quoted constant. Both
// frames splice it through leadHoldLine, a name extractNudgeFrames declares,
// whose value is this constant behind one space or an empty string, so it is
// sized once here. The one space is not sized.
function extractNudgeLeadHoldText(src) {
  const m = /const NUDGE_LEAD_HOLD_TEXT = "([^\n"]*)";/.exec(src);
  if (!m) throw new Error("NUDGE_LEAD_HOLD_TEXT not found in hooks/index.ts as a single-line double-quoted constant");
  return record("NUDGE_LEAD_HOLD_TEXT", "hooks/index.ts", m[1]);
}

// The nudge cap's ask: the question nudgeCapAskText returns, which the ask
// record stores and the still-waiting re-raise and the expired-ask sentence
// later carry into the worker's context. The persona, the quoted title and
// the count are interpolations and are stripped. The function's whole body
// must be one `return` of one template literal, so a sentence added before
// the return, or hoisted into a name, refuses rather than going unsized.
function extractNudgeCapAskText(src) {
  const body = functionBody(src, "nudgeCapAskText");
  const m = /^\s*return (`[^`]*`);\s*$/.exec(body);
  if (!m) throw new Error("[chain-shape] NUDGE_CAP_ASK_TEXT: nudgeCapAskText's body is not one return of one template literal");
  return record("NUDGE_CAP_ASK_TEXT", "hooks/index.ts", literalOfTemplateChain(m[1], "NUDGE_CAP_ASK_TEXT"));
}

// The still-waiting re-raise: one quoted instruction joined by `+` to
// quoteContinuationLines(`[STILL WAITING] ${askRecord.question}`). The
// question is per-ask data excluded as interpolation. The instruction and
// the label are both authored prose and both are sized.
//
// The capture runs from the assignment to the `;` that closes the statement,
// which is the anchor proving it reached the end of the expression: a piece
// added in front of the call, between the operands, or after it, is inside
// the capture rather than sitting outside it unseen. Every string literal in
// that region is then collected, in the order the scan meets each closing
// delimiter, which for a chain of this shape is source order. They are joined
// with nothing between them, as they concatenate in the child, so a piece
// split in two records the size it recorded whole. The collector
// is used here rather than the shared chain reader because the region mixes a
// quoted literal with a call whose argument is a template, and a reader that
// refused the call would refuse a shape this frame reads correctly. What that
// costs is that a data literal passed to a call in this region would be
// counted as prose, which overcounts rather than under.
function extractStillWaitingReraise(src) {
  const m = /const reraiseText =\s*([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("still-waiting reraise frame not found in hooks/index.ts");
  // Everything outside a literal in this region must be the join, the one
  // call the frame wraps its label line in, or whitespace. A sentence
  // hoisted into a constant and spliced back by name would otherwise leave
  // the other operand's literal behind and record a short value in silence,
  // which findSizeViolations cannot see because it reports growth only.
  const spans = collectLiteralSpans(m[1]);
  let residue = m[1];
  for (const s of spans.filter((x) => x.start >= 0).reverse()) {
    residue = residue.slice(0, s.start) + residue.slice(s.end);
  }
  residue = residue.replace(/quoteContinuationLines\(/g, "").replace(/[+()\s;]/g, "");
  if (residue !== "") {
    throw new Error(`[chain-shape] STILL_WAITING_RERAISE_TEXT: the re-raise region carries ${JSON.stringify(residue.slice(0, 48))} outside any string literal. Prose reaching the re-raise through a name, a call's return or a property read is text this rule cannot size, because it resolves no identifier. Write the sentence as a literal at the site, or give it a rule of its own in the same commit.`);
  }
  const literals = collectStringLiterals(m[1]).filter((s) => s.length > 0);
  if (literals.length === 0) throw new Error("[chain-shape] STILL_WAITING_RERAISE_TEXT: the re-raise text carries no string literal at all");
  return record("STILL_WAITING_RERAISE_TEXT", "hooks/index.ts", literals.join(""));
}

// fleetPromptText's returned frame: `[FLEET] ${count} reading...continue your
// work:` + "\n" + lines.join("\n"). The backtick template is this frame's
// literal text once ${count} is stripped. The `lines` joined after it are
// composed one per fleet row from three things rather than two: fixed field
// labels, per-row data, and the authored prose of a note's `composed` half,
// several of which run to a sentence or more. The labels are sized by
// extractFleetPromptLineLiterals below and the prose by
// extractFleetNoteComposedProse, so all three of the frame's own sources are
// sized by a rule here.
function extractFleetPromptFrame(src) {
  const m = /return `(\[FLEET\][^`]*)`\s*\+\s*"\\n"\s*\+\s*lines\.join/.exec(src);
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
  return collectLiteralSpans(region).map((s) => s.text);
}

// The same scan, each literal carrying the span it occupied. A caller that
// needs to know what in a region was not a literal reads these spans and
// blanks them; extractFleetNoteComposedProse below is the one that does. A
// literal met inside an interpolation carries no span, since the template
// enclosing it already spans it, and blanking both would blank the same
// bytes twice.
function collectLiteralSpans(region) {
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
          if (c === '"' || c === "'") { out.push({ text: readQuoted(c), start: -1, end: -1 }); continue; }
          if (c === "`") { out.push({ text: readTemplate(), start: -1, end: -1 }); continue; }
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
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      const text = c === "`" ? readTemplate() : readQuoted(c);
      out.push({ text, start, end: i });
      continue;
    }
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
  const returnIdx = promptBody.indexOf("return `[FLEET]");
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

// Every fleet note's `composed` half: the plugin's own sentence, spliced
// into a '- ' line of the [FLEET] prompt through an interpolation. A note's
// `carried` half is text quoted out of a file and is per-reading data; the
// composed half is authored prose, several sites running to a sentence or
// more, and this is the rule that sizes it.
//
// The sites are read by shape rather than from a list: every `composed:`
// key in hooks/index.ts outside the FleetLine type's own declaration is a
// site, so one added anywhere in the file is sized the moment it is
// written in that shape. One written in shorthand (`{ composed, carried }`)
// is not sized, and is refused by name below rather than passed over: the
// shorthand's value is an identifier by definition, and this file resolves
// no identifier, so there is no more correct reading of one here than of a
// sentence hoisted into a constant. Each site's value region runs to the
// `carried:` key that closes
// the pair, which is the anchor proving the capture reached the end of the
// value. Inside that region, everything outside a string literal must be
// whitespace or the comma that closes the pair. An identifier, a call or a
// condition standing as the whole value refuses, because a sentence hoisted
// into a constant and spliced back by name is exactly the shape that reaches
// the child unsized, and this file resolves no identifier, so there is no
// correct reading of one here. That check does not reach inside a top-level
// template's own interpolation: the span it strips covers the interpolation
// with it, so a name or a call spliced there passes unsized, which the
// header above declares as an open bound rather than closing it here. A
// `+` joining two literals refuses for a reason of its own: each literal is
// its own line of the entry, so that two sentences cannot glue into one at
// the seam, and a value split into two pieces would therefore record one
// character more than the same value whole. One top-level literal per site
// is the shape that makes the recorded size mean what it says; a template
// contributes its own literal text and the literals its interpolations
// carry, each as its own line of the entry.
function extractFleetNoteComposedProse(src) {
  const typeIdx = src.indexOf("type FleetLine = {");
  if (typeIdx === -1) {
    throw new Error("[fleet-note-prose] the FleetLine type declaration was not found in hooks/index.ts; this rule tells the type's own `composed` key from a note's by that declaration's own region and cannot run without it");
  }
  const typeEnd = findMatchingBrace(src, src.indexOf("{", typeIdx));
  // A note written in shorthand carries no colon, so the key scan below
  // never sees it and the entry would shrink by that site's whole sentence
  // with nothing said. The shape is the `composed` name standing alone in
  // object-literal key position, which is a `{` or a `,` before it and a
  // `,` or a `}` after it. A member read (`line.composed`) is excluded by
  // the opening delimiter, and a `composed:` key by the closing one.
  const shorthandRe = /[{,]\s*composed\s*(?=[,}])/g;
  let sh;
  while ((sh = shorthandRe.exec(src)) !== null) {
    if (sh.index > typeIdx && sh.index < typeEnd) continue;
    throw new Error(`[fleet-note-prose] the fleet note at hooks/index.ts offset ${sh.index} writes its composed half in shorthand property form; that form carries no sentence at the site, only the name of one, and this file resolves no identifier, so the note's prose would leave this ledger unsized and the [FLEET] prompt would grow with nothing declaring it. Write the key and its literal out in full (\`composed: "..."\`), or give the shape a rule of its own in the same commit.`);
  }
  const literals = [];
  let sites = 0;
  const keyRe = /\bcomposed:[ \t]*/g;
  let m;
  while ((m = keyRe.exec(src)) !== null) {
    if (m.index > typeIdx && m.index < typeEnd) continue;
    const at = m.index + m[0].length;
    const carriedIdx = src.indexOf("carried:", at);
    if (carriedIdx === -1) {
      throw new Error(`[fleet-note-prose] the fleet note at hooks/index.ts offset ${at} has no \`carried:\` key after its \`composed:\` key; that key is what bounds the value this rule sizes, so restore the pair's shape or re-anchor this rule in the same commit`);
    }
    const region = src.slice(at, carriedIdx);
    const spans = collectLiteralSpans(region);
    let residue = region;
    for (const s of spans.filter((x) => x.start >= 0).reverse()) {
      residue = residue.slice(0, s.start) + residue.slice(s.end);
    }
    if (!/^[\s,]*$/.test(residue)) {
      throw new Error(`[fleet-note-prose] the fleet note composed half at hooks/index.ts offset ${at} carries ${JSON.stringify(residue.trim().slice(0, 48))} outside any string literal; a fleet note's composed half is one string or template literal and nothing else. Prose reaching the [FLEET] prompt through a name, a call or a condition is text this rule cannot size, because it resolves no identifier; a value split across a `+` would record one character more than the same value whole, because each literal is its own line of the entry. Write the sentence as one literal at the site, or give it a rule of its own in the same commit.`);
    }
    const texts = spans.map((s) => s.text).filter((t) => t.length > 0);
    if (texts.length === 0) {
      throw new Error(`[fleet-note-prose] the fleet note composed half at hooks/index.ts offset ${at} carries no string literal at all`);
    }
    literals.push(...texts);
    sites += 1;
  }
  if (sites === 0) {
    throw new Error("[fleet-note-prose] hooks/index.ts carries no fleet note `composed:` site outside the FleetLine type declaration; the rule no longer reads what it was written for");
  }
  return record("FLEET_NOTE_COMPOSED_PROSE", "hooks/index.ts", literals.join("\n"));
}

// The [KAIZEN] frame: `[KAIZEN] Send each line below...`
// followed by `+ announced.map((line) => `- ${line}`).join("\n")`. Each
// announced line is per-announcement data and excluded; the two-character
// `- ` prefix the map puts on each is fixed text this rule does not size.
//
// The capture runs from the assignment to the `+ announced.map(` that ends
// the literal half, which is the anchor proving it reached the end of that
// half, and the shared chain reader sizes whatever sits between. See
// extractStillWaitingReraise for why both halves are needed.
function extractKaizenFrame(src) {
  const m = /const kaizenText =\s*([\s\S]*?)\s*\+\s*announced\.map\(/.exec(src);
  if (!m) throw new Error("kaizen frame not found in hooks/index.ts");
  return record("KAIZEN_FRAME", "hooks/index.ts", literalOfTemplateChain(m[1], "KAIZEN_FRAME"));
}

// Splits a `+`-joined chain (the raw source text between an assignment's `=`
// and its closing `;`) at a bare identifier operand, returning the text
// before and after it with the neighboring `+` trimmed off each side, so
// both halves are themselves valid chains literalOfTemplateChain can read.
// Used where a declared identifier's own text must be spliced back into its
// exact position in the rendered string, rather than only excluded from it:
// concatenating "everything before and after" with "the identifier's text"
// appended at the end reproduces the identifier's characters but not the
// order the source (and the render) actually put them in.
function splitChainAtIdentifier(chainSrc, ident, owner) {
  const re = new RegExp(`\\+\\s*${ident}\\s*\\+`);
  const m = re.exec(chainSrc);
  if (!m) throw new Error(`[chain-shape] ${owner}: the identifier \`${ident}\` was not found as a chain operand`);
  return { before: chainSrc.slice(0, m.index), after: chainSrc.slice(m.index + m[0].length) };
}

// The [PROPOSE] frame, built by proposeFrame: a chain of template-literal
// pieces joined by `+`, with `goalLines` spliced whole between the first and
// the rest. The goal lines are per-goal data the persona wrote and are not
// sized; `${coordinatorPersona}` is an interpolation and is stripped. The
// capture is bounded by the statement's own semicolon, so a piece added
// anywhere in the chain is inside it.
//
// The chain also splices `levelClause` whole, a ternary declared just above
// the frame. Its plan-and-ask and plan-and-start arms are each a `+`-chain of
// constants already sized elsewhere (PROPOSE_FRAME_PLAN_AND_ASK_TEXT or
// PROPOSE_FRAME_PLAN_AND_START_TEXT, PROPOSE_FRAME_ASK_AWAITING_TEXT at
// plan-and-ask only, and the no-goal-tree clause proposeFrameNoTreeClause
// returns), so this rule only checks their shape rather than sizing them
// again; a changed identifier or operand order refuses. The propose arm is
// the one piece nothing else sizes, a plain template literal read from the
// ternary's own declaration. `levelClause` is spliced at its exact chain
// position (splitChainAtIdentifier) rather than appended after the rest of
// the chain, so the recorded text keeps the order the frame actually
// renders in: at propose, "...belongs in. " then the propose arm then "If
// you have no proposal...". Appending it after the whole chain instead put
// the propose arm's text after the frame's closing sentence, which is not
// what any level ever sends.
function extractProposeFrame(src) {
  const m = /const proposeText =\s*([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("[PROPOSE] frame not found in hooks/index.ts");
  const c = /const levelClause = level === "plan-and-ask"\s*\?\s*PROPOSE_FRAME_PLAN_AND_ASK_TEXT \+ PROPOSE_FRAME_ASK_AWAITING_TEXT \+ noTreeClause\s*:\s*level === "plan-and-start"\s*\?\s*PROPOSE_FRAME_PLAN_AND_START_TEXT \+ noTreeClause\s*:\s*(`[^`]*`);\n/.exec(src);
  if (!c) throw new Error("[chain-shape] PROPOSE_FRAME: the levelClause ternary was not found in hooks/index.ts in the shape this rule reads");
  const { before, after } = splitChainAtIdentifier(m[1], "levelClause", "PROPOSE_FRAME");
  const literal = literalOfTemplateChain(before, "PROPOSE_FRAME before levelClause", ["goalLines"])
    + literalOfTemplateChain(c[1], "PROPOSE_FRAME levelClause propose arm")
    + literalOfTemplateChain(after, "PROPOSE_FRAME after levelClause");
  return record("PROPOSE_FRAME", "hooks/index.ts", literal);
}

// The no-goal-tree fallback proposeFrame calls at plan-and-ask and
// plan-and-start: a function returning one template literal, read the way
// extractNudgeCapAskText reads nudgeCapAskText's body.
function extractProposeFrameNoTreeClause(src) {
  const body = functionBody(src, "proposeFrameNoTreeClause");
  const m = /^\s*return (`[^`]*`);\s*$/.exec(body);
  if (!m) throw new Error("[chain-shape] PROPOSE_FRAME_NO_TREE_CLAUSE: proposeFrameNoTreeClause's body is not one return of one template literal");
  return record("PROPOSE_FRAME_NO_TREE_CLAUSE", "hooks/index.ts", literalOfTemplateChain(m[1], "PROPOSE_FRAME_NO_TREE_CLAUSE"));
}

// A single-line double-quoted top-level constant: the shape
// extractNudgeStatusLineText and extractNudgeLeadHoldText each read with
// their own function. This one is shared across the plain double-quoted
// constants the [STANDING] block and the [PROPOSE] frame add in that same
// shape, since sharing one reader for one shape used this often is the
// simplification the header above reserves for a shape repeated often,
// where a per-shape rule still exists and every entry's name rides in its
// own error.
function extractSimpleTextConst(src, name) {
  const re = new RegExp(`const ${name} =\\s*"([^\\n"]*)";`);
  const m = re.exec(src);
  if (!m) throw new Error(`${name} not found in hooks/index.ts as a single-line double-quoted constant`);
  return record(name, "hooks/index.ts", m[1]);
}

// The backtick counterpart to extractSimpleTextConst, for a constant whose
// text carries a literal double quote (a quoted sentence inside the
// sentence): a double-quoted source literal cannot hold one without an
// escape, and this ledger's simple double-quoted reader does not decode an
// escape mid-capture, so the constant is written as a plain backtick
// template instead.
function extractSimpleTemplateConst(src, name) {
  const re = new RegExp(`const ${name} = \`([^\`]*)\`;`);
  const m = re.exec(src);
  if (!m) throw new Error(`${name} not found in hooks/index.ts as a single-line backtick constant`);
  return record(name, "hooks/index.ts", m[1]);
}

// The reply backstop: `[REPLY BACKSTOP] Send this exact text...unchanged:
// \n${e.answer}`. e.answer is the operator-facing text
// already composed elsewhere and is excluded as interpolation. The capture
// is bounded by the statement's own semicolon for the reason above.
function extractBackstopFrame(src) {
  const m = /const backstopText = ([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("reply backstop frame not found in hooks/index.ts");
  return record("REPLY_BACKSTOP_FRAME", "hooks/index.ts", literalOfTemplateChain(m[1], "REPLY_BACKSTOP_FRAME"));
}

// The supervisor's shutdown delivery: `[SUPERVISOR id=${rec.id}] ${...}`,
// where the id and the quoted record text are mailbox data and are stripped as
// interpolation, leaving the label's literal frame. The capture is bounded by
// the statement's own semicolon for the reason above.
function extractShutdownFrame(src) {
  const m = /const shutdownText = ([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("supervisor shutdown frame not found in hooks/index.ts");
  return record("SUPERVISOR_SHUTDOWN_FRAME", "hooks/index.ts", literalOfTemplateChain(m[1], "SUPERVISOR_SHUTDOWN_FRAME"));
}

// Section 3 (boundary-compaction): the plan document line planDocumentLine
// returns, spliced by name (as `planLine`) into both nudge arms and the
// [GOAL TREE] block, so it is sized once here rather than once per splice
// site. `${holder.planPath}` and `${(holder.chapterCount ?? 0) + 1}` are
// per-plan data and are stripped as interpolation. The function's body must
// be exactly the guard-then-return shape it is written in today: a lookup,
// an empty-string early return, then one `return` of one template literal;
// any other shape (the guard rewritten, a second sentence added before the
// return, the return no longer a single template literal) refuses rather
// than sizing a truncated or wrong copy.
function extractPlanDocumentLine(src) {
  const body = functionBody(src, "planDocumentLine");
  const m = /^\s*const holder = planHolderOf\(state, entry\);\s*\n\s*if \(!holder\?\.planPath \|\| !PLAN_PATH_PATTERN\.test\(holder\.planPath\)\) return "";\s*\n\s*return (`[^`]*`);\s*$/.exec(body);
  if (!m) throw new Error("[chain-shape] PLAN_DOCUMENT_LINE: planDocumentLine's body is not the guard-then-template-return shape this rule reads");
  return record("PLAN_DOCUMENT_LINE", "hooks/index.ts", literalOfTemplateChain(m[1], "PLAN_DOCUMENT_LINE"));
}

// The two idle-nudge frames (nudgeText's ternary): each is a chain of plain
// template-literal pieces joined by `+`, with `${g.objective}` and
// `${idleDisplay}` as the only interpolations, both per-goal data and
// excluded.
//
// Both arms splice `expiredAskLine` whole, the one sentence naming an ask on
// the entry that timed out unnamed, and the idle-gap arm splices
// `architectLine` whole as well, the architect sentence built only where the
// plugin holds an architect name. Each value is a ternary declared just
// above the frame: a template literal, or an empty string. The expired-ask
// sentence interpolates the question, store data, and that interpolation is
// excluded like the others. The architect sentence is read from its
// declaration and sized with the idle-gap frame, the one arm that carries
// it, as the [GOAL TREE] block's roundText is. The expired-ask sentence is
// carried by both arms, so it is sized once, as an entry of its own, and the
// duplicate check reads one copy of it. The two declarations are matched
// only in their fixed order directly above the nudgeText ternary, with the
// comment block and the question read between them, and each arm must be a
// single template literal, so a declaration moved away from the frame, or
// an arm that is not one, refuses.
//
// Both arms also close with NUDGE_STATUS_LINE_TEXT and leadHoldLine, spliced
// by name. They are sized by extractNudgeStatusLineText and
// extractNudgeLeadHoldText as entries of their own, so both are declared here
// and not added to either arm's size.
//
// Section 3 (boundary-compaction): both arms also splice `planLine` whole,
// right after the `${g.objective}` piece, the active entry's plan document
// and section. It is declared above architectLine, outside the fixed-order
// match `a` reads below, and is sized once as its own entry,
// PLAN_DOCUMENT_LINE, by extractPlanDocumentLine, so it is declared here and
// not added to either arm's size, the way NUDGE_STATUS_LINE_TEXT is.
function extractNudgeFrames(src) {
  const m = /const nudgeText = idleGapConverted\s*\n\s*\?\s*([\s\S]*?)\n\s*:\s*([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("nudgeText ternary not found in hooks/index.ts");
  const a = /const architectLine = [^\n]*\n\s*\?\s*(`[^`]*`)\s*\n\s*:\s*"";\n(?:\s*\/\/[^\n]*\n)*\s*const expiredAskQuestion = [^\n]*\n\s*const expiredAskLine = [^\n]*\n\s*\?\s*(`[^`]*`)\s*\n\s*:\s*"";\n\s*const nudgeText = idleGapConverted\b/.exec(src);
  if (!a) throw new Error("the idle-gap nudge's architectLine and expiredAskLine ternaries were not found in hooks/index.ts in the shape this rule reads");
  // The idle-gap arm declares architectLine and expiredAskLine and nothing
  // else, the other arm declares expiredAskLine alone, so any other operand
  // that is not a template literal refuses.
  return [
    record("NUDGE_TEXT_idle_gap_converted", "hooks/index.ts", literalOfTemplateChain(m[1], "NUDGE_TEXT_idle_gap_converted", ["planLine", "architectLine", "expiredAskLine", "NUDGE_STATUS_LINE_TEXT", "leadHoldLine"])
      + literalOfTemplateChain(a[1], "NUDGE_TEXT_idle_gap_converted architectLine")),
    record("NUDGE_TEXT_idle_timeout", "hooks/index.ts", literalOfTemplateChain(m[2], "NUDGE_TEXT_idle_timeout", ["planLine", "expiredAskLine", "NUDGE_STATUS_LINE_TEXT", "leadHoldLine"])),
    record("NUDGE_EXPIRED_ASK_LINE", "hooks/index.ts", literalOfTemplateChain(a[2], "NUDGE_EXPIRED_ASK_LINE")),
  ];
}

// The [GOAL TREE] block. `siblingLine` and `lastNote` are whole-variable
// insertions (not `${}` interpolations inside one template literal), so they
// are declared to the chain reader by name and their content is not sized
// here. Their own fixed openers (`Pending siblings: `, `Last note: `) and the
// `root > ` of `path` are therefore not sized by this rule. Declaring them is
// what lets any other bare identifier refuse rather than vanish.
//
// Section 3 (boundary-compaction): `planLine`, spliced right after the
// `Path: ${path}` piece, is the active entry's plan document and section,
// declared here on the same terms as siblingLine and lastNote and sized
// once as its own entry, PLAN_DOCUMENT_LINE, by extractPlanDocumentLine.
//
// The Active line's round text is the `${roundText}` interpolation, whose
// value is a ternary declared just above the block: an empty string for a
// plan entry, or a template literal for a task entry. The row pins the larger
// shape, so the task-entry arm's literal is read from that declaration and
// sized with the block. The arm must be a single template literal; a
// declaration that has moved, or an arm that is not one, refuses.
function extractGoalTreeBlock(src) {
  const m = /const goalBlock =\s*\n([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("goalBlock not found in hooks/index.ts");
  const r = /const roundText = isPlanEntry\(sess\.state, activeNode\)\s*\n\s*\?\s*""\s*\n\s*:\s*(`[^`]*`);\n/.exec(src);
  if (!r) throw new Error("the [GOAL TREE] roundText ternary was not found in hooks/index.ts in the shape this rule reads");
  const literal = literalOfTemplateChain(m[1], "GOAL_TREE_BLOCK", ["planLine", "siblingLine", "lastNote"])
    + literalOfTemplateChain(r[1], "GOAL_TREE_BLOCK roundText");
  return record("GOAL_TREE_BLOCK", "hooks/index.ts", literal);
}

// The [GOAL QUEUE] block. `queueLines` is the entry lines and the count line,
// per-entry data spliced whole, so it is declared to the chain reader by name
// and not sized, the way the [GOAL TREE] block's siblingLine is. The closing
// line is `queueClose`, a ternary declared just above the block whose two arms
// are each a single template literal. Both arms are read from that
// declaration and sized with the block, joined by a line break so each stays
// its own sentence to the duplicate check, although a prompt carries one. A
// declaration that has moved, or an arm that is not one template literal,
// refuses.
function extractGoalQueueBlock(src) {
  const m = /const queueBlock =\s*\n([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("queueBlock not found in hooks/index.ts");
  const c = /const queueClose = hasStartableWork\(sess\.state\)\s*\n\s*\?\s*(`[^`]*`)\s*\n\s*:\s*(`[^`]*`);\n/.exec(src);
  if (!c) throw new Error("the [GOAL QUEUE] queueClose ternary was not found in hooks/index.ts in the shape this rule reads");
  const literal = literalOfTemplateChain(m[1], "GOAL_QUEUE_BLOCK", ["queueLines", "queueClose"])
    + literalOfTemplateChain(c[1], "GOAL_QUEUE_BLOCK queueClose startable")
    + "\n"
    + literalOfTemplateChain(c[2], "GOAL_QUEUE_BLOCK queueClose idle");
  return record("GOAL_QUEUE_BLOCK", "hooks/index.ts", literal);
}

// The [NO GOAL] reminder: fully literal, no interpolation at all, written as
// a chain of backtick pieces joined by `+`.
function extractNoGoalBlock(src) {
  const m = /const idleBlock =\s*\n([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("idleBlock not found in hooks/index.ts");
  const literal = literalOfTemplateChain(m[1], "NO_GOAL_BLOCK");
  return record("NO_GOAL_BLOCK", "hooks/index.ts", literal);
}

// The [STANDING] block's own frame: the "[STANDING]" header and the two
// newlines that separate its lines, everything else in the chain being a
// whole-variable insertion declared here and sized by its own rule instead:
// the block's two fixed sentences (STANDING_IDLE_ORDER_TEXT,
// STANDING_QUEUE_NAME_TEXT), the selected level sentence (`levelSentence`,
// one of the three STANDING_LEVEL_* constants read out by
// standingLevelSentence), and the conditional idle sentence (`idleSentence`,
// empty or a leading newline plus STANDING_IDLE_DUTIES_TEXT). Autonomy dial
// Section 3, design point 4.
function extractStandingBlock(src) {
  const m = /const standingBlock =\s*\n([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("standingBlock not found in hooks/index.ts");
  const literal = literalOfTemplateChain(m[1], "STANDING_BLOCK", ["STANDING_IDLE_ORDER_TEXT", "STANDING_QUEUE_NAME_TEXT", "levelSentence", "idleSentence"]);
  return record("STANDING_BLOCK", "hooks/index.ts", literal);
}

// The [STANDING] block's three level sentences. Each opens with
// STANDING_OWN_WORK_LEAD_TEXT, spliced whole rather than typed three times,
// and the plan-and-ask and plan-and-start sentences close on
// STANDING_NO_TREE_FALLBACK_TEXT, spliced whole for the same reason. Both are
// sized once by their own extractSimpleTextConst rule and declared here, not
// re-sized, the way NUDGE_STATUS_LINE_TEXT is declared inside the nudge
// frames that splice it.
function extractStandingLevelProposeText(src) {
  const m = /const STANDING_LEVEL_PROPOSE_TEXT =\s*([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("STANDING_LEVEL_PROPOSE_TEXT not found in hooks/index.ts");
  return record("STANDING_LEVEL_PROPOSE_TEXT", "hooks/index.ts", literalOfTemplateChain(m[1], "STANDING_LEVEL_PROPOSE_TEXT", ["STANDING_OWN_WORK_LEAD_TEXT"]));
}
function extractStandingLevelPlanAndAskText(src) {
  const m = /const STANDING_LEVEL_PLAN_AND_ASK_TEXT =\s*([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("STANDING_LEVEL_PLAN_AND_ASK_TEXT not found in hooks/index.ts");
  return record("STANDING_LEVEL_PLAN_AND_ASK_TEXT", "hooks/index.ts", literalOfTemplateChain(m[1], "STANDING_LEVEL_PLAN_AND_ASK_TEXT", ["STANDING_OWN_WORK_LEAD_TEXT", "STANDING_NO_TREE_FALLBACK_TEXT"]));
}
function extractStandingLevelPlanAndStartText(src) {
  const m = /const STANDING_LEVEL_PLAN_AND_START_TEXT =\s*([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("STANDING_LEVEL_PLAN_AND_START_TEXT not found in hooks/index.ts");
  return record("STANDING_LEVEL_PLAN_AND_START_TEXT", "hooks/index.ts", literalOfTemplateChain(m[1], "STANDING_LEVEL_PLAN_AND_START_TEXT", ["STANDING_OWN_WORK_LEAD_TEXT", "STANDING_NO_TREE_FALLBACK_TEXT"]));
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
//
// This one refuses a split where the three frames above read one, because
// its operands are double-quoted strings and its real second operand is a
// `.map(...).join(...)` call that no chain reader can size. So the anchor is
// the `+ entries.map(` that must follow the one string, and a second string
// spliced in front of it fails the match rather than being dropped from the
// entry. The refusal is tagged so a caller can tell it from a rule whose
// source moved.
function extractMemoryBlock(src) {
  const m = /const memoryBlock =\s*\n\s*"((?:[^"\\]|\\.)*)"\s*\+\s*\n\s*entries\.map\(/.exec(src);
  if (!m) {
    if (/const memoryBlock =/.test(src)) {
      throw new Error("[chain-shape] MEMORY_BLOCK: the memory block is no longer one quoted string followed by `+ entries.map(`; a second literal operand here would be dropped from the entry, so size it explicitly or restore that shape");
    }
    throw new Error("memoryBlock not found in hooks/index.ts");
  }
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
  queueBlock: "GOAL_QUEUE_BLOCK",
  idleBlock: "NO_GOAL_BLOCK",
  standingBlock: "STANDING_BLOCK",
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
  { anchor: "fleetPromptText(", entries: ["FLEET_PROMPT_FRAME", "FLEET_PROMPT_LINE_LITERALS", "FLEET_NOTE_COMPOSED_PROSE"] },
  { anchor: "RECONCILE_TEXT", entries: ["RECONCILE_TEXT"] },
  { anchor: "expectedAnswerTurn", excludedTextVar: "answerText" },
  { anchor: "expectedDeliveryTurn", excludedTextVar: "submittedText" },
  { anchor: "kaizenText", entries: ["KAIZEN_FRAME"] },
  { anchor: "expectedProposalTurn", entries: ["PROPOSE_FRAME"] },
  { anchor: "expectedNudgeTurn", entries: ["NUDGE_TEXT_idle_gap_converted", "NUDGE_TEXT_idle_timeout"] },
  { anchor: "backstopText", entries: ["REPLY_BACKSTOP_FRAME"] },
  { anchor: "shutdownEntry", entries: ["SUPERVISOR_SHUTDOWN_FRAME"] },
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
    // Each of the three positional arguments must be a bare reference. The
    // shape is asserted positively rather than one bad character being
    // screened out, which refuses a literal and every expression form that is
    // not a plain name or member path. It does not refuse a hoisted constant.
    // A name carrying prose and a name carrying data are the same shape, and
    // telling them apart needs the name resolved rather than matched, which
    // is the header's declared bound and not something a further pattern
    // here closes. So the exclusion these three arguments rest on is an
    // assertion this file cannot verify. The answerTo check below refuses a
    // literal on exactly the same terms and with exactly the same reach.
    const positional = textArgs.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
    for (const arg of positional) {
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(arg)) {
        throw new Error(
          `[delivery-exclusion] a deliveryText call in hooks/index.ts passes \`${arg}\` as one of its ground, id or text arguments (deliveryText(${args.trim()})); the exclusion holds only while those three are a bare identifier or member path carrying data, so ledger the literal here or move it into deliveryText`,
        );
      }
    }
    // The options object is excluded on the ground that its values select a
    // prefix deliveryText composes. That is true of `mark`, whose value
    // picks among prefixes written in hooks/operator.ts, and false of
    // `answerTo`, whose value that file splices into the delivered text
    // verbatim. So a literal answerTo is injected text and is refused here.
    const opts = optsIdx === -1 ? "" : args.slice(optsIdx);
    const answerTo = /answerTo\s*:\s*([^,}]+)/.exec(opts);
    if (answerTo && /["'`]/.test(answerTo[1])) {
      throw new Error(
        `[delivery-exclusion] a deliveryText call in hooks/index.ts passes a literal answerTo (${answerTo[1].trim()}); hooks/operator.ts splices that value into the delivered text verbatim, so it is injected text this ledger must size rather than an option selecting a composed prefix`,
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
function buildLedgerFrom(shSrc, holderSrc, tsSrc) {
  const entries = [
    ...extractHolderInstructions(holderSrc),
    ...extractSupervisorAskTexts(shSrc),
    extractReconcileText(tsSrc),
    extractNudgeStatusLineText(tsSrc),
    extractNudgeLeadHoldText(tsSrc),
    extractNudgeCapAskText(tsSrc),
    extractStillWaitingReraise(tsSrc),
    extractFleetPromptFrame(tsSrc),
    extractFleetPromptLineLiterals(tsSrc),
    extractFleetNoteComposedProse(tsSrc),
    extractKaizenFrame(tsSrc),
    extractProposeFrame(tsSrc),
    extractSimpleTextConst(tsSrc, "PROPOSE_FRAME_PLAN_AND_ASK_TEXT"),
    extractSimpleTextConst(tsSrc, "PROPOSE_FRAME_PLAN_AND_START_TEXT"),
    extractSimpleTemplateConst(tsSrc, "PROPOSE_FRAME_ASK_AWAITING_TEXT"),
    extractProposeFrameNoTreeClause(tsSrc),
    extractBackstopFrame(tsSrc),
    extractShutdownFrame(tsSrc),
    extractPlanDocumentLine(tsSrc),
    ...extractNudgeFrames(tsSrc),
    extractGoalTreeBlock(tsSrc),
    extractGoalQueueBlock(tsSrc),
    extractNoGoalBlock(tsSrc),
    extractSimpleTextConst(tsSrc, "STANDING_IDLE_ORDER_TEXT"),
    extractSimpleTextConst(tsSrc, "STANDING_QUEUE_NAME_TEXT"),
    extractSimpleTextConst(tsSrc, "STANDING_OWN_WORK_LEAD_TEXT"),
    extractSimpleTextConst(tsSrc, "STANDING_NO_TREE_FALLBACK_TEXT"),
    extractStandingLevelProposeText(tsSrc),
    extractStandingLevelPlanAndAskText(tsSrc),
    extractStandingLevelPlanAndStartText(tsSrc),
    extractSimpleTextConst(tsSrc, "STANDING_IDLE_DUTIES_TEXT"),
    extractStandingBlock(tsSrc),
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
  return buildLedgerFrom(readNormalized(shPath), readNormalized(holderPath), readNormalized(tsPath));
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
