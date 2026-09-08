import { DurableObject } from "cloudflare:workers";
import type { KeyValueStorage } from "./meter.js";
import { RunStore, type OpenCreate, type StoredResult, type UnattributedResult } from "./runs.js";

/** One Runs Durable Object per webhook-bearing server (spec 0014 §3); the logic is RunStore's. */
export class Runs extends DurableObject {
  private readonly store = new RunStore(durableStorage(this.ctx.storage));

  openCreate(create: OpenCreate): Promise<void> {
    return this.store.openCreate(create);
  }
  closeCreate(createId: string, runId: string): Promise<boolean> {
    return this.store.closeCreate(createId, runId);
  }
  listOpenCreates(at: string): Promise<OpenCreate[]> {
    return this.store.listOpenCreates(at);
  }
  storeCallback(input: { runId: string; event: string; deliveryKey: string; body: string; at: string }) {
    return this.store.storeCallback(input);
  }
  pullResults(agentId: string, limit?: number): Promise<StoredResult[]> {
    return this.store.pullResults(agentId, limit);
  }
  ackResults(agentId: string, ids: string[]): Promise<number> {
    return this.store.ackResults(agentId, ids);
  }
  listUnattributed(): Promise<UnattributedResult[]> {
    return this.store.listUnattributed();
  }
  assign(id: string, agentId: string): Promise<UnattributedResult | undefined> {
    return this.store.assign(id, agentId);
  }
}

function durableStorage(storage: DurableObjectStorage): KeyValueStorage {
  return {
    get: <T>(key: string) => storage.get<T>(key),
    put: <T>(key: string, value: T) => storage.put(key, value),
    delete: async (key: string) => {
      await storage.delete(key);
    },
    list: <T>(prefix: string) => storage.list<T>({ prefix })
  };
}
