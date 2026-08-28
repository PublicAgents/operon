import { describe, expect, it } from "vitest";
import { auditEvent, sessionNameFromPath, upstreamEndpoint } from "./audit.js";

describe("audit taps", () => {
  it("ledgers a top-frame navigation", () => {
    const frame = JSON.stringify({
      method: "Page.frameNavigated",
      params: { frame: { id: "A", url: "https://example.com/pricing" } }
    });
    expect(auditEvent(frame)).toEqual({ kind: "navigation", url: "https://example.com/pricing" });
  });

  it("ignores subframe navigations (ads and embeds)", () => {
    const frame = JSON.stringify({
      method: "Page.frameNavigated",
      params: { frame: { id: "B", parentId: "A", url: "https://ads.example.net/slot" } }
    });
    expect(auditEvent(frame)).toBeNull();
  });

  it("ledgers a download", () => {
    const frame = JSON.stringify({
      method: "Browser.downloadWillBegin",
      params: { url: "https://example.com/report.pdf" }
    });
    expect(auditEvent(frame)).toEqual({ kind: "download", url: "https://example.com/report.pdf" });
  });

  it("passes ordinary frames through without parsing surprises", () => {
    expect(auditEvent('{"id":7,"result":{}}')).toBeNull();
    expect(auditEvent("not json at all")).toBeNull();
    expect(auditEvent('{"method":"Network.responseReceived","params":{}}')).toBeNull();
  });

  it("parses session names strictly", () => {
    expect(sessionNameFromPath("/web/session/research")).toBe("research");
    expect(sessionNameFromPath("/web/session/x-account")).toBe("x-account");
    expect(sessionNameFromPath("/web/session/UPPER")).toBeNull();
    expect(sessionNameFromPath("/web/session/a/b")).toBeNull();
    expect(sessionNameFromPath("/web/other")).toBeNull();
  });

  it("builds the recorded, kept-alive upstream endpoint", () => {
    const url = upstreamEndpoint("acc123");
    expect(url).toContain("/accounts/acc123/browser-rendering/devtools/browser");
    expect(url).toContain("recording=true");
    expect(url).toContain("keep_alive=600000");
  });
});
