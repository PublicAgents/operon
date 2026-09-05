import { describe, expect, it } from "vitest";
import { CLAIM_AGE_MS, HoldStore, memoryStorage, TERMINAL_RETENTION_MS } from "./holds.js";

const T0 = "2026-09-05T10:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function store() {
  let n = 0;
  return new HoldStore(memoryStorage(), () => `id-${(n += 1)}`);
}

const merge = {
  agentId: "cto",
  repo: "org/registry",
  number: 7,
  title: "add @Prior",
  author: "researcher-bot",
  headSha: "head1",
  outside: ["site/index.ts"],
  approvedBy: ["reviewer"]
};

describe("HoldStore holds (spec 0012 §8)", () => {
  it("holds once per head, claimed rows included, and lists in queue order", async () => {
    const s = store();
    const first = await s.hold(merge, T0);
    expect(first).toMatchObject({ deduped: false, held: { id: "id-1", queuedAt: T0, headSha: "head1" } });
    expect(await s.hold(merge, later(1000))).toMatchObject({ deduped: true, held: { id: "id-1" } });
    expect(await s.claimHeld("id-1", later(2000))).toMatchObject({ claimed: true, claimedAt: later(2000) });
    expect(await s.hold(merge, later(3000))).toMatchObject({ deduped: true, held: { id: "id-1" } });
    const other = await s.hold({ ...merge, headSha: "head2" }, later(4000));
    expect(other.held.id).toBe("id-2");
    expect((await s.listHeld()).map(h => h.id)).toEqual(["id-1", "id-2"]);
  });

  it("claims exactly once until unclaimed, and deletes", async () => {
    const s = store();
    await s.hold(merge, T0);
    expect(await s.claimHeld("id-1", T0)).toBeDefined();
    expect(await s.claimHeld("id-1", T0)).toBeUndefined();
    await s.unclaimHeld("id-1");
    expect(await s.claimHeld("id-1", T0)).toBeDefined();
    await s.deleteHeld("id-1");
    expect(await s.claimHeld("id-1", T0)).toBeUndefined();
    expect(await s.getHeld("id-1")).toBeUndefined();
  });

  it("answers a rejection by the claim's age", async () => {
    const s = store();
    await s.hold(merge, T0);
    expect(await s.rejectVerdict("nope", T0)).toEqual({ status: "not_found" });
    expect((await s.rejectVerdict("id-1", T0)).status).toBe("clear");
    await s.claimHeld("id-1", T0);
    expect((await s.rejectVerdict("id-1", later(CLAIM_AGE_MS - 1))).status).toBe("approval_in_flight");
    expect((await s.rejectVerdict("id-1", later(CLAIM_AGE_MS + 1))).status).toBe("stale_claim");
  });
});

describe("HoldStore intents and terminals (spec 0012 §6, §7)", () => {
  it("keeps one open merge intent per pull request until it is terminal", async () => {
    const s = store();
    expect(await s.openMergeIntent("org/registry", 7)).toBeUndefined();
    const intent = await s.beginMerge({ repo: "org/registry", number: 7, headSha: "head1", agentId: "cto", mode: "auto", at: T0 });
    expect(intent).toMatchObject({ id: "id-1", state: "pending" });
    expect((await s.openMergeIntent("org/registry", 7))?.id).toBe("id-1");
    await s.resolveMerge("id-1", { state: "unknown", detail: "timeout" }, later(1000));
    expect(await s.openMergeIntent("org/registry", 7)).toMatchObject({ state: "unknown", detail: "timeout" });
    const merged = await s.resolveMerge("id-1", { state: "merged", mergeSha: "m1" }, later(2000));
    expect(merged).toMatchObject({ state: "merged", mergeSha: "m1", resolvedAt: later(2000) });
    expect(await s.openMergeIntent("org/registry", 7)).toBeUndefined();
    expect(await s.resolveMerge("ghost", { state: "failed" }, T0)).toBeUndefined();
  });

  it("records close steps so a retry resumes where the last call stopped", async () => {
    const s = store();
    const intent = await s.beginClose({ repo: "org/registry", number: 8, agentId: "cto", reason: "spam", at: T0 });
    expect(intent.steps).toEqual({});
    await s.closeStep(intent.id, "commented");
    expect((await s.openCloseIntent("org/registry", 8))?.steps).toEqual({ commented: true });
    await s.closeStep(intent.id, "closed");
    await s.resolveClose(intent.id, "closed", later(1000));
    expect(await s.openCloseIntent("org/registry", 8)).toBeUndefined();
  });

  it("keeps terminal records per head and prunes the ones past retention", async () => {
    const s = store();
    await s.recordTerminal({ repo: "org/registry", number: 7, headSha: "old", outcome: "rejected", at: T0, by: "operator", reason: "no" });
    expect(await s.terminal("org/registry", 7, "old")).toMatchObject({ outcome: "rejected", reason: "no" });
    await s.recordTerminal({
      repo: "org/registry",
      number: 7,
      headSha: "new",
      outcome: "merged",
      at: later(TERMINAL_RETENTION_MS + 1000),
      by: "cto",
      mergeSha: "m"
    });
    expect(await s.terminal("org/registry", 7, "old")).toBeUndefined();
    expect((await s.listTerminals()).map(record => record.headSha)).toEqual(["new"]);
  });
});
