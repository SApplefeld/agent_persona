// plan-record.ts: done and progress read from a plan document.
//
// A queue entry that carries a planPath is judged from the plan document it
// names rather than from a count of turns. This module holds the two halves
// of that read. parsePlanRecord is a pure parser over the document's text,
// with no I/O, so its rules are testable on a string alone. readPlanRecord
// joins a stored planPath onto the persona's working directory, looks for the
// document in the four places a plan can sit, and hands the text to the
// parser. hooks/index.ts calls the reader at the end of each turn for the
// entry that was active when the turn started, when that entry has a plan.

import { PLAN_PATH_PATTERN } from "./agent-state";

export interface PlanRecord {
  complete: boolean;
  chapters: number;
}

export type PlanRecordReading =
  | { kind: "read"; complete: boolean; chapters: number }
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
// Chapters: the number of "### Chapter N" headings under the "## Chapters"
// heading, counted up to the next "## " heading. N is the digits; what
// follows them (a colon, a dash and a date, a suffix) is convention rather
// than the contract, so "### Chapter 1: title" counts. "### Interim board N"
// and a "### Chapter" with no number are not Chapters. The heading may carry
// text after the word, as "## Chapters (append-only)" does. A document with
// no "## Chapters" section has zero.
export function parsePlanRecord(text: string): PlanRecord {
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
  let inChapters = false;
  for (const line of lines) {
    if (/^## /.test(line)) {
      inChapters = /^## Chapters\b/.test(line);
      continue;
    }
    if (inChapters && /^### Chapter \d+(?!\d)/.test(line)) chapters += 1;
  }

  return { complete, chapters };
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
  const root = workdir ? `${workdir.replace(/[/\\]+$/, "")}/` : "";
  const name = planPath.slice(PLAN_DIR_PREFIX.length);

  try {
    if (await fs.exists(root + planPath)) {
      const text = await fs.read(root + planPath);
      if (new TextEncoder().encode(text).length > PLAN_RECORD_MAX_BYTES) {
        return { kind: "unreadable", reason: `document over ${PLAN_RECORD_MAX_BYTES} bytes` };
      }
      const record = parsePlanRecord(text);
      return { kind: "read", complete: record.complete, chapters: record.chapters };
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
