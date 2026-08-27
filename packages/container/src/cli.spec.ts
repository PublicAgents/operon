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

  it("parses submodule bumps, with and without files", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(
      parseArgs(["github", "pr", "org/colony", "--title", "t", "--body", "b", "--submodule", `operon=${sha}`])
    ).toEqual({
      path: "/github/pr",
      payload: { repo: "org/colony", title: "t", body: "b", submodules: [{ path: "operon", sha }] }
    });
    expect(
      parseArgs(["github", "pr", "org/colony", "docs", "--title", "t", "--body", "b", "--submodule", `operon=${sha}`])
    ).toEqual({
      path: "/github/pr",
      payload: { repo: "org/colony", dir: "docs", title: "t", body: "b", submodules: [{ path: "operon", sha }] }
    });
    expect(() =>
      parseArgs(["github", "pr", "org/colony", "--title", "t", "--body", "b", "--submodule", "operon=short"])
    ).toThrowError(/40-hex/);
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

  it("parses the till doors", () => {
    expect(
      parseArgs([
        "till", "offer", "prior.livevariant.ai", "/reports/weekly.html",
        "--price", "0.05", "--currency", "0xtoken", "--description", "Weekly report"
      ])
    ).toEqual({
      path: "/till/offer",
      payload: {
        host: "prior.livevariant.ai",
        path: "/reports/weekly.html",
        price: "0.05",
        currency: "0xtoken",
        description: "Weekly report"
      }
    });
    expect(parseArgs(["till", "retire", "prior.livevariant.ai", "/reports/weekly.html"])).toEqual({
      path: "/till/retire",
      payload: { host: "prior.livevariant.ai", path: "/reports/weekly.html" }
    });
    expect(parseArgs(["till", "sales"])).toEqual({ path: "/till/sales", payload: {} });
    expect(() => parseArgs(["till", "offer", "h", "nopath", "--price", "1"])).toThrowError(
      CliUsageError
    );
    expect(() => parseArgs(["till", "dance"])).toThrowError(/till subcommand/);
  });

  it("parses email original by id prefix", () => {
    expect(parseArgs(["email", "original", "abcdef12"])).toEqual({
      path: "/email/original",
      payload: { id: "abcdef12" }
    });
    expect(() => parseArgs(["email", "original"])).toThrow(CliUsageError);
    expect(() => parseArgs(["email", "original", "short"])).toThrow(CliUsageError);
  });

  it("parses the vault doors, with and without an inline value", () => {
    expect(parseArgs(["vault", "set", "lv-stats", "--value", "s3cr3t-value"])).toEqual({
      path: "/vault/set",
      payload: { label: "lv-stats", value: "s3cr3t-value" }
    });
    // Without --value the payload omits it; main() reads stdin instead.
    expect(parseArgs(["vault", "set", "lv-stats"])).toEqual({
      path: "/vault/set",
      payload: { label: "lv-stats" }
    });
    expect(parseArgs(["vault", "get", "lv-stats"])).toEqual({
      path: "/vault/get",
      payload: { label: "lv-stats" }
    });
    expect(parseArgs(["vault", "list"])).toEqual({ path: "/vault/list", payload: {} });
    expect(parseArgs(["vault", "delete", "lv-stats"])).toEqual({
      path: "/vault/delete",
      payload: { label: "lv-stats" }
    });
    expect(() => parseArgs(["vault", "set"])).toThrow(CliUsageError);
    expect(() => parseArgs(["vault", "unknown"])).toThrow(CliUsageError);
  });

  it("parses channel original by entry id", () => {
    expect(parseArgs(["channel", "original", "123"])).toEqual({
      path: "/channel/original",
      payload: { id: 123 }
    });
    expect(() => parseArgs(["channel", "original"])).toThrow(CliUsageError);
    expect(() => parseArgs(["channel", "original", "zero"])).toThrow(CliUsageError);
    expect(() => parseArgs(["channel", "dance", "1"])).toThrow(CliUsageError);
  });

  it("parses the x doors, with and without inline text", () => {
    expect(parseArgs(["x", "post", "--text", "a valuable post"])).toEqual({
      path: "/x/post",
      payload: { text: "a valuable post" }
    });
    // Without --text the payload omits it; main() reads stdin instead.
    expect(parseArgs(["x", "post"])).toEqual({ path: "/x/post", payload: {} });
    expect(parseArgs(["x", "posts"])).toEqual({ path: "/x/posts", payload: {} });
    expect(parseArgs(["x", "dm", "@someone", "--text", "thanks for reaching out"])).toEqual({
      path: "/x/dm",
      payload: { to: "@someone", text: "thanks for reaching out" }
    });
    expect(parseArgs(["x", "dm", "@someone"])).toEqual({
      path: "/x/dm",
      payload: { to: "@someone" }
    });
    expect(() => parseArgs(["x", "dm"])).toThrow(CliUsageError);
    expect(() => parseArgs(["x", "dance"])).toThrow(CliUsageError);
  });

  it("parses x replies, profile, follow, and reads", () => {
    expect(parseArgs(["x", "post", "--text", "answer", "--reply-to", "123"])).toEqual({
      path: "/x/post",
      payload: { text: "answer", replyTo: "123" }
    });
    expect(() => parseArgs(["x", "post", "--reply-to", "abc"])).toThrow(CliUsageError);
    expect(parseArgs(["x", "profile", "--bio", "autonomous AI agent growing LiveVariant"])).toEqual({
      path: "/x/profile",
      payload: { bio: "autonomous AI agent growing LiveVariant" }
    });
    expect(() => parseArgs(["x", "profile"])).toThrow(CliUsageError);
    expect(parseArgs(["x", "avatar", "site/avatar.png"])).toEqual({
      path: "/x/avatar",
      payload: { file: "site/avatar.png" }
    });
    expect(parseArgs(["x", "follow", "@someone"])).toEqual({
      path: "/x/follow",
      payload: { handle: "@someone" }
    });
    expect(parseArgs(["x", "search", "adaptive", "a/b", "testing"])).toEqual({
      path: "/x/read",
      payload: {
        path: "/2/tweets/search/recent",
        params: { query: "adaptive a/b testing", max_results: "25", "tweet.fields": "created_at,author_id,public_metrics" }
      }
    });
    expect(parseArgs(["x", "mentions"]).path).toBe("/x/read");
    expect(parseArgs(["x", "read", "/2/users/by/username/someone", "--param", "user.fields=description"])).toEqual({
      path: "/x/read",
      payload: { path: "/2/users/by/username/someone", params: { "user.fields": "description" } }
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
