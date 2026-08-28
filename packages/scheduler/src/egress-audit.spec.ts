import { describe, expect, it } from "vitest";
import { requestLog, withError, withResponse } from "./egress-audit.js";

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
