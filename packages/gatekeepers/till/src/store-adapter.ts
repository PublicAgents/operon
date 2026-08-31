/**
 * The mppx AtomicStore adapter over the TillStore DO stub. Pure module
 * with no cloudflare imports so the spec can exercise the CAS loop in
 * plain node; the DO class lives in replay-store.ts.
 */

export interface TillStoreStub {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  tryClaim(key: string, expires: number): Promise<boolean>;
  releaseClaim(key: string): Promise<void>;
  getVersioned(key: string): Promise<{ value: unknown; version: number }>;
  casPut(
    key: string,
    expectedVersion: number,
    change: { op: "noop" } | { op: "set"; value: unknown } | { op: "delete" }
  ): Promise<boolean>;
}

/**
 * mppx AtomicStore over the TillStore DO. tryClaim is the native fast
 * path (what the charge replay check uses); update is an optimistic
 * CAS loop for completeness, since Store callbacks cannot cross an RPC
 * boundary and the DO's serialization plus versioning gives the same
 * atomicity.
 */
export function durableStore(stub: TillStoreStub): {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  tryClaim: (key: string, expires: number) => Promise<boolean>;
  releaseClaim: (key: string) => Promise<void>;
  update: <result>(
    key: string,
    fn: (current: unknown) => { op: "noop"; result: result } | { op: "set"; value: unknown; result: result } | { op: "delete"; result: result }
  ) => Promise<result>;
} {
  return {
    get: key => stub.get(key),
    put: (key, value) => stub.put(key, value),
    delete: key => stub.delete(key),
    tryClaim: (key, expires) => stub.tryClaim(key, expires),
    releaseClaim: key => stub.releaseClaim(key),
    async update(key, fn) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const { value, version } = await stub.getVersioned(key);
        const change = fn(value);
        const applied = await stub.casPut(
          key,
          version,
          change.op === "set" ? { op: "set", value: change.value } : { op: change.op }
        );
        if (applied) return change.result;
      }
      throw new Error("till store update contention: eight CAS attempts lost");
    }
  };
}
