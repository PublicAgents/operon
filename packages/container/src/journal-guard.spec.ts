import { describe, expect, it } from "vitest";
import { journalGuardDecision } from "./journal-guard.js";

const START = "# Journal\n\n## Wake 22\nDid things.\n";
const STAMP = "wake fc9dcf85";
const ENTRY = `## Wake 24 (${STAMP})\nNew entry.\n`;

describe("journalGuardDecision", () => {
  it("blocks the first stop while the journal is byte-identical, naming the stamp", () => {
    const decision = journalGuardDecision(START, START, STAMP, false);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("JOURNAL.md");
    expect(decision.reason).toContain("did not happen");
    expect(decision.reason).toContain(STAMP);
  });

  it("yields when a stamped entry was appended (newest first or at the end)", () => {
    expect(journalGuardDecision(START, ENTRY + START, STAMP, false).block).toBe(false);
    expect(journalGuardDecision(START, START + ENTRY, STAMP, false).block).toBe(false);
    expect(journalGuardDecision(START, "# Journal\n\n" + ENTRY + START, STAMP, false).block).toBe(false);
  });

  it("blocks a rewrite or truncation that discards the wake-start content", () => {
    const rewritten = journalGuardDecision(START, "# Journal\n\n" + ENTRY, STAMP, false);
    expect(rewritten.block).toBe(true);
    expect(rewritten.reason).toContain("append-only");
    expect(journalGuardDecision(START, "", STAMP, false).block).toBe(true);
    expect(journalGuardDecision(START, START.replace("things", "thangs"), STAMP, false).block).toBe(true);
  });

  it("blocks added bytes that carry no current-wake stamp", () => {
    const unstamped = journalGuardDecision(START, START + "\nstray note\n", STAMP, false);
    expect(unstamped.block).toBe(true);
    expect(unstamped.reason).toContain(STAMP);
    expect(unstamped.reason).toContain("stamp");
  });

  it("blocks a stamp mentioned only in body text, outside any heading", () => {
    const bodyOnly = journalGuardDecision(
      START,
      START + `\nnote to self: ${STAMP} still owes a journal entry\n`,
      STAMP,
      false
    );
    expect(bodyOnly.block).toBe(true);
    expect(bodyOnly.reason).toContain("HEADING");
    const deepHeading = journalGuardDecision(START, START + `\n### notes (${STAMP})\nBody.\n`, STAMP, false);
    expect(deepHeading.block).toBe(false);
  });

  it("skips the stamp requirement when no stamp was staged (fail open)", () => {
    expect(journalGuardDecision(START, START + "\nany appended entry\n", null, false).block).toBe(false);
  });

  it("yields on the second stop attempt (loop safety)", () => {
    expect(journalGuardDecision(START, START, STAMP, true).block).toBe(false);
    expect(journalGuardDecision(START, "rewritten", STAMP, true).block).toBe(false);
  });

  it("never blocks on missing information (baseline or journal unreadable)", () => {
    expect(journalGuardDecision(null, START, STAMP, false).block).toBe(false);
    expect(journalGuardDecision(START, null, STAMP, false).block).toBe(false);
  });

  it("an empty wake-start journal accepts a first stamped entry", () => {
    expect(journalGuardDecision("", ENTRY, STAMP, false).block).toBe(false);
    expect(journalGuardDecision("", "", STAMP, false).block).toBe(true);
  });
});
