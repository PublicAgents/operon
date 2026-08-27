import { WorkerEntrypoint } from "cloudflare:workers";
import { resolveDoor } from "./umbilical-routes.js";

/**
 * The umbilical router (spec 0003 step 4): container door egress goes
 * through the supervisor, so no door credential rides in the container.
 * Runs in the Workers runtime on the same machine, OUTSIDE the container
 * sandbox. It validates the per-wake nonce (a browser page or the mind
 * cannot read the root-held nonce, so cannot reach the doors), maps the
 * virtual host to the owning Gatekeeper binding, swaps the nonce for the
 * REAL bearer (the per-agent one for THIS container's agent), and
 * forwards over the private binding.
 */
interface RouterEnv {
  OPERON_UMBILICAL_NONCE?: string;
  OPERON_ROUTED_AGENT?: string;
  [name: string]: unknown;
}

export class UmbilicalRouter extends WorkerEntrypoint<RouterEnv> {
  override async fetch(request: Request): Promise<Response> {
    const nonce = this.env.OPERON_UMBILICAL_NONCE;
    const agentId = this.env.OPERON_ROUTED_AGENT;
    if (!nonce || !agentId) return new Response("umbilical_unconfigured", { status: 503 });
    if (request.headers.get("authorization") !== `Bearer ${nonce}`) {
      return new Response("umbilical_denied", { status: 403 });
    }
    const url = new URL(request.url);
    const resolved = resolveDoor(url.hostname, this.env, agentId);
    if ("error" in resolved) return new Response(resolved.error, { status: 502 });
    const binding = this.env[resolved.binding] as Fetcher | undefined;
    if (!binding) return new Response(`binding_unwired:${resolved.binding}`, { status: 502 });
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${resolved.bearer}`);
    headers.set("x-operon-agent", agentId);
    return binding.fetch(`https://internal${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body
    });
  }
}
