import { describe, expect, it } from "vitest";
import { journalGuardDecision } from "./journal-guard.js";

const START = "# Journal\n\n## Wake 22\nDid things.\n";

describe("journalGuardDecision", () => {
  it("blocks the first stop while the journal is byte-identical, with the reason", () => {
    const decision = journalGuardDecision(START, START, false);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("JOURNAL.md");
    expect(decision.reason).toContain("did not happen");
  });

  it("yields when an entry was appended (newest first or at the end)", () => {
    const prepended = "# Journal\n\n## Wake 23\nNew entry.\n" + START;
    expect(journalGuardDecision(START, "## Wake 23\nNew entry.\n\n" + START, false).block).toBe(false);
    expect(journalGuardDecision(START, prepended, false).block).toBe(false);
    expect(journalGuardDecision(START, START + "\n## Wake 23\nNew entry.\n", false).block).toBe(false);
  });

  it("blocks a rewrite or truncation that discards the wake-start content", () => {
    const rewritten = journalGuardDecision(START, "# Journal\n\ntotally reformatted\n", false);
    expect(rewritten.block).toBe(true);
    expect(rewritten.reason).toContain("append-only");
    expect(journalGuardDecision(START, "", false).block).toBe(true);
    const sameLength = journalGuardDecision(START, START.replace("things", "thangs"), false);
    expect(sameLength.block).toBe(true);
  });

  it("yields on the second stop attempt (loop safety)", () => {
    expect(journalGuardDecision(START, START, true).block).toBe(false);
    expect(journalGuardDecision(START, "rewritten", true).block).toBe(false);
  });

  it("never blocks on missing information (baseline or journal unreadable)", () => {
    expect(journalGuardDecision(null, START, false).block).toBe(false);
    expect(journalGuardDecision(START, null, false).block).toBe(false);
  });

  it("an empty wake-start journal accepts any appended content", () => {
    expect(journalGuardDecision("", "## Wake 1\nFirst entry.\n", false).block).toBe(false);
    expect(journalGuardDecision("", "", false).block).toBe(true);
  });
});
