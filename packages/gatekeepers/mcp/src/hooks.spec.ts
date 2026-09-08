import { describe, expect, it } from "vitest";
import { deliveryKey, fillRegistration, readPath, runIdFromResult, signedInput, timestampMs, TIMESTAMP_SKEW_MS, verifySignature } from "./hooks.js";

const encoder = new TextEncoder();
async function hmacHex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(input)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

describe("webhook signatures (spec 0014 §3)", () => {
  it("verifies an HMAC over the body, in hex and base64, and refuses a wrong secret or a tampered body", async () => {
    const body = JSON.stringify({ run_id: "r1", event: "done" });
    const sig = await hmacHex("s3cret", body);
    expect(await verifySignature("hmac-sha256-hex", "s3cret", sig, body)).toBe(true);
    expect(await verifySignature("hmac-sha256-hex", "s3cret", `sha256=${sig}`, body)).toBe(true);
    expect(await verifySignature("hmac-sha256-hex", "other", sig, body)).toBe(false);
    expect(await verifySignature("hmac-sha256-hex", "s3cret", sig, body + " ")).toBe(false);
    expect(await verifySignature("hmac-sha256-hex", "s3cret", "not hex", body)).toBe(false);
    const b64 = btoa(String.fromCharCode(...(sig.match(/../g) ?? []).map(h => parseInt(h, 16))));
    expect(await verifySignature("hmac-sha256-base64", "s3cret", b64, body)).toBe(true);
    expect(await verifySignature("hmac-sha256-base64", "s3cret", "%%%", body)).toBe(false);
  });

  it("binds the timestamp into the signed input when the contract names one", async () => {
    const body = "{}";
    expect(signedInput(body)).toBe(body);
    expect(signedInput(body, "1700000000")).toBe(`1700000000.${body}`);
    const sig = await hmacHex("k", signedInput(body, "1700000000"));
    expect(await verifySignature("hmac-sha256-hex", "k", sig, signedInput(body, "1700000000"))).toBe(true);
    expect(await verifySignature("hmac-sha256-hex", "k", sig, signedInput(body, "1700000001"))).toBe(false);
  });

  it("verifies ed25519 against the provider's public key and refuses a bad key or signature", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
    const body = '{"run_id":"r2"}';
    const sig = hex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, encoder.encode(body)));
    expect(await verifySignature("ed25519-hex", publicKey, sig, body)).toBe(true);
    expect(await verifySignature("ed25519-hex", publicKey, sig, body + "x")).toBe(false);
    expect(await verifySignature("ed25519-hex", "zz", sig, body)).toBe(false);
    expect(await verifySignature("ed25519-hex", publicKey, "00", body)).toBe(false);
  });

  it("reads provider timestamps in seconds, milliseconds and ISO 8601", () => {
    expect(timestampMs("1700000000")).toBe(1_700_000_000_000);
    expect(timestampMs("1700000000000")).toBe(1_700_000_000_000);
    expect(timestampMs("2026-09-08T10:00:00Z")).toBe(Date.parse("2026-09-08T10:00:00Z"));
    expect(timestampMs("yesterday")).toBeUndefined();
    expect(TIMESTAMP_SKEW_MS).toBe(5 * 60 * 1000);
  });
});

describe("the registration template", () => {
  it("fills {url} as a whole field and {events} as the array or joined text", () => {
    const filled = fillRegistration(
      { webhook: { url: "{url}", event_types: "{events}" }, note: "events: {events} at {url}", keep: 3 },
      "https://hooks.example.com/webhook/tasks",
      ["task_run.status"]
    );
    expect(filled).toEqual({
      webhook: { url: "https://hooks.example.com/webhook/tasks", event_types: ["task_run.status"] },
      note: "events: task_run.status at https://hooks.example.com/webhook/tasks",
      keep: 3
    });
  });

  it("reads dotted paths, including array indexes, and answers undefined past a scalar", () => {
    const value = { data: { runs: [{ id: "a" }, { id: "b" }] }, flat: "x" };
    expect(readPath(value, "data.runs.1.id")).toBe("b");
    expect(readPath(value, "flat")).toBe("x");
    expect(readPath(value, "flat.deeper")).toBeUndefined();
    expect(readPath(value, "missing.path")).toBeUndefined();
  });

  it("dedupes on the provider's id when one is named, else on the body's digest", async () => {
    expect(await deliveryKey("evt_1", "{}")).toBe("id:evt_1");
    expect(await deliveryKey(7, "{}")).toBe("id:7");
    const digest = await deliveryKey(undefined, '{"a":1}');
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await deliveryKey("", '{"a":1}')).toBe(digest);
    expect(await deliveryKey(undefined, '{"a":2}')).not.toBe(digest);
  });

  it("finds the run id in structured content, then in JSON text content, never in prose", () => {
    expect(runIdFromResult({ structuredContent: { run: { id: "r-1" } } }, "run.id")).toBe("r-1");
    expect(runIdFromResult({ content: [{ type: "text", text: '{"run_id": 42}' }] }, "run_id")).toBe("42");
    expect(runIdFromResult({ content: [{ type: "text", text: "run_id: r-3" }] }, "run_id")).toBeUndefined();
    expect(runIdFromResult({ structuredContent: { run: {} } }, "run.id")).toBeUndefined();
    expect(runIdFromResult("nope", "run.id")).toBeUndefined();
  });
});
