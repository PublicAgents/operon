import { describe, expect, it } from "vitest";
import { countNewAsks } from "./asks-delivery.js";

describe("countNewAsks", () => {
  it("announces one operator action once, however often it re-delivers", () => {
    const shown = new Map<string, number>();
    expect(countNewAsks([{ id: "a1", throughSeq: 3 }], shown)).toBe(1);
    // The ack waits for persist, so the very same row comes back on
    // every pull of this wake. It is not news the second time.
    expect(countNewAsks([{ id: "a1", throughSeq: 3 }], shown)).toBe(0);
    expect(countNewAsks([{ id: "a1", throughSeq: 3 }], shown)).toBe(0);
  });

  it("announces the same ask again when the operator says something more", () => {
    const shown = new Map([["a1", 3]]);
    expect(countNewAsks([{ id: "a1", throughSeq: 5 }], shown)).toBe(1);
    expect(countNewAsks([{ id: "a1", throughSeq: 5 }], shown)).toBe(0);
  });

  it("seeds from the wake-start delivery, which is not news either", () => {
    const shown = new Map<string, number>();
    countNewAsks([{ id: "a1", throughSeq: 2 }], shown);
    expect(
      countNewAsks([{ id: "a1", throughSeq: 2 }, { id: "a2", throughSeq: 1 }], shown)
    ).toBe(1);
  });

  it("never counts backwards on an out-of-order delivery", () => {
    const shown = new Map([["a1", 9]]);
    expect(countNewAsks([{ id: "a1", throughSeq: 4 }], shown)).toBe(0);
    expect(shown.get("a1")).toBe(9);
  });
});
