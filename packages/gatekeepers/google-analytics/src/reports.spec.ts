import { describe, expect, it } from "vitest";
import { isMcpPath } from "./paths.js";
import {
  AnalyticsError,
  ReportInputError,
  getAccountSummaries,
  getMetadata,
  runRealtimeReport,
  runReport,
  validateReport,
  type AnalyticsApi
} from "./reports.js";

const PROPERTY = "properties/123456";

function scripted(calls: Array<{ url: string; body?: unknown }>, response: unknown = { rows: [] }) {
  const api: AnalyticsApi = {
    token: async () => "ya29.test",
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(response));
    }) as typeof fetch
  };
  return api;
}

describe("runReport", () => {
  it("asks only about the configured property, whatever the arguments say", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    await runReport(scripted(calls), PROPERTY, {
      startDate: "7daysAgo",
      endDate: "today",
      metrics: ["activeUsers"],
      dimensions: ["pagePath"],
      limit: 10,
      // A property named in the input has nowhere to go: the pin is
      // configuration, not an argument.
      ...({ property: "properties/999" } as Record<string, unknown>)
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport"
    );
    expect(calls[0].url).not.toContain("999");
    expect(calls[0].body).toEqual({
      dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
      metrics: [{ name: "activeUsers" }],
      dimensions: [{ name: "pagePath" }],
      limit: 10
    });
  });

  it("sorts by a metric when asked", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    await runReport(scripted(calls), PROPERTY, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      metrics: ["sessions"],
      orderByMetric: "sessions"
    });
    expect((calls[0].body as { orderBys: unknown }).orderBys).toEqual([
      { metric: { metricName: "sessions" }, desc: true }
    ]);
  });

  it("surfaces Google's own words on a refusal, and the status", async () => {
    const api: AnalyticsApi = {
      token: async () => "t",
      fetch: (async () =>
        new Response("User does not have sufficient permissions for this property.", {
          status: 403
        })) as typeof fetch
    };
    await expect(
      runReport(api, PROPERTY, { startDate: "today", endDate: "today", metrics: ["activeUsers"] })
    ).rejects.toThrow(AnalyticsError);
    await expect(
      runReport(api, PROPERTY, { startDate: "today", endDate: "today", metrics: ["activeUsers"] })
    ).rejects.toThrow(/sufficient permissions/);
  });
});

describe("validateReport", () => {
  const base = { startDate: "today", endDate: "today", metrics: ["activeUsers"] };

  it("accepts the date forms GA accepts", () => {
    for (const date of ["2026-08-31", "today", "yesterday", "28daysAgo"]) {
      expect(() => validateReport({ ...base, startDate: date })).not.toThrow();
    }
  });

  it("refuses everything else by name, before anything is sent", () => {
    expect(() => validateReport({ ...base, startDate: "last tuesday" })).toThrow(ReportInputError);
    expect(() => validateReport({ ...base, metrics: [] })).toThrow(/at least one metric/);
    expect(() => validateReport({ ...base, metrics: ["active users"] })).toThrow(/not a GA API name/);
    expect(() => validateReport({ ...base, dimensions: ["../etc"] })).toThrow(/not a GA API name/);
    expect(() => validateReport({ ...base, limit: 0 })).toThrow(/between 1 and 1000/);
    expect(() => validateReport({ ...base, limit: 5000 })).toThrow(/between 1 and 1000/);
  });

  it("allows custom event names, which carry a colon", () => {
    expect(() => validateReport({ ...base, metrics: ["customEvent:signup"] })).not.toThrow();
  });
});

describe("the other reads", () => {
  it("realtime reports carry no date range", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    await runRealtimeReport(scripted(calls), PROPERTY, { metrics: ["activeUsers"] });
    expect(calls[0].url).toContain(":runRealtimeReport");
    expect(calls[0].body).not.toHaveProperty("dateRanges");
  });

  it("metadata and account summaries are GETs", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const api = scripted(calls, { dimensions: [] });
    await getMetadata(api, PROPERTY);
    await getAccountSummaries(api);
    expect(calls[0].url).toBe(
      "https://analyticsdata.googleapis.com/v1beta/properties/123456/metadata"
    );
    expect(calls[0].body).toBeUndefined();
    expect(calls[1].url).toBe(
      "https://analyticsadmin.googleapis.com/v1beta/accountSummaries"
    );
  });
});

describe("the door's path (the contract with the container config)", () => {
  it("answers /mcp/<name>, which is how every wake addresses it", () => {
    // mcp-config.ts writes http://<virtual>/mcp/<name>; the first
    // hand-run wake reported the server "failed" because only bare
    // /mcp was accepted.
    expect(isMcpPath("/mcp/google-analytics")).toBe(true);
    expect(isMcpPath("/mcp")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const path of ["/", "/mcp/", "/mcp/Google", "/mcp/a/b", "/gatekeeper/google-analytics/ledger"]) {
      expect(isMcpPath(path), path).toBe(false);
    }
  });
});
