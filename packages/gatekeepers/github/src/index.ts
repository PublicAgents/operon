import { findAgent, parseRoster, type RosterAgent } from "@operon/core";
import {
  errorResponse,
  json,
  readJson,
  requireBearer,
  Ledger,
  commitToBranch,
  GitDataError,
  type GitFile
} from "@operon/worker-kit";
import { signAppJwt } from "./app-jwt.js";

export { Ledger };
export { signAppJwt, pemToPkcs8Bytes } from "./app-jwt.js";

/**
 * The github Gatekeeper holds the GitHub App and does two things for an
 * agent's own state repo, with the credential never leaving this Worker:
 *
 *  - /token: mint a short-lived, READ-ONLY installation token for the
 *    initial clone (the container needs a local copy to work in). Read
 *    only, so a leaked clone token can only read the agent's own memory,
 *    which the mind already has.
 *  - /commit: persist the wake's file changes by committing them to the
 *    state repo through the Git Data API. No push token ever enters the
 *    container; the container only sends file data.
 */

interface Env {
  ROSTER: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  TOKEN_SERVICE_TOKEN?: string;
  COMMIT_SERVICE_TOKEN?: string;
  LEDGER: DurableObjectNamespace<Ledger>;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("github"));
}

function appConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID);
}

/** Mint an installation token scoped to one repo with the given permission. */
async function installationToken(
  env: Env,
  repoName: string,
  permission: "read" | "write"
): Promise<{ token: string; expiresAt: string }> {
  const jwt = await signAppJwt(env.GITHUB_APP_ID as string, env.GITHUB_APP_PRIVATE_KEY as string);
  const response = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "operon-gatekeeper-github"
      },
      body: JSON.stringify({ repositories: [repoName], permissions: { contents: permission } })
    }
  );
  if (!response.ok) {
    throw new GitDataError(response.status, (await response.text()).slice(0, 300));
  }
  const { token, expires_at } = (await response.json()) as { token: string; expires_at: string };
  return { token, expiresAt: expires_at };
}

async function resolveAgent(
  env: Env,
  agentId: unknown
): Promise<RosterAgent | Response> {
  if (typeof agentId !== "string") return errorResponse(400, "missing_agent_id");
  const agent = findAgent(parseRoster(env.ROSTER), agentId);
  if (!agent) return errorResponse(404, "unknown_agent", agentId);
  return agent;
}

async function mintCloneToken(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.TOKEN_SERVICE_TOKEN);
  if (denied) {
    await ledger(env).append("token_denied", { status: denied.status });
    return denied;
  }
  const body = await readJson<{ agentId?: string }>(request);
  if (!body.ok) {
    await ledger(env).append("token_failed", { reason: "malformed_json" });
    return errorResponse(400, "malformed_json");
  }
  const agent = await resolveAgent(env, body.value.agentId);
  if (agent instanceof Response) return agent;
  if (!appConfigured(env)) {
    await ledger(env).append("token_failed", { reason: "app_unconfigured", agentId: agent.id });
    return errorResponse(500, "github_app_unconfigured");
  }
  try {
    const [, repoName] = agent.stateRepo.split("/");
    // READ-only: the container clones with this and never pushes.
    const { token, expiresAt } = await installationToken(env, repoName, "read");
    await ledger(env).append("clone_token_minted", { agentId: agent.id, repository: agent.stateRepo, expiresAt });
    return json({ token, expiresAt, repository: agent.stateRepo });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("token_failed", { reason: "github_api_error", agentId: agent.id, detail });
    return errorResponse(502, "github_api_error", detail.slice(0, 300));
  }
}

async function commitState(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.COMMIT_SERVICE_TOKEN);
  if (denied) {
    await ledger(env).append("commit_denied", { status: denied.status });
    return denied;
  }
  const body = await readJson<{
    agentId?: string;
    message?: string;
    files?: GitFile[];
    deletions?: string[];
  }>(request);
  if (!body.ok) {
    await ledger(env).append("commit_failed", { reason: "malformed_json" });
    return errorResponse(400, "malformed_json");
  }
  const agent = await resolveAgent(env, body.value.agentId);
  if (agent instanceof Response) return agent;
  if (!appConfigured(env)) {
    await ledger(env).append("commit_failed", { reason: "app_unconfigured", agentId: agent.id });
    return errorResponse(500, "github_app_unconfigured");
  }

  const { message, files, deletions } = body.value;
  if (typeof message !== "string" || message.length === 0) {
    return errorResponse(400, "missing_message");
  }
  const safeFiles = Array.isArray(files) ? files : [];
  const safeDeletions = Array.isArray(deletions) ? deletions : [];
  if (safeFiles.length === 0 && safeDeletions.length === 0) {
    await ledger(env).append("commit_noop", { agentId: agent.id });
    return json({ ok: true, noop: true });
  }
  for (const file of safeFiles) {
    if (
      typeof file?.path !== "string" ||
      file.path.includes("..") ||
      file.path.startsWith("/") ||
      typeof file.contentBase64 !== "string"
    ) {
      await ledger(env).append("commit_failed", { reason: "invalid_file", agentId: agent.id, path: file?.path });
      return errorResponse(400, "invalid_file", String(file?.path));
    }
  }

  try {
    const [, repoName] = agent.stateRepo.split("/");
    const { token } = await installationToken(env, repoName, "write");
    const result = await commitToBranch(
      { token, userAgent: "operon-gatekeeper-github" },
      agent.stateRepo,
      { message, files: safeFiles, deletions: safeDeletions }
    );
    await ledger(env).append("committed", {
      agentId: agent.id,
      repository: agent.stateRepo,
      commit: result.commitSha,
      files: safeFiles.length,
      deletions: safeDeletions.length
    });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("commit_failed", { reason: "github_api_error", agentId: agent.id, detail: detail.slice(0, 300) });
    return errorResponse(502, "commit_failed", detail.slice(0, 300));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/token" && request.method === "POST") return mintCloneToken(request, env);
    if (url.pathname === "/commit" && request.method === "POST") return commitState(request, env);
    if (url.pathname === "/ledger" && request.method === "GET") {
      const denied = requireBearer(request, env.TOKEN_SERVICE_TOKEN);
      if (denied) return denied;
      return json(await ledger(env).recent());
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
