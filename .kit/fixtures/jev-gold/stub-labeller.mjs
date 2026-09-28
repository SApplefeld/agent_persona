#!/usr/bin/env node
// A stand-in for `claude -p` that .kit/jev-gold-unit-test.mjs names through
// JEV_GOLD_LABELLER, so the suite drives label.mjs and adjudicate.mjs with no
// model. It reads the batch from stdin and answers in the CLI's json envelope.
//
// JEV_GOLD_STUB_ANSWERS names a JSON file mapping a record id to its label per
// labeller, as { "<id>": { "a": "...", "b": "...", "c": "..." } }, with "*" as
// the fallback entry. A labeller whose value is null omits that record.
// JEV_GOLD_LABELLER_NAME is the labeller label.mjs is running.
// JEV_GOLD_STUB_LOG, where set, gets one JSON line per call: the argument
// array and the labeller name.
// JEV_GOLD_STUB_SLEEP_MS delays the reply. With JEV_GOLD_STUB_SLEEP_ONCE set
// to a path, only the call that finds no file there sleeps, and it creates
// the file, so the next call answers at once.

import fs from "node:fs";

const name = process.env.JEV_GOLD_LABELLER_NAME || "?";
if (process.env.JEV_GOLD_STUB_LOG) {
  fs.appendFileSync(process.env.JEV_GOLD_STUB_LOG, JSON.stringify({ name, argv: process.argv.slice(2) }) + "\n");
}
const input = fs.readFileSync(0, "utf8");
const answers = JSON.parse(fs.readFileSync(process.env.JEV_GOLD_STUB_ANSWERS, "utf8"));

let sleepMs = Number(process.env.JEV_GOLD_STUB_SLEEP_MS) || 0;
const once = process.env.JEV_GOLD_STUB_SLEEP_ONCE;
if (sleepMs > 0 && once) {
  if (fs.existsSync(once)) sleepMs = 0;
  else fs.writeFileSync(once, "slept\n");
}
if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);

const lines = [];
for (const line of input.split("\n")) {
  if (!line.startsWith("{")) continue;
  const { id } = JSON.parse(line);
  const entry = answers[id] || answers["*"] || {};
  const label = name in entry ? entry[name] : (answers["*"] || {})[name];
  if (label === null || label === undefined) continue;
  lines.push(JSON.stringify({ id, label, confidence: "high", note: "stub" }));
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + lines.join("\n") + "\n```" }));
