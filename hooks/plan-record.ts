// plan-record.ts: done and progress read from a plan document.
//
// A queue entry that carries a planPath is judged from the plan document it
// names rather than from a count of turns. This module holds the three parts
// of that read. parsePlanRecord is a pure parser over the document's text,
// with no I/O, so its rules are testable on a string alone. resolvePlanDir
// chooses the directory to read under: the session's live directory, or the
// nearest ancestor of it inside the same checkout that holds the document.
// readPlanRecord joins a stored planPath onto that directory, looks for the
// document in the four places a plan can sit, and hands the text to the
// parser. hooks/index.ts calls the resolver and the reader at the end of each
// turn for the entry that was active when the turn started, when that entry
// has a plan.

import { PLAN_PATH_PATTERN, oneLine } from "./agent-state";

export interface PlanRecord {
  complete: boolean;
  chapters: number;
  sections: number;
  next: string | null;
}

export type PlanRecordReading =
  | { kind: "read"; complete: boolean; chapters: number; sections: number; next: string | null }
  | { kind: "archived"; at: string }
  | { kind: "unreadable"; reason: string };

// The most a plan document may weigh before the reader refuses it. The host's
// file API exposes exists, read and write and the plugin uses no stat, so the
// cap is enforced on the UTF-8 byte length of the text read back rather than
// on a size read before the read.
export const PLAN_RECORD_MAX_BYTES = 256 * 1024;

// The three places a completed plan is archived to, relative to the working
// directory, each taking the document's own file name. A planPath with no
// file at it and a file of the same name at one of these reads as archived,
// whatever that file's own Status line says. The set is closed at these
// three: a fourth archive folder is not read.
export const PLAN_ARCHIVE_DIRS = ["docs/archive", "docs/archive/plans", "docs/plans/archive"] as const;

const PLAN_DIR_PREFIX = "docs/plans/";

// The parser's rules.
//
// Complete: the first line opening with "Status:" (any case) above the first
// "##" heading has the value "Complete", trimmed, as the whole value, ignoring
// case. "Status: Complete (archived)" and "Status: Completed" are not that
// value. A line with markup around the key, such as "**Status:**", does not
// open with "Status:" and is not that line. A "Status: Complete" line sitting
// below the first "##" heading is outside the header and is never read, so a
// header reading "Status: In Progress" governs over it. A document with no
// Status line in its header is simply not complete.
//
// The Chapters, Sections and Next rules below use the five heading patterns
// the Discord board card in the broker's repository uses, in
// `broker/board/plans.ts`, which the external engine's own reading shares. The
// card and this parser therefore agree on the Chapter count, the section count
// and the next line of the same file. That agreement does not cover Complete,
// which keeps its own rule above.
//
// A block is the lines after its heading up to the next block heading, a line
// opening "##" then whitespace then text. "###" and deeper headings never end
// a block, and neither does "##text" with no whitespace. Only the first
// heading of a block's name opens it: a second "## Chapters" or
// "## Sections of Work" further down is read as a foreign heading that ends
// whatever block is open.
//
// Chapters: the number of "### Chapter N" headings in the "## Chapters"
// block, with any whitespace run between the words. N is the digits; what
// follows them (a colon, a dash and a date, a suffix) is convention rather
// than the contract, so "### Chapter 1: title" counts. "### Interim board N"
// and a "### Chapter" with no number are not Chapters. The block heading is
// "##", whitespace, "Chapters", then nothing but whitespace, so
// "## Chapters (append-only)" opens no block and its Chapters count nothing.
// A document with no such block has zero.
//
// Sections: the number of "### N." headings inside the "## Sections of Work"
// block, where N is one or more digits followed by a period and whitespace.
// The block heading is "##", whitespace, "Sections of Work", then nothing but
// whitespace. A foreign "##" heading inside the block ends it early and drops
// every later section. That edge is the plan-doc contract's own, and the
// board card and the external engine count the same way, so a count that
// disagreed with theirs about the same file would be the wrong one. A "### N."
// line outside the block, and a "#### N." line inside it, count nothing. A
// document with no such block has zero.
//
// Next: the value of the first line opening with "Next:" under the
// highest-numbered Chapter, the Chapters being the headings the count above
// counts. Every line from a Chapter's heading to the next Chapter heading or
// the block's end is under it, an Interim board's lines included. A repeated
// number reads the later-written Chapter, the more recent account of it. The
// first Next: line ends the search whatever its value, so a bare "Next:"
// above a "Next: y" reads null. The value is folded to one line through
// oneLine, its whitespace runs collapsed to one space and trimmed, then cut to
// NEXT_LINE_MAX_CHARS characters, counted so an astral character is never
// halved. That is the card's own order: collapsing first means whitespace
// never spends the cut. An empty value reads null, as does a document with no
// Chapter or a highest Chapter with no Next: line, even where an earlier
// Chapter carries one. The key is case-sensitive and must open the line, as
// the contract reads it. Brackets in the value are kept as written.
export const NEXT_LINE_MAX_CHARS = 200;

const BLOCK_HEADING = /^##\s+.+$/;
const SECTIONS_HEADING = /^##\s+Sections of Work\s*$/;
const CHAPTERS_HEADING = /^##\s+Chapters\s*$/;
const CHAPTER_HEADING = /^###\s+Chapter\s+(\d+)/;
const SECTION_HEADING = /^###\s+(\d+)\.\s+(.*)$/;

function nextValue(raw: string): string | null {
  const collapsed = oneLine(raw).replace(/\s+/g, " ").trim();
  const cut = Array.from(collapsed).slice(0, NEXT_LINE_MAX_CHARS).join("");
  return cut === "" ? null : cut;
}

export function parsePlanRecord(text: string): PlanRecord {
  // The split is the card's own. The LINE_TERMINATOR guard in ./agent-state
  // governs text that leaves the parse for a reader, and the next line is the
  // only free text here that does, so it alone is folded through oneLine.
  const lines = text.split(/\r?\n/);

  let complete = false;
  for (const line of lines) {
    if (/^##/.test(line)) break;
    const m = /^status:(.*)$/i.exec(line);
    if (m) {
      complete = m[1].trim().toLowerCase() === "complete";
      break;
    }
  }

  let chapters = 0;
  let sections = 0;
  let inChapters = false;
  let inSections = false;
  let chaptersOpened = false;
  let sectionsOpened = false;
  // The highest-numbered Chapter seen so far, whether a Next: line has been
  // seen under it and that line's value, and whether the line being read
  // sits under that Chapter.
  let latest = -1;
  let latestNextSeen = false;
  let latestNext: string | null = null;
  let underLatest = false;
  for (const line of lines) {
    if (BLOCK_HEADING.test(line)) {
      inChapters = !chaptersOpened && CHAPTERS_HEADING.test(line);
      inSections = !sectionsOpened && SECTIONS_HEADING.test(line);
      if (inChapters) chaptersOpened = true;
      if (inSections) sectionsOpened = true;
      underLatest = false;
      continue;
    }
    if (inSections && SECTION_HEADING.test(line)) sections += 1;
    if (!inChapters) continue;
    const chapter = CHAPTER_HEADING.exec(line);
    if (chapter) {
      chapters += 1;
      const n = Number(chapter[1]);
      underLatest = n >= latest;
      if (underLatest) {
        latest = n;
        latestNextSeen = false;
        latestNext = null;
      }
      continue;
    }
    if (underLatest && !latestNextSeen) {
      const next = /^Next:(.*)$/.exec(line);
      if (next) {
        latestNextSeen = true;
        latestNext = nextValue(next[1]);
      }
    }
  }

  return { complete, chapters, sections, next: latestNext };
}

// The reader. The host's file functions are passed as two closures rather
// than as the host object itself, since the plugin loader refuses a host noun
// passed as a value. workdir is the directory the session runs in; the join
// is the unconditional "/" the plugin's other workdir joins use, and an empty
// workdir leaves the path relative, as they do.
//
// The stored planPath is re-tested against PLAN_PATH_PATTERN before the join.
// goal_add enforces that pattern on the value it stores, but the store is a
// second producer that validation never sees, so a value read back out of it
// is untrusted at the join. A value failing the re-test is unreadable, and
// the join is never performed on it.
//
// Every read failure is a return value rather than a throw: a rejected read,
// a document over the cap, a planPath failing the re-test, or a document
// absent from planPath and from all three archive places each return
// unreadable with the reason named.
export async function readPlanRecord(
  fs: { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string> },
  workdir: string,
  planPath: string,
): Promise<PlanRecordReading> {
  if (typeof planPath !== "string" || !PLAN_PATH_PATTERN.test(planPath)) {
    return { kind: "unreadable", reason: "planPath fails the shape goal_add enforces" };
  }
  const root = rootOf(workdir);
  const name = planPath.slice(PLAN_DIR_PREFIX.length);

  try {
    if (await fs.exists(root + planPath)) {
      const text = await fs.read(root + planPath);
      if (new TextEncoder().encode(text).length > PLAN_RECORD_MAX_BYTES) {
        return { kind: "unreadable", reason: `document over ${PLAN_RECORD_MAX_BYTES} bytes` };
      }
      const record = parsePlanRecord(text);
      return { kind: "read", complete: record.complete, chapters: record.chapters, sections: record.sections, next: record.next };
    }
    for (const dir of PLAN_ARCHIVE_DIRS) {
      const archived = `${dir}/${name}`;
      if (await fs.exists(root + archived)) {
        return { kind: "archived", at: archived };
      }
    }
    return { kind: "unreadable", reason: "no file at planPath or at any archive place" };
  } catch (err) {
    return { kind: "unreadable", reason: `read failed: ${String(err).slice(0, 150)}` };
  }
}

// The prefix a directory contributes to a joined path: the directory with its
// trailing separators cut and one "/" added, or nothing for an empty one. The
// reader and the directory resolver below join through this one rule, so a
// directory the resolver finds a document under is the directory the reader
// then reads it from.
function rootOf(workdir: string): string {
  return workdir ? `${workdir.replace(/[/\\]+$/, "")}/` : "";
}

// The directory one level above `dir`, by string alone, since the plugin
// loader offers no path API. Both "/" and "\" separate, and trailing
// separators are ignored. A root is its own parent: a POSIX "/", a drive root
// such as "D:\" or "D:/" (or a bare "D:"), and a relative path with no
// separator left. The parent of a directory directly under a drive root keeps
// the drive's separator ("D:\work" gives "D:\"), and one directly under the
// POSIX root gives "/". A network path, one opening with two separators, is
// rooted at its share: "\\server\share" is its own parent, so a walk never
// climbs to the server name or to the current drive's root.
export function parentDir(dir: string): string {
  const trimmed = dir.replace(/[/\\]+$/, "");
  if (trimmed === "" || /^[A-Za-z]:$/.test(trimmed)) return dir;
  if (/^[/\\]{2}[^/\\]*([/\\][^/\\]*)?$/.test(trimmed)) return dir;
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return dir;
  const head = trimmed.slice(0, cut);
  if (head === "") return trimmed.charAt(0);
  if (/^[A-Za-z]:$/.test(head)) return head + trimmed.charAt(cut);
  return head;
}

// The directory the plan document is read under: the live directory, or the
// nearest ancestor of it that holds the document, so a session whose shell
// moved into a subdirectory of its checkout still reads that checkout's copy.
// The walk never leaves the checkout the session works in. A persona's
// worktree sits inside the launch checkout, whose copy of the document is
// stale until the plan's branch merges, so the walk stops at the checkout's
// root, the first folder holding a .git entry (a worktree's .git file or a
// checkout's .git directory), and never tests a folder above it.
// At each directory, starting at the live one, the document is looked for at
// planPath and at each archive place, under the same join and the same
// exists the reader uses. The first directory holding it is returned. A
// directory holding no document but a .git entry ends the walk with no hit.
// The filesystem root, where the parent is the directory itself, ends it
// too. Where the walk ends with no hit, or planPath fails the re-test, or an
// exists call fails, the live directory itself is returned, so the reader
// reports its own reason for it. Nothing is cached: each call walks afresh.
export async function resolvePlanDir(
  fs: { exists: (path: string) => Promise<boolean> },
  liveDir: string,
  planPath: string,
): Promise<string> {
  if (typeof planPath !== "string" || !PLAN_PATH_PATTERN.test(planPath)) return liveDir;
  const name = planPath.slice(PLAN_DIR_PREFIX.length);
  const places = [planPath, ...PLAN_ARCHIVE_DIRS.map((dir) => `${dir}/${name}`)];
  try {
    let dir = liveDir;
    for (;;) {
      const root = rootOf(dir);
      for (const place of places) {
        if (await fs.exists(root + place)) return dir;
      }
      if (await fs.exists(`${root}.git`)) return liveDir;
      const parent = parentDir(dir);
      if (parent === dir) return liveDir;
      dir = parent;
    }
  } catch {
    return liveDir;
  }
}
