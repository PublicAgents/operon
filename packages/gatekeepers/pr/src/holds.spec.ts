import { describe, expect, it } from "vitest";
import { CLAIM_AGE_MS, HoldStore, INTENT_STALE_MS, UNKNOWN_GRACE_MS, memoryStorage, TERMINAL_RETENTION_MS } from "./holds.js";

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
    // The claim minted id-2 as its token; the next hold is id-3.
    const other = await s.hold({ ...merge, headSha: "head2" }, later(4000));
    expect(other.held.id).toBe("id-3");
    expect((await s.listHeld()).map(h => h.id)).toEqual(["id-1", "id-3"]);
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
    const begun = await s.beginMerge({ repo: "org/registry", number: 7, headSha: "head1", agentId: "cto", mode: "auto", at: T0 });
    expect(begun).toMatchObject({ created: true, intent: { id: "id-1", state: "pending" } });
    expect((await s.openMergeIntent("org/registry", 7))?.id).toBe("id-1");
    // The begin is atomic: a second begin for the same pull request gets
    // the open intent back instead of a twin.
    expect(await s.beginMerge({ repo: "org/registry", number: 7, headSha: "head1", agentId: "cto", mode: "auto", at: T0 })).toMatchObject({
      created: false,
      intent: { id: "id-1" }
    });
    expect((await s.listOpenMergeIntents()).map(i => i.id)).toEqual(["id-1"]);
    await s.resolveMerge("id-1", { state: "unknown", detail: "timeout" }, later(1000));
    expect(await s.openMergeIntent("org/registry", 7)).toMatchObject({ state: "unknown", detail: "timeout" });
    const merged = await s.resolveMerge("id-1", { state: "merged", mergeSha: "m1" }, later(2000));
    expect(merged).toMatchObject({ state: "merged", mergeSha: "m1", resolvedAt: later(2000) });
    expect(await s.openMergeIntent("org/registry", 7)).toBeUndefined();
    expect(await s.resolveMerge("ghost", { state: "failed" }, T0)).toBeUndefined();
  });

  it("begins an intent for a hold only with the claim it carries", async () => {
    const s = store();
    const { held } = await s.hold(merge, T0);
    const base = { repo: "org/registry", number: 7, headSha: "head1", agentId: "cto", mode: "operator" as const, heldId: held.id, at: T0 };
    expect(await s.beginMerge(base)).toEqual({ created: false, reason: "hold_gone" });
    const claimed = await s.claimHeld(held.id, T0);
    expect(claimed?.claimToken).toBeDefined();
    expect(await s.beginMerge({ ...base, claimToken: "wrong" })).toEqual({ created: false, reason: "hold_gone" });
    // With the approval's intent already begun, the rejection yields in the same turn.
    const begun = await s.beginMerge({ ...base, claimToken: claimed?.claimToken });
    expect(begun.created).toBe(true);
    const record = { repo: "org/registry", number: 7, headSha: "head1", outcome: "rejected" as const, at: T0, by: "operator", heldId: held.id };
    expect((await s.rejectAndRecord(claimed!, record, T0)).status).toBe("approval_in_flight");
    // Once that intent is over, the rejection lands and a later begin finds the hold gone.
    if (begun.created) await s.resolveMerge(begun.intent.id, { state: "failed", detail: "no" }, T0);
    expect((await s.rejectAndRecord(claimed!, record, T0)).status).toBe("rejected");
    expect(await s.beginMerge({ ...base, claimToken: claimed?.claimToken })).toEqual({ created: false, reason: "hold_gone" });
    expect(await s.getHeld(held.id)).toBeUndefined();
    expect(await s.terminal("org/registry", 7, "head1")).toMatchObject({ outcome: "rejected" });
  });

  it("settles an intent, its terminal record and its hold in one turn", async () => {
    const s = store();
    const { held } = await s.hold(merge, T0);
    const claimed = await s.claimHeld(held.id, T0);
    const begun = await s.beginMerge({ repo: "org/registry", number: 7, headSha: "head1", agentId: "cto", mode: "operator", heldId: held.id, claimToken: claimed?.claimToken, at: T0 });
    if (!begun.created) throw new Error("expected an intent");
    const { intent } = begun;
    const settled = await s.settleMerge(intent.id, { state: "merged", mergeSha: "m1" }, later(1000), {
      terminal: { repo: "org/registry", number: 7, headSha: "head1", outcome: "merged", at: later(1000), by: "cto", heldId: held.id, mergeSha: "m1" },
      hold: "delete"
    });
    expect(settled).toMatchObject({ state: "merged", mergeSha: "m1" });
    // Single winner: a second settle of the same intent gets nothing.
    expect(await s.settleMerge(intent.id, { state: "failed", detail: "late" }, later(1500))).toBeUndefined();
    expect(await s.terminal("org/registry", 7, "head1")).toMatchObject({ outcome: "merged", heldId: held.id });
    // A rejection can no longer land on that head.
    const late = await s.hold({ ...merge, headSha: "head1" }, later(1600));
    expect((await s.rejectAndRecord(late.held, { repo: "org/registry", number: 7, headSha: "head1", outcome: "rejected", at: later(1700), by: "operator" }, later(1700))).status).toBe("already_merged");
    expect(await s.getHeld(late.held.id)).toBeUndefined();
    expect(await s.getHeld(held.id)).toBeUndefined();
    expect(await s.listOpenMergeIntents()).toEqual([]);
    // A failed attempt gives a claimed hold back instead of deleting it.
    const second = await s.hold({ ...merge, headSha: "head2" }, later(2000));
    const secondClaim = await s.claimHeld(second.held.id, later(2000));
    const again = await s.beginMerge({ repo: "org/registry", number: 7, headSha: "head2", agentId: "cto", mode: "operator", heldId: second.held.id, claimToken: secondClaim?.claimToken, at: later(2000) });
    if (!again.created) throw new Error("expected an intent");
    await s.settleMerge(again.intent.id, { state: "failed", detail: "no" }, later(3000), { hold: "unclaim" });
    expect(await s.getHeld(second.held.id)).toMatchObject({ claimed: false });
    expect(await s.settleMerge("ghost", { state: "failed" }, T0)).toBeUndefined();
  });

  it("records close steps so a retry resumes where the last call stopped, and refuses a twin while one works", async () => {
    const s = store();
    const begun = await s.beginClose({ repo: "org/registry", number: 8, agentId: "cto", reason: "spam", at: T0 });
    expect(begun).toMatchObject({ status: "created", intent: { steps: {}, workingSince: T0 } });
    const { intent } = begun;
    // A second door arriving while the first works gets busy; after the
    // first releases (a lost response) the second resumes.
    expect((await s.beginClose({ repo: "org/registry", number: 8, agentId: "cto", reason: "spam", at: later(1000) })).status).toBe("busy");
    expect(await s.closeStep(intent.id, "commented", intent.workToken)).toBe(true);
    await s.releaseClose(intent.id, intent.workToken);
    const resumed = await s.beginClose({ repo: "org/registry", number: 8, agentId: "cto", reason: "spam", at: later(2000) });
    expect(resumed).toMatchObject({ status: "resumed", intent: { id: intent.id, steps: { commented: true } } });
    // The resume minted a new token: the first executor's steps and resolve refuse from here on.
    expect(resumed.intent.workToken).not.toBe(intent.workToken);
    expect(await s.closeStep(intent.id, "closed", intent.workToken)).toBe(false);
    expect(await s.resolveClose(intent.id, "closed", later(2500), undefined, intent.workToken)).toBe(false);
    // A door that crashed while working ages out of the way, past the
    // stale bound plus the grace (its last request is over by then).
    expect((await s.beginClose({ repo: "org/registry", number: 8, agentId: "cto", reason: "spam", at: later(INTENT_STALE_MS + 3000) })).status).toBe("busy");
    const again = await s.beginClose({ repo: "org/registry", number: 8, agentId: "cto", reason: "spam", at: later(INTENT_STALE_MS + UNKNOWN_GRACE_MS + 3000) });
    expect(again.status).toBe("resumed");
    expect(await s.closeStep(intent.id, "closed", again.intent.workToken)).toBe(true);
    expect(await s.resolveClose(intent.id, "closed", later(INTENT_STALE_MS + 4000), undefined, again.intent.workToken)).toBe(true);
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
