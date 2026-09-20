#!/usr/bin/env node
// Decision journal unit tests: the line shapes, the path, the write chain that
// keeps two concurrent writes from losing one, the never-throws rule, the
// once-a-day failure latch, the stamp ids and their split.
//
// Drives hooks/decision-journal.ts through a fake JournalHost built here: a
// Map-backed filesystem whose read and write each yield to the event loop, so
// two appends started together really can interleave. A host that cannot
// interleave would pass the concurrency case whatever the module did.
//
// Each case imports its own module instance, since the counter, the failure
// latch, the write chains and the state dedup are all module state.
//
// Usage: node decision-journal-unit-test.mjs
// Exits 0 on success, 1 on failure.

import { stubDateNow } from "./tick-harness.mjs";

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name, detail) {
  console.error(`  FAIL: ${name}`);
  if (detail !== undefined) console.error(`        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  failed++;
}
function check(name, cond, detail) { if (cond) ok(name); else fail(name, detail); }

// An unhandled rejection anywhere here is the never-throws contract breaking
// somewhere a resolved false hid it.
const unhandled = [];
process.on("unhandledRejection", (reason) => { unhandled.push(reason); });

const HOME = "D:/home/operator";
const PERSONA = "steward";
const SESSION = "harness-session";
// 2023-11-14T22:13:20.000Z, so the UTC day is 2023-11-14.
const T0 = 1_700_000_000_000;
const DAY = "2023-11-14";
const PATH = `${HOME}/.claude/agentic-decisions/${PERSONA}/${DAY}-${SESSION}.jsonl`;

let caseCounter = 0;
async function freshModule() {
  caseCounter += 1;
  return import(`../hooks/decision-journal.ts?case=${caseCounter}`);
}

// The fake host. Every member yields before it answers, which is what lets two
// appends interleave; `calls` records what was asked for.
function makeHost(overrides = {}) {
  const files = new Map();
  const calls = [];
  const host = {
    async getHome() {
      calls.push(["getHome"]);
      await null;
      if (overrides.home instanceof Error) throw overrides.home;
      return "home" in overrides ? overrides.home : HOME;
    },
    async fileExists(path) {
      calls.push(["fileExists", path]);
      await null;
      if (overrides.existsThrows) throw new Error("exists refused");
      // A hook above the caller may answer this op event with a value of its
      // own, so the suite can hand back something that is not a boolean.
      if ("existsReturns" in overrides) return overrides.existsReturns;
      return files.has(path);
    },
    async readFile(path) {
      calls.push(["readFile", path]);
      await null;
      if (overrides.readThrows) throw new Error("read refused");
      if (overrides.readReturns !== undefined) return overrides.readReturns;
      if (!files.has(path)) throw new Error("no such file");
      return files.get(path);
    },
    async writeFile(path, text) {
      calls.push(["writeFile", path]);
      await null;
      if (overrides.writeThrows) throw new Error("write refused");
      files.set(path, text);
    },
  };
  return { host, files, calls };
}

function okResult(extra = {}) {
  return {
    ok: true,
    questionSetId: "controller-decision",
    questionId: "controller-decision",
    questionVersion: "v1",
    overrideRefused: null,
    primitive: "choice",
    answer: { type: "choice", choice: "nudge", probabilities: { nudge: 0.8, pause: 0.2 }, confidence: 0.7 },
    usage: { input_tokens: 296, output_tokens: 4 },
    latencyMs: 412,
    model: "jev-latest",
    haikuValue: "nudge",
    // The state as the seam scrubbed and sent it. The journal reads it here
    // rather than from a field of its own, so a case that drives a different
    // state drives it through the result.
    state: "worker idle 3 ticks",
    ...extra,
  };
}

function failureResult(extra = {}) {
  return {
    ok: false,
    reason: "no_key",
    detail: null,
    questionSetId: "controller-decision",
    questionId: null,
    questionVersion: null,
    overrideRefused: null,
    latencyMs: null,
    haikuValue: "nudge",
    // A no_key failure, which is one of the two that read no key and so carry
    // no state at all.
    state: null,
    ...extra,
  };
}

function callRecord(J, extra = {}) {
  return {
    stampId: "steward.harness-session.1700000000000.1",
    persona: PERSONA,
    session: SESSION,
    site: "controller",
    questionSet: "controller-decision",
    mode: "shadow",
    result: okResult(),
    ...extra,
  };
}

function linesOf(files, path = PATH) {
  const text = files.get(path);
  if (text === undefined) return [];
  return text.split("\n").slice(0, -1).map((l) => JSON.parse(l));
}

const clock = stubDateNow();
try {
  // --- The path ---
  {
    console.log("\n=== The journal path ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    const r = await J.writeCall(host, callRecord(J));
    check("path: the write landed", r.ok === true && r.firstFailureToday === false, r);
    check("path: the file is <home>/.claude/agentic-decisions/<persona>/<UTC day>-<session>.jsonl",
      [...files.keys()].length === 1 && files.has(PATH), [...files.keys()]);

    // The UTC day rather than the local one: 23:30 UTC on the 14th is the 15th
    // in some zones and this file must still be the 14th's.
    clock.set(Date.UTC(2023, 10, 14, 23, 30, 0));
    await J.writeCall(host, callRecord(J, { result: okResult({ state: "later that day" }) }));
    check("path: a write at 23:30 UTC lands on the same UTC day's file",
      [...files.keys()].length === 1 && files.has(PATH), [...files.keys()]);
    clock.set(Date.UTC(2023, 10, 15, 0, 30, 0));
    await J.writeCall(host, callRecord(J, { result: okResult({ state: "just past midnight" }) }));
    check("path: a write past UTC midnight lands on the next day's file",
      files.has(`${HOME}/.claude/agentic-decisions/${PERSONA}/2023-11-15-${SESSION}.jsonl`), [...files.keys()]);
  }

  // --- The path's two caller-supplied segments ---
  {
    console.log("\n=== The path's segments are sanitized ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    // A persona name and a session id are the caller's strings and are the
    // only parts of this path that come from outside. Neither may carry a
    // separator or a parent traversal into it.
    await J.writeCall(host, callRecord(J, { persona: "../../etc", session: "a/b\\c:d" }));
    const written = [...files.keys()][0];
    check("segments: the path is the sanitized one, character for character",
      written === `${HOME}/.claude/agentic-decisions/______etc/${DAY}-a_b_c_d.jsonl`, written);
    check("segments: no parent traversal survives", !written.includes(".."), written);

    // The control the case above needs: the same unsanitized text does reach a
    // path when nothing sanitizes it, so the assertion is the guard's doing.
    const naive = `${HOME}/.claude/agentic-decisions/${"../../etc"}/${DAY}-${"a/b\\c:d"}.jsonl`;
    check("segments control: the unsanitized join does carry the traversal",
      naive.includes("../..") && naive !== written, naive);

    // The 64-character cut, on a session id longer than it.
    const long = "s".repeat(80);
    await J.writeCall(host, callRecord(J, { session: long }));
    check("segments: a session id past 64 characters is cut to 64",
      files.has(`${HOME}/.claude/agentic-decisions/${PERSONA}/${DAY}-${"s".repeat(64)}.jsonl`), [...files.keys()]);

    // A value that sanitizes away entirely still has to be a segment.
    await J.writeCall(host, callRecord(J, { persona: "///" }));
    check("segments: a persona that sanitizes away becomes one underscore",
      files.has(`${HOME}/.claude/agentic-decisions/___/${DAY}-${SESSION}.jsonl`), [...files.keys()]);
  }

  // --- The call line ---
  {
    console.log("\n=== The call line's shape ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    await J.writeCall(host, callRecord(J));
    const [line] = linesOf(files);
    const expectedFields = ["lineKind", "stampId", "at", "persona", "session", "site", "questionSet", "mode", "split", "stateHash", "state", "stateRef", "inputTokens", "latencyMs", "result", "detail"];
    check("call line: every field of the shape is present and no other",
      JSON.stringify(Object.keys(line).sort()) === JSON.stringify([...expectedFields].sort()), Object.keys(line));
    check("call line: it names itself a call", line.lineKind === "call", line);
    check("call line: at is the ISO instant of the write", line.at === new Date(T0).toISOString(), line.at);
    check("call line: a successful call records ok", line.result === "ok" && line.detail === null, line);
    check("call line: the usage count and the latency ride it", line.inputTokens === 296 && line.latencyMs === 412, line);
    check("call line: the state rides the first call for a site", line.state === "worker idle 3 ticks" && line.stateRef === null, line);
    check("call line: the state hash is a number", typeof line.stateHash === "number", line);
    check("call line: the split is the stamp id's own", line.split === J.splitOf(line.stampId), line);

    // A call that made no request carries no count and no latency, and names
    // the reason it ended.
    const { host: h2, files: f2 } = makeHost();
    await J.writeCall(h2, callRecord(J, { result: failureResult(), stampId: "steward.harness-session.1700000000000.2" }));
    const [failLine] = linesOf(f2);
    check("call line: a call that made no request carries null token count and null latency",
      failLine.inputTokens === null && failLine.latencyMs === null, failLine);
    check("call line: and it records the seam's own reason", failLine.result === "no_key", failLine);
    check("call line: every field is still present on it",
      JSON.stringify(Object.keys(failLine).sort()) === JSON.stringify([...expectedFields].sort()), Object.keys(failLine));
  }

  // --- The state dedup ---
  {
    console.log("\n=== The state rides once per site until it changes ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    await J.writeCall(host, callRecord(J, { stampId: "a.b.1.1" }));
    await J.writeCall(host, callRecord(J, { stampId: "a.b.1.2" }));
    await J.writeCall(host, callRecord(J, { stampId: "a.b.1.3", result: okResult({ state: "worker idle 4 ticks" }) }));
    await J.writeCall(host, callRecord(J, { stampId: "a.b.1.4", site: "scorer" }));
    const lines = linesOf(files);
    check("state dedup: the first call carries the state", lines[0].state === "worker idle 3 ticks" && lines[0].stateRef === null, lines[0]);
    check("state dedup: the second call on the same state points at the first",
      lines[1].state === null && lines[1].stateRef === "a.b.1.1", lines[1]);
    check("state dedup: the two lines agree on the hash", lines[0].stateHash === lines[1].stateHash, lines.map((l) => l.stateHash));
    check("state dedup: a changed state rides again", lines[2].state === "worker idle 4 ticks" && lines[2].stateRef === null, lines[2]);
    check("state dedup: another site carries its own first state",
      lines[3].state === "worker idle 3 ticks" && lines[3].stateRef === null, lines[3]);
  }

  // --- The answer line ---
  {
    console.log("\n=== The answer line's shape ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    const answer = {
      callStampId: "a.b.1.1",
      questionId: "controller-decision",
      questionVersion: "v1",
      overrideRefused: null,
      value: "nudge",
      probabilities: { nudge: 0.8, pause: 0.2 },
      confidence: 0.7,
      haikuValue: "nudge",
    };
    const r = await J.writeAnswers(host, { persona: PERSONA, session: SESSION, answers: [answer] });
    check("answer line: the write landed", r.ok === true, r);
    const [line] = linesOf(files);
    const expectedFields = ["lineKind", "stampId", "callStampId", "questionId", "questionVersion", "overrideRefused", "primitive", "value", "probabilities", "confidence", "haikuValue", "agrees"];
    check("answer line: every field of the shape is present and no other",
      JSON.stringify(Object.keys(line).sort()) === JSON.stringify([...expectedFields].sort()), Object.keys(line));
    check("answer line: it carries a stamp id of its own and the call's to join on",
      typeof line.stampId === "string" && line.stampId !== line.callStampId && line.callStampId === "a.b.1.1", line);
    check("answer line: an exact option-id match is agreement", line.agrees === true, line);
    check("answer line: the probabilities ride whole", line.probabilities.nudge === 0.8 && line.probabilities.pause === 0.2, line.probabilities);

    const { host: h2, files: f2 } = makeHost();
    await J.writeAnswers(h2, { persona: PERSONA, session: SESSION, answers: [{ ...answer, value: "pause" }] });
    check("answer line: a different option id is disagreement", linesOf(f2)[0].agrees === false, linesOf(f2)[0]);

    const { host: h3, files: f3 } = makeHost();
    await J.writeAnswers(h3, { persona: PERSONA, session: SESSION, answers: [{ ...answer, haikuValue: null }] });
    check("answer line: no Haiku value is no agreement record rather than a false one",
      linesOf(f3)[0].agrees === null && linesOf(f3)[0].haikuValue === null, linesOf(f3)[0]);

    const { host: h4, files: f4 } = makeHost();
    const many = await J.writeAnswers(h4, { persona: PERSONA, session: SESSION, answers: [answer, { ...answer, value: "pause" }] });
    check("answer line: two answers write two lines with two stamp ids",
      many.ok === true && linesOf(f4).length === 2 && linesOf(f4)[0].stampId !== linesOf(f4)[1].stampId, linesOf(f4));

    const { host: h5, files: f5 } = makeHost();
    const none = await J.writeAnswers(h5, { persona: PERSONA, session: SESSION, answers: [] });
    check("answer line: a call with no answer writes nothing and reports a landed write",
      none.ok === true && none.firstFailureToday === false && f5.size === 0, { none, keys: [...f5.keys()] });
  }

  // --- The probabilities map is prototype-free ---
  {
    console.log("\n=== The probabilities map is built prototype-free ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    // A response body reaches this map through JSON.parse, which makes
    // __proto__ an own property. An ordinary object literal would swallow it
    // and a null value there would rewire the map, so what the journal records
    // would differ from what the seam validated.
    const hostile = JSON.parse('{"nudge":0.5,"__proto__":0.5}');
    await J.writeAnswers(host, {
      persona: PERSONA,
      session: SESSION,
      answers: [{
        callStampId: "a.b.1.1",
        questionId: "q",
        questionVersion: "v1",
        overrideRefused: null,
        value: "nudge",
        probabilities: hostile,
        confidence: 0.5,
        haikuValue: "nudge",
      }],
    });
    const text = files.get(PATH);
    check("prototype-free: the __proto__ probability is written rather than swallowed",
      text.includes('"__proto__":0.5'), text);
    const parsed = JSON.parse(text.trim());
    check("prototype-free: and both probabilities are there",
      Object.keys(parsed.probabilities).length === 2 && parsed.probabilities.nudge === 0.5, parsed.probabilities);

    // The withheld control: the same value through an ordinary literal loses
    // it, matched on the shape rather than on a string this case was handed.
    const naive = {};
    for (const [k, v] of Object.entries(hostile)) naive[k] = v;
    check("prototype-free control: an ordinary literal does swallow that key",
      !JSON.stringify(naive).includes("__proto__"), JSON.stringify(naive));
  }

  // --- The outcome line ---
  {
    console.log("\n=== The outcome line's shape and its closed kinds ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    const r = await J.writeOutcome(host, { persona: PERSONA, session: SESSION, callStampId: "a.b.1.1", kind: "next_score", value: "on-goal" });
    check("outcome line: the write landed", r.ok === true, r);
    const [line] = linesOf(files);
    const expectedFields = ["lineKind", "stampId", "callStampId", "kind", "value", "at"];
    check("outcome line: every field of the shape is present and no other",
      JSON.stringify(Object.keys(line).sort()) === JSON.stringify([...expectedFields].sort()), Object.keys(line));
    check("outcome line: the kind is the outcome's own, and the line names itself separately",
      line.kind === "next_score" && line.lineKind === "outcome", line);
    check("outcome line: the two kinds are the closed set",
      JSON.stringify(J.OUTCOME_KINDS) === JSON.stringify(["next_score", "ask_marker"]), J.OUTCOME_KINDS);

    const { host: h2, files: f2 } = makeHost();
    const bad = await J.writeOutcome(h2, { persona: PERSONA, session: SESSION, callStampId: "a.b.1.1", kind: "something_else", value: "x" });
    check("outcome line: a kind outside the set writes nothing and resolves false",
      bad.ok === false && f2.size === 0, { bad, keys: [...f2.keys()] });
  }

  // --- The bytes ---
  {
    console.log("\n=== The file's byte layout ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    await J.writeCall(host, callRecord(J, { stampId: "a.b.1.1" }));
    await J.writeCall(host, callRecord(J, { stampId: "a.b.1.2" }));
    const text = files.get(PATH);
    check("bytes: exactly one terminating newline", text.endsWith("\n") && !text.endsWith("\n\n"), text.slice(-40));
    check("bytes: no blank line between records", !text.includes("\n\n"), text.slice(0, 80));
    check("bytes: two lines, each one parseable JSON object", text.split("\n").slice(0, -1).length === 2, text.split("\n").length);

    // A file that does not end in a newline takes a separator, the way the
    // plugin's own logs do: a hand-edited file must not join two records.
    const { host: h2, files: f2 } = makeHost();
    f2.set(PATH, '{"lineKind":"call"}');
    await J.writeCall(h2, callRecord(J, { stampId: "a.b.1.3" }));
    const text2 = f2.get(PATH);
    check("bytes: an unterminated file takes exactly one separator",
      text2.startsWith('{"lineKind":"call"}\n{') && !text2.includes("\n\n"), text2.slice(0, 60));
  }

  // --- Two writes started together ---
  {
    console.log("\n=== Two writes started together both land ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    // Started together and settled together. The append reads the whole file
    // and rewrites it, so without a chain the second read would predate the
    // first write and one line would be lost.
    const results = await Promise.all([
      J.writeCall(host, callRecord(J, { stampId: "a.b.1.1" })),
      J.writeCall(host, callRecord(J, { stampId: "a.b.1.2" })),
    ]);
    check("concurrent: both writes report landed", results.every((r) => r.ok === true), results);
    const lines = linesOf(files);
    check("concurrent: both lines are in the file", lines.length === 2, lines.length);
    check("concurrent: and they are the two that were written",
      lines.map((l) => l.stampId).sort().join(",") === "a.b.1.1,a.b.1.2", lines.map((l) => l.stampId));

    // Four at once, mixing the three writers, all on the one path.
    const { host: h2, files: f2 } = makeHost();
    const mixed = await Promise.all([
      J.writeCall(h2, callRecord(J, { stampId: "c.d.1.1" })),
      J.writeAnswers(h2, { persona: PERSONA, session: SESSION, answers: [{ callStampId: "c.d.1.1", questionId: "q", questionVersion: "v1", overrideRefused: null, value: "nudge", probabilities: {}, confidence: 1, haikuValue: "nudge" }] }),
      J.writeOutcome(h2, { persona: PERSONA, session: SESSION, callStampId: "c.d.1.1", kind: "next_score", value: "on-goal" }),
      J.writeCall(h2, callRecord(J, { stampId: "c.d.1.2" })),
    ]);
    check("concurrent: four writers started together all report landed", mixed.every((r) => r.ok === true), mixed);
    check("concurrent: and all four lines are in the file", linesOf(f2).length === 4, linesOf(f2).length);
  }

  // --- Never throws, and the failure latch ---
  {
    console.log("\n=== A failed write resolves false and never throws ===");
    const J = await freshModule();
    clock.set(T0);
    const record = callRecord(J);
    const hostile = [
      ["a host that cannot name a home directory", makeHost({ home: undefined }).host],
      ["a home directory that is not a string", makeHost({ home: 42 }).host],
      ["a home lookup that rejects", makeHost({ home: new Error("env refused") }).host],
      ["an existence check that rejects", makeHost({ existsThrows: true }).host],
      ["a write that rejects", makeHost({ writeThrows: true }).host],
    ];
    for (const [label, host] of hostile) {
      let threw = null;
      let value = null;
      try {
        value = await J.writeCall(host, record);
      } catch (err) {
        threw = err;
      }
      check(`never throws: ${label} resolves false rather than throwing`,
        threw === null && value !== null && value.ok === false, { threw: String(threw), value });
    }

    // A file that exists and reads as something other than text is left as it
    // is: a rewrite built on that read would replace the day's lines with one.
    const { host: badRead, files: badFiles } = makeHost({ readReturns: { not: "text" } });
    badFiles.set(PATH, '{"lineKind":"call"}\n');
    const readResult = await J.writeCall(badRead, record);
    check("never throws: an unreadable existing file resolves false and is not rewritten",
      readResult.ok === false && badFiles.get(PATH) === '{"lineKind":"call"}\n', { readResult, text: badFiles.get(PATH) });

    // The three writers share the rule.
    const { host: h2 } = makeHost({ writeThrows: true });
    const a = await J.writeAnswers(h2, { persona: PERSONA, session: SESSION, answers: [{ callStampId: "x", questionId: "q", questionVersion: "v1", overrideRefused: null, value: "v", probabilities: {}, confidence: 1, haikuValue: "v" }] });
    const o = await J.writeOutcome(h2, { persona: PERSONA, session: SESSION, callStampId: "x", kind: "ask_marker", value: "ASK: something" });
    check("never throws: writeAnswers resolves false on a refused write", a.ok === false, a);
    check("never throws: writeOutcome resolves false on a refused write", o.ok === false, o);
  }

  // --- The once-a-day latch ---
  {
    console.log("\n=== The failure latch fires once per UTC day ===");
    const J = await freshModule();
    clock.set(T0);
    const { host } = makeHost({ writeThrows: true });
    const record = callRecord(J);
    const first = await J.writeCall(host, record);
    const second = await J.writeCall(host, record);
    check("latch: the first failed write of the day is flagged",
      first.ok === false && first.firstFailureToday === true, first);
    check("latch: the second is not", second.ok === false && second.firstFailureToday === false, second);

    // A write that lands never carries the flag.
    const { host: good } = makeHost();
    const landed = await J.writeCall(good, record);
    check("latch: a write that lands is never flagged", landed.ok === true && landed.firstFailureToday === false, landed);

    // Later the same UTC day, still not flagged.
    clock.set(Date.UTC(2023, 10, 14, 23, 59, 0));
    const laterSameDay = await J.writeCall(host, record);
    check("latch: a failure later the same UTC day is not flagged", laterSameDay.firstFailureToday === false, laterSameDay);

    // The next UTC day flags again.
    clock.set(Date.UTC(2023, 10, 15, 0, 1, 0));
    const nextDay = await J.writeCall(host, record);
    check("latch: the first failure of the next UTC day is flagged", nextDay.firstFailureToday === true, nextDay);
  }

  // --- Stamp ids ---
  {
    console.log("\n=== Stamp ids and their split ===");
    const J = await freshModule();
    clock.set(T0);
    const a = J.newStampId(PERSONA, SESSION);
    const b = J.newStampId(PERSONA, SESSION);
    check("stamp id: two ids minted in the same millisecond differ", a !== b, [a, b]);
    check("stamp id: the form is persona.session.epochMs.counter",
      a === `${PERSONA}.${SESSION}.${T0}.1` && b === `${PERSONA}.${SESSION}.${T0}.2`, [a, b]);
    check("stamp id: it splits into exactly four parts", a.split(".").length === 4, a);
    check("stamp id: a persona carrying a dot cannot add a fifth part",
      J.newStampId("a.b", "c.d").split(".").length === 4, J.newStampId("a.b", "c.d"));

    // The counter is never reset, including across a UTC day boundary.
    clock.set(Date.UTC(2023, 10, 15, 0, 1, 0));
    check("stamp id: the counter carries across a day boundary",
      J.newStampId(PERSONA, SESSION).endsWith(".5"), J.newStampId(PERSONA, SESSION));

    // The split is a function of the id alone, so it never changes.
    const ids = [];
    clock.set(T0);
    for (let i = 0; i < 10_000; i++) ids.push(J.newStampId(PERSONA, SESSION));
    const splits = ids.map((id) => J.splitOf(id));
    check("split: every split is one of the two values",
      splits.every((s) => s === "holdout" || s === "dev"), [...new Set(splits)]);
    const holdout = splits.filter((s) => s === "holdout").length;
    check(`split: the holdout share over 10,000 ids is between 15 and 25 percent (${holdout})`,
      holdout >= 1500 && holdout <= 2500, holdout);
    check("split: asking again gives the same answer for every id",
      ids.every((id, i) => J.splitOf(id) === splits[i]), "a split changed between two reads");
    check("split: the rule is one in five by hash",
      J.splitOf("holdout-probe") === "holdout" || J.splitOf("holdout-probe") === "dev", J.splitOf("holdout-probe"));
  }

  // --- The clamp ---
  //
  // There is no scrub on this boundary. The guard that keeps the vendor API
  // key out of a line needs the key, so it lives in the seam, and this module
  // exports nothing that takes a secret. The seam suite drives it.
  {
    console.log("\n=== The clamp on this boundary ===");
    const J = await freshModule();
    clock.set(T0);
    // The subject is a class, so the predicate is over the class rather than
    // over one name a later author is free not to reuse. What the check cannot
    // do is prove intent: an export named for something other than a secret
    // would pass it. The structural half is enforced by the compiler instead,
    // CallRecord carrying no state field, and the cross-pin below drives it.
    const secretish = Object.keys(J).filter((k) => /secret|scrub|redact|sanitiz|key/i.test(k));
    check("no scrub here: the module exports nothing named for a secret or a scrub",
      secretish.length === 0, secretish);
    // The control is a withheld sibling rather than a string this file handed
    // the pattern: the seam module really does export a name the predicate
    // matches, and nothing in this suite chose that name. A control drawn from
    // the pattern's own literals would prove only that the regex compiles.
    const siblingNames = Object.keys(await import("../hooks/decision-seam.ts"));
    const siblingHits = siblingNames.filter((k) => /secret|scrub|redact|sanitiz|key/i.test(k));
    check("no scrub here control: the same predicate fires on a withheld sibling module",
      siblingHits.length > 0, siblingHits);

    const long = "x".repeat(2000);
    const clamped = J.journalText(long);
    check("clamp: a long field is cut to the bound", clamped.length === J.FREE_TEXT_MAX, clamped.length);
    check("clamp: and it says it was cut", clamped.endsWith(J.TEXT_CUT_MARK), clamped.slice(-20));
    check("clamp: a short field is left exactly as it was", J.journalText("short") === "short", J.journalText("short"));

    // The clamp on the line the journal actually writes.
    const { host, files } = makeHost();
    await J.writeCall(host, callRecord(J, { result: failureResult({ reason: "network", detail: long, latencyMs: 12 }) }));
    const [line] = linesOf(files);
    check("clamp: a call line's detail is bounded", line.detail.length === J.FREE_TEXT_MAX && line.detail.endsWith(J.TEXT_CUT_MARK), line.detail.length);

    // The state is the one free text field the clamp does not touch: it is the
    // measured payload the line stores once and a reader needs it whole.
    const { host: h2, files: f2 } = makeHost();
    await J.writeCall(h2, callRecord(J, { result: okResult({ state: long }) }));
    check("clamp: the state is stored whole", linesOf(f2)[0].state === long, linesOf(f2)[0].state.length);
  }

  // --- Nothing is written when the caller is off the journal's path ---
  {
    console.log("\n=== A host with no home writes no file ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files, calls } = makeHost({ home: "" });
    const r = await J.writeCall(host, callRecord(J));
    check("no home: the write resolves false", r.ok === false, r);
    check("no home: and nothing was written anywhere", files.size === 0, [...files.keys()]);
    check("no home: and no write was even attempted",
      !calls.some((c) => c[0] === "writeFile"), calls.map((c) => c[0]));
  }

  // --- A reference is never recorded for a line that never landed ---
  {
    console.log("\n=== A call line that never landed is never named by a later stateRef ===");
    const J = await freshModule();
    clock.set(T0);
    const ov = { writeThrows: true };
    const { host, files } = makeHost(ov);
    const first = await J.writeCall(host, callRecord(J, { stampId: "steward.harness-session.1700000000000.1" }));
    check("dangling: the first write failed (precondition)", first.ok === false, first);
    ov.writeThrows = false;
    const second = await J.writeCall(host, callRecord(J, { stampId: "steward.harness-session.1700000000000.2" }));
    check("dangling: the second write landed (precondition)", second.ok === true, second);
    const line = linesOf(files)[0];
    // The state is the same on both calls, so a dedup that trusted the failed
    // write would point this line at a stamp id no load can find.
    check("dangling: the landed line carries the state rather than a reference",
      line.state === "worker idle 3 ticks", line);
    check("dangling: and it names no earlier line", line.stateRef === null, line);
  }

  // --- An existence answer that is neither true nor false ---
  {
    console.log("\n=== An existence answer that is neither true nor false destroys nothing ===");
    const J = await freshModule();
    clock.set(T0);
    const PRIOR = '{"lineKind":"call","stampId":"an-earlier-line"}\n';
    const { host, files } = makeHost({ existsReturns: 1 });
    files.set(PATH, PRIOR);
    const r = await J.writeCall(host, callRecord(J));
    check("hostile exists: the write resolves false", r.ok === false, r);
    check("hostile exists: and the day's lines are exactly as they were",
      files.get(PATH) === PRIOR, files.get(PATH));
  }

  // --- The once-a-day latch reports the channel, not the caller ---
  {
    console.log("\n=== A refused outcome kind does not spend the day's failure latch ===");
    const J = await freshModule();
    clock.set(T0);
    const { host } = makeHost({ writeThrows: true });
    const base = { persona: PERSONA, session: SESSION, callStampId: "steward.harness-session.1700000000000.1" };
    const refused = await J.writeOutcome(host, { ...base, kind: "not_a_kind", value: "x" });
    check("latch: the refused kind resolves false", refused.ok === false, refused);
    check("latch: and is not reported as the day's first failure",
      refused.firstFailureToday === false, refused);
    const real = await J.writeOutcome(host, { ...base, kind: "next_score", value: "on-goal" });
    check("latch: so the day's first real write failure is still reported",
      real.ok === false && real.firstFailureToday === true, real);
  }

  // --- Agreement is decided before the clamp, not after ---
  {
    console.log("\n=== Two values differing only past the clamp do not read as agreeing ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    const stem = "o".repeat(600);
    await J.writeAnswers(host, { persona: PERSONA, session: SESSION, answers: [{
      callStampId: "steward.harness-session.1700000000000.1",
      questionId: "controller-decision",
      questionVersion: "v1",
      overrideRefused: null,
      value: stem + "A",
      probabilities: { a: 1 },
      confidence: 0.5,
      haikuValue: stem + "B",
    }] });
    const line = linesOf(files)[0];
    check("agreement: both values are bounded on the line (precondition)",
      line.value.endsWith("...[cut]") && line.haikuValue.endsWith("...[cut]"), line.value.length);
    check("agreement: and the pair does not read as agreeing", line.agrees === false, line.agrees);
  }

  // --- Every text the journal did not author is bounded, keys included ---
  {
    console.log("\n=== A probability key is bounded like every other unauthored text ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    // The seam validates each probability as a finite number and never checks
    // the key set against the option ids it offered, so an unbounded key
    // reaches this boundary and an append rewrites the whole file.
    const huge = "k".repeat(900);
    await J.writeAnswers(host, { persona: PERSONA, session: SESSION, answers: [{
      callStampId: "steward.harness-session.1700000000000.1",
      questionId: "controller-decision",
      questionVersion: "v1",
      overrideRefused: null,
      value: "nudge",
      probabilities: { [huge]: 0.5, nudge: 0.5 },
      confidence: 0.5,
      haikuValue: "nudge",
    }] });
    const keys = Object.keys(linesOf(files)[0].probabilities);
    check("probability keys: the unbounded key was cut", keys.some((k) => k.endsWith("...[cut]")), keys.map((k) => k.length));
    check("probability keys: no key on the line runs past the clamp",
      keys.every((k) => k.length <= 512), keys.map((k) => k.length));
    check("probability keys: and the ordinary key is untouched", keys.includes("nudge"), keys.map((k) => k.slice(0, 12)));
  }

  // --- A call that read no key carries no state ---
  //
  // Both reasons that precede the key check carry a null state, because
  // nothing was scrubbed and nothing was sent. The line records that as a null
  // rather than as a flag of its own: the result column already names which
  // reason it was, and a second column could drift from it.
  {
    console.log("\n=== A call that read no key writes a null state and no reference ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    await J.writeCall(host, callRecord(J, {
      stampId: "steward.harness-session.1700000000000.1",
      result: failureResult({ reason: "off" }),
    }));
    const [line] = linesOf(files);
    check("no state: the line carries a null state", line.state === null, line);
    check("no state: and a null hash rather than the hash of an empty string",
      line.stateHash === null, line.stateHash);
    check("no state: and it names no earlier line", line.stateRef === null, line);
    check("no state: the reason column is what says why", line.result === "off", line.result);

    // A null state must not be recorded as this site's last state, or the next
    // real call on this site would read as a repeat of nothing.
    await J.writeCall(host, callRecord(J, { stampId: "steward.harness-session.1700000000000.2" }));
    const second = linesOf(files)[1];
    check("no state: the next real call still carries its state whole",
      second.state === "worker idle 3 ticks" && second.stateRef === null, second);

    // And a null state after a real one is not a repeat of it either.
    await J.writeCall(host, callRecord(J, {
      stampId: "steward.harness-session.1700000000000.3",
      result: failureResult({ reason: "no_key" }),
    }));
    const third = linesOf(files)[2];
    check("no state: a null state after a real one points at nothing",
      third.state === null && third.stateRef === null && third.stateHash === null, third);

    // The real state is still the one a later repeat points back at, so the
    // null line did not disturb the dedup.
    await J.writeCall(host, callRecord(J, { stampId: "steward.harness-session.1700000000000.4" }));
    const fourth = linesOf(files)[3];
    check("no state: a repeat after the null line still points at the real one",
      fourth.state === null && fourth.stateRef === "steward.harness-session.1700000000000.2", fourth);
  }

  // --- The state a line carries is the seam's, byte for byte ---
  {
    console.log("\n=== The line stores the seam's scrubbed bytes unchanged ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    // What the seam hands over is already scrubbed. The journal neither
    // scrubs nor clamps it, so what a reader gets is what the vendor got.
    const scrubbed = "worker printed [key] to its log this tick";
    await J.writeCall(host, callRecord(J, { result: okResult({ state: scrubbed }) }));
    check("seam bytes: the line carries the result's state unchanged",
      linesOf(files)[0].state === scrubbed, linesOf(files)[0].state);
  }

  // --- The ask marker's value is the journal's, not the worker's ---
  //
  // What matched an ASK: marker is a line the worker wrote. A journal line
  // records that the marker fired and never what it said, so the value is
  // substituted rather than clamped. The guard needs only the kind, so it sits
  // on this channel rather than on the joiner that will call it.
  {
    console.log("\n=== An ask marker's value is a fixed token ===");
    const J = await freshModule();
    clock.set(T0);
    const { host, files } = makeHost();
    const workerText = "ASK: should I use the staging credentials for this run?";
    await J.writeOutcome(host, {
      persona: PERSONA, session: SESSION, callStampId: "steward.harness-session.1700000000000.1",
      kind: "ask_marker", value: workerText,
    });
    const line = linesOf(files)[0];
    check("ask marker: the line carries the fixed token", line.value === J.ASK_MARKER_VALUE, line.value);
    check("ask marker: and the token is not the empty string or null",
      typeof J.ASK_MARKER_VALUE === "string" && J.ASK_MARKER_VALUE.length > 0, J.ASK_MARKER_VALUE);
    check("ask marker: no part of the worker's line reaches the file",
      !files.get(PATH).includes("staging credentials"), files.get(PATH));

    // A long worker line would otherwise be clamped and still carry 512 of
    // the worker's own characters, which is the failure this substitution
    // closes rather than bounds.
    const { host: h2, files: f2 } = makeHost();
    await J.writeOutcome(h2, {
      persona: PERSONA, session: SESSION, callStampId: "steward.harness-session.1700000000000.2",
      kind: "ask_marker", value: "q".repeat(2000),
    });
    check("ask marker: a long worker line is substituted rather than cut",
      linesOf(f2)[0].value === J.ASK_MARKER_VALUE && !f2.get(PATH).includes("qqqq"), linesOf(f2)[0].value);

    // The other kind is the plugin's own label from a closed set, so it rides
    // as it was given. This is the withheld half: the substitution is keyed on
    // the kind, and a guard that replaced every value would pass the three
    // checks above just as well.
    const { host: h3, files: f3 } = makeHost();
    await J.writeOutcome(h3, {
      persona: PERSONA, session: SESSION, callStampId: "steward.harness-session.1700000000000.3",
      kind: "next_score", value: "on-goal",
    });
    check("ask marker: a next_score value is untouched", linesOf(f3)[0].value === "on-goal", linesOf(f3)[0].value);
  }

  // --- The seam's own result, driven through this writer ---
  //
  // Every other case here builds the seam's result by hand. Each side tested
  // against its own literal is how a writer and a reader drift apart, so this
  // one runs the real ask and hands what it returns straight to writeCall.
  {
    console.log("\n=== A real seam result is what the call line records ===");
    const J = await freshModule();
    const { ask } = await import("../hooks/decision-seam.ts");
    const { createFake$, fakeHostOf } = await import("./tick-harness.mjs");
    clock.set(T0);

    const KEY = "sk-journal-crosspin-key";
    const QUESTION = {
      id: "controller-decision", version: "v1", overrideRefused: null, primitive: "choice",
      instructions: "Pick one.", options: { nudge: "Send a nudge", wait: "Do nothing" },
    };
    const body = JSON.stringify({
      answers: { "controller-decision": { type: "choice", choice: "nudge", probabilities: { nudge: 0.8, wait: 0.2 }, confidence: 0.7 } },
      usage: { input_tokens: 296, output_tokens: 4 },
      model: "jev-latest",
    });

    // An ok call: the seam scrubs the state and the line records those bytes.
    const fake = createFake$();
    fake.setEnv("TYPESAFE_API_KEY", KEY);
    fake.setHttpResponse(() => Promise.resolve({ status: 200, ok: true, headers: {}, text: body }));
    const leaky = `worker printed ${KEY} this tick`;
    const okReal = await ask(fakeHostOf(fake), "controller-decision", ["nudge", "wait"], leaky, "shadow", "nudge", async () => QUESTION);
    check("cross-pin: the real call succeeded (precondition)", okReal.ok === true, okReal);
    const { host, files } = makeHost();
    await J.writeCall(host, {
      stampId: "steward.harness-session.1700000000000.1", persona: PERSONA, session: SESSION,
      site: "controller", questionSet: "controller-decision", mode: "shadow", result: okReal,
    });
    const okLine = linesOf(files)[0];
    check("cross-pin: the line carries the seam's scrubbed state byte for byte",
      okLine.state === okReal.state && okLine.state === "worker printed [key] this tick", okLine.state);
    check("cross-pin: the key is nowhere in the file", !files.get(PATH).includes(KEY), okLine.state);
    check("cross-pin: the line's hash is a number for a state that exists", typeof okLine.stateHash === "number", okLine.stateHash);

    // A call the kill switch stopped: the seam read no key, so the line's
    // state and hash are both null. This is the half that would drift if the
    // two modules disagreed on which reasons carry a state.
    const offReal = await ask(fakeHostOf(fake), "controller-decision", ["nudge", "wait"], leaky, "off", "nudge", async () => QUESTION);
    check("cross-pin: the off call failed off (precondition)", offReal.ok === false && offReal.reason === "off", offReal);
    const { host: h2, files: f2 } = makeHost();
    await J.writeCall(h2, {
      stampId: "steward.harness-session.1700000000000.2", persona: PERSONA, session: SESSION,
      site: "controller", questionSet: "controller-decision", mode: "off", result: offReal,
    });
    const offLine = linesOf(f2)[0];
    check("cross-pin: a real off result writes a null state and a null hash",
      offLine.state === null && offLine.stateHash === null && offLine.stateRef === null, offLine);
    check("cross-pin: and the worker's text is nowhere in that file either",
      !f2.get(PATH).includes("worker printed"), f2.get(PATH));

    // The branch the floor added, driven end to end. The off leg above returns
    // before the key is read at all, so it exercises the mode check rather than
    // the floor. This one hands the seam a key one character under the floor.
    const underFloor = "k".repeat(15);
    const fakeShort = createFake$();
    fakeShort.setEnv("TYPESAFE_API_KEY", underFloor);
    fakeShort.setHttpResponse(() => Promise.resolve({ status: 200, ok: true, headers: {}, text: body }));
    const shortReal = await ask(fakeHostOf(fakeShort), "controller-decision", ["nudge", "wait"], leaky, "shadow", "nudge", async () => QUESTION);
    check("cross-pin: the under-floor key failed no_key (precondition)",
      shortReal.ok === false && shortReal.reason === "no_key", shortReal);
    check("cross-pin: and nothing was sent", fakeShort.httpCalls.length === 0, fakeShort.httpCalls.length);
    const { host: h3, files: f3 } = makeHost();
    await J.writeCall(h3, {
      stampId: "steward.harness-session.1700000000000.3", persona: PERSONA, session: SESSION,
      site: "controller", questionSet: "controller-decision", mode: "shadow", result: shortReal,
    });
    const shortLine = linesOf(f3)[0];
    check("cross-pin: a real under-floor result writes a null state and a null hash",
      shortLine.state === null && shortLine.stateHash === null && shortLine.stateRef === null, shortLine);
    check("cross-pin: the result column tells it apart from an off call",
      shortLine.result === "no_key", shortLine.result);
    check("cross-pin: and the worker's text is nowhere in that file",
      !f3.get(PATH).includes("worker printed"), f3.get(PATH));
  }
} finally {
  clock.restore();
}

await new Promise((res) => setImmediate(res));
check("Final: no unhandled rejection surfaced during the suite", unhandled.length === 0, unhandled.map(String));

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`);
process.exit(failed === 0 ? 0 : 1);
