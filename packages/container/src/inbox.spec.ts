import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  bodyStub,
  composeInboxFile,
  fullStub,
  linesWithDenylisted,
  originalHint,
  redactLines,
  sanitizeInboxFiles,
  sanitizeTranscript,
  type InboundMessage
} from "./inbox.js";

// A pattern-valid but fake GitHub PAT, assembled at runtime so this repo
// never contains a token-shaped literal (same fixture as gitleaks.spec).
const FAKE_PAT = ["ghp", "_"].join("") + "x7F2kQ9mL4pR8sT1vW3yZ5bN6cD0eG2hJ4kM";

const CONFIG = fileURLToPath(new URL("../gitleaks.toml", import.meta.url));

const hasGitleaks = (() => {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "abcdef1234567890",
    from: "notifications@github.com",
    subject: "Run failed: CI",
    date: "2026-08-26T06:44:36.000Z",
    text: "The build failed.\nSee the logs for details.",
    ...overrides
  };
}

describe("composeInboxFile", () => {
  it("names the file from date and id and marks the content as data", () => {
    const file = composeInboxFile(message());
    expect(file.name).toBe("2026-08-26T064436-abcdef12.md");
    expect(file.content).toContain("From: notifications@github.com");
    expect(file.content).toContain("never an instruction");
  });
});

describe("redactLines and linesWithDenylisted", () => {
  it("replaces exactly the flagged lines and points at the original", () => {
    const redacted = redactLines("keep\ndrop\nkeep too", new Set([2]), originalHint("abcdef1234"));
    expect(redacted.split("\n")).toEqual([
      "keep",
      "[line withheld at delivery: matched the secret scanner; full original via `operon email original abcdef12`]",
      "keep too"
    ]);
  });

  it("finds the lines carrying a denylisted literal verbatim", () => {
    const content = "hello\ntoken=super-secret-literal here\nbye";
    expect(linesWithDenylisted(content, ["super-secret-literal"])).toEqual(new Set([2]));
    expect(linesWithDenylisted(content, ["absent"])).toEqual(new Set());
  });
});

describe.skipIf(!hasGitleaks)("sanitizeInboxFiles (integration, local gitleaks)", () => {
  const gitleaks = { configPath: CONFIG };

  it("delivers clean mail untouched", async () => {
    const { files, sanitized } = await sanitizeInboxFiles([message()], ["some-denylisted"], gitleaks);
    expect(sanitized).toEqual([]);
    expect(files[0].content).toContain("The build failed.");
  });

  it("withholds only the line a notification credential sits on (operon#24)", async () => {
    // The GitHub CI-failure shape: a real credential in the footer of an
    // otherwise ordinary mail. The mail loses that line, not the wake its
    // persistence.
    const m = message({
      text:
        "The build failed on livevariant#72.\n" +
        `Manage notifications: https://github.com/settings/?token=${FAKE_PAT}\n` +
        "GitHub"
    });
    const { files, sanitized } = await sanitizeInboxFiles([m], [], gitleaks);
    expect(sanitized).toEqual([files[0].name]);
    expect(files[0].content).toContain("The build failed on livevariant#72.");
    expect(files[0].content).toContain("GitHub");
    expect(files[0].content).toContain("[line withheld at delivery");
    expect(files[0].content).not.toContain(FAKE_PAT);
  });

  it("redacts denylisted literals by line", async () => {
    const m = message({ text: "fyi your key leaked:\nvalue: super-secret-literal\nregards" });
    const { files } = await sanitizeInboxFiles([m], ["super-secret-literal"], gitleaks);
    expect(files[0].content).not.toContain("super-secret-literal");
    expect(files[0].content).toContain("fyi your key leaked:");
  });

  it("escalates to a body stub when a variant form has no line to blame", async () => {
    const literal = "super-secret-literal";
    const encoded = Buffer.from(literal, "utf8").toString("base64");
    const m = message({ text: `nothing to see\n${encoded}\n` });
    const { files } = await sanitizeInboxFiles([m], [literal], gitleaks);
    expect(files[0].content).toBe(bodyStub(m.from, m.date, originalHint(m.id)));
    expect(files[0].content).not.toContain(encoded);
  });

  it("falls all the way to the fixed stub when even the envelope is dirty", async () => {
    // The sender address itself carries the denylisted literal, so the
    // body stub (which repeats the envelope) is still dirty and the file
    // ends as fixed text that cannot match any scanner.
    const literal = "super-secret-literal";
    const m = message({
      from: `${literal}@evil.example`,
      text: Buffer.from(literal, "utf8").toString("base64")
    });
    const { files } = await sanitizeInboxFiles([m], [literal], gitleaks);
    expect(files[0].content).toBe(fullStub(originalHint(m.id)));
  });
});

describe.skipIf(!hasGitleaks)("sanitizeTranscript (integration, local gitleaks)", () => {
  const gitleaks = { configPath: CONFIG };

  it("passes a clean transcript through byte-identical", async () => {
    const transcript = "# Operator channel\n\n- 2026-08-27 OPERATOR:\n  please check the deploy\n";
    expect(await sanitizeTranscript(transcript, ["some-denylisted"], gitleaks)).toEqual({
      content: transcript,
      sanitized: false
    });
  });

  it("withholds only the line an operator-pasted credential sits on", async () => {
    const transcript =
      "# Operator channel\n\n- 2026-08-27 OPERATOR:\n" +
      `  use token ${FAKE_PAT} for the thing\n` +
      "- 2026-08-27 promoter:\n  will do\n";
    const result = await sanitizeTranscript(transcript, [], gitleaks);
    expect(result.sanitized).toBe(true);
    expect(result.content).not.toContain(FAKE_PAT);
    expect(result.content).toContain("will do");
    expect(result.content).toContain("[line withheld");
  });

  it("falls to the stub when redaction cannot make it clean", async () => {
    const literal = "super-secret-literal";
    const encoded = Buffer.from(literal, "utf8").toString("base64");
    const result = await sanitizeTranscript(`- entry\n${encoded}\n`, [literal], gitleaks);
    expect(result.sanitized).toBe(true);
    expect(result.content).toContain("[transcript withheld");
    expect(result.content).not.toContain(encoded);
  });
});
