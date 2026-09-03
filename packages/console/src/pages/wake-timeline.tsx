import { useState } from "react";
import { callTool, type TraceEventRow, type TraceSpanRow, type WakeUsageRow } from "../api.js";
import { useTool } from "../hooks.js";
import { Empty, ErrorNote, LoadingGate } from "../ui.js";
import { UntrustedText } from "../untrusted.js";
import { formatUsage } from "./wakes.js";

/**
 * A wake's telemetry (spec 0011 §4): the usage line, the events in
 * order, and the spans as a waterfall against the wake's first span.
 * Everything shown was exported by the harness and is rendered as text
 * nodes only, like the transcript; names, timings and counts, never
 * prompt or tool content (the exporters' content flags are off).
 */

export function UsageLine({ wakeId }: { wakeId: string }) {
  const state = useTool<{ usage: WakeUsageRow | null }>("wake_usage", { wakeId }, { pollMs: 30_000 });
  const row = state.data?.usage ?? undefined;
  if (!row) return null;
  return (
    <span className="usage-line" title="read from the harness's own stream at the end of the wake">
      {formatUsage(row)}
      {row.cacheReadTokens > 0 ? ` · ${Math.round(row.cacheReadTokens / 1000)}k cached` : ""}
      {row.turns !== null ? ` · ${row.turns} turns` : ""}
      {row.model ? <span className="tag">{row.model}</span> : null}
    </span>
  );
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

/** The attributes worth a glance, compact: short scalars only, keyed. */
function briefAttributes(attributes: Record<string, unknown>): string {
  const skip = new Set(["session.id", "user.account_uuid", "user.id", "organization.id", "app.version", "app.entrypoint", "terminal.type"]);
  return Object.entries(attributes)
    .filter(([key, value]) => !skip.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
    .slice(0, 8)
    .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
    .join(" ");
}

export function WakeTimeline({ wakeId }: { wakeId: string }) {
  const [kind, setKind] = useState<"events" | "spans">("events");
  const events = useTool<{ rows: TraceEventRow[] }>("wake_trace", { wakeId, kind: "events", limit: 500 }, { pollMs: 10_000 });
  const spans = useTool<{ rows: TraceSpanRow[] }>("wake_trace", { wakeId, kind: "spans", limit: 500 }, { pollMs: 10_000 });
  const [more, setMore] = useState<{ events: TraceEventRow[]; spans: TraceSpanRow[] }>({ events: [], spans: [] });
  // Pages come in insertion order (the cursor's order); the timeline
  // is shown in time order.
  const allEvents = [...(events.data?.rows ?? []), ...more.events].sort((a, b) => a.atMs - b.atMs || a.id - b.id);
  const allSpans = [...(spans.data?.rows ?? []), ...more.spans].sort((a, b) => a.startMs - b.startMs || a.id - b.id);

  async function loadMore() {
    if (kind === "events") {
      const last = Math.max(0, ...allEvents.map(row => row.id));
      const page = await callTool<{ rows: TraceEventRow[] }>("wake_trace", { wakeId, kind: "events", after: last, limit: 500 });
      setMore(current => ({ ...current, events: [...current.events, ...page.rows] }));
    } else {
      const last = Math.max(0, ...allSpans.map(row => row.id));
      const page = await callTool<{ rows: TraceSpanRow[] }>("wake_trace", { wakeId, kind: "spans", after: last, limit: 500 });
      setMore(current => ({ ...current, spans: [...current.spans, ...page.rows] }));
    }
  }

  const origin = allSpans.length > 0 ? Math.min(...allSpans.map(span => span.startMs)) : 0;
  const span = allSpans.length > 0 ? Math.max(1, Math.max(...allSpans.map(s => s.endMs)) - origin) : 1;
  const depth = new Map<string, number>();
  for (const row of allSpans) {
    depth.set(row.spanId, row.parentSpanId && depth.has(row.parentSpanId) ? (depth.get(row.parentSpanId) ?? 0) + 1 : 0);
  }

  return (
    <div className="timeline" data-provenance="agent">
      <div className="provenance-banner">harness telemetry: names, timings and counts, exported by the mind's session</div>
      <div className="timeline-tabs">
        <button className={kind === "events" ? "active" : ""} onClick={() => setKind("events")}>
          events ({allEvents.length})
        </button>
        <button className={kind === "spans" ? "active" : ""} onClick={() => setKind("spans")}>
          spans ({allSpans.length})
        </button>
        <button onClick={() => void loadMore()}>load more</button>
      </div>
      <ErrorNote error={events.error ?? spans.error} />
      <LoadingGate loading={events.loading || spans.loading} hasData={events.data !== undefined || spans.data !== undefined}>
        {kind === "events" ? (
          allEvents.length === 0 ? (
            <Empty>no events exported for this wake (yet)</Empty>
          ) : (
            <table className="timeline-events">
              <tbody>
                {allEvents.map(row => (
                  <tr key={row.id}>
                    <td className="when">{row.atMs ? new Date(row.atMs).toISOString().slice(11, 23) : ""}</td>
                    <td className="name">
                      <UntrustedText text={row.name} />
                    </td>
                    <td className="attrs">
                      <UntrustedText text={briefAttributes(row.attributes)} />
                      {row.body ? (
                        <span className="body">
                          {" "}
                          <UntrustedText text={row.body.slice(0, 200)} />
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : allSpans.length === 0 ? (
          <Empty>no spans exported for this wake (yet)</Empty>
        ) : (
          <div className="waterfall">
            {allSpans.map(row => (
              <div key={row.id} className={`span-row status-${row.status}`} style={{ paddingLeft: `${8 + (depth.get(row.spanId) ?? 0) * 14}px` }}>
                <span className="span-name">
                  <UntrustedText text={row.name} />
                </span>
                <span className="span-bar-track">
                  <span
                    className="span-bar"
                    style={{
                      left: `${((row.startMs - origin) / span) * 100}%`,
                      width: `${Math.max(0.5, ((row.endMs - row.startMs) / span) * 100)}%`
                    }}
                  />
                </span>
                <span className="span-ms">{ms(Math.max(0, row.endMs - row.startMs))}</span>
              </div>
            ))}
          </div>
        )}
      </LoadingGate>
    </div>
  );
}
