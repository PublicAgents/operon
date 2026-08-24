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

  it("parses github pr with default and explicit dir", () => {
    expect(parseArgs(["github", "pr", "org/repo", "--title", "t", "--body", "b"])).toEqual({
      path: "/github/pr",
      payload: { repo: "org/repo", dir: "pr", title: "t", body: "b" }
    });
    expect(
      parseArgs(["github", "pr", "org/repo", "proposals/x", "--title", "t", "--body", "b"])
    ).toEqual({
      path: "/github/pr",
      payload: { repo: "org/repo", dir: "proposals/x", title: "t", body: "b" }
    });
  });

  it("parses the github conversation subcommands", () => {
    expect(parseArgs(["github", "status"])).toEqual({ path: "/github/status", payload: {} });
    expect(parseArgs(["github", "thread", "org/repo", "59"])).toEqual({
      path: "/github/thread",
      payload: { repo: "org/repo", number: 59 }
    });
    expect(
      parseArgs(["github", "comment", "org/repo", "59", "--body", "hi", "--reply-to", "4"])
    ).toEqual({
      path: "/github/comment",
      payload: { repo: "org/repo", number: 59, body: "hi", replyTo: 4 }
    });
    expect(
      parseArgs(["github", "push", "org/repo", "59", "--message", "fix review nits"])
    ).toEqual({
      path: "/github/push",
      payload: { repo: "org/repo", number: 59, dir: "pr", message: "fix review nits" }
    });
    expect(parseArgs(["github", "update", "org/repo", "59", "--state", "closed"])).toEqual({
      path: "/github/update",
      payload: { repo: "org/repo", number: 59, state: "closed" }
    });
    expect(parseArgs(["github", "issue", "org/repo", "notes/i.md", "--title", "t"])).toEqual({
      path: "/github/issue",
      payload: { repo: "org/repo", bodyFile: "notes/i.md", title: "t" }
    });
  });

  it("rejects missing requireds with usage errors", () => {
    expect(() => parseArgs(["notify"])).toThrowError(CliUsageError);
    expect(() => parseArgs(["publish"])).toThrowError(/--host/);
    expect(() => parseArgs(["github", "pr", "norepo", "--title", "t", "--body", "b"])).toThrowError(
      CliUsageError
    );
    expect(() => parseArgs(["github", "pr", "org/repo", "--title", "t"])).toThrowError(/--body/);
    expect(() => parseArgs(["github", "thread", "org/repo", "zero"])).toThrowError(/number/);
    expect(() => parseArgs(["github", "comment", "org/repo", "59"])).toThrowError(/--body/);
    expect(() => parseArgs(["github", "update", "org/repo", "59"])).toThrowError(CliUsageError);
    expect(() => parseArgs(["github", "update", "org/repo", "59", "--state", "x"])).toThrowError(
      /open or closed/
    );
    expect(() => parseArgs(["github", "dance"])).toThrowError(/github subcommand/);
    expect(() => parseArgs(["dance"])).toThrowError(/unknown command/);
  });
});
