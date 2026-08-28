import { WorkerEntrypoint } from "cloudflare:workers";
import { requestLog, withError, withResponse, type EgressProps } from "./egress-audit.js";

/**
 * The egress audit interceptor (spec 0004 section 8). The WakeContainer
 * points `interceptOutboundHttps("*")` at a loopback binding to this
 * export, delivering the agent + wake id as `ctx.props`. Every real
 * outbound request is logged and forwarded; a failure to reach upstream
 * is logged and surfaced, a failure to LOG never blocks the request.
 */
export class EgressAudit extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx.props ?? {}) as EgressProps;
    const log = requestLog(request, props);
    try {
      const response = await fetch(request);
      try {
        console.log(JSON.stringify(withResponse(log, response.status, response.ok)));
      } catch {
        /* logging must never block egress */
      }
      return response;
    } catch (error) {
      try {
        console.log(JSON.stringify(withError(log, error)));
      } catch {
        /* logging must never block egress */
      }
      // Forwarding failed for real (not a log failure): surface it, the
      // container would have seen this error with no interceptor too.
      return new Response(`egress_failed: ${String(error).slice(0, 200)}`, { status: 502 });
    }
  }
}
