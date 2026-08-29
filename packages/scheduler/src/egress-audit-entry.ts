import { WorkerEntrypoint } from "cloudflare:workers";
import { recordEvent } from "@operon/chronicle";
import {
  dueForFlush,
  requestLog,
  summaryDetail,
  tallyLine,
  withError,
  withResponse,
  type EgressProps,
  type EgressTally
} from "./egress-audit.js";

/**
 * The egress audit interceptor (spec 0004 section 8). The WakeContainer
 * points `interceptOutboundHttps("*")` at a loopback binding to this
 * export, delivering the agent + wake id as `ctx.props`. Every real
 * outbound request is logged and forwarded; a failure to reach upstream
 * is logged and surfaced, a failure to LOG never blocks the request.
 *
 * Beyond the raw console lines, per-wake host histograms flush to the
 * chronicle (kind egress_summary) so the events explorer can answer
 * "where did this wake talk to" after observability's retention runs
 * out. Isolate-scoped and best-effort, like every mirror.
 */

interface Env {
  /** CHRONICLE_DB, not CHRONICLE: that name is the gatekeeper binding. */
  CHRONICLE_DB?: D1Database;
}

const tallies = new Map<string, EgressTally>();

/**
 * The WakeContainer pokes this host at wake finish so a quiet tail
 * (fewer than the request threshold, no further requests to trip the
 * time window) still lands its summary. A container could reach this
 * host itself through the catch-all interception; that only flushes
 * its own tally early, which changes no count, so it needs no gate.
 */
export const EGRESS_FLUSH_HOST = "operon-egress-flush.internal";

export class EgressAudit extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx.props ?? {}) as EgressProps;
    if (new URL(request.url).hostname === EGRESS_FLUSH_HOST) {
      this.flush(props.wakeId);
      return new Response(null, { status: 204 });
    }
    const log = requestLog(request, props);
    try {
      const response = await fetch(request);
      this.record(withResponse(log, response.status, response.ok));
      return response;
    } catch (error) {
      this.record(withError(log, error));
      // Forwarding failed for real (not a log failure): surface it, the
      // container would have seen this error with no interceptor too.
      return new Response(`egress_failed: ${String(error).slice(0, 200)}`, { status: 502 });
    }
  }

  /** Console line plus summary tally; neither may ever block egress. */
  private record(log: ReturnType<typeof requestLog>): void {
    try {
      console.log(JSON.stringify(log));
      const tally = tallyLine(tallies, log, Date.now());
      if (dueForFlush(tally, Date.now())) this.flush(log.wakeId);
    } catch {
      /* logging must never block egress */
    }
  }

  /** Write one wake's tally (if any) to the chronicle and drop it. */
  private flush(wakeId: string | undefined): void {
    if (!wakeId || !this.env.CHRONICLE_DB) return;
    const tally = tallies.get(wakeId);
    if (!tally) return;
    tallies.delete(wakeId);
    this.ctx.waitUntil(
      recordEvent(this.env.CHRONICLE_DB, {
        at: new Date().toISOString(),
        gatekeeper: "scheduler",
        kind: "egress_summary",
        agentId: tally.agentId,
        detail: summaryDetail(tally)
      })
    );
  }
}
