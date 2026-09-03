/**
 * The chronicle schema: two append-only tables. `events` mirrors every
 * Ledger row every Gatekeeper writes (denials and failures included: an
 * empty chronicle must be distinguishable from a dead rail, same doctrine
 * as the ledgers). `messages` carries the full bodies of everything said
 * through the chassis: inbound and outbound email, and the operator
 * channel in both directions.
 *
 * What may NEVER be written here: vault values, mind credentials, any
 * bearer. Labels and ids only, the "labels ledgered, values never" rule.
 * The mirror is written best-effort from the hot path (a failed insert
 * logs and moves on); the Durable Objects remain the source of truth and
 * the chronicle is rebuildable in principle from them and the operator's
 * own records.
 */
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** ISO timestamp, identical to the mirrored ledger row's. */
    at: text("at").notNull(),
    /** Which Gatekeeper's ledger this row mirrors (the Ledger DO's name). */
    gatekeeper: text("gatekeeper").notNull(),
    kind: text("kind").notNull(),
    /** Extracted from the detail when present, for per-agent queries. */
    agentId: text("agent_id"),
    detail: text("detail", { mode: "json" }).notNull()
  },
  table => [
    index("events_at_idx").on(table.at),
    index("events_gatekeeper_at_idx").on(table.gatekeeper, table.at),
    index("events_agent_at_idx").on(table.agentId, table.at),
    index("events_kind_at_idx").on(table.kind, table.at)
  ]
);

export const wakeLog = sqliteTable(
  "wake_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    wakeId: text("wake_id").notNull(),
    agentId: text("agent_id").notNull(),
    /** Chunk order within the wake; (wakeId, seq) is the natural key. */
    seq: integer("seq").notNull(),
    at: text("at").notNull(),
    /** Transcript text, denylist-redacted BEFORE it left the container. */
    text: text("text").notNull(),
    /** 1 on the final chunk of a wake. */
    done: integer("done").notNull().default(0)
  },
  table => [
    index("wake_log_wake_seq_idx").on(table.wakeId, table.seq),
    index("wake_log_agent_at_idx").on(table.agentId, table.at)
  ]
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    /** "email_in" | "email_out" | "channel_operator" | "channel_agent". */
    kind: text("kind").notNull(),
    agentId: text("agent_id").notNull(),
    sender: text("sender"),
    recipient: text("recipient"),
    subject: text("subject"),
    body: text("body").notNull(),
    /** Source id: the mailbox message id or the channel entry id. */
    refId: text("ref_id"),
    meta: text("meta", { mode: "json" })
  },
  table => [
    index("messages_agent_at_idx").on(table.agentId, table.at),
    index("messages_kind_at_idx").on(table.kind, table.at),
    index("messages_at_idx").on(table.at)
  ]
);

/**
 * Telemetry (spec 0011). `wake_usage` is one row per wake, read from the
 * harness's own stream at the end of the wake; the `otel_*` tables hold
 * what the harness exported over OTLP through the porch, identified by
 * the umbilical (never by the payload). Names, timings, counts and
 * statuses only: content flags stay off, and every payload was
 * denylist-redacted before it left the container.
 */
export const wakeUsage = sqliteTable(
  "wake_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    wakeId: text("wake_id").notNull().unique(),
    agentId: text("agent_id").notNull(),
    harness: text("harness").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** USD, when the harness reports one; null under a subscription that prices nothing. */
    costUsd: real("cost_usd"),
    turns: integer("turns"),
    durationMs: integer("duration_ms"),
    /** ISO timestamp of the record, which is the wake's end. */
    recordedAt: text("recorded_at").notNull()
  },
  table => [index("wake_usage_agent_at_idx").on(table.agentId, table.recordedAt)]
);

export const otelSpans = sqliteTable(
  "otel_spans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    wakeId: text("wake_id").notNull(),
    agentId: text("agent_id").notNull(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    /** Epoch milliseconds. */
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    /** "ok" | "error" | "unset". */
    status: text("status").notNull(),
    attributes: text("attributes", { mode: "json" }).notNull()
  },
  table => [
    index("otel_spans_wake_start_idx").on(table.wakeId, table.startMs),
    index("otel_spans_start_idx").on(table.startMs)
  ]
);

export const otelEvents = sqliteTable(
  "otel_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    wakeId: text("wake_id").notNull(),
    agentId: text("agent_id").notNull(),
    atMs: integer("at_ms").notNull(),
    name: text("name").notNull(),
    severity: text("severity"),
    body: text("body"),
    attributes: text("attributes", { mode: "json" }).notNull()
  },
  table => [
    index("otel_events_wake_at_idx").on(table.wakeId, table.atMs),
    index("otel_events_at_idx").on(table.atMs)
  ]
);

export const otelMetrics = sqliteTable(
  "otel_metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    wakeId: text("wake_id").notNull(),
    agentId: text("agent_id").notNull(),
    atMs: integer("at_ms").notNull(),
    name: text("name").notNull(),
    value: real("value").notNull(),
    attributes: text("attributes", { mode: "json" }).notNull()
  },
  table => [
    index("otel_metrics_wake_at_idx").on(table.wakeId, table.atMs),
    index("otel_metrics_at_idx").on(table.atMs)
  ]
);
