import { describe, expect, it } from "vitest";
import { concernsAgent, transcriptFor, CONTEXT_WINDOW, type ChannelEntry } from "./channel.js";

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

  it("caps context at the window and keeps upTo at the last relevant id", () => {
    const all: ChannelEntry[] = [];
    for (let id = 1; id <= CONTEXT_WINDOW + 10; id++) {
      all.push(entry({ id, agentId: "promoter" }));
    }
    const t = transcriptFor(all, "promoter", 0);
    expect(t.entries).toHaveLength(CONTEXT_WINDOW);
    expect(t.entries[0].id).toBe(11);
    expect(t.upTo).toBe(CONTEXT_WINDOW + 10);
    // New marks are not limited by the display window.
    expect(t.newOperatorIds).toHaveLength(CONTEXT_WINDOW + 10);
  });

  it("leaves the cursor unchanged when nothing concerns the agent", () => {
    const t = transcriptFor([entry({ id: 8, agentId: "other" })], "promoter", 5);
    expect(t.entries).toEqual([]);
    expect(t.newOperatorIds).toEqual([]);
    expect(t.upTo).toBe(5);
  });
});
