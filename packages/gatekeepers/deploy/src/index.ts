import { parseRoster } from "@operon/core";
import { errorResponse, json, readJson, requireBearer, Ledger } from "@operon/worker-kit";
import {
  decodeBase64,
  hostLabel,
  storagePath,
  validatePublish,
  type PublishRequest
} from "./gates.js";

export { Ledger };
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
  LEDGER: DurableObjectNamespace<Ledger>;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("deploy"));
}

function fileKey(host: string, path: string): string {
  return `f:${host}:${path}`;
}

function manifestKey(host: string): string {
  return `m:${host}`;
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
  const newPaths = new Set(files.map(file => file.path));
  for (const file of files) {
    await env.SITE_STORE.put(fileKey(host, file.path), decodeBase64(file.contentBase64), {
      metadata: { contentType: file.contentType }
    });
  }
  const previous = await env.SITE_STORE.get<string[]>(manifestKey(host), "json");
  for (const stale of previous ?? []) {
    if (!newPaths.has(stale)) await env.SITE_STORE.delete(fileKey(host, stale));
  }
  await env.SITE_STORE.put(manifestKey(host), JSON.stringify([...newPaths]));

  await ledger(env).append("published", {
    agentId,
    host,
    files: files.length,
    removed: (previous ?? []).filter(path => !newPaths.has(path)).length
  });
  return json({ ok: true, host, files: files.length });
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
    if (url.pathname === "/gatekeeper/ledger" && request.method === "GET") {
      const denied = requireBearer(request, env.PUBLISH_TOKEN);
      if (denied) return denied;
      return json(await ledger(env).recent());
    }
    if (request.method === "GET" || request.method === "HEAD") {
      return serve(request, env);
    }
    return errorResponse(405, "method_not_allowed");
  }
} satisfies ExportedHandler<Env>;
