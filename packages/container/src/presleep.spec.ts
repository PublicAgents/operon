import { describe, expect, it } from "vitest";
import { maskSecret, verifyPresleep } from "./presleep.js";

describe("verifyPresleep", () => {
  it("passes a wake that journaled and leaked nothing", () => {
    const result = verifyPresleep(
      [
        { path: "JOURNAL.md", content: "## Wake 1\ndid things" },
        { path: "notes.md", content: "plans" }
      ],
      ["super-secret-token"]
    );
    expect(result).toEqual({ ok: true, failures: [], blockPush: false });
  });

  it("fails when the journal was not touched, without blocking the push", () => {
    const result = verifyPresleep([{ path: "notes.md", content: "x" }], []);
    expect(result.ok).toBe(false);
    expect(result.blockPush).toBe(false);
    expect(result.failures[0].code).toBe("journal_untouched");
  });

  it("blocks the push when a denylisted literal appears in a changed file", () => {
    const result = verifyPresleep(
      [{ path: "JOURNAL.md", content: "today I used super-secret-token to..." }],
      ["super-secret-token"]
    );
    expect(result.ok).toBe(false);
    expect(result.blockPush).toBe(true);
    expect(result.failures[0].code).toBe("secret_found");
  });

  it("never re-prints the secret it found", () => {
    const result = verifyPresleep(
      [{ path: "JOURNAL.md", content: "super-secret-token" }],
      ["super-secret-token"]
    );
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });

  it("ignores empty denylist entries", () => {
    const result = verifyPresleep([{ path: "JOURNAL.md", content: "anything" }], [""]);
    expect(result.ok).toBe(true);
  });

  it("blocks the push when a changed file could not be scanned", () => {
    const result = verifyPresleep(
      [
        { path: "JOURNAL.md", content: "## Wake 1" },
        { path: "big.bin", content: null }
      ],
      []
    );
    expect(result.ok).toBe(false);
    expect(result.blockPush).toBe(true);
    expect(result.failures.map(f => f.code)).toContain("unscannable");
  });

  it("counts a staged deletion (empty content) for the journal check without blocking", () => {
    const result = verifyPresleep(
      [
        { path: "JOURNAL.md", content: "## Wake 1" },
        { path: "old.md", content: "" }
      ],
      ["secret"]
    );
    expect(result).toEqual({ ok: true, failures: [], blockPush: false });
  });
});

describe("maskSecret", () => {
  it("masks short and long literals", () => {
    expect(maskSecret("abc")).toBe("****");
    expect(maskSecret("super-secret-token")).toBe("sup…(18 chars)");
  });
});
