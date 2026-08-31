import { describe, expect, it } from "vitest";
import { newAsks } from "./asks-delivery.js";

describe("newAsks", () => {
  it("announces one operator action once, however often it re-delivers", () => {
    const shown = new Map<string, number>();
    expect(newAsks([{ id: "a1", throughSeq: 3 }], shown)).toEqual(["a1"]);
    // The ack waits for persist, so the very same row comes back on
    // every pull of this wake. It is not news the second time.
    expect(newAsks([{ id: "a1", throughSeq: 3 }], shown)).toEqual([]);
    expect(newAsks([{ id: "a1", throughSeq: 3 }], shown)).toEqual([]);
  });

  it("announces the same ask again when the operator says something more", () => {
    const shown = new Map([["a1", 3]]);
    expect(newAsks([{ id: "a1", throughSeq: 5 }], shown)).toEqual(["a1"]);
    expect(newAsks([{ id: "a1", throughSeq: 5 }], shown)).toEqual([]);
  });

  it("names ids, so a buffered announcement stays one ask", () => {
    // Two operator actions on a1 while nobody was listening: the
    // pending notice is still about one ask, and only ids can say so.
    const shown = new Map<string, number>();
    const pending = new Set([...newAsks([{ id: "a1", throughSeq: 3 }], shown)]);
    for (const id of newAsks([{ id: "a1", throughSeq: 5 }], shown)) pending.add(id);
    expect([...pending]).toEqual(["a1"]);
  });

  it("seeds from the wake-start delivery, which is not news either", () => {
    const shown = new Map<string, number>();
    newAsks([{ id: "a1", throughSeq: 2 }], shown);
    expect(newAsks([{ id: "a1", throughSeq: 2 }, { id: "a2", throughSeq: 1 }], shown)).toEqual([
      "a2"
    ]);
  });

  it("never moves backwards on an out-of-order delivery", () => {
    const shown = new Map([["a1", 9]]);
    expect(newAsks([{ id: "a1", throughSeq: 4 }], shown)).toEqual([]);
    expect(shown.get("a1")).toBe(9);
  });
});
