import { dueAgents, findAgent, parseRoster, type RosterAgent } from "@operon/core";
import { errorResponse, json, requireBearer } from "@operon/worker-kit";
import {
  LaunchPreconditionError,
  prepareLaunch,
  type LaunchContext
} from "./launch.js";
import { WakeContainer } from "./wake-container.js";
import { DEFAULT_HARD_WALL_MS } from "./wake-lifecycle.js";

export { WakeContainer };
// Top-level export required: ctx.exports only sees top-level entrypoints.
export { UmbilicalRouter } from "./umbilical.js";
// Top-level export required: ctx.exports only sees top-level entrypoints.
export { EgressAudit } from "./egress-audit-entry.js";
export { mindCredentialVar, prepareLaunch, LaunchPreconditionError } from "./launch.js";

/**
 * A running wake older than this is REPORTED stale to the operator; nothing
 * is touched. The hard wall that actually stops a wake is separate,
 * generous, and per-agent (roster maxWakeMinutes, default 2h): stopping
 * loses unpushed work, so awareness comes early and force comes late.
 */
const STALE_AFTER_MS = 45 * 60 * 1000;

interface Env {
  ROSTER: string;
  WAKE_TRIGGER_TOKEN?: string;
  NOTIFY_URL?: string;
  NOTIFY_TOKEN?: string;
  PUBLISH_URL?: string;
  PUBLISH_TOKEN?: string;
  PERSIST_URL?: string;
  PERSIST_TOKEN?: string;
  PR_URL?: string;
  PR_TOKEN?: string;
  PR_REPOS?: string;
  EMAIL_URL?: string;
  EMAIL_TOKEN?: string;
  TILL_URL?: string;
  SPEND_URL?: string;
  VAULT_URL?: string;
  CHRONICLE_URL?: string;
  CHRONICLE_TOKEN?: string;
  X_URL?: string;
  // Per-agent money bearers arrive as TILL_TOKEN_<AGENTID> secrets via the
  // existing index signature below (spec 0002 §3).
  SECRET_DENYLIST?: string;
  HARNESS_EXTRA_ARGS?: string;
  WAKE_CONTAINER: DurableObjectNamespace<WakeContainer>;
  GITHUB_GATEKEEPER?: Fetcher;
  [secretName: string]: unknown;
}

function launchContext(env: Env): LaunchContext {
  return {
    getSecret(name) {
      const value = env[name];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
    async getGithubToken(agent: RosterAgent) {
      if (!env.GITHUB_GATEKEEPER) {
        throw new LaunchPreconditionError(
          "github_gatekeeper_unbound",
          "no GITHUB_GATEKEEPER service binding; a wake cannot reach its state repo"
        );
      }
      const serviceToken = env.GITHUB_TOKEN_SERVICE_TOKEN;
      if (typeof serviceToken !== "string" || serviceToken.length === 0) {
        throw new LaunchPreconditionError(
          "github_service_token_missing",
          "secret GITHUB_TOKEN_SERVICE_TOKEN is not configured"
        );
      }
      const response = await env.GITHUB_GATEKEEPER.fetch(
        "https://github-gatekeeper.internal/token",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${serviceToken}`
          },
          body: JSON.stringify({ agentId: agent.id })
        }
      );
      if (!response.ok) {
        throw new LaunchPreconditionError(
          "github_token_mint_failed",
          `gatekeeper answered ${response.status}: ${await response.text()}`
        );
      }
      const { token } = (await response.json()) as { token: string };
      return token;
    },
    options: {
      notifyUrl: env.NOTIFY_URL,
      notifyToken: env.NOTIFY_TOKEN,
      publishUrl: env.PUBLISH_URL,
      publishToken: env.PUBLISH_TOKEN,
      persistUrl: env.PERSIST_URL,
      persistToken: env.PERSIST_TOKEN,
      prUrl: env.PR_URL,
      prToken: env.PR_TOKEN,
      prRepos: env.PR_REPOS,
      emailUrl: env.EMAIL_URL,
      emailToken: env.EMAIL_TOKEN,
      tillUrl: env.TILL_URL,
      spendUrl: env.SPEND_URL,
      vaultUrl: env.VAULT_URL,
      chronicleUrl: env.CHRONICLE_URL,
      chronicleToken: env.CHRONICLE_TOKEN,
      xUrl: env.X_URL,
      secretDenylist: env.SECRET_DENYLIST,
      harnessExtraArgs: env.HARNESS_EXTRA_ARGS
    }
  };
}

async function wake(
  env: Env,
  agent: RosterAgent,
  trigger: "cron" | "manual"
): Promise<{ status: string; wakeId?: string; detail?: string }> {
  const wakeId = crypto.randomUUID();
  const stub = env.WAKE_CONTAINER.get(env.WAKE_CONTAINER.idFromName(agent.id));
  try {
    const prepared = await prepareLaunch(agent, trigger, wakeId, launchContext(env));
    const result = await stub.launch({
      ...prepared,
      staleAfterMs: STALE_AFTER_MS,
      hardWallMs: agent.maxWakeMinutes
        ? agent.maxWakeMinutes * 60_000
        : DEFAULT_HARD_WALL_MS
    });
    if (result.status === "locked") {
      const detail = result.stale
        ? `wake ${result.wakeId} running since ${result.startedAt} is past the stale threshold`
        : `wake ${result.wakeId} still running`;
      await notify(env, `[${agent.id}] wake skipped: ${detail}`);
      return { status: "locked", wakeId: result.wakeId, detail };
    }
    if (result.status === "disabled") {
      // Deliberate operator state, notified only for manual wakes: a cron
      // firing against a disabled agent is the kill switch doing its job,
      // and alerting on every cron tick would be noise.
      if (trigger === "manual") {
        await notify(env, `[${agent.id}] wake refused: disabled by operator (/enable ${agent.id} to lift)`);
      }
      return { status: "disabled", detail: "disabled by operator" };
    }
    if (result.status === "error") {
      await notify(env, `[${agent.id}] wake ${wakeId} failed to start: ${result.error}`);
      return { status: "error", wakeId, detail: result.error };
    }
    return { status: "started", wakeId };
  } catch (error) {
    const detail =
      error instanceof LaunchPreconditionError ? error.message : String(error);
    await stub.recordFailure({ wakeId, agentId: agent.id, trigger }, detail);
    await notify(env, `[${agent.id}] wake ${wakeId} failed preconditions: ${detail}`);
    return { status: "error", wakeId, detail };
  }
}

/** Best-effort operator alert through the telegram Gatekeeper; never throws. */
async function notify(env: Env, text: string): Promise<void> {
  if (!env.NOTIFY_URL || !env.NOTIFY_TOKEN) return;
  try {
    const response = await fetch(env.NOTIFY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.NOTIFY_TOKEN}`
      },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      console.error(
        `notify rejected: ${response.status} ${(await response.text()).slice(0, 200)}`
      );
    }
  } catch (error) {
    console.error("notify failed", error);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    const roster = parseRoster(env.ROSTER);
    const due = dueAgents(roster, controller.cron);
    console.log(`cron "${controller.cron}": ${due.length} agent(s) due`);
    for (const agent of due) {
      ctx.waitUntil(wake(env, agent, "cron"));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const wakeMatch = /^\/wake\/([a-z0-9-]+)$/.exec(url.pathname);
    if (wakeMatch && request.method === "POST") {
      const denied = requireBearer(request, env.WAKE_TRIGGER_TOKEN);
      if (denied) return denied;
      const roster = parseRoster(env.ROSTER);
      const agent = findAgent(roster, wakeMatch[1]);
      if (!agent) return errorResponse(404, "unknown_agent", wakeMatch[1]);
      if (!agent.enabled) return errorResponse(409, "agent_disabled", agent.id);
      return json(await wake(env, agent, "manual"));
    }

    const toggleMatch = /^\/(disable|enable)\/([a-z0-9-]+)$/.exec(url.pathname);
    if (toggleMatch && request.method === "POST") {
      const denied = requireBearer(request, env.WAKE_TRIGGER_TOKEN);
      if (denied) return denied;
      const roster = parseRoster(env.ROSTER);
      const agent = findAgent(roster, toggleMatch[2]);
      if (!agent) return errorResponse(404, "unknown_agent", toggleMatch[2]);
      const stub = env.WAKE_CONTAINER.get(env.WAKE_CONTAINER.idFromName(agent.id));
      const result = await stub.setDisabled(toggleMatch[1] === "disable");
      console.log(`operator ${toggleMatch[1]}: ${agent.id}`, JSON.stringify(result));
      return json({ agentId: agent.id, ...result });
    }

    if (url.pathname === "/agents" && request.method === "GET") {
      const denied = requireBearer(request, env.WAKE_TRIGGER_TOKEN);
      if (denied) return denied;
      const roster = parseRoster(env.ROSTER);
      // The roster joined with each agent's live supervisor state: the
      // console's dashboard source. One status() per agent is fine at
      // roster scale; batch if rosters ever grow past dozens.
      const agents = await Promise.all(
        roster.agents.map(async agent => {
          const stub = env.WAKE_CONTAINER.get(env.WAKE_CONTAINER.idFromName(agent.id));
          const status = await stub.status();
          return {
            id: agent.id,
            enabled: agent.enabled,
            cadence: agent.cadence,
            harness: agent.harness,
            model: agent.model,
            hosts: agent.hosts,
            web: agent.web === true,
            disabled: status.disabled,
            ...(status.current ? { currentWake: status.current } : {})
          };
        })
      );
      return json({ zone: roster.zone, agents });
    }

    const wakesMatch = /^\/wakes\/([a-z0-9-]+)$/.exec(url.pathname);
    if (wakesMatch && request.method === "GET") {
      const denied = requireBearer(request, env.WAKE_TRIGGER_TOKEN);
      if (denied) return denied;
      const stub = env.WAKE_CONTAINER.get(env.WAKE_CONTAINER.idFromName(wakesMatch[1]));
      return json(await stub.wakes());
    }

    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
