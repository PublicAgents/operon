import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "./cli.js";

describe("operon CLI parsing", () => {
  it("maps pull to the porch's mid-wake refresh", () => {
    expect(parseArgs(["pull"])).toEqual({ path: "/pull", payload: {} });
  });

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

  it("parses the adjudication verbs (spec 0012 §9)", () => {
    expect(parseArgs(["github", "review", "org/repo", "59", "--approve"])).toEqual({
      path: "/github/review",
      payload: { repo: "org/repo", number: 59, verdict: "approve" }
    });
    expect(parseArgs(["github", "review", "org/repo", "59", "--request-changes", "--body-file", "review.md"])).toEqual({
      path: "/github/review",
      payload: { repo: "org/repo", number: 59, verdict: "request_changes", bodyFile: "review.md" }
    });
    expect(parseArgs(["github", "review", "org/repo", "59", "--comment", "--body", "one thought"])).toEqual({
      path: "/github/review",
      payload: { repo: "org/repo", number: 59, verdict: "comment", body: "one thought" }
    });
    // Exactly one verdict flag, or the usage line.
    expect(() => parseArgs(["github", "review", "org/repo", "59"])).toThrow(/usage: operon github review/);
    expect(() => parseArgs(["github", "review", "org/repo", "59", "--approve", "--comment"])).toThrow(/usage/);
    // A request for changes or a comment says something; one body source only.
    expect(() => parseArgs(["github", "review", "org/repo", "59", "--request-changes"])).toThrow(/need a --body/);
    expect(() => parseArgs(["github", "review", "org/repo", "59", "--comment"])).toThrow(/need a --body/);
    expect(() => parseArgs(["github", "review", "org/repo", "59", "--comment", "--body", "a", "--body-file", "b.md"])).toThrow(/not both/);
    expect(parseArgs(["github", "merge", "org/repo", "59"])).toEqual({
      path: "/github/merge",
      payload: { repo: "org/repo", number: 59 }
    });
    expect(() => parseArgs(["github", "merge", "org/repo"])).toThrow(/usage: operon github merge/);
    expect(parseArgs(["github", "close", "org/repo", "59", "--reason", "spam"])).toEqual({
      path: "/github/close",
      payload: { repo: "org/repo", number: 59, reason: "spam" }
    });
    expect(() => parseArgs(["github", "close", "org/repo", "59"])).toThrow(/usage: operon github close/);
  });

  it("parses the till doors", () => {
    expect(
      parseArgs([
        "till", "offer", "prior.example-colony.com", "/reports/weekly.html",
        "--price", "0.05", "--currency", "0xtoken", "--description", "Weekly report"
      ])
    ).toEqual({
      path: "/till/offer",
      payload: {
        host: "prior.example-colony.com",
        path: "/reports/weekly.html",
        price: "0.05",
        currency: "0xtoken",
        description: "Weekly report"
      }
    });
    expect(parseArgs(["till", "retire", "prior.example-colony.com", "/reports/weekly.html"])).toEqual({
      path: "/till/retire",
      payload: { host: "prior.example-colony.com", path: "/reports/weekly.html" }
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

  it("email: --body - and an omitted --body defer the body to stdin", () => {
    const piped = parseArgs(["email", "--to", "a@b.com", "--subject", "s", "--body", "-"]);
    expect(piped.payload).toEqual({ to: "a@b.com", subject: "s" });
    const omitted = parseArgs(["email", "--to", "a@b.com", "--subject", "s"]);
    expect(omitted.payload).toEqual({ to: "a@b.com", subject: "s" });
    const inline = parseArgs(["email", "--to", "a@b.com", "--subject", "s", "--body", "hello"]);
    expect(inline.payload).toEqual({ to: "a@b.com", subject: "s", text: "hello" });
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
    expect(parseArgs(["x", "me"])).toEqual({ path: "/x/me", payload: {} });
    expect(parseArgs(["web"])).toEqual({ path: "/web/session/default", payload: { local: true } });
    expect(parseArgs(["web", "open", "research"])).toEqual({
      path: "/web/session/research",
      payload: { local: true }
    });
    expect(parseArgs(["web", "sessions"])).toEqual({ path: "/web/sessions", payload: {} });
    expect(parseArgs(["web", "close", "research"])).toEqual({
      path: "/web/close",
      payload: { name: "research" }
    });
    expect(parseArgs(["web", "password", "github", "--domains", "github.com,gist.github.com"])).toEqual({
      path: "/web/password",
      payload: { name: "github", domains: ["github.com", "gist.github.com"] }
    });
    expect(() => parseArgs(["web", "open", "BAD"])).toThrow(CliUsageError);
    expect(() => parseArgs(["web", "password", "github"])).toThrow(CliUsageError);
    expect(() => parseArgs(["web", "dance"])).toThrow(CliUsageError);
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

  it("parses the ask door: the kind leads, and links repeat", () => {
    expect(
      parseArgs([
        "ask",
        "decision",
        "--title",
        "may I pay the invoice",
        "--body",
        "20 USD, due friday",
        "--link",
        "https://example.com/a",
        "--link",
        "https://example.com/b"
      ])
    ).toEqual({
      path: "/ask/create",
      payload: {
        kind: "decision",
        title: "may I pay the invoice",
        body: "20 USD, due friday",
        links: ["https://example.com/a", "https://example.com/b"]
      }
    });
    // No --body: main() reads it from stdin, so it must be absent here
    // rather than empty (an empty body would file a blank ask).
    expect(parseArgs(["ask", "question", "--title", "what next"])).toEqual({
      path: "/ask/create",
      payload: { kind: "question", title: "what next", links: [] }
    });
    expect(parseArgs(["ask", "list"])).toEqual({ path: "/ask/list", payload: {} });
    expect(parseArgs(["ask", "reply", "a1", "--text", "done"])).toEqual({
      path: "/ask/reply",
      payload: { askId: "a1", text: "done" }
    });
    expect(parseArgs(["ask", "reply", "a1"])).toEqual({
      path: "/ask/reply",
      payload: { askId: "a1" }
    });
    expect(parseArgs(["ask", "retract", "a1", "--reason", "solved it myself"])).toEqual({
      path: "/ask/retract",
      payload: { askId: "a1", text: "solved it myself" }
    });
    expect(parseArgs(["ask", "close", "a1"])).toEqual({
      path: "/ask/close",
      payload: { askId: "a1" }
    });
    // A kind is required: defaulting it would choose on the mind's
    // behalf what the operator is being asked to do.
    expect(() => parseArgs(["ask", "--title", "t", "--body", "b"])).toThrow(CliUsageError);
    expect(() => parseArgs(["ask", "urgent", "--title", "t"])).toThrow(/decision\|request\|question/);
    expect(() => parseArgs(["ask", "decision", "--body", "b"])).toThrow(/--title/);
    expect(() => parseArgs(["ask", "close"])).toThrow(/ask-id/);
  });

  it("parses the branch door", () => {
    expect(
      parseArgs([
        "github",
        "branch",
        "org/repo",
        "out",
        "--branch",
        "prior/experiment",
        "--message",
        "wip"
      ])
    ).toEqual({
      path: "/github/branch",
      payload: { repo: "org/repo", branch: "prior/experiment", message: "wip", dir: "out" }
    });
    expect(
      parseArgs(["github", "branch", "org/repo", "--branch", "b", "--message", "m"])
    ).toEqual({
      path: "/github/branch",
      payload: { repo: "org/repo", branch: "b", message: "m", dir: "pr" }
    });
    expect(() => parseArgs(["github", "branch", "org/repo", "--branch", "b"])).toThrow(
      /--message/
    );
    expect(() => parseArgs(["github", "branch", "org/repo", "--message", "m"])).toThrow(/--branch/);
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
