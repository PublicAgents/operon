import { findAgent, parseRoster } from "@operon/core";
import { errorResponse, json, readJson, requireBearer, Ledger } from "@operon/worker-kit";
import { signAppJwt } from "./app-jwt.js";

export { Ledger };
export { signAppJwt, pemToPkcs8Bytes } from "./app-jwt.js";

interface Env {
  ROSTER: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  TOKEN_SERVICE_TOKEN?: string;
  LEDGER: DurableObjectNamespace<Ledger>;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("github"));
}

async function mintToken(request: Request, env: Env): Promise<Response> {
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
  const { agentId } = body.value;
  if (typeof agentId !== "string") {
    await ledger(env).append("token_failed", { reason: "missing_agent_id" });
    return errorResponse(400, "missing_agent_id");
  }
  const agent = findAgent(parseRoster(env.ROSTER), agentId);
  if (!agent) {
    await ledger(env).append("token_failed", { reason: "unknown_agent", agentId });
    return errorResponse(404, "unknown_agent", agentId);
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_INSTALLATION_ID) {
    await ledger(env).append("token_failed", { reason: "app_unconfigured", agentId });
    return errorResponse(500, "github_app_unconfigured");
  }

  const [, repoName] = agent.stateRepo.split("/");
  const jwt = await signAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
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
      body: JSON.stringify({
        repositories: [repoName],
        permissions: { contents: "write" }
      })
    }
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    await ledger(env).append("token_failed", {
      reason: "github_api_error",
      agentId,
      status: response.status,
      detail
    });
    return errorResponse(502, "github_api_error", `${response.status}: ${detail}`);
  }

  const { token, expires_at } = (await response.json()) as {
    token: string;
    expires_at: string;
  };
  await ledger(env).append("token_minted", {
    agentId,
    repository: agent.stateRepo,
    expiresAt: expires_at
  });
  return json({ token, expiresAt: expires_at, repository: agent.stateRepo });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/token" && request.method === "POST") {
      return mintToken(request, env);
    }
    if (url.pathname === "/ledger" && request.method === "GET") {
      const denied = requireBearer(request, env.TOKEN_SERVICE_TOKEN);
      if (denied) return denied;
      return json(await ledger(env).recent());
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
