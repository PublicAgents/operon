import { describe, expect, it } from "vitest";
import {
  assertEnvClean,
  claudeCode,
  codex,
  getAdapter,
  UnknownHarnessError,
  EnvNotCleanError,
  AdapterNotImplementedError
} from "./index.js";

describe("getAdapter", () => {
  it("resolves known harnesses", () => {
    expect(getAdapter("claude-code")).toBe(claudeCode);
    expect(getAdapter("codex")).toBe(codex);
  });

  it("fails loudly on unknown harnesses", () => {
    expect(() => getAdapter("mystery")).toThrowError(UnknownHarnessError);
    expect(() => getAdapter("mystery")).toThrowError(/claude-code/);
  });
});

describe("claude-code adapter", () => {
  it("builds a pinned session with fallback and injects only its credential", () => {
    const spec = claudeCode.session("do the wake", "claude-sonnet-5", "tok", "claude-haiku-4-5");
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual([
      "-p",
      "do the wake",
      "--model",
      "claude-sonnet-5",
      "--fallback-model",
      "claude-haiku-4-5"
    ]);
    expect(spec.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  });

  it("omits the fallback flag when no fallback is pinned", () => {
    const spec = claudeCode.session("p", "claude-sonnet-5", "tok");
    expect(spec.args).not.toContain("--fallback-model");
  });

  it("probes with a model-identity question", () => {
    const spec = claudeCode.probe("claude-sonnet-5", "tok");
    expect(spec.args).toContain("--model");
    expect(spec.args.join(" ")).toMatch(/model id/);
  });

  it("refuses an environment that could silently switch auth", () => {
    expect(() =>
      assertEnvClean(claudeCode, { ANTHROPIC_API_KEY: "sk-x" })
    ).toThrowError(EnvNotCleanError);
    expect(() =>
      assertEnvClean(claudeCode, { ANTHROPIC_BASE_URL: "https://elsewhere" })
    ).toThrowError(/ANTHROPIC_BASE_URL/);
    expect(() => assertEnvClean(claudeCode, { UNRELATED: "1" })).not.toThrow();
  });
});

describe("codex adapter", () => {
  it("is an honest stub with a named error", () => {
    expect(() => codex.session("p", "m", "c")).toThrowError(AdapterNotImplementedError);
    expect(() => codex.probe("m", "c")).toThrowError(/adapter_not_implemented/);
  });
});
