import { errorResponse, json, Ledger, OpsEntrypoint } from "@operon/worker-kit";
import { sessionNameFromPath } from "./audit.js";
import { WebSession } from "./session-do.js";

export { Ledger, WebSession };
export * from "./audit.js";

/**
 * The web door's Gatekeeper (spec 0004): the browser relay. This worker
 * has NO public surface (no routes, no workers_dev): the only way in is
 * the scheduler's service binding, which is the auth, and identity is
 * the x-operon-agent header the umbilical router asserts (a fact of the
 * supervisor, never a container claim).
 *
 * Spike scope: the CDP relay + audit ledger. Storage-state snapshots,
 * the WebMeter concurrency cap, credential fill, and passkeys are the
 * MVP phase (spec 0004 section 10).
 */

interface Env {
  CF_ACCOUNT_ID?: string;
  BROWSER_RUN_TOKEN?: string;
  WEB_SESSION: DurableObjectNamespace<WebSession>;
  LEDGER: DurableObjectNamespace<Ledger>;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("web"));
}

/** The operator's binding-only view (spec 0003 step 3). */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/gatekeeper/web/ledger") return json(await ledger(this.env).recent());
    return errorResponse(404, "not_found");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const agentId = request.headers.get("x-operon-agent");
    if (!agentId) return errorResponse(401, "agent_unasserted");
    const name = sessionNameFromPath(url.pathname);
    if (!name) return errorResponse(404, "unknown_web_path");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "websocket_required");
    }
    // One DO per (agent, session name): the session identity the spec
    // keys everything on. The name rides a query param so the DO does
    // not re-parse the path.
    const id = env.WEB_SESSION.idFromName(`${agentId}:${name}`);
    const target = new URL(request.url);
    target.searchParams.set("name", name);
    return env.WEB_SESSION.get(id).fetch(new Request(target.toString(), request));
  }
} satisfies ExportedHandler<Env>;
