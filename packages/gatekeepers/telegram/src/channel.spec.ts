import { describe, expect, it } from "vitest";
import { concernsAgent, effectiveCursors, prunableIds, transcriptFor, CONTEXT_WINDOW, HARD_RETENTION, RETENTION, type ChannelEntry } from "./channel.js";

function entry(partial: Partial<ChannelEntry> & { id: number }): ChannelEntry {
  return {
    at: `2026-08-25T10:00:${String(partial.id).padStart(2, "0")}Z`,
    from: "operator",
    agentId: "*",
    text: `m${partial.id}`,
    ...partial
  };
}

describe("concernsAgent", () => {
  it("routes broadcasts and targeted messages, and the agent's own notifies", () => {
    expect(concernsAgent(entry({ id: 1, agentId: "*" }), "promoter")).toBe(true);
    expect(concernsAgent(entry({ id: 2, agentId: "promoter" }), "promoter")).toBe(true);
    expect(concernsAgent(entry({ id: 3, agentId: "other" }), "promoter")).toBe(false);
    expect(concernsAgent(entry({ id: 4, from: "agent", agentId: "promoter" }), "promoter")).toBe(true);
    expect(concernsAgent(entry({ id: 5, from: "agent", agentId: "other" }), "promoter")).toBe(false);
  });
});

describe("transcriptFor", () => {
  it("returns the conversation with new-marks past the cursor, both directions", () => {
    const all: ChannelEntry[] = [
      entry({ id: 1, from: "agent", agentId: "promoter", text: "shipped the site" }),
      entry({ id: 2, agentId: "*", text: "nice work everyone" }),
      entry({ id: 3, agentId: "other", text: "not for promoter" }),
      entry({ id: 4, agentId: "promoter", text: "focus on the registry" })
    ];
    const t = transcriptFor(all, "promoter", 2);
    expect(t.entries.map(e => e.id)).toEqual([1, 2, 4]);
    // Only operator entries past the cursor are new; the agent's own notify
    // and the already-acked broadcast are context.
    expect(t.newOperatorIds).toEqual([4]);
    expect(t.upTo).toBe(4);
  });

  it("never acks an operator message the wake did not receive", () => {
    // More new operator messages than the context window: every one of
    // them is still delivered; the window only trims old context.
    const all: ChannelEntry[] = [];
    for (let id = 1; id <= CONTEXT_WINDOW + 10; id++) {
      all.push(entry({ id, agentId: "promoter" }));
    }
    const t = transcriptFor(all, "promoter", 0);
    expect(t.entries).toHaveLength(CONTEXT_WINDOW + 10);
    expect(t.entries[0].id).toBe(1);
    expect(t.upTo).toBe(CONTEXT_WINDOW + 10);
    expect(t.newOperatorIds).toHaveLength(CONTEXT_WINDOW + 10);
  });

  it("caps already-acked context at the window", () => {
    const all: ChannelEntry[] = [];
    for (let id = 1; id <= CONTEXT_WINDOW + 10; id++) {
      all.push(entry({ id, agentId: "promoter" }));
    }
    // Everything acked: pure context, so the window applies.
    const t = transcriptFor(all, "promoter", CONTEXT_WINDOW + 10);
    expect(t.entries).toHaveLength(CONTEXT_WINDOW);
    expect(t.entries[0].id).toBe(11);
    expect(t.newOperatorIds).toEqual([]);
    expect(t.upTo).toBe(CONTEXT_WINDOW + 10);
  });

  it("leaves the cursor unchanged when nothing concerns the agent", () => {
    const t = transcriptFor([entry({ id: 8, agentId: "other" })], "promoter", 5);
    expect(t.entries).toEqual([]);
    expect(t.newOperatorIds).toEqual([]);
    expect(t.upTo).toBe(5);
  });
});

describe("prunableIds", () => {
  function makeEntries(count: number): ChannelEntry[] {
    return Array.from({ length: count }, (_, i) => entry({ id: i + 1 }));
  }

  it("prunes nothing below retention", () => {
    expect(prunableIds(makeEntries(RETENTION), [RETENTION])).toEqual({
      ids: [],
      droppedUnacked: 0
    });
  });

  it("prunes only entries acked by every known cursor", () => {
    const entries = makeEntries(RETENTION + 20);
    // Slowest agent has acked through 10: only 1..10 are safely prunable
    // even though 20 entries are beyond retention.
    const result = prunableIds(entries, [10, 300]);
    expect(result.ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.droppedUnacked).toBe(0);
  });

  it("prunes nothing while no agent has ever acked", () => {
    expect(prunableIds(makeEntries(RETENTION + 50), [])).toEqual({
      ids: [],
      droppedUnacked: 0
    });
  });

  it("drops unacked overflow only at the hard bound, and reports it", () => {
    const entries = makeEntries(HARD_RETENTION + 5);
    const result = prunableIds(entries, []);
    expect(result.droppedUnacked).toBe(5);
    expect(result.ids).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("effectiveCursors", () => {
  it("counts a roster agent with no ack yet as cursor 0", () => {
    const cursors = effectiveCursors(new Map([["promoter", 50]]), ["promoter", "newbie"]);
    expect(cursors.sort()).toEqual([0, 50]);
  });

  it("drops stored cursors for agents no longer in the roster", () => {
    expect(effectiveCursors(new Map([["gone", 99]]), ["promoter"])).toEqual([0]);
  });

  it("fails safe to [0] when the roster is unknown or empty", () => {
    expect(effectiveCursors(new Map([["promoter", 50]]), undefined)).toEqual([0]);
    expect(effectiveCursors(new Map(), [])).toEqual([0]);
  });

  it("a never-acked roster agent blocks normal pruning entirely", () => {
    const entries = Array.from({ length: RETENTION + 20 }, (_, i) => entry({ id: i + 1 }));
    const cursors = effectiveCursors(new Map([["promoter", RETENTION + 20]]), ["promoter", "newbie"]);
    expect(prunableIds(entries, cursors)).toEqual({ ids: [], droppedUnacked: 0 });
  });
});
