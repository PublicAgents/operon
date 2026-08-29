import { describe, expect, it } from "vitest";
import { csrfDenied, wsOriginDenied, wsProtocolToken } from "./guards.js";

const OPS = new URL("https://ops.example.test/api/v1/wake");

function post(headers: Record<string, string>): Request {
  return new Request(OPS, { method: "POST", headers });
}

describe("csrfDenied", () => {
  it("exempts header-authenticated (service token / cloudflared) callers", () => {
    expect(csrfDenied(post({ "cf-access-jwt-assertion": "jwt" }), OPS)).toBeNull();
  });

  it("requires the custom header on cookie-authenticated writes", async () => {
    const denied = csrfDenied(post({ cookie: "CF_Authorization=jwt" }), OPS);
    expect(denied?.status).toBe(403);
    expect(await denied?.json()).toMatchObject({ error: "csrf_header_missing" });
  });

  it("accepts a same-origin console write", () => {
    expect(
      csrfDenied(
        post({
          cookie: "CF_Authorization=jwt",
          "x-operon-console": "1",
          "sec-fetch-site": "same-origin",
          origin: "https://ops.example.test"
        }),
        OPS
      )
    ).toBeNull();
  });

  it("refuses a cross-site write even with the header", async () => {
    const denied = csrfDenied(
      post({ "x-operon-console": "1", "sec-fetch-site": "cross-site" }),
      OPS
    );
    expect(await denied?.json()).toMatchObject({ error: "csrf_cross_site" });
  });

  it("refuses a mismatched Origin", async () => {
    const denied = csrfDenied(
      post({ "x-operon-console": "1", origin: "https://evil.example" }),
      OPS
    );
    expect(await denied?.json()).toMatchObject({ error: "csrf_origin_mismatch" });
  });

  it("ignores GETs (reads carry no CSRF risk on this surface)", () => {
    expect(csrfDenied(new Request(OPS, { method: "GET" }), OPS)).toBeNull();
  });
});

describe("wsOriginDenied", () => {
  it("accepts same-origin and headerless upgrades, refuses foreign origins", () => {
    const ws = new URL("https://ops.example.test/ws/channel");
    expect(
      wsOriginDenied(new Request(ws, { headers: { origin: "https://ops.example.test" } }), ws)
    ).toBeNull();
    expect(wsOriginDenied(new Request(ws), ws)).toBeNull();
    expect(
      wsOriginDenied(new Request(ws, { headers: { origin: "https://evil.example" } }), ws)?.status
    ).toBe(403);
  });
});

describe("wsProtocolToken", () => {
  it("extracts the token entry and ignores the rest", () => {
    const request = new Request(OPS, {
      headers: { "sec-websocket-protocol": "operon-ws, operon-access.abc.def.ghi" }
    });
    expect(wsProtocolToken(request)).toBe("abc.def.ghi");
  });

  it("returns null when absent or empty", () => {
    expect(wsProtocolToken(new Request(OPS))).toBeNull();
    expect(
      wsProtocolToken(new Request(OPS, { headers: { "sec-websocket-protocol": "operon-access." } }))
    ).toBeNull();
  });
});
