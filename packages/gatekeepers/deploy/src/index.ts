import { parseRoster } from "@operon/core";
import { errorResponse, json, readJson, requireBearer, Ledger, OpsEntrypoint } from "@operon/worker-kit";
import {
  hostLabel,
  storagePath,
  validatePublish,
  type PublishRequest
} from "./gates.js";
import { SitePublisher } from "./site-publisher.js";

export { Ledger, SitePublisher };

/** The operator's binding-only view of the deploy ledger (spec 0003 step 3). */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/gatekeeper/deploy/ledger") return json(await ledger(this.env).recent());
    return errorResponse(404, "not_found");
  }
}
export * from "./gates.js";

/**
 * The publish Gatekeeper is both the door and the floor: it accepts swept
 * publish payloads from the porch (bearer-authenticated, gate-checked, KV
 * full-replace per host) and serves every agent site from that KV on the
 * colony zone's hosts. Serving is public; publishing and the ledger are
 * not.
 */

interface Env {
  ROSTER: string;
  PUBLISH_TOKEN?: string;
  DISCLOSURE_MARKER?: string;
  SECRET_DENYLIST?: string;
  SITE_STORE: KVNamespace;
  SITE_PUBLISHER: DurableObjectNamespace<SitePublisher>;
  LEDGER: DurableObjectNamespace<Ledger>;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("deploy"));
}

function fileKey(host: string, path: string): string {
  return `f:${host}:${path}`;
}

async function handlePublish(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PUBLISH_TOKEN);
  if (denied) {
    await ledger(env).append("publish_denied", { status: denied.status });
    return denied;
  }
  const body = await readJson<PublishRequest>(request);
  if (!body.ok) {
    await ledger(env).append("publish_failed", { reason: "malformed_json" });
    return errorResponse(400, "malformed_json");
  }
  const roster = parseRoster(env.ROSTER);
  const denylist = (env.SECRET_DENYLIST ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  const gateError = validatePublish(
    roster,
    body.value,
    env.DISCLOSURE_MARKER ?? "",
    denylist
  );
  if (gateError) {
    await ledger(env).append("publish_failed", {
      agentId: body.value.agentId,
      host: body.value.host,
      reason: gateError.code,
      detail: gateError.detail.slice(0, 300)
    });
    return errorResponse(422, gateError.code, gateError.detail);
  }

  const { host, files, agentId } = body.value;
  // Single writer per host: the per-host Durable Object serializes the
  // whole write-delete-manifest sequence against concurrent publishes.
  const publisher = env.SITE_PUBLISHER.get(env.SITE_PUBLISHER.idFromName(host));
  const outcome = await publisher.publishFiles(host, files);

  await ledger(env).append("published", {
    agentId,
    host,
    files: outcome.files,
    removed: outcome.removed
  });
  return json({ ok: true, host, files: outcome.files });
}

async function serve(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const zone = parseRoster(env.ROSTER).zone;
  const label = hostLabel(zone, url.hostname);
  if (!label) return errorResponse(404, "unknown_host", url.hostname);

  const path = storagePath(url.pathname);
  let entry = await env.SITE_STORE.getWithMetadata<{ contentType?: string }>(
    fileKey(label, path),
    "arrayBuffer"
  );
  if (!entry.value && !path.includes(".")) {
    entry = await env.SITE_STORE.getWithMetadata<{ contentType?: string }>(
      fileKey(label, `${path}/index.html`),
      "arrayBuffer"
    );
  }
  if (!entry.value) {
    return new Response("Not found. This page has not been published yet.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
  return new Response(entry.value, {
    headers: {
      "content-type": entry.metadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=60"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/gatekeeper/publish" && request.method === "POST") {
      return handlePublish(request, env);
    }
    if (request.method === "GET" || request.method === "HEAD") {
      return serve(request, env);
    }
    return errorResponse(405, "method_not_allowed");
  }
} satisfies ExportedHandler<Env>;
