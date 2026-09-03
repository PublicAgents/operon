import { WorkerEntrypoint } from "cloudflare:workers";
import { doorHost, MIND_DOOR, policyDoorFor, resolveDoor } from "./umbilical-routes.js";
import { judgeRelay } from "./mind-credential.js";
import type { FleetControl } from "./fleet-control.js";

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
  /** The doors closed for this wake (spec 0006 §7): refused here, whatever the container asks. */
  closedDoors?: string[];
  /** The harness this wake runs on and its credential's seed (spec 0010 §5). */
  harness?: string;
  mindSeed?: { fingerprint: string; account?: string };
}

export class UmbilicalRouter extends WorkerEntrypoint<RouterEnv> {
  private async relayCredential(request: Request, url: URL, props: RouterProps): Promise<Response> {
    if (url.pathname !== "/credential" || request.method !== "POST") {
      return new Response("mind_door_unknown_route", { status: 404 });
    }
    if (!props.harness || !props.mindSeed) return new Response("mind_door_unseeded", { status: 503 });
    const body = (await request.json().catch(() => ({}))) as { credential?: unknown };
    const verdict = judgeRelay(props.mindSeed.account, body.credential);
    if (!verdict.ok) return new Response(verdict.error, { status: 400 });
    const fleet = this.env.FLEET_CONTROL as DurableObjectNamespace<FleetControl> | undefined;
    if (!fleet) return new Response("binding_unwired:FLEET_CONTROL", { status: 502 });
    await fleet.get(fleet.idFromName("fleet")).setRefreshedCredential(
      props.harness,
      props.mindSeed.fingerprint,
      verdict.value
    );
    console.log(`[${props.agentId}] mind credential relayed for ${props.harness} (refreshed in-container)`);
    return Response.json({ ok: true });
  }

  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx.props ?? {}) as RouterProps;
    const nonce = props.nonce;
    const agentId = props.agentId;
    if (!nonce || !agentId) return new Response("umbilical_unconfigured", { status: 503 });
    if (request.headers.get("authorization") !== `Bearer ${nonce}`) {
      return new Response("umbilical_denied", { status: 403 });
    }
    const url = new URL(request.url);
    // The mind door (spec 0010 §5): handled here, never forwarded. The
    // container relays a credential its harness refreshed; it is stored
    // for later launches only under this wake's seed and account.
    if (url.hostname === doorHost(MIND_DOOR)) return this.relayCredential(request, url, props);
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
