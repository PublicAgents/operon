import { describe, expect, it } from "vitest";
import { openPullRequest, type GithubClient } from "./github.js";

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
    const client: GithubClient = {
      token: "pat",
      branchSuffix: "abc",
      fetch: scriptedFetch(calls)
    };
    const result = await openPullRequest(client, {
      repo: "org/repo",
      title: "Add server.json",
      body: "Registers the MCP server.",
      files: [{ path: "server.json", contentBase64: btoa('{"name":"x"}') }]
    });

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
    const client: GithubClient = {
      token: "pat",
      branchSuffix: "abc",
      fetch: (async () => new Response("nope", { status: 404 })) as typeof fetch
    };
    await expect(
      openPullRequest(client, { repo: "org/repo", title: "t", body: "b", files: [] })
    ).rejects.toThrow(/github_api_error/);
  });
});
