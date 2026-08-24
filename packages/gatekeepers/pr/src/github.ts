import { buildTree, githubApi, type GitFile, type GithubApi } from "@operon/worker-kit/git-data";

/**
 * Fork-based pull requests through the GitHub Git Data API only: no git, no
 * local checkout. Ensure the machine user's fork, build a tree overlaying
 * the submitted files on the upstream base commit, create a commit and a
 * branch ref ON THE FORK, then open the PR upstream. Every step is one
 * authenticated HTTPS call; the credential never leaves the Worker.
 */

export interface PrRequest {
  repo: string;
  title: string;
  body: string;
  files: GitFile[];
}

export interface PrResult {
  url: string;
  branch: string;
  base: string;
}

const UA = "operon-gatekeeper-pr";

export async function openPullRequest(
  api: GithubApi,
  request: PrRequest,
  branchSuffix: string
): Promise<PrResult> {
  const client: GithubApi = { ...api, userAgent: UA };
  const [owner, name] = request.repo.split("/");
  const me = (await githubApi(client, "GET", "/user")) as { login: string };
  const user = me.login;

  const upstream = (await githubApi(client, "GET", `/repos/${owner}/${name}`)) as {
    default_branch: string;
  };
  const base = upstream.default_branch;
  const ref = (await githubApi(client, "GET", `/repos/${owner}/${name}/git/ref/heads/${base}`)) as {
    object: { sha: string };
  };
  const baseSha = ref.object.sha;
  const baseCommit = (await githubApi(client, "GET", `/repos/${owner}/${name}/git/commits/${baseSha}`)) as {
    tree: { sha: string };
  };

  // Ensure the machine user's fork exists, then wait for it to be usable.
  await githubApi(client, "POST", `/repos/${owner}/${name}/forks`, {});
  let forkReady = false;
  for (let i = 0; i < 15 && !forkReady; i++) {
    try {
      await githubApi(client, "GET", `/repos/${user}/${name}`);
      forkReady = true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  if (!forkReady) throw new Error(`fork_unavailable: ${user}/${name} did not appear`);

  const treeSha = await buildTree(client, `${user}/${name}`, baseCommit.tree.sha, request.files);
  const commit = (await githubApi(client, "POST", `/repos/${user}/${name}/git/commits`, {
    message: `${request.title}\n\nOpened by the Operon PR Gatekeeper on behalf of an autonomous agent.`,
    tree: treeSha,
    parents: [baseSha]
  })) as { sha: string };

  const branch = `operon/${branchSuffix}`;
  await githubApi(client, "POST", `/repos/${user}/${name}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: commit.sha
  });

  const pr = (await githubApi(client, "POST", `/repos/${owner}/${name}/pulls`, {
    title: request.title,
    body: request.body,
    head: `${user}:${branch}`,
    base
  })) as { html_url: string };

  return { url: pr.html_url, branch, base };
}

export interface ActivityComment {
  user: string;
  at: string;
  body: string;
}

export interface ActivityItem {
  url: string;
  repo: string;
  number: number;
  title: string;
  kind: "pr" | "issue";
  state: string;
  merged?: boolean;
  updatedAt: string;
  commentCount: number;
  recentComments: ActivityComment[];
}

/**
 * List the machine account's own recently-updated PRs and issues, with the
 * latest comments on each, so an agent can follow the conversation on what
 * it opened. Searching by author scopes cleanly to this agent's account
 * (one account per agent), and the credential's read covers private repos
 * too. Bounded: a handful of items, a few comments each.
 */
export async function listActivity(api: GithubApi, max = 12): Promise<ActivityItem[]> {
  const client: GithubApi = { ...api, userAgent: UA };
  const me = (await githubApi(client, "GET", "/user")) as { login: string };
  const q = encodeURIComponent(`author:${me.login} sort:updated-desc`);
  const search = (await githubApi(client, "GET", `/search/issues?q=${q}&per_page=${max}`)) as {
    items: Array<{
      html_url: string;
      title: string;
      state: string;
      number: number;
      comments: number;
      updated_at: string;
      repository_url: string;
      pull_request?: { merged_at?: string | null };
    }>;
  };

  const items: ActivityItem[] = [];
  for (const it of search.items ?? []) {
    const repo = it.repository_url.replace("https://api.github.com/repos/", "");
    const isPr = Boolean(it.pull_request);
    let merged: boolean | undefined;
    if (isPr && it.state === "closed") {
      merged = Boolean(it.pull_request?.merged_at);
    }
    let recentComments: ActivityComment[] = [];
    if (it.comments > 0) {
      const comments = (await githubApi(
        client,
        "GET",
        `/repos/${repo}/issues/${it.number}/comments?per_page=30`
      )) as Array<{ user?: { login?: string }; created_at: string; body?: string }>;
      recentComments = comments.slice(-3).map(c => ({
        user: c.user?.login ?? "unknown",
        at: c.created_at,
        body: (c.body ?? "").slice(0, 800)
      }));
    }
    items.push({
      url: it.html_url,
      repo,
      number: it.number,
      title: it.title,
      kind: isPr ? "pr" : "issue",
      state: it.state,
      merged,
      updatedAt: it.updated_at,
      commentCount: it.comments,
      recentComments
    });
  }
  return items;
}

/** Open an issue on an allowlisted repo through the API (no fork needed). */
export async function openIssue(
  api: GithubApi,
  repo: string,
  title: string,
  body: string
): Promise<{ url: string }> {
  const issue = (await githubApi(
    { ...api, userAgent: UA },
    "POST",
    `/repos/${repo}/issues`,
    { title, body }
  )) as { html_url: string };
  return { url: issue.html_url };
}
