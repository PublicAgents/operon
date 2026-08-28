import { errorResponse, json, readJson, Ledger, OpsEntrypoint } from "@operon/worker-kit";
import { sessionNameFromPath, SESSION_NAME } from "./audit.js";
import { WebSession } from "./session-do.js";
import { WebMeter } from "./meter-do.js";

export { Ledger, WebSession, WebMeter };
export * from "./audit.js";
export * from "./cdp-policy.js";

/**
 * The web door's Gatekeeper (spec 0004): the browser relay. This worker
 * has NO public surface (no routes, no workers_dev): the only way in is
 * a service binding, which is the auth, and identity is the
 * x-operon-agent header the umbilical router asserts (a fact of the
 * supervisor, never a container claim).
 */

interface Env {
  CF_ACCOUNT_ID?: string;
  BROWSER_RUN_TOKEN?: string;
  WEB_ORIGIN_DENYLIST?: string;
  /** Concurrent sessions one agent may hold open (spec 0004: 3; one is the norm). */
  WEB_MAX_CONCURRENT?: string;
  WEB_SESSION: DurableObjectNamespace<WebSession>;
  WEB_METER: DurableObjectNamespace<WebMeter>;
  LEDGER: DurableObjectNamespace<Ledger>;
}

const DEFAULT_MAX_CONCURRENT = 3;

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("web"));
}

function session(env: Env, agentId: string, name: string) {
  return env.WEB_SESSION.get(env.WEB_SESSION.idFromName(`${agentId}:${name}`));
}

/** One meter per agent: the concurrency cap is an aggregate, never per session. */
function meter(env: Env, agentId: string) {
  return env.WEB_METER.get(env.WEB_METER.idFromName(agentId));
}

function maxConcurrent(env: Env): number {
  const parsed = Number(env.WEB_MAX_CONCURRENT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_CONCURRENT;
}

/** The operator's binding-only view (spec 0003 step 3). */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/gatekeeper/web/ledger") {
      return json(await ledger(this.env).recent());
    }
    // Sessions for one agent: name, where it is logged in (domains, never
    // values), live/saved, and this wake's usage.
    if (url.pathname === "/gatekeeper/web/sessions") {
      const agentId = url.searchParams.get("agentId");
      if (!agentId) return errorResponse(400, "agent_required");
      const agentMeter = meter(this.env, agentId);
      const known = await agentMeter.sessions();
      const sessions = [];
      for (const name of known) {
        const detail = (await session(this.env, agentId, name).describe()) as Record<string, unknown>;
        sessions.push({ name, ...detail });
      }
      return json({ ok: true, agentId, sessions, usage: await agentMeter.usage() });
    }
    // The remote logout: kill the live relay, bump the generation, drop
    // the state, so an in-flight snapshot cannot resurrect it.
    if (url.pathname === "/gatekeeper/web/delete") {
      const body = await readJson<{ agentId?: unknown; name?: unknown }>(request);
      if (!body.ok) return errorResponse(400, "invalid_body");
      const { agentId, name } = body.value;
      if (typeof agentId !== "string" || typeof name !== "string" || !SESSION_NAME.test(name)) {
        return errorResponse(400, "agent_and_name_required");
      }
      const result = await session(this.env, agentId, name).destroySession();
      await meter(this.env, agentId).forget(name);
      await ledger(this.env).append("web_session_deleted", { agentId, name });
      return json({ ok: true, ...result });
    }
    return errorResponse(404, "not_found");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const agentId = request.headers.get("x-operon-agent");
    if (!agentId) return errorResponse(401, "agent_unasserted");

    // Door-side credential minting: the value is generated HERE and the
    // mind only ever learns the placeholder (spec 0004).
    if (url.pathname === "/gatekeeper/web/credential" && request.method === "POST") {
      const body = await readJson<{ name?: unknown; domains?: unknown }>(request);
      if (!body.ok) return errorResponse(400, "invalid_body");
      const name = body.value.name;
      const domains = body.value.domains;
      if (typeof name !== "string" || !SESSION_NAME.test(name)) return errorResponse(400, "bad_name");
      if (!Array.isArray(domains) || domains.length === 0) return errorResponse(400, "domains_required");
      const value = mintPassword();
      await session(env, agentId, name).putCredential(
        name,
        value,
        domains.filter((d): d is string => typeof d === "string")
      );
      await ledger(env).append("web_credential_minted", { agentId, name, domains });
      // The placeholder, never the value.
      return json({ ok: true, placeholder: `{{vault:web/${name}}}` });
    }

    // The agent's own view of its sessions (names + domains, no values).
    if (url.pathname === "/gatekeeper/web/sessions/list" && request.method === "POST") {
      const agentMeter = meter(env, agentId);
      const sessions = [];
      for (const known of await agentMeter.sessions()) {
        const detail = (await session(env, agentId, known).describe()) as Record<string, unknown>;
        sessions.push({ name: known, ...detail });
      }
      return json({ ok: true, sessions, usage: await agentMeter.usage() });
    }

    // End a live relay but KEEP the saved identity (that is what makes a
    // named session resumable next wake); delete is operator-only.
    if (url.pathname === "/gatekeeper/web/close" && request.method === "POST") {
      const body = await readJson<{ name?: unknown }>(request);
      if (!body.ok) return errorResponse(400, "invalid_body");
      const target = body.value.name;
      if (typeof target !== "string" || !SESSION_NAME.test(target)) return errorResponse(400, "bad_name");
      await session(env, agentId, target).closeLive();
      await ledger(env).append("web_session_closed_by_agent", { agentId, name: target });
      return json({ ok: true, closed: target });
    }

    const name = sessionNameFromPath(url.pathname);
    if (!name) return errorResponse(404, "unknown_web_path");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "websocket_required");
    }

    // The concurrency cap is per AGENT and aggregate: N sessions never
    // means N budgets (spec 0004 section 5).
    const wakeId = request.headers.get("x-operon-wake") ?? "unknown";
    const admitted = await meter(env, agentId).admit(name, wakeId, maxConcurrent(env));
    if (!admitted.ok) {
      await ledger(env).append("web_session_refused", { agentId, name, reason: admitted.reason });
      return errorResponse(429, admitted.reason, `concurrency cap is ${maxConcurrent(env)}`);
    }

    const target = new URL(request.url);
    target.searchParams.set("name", name);
    target.searchParams.set("wake", wakeId);
    return session(env, agentId, name).fetch(new Request(target.toString(), request));
  }
} satisfies ExportedHandler<Env>;

/** A strong password, minted door-side; the mind never sees the value. */
function mintPassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}
