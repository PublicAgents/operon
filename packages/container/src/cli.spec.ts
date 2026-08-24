import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "./cli.js";

describe("operon CLI parsing", () => {
  it("shows help with no command or --help", () => {
    expect(parseArgs([])).toBe("help");
    expect(parseArgs(["--help"])).toBe("help");
  });

  it("parses notify with multi-word text", () => {
    expect(parseArgs(["notify", "hello", "operator"])).toEqual({
      path: "/notify",
      payload: { text: "hello operator" }
    });
  });

  it("parses publish with default dir and explicit host", () => {
    expect(parseArgs(["publish", "--host", "@"])).toEqual({
      path: "/publish",
      payload: { dir: "site", host: "@" }
    });
    expect(parseArgs(["publish", "docs", "--host", "growth"])).toEqual({
      path: "/publish",
      payload: { dir: "docs", host: "growth" }
    });
  });

  it("parses pr with default and explicit dir", () => {
    expect(parseArgs(["pr", "org/repo", "--title", "t", "--body", "b"])).toEqual({
      path: "/pr",
      payload: { repo: "org/repo", dir: "pr", title: "t", body: "b" }
    });
    expect(
      parseArgs(["pr", "org/repo", "proposals/x", "--title", "t", "--body", "b"])
    ).toEqual({
      path: "/pr",
      payload: { repo: "org/repo", dir: "proposals/x", title: "t", body: "b" }
    });
  });

  it("rejects missing requireds with usage errors", () => {
    expect(() => parseArgs(["notify"])).toThrowError(CliUsageError);
    expect(() => parseArgs(["publish"])).toThrowError(/--host/);
    expect(() => parseArgs(["pr", "norepo", "--title", "t", "--body", "b"])).toThrowError(
      CliUsageError
    );
    expect(() => parseArgs(["pr", "org/repo", "--title", "t"])).toThrowError(/--body/);
    expect(() => parseArgs(["dance"])).toThrowError(/unknown command/);
  });
});
