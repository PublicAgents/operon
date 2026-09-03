import { describe, expect, it } from "vitest";
import { claudeUsageFrom, codexUsageFrom, describeUsage, isUsageLine } from "./usage.js";

describe("claudeUsageFrom (spec 0011)", () => {
  it("reads the last result event's totals, cost, turns, duration and model", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1 } } }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 61_000,
        num_turns: 12,
        total_cost_usd: 1.2345,
        usage: { input_tokens: 4200, cache_creation_input_tokens: 800, cache_read_input_tokens: 120_000, output_tokens: 3100 },
        modelUsage: { "claude-fable-5": { inputTokens: 4200 } }
      })
    ];
    expect(claudeUsageFrom(lines)).toEqual({
      inputTokens: 4200,
      outputTokens: 3100,
      cacheReadTokens: 120_000,
      cacheWriteTokens: 800,
      costUsd: 1.2345,
      turns: 12,
      durationMs: 61_000,
      model: "claude-fable-5"
    });
  });

  it("is undefined without a result event and tolerates junk lines", () => {
    expect(claudeUsageFrom(["not json", '{"type":"assistant"}', "{broken"])).toBeUndefined();
    expect(claudeUsageFrom([JSON.stringify({ type: "result", subtype: "error" })])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    });
  });
});

describe("codexUsageFrom (spec 0011)", () => {
  it("sums every turn.completed and counts the turns", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 24_763, cached_input_tokens: 24_448, output_tokens: 122 } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "usage" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 30_000, cached_input_tokens: 29_000, output_tokens: 400 } })
    ];
    expect(codexUsageFrom(lines)).toEqual({
      inputTokens: 54_763,
      outputTokens: 522,
      cacheReadTokens: 53_448,
      cacheWriteTokens: 0,
      turns: 2
    });
    expect(codexUsageFrom([JSON.stringify({ type: "turn.started" })])).toBeUndefined();
  });
});

describe("isUsageLine and describeUsage", () => {
  it("keeps only JSON lines that mention usage", () => {
    expect(isUsageLine('{"type":"result","usage":{}}')).toBe(true);
    expect(isUsageLine("[operon] usage")).toBe(false);
    expect(isUsageLine('{"type":"assistant"}')).toBe(false);
  });

  it("phrases the numbers for the summary", () => {
    expect(describeUsage(undefined)).toBe("usage unknown");
    expect(
      describeUsage({ inputTokens: 412_301, outputTokens: 3800, cacheReadTokens: 1_200_000, cacheWriteTokens: 0, costUsd: 1.234, turns: 41 })
    ).toBe("412k in, 3800 out, 1200k cached, $1.23, 41 turns");
    expect(describeUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe("10 in, 2 out");
  });
});
