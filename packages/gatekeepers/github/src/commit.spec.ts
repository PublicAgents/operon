import { describe, expect, it } from "vitest";
import { commitToBranch, type GithubApi } from "@operon/worker-kit/git-data";

/** Scripted GitHub API asserting a direct-to-branch commit via Git Data API. */
function scriptedFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const key = `${init?.method ?? "GET"} ${url.replace("https://api.github.com", "")}`;
    calls.push(key);
    const respond = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (key === "GET /repos/org/state") return respond({ default_branch: "main" });
    if (key === "GET /repos/org/state/git/ref/heads/main") return respond({ object: { sha: "head" } });
    if (key === "GET /repos/org/state/git/commits/head") return respond({ tree: { sha: "base-tree" } });
    if (key === "POST /repos/org/state/git/blobs") return respond({ sha: "blob" });
    if (key === "POST /repos/org/state/git/trees") return respond({ sha: "new-tree" });
    if (key === "POST /repos/org/state/git/commits") return respond({ sha: "new-commit" });
    if (key === "PATCH /repos/org/state/git/refs/heads/main") return respond({});
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

describe("commitToBranch (state persistence)", () => {
  it("commits files to the default branch via the Git Data API and fast-forwards the ref", async () => {
    const calls: string[] = [];
    const api: GithubApi = { token: "t", userAgent: "test", fetch: scriptedFetch(calls) };
    const result = await commitToBranch(api, "org/state", {
      message: "wake abc",
      files: [{ path: "JOURNAL.md", contentBase64: btoa("## Wake 1") }],
      deletions: ["old.md"]
    });
    expect(result).toEqual({ commitSha: "new-commit", branch: "main" });
    expect(calls).toContain("POST /repos/org/state/git/commits");
    expect(calls).toContain("PATCH /repos/org/state/git/refs/heads/main");
    // No git binary anywhere; the whole flow is HTTPS.
    expect(calls.every(c => c.startsWith("GET ") || c.startsWith("POST ") || c.startsWith("PATCH ")))
      .toBe(true);
  });
});
