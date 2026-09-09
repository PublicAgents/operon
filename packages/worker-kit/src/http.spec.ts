import { describe, expect, it } from "vitest";
import { drainBody, errorResponse, json, readJson, requireBearer } from "./http.js";

function request(auth?: string): Request {
  return new Request("https://example.com/", {
    headers: auth ? { authorization: auth } : {}
  });
}

describe("requireBearer", () => {
  it("fails closed when no token is configured server-side", async () => {
    const denied = requireBearer(request("Bearer anything"), undefined);
    expect(denied?.status).toBe(500);
    expect(await denied?.json()).toMatchObject({ error: "auth_not_configured" });
  });

  it("names each distinct rejection", async () => {
    expect((await requireBearer(request(), "t")?.json()) as object).toMatchObject({
      error: "missing_bearer"
    });
    expect(
      (await requireBearer(request("Basic abc"), "t")?.json()) as object
    ).toMatchObject({ error: "malformed_authorization_header" });
    expect(
      (await requireBearer(request("Bearer wrong"), "t")?.json()) as object
    ).toMatchObject({ error: "invalid_token" });
  });

  it("returns null on a valid token", () => {
    expect(requireBearer(request("Bearer right"), "right")).toBeNull();
  });
});

describe("readJson", () => {
  it("returns the parsed value on valid JSON", async () => {
    const request = new Request("https://x/", { method: "POST", body: '{"a":1}' });
    expect(await readJson<{ a: number }>(request)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("does not throw on malformed JSON, so the ledger path can run", async () => {
    const request = new Request("https://x/", { method: "POST", body: "{not json" });
    expect(await readJson(request)).toEqual({ ok: false });
  });

  it("rejects valid non-object JSON that handlers would crash destructuring", async () => {
    for (const body of ["null", "42", '"text"', "[1,2]"]) {
      const request = new Request("https://x/", { method: "POST", body });
      expect(await readJson(request)).toEqual({ ok: false });
    }
  });
});

describe("drainBody", () => {
  it("consumes a body the handler never reads, so nothing is left unread behind the response", async () => {
    const request = new Request("https://x/", { method: "POST", body: "{}" });
    expect(request.bodyUsed).toBe(false);
    await drainBody(request);
    expect(request.bodyUsed).toBe(true);
  });

  it("is a no-op on a request without a body", async () => {
    const request = new Request("https://x/", { method: "POST" });
    await expect(drainBody(request)).resolves.toBeUndefined();
    expect(request.bodyUsed).toBe(false);
  });

  it("is a no-op on a body already read, and never throws", async () => {
    const request = new Request("https://x/", { method: "POST", body: '{"a":1}' });
    expect(await readJson(request)).toEqual({ ok: true, value: { a: 1 } });
    await expect(drainBody(request)).resolves.toBeUndefined();
    expect(request.bodyUsed).toBe(true);
  });

  it("reads a streamed body to its end without buffering it", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 3) controller.close();
        else controller.enqueue(new TextEncoder().encode("{}"));
      }
    });
    const request = new Request("https://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await drainBody(request);
    expect(pulls).toBe(4);
    expect(request.bodyUsed).toBe(true);
  });

  it("swallows a stream that fails mid-read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection dropped"));
      }
    });
    const request = new Request("https://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(drainBody(request)).resolves.toBeUndefined();
  });
});

describe("responses", () => {
  it("json sets the content type", () => {
    const response = json({ a: 1 });
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("errorResponse carries code and optional detail", async () => {
    const response = errorResponse(404, "unknown_agent", "growth");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_agent", detail: "growth" });
  });
});
