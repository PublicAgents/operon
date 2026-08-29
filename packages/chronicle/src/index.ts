import { drizzle } from "drizzle-orm/d1";
import { and, asc, desc, eq, gte, lte, max, sql } from "drizzle-orm";
import { events, messages, wakeLog } from "./schema.js";

export * from "./schema.js";

/**
 * Write and read helpers for the chronicle. All writes are BEST-EFFORT:
 * the caller's operation must never fail or slow because the mirror did
 * (the Durable Objects are the source of truth; this is the projection).
 * A missing binding is a deployment without a chronicle, which is legal:
 * every helper no-ops on undefined.
 */

export interface EventRecord {
  at: string;
  gatekeeper: string;
  kind: string;
  agentId?: string;
  detail: Record<string, unknown>;
}

export interface MessageRecord {
  at: string;
  kind:
    | "email_in"
    | "email_out"
    | "channel_operator"
    | "channel_agent"
    | "x_post"
    | "x_dm_in"
    | "x_dm_out"
    /** The notifications feed (spec 0005 §5): every operator notify,
     * recorded whether or not a Telegram delivery happened. */
    | "notify";
  agentId: string;
  sender?: string;
  recipient?: string;
  subject?: string;
  body: string;
  refId?: string;
  meta?: Record<string, unknown>;
}

export async function recordEvent(d1: D1Database | undefined, row: EventRecord): Promise<void> {
  if (!d1) return;
  try {
    await drizzle(d1).insert(events).values({
      at: row.at,
      gatekeeper: row.gatekeeper,
      kind: row.kind,
      agentId: row.agentId ?? null,
      detail: row.detail
    });
  } catch (error) {
    console.error("chronicle event mirror failed", error);
  }
}

/**
 * Best-effort mirror write, as ever, but the outcome is REPORTED: true
 * only when the row actually landed. Mirror callers ignore it; a caller
 * whose own success contract depends on durability (the notify feed,
 * spec 0005 §5) must check it, because "recorded" may never mean "the
 * insert was attempted".
 */
export async function recordMessage(d1: D1Database | undefined, row: MessageRecord): Promise<boolean> {
  if (!d1) return false;
  try {
    await drizzle(d1).insert(messages).values({
      at: row.at,
      kind: row.kind,
      agentId: row.agentId,
      sender: row.sender ?? null,
      recipient: row.recipient ?? null,
      subject: row.subject ?? null,
      body: row.body,
      refId: row.refId ?? null,
      meta: row.meta ?? null
    });
    return true;
  } catch (error) {
    console.error("chronicle message mirror failed", error);
    return false;
  }
}

export interface EventQuery {
  gatekeeper?: string;
  kind?: string;
  agentId?: string;
  /** ISO bounds, inclusive. */
  since?: string;
  until?: string;
  limit?: number;
}

export interface MessageQuery {
  kind?: string;
  agentId?: string;
  since?: string;
  until?: string;
  /** Case-insensitive substring over subject and body. */
  contains?: string;
  limit?: number;
}

const MAX_LIMIT = 500;

function bounded(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit) || limit <= 0) return 100;
  return Math.min(limit, MAX_LIMIT);
}

export interface WakeLogChunk {
  wakeId: string;
  agentId: string;
  seq: number;
  at: string;
  text: string;
  done: boolean;
}

export async function recordWakeLogChunk(
  d1: D1Database | undefined,
  chunk: WakeLogChunk
): Promise<void> {
  if (!d1) return;
  try {
    await drizzle(d1).insert(wakeLog).values({ ...chunk, done: chunk.done ? 1 : 0 });
  } catch (error) {
    console.error("chronicle wake-log mirror failed", error);
  }
}

/** Recent wakes with transcripts, newest first: one row per wake. */
export async function queryWakes(d1: D1Database, agentId?: string, limit = 50) {
  const db = drizzle(d1);
  return db
    .select({
      wakeId: wakeLog.wakeId,
      agentId: wakeLog.agentId,
      startedAt: sql<string>`min(${wakeLog.at})`,
      lastAt: max(wakeLog.at),
      chunks: sql<number>`count(*)`,
      done: max(wakeLog.done)
    })
    .from(wakeLog)
    .where(agentId ? eq(wakeLog.agentId, agentId) : undefined)
    .groupBy(wakeLog.wakeId, wakeLog.agentId)
    .orderBy(desc(max(wakeLog.at)))
    .limit(bounded(limit));
}

/** One wake's transcript chunks in order, optionally after a seq (tailing). */
export async function queryWakeLog(d1: D1Database, wakeId: string, afterSeq = -1) {
  return drizzle(d1)
    .select()
    .from(wakeLog)
    .where(and(eq(wakeLog.wakeId, wakeId), sql`${wakeLog.seq} > ${afterSeq}`))
    .orderBy(asc(wakeLog.seq))
    .limit(MAX_LIMIT);
}

export async function queryEvents(d1: D1Database, query: EventQuery) {
  const where = [
    query.gatekeeper ? eq(events.gatekeeper, query.gatekeeper) : undefined,
    query.kind ? eq(events.kind, query.kind) : undefined,
    query.agentId ? eq(events.agentId, query.agentId) : undefined,
    query.since ? gte(events.at, query.since) : undefined,
    query.until ? lte(events.at, query.until) : undefined
  ].filter(Boolean);
  return drizzle(d1)
    .select()
    .from(events)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(events.at), desc(events.id))
    .limit(bounded(query.limit));
}

export async function queryMessages(d1: D1Database, query: MessageQuery) {
  const needle = query.contains ? `%${query.contains.toLowerCase()}%` : undefined;
  const where = [
    query.kind ? eq(messages.kind, query.kind) : undefined,
    query.agentId ? eq(messages.agentId, query.agentId) : undefined,
    query.since ? gte(messages.at, query.since) : undefined,
    query.until ? lte(messages.at, query.until) : undefined,
    needle
      ? sql`(lower(${messages.body}) like ${needle} or lower(coalesce(${messages.subject}, '')) like ${needle})`
      : undefined
  ].filter(Boolean);
  return drizzle(d1)
    .select()
    .from(messages)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(messages.at), desc(messages.id))
    .limit(bounded(query.limit));
}
