#!/usr/bin/env node
// Question catalog unit tests: the label arrays the three classify sites pass
// to Haiku are the arrays this catalog ships, each fixed set's option ids are
// exactly its label constant's superset, a valid override resolves with its
// own version label, every refusal falls back to the shipped default naming
// the rule that refused it, and a refused override's wording never reaches a
// request.
//
// Drives hooks/question-catalog.ts through the fake PluginHost tick-harness
// builds over its fake $ (fakeHostOf), the way hooks/index.ts builds one over
// the real $ in its top-level hostOf. The harness fs fake is keyed on the raw
// path string with no directory model, so an absolute override path under a
// fake home reads here the way it does on the engine.
//
// The end-to-end cases drive hooks/decision-seam.ts with this catalog's own
// resolver rather than a stub, which is the only way to see that the request
// carries the shipped wording when an override was refused.
//
// A failure detail printed by this runner never carries a header object or a
// request list: a red run prints names and counts, so no bearer value can
// reach a log even from a test that failed.
//
// Usage: node question-catalog-unit-test.mjs
// Exits 0 on success, 1 on failure.

import { createFake$, fakeHostOf } from "./tick-harness.mjs";

const catalog = await import("../hooks/question-catalog.ts");
const {
  CONTROLLER_LABELS,
  CONTROLLER_LABELS_WITH_SWITCH,
  SCORER_LABELS,
  SCORER_LABELS_AFTER_NUDGE,
  MEMORY_KIND_LABELS,
  CONTROLLER_DECISION,
  PLAN_SWITCH,
  TURN_SCORE,
  MEMORY_KIND,
  QUESTION_SET_IDS,
  FIXED_OPTION_SETS,
  SHIPPED_QUESTIONS,
  SHIPPED_VERSION,
  MIN_OPTIONS,
  MAX_OPTIONS,
  MIN_LEVELS,
  MAX_LEVELS,
  WORKER_BLOCKED,
  ROUNDS_CONVERGING,
  BLOCK_OWNER,
  BLOCK_OWNER_OPTIONS,
  PLAN_HEALTH_SET_IDS,
  FIXED_LEVEL_SETS,
  OVERRIDE_DIR,
  resolverOf,
} = catalog;

const { ask, askAll } = await import("../hooks/decision-seam.ts");

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

// The resolver's contract is that it never rejects, so an unhandled rejection
// anywhere in this process is a failure of it.
const unhandled = [];
process.on("unhandledRejection", (reason) => { unhandled.push(reason); });

const HOME = "C:/Users/Fake";
const KEY = "sk-test-not-a-real-key";
const STATE = "worker idle 3 ticks; last turn scored on-goal";

function dirOf(questionId) { return `${HOME}/${OVERRIDE_DIR}/${questionId}`; }
function activePathOf(questionId) { return `${dirOf(questionId)}/active.json`; }
function versionPathOf(questionId, version) { return `${dirOf(questionId)}/${version}.json`; }

// One fresh fake per case. The home is set unless a case unsets it, and the
// key is set so the seam-driven cases reach a request.
function harness(opts = {}) {
  const h = createFake$();
  if (opts.home !== null) h.setEnv("USERPROFILE", opts.home === undefined ? HOME : opts.home);
  h.setEnv("TYPESAFE_API_KEY", KEY);
  return h;
}

// Writes an active.json and the version file it names, each as given. A value
// that is already a string is written verbatim, so a case can plant text that
// is not JSON at all.
function plant(h, questionId, version, body) {
  if (version !== null) {
    h.fsMap.set(activePathOf(questionId), typeof version === "string" ? JSON.stringify({ version }) : version);
  }
  if (body !== undefined) {
    const path = versionPathOf(questionId, typeof version === "string" ? version : "v2");
    h.fsMap.set(path, typeof body === "string" ? body : JSON.stringify(body));
  }
}

async function settle(p) {
  try {
    return { resolved: true, value: await p };
  } catch (err) {
    return { resolved: false, err };
  }
}

const VALID_CONTROLLER_OVERRIDE = {
  primitive: "choice",
  instructions: "OVERRIDE: which action should the controller take?",
  options: {
    "nudge": "override nudge",
    "pause": "override pause",
    "complete": "override complete",
    "ask-operator": "override ask-operator",
    "switch": "override switch",
  },
};

// --- Test 1: the label arrays are the values and the order the sites ship ---
{
  check("Test 1a: CONTROLLER_LABELS is the four-label variant in order",
    JSON.stringify(CONTROLLER_LABELS) === JSON.stringify(["nudge", "pause", "complete", "ask-operator"]), CONTROLLER_LABELS);
  check("Test 1b: CONTROLLER_LABELS_WITH_SWITCH is the superset in order",
    JSON.stringify(CONTROLLER_LABELS_WITH_SWITCH) === JSON.stringify(["nudge", "pause", "complete", "ask-operator", "switch"]), CONTROLLER_LABELS_WITH_SWITCH);
  check("Test 1c: SCORER_LABELS_AFTER_NUDGE is the three-label variant in order",
    JSON.stringify(SCORER_LABELS_AFTER_NUDGE) === JSON.stringify(["on-goal", "drift", "complete"]), SCORER_LABELS_AFTER_NUDGE);
  check("Test 1d: SCORER_LABELS is the superset in order",
    JSON.stringify(SCORER_LABELS) === JSON.stringify(["on-goal", "off-goal-by-instruction", "drift", "complete"]), SCORER_LABELS);
  check("Test 1e: MEMORY_KIND_LABELS is the memory gate's four labels in order",
    JSON.stringify(MEMORY_KIND_LABELS) === JSON.stringify(["fact", "preference", "lesson", "discard"]), MEMORY_KIND_LABELS);
  check("Test 1f: each variant is a subset of its superset",
    CONTROLLER_LABELS.every((x) => CONTROLLER_LABELS_WITH_SWITCH.includes(x))
      && SCORER_LABELS_AFTER_NUDGE.every((x) => SCORER_LABELS.includes(x)));

  // The freeze has already been removed once with this suite green, which is
  // why it is pinned rather than trusted. Each classify site passes one shared
  // constant now instead of a fresh literal per call, and the classify call is
  // an op event that hands its labels to any co-loaded hook, so an unfrozen
  // array is corruptible for the process lifetime rather than for one call.
  const frozen = [
    ["CONTROLLER_LABELS", CONTROLLER_LABELS],
    ["CONTROLLER_LABELS_WITH_SWITCH", CONTROLLER_LABELS_WITH_SWITCH],
    ["SCORER_LABELS", SCORER_LABELS],
    ["SCORER_LABELS_AFTER_NUDGE", SCORER_LABELS_AFTER_NUDGE],
    ["MEMORY_KIND_LABELS", MEMORY_KIND_LABELS],
    ["QUESTION_SET_IDS", QUESTION_SET_IDS],
    ["FIXED_OPTION_SETS", FIXED_OPTION_SETS],
  ];
  for (const [name, arr] of frozen) {
    check(`Test 1g: ${name} is frozen`, Object.isFrozen(arr), name);
  }
}

// --- Test 2: the option-id pin, the check a drifting catalog fails ---
{
  check("Test 2a: the seven question set ids are the ones the catalog exports",
    sameSet(QUESTION_SET_IDS, [CONTROLLER_DECISION, PLAN_SWITCH, TURN_SCORE, MEMORY_KIND, WORKER_BLOCKED, ROUNDS_CONVERGING, BLOCK_OWNER])
      && QUESTION_SET_IDS.length === 7, QUESTION_SET_IDS);
  check("Test 2a: the three plan health sets are the noul, the score and the choice, in the request's order",
    JSON.stringify(PLAN_HEALTH_SET_IDS) === JSON.stringify([WORKER_BLOCKED, ROUNDS_CONVERGING, BLOCK_OWNER]), PLAN_HEALTH_SET_IDS);
  check("Test 2b: every question set id has a shipped default",
    QUESTION_SET_IDS.every((id) => SHIPPED_QUESTIONS[id] !== undefined), Object.keys(SHIPPED_QUESTIONS));
  check("Test 2c: no shipped default exists that no id names",
    sameSet(Object.keys(SHIPPED_QUESTIONS), QUESTION_SET_IDS), Object.keys(SHIPPED_QUESTIONS));
  // The pin itself, one per fixed set, against the label constant the classify
  // site passes to Haiku.
  const pins = [
    [CONTROLLER_DECISION, CONTROLLER_LABELS_WITH_SWITCH],
    [TURN_SCORE, SCORER_LABELS],
    [MEMORY_KIND, MEMORY_KIND_LABELS],
    // The block owner has no Haiku label array; its constant is the caller's
    // one source of the ids it offers, pinned here the same way.
    [BLOCK_OWNER, BLOCK_OWNER_OPTIONS],
  ];
  check("Test 2d: the pinned sets are exactly the catalog's fixed sets", sameSet(pins.map(([id]) => id), FIXED_OPTION_SETS), FIXED_OPTION_SETS);
  for (const [id, labels] of pins) {
    check(`Test 2e: ${id}'s option ids are exactly its label constant's superset`,
      sameSet(Object.keys(SHIPPED_QUESTIONS[id].options), labels), Object.keys(SHIPPED_QUESTIONS[id].options));
    check(`Test 2f: every ${id} option carries a description`,
      Object.values(SHIPPED_QUESTIONS[id].options).every((d) => typeof d === "string" && d.length > 0), Object.keys(SHIPPED_QUESTIONS[id].options));
  }
  check("Test 2g: the plan switch is not pinned and ships only no_match, its other ids being the caller's",
    !FIXED_OPTION_SETS.includes(PLAN_SWITCH) && sameSet(Object.keys(SHIPPED_QUESTIONS[PLAN_SWITCH].options), ["no_match"]),
    Object.keys(SHIPPED_QUESTIONS[PLAN_SWITCH].options));
  for (const id of QUESTION_SET_IDS) {
    const q = SHIPPED_QUESTIONS[id];
    check(`Test 2h: ${id} ships the shape the seam validates`,
      q.id === id && q.version === SHIPPED_VERSION && q.overrideRefused === null
        && q.primitive === (id === WORKER_BLOCKED ? "noul" : id === ROUNDS_CONVERGING ? "score" : "choice")
        && typeof q.instructions === "string" && q.instructions.trim().length > 0, id);
  }
  check("Test 2i: the upper option bound is the vendor's and the lower is this catalog's",
    MIN_OPTIONS === 2 && MAX_OPTIONS === 255, [MIN_OPTIONS, MAX_OPTIONS]);
}

// --- Test 3: no override at all resolves to the shipped default, no reason ---
{
  const h = harness();
  const resolve = resolverOf(fakeHostOf(h));
  for (const id of QUESTION_SET_IDS) {
    const r = await settle(resolve(id));
    check(`Test 3: ${id} with no active.json resolves to the shipped default with no refusal reason`,
      r.resolved && r.value.id === id && r.value.version === SHIPPED_VERSION && r.value.overrideRefused === null
        && r.value.instructions === SHIPPED_QUESTIONS[id].instructions, r);
  }
}

// --- Test 4: a valid override resolves with its own version label ---
{
  const h = harness();
  plant(h, CONTROLLER_DECISION, "v7", VALID_CONTROLLER_OVERRIDE);
  const r = await settle(resolverOf(fakeHostOf(h))(CONTROLLER_DECISION));
  check("Test 4a: a valid override resolves with the version label active.json named",
    r.resolved && r.value.version === "v7" && r.value.overrideRefused === null, r);
  check("Test 4b: the override's instructions and descriptions replace the shipped ones",
    r.resolved && r.value.instructions === VALID_CONTROLLER_OVERRIDE.instructions && r.value.options.nudge === "override nudge", r.value && r.value.version);
  check("Test 4c: the resolved question keeps the catalog's id and primitive",
    r.resolved && r.value.id === CONTROLLER_DECISION && r.value.primitive === "choice", r.value && r.value.id);
  check("Test 4d: an option description of null is admitted", await (async () => {
    const h2 = harness();
    plant(h2, MEMORY_KIND, "v2", {
      primitive: "choice",
      instructions: "override memory gate",
      options: { fact: null, preference: null, lesson: null, discard: null },
    });
    const r2 = await settle(resolverOf(fakeHostOf(h2))(MEMORY_KIND));
    return r2.resolved && r2.value.overrideRefused === null && r2.value.options.fact === null;
  })());
  // Order is free: an override that reorders a fixed set's options is admitted,
  // because order carries no meaning to a Choice.
  const h3 = harness();
  plant(h3, TURN_SCORE, "v2", {
    primitive: "choice",
    instructions: "override scorer",
    options: { complete: "d", drift: "c", "off-goal-by-instruction": "b", "on-goal": "a" },
  });
  const r3 = await settle(resolverOf(fakeHostOf(h3))(TURN_SCORE));
  check("Test 4e: an override that reorders a fixed set's option ids is admitted",
    r3.resolved && r3.value.overrideRefused === null && r3.value.version === "v2", r3);
  // The shipped default is shared, so a resolved override must not have
  // written itself onto it.
  const r4 = await settle(resolverOf(fakeHostOf(harness()))(CONTROLLER_DECISION));
  check("Test 4f: resolving an override leaves the shipped default untouched for the next call",
    r4.resolved && r4.value.version === SHIPPED_VERSION && r4.value.instructions === SHIPPED_QUESTIONS[CONTROLLER_DECISION].instructions
      && SHIPPED_QUESTIONS[CONTROLLER_DECISION].overrideRefused === null, r4);
}

// --- Test 5: every refusal falls back to the shipped default, naming its rule ---
//
// Each case asserts the reason string rather than only the fallback: five
// different rules end in the same shipped default, so a case that checked only
// the fallback would pass for the wrong rule.
{
  const refusals = [
    ["active.json is not JSON", "active.json is not JSON", (h) => {
      h.fsMap.set(activePathOf(CONTROLLER_DECISION), "<html>not json</html>");
    }],
    ["active.json is a JSON scalar", "active.json names no version", (h) => {
      h.fsMap.set(activePathOf(CONTROLLER_DECISION), "42");
    }],
    ["active.json carries no version field", "active.json names no version", (h) => {
      h.fsMap.set(activePathOf(CONTROLLER_DECISION), JSON.stringify({ active: "v2" }));
    }],
    ["active.json's version is not a string", "active.json names no version", (h) => {
      h.fsMap.set(activePathOf(CONTROLLER_DECISION), JSON.stringify({ version: 2 }));
    }],
    ["active.json's version is not a v<N> label", "active.json names no v<N> version label", (h) => {
      h.fsMap.set(activePathOf(CONTROLLER_DECISION), JSON.stringify({ version: "latest" }));
    }],
    ["active.json's version tries to traverse out of the directory", "active.json names no v<N> version label", (h) => {
      h.fsMap.set(activePathOf(CONTROLLER_DECISION), JSON.stringify({ version: "../../../secrets" }));
      // The withheld control. joined(dir, "../../../secrets.json") builds this
      // exact key and the fs fake has no directory model, so a valid override
      // sits at the traversal target and is reachable the moment VERSION_LABEL
      // stops refusing. Without it the case cannot tell the guard working from
      // nothing having been planted.
      h.fsMap.set(`${dirOf(CONTROLLER_DECISION)}/../../../secrets.json`, JSON.stringify(VALID_CONTROLLER_OVERRIDE));
    }],
    ["the named version file is missing", "the named version file is missing", (h) => {
      h.fsMap.set(activePathOf(CONTROLLER_DECISION), JSON.stringify({ version: "v9" }));
    }],
    ["the version file is not JSON", "the version file is not JSON", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", "{ not json");
    }],
    ["the version file is a JSON scalar", "the version file is not an object", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", "\"a string\"");
    }],
    ["the version file is an array", "the version file is not an object", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", "[]");
    }],
    ["the primitive is not choice", "the override is not a choice", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, primitive: "noul" });
    }],
    ["the primitive is absent", "the override is not a choice", (h) => {
      const { primitive, ...rest } = VALID_CONTROLLER_OVERRIDE;
      plant(h, CONTROLLER_DECISION, "v2", rest);
    }],
    ["the instruction is empty", "the override has an empty instruction", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, instructions: "" });
    }],
    ["the instruction is whitespace only", "the override has an empty instruction", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, instructions: "   \n\t " });
    }],
    ["the instruction is not a string", "the override has an empty instruction", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, instructions: { text: "x" } });
    }],
    ["there is no options map", "the override has no options map", (h) => {
      const { options, ...rest } = VALID_CONTROLLER_OVERRIDE;
      plant(h, CONTROLLER_DECISION, "v2", rest);
    }],
    ["options is an array", "the override has no options map", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, options: ["nudge", "pause"] });
    }],
    ["an option description is a number", "the override has an option description that is not a string or null", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, options: { ...VALID_CONTROLLER_OVERRIDE.options, nudge: 1 } });
    }],
    ["there is one option", `the override has fewer than ${MIN_OPTIONS} options`, (h) => {
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, options: { nudge: "only one" } });
    }],
    ["there are no options", `the override has fewer than ${MIN_OPTIONS} options`, (h) => {
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, options: {} });
    }],
    ["there are more than 255 options", `the override has more than ${MAX_OPTIONS} options`, (h) => {
      const options = {};
      for (let i = 0; i < MAX_OPTIONS + 1; i++) options[`opt-${i}`] = `option ${i}`;
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, options });
    }],
    ["a fixed set's override drops an option id", "the override's option ids differ from the shipped set", (h) => {
      const { switch: dropped, ...options } = VALID_CONTROLLER_OVERRIDE.options;
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, options });
    }],
    ["a fixed set's override adds an option id", "the override's option ids differ from the shipped set", (h) => {
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, options: { ...VALID_CONTROLLER_OVERRIDE.options, escalate: "new" } });
    }],
    ["a fixed set's override renames an option id", "the override's option ids differ from the shipped set", (h) => {
      const { nudge, ...rest } = VALID_CONTROLLER_OVERRIDE.options;
      plant(h, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, options: { ...rest, poke: nudge } });
    }],
  ];
  for (const [label, reason, setup] of refusals) {
    const h = harness();
    setup(h);
    const r = await settle(resolverOf(fakeHostOf(h))(CONTROLLER_DECISION));
    check(`Test 5: ${label} is refused as "${reason}" and falls back to the shipped default`,
      r.resolved && r.value.overrideRefused === reason
        && r.value.version === SHIPPED_VERSION
        && r.value.instructions === SHIPPED_QUESTIONS[CONTROLLER_DECISION].instructions
        && sameSet(Object.keys(r.value.options), CONTROLLER_LABELS_WITH_SWITCH), r.resolved ? r.value.overrideRefused : r);
  }
  // The control: the same override, unmodified, is admitted. Without it every
  // case above could be passing because the plant never landed.
  const hc = harness();
  plant(hc, CONTROLLER_DECISION, "v2", VALID_CONTROLLER_OVERRIDE);
  const rc = await settle(resolverOf(fakeHostOf(hc))(CONTROLLER_DECISION));
  check("Test 5 control: the unmodified override these cases start from is admitted",
    rc.resolved && rc.value.overrideRefused === null && rc.value.version === "v2", rc);

  // The plan switch is exempt from the option-id pin, since its ids are the
  // caller's pending plan ids rather than the catalog's.
  const hp = harness();
  plant(hp, PLAN_SWITCH, "v2", {
    primitive: "choice",
    instructions: "override plan switch",
    options: { no_match: "none fits", "plan-a": "a described plan" },
  });
  const rp = await settle(resolverOf(fakeHostOf(hp))(PLAN_SWITCH));
  check("Test 5 exemption: a plan switch override with ids the shipped set does not carry is admitted",
    rp.resolved && rp.value.overrideRefused === null && rp.value.version === "v2", rp);

  // The two-option floor bounds a set whose options are all this catalog's
  // own. The plan switch's are not, so an override mirroring its one-option
  // shipped map is admitted rather than refused.
  const hp1 = harness();
  plant(hp1, PLAN_SWITCH, "v2", {
    primitive: "choice",
    instructions: "override plan switch, one option",
    options: { no_match: "none fits" },
  });
  const rp1 = await settle(resolverOf(fakeHostOf(hp1))(PLAN_SWITCH));
  check("Test 5 floor: a one-option plan switch override is admitted",
    rp1.resolved && rp1.value.overrideRefused === null && rp1.value.version === "v2"
      && sameSet(Object.keys(rp1.value.options), ["no_match"]),
    rp1.resolved ? rp1.value.overrideRefused : rp1);

  // Withheld control on the same axis: the floor still refuses a one-option
  // override of a set the catalog does own, so the case above passes because
  // the set is exempt rather than because the floor stopped working.
  const hp2 = harness();
  plant(hp2, TURN_SCORE, "v2", {
    primitive: "choice",
    instructions: "override turn score, one option",
    options: { "on-goal": "only one" },
  });
  const rp2 = await settle(resolverOf(fakeHostOf(hp2))(TURN_SCORE));
  check("Test 5 floor control: a one-option override of a catalog-owned set is still refused",
    rp2.resolved && rp2.value.overrideRefused === "the override has fewer than 2 options",
    rp2.resolved ? rp2.value.overrideRefused : rp2);

  // The refusing side of the plan switch's own floor, which nothing else
  // drives: an empty options map is below even a floor of one.
  const hp0 = harness();
  plant(hp0, PLAN_SWITCH, "v2", {
    primitive: "choice",
    instructions: "override plan switch, no options at all",
    options: {},
  });
  const rp0 = await settle(resolverOf(fakeHostOf(hp0))(PLAN_SWITCH));
  check("Test 5 floor zero: a plan switch override with no options is refused",
    rp0.resolved && rp0.value.overrideRefused === "the override has fewer than 1 option",
    rp0.resolved ? rp0.value.overrideRefused : rp0);

  // Every key the validation counted is copied as an own property. The body is
  // planted as raw JSON rather than an object literal, because a literal would
  // hit the very __proto__ setter this case is about.
  const hp3 = harness();
  plant(hp3, PLAN_SWITCH, "v2",
    '{"primitive":"choice","instructions":"plan switch, prototype-shaped id","options":{"no_match":"none fits","__proto__":"an option, not a prototype"}}');
  const rp3 = await settle(resolverOf(fakeHostOf(hp3))(PLAN_SWITCH));
  check("Test 5 proto: an option id of __proto__ is copied as an own property rather than swallowed",
    rp3.resolved && rp3.value.overrideRefused === null
      && Object.hasOwn(rp3.value.options, "__proto__")
      && rp3.value.options["__proto__"] === "an option, not a prototype"
      && sameSet(Object.keys(rp3.value.options), ["no_match", "__proto__"]),
    rp3.resolved ? Object.keys(rp3.value.options) : rp3);

  // The null-valued form of the same id, which through a literal's setter
  // rewires the map's prototype instead of storing an option.
  const hp4 = harness();
  plant(hp4, PLAN_SWITCH, "v2",
    '{"primitive":"choice","instructions":"plan switch, null prototype-shaped id","options":{"no_match":"none fits","__proto__":null}}');
  const rp4 = await settle(resolverOf(fakeHostOf(hp4))(PLAN_SWITCH));
  check("Test 5 proto null: a null __proto__ option is stored rather than rewiring the map",
    rp4.resolved && rp4.value.overrideRefused === null
      && Object.hasOwn(rp4.value.options, "__proto__")
      && rp4.value.options["__proto__"] === null,
    rp4.resolved ? Object.keys(rp4.value.options) : rp4);

  // One shape on every path the resolver returns on. Pinning the admitted path
  // alone would let the other three revert to a literal with the suite still
  // green, since every other case reads options through Object.keys, which
  // passes on either shape.
  const shapeCases = [
    ["no override at all", () => resolverOf(fakeHostOf(harness()))(CONTROLLER_DECISION)],
    ["a refused override", () => {
      const h = harness();
      plant(h, CONTROLLER_DECISION, "v2", { primitive: "noul", instructions: "x", options: { a: null, b: null } });
      return resolverOf(fakeHostOf(h))(CONTROLLER_DECISION);
    }],
    ["an admitted override", () => {
      const h = harness();
      plant(h, CONTROLLER_DECISION, "v2", VALID_CONTROLLER_OVERRIDE);
      return resolverOf(fakeHostOf(h))(CONTROLLER_DECISION);
    }],
    ["an unknown question set", () => resolverOf(fakeHostOf(harness()))("no-such-question")],
  ];
  for (const [label, run] of shapeCases) {
    const rs = await settle(run());
    check(`Test 5 shape: the options map from ${label} is prototype-free`,
      rs.resolved && Object.getPrototypeOf(rs.value.options) === null,
      rs.resolved ? String(Object.getPrototypeOf(rs.value.options)) : rs);
  }
}

// --- Test 6: a host that cannot answer is reported, never thrown ---
{
  const hostFailures = [
    ["getHome resolves undefined", "no home directory, so no override was read", (host) => { host.getHome = () => Promise.resolve(undefined); }],
    ["getHome resolves an empty string", "no home directory, so no override was read", (host) => { host.getHome = () => Promise.resolve("   "); }],
    ["getHome resolves a non-string", "no home directory, so no override was read", (host) => { host.getHome = () => Promise.resolve(7); }],
    ["getHome rejects", "no home directory, so no override was read", (host) => { host.getHome = () => Promise.reject(new Error("env down")); }],
    ["getHome throws synchronously", "no home directory, so no override was read", (host) => { host.getHome = () => { throw new Error("env down"); }; }],
    ["fileExists rejects on active.json", "active.json could not be checked", (host) => { host.fileExists = () => Promise.reject(new Error("fs down")); }],
    ["fileExists throws synchronously", "active.json could not be checked", (host) => { host.fileExists = () => { throw new Error("fs down"); }; }],
  ];
  for (const [label, reason, mutate] of hostFailures) {
    const h = harness();
    const host = fakeHostOf(h);
    mutate(host);
    const r = await settle(resolverOf(host)(CONTROLLER_DECISION));
    check(`Test 6: ${label} resolves with reason "${reason}" and the shipped default`,
      r.resolved && r.value.overrideRefused === reason && r.value.version === SHIPPED_VERSION, r.resolved ? r.value.overrideRefused : r);
  }
  // A read that rejects where exists said the file is there, both files.
  const h2 = harness();
  h2.fsMap.set(activePathOf(CONTROLLER_DECISION), JSON.stringify({ version: "v2" }));
  const host2 = fakeHostOf(h2);
  host2.readFile = () => Promise.reject(new Error("EACCES"));
  const r2 = await settle(resolverOf(host2)(CONTROLLER_DECISION));
  check('Test 6: an active.json read that rejects resolves with reason "active.json could not be read"',
    r2.resolved && r2.value.overrideRefused === "active.json could not be read", r2.resolved ? r2.value.overrideRefused : r2);
  const h3 = harness();
  plant(h3, CONTROLLER_DECISION, "v2", VALID_CONTROLLER_OVERRIDE);
  const host3 = fakeHostOf(h3);
  host3.readFile = (p) => (p.endsWith("v2.json") ? Promise.reject(new Error("EACCES")) : h3.fake.fs.read(p));
  const r3 = await settle(resolverOf(host3)(CONTROLLER_DECISION));
  check('Test 6: a version file read that rejects resolves with reason "the version file could not be read"',
    r3.resolved && r3.value.overrideRefused === "the version file could not be read", r3.resolved ? r3.value.overrideRefused : r3);
  // Every host call is an op event a co-loaded hook may answer with a value of
  // its own, so a read that resolves with something other than text is a shape
  // this module meets rather than only a fake's.
  const h4 = harness();
  h4.fsMap.set(activePathOf(CONTROLLER_DECISION), JSON.stringify({ version: "v2" }));
  const host4 = fakeHostOf(h4);
  host4.readFile = () => Promise.resolve({ version: "v2" });
  const r4 = await settle(resolverOf(host4)(CONTROLLER_DECISION));
  check('Test 6: an active.json read that resolves with a non-string is "active.json is not text"',
    r4.resolved && r4.value.overrideRefused === "active.json is not text", r4.resolved ? r4.value.overrideRefused : r4);
  const h5 = harness();
  plant(h5, CONTROLLER_DECISION, "v2", VALID_CONTROLLER_OVERRIDE);
  const host5 = fakeHostOf(h5);
  host5.readFile = (p) => (p.endsWith("v2.json") ? Promise.resolve(42) : h5.fake.fs.read(p));
  const r5 = await settle(resolverOf(host5)(CONTROLLER_DECISION));
  check('Test 6: a version file read that resolves with a non-string is "the version file is not text"',
    r5.resolved && r5.value.overrideRefused === "the version file is not text", r5.resolved ? r5.value.overrideRefused : r5);
  // fileExists answering with something other than true is not a file.
  const h6 = harness();
  plant(h6, CONTROLLER_DECISION, "v2", VALID_CONTROLLER_OVERRIDE);
  const host6 = fakeHostOf(h6);
  host6.fileExists = (p) => (p.endsWith("v2.json") ? Promise.resolve("yes") : h6.fake.fs.exists(p));
  const r6 = await settle(resolverOf(host6)(CONTROLLER_DECISION));
  check('Test 6: a version file whose existence check answers a non-true value is "the named version file is missing"',
    r6.resolved && r6.value.overrideRefused === "the named version file is missing", r6.resolved ? r6.value.overrideRefused : r6);
}

// --- Test 7: an unknown question set id, and the resolver's never-reject contract ---
{
  const h = harness();
  const r = await settle(resolverOf(fakeHostOf(h))("no-such-question"));
  check("Test 7a: an unknown question set id resolves rather than rejecting",
    r.resolved && r.value !== undefined && r.value !== null, r);
  check("Test 7b: the unknown question carries an empty id, which the seam reads as no_question",
    r.resolved && r.value.id === "" && r.value.primitive === "choice", r.value);
  for (const [label, id] of [["an empty string", ""], ["a path", "../secrets"], ["a shipped id with different case", CONTROLLER_DECISION.toUpperCase()]]) {
    const r2 = await settle(resolverOf(fakeHostOf(harness()))(id));
    check(`Test 7c: ${label} resolves as the unknown question without a throw`, r2.resolved && r2.value.id === "", r2);
  }
}

// --- Test 8: end to end through the seam ---
{
  function response(text) { return { status: 200, ok: true, headers: {}, text }; }
  function answerBody(questionId, choice) {
    return JSON.stringify({
      model: "jev-fake",
      answers: { [questionId]: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 } },
      usage: { input_tokens: 10, output_tokens: 1 },
    });
  }

  // 8a: the shipped wording reaches the request when no override exists.
  const h = harness();
  h.setHttpResponse(response(answerBody(CONTROLLER_DECISION, "nudge")));
  const r = await settle(ask(fakeHostOf(h), CONTROLLER_DECISION, CONTROLLER_LABELS, STATE, "shadow", "nudge", resolverOf(fakeHostOf(h))));
  const sent = JSON.parse(h.httpCalls[0].init.body).questions[CONTROLLER_DECISION];
  check("Test 8a: the shipped instructions reach the request and the answer rides back",
    r.resolved && r.value.ok === true && sent.instructions === SHIPPED_QUESTIONS[CONTROLLER_DECISION].instructions
      && r.value.questionVersion === SHIPPED_VERSION && r.value.overrideRefused === null, r.resolved ? r.value.reason : r);
  check("Test 8a: the criteria are the ids in force, with the catalog's descriptions",
    sameSet(Object.keys(sent.criteria), CONTROLLER_LABELS) && sent.criteria.nudge === SHIPPED_QUESTIONS[CONTROLLER_DECISION].options.nudge, Object.keys(sent.criteria));

  // 8b: a refused override's wording never reaches a request. The refusal
  // rule here is the option-id pin, asserted by name on the result.
  const h2 = harness();
  plant(h2, CONTROLLER_DECISION, "v2", { ...VALID_CONTROLLER_OVERRIDE, options: { ...VALID_CONTROLLER_OVERRIDE.options, escalate: "new" } });
  h2.setHttpResponse(response(answerBody(CONTROLLER_DECISION, "nudge")));
  const r2 = await settle(ask(fakeHostOf(h2), CONTROLLER_DECISION, CONTROLLER_LABELS, STATE, "shadow", "nudge", resolverOf(fakeHostOf(h2))));
  const sent2 = JSON.parse(h2.httpCalls[0].init.body);
  check("Test 8b: the refused override's instructions never reach the request",
    !h2.httpCalls[0].init.body.includes(VALID_CONTROLLER_OVERRIDE.instructions)
      && sent2.questions[CONTROLLER_DECISION].instructions === SHIPPED_QUESTIONS[CONTROLLER_DECISION].instructions, sent2.questions[CONTROLLER_DECISION].instructions);
  check("Test 8b: the refused override's added option id never reaches the request",
    !("escalate" in sent2.questions[CONTROLLER_DECISION].criteria), Object.keys(sent2.questions[CONTROLLER_DECISION].criteria));
  check("Test 8b: the journal records the shipped version and the pin as the refusal reason",
    r2.resolved && r2.value.ok === true && r2.value.questionVersion === SHIPPED_VERSION
      && r2.value.overrideRefused === "the override's option ids differ from the shipped set", r2.resolved ? r2.value.overrideRefused : r2);

  // 8c: an admitted override's wording does reach the request, and its label
  // rides the result. The control for 8b.
  const h3 = harness();
  plant(h3, CONTROLLER_DECISION, "v5", VALID_CONTROLLER_OVERRIDE);
  h3.setHttpResponse(response(answerBody(CONTROLLER_DECISION, "nudge")));
  const r3 = await settle(ask(fakeHostOf(h3), CONTROLLER_DECISION, CONTROLLER_LABELS, STATE, "shadow", "nudge", resolverOf(fakeHostOf(h3))));
  const sent3 = JSON.parse(h3.httpCalls[0].init.body).questions[CONTROLLER_DECISION];
  check("Test 8c control: an admitted override's instructions do reach the request, under its own version label",
    r3.resolved && r3.value.ok === true && sent3.instructions === VALID_CONTROLLER_OVERRIDE.instructions
      && r3.value.questionVersion === "v5" && r3.value.overrideRefused === null, r3.resolved ? r3.value.reason : r3);

  // 8d: an unknown question set sends nothing and lands as no_question.
  const h4 = harness();
  h4.setHttpResponse(response(answerBody("no-such-question", "nudge")));
  const r4 = await settle(ask(fakeHostOf(h4), "no-such-question", CONTROLLER_LABELS, STATE, "shadow", "nudge", resolverOf(fakeHostOf(h4))));
  check("Test 8d: an unknown question set is no_question and makes no request",
    r4.resolved && r4.value.ok === false && r4.value.reason === "no_question" && h4.httpCalls.length === 0, r4.resolved ? r4.value.reason : r4);

  // 8e: a host whose fs is entirely down still sends the shipped question.
  const h5 = harness();
  h5.setHttpResponse(response(answerBody(TURN_SCORE, "on-goal")));
  const host5 = fakeHostOf(h5);
  host5.fileExists = () => Promise.reject(new Error("fs down"));
  const r5 = await settle(ask(fakeHostOf(h5), TURN_SCORE, SCORER_LABELS, STATE, "shadow", "on-goal", resolverOf(host5)));
  check("Test 8e: an unreadable override layer still sends the shipped question, with the reason on the result",
    r5.resolved && r5.value.ok === true && r5.value.questionVersion === SHIPPED_VERSION
      && r5.value.overrideRefused === "active.json could not be checked" && h5.httpCalls.length === 1, r5.resolved ? r5.value.overrideRefused : r5);

  // The same invariant on the seam's own outbound map, which the catalog's
  // copy does not reach. An option id in force naming the prototype must ride
  // the request rather than rewiring the map it is written into.
  const hs = harness();
  hs.setHttpResponse(response(answerBody(PLAN_SWITCH, "no_match")));
  await settle(ask(fakeHostOf(hs), PLAN_SWITCH, ["no_match", "__proto__"], STATE, "shadow", "no_match", resolverOf(fakeHostOf(hs))));
  const sentCriteria = hs.httpCalls.length === 1
    ? JSON.parse(hs.httpCalls[0].init.body).questions[PLAN_SWITCH].criteria
    : null;
  check("Test 8f: an option id of __proto__ in force rides the request rather than rewiring the criteria map",
    sentCriteria !== null && Object.hasOwn(sentCriteria, "__proto__") && sentCriteria["__proto__"] === null,
    sentCriteria === null ? hs.httpCalls.length : Object.keys(sentCriteria));

  // The inbound half of the same channel, and the less trusted one: the module
  // header says a co-loaded hook may answer the fetch with a body of its own.
  // The body is built by concatenation rather than as an object literal,
  // because a literal would hit the very setter this case is about.
  const hi = harness();
  const protoBody = '{"model":"jev-fake","answers":{"' + PLAN_SWITCH +
    '":{"type":"choice","choice":"no_match","probabilities":{"no_match":0.75,"__proto__":0.25},"confidence":0.9}},' +
    '"usage":{"input_tokens":10,"output_tokens":1}}';
  hi.setHttpResponse(response(protoBody));
  const ri = await settle(ask(fakeHostOf(hi), PLAN_SWITCH, ["no_match", "__proto__"], STATE, "shadow", "no_match", resolverOf(fakeHostOf(hi))));
  check("Test 8g: a probability keyed __proto__ in the response body survives into the validated answer",
    ri.resolved && ri.value.ok === true
      && Object.hasOwn(ri.value.answer.probabilities, "__proto__")
      && ri.value.answer.probabilities["__proto__"] === 0.25,
    ri.resolved ? (ri.value.ok ? Object.keys(ri.value.answer.probabilities) : ri.value.reason) : ri);
}


// --- Test 9: the three plan health sets ship in the shapes the plan states ---
{
  const blocked = SHIPPED_QUESTIONS[WORKER_BLOCKED];
  check("Test 9a: worker-blocked is a Noul with an instruction and no options or levels",
    blocked.primitive === "noul" && typeof blocked.instructions === "string" && blocked.instructions.trim().length > 0
      && !("options" in blocked) && !("levels" in blocked), blocked);
  check("Test 9b: worker-blocked's instruction names the closing text field",
    blocked.instructions.includes("`closingText`"), blocked.instructions);
  const converging = SHIPPED_QUESTIONS[ROUNDS_CONVERGING];
  check("Test 9c: rounds-converging is a Score with three levels and no options",
    converging.primitive === "score" && Array.isArray(converging.levels) && converging.levels.length === 3 && !("options" in converging), converging);
  check("Test 9d: its levels are the plan's three situations in order: closes more than it opens, holds steady, reopens",
    /closes more than it opens/i.test(converging.levels[0]) && /hold steady/i.test(converging.levels[1]) && /reopen/i.test(converging.levels[2]),
    converging.levels);
  check("Test 9e: rounds-converging's instruction names the recent closing texts field",
    converging.instructions.includes("`recentClosingTexts`"), converging.instructions);
  check("Test 9f: the levels array is frozen, for the reason the label arrays are",
    Object.isFrozen(converging.levels), converging.levels);
  const owner = SHIPPED_QUESTIONS[BLOCK_OWNER];
  check("Test 9g: block-owner is a Choice among exactly operator, coordinator, another-plan, self-resolving and none",
    owner.primitive === "choice" && sameSet(Object.keys(owner.options), ["operator", "coordinator", "another-plan", "self-resolving", "none"]), Object.keys(owner.options));
  check("Test 9h: BLOCK_OWNER_OPTIONS is those ids in that order, frozen, and is a fixed set",
    JSON.stringify(BLOCK_OWNER_OPTIONS) === JSON.stringify(["operator", "coordinator", "another-plan", "self-resolving", "none"])
      && Object.isFrozen(BLOCK_OWNER_OPTIONS) && FIXED_OPTION_SETS.includes(BLOCK_OWNER), BLOCK_OWNER_OPTIONS);
  check("Test 9i: block-owner's instruction names the closing text field",
    owner.instructions.includes("`closingText`"), owner.instructions);
  check("Test 9j: the level bounds are the vendor's two and ten, and rounds-converging is the one fixed-level set",
    MIN_LEVELS === 2 && MAX_LEVELS === 10 && JSON.stringify(FIXED_LEVEL_SETS) === JSON.stringify([ROUNDS_CONVERGING]) && Object.isFrozen(FIXED_LEVEL_SETS),
    [MIN_LEVELS, MAX_LEVELS, FIXED_LEVEL_SETS]);
  // Resolving hands back copies: a consumer writing into what it resolved
  // cannot reach the shipped constant.
  const r = await settle(resolverOf(fakeHostOf(harness()))(ROUNDS_CONVERGING));
  check("Test 9k: the resolved Score carries a copy of the levels rather than the frozen constant",
    r.resolved && r.value.levels !== converging.levels && JSON.stringify(r.value.levels) === JSON.stringify(converging.levels), r);
  const rn = await settle(resolverOf(fakeHostOf(harness()))(WORKER_BLOCKED));
  check("Test 9l: the resolved Noul is the shipped shape with no refusal reason",
    rn.resolved && rn.value.primitive === "noul" && rn.value.version === SHIPPED_VERSION && rn.value.overrideRefused === null
      && sameSet(Object.keys(rn.value), ["id", "version", "overrideRefused", "primitive", "instructions"]), rn);
}

// --- Test 10: an override of a Score keeps its level count; a Noul override keeps its shape ---
{
  const threeLevels = {
    primitive: "score",
    instructions: "OVERRIDE: converging or reopening?",
    levels: ["reworded closing", "reworded steady", "reworded reopening"],
  };
  // The control first: three reworded levels are admitted under their own
  // version label, so the refusals below are the count rule and not a plant
  // that never landed.
  const hc = harness();
  plant(hc, ROUNDS_CONVERGING, "v2", threeLevels);
  const rc = await settle(resolverOf(fakeHostOf(hc))(ROUNDS_CONVERGING));
  check("Test 10 control: a rounds-converging override with three reworded levels is admitted",
    rc.resolved && rc.value.overrideRefused === null && rc.value.version === "v2" && rc.value.primitive === "score"
      && JSON.stringify(rc.value.levels) === JSON.stringify(threeLevels.levels) && rc.value.instructions === threeLevels.instructions, rc);
  check("Test 10 control: the admitted override carries no options field",
    rc.resolved && !("options" in rc.value), rc.resolved ? Object.keys(rc.value) : rc);

  const refusals = [
    ["two levels", { ...threeLevels, levels: ["low", "high"] }, "the override's level count differs from the shipped set"],
    ["five levels", { ...threeLevels, levels: ["a", "b", "c", "d", "e"] }, "the override's level count differs from the shipped set"],
    ["no levels array", { primitive: "score", instructions: "x" }, "the override has no levels array"],
    ["levels that is an object", { ...threeLevels, levels: { "0": "a", "1": "b", "2": "c" } }, "the override has no levels array"],
    ["a level that is not a string", { ...threeLevels, levels: ["a", 2, "c"] }, "the override has a level that is not a non-empty string"],
    ["an empty level", { ...threeLevels, levels: ["a", "", "c"] }, "the override has a level that is not a non-empty string"],
    ["a choice primitive", { primitive: "choice", instructions: "x", options: { a: null, b: null, c: null } }, "the override is not a score"],
    ["an absent primitive", { instructions: "x", levels: threeLevels.levels }, "the override is not a score"],
    ["an empty instruction", { ...threeLevels, instructions: " " }, "the override has an empty instruction"],
  ];
  for (const [label, body, reason] of refusals) {
    const h = harness();
    plant(h, ROUNDS_CONVERGING, "v2", body);
    const r = await settle(resolverOf(fakeHostOf(h))(ROUNDS_CONVERGING));
    check(`Test 10: a rounds-converging override with ${label} is refused as "${reason}" and falls back to the shipped levels`,
      r.resolved && r.value.overrideRefused === reason && r.value.version === SHIPPED_VERSION && r.value.primitive === "score"
        && JSON.stringify(r.value.levels) === JSON.stringify(SHIPPED_QUESTIONS[ROUNDS_CONVERGING].levels)
        && r.value.instructions === SHIPPED_QUESTIONS[ROUNDS_CONVERGING].instructions, r.resolved ? r.value.overrideRefused : r);
  }

  // A Noul override is its instruction alone.
  const hn = harness();
  plant(hn, WORKER_BLOCKED, "v3", { primitive: "noul", instructions: "OVERRIDE: is the worker stuck?" });
  const rn = await settle(resolverOf(fakeHostOf(hn))(WORKER_BLOCKED));
  check("Test 10 noul: a worker-blocked override with an instruction alone is admitted under its version",
    rn.resolved && rn.value.overrideRefused === null && rn.value.version === "v3" && rn.value.primitive === "noul"
      && rn.value.instructions === "OVERRIDE: is the worker stuck?" && sameSet(Object.keys(rn.value), ["id", "version", "overrideRefused", "primitive", "instructions"]), rn);
  const hn2 = harness();
  plant(hn2, WORKER_BLOCKED, "v3", { primitive: "choice", instructions: "x", options: { yes: null, no: null } });
  const rn2 = await settle(resolverOf(fakeHostOf(hn2))(WORKER_BLOCKED));
  check('Test 10 noul: a worker-blocked override naming another primitive is refused as "the override is not a noul"',
    rn2.resolved && rn2.value.overrideRefused === "the override is not a noul" && rn2.value.primitive === "noul" && rn2.value.version === SHIPPED_VERSION,
    rn2.resolved ? rn2.value.overrideRefused : rn2);
  // Fields the Noul shape does not carry are not copied out of an override.
  const hn3 = harness();
  plant(hn3, WORKER_BLOCKED, "v3", { primitive: "noul", instructions: "with extras", options: { a: null }, levels: ["x", "y"] });
  const rn3 = await settle(resolverOf(fakeHostOf(hn3))(WORKER_BLOCKED));
  check("Test 10 noul: an admitted override's stray options and levels do not ride the resolved question",
    rn3.resolved && rn3.value.overrideRefused === null && !("options" in rn3.value) && !("levels" in rn3.value), rn3.resolved ? Object.keys(rn3.value) : rn3);

  // The block owner is a fixed option set like the Haiku-paired three.
  const hb = harness();
  const { none, ...fourOptions } = SHIPPED_QUESTIONS[BLOCK_OWNER].options;
  plant(hb, BLOCK_OWNER, "v2", { primitive: "choice", instructions: "override owner", options: fourOptions });
  const rb = await settle(resolverOf(fakeHostOf(hb))(BLOCK_OWNER));
  check("Test 10 owner: a block-owner override dropping an id is refused by the option-id pin",
    rb.resolved && rb.value.overrideRefused === "the override's option ids differ from the shipped set" && sameSet(Object.keys(rb.value.options), BLOCK_OWNER_OPTIONS),
    rb.resolved ? rb.value.overrideRefused : rb);
  // The existing Choice refusal wording still names choice for a choice set.
  const hb2 = harness();
  plant(hb2, BLOCK_OWNER, "v2", { primitive: "noul", instructions: "x" });
  const rb2 = await settle(resolverOf(fakeHostOf(hb2))(BLOCK_OWNER));
  check('Test 10 owner: a block-owner override naming noul is refused as "the override is not a choice"',
    rb2.resolved && rb2.value.overrideRefused === "the override is not a choice", rb2.resolved ? rb2.value.overrideRefused : rb2);
}

// --- Test 11: the three sets end to end through the seam in one request ---
{
  function response(text) { return { status: 200, ok: true, headers: {}, text }; }
  const asks = [
    { questionSetId: WORKER_BLOCKED, primitive: "noul" },
    { questionSetId: ROUNDS_CONVERGING, primitive: "score" },
    { questionSetId: BLOCK_OWNER, primitive: "choice", optionIds: BLOCK_OWNER_OPTIONS },
  ];
  const state = { closingText: "BLOCKED: waiting on the operator", recentClosingTexts: ["Working.", "BLOCKED: waiting on the operator"] };
  const body = JSON.stringify({
    model: "jev-fake",
    answers: {
      [WORKER_BLOCKED]: { type: "noul", noul: 0.9 },
      [ROUNDS_CONVERGING]: { type: "score", score: 0.5, probabilities: { "0": 0.5, "1": 0.5, "2": 0 }, confidence: 0.5 },
      [BLOCK_OWNER]: { type: "choice", choice: "operator", probabilities: { operator: 1, coordinator: 0, "another-plan": 0, "self-resolving": 0, none: 0 }, confidence: 1 },
    },
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  // 11a: the shipped wording of all three reaches one request.
  const h = harness();
  h.setHttpResponse(response(body));
  const r = await settle(askAll(fakeHostOf(h), asks, state, "shadow", resolverOf(fakeHostOf(h))));
  const sent = h.httpCalls.length === 1 ? JSON.parse(h.httpCalls[0].init.body) : null;
  check("Test 11a: one request carries the three shipped questions under their ids",
    r.resolved && r.value.ok === true && sent !== null && JSON.stringify(Object.keys(sent.questions)) === JSON.stringify([WORKER_BLOCKED, ROUNDS_CONVERGING, BLOCK_OWNER]),
    sent && Object.keys(sent.questions));
  check("Test 11a: the Noul carries the shipped instruction and no criteria",
    sent !== null && sent.questions[WORKER_BLOCKED].type === "noul" && sent.questions[WORKER_BLOCKED].instructions === SHIPPED_QUESTIONS[WORKER_BLOCKED].instructions
      && !("criteria" in sent.questions[WORKER_BLOCKED]), sent && sent.questions[WORKER_BLOCKED]);
  check("Test 11a: the Score carries the shipped levels as its criteria, in order",
    sent !== null && sent.questions[ROUNDS_CONVERGING].type === "score"
      && JSON.stringify(sent.questions[ROUNDS_CONVERGING].criteria) === JSON.stringify(SHIPPED_QUESTIONS[ROUNDS_CONVERGING].levels), sent && sent.questions[ROUNDS_CONVERGING]);
  check("Test 11a: the Choice carries the five owner ids with the shipped descriptions",
    sent !== null && sent.questions[BLOCK_OWNER].type === "choice"
      && JSON.stringify(Object.keys(sent.questions[BLOCK_OWNER].criteria)) === JSON.stringify([...BLOCK_OWNER_OPTIONS])
      && sent.questions[BLOCK_OWNER].criteria.operator === SHIPPED_QUESTIONS[BLOCK_OWNER].options.operator, sent && sent.questions[BLOCK_OWNER]);
  check("Test 11a: the state rides as the object with its two fields",
    sent !== null && JSON.stringify(sent.state) === JSON.stringify(state), sent && sent.state);
  check("Test 11a: three answers ride back, each naming its primitive and the shipped version",
    r.resolved && r.value.ok === true && r.value.answers.map((a) => a.primitive).join(",") === "noul,score,choice"
      && r.value.answers.every((a) => a.questionVersion === SHIPPED_VERSION && a.overrideRefused === null), r.resolved ? r.value : r);

  // 11b: a refused Score override never reaches the request; the shipped
  // levels do, and the refusal rides the answer.
  const h2 = harness();
  plant(h2, ROUNDS_CONVERGING, "v2", { primitive: "score", instructions: "OVERRIDE five levels", levels: ["a", "b", "c", "d", "e"] });
  h2.setHttpResponse(response(body));
  const r2 = await settle(askAll(fakeHostOf(h2), asks, state, "shadow", resolverOf(fakeHostOf(h2))));
  const sent2 = h2.httpCalls.length === 1 ? JSON.parse(h2.httpCalls[0].init.body) : null;
  check("Test 11b: the refused five-level override's wording never reaches the request",
    sent2 !== null && !h2.httpCalls[0].init.body.includes("OVERRIDE five levels")
      && JSON.stringify(sent2.questions[ROUNDS_CONVERGING].criteria) === JSON.stringify(SHIPPED_QUESTIONS[ROUNDS_CONVERGING].levels), sent2 && sent2.questions[ROUNDS_CONVERGING]);
  check("Test 11b: the answer records the shipped version and the level-count rule as the refusal",
    r2.resolved && r2.value.ok === true && r2.value.answers[1].questionVersion === SHIPPED_VERSION
      && r2.value.answers[1].overrideRefused === "the override's level count differs from the shipped set", r2.resolved ? r2.value : r2);
}

// Give any rejection the last case left behind one turn of the loop to surface.
await new Promise((res) => setImmediate(res));
check("Final: no unhandled rejection surfaced during the suite", unhandled.length === 0, unhandled.map(String));

const summary = `\n${failed === 0 ? "All tests passed" : failed + " test(s) FAILED"}`;
console.log(summary);
process.exit(failed === 0 ? 0 : 1);
