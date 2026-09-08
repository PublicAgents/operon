import { describe, expect, it } from "vitest";
import type { KeyValueStorage } from "./meter.js";
import { RUN_RETENTION_MS, RunStore } from "./runs.js";

function memory(): KeyValueStorage {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      map.set(key, structuredClone(value));
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async <T>(prefix: string) => {
      const out = new Map<string, T>();
      for (const [k, v] of map) if (k.startsWith(prefix)) out.set(k, v as T);
      return out;
    }
  };
}

const T0 = "2026-09-08T10:00:00.000Z";
const T1 = "2026-09-08T10:05:00.000Z";
const T2 = "2026-09-08T10:06:00.000Z";

describe("the run store (spec 0014 §3)", () => {
  it("attributes a callback to the agent whose create produced the run, and queues it until acked", async () => {
    const store = new RunStore(memory());
    await store.openCreate({ id: "c1", agentId: "scout", tool: "createTask", at: T0 });
    expect(await store.closeCreate("c1", "run-1")).toBe(true);
    expect(await store.closeCreate("c1", "run-1")).toBe(false);
    expect(await store.listOpenCreates(T1)).toEqual([]);
    const stored = await store.storeCallback({ runId: "run-1", event: "done", deliveryKey: "id:e1", body: "{}", at: T1 });
    expect(stored).toMatchObject({ stored: true, agentId: "scout" });
    const pulled = await store.pullResults("scout");
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).toMatchObject({ id: stored.id, runId: "run-1", n: 1, event: "done", body: "{}", at: T1 });
    // Not acked: the same wake, interrupted, sees it again.
    expect(await store.pullResults("scout")).toHaveLength(1);
    expect(await store.ackResults("scout", [stored.id])).toBe(1);
    expect(await store.pullResults("scout")).toEqual([]);
    expect(await store.ackResults("scout", [stored.id])).toBe(0);
  });

  it("stores each delivery once, by delivery key within a run", async () => {
    const store = new RunStore(memory());
    await store.openCreate({ id: "c1", agentId: "scout", tool: "createTask", at: T0 });
    await store.closeCreate("c1", "run-1");
    const first = await store.storeCallback({ runId: "run-1", event: "done", deliveryKey: "id:e1", body: "{}", at: T1 });
    const again = await store.storeCallback({ runId: "run-1", event: "done", deliveryKey: "id:e1", body: "{}", at: T2 });
    expect(again).toEqual({ stored: false, id: first.id });
    const other = await store.storeCallback({ runId: "run-1", event: "progress", deliveryKey: "id:e2", body: "{}", at: T2 });
    expect(other.stored).toBe(true);
    // Numbered within the run in arrival order, across pulls and acks:
    // the inbox path never collides with an earlier callback's.
    expect((await store.pullResults("scout")).map(row => row.n)).toEqual([1, 2]);
    await store.ackResults("scout", [first.id, other.id]);
    const third = await store.storeCallback({ runId: "run-1", event: "done", deliveryKey: "id:e3", body: "{}", at: T2 });
    expect((await store.pullResults("scout")).map(row => [row.id, row.n])).toEqual([[third.id, 3]]);
  });

  it("keeps a callback nobody could be attributed for the operator, with the open creates as evidence", async () => {
    const store = new RunStore(memory());
    await store.openCreate({ id: "c-lost", agentId: "scout", tool: "createTask", at: T0 });
    const stored = await store.storeCallback({ runId: "run-?", event: "done", deliveryKey: "id:e9", body: '{"x":1}', at: T1 });
    expect(stored).toEqual({ stored: true, id: stored.id });
    expect(await store.pullResults("scout")).toEqual([]);
    const orphans = await store.listUnattributed();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ id: stored.id, runId: "run-?", openCreates: [{ id: "c-lost", agentId: "scout" }] });
    // The operator's decision: the result and the run become the agent's.
    const assigned = await store.assign(stored.id, "scout");
    expect(assigned?.runId).toBe("run-?");
    expect(await store.listUnattributed()).toEqual([]);
    expect(await store.pullResults("scout")).toHaveLength(1);
    expect(await store.agentOf("run-?", T2)).toBe("scout");
    const next = await store.storeCallback({ runId: "run-?", event: "done", deliveryKey: "id:e10", body: "{}", at: T2 });
    expect(next.agentId).toBe("scout");
    expect(await store.assign("nope", "scout")).toBeUndefined();
  });

  it("forgets open creates and run attributions past the retention window", async () => {
    const store = new RunStore(memory());
    await store.openCreate({ id: "old", agentId: "scout", tool: "createTask", at: T0 });
    await store.openCreate({ id: "done", agentId: "scout", tool: "createTask", at: T0 });
    await store.closeCreate("done", "run-old");
    const later = new Date(Date.parse(T0) + RUN_RETENTION_MS + 1000).toISOString();
    expect(await store.listOpenCreates(later)).toEqual([]);
    expect(await store.closeCreate("old", "run-late")).toBe(false);
    expect(await store.agentOf("run-old", T1)).toBe("scout");
    // A callback after the window is nobody's: kept for the operator,
    // never handed to whoever held the run a month ago.
    const late = await store.storeCallback({ runId: "run-old", event: "done", deliveryKey: "id:late", body: "{}", at: later });
    expect(late.agentId).toBeUndefined();
    expect(await store.pullResults("scout")).toEqual([]);
    expect((await store.listUnattributed()).map(row => row.runId)).toEqual(["run-old"]);
    expect(await store.agentOf("run-old", later)).toBeUndefined();
  });
});
