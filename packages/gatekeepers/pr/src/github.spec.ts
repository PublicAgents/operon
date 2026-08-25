import { describe, expect, it } from "vitest";
import { openPullRequest } from "./github.js";

/**
 * A scripted GitHub API: asserts the Gatekeeper drives the fork + Git Data
 * API flow and never needs a local git operation. Each entry matches a
 * method+path and returns a canned body.
 */
function scriptedFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const key = `${method} ${url.replace("https://api.github.com", "")}`;
    calls.push(key);
    const respond = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });

    if (key === "GET /user") return respond({ login: "bot" });
    if (key === "GET /repos/org/repo") return respond({ default_branch: "main" });
    if (key === "GET /repos/org/repo/git/ref/heads/main")
      return respond({ object: { sha: "base-sha" } });
    if (key === "GET /repos/org/repo/git/commits/base-sha")
      return respond({ tree: { sha: "base-tree" } });
    if (key === "POST /repos/org/repo/forks") return respond({}, 202);
    if (key === "GET /repos/bot/repo") return respond({ full_name: "bot/repo" });
    if (key === "POST /repos/bot/repo/git/blobs") return respond({ sha: "blob-sha" });
    if (key === "POST /repos/bot/repo/git/trees") return respond({ sha: "tree-sha" });
    if (key === "POST /repos/bot/repo/git/commits") return respond({ sha: "commit-sha" });
    if (key === "POST /repos/bot/repo/git/refs") return respond({});
    if (key === "POST /repos/org/repo/pulls")
      return respond({ html_url: "https://github.com/org/repo/pull/7" });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

describe("openPullRequest", () => {
  it("opens a fork-based PR entirely through the API", async () => {
    const calls: string[] = [];
    const result = await openPullRequest(
      { token: "pat", userAgent: "test", fetch: scriptedFetch(calls) },
      {
        repo: "org/repo",
        title: "Add server.json",
        body: "Registers the MCP server.",
        files: [{ path: "server.json", contentBase64: btoa('{"name":"x"}') }]
      },
      "abc"
    );

    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/7",
      branch: "operon/abc",
      base: "main"
    });
    // The commit and ref were created on the FORK, the PR on the upstream.
    expect(calls).toContain("POST /repos/bot/repo/git/commits");
    expect(calls).toContain("POST /repos/bot/repo/git/refs");
    expect(calls).toContain("POST /repos/org/repo/pulls");
    // No local git: the whole flow is HTTPS to api.github.com.
    expect(calls.every(c => c.includes("/"))).toBe(true);
  });

  it("surfaces a GitHub API failure as an error", async () => {
    await expect(
      openPullRequest(
        { token: "pat", userAgent: "test", fetch: (async () => new Response("nope", { status: 404 })) as typeof fetch },
        { repo: "org/repo", title: "t", body: "b", files: [] },
        "abc"
      )
    ).rejects.toThrow(/github_api_error/);
  });
});

describe("listActivity", () => {
  it("lists the account's PRs/issues with latest comments and merged state", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace("https://api.github.com", "");
      const respond = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
      if (path === "/user") return respond({ login: "prior-agent" });
      if (path.startsWith("/search/issues"))
        return respond({
          items: [
            {
              html_url: "https://github.com/org/repo/pull/59",
              title: "Add server.json",
              state: "closed",
              number: 59,
              comments: 1,
              updated_at: "2026-08-24T20:00:00Z",
              repository_url: "https://api.github.com/repos/org/repo",
              pull_request: { merged_at: "2026-08-24T21:00:00Z" }
            }
          ]
        });
      if (path === "/repos/org/repo/issues/59/comments?per_page=30")
        return respond([{ user: { login: "maintainer" }, created_at: "2026-08-24T20:30:00Z", body: "thanks!" }]);
      if (path === "/repos/org/repo/pulls/59/comments?per_page=30")
        return respond([{ user: { login: "maintainer" }, created_at: "2026-08-24T20:31:00Z", body: "inline nit" }]);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const { listActivity } = await import("./github.js");
    const { mine: items, watched } = await listActivity({ token: "pat", userAgent: "test", fetch: fetchImpl });
    expect(watched).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "pr",
      number: 59,
      state: "closed",
      merged: true,
      commentCount: 1
    });
    expect(items[0].recentComments[0]).toMatchObject({ user: "maintainer", body: "thanks!" });
    expect(items[0].recentReviewComments?.[0]).toMatchObject({ user: "maintainer", body: "inline nit" });
  });
});

describe("getThread", () => {
  it("merges comments, reviews, and inline review comments chronologically", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = (typeof input === "string" ? input : input.toString()).replace(
        "https://api.github.com",
        ""
      );
      const respond = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
      if (path === "/repos/org/repo/issues/7")
        return respond({
          html_url: "https://github.com/org/repo/pull/7",
          title: "t",
          state: "open",
          body: "the body",
          user: { login: "prior-livevariant-bot" },
          pull_request: { merged_at: null }
        });
      if (path === "/repos/org/repo/issues/7/comments?per_page=100")
        return respond([
          { id: 1, user: { login: "alice" }, created_at: "2026-08-25T10:00:00Z", body: "conversation" }
        ]);
      if (path === "/repos/org/repo/pulls/7/reviews?per_page=100")
        return respond([
          { id: 2, user: { login: "bob" }, submitted_at: "2026-08-25T09:00:00Z", body: "looks off", state: "CHANGES_REQUESTED" },
          { id: 3, user: { login: "bob" }, submitted_at: "2026-08-25T09:30:00Z", body: "", state: "COMMENTED" }
        ]);
      if (path === "/repos/org/repo/pulls/7/comments?per_page=100")
        return respond([
          { id: 4, user: { login: "bob" }, created_at: "2026-08-25T09:10:00Z", body: "fix this line", path: "a.ts", line: 12 }
        ]);
      return new Response("unexpected: " + path, { status: 500 });
    }) as typeof fetch;

    const { getThread } = await import("./github.js");
    const thread = await getThread({ token: "pat", userAgent: "test", fetch: fetchImpl }, "org/repo", 7);
    expect(thread.kind).toBe("pr");
    expect(thread.author).toBe("prior-livevariant-bot");
    // Chronological: review (09:00), review-comment (09:10), comment (10:00).
    // The empty COMMENTED container review is dropped.
    expect(thread.items.map(i => i.kind)).toEqual(["review", "review-comment", "comment"]);
    expect(thread.items[0].verdict).toBe("CHANGES_REQUESTED");
    expect(thread.items[1]).toMatchObject({ path: "a.ts", line: 12, id: 4 });
  });
});

describe("getIssueRef", () => {
  it("returns author and, for PRs, the head fork and branch", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = (typeof input === "string" ? input : input.toString()).replace(
        "https://api.github.com",
        ""
      );
      const respond = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
      if (path === "/repos/org/repo/issues/9")
        return respond({ user: { login: "prior-livevariant-bot" }, state: "open", pull_request: {} });
      if (path === "/repos/org/repo/pulls/9")
        return respond({ head: { ref: "operon/x", repo: { full_name: "prior-livevariant-bot/repo" } } });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const { getIssueRef } = await import("./github.js");
    const ref = await getIssueRef({ token: "pat", userAgent: "test", fetch: fetchImpl }, "org/repo", 9);
    expect(ref).toEqual({
      kind: "pr",
      author: "prior-livevariant-bot",
      state: "open",
      headRepo: "prior-livevariant-bot/repo",
      headBranch: "operon/x"
    });
  });
});

describe("getUpstreamFile", () => {
  it("returns raw content base64 and maps 404 to exists:false", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.github.com/repos/org/repo/contents/docs%2FREADME.md".replace("%2F", "/"))
        return new Response("hello upstream", { status: 200 });
      if (url.endsWith("/contents/missing.md")) return new Response("", { status: 404 });
      return new Response("unexpected: " + url, { status: 500 });
    }) as typeof fetch;

    const { getUpstreamFile } = await import("./github.js");
    const found = await getUpstreamFile({ token: "pat", userAgent: "t", fetch: fetchImpl }, "org/repo", "docs/README.md");
    expect(found.exists).toBe(true);
    expect(Buffer.from(found.contentBase64 ?? "", "base64").toString("utf8")).toBe("hello upstream");
    const missing = await getUpstreamFile({ token: "pat", userAgent: "t", fetch: fetchImpl }, "org/repo", "missing.md");
    expect(missing).toEqual({ exists: false });
  });
});

describe("openPullRequest with submodules", () => {
  it("emits a gitlink (mode 160000, type commit) tree entry", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const trees: unknown[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace("https://api.github.com", "");
      const respond = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
      if (path === "/user") return respond({ login: "bot" });
      if (path === "/repos/org/colony") return respond({ default_branch: "main" });
      if (path === "/repos/org/colony/git/ref/heads/main")
        return respond({ object: { sha: "base0000" } });
      if (path === "/repos/org/colony/git/commits/base0000")
        return respond({ tree: { sha: "tree0000" } });
      if (path === "/repos/org/colony/forks") return respond({});
      if (path === "/repos/bot/colony") return respond({});
      if (path === "/repos/bot/colony/git/trees") {
        trees.push(JSON.parse(String(init?.body)));
        return respond({ sha: "newtree" });
      }
      if (path === "/repos/bot/colony/git/commits") return respond({ sha: "newcommit" });
      if (path === "/repos/bot/colony/git/refs") return respond({});
      if (path === "/repos/org/colony/pulls")
        return respond({ html_url: "https://github.com/org/colony/pull/9" });
      return new Response("unexpected: " + path, { status: 500 });
    }) as typeof fetch;

    const { openPullRequest } = await import("./github.js");
    const result = await openPullRequest(
      { token: "pat", userAgent: "t", fetch: fetchImpl },
      { repo: "org/colony", title: "bump", body: "b", files: [], submodules: [{ path: "operon", sha }] },
      "suffix"
    );
    expect(result.url).toContain("/pull/9");
    expect(trees).toHaveLength(1);
    expect((trees[0] as { tree: unknown[] }).tree).toEqual([
      { path: "operon", mode: "160000", type: "commit", sha }
    ]);
  });
});
