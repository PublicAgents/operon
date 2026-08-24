/**
 * Fork-based pull requests through the GitHub API only: no git, no local
 * checkout, no repo config to execute. The machine credential lives in the
 * Worker that calls this and is never handed to a wake container.
 *
 * Flow: ensure the machine user's fork exists, read the upstream default
 * branch head, build a new tree overlaying the submitted files on the base
 * commit's tree, create a commit and a branch ref ON THE FORK via the Git
 * Data API, then open the PR upstream. Every step is one authenticated
 * HTTPS call.
 */

export interface PrFile {
  path: string;
  contentBase64: string;
}

export interface PrRequest {
  repo: string;
  title: string;
  body: string;
  files: PrFile[];
}

export interface PrResult {
  url: string;
  branch: string;
  base: string;
}

export interface GithubClient {
  token: string;
  fetch?: typeof fetch;
  /** Deterministic branch suffix; real callers pass a uuid. */
  branchSuffix: string;
}

class GithubError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string
  ) {
    super(`${code}: ${detail}`);
  }
}

async function api(
  client: GithubClient,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const doFetch = client.fetch ?? fetch;
  const response = await doFetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "operon-gatekeeper-pr",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  if (!response.ok) {
    throw new GithubError(response.status, "github_api_error", `${method} ${path}: ${text.slice(0, 300)}`);
  }
  return text.length ? JSON.parse(text) : {};
}

function decodeUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function openPullRequest(
  client: GithubClient,
  request: PrRequest
): Promise<PrResult> {
  const [owner, name] = request.repo.split("/");
  const me = (await api(client, "GET", "/user")) as { login: string };
  const user = me.login;

  // Read upstream default branch + head commit + its tree.
  const upstream = (await api(client, "GET", `/repos/${owner}/${name}`)) as {
    default_branch: string;
  };
  const base = upstream.default_branch;
  const ref = (await api(client, "GET", `/repos/${owner}/${name}/git/ref/heads/${base}`)) as {
    object: { sha: string };
  };
  const baseSha = ref.object.sha;
  const baseCommit = (await api(client, "GET", `/repos/${owner}/${name}/git/commits/${baseSha}`)) as {
    tree: { sha: string };
  };

  // Ensure the machine user's fork exists, then wait for it to be usable.
  await api(client, "POST", `/repos/${owner}/${name}/forks`, {});
  let forkReady = false;
  for (let i = 0; i < 15 && !forkReady; i++) {
    try {
      await api(client, "GET", `/repos/${user}/${name}`);
      forkReady = true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  if (!forkReady) throw new GithubError(502, "fork_unavailable", `${user}/${name} did not appear`);

  // Build the new tree on the fork by overlaying each submitted file as a
  // blob on top of the upstream base tree.
  const tree = [];
  for (const file of request.files) {
    const blob = (await api(client, "POST", `/repos/${user}/${name}/git/blobs`, {
      content: decodeUtf8(file.contentBase64),
      encoding: "utf-8"
    })) as { sha: string };
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = (await api(client, "POST", `/repos/${user}/${name}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree
  })) as { sha: string };

  const commit = (await api(client, "POST", `/repos/${user}/${name}/git/commits`, {
    message: `${request.title}\n\nOpened by the Operon PR Gatekeeper on behalf of an autonomous agent.`,
    tree: newTree.sha,
    parents: [baseSha]
  })) as { sha: string };

  const branch = `operon/${client.branchSuffix}`;
  await api(client, "POST", `/repos/${user}/${name}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: commit.sha
  });

  const pr = (await api(client, "POST", `/repos/${owner}/${name}/pulls`, {
    title: request.title,
    body: request.body,
    head: `${user}:${branch}`,
    base
  })) as { html_url: string };

  return { url: pr.html_url, branch, base };
}

export { GithubError };
