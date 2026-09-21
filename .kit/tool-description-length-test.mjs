#!/usr/bin/env node
// Tool description length test: every tool hooks/index.ts registers carries a
// top-level description of at most MAX_DESCRIPTION_CHARS characters.
//
// Claude Code refuses a tool description over 4096 characters, and the
// refusal throws out of $.tool.register. Every registration sits inside the
// plugin's session.start hook, so one over-long description skips the whole
// hook: the persona claim, the store load, the heartbeat and every
// registration after the one that threw. The bound here sits under the
// engine's so a description fails this offline check before it can fail a
// live session.
//
// The measured string is the runtime one. Each description is a chain of
// string literals, so the expression between `description:` and
// `inputSchema:` is evaluated as JavaScript and its length read. A
// description that interpolates a name does not evaluate here and fails
// rather than being sized short. .kit/injection-ledger.mjs sizes the same
// registrations for a different question: its figure joins the parameter
// descriptions onto the top-level one, which is what a session's context
// carries and not what the engine's limit reads.
//
// Offline: reads one file, spawns nothing, writes nothing.
//
// Usage: node .kit/tool-description-length-test.mjs
// Exits 0 on success, 1 on failure.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const sourcePath = join(__dirname, "..", "hooks", "index.ts");

const MAX_DESCRIPTION_CHARS = 4000;

let failures = 0;
function ok(msg) { console.log(`  OK: ${msg}`); }
function fail(msg) { failures++; console.log(`  FAIL: ${msg}`); }

// [{ name, chars }] for every $.tool.register({ ... }) block in src. Throws
// where a registration is in a shape this reader cannot measure, so a tool
// never passes by going unread.
function measureDescriptions(src) {
  const calls = src.match(/\$\.tool\.register\(/g) || [];
  const blockRe = /\$\.tool\.register\(\{/g;
  const measured = [];
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    const rest = src.slice(m.index);
    const nameMatch = /name:\s*"([^"]+)"/.exec(rest);
    const descIdx = rest.indexOf("description:");
    const schemaIdx = rest.indexOf("inputSchema:");
    if (!nameMatch || descIdx === -1 || schemaIdx === -1 || !(nameMatch.index < descIdx && descIdx < schemaIdx)) {
      throw new Error(`a $.tool.register block does not read name, description, inputSchema in that order: ${rest.slice(0, 80)}`);
    }
    const expression = rest.slice(descIdx + "description:".length, schemaIdx).trim().replace(/,$/, "");
    let value;
    try {
      value = new Function(`return (${expression}\n);`)();
    } catch (e) {
      throw new Error(`tool ${nameMatch[1]}: the description is not a chain of string literals (${e.message})`);
    }
    if (typeof value !== "string") throw new Error(`tool ${nameMatch[1]}: the description evaluated to a ${typeof value}`);
    measured.push({ name: nameMatch[1], chars: value.length });
  }
  if (measured.length !== calls.length) {
    throw new Error(`${calls.length} $.tool.register call(s) and ${measured.length} measured: a registration is in a shape this test cannot read`);
  }
  if (measured.length === 0) throw new Error("no $.tool.register call found");
  return measured;
}

function registration(name, chars) {
  return `await $.tool.register({\n  name: "${name}",\n  description:\n    "${"a".repeat(chars - 10)}" +\n    "${"b".repeat(10)}",\n  inputSchema: { type: "object", properties: {}, required: [] },\n});\n`;
}

console.log("=== controls: the reader measures a registration it was handed ===");
{
  const at = measureDescriptions(registration("control_at", MAX_DESCRIPTION_CHARS));
  if (at.length === 1 && at[0].chars === MAX_DESCRIPTION_CHARS) ok(`a description split across two literals measures ${at[0].chars}`);
  else fail(`a ${MAX_DESCRIPTION_CHARS}-character description measured ${JSON.stringify(at)}`);

  const over = measureDescriptions(registration("control_at", 10) + registration("control_over", MAX_DESCRIPTION_CHARS + 1));
  if (over.length === 2 && over[1].chars === MAX_DESCRIPTION_CHARS + 1) ok(`a second registration one character over measures ${over[1].chars}`);
  else fail(`a description one character over measured ${JSON.stringify(over)}`);

  let refused = false;
  try { measureDescriptions(registration("control_at", 10) + "await $.tool.register(spec);\n"); } catch { refused = true; }
  if (refused) ok("a registration handed a name instead of an object literal is refused, not skipped");
  else fail("a registration handed a name instead of an object literal went unread");

  refused = false;
  try { measureDescriptions(registration("control_at", 20).replace(`"${"b".repeat(10)}"`, "SHARED_NOTE")); } catch { refused = true; }
  if (refused) ok("a description that splices in a name is refused, not sized short");
  else fail("a description that splices in a name was sized");
}

console.log(`\n=== hooks/index.ts: every registered tool's description is at most ${MAX_DESCRIPTION_CHARS} characters ===`);
try {
  const measured = measureDescriptions(readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n"));
  for (const t of measured) {
    if (t.chars <= MAX_DESCRIPTION_CHARS) ok(`${t.name}: ${t.chars}`);
    else fail(`${t.name}: ${t.chars} characters, ${t.chars - MAX_DESCRIPTION_CHARS} over`);
  }
} catch (e) {
  fail(e.message);
}

console.log(failures === 0 ? "\nAll tests passed" : `\nFAIL: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
