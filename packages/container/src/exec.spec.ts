import { describe, expect, it } from "vitest";
import { CommandError, headAndTail } from "./exec.js";

describe("a failed command's words", () => {
  it("keeps the head and the tail of a long output: the error line comes last", () => {
    const banner = "OpenAI Codex v0.153.0\n" + "warning: something long and repeated\n".repeat(40);
    const text = banner + "ERROR: stream error: unexpected status 401 Unauthorized";
    const shown = headAndTail(text);
    expect(shown).toContain("OpenAI Codex v0.153.0");
    expect(shown).toContain("chars elided");
    expect(shown).toContain("unexpected status 401 Unauthorized");
    expect(headAndTail("short")).toBe("short");
    const error = new CommandError("codex", 1, text);
    expect(error.message).toContain("unexpected status 401 Unauthorized");
    expect(error.message).toMatch(/^command_failed: codex exited 1: /);
  });
});
