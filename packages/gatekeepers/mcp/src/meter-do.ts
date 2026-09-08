import { DurableObject } from "cloudflare:workers";
import { MeterStore, type KeyValueStorage, type Remaining, type Reservation, type ReserveOutcome } from "./meter.js";

/**
 * One Meter Durable Object per budgeted server (spec 0014 §4): the
 * store above, handed the DO's storage. Every method is one serialized
 * turn, so a reservation is atomic and two agents cannot both take the
 * last cent. The logic lives in MeterStore so it is tested without
 * this runtime.
 */
export class Meter extends DurableObject {
  private readonly store = new MeterStore(durableStorage(this.ctx.storage));

  remaining(monthlyUsd: number, at: string): Promise<{ remaining: Remaining; staleSettled: Reservation[] }> {
    return this.store.remaining(monthlyUsd, at);
  }
  reserve(
    input: { id: string; tool: string; agentId: string; usd: number; monthlyUsd: number },
    at: string
  ): Promise<ReserveOutcome & { staleSettled: Reservation[] }> {
    return this.store.reserve(input, at);
  }
  settle(id: string): Promise<boolean> {
    return this.store.settle(id);
  }
  refund(id: string): Promise<boolean> {
    return this.store.refund(id);
  }
  reset(spentMonthUsd: number, monthlyUsd: number, at: string): Promise<{ remaining: Remaining; staleSettled: Reservation[] }> {
    return this.store.reset(spentMonthUsd, monthlyUsd, at);
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
