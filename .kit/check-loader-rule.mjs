#!/usr/bin/env node
// Static check: catch the loader rule violation where $ or its nouns are
// bound, passed, or read as values instead of being called as $.noun.verb(...).
//
// Rules checked (against hooks/*.ts):
//   R1: $.store, $.fs, $.ui, $.session, $.tool, $.env, $.http, $.clock or
//       $.process used as a VALUE (passed, read, bound) rather than as
//       $.noun.verb(...).
//   R2: dp.store or $.store passed as an argument to a function.
//   R3: a function or const-bound arrow that takes $ or dp as a parameter,
//       declared anywhere other than the top level of the file (a nested
//       declaration, indented inside register() or another function). The
//       loader refuses to call such a function at all - it is not a $-noun
//       misuse R1/R2 can see, since the body may use $ correctly throughout.
//   R4: the same event registered twice in one file without a matcher
//       (two `on("<event>", hook)` calls). The loader judges the compiled
//       module statically and refuses the whole file, so a second
//       registration inside a branch that never runs alongside the first
//       is still a refusal: no hook of the module loads, no tool registers,
//       and the session runs with the plugin silently absent.
//   R5: a bare $ or dp passed as an argument to anything that is not a
//       declaration at the top level of the same file: an imported function,
//       a method, a nested helper. The loader follows $ only into a function
//       declared in the file it is reading, never across an import, and
//       refuses the whole module otherwise. The refusal is silent and tsc
//       and every mock suite pass over it. R5 earns its silence with a
//       self-check that runs before the scan: a source holding the exact
//       shape a live launch refused must fire, and the adapter shapes the
//       loader accepts must not.
//
// This check must be run BEFORE any live suite spawns children. A green unit
// suite over mocks is NOT sufficient: the mocks accept $.store as a value,
// and a mock-driven harness calls a nested helper directly rather than
// through the real loader, so neither catches an R3 violation; the loader
// does not accept $-as-value (R1/R2) and does not accept a nested $-taking
// declaration (R3) regardless of how correctly its body reads $. The mock
// `on` also accepts a repeated event, so R4 is likewise invisible to it,
// and a mock host takes $ across any import, so R5 is too.
//
// Exit codes: 0 clean, 1 violations found, 2 the R5 self-check failed.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const hooksDir = join(__dirname, "..", "hooks");

let violations = 0;

function checkFile(path) {
  const src = readFileSync(path, "utf8");
  const lines = src.split("\n");
  const rel = path.replace(/\\/g, "/");

  // R1: $.noun (where noun is one of the engine's nouns) NOT immediately
  //     followed by .verb(  →  violation.
  //     Pattern: $.(store|fs|...)\b(?!\.?[A-Za-z_$]+\()
  const r1 = /\$\.(store|fs|ui|session|tool|env|http|clock|process)\b(?!\s*[.][A-Za-z_$][A-Za-z0-9_$]*\s*\()/g;
  // R2: dp.store or $.store passed as an argument (heuristic: followed by , or ) on the same line,
  //     and NOT part of a $.store.verb( call).
  const r2 = /\b(?:dp|\$)\.store\b(?!\s*[.][A-Za-z_$][A-Za-z0-9_$]*\s*\()/g;

  for (const [rule, re] of [["R1", r1], ["R2", r2]]) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment-only lines (// and JSDoc *)
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
      // Skip the adapter function itself (commonsStoreOf)
      if (line.includes("commonsStoreOf")) continue;
      // Skip type-only lines
      if (line.includes(": CommonsStore") || line.includes("import type")) continue;

      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const col = m.index + 1;
        const matched = m[0];
        console.error(`VIOLATION [${rule}] ${rel}:${i + 1}:${col}: "${matched}" - $-noun used as a value, not as $.noun.verb(...)`);
        violations++;
      }
    }
  }
}

// R3: a `function NAME(...)` or `const NAME = (...) => ` / `const NAME =
// async (...) => ` declaration whose own parameter list names `$` or `dp`,
// found at a nonzero indentation (not column 0, so not a top-level
// declaration). Matches the exact shape 754a9fa shipped:
//   const writeOwnerHeartbeat = async ($: any): Promise<void> => { ... }
// declared inside register(), which the loader refused to call.
function checkNestedDollarParam(path) {
  const src = readFileSync(path, "utf8");
  const lines = src.split("\n");
  const rel = path.replace(/\\/g, "/");

  const constDecl = /^(\s+)const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::[^=]+)?=>/;
  const fnDecl = /^(\s+)(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

    const m = constDecl.exec(line) || fnDecl.exec(line);
    if (!m) continue;
    const [, indent, name, params] = m;
    if (indent.length === 0) continue; // top-level: exactly what the loader allows.

    const takesDollarOrDp = /(^|[,(]\s*)(\$|dp)\s*:/.test(params) || /(^|[,(]\s*)(\$|dp)\s*(,|\)|$)/.test(params);
    if (!takesDollarOrDp) continue;

    console.error(
      `VIOLATION [R3] ${rel}:${i + 1}: "${name}" takes ${params.trim()} but is declared at ` +
        `column ${indent.length + 1}, not the top of the file - the loader refuses to call a ` +
        `nested function or const that $/dp is passed to.`,
    );
    violations++;
  }
}

// R4: `on("<pattern>", hook)` registered more than once in one file with no
// matcher between the pattern and the hook. The pattern is a double- or
// single-quoted string containing neither quote (an event name, a glob
// such as `session.*` or `*`, a negation); a template literal is not read.
// The matcher form is `on("<pattern>", matcher, hook)`, and the heuristic
// for it is a second argument that opens an object literal `{`; a matcher
// held in a variable reads as a hook and counts, which errs toward a
// violation rather than a silence. Anything else after the comma is the
// no-matcher form: a function literal, an identifier, on the same line or
// the next. The call must start its line (`on(` after indentation), so
// `proc.on("exit", ...)` on an EventEmitter is not read as a hook
// registration; a call that does not start its line (`return on(...)`,
// `const r = on(...)`) is not scanned.
function checkDuplicateRegistration(path) {
  const src = readFileSync(path, "utf8");
  const rel = path.replace(/\\/g, "/");

  const registration = /^[ \t]*on\(\s*(["'])([^"'\n]+)\1\s*,\s*([^\s])/gm;
  const seen = new Map();
  let m;
  while ((m = registration.exec(src)) !== null) {
    const [, , event, secondArgStart] = m;
    if (secondArgStart === "{") continue; // matcher form
    const lineNo = src.slice(0, m.index).split("\n").length;
    const first = seen.get(event);
    if (first === undefined) {
      seen.set(event, lineNo);
      continue;
    }
    console.error(
      `VIOLATION [R4] ${rel}:${lineNo}: on("${event}") is registered without a matcher a second time; ` +
        `the first is at line ${first} - the loader refuses the whole module for a repeated event.`,
    );
    violations++;
  }
}

// R5: a bare `$` or `dp` in argument position of a call whose callee is not
// a top-level declaration of the same file. Matches the exact shape a live
// launch refused, `await runSeamProbe($)` with runSeamProbe imported from
// another file, which R1 to R4 cannot see: `$` is not followed by a noun,
// the callee is declared nowhere in the file, and nothing is registered
// twice.
//
// A top-level declaration is `function NAME(` or `const NAME = (...) =>` at
// column 0, with `export` and `async` allowed. Both are accepted because
// both load: commonsStoreOf is the former and persistOrRollBack, which `$`
// is passed to, is the latter. A parameter list (`async ($, e, next) =>`)
// is not a call, since its opener is preceded by a keyword or by nothing
// rather than by a name. A method call (`x.y($)`) reads as a violation even
// where a top-level function shares the method's name, which errs toward a
// violation rather than a silence.
//
// Comments are blanked to spaces of the same length before the scan, so a
// `$` in prose is not read and every index still points at the original
// text. A `//` is a comment only at line start or after whitespace, so a
// URL inside a string keeps its line.
const KEYWORDS = new Set([
  "async", "function", "if", "for", "while", "switch", "catch", "return", "await", "typeof",
  "else", "do", "yield", "void", "delete", "new", "in", "of", "instanceof", "throw", "case",
]);

function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[ \t])\/\/[^\n]*/gm, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

function topLevelNamesOf(src) {
  const names = new Set();
  const decl = /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(|const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\()/gm;
  let m;
  while ((m = decl.exec(src)) !== null) names.add(m[1] || m[2]);
  return names;
}

// Returns the violations found as `{ lineNo, arg, callee }`, printing nothing,
// so the self-check can read the rule's output and the scan can report it.
function dollarPassedAcrossFile(src) {
  const clean = blankComments(src);
  const topLevel = topLevelNamesOf(clean);
  const found = [];
  const arg = /(?<![A-Za-z0-9_$.])(\$|dp)(?![A-Za-z0-9_$])\s*[,)]/g;
  let m;
  while ((m = arg.exec(clean)) !== null) {
    // In argument position: preceded, ignoring whitespace, by `(` or `,`.
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(clean[j])) j--;
    if (j < 0 || (clean[j] !== "(" && clean[j] !== ",")) continue;
    // Walk back to the unmatched opener of the argument list.
    let depth = 0;
    let k = m.index - 1;
    for (; k >= 0; k--) {
      const c = clean[k];
      if (c === ")") depth++;
      else if (c === "(") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (k < 0) continue;
    const before = clean.slice(0, k).replace(/\s+$/, "");
    const callee = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(before);
    if (!callee) continue; // a parameter list or a grouping, not a call
    const name = callee[1];
    if (KEYWORDS.has(name)) continue; // `async ($, e, next) =>`, `if (dp)`
    const isMethod = before[before.length - name.length - 1] === ".";
    if (!isMethod && topLevel.has(name)) continue;
    const lineNo = clean.slice(0, m.index).split("\n").length;
    found.push({ lineNo, arg: m[1], callee: name });
  }
  return found;
}

function checkDollarPassedAcrossFile(path) {
  const src = readFileSync(path, "utf8");
  const rel = path.replace(/\\/g, "/");
  for (const { lineNo, arg, callee } of dollarPassedAcrossFile(src)) {
    console.error(
      `VIOLATION [R5] ${rel}:${lineNo}: "${arg}" is passed to "${callee}", which is not a function or ` +
        `const arrow declared at the top level of this file - the loader follows $ only into a ` +
        `same-file top-level declaration and refuses the whole module otherwise.`,
    );
    violations++;
  }
}

// The R5 self-check. The positive fixture holds the refused shape under a
// name the rule never spells, so it matches on shape alone; the control
// holds every accepted shape the tree uses: the commonsStoreOf and hostOf
// adapters, a column-0 const arrow, a top-level function declared after its
// call, a multi-line call, and a hook's own parameter list.
const R5_MUST_FIRE = `import { frobnicateEngine } from "./frobnicate";
export function register(on: any) {
  on("session.start", async ($: any, e: any, next: any) => {
    await frobnicateEngine($);
    await next();
  });
}
`;
const R5_MUST_NOT_FIRE = `import type { CommonsStore } from "./commons";
import type { PluginHost } from "./host";
function commonsStoreOf(dp: any): CommonsStore {
  return { get: (k: string) => dp.store.get(k) }; // full dp.store.verb(...) call, see https://example.invalid/loader
}
function hostOf(dp: any): PluginHost {
  return { getApiKey: () => dp.env.get("TYPESAFE_API_KEY"), sleep: (ms: number) => dp.clock.sleep(ms) };
}
const persistOrRollBack = async (dp: any, rollBack: () => void): Promise<boolean> => { return true; };
/** Passing $ to a helper declared in another file is refused: helper($). */
export function register(on: any) {
  on("turn.start", async ($: any, e: any, next: any) => {
    const store = commonsStoreOf($);
    if (!await persistOrRollBack($, () => {})) return;
    await tickOpenAsk(
      $,
      store,
    );
    await (commonsStoreOf($)).set("k", 1);
    await next();
  });
}
async function tickOpenAsk(dp: any, store: any): Promise<void> {}
`;

function selfCheckR5() {
  const fired = dollarPassedAcrossFile(R5_MUST_FIRE);
  const quiet = dollarPassedAcrossFile(R5_MUST_NOT_FIRE);
  const firedRight = fired.length === 1 && fired[0].lineNo === 4 && fired[0].arg === "$" && fired[0].callee === "frobnicateEngine";
  if (!firedRight) {
    console.error(`SELF-CHECK FAILED: R5 did not fire once at line 4 on the refused shape; found ${JSON.stringify(fired)}`);
    return false;
  }
  if (quiet.length !== 0) {
    console.error(`SELF-CHECK FAILED: R5 fired on the accepted adapter shapes; found ${JSON.stringify(quiet)}`);
    return false;
  }
  return true;
}

if (!selfCheckR5()) {
  process.exit(2);
}

// Find all .ts files in hooks/
const files = readdirSync(hooksDir).filter((f) => f.endsWith(".ts"));
for (const f of files) {
  checkFile(join(hooksDir, f));
  checkNestedDollarParam(join(hooksDir, f));
  checkDuplicateRegistration(join(hooksDir, f));
  checkDollarPassedAcrossFile(join(hooksDir, f));
}

if (violations > 0) {
  console.error(`\nFAIL: ${violations} loader-rule violation(s) found in hooks/*.ts`);
  process.exit(1);
} else {
  console.log("PASS: no loader-rule violations in hooks/*.ts");
  process.exit(0);
}
