import { describe, expect, it } from "vitest";
import {
  AskInputError,
  LIMITS,
  parseKind,
  parseLinks,
  parseState,
  requireText,
  transitionRefusal,
  unreadForAgent,
  type Ask
} from "./policy.js";

function ask(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "a1",
    agentId: "promoter",
    wakeId: "w1",
    title: "t",
    body: "b",
    kind: "question",
    links: [],
    state: "open",
    createdAt: "2026-08-31T06:00:00.000Z",
    updatedAt: "2026-08-31T06:00:00.000Z",
    thread: [],
    ...overrides
  };
}

describe("requireText", () => {
  it("trims, requires content, and enforces the cap", () => {
    expect(requireText("  hello  ", "title", 10)).toBe("hello");
    expect(() => requireText("   ", "title", 10)).toThrow(AskInputError);
    expect(() => requireText("x".repeat(11), "title", 10)).toThrow(/exceeds 10/);
  });

  it("refuses control characters but keeps tabs and newlines", () => {
    expect(requireText("line one\nline two\tindented", "body", 100)).toContain("\n");
    expect(() => requireText("bellhere", "body", 100)).toThrow(/control characters/);
    // The ANSI escape an injected transcript would use to rewrite the screen.
    expect(() => requireText("[2Jcleared", "body", 100)).toThrow(/control characters/);
  });
});

describe("parseKind and parseLinks", () => {
  it("defaults kind to question and refuses unknown kinds", () => {
    expect(parseKind(undefined)).toBe("question");
    expect(parseKind("decision")).toBe("decision");
    expect(() => parseKind("urgent")).toThrow(AskInputError);
  });

  it("requires https links and caps their number", () => {
    expect(parseLinks("https://example.com/x")).toEqual(["https://example.com/x"]);
    expect(parseLinks(undefined)).toEqual([]);
    expect(() => parseLinks("http://example.com")).toThrow(/https/);
    expect(() => parseLinks(new Array(LIMITS.links + 1).fill("https://e.com"))).toThrow(/at most/);
  });

  it("parses states and refuses invented ones", () => {
    expect(parseState("allowed", "decision")).toBe("allowed");
    expect(() => parseState("maybe", "decision")).toThrow(AskInputError);
  });
});

describe("transitionRefusal", () => {
  it("allows a move from the state the caller expected", () => {
    expect(transitionRefusal("open", "open", "allowed")).toBeNull();
    expect(transitionRefusal("acknowledged", "acknowledged", "closed")).toBeNull();
  });

  it("refuses when the ask moved under the caller", () => {
    expect(transitionRefusal("allowed", "open", "declined")).toBe("state_moved");
  });

  it("refuses a no-op transition to the state it is already in", () => {
    expect(transitionRefusal("allowed", "allowed", "allowed")).toBe("state_moved");
  });

  it("refuses any move out of a terminal state, even a matching expectation", () => {
    expect(transitionRefusal("closed", "closed", "open")).toBe("terminal");
    expect(transitionRefusal("retracted", "retracted", "allowed")).toBe("terminal");
  });
});

describe("unreadForAgent", () => {
  const operatorEntry = { seq: 1, at: "2026-08-31T07:00:00.000Z", author: "operator" as const, kind: "message" as const, text: "hi" };
  const agentEntry = { seq: 2, at: "2026-08-31T07:05:00.000Z", author: "agent" as const, kind: "message" as const, text: "ok" };

  it("counts operator entries the agent has not seen, never its own", () => {
    expect(unreadForAgent(ask({ thread: [operatorEntry, agentEntry] }))).toEqual([operatorEntry]);
  });

  it("stops counting once seen, and counts what arrived after", () => {
    const seen = ask({ thread: [operatorEntry], agentSeenSeq: 1 });
    expect(unreadForAgent(seen)).toEqual([]);
    const later = { ...operatorEntry, seq: 2, at: "2026-08-31T07:02:00.000Z", text: "and this" };
    expect(unreadForAgent({ ...seen, thread: [operatorEntry, later] })).toEqual([later]);
  });

  it("delivers a reply that shares a millisecond with the acked one", () => {
    // The bug a timestamp cursor has: same instant, later entry, gone
    // forever. The sequence cursor cannot express that.
    const sameMs = { ...operatorEntry, seq: 2, text: "and one more" };
    const seen = ask({ thread: [operatorEntry, sameMs], agentSeenSeq: 1 });
    expect(unreadForAgent(seen)).toEqual([sameMs]);
  });
});
