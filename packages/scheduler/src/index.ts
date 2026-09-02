import { WorkerEntrypoint } from "cloudflare:workers";
import { dueAgents, findAgent, parseRoster, type RosterAgent , DOORS, isDoor } from "@operon/core";
import { errorResponse, json, requireBearer,
  notifyOperator,
  type TelegramGatewayBinding
} from "@operon/worker-kit";
import {
  LaunchPreconditionError,
  prepareLaunch,
  type LaunchContext
} from "./launch.js";
import { effectiveDoors } from "./doors.js";
import { WakeContainer } from "./wake-container.js";
export { FleetControl } from "./fleet-control.js";

/**
 * The authoritative answer to "which wake is this agent running right
 * now", binding-only (spec 0007 §3). A Gatekeeper that quotas per wake
 * must not take the wake id from its caller: the scheduler owns the
 * supervisor lock, so it is the only honest source.
 */
export class WakeQuery extends WorkerEntrypoint<Env> {
  async currentWakeId(agentId: string): Promise<string | null> {
    const roster = parseRoster(this.env.ROSTER);
    const agent = findAgent(roster, agentId);
    if (!agent) return null;
    const stub = this.env.WAKE_CONTAINER.get(this.env.WAKE_CONTAINER.idFromName(agent.id));
    const status = await stub.status();
    return status.current?.wakeId ?? null;
  }
}
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
  FLEET_CONTROL: DurableObjectNamespace<import("./fleet-control.js").FleetControl>;
  ROSTER: string;
  WAKE_TRIGGER_TOKEN?: string;
  NOTIFY_TOKEN?: string;
  /** The telegram Gatekeeper over a service binding: how this Worker alerts the operator. */
  TELEGRAM?: TelegramGatewayBinding;
  PUBLISH_TOKEN?: string;
  PERSIST_TOKEN?: string;
  PR_TOKEN?: string;
  PR_REPOS?: string;
  EMAIL_TOKEN?: string;
  CHRONICLE_TOKEN?: string;
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
    getDoorOverrides: agentId => fleetControl(env).doorOverrides(agentId),
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
    // Door URLs and bearers are the umbilical's (spec 0003 step 4): the
    // launch wires virtual hosts and the per-wake nonce, and the real
    // bearers stay in this env for the router. Nothing public remains
    // to hand over (spec 0009).
    options: {
      prRepos: env.PR_REPOS,
      secretDenylist: env.SECRET_DENYLIST,
      harnessExtraArgs: env.HARNESS_EXTRA_ARGS
    }
  };
}

function fleetControl(env: Env) {
  return env.FLEET_CONTROL.get(env.FLEET_CONTROL.idFromName("fleet"));
}

async function wake(
  env: Env,
  agent: RosterAgent,
  trigger: "cron" | "manual"
): Promise<{ status: string; wakeId?: string; detail?: string }> {
  // The fleet pause (spec 0006 §5): a deploy drain defers NEW wakes and
  // never touches one in flight. A paused cron fires again at its next
  // cadence; manual wakes answer with the pause reason.
  const pauseState = await fleetControl(env).state();
  if (pauseState.paused) {
    if (trigger === "manual") {
      return { status: "paused", detail: `fleet paused: ${pauseState.reason}` };
    }
    console.log(`[${agent.id}] cron wake deferred: fleet paused (${pauseState.reason})`);
    return { status: "paused", detail: pauseState.reason };
  }
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
    if (result.status === "paused") {
      // The launch-level pause refusal (the registration-adjacent
      // check); same meaning as the early check above.
      return { status: "paused", detail: result.detail };
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

/** Best-effort operator alert over the TELEGRAM binding (spec 0009); never throws. */
async function notify(env: Env, text: string): Promise<void> {
  await notifyOperator(env, text);
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

    if (url.pathname === "/pause" && request.method === "POST") {
      const denied = requireBearer(request, env.WAKE_TRIGGER_TOKEN);
      if (denied) return denied;
      const body = (await request.json().catch(() => ({}))) as { reason?: string; token?: string };
      const reason = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "operator pause";
      const token = typeof body.token === "string" && body.token.length > 0 ? body.token : "operator";
      const result = await fleetControl(env).pause(reason.slice(0, 200), token.slice(0, 80));
      if (!result.ok) {
        return errorResponse(409, "fleet_already_paused", `held since ${result.at}: ${result.reason}`);
      }
      return json({ ok: true, paused: true, reason });
    }
    if (url.pathname === "/resume" && request.method === "POST") {
      const denied = requireBearer(request, env.WAKE_TRIGGER_TOKEN);
      if (denied) return denied;
      const body = (await request.json().catch(() => ({}))) as { token?: string; force?: boolean };
      const token = typeof body.token === "string" && body.token.length > 0 ? body.token : "operator";
      const result = await fleetControl(env).resume(token.slice(0, 80), body.force === true);
      if (!result.ok) {
        return errorResponse(409, "pause_held_elsewhere", "another holder's pause; pass force to override");
      }
      return json({ ok: true, paused: false, wasPaused: result.wasPaused });
    }

    // ---- the doors matrix (spec 0006 §7) ------------------------------
    const doorsMatch = /^\/doors\/([a-z0-9-]+)$/.exec(url.pathname);
    if (doorsMatch && (request.method === "GET" || request.method === "POST")) {
      const denied = requireBearer(request, env.WAKE_TRIGGER_TOKEN);
      if (denied) return denied;
      const roster = parseRoster(env.ROSTER);
      const agent = findAgent(roster, doorsMatch[1]);
      if (!agent) return errorResponse(404, "unknown_agent", doorsMatch[1]);
      const control = fleetControl(env);
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { door?: unknown; enabled?: unknown };
        if (!isDoor(body.door)) {
          return errorResponse(400, "unknown_door", `door must be one of ${DOORS.join(", ")}`);
        }
        if (body.enabled !== null && typeof body.enabled !== "boolean") {
          return errorResponse(400, "invalid_enabled", "enabled must be true, false, or null (clear the override)");
        }
        await control.setDoor(agent.id, body.door, body.enabled as boolean | null);
        console.log(`operator door ${body.door}=${String(body.enabled)}: ${agent.id}`);
      }
      const doors = effectiveDoors(agent, await control.doorOverrides(agent.id));
      return json({ agentId: agent.id, doors, effectiveAt: "next wake" });
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
      const pauseState = await fleetControl(env).state();
      return json({
        zone: roster.zone,
        agents,
        ...(pauseState.paused ? { paused: { at: pauseState.at, reason: pauseState.reason } } : {})
      });
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
