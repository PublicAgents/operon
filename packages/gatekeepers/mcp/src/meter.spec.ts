import { describe, expect, it } from "vitest";
import { MeterStore, RESERVATION_STALE_MS, type KeyValueStorage } from "./meter.js";

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

const MONTHLY = 30; // a 30-day month at $1 a day
const DAY1 = "2026-09-01T10:00:00.000Z";
const at = (day: number, hour = 10) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const reserve = (store: MeterStore, id: string, usd: number, when: string, tool = "web_search") =>
  store.reserve({ id, tool, agentId: "scout", usd, monthlyUsd: MONTHLY }, when);

describe("the meter (spec 0014 §2)", () => {
  it("spreads the month over its remaining days and fixes the allotment at the day's first call", async () => {
    const store = new MeterStore(memory());
    const first = await store.remaining(MONTHLY, DAY1);
    expect(first.remaining.allotmentTodayUsd).toBe(1);
    // Today's own calls never shrink today's share.
    expect((await reserve(store, "a", 0.4, DAY1)).ok).toBe(true);
    expect((await store.remaining(MONTHLY, at(1, 12))).remaining.allotmentTodayUsd).toBe(1);
    expect((await store.remaining(MONTHLY, at(1, 12))).remaining.remainingTodayUsd).toBe(0.6);
  });

  it("refuses the call that would cross today's allotment, by name, and names the reset", async () => {
    const store = new MeterStore(memory());
    expect((await reserve(store, "a", 0.7, DAY1)).ok).toBe(true);
    const over = await reserve(store, "b", 0.4, DAY1);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.code).toBe("mcp_budget_exhausted");
      expect(over.detail).toContain("2026-09-02T00:00:00.000Z");
      expect(over.remaining.remainingTodayUsd).toBe(0.3);
    }
    // The exact remainder still fits.
    expect((await reserve(store, "c", 0.3, DAY1)).ok).toBe(true);
  });

  it("lets an unspent day flow forward and never lets a day borrow from tomorrow", async () => {
    const store = new MeterStore(memory());
    await store.remaining(MONTHLY, DAY1); // day 1: nothing spent
    const day2 = await store.remaining(MONTHLY, at(2));
    // $30 left over 29 days.
    expect(day2.remaining.allotmentTodayUsd).toBeCloseTo(30 / 29, 6);
    expect((await reserve(store, "a", 30 / 29, at(2))).ok).toBe(true);
    expect((await reserve(store, "b", 0.01, at(2))).ok).toBe(false);
  });

  it("lands a month of daily spending to the allotment exactly on the cap", async () => {
    const store = new MeterStore(memory());
    let spent = 0;
    for (let day = 1; day <= 30; day++) {
      const { remaining } = await store.remaining(MONTHLY, at(day));
      const outcome = await reserve(store, `d${day}`, remaining.allotmentTodayUsd, at(day));
      expect(outcome.ok).toBe(true);
      await store.settle(`d${day}`);
      spent += remaining.allotmentTodayUsd;
    }
    expect(spent).toBeCloseTo(MONTHLY, 4);
    expect((await reserve(store, "x", 0.01, at(30, 23))).ok).toBe(false);
    // A new month starts over.
    expect((await store.remaining(MONTHLY, "2026-10-01T00:00:01.000Z")).remaining.allotmentTodayUsd).toBeCloseTo(30 / 31, 6);
  });

  it("refunds only what it is told to, and settles a stale reservation as spent once", async () => {
    const store = new MeterStore(memory());
    expect((await reserve(store, "a", 0.5, DAY1)).ok).toBe(true);
    expect(await store.refund("a")).toBe(true);
    expect((await store.remaining(MONTHLY, DAY1)).remaining.spentTodayUsd).toBe(0);
    expect(await store.refund("a")).toBe(false);
    expect((await reserve(store, "b", 0.5, DAY1)).ok).toBe(true);
    const later = new Date(Date.parse(DAY1) + RESERVATION_STALE_MS + 1000).toISOString();
    const rolled = await store.remaining(MONTHLY, later);
    expect(rolled.staleSettled.map(r => r.id)).toEqual(["b"]);
    expect(rolled.remaining.spentTodayUsd).toBe(0.5);
    // Settled once: a later refund finds nothing, the spend stays.
    expect(await store.refund("b")).toBe(false);
    expect((await store.remaining(MONTHLY, later)).remaining.spentTodayUsd).toBe(0.5);
  });

  it("resets to the operator's figure from the vendor's dashboard", async () => {
    const store = new MeterStore(memory());
    await reserve(store, "a", 1, DAY1);
    const after = await store.reset(12, MONTHLY, at(16));
    expect(after.spentMonthUsd).toBe(12);
    expect(after.allotmentTodayUsd).toBeCloseTo(18 / 15, 6);
  });
});
