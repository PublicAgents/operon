import { drizzle } from "drizzle-orm/d1";
import { and, asc, desc, eq, gte, lte, max, sql } from "drizzle-orm";
import { events, messages, otelEvents, otelMetrics, otelSpans, wakeLog, wakeUsage } from "./schema.js";
import type { EventRow, MetricRow, SpanRow } from "./otlp.js";

export * from "./schema.js";
export * from "./otlp.js";

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

// ---- telemetry (spec 0011) ------------------------------------------

export interface WakeUsageRecord {
  wakeId: string;
  agentId: string;
  harness: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  recordedAt: string;
}

/** One row per wake; a second record for the same wake replaces the first (the later one read the full stream). */
export async function recordWakeUsage(d1: D1Database | undefined, row: WakeUsageRecord): Promise<void> {
  if (!d1) return;
  try {
    const values = {
      wakeId: row.wakeId,
      agentId: row.agentId,
      harness: row.harness,
      model: row.model ?? null,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      costUsd: row.costUsd ?? null,
      turns: row.turns ?? null,
      durationMs: row.durationMs ?? null,
      recordedAt: row.recordedAt
    };
    await drizzle(d1)
      .insert(wakeUsage)
      .values(values)
      .onConflictDoUpdate({ target: wakeUsage.wakeId, set: values });
  } catch (error) {
    console.error("chronicle wake-usage write failed", error);
  }
}

export async function queryWakeUsage(d1: D1Database, wakeId: string) {
  const rows = await drizzle(d1).select().from(wakeUsage).where(eq(wakeUsage.wakeId, wakeId)).limit(1);
  return rows[0];
}

/** Recent wakes' usage rows for one agent (or all), newest first. */
export async function queryWakesUsage(d1: D1Database, agentId?: string, limit = 50) {
  return drizzle(d1)
    .select()
    .from(wakeUsage)
    .where(agentId ? eq(wakeUsage.agentId, agentId) : undefined)
    .orderBy(desc(wakeUsage.recordedAt))
    .limit(bounded(limit));
}

/** Token and cost totals per agent per UTC day since a timestamp. */
export async function sumUsageByDay(d1: D1Database, since: string, agentId?: string) {
  const day = sql<string>`substr(${wakeUsage.recordedAt}, 1, 10)`;
  return drizzle(d1)
    .select({
      day,
      agentId: wakeUsage.agentId,
      harness: wakeUsage.harness,
      wakes: sql<number>`count(*)`,
      inputTokens: sql<number>`sum(${wakeUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${wakeUsage.outputTokens})`,
      cacheReadTokens: sql<number>`sum(${wakeUsage.cacheReadTokens})`,
      cacheWriteTokens: sql<number>`sum(${wakeUsage.cacheWriteTokens})`,
      costUsd: sql<number | null>`sum(${wakeUsage.costUsd})`
    })
    .from(wakeUsage)
    .where(and(gte(wakeUsage.recordedAt, since), agentId ? eq(wakeUsage.agentId, agentId) : undefined))
    .groupBy(day, wakeUsage.agentId, wakeUsage.harness)
    .orderBy(desc(day), asc(wakeUsage.agentId))
    .limit(MAX_LIMIT);
}

/** Batch insert of parsed OTLP rows; best-effort, chunked to D1's bound-parameter limits. */
export async function recordOtlp(
  d1: D1Database | undefined,
  rows: { spans?: SpanRow[]; events?: EventRow[]; metrics?: MetricRow[] }
): Promise<void> {
  if (!d1) return;
  const db = drizzle(d1);
  const chunk = <T>(list: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  };
  try {
    for (const part of chunk(rows.spans ?? [], 40)) await db.insert(otelSpans).values(part);
    for (const part of chunk(rows.events ?? [], 40)) await db.insert(otelEvents).values(part);
    for (const part of chunk(rows.metrics ?? [], 60)) await db.insert(otelMetrics).values(part);
  } catch (error) {
    console.error("chronicle otlp write failed", error);
  }
}

export type TraceKind = "spans" | "events" | "metrics";

/** One wake's telemetry of one kind, in time order, paginated by row id. */
export async function queryTrace(d1: D1Database, wakeId: string, kind: TraceKind, afterId = 0, limit = 200) {
  const db = drizzle(d1);
  const take = bounded(limit);
  if (kind === "spans") {
    return db
      .select()
      .from(otelSpans)
      .where(and(eq(otelSpans.wakeId, wakeId), sql`${otelSpans.id} > ${afterId}`))
      .orderBy(asc(otelSpans.startMs), asc(otelSpans.id))
      .limit(take);
  }
  if (kind === "metrics") {
    return db
      .select()
      .from(otelMetrics)
      .where(and(eq(otelMetrics.wakeId, wakeId), sql`${otelMetrics.id} > ${afterId}`))
      .orderBy(asc(otelMetrics.atMs), asc(otelMetrics.id))
      .limit(take);
  }
  return db
    .select()
    .from(otelEvents)
    .where(and(eq(otelEvents.wakeId, wakeId), sql`${otelEvents.id} > ${afterId}`))
    .orderBy(asc(otelEvents.atMs), asc(otelEvents.id))
    .limit(take);
}

/** Retention (spec 0011 §2): telemetry rows older than the cutoff go; usage rows stay. */
export async function pruneOtel(d1: D1Database | undefined, olderThanMs: number): Promise<void> {
  if (!d1) return;
  const db = drizzle(d1);
  try {
    await db.delete(otelSpans).where(sql`${otelSpans.startMs} < ${olderThanMs}`);
    await db.delete(otelEvents).where(sql`${otelEvents.atMs} < ${olderThanMs}`);
    await db.delete(otelMetrics).where(sql`${otelMetrics.atMs} < ${olderThanMs}`);
  } catch (error) {
    console.error("chronicle otlp prune failed", error);
  }
}
