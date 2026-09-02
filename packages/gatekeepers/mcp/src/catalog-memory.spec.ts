import { describe, expect, it } from "vitest";
import { CatalogMemory } from "./catalog-memory.js";

function counter() {
  const state = { writes: 0 };
  return {
    state,
    append: async () => {
      state.writes += 1;
    }
  };
}

describe("CatalogMemory", () => {
  it("writes a revision once per agent and server, and again only when it changes", async () => {
    const memory = new CatalogMemory();
    const { state, append } = counter();
    expect(await memory.record("promoter", "livevariant", "aaaa", append)).toBe(true);
    expect(await memory.record("promoter", "livevariant", "aaaa", append)).toBe(false);
    expect(await memory.record("promoter", "livevariant", "bbbb", append)).toBe(true);
    expect(await memory.record("promoter", "livevariant", "aaaa", append)).toBe(true);
    expect(state.writes).toBe(3);
  });

  it("does not remember a revision whose append failed", async () => {
    const memory = new CatalogMemory();
    await expect(
      memory.record("promoter", "livevariant", "aaaa", async () => {
        throw new Error("ledger down");
      })
    ).rejects.toThrow("ledger down");
    const { state, append } = counter();
    expect(await memory.record("promoter", "livevariant", "aaaa", append)).toBe(true);
    expect(state.writes).toBe(1);
  });

  it("single-flights concurrent writes of one revision", async () => {
    const memory = new CatalogMemory();
    let release: () => void = () => undefined;
    let writes = 0;
    const slow = () =>
      new Promise<void>(resolve => {
        writes += 1;
        release = resolve;
      });
    const first = memory.record("promoter", "livevariant", "aaaa", slow);
    const second = memory.record("promoter", "livevariant", "aaaa", slow);
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(writes).toBe(1);
    expect(await memory.record("promoter", "livevariant", "aaaa", slow)).toBe(false);
  });

  it("keeps two revisions of one pair in flight apart", async () => {
    const memory = new CatalogMemory();
    const releases: Array<() => void> = [];
    let writes = 0;
    const slow = () =>
      new Promise<void>(resolve => {
        writes += 1;
        releases.push(resolve);
      });
    const a1 = memory.record("promoter", "livevariant", "aaaa", slow);
    const b1 = memory.record("promoter", "livevariant", "bbbb", slow);
    // A third caller for the first revision joins ITS flight, not the second's.
    const a2 = memory.record("promoter", "livevariant", "aaaa", slow);
    expect(writes).toBe(2);
    for (const release of releases) release();
    expect(await Promise.all([a1, b1, a2])).toEqual([true, true, true]);
    expect(writes).toBe(2);
  });

  it("remembers the newest revision started, not the one that finished last", async () => {
    const memory = new CatalogMemory();
    const releases = new Map<string, () => void>();
    const slow = (tag: string) => () =>
      new Promise<void>(resolve => {
        releases.set(tag, resolve);
      });
    const older = memory.record("promoter", "livevariant", "aaaa", slow("a"));
    const newer = memory.record("promoter", "livevariant", "bbbb", slow("b"));
    releases.get("b")?.();
    await newer;
    releases.get("a")?.();
    await older;
    // The pair's memory is the newer revision; an "aaaa" sighting now is a change.
    let writes = 0;
    const count = async () => {
      writes += 1;
    };
    expect(await memory.record("promoter", "livevariant", "bbbb", count)).toBe(false);
    expect(await memory.record("promoter", "livevariant", "aaaa", count)).toBe(true);
    expect(writes).toBe(1);
  });

  it("keeps agents and servers apart", async () => {
    const memory = new CatalogMemory();
    const { state, append } = counter();
    await memory.record("promoter", "livevariant", "aaaa", append);
    await memory.record("other", "livevariant", "aaaa", append);
    await memory.record("promoter", "linear", "aaaa", append);
    expect(state.writes).toBe(3);
  });
});
