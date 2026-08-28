/**
 * The container egress audit (spec 0004 section 8), the OBSERVE-only
 * version: every real outbound request the container makes is logged and
 * forwarded. It is NOT a fence. A hijacked mind can exfiltrate through
 * the remote browser regardless, so blocking direct egress is burden
 * without benefit; what earns its keep is a durable record to analyse
 * later. Fail-open by construction: a logging failure never blocks the
 * request.
 *
 * The interceptor runs in the Workers runtime OUTSIDE the container, so
 * the log is unforgeable by the container. Records go to `console`, which
 * Workers observability captures and makes queryable; volume is high (an
 * npm install is thousands of requests), so each line is compact
 * structured JSON.
 *
 * This module holds the PURE shaping (what a log line contains) so it is
 * unit-tested without a Workers runtime; the entrypoint is a thin wrapper.
 */

export interface EgressProps {
  agentId?: string;
  wakeId?: string;
}

export interface EgressLog {
  t: "egress";
  agentId: string;
  wakeId: string;
  method: string;
  host: string;
  path: string;
  /** Query string length only: values can carry secrets, so never logged. */
  queryLen: number;
  status?: number;
  ok?: boolean;
  error?: string;
}

/** The audit line for a request (before the response is known). */
export function requestLog(request: Request, props: EgressProps): EgressLog {
  let host: string;
  let path = "";
  let queryLen = 0;
  try {
    const url = new URL(request.url);
    host = url.hostname;
    path = url.pathname;
    queryLen = url.search.length > 0 ? url.search.length - 1 : 0;
  } catch {
    host = "unparseable";
  }
  return {
    t: "egress",
    agentId: props.agentId ?? "unknown",
    wakeId: props.wakeId ?? "unknown",
    method: request.method,
    host,
    // A path can carry ids but not usually secrets; a query string can,
    // so we record only its LENGTH, never its content.
    path: path.length > 512 ? path.slice(0, 512) + "…" : path,
    queryLen
  };
}

/** Fold the response outcome into the line. */
export function withResponse(log: EgressLog, status: number, ok: boolean): EgressLog {
  return { ...log, status, ok };
}

/** Fold a transport failure into the line. */
export function withError(log: EgressLog, error: unknown): EgressLog {
  return { ...log, error: String(error).slice(0, 200) };
}
