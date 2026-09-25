#!/usr/bin/env node
// Task store test: the task list beside the goal tree. Pins the load of a
// store written before the list existed (v2, v3 and v4 all load at version 5
// with an empty list), the tolerance for a malformed list or entry, and the
// completion reap in both directions: a task under a complete or abandoned
// goal, or under no goal at all, is dropped, and one under a pending, active,
// paused or blocked goal is kept, both at a load and when the reap is called
// on a live state. The persist-path reap, which needs a session, is pinned in
// controller-tick-test.mjs.
// Usage: node task-store-unit-test.mjs
// Exits 0 on success, 1 on failure.

import { readFileSync } from "fs";
import { createDefaultState, newTaskId, parseState, reapCompletedGoalTasks } from "../hooks/agent-state.ts";

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
// A v5 store built from the fixture, carrying the goals and tasks given.
function v5Store(goals, tasks) {
  return JSON.stringify({ ...JSON.parse(fixtureText), version: 5, goals, activeGoalId: null, tasks });
}

// --- A store written before the list existed ---
console.log("\nFixture: state-v4-no-tasks.json (v4, tasks absent)");
check("the fixture is a v4 store with no tasks key (the instrument)",
  JSON.parse(fixtureText).version === 4 && !fixtureText.includes("\"tasks\""));
const fromV4 = parseState(fixtureText);
check("v4 loads at version 5", fromV4.version === 5, fromV4.version);
check("v4 loads with an empty task list", Array.isArray(fromV4.tasks) && fromV4.tasks.length === 0, fromV4.tasks);
check("v4 keeps its tree and its active goal",
  fromV4.goals.length === 2 && fromV4.activeGoalId === "task-1", { goals: fromV4.goals.length, active: fromV4.activeGoalId });

console.log("\nOlder versions: v3 and v2");
const fromV3 = parseState(JSON.stringify({ ...JSON.parse(fixtureText), version: 3 }));
check("v3 loads at version 5 with an empty task list",
  fromV3.version === 5 && Array.isArray(fromV3.tasks) && fromV3.tasks.length === 0, { version: fromV3.version, tasks: fromV3.tasks });
const v2 = {
  version: 2, persona: "test-persona", activeSessionId: "s-2", epoch: 1, memory: [],
  goal: { id: "goal-x", objective: "Old goal", maxRounds: 5, completedRounds: 0, status: "active", createdAt: T0, updatedAt: T0, scores: [] },
  monitor: { sessionStart: T0, turnCount: 0, totalToolCalls: 0, errors: 0 },
  decisions: [], createdAt: T0, updatedAt: T0,
};
const fromV2 = parseState(JSON.stringify(v2));
check("v2 loads at version 5 with an empty task list",
  fromV2.version === 5 && Array.isArray(fromV2.tasks) && fromV2.tasks.length === 0, { version: fromV2.version, tasks: fromV2.tasks });

console.log("\nThe current version and the ones past it");
const heldGoals = [goal("root-1", null, "pending"), goal("task-1", "root-1", "active")];
const held = [task("tk-a", "task-1"), task("tk-b", "task-1", { done: true, doneAt: T0 + 5 })];
const fromV5 = parseState(v5Store(heldGoals, held));
check("a v5 store's list under an open goal loads as it was",
  fromV5.version === 5 && JSON.stringify(fromV5.tasks) === JSON.stringify(held), fromV5.tasks);
let threw = null;
try { parseState(JSON.stringify({ ...JSON.parse(fixtureText), version: 6 })); } catch (e) { threw = e; }
check("a version past 5 is refused as unsupported",
  threw instanceof Error && threw.message.includes("Unsupported AgentState version: 6"), threw && threw.message);

// --- Malformed input ---
console.log("\nA stored list that is not a list");
for (const [label, value] of [["null", null], ["a string", "x"], ["an object", { a: 1 }], ["a number", 7]]) {
  const parsed = parseState(v5Store(heldGoals, value));
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
  const parsed = parseState(v5Store(heldGoals, [good, entry]));
  check(`an entry with ${label} is dropped and the well-formed one kept`,
    parsed.tasks.length === 1 && parsed.tasks[0].id === "tk-good", parsed.tasks);
}
const parsedOpen = parseState(v5Store(heldGoals, [goodNoDoneAt]));
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
const loaded = parseState(v5Store(reapGoals, reapTasks));
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
check("a new state is version 5 with an empty task list",
  fresh.version === 5 && Array.isArray(fresh.tasks) && fresh.tasks.length === 0, { version: fresh.version, tasks: fresh.tasks });
const id1 = newTaskId(T0);
const id2 = newTaskId(T0);
const m = /^tk-([0-9a-z]+)-[0-9a-z]+$/.exec(id1);
check("a task id carries the tk- prefix and the clock in base 36", m !== null && parseInt(m[1], 36) === T0, id1);
check("a task id never takes a goal node's prefix",
  !/^(root|plan|task|lt)-/.test(id1), id1);
check("two ids minted at one clock differ", id1 !== id2, [id1, id2]);

// --- Summary ---
console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${failed} failures`);
process.exit(failed === 0 ? 0 : 1);
