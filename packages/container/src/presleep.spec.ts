import { describe, expect, it } from "vitest";
import { excludeChassisWritten, linesNotIn, maskSecret, verifyPresleep } from "./presleep.js";

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

  it("catches a secret wrapped across lines", () => {
    const result = verifyPresleep(
      [{ path: "JOURNAL.md", content: "note: super-sec\nret-token was used" }],
      ["super-secret-token"]
    );
    expect(result.blockPush).toBe(true);
    expect(result.failures[0].detail).toMatch(/whitespace-split/);
  });

  it("catches base64, base64url, and hex encodings of a secret", () => {
    const literal = "super-secret-token";
    for (const encoded of [
      Buffer.from(literal).toString("base64"),
      Buffer.from(literal).toString("base64url"),
      Buffer.from(literal).toString("hex").toUpperCase()
    ]) {
      const result = verifyPresleep(
        [{ path: "JOURNAL.md", content: `data: ${encoded}` }],
        [literal]
      );
      expect(result.blockPush).toBe(true);
    }
  });

  it("catches a secret split across two files", () => {
    const result = verifyPresleep(
      [
        { path: "JOURNAL.md", content: "first half: super-secr" },
        { path: "notes.md", content: "et-token is the rest" }
      ],
      ["super-secret-token"]
    );
    expect(result.blockPush).toBe(true);
    expect(result.failures.some(f => f.detail.includes("split across files"))).toBe(true);
  });

  it("does not expand variants for short literals", () => {
    // 5 chars: raw match only; its base64 appearing is not flagged.
    const result = verifyPresleep(
      [{ path: "JOURNAL.md", content: Buffer.from("abcde").toString("base64") }],
      ["abcde"]
    );
    expect(result.ok).toBe(true);
  });

  it("still reports masked, never the secret, for variant matches", () => {
    const literal = "super-secret-token";
    const result = verifyPresleep(
      [{ path: "JOURNAL.md", content: Buffer.from(literal).toString("base64") }],
      [literal]
    );
    expect(JSON.stringify(result)).not.toContain(literal);
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

describe("linesNotIn", () => {
  it("keeps only lines absent from upstream, dropping unchanged content", () => {
    const upstream = "alpha\nbeta with tokens. 9 tools: price/funding/OI\ngamma";
    const submitted = "alpha\nbeta with tokens. 9 tools: price/funding/OI\n- [New Entry](x)\ngamma";
    expect(linesNotIn(submitted, upstream)).toBe("- [New Entry](x)");
  });

  it("treats a modified line as added", () => {
    expect(linesNotIn("a\nb-changed", "a\nb")).toBe("b-changed");
  });

  it("returns everything for a new file against empty upstream content", () => {
    expect(linesNotIn("x\ny", "")).toBe("x\ny");
  });
});

describe("excludeChassisWritten", () => {
  const written = new Map([["inbox/mail.md", "delivered content"]]);

  it("drops files still byte-identical to what the chassis wrote", () => {
    const changed = [
      { path: "inbox/mail.md", content: "delivered content" },
      { path: "JOURNAL.md", content: "## Wake 12" }
    ];
    expect(excludeChassisWritten(changed, written)).toEqual([
      { path: "JOURNAL.md", content: "## Wake 12" }
    ]);
  });

  it("keeps a chassis file the mind modified, and unscannable files", () => {
    const changed = [
      { path: "inbox/mail.md", content: "delivered content, annotated" },
      { path: "inbox/big.md", content: null }
    ];
    expect(excludeChassisWritten(changed, written)).toEqual(changed);
  });
});
