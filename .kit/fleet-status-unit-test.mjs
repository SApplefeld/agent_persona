#!/usr/bin/env node
// fleet-status-unit-test.mjs: the fleet_status tool, driven through the
// tick-harness fake $ with the roster, keeper state files and hold marker
// under .kit/fixtures/ seeded into the fake filesystem.
//
// Proves:
//   - one row per roster persona, for a healthy one, a held one, one backing
//     off, one with no keeper.json and one absent from the commons
//   - the run directory a roster entry without `rundir` derives
//   - the two standings the reach rule admits (the coordinator persona's
//     holder, and a session holding a live reader claim on it) and the two it
//     refuses (a worker, and a reader of some other persona)
//   - a roster that is missing, that is not an array, and a setting naming no
//     roster at all, each reported in place of rows rather than thrown
//   - the tool writes nothing and deletes nothing, the stale commons entry it
//     reads a heartbeat age from included
//   - the base keeper delay this plugin compares against is the one
//     bin/keeper-functions.ps1 holds
//
// The harness's resolve hook is what makes hooks/index.ts loadable: a static
// top-level import of it does not resolve under plain Node ESM, because its
// sibling imports carry no extension. Each case takes a fresh module instance
// through the query string.
//
// Usage: node fleet-status-unit-test.mjs
// Exits 0 on success, 1 on failure.

import { readFileSync } from "node:fs";
import { createFake$, stubDateNow, SESSION_ID } from "./tick-harness.mjs";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  OK: ${name}`);
  } else {
    console.error(`  FAIL: ${name}`);
    if (detail !== undefined) console.error(`        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    failures++;
  }
}

const PLUGIN_MODULE = "../hooks/index.ts";

const T0 = 1_700_000_000_000;
const STALE_AFTER_MS = 90_000;
const ROSTER_PATH = "D:/fleet/fleet.json";

const OPTS = {
  arming: "owner",
  persona: "coordinator",
  coordinatorPersona: "coordinator",
  staleAfterMs: STALE_AFTER_MS,
  fleetRoster: ROSTER_PATH,
};

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

async function loadPlugin(caseName) {
  return import(`${PLUGIN_MODULE}?case=${encodeURIComponent(caseName)}`);
}

// A session with the plugin registered and session.start fired, which is what
// takes this session's own commons claim. Every seed a case makes goes in
// after this call: session.start reads the claims through readAllClaims, which
// collects stale entries as it reads, and one case's whole subject is a stale
// entry surviving to be read.
async function startSession(caseName, overrides = {}) {
  const opts = { ...OPTS, ...overrides };
  const h = createFake$(opts);
  const mod = await loadPlugin(caseName);
  const handlers = {};
  const on = (event, handler) => { handlers[event] = handler; };
  await mod.register(on, opts);
  await handlers["session.start"](h.fake, {}, () => {});
  h.handlers = handlers;
  return h;
}

function callFleetStatus(h) {
  return h.handlers["tool.call"](h.fake, { tool: "mcp__agentic-plugin__fleet_status" }, async () => ({ result: "passthrough" }));
}

// The five personas of .kit/fixtures/fleet-status.roster.json, as the machine
// they describe would look: alpha up and inside a turn, beta held with its
// session gone, gamma backing off, delta never started by the keeper, epsilon
// disabled and absent from the commons. beta and delta carry no `rundir`, so
// their keeper files sit under the <workdir>/run the tool derives.
function seedFleet(h) {
  h.fsMap.set(ROSTER_PATH, fixture("fleet-status.roster.json"));
  h.fsMap.set("D:/fleet/alpha/run/keeper.json", fixture("fleet-status.keeper-alpha.json"));
  h.fsMap.set("D:/fleet/beta/work/run/keeper.json", fixture("fleet-status.keeper-beta.json"));
  h.fsMap.set("D:/fleet/beta/work/run/keeper.hold", fixture("fleet-status.hold-beta.txt"));
  h.fsMap.set("D:/fleet/gamma/run/keeper.json", fixture("fleet-status.keeper-gamma.json"));
  h.fsMap.set("D:/fleet/epsilon/run/keeper.json", fixture("fleet-status.keeper-epsilon.json"));

  h.storeMap.set("commons:alpha-session", {
    sessionId: "alpha-session",
    lastSeen: T0 - 5_000,
    claims: [{ resource: "persona:alpha", claimedAt: T0 - 600_000 }],
    turnStartedAt: T0 - 45_000,
    workdir: "D:/fleet/alpha/work",
  });
  h.storeMap.set("commons:beta-session", {
    sessionId: "beta-session",
    lastSeen: T0 - 600_000,
    claims: [{ resource: "persona:beta", claimedAt: T0 - 900_000 }],
    turnStartedAt: null,
    workdir: "D:/fleet/beta/work",
  });
  h.storeMap.set("commons:delta-session", {
    sessionId: "delta-session",
    lastSeen: T0 - 1_000,
    claims: [{ resource: "persona:delta", claimedAt: T0 - 300_000 }],
    turnStartedAt: null,
    workdir: "D:/fleet/delta/work",
  });
}

// The report a served call carries. A call that returned no result, or one
// whose result is not the JSON the tool promises, reads as an empty report
// with the reason in `problem`, so the case that asked for it fails on its own
// assertions instead of ending the run on a parse error.
function reportOf(result) {
  if (typeof result?.result !== "string") return { rows: [], problem: `the tool returned no result: ${JSON.stringify(result)}` };
  try {
    const parsed = JSON.parse(result.result);
    return Array.isArray(parsed?.rows) ? parsed : { rows: [], problem: `the tool's result carries no rows: ${result.result}` };
  } catch {
    return { rows: [], problem: `the tool's result is not JSON: ${result.result}` };
  }
}

function rowFor(report, name) {
  return report.rows.find((row) => row.name === name) ?? {};
}

// Whether a message the tool wrote carries a phrase. Text the tool did not
// write at all reads as a message that does not carry it, so the case fails on
// its assertion rather than on a call against undefined.
function says(text, phrase) {
  return String(text ?? "").includes(phrase);
}

// ============================================================
// The five rows
// ============================================================
async function caseRows() {
  console.log("\n=== fleet_status: one row per roster persona ===");
  const h = await startSession("rows");
  seedFleet(h);
  const result = await callFleetStatus(h);
  check("rows: the call is served, not denied", !result?.deny, result);

  const report = reportOf(result);
  check("rows: the result names the roster it read", report.roster === ROSTER_PATH, report.roster);
  check("rows: the result carries the staleness threshold heartbeat ages are read against", report.staleAfterMs === STALE_AFTER_MS, report.staleAfterMs);
  check("rows: one row per roster entry, in roster order", JSON.stringify(report.rows.map((r) => r.name)) === JSON.stringify(["alpha", "beta", "gamma", "delta", "epsilon"]), report.rows.map((r) => r.name));
  check("rows: no entry was reported as a problem", report.problems === undefined, report.problems);

  const alpha = rowFor(report, "alpha");
  check("healthy: enabled", alpha.enabled === true, alpha);
  check("healthy: the keeper relaunches it at the base delay", alpha.action === "relaunching" && alpha.delaySeconds === 300, alpha);
  check("healthy: no hold reason", alpha.holdReason === null, alpha);
  check("healthy: the last supervisor exit is the state file's", alpha.lastExitCode === 2, alpha);
  check("healthy: a live session holds its commons claim", alpha.claimHeld === true, alpha);
  check("healthy: the heartbeat age is the claim's last-seen stamp", alpha.heartbeatAgeMs === 5_000, alpha);
  check("healthy: the turn state is the turn the session is inside", alpha.turnState === "in turn" && alpha.turnRunningMs === 45_000, alpha);
  check("healthy: nothing went unread", alpha.note === undefined, alpha);

  const beta = rowFor(report, "beta");
  check("held: the hold marker makes it held", beta.action === "held", beta);
  check("held: the hold reason is the marker's first line", beta.holdReason === "supervisor exited 0: shutdown honored or stop complete", beta);
  check("held: the delay and last exit come from the state file under the derived run directory", beta.delaySeconds === 300 && beta.lastExitCode === 0, beta);
  check("held: no live session holds its commons claim", beta.claimHeld === false, beta);
  check("held: the stopped session's heartbeat age still reads", beta.heartbeatAgeMs === 600_000, beta);
  check("held: a session that is not live has no turn state", beta.turnState === "unknown" && beta.turnRunningMs === undefined, beta);

  const gamma = rowFor(report, "gamma");
  check("backing off: a delay above the base is backing off", gamma.action === "backing off" && gamma.delaySeconds === 1200, gamma);
  check("backing off: the exit code that earned it", gamma.lastExitCode === 3, gamma);
  check("backing off: nothing holds its commons claim and it has no entry", gamma.claimHeld === false && gamma.heartbeatAgeMs === null, gamma);

  const delta = rowFor(report, "delta");
  check("no keeper.json: the row says so and names the run directory", delta.action === "unknown" && typeof delta.note === "string" && delta.note.includes("D:/fleet/delta/work/run"), delta);
  check("no keeper.json: the keeper fields read as absent rather than as zero", delta.delaySeconds === null && delta.lastExitCode === null && delta.holdReason === null, delta);
  check("no keeper.json: the commons half still reports", delta.claimHeld === true && delta.heartbeatAgeMs === 1_000 && delta.turnState === "idle", delta);

  const epsilon = rowFor(report, "epsilon");
  check("absent from the commons: no claim, no heartbeat age, no turn state", epsilon.claimHeld === false && epsilon.heartbeatAgeMs === null && epsilon.turnState === "unknown", epsilon);
  check("absent from the commons: a disabled entry is still a row, marked disabled", epsilon.enabled === false, epsilon);
  check("absent from the commons: its keeper state still reads", epsilon.action === "relaunching" && epsilon.lastExitCode === 130, epsilon);
}

// ============================================================
// The trust boundary
// ============================================================
async function caseDeniedToAWorker() {
  console.log("\n=== fleet_status: denied to a session that owns a named persona of its own ===");
  const h = await startSession("deny_worker", { persona: "worker-a" });
  seedFleet(h);
  const entry = h.storeMap.get(`commons:${SESSION_ID}`);
  check("deny worker control: the session owns persona:worker-a", !!entry && entry.claims.some((c) => c.resource === "persona:worker-a"), entry);

  const result = await callFleetStatus(h);
  check("deny worker: the call is denied", typeof result?.deny === "string", result);
  check("deny worker: the deny names the rule that refused it", says(result?.deny, "reach rule") && says(result?.deny, "'coordinator'") && says(result?.deny, "reader claim"), result?.deny);
  check("deny worker: no rows leak through the deny", result.result === undefined, result);
}

async function caseDeniedToAReaderOfAnotherPersona() {
  console.log("\n=== fleet_status: denied to a reader of some other persona ===");
  const h = await startSession("deny_other_reader", { persona: "worker-a" });
  seedFleet(h);
  // A reader claim on a persona that is not the coordinator: the reach rule
  // grants this session a ground, because it owns a named persona and so may
  // send the coordinator a record, and that ground is not one fleet state is
  // read from.
  const entry = h.storeMap.get(`commons:${SESSION_ID}`);
  entry.claims.push({ resource: "reader:other", claimedAt: T0 - 1_000 });
  h.storeMap.set(`commons:${SESSION_ID}`, entry);

  const result = await callFleetStatus(h);
  check("deny other reader: the call is denied", typeof result?.deny === "string", result);
  check("deny other reader: the deny names the rule that refused it", says(result?.deny, "reach rule"), result?.deny);
}

async function caseAllowedToAReaderOfTheCoordinatorPersona() {
  console.log("\n=== fleet_status: served to a session holding a live reader claim on the coordinator persona ===");
  const h = await startSession("allow_reader", { arming: "reader" });
  seedFleet(h);
  const entry = h.storeMap.get(`commons:${SESSION_ID}`);
  check("allow reader control: the session holds reader:coordinator and owns no persona", !!entry
    && entry.claims.some((c) => c.resource === "reader:coordinator")
    && !entry.claims.some((c) => c.resource.startsWith("persona:")), entry);
  check("allow reader: the tool registers under the reader tier", h.toolRegisters.some((t) => t.name === "fleet_status"), h.toolRegisters.map((t) => t.name));

  const result = await callFleetStatus(h);
  check("allow reader: the call is served, not denied", !result?.deny, result);
  check("allow reader: the rows are the same five", JSON.stringify(reportOf(result).rows.map((r) => r.name)) === JSON.stringify(["alpha", "beta", "gamma", "delta", "epsilon"]), result.result);
}

// ============================================================
// A roster that is not there, not an array, or not named
// ============================================================
async function caseRosterUnreadable() {
  console.log("\n=== fleet_status: a roster that cannot be read is reported, not thrown ===");
  const h = await startSession("roster_missing");
  // No roster seeded: the fake filesystem rejects the read the way a missing
  // file does.
  const missing = await callFleetStatus(h);
  const missingReport = reportOf(missing);
  check("missing roster: no rows and a problem naming the path", missingReport.rows.length === 0 && says(missingReport.problem, ROSTER_PATH), missingReport);

  h.fsMap.set(ROSTER_PATH, JSON.stringify({ alpha: {} }));
  const notArray = await callFleetStatus(h);
  const notArrayReport = reportOf(notArray);
  check("roster that is not an array: no rows and a problem saying so", notArrayReport.rows.length === 0 && says(notArrayReport.problem, "does not hold a JSON array"), notArrayReport);

  h.fsMap.set(ROSTER_PATH, JSON.stringify([{ workdir: "D:/fleet/nameless/work", enabled: true }, { name: "alpha", rundir: "D:/fleet/alpha/run", enabled: true }]));
  h.fsMap.set("D:/fleet/alpha/run/keeper.json", fixture("fleet-status.keeper-alpha.json"));
  const nameless = await callFleetStatus(h);
  const namelessReport = reportOf(nameless);
  check("roster entry with no name: reported as a problem, and the named entry still gets its row", namelessReport.rows.length === 1
    && namelessReport.rows[0].name === "alpha"
    && namelessReport.problems?.length === 1
    && says(namelessReport.problems?.[0], "entry 1"), namelessReport);
}

async function caseRosterSettingUnset() {
  console.log("\n=== fleet_status: no fleetRoster setting at all ===");
  const h = await startSession("roster_unset", { fleetRoster: "" });
  const result = await callFleetStatus(h);
  const report = reportOf(result);
  check("unset roster: no rows and a problem naming the setting", report.rows.length === 0 && says(report.problem, "fleetRoster"), report);
}

// ============================================================
// Read-only
// ============================================================
async function caseWritesNothing() {
  console.log("\n=== fleet_status: writes nothing, creates nothing, deletes nothing ===");
  const h = await startSession("read_only");
  seedFleet(h);
  const storeBefore = JSON.stringify([...h.storeMap.entries()]);
  const fsBefore = JSON.stringify([...h.fsMap.entries()]);

  await callFleetStatus(h);

  check("read-only: the commons store is untouched", JSON.stringify([...h.storeMap.entries()]) === storeBefore, [...h.storeMap.keys()]);
  check("read-only: the filesystem is untouched", JSON.stringify([...h.fsMap.entries()]) === fsBefore, [...h.fsMap.keys()]);
  // The stale entry is the one a claims read would have collected. Its
  // survival is what lets the held persona's row carry a heartbeat age.
  check("read-only: the stale commons entry survives the call", h.storeMap.has("commons:beta-session"), [...h.storeMap.keys()]);
}

// ============================================================
// The base delay, in two files
// ============================================================
function caseBaseDelayMatchesTheKeeper() {
  console.log("\n=== fleet_status: the base keeper delay is one value in two files ===");
  const plugin = readFileSync(new URL("../hooks/index.ts", import.meta.url), "utf8");
  const keeper = readFileSync(new URL("../bin/keeper-functions.ps1", import.meta.url), "utf8");
  const pluginMatch = plugin.match(/const KEEPER_BASE_DELAY_SECONDS = (\d+);/);
  const keeperMatch = keeper.match(/\$script:KeeperBaseDelaySeconds = (\d+)/);
  check("base delay: the plugin declares one", pluginMatch !== null);
  check("base delay: the keeper declares one", keeperMatch !== null);
  check("base delay: the two agree, so a row reads 'backing off' exactly when the keeper escalated",
    pluginMatch !== null && keeperMatch !== null && pluginMatch[1] === keeperMatch[1],
    { plugin: pluginMatch?.[1], keeper: keeperMatch?.[1] });
}

// ============================================================
async function main() {
  const clock = stubDateNow();
  clock.set(T0);
  try {
    await caseRows();
    await caseDeniedToAWorker();
    await caseDeniedToAReaderOfAnotherPersona();
    await caseAllowedToAReaderOfTheCoordinatorPersona();
    await caseRosterUnreadable();
    await caseRosterSettingUnset();
    await caseWritesNothing();
    caseBaseDelayMatchesTheKeeper();
  } finally {
    clock.restore();
  }

  if (failures === 0) {
    console.log("\nPASS: 0 failure(s)");
    process.exit(0);
  }
  console.error(`\nFAIL: ${failures} failure(s)`);
  process.exit(1);
}

main().catch((err) => {
  console.error("fleet-status-unit-test: unhandled error", err);
  process.exit(1);
});
