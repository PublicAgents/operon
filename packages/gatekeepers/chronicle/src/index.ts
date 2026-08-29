import {
  queryEvents,
  queryMessages,
  queryWakeLog,
  queryWakes,
  recordWakeLogChunk
} from "@operon/chronicle";
import { errorResponse, json, readJson, requireBearer, OpsEntrypoint } from "@operon/worker-kit";
import { WakeLog } from "./wake-log-do.js";

export { WakeLog };

/**
 * The chronicle Gatekeeper: the colony's introspection surface.
 *
 * Write side (containers, internal bearer): transcript chunks stream in
 * per wake, landing in the tailable WakeLog DO AND the D1 mirror. Chunks
 * were denylist-redacted BEFORE leaving the container; nothing here
 * un-redacts.
 *
 * Read side (operator bearer): the audit database. Every Gatekeeper's
 * ledger events (mirrored by worker-kit's Ledger), every message body
 * (email both ways, the operator channel), every wake transcript. This
 * is the operator console's data layer.
 */

interface Env {
  ROSTER: string;
  CHRONICLE: D1Database;
  CHRONICLE_SERVICE_TOKEN?: string;
  WAKE_LOG: DurableObjectNamespace<WakeLog>;
}

const MAX_CHUNK_BYTES = 128 * 1024;
const WAKE_ID = /^[0-9a-f-]{8,64}$/;

async function handleAppend(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const denied = requireBearer(request, env.CHRONICLE_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{
    wakeId?: string;
    agentId?: string;
    seq?: number;
    text?: string;
    done?: boolean;
  }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { wakeId, agentId, seq, text, done } = body.value;
  if (typeof wakeId !== "string" || !WAKE_ID.test(wakeId)) return errorResponse(400, "invalid_wake_id");
  if (typeof agentId !== "string" || !agentId) return errorResponse(400, "invalid_agent_id");
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return errorResponse(400, "invalid_seq");
  }
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_CHUNK_BYTES) {
    return errorResponse(400, "invalid_text", `chunks are capped at ${MAX_CHUNK_BYTES} bytes`);
  }
  const at = new Date().toISOString();
  const chunk = { seq, at, text, done: done === true };
  await env.WAKE_LOG.get(env.WAKE_LOG.idFromName(wakeId)).append(agentId, chunk);
  ctx.waitUntil(recordWakeLogChunk(env.CHRONICLE, { wakeId, agentId, ...chunk }));
  return json({ ok: true, seq });
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) ? value : fallback;
}

/**
 * The operator's read surface, served ONLY over the binding-only Ops
 * entrypoint (spec 0003 step 3): events, messages, wakes, wake tail. No
 * bearer, the service binding is the authorization.
 */
async function operatorReads(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return errorResponse(404, "not_found");

    // Live tail over WebSocket (spec 0005 §4): the upgrade passes through
    // to the wake's WakeLog DO, which replays from the subscriber's
    // cursor and then streams appends.
    const wsMatch = /^\/ws\/wake-log\/([0-9a-f-]{8,64})$/.exec(url.pathname);
    if (wsMatch) {
      return env.WAKE_LOG.get(env.WAKE_LOG.idFromName(wsMatch[1])).fetch(request);
    }

    if (url.pathname === "/chronicle/events") {
      return json({
        ok: true,
        events: await queryEvents(env.CHRONICLE, {
          gatekeeper: url.searchParams.get("gatekeeper") ?? undefined,
          kind: url.searchParams.get("kind") ?? undefined,
          agentId: url.searchParams.get("agent") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          until: url.searchParams.get("until") ?? undefined,
          limit: intParam(url, "limit", 100)
        })
      });
    }
    if (url.pathname === "/chronicle/messages") {
      return json({
        ok: true,
        messages: await queryMessages(env.CHRONICLE, {
          kind: url.searchParams.get("kind") ?? undefined,
          agentId: url.searchParams.get("agent") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          until: url.searchParams.get("until") ?? undefined,
          contains: url.searchParams.get("contains") ?? undefined,
          limit: intParam(url, "limit", 100)
        })
      });
    }
    if (url.pathname === "/chronicle/wakes") {
      return json({
        ok: true,
        wakes: await queryWakes(
          env.CHRONICLE,
          url.searchParams.get("agent") ?? undefined,
          intParam(url, "limit", 50)
        )
      });
    }
    const wakeMatch = /^\/chronicle\/wake-log\/([0-9a-f-]{8,64})$/.exec(url.pathname);
    if (wakeMatch) {
      const after = intParam(url, "after", -1);
      // The DO is the LIVE tail while the wake runs (and for a week
      // after); once it has expired, the D1 mirror answers instead.
      const live = await env.WAKE_LOG.get(env.WAKE_LOG.idFromName(wakeMatch[1])).read(after);
      if (live.chunks.length > 0 || live.agentId) {
        return json({ ok: true, source: "live", ...live });
      }
      const chunks = await queryWakeLog(env.CHRONICLE, wakeMatch[1], after);
      return json({
        ok: true,
        source: "chronicle",
        done: chunks.some(chunk => chunk.done === 1),
        chunks
      });
    }
    return errorResponse(404, "not_found");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/chronicle/wake-log/append" && request.method === "POST") {
      return handleAppend(request, env, ctx);
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;

export class Ops extends OpsEntrypoint<Env> {
  protected handle(request: Request): Promise<Response> {
    return operatorReads(request, this.env);
  }
}
