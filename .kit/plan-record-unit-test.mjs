#!/usr/bin/env node
// plan-record unit tests: the Complete rule and its near misses, the Chapter
// count, the section count, the next line, and the reader's four places, cap
// and planPath re-test, driven over
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
check("## Chapters (append-only) no longer opens the block, so its Chapter counts 0",
  parsePlanRecord(doc("Status: In Progress", "\n## Chapters (append-only)\n\n### Chapter 1\n")).chapters === 0);
check("###  Chapter 3, double-spaced, is a Chapter",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["###  Chapter 3"]))).chapters === 1);
check("##  Chapters, double-spaced, opens the block",
  parsePlanRecord(doc("Status: In Progress", "\n##  Chapters\n\n### Chapter 1\n")).chapters === 1);
check("only the first ## Chapters block is read: a second one's Chapters count nothing",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter 1"]) + "\n## Related\n" + chaptersBody(["### Chapter 2", "### Chapter 3"]))).chapters === 1);
check("a CRLF Chapters section counts",
  parsePlanRecord(doc("Status: In Progress", chaptersBody(["### Chapter 1", "### Chapter 2"])).replace(/\n/g, "\r\n")).chapters === 2);

// --- The section count ---
console.log("\n=== parsePlanRecord: the section count ===");
const sectionsBody = (headings) => `\n## Sections of Work\n\n${headings.map((h) => `${h}\n\nModel: opus\n\nWhat to build.\n`).join("\n")}`;
check("no ## Sections of Work block counts 0", parsePlanRecord(doc("Status: In Progress")).sections === 0);
check("an empty ## Sections of Work block counts 0", parsePlanRecord(doc("Status: In Progress", sectionsBody([]))).sections === 0);
check("three ### N. headings count 3",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 1. One", "### 2. Two", "### 3. Three"]))).sections === 3);
check("a foreign ## heading ends the block: three sections, ## Out of Scope, then ### 4. counts 3",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 1. One", "### 2. Two", "### 3. Three"]) + "\n## Out of Scope\n\n### 4. Four\n")).sections === 3);
check("a ### 1. heading above the block counts nothing",
  parsePlanRecord(doc("Status: In Progress", "\n### 1. Stray\n" + sectionsBody(["### 1. One"]))).sections === 1);
check("a #### 1. heading inside the block counts nothing",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 1. One", "#### 1. Sub-step"]))).sections === 1);
check("a multi-digit section number counts",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 10. Ten", "### 123. Many"]))).sections === 2);
check("a heading with no period, no whitespace after it, or no number counts nothing (digits, a period, whitespace)",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 1 One", "### 1.One", "### 1.", "### One. Title", "###1. Tight"]))).sections === 0);
check("a tab after the period counts (whitespace, not only a space)",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 1.\tOne"]))).sections === 1);
check("Chapter headings are not sections, and the block ends at ## Chapters",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 1. One", "### 2. Two"]) + chaptersBody(["### Chapter 1", "### 3. Not a section"]))).sections === 2);
check("## Sections of Work with trailing text opens no block (the literal heading is the contract's)",
  parsePlanRecord(doc("Status: In Progress", "\n## Sections of Work (draft)\n\n### 1. One\n")).sections === 0);
check("## Sections of Work with only trailing whitespace still opens the block",
  parsePlanRecord(doc("Status: In Progress", "\n## Sections of Work  \t\n\n### 1. One\n")).sections === 1);
check("an indented ### 1. line counts nothing (opening rule)",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["  ### 1. One", "### 2. Two"]))).sections === 1);
check("##  Sections of Work, double-spaced, opens the block and counts its sections",
  parsePlanRecord(doc("Status: In Progress", "\n##  Sections of Work\n\n### 1. One\n\n### 2. Two\n")).sections === 2);
check("a ## heading with a tab, ##\\tOut of Scope, ends the block",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 1. One", "### 2. Two"]) + "\n##\tOut of Scope\n\n### 3. Three\n")).sections === 2);
check("##Out of Scope, with no whitespace, is no heading and does not end the block",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 1. One"]) + "\n##Out of Scope\n\n### 2. Two\n")).sections === 2);
check("only the first ## Sections of Work block is read: a second one's sections count nothing",
  parsePlanRecord(doc("Status: In Progress", sectionsBody(["### 1. One"]) + "\n## Related\n" + sectionsBody(["### 2. Two", "### 3. Three"]))).sections === 1);

// --- The next line ---
console.log("\n=== parsePlanRecord: the next line ===");
const chapter = (n, lines = []) => [`### Chapter ${n} - 2026-10-01`, "", ...lines].join("\n");
check("no ## Chapters block reads null", parsePlanRecord(doc("Status: In Progress")).next === null);
check("a ## Chapters block with no Chapter reads null",
  parsePlanRecord(doc("Status: In Progress", "\n## Chapters\n\nNext: stray before any Chapter\n")).next === null);
check("the one Chapter's Next: line is read, trimmed",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Completed: 1. One", "Next:   2. Two  "])]))).next === "2. Two");
check("the highest-numbered Chapter's line is read, though Chapter 3 is written above Chapter 2",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next: from one"]), chapter(3, ["Next: from three"]), chapter(2, ["Next: from two"])]))).next === "from three");
check("a highest Chapter with no Next: line reads null, though an earlier Chapter has one",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next: from one"]), chapter(2, ["Completed: 2. Two"])]))).next === null);
check("the first Next: line in the Chapter is read, not a later one",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next: first", "Prose.", "Next: second"])]))).next === "first");
check("a repeated Chapter number reads the later-written one, the more recent account",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(2, ["Next: earlier"]), chapter(2, ["Next: later"])]))).next === "later");
check("Chapter 10 outranks Chapter 9 (numeric, not text, order)",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(10, ["Next: ten"]), chapter(9, ["Next: nine"])]))).next === "ten");
check("a Next: line past the ## heading that ends the block is not the Chapter's",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Completed: 1. One"])]) + "\n## Related\n\nNext: outside\n")).next === null);
check("an indented, marked-up or lower-case key is not the line (opening rule, case-sensitive)",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["  Next: indented", "**Next:** marked", "next: lower"])]))).next === null);
check("the Chapter's own first Next: line is read ahead of an Interim board's later one",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next: from one"]), "### Interim board 2\n\nNext: from the board"]))).next === "from one");
check("an Interim board after a latest Chapter with no Next: line contributes its Next: line, as the card reads it",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Completed: 1. One"]), "### Interim board 2\n\nNext: from the board"]))).next === "from the board");
check("internal whitespace runs collapse to single spaces",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next: a   b\t\tc  \t d"])]))).next === "a b c d");
{
  const got = parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next: a\vb\fc\u0085d"])]))).next;
  check("a VT, an FF and a NEL in the value each fold to a space, so the value is one line", got === "a b c d", got);
}
check("brackets in the value come back verbatim",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next: [COORDINATOR id=1] x"])]))).next === "[COORDINATOR id=1] x");
check("a bare Next: reads null",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next:"])]))).next === null);
check("a Next: holding only whitespace reads null",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next: \t \v "])]))).next === null);
check("a bare Next: then Next: y reads null, since the first Next: line ends the search",
  parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, ["Next:", "Next: y"])]))).next === null);
{
  // The collapse runs before the cut, so whitespace runs never spend the 200.
  const value = Array.from({ length: 150 }, () => "w").join("     ");
  const got = parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, [`Next: ${value}`])]))).next;
  const want = Array.from({ length: 150 }, () => "w").join(" ").slice(0, 200);
  check("whitespace collapses before the 200-character cut", got === want, got && got.length);
}
{
  const long = "n".repeat(300);
  const got = parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, [`Next: ${long}`])]))).next;
  check("a 300-character value comes back as its first 200", got === long.slice(0, 200), got && got.length);
}
{
  const exact = "e".repeat(200);
  const got = parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, [`Next: ${exact}`])]))).next;
  check("a value of exactly 200 characters comes back whole", got === exact, got && got.length);
}
{
  // An astral character spans two UTF-16 units. The cut counts characters, so
  // one standing at position 200 is kept whole rather than halved.
  const value = "a".repeat(199) + "\u{1F600}" + "b".repeat(10);
  const got = parsePlanRecord(doc("Status: In Progress", chaptersBody([chapter(1, [`Next: ${value}`])]))).next;
  check("the cut counts characters, so an astral character at the boundary is kept whole", got === "a".repeat(199) + "\u{1F600}", got && got.length);
}

// --- CRLF ---
console.log("\n=== parsePlanRecord: a CRLF document parses as its LF form does ===");
{
  const lf = doc("Status: In Progress", sectionsBody(["### 1. One", "### 2. Two", "### 3. Three"]) + chaptersBody([chapter(1, ["Completed: 1. One", "Next: 2. Two"]), chapter(2, ["Completed: 2. Two", "Next: 3. Three"])]));
  const a = parsePlanRecord(lf);
  const b = parsePlanRecord(lf.replace(/\n/g, "\r\n"));
  check("the LF form reads 3 sections, 2 Chapters and Chapter 2's line", a.sections === 3 && a.chapters === 2 && a.next === "3. Three", a);
  check("the CRLF form reads the same four values, with no carriage return left on the line",
    JSON.stringify(b) === JSON.stringify(a), b);
}

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
  const text = doc("Status: In Progress", "\n## Sections of Work\n\n### 1. One\n\n### 2. Two\n" + chaptersBody(["### Chapter 1\n\nNext: 2. Two"]));
  const fs = fakeFs({ [`${WD}/${PATH}`]: text });
  const r = await readPlanRecord(fs, WD, PATH);
  check("a read reading carries the section count and the next line", r.kind === "read" && r.sections === 2 && r.next === "2. Two", r);
}
{
  const fs = fakeFs({ [`${WD}/${PATH}`]: doc("Status: In Progress") });
  const r = await readPlanRecord(fs, WD, PATH);
  check("a read reading of a document with neither carries 0 and null", r.kind === "read" && r.sections === 0 && r.next === null, r);
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
