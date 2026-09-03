import { describe, expect, it } from "vitest";
import {
  anyValue,
  attributes,
  MAX_ATTRIBUTES_BYTES,
  MAX_BODY_CHARS,
  MAX_ROWS_PER_REQUEST,
  nanosToMs,
  OtlpError,
  parseLogs,
  parseMetrics,
  parseTraces
} from "./otlp.js";

const identity = { wakeId: "w1", agentId: "promoter" };
const kv = (key: string, value: object) => ({ key, value });

describe("anyValue and attributes", () => {
  it("maps every OTLP value kind to plain JSON", () => {
    expect(anyValue({ stringValue: "s" })).toBe("s");
    expect(anyValue({ intValue: "42" })).toBe(42);
    expect(anyValue({ intValue: "99999999999999999999" })).toBe("99999999999999999999");
    expect(anyValue({ doubleValue: 1.5 })).toBe(1.5);
    expect(anyValue({ boolValue: true })).toBe(true);
    expect(anyValue({ arrayValue: { values: [{ stringValue: "a" }, { intValue: 1 }] } })).toEqual(["a", 1]);
    expect(anyValue({ kvlistValue: { values: [kv("k", { stringValue: "v" })] } })).toEqual({ k: "v" });
    expect(anyValue({ bytesValue: "AQI=" })).toBe("AQI=");
    expect(anyValue(undefined)).toBeNull();
    expect(anyValue({})).toBeNull();
  });

  it("caps attributes by serialized size and marks the truncation", () => {
    const big = Array.from({ length: 40 }, (_, i) => kv(`k${i}`, { stringValue: "x".repeat(300) }));
    const attrs = attributes(big);
    expect(JSON.stringify(attrs).length).toBeLessThanOrEqual(MAX_ATTRIBUTES_BYTES + 64);
    expect(attrs["operon.truncated"]).toBe(true);
    expect(attributes(undefined)).toEqual({});
  });

  it("converts nanosecond strings without floating point", () => {
    expect(nanosToMs("1725350400123456789")).toBe(1725350400123);
    expect(nanosToMs(1_000_000_000_000)).toBe(1000);
    expect(nanosToMs("12")).toBe(0);
    expect(nanosToMs("nope")).toBe(0);
  });
});

describe("parseTraces", () => {
  it("flattens resource and scope spans into rows with the caller's identity", () => {
    const rows = parseTraces(
      {
        resourceSpans: [
          {
            resource: { attributes: [kv("operon.wake_id", { stringValue: "spoofed" })] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "t1",
                    spanId: "s1",
                    name: "claude_code.interaction",
                    startTimeUnixNano: "1725350400000000000",
                    endTimeUnixNano: "1725350401500000000",
                    status: { code: 1 },
                    attributes: [kv("prompt.id", { stringValue: "p1" })]
                  },
                  {
                    traceId: "t1",
                    spanId: "s2",
                    parentSpanId: "s1",
                    name: "claude_code.tool",
                    startTimeUnixNano: "1725350400100000000",
                    endTimeUnixNano: "1725350400900000000",
                    status: { code: "STATUS_CODE_ERROR" }
                  }
                ]
              }
            ]
          }
        ]
      },
      identity
    );
    expect(rows).toEqual([
      {
        wakeId: "w1",
        agentId: "promoter",
        traceId: "t1",
        spanId: "s1",
        parentSpanId: null,
        name: "claude_code.interaction",
        startMs: 1725350400000,
        endMs: 1725350401500,
        status: "ok",
        attributes: { "prompt.id": "p1" }
      },
      {
        wakeId: "w1",
        agentId: "promoter",
        traceId: "t1",
        spanId: "s2",
        parentSpanId: "s1",
        name: "claude_code.tool",
        startMs: 1725350400100,
        endMs: 1725350400900,
        status: "error",
        attributes: {}
      }
    ]);
  });

  it("skips malformed spans, tolerates an empty payload, and refuses the row cap by name", () => {
    expect(parseTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: "no ids" }, null] }] }] }, identity)).toEqual([]);
    expect(parseTraces({}, identity)).toEqual([]);
    expect(parseTraces("garbage", identity)).toEqual([]);
    const spans = Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, (_, i) => ({ traceId: "t", spanId: `s${i}` }));
    expect(() => parseTraces({ resourceSpans: [{ scopeSpans: [{ spans }] }] }, identity)).toThrowError(OtlpError);
    expect(() => parseTraces({ resourceSpans: [{ scopeSpans: [{ spans }] }] }, identity)).toThrowError(/otlp_too_many_rows/);
  });
});

describe("parseLogs", () => {
  it("names an event from eventName, then event.name, then severity, and caps the body", () => {
    const rows = parseLogs(
      {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "1725350400000000000",
                    severityText: "INFO",
                    body: { stringValue: "x".repeat(MAX_BODY_CHARS + 10) },
                    attributes: [kv("event.name", { stringValue: "claude_code.tool_result" }), kv("tool_name", { stringValue: "Bash" })]
                  },
                  { observedTimeUnixNano: "1725350401000000000", eventName: "codex.turn", body: { kvlistValue: { values: [kv("a", { intValue: 1 })] } } },
                  { severityText: "WARN" }
                ]
              }
            ]
          }
        ]
      },
      identity
    );
    expect(rows[0]).toMatchObject({ atMs: 1725350400000, name: "claude_code.tool_result", severity: "INFO", attributes: { tool_name: "Bash" } });
    expect(rows[0].body?.length).toBe(MAX_BODY_CHARS);
    expect(rows[1]).toMatchObject({ atMs: 1725350401000, name: "codex.turn", severity: null, body: '{"a":1}' });
    expect(rows[2]).toMatchObject({ atMs: 0, name: "WARN", body: null });
  });
});

describe("parseMetrics", () => {
  it("reads sum, gauge and histogram points with the metric name and attributes", () => {
    const rows = parseMetrics(
      {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "claude_code.token.usage",
                    sum: { dataPoints: [{ timeUnixNano: "1725350400000000000", asInt: "1200", attributes: [kv("type", { stringValue: "input" })] }] }
                  },
                  { name: "gauge.x", gauge: { dataPoints: [{ timeUnixNano: "1725350400000000000", asDouble: 2.5 }] } },
                  { name: "hist.y", histogram: { dataPoints: [{ timeUnixNano: "1725350400000000000", sum: 30, count: "3" }] } },
                  { name: "bad", sum: { dataPoints: [{ asDouble: Number.NaN }, null] } }
                ]
              }
            ]
          }
        ]
      },
      identity
    );
    expect(rows).toEqual([
      { wakeId: "w1", agentId: "promoter", atMs: 1725350400000, name: "claude_code.token.usage", value: 1200, attributes: { type: "input" } },
      { wakeId: "w1", agentId: "promoter", atMs: 1725350400000, name: "gauge.x", value: 2.5, attributes: {} },
      { wakeId: "w1", agentId: "promoter", atMs: 1725350400000, name: "hist.y", value: 30, attributes: { "operon.count": 3 } }
    ]);
  });
});
