import { describe, expect, it } from "vitest";
import {
  dueForFlush,
  requestLog,
  summaryDetail,
  SUMMARY_FLUSH_MS,
  SUMMARY_FLUSH_REQUESTS,
  SUMMARY_MAX_HOSTS,
  tallyLine,
  withError,
  withResponse,
  type EgressLog,
  type EgressTally
} from "./egress-audit.js";

const PROPS = { agentId: "promoter", wakeId: "wake-1" };

describe("egress audit log shaping", () => {
  it("records method, host, and path but only the query LENGTH", () => {
    const req = new Request("https://registry.npmjs.org/left-pad?token=SECRETVALUE", { method: "GET" });
    const log = requestLog(req, PROPS);
    expect(log).toMatchObject({
      t: "egress",
      agentId: "promoter",
      wakeId: "wake-1",
      method: "GET",
      host: "registry.npmjs.org",
      path: "/left-pad"
    });
    // The query string can carry secrets, so only its length is kept.
    expect(log.queryLen).toBe("token=SECRETVALUE".length);
    expect(JSON.stringify(log)).not.toContain("SECRETVALUE");
  });

  it("truncates an absurdly long path", () => {
    const log = requestLog(new Request("https://x.dev/" + "a".repeat(1000)), PROPS);
    expect(log.path.length).toBeLessThanOrEqual(513);
    expect(log.path.endsWith("…")).toBe(true);
  });

  it("folds a response outcome in", () => {
    const log = withResponse(requestLog(new Request("https://x.dev/"), PROPS), 200, true);
    expect(log.status).toBe(200);
    expect(log.ok).toBe(true);
  });

  it("folds a transport error in", () => {
    const log = withError(requestLog(new Request("https://x.dev/"), PROPS), new Error("ECONNREFUSED"));
    expect(log.error).toContain("ECONNREFUSED");
  });

  it("falls back to unknown ids when props are absent", () => {
    const log = requestLog(new Request("https://x.dev/"), {});
    expect(log.agentId).toBe("unknown");
    expect(log.wakeId).toBe("unknown");
  });
});

describe("egress summaries", () => {
  const line = (host: string, extra: Partial<EgressLog> = {}): EgressLog => ({
    t: "egress",
    agentId: "promoter",
    wakeId: "wake-1",
    method: "GET",
    host,
    path: "/",
    queryLen: 0,
    status: 200,
    ok: true,
    ...extra
  });

  it("tallies per wake with host counts and error counts", () => {
    const tallies = new Map<string, EgressTally>();
    tallyLine(tallies, line("registry.npmjs.org"), 1000);
    tallyLine(tallies, line("registry.npmjs.org"), 2000);
    tallyLine(tallies, line("api.example.com", { ok: false, status: 500 }), 3000);
    const tally = tallies.get("wake-1");
    expect(tally).toMatchObject({
      agentId: "promoter",
      requests: 3,
      errors: 1,
      hosts: { "registry.npmjs.org": 2, "api.example.com": 1 },
      sinceMs: 1000
    });
  });

  it("folds the long host tail into (other) past the cap", () => {
    const tallies = new Map<string, EgressTally>();
    for (let i = 0; i < SUMMARY_MAX_HOSTS + 5; i++) {
      tallyLine(tallies, line(`host-${i}.example`), 0);
    }
    const tally = tallies.get("wake-1");
    expect(Object.keys(tally?.hosts ?? {})).toHaveLength(SUMMARY_MAX_HOSTS + 1);
    expect(tally?.hosts["(other)"]).toBe(5);
  });

  it("flushes on the request threshold or the time window", () => {
    const tallies = new Map<string, EgressTally>();
    const tally = tallyLine(tallies, line("x.dev"), 0);
    expect(dueForFlush(tally, 1000)).toBe(false);
    expect(dueForFlush(tally, SUMMARY_FLUSH_MS)).toBe(true);
    tally.requests = SUMMARY_FLUSH_REQUESTS;
    expect(dueForFlush(tally, 1000)).toBe(true);
  });

  it("shapes the chronicle detail without raw paths or queries", () => {
    const tallies = new Map<string, EgressTally>();
    const tally = tallyLine(tallies, line("x.dev", { path: "/secret-ish/path" }), 0);
    const detail = summaryDetail(tally);
    expect(detail).toEqual({
      wakeId: "wake-1",
      requests: 1,
      errors: 0,
      hosts: { "x.dev": 1 }
    });
    expect(JSON.stringify(detail)).not.toContain("secret-ish");
  });
});
