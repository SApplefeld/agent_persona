#!/usr/bin/env node
// Static check: catch the loader rule violation where $ or its nouns are
// bound, passed, or read as values instead of being called as $.noun.verb(...).
//
// Rules checked (against hooks/*.ts):
//   R1: $.store, $.fs, $.ui, $.session, $.tool used as a VALUE (passed, read,
//       bound) rather than as $.noun.verb(...).
//   R2: dp.store or $.store passed as an argument to a function.
//   R3: a function or const-bound arrow that takes $ or dp as a parameter,
//       declared anywhere other than the top level of the file (a nested
//       declaration, indented inside register() or another function). The
//       loader refuses to call such a function at all - it is not a $-noun
//       misuse R1/R2 can see, since the body may use $ correctly throughout.
//
// This check must be run BEFORE any live suite spawns children. A green unit
// suite over mocks is NOT sufficient: the mocks accept $.store as a value,
// and a mock-driven harness calls a nested helper directly rather than
// through the real loader, so neither catches an R3 violation; the loader
// does not accept $-as-value (R1/R2) and does not accept a nested $-taking
// declaration (R3) regardless of how correctly its body reads $.

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

  // R1: $.noun (where noun is store|fs|ui|session|tool) NOT immediately
  //     followed by .verb(  →  violation.
  //     Pattern: $.(store|fs|ui|session|tool)\b(?!\.?[A-Za-z_$]+\()
  const r1 = /\$\.(store|fs|ui|session|tool)\b(?!\s*[.][A-Za-z_$][A-Za-z0-9_$]*\s*\()/g;
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

// Find all .ts files in hooks/
const files = readdirSync(hooksDir).filter((f) => f.endsWith(".ts"));
for (const f of files) {
  checkFile(join(hooksDir, f));
  checkNestedDollarParam(join(hooksDir, f));
}

if (violations > 0) {
  console.error(`\nFAIL: ${violations} loader-rule violation(s) found in hooks/*.ts`);
  process.exit(1);
} else {
  console.log("PASS: no loader-rule violations in hooks/*.ts");
  process.exit(0);
}
