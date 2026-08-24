import { errorResponse, json, readJson, requireBearer, Ledger } from "@operon/worker-kit";
import { GithubError, openPullRequest, type PrRequest } from "./github.js";

export { Ledger };
export * from "./github.js";

/**
 * The PR Gatekeeper: opens fork-based pull requests for allowlisted repos
 * through the GitHub API. It holds the machine credential; no wake
 * container ever does. Callers (the porch) authenticate with an internal
 * bearer and submit file DATA; this Worker turns it into a PR.
 */

interface Env {
  MACHINE_PAT?: string;
  PR_SERVICE_TOKEN?: string;
  PR_REPOS?: string;
  LEDGER: DurableObjectNamespace<Ledger>;
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
  if (!env.MACHINE_PAT) {
    await ledger(env).append("pr_failed", { reason: "credential_unconfigured", repo });
    return errorResponse(500, "credential_unconfigured");
  }

  try {
    const result = await openPullRequest(
      { token: env.MACHINE_PAT, branchSuffix: crypto.randomUUID() },
      { repo, title, body: prBody, files }
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
    const detail = error instanceof GithubError ? error.message : String(error);
    await ledger(env).append("pr_failed", { reason: "github_error", repo, detail: detail.slice(0, 300) });
    return errorResponse(502, "pr_open_failed", detail.slice(0, 300));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/gatekeeper/pr" && request.method === "POST") {
      return handlePr(request, env);
    }
    if (url.pathname === "/gatekeeper/ledger" && request.method === "GET") {
      const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
      if (denied) return denied;
      return json(await ledger(env).recent());
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
