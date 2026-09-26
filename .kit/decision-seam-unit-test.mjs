#!/usr/bin/env node
// Decision seam unit tests: every closed failure reason resolves without a
// throw, the kill switch sends nothing, the timeout race settles cleanly, the
// one request the seam sends carries the live contract's shape, the answer
// that rides the result is validated rather than forwarded, and no failure
// detail can carry the key.
//
// Drives hooks/decision-seam.ts through the fake PluginHost tick-harness
// builds over its fake $ (fakeHostOf), the way hooks/index.ts builds one over
// the real $ in its top-level hostOf, with Date.now stubbed so latency is a
// number the case chose rather than a wall-clock reading. The catalog
// resolver is a stub here, typed against the interface
// hooks/question-catalog.ts exports.
//
// A failure detail printed by this runner never carries a header object or a
// request list: a red run prints header names and call counts, so the bearer
// value cannot reach a log even from a test that failed.
//
// Usage: node decision-seam-unit-test.mjs
// Exits 0 on success, 1 on failure.

import { createFake$, fakeHostOf, stubDateNow } from "./tick-harness.mjs";

const {
  ask,
  askAll,
  JEV_ENDPOINT,
  JEV_MODEL,
  SHADOW_TIMEOUT_MS,
  LIVE_TIMEOUT_MS,
  SEAM_FAILURE_REASONS,
  KEY_MIN_CHARS,
} = await import("../hooks/decision-seam.ts");

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name, detail) {
  console.error(`  FAIL: ${name}`);
  if (detail !== undefined) console.error(`        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  failed++;
}
function check(name, cond, detail) { if (cond) ok(name); else fail(name, detail); }
function sameSet(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

// An unhandled rejection anywhere in this process is a failure of the
// "never throws, and the race's loser is handled" contract, so it is
// counted here and asserted at the end, after the loop has had a turn to
// surface any the last case left behind.
const unhandled = [];
process.on("unhandledRejection", (reason) => { unhandled.push(reason); });

const KEY = "sk-test-not-a-real-key";
// Exactly at the floor and one character under it, so the boundary is driven
// from both sides rather than from one.
const KEY_AT_FLOOR = "k".repeat(16);
const KEY_UNDER_FLOOR = "k".repeat(15);
const STATE = "worker idle 3 ticks; last turn scored on-goal; no pending ask";

// The stub catalog: one Choice set with a superset of three options, and a
// second set with no options of its own (the plan switch's shape, whose ids
// are the caller's pending plan ids).
const CATALOG = {
  controller_decision: {
    id: "controller_decision",
    version: "v1",
    overrideRefused: null,
    primitive: "choice",
    instructions: "Which action should the controller take next?",
    options: { nudge: "Send the worker a nudge", wait: "Do nothing this tick", switch: "Switch to the pending plan" },
  },
  plan_switch: {
    id: "plan_switch",
    version: "v3",
    overrideRefused: "fewer than 2 options",
    primitive: "choice",
    instructions: "Which pending plan does the worker's last turn address?",
    options: { no_match: "None of the pending plans" },
  },
};
const resolveCalls = [];
const resolveStub = async (questionSetId) => {
  resolveCalls.push(questionSetId);
  return CATALOG[questionSetId];
};

function okBody(questionId, choice = "nudge") {
  return JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      // Only ids the default call offers. A body scoring an id the request
      // never carried is a malformed body, refused at validation, and Test 17
      // drives that case deliberately rather than leaving it in the fixture
      // every other case shares.
      [questionId]: { type: "choice", choice, probabilities: { nudge: 0.7, wait: 0.3 }, confidence: 0.55 },
    },
    usage: { input_tokens: 296, output_tokens: 20 },
  });
}

function response(status, text, extra = {}) {
  return { status, ok: status >= 200 && status <= 299, headers: {}, text, ...extra };
}

// One fresh fake per case, with the key set unless a case unsets it.
function harness(opts = {}) {
  const h = createFake$();
  if (opts.key !== null) h.setEnv("TYPESAFE_API_KEY", opts.key === undefined ? KEY : opts.key);
  resolveCalls.length = 0;
  return h;
}

function askDefault(h, overrides = {}) {
  const a = {
    questionSetId: "controller_decision",
    optionIds: ["nudge", "wait"],
    state: STATE,
    mode: "shadow",
    haikuValue: "nudge",
    resolve: resolveStub,
    ...overrides,
  };
  return ask(fakeHostOf(h), a.questionSetId, a.optionIds, a.state, a.mode, a.haikuValue, a.resolve);
}

// Resolves a value or the error it threw, so a case can assert that the
// seam resolved rather than rejected without a try block per case.
async function settle(p) {
  try {
    return { resolved: true, value: await p };
  } catch (err) {
    return { resolved: false, err };
  }
}

const clock = stubDateNow();
const T0 = 1_700_000_000_000;

try {
  // --- Test 1: the closed reason set is exactly the spec's eleven ---
  {
    const expected = ["off", "no_key", "no_question", "timeout", "network", "http_401", "http_422", "http_429", "http_529", "http_other", "parse"];
    check("Test 1: SEAM_FAILURE_REASONS is the closed set of eleven, in the spec's order",
      JSON.stringify(SEAM_FAILURE_REASONS) === JSON.stringify(expected), SEAM_FAILURE_REASONS);
  }

  // --- Test 2: mode "off" sends nothing, reads nothing, resolves nothing ---
  {
    const h = harness();
    const r = await settle(askDefault(h, { mode: "off" }));
    check("Test 2a: mode off resolves (no throw) with reason off",
      r.resolved && r.value.ok === false && r.value.reason === "off", r);
    check("Test 2b: mode off makes no request", h.httpCalls.length === 0, h.httpCalls.length);
    check("Test 2c: mode off reads no environment variable", h.envGets.length === 0, h.envGets);
    check("Test 2d: mode off resolves no question", resolveCalls.length === 0, resolveCalls);
    check("Test 2e: mode off carries no latency and no question", r.value.latencyMs === null && r.value.questionId === null, r.value);
    check("Test 2f: mode off carries Haiku's value through", r.value.haikuValue === "nudge", r.value);
  }

  // --- Test 3: every unrecognized mode is off; the exact strings shadow and live alone send ---
  {
    for (const mode of ["Shadow", "shadow ", " shadow", "Live", "live ", " live", "LIVE", "on", "", "SHADOW", "shadows", "lives"]) {
      const h = harness();
      const r = await settle(askDefault(h, { mode }));
      check(`Test 3: mode ${JSON.stringify(mode)} is off and makes no request`,
        r.resolved && r.value.ok === false && r.value.reason === "off" && h.httpCalls.length === 0 && h.envGets.length === 0, r);
    }
    for (const mode of ["shadow", "live"]) {
      const h = harness();
      h.setHttpResponse(response(200, okBody("controller_decision")));
      const r = await settle(askDefault(h, { mode }));
      check(`Test 3 control: the exact string ${mode} makes the request`, r.resolved && r.value.ok === true && h.httpCalls.length === 1, r);
    }
  }

  // --- Test 4: no key sends nothing ---
  {
    for (const [label, key] of [["absent", null], ["empty string", ""], ["whitespace only", " \t\n "]]) {
      const h = harness({ key });
      const r = await settle(askDefault(h));
      check(`Test 4: key ${label} resolves with reason no_key and makes no request`,
        r.resolved && r.value.ok === false && r.value.reason === "no_key" && h.httpCalls.length === 0 && r.value.latencyMs === null, r);
      check(`Test 4: key ${label} resolves no question`, resolveCalls.length === 0, resolveCalls);
    }
    const h2 = harness({ key: null });
    await askDefault(h2);
    check("Test 4: the seam asks the host for the key exactly once and reads nothing else",
      JSON.stringify(h2.envGets) === JSON.stringify(["TYPESAFE_API_KEY"]), h2.envGets);
    // An environment read that rejects is a key that cannot be read.
    const h3 = harness();
    h3.fake.env.get = () => Promise.reject(new Error("env unavailable"));
    const r3 = await settle(askDefault(h3));
    check("Test 4: an env.get that rejects resolves with reason no_key and makes no request",
      r3.resolved && r3.value.ok === false && r3.value.reason === "no_key" && h3.httpCalls.length === 0, r3);
  }

  // --- Test 5: the one request carries the live contract's shape ---
  {
    const h = harness();
    clock.set(T0);
    h.setHttpResponse((url, init) => {
      clock.advance(37);
      return Promise.resolve(response(200, okBody("controller_decision")));
    });
    const r = await settle(askDefault(h));
    check("Test 5a: a 200 with the asked answer resolves ok", r.resolved && r.value.ok === true, r);
    check("Test 5b: exactly one request was sent", h.httpCalls.length === 1, h.httpCalls.length);
    const call = h.httpCalls[0];
    check("Test 5c: the request goes to the evaluation endpoint", call.url === JEV_ENDPOINT && JEV_ENDPOINT === "https://api.typesafe.ai/v1/systemone", call.url);
    check("Test 5d: the request is a POST", call.init.method === "POST", call.init.method);
    check("Test 5e: the bearer header carries the key and the body is JSON",
      call.init.headers.Authorization === `Bearer ${KEY}` && call.init.headers["Content-Type"] === "application/json", Object.keys(call.init.headers));
    const body = JSON.parse(call.init.body);
    check("Test 5f: the body carries the state text unchanged", body.state === STATE, body.state);
    check("Test 5g: the body names the model alias", body.model === JEV_MODEL && JEV_MODEL === "jev-latest", body.model);
    check("Test 5h: the questions map holds exactly the resolved question under its id",
      JSON.stringify(Object.keys(body.questions)) === JSON.stringify(["controller_decision"]), Object.keys(body.questions));
    const q = body.questions.controller_decision;
    check("Test 5i: the question is a choice with the catalog's instructions",
      q.type === "choice" && q.instructions === CATALOG.controller_decision.instructions, q);
    check("Test 5j: the criteria are exactly the ids in force, in the caller's order, with the catalog's descriptions",
      JSON.stringify(q.criteria) === JSON.stringify({ nudge: "Send the worker a nudge", wait: "Do nothing this tick" }), q.criteria);
    check("Test 5k: the superset option the caller did not offer is not sent", !("switch" in q.criteria), q.criteria);
    check("Test 5l: the key appears nowhere in the body", !call.init.body.includes(KEY));
    check("Test 5m: latencyMs is the seam's own measurement", r.value.latencyMs === 37, r.value.latencyMs);
    check("Test 5n: the answer, usage, model and version ride the result",
      r.value.answer?.choice === "nudge"
        && r.value.usage.input_tokens === 296 && r.value.usage.output_tokens === 20
        && r.value.model === "jev-1.13.0" && r.value.questionVersion === "v1" && r.value.overrideRefused === null
        && r.value.questionId === "controller_decision" && r.value.haikuValue === "nudge", r.value);
    check("Test 5o: the resolver was asked once, for the set id", JSON.stringify(resolveCalls) === JSON.stringify(["controller_decision"]), resolveCalls);
  }

  // --- Test 6: the plan switch shape, ids with no catalog entry carry null ---
  {
    const h = harness();
    h.setHttpResponse(response(200, JSON.stringify({
      model: "jev-1.13.0",
      answers: { plan_switch: { type: "choice", choice: "no_match", probabilities: { "plan-a": 0.3, "plan-b": 0.1, no_match: 0.6 }, confidence: 0.4 } },
      usage: { input_tokens: 100, output_tokens: 10 },
    })));
    const r = await settle(askDefault(h, { questionSetId: "plan_switch", optionIds: ["plan-a", "plan-b", "no_match"], haikuValue: "no_match" }));
    const q = JSON.parse(h.httpCalls[0].init.body).questions.plan_switch;
    check("Test 6a: caller-supplied ids with no catalog description are sent with null",
      JSON.stringify(q.criteria) === JSON.stringify({ "plan-a": null, "plan-b": null, no_match: "None of the pending plans" }), q.criteria);
    check("Test 6b: the refusal reason the resolver returned rides the result",
      r.resolved && r.value.ok === true && r.value.overrideRefused === "fewer than 2 options" && r.value.questionVersion === "v3", r.value);
  }

  // --- Test 7: each HTTP error status maps to its own reason, without a throw ---
  {
    for (const [status, reason] of [[401, "http_401"], [422, "http_422"], [429, "http_429"], [529, "http_529"]]) {
      const h = harness();
      h.setHttpResponse(response(status, JSON.stringify({ error: "x" })));
      const r = await settle(askDefault(h));
      check(`Test 7: status ${status} resolves with reason ${reason}, detail ${status}, and a measured latency`,
        r.resolved && r.value.ok === false && r.value.reason === reason && r.value.detail === String(status) && typeof r.value.latencyMs === "number", r);
    }
    for (const status of [199, 300, 302, 400, 403, 404, 500, 502, 503]) {
      const h = harness();
      h.setHttpResponse(response(status, ""));
      const r = await settle(askDefault(h));
      check(`Test 7: status ${status} resolves with reason http_other and detail ${status}`,
        r.resolved && r.value.ok === false && r.value.reason === "http_other" && r.value.detail === String(status), r);
    }
    const h = harness();
    h.setHttpResponse({ status: undefined, ok: false, headers: {}, text: "" });
    const r = await settle(askDefault(h));
    check("Test 7: a response with no numeric status resolves with reason http_other",
      r.resolved && r.value.ok === false && r.value.reason === "http_other", r);
    // A status that is a number but not an integer in 200..299 is not success:
    // NaN passes a typeof test and fails both range comparisons.
    for (const [label, status] of [["NaN", NaN], ["a fraction", 200.5], ["a numeric string", "200"], ["Infinity", Infinity]]) {
      const h2 = harness();
      h2.setHttpResponse({ status, ok: true, headers: {}, text: okBody("controller_decision") });
      const r2 = await settle(askDefault(h2));
      check(`Test 7: status ${label} with a well-formed body resolves with reason http_other, not success`,
        r2.resolved && r2.value.ok === false && r2.value.reason === "http_other", r2);
    }
    const h3 = harness();
    h3.setHttpResponse(response(204, okBody("controller_decision")));
    const r3 = await settle(askDefault(h3));
    check("Test 7 control: any 2xx integer is read as success", r3.resolved && r3.value.ok === true, r3);
  }

  // --- Test 8: a rejected fetch is network; a fetch that throws synchronously is network too ---
  {
    const h = harness();
    h.setHttpResponse(() => Promise.reject(new Error("ECONNRESET")));
    const r = await settle(askDefault(h));
    check("Test 8a: a rejecting fetch resolves with reason network and the error's message",
      r.resolved && r.value.ok === false && r.value.reason === "network" && r.value.detail === "ECONNRESET" && typeof r.value.latencyMs === "number", r);
    const h2 = harness();
    h2.fake.http.fetch = () => { throw new Error("policy refused"); };
    const r2 = await settle(askDefault(h2));
    check("Test 8b: a fetch that throws synchronously resolves with reason network",
      r2.resolved && r2.value.ok === false && r2.value.reason === "network" && r2.value.detail === "policy refused", r2);
    const h3 = harness();
    h3.setHttpResponse(() => Promise.reject("string reason"));
    const r3 = await settle(askDefault(h3));
    check("Test 8c: a non-Error rejection is network with its string form", r3.resolved && r3.value.reason === "network" && r3.value.detail === "string reason", r3);
    // A host fetch that resolves with no response object at all. Every host
    // call is an op event a co-loaded hook may answer with a value of its
    // own, so this is a shape the seam meets, not only a fake's.
    for (const [label, value] of [["null", null], ["undefined", undefined], ["a string", "ok"], ["a number", 200]]) {
      const h4 = harness();
      h4.setHttpResponse(() => Promise.resolve(value));
      const r4 = await settle(askDefault(h4));
      check(`Test 8d: a fetch that resolves with ${label} resolves with reason network and detail "no response"`,
        r4.resolved && r4.value.ok === false && r4.value.reason === "network" && r4.value.detail === "no response", r4);
    }
    // The network detail is bound for the journal, so a host error that
    // echoes the request must not carry the bearer value into it.
    const h5 = harness();
    const echoed = new Error(`upstream refused Bearer ${KEY} at ${JEV_ENDPOINT}`);
    h5.setHttpResponse(() => Promise.reject(echoed));
    const r5 = await settle(askDefault(h5));
    check("Test 8e control: the fake's rejection message does contain the key", echoed.message.includes(KEY));
    check("Test 8e: a network detail never contains the key",
      r5.resolved && r5.value.reason === "network" && typeof r5.value.detail === "string" && !r5.value.detail.includes(KEY), r5.value.reason);
    check("Test 8e: the scrubbed detail keeps the rest of the message",
      r5.resolved && r5.value.detail.includes("upstream refused") && r5.value.detail.includes(JEV_ENDPOINT), r5.value.reason);
  }

  // --- Test 9: parse failures ---
  {
    const cases = [
      ["not JSON", "<html>oops</html>", "body is not JSON"],
      ["empty body", "", "body is not JSON"],
      ["JSON with no answers", JSON.stringify({ model: "jev-1.13.0", usage: {} }), "no answer for controller_decision"],
      ["answers missing the asked id", JSON.stringify({ answers: { other: { type: "noul", noul: 0.5 } }, usage: {} }), "no answer for controller_decision"],
      ["answers is an array", JSON.stringify({ answers: [] }), "no answer for controller_decision"],
      ["a JSON scalar", "42", "no answer for controller_decision"],
      ["the answer is null", JSON.stringify({ answers: { controller_decision: null } }), "no answer for controller_decision"],
    ];
    for (const [label, text, detail] of cases) {
      const h = harness();
      h.setHttpResponse(response(200, text));
      const r = await settle(askDefault(h));
      check(`Test 9: 200 with ${label} resolves with reason parse (${detail})`,
        r.resolved && r.value.ok === false && r.value.reason === "parse" && r.value.detail === detail, r);
    }
    const h = harness();
    h.setHttpResponse(response(200, JSON.stringify({ answers: { controller_decision: { type: "choice", choice: "wait", probabilities: {}, confidence: 1 } } })));
    const r = await settle(askDefault(h));
    check("Test 9: a body with no usage block resolves ok with null counts",
      r.resolved && r.value.ok === true && r.value.usage.input_tokens === null && r.value.usage.output_tokens === null && r.value.model === null, r.value);
    const h2 = harness();
    h2.setHttpResponse({ status: 200, ok: true, headers: {}, text: { answers: {} } });
    const r2 = await settle(askDefault(h2));
    check("Test 9: a body that is not text resolves with reason parse", r2.resolved && r2.value.ok === false && r2.value.reason === "parse", r2);
  }

  // --- Test 10: the timeout race ---
  {
    // 10a: the fetch never settles; the timer fires; the seam resolves timeout.
    const h = harness();
    clock.set(T0);
    let rejectLateFetch;
    h.setHttpResponse(() => new Promise((_, reject) => { rejectLateFetch = reject; }));
    const p = askDefault(h);
    await new Promise((r) => setImmediate(r));
    check("Test 10a: one sleep of SHADOW_TIMEOUT_MS was started beside the request",
      h.sleeps.length === 1 && h.sleeps[0].ms === SHADOW_TIMEOUT_MS && SHADOW_TIMEOUT_MS === 10000, h.sleeps.map((s) => s.ms));
    clock.advance(SHADOW_TIMEOUT_MS);
    h.fireSleep();
    const r = await settle(p);
    check("Test 10b: the timer winning resolves with reason timeout and the elapsed latency",
      r.resolved && r.value.ok === false && r.value.reason === "timeout" && r.value.latencyMs === SHADOW_TIMEOUT_MS && r.value.questionId === "controller_decision", r);
    // The loser settles later, as a rejection: it must already be handled.
    rejectLateFetch(new Error("late failure"));
    await new Promise((res) => setImmediate(res));
    check("Test 10c: the losing fetch rejecting after the timeout leaves no unhandled rejection", unhandled.length === 0, unhandled.map(String));

    // 10d: the fetch wins; the timer firing later changes nothing.
    const h2 = harness();
    h2.setHttpResponse(response(200, okBody("controller_decision", "wait")));
    const r2 = await settle(askDefault(h2));
    check("Test 10d: a fetch that settles first resolves ok while the timer is still pending",
      r2.resolved && r2.value.ok === true && h2.pendingSleepCount === 1, r2);
    h2.fireSleep();
    await new Promise((res) => setImmediate(res));
    check("Test 10e: the timer firing after the answer leaves no unhandled rejection", unhandled.length === 0, unhandled.map(String));

    // 10f: a timer the host cannot start reads as fired, so the request is
    // never unbounded.
    const h3 = harness();
    h3.setHttpResponse(() => new Promise(() => {}));
    h3.fake.clock.sleep = () => Promise.reject(new Error("no timers"));
    const r3 = await settle(askDefault(h3));
    check("Test 10f: a sleep that rejects resolves the race as timeout", r3.resolved && r3.value.ok === false && r3.value.reason === "timeout", r3);
    const h4 = harness();
    h4.setHttpResponse(() => new Promise(() => {}));
    h4.fake.clock.sleep = () => { throw new Error("no timers"); };
    const r4 = await settle(askDefault(h4));
    check("Test 10g: a sleep that throws synchronously resolves the race as timeout", r4.resolved && r4.value.ok === false && r4.value.reason === "timeout", r4);

    // 10h: the timer is the mode's. A live call is awaited on a turn-end
    // path, so its bound is the shorter one; 10a above pins shadow at its.
    const h5 = harness();
    clock.set(T0);
    h5.setHttpResponse(() => new Promise(() => {}));
    const p5 = askDefault(h5, { mode: "live" });
    await new Promise((r) => setImmediate(r));
    check("Test 10h: a live call starts one sleep of LIVE_TIMEOUT_MS, which is two seconds",
      h5.sleeps.length === 1 && h5.sleeps[0].ms === LIVE_TIMEOUT_MS && LIVE_TIMEOUT_MS === 2000 && LIVE_TIMEOUT_MS < SHADOW_TIMEOUT_MS, h5.sleeps.map((s) => s.ms));
    clock.advance(LIVE_TIMEOUT_MS);
    h5.fireSleep();
    const r5 = await settle(p5);
    check("Test 10i: the live timer winning resolves timeout at the live bound's latency",
      r5.resolved && r5.value.ok === false && r5.value.reason === "timeout" && r5.value.latencyMs === LIVE_TIMEOUT_MS, r5);
  }

  // --- Test 11: every failure result carries the same field set, and no failure throws ---
  {
    const fields = ["ok", "reason", "detail", "questionSetId", "questionId", "questionVersion", "overrideRefused", "latencyMs", "haikuValue", "state"];
    const seen = new Set();
    const drivers = {
      off: (h) => askDefault(h, { mode: "off" }),
      no_key: (h) => { h.setEnv("TYPESAFE_API_KEY", ""); return askDefault(h); },
      no_question: (h) => askDefault(h, { resolve: () => Promise.reject(new Error("catalog unreadable")) }),
      timeout: (h) => { h.setHttpResponse(() => new Promise(() => {})); const p = askDefault(h); setImmediate(() => h.fireSleep()); return p; },
      network: (h) => { h.setHttpResponse(() => Promise.reject(new Error("down"))); return askDefault(h); },
      http_401: (h) => { h.setHttpResponse(response(401, "")); return askDefault(h); },
      http_422: (h) => { h.setHttpResponse(response(422, "")); return askDefault(h); },
      http_429: (h) => { h.setHttpResponse(response(429, "")); return askDefault(h); },
      http_529: (h) => { h.setHttpResponse(response(529, "")); return askDefault(h); },
      http_other: (h) => { h.setHttpResponse(response(500, "")); return askDefault(h); },
      parse: (h) => { h.setHttpResponse(response(200, "nope")); return askDefault(h); },
    };
    check("Test 11: a driver exists for every reason in the closed set", sameSet(Object.keys(drivers), SEAM_FAILURE_REASONS), Object.keys(drivers));
    for (const reason of SEAM_FAILURE_REASONS) {
      const h = harness();
      const r = await settle(drivers[reason](h));
      seen.add(r.resolved ? r.value.reason : "THREW");
      check(`Test 11: reason ${reason} resolves without a throw with every failure field present`,
        r.resolved && r.value.ok === false && r.value.reason === reason && sameSet(Object.keys(r.value), fields), r);
    }
    check("Test 11: every reason in the closed set was driven", SEAM_FAILURE_REASONS.every((x) => seen.has(x)), [...seen]);
  }

  // --- Test 12: a question the catalog cannot resolve is no_question, local and before any request ---
  {
    // A resolver that rejects. Its message carries the key, the way a
    // catalog error that echoed the environment might, and the detail must
    // not.
    const h = harness();
    const r = await settle(askDefault(h, { resolve: () => Promise.reject(new Error(`override unreadable, env ${KEY}`)) }));
    check("Test 12a: a rejecting resolver resolves with reason no_question, no request, no question and no latency",
      r.resolved && r.value.ok === false && r.value.reason === "no_question" && h.httpCalls.length === 0
        && r.value.questionId === null && r.value.questionVersion === null && r.value.latencyMs === null && r.value.haikuValue === "nudge", r);
    check("Test 12a: the no_question detail carries the resolver's message without the key",
      r.resolved && typeof r.value?.detail === "string" && r.value.detail.includes("override unreadable") && !r.value.detail.includes(KEY), r.value?.reason);
    const h2 = harness();
    const r2 = await settle(askDefault(h2, { resolve: () => { throw new Error("sync"); } }));
    check("Test 12b: a resolver that throws synchronously resolves with reason no_question and no request",
      r2.resolved && r2.value.ok === false && r2.value.reason === "no_question" && h2.httpCalls.length === 0, r2);
    // A resolver that resolves with a shape carrying no options.
    const shapes = [
      ["undefined", undefined],
      ["null", null],
      ["a string", "controller_decision"],
      ["an object with no options", { id: "controller_decision", version: "v1", overrideRefused: null, primitive: "choice", instructions: "x" }],
      ["options that is an array", { ...CATALOG.controller_decision, options: ["nudge", "wait"] }],
      ["an option whose description is a number", { ...CATALOG.controller_decision, options: { nudge: 1 } }],
      ["no id", { ...CATALOG.controller_decision, id: undefined }],
      ["a primitive that is not choice", { ...CATALOG.controller_decision, primitive: "noul" }],
    ];
    for (const [label, shape] of shapes) {
      const h3 = harness();
      const r3 = await settle(askDefault(h3, { resolve: async () => shape }));
      check(`Test 12c: a resolver returning ${label} resolves with reason no_question and makes no request`,
        r3.resolved && r3.value.ok === false && r3.value.reason === "no_question" && typeof r3.value.detail === "string" && h3.httpCalls.length === 0, r3);
    }
    const h4 = harness();
    h4.setHttpResponse(response(200, okBody("controller_decision")));
    const r4 = await settle(askDefault(h4));
    check("Test 12 control: the stub catalog's own shape resolves and the request is sent", r4.resolved && r4.value.ok === true && h4.httpCalls.length === 1, r4);
  }

  // --- Test 13: the answer that rides the result is validated for the asked id alone ---
  {
    function bodyWith(answer, extra = {}) {
      return JSON.stringify({ model: "jev-1.13.0", answers: { controller_decision: answer }, usage: { input_tokens: 10, output_tokens: 2 }, ...extra });
    }
    const valid = { type: "choice", choice: "wait", probabilities: { nudge: 0.3, wait: 0.7 }, confidence: 0.8 };
    // 13a: unrequested answer keys and unknown answer fields are dropped.
    const h = harness();
    h.setHttpResponse(response(200, JSON.stringify({
      model: "jev-1.13.0",
      answers: { controller_decision: { ...valid, reasoning: "because", raw: { x: 1 } }, unrequested: { type: "noul", noul: 0.1 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    })));
    const r = await settle(askDefault(h));
    check("Test 13a: a valid answer resolves ok with exactly the four choice fields",
      r.resolved && r.value.ok === true && sameSet(Object.keys(r.value.answer ?? {}), ["type", "choice", "probabilities", "confidence"]), r.value);
    check("Test 13a: the validated answer carries the vendor's values",
      r.resolved && r.value.ok === true && r.value.answer?.type === "choice" && r.value.answer?.choice === "wait"
        && r.value.answer.confidence === 0.8 && JSON.stringify(r.value.answer.probabilities) === JSON.stringify({ nudge: 0.3, wait: 0.7 }), r.value);
    check("Test 13a: no answers map and no unrequested key ride the result",
      r.resolved && !("answers" in r.value) && !("unrequested" in r.value) && !("reasoning" in (r.value.answer ?? {})), Object.keys(r.value));
    // 13b: each validation failure is parse, with a fixed detail naming the field.
    const bad = [
      ["a type other than choice", { ...valid, type: "noul" }, "answer type is not choice"],
      ["no type", { choice: "wait", probabilities: {}, confidence: 1 }, "answer type is not choice"],
      ["a choice outside the ids in force", { ...valid, choice: "switch" }, "answer choice is not an offered option"],
      ["a choice that is not a string", { ...valid, choice: 1 }, "answer choice is not an offered option"],
      ["no probabilities", { type: "choice", choice: "wait", confidence: 1 }, "answer probabilities is not an object"],
      ["probabilities that is an array", { ...valid, probabilities: [0.3, 0.7] }, "answer probabilities is not an object"],
      ["a probability that is a string", { ...valid, probabilities: { nudge: "0.3", wait: 0.7 } }, "answer probabilities carry a value that is not a finite number"],
      ["a probability that is null", { ...valid, probabilities: { nudge: null } }, "answer probabilities carry a value that is not a finite number"],
      // A probability is bounded the way a Noul's value is: a finite number
      // outside 0 to 1 is a malformed body. A live turn-disposition answer is
      // read by comparing one probability against a threshold, so a value
      // past 1 would read as delivered on that comparison.
      ["a probability above 1", { ...valid, probabilities: { nudge: 7, wait: 0.7 } }, "answer probabilities carry a value that is outside 0 to 1"],
      ["a probability below 0", { ...valid, probabilities: { nudge: -0.1, wait: 0.7 } }, "answer probabilities carry a value that is outside 0 to 1"],
      ["no confidence", { type: "choice", choice: "wait", probabilities: {} }, "answer confidence is not a finite number"],
      ["a confidence that is a string", { ...valid, confidence: "high" }, "answer confidence is not a finite number"],
    ];
    for (const [label, answer, detail] of bad) {
      const h2 = harness();
      h2.setHttpResponse(response(200, bodyWith(answer)));
      const r2 = await settle(askDefault(h2));
      check(`Test 13b: an answer with ${label} resolves with reason parse (${detail})`,
        r2.resolved && r2.value.ok === false && r2.value.reason === "parse" && r2.value.detail === detail, r2);
    }
    // 13c: the model string is bounded and a non-string model is null.
    const h3 = harness();
    h3.setHttpResponse(response(200, bodyWith(valid, { model: "m".repeat(500) })));
    const r3 = await settle(askDefault(h3));
    check("Test 13c: a long model string is cut to 64 characters",
      r3.resolved && r3.value.ok === true && r3.value.model === "m".repeat(64), r3.value.model && r3.value.model.length);
    const h4 = harness();
    h4.setHttpResponse(response(200, bodyWith(valid, { model: { name: "x" } })));
    const r4 = await settle(askDefault(h4));
    check("Test 13c: a model that is not a string rides as null", r4.resolved && r4.value.ok === true && r4.value.model === null, r4.value);
    // 13d: token counts are non-negative integers or null.
    const counts = [
      ["a negative count", -1, null],
      ["a fractional count", 1.5, null],
      ["a string count", "5", null],
      ["zero", 0, 0],
      ["a positive integer", 296, 296],
    ];
    for (const [label, input, expected] of counts) {
      const h5 = harness();
      h5.setHttpResponse(response(200, bodyWith(valid, { usage: { input_tokens: input, output_tokens: input } })));
      const r5 = await settle(askDefault(h5));
      check(`Test 13d: usage with ${label} rides as ${expected}`,
        r5.resolved && r5.value.ok === true && r5.value.usage.input_tokens === expected && r5.value.usage.output_tokens === expected, r5.value && r5.value.usage);
    }
  }

  // --- Test 14: the folded guard, the key floor and the state scrub ---
  //
  // The scrub lives here rather than on the journal's boundary because it
  // needs the key, and the journal must not hold one. The seam is the last
  // point holding both the text and the key, so it scrubs once and the same
  // bytes go to the vendor and to the journal line.
  {
    check("Test 14a: the floor is 16 characters", KEY_MIN_CHARS === 16, KEY_MIN_CHARS);

    // A value too short to be a bearer token is an absent key: nothing is
    // sent, and no state is carried past the check.
    const hShort = harness({ key: KEY_UNDER_FLOOR });
    const rShort = await settle(askDefault(hShort));
    check("Test 14b: a key one character under the floor reads as no_key",
      rShort.resolved && rShort.value.ok === false && rShort.value.reason === "no_key", rShort.value);
    check("Test 14c: and nothing was sent", hShort.httpCalls.length === 0, hShort.httpCalls.length);
    check("Test 14d: and the result carries no state", rShort.value.state === null, rShort.value.state);

    // The control on the floor: the same driver one character longer gets
    // through, so 14b reports the floor rather than some other refusal.
    const hFloor = harness({ key: KEY_AT_FLOOR });
    hFloor.setHttpResponse(response(200, okBody("controller_decision")));
    const rFloor = await settle(askDefault(hFloor));
    check("Test 14e control: a key exactly at the floor is sent",
      rFloor.resolved && rFloor.value.ok === true && hFloor.httpCalls.length === 1, rFloor.value && rFloor.value.reason);

    // The scrub, driven on a state that actually holds the key. The suite's
    // ordinary state does not, so Test 5l's silence is the instrument working
    // rather than evidence of reach; this case is what gives it reach.
    const leaky = `worker printed ${KEY} to its log this tick`;
    check("Test 14f control: the driving state does contain the key", leaky.includes(KEY), leaky.length);
    const hLeak = harness();
    hLeak.setHttpResponse(response(200, okBody("controller_decision")));
    const rLeak = await settle(askDefault(hLeak, { state: leaky }));
    const sentBody = JSON.parse(hLeak.httpCalls[0].init.body);
    check("Test 14g: the key is gone from the state the vendor receives",
      !sentBody.state.includes(KEY), sentBody.state);
    check("Test 14h: and it was redacted rather than dropped, the rest of the text standing",
      sentBody.state === "worker printed [key] to its log this tick", sentBody.state);
    check("Test 14i: the result carries the same bytes the vendor received",
      rLeak.resolved && rLeak.value.state === sentBody.state, rLeak.value && rLeak.value.state);

    // Every result past the key check carries the scrubbed state, not just the
    // ok one: a failure line is a journal line too.
    const hFail = harness();
    hFail.setHttpResponse(response(500, ""));
    const rFail = await settle(askDefault(hFail, { state: leaky }));
    check("Test 14j: a failure past the key check carries the scrubbed state",
      rFail.resolved && rFail.value.ok === false && rFail.value.state === "worker printed [key] to its log this tick",
      rFail.value && rFail.value.state);

    // A call that read no key has nothing to scrub with, so it carries no
    // state at all and its reason is what names why.
    const hOff = harness();
    const rOff = await settle(askDefault(hOff, { mode: "off", state: leaky }));
    check("Test 14k: an off call carries no state and made no request",
      rOff.resolved && rOff.value.state === null && rOff.value.reason === "off" && hOff.httpCalls.length === 0, rOff.value);

    // The failure that precedes the request but follows the key check still
    // carries the state, which is what lets its line be joined like any other.
    const hNoQ = harness();
    const rNoQ = await settle(askDefault(hNoQ, { state: leaky, resolve: () => Promise.reject(new Error("catalog unreadable")) }));
    check("Test 14l: a no_question failure carries the scrubbed state",
      rNoQ.resolved && rNoQ.value.reason === "no_question" && rNoQ.value.state === "worker printed [key] to its log this tick",
      rNoQ.value && rNoQ.value.state);
  }

  // --- Test 15: the scrub removes both forms of the key ---
  //
  // The key reaches the header exactly as the environment holds it, so a
  // padded value is sent padded. A worker that read the same variable and
  // trimmed it prints the trimmed form, which is the form the state would
  // carry. Both forms therefore have to go, and this is the only case that
  // drives a key whose two forms differ.
  {
    const padded = `  ${"z".repeat(20)}  `;
    const trimmed = padded.trim();
    check("Test 15a control: the two forms differ and the trimmed form clears the floor",
      padded !== trimmed && trimmed.length >= KEY_MIN_CHARS, [padded.length, trimmed.length]);

    const h = harness({ key: padded });
    h.setHttpResponse(response(200, okBody("controller_decision")));
    const state = `worker echoed ${trimmed} into its log`;
    check("Test 15b control: the driving state holds the trimmed form", state.includes(trimmed), state.length);
    const r = await settle(askDefault(h, { state }));
    const body = JSON.parse(h.httpCalls[0].init.body);
    // The floor is measured on the trimmed length, so the trimmed form is what
    // is sent. A padded value would otherwise clear the floor and go out as a
    // header no server accepts, landing every call as http_401 with nothing on
    // the line naming the real cause.
    const authSent = h.httpCalls[0].init.headers.Authorization;
    check("Test 15c: the header carries the trimmed key",
      authSent === `Bearer ${trimmed}`, authSent);
    check("Test 15c control: the padded form would have been a different header",
      `Bearer ${padded}` !== `Bearer ${trimmed}`, [padded.length, trimmed.length]);
    check("Test 15c-ii: and no whitespace rides between the scheme and the token",
      authSent === authSent.trimEnd() && authSent.split(" ").length === 2, JSON.stringify(authSent.slice(0, 12)));
    check("Test 15d: the trimmed form is gone from the state the vendor receives",
      !body.state.includes(trimmed), body.state);
    check("Test 15e: and gone from the result the journal will read",
      r.resolved && r.value.ok === true && !r.value.state.includes(trimmed), r.value && r.value.state);
    check("Test 15f: the rest of the text stands", body.state === "worker echoed [key] into its log", body.state);
  }

  // --- Test 16: a state that is not a string cannot break the contract ---
  //
  // Every call site is typed, so this is unreachable from the plugin. It is
  // driven because the scrub is the first thing to reach into the state, and
  // this module's stated contract is that it never rejects.
  {
    const h = harness();
    h.setHttpResponse(response(200, okBody("controller_decision")));
    const r = await settle(askDefault(h, { state: { not: "a string" } }));
    check("Test 16a: an ordinary object state resolves rather than rejecting", r.resolved === true, r);

    // The half that matters. String() raises a TypeError on an object with a
    // null prototype, so a conversion written to survive a non-string would
    // throw on exactly the class it was for. This file builds null-prototype
    // objects deliberately, so the shape is native here rather than exotic.
    const hostile = Object.create(null);
    hostile.summary = "worker idle";
    let controlThrew = false;
    try { String(hostile); } catch { controlThrew = true; }
    check("Test 16b control: converting this value does throw outside the seam", controlThrew === true, controlThrew);
    const h2 = harness();
    h2.setHttpResponse(response(200, okBody("controller_decision")));
    const r2 = await settle(askDefault(h2, { state: hostile }));
    check("Test 16b: a null-prototype state resolves rather than rejecting", r2.resolved === true, r2);

    // An object whose toString throws is the same class by another route.
    const h3 = harness();
    h3.setHttpResponse(response(200, okBody("controller_decision")));
    const r3 = await settle(askDefault(h3, { state: { toString() { throw new Error("nope"); } } }));
    check("Test 16c: a state whose toString throws resolves rather than rejecting", r3.resolved === true, r3);
  }

  // --- Test 17: a probability key the request never offered is refused ---
  //
  // The response body is supplied by whoever answers the fetch op event, not
  // by the vendor alone. The map's keys were bounded per key and unbounded in
  // count, and an append rewrites the whole day's file, so one body carrying
  // a hundred thousand keys would grow that cost for every later line.
  {
    const offered = ["nudge", "wait"];
    const bodyWithKeys = (probabilities) => JSON.stringify({
      answers: { controller_decision: { type: "choice", choice: "nudge", probabilities, confidence: 0.7 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const h = harness();
    h.setHttpResponse(response(200, bodyWithKeys({ nudge: 0.8, wait: 0.2 })));
    const good = await settle(askDefault(h, { optionIds: offered }));
    check("Test 17a control: a body answering only the offered ids is accepted",
      good.resolved && good.value.ok === true, good.value && good.value.reason);

    const h2 = harness();
    h2.setHttpResponse(response(200, bodyWithKeys({ nudge: 0.8, wait: 0.1, switch: 0.1 })));
    const extra = await settle(askDefault(h2, { optionIds: offered }));
    check("Test 17b: an id that was never offered is refused as a parse failure",
      extra.resolved && extra.value.ok === false && extra.value.reason === "parse", extra.value);
    check("Test 17c: and the detail names what failed rather than quoting the body",
      typeof extra.value.detail === "string" && extra.value.detail.includes("not offered")
        && !extra.value.detail.includes("switch"), extra.value.detail);

    // The bound this buys, driven rather than argued: a body cannot make the
    // map larger than the set of ids the request carried.
    const flood = Object.create(null);
    for (let i = 0; i < 5000; i += 1) flood[`k${i}`] = 0.0001;
    const h3 = harness();
    h3.setHttpResponse(response(200, bodyWithKeys(flood)));
    const flooded = await settle(askDefault(h3, { optionIds: offered }));
    check("Test 17d: a flood of unoffered ids cannot reach a result",
      flooded.resolved && flooded.value.ok === false && flooded.value.reason === "parse", flooded.value && flooded.value.reason);
  }

  // Test 18: a host-supplied response is a hostile value, and every conversion
  // of one is guarded. Round 6 found the module guarding String(state), which
  // its own comment calls unreachable from a typed call site, while leaving
  // three reachable conversions of host-chosen values unguarded. A rejection
  // here is not a caught failure: Section 5 does not await the ask, so it
  // becomes an unhandled rejection and the call's journal line is never
  // written at all.
  {
    // A response object whose accessor throws. A lazily-read body is an
    // ordinary shape for a response wrapper, so this is not an exotic value.
    const h = harness();
    h.setHttpResponse(() => Promise.resolve({
      get status() { throw new Error("accessor exploded"); },
      get text() { throw new Error("accessor exploded"); },
      ok: true,
      headers: {},
    }));
    const thrown = await settle(askDefault(h));
    check("Test 18a: a response whose accessor throws resolves a closed failure rather than rejecting",
      thrown.resolved && thrown.value.ok === false && thrown.value.reason === "network",
      thrown.resolved ? thrown.value.reason : "REJECTED: " + String(thrown.err && thrown.err.message));

    // A status that is not a number takes the String(status) path, and a
    // null-prototype object is exactly what JSON.parse and this module's own
    // prototype-free maps produce. String() raises a TypeError on one.
    const h2 = harness();
    h2.setHttpResponse({ status: Object.create(null), ok: false, headers: {}, text: "" });
    const badStatus = await settle(askDefault(h2));
    check("Test 18b: a null-prototype status resolves http_other rather than rejecting",
      badStatus.resolved && badStatus.value.ok === false && badStatus.value.reason === "http_other",
      badStatus.resolved ? badStatus.value.reason : "REJECTED: " + String(badStatus.err && badStatus.err.message));

    // The same shape as a rejection value, which messageOf converts with String().
    const h3 = harness();
    h3.setHttpResponse(() => Promise.reject(Object.create(null)));
    const badErr = await settle(askDefault(h3));
    check("Test 18c: a null-prototype rejection value resolves network rather than rejecting",
      badErr.resolved && badErr.value.ok === false && badErr.value.reason === "network",
      badErr.resolved ? badErr.value.reason : "REJECTED: " + String(badErr.err && badErr.err.message));
  }

  // --- Test 19: one request carrying a Noul, a Score and a Choice over a structured state ---
  //
  // The three plan health questions ride one request. Each primitive's request
  // shape is the live contract's (https://docs.typesafe.ai/api.md): a Noul is
  // type and instructions with no criteria, a Score's criteria is the ordered
  // level array, a Choice's criteria is the option map. The state is an object
  // whose fields the instructions name, and it goes out as an object.
  const PLAN_CATALOG = {
    worker_blocked: { id: "worker_blocked", version: "v1", overrideRefused: null, primitive: "noul", instructions: "Is `closingText` a worker saying it is blocked?" },
    rounds_converging: { id: "rounds_converging", version: "v1", overrideRefused: null, primitive: "score", instructions: "Across `recentClosingTexts`, converging or reopening?", levels: ["closing", "steady", "reopening"] },
    block_owner: { id: "block_owner", version: "v2", overrideRefused: "reworded", primitive: "choice", instructions: "Who owns the block in `closingText`?", options: { operator: "the human", none: null } },
  };
  const planResolveCalls = [];
  const planResolve = async (id) => { planResolveCalls.push(id); return PLAN_CATALOG[id]; };
  const PLAN_ASKS = [
    { questionSetId: "worker_blocked", primitive: "noul" },
    { questionSetId: "rounds_converging", primitive: "score" },
    { questionSetId: "block_owner", primitive: "choice", optionIds: ["operator", "none"] },
  ];
  const PLAN_STATE = { closingText: "BLOCKED: waiting on the operator", recentClosingTexts: ["Did a thing.", "BLOCKED: waiting on the operator"] };
  function planAnswers(overrides = {}) {
    return {
      worker_blocked: { type: "noul", noul: 0.93 },
      rounds_converging: { type: "score", score: 1.4, legend: { "0": "closing", "1": "steady", "2": "reopening" }, probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 }, confidence: 0.4 },
      block_owner: { type: "choice", choice: "operator", probabilities: { operator: 0.9, none: 0.1 }, confidence: 0.85 },
      ...overrides,
    };
  }
  function planBody(overrides = {}, extra = {}) {
    return JSON.stringify({ model: "jev-1.13.0", answers: planAnswers(overrides), usage: { input_tokens: 400, output_tokens: 30 }, ...extra });
  }
  function askPlan(h, overrides = {}) {
    const a = { asks: PLAN_ASKS, state: PLAN_STATE, mode: "shadow", resolve: planResolve, ...overrides };
    return askAll(fakeHostOf(h), a.asks, a.state, a.mode, a.resolve);
  }
  {
    const h = harness();
    clock.set(T0);
    planResolveCalls.length = 0;
    h.setHttpResponse((url, init) => { clock.advance(41); return Promise.resolve(response(200, planBody())); });
    const r = await settle(askPlan(h));
    check("Test 19a: three questions in one request resolve ok", r.resolved && r.value.ok === true, r);
    check("Test 19b: exactly one request was sent", h.httpCalls.length === 1, h.httpCalls.length);
    const body = JSON.parse(h.httpCalls[0].init.body);
    check("Test 19c: the state rides as an object with the two named fields",
      typeof body.state === "object" && body.state !== null && !Array.isArray(body.state)
        && JSON.stringify(Object.keys(body.state)) === JSON.stringify(["closingText", "recentClosingTexts"]), body.state);
    check("Test 19d: the state's text and list fields ride unchanged",
      body.state.closingText === PLAN_STATE.closingText && JSON.stringify(body.state.recentClosingTexts) === JSON.stringify(PLAN_STATE.recentClosingTexts), body.state);
    check("Test 19e: the questions map holds the three ids in the asks' order",
      JSON.stringify(Object.keys(body.questions)) === JSON.stringify(["worker_blocked", "rounds_converging", "block_owner"]), Object.keys(body.questions));
    const noul = body.questions.worker_blocked;
    check("Test 19f: the Noul is type noul with its instructions and no criteria",
      JSON.stringify(Object.keys(noul).sort()) === JSON.stringify(["instructions", "type"]) && noul.type === "noul"
        && noul.instructions === PLAN_CATALOG.worker_blocked.instructions, noul);
    const score = body.questions.rounds_converging;
    check("Test 19g: the Score is type score with its levels as an ordered criteria array",
      score.type === "score" && Array.isArray(score.criteria) && JSON.stringify(score.criteria) === JSON.stringify(["closing", "steady", "reopening"])
        && score.instructions === PLAN_CATALOG.rounds_converging.instructions, score);
    const choice = body.questions.block_owner;
    check("Test 19h: the Choice is type choice with the ids in force as its criteria map",
      choice.type === "choice" && JSON.stringify(choice.criteria) === JSON.stringify({ operator: "the human", none: null }), choice);
    check("Test 19i: the model alias and the endpoint are the same as a single call's",
      body.model === JEV_MODEL && h.httpCalls[0].url === JEV_ENDPOINT, [body.model, h.httpCalls[0].url]);
    check("Test 19j: the result carries one validated answer per question, in order, each naming its primitive and set",
      r.value.answers.length === 3
        && r.value.answers.map((a) => a.primitive).join(",") === "noul,score,choice"
        && r.value.answers.map((a) => a.questionSetId).join(",") === "worker_blocked,rounds_converging,block_owner"
        && r.value.answers.map((a) => a.questionId).join(",") === "worker_blocked,rounds_converging,block_owner", r.value.answers);
    check("Test 19k: each answer carries its question's version and refusal reason",
      r.value.answers[2].questionVersion === "v2" && r.value.answers[2].overrideRefused === "reworded" && r.value.answers[0].questionVersion === "v1", r.value.answers);
    check("Test 19l: the Noul answer is the vendor's probability and nothing else",
      JSON.stringify(r.value.answers[0].answer) === JSON.stringify({ type: "noul", noul: 0.93 }), r.value.answers[0].answer);
    check("Test 19m: the Score answer carries score, probabilities by level number and confidence, and not the echoed legend",
      sameSet(Object.keys(r.value.answers[1].answer), ["type", "score", "probabilities", "confidence"])
        && r.value.answers[1].answer.score === 1.4 && r.value.answers[1].answer.probabilities["2"] === 0.5 && r.value.answers[1].answer.confidence === 0.4, r.value.answers[1].answer);
    check("Test 19n: the Choice answer is the four choice fields",
      sameSet(Object.keys(r.value.answers[2].answer), ["type", "choice", "probabilities", "confidence"]) && r.value.answers[2].answer.choice === "operator", r.value.answers[2].answer);
    check("Test 19o: usage, latency, model and the set ids ride the result",
      r.value.usage.input_tokens === 400 && r.value.usage.output_tokens === 30 && r.value.latencyMs === 41 && r.value.model === "jev-1.13.0"
        && JSON.stringify(r.value.questionSetIds) === JSON.stringify(["worker_blocked", "rounds_converging", "block_owner"]), r.value);
    check("Test 19p: the result's state is the JSON text of the object the vendor received",
      r.value.state === JSON.stringify(body.state), r.value.state);
    check("Test 19q: the resolver was asked once per set, in the asks' order",
      JSON.stringify(planResolveCalls) === JSON.stringify(["worker_blocked", "rounds_converging", "block_owner"]), planResolveCalls);

    // The key scrub over a structured state: every field, and every item of
    // a list field, leaves with the key removed, and the bytes the journal
    // reads are the bytes the vendor received.
    const leakyState = { closingText: `printed ${KEY} here`, recentClosingTexts: [`earlier ${KEY}`, "clean"] };
    check("Test 19r control: the driving state carries the key in a text field and in a list item",
      leakyState.closingText.includes(KEY) && leakyState.recentClosingTexts[0].includes(KEY));
    const h2 = harness();
    h2.setHttpResponse(response(200, planBody()));
    const r2 = await settle(askPlan(h2, { state: leakyState }));
    const sent2 = JSON.parse(h2.httpCalls[0].init.body).state;
    check("Test 19s: the key is gone from every field the vendor received",
      !h2.httpCalls[0].init.body.includes(KEY) && sent2.closingText === "printed [key] here" && sent2.recentClosingTexts[0] === "earlier [key]" && sent2.recentClosingTexts[1] === "clean", sent2);
    check("Test 19t: and the result's state is those same bytes",
      r2.resolved && r2.value.ok === true && r2.value.state === JSON.stringify(sent2) && !r2.value.state.includes(KEY), r2.value && r2.value.state);
    const h3 = harness();
    h3.setHttpResponse(response(500, ""));
    const r3 = await settle(askPlan(h3, { state: leakyState }));
    check("Test 19u: a failure past the key check carries the scrubbed structured state",
      r3.resolved && r3.value.ok === false && r3.value.reason === "http_other" && typeof r3.value.state === "string" && !r3.value.state.includes(KEY), r3.value);
  }

  // --- Test 20: the Noul answer is validated field by field ---
  {
    for (const [label, noul] of [["0, the no end", 0], ["1, the yes end", 1], ["a middle value", 0.5]]) {
      const h = harness();
      h.setHttpResponse(response(200, planBody({ worker_blocked: { type: "noul", noul } })));
      const r = await settle(askPlan(h));
      check(`Test 20a: a Noul of ${label} is accepted`, r.resolved && r.value.ok === true && r.value.answers[0].answer.noul === noul, r.value);
    }
    const bad = [
      ["a type other than noul", { type: "choice", noul: 0.5 }, "answer type is not noul"],
      ["no type", { noul: 0.5 }, "answer type is not noul"],
      ["no noul value", { type: "noul" }, "answer noul is not a finite number"],
      ["a string value", { type: "noul", noul: "0.5" }, "answer noul is not a finite number"],
      ["a value above 1", { type: "noul", noul: 1.5 }, "answer noul is outside 0 to 1"],
      ["a value below 0", { type: "noul", noul: -0.1 }, "answer noul is outside 0 to 1"],
      ["null", null, "no answer for worker_blocked"],
    ];
    for (const [label, answer, detail] of bad) {
      const h = harness();
      h.setHttpResponse(response(200, planBody({ worker_blocked: answer })));
      const r = await settle(askPlan(h));
      check(`Test 20b: a Noul answer with ${label} fails the whole call as parse (${detail})`,
        r.resolved && r.value.ok === false && r.value.reason === "parse" && r.value.detail === detail, r.value);
    }
    const h = harness();
    h.setHttpResponse(response(200, planBody({ worker_blocked: { type: "noul", noul: 0.2, confidence: 0.9, reasoning: "x" } })));
    const r = await settle(askPlan(h));
    check("Test 20c: fields the Noul shape does not name are dropped, confidence among them",
      r.resolved && r.value.ok === true && JSON.stringify(Object.keys(r.value.answers[0].answer)) === JSON.stringify(["type", "noul"]), r.value.answers[0].answer);
  }

  // --- Test 21: the Score answer is validated against the levels that were sent ---
  {
    for (const [label, score] of [["0, the lowest level", 0], ["2, the highest level", 2], ["1.43, between levels", 1.43]]) {
      const h = harness();
      h.setHttpResponse(response(200, planBody({ rounds_converging: { type: "score", score, probabilities: { "0": 0.3, "1": 0.3, "2": 0.4 }, confidence: 0.3 } })));
      const r = await settle(askPlan(h));
      check(`Test 21a: a Score of ${label} is accepted`, r.resolved && r.value.ok === true && r.value.answers[1].answer.score === score, r.value);
    }
    const valid = { type: "score", score: 1, probabilities: { "0": 0, "1": 1, "2": 0 }, confidence: 1 };
    const bad = [
      ["a type other than score", { ...valid, type: "choice" }, "answer type is not score"],
      ["no score", { type: "score", probabilities: {}, confidence: 1 }, "answer score is not a finite number"],
      ["a string score", { ...valid, score: "1" }, "answer score is not a finite number"],
      ["a score above the top level", { ...valid, score: 2.5 }, "answer score is outside the levels that were sent"],
      ["a negative score", { ...valid, score: -1 }, "answer score is outside the levels that were sent"],
      ["no probabilities", { type: "score", score: 1, confidence: 1 }, "answer probabilities is not an object"],
      ["probabilities that is an array", { ...valid, probabilities: [0, 1, 0] }, "answer probabilities is not an object"],
      ["a level number that was not sent", { ...valid, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } }, "answer probabilities carry a level that was not sent"],
      ["a level keyed by its text rather than its number", { ...valid, probabilities: { steady: 1 } }, "answer probabilities carry a level that was not sent"],
      ["a probability that is a string", { ...valid, probabilities: { "1": "1" } }, "answer probabilities carry a value that is not a finite number"],
      ["a probability above 1", { ...valid, probabilities: { "1": 7 } }, "answer probabilities carry a value that is outside 0 to 1"],
      ["a probability below 0", { ...valid, probabilities: { "1": -0.1 } }, "answer probabilities carry a value that is outside 0 to 1"],
      ["no confidence", { type: "score", score: 1, probabilities: { "1": 1 } }, "answer confidence is not a finite number"],
    ];
    for (const [label, answer, detail] of bad) {
      const h = harness();
      h.setHttpResponse(response(200, planBody({ rounds_converging: answer })));
      const r = await settle(askPlan(h));
      check(`Test 21b: a Score answer with ${label} fails the whole call as parse (${detail})`,
        r.resolved && r.value.ok === false && r.value.reason === "parse" && r.value.detail === detail, r.value);
    }
    // The bound a level check buys: a body cannot make the map larger than
    // the levels the request carried.
    const flood = Object.create(null);
    for (let i = 0; i < 5000; i += 1) flood[String(i)] = 0.0002;
    const h = harness();
    h.setHttpResponse(response(200, planBody({ rounds_converging: { ...valid, probabilities: flood } })));
    const r = await settle(askPlan(h));
    check("Test 21c: a flood of level numbers beyond the sent levels cannot reach a result",
      r.resolved && r.value.ok === false && r.value.reason === "parse", r.value && r.value.reason);
    // Prototype-free, the inbound half of the channel as for a choice.
    const h2 = harness();
    const protoBody = planBody().replace('"probabilities":{"0":0.1,"1":0.4,"2":0.5}', '"probabilities":{"0":0.1,"1":0.4,"2":0.5,"__proto__":0}');
    check("Test 21d control: the hand-built body does carry the prototype key", protoBody.includes('"__proto__":0'));
    h2.setHttpResponse(response(200, protoBody));
    const r2 = await settle(askPlan(h2));
    check("Test 21d: a level key naming the prototype is refused as a level that was not sent rather than swallowed",
      r2.resolved && r2.value.ok === false && r2.value.detail === "answer probabilities carry a level that was not sent", r2.value);
  }

  // --- Test 22: a whole call fails on any one question, and the resolver is checked per primitive ---
  {
    const h = harness();
    const { block_owner, ...twoAnswers } = planAnswers();
    h.setHttpResponse(response(200, JSON.stringify({ answers: twoAnswers, usage: {} })));
    const r = await settle(askPlan(h));
    check("Test 22a: a body answering two of three questions fails as parse naming the missing one, carrying no answers",
      r.resolved && r.value.ok === false && r.value.reason === "parse" && r.value.detail === "no answer for block_owner" && !("answers" in r.value), r.value);
    const h2 = harness();
    h2.setHttpResponse(response(200, planBody({ block_owner: { type: "choice", choice: "coordinator", probabilities: {}, confidence: 1 } })));
    const r2 = await settle(askPlan(h2));
    check("Test 22b: a malformed third answer fails the whole call with the choice validator's own detail",
      r2.resolved && r2.value.ok === false && r2.value.reason === "parse" && r2.value.detail === "answer choice is not an offered option", r2.value);

    const shapes = [
      ["a choice where a noul was asked", { worker_blocked: { ...PLAN_CATALOG.block_owner, id: "worker_blocked" } }, "resolved question is not a noul"],
      ["a noul where a score was asked", { rounds_converging: { ...PLAN_CATALOG.worker_blocked, id: "rounds_converging" } }, "resolved question is not a score"],
      ["a noul where a choice was asked", { block_owner: { ...PLAN_CATALOG.worker_blocked, id: "block_owner" } }, "resolved question is not a choice"],
      ["a score with no levels", { rounds_converging: { ...PLAN_CATALOG.rounds_converging, levels: undefined } }, "resolved question has no levels"],
      ["a score with one level", { rounds_converging: { ...PLAN_CATALOG.rounds_converging, levels: ["only"] } }, "resolved question has fewer than 2 or more than 10 levels"],
      ["a score with eleven levels", { rounds_converging: { ...PLAN_CATALOG.rounds_converging, levels: Array.from({ length: 11 }, (_, i) => `level ${i}`) } }, "resolved question has fewer than 2 or more than 10 levels"],
      ["a score with a level that is not a string", { rounds_converging: { ...PLAN_CATALOG.rounds_converging, levels: ["a", 2, "c"] } }, "resolved question has a level that is not a non-empty string"],
      ["a score with an empty level", { rounds_converging: { ...PLAN_CATALOG.rounds_converging, levels: ["a", "  ", "c"] } }, "resolved question has a level that is not a non-empty string"],
    ];
    for (const [label, patch, detail] of shapes) {
      const h3 = harness();
      h3.setHttpResponse(response(200, planBody()));
      const r3 = await settle(askPlan(h3, { resolve: async (id) => ({ ...PLAN_CATALOG, ...patch })[id] }));
      check(`Test 22c: a resolver returning ${label} is no_question (${detail}) and no request is sent`,
        r3.resolved && r3.value.ok === false && r3.value.reason === "no_question" && r3.value.detail === detail && h3.httpCalls.length === 0, r3.value);
    }
    const h4 = harness();
    h4.setHttpResponse(response(200, planBody()));
    const r4 = await settle(askPlan(h4, { resolve: async (id) => ({ ...PLAN_CATALOG, rounds_converging: { ...PLAN_CATALOG.rounds_converging, levels: ["low", "high"] } })[id] }));
    check("Test 22c control: a score with exactly two levels is admitted and sent",
      r4.resolved && h4.httpCalls.length === 1 && JSON.parse(h4.httpCalls[0].init.body).questions.rounds_converging.criteria.length === 2, r4.value && r4.value.reason);
    // The single-question entry point refuses the same way, and still names
    // its own primitive.
    const h5 = harness();
    const r5 = await settle(askDefault(h5, { resolve: async () => ({ ...CATALOG.controller_decision, primitive: "score", levels: ["a", "b"] }) }));
    check("Test 22d: ask refuses a score where its choice was asked, with the same detail shape",
      r5.resolved && r5.value.ok === false && r5.value.reason === "no_question" && r5.value.detail === "resolved question is not a choice", r5.value);
  }

  // --- Test 23: every way a set call ends short of an answer resolves with the set failure shape ---
  {
    const fields = ["ok", "reason", "detail", "questionSetIds", "latencyMs", "state"];
    const drivers = {
      off: (h) => askPlan(h, { mode: "off" }),
      no_key: (h) => { h.setEnv("TYPESAFE_API_KEY", ""); return askPlan(h); },
      no_question: (h) => askPlan(h, { resolve: () => Promise.reject(new Error("catalog unreadable")) }),
      timeout: (h) => { h.setHttpResponse(() => new Promise(() => {})); const p = askPlan(h); setImmediate(() => h.fireSleep()); return p; },
      network: (h) => { h.setHttpResponse(() => Promise.reject(new Error("down"))); return askPlan(h); },
      http_401: (h) => { h.setHttpResponse(response(401, "")); return askPlan(h); },
      http_422: (h) => { h.setHttpResponse(response(422, "")); return askPlan(h); },
      http_429: (h) => { h.setHttpResponse(response(429, "")); return askPlan(h); },
      http_529: (h) => { h.setHttpResponse(response(529, "")); return askPlan(h); },
      http_other: (h) => { h.setHttpResponse(response(500, "")); return askPlan(h); },
      parse: (h) => { h.setHttpResponse(response(200, "nope")); return askPlan(h); },
    };
    check("Test 23: a driver exists for every reason in the closed set", sameSet(Object.keys(drivers), SEAM_FAILURE_REASONS), Object.keys(drivers));
    for (const reason of SEAM_FAILURE_REASONS) {
      const h = harness();
      const r = await settle(drivers[reason](h));
      check(`Test 23: set reason ${reason} resolves without a throw with every set failure field present and the set ids`,
        r.resolved && r.value.ok === false && r.value.reason === reason && sameSet(Object.keys(r.value), fields)
          && JSON.stringify(r.value.questionSetIds) === JSON.stringify(["worker_blocked", "rounds_converging", "block_owner"]), r);
      if (reason === "off" || reason === "no_key") {
        check(`Test 23: set reason ${reason} carries no state and sent nothing`, r.value.state === null && h.httpCalls.length === 0, r.value);
      } else {
        check(`Test 23: set reason ${reason} carries the scrubbed state as text`, typeof r.value.state === "string" && r.value.state.includes("closingText"), r.value.state);
      }
    }
    const h = harness();
    h.setHttpResponse(() => new Promise(() => {}));
    const p = askPlan(h);
    await new Promise((res) => setImmediate(res));
    check("Test 23: one timer of SHADOW_TIMEOUT_MS guards the whole set request", h.sleeps.length === 1 && h.sleeps[0].ms === SHADOW_TIMEOUT_MS, h.sleeps.map((s) => s.ms));
    h.fireSleep();
    const r = await settle(p);
    check("Test 23: the timer winning resolves the set call as timeout", r.resolved && r.value.ok === false && r.value.reason === "timeout", r.value);
  }
} finally {
  clock.restore();
}

// Give any rejection the last case left behind one turn of the loop to surface.
await new Promise((res) => setImmediate(res));
check("Final: no unhandled rejection surfaced during the suite", unhandled.length === 0, unhandled.map(String));

const summary = `\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`;
console.log(summary);
process.exit(failed === 0 ? 0 : 1);
