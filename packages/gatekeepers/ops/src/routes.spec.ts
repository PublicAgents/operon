import { describe, expect, it } from "vitest";
import { downstreamPath, matchRoute, OPS_ROUTES } from "./routes.js";

describe("ops route table", () => {
  it("matches an exact read route", () => {
    const m = matchRoute("GET", "/chronicle/events");
    expect(m?.route.binding).toBe("CHRONICLE_GK");
    expect(m && downstreamPath(m)).toBe("/chronicle/events");
  });

  it("captures the tail of a wildcard route", () => {
    const m = matchRoute("GET", "/chronicle/wake-log/abc-123");
    expect(m?.route.binding).toBe("CHRONICLE_GK");
    expect(m && downstreamPath(m)).toBe("/chronicle/wake-log/abc-123");
  });

  it("routes agent control to the scheduler with the tail", () => {
    const m = matchRoute("POST", "/wake/promoter");
    expect(m?.route.binding).toBe("SCHEDULER");
    expect(m && downstreamPath(m)).toBe("/wake/promoter");
    expect(m?.route.decision).toBe(true);
  });

  it("flags decisions and leaves reads unflagged", () => {
    expect(matchRoute("POST", "/spend/approve")?.route.decision).toBe(true);
    expect(matchRoute("GET", "/ledger/spend")?.route.decision).toBeUndefined();
  });

  it("does not match a method mismatch or unknown path", () => {
    expect(matchRoute("GET", "/spend/approve")).toBeNull();
    expect(matchRoute("POST", "/nope")).toBeNull();
  });

  it("exposes the console's wake reads on the scheduler", () => {
    expect(matchRoute("GET", "/agents")?.route.binding).toBe("SCHEDULER");
    const wakes = matchRoute("GET", "/wakes/promoter");
    expect(wakes?.route.binding).toBe("SCHEDULER");
    expect(wakes && downstreamPath(wakes)).toBe("/wakes/promoter");
    expect(wakes?.route.decision).toBeUndefined();
  });

  it("every route names a binding and a downstream path", () => {
    for (const r of OPS_ROUTES) {
      expect(r.binding).toBeTruthy();
      expect(r.downstreamPath.startsWith("/")).toBe(true);
    }
  });
});
