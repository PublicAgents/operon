import {
  errorResponse,
  json,
  readJson,
  requireBearer,
  Ledger,
  GitDataError
} from "@operon/worker-kit";
import {
  authenticatedLogin,
  getIssueRef,
  getThread,
  listActivity,
  openIssue,
  openPullRequest,
  postComment,
  pushToPr,
  replyToReviewComment,
  updateIssue,
  type PrRequest
} from "./github.js";

export { Ledger };
export * from "./github.js";

/**
 * The PR Gatekeeper: opens fork-based pull requests and issues for
 * allowlisted repos, and reports the status of what an agent opened, all
 * through the GitHub API. It holds the machine credential; no wake
 * container ever does. Callers (the porch) authenticate with an internal
 * bearer and submit DATA; this Worker turns it into GitHub actions.
 */

interface Env {
  MACHINE_PAT?: string;
  PR_SERVICE_TOKEN?: string;
  PR_REPOS?: string;
  LEDGER: DurableObjectNamespace<Ledger>;
  [secret: string]: unknown;
}

/**
 * The GitHub credential for an agent: its own account's PAT
 * (MACHINE_PAT_<AGENTID>) when set, else the shared MACHINE_PAT. Per-agent
 * accounts let each agent open and own its PRs under its own identity and
 * receive its own notifications.
 */
function patForAgent(env: Env, agentId: string): string | undefined {
  const perAgent = env[`MACHINE_PAT_${agentId.toUpperCase().replace(/-/g, "_")}`];
  if (typeof perAgent === "string" && perAgent.length > 0) return perAgent;
  return env.MACHINE_PAT;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("pr"));
}

function allowlist(env: Env): string[] {
  return (env.PR_REPOS ?? "")
    .split(",")
    .map(repo => repo.trim())
    .filter(repo => repo.length > 0);
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

async function handlePr(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) {
    await ledger(env).append("pr_denied", { status: denied.status });
    return denied;
  }
  const body = await readJson<PrRequest & { agentId?: string }>(request);
  if (!body.ok) {
    await ledger(env).append("pr_failed", { reason: "malformed_json" });
    return errorResponse(400, "malformed_json");
  }
  const { repo, title, body: prBody, files, agentId } = body.value;

  if (typeof repo !== "string" || !REPO.test(repo) || !allowlist(env).includes(repo)) {
    await ledger(env).append("pr_failed", { reason: "repo_not_allowlisted", repo });
    return errorResponse(403, "repo_not_allowlisted", `allowed: ${allowlist(env).join(", ")}`);
  }
  if (typeof title !== "string" || !title || typeof prBody !== "string" || !prBody) {
    await ledger(env).append("pr_failed", { reason: "missing_title_or_body", repo });
    return errorResponse(400, "missing_title_or_body");
  }
  if (!Array.isArray(files) || files.length === 0) {
    await ledger(env).append("pr_failed", { reason: "no_files", repo });
    return errorResponse(400, "no_files");
  }
  for (const file of files) {
    if (
      typeof file?.path !== "string" ||
      !SAFE_PATH.test(file.path) ||
      file.path.includes("..") ||
      file.path.startsWith("/") ||
      typeof file.contentBase64 !== "string"
    ) {
      await ledger(env).append("pr_failed", { reason: "invalid_file", repo, path: file?.path });
      return errorResponse(400, "invalid_file", String(file?.path));
    }
  }
  const pat = typeof agentId === "string" ? patForAgent(env, agentId) : undefined;
  if (!pat) {
    await ledger(env).append("pr_failed", { reason: "credential_unconfigured", repo });
    return errorResponse(500, "credential_unconfigured");
  }

  try {
    const result = await openPullRequest(
      { token: pat, userAgent: "operon-gatekeeper-pr" },
      { repo, title, body: prBody, files },
      crypto.randomUUID()
    );
    await ledger(env).append("pr_opened", {
      agentId,
      repo,
      url: result.url,
      branch: result.branch,
      files: files.length
    });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("pr_failed", { reason: "github_error", repo, detail: detail.slice(0, 300) });
    return errorResponse(502, "pr_open_failed", detail.slice(0, 300));
  }
}

async function handleIssue(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) {
    await ledger(env).append("issue_denied", { status: denied.status });
    return denied;
  }
  const body = await readJson<{ agentId?: string; repo?: string; title?: string; body?: string }>(
    request
  );
  if (!body.ok) {
    await ledger(env).append("issue_failed", { reason: "malformed_json" });
    return errorResponse(400, "malformed_json");
  }
  const { repo, title, body: issueBody, agentId } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || !allowlist(env).includes(repo)) {
    await ledger(env).append("issue_failed", { reason: "repo_not_allowlisted", repo });
    return errorResponse(403, "repo_not_allowlisted", `allowed: ${allowlist(env).join(", ")}`);
  }
  if (typeof title !== "string" || !title || typeof issueBody !== "string" || !issueBody) {
    await ledger(env).append("issue_failed", { reason: "missing_title_or_body", repo });
    return errorResponse(400, "missing_title_or_body");
  }
  const pat = patForAgent(env, agentId as string);
  if (!pat) return errorResponse(500, "credential_unconfigured");
  try {
    const result = await openIssue(
      { token: pat, userAgent: "operon-gatekeeper-pr" },
      repo,
      title,
      issueBody
    );
    await ledger(env).append("issue_opened", { agentId, repo, url: result.url });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("issue_failed", { reason: "github_error", repo, detail: detail.slice(0, 300) });
    return errorResponse(502, "issue_open_failed", detail.slice(0, 300));
  }
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const pat = typeof body.value.agentId === "string" ? patForAgent(env, body.value.agentId) : undefined;
  if (!pat) return errorResponse(500, "credential_unconfigured");
  try {
    const activity = await listActivity({ token: pat, userAgent: "operon-gatekeeper-pr" }, allowlist(env));
    return json({ ok: true, ...activity });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    return errorResponse(502, "status_failed", detail.slice(0, 300));
  }
}


/**
 * Conversation policy. Reading a thread or commenting is allowed on any
 * item in an allowlisted repo (answering users' issues is the point) and
 * on any item this agent's own account authored anywhere (its own PRs on
 * outside repos). Updating or pushing to an item requires AUTHORSHIP, not
 * just the allowlist: an agent must never rewrite or close someone else's
 * thread, and pushes additionally require the PR's head to live on the
 * agent's own account (its fork), never a branch of the upstream repo.
 */

async function conversationAccess(
  env: Env,
  pat: string,
  repo: string,
  number: number
): Promise<{ ref: Awaited<ReturnType<typeof getIssueRef>>; own: boolean } | Response> {
  const login = await authenticatedLogin({ token: pat, userAgent: "operon-gatekeeper-pr" });
  const ref = await getIssueRef({ token: pat, userAgent: "operon-gatekeeper-pr" }, repo, number);
  const own = ref.author === login;
  if (!own && !allowlist(env).includes(repo)) {
    return errorResponse(403, "not_own_and_not_allowlisted", `${repo}#${number}`);
  }
  return { ref, own };
}

async function handleThread(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; repo?: string; number?: number }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  const pat = patForAgent(env, agentId as string);
  if (!pat) return errorResponse(500, "credential_unconfigured");
  try {
    const access = await conversationAccess(env, pat, repo, number);
    if (access instanceof Response) return access;
    return json({ ok: true, thread: await getThread({ token: pat, userAgent: "operon-gatekeeper-pr" }, repo, number) });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    return errorResponse(502, "thread_failed", detail.slice(0, 300));
  }
}

async function handleComment(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{
    agentId?: string;
    repo?: string;
    number?: number;
    body?: string;
    replyTo?: number;
  }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number, body: text, replyTo } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  if (typeof text !== "string" || !text) return errorResponse(400, "missing_body");
  const pat = patForAgent(env, agentId as string);
  if (!pat) return errorResponse(500, "credential_unconfigured");
  try {
    const access = await conversationAccess(env, pat, repo, number);
    if (access instanceof Response) {
      await ledger(env).append("comment_denied", { agentId, repo, number });
      return access;
    }
    const api = { token: pat, userAgent: "operon-gatekeeper-pr" };
    const result =
      typeof replyTo === "number"
        ? await replyToReviewComment(api, repo, number, replyTo, text)
        : await postComment(api, repo, number, text);
    await ledger(env).append("comment_posted", { agentId, repo, number, replyTo, url: result.url });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("comment_failed", { agentId, repo, number, detail: detail.slice(0, 300) });
    return errorResponse(502, "comment_failed", detail.slice(0, 300));
  }
}

async function handleUpdate(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{
    agentId?: string;
    repo?: string;
    number?: number;
    title?: string;
    body?: string;
    state?: string;
  }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number, title, body: text, state } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  if (state !== undefined && state !== "open" && state !== "closed") {
    return errorResponse(400, "invalid_state");
  }
  const patch: { title?: string; body?: string; state?: "open" | "closed" } = {};
  if (typeof title === "string" && title) patch.title = title;
  if (typeof text === "string" && text) patch.body = text;
  if (state) patch.state = state;
  if (Object.keys(patch).length === 0) return errorResponse(400, "empty_patch");
  const pat = patForAgent(env, agentId as string);
  if (!pat) return errorResponse(500, "credential_unconfigured");
  try {
    const access = await conversationAccess(env, pat, repo, number);
    if (access instanceof Response) return access;
    if (!access.own) {
      await ledger(env).append("update_denied", { agentId, repo, number, reason: "not_author" });
      return errorResponse(403, "not_author", "only the item's own author may update it");
    }
    const result = await updateIssue({ token: pat, userAgent: "operon-gatekeeper-pr" }, repo, number, patch);
    await ledger(env).append("item_updated", { agentId, repo, number, fields: Object.keys(patch) });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    return errorResponse(502, "update_failed", detail.slice(0, 300));
  }
}

async function handlePush(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{
    agentId?: string;
    repo?: string;
    number?: number;
    message?: string;
    files?: Array<{ path?: string; contentBase64?: string }>;
  }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number, message, files } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  if (typeof message !== "string" || !message) return errorResponse(400, "missing_message");
  if (!Array.isArray(files) || files.length === 0) return errorResponse(400, "no_files");
  for (const file of files) {
    if (
      typeof file?.path !== "string" ||
      !SAFE_PATH.test(file.path) ||
      file.path.includes("..") ||
      file.path.startsWith("/") ||
      typeof file.contentBase64 !== "string"
    ) {
      return errorResponse(400, "invalid_file", String(file?.path));
    }
  }
  const pat = patForAgent(env, agentId as string);
  if (!pat) return errorResponse(500, "credential_unconfigured");
  try {
    const api = { token: pat, userAgent: "operon-gatekeeper-pr" };
    const login = await authenticatedLogin(api);
    const ref = await getIssueRef(api, repo, number);
    if (ref.kind !== "pr") return errorResponse(400, "not_a_pr");
    if (ref.author !== login) {
      await ledger(env).append("push_denied", { agentId, repo, number, reason: "not_author" });
      return errorResponse(403, "not_author", "only the PR's own author may push to it");
    }
    if (!ref.headRepo || !ref.headBranch || !ref.headRepo.startsWith(`${login}/`)) {
      await ledger(env).append("push_denied", { agentId, repo, number, reason: "head_not_own_fork" });
      return errorResponse(403, "head_not_own_fork", String(ref.headRepo));
    }
    const result = await pushToPr(
      api,
      ref.headRepo,
      ref.headBranch,
      message,
      files as Array<{ path: string; contentBase64: string }>
    );
    await ledger(env).append("pr_pushed", { agentId, repo, number, commit: result.commitSha, files: files.length });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("push_failed", { agentId, repo, number, detail: detail.slice(0, 300) });
    return errorResponse(502, "push_failed", detail.slice(0, 300));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/gatekeeper/pr" && request.method === "POST") {
      return handlePr(request, env);
    }
    if (url.pathname === "/gatekeeper/issue" && request.method === "POST") {
      return handleIssue(request, env);
    }
    if (url.pathname === "/gatekeeper/status" && request.method === "POST") {
      return handleStatus(request, env);
    }
    if (url.pathname === "/gatekeeper/thread" && request.method === "POST") {
      return handleThread(request, env);
    }
    if (url.pathname === "/gatekeeper/comment" && request.method === "POST") {
      return handleComment(request, env);
    }
    if (url.pathname === "/gatekeeper/update" && request.method === "POST") {
      return handleUpdate(request, env);
    }
    if (url.pathname === "/gatekeeper/push" && request.method === "POST") {
      return handlePush(request, env);
    }
    if (url.pathname === "/gatekeeper/ledger" && request.method === "GET") {
      const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
      if (denied) return denied;
      return json(await ledger(env).recent());
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
