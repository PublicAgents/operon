import { WorkerEntrypoint } from "cloudflare:workers";
import { policyDoorFor, resolveDoor } from "./umbilical-routes.js";

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
  [name: string]: unknown;
}

/** Per-wake identity, delivered as ctx.props by the loopback binding the
 * WakeContainer creates (ctx.exports.UmbilicalRouter({ props })); the
 * bearers + Gatekeeper bindings come from the worker env as usual. */
interface RouterProps {
  nonce?: string;
  agentId?: string;
  /** The wake this router serves (spec 0011): stored rows are identified by it, never by a payload. */
  wakeId?: string;
  /** The doors closed for this wake (spec 0006 §7): refused here, whatever the container asks. */
  closedDoors?: string[];
}

export class UmbilicalRouter extends WorkerEntrypoint<RouterEnv> {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx.props ?? {}) as RouterProps;
    const nonce = props.nonce;
    const agentId = props.agentId;
    if (!nonce || !agentId) return new Response("umbilical_unconfigured", { status: 503 });
    if (request.headers.get("authorization") !== `Bearer ${nonce}`) {
      return new Response("umbilical_denied", { status: 403 });
    }
    const url = new URL(request.url);
    const door = policyDoorFor(url.hostname, url.pathname);
    if (door && (props.closedDoors ?? []).includes(door)) {
      return new Response(`door_closed:${door}`, { status: 403 });
    }
    const resolved = resolveDoor(url.hostname, this.env, agentId);
    if ("error" in resolved) return new Response(resolved.error, { status: 502 });
    const binding = this.env[resolved.binding] as Fetcher | undefined;
    if (!binding) return new Response(`binding_unwired:${resolved.binding}`, { status: 502 });
    const headers = new Headers(request.headers);
    if (resolved.bearer) headers.set("authorization", `Bearer ${resolved.bearer}`);
    else headers.delete("authorization");
    headers.set("x-operon-agent", agentId);
    if (props.wakeId) headers.set("x-operon-wake", props.wakeId);
    const target = `https://internal${url.pathname}${url.search}`;
    // A WebSocket upgrade (the web door's CDP relay) must pass through
    // as an upgrade: build the forward from the ORIGINAL request so the
    // runtime carries the 101 + socket back, and never touch the body.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return binding.fetch(new Request(target, new Request(request, { headers })));
    }
    return binding.fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body
    });
  }
}
