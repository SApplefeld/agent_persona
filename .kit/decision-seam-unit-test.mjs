#!/usr/bin/env node
// Decision seam unit tests: every closed failure reason resolves without a
// throw, the kill switch sends nothing, the timeout race settles cleanly, and
// the one request the seam sends carries the live contract's shape.
//
// Drives hooks/decision-seam.ts through a SeamHost built over the
// tick-harness fake $ (its http, env and clock.sleep fakes), the way
// hooks/index.ts builds one over the real $ in a top-level adapter, with
// Date.now stubbed so latency is a number the case chose rather than a
// wall-clock reading. The catalog resolver is a stub here, typed against the
// interface hooks/question-catalog.ts exports.
//
// Usage: node decision-seam-unit-test.mjs
// Exits 0 on success, 1 on failure.

import { createFake$, stubDateNow } from "./tick-harness.mjs";

const {
  ask,
  JEV_ENDPOINT,
  JEV_MODEL,
  SHADOW_TIMEOUT_MS,
  SEAM_FAILURE_REASONS,
} = await import("../hooks/decision-seam.ts");

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name, detail) {
  console.error(`  FAIL: ${name}`);
  if (detail !== undefined) console.error(`        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  failed++;
}
function check(name, cond, detail) { if (cond) ok(name); else fail(name, detail); }

// An unhandled rejection anywhere in this process is a failure of the
// "never throws, and the race's loser is handled" contract, so it is
// counted here and asserted at the end, after the loop has had a turn to
// surface any the last case left behind.
const unhandled = [];
process.on("unhandledRejection", (reason) => { unhandled.push(reason); });

const KEY = "sk-test-not-a-real-key";
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

// The host hooks/index.ts builds over $ in its adapter, built here over the
// fake $. Each closure reads the fake at call time, so a case that replaces
// h.fake.http.fetch or h.fake.clock.sleep after this is still what the seam
// reaches.
function hostOf(h) {
  return {
    getApiKey: () => h.fake.env.get("TYPESAFE_API_KEY"),
    fetch: (url, init) => h.fake.http.fetch(url, init),
    sleep: (ms) => h.fake.clock.sleep(ms),
  };
}

function okBody(questionId, choice = "nudge") {
  return JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      [questionId]: { type: "choice", choice, probabilities: { nudge: 0.7, wait: 0.2, switch: 0.1 }, confidence: 0.55 },
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
    ...overrides,
  };
  return ask(hostOf(h), a.questionSetId, a.optionIds, a.state, a.mode, a.haikuValue, resolveStub);
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
  // --- Test 1: the closed reason set is exactly the spec's ten ---
  {
    const expected = ["off", "no_key", "timeout", "network", "http_401", "http_422", "http_429", "http_529", "http_other", "parse"];
    check("Test 1: SEAM_FAILURE_REASONS is the closed set of ten, in the spec's order",
      JSON.stringify(SEAM_FAILURE_REASONS) === JSON.stringify(expected), SEAM_FAILURE_REASONS);
  }

  // --- Test 2: mode "off" sends nothing, reads nothing, resolves nothing ---
  {
    const h = harness();
    const r = await settle(askDefault(h, { mode: "off" }));
    check("Test 2a: mode off resolves (no throw) with reason off",
      r.resolved && r.value.ok === false && r.value.reason === "off", r);
    check("Test 2b: mode off makes no request", h.httpCalls.length === 0, h.httpCalls);
    check("Test 2c: mode off reads no environment variable", h.envGets.length === 0, h.envGets);
    check("Test 2d: mode off resolves no question", resolveCalls.length === 0, resolveCalls);
    check("Test 2e: mode off carries no latency and no question", r.value.latencyMs === null && r.value.questionId === null, r.value);
    check("Test 2f: mode off carries Haiku's value through", r.value.haikuValue === "nudge", r.value);
  }

  // --- Test 3: every unrecognized mode is off, the exact string alone is shadow ---
  {
    for (const mode of ["Shadow", "shadow ", " shadow", "live", "on", "", "SHADOW", "shadows"]) {
      const h = harness();
      const r = await settle(askDefault(h, { mode }));
      check(`Test 3: mode ${JSON.stringify(mode)} is off and makes no request`,
        r.resolved && r.value.ok === false && r.value.reason === "off" && h.httpCalls.length === 0 && h.envGets.length === 0, r);
    }
    const h = harness();
    h.setHttpResponse(response(200, okBody("controller_decision")));
    const r = await settle(askDefault(h, { mode: "shadow" }));
    check("Test 3 control: the exact string shadow makes the request", r.resolved && r.value.ok === true && h.httpCalls.length === 1, r);
  }

  // --- Test 4: no key sends nothing ---
  {
    for (const [label, key] of [["absent", null], ["empty string", ""]]) {
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
      call.init.headers.Authorization === `Bearer ${KEY}` && call.init.headers["Content-Type"] === "application/json", call.init.headers);
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
      r.value.answers.controller_decision.choice === "nudge"
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
    const h2 = harness();
    h2.setHttpResponse(response(204, okBody("controller_decision")));
    const r2 = await settle(askDefault(h2));
    check("Test 7 control: any 2xx is read as success", r2.resolved && r2.value.ok === true, r2);
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
  }

  // --- Test 11: every failure result carries the same field set, and no failure throws ---
  {
    const fields = ["ok", "reason", "detail", "questionSetId", "questionId", "questionVersion", "overrideRefused", "latencyMs", "haikuValue"];
    const seen = new Set();
    const drivers = {
      off: (h) => askDefault(h, { mode: "off" }),
      no_key: (h) => { h.setEnv("TYPESAFE_API_KEY", ""); return askDefault(h); },
      timeout: (h) => { h.setHttpResponse(() => new Promise(() => {})); const p = askDefault(h); setImmediate(() => h.fireSleep()); return p; },
      network: (h) => { h.setHttpResponse(() => Promise.reject(new Error("down"))); return askDefault(h); },
      http_401: (h) => { h.setHttpResponse(response(401, "")); return askDefault(h); },
      http_422: (h) => { h.setHttpResponse(response(422, "")); return askDefault(h); },
      http_429: (h) => { h.setHttpResponse(response(429, "")); return askDefault(h); },
      http_529: (h) => { h.setHttpResponse(response(529, "")); return askDefault(h); },
      http_other: (h) => { h.setHttpResponse(response(500, "")); return askDefault(h); },
      parse: (h) => { h.setHttpResponse(response(200, "nope")); return askDefault(h); },
    };
    for (const reason of SEAM_FAILURE_REASONS) {
      const h = harness();
      const r = await settle(drivers[reason](h));
      seen.add(r.resolved ? r.value.reason : "THREW");
      check(`Test 11: reason ${reason} resolves without a throw with every failure field present`,
        r.resolved && r.value.ok === false && r.value.reason === reason
          && JSON.stringify(Object.keys(r.value)) === JSON.stringify(fields), r);
    }
    check("Test 11: every reason in the closed set was driven", SEAM_FAILURE_REASONS.every((x) => seen.has(x)), [...seen]);
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
