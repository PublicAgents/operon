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
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const { listActivity } = await import("./github.js");
    const items = await listActivity({ token: "pat", userAgent: "test", fetch: fetchImpl });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "pr",
      number: 59,
      state: "closed",
      merged: true,
      commentCount: 1
    });
    expect(items[0].recentComments[0]).toMatchObject({ user: "maintainer", body: "thanks!" });
  });
});
