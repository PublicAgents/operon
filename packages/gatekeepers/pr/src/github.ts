import {
  buildTree,
  commitToBranch,
  githubApi,
  type GitFile,
  type GitLink,
  type GithubApi
} from "@operon/worker-kit/git-data";

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
  /** Submodule bumps: gitlink entries advancing path to a commit sha. */
  submodules?: GitLink[];
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

  const treeSha = await buildTree(
    client,
    `${user}/${name}`,
    baseCommit.tree.sha,
    request.files,
    [],
    request.submodules ?? []
  );
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
  /** PRs only: latest inline review comments; full detail via getThread. */
  recentReviewComments?: ActivityComment[];
}

/**
 * List the machine account's own recently-updated PRs and issues, with the
 * latest comments on each, so an agent can follow the conversation on what
 * it opened. Searching by author scopes cleanly to this agent's account
 * (one account per agent), and the credential's read covers private repos
 * too. Bounded: a handful of items, a few comments each.
 */
interface SearchIssueItem {
  html_url: string;
  title: string;
  state: string;
  number: number;
  comments: number;
  updated_at: string;
  repository_url: string;
  pull_request?: { merged_at?: string | null };
}

async function toActivityItem(client: GithubApi, it: SearchIssueItem): Promise<ActivityItem> {
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
  let recentReviewComments: ActivityComment[] | undefined;
  if (isPr) {
    const reviewComments = (await githubApi(
      client,
      "GET",
      `/repos/${repo}/pulls/${it.number}/comments?per_page=30`
    )) as Array<{ user?: { login?: string }; created_at: string; body?: string }>;
    if (reviewComments.length > 0) {
      recentReviewComments = reviewComments.slice(-3).map(c => ({
        user: c.user?.login ?? "unknown",
        at: c.created_at,
        body: (c.body ?? "").slice(0, 800)
      }));
    }
  }
  return {
    url: it.html_url,
    repo,
    number: it.number,
    title: it.title,
    kind: isPr ? "pr" : "issue",
    state: it.state,
    merged,
    updatedAt: it.updated_at,
    commentCount: it.comments,
    recentComments,
    recentReviewComments
  };
}

async function searchActivity(client: GithubApi, query: string, max: number): Promise<ActivityItem[]> {
  const search = (await githubApi(
    client,
    "GET",
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${max}`
  )) as { items: SearchIssueItem[] };
  const items: ActivityItem[] = [];
  for (const it of search.items ?? []) {
    items.push(await toActivityItem(client, it));
  }
  return items;
}

export interface Activity {
  /** Items this agent's account authored, anywhere. */
  mine: ActivityItem[];
  /** Recently active items by OTHERS in the watched (allowlisted) repos. */
  watched: ActivityItem[];
}

export async function listActivity(
  api: GithubApi,
  watchRepos: string[] = [],
  max = 12
): Promise<Activity> {
  const client: GithubApi = { ...api, userAgent: UA };
  const me = (await githubApi(client, "GET", "/user")) as { login: string };
  const mine = await searchActivity(client, `author:${me.login} sort:updated-desc`, max);
  let watched: ActivityItem[] = [];
  if (watchRepos.length > 0) {
    const repoTerms = watchRepos.map(repo => `repo:${repo}`).join(" ");
    watched = await searchActivity(
      client,
      `${repoTerms} -author:${me.login} sort:updated-desc`,
      max
    );
  }
  return { mine, watched };
}

export interface ThreadItem {
  kind: "comment" | "review" | "review-comment";
  id: number;
  user: string;
  at: string;
  body: string;
  /** review-comment only: the file and line the comment anchors to. */
  path?: string;
  line?: number;
  /** review only: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  verdict?: string;
}

export interface Thread {
  url: string;
  repo: string;
  number: number;
  kind: "pr" | "issue";
  title: string;
  state: string;
  merged?: boolean;
  author: string;
  body: string;
  items: ThreadItem[];
}

export interface IssueRef {
  kind: "pr" | "issue";
  author: string;
  state: string;
  headRepo?: string;
  headBranch?: string;
}

/** Who the credential authenticates as. */
export async function authenticatedLogin(api: GithubApi): Promise<string> {
  const me = (await githubApi({ ...api, userAgent: UA }, "GET", "/user")) as { login: string };
  return me.login;
}

/** Fetch a PR/issue's author and (for PRs) its head, for policy checks. */
export async function getIssueRef(api: GithubApi, repo: string, number: number): Promise<IssueRef> {
  const client: GithubApi = { ...api, userAgent: UA };
  const issue = (await githubApi(client, "GET", `/repos/${repo}/issues/${number}`)) as {
    user?: { login?: string };
    state: string;
    pull_request?: object;
  };
  const ref: IssueRef = {
    kind: issue.pull_request ? "pr" : "issue",
    author: issue.user?.login ?? "unknown",
    state: issue.state
  };
  if (ref.kind === "pr") {
    const pr = (await githubApi(client, "GET", `/repos/${repo}/pulls/${number}`)) as {
      head: { ref: string; repo?: { full_name?: string } };
    };
    ref.headRepo = pr.head.repo?.full_name;
    ref.headBranch = pr.head.ref;
  }
  return ref;
}

/**
 * The full conversation on one PR or issue: the opening body, conversation
 * comments, and for PRs the reviews and their inline file comments, merged
 * into one chronological list. This is what lets an agent actually answer a
 * reviewer instead of only knowing a comment count.
 */
export async function getThread(api: GithubApi, repo: string, number: number): Promise<Thread> {
  const client: GithubApi = { ...api, userAgent: UA };
  const issue = (await githubApi(client, "GET", `/repos/${repo}/issues/${number}`)) as {
    html_url: string;
    title: string;
    state: string;
    body?: string;
    user?: { login?: string };
    pull_request?: { merged_at?: string | null };
  };
  const isPr = Boolean(issue.pull_request);

  const items: ThreadItem[] = [];
  const comments = (await githubApi(
    client,
    "GET",
    `/repos/${repo}/issues/${number}/comments?per_page=100`
  )) as Array<{ id: number; user?: { login?: string }; created_at: string; body?: string }>;
  for (const c of comments) {
    items.push({
      kind: "comment",
      id: c.id,
      user: c.user?.login ?? "unknown",
      at: c.created_at,
      body: (c.body ?? "").slice(0, 4000)
    });
  }

  let merged: boolean | undefined;
  if (isPr) {
    merged = Boolean(issue.pull_request?.merged_at);
    const reviews = (await githubApi(
      client,
      "GET",
      `/repos/${repo}/pulls/${number}/reviews?per_page=100`
    )) as Array<{
      id: number;
      user?: { login?: string };
      submitted_at?: string;
      body?: string;
      state: string;
    }>;
    for (const r of reviews) {
      if (!r.body && r.state === "COMMENTED") continue; // empty container review
      items.push({
        kind: "review",
        id: r.id,
        user: r.user?.login ?? "unknown",
        at: r.submitted_at ?? "",
        body: (r.body ?? "").slice(0, 4000),
        verdict: r.state
      });
    }
    const reviewComments = (await githubApi(
      client,
      "GET",
      `/repos/${repo}/pulls/${number}/comments?per_page=100`
    )) as Array<{
      id: number;
      user?: { login?: string };
      created_at: string;
      body?: string;
      path?: string;
      line?: number | null;
      original_line?: number | null;
    }>;
    for (const c of reviewComments) {
      items.push({
        kind: "review-comment",
        id: c.id,
        user: c.user?.login ?? "unknown",
        at: c.created_at,
        body: (c.body ?? "").slice(0, 4000),
        path: c.path,
        line: c.line ?? c.original_line ?? undefined
      });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at));

  return {
    url: issue.html_url,
    repo,
    number,
    kind: isPr ? "pr" : "issue",
    title: issue.title,
    state: issue.state,
    merged,
    author: issue.user?.login ?? "unknown",
    body: (issue.body ?? "").slice(0, 8000),
    items
  };
}

/** Post a conversation comment on a PR or issue. */
export async function postComment(
  api: GithubApi,
  repo: string,
  number: number,
  body: string
): Promise<{ url: string }> {
  const comment = (await githubApi(
    { ...api, userAgent: UA },
    "POST",
    `/repos/${repo}/issues/${number}/comments`,
    { body }
  )) as { html_url: string };
  return { url: comment.html_url };
}

/** Reply in an inline review-comment thread on a PR. */
export async function replyToReviewComment(
  api: GithubApi,
  repo: string,
  number: number,
  commentId: number,
  body: string
): Promise<{ url: string }> {
  const reply = (await githubApi(
    { ...api, userAgent: UA },
    "POST",
    `/repos/${repo}/pulls/${number}/comments/${commentId}/replies`,
    { body }
  )) as { html_url: string };
  return { url: reply.html_url };
}

/** Update a PR/issue's title, body, or state. Caller enforces authorship. */
export async function updateIssue(
  api: GithubApi,
  repo: string,
  number: number,
  patch: { title?: string; body?: string; state?: "open" | "closed" }
): Promise<{ url: string }> {
  const updated = (await githubApi(
    { ...api, userAgent: UA },
    "PATCH",
    `/repos/${repo}/issues/${number}`,
    patch
  )) as { html_url: string };
  return { url: updated.html_url };
}

/**
 * Push follow-up files to an existing PR's head branch (the machine
 * account's fork). Caller has verified the PR is authored by this account
 * and the head repo belongs to it; the commit itself is a plain
 * fast-forward on that branch.
 */
export async function pushToPr(
  api: GithubApi,
  headRepo: string,
  headBranch: string,
  message: string,
  files: GitFile[]
): Promise<{ commitSha: string }> {
  const result = await commitToBranch({ ...api, userAgent: UA }, headRepo, {
    branch: headBranch,
    message,
    files
  });
  return { commitSha: result.commitSha };
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

/**
 * Fetch a file's current content from a repo, raw (works past the contents
 * API's 1MB JSON limit). exists:false on 404. Used by the porch to scope
 * the outbound sweep of an existing file to the agent's added lines.
 */
export async function getUpstreamFile(
  api: GithubApi,
  repo: string,
  path: string
): Promise<{ exists: boolean; contentBase64?: string }> {
  const doFetch = api.fetch ?? fetch;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await doFetch(`https://api.github.com/repos/${repo}/contents/${encodedPath}`, {
    headers: {
      authorization: `Bearer ${api.token}`,
      accept: "application/vnd.github.raw+json",
      "user-agent": UA,
      "x-github-api-version": "2022-11-28"
    }
  });
  if (response.status === 404) return { exists: false };
  if (!response.ok) {
    throw new Error(`upstream_file_failed: ${response.status} for ${repo}/${path}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { exists: true, contentBase64: btoa(binary) };
}
