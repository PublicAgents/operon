/**
 * Commit and pull-request creation through the GitHub Git Data API only:
 * no git binary, no local checkout, no repo config to execute. Both the
 * github Gatekeeper (state persistence) and the PR Gatekeeper (fork PRs)
 * build on this. The caller supplies an authenticated fetch (App
 * installation token or PAT); the credential never leaves the Worker.
 */

export interface GitFile {
  path: string;
  /** UTF-8 content, base64-encoded. */
  contentBase64: string;
}

export interface GithubApi {
  token: string;
  fetch?: typeof fetch;
  userAgent: string;
}

export class GitDataError extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`github_api_error (${status}): ${detail}`);
    this.name = "GitDataError";
  }
}

export async function githubApi(
  api: GithubApi,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const doFetch = api.fetch ?? fetch;
  const response = await doFetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${api.token}`,
      accept: "application/vnd.github+json",
      "user-agent": api.userAgent,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  if (!response.ok) throw new GitDataError(response.status, `${method} ${path}: ${text.slice(0, 300)}`);
  return text.length ? JSON.parse(text) : {};
}

export function decodeUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Create blobs for each file and a tree overlaying them on a base tree. */
/** A submodule pointer: a gitlink tree entry advancing path to sha. */
export interface GitLink {
  path: string;
  sha: string;
}

export async function buildTree(
  api: GithubApi,
  ownerRepo: string,
  baseTreeSha: string,
  files: GitFile[],
  deletions: string[] = [],
  gitlinks: GitLink[] = []
): Promise<string> {
  const tree: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const blob = (await githubApi(api, "POST", `/repos/${ownerRepo}/git/blobs`, {
      content: decodeUtf8(file.contentBase64),
      encoding: "utf-8"
    })) as { sha: string };
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  // A submodule bump is a commit-typed entry (gitlink): no blob exists;
  // the sha references a commit in the submodule's own repository.
  for (const link of gitlinks) {
    tree.push({ path: link.path, mode: "160000", type: "commit", sha: link.sha });
  }
  // A tree entry with sha:null deletes that path relative to base_tree.
  for (const path of deletions) {
    tree.push({ path, mode: "100644", type: "blob", sha: null });
  }
  const created = (await githubApi(api, "POST", `/repos/${ownerRepo}/git/trees`, {
    base_tree: baseTreeSha,
    tree
  })) as { sha: string };
  return created.sha;
}

export interface CommitResult {
  commitSha: string;
  branch: string;
}

/**
 * Commit files directly to a branch of a repo (fast-forward update of the
 * ref). Used for state persistence: the Gatekeeper is the only writer of
 * an agent's state branch, and wakes are serialized per agent, so a plain
 * ref update is safe.
 */
export async function commitToBranch(
  api: GithubApi,
  ownerRepo: string,
  opts: { branch?: string; message: string; files: GitFile[]; deletions?: string[] }
): Promise<CommitResult> {
  const repo = (await githubApi(api, "GET", `/repos/${ownerRepo}`)) as { default_branch: string };
  const branch = opts.branch ?? repo.default_branch;
  const ref = (await githubApi(api, "GET", `/repos/${ownerRepo}/git/ref/heads/${branch}`)) as {
    object: { sha: string };
  };
  const headSha = ref.object.sha;
  const headCommit = (await githubApi(api, "GET", `/repos/${ownerRepo}/git/commits/${headSha}`)) as {
    tree: { sha: string };
  };
  const treeSha = await buildTree(api, ownerRepo, headCommit.tree.sha, opts.files, opts.deletions ?? []);
  const commit = (await githubApi(api, "POST", `/repos/${ownerRepo}/git/commits`, {
    message: opts.message,
    tree: treeSha,
    parents: [headSha]
  })) as { sha: string };
  await githubApi(api, "PATCH", `/repos/${ownerRepo}/git/refs/heads/${branch}`, {
    sha: commit.sha,
    force: false
  });
  return { commitSha: commit.sha, branch };
}
