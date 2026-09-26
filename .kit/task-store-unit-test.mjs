#!/usr/bin/env node
// Task store test: the two lists beside the goal tree, the task list and the
// turn records. For the task list it pins the load of a store written before
// the list existed (v2, v3 and v4 all load at version 6 with an empty list),
// the tolerance for a malformed list or entry, and the completion reap in both
// directions: a task under a complete or abandoned goal, or under no goal at
// all, is dropped, and one under a pending, active, paused or blocked goal is
// kept, both at a load and when the reap is called on a live state. For the
// turn records it pins the v5-to-v6 migration, the round trip of all five
// statuses, the tolerance for a malformed list or entry, the timeout in both
// directions, the cap sparing the open record, and the one-open repair. The
// persist-path reaps and the goal_status line, which need a session, are pinned
// in controller-tick-test.mjs.
// Usage: node task-store-unit-test.mjs
// Exits 0 on success, 1 on failure.

import { readFileSync } from "fs";
import {
  createDefaultState,
  newTaskId,
  newTurnRecordId,
  openTurnRecord,
  parseState,
  reapCompletedGoalTasks,
  reapTurnRecords,
  serializeState,
  TURN_RECORD_STATUSES,
  TURN_RECORD_TEXT_MAX,
  TURN_RECORD_TIMEOUT_MS,
  TURN_RECORDS_MAX,
} from "../hooks/agent-state.ts";

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name, detail) {
  console.error(`  FAIL: ${name}`);
  if (detail !== undefined) console.error(`        detail: ${JSON.stringify(detail)}`);
  failed++;
}
function check(name, cond, detail) { if (cond) ok(name); else fail(name, detail); }

const T0 = 1_700_000_000_000;
const fixtureText = readFileSync(new URL("./fixtures/state-v4-no-tasks.json", import.meta.url), "utf8");

function goal(id, parentId, status) {
  return {
    id, parentId, kind: parentId === null ? "root" : "task", title: id, objective: id, status,
    source: "operator", maxRounds: parentId === null ? 0 : 10, completedRounds: 0, scores: [], notes: [],
    planningRounds: 0, consecutiveBlockedPlannings: 0, consecutivePlanningFailures: 0, planningRound: 0,
    createdAt: T0, updatedAt: T0,
  };
}
function task(id, goalId, extra = {}) {
  return { id, goalId, text: `work ${id}`, done: false, addedAt: T0, ...extra };
}
// A current-version store built from the fixture, carrying the goals and tasks
// given.
function v6Store(goals, tasks) {
  return JSON.stringify({ ...JSON.parse(fixtureText), version: 6, goals, activeGoalId: null, tasks });
}

// --- A store written before the list existed ---
console.log("\nFixture: state-v4-no-tasks.json (v4, tasks absent)");
check("the fixture is a v4 store with no tasks key (the instrument)",
  JSON.parse(fixtureText).version === 4 && !fixtureText.includes("\"tasks\""));
const fromV4 = parseState(fixtureText);
check("v4 loads at version 6", fromV4.version === 6, fromV4.version);
check("v4 loads with an empty task list", Array.isArray(fromV4.tasks) && fromV4.tasks.length === 0, fromV4.tasks);
check("v4 keeps its tree and its active goal",
  fromV4.goals.length === 2 && fromV4.activeGoalId === "task-1", { goals: fromV4.goals.length, active: fromV4.activeGoalId });

console.log("\nOlder versions: v3 and v2");
const fromV3 = parseState(JSON.stringify({ ...JSON.parse(fixtureText), version: 3 }));
check("v3 loads at version 6 with an empty task list",
  fromV3.version === 6 && Array.isArray(fromV3.tasks) && fromV3.tasks.length === 0, { version: fromV3.version, tasks: fromV3.tasks });
const v2 = {
  version: 2, persona: "test-persona", activeSessionId: "s-2", epoch: 1, memory: [],
  goal: { id: "goal-x", objective: "Old goal", maxRounds: 5, completedRounds: 0, status: "active", createdAt: T0, updatedAt: T0, scores: [] },
  monitor: { sessionStart: T0, turnCount: 0, totalToolCalls: 0, errors: 0 },
  decisions: [], createdAt: T0, updatedAt: T0,
};
const fromV2 = parseState(JSON.stringify(v2));
check("v2 loads at version 6 with an empty task list",
  fromV2.version === 6 && Array.isArray(fromV2.tasks) && fromV2.tasks.length === 0, { version: fromV2.version, tasks: fromV2.tasks });

console.log("\nThe current version and the ones past it");
const heldGoals = [goal("root-1", null, "pending"), goal("task-1", "root-1", "active")];
const held = [task("tk-a", "task-1"), task("tk-b", "task-1", { done: true, doneAt: T0 + 5 })];
const fromV6 = parseState(v6Store(heldGoals, held));
check("a v6 store's list under an open goal loads as it was",
  fromV6.version === 6 && JSON.stringify(fromV6.tasks) === JSON.stringify(held), fromV6.tasks);
let threw = null;
try { parseState(JSON.stringify({ ...JSON.parse(fixtureText), version: 7 })); } catch (e) { threw = e; }
check("a version past 6 is refused as unsupported",
  threw instanceof Error && threw.message === "Unsupported AgentState version: 7", threw && threw.message);

// --- Malformed input ---
console.log("\nA stored list that is not a list");
for (const [label, value] of [["null", null], ["a string", "x"], ["an object", { a: 1 }], ["a number", 7]]) {
  const parsed = parseState(v6Store(heldGoals, value));
  check(`tasks as ${label} loads as an empty list`, Array.isArray(parsed.tasks) && parsed.tasks.length === 0, parsed.tasks);
}

console.log("\nA stored entry that is not a task");
const good = task("tk-good", "task-1");
const goodNoDoneAt = task("tk-open", "task-1");
for (const [label, entry] of [
  ["null", null],
  ["a string", "tk-x"],
  ["a missing text", { id: "tk-1", goalId: "task-1", done: false, addedAt: T0 }],
  ["a numeric id", { ...good, id: 7 }],
  ["a missing goalId", { id: "tk-2", text: "t", done: false, addedAt: T0 }],
  ["a string done", { ...good, id: "tk-3", done: "false" }],
  ["a string addedAt", { ...good, id: "tk-4", addedAt: String(T0) }],
  ["a string doneAt", { ...good, id: "tk-5", done: true, doneAt: "later" }],
  ["a null doneAt", { ...good, id: "tk-6", done: true, doneAt: null }],
]) {
  const parsed = parseState(v6Store(heldGoals, [good, entry]));
  check(`an entry with ${label} is dropped and the well-formed one kept`,
    parsed.tasks.length === 1 && parsed.tasks[0].id === "tk-good", parsed.tasks);
}
const parsedOpen = parseState(v6Store(heldGoals, [goodNoDoneAt]));
check("an open entry with no doneAt is kept (the control)",
  parsedOpen.tasks.length === 1 && parsedOpen.tasks[0].id === "tk-open" && !("doneAt" in parsedOpen.tasks[0]), parsedOpen.tasks);

// --- The reap ---
// One goal in each of the six statuses under a pending root, a task under
// each, and one task naming a goal the tree does not hold.
const statuses = ["pending", "active", "paused", "blocked", "complete", "abandoned"];
const reapGoals = [goal("root-1", null, "pending"), ...statuses.map((s) => goal(`g-${s}`, "root-1", s))];
const reapTasks = [...statuses.map((s) => task(`tk-${s}`, `g-${s}`)), task("tk-orphan", "g-gone")];
const kept = ["tk-pending", "tk-active", "tk-paused", "tk-blocked"];

console.log("\nThe reap at a load (the backstop)");
const loaded = parseState(v6Store(reapGoals, reapTasks));
const loadedIds = loaded.tasks.map((t) => t.id);
check("the goals keep their six statuses through the load (the instrument)",
  statuses.every((s) => loaded.goals.find((g) => g.id === `g-${s}`)?.status === s), loaded.goals.map((g) => [g.id, g.status]));
check("a load keeps the tasks of pending, active, paused and blocked goals",
  JSON.stringify(loadedIds) === JSON.stringify(kept), loadedIds);
check("a load drops the tasks of complete and abandoned goals and the orphan",
  !loadedIds.includes("tk-complete") && !loadedIds.includes("tk-abandoned") && !loadedIds.includes("tk-orphan"), loadedIds);

console.log("\nThe reap on a live state");
const live = createDefaultState("someone", "s-1");
live.goals = reapGoals.map((g) => ({ ...g }));
live.tasks = reapTasks.map((t) => ({ ...t }));
const { tasks: _ignored, ...restBefore } = live;
const otherFieldsBefore = JSON.stringify(restBefore);
reapCompletedGoalTasks(live);
const { tasks: liveTasks, ...restAfter } = live;
check("the reap keeps the tasks of pending, active, paused and blocked goals",
  JSON.stringify(liveTasks.map((t) => t.id)) === JSON.stringify(kept), liveTasks.map((t) => t.id));
check("the reap changes no field but tasks", JSON.stringify(restAfter) === otherFieldsBefore);

// --- A new state and a new id ---
console.log("\nA new state and a new task id");
const fresh = createDefaultState("someone", "s-1");
check("a new state is version 6 with an empty task list",
  fresh.version === 6 && Array.isArray(fresh.tasks) && fresh.tasks.length === 0, { version: fresh.version, tasks: fresh.tasks });
const id1 = newTaskId(T0);
const id2 = newTaskId(T0);
check("a task id never takes a goal node's prefix",
  !/^(root|plan|task|lt)-/.test(id1), id1);
check("two ids minted at one clock differ", id1 !== id2, [id1, id2]);

// ============================================================
// The turn records
// ============================================================

const recordFixtureText = readFileSync(new URL("./fixtures/state-v5-no-turn-records.json", import.meta.url), "utf8");

// A record in the shape the store holds, open at T0 unless overridden.
function record(id, extra = {}) {
  return { id, text: `held ${id}`, openedAt: T0, status: "open", ...extra };
}
// A current-version store carrying the records given and nothing else of note.
function recordStore(records) {
  return JSON.stringify({
    ...JSON.parse(recordFixtureText), version: 6, goals: [], activeGoalId: null, tasks: [], turnRecords: records,
  });
}
// A live state carrying the records given, for the reap called directly.
function stateWith(records) {
  const state = createDefaultState("someone", "s-1");
  state.turnRecords = records;
  return state;
}

// --- A store written before the records existed ---
console.log("\nFixture: state-v5-no-turn-records.json (v5, turnRecords absent)");
check("the fixture is a v5 store with no turnRecords key (the instrument)",
  JSON.parse(recordFixtureText).version === 5 && !recordFixtureText.includes("\"turnRecords\""));
const fromV5NoRecords = parseState(recordFixtureText);
check("a v5 store loads at version 6 with an empty record list",
  fromV5NoRecords.version === 6 && Array.isArray(fromV5NoRecords.turnRecords) && fromV5NoRecords.turnRecords.length === 0,
  { version: fromV5NoRecords.version, records: fromV5NoRecords.turnRecords });
check("a v5 store keeps its tree, its active goal and its task through the migration",
  fromV5NoRecords.goals.length === 2 && fromV5NoRecords.activeGoalId === "task-1"
  && fromV5NoRecords.tasks.length === 1 && fromV5NoRecords.tasks[0].id === "tk-held",
  { goals: fromV5NoRecords.goals.length, active: fromV5NoRecords.activeGoalId, tasks: fromV5NoRecords.tasks });
check("a v4 store loads at version 6 with an empty record list too",
  fromV4.version === 6 && Array.isArray(fromV4.turnRecords) && fromV4.turnRecords.length === 0, fromV4.turnRecords);
check("a new state is version 6 with an empty record list",
  Array.isArray(fresh.turnRecords) && fresh.turnRecords.length === 0, fresh.turnRecords);

// --- The round trip ---
// The status set is closed at five, and fillTurnRecords reads it to decide
// which stored entries survive, so every member round-trips or the load drops
// the ones it does not know.
console.log("\nA record in each of the five statuses through serializeState and parseState");
const nowish = Date.now();
const fiveStatuses = TURN_RECORD_STATUSES.map((status, i) => ({
  id: `tr-${status}`,
  text: `a message in ${status}`,
  // Only the open record is read against the clock, so it opens just now and
  // the four closed ones carry an old clock without being touched.
  openedAt: status === "open" ? nowish - 1000 : T0 + i,
  status,
  turnId: `turn-${i}`,
  goalId: `task-${i}`,
  planPath: `docs/plans/p_${i}_v1.md`,
  taskId: `tk-${i}`,
  ...(status === "open" ? {} : { closedAt: T0 + 100 + i }),
}));
const roundTripped = parseState(serializeState(stateWith(fiveStatuses.map((r) => ({ ...r })))));
check("all five statuses survive a write and a load unchanged",
  JSON.stringify(roundTripped.turnRecords) === JSON.stringify(fiveStatuses), roundTripped.turnRecords);
check("TURN_RECORD_STATUSES is the closed set of five, in order",
  JSON.stringify([...TURN_RECORD_STATUSES]) === JSON.stringify(["open", "delivered", "superseded", "expired", "promoted"]),
  [...TURN_RECORD_STATUSES]);

// --- Malformed input ---
console.log("\nA stored record list that is not a list");
for (const [label, value] of [["null", null], ["a string", "x"], ["an object", { a: 1 }], ["a number", 7]]) {
  const parsed = parseState(recordStore(value));
  check(`turnRecords as ${label} loads as an empty list`,
    Array.isArray(parsed.turnRecords) && parsed.turnRecords.length === 0, parsed.turnRecords);
}

console.log("\nA stored entry that is not a record");
const goodRecord = record("tr-good", { status: "delivered", closedAt: T0 + 5 });
for (const [label, entry] of [
  ["null", null],
  ["a string", "tr-x"],
  ["a numeric id", { ...goodRecord, id: 7 }],
  ["a missing text", { id: "tr-1", openedAt: T0, status: "delivered" }],
  ["a numeric text", { ...goodRecord, id: "tr-2", text: 7 }],
  ["a status outside the five", { ...goodRecord, id: "tr-3", status: "closed" }],
  ["a missing status", { id: "tr-4", text: "t", openedAt: T0 }],
  ["a missing openedAt", { id: "tr-5", text: "t", status: "delivered" }],
  ["a string openedAt", { ...goodRecord, id: "tr-6", openedAt: String(T0) }],
  ["a null openedAt", { ...goodRecord, id: "tr-7", openedAt: null }],
  ["a numeric turnId", { ...goodRecord, id: "tr-8", turnId: 7 }],
  ["a numeric goalId", { ...goodRecord, id: "tr-9", goalId: 7 }],
  ["a numeric planPath", { ...goodRecord, id: "tr-10", planPath: 7 }],
  ["a numeric taskId", { ...goodRecord, id: "tr-11", taskId: 7 }],
  ["a string closedAt", { ...goodRecord, id: "tr-12", closedAt: "later" }],
  ["a null closedAt", { ...goodRecord, id: "tr-13", closedAt: null }],
]) {
  const parsed = parseState(recordStore([goodRecord, entry]));
  check(`a record with ${label} is dropped and the well-formed one kept`,
    parsed.turnRecords.length === 1 && parsed.turnRecords[0].id === "tr-good", parsed.turnRecords);
}
const everyField = { ...goodRecord, id: "tr-full", turnId: "t-1", goalId: "task-1", planPath: "docs/plans/a_v1.md", taskId: "tk-1" };
const parsedFull = parseState(recordStore([everyField]));
check("a record carrying every optional field is kept (the control)",
  JSON.stringify(parsedFull.turnRecords) === JSON.stringify([everyField]), parsedFull.turnRecords);
const parsedBare = parseState(recordStore([{ id: "tr-bare", text: "t", openedAt: T0, status: "delivered" }]));
check("a record carrying no optional field is kept (the control)",
  parsedBare.turnRecords.length === 1 && parsedBare.turnRecords[0].id === "tr-bare", parsedBare.turnRecords);

console.log("\nA stored text past the maximum");
const longText = "x".repeat(TURN_RECORD_TEXT_MAX + 20);
const parsedLong = parseState(recordStore([{ ...goodRecord, text: longText }]));
check("a text past the maximum is cut to it and the record kept",
  parsedLong.turnRecords.length === 1 && parsedLong.turnRecords[0].text === "x".repeat(TURN_RECORD_TEXT_MAX),
  parsedLong.turnRecords[0] && parsedLong.turnRecords[0].text.length);

// --- The timeout, in both directions ---
console.log("\nThe timeout at a load");
const staleLoad = parseState(recordStore([record("tr-stale", { openedAt: nowish - TURN_RECORD_TIMEOUT_MS - 1000 })]));
check("an open record older than the timeout loads expired with a closedAt",
  staleLoad.turnRecords.length === 1 && staleLoad.turnRecords[0].status === "expired"
  && Number.isFinite(staleLoad.turnRecords[0].closedAt) && staleLoad.turnRecords[0].closedAt >= nowish,
  staleLoad.turnRecords);
const youngLoad = parseState(recordStore([record("tr-young", { openedAt: nowish - 60_000 })]));
check("an open record younger than the timeout loads open with no closedAt",
  youngLoad.turnRecords.length === 1 && youngLoad.turnRecords[0].status === "open"
  && youngLoad.turnRecords[0].closedAt === undefined, youngLoad.turnRecords);
// 1e999 parses out of JSON as Infinity, which is the one non-finite number a
// stored clock can actually carry: JSON has no NaN and no Infinity literal.
const infiniteLoad = parseState(recordStore([record("tr-infinite", { openedAt: "__INF__" })]).replace('"__INF__"', "1e999"));
check("an open record whose openedAt is not a finite number loads expired",
  infiniteLoad.turnRecords.length === 1 && infiniteLoad.turnRecords[0].status === "expired"
  && Number.isFinite(infiniteLoad.turnRecords[0].closedAt), infiniteLoad.turnRecords);

console.log("\nThe timeout on a live state");
const timeoutLive = stateWith([
  record("tr-stale", { openedAt: T0 - TURN_RECORD_TIMEOUT_MS }),
  record("tr-young", { openedAt: T0 - TURN_RECORD_TIMEOUT_MS + 1 }),
]);
reapTurnRecords(timeoutLive, T0);
check("the reap expires the record at the timeout and keeps the one inside it",
  timeoutLive.turnRecords.map((r) => r.status).join(",") === "expired,open"
  && timeoutLive.turnRecords[0].closedAt === T0, timeoutLive.turnRecords);
const untouched = stateWith([record("tr-keep", { openedAt: T0 })]);
const { turnRecords: _ignoredRecords, ...recordRestBefore } = untouched;
const recordOtherFieldsBefore = JSON.stringify(recordRestBefore);
reapTurnRecords(untouched, T0);
const { turnRecords: _afterRecords, ...recordRestAfter } = untouched;
check("the reap changes no field but turnRecords", JSON.stringify(recordRestAfter) === recordOtherFieldsBefore);

// --- The cap ---
console.log("\nThe cap");
const closedRecords = Array.from({ length: TURN_RECORDS_MAX + 1 }, (_, i) =>
  record(`tr-c${i}`, { openedAt: T0 + i, status: "delivered", closedAt: T0 + 100 + i }));
const capped = stateWith(closedRecords.map((r) => ({ ...r })));
reapTurnRecords(capped, T0 + 1000);
check("twenty-one closed records leave twenty, the oldest-opened dropped",
  capped.turnRecords.length === TURN_RECORDS_MAX && !capped.turnRecords.some((r) => r.id === "tr-c0")
  && capped.turnRecords[0].id === "tr-c1" && capped.turnRecords[TURN_RECORDS_MAX - 1].id === `tr-c${TURN_RECORDS_MAX}`,
  capped.turnRecords.map((r) => r.id));
const cappedWithOpen = stateWith([
  record("tr-open", { openedAt: T0 }),
  ...closedRecords.map((r) => ({ ...r })),
]);
reapTurnRecords(cappedWithOpen, T0 + 1000);
check("the open record is never dropped by the cap, and twenty closed ones stand beside it",
  cappedWithOpen.turnRecords.length === TURN_RECORDS_MAX + 1
  && cappedWithOpen.turnRecords[0].id === "tr-open" && cappedWithOpen.turnRecords[0].status === "open"
  && !cappedWithOpen.turnRecords.some((r) => r.id === "tr-c0"), cappedWithOpen.turnRecords.map((r) => r.id));
const underCap = stateWith(closedRecords.slice(0, TURN_RECORDS_MAX).map((r) => ({ ...r })));
reapTurnRecords(underCap, T0 + 1000);
check("twenty closed records are all kept (the control)",
  underCap.turnRecords.length === TURN_RECORDS_MAX && underCap.turnRecords[0].id === "tr-c0",
  underCap.turnRecords.map((r) => r.id));

// --- The one-open repair ---
console.log("\nTwo open records at a load");
const twoOpen = parseState(recordStore([
  record("tr-older", { openedAt: nowish - 60_000 }),
  record("tr-newer", { openedAt: nowish - 1000 }),
]));
check("the newer open record stays open and the older is superseded with a closedAt",
  twoOpen.turnRecords.length === 2
  && twoOpen.turnRecords.find((r) => r.id === "tr-newer").status === "open"
  && twoOpen.turnRecords.find((r) => r.id === "tr-older").status === "superseded"
  && Number.isFinite(twoOpen.turnRecords.find((r) => r.id === "tr-older").closedAt), twoOpen.turnRecords);
const twoOpenReversed = parseState(recordStore([
  record("tr-newer", { openedAt: nowish - 1000 }),
  record("tr-older", { openedAt: nowish - 60_000 }),
]));
check("the repair reads the clock, not the stored order",
  twoOpenReversed.turnRecords.find((r) => r.id === "tr-newer").status === "open"
  && twoOpenReversed.turnRecords.find((r) => r.id === "tr-older").status === "superseded", twoOpenReversed.turnRecords);
const oneOpen = parseState(recordStore([record("tr-one", { openedAt: nowish - 1000 })]));
check("one open record is left open (the control)",
  oneOpen.turnRecords.length === 1 && oneOpen.turnRecords[0].status === "open"
  && oneOpen.turnRecords[0].closedAt === undefined, oneOpen.turnRecords);

// --- openTurnRecord and a new record id ---
console.log("\nThe open record and a new record id");
check("openTurnRecord returns the one open record",
  openTurnRecord(oneOpen)?.id === "tr-one", openTurnRecord(oneOpen));
check("openTurnRecord returns null where every record is closed",
  openTurnRecord(parseState(recordStore([goodRecord]))) === null);
check("openTurnRecord returns null where there are no records", openTurnRecord(fresh) === null);
const rid1 = newTurnRecordId(T0);
const rid2 = newTurnRecordId(T0);
check("a record id never takes a goal node's, a long-term goal's or a task's prefix",
  !/^(root|plan|task|lt|tk)-/.test(rid1), rid1);
check("two record ids minted at one clock differ", rid1 !== rid2, [rid1, rid2]);

// --- Summary ---
console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${failed} failures`);
process.exit(failed === 0 ? 0 : 1);
