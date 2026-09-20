// question-catalog.ts: the wording of every closed question this plugin puts
// to Jev, in two layers. The shipped defaults are the constants below. An
// override layer outside the repository can replace one, so a later plan can
// revise a question without shipping a release.
//
// It is also the single source of the label arrays the three $.model.classify
// sites in hooks/index.ts pass to Haiku. What those two share is the option
// ids and their order, single-sourced here so the ids Haiku is offered and
// the ids Jev is offered cannot drift. Each site's prompt prose names some of
// those ids again in its own sentences, and nothing pins that second copy; a
// drift there lands in the wording rather than in the offered ids, so the
// agreement figure survives it. The
// wording around the ids differs by design, since Haiku reads a prompt and Jev
// reads a description per option. The ids are the part that must not drift: an
// agreement in the decision journal is exact equality of option id between
// Haiku's answer and Jev's, so a drift there would make every agreement figure
// meaningless.
//
// No `import $` and no side effects at load. The engine's loader follows `$`
// only into functions declared in hooks/index.ts and refuses the whole module
// where `$` crosses an import, so this file takes a CatalogHost instead: three
// members of the PluginHost that hooks/index.ts builds over `$` in its
// top-level hostOf adapter.
//
// The resolver never rejects. A resolver failure the seam cannot name lands as
// its `no_question` reason, which exists for a resolver it cannot trust; this
// catalog's own contract is to fall back to the shipped default on every
// failure and report why. Nothing here throws into a controller tick.

import type { PluginHost } from "./host";
import type { ResolvedQuestion, QuestionResolver } from "./decision-seam";

// --- The label arrays the three classify sites pass to Haiku ---
//
// Frozen at their declaration, in the same shape hooks/index.ts and
// hooks/self-review.ts already ship and load as new Set([...]). The freeze is
// load-bearing rather than tidy: each classify site used to build a fresh
// array literal per call and now passes this one shared constant, and
// $.model.classify is an op event that hands its labels to any co-loaded hook.
// A hook mutating the array in place would otherwise corrupt what Haiku is
// offered for the process lifetime rather than for one call, which is the
// drift this module exists to prevent. Its readonly annotation is a compile
// -time thing only and stops nothing at runtime.
//
// Values and order are the shipped Haiku behavior. Changing either changes
// what the classifier is offered and what it answers, so neither is free.
// Each pair's second member is the superset: the controller offers `switch`
// only where a pending plan exists, and the scorer offers
// `off-goal-by-instruction` only on a turn that was not nudged. The catalog
// set holds the superset with a description per option, and the caller names
// the ids in force at request time.

// The controller's decision on an idle worker, with no pending plan to switch to.
export const CONTROLLER_LABELS: readonly string[] = Object.freeze(["nudge", "pause", "complete", "ask-operator"]);
// The same decision where at least one pending plan exists. The superset.
export const CONTROLLER_LABELS_WITH_SWITCH: readonly string[] = Object.freeze(["nudge", "pause", "complete", "ask-operator", "switch"]);

// The turn scorer on a turn the plugin nudged: a worker answering our own
// nudge cannot be off goal by the operator's instruction.
export const SCORER_LABELS_AFTER_NUDGE: readonly string[] = Object.freeze(["on-goal", "drift", "complete"]);
// The turn scorer on a turn the plugin did not nudge. The superset.
export const SCORER_LABELS: readonly string[] = Object.freeze(["on-goal", "off-goal-by-instruction", "drift", "complete"]);

// The memory-curation gate. One array, no variants.
export const MEMORY_KIND_LABELS: readonly string[] = Object.freeze(["fact", "preference", "lesson", "discard"]);

// --- The four question sets ---
//
// Each id is the join key between this catalog and the decision journal, and
// it is a wire value: the seam sends it as the request's question key and the
// vendor returns the answer under it. So an id is stable once shipped.
export const CONTROLLER_DECISION = "controller-decision";
export const PLAN_SWITCH = "plan-switch";
export const TURN_SCORE = "turn-score";
export const MEMORY_KIND = "memory-kind";

// The plan switch is the one set whose options are not all the catalog own:
// the rest are the pending plan ids the caller supplies per request. This is
// the option that covers none of them, and the wiring in hooks/index.ts sends
// it as an offered id and records it as Haiku value where no plan matched, so
// the two files are pinned to one spelling rather than two literals.
export const PLAN_SWITCH_NO_MATCH = "no_match";

export const QUESTION_SET_IDS: readonly string[] = Object.freeze([CONTROLLER_DECISION, PLAN_SWITCH, TURN_SCORE, MEMORY_KIND]);

// The version label a shipped default carries into the journal. An override
// carries its own label instead.
export const SHIPPED_VERSION = "v1";

// A Choice takes up to 255 options (https://docs.typesafe.ai/primitives/choice.md).
// The lower bound is this catalog's own judgment rather than the vendor's: a
// question whose options are all the catalog's has no judgment in it with only
// one. It therefore applies to the three fixed sets and not to the plan
// switch, whose other options arrive per request. See overrideProblem.
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 255;

// The three sets whose options are this catalog's own, so an override that
// changes the set of option ids is refused: the journal's agreement figure
// compares Jev's option id against Haiku's, and Haiku's come from the label
// arrays above. The plan switch is absent because its option ids are the
// caller's pending plan ids rather than the catalog's.
export const FIXED_OPTION_SETS: readonly string[] = Object.freeze([CONTROLLER_DECISION, TURN_SCORE, MEMORY_KIND]);

// The shipped defaults. Instructions are one snap judgment each, which is
// what a System One model is built for, and every option carries a one-line
// description, which is what the vendor's Choice page asks for.
export const SHIPPED_QUESTIONS: Readonly<Record<string, ResolvedQuestion>> = {
  [CONTROLLER_DECISION]: {
    id: CONTROLLER_DECISION,
    version: SHIPPED_VERSION,
    overrideRefused: null,
    primitive: "choice",
    instructions: "An autonomous worker session has gone idle. Given its goal, its recent scores and how long it has been idle, which action should the controller take now?",
    options: {
      "nudge": "Prompt the worker to take the next concrete step toward the goal.",
      "pause": "Repeated drift or off-goal-by-instruction suggests the operator changed direction, so stop nudging.",
      "complete": "The objective is evidently met.",
      "ask-operator": "The worker is blocked or the goal is ambiguous, or the round budget is nearly spent.",
      "switch": "A different pending plan is the one to work on now.",
    },
  },
  [PLAN_SWITCH]: {
    id: PLAN_SWITCH,
    version: SHIPPED_VERSION,
    overrideRefused: null,
    primitive: "choice",
    instructions: "The controller has decided to switch plans. Which of the pending plans listed in the state should the worker take up next?",
    // The only option this catalog owns. The rest are the pending plan ids the
    // caller supplies at request time, which have no catalog description and
    // ride the request with null. So this map is one entry, and an override of
    // this set is floored at one for the same reason rather than at
    // MIN_OPTIONS, which bounds the sets whose options are all the catalog's.
    options: {
      [PLAN_SWITCH_NO_MATCH]: "None of the pending plans fits.",
    },
  },
  [TURN_SCORE]: {
    id: TURN_SCORE,
    version: SHIPPED_VERSION,
    overrideRefused: null,
    primitive: "choice",
    instructions: "Given the goal objective, what did the worker's answer do about it?",
    options: {
      "on-goal": "The answer advanced the stated objective.",
      "off-goal-by-instruction": "The answer went elsewhere because the user asked it to.",
      "drift": "The answer went elsewhere with no instruction to do so.",
      "complete": "The answer finished the objective.",
    },
  },
  [MEMORY_KIND]: {
    id: MEMORY_KIND,
    version: SHIPPED_VERSION,
    overrideRefused: null,
    primitive: "choice",
    instructions: "What kind of memorable content is in this exchange, if any?",
    options: {
      "fact": "A fact the user stated explicitly.",
      "preference": "A preference the user stated explicitly.",
      "lesson": "A durable lesson about how to work, drawn from what happened this turn.",
      "discard": "Nothing worth keeping, including a description of what happened this turn and an instruction to call a tool.",
    },
  },
};

// What the resolver hands back for a question set id it does not know. Its
// empty id is the first thing the seam's questionProblem rejects, so the call
// ends as no_question before any request is sent. Returned rather than thrown
// because the resolver's contract is that it never rejects.
export const UNKNOWN_QUESTION: ResolvedQuestion = {
  id: "",
  version: "",
  overrideRefused: "unknown question set",
  primitive: "choice",
  instructions: "",
  options: {},
};

// --- The override layer ---
//
// Layout under the home directory host.getHome() resolves:
//   <home>/.claude/agentic-questions/<questionId>/active.json
//   <home>/.claude/agentic-questions/<questionId>/v<N>.json
//
// active.json names the active version and is the one mutable file:
//   { "version": "v3" }
//
// v<N>.json holds the question itself, its field names mirroring
// ResolvedQuestion's where they overlap. Every field is required:
//   {
//     "primitive": "choice",
//     "instructions": "...",
//     "options": { "<optionId>": "<description>" | null, ... }
//   }
//
// A version file is immutable once written: the journal records the version
// label beside every answer, so a label whose wording changed underneath it
// would make two different questions read as one.
//
// This module only reads these files. Nothing here writes one.
export const OVERRIDE_DIR = ".claude/agentic-questions";
// The one path segment that comes from outside this repository. Held to a
// v<N> label so a version string can carry no separator and no parent
// traversal into the path built from it.
const VERSION_LABEL = /^v[0-9]{1,9}$/;

// What the catalog needs from the host: the home directory and two reads.
export type CatalogHost = Pick<PluginHost, "getHome" | "readFile" | "fileExists">;

// The join hooks/index.ts uses at workdirPathOf and rosterRunDir: trailing
// separators off the root, then an unconditional forward slash, which Windows
// resolves as readily as POSIX. Kept here because those two are local to
// hooks/index.ts and `$` cannot cross an import to reach them.
function joined(root: string, ...parts: string[]): string {
  return [root.replace(/[/\\]+$/, ""), ...parts].join("/");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The shipped default with a refusal reason written onto it. The default is
// never mutated: a refusal is per call, and the constants are shared.
function fallback(shipped: ResolvedQuestion, refused: string | null): ResolvedQuestion {
  return { ...shipped, options: optionsCopy(shipped.options), overrideRefused: refused };
}

// Every options map the resolver returns is prototype-free, on every path.
// The exported SHIPPED_QUESTIONS and UNKNOWN_QUESTION constants are ordinary
// literals and are never returned directly, always through this copy.
// Two shapes under one declared type is the worse defect: a consumer writing
// question.options.hasOwnProperty(id) would work on the fallback path and
// throw on the override path, and the fallback path is the one every test
// exercises. A literal also carries a __proto__ setter, which swallows an
// option of that id and nulls the map's prototype for a null value, so the
// map that resolves would differ from the one that was validated.
function optionsCopy(from: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = Object.create(null);
  for (const [id, description] of Object.entries(from)) out[id] = description;
  return out;
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

// The first way an override file's parsed content fails to be a usable
// question, or null where it is one. Checked field by field rather than cast,
// because the file is written outside this repository by a party this module
// cannot vouch for. Each reason is written for the journal to record: fixed,
// except the two that name the bound they applied, and never quoting the
// file's own content.
function overrideProblem(parsed: unknown, shipped: ResolvedQuestion): string | null {
  if (!isRecord(parsed)) return "the version file is not an object";
  if (parsed.primitive !== "choice") return "the override is not a choice";
  if (typeof parsed.instructions !== "string" || parsed.instructions.trim().length === 0) {
    return "the override has an empty instruction";
  }
  if (!isRecord(parsed.options)) return "the override has no options map";
  for (const description of Object.values(parsed.options)) {
    if (description !== null && typeof description !== "string") {
      return "the override has an option description that is not a string or null";
    }
  }
  const ids = Object.keys(parsed.options);
  // The floor is two for a set whose options are all this catalog's own. The
  // plan switch's are not: its shipped map holds no_match alone and the rest
  // are the pending plan ids the caller supplies per request. So a one-option
  // override of that set is the shape mirroring its shipped default rather
  // than a question with no judgment in it, and the floor there is one.
  const floor = FIXED_OPTION_SETS.includes(shipped.id) ? MIN_OPTIONS : 1;
  if (ids.length < floor) return `the override has fewer than ${floor} option${floor === 1 ? "" : "s"}`;
  if (ids.length > MAX_OPTIONS) return `the override has more than ${MAX_OPTIONS} options`;
  // Option order is free. Order carries no meaning to a Choice, which returns
  // a probability per option id, so a reordered override is admitted.
  if (FIXED_OPTION_SETS.includes(shipped.id) && !sameIdSet(ids, Object.keys(shipped.options))) {
    return "the override's option ids differ from the shipped set";
  }
  return null;
}

// Builds the resolver the seam calls, bound to one host. The seam types it as
// QuestionResolver and depends on it resolving for every input: a question set
// it does not know comes back as UNKNOWN_QUESTION rather than a rejection.
//
// One call reads at most two files and holds nothing between calls, so an
// override written while a persona is running takes effect on the next
// question rather than on the next restart.
export function resolverOf(host: CatalogHost): QuestionResolver {
  return async (questionSetId: string): Promise<ResolvedQuestion> => {
    const shipped = Object.hasOwn(SHIPPED_QUESTIONS, questionSetId) ? SHIPPED_QUESTIONS[questionSetId] : null;
    if (shipped === null) return { ...UNKNOWN_QUESTION, options: optionsCopy(UNKNOWN_QUESTION.options) };

    // A home that cannot be read is an override layer that cannot be reached,
    // which is reported rather than passed over: an operator whose override
    // was silently ignored has no other way to see it.
    let home: unknown;
    try {
      home = await host.getHome();
    } catch {
      home = undefined;
    }
    if (typeof home !== "string" || home.trim().length === 0) {
      return fallback(shipped, "no home directory, so no override was read");
    }

    const dir = joined(home.trim(), OVERRIDE_DIR, shipped.id);
    const activePath = joined(dir, "active.json");

    // No active.json is the ordinary case: no override exists, nothing was
    // refused, and the shipped default carries no reason.
    let activeExists: unknown;
    try {
      activeExists = await host.fileExists(activePath);
    } catch {
      return fallback(shipped, "active.json could not be checked");
    }
    if (activeExists !== true) return fallback(shipped, null);

    let activeText: unknown;
    try {
      activeText = await host.readFile(activePath);
    } catch {
      return fallback(shipped, "active.json could not be read");
    }
    if (typeof activeText !== "string") return fallback(shipped, "active.json is not text");
    let active: unknown;
    try {
      active = JSON.parse(activeText);
    } catch {
      return fallback(shipped, "active.json is not JSON");
    }
    if (!isRecord(active) || typeof active.version !== "string") {
      return fallback(shipped, "active.json names no version");
    }
    const version = active.version.trim();
    if (!VERSION_LABEL.test(version)) return fallback(shipped, "active.json names no v<N> version label");

    const versionPath = joined(dir, `${version}.json`);
    let versionExists: unknown;
    try {
      versionExists = await host.fileExists(versionPath);
    } catch {
      return fallback(shipped, "the named version file could not be checked");
    }
    if (versionExists !== true) return fallback(shipped, "the named version file is missing");

    let versionText: unknown;
    try {
      versionText = await host.readFile(versionPath);
    } catch {
      return fallback(shipped, "the version file could not be read");
    }
    if (typeof versionText !== "string") return fallback(shipped, "the version file is not text");
    let parsed: unknown;
    try {
      parsed = JSON.parse(versionText);
    } catch {
      return fallback(shipped, "the version file is not JSON");
    }

    const problem = overrideProblem(parsed, shipped);
    if (problem !== null) return fallback(shipped, problem);

    // Validated field by field above, so only the three fields this module
    // checked are copied out. Nothing else the file carried rides along.
    const source = parsed as { instructions: string; options: Record<string, string | null> };
    const options = optionsCopy(source.options);
    return {
      id: shipped.id,
      version,
      overrideRefused: null,
      primitive: "choice",
      instructions: source.instructions,
      options,
    };
  };
}
