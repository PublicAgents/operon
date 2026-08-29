import { describe, expect, it } from "vitest";
import { journalGuardDecision } from "./journal-guard.js";

const BASE = { mtimeMs: 1000, size: 500 };

describe("journalGuardDecision", () => {
  it("blocks the first stop while the journal is untouched, with the reason", () => {
    const decision = journalGuardDecision(BASE, { ...BASE }, false);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("JOURNAL.md");
    expect(decision.reason).toContain("did not happen");
  });

  it("yields once the journal changed (mtime or size)", () => {
    expect(journalGuardDecision(BASE, { mtimeMs: 2000, size: 500 }, false).block).toBe(false);
    expect(journalGuardDecision(BASE, { mtimeMs: 1000, size: 900 }, false).block).toBe(false);
  });

  it("yields on the second stop attempt (loop safety)", () => {
    expect(journalGuardDecision(BASE, { ...BASE }, true).block).toBe(false);
  });

  it("never blocks on missing information (baseline or journal unreadable)", () => {
    expect(journalGuardDecision(null, { ...BASE }, false).block).toBe(false);
    expect(journalGuardDecision(BASE, null, false).block).toBe(false);
  });
});
