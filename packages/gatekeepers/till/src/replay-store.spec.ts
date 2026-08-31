import { describe, expect, it } from "vitest";
import { durableStore } from "./store-adapter.js";

/** In-memory stand-in with the DO stub's contract, for the adapter. */
function fakeStub() {
  const kv = new Map<string, unknown>();
  const claims = new Map<string, number>();
  const versioned = new Map<string, { value: unknown; version: number }>();
  return {
    async get(key: string) {
      return kv.get(key) ?? null;
    },
    async put(key: string, value: unknown) {
      kv.set(key, value);
    },
    async delete(key: string) {
      kv.delete(key);
    },
    async releaseClaim(key: string) {
      claims.delete(key);
    },
    async tryClaim(key: string, expires: number) {
      const existing = claims.get(key);
      if (existing !== undefined && existing > Date.now()) return false;
      claims.set(key, expires);
      return true;
    },
    async getVersioned(key: string) {
      return versioned.get(key) ?? { value: null, version: 0 };
    },
    async casPut(
      key: string,
      expectedVersion: number,
      change: { op: "noop" } | { op: "set"; value: unknown } | { op: "delete" }
    ) {
      const row = versioned.get(key) ?? { value: null, version: 0 };
      if (row.version !== expectedVersion) return false;
      if (change.op === "set") versioned.set(key, { value: change.value, version: row.version + 1 });
      else if (change.op === "delete") versioned.delete(key);
      return true;
    },
    _versioned: versioned
  };
}

describe("durableStore adapter", () => {
  it("tryClaim claims once and refuses the replay until expiry", async () => {
    const store = durableStore(fakeStub());
    const expires = Date.now() + 60_000;
    expect(await store.tryClaim("tx:0xabc", expires)).toBe(true);
    expect(await store.tryClaim("tx:0xabc", expires)).toBe(false);
    expect(await store.tryClaim("tx:0xdef", expires)).toBe(true);
  });

  it("releaseClaim drops a scratch claim so the key is claimable again", async () => {
    const store = durableStore(fakeStub());
    const expires = Date.now() + 60_000;
    expect(await store.tryClaim("selfcheck:x", expires)).toBe(true);
    expect(await store.tryClaim("selfcheck:x", expires)).toBe(false);
    await store.releaseClaim("selfcheck:x");
    expect(await store.tryClaim("selfcheck:x", expires)).toBe(true);
  });

  it("an expired claim is claimable again", async () => {
    const store = durableStore(fakeStub());
    expect(await store.tryClaim("tx:0xabc", Date.now() - 1)).toBe(true);
    expect(await store.tryClaim("tx:0xabc", Date.now() + 60_000)).toBe(true);
  });

  it("update applies the change atomically and returns the callback result", async () => {
    const store = durableStore(fakeStub());
    const first = await store.update("counter", current => ({
      op: "set",
      value: ((current as number) ?? 0) + 1,
      result: "wrote"
    }));
    expect(first).toBe("wrote");
    const second = await store.update("counter", current => ({ op: "noop", result: current }));
    expect(second).toBe(1);
  });

  it("update retries a lost CAS and wins on the fresh version", async () => {
    const stub = fakeStub();
    const store = durableStore(stub);
    let raced = false;
    const result = await store.update("k", current => {
      if (!raced) {
        // Simulate a concurrent writer landing between read and CAS.
        raced = true;
        stub._versioned.set("k", { value: "other", version: (stub._versioned.get("k")?.version ?? 0) + 1 });
      }
      return { op: "set", value: `${current ?? "null"}+mine`, result: current };
    });
    expect(result).toBe("other");
    expect(stub._versioned.get("k")?.value).toBe("other+mine");
  });
});
