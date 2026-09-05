import { DurableObject } from "cloudflare:workers";
import {
  HoldStore,
  type CloseIntent,
  type HeldMerge,
  type KeyValueStorage,
  type MergeIntent,
  type TerminalRecord
} from "./holds.js";

/**
 * One PrHolds Durable Object per pr Worker (spec 0012 §8): the store
 * above, handed the DO's storage. Every method is one serialized turn,
 * which is what makes a claim atomic and a dedupe race-free. The logic
 * lives in HoldStore so it is tested without this runtime.
 */
export class PrHolds extends DurableObject {
  private readonly store = new HoldStore(durableStorage(this.ctx.storage));

  hold(merge: Parameters<HoldStore["hold"]>[0], at: string): Promise<{ held: HeldMerge; deduped: boolean }> {
    return this.store.hold(merge, at);
  }
  getHeld(id: string): Promise<HeldMerge | undefined> {
    return this.store.getHeld(id);
  }
  claimHeld(id: string, at: string): Promise<HeldMerge | undefined> {
    return this.store.claimHeld(id, at);
  }
  unclaimHeld(id: string): Promise<void> {
    return this.store.unclaimHeld(id);
  }
  deleteHeld(id: string): Promise<void> {
    return this.store.deleteHeld(id);
  }
  listHeld(): Promise<HeldMerge[]> {
    return this.store.listHeld();
  }
  rejectVerdict(id: string, at: string): ReturnType<HoldStore["rejectVerdict"]> {
    return this.store.rejectVerdict(id, at);
  }
  openMergeIntent(repo: string, number: number): Promise<MergeIntent | undefined> {
    return this.store.openMergeIntent(repo, number);
  }
  listOpenMergeIntents(): Promise<MergeIntent[]> {
    return this.store.listOpenMergeIntents();
  }
  beginMerge(input: Parameters<HoldStore["beginMerge"]>[0]): ReturnType<HoldStore["beginMerge"]> {
    return this.store.beginMerge(input);
  }
  resolveMerge(
    id: string,
    result: Parameters<HoldStore["resolveMerge"]>[1],
    at: string
  ): Promise<MergeIntent | undefined> {
    return this.store.resolveMerge(id, result, at);
  }
  openCloseIntent(repo: string, number: number): Promise<CloseIntent | undefined> {
    return this.store.openCloseIntent(repo, number);
  }
  beginClose(input: Parameters<HoldStore["beginClose"]>[0]): ReturnType<HoldStore["beginClose"]> {
    return this.store.beginClose(input);
  }
  releaseClose(id: string): Promise<void> {
    return this.store.releaseClose(id);
  }
  closeStep(id: string, step: "commented" | "closed"): Promise<void> {
    return this.store.closeStep(id, step);
  }
  resolveClose(id: string, state: "closed" | "failed", at: string, detail?: string): Promise<void> {
    return this.store.resolveClose(id, state, at, detail);
  }
  terminal(repo: string, number: number, headSha: string): Promise<TerminalRecord | undefined> {
    return this.store.terminal(repo, number, headSha);
  }
  recordTerminal(record: TerminalRecord): Promise<void> {
    return this.store.recordTerminal(record);
  }
  listTerminals(): Promise<TerminalRecord[]> {
    return this.store.listTerminals();
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
