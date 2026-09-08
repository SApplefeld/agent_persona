#!/usr/bin/env node
// Static check: catch the loader rule violation where $ or its nouns are
// bound, passed, or read as values instead of being called as $.noun.verb(...).
//
// Rules checked (against hooks/*.ts):
//   R1: $.store, $.fs, $.ui, $.session, $.tool used as a VALUE (passed, read,
//       bound) rather than as $.noun.verb(...).
//   R2: dp.store or $.store passed as an argument to a function.
//
// This check must be run BEFORE any live suite spawns children. A green unit
// suite over mocks is NOT sufficient: the mocks accept $.store as a value;
// the loader does not.

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
        console.error(`VIOLATION [${rule}] ${rel}:${i + 1}:${col}: "${matched}" — $-noun used as a value, not as $.noun.verb(...)`);
        violations++;
      }
    }
  }
}

// Find all .ts files in hooks/
const files = readdirSync(hooksDir).filter((f) => f.endsWith(".ts"));
for (const f of files) {
  checkFile(join(hooksDir, f));
}

if (violations > 0) {
  console.error(`\nFAIL: ${violations} loader-rule violation(s) found in hooks/*.ts`);
  process.exit(1);
} else {
  console.log("PASS: no loader-rule violations in hooks/*.ts");
  process.exit(0);
}
