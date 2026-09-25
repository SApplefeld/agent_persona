#!/usr/bin/env node
// plan-record unit tests: the Complete rule and its near misses, the Chapter
// count, and the reader's four places, cap and planPath re-test, driven over
// hooks/plan-record.ts with an in-memory fake of the host's file functions.
// Usage: node .kit/plan-record-unit-test.mjs
// Exits 0 on success, 1 on failure.

// hooks/plan-record.ts imports its sibling without an extension, the way the
// plugin loader resolves it; the harness module registers the resolve hook
// that gives Node the same rule, and is imported here for that alone.
await import("./tick-harness.mjs");

const {
  parsePlanRecord,
  readPlanRecord,
  parentDir,
  resolvePlanDir,
  PLAN_RECORD_MAX_BYTES,
  PLAN_ARCHIVE_DIRS,
} = await import("../hooks/plan-record.ts");

let failed = 0;
function ok(name) { console.log(`  OK: ${name}`); }
function fail(name, detail) {
  console.error(`  FAIL: ${name}`);
  if (detail !== undefined) console.error(`        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  failed++;
}
function check(name, cond, detail) { if (cond) ok(name); else fail(name, detail); }

// A document in the shape the repository's own plan template writes: an H1,
// a header of key lines, then H2 sections.
function doc(header, body = "") {
  return `# A plan\n\n${header}\nCreated: 2026-09-20\n\n## Goal\n\nThe goal.\n${body}`;
}

// --- The Complete rule ---
console.log("\n=== parsePlanRecord: the Complete rule ===");
check("Status: Complete completes", parsePlanRecord(doc("Status: Complete")).complete === true);
check("status:   complete   completes (case and whitespace are ignored)", parsePlanRecord(doc("status:   complete  ")).complete === true);
check("STATUS: COMPLETE completes (key case is ignored too)", parsePlanRecord(doc("STATUS: COMPLETE")).complete === true);
check("a CRLF document completes", parsePlanRecord(doc("Status: Complete").replace(/\n/g, "\r\n")).complete === true);
check("the Status line is read from below other header lines", parsePlanRecord(doc("Commit Model: Branch-and-PR\nStatus: Complete")).complete === true);

// --- Near misses, each named by the rule that refuses it ---
console.log("\n=== parsePlanRecord: near misses ===");
check("Status: Complete (archived) does not complete (whole-value rule)", parsePlanRecord(doc("Status: Complete (archived)")).complete === false);
check("Status: Completed does not complete (whole-value rule)", parsePlanRecord(doc("Status: Completed")).complete === false);
check("Status: In Progress does not complete (value rule)", parsePlanRecord(doc("Status: In Progress")).complete === false);
check("**Status:** Complete does not complete (a marked-up key is not the line)", parsePlanRecord(doc("**Status:** Complete")).complete === false);
check("Status: Complete below the first ## heading under Status: In Progress does not complete (header rule)",
  parsePlanRecord(doc("Status: In Progress", "\nStatus: Complete\n")).complete === false);
check("Status: Complete only below the first ## heading does not complete (header rule)",
  parsePlanRecord(doc("Commit Model: Branch-and-PR", "\nStatus: Complete\n")).complete === false);
check("a document with no Status line is not complete", parsePlanRecord(doc("Commit Model: Branch-and-PR")).complete === false);
check("the first Status line governs over a later one in the header (first-line rule)",
  parsePlanRecord(doc("Status: In Progress\nStatus: Complete")).complete === false);
check("an indented Status line does not open with Status: (opening rule)", parsePlanRecord(doc("  Status: Complete")).complete === false);
check("an empty document is not complete", parsePlanRecord("").complete === false);
check("a ### heading ends the header as a ## heading does", parsePlanRecord("# T\n### Note\nStatus: Complete\n").complete === false);

// --- The Chapter count ---
console.log("\n=== parsePlanRecord: the Chapter count ===");
const chaptersBody = (headings) => `\n## Chapters\n\n${headings.map((h) => `${h}\n\nText.\n`).join("\n")}`;
check("no ## Chapters section counts 0", parsePlanRecord(doc("Status: In Progress")).chapters === 0);
check("an empty ## Chapters section counts 0", parsePlanRecord(doc("Status: In Progress", chaptersBody([]))).chapters === 0);
check("two Chapter headings count 2",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter 1 - 2026-09-21", "### Chapter 2 - 2026-09-21"]))).chapters === 2);
check("an Interim board heading is not a Chapter",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Interim board 1 - 2026-09-21", "### Chapter 1 - 2026-09-21", "### Interim board 2 - 2026-09-21"]))).chapters === 1);
check("a Chapter heading outside ## Chapters is not counted",
  parsePlanRecord(doc("Status: In Progress", "\n### Chapter 1\n" + chaptersBody(["### Chapter 1"]))).chapters === 1);
check("a Chapter heading after the next ## section is not counted",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter 1"]) + "\n## Related\n\n### Chapter 2\n")).chapters === 1);
check("a bare ### Chapter heading with no number is not counted",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter", "### Chapter 1"]))).chapters === 1);
check("a two-digit Chapter number counts",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter 10"]))).chapters === 1);
check("### Chapter 1: title counts one (a colon after the number is convention, not the contract)",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter 1: Section 1, delivered in one changeset"]))).chapters === 1);
check("### Chapter 12 - 2026-09-21 still counts one",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter 12 - 2026-09-21"]))).chapters === 1);
check("### Chapter 1b and ### Chapter 8.2 count one each (N is the digits; what follows is convention)",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter 1b", "### Chapter 8.2"]))).chapters === 2);
check("### Chapters and ### Chapter with no number count zero",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapters", "### Chapter "]))).chapters === 0);
check("## Chapters (append-only) still opens the block",
  parsePlanRecord(doc("Status: In Progress", "\n## Chapters (append-only)\n\n### Chapter 1\n")).chapters === 1);
check("a CRLF Chapters section counts",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter 1", "### Chapter 2"])).replace(/\n/g, "\r\n")).chapters === 2);

// --- The reader ---
console.log("\n=== readPlanRecord: the four places, the cap and the re-test ===");
function fakeFs(files) {
  const map = new Map(Object.entries(files));
  const reads = [];
  return {
    reads,
    exists: (p) => Promise.resolve(map.has(p)),
    read: (p) => { reads.push(p); return map.has(p) ? Promise.resolve(map.get(p)) : Promise.reject(new Error("ENOENT: " + p)); },
  };
}
const WD = "D:/work";
const PATH = "docs/plans/a_v1.md";

{
  const fs = fakeFs({ [`${WD}/${PATH}`]: doc("Status: Complete", chaptersBody(["### Chapter 1"])) });
  const r = await readPlanRecord(fs, WD, PATH);
  check("a readable document returns the parser's result", r.kind === "read" && r.complete === true && r.chapters === 1, r);
}
{
  const fs = fakeFs({ [`${WD}/${PATH}`]: doc("Status: In Progress") });
  const r = await readPlanRecord(fs, `${WD}/`, PATH);
  check("a trailing slash on workdir joins the same path", r.kind === "read" && r.complete === false, r);
}
{
  const fs = fakeFs({ [PATH]: doc("Status: Complete") });
  const r = await readPlanRecord(fs, "", PATH);
  check("an empty workdir leaves the path relative", r.kind === "read" && r.complete === true, r);
}
for (const dir of PLAN_ARCHIVE_DIRS) {
  const fs = fakeFs({ [`${WD}/${dir}/a_v1.md`]: doc("Status: In Progress") });
  const r = await readPlanRecord(fs, WD, PATH);
  check(`absent at planPath and present at ${dir} reads as archived, whatever that file says`, r.kind === "archived" && r.at === `${dir}/a_v1.md`, r);
}
check("the archive set is closed at three places", PLAN_ARCHIVE_DIRS.length === 3);
{
  const fs = fakeFs({ [`${WD}/docs/plans/other/a_v1.md`]: doc("Status: Complete") });
  const r = await readPlanRecord(fs, WD, PATH);
  check("a file outside the four places does not count: absent everywhere is unreadable", r.kind === "unreadable", r);
}
{
  const fs = fakeFs({});
  const r = await readPlanRecord(fs, WD, PATH);
  check("absent from all four places is unreadable, not a throw", r.kind === "unreadable" && /no file/.test(r.reason), r);
}
{
  const fs = fakeFs({ [`${WD}/${PATH}`]: doc("Status: Complete") + "x".repeat(PLAN_RECORD_MAX_BYTES) });
  const r = await readPlanRecord(fs, WD, PATH);
  check("a document over the cap is unreadable", r.kind === "unreadable" && /over/.test(r.reason), r);
}
{
  const fs = fakeFs({ [`${WD}/${PATH}`]: "\u00e9".repeat(PLAN_RECORD_MAX_BYTES / 2 + 1) });
  const r = await readPlanRecord(fs, WD, PATH);
  check("the cap is measured in UTF-8 bytes, not characters", r.kind === "unreadable" && /over/.test(r.reason), r);
}
{
  const text = "Status: Complete\n" + "x".repeat(PLAN_RECORD_MAX_BYTES - "Status: Complete\n".length);
  const fs = fakeFs({ [`${WD}/${PATH}`]: text });
  const r = await readPlanRecord(fs, WD, PATH);
  check("a document exactly at the cap is read", r.kind === "read" && r.complete === true, r);
}
{
  const fs = { exists: () => Promise.resolve(true), read: () => Promise.reject(new Error("EACCES")), reads: [] };
  const r = await readPlanRecord(fs, WD, PATH);
  check("a rejected read is unreadable, not a throw", r.kind === "unreadable" && /EACCES/.test(r.reason), r);
}
{
  const fs = { exists: () => { throw new Error("boom"); }, read: () => Promise.resolve(""), reads: [] };
  const r = await readPlanRecord(fs, WD, PATH);
  check("a throwing exists is unreadable, not a throw", r.kind === "unreadable", r);
}

// The re-test: a stored value that fails the shape goal_add enforces is
// unreadable and the join never happens, so the host is never asked about it.
const badPaths = ["../x.md", "docs/plans/sub/x.md", "C:\\x.md", "docs/plans/x.txt", "Docs/plans/x.md", "", "docs/plans/../../secret.md"];
for (const bad of badPaths) {
  let asked = 0;
  const fs = { exists: () => { asked++; return Promise.resolve(true); }, read: () => { asked++; return Promise.resolve(doc("Status: Complete")); }, reads: [] };
  const r = await readPlanRecord(fs, WD, bad);
  check(`re-test refuses ${JSON.stringify(bad)} as unreadable and asks the host nothing`, r.kind === "unreadable" && asked === 0, r);
}
{
  const fs = { exists: () => Promise.resolve(false), read: () => Promise.resolve(""), reads: [] };
  const r = await readPlanRecord(fs, WD, undefined);
  check("a non-string planPath is unreadable", r.kind === "unreadable", r);
}
{
  // Control for the re-test: a well-formed value does reach the host.
  let asked = 0;
  const fs = { exists: () => { asked++; return Promise.resolve(false); }, read: () => Promise.resolve(""), reads: [] };
  await readPlanRecord(fs, WD, PATH);
  check("re-test control: a well-formed planPath does reach the host", asked > 0);
}

// --- The parent walk ---
console.log("\n=== parentDir: one level up, by string, stopping at a root ===");
const parentCases = [
  ["D:\\work\\repo\\hooks", "D:\\work\\repo"],
  ["D:/work/repo/hooks", "D:/work/repo"],
  ["D:/work/repo/hooks/", "D:/work/repo"],
  ["D:\\work/repo\\hooks", "D:\\work/repo"],
  ["D:\\work", "D:\\"],
  ["D:/work", "D:/"],
  ["D:\\", "D:\\"],
  ["D:/", "D:/"],
  ["D:", "D:"],
  ["/home/p/repo/hooks", "/home/p/repo"],
  ["/home", "/"],
  ["/", "/"],
  ["repo", "repo"],
  ["\\\\server\\share\\work", "\\\\server\\share"],
  ["\\\\server\\share", "\\\\server\\share"],
  ["//server/share/", "//server/share/"],
];
for (const [dir, expected] of parentCases) {
  const got = parentDir(dir);
  check(`parentDir(${JSON.stringify(dir)}) is ${JSON.stringify(expected)}`, got === expected, got);
}
for (const start of ["D:\\a\\b\\c\\d", "D:/a/b/c/d", "/a/b/c/d"]) {
  const seen = [start];
  let dir = start;
  while (parentDir(dir) !== dir && seen.length < 20) { dir = parentDir(dir); seen.push(dir); }
  check(`the walk from ${JSON.stringify(start)} ends at a root in five steps`, seen.length === 5 && parentDir(dir) === dir, seen);
}

// --- The directory resolver ---
console.log("\n=== resolvePlanDir: the live directory or its nearest ancestor holding the document ===");
{
  const fs = fakeFs({ [`${WD}/${PATH}`]: doc("Status: Complete") });
  check("a document under the live directory resolves to the live directory", await resolvePlanDir(fs, WD, PATH) === WD);
  check("a document two levels up resolves to that ancestor", await resolvePlanDir(fs, `${WD}/hooks/sub`, PATH) === WD);
}
{
  // The fake keys on the exact joined string, and a backslash directory joins
  // as "D:\work/docs/plans/...", which the host's own file API accepts.
  const fs = fakeFs({ [`D:\\work/${PATH}`]: doc("Status: Complete") });
  const got = await resolvePlanDir(fs, "D:\\work\\hooks", PATH);
  check("a backslash live directory resolves to its ancestor", got === "D:\\work", got);
}
for (const dir of PLAN_ARCHIVE_DIRS) {
  const fs = fakeFs({ [`${WD}/${dir}/a_v1.md`]: doc("Status: In Progress") });
  check(`an archived copy at ${dir} under an ancestor resolves to that ancestor`, await resolvePlanDir(fs, `${WD}/hooks`, PATH) === WD);
}
{
  const fs = fakeFs({ [`${WD}/${PATH}`]: doc("Status: In Progress"), [`${WD}/inner/${PATH}`]: doc("Status: Complete") });
  check("the first hit wins: the nearer ancestor, not a farther one", await resolvePlanDir(fs, `${WD}/inner/hooks`, PATH) === `${WD}/inner`);
}
{
  const fs = fakeFs({ [`D:/${PATH}`]: doc("Status: Complete") });
  check("a Windows drive root is tested and can be the hit", await resolvePlanDir(fs, "D:/work/hooks", PATH) === "D:/");
}
{
  const fs = fakeFs({ [`/${PATH}`]: doc("Status: Complete") });
  check("the POSIX root is tested and can be the hit", await resolvePlanDir(fs, "/home/p/hooks", PATH) === "/");
}
{
  const asked = [];
  const fs = { exists: (p) => { asked.push(p); return Promise.resolve(false); } };
  const got = await resolvePlanDir(fs, "D:\\work\\hooks", PATH);
  check("no ancestor holding it returns the live directory itself", got === "D:\\work\\hooks", got);
  check("the walk tested every level up to and including the drive root, and stopped there",
    asked.some(p => p === `D:/${PATH}`) && asked.filter(p => p.endsWith(`/${PATH}`)).length === 3, asked);
}
{
  const asked = [];
  const fs = { exists: (p) => { asked.push(p); return Promise.resolve(false); } };
  const got = await resolvePlanDir(fs, "/home/p", PATH);
  check("no ancestor holding it on POSIX returns the live directory, having tested the root", got === "/home/p" && asked.includes(`/${PATH}`), asked);
}
{
  // A .git entry between the live directory and an ancestor holding the
  // document ends the walk at that folder with no hit, so the live directory
  // is returned and the ancestor is never asked about.
  const fs = fakeFs({ [`${WD}/${PATH}`]: doc("Status: Complete"), [`${WD}/wt/.git`]: "gitdir: D:/work/.git/worktrees/wt\n" });
  const asked = [];
  const realExists = fs.exists;
  fs.exists = (p) => { asked.push(p); return realExists(p); };
  const got = await resolvePlanDir(fs, `${WD}/wt/hooks`, PATH);
  check("a .git entry between the live directory and the document's ancestor stops the walk with no hit", got === `${WD}/wt/hooks`, got);
  check("the walk tested the .git folder and asked nothing above it",
    asked.includes(`${WD}/wt/.git`) && !asked.some(p => p.startsWith(`${WD}/docs/`)), asked);
}
{
  // The document and a .git entry in the same folder: the document is the hit.
  const fs = fakeFs({ [`${WD}/${PATH}`]: doc("Status: Complete"), [`${WD}/.git`]: "gitdir: x\n" });
  check("a folder holding both the document and .git resolves to that folder", await resolvePlanDir(fs, `${WD}/hooks`, PATH) === WD);
}
{
  const fs = { exists: () => { throw new Error("boom"); } };
  check("a throwing exists returns the live directory, not a throw", await resolvePlanDir(fs, `${WD}/hooks`, PATH) === `${WD}/hooks`);
}
{
  let asked = 0;
  const fs = { exists: () => { asked++; return Promise.resolve(true); } };
  const got = await resolvePlanDir(fs, `${WD}/hooks`, "../x.md");
  check("a planPath failing the re-test returns the live directory and asks the host nothing", got === `${WD}/hooks` && asked === 0, { got, asked });
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
