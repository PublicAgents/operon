import { describe, expect, it } from "vitest";
import { journalDigest, journalGuardDecision } from "./journal-guard.js";

const START = journalDigest("# Journal\n\n## Wake 22\nDid things.\n");
const BASE = { sha256: START };

describe("journalGuardDecision", () => {
  it("blocks the first stop while the journal is byte-identical, with the reason", () => {
    const decision = journalGuardDecision(BASE, START, false);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("JOURNAL.md");
    expect(decision.reason).toContain("did not happen");
  });

  it("yields once the journal content changed", () => {
    const appended = journalDigest("# Journal\n\n## Wake 23\nNew entry.\n\n## Wake 22\nDid things.\n");
    expect(journalGuardDecision(BASE, appended, false).block).toBe(false);
  });

  it("catches a same-length rewrite and a metadata-only touch (content hash, not stat)", () => {
    const sameLength = journalDigest("# Journal\n\n## Wake 22\nDid thangs.\n");
    expect(sameLength).not.toBe(START);
    expect(journalGuardDecision(BASE, sameLength, false).block).toBe(false);
    expect(journalGuardDecision(BASE, START, false).block).toBe(true);
  });

  it("yields on the second stop attempt (loop safety)", () => {
    expect(journalGuardDecision(BASE, START, true).block).toBe(false);
  });

  it("never blocks on missing information (baseline or journal unreadable)", () => {
    expect(journalGuardDecision(null, START, false).block).toBe(false);
    expect(journalGuardDecision(BASE, null, false).block).toBe(false);
  });
});
