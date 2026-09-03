/**
 * OTLP/HTTP JSON, parsed into chronicle rows (spec 0011 §3). The JSON
 * encoding is the protobuf-to-JSON mapping of the OpenTelemetry
 * protocol: resource → scope → spans | metrics | log records, with
 * attributes as `{ key, value: { stringValue | intValue | ... } }`
 * pairs and times as nanosecond strings. No dependency: the shapes
 * are small and stable, and a decoder that pulls in a protobuf
 * runtime would be a bigger surface than the format itself.
 *
 * Identity (wake id, agent id) is the caller's, from the umbilical;
 * nothing in the payload names the wake. Sizes are capped: an
 * attribute set or a body past its cap is truncated, a request past
 * the row cap is refused by name (never silently trimmed).
 */

export interface OtlpIdentity {
  wakeId: string;
  agentId: string;
}

export interface SpanRow extends OtlpIdentity {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  status: "ok" | "error" | "unset";
  attributes: Record<string, unknown>;
}

export interface EventRow extends OtlpIdentity {
  atMs: number;
  name: string;
  severity: string | null;
  body: string | null;
  attributes: Record<string, unknown>;
}

export interface MetricRow extends OtlpIdentity {
  atMs: number;
  name: string;
  value: number;
  attributes: Record<string, unknown>;
}

/** Rows one request may carry; a payload past this is refused, not trimmed. */
export const MAX_ROWS_PER_REQUEST = 5000;
/** Serialized attribute bytes kept per row. */
export const MAX_ATTRIBUTES_BYTES = 8 * 1024;
/** Log body characters kept. */
export const MAX_BODY_CHARS = 4 * 1024;

export class OtlpError extends Error {
  override name = "OtlpError";
  constructor(
    readonly code: string,
    detail: string
  ) {
    super(`${code}: ${detail}`);
  }
}

interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
}

interface KeyValue {
  key?: string;
  value?: AnyValue;
}

/** One OTLP value as plain JSON; unknown kinds become null rather than crash. */
export function anyValue(value: AnyValue | undefined): unknown {
  if (!value || typeof value !== "object") return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) {
    const n = Number(value.intValue);
    return Number.isSafeInteger(n) ? n : String(value.intValue);
  }
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(anyValue);
  if (value.kvlistValue) return attributes(value.kvlistValue.values);
  if (value.bytesValue !== undefined) return value.bytesValue;
  return null;
}

/** Attribute pairs as an object, capped by serialized size (later keys dropped, marked). */
export function attributes(pairs: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(pairs)) return out;
  let bytes = 2;
  for (const pair of pairs) {
    if (!pair || typeof pair.key !== "string") continue;
    const value = anyValue(pair.value);
    const cost = pair.key.length + JSON.stringify(value ?? null).length + 4;
    if (bytes + cost > MAX_ATTRIBUTES_BYTES) {
      out["operon.truncated"] = true;
      break;
    }
    out[pair.key] = value;
    bytes += cost;
  }
  return out;
}

/** Nanoseconds (a string or number) to epoch milliseconds; 0 when unreadable. */
export function nanosToMs(nanos: unknown): number {
  if (typeof nanos === "number") return Math.floor(nanos / 1_000_000);
  if (typeof nanos === "string" && /^\d+$/.test(nanos)) {
    // Drop the last six digits without going through a float.
    return nanos.length > 6 ? Number(nanos.slice(0, -6)) : 0;
  }
  return 0;
}

function bounded(rows: unknown[]): void {
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    throw new OtlpError("otlp_too_many_rows", `${rows.length} rows in one request; the cap is ${MAX_ROWS_PER_REQUEST}`);
  }
}

interface ScopeSpans {
  spans?: {
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    name?: string;
    startTimeUnixNano?: unknown;
    endTimeUnixNano?: unknown;
    attributes?: KeyValue[];
    status?: { code?: number | string };
  }[];
}

/** ExportTraceServiceRequest → span rows. */
export function parseTraces(payload: unknown, identity: OtlpIdentity): SpanRow[] {
  const rows: SpanRow[] = [];
  const resources = (payload as { resourceSpans?: { scopeSpans?: ScopeSpans[] }[] })?.resourceSpans;
  for (const resource of Array.isArray(resources) ? resources : []) {
    for (const scope of resource?.scopeSpans ?? []) {
      for (const span of scope?.spans ?? []) {
        if (!span || typeof span.spanId !== "string" || typeof span.traceId !== "string") continue;
        const code = span.status?.code;
        rows.push({
          ...identity,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: typeof span.parentSpanId === "string" && span.parentSpanId ? span.parentSpanId : null,
          name: String(span.name ?? "").slice(0, 200),
          startMs: nanosToMs(span.startTimeUnixNano),
          endMs: nanosToMs(span.endTimeUnixNano),
          status:
            code === 2 || code === "STATUS_CODE_ERROR" ? "error" : code === 1 || code === "STATUS_CODE_OK" ? "ok" : "unset",
          attributes: attributes(span.attributes)
        });
      }
    }
  }
  bounded(rows);
  return rows;
}

interface ScopeLogs {
  logRecords?: {
    timeUnixNano?: unknown;
    observedTimeUnixNano?: unknown;
    severityText?: string;
    body?: AnyValue;
    attributes?: KeyValue[];
    eventName?: string;
  }[];
}

/**
 * ExportLogsServiceRequest → event rows. The event's name is the
 * `event.name` attribute when the record carries one (how both
 * harnesses name their events; Codex fills the record's own eventName
 * with a source location instead), else the record's eventName, else
 * the severity.
 */
export function parseLogs(payload: unknown, identity: OtlpIdentity): EventRow[] {
  const rows: EventRow[] = [];
  const resources = (payload as { resourceLogs?: { scopeLogs?: ScopeLogs[] }[] })?.resourceLogs;
  for (const resource of Array.isArray(resources) ? resources : []) {
    for (const scope of resource?.scopeLogs ?? []) {
      for (const record of scope?.logRecords ?? []) {
        if (!record || typeof record !== "object") continue;
        const attrs = attributes(record.attributes);
        const eventName =
          typeof attrs["event.name"] === "string" && attrs["event.name"]
            ? (attrs["event.name"] as string)
            : typeof record.eventName === "string" && record.eventName
              ? record.eventName
              : (record.severityText ?? "log");
        const body = anyValue(record.body);
        const bodyText = body === null || body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
        rows.push({
          ...identity,
          atMs: nanosToMs(record.timeUnixNano) || nanosToMs(record.observedTimeUnixNano),
          name: String(eventName).slice(0, 200),
          severity: typeof record.severityText === "string" ? record.severityText : null,
          body: bodyText === null ? null : bodyText.slice(0, MAX_BODY_CHARS),
          attributes: attrs
        });
      }
    }
  }
  bounded(rows);
  return rows;
}

interface DataPoint {
  timeUnixNano?: unknown;
  asInt?: string | number;
  asDouble?: number;
  sum?: number;
  count?: string | number;
  attributes?: KeyValue[];
}

interface Metric {
  name?: string;
  sum?: { dataPoints?: DataPoint[] };
  gauge?: { dataPoints?: DataPoint[] };
  histogram?: { dataPoints?: DataPoint[] };
}

interface ScopeMetrics {
  metrics?: Metric[];
}

/**
 * ExportMetricsServiceRequest → metric rows, one per data point. A sum
 * or gauge point is its value; a histogram point is its sum (the
 * count rides along as an attribute), which is what a token or cost
 * histogram means to an operator.
 */
export function parseMetrics(payload: unknown, identity: OtlpIdentity): MetricRow[] {
  const rows: MetricRow[] = [];
  const resources = (payload as { resourceMetrics?: { scopeMetrics?: ScopeMetrics[] }[] })?.resourceMetrics;
  for (const resource of Array.isArray(resources) ? resources : []) {
    for (const scope of resource?.scopeMetrics ?? []) {
      for (const metric of scope?.metrics ?? []) {
        if (!metric || typeof metric.name !== "string") continue;
        const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? metric.histogram?.dataPoints ?? [];
        const isHistogram = Boolean(metric.histogram);
        for (const point of points) {
          if (!point || typeof point !== "object") continue;
          const value = isHistogram
            ? Number(point.sum ?? 0)
            : point.asDouble !== undefined
              ? Number(point.asDouble)
              : Number(point.asInt ?? 0);
          if (!Number.isFinite(value)) continue;
          rows.push({
            ...identity,
            atMs: nanosToMs(point.timeUnixNano),
            name: metric.name.slice(0, 200),
            value,
            attributes: {
              ...attributes(point.attributes),
              ...(isHistogram && point.count !== undefined ? { "operon.count": Number(point.count) } : {})
            }
          });
        }
      }
    }
  }
  bounded(rows);
  return rows;
}
