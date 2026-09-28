#!/usr/bin/env node
// label.mjs: labels one question's sample twice, by two independent headless
// Opus runs over the same records in different orders, and prints Cohen's
// kappa between the two.
//
// Usage:
//   node .kit/jev-gold/label.mjs --question <id> [--in <dir>] [--seed <int>]
//
// --in defaults to .kit/jev-gold/out/<question> and must hold sample.jsonl.
// Writes labels-a.jsonl, labels-b.jsonl and kappa.txt there, and prints the
// kappa line and each batch's timing.
//
// Each batch is one `claude -p` child with the question's rubric as its
// system prompt and the batch's records on stdin. The child runs no tool, no
// hook, no MCP server, no slash command, and loads no CLAUDE.md or output
// style. It does read the account's own CLI sign-in and any admin-managed
// settings, which --safe-mode leaves in force. It writes no transcript, so
// nothing it does lands in the folders sample.mjs scans. Its environment is
// this process's, less the vendor key and the parent session's markers.
// A batch whose output does not carry every record id, or carries a label
// outside the rubric's, fails the run naming the batch. A child that outlives
// the timeout is retried once before the run fails naming the batch; a child
// ended any other way fails the run at once, naming how. Nothing is written
// until both labellers have finished, so a failed run is re-run and nothing
// is undone.
//
// JEV_GOLD_LABELLER names a node script to run in place of `claude`, which is
// how the unit suite drives this without a real model. JEV_GOLD_TIMEOUT_MS
// overrides the per-batch timeout for the same suite.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCommand } from "../../bin/upgrade-check.mjs";
import { DEFAULT_SEED, QUESTIONS, rngOf, shuffled } from "./sample.mjs";

export const BATCH_SIZE = 20;
export const TIMEOUT_MS = 300000;
export const KAPPA_FLOOR = 0.8;
// A batch's reply is JSON lines for twenty records, far under this.
const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUBRIC_DIR = path.join(HERE, "rubrics");

// The child's flags past `-p`. The rubric follows --system-prompt. The
// settings key turns off the plugins' hooks and --strict-mcp-config their MCP
// servers. --safe-mode also leaves out the user's and the project's CLAUDE.md
// files and the output style, which reach a child without it and would sit
// beside the rubric; it keeps the CLI's own sign-in, which --bare does not,
// and a --system-prompt given on the command line still applies.
export const CLI_FLAGS = Object.freeze([
  "--model", "opus",
  "--output-format", "json",
  "--tools", "",
  "--settings", JSON.stringify({ disableAllHooks: true }),
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--safe-mode",
]);

// --- The rubric ---

export function rubricText(question) {
  return fs.readFileSync(path.join(RUBRIC_DIR, `${question}.md`), "utf8");
}

// The label ids a rubric offers: each bullet under its `## Labels` heading
// that opens with a backticked id and a colon. The rubric is the one place a
// question's label list is written.
export function rubricLabels(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Labels\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = /^- `([^`]+)`:/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

// --- What a labeller sees ---

// A sample record cut to the fields a labeller reads. Jev's answer, Haiku's
// value and every probability are left out, so neither labeller sees what
// the judges being graded said. The outcome lines are left out too: a later
// section scores its questions against them, and gold labelled from them
// would copy the measure it is read against.
export function labellerView(record) {
  return {
    id: record.id,
    state: record.state,
    opening_prompt: record.transcript.prompt,
    final_message: record.transcript.finalMessage,
    tool_activity: record.transcript.toolActivity,
    next_state: record.hindsight ? record.hindsight.state : null,
  };
}

export function batchPrompt(records) {
  return "Label each record below by the rubric in your instructions. " +
    "Reply with one JSON line per record, in any order, and nothing else.\n\n" +
    records.map((r) => JSON.stringify(labellerView(r))).join("\n") + "\n";
}

// --- The child ---

// The command a batch runs: the stub the environment names, or `claude`
// resolved against PATH the way bin/upgrade-check.mjs resolves it, which
// passes over a .CMD or .BAT shim and never resolves against the working
// directory.
export function labellerCommand(env = process.env) {
  if (env.JEV_GOLD_LABELLER) return { file: process.execPath, args: [env.JEV_GOLD_LABELLER] };
  const claude = resolveCommand("claude", env);
  if (!claude) throw new Error("claude could not be resolved on PATH");
  return claude;
}

// The line a labelling run prints once before its first batch, so a stale
// JEV_GOLD_LABELLER in the environment shows in the output.
export function commandLine(env = process.env) {
  const cmd = labellerCommand(env);
  return `labeller command: ${[cmd.file, ...cmd.args].join(" ")}`;
}

// The variables a labeller child does not inherit: the vendor key the plugin's
// own calls read, and the markers that tell a CLI it runs inside another
// session. The rest of the environment passes through, since the CLI's own
// sign-in reads the profile variables.
export const CHILD_ENV_DROPPED = Object.freeze(["TYPESAFE_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);

export function childEnvOf(env, name) {
  const out = { ...env, JEV_GOLD_LABELLER_NAME: name };
  for (const k of CHILD_ENV_DROPPED) delete out[k];
  return out;
}

function runChild(cmd, args, input, timeoutMs, env) {
  const r = spawnSync(cmd.file, [...cmd.args, ...args], {
    input,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
    maxBuffer: OUTPUT_CAP_BYTES,
  });
  // Only spawnSync's own timeout reads as one. Any other end without an exit
  // status, an output past the buffer (ENOBUFS) or a signal from elsewhere, is
  // named by the caller and never retried.
  const timedOut = r.error?.code === "ETIMEDOUT";
  const killed = !timedOut && (r.error || r.status === null)
    ? [r.error?.code, r.signal ? `signal ${r.signal}` : null, r.error?.message].filter(Boolean).join(", ")
    : "";
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), timedOut, killed };
}

// The labels in a child's reply. The CLI's json output is one object whose
// `result` is the model's text; the text is read line by line, and a line
// that is not a JSON object is passed over, which covers a code fence.
export function parseReply(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch { throw new Error("the reply is not the CLI's JSON envelope"); }
  if (!envelope || envelope.is_error || typeof envelope.result !== "string") {
    throw new Error(`the CLI reported an error: ${String(envelope && (envelope.result || envelope.subtype)).slice(0, 200)}`);
  }
  const out = [];
  for (const line of envelope.result.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { out.push(JSON.parse(t)); } catch { /* not a label line */ }
  }
  return out;
}

// One batch's labels, checked against its records: every id present, no id
// outside the batch, every label one the rubric offers. A failure throws,
// and the caller names the batch.
export function checkBatch(records, labels, allowed) {
  const want = new Set(records.map((r) => r.id));
  const got = new Map();
  for (const l of labels) {
    if (!l || typeof l.id !== "string") continue;
    if (!want.has(l.id)) throw new Error(`the reply names a record outside the batch: ${l.id}`);
    if (!allowed.includes(l.label)) throw new Error(`record ${l.id} carries a label the rubric does not offer: ${String(l.label)}`);
    if (!got.has(l.id)) got.set(l.id, l);
  }
  const missing = records.filter((r) => !got.has(r.id)).map((r) => r.id);
  if (missing.length > 0) throw new Error(`the reply is missing ${missing.length} record(s): ${missing.join(", ")}`);
  return records.map((r) => {
    const l = got.get(r.id);
    return { id: r.id, label: l.label, confidence: l.confidence ?? null, note: l.note ?? null };
  });
}

// Runs one labeller over `records` in the order given, in batches. Returns
// the labels in that order, each carrying its batch number, and the batch
// timings. `name` reaches the child's environment only, so a stub can tell
// the labellers apart; the model never sees it.
export function runLabeller(name, question, records, opts = {}) {
  const env = opts.env || process.env;
  const timeoutMs = Number(env.JEV_GOLD_TIMEOUT_MS) > 0 ? Number(env.JEV_GOLD_TIMEOUT_MS) : TIMEOUT_MS;
  const rubric = rubricText(question);
  const allowed = rubricLabels(rubric);
  const cmd = labellerCommand(env);
  const args = ["-p", ...CLI_FLAGS, "--system-prompt", rubric];
  const childEnv = childEnvOf(env, name);
  const log = opts.log || ((line) => process.stdout.write(line + "\n"));
  const labels = [];
  const timings = [];
  for (let b = 0; b * BATCH_SIZE < records.length; b++) {
    const batch = records.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const where = `labeller ${name} batch ${b + 1} (${batch[0].id}..${batch[batch.length - 1].id})`;
    const input = batchPrompt(batch);
    let run = null;
    const started = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      run = runChild(cmd, args, input, timeoutMs, childEnv);
      if (!run.timedOut) break;
      log(`${where}: timed out after ${timeoutMs} ms on attempt ${attempt}`);
    }
    if (run.timedOut) throw new Error(`${where} timed out twice`);
    if (run.killed) throw new Error(`${where} ended without an exit status: ${run.killed}`);
    if (run.status !== 0) throw new Error(`${where} exited ${run.status}: ${(run.stderr || run.stdout).slice(0, 300)}`);
    let checked;
    try {
      checked = checkBatch(batch, parseReply(run.stdout), allowed);
    } catch (e) {
      throw new Error(`${where}: ${e.message}`);
    }
    const ms = Date.now() - started;
    timings.push({ labeller: name, batch: b + 1, records: batch.length, ms });
    log(`${where}: ${batch.length} records in ${(ms / 1000).toFixed(1)} s`);
    for (const l of checked) labels.push({ ...l, labeller: name, batch: b + 1 });
  }
  return { labels, timings };
}

// --- Kappa ---

// Cohen's kappa between two labellings of the same records, keyed by id.
// Observed agreement is the share of records given the same label; chance
// agreement is the sum over labels of the product of each labeller's share
// of that label. Where chance agreement is 1, both labellers gave one label
// throughout and kappa reads 1.
export function cohensKappa(a, b) {
  const bOf = new Map(b.map((l) => [l.id, l.label]));
  const pairs = a.filter((l) => bOf.has(l.id)).map((l) => [l.label, bOf.get(l.id)]);
  const n = pairs.length;
  if (n === 0) return { kappa: null, n: 0, agree: 0 };
  const agree = pairs.filter(([x, y]) => x === y).length;
  const count = (i) => { const m = new Map(); for (const p of pairs) m.set(p[i], (m.get(p[i]) || 0) + 1); return m; };
  const ca = count(0);
  const cb = count(1);
  let pe = 0;
  for (const [k, v] of ca) pe += (v / n) * ((cb.get(k) || 0) / n);
  const po = agree / n;
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa, n, agree };
}

export function kappaLine(question, k) {
  const figure = k.kappa === null ? "none" : k.kappa.toFixed(3);
  const met = k.kappa !== null && k.kappa >= KAPPA_FLOOR ? "met" : "not met";
  return `kappa: ${question} ${figure} over ${k.n} records, ${k.agree} agree, floor ${KAPPA_FLOOR} ${met}`;
}

// --- Files ---

export function readSample(dir) {
  const file = path.join(dir, "sample.jsonl");
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function writeJsonLines(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

function parseArgs(argv) {
  const flags = { seed: DEFAULT_SEED };
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`bad argument: ${a}`);
    if (a === "--question") flags.question = v;
    else if (a === "--in") flags.in = v;
    else if (a === "--seed") {
      if (!/^\d+$/.test(v)) throw new Error("--seed takes a whole number");
      flags.seed = Number(v);
    } else throw new Error(`unknown flag: ${a}`);
  }
  if (!flags.question || !QUESTIONS[flags.question]) throw new Error(`--question must be one of ${Object.keys(QUESTIONS).join(", ")}`);
  return flags;
}

export function main(argv) {
  const flags = parseArgs(argv);
  const dir = flags.in || path.join(HERE, "out", flags.question);
  const records = readSample(dir);
  // The second labeller's order is a seeded shuffle, drawn from a stream of
  // its own so it does not move with the sampler's draws.
  const orderB = shuffled(records, rngOf(flags.seed ^ 0x9e3779b9));
  process.stdout.write(commandLine() + "\n");
  const a = runLabeller("a", flags.question, records);
  const b = runLabeller("b", flags.question, orderB);
  const order = new Map(records.map((r, i) => [r.id, i]));
  const bySample = (x, y) => order.get(x.id) - order.get(y.id);
  writeJsonLines(path.join(dir, "labels-a.jsonl"), a.labels.slice().sort(bySample));
  writeJsonLines(path.join(dir, "labels-b.jsonl"), b.labels.slice().sort(bySample));
  const line = kappaLine(flags.question, cohensKappa(a.labels, b.labels));
  fs.writeFileSync(path.join(dir, "kappa.txt"), line + "\n");
  process.stdout.write(line + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`label: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  }
}
