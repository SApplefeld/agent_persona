// Operator channel: cross-session steering for agentic-plugin.
// D1: Records (inbox, reply, ask) in the commons store.
// D2: Reader claim and tools (agentic_say, agentic_inbox).
//
// Substrate: $.store (per plugin, global across sessions, async JSON values).
// Key layout: one writer per key.
//
// Records:
// - inbox:<persona>:<writerSessionId>:<seq> = { id, from, at, text, kind, answers?, urgent?, status }
// - reply:<persona>:<msgId> = { at, text }
// - ask:<persona>:<askId> = { at, nodeId, question, status }
//
// Writer: the reader session writes inbox records; the owner advances status.
// Reader: the reader session calls agentic_inbox to read replies.

// --- Types ---

export type InboxKind = "say" | "answer";
// "answered" means a turn replied; "resolved" means the owner finished or
// declined the work the record asked for, set through agentic_resolve.
export type InboxStatus = "pending" | "delivered" | "answered" | "skipped" | "resolved";
export type InboxOutcome = "done" | "declined";

export interface InboxRecord {
  id: string;
  key: string; // full store key (for sweep)
  from: string; // writer sessionId
  at: number; // ms timestamp
  text: string;
  kind: InboxKind;
  answers?: string; // askId if kind === "answer"
  urgent?: boolean; // plan item 8.3: delivered inside the owner's running turn, not at the next quiet tick
  status: InboxStatus;
  deliveredAt?: number; // set by owner on delivery
  turnId?: string; // set by owner on turn.start after delivery
  resolvedAt?: number; // set by the owner's agentic_resolve, with the two below
  outcome?: InboxOutcome;
  note?: string;
}

export interface ReplyRecord {
  at: number;
  text: string;
}

export type AskStatus = "open" | "answered" | "expired" | "resumed";

export interface AskRecord {
  id: string;
  ownerSessionId: string;
  at: number;
  nodeId: string;
  question: string;
  status: AskStatus;
  reraisedAt?: number; // plan item 5 (D5b, bullet 3): set the one time this ask
                        // was re-raised into the thread past the bounded window.
}

// --- Constants ---

const INBOX_PREFIX = "inbox:";
const REPLY_PREFIX = "reply:";
const ASK_PREFIX = "ask:";
const READER_PREFIX = "reader:";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Store interface ---

import type { CommonsStore, CommonsMeta } from "./commons";
import { claimResource, releaseResource, readAllClaims } from "./commons";

// --- Key helpers ---

function inboxKey(persona: string, writerSessionId: string, seq: number): string {
  return `${INBOX_PREFIX}${persona}:${writerSessionId}:${seq}`;
}

function replyKey(persona: string, msgId: string): string {
  return `${REPLY_PREFIX}${persona}:${msgId}`;
}

export function askKey(persona: string, askId: string): string {
  return `${ASK_PREFIX}${persona}:${askId}`;
}

function readerKey(persona: string): string {
  return `${READER_PREFIX}${persona}`;
}

// --- D1: Records ---

/**
 * Write an inbox record. The reader session is the writer.
 * Returns the record id.
 */
export async function writeInboxRecord(
  store: CommonsStore,
  persona: string,
  writerSessionId: string,
  seq: number,
  text: string,
  kind: InboxKind,
  answers?: string,
  urgent?: boolean,
): Promise<string> {
  const id = `${persona}-${writerSessionId}-${seq}`;
  const key = inboxKey(persona, writerSessionId, seq);
  const record: InboxRecord = {
    id,
    key,
    from: writerSessionId,
    at: Date.now(),
    text,
    kind,
    answers,
    ...(urgent ? { urgent: true } : {}),
    status: "pending",
  };
  await store.set(key, record);
  return id;
}

/**
 * Read an inbox record.
 */
export async function readInboxRecord(
  store: CommonsStore,
  persona: string,
  writerSessionId: string,
  seq: number,
): Promise<InboxRecord | null> {
  const key = inboxKey(persona, writerSessionId, seq);
  const raw = await store.get(key);
  return raw ? (raw as InboxRecord) : null;
}

/**
 * List all inbox records for a persona.
 */
export async function listInboxRecords(
  store: CommonsStore,
  persona: string,
): Promise<InboxRecord[]> {
  const keys = await store.keys();
  const prefix = `${INBOX_PREFIX}${persona}:`;
  const records: InboxRecord[] = [];
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      const raw = await store.get(key);
      if (raw) records.push(raw as InboxRecord);
    }
  }
  return records.sort((a, b) => a.at - b.at);
}

/**
 * Write a reply record. The owner session is the writer.
 */
export async function writeReplyRecord(
  store: CommonsStore,
  persona: string,
  msgId: string,
  text: string,
): Promise<void> {
  const record: ReplyRecord = { at: Date.now(), text };
  const key = replyKey(persona, msgId);
  await store.set(key, record);
}

/**
 * Read a reply record.
 */
export async function readReplyRecord(
  store: CommonsStore,
  persona: string,
  msgId: string,
): Promise<ReplyRecord | null> {
  const key = replyKey(persona, msgId);
  const raw = await store.get(key);
  if (!raw) return null;
  // BE2: accept a string value by parsing it, so records already on disk still read
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as ReplyRecord; } catch { return null; }
  }
  return raw as ReplyRecord;
}

/**
 * Write an ask record. The owner session is the writer.
 */
export async function writeAskRecord(
  store: CommonsStore,
  persona: string,
  askId: string,
  nodeId: string,
  question: string,
  ownerSessionId: string,
): Promise<void> {
  const record: AskRecord = {
    id: askId,
    ownerSessionId,
    at: Date.now(),
    nodeId,
    question,
    status: "open",
  };
  const key = askKey(persona, askId);
  await store.set(key, record);
}

/**
 * Mark every open ask of a persona as expired (owner restart).
 * Returns the list of expired ask ids.
 */
export async function expireOpenAsks(
  store: CommonsStore,
  persona: string,
): Promise<string[]> {
  const keys = await store.keys();
  const prefix = `${ASK_PREFIX}${persona}:`;
  const ids: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const raw = await store.get(key);
    if (!raw) continue;
    const rec = (typeof raw === "string" ? JSON.parse(raw) : raw) as AskRecord;
    if (rec.status !== "open") continue;
    // BE4: fall back to the key suffix after ask:<persona>: when rec.id is undefined
    const id = rec.id ?? key.slice(prefix.length);
    rec.id = id;
    rec.status = "expired";
    await store.set(askKey(persona, id), rec);
    ids.push(id);
  }
  return ids;
}

/**
 * Read an ask record.
 */
export async function readAskRecord(
  store: CommonsStore,
  persona: string,
  askId: string,
): Promise<AskRecord | null> {
  const key = askKey(persona, askId);
  const raw = await store.get(key);
  return raw ? (raw as AskRecord) : null;
}

/**
 * List all ask records for a persona.
 */
export async function listAskRecords(
  store: CommonsStore,
  persona: string,
): Promise<AskRecord[]> {
  const keys = await store.keys();
  const prefix = `${ASK_PREFIX}${persona}:`;
  const records: AskRecord[] = [];
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      const raw = await store.get(key);
      if (raw) records.push(raw as AskRecord);
    }
  }
  return records.sort((a, b) => a.at - b.at);
}

/**
 * Sweep records older than the TTL.
 * Returns the number of records swept.
 *
 * A `pending` record is never swept, whatever its age: a pending record whose
 * writer has no live claim leaves the queue through the drain's own route
 * (`skipped`), so one that is still pending is live work the owner has not
 * consumed yet. Every record the sweep removes (inbox, reply, ask) is appended
 * to the channel log first, one line per record in the shape `enforceChannelWindow`
 * writes with `sweptAt` in place of `rolledAt`, so a reader of the log can tell
 * the two routes apart. Append before delete, and never delete on a failed
 * append: the error propagates with every record still in the store, so the
 * caller records the refusal rather than a count.
 */
export async function sweepExpiredRecords(
  store: CommonsStore,
  persona: string,
  appendLines: (lines: string[]) => Promise<void>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  let swept = 0;

  // Collect every record past the TTL (inbox, reply, ask), log them all in
  // one append, then delete.
  const expired: { key: string; kind: "inbox" | "reply" | "ask"; record: unknown }[] = [];
  const inboxRecords = await listInboxRecords(store, persona);
  for (const record of inboxRecords) {
    if (record.at < cutoff && record.status !== "pending" && record.key) {
      expired.push({ key: record.key, kind: "inbox", record });
    }
  }
  const keys = await store.keys();
  const replyPrefix = `${REPLY_PREFIX}${persona}:`;
  const askPrefix = `${ASK_PREFIX}${persona}:`;
  for (const key of keys) {
    const kind = key.startsWith(replyPrefix) ? "reply" : key.startsWith(askPrefix) ? "ask" : null;
    if (!kind) continue;
    const raw = await store.get(key);
    if (!raw) continue;
    const record = raw as ReplyRecord | AskRecord;
    if (record.at < cutoff) expired.push({ key, kind, record: raw });
  }
  if (expired.length > 0) {
    const sweptAt = Date.now();
    await appendLines(expired.map((e) => JSON.stringify({ persona, kind: e.kind, key: e.key, sweptAt, record: e.record })));
    for (const e of expired) {
      await store.delete(e.key);
      swept++;
    }
  }

  return swept;
}

/**
 * Item 5 (Bounded store): the shared commons store keeps only open asks and
 * a short window of recent inbox/reply records per persona - closed records
 * beyond the window roll to an append-only log rather than staying in the
 * one JSON file forever. This never touches `ask:` keys (an open ask has
 * its own lifecycle - answered, expired, or re-raised - and TTL-based
 * `sweepExpiredRecords` above is the only thing that ages one out); it
 * covers `inbox:` records that are `"skipped"` or `"resolved"` and every
 * `reply:` record except one whose inbox record is present as `"delivered"`
 * or `"answered"`, combined and ordered oldest-first, keeping the newest
 * `windowSize` and rolling the rest. A `pending` record is live work the
 * drain has not consumed yet, and a `delivered` or `answered` record is an
 * open steer whose state the sender still reads, so both stay in the store
 * whatever the window, and so does the open steer's reply; the TTL sweep is
 * the bound on those. A reply for a `resolved` or `skipped` record rolls
 * with it, and an orphan reply with no inbox record rolls on its own age.
 * Returns the number of records rolled.
 */
export async function enforceChannelWindow(
  store: CommonsStore,
  persona: string,
  windowSize: number,
  appendLines: (lines: string[]) => Promise<void>,
): Promise<number> {
  const allInbox = await listInboxRecords(store, persona);
  const inbox = allInbox.filter((r) => r.status === "skipped" || r.status === "resolved");
  const openSteerIds = new Set(allInbox.filter((r) => r.status === "delivered" || r.status === "answered").map((r) => r.id));
  const keys = await store.keys();
  const replyPrefix = `${REPLY_PREFIX}${persona}:`;
  const combined: { key: string; at: number; kind: "inbox" | "reply"; record: unknown }[] = inbox.map((r) => ({
    key: r.key,
    at: r.at,
    kind: "inbox" as const,
    record: r,
  }));
  for (const key of keys) {
    if (key.startsWith(replyPrefix)) {
      if (openSteerIds.has(key.slice(replyPrefix.length))) continue;
      const raw = await store.get(key);
      if (raw) combined.push({ key, at: (raw as ReplyRecord).at, kind: "reply", record: raw });
    }
  }
  combined.sort((a, b) => a.at - b.at);

  if (combined.length <= windowSize) return 0;
  const overflow = combined.slice(0, combined.length - windowSize);
  // Round 47 (BG5): the store key rides at the top level of the log line,
  // not only inside `record` - a reply record carries no key field of its
  // own, so a consumer correlating a missing store key back to this log
  // (BG5's own job) needs it named explicitly for every kind, not just inbox.
  const lines = overflow.map((o) => JSON.stringify({ persona, kind: o.kind, key: o.key, rolledAt: Date.now(), record: o.record }));
  // Round 47: append before delete, and never delete on a failed append -
  // a record must have proof it landed in the log before it leaves the
  // store, not the other way around. Round 50 point 3: a failed append used
  // to return 0 here, the same value as "nothing to roll" - the caller could
  // not tell "no overflow this tick" from "overflow existed and the roll was
  // refused". Let the error propagate instead, so the caller records which
  // one happened.
  await appendLines(lines);
  for (const o of overflow) {
    await store.delete(o.key);
  }
  return overflow.length;
}

// --- D2: Reader claim and tools ---

/**
 * Claim the reader role for a persona.
 * The reader session is the writer.
 */
export async function claimReaderRole(
  store: CommonsStore,
  persona: string,
  mySessionId: string,
  now: number = Date.now(),
  meta?: CommonsMeta,
): Promise<void> {
  // Use the commons claim path (same as persona claim)
  await claimResource(store, readerKey(persona), mySessionId, now, meta);
}

/**
 * Release the reader role for a persona.
 */
export async function releaseReaderRole(
  store: CommonsStore,
  persona: string,
  mySessionId: string,
  now: number = Date.now(),
  meta?: CommonsMeta,
): Promise<void> {
  await releaseResource(store, readerKey(persona), mySessionId, now, meta);
}

/**
 * Check if a session holds a live reader claim for a persona.
 */
export async function hasLiveReaderClaim(
  store: CommonsStore,
  persona: string,
  sessionId: string,
  staleAfterMs: number = 90_000,
): Promise<boolean> {
  const claims = await readAllClaims(store, staleAfterMs);
  const readerResource = readerKey(persona);
  return claims.some((c) => c.resource === readerResource && c.holder === sessionId);
}

/**
 * Get the highest existing inbox seq for a persona and writer session.
 */
export async function getHighestInboxSeq(
  store: CommonsStore,
  persona: string,
  writerSessionId: string,
): Promise<number> {
  const keys = await store.keys();
  const prefix = `${INBOX_PREFIX}${persona}:${writerSessionId}:`;
  let maxSeq = 0;
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      const seqStr = key.slice(prefix.length);
      const seq = parseInt(seqStr, 10);
      if (!isNaN(seq) && seq > maxSeq) {
        maxSeq = seq;
      }
    }
  }
  return maxSeq;
}
