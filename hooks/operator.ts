// Operator channel: cross-session steering for agentic-plugin.
// D1: Records (inbox, reply, ask) in the commons store.
// D2: Reader claim and tools (agentic_say, agentic_inbox).
//
// Substrate: $.store (per plugin, global across sessions, async JSON values).
// Key layout: one writer per key.
//
// Records:
// - inbox:<persona>:<writerSessionId>:<seq> = { id, from, at, text, kind, answers?, status }
// - reply:<persona>:<msgId> = { at, text }
// - ask:<persona>:<askId> = { at, nodeId, question, status }
//
// Writer: the reader session writes inbox records; the owner advances status.
// Reader: the reader session calls agentic_inbox to read replies.

// --- Types ---

export type InboxKind = "say" | "answer";
export type InboxStatus = "pending" | "delivered" | "answered";

export interface InboxRecord {
  id: string;
  from: string; // writer sessionId
  at: number; // ms timestamp
  text: string;
  kind: InboxKind;
  answers?: string; // askId if kind === "answer"
  status: InboxStatus;
  deliveredAt?: number; // set by owner on delivery
  turnId?: string; // set by owner on turn.start after delivery
}

export interface ReplyRecord {
  at: number;
  text: string;
}

export type AskStatus = "open" | "answered";

export interface AskRecord {
  at: number;
  nodeId: string;
  question: string;
  status: AskStatus;
}

// --- Constants ---

const INBOX_PREFIX = "inbox:";
const REPLY_PREFIX = "reply:";
const ASK_PREFIX = "ask:";
const READER_PREFIX = "reader:";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Key helpers ---

function inboxKey(persona: string, writerSessionId: string, seq: number): string {
  return `${INBOX_PREFIX}${persona}:${writerSessionId}:${seq}`;
}

function replyKey(persona: string, msgId: string): string {
  return `${REPLY_PREFIX}${persona}:${msgId}`;
}

function askKey(persona: string, askId: string): string {
  return `${ASK_PREFIX}${persona}:${askId}`;
}

function readerKey(persona: string): string {
  return `${READER_PREFIX}${persona}`;
}

// --- Store interface ---

import { CommonsStore } from "./commons.js";

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
): Promise<string> {
  const id = `${persona}-${writerSessionId}-${seq}`;
  const record: InboxRecord = {
    id,
    from: writerSessionId,
    at: Date.now(),
    text,
    kind,
    answers,
    status: "pending",
  };
  const key = inboxKey(persona, writerSessionId, seq);
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
  return raw ? (raw as ReplyRecord) : null;
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
): Promise<void> {
  const record: AskRecord = {
    at: Date.now(),
    nodeId,
    question,
    status: "open",
  };
  const key = askKey(persona, askId);
  await store.set(key, record);
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
 */
export async function sweepExpiredRecords(
  store: CommonsStore,
  persona: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  let swept = 0;

  // Sweep inbox records
  const inboxRecords = await listInboxRecords(store, persona);
  for (const record of inboxRecords) {
    if (record.at < cutoff) {
      const key = inboxKey(persona, record.from, 0); // seq is in the key, but we don't have it here
      // We need to reconstruct the key from the record
      const parts = record.id.split("-");
      if (parts.length >= 3) {
        const seq = parseInt(parts[parts.length - 1], 10);
        const writerSessionId = parts[1];
        const key = inboxKey(persona, writerSessionId, seq);
        await store.delete(key);
        swept++;
      }
    }
  }

  // Sweep reply records
  const keys = await store.keys();
  const replyPrefix = `${REPLY_PREFIX}${persona}:`;
  for (const key of keys) {
    if (key.startsWith(replyPrefix)) {
      const raw = await store.get(key);
      if (raw) {
        const record = raw as ReplyRecord;
        if (record.at < cutoff) {
          await store.delete(key);
          swept++;
        }
      }
    }
  }

  // Sweep ask records
  const askPrefix = `${ASK_PREFIX}${persona}:`;
  for (const key of keys) {
    if (key.startsWith(askPrefix)) {
      const raw = await store.get(key);
      if (raw) {
        const record = raw as AskRecord;
        if (record.at < cutoff) {
          await store.delete(key);
          swept++;
        }
      }
    }
  }

  return swept;
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
): Promise<void> {
  // Use the commons claim path (same as persona claim)
  const { claimResource } = await import("./commons.js");
  await claimResource(store, readerKey(persona), mySessionId);
}

/**
 * Release the reader role for a persona.
 */
export async function releaseReaderRole(
  store: CommonsStore,
  persona: string,
  mySessionId: string,
): Promise<void> {
  const { releaseResource } = await import("./commons.js");
  await releaseResource(store, readerKey(persona), mySessionId);
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
  const { readAllClaims } = await import("./commons.js");
  const claims = await readAllClaims(store, staleAfterMs);
  const readerResource = readerKey(persona);
  return claims.some((c: any) => c.resource === readerResource && c.holder === sessionId);
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
