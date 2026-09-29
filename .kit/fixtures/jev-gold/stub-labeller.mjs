#!/usr/bin/env node
// A stand-in for `claude -p` that .kit/jev-gold-unit-test.mjs names through
// JEV_GOLD_LABELLER, so the suite drives label.mjs and adjudicate.mjs with no
// model. Every call, the flood case included, reads the batch from stdin
// before it answers. It answers in the CLI's json envelope.
//
// JEV_GOLD_STUB_ANSWERS names a JSON file mapping a record id to its label per
// labeller, as { "<id>": { "a": "...", "b": "...", "c": "..." } }, with "*" as
// the fallback entry. A labeller whose value is null omits that record.
// JEV_GOLD_LABELLER_NAME is the labeller label.mjs is running.
// JEV_GOLD_STUB_LOG, where set, gets one JSON line per call: the argument
// array, the labeller name, which of the variables a labeller child must not
// inherit are present in its environment, and the record ids the call
// received, in the order received.
// JEV_GOLD_STUB_FLOOD, where set, prints past the runner's output buffer.
// JEV_GOLD_STUB_SLEEP_MS delays the reply. With JEV_GOLD_STUB_SLEEP_ONCE set
// to a path, only the call that finds no file there sleeps, and it creates
// the file, so the next call answers at once.
// JEV_GOLD_STUB_OMIT_ONCE, set to a path, limits the null omission: a call
// that finds no file there omits each null record, and creates the file only
// if it omitted one. A call that finds the file answers a null record with
// the "*" entry's label for its labeller.
// JEV_GOLD_STUB_EXTRA_ID, where set, names a record id every call labels with
// the "*" entry's label for its labeller, whether or not the call received it.

import fs from "node:fs";

const name = process.env.JEV_GOLD_LABELLER_NAME || "?";
const input = fs.readFileSync(0, "utf8");
const ids = input.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line).id);
if (process.env.JEV_GOLD_STUB_LOG) {
  const envPresent = ["TYPESAFE_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].filter((k) => k in process.env);
  fs.appendFileSync(process.env.JEV_GOLD_STUB_LOG, JSON.stringify({ name, argv: process.argv.slice(2), envPresent, ids }) + "\n");
}
if (process.env.JEV_GOLD_STUB_FLOOD) {
  const chunk = "x".repeat(1024 * 1024);
  for (let i = 0; i < 17; i++) fs.writeSync(1, chunk);
  process.exit(0);
}
const answers = JSON.parse(fs.readFileSync(process.env.JEV_GOLD_STUB_ANSWERS, "utf8"));
const fallback = (answers["*"] || {})[name];

let sleepMs = Number(process.env.JEV_GOLD_STUB_SLEEP_MS) || 0;
const once = process.env.JEV_GOLD_STUB_SLEEP_ONCE;
if (sleepMs > 0 && once) {
  if (fs.existsSync(once)) sleepMs = 0;
  else fs.writeFileSync(once, "slept\n");
}
if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);

const omitOnce = process.env.JEV_GOLD_STUB_OMIT_ONCE;
const omitNull = !(omitOnce && fs.existsSync(omitOnce));
let omitted = false;

const lines = [];
for (const id of ids) {
  const entry = answers[id] || answers["*"] || {};
  let label = name in entry ? entry[name] : fallback;
  if (label === null && !omitNull) label = fallback;
  if (label === null) omitted = true;
  if (label === null || label === undefined) continue;
  lines.push(JSON.stringify({ id, label, confidence: "high", note: "stub" }));
}
const extra = process.env.JEV_GOLD_STUB_EXTRA_ID;
if (extra && !ids.includes(extra) && fallback !== null && fallback !== undefined) {
  lines.push(JSON.stringify({ id: extra, label: fallback, confidence: "high", note: "stub" }));
}
if (omitOnce && omitted) fs.writeFileSync(omitOnce, "omitted\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + lines.join("\n") + "\n```" }));
