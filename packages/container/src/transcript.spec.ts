import { describe, expect, it } from "vitest";
import { redactLiterals, TranscriptShipper, REDACTED } from "./transcript.js";

function collectingFetch() {
  const chunks: Array<{ seq: number; text: string; done?: boolean }> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    chunks.push(JSON.parse(String(init?.body)) as (typeof chunks)[number]);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { chunks, fetchImpl };
}

function shipper(denylist: string[], fetchImpl: typeof fetch) {
  return new TranscriptShipper({
    url: "http://chronicle.test",
    token: "t",
    wakeId: "wake-1",
    agentId: "promoter",
    denylist,
    flushIntervalMs: 60_000, // flushing is driven manually via close() here
    fetchImpl
  });
}

describe("redactLiterals", () => {
  it("replaces every occurrence, longest literal first", () => {
    expect(redactLiterals("key=abc-secret-xyz done", ["abc-secret-xyz", "secret"])).toBe(
      `key=${REDACTED} done`
    );
  });
});

describe("TranscriptShipper", () => {
  it("ships whole lines, redacted, and marks the final chunk done", async () => {
    const { chunks, fetchImpl } = collectingFetch();
    const s = shipper(["super-secret-value"], fetchImpl);
    s.ready();
    s.write("hello\ntoken is super-secret-value here\npartial");
    await s.close();
    const all = chunks.map(chunk => chunk.text).join("");
    expect(all).toContain("hello\n");
    expect(all).toContain(`token is ${REDACTED} here`);
    // The partial last line ships at close.
    expect(all).toContain("partial");
    expect(all).not.toContain("super-secret-value");
    expect(chunks[chunks.length - 1].done).toBe(true);
  });

  it("redacts values added to the live denylist AFTER construction", async () => {
    const { chunks, fetchImpl } = collectingFetch();
    const denylist: string[] = [];
    const s = shipper(denylist, fetchImpl);
    s.ready();
    s.write("the value is late-vaulted-secret indeed\n");
    denylist.push("late-vaulted-secret"); // e.g. `operon vault set` mid-wake
    await s.close();
    expect(chunks.map(chunk => chunk.text).join("")).not.toContain("late-vaulted-secret");
  });

  it("holds everything until ready() so nothing ships before the denylist exists", async () => {
    const { chunks, fetchImpl } = collectingFetch();
    const s = shipper([], fetchImpl);
    s.write("early output\n");
    // Never marked ready: close must not ship.
    await s.close();
    expect(chunks).toEqual([]);
  });

  it("keeps unshipped text and retries when the chronicle is down", async () => {
    let failures = 1;
    const { chunks, fetchImpl } = collectingFetch();
    const flaky = (async (url: unknown, init?: RequestInit) => {
      if (failures-- > 0) return new Response("nope", { status: 503 });
      return fetchImpl(url as string, init);
    }) as typeof fetch;
    const s = shipper([], flaky);
    s.ready();
    s.write("survives the outage\n");
    await s.close();
    expect(chunks.map(chunk => chunk.text).join("")).toContain("survives the outage");
  });
});
