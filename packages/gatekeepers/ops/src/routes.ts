/**
 * The operator API surface as data (spec 0003 §3): every read and every
 * decision the operator can make, each mapped to the Gatekeeper binding
 * and downstream path it forwards to. Pure and unit-tested; the Worker
 * adds Access verification and the actual forwarding.
 *
 * Keeping this a table, not scattered handlers, is the point: the
 * operator's WHOLE authority is auditable in one list, and a new
 * operator action is one entry.
 */

export type Method = "GET" | "POST";

export interface OpsRoute {
  /** Operator-facing method + path (under the ops host). */
  method: Method;
  path: string;
  /** Which service binding to forward to. */
  binding: string;
  /** Downstream method (usually same). */
  downstreamMethod: Method;
  /**
   * Downstream path; `:cfg`-free. A trailing "*" forwards the remainder
   * of the operator path (for /wake-log/<id> style tails).
   */
  downstreamPath: string;
  /** true = a state-changing decision (audit-logged distinctly). */
  decision?: boolean;
}

export const OPS_ROUTES: OpsRoute[] = [
  // ---- reads: the chronicle (the audit database) --------------------
  { method: "GET", path: "/chronicle/events", binding: "CHRONICLE_GK", downstreamMethod: "GET", downstreamPath: "/chronicle/events" },
  { method: "GET", path: "/chronicle/messages", binding: "CHRONICLE_GK", downstreamMethod: "GET", downstreamPath: "/chronicle/messages" },
  { method: "GET", path: "/chronicle/wakes", binding: "CHRONICLE_GK", downstreamMethod: "GET", downstreamPath: "/chronicle/wakes" },
  { method: "GET", path: "/chronicle/wake-log/*", binding: "CHRONICLE_GK", downstreamMethod: "GET", downstreamPath: "/chronicle/wake-log/*" },

  // ---- reads: every Gatekeeper's ledger -----------------------------
  { method: "GET", path: "/ledger/email", binding: "EMAIL", downstreamMethod: "GET", downstreamPath: "/gatekeeper/email/ledger" },
  { method: "GET", path: "/ledger/spend", binding: "SPEND", downstreamMethod: "GET", downstreamPath: "/gatekeeper/spend/ledger" },
  { method: "GET", path: "/ledger/vault", binding: "VAULT", downstreamMethod: "GET", downstreamPath: "/gatekeeper/vault/ledger" },
  { method: "GET", path: "/ledger/x", binding: "X", downstreamMethod: "GET", downstreamPath: "/gatekeeper/x/ledger" },
  { method: "GET", path: "/ledger/telegram", binding: "TELEGRAM", downstreamMethod: "GET", downstreamPath: "/ledger" },

  // ---- reads: money detail ------------------------------------------
  { method: "GET", path: "/spend/outbox", binding: "SPEND", downstreamMethod: "GET", downstreamPath: "/gatekeeper/spend/outbox" },
  { method: "GET", path: "/email/outbox", binding: "EMAIL", downstreamMethod: "POST", downstreamPath: "/gatekeeper/email/outbox" },

  // ---- decisions: money and mail ------------------------------------
  { method: "POST", path: "/spend/approve", binding: "SPEND", downstreamMethod: "POST", downstreamPath: "/gatekeeper/spend/approve", decision: true },
  { method: "POST", path: "/spend/reject", binding: "SPEND", downstreamMethod: "POST", downstreamPath: "/gatekeeper/spend/reject", decision: true },
  { method: "POST", path: "/spend/reconcile", binding: "SPEND", downstreamMethod: "POST", downstreamPath: "/gatekeeper/spend/reconcile", decision: true },
  { method: "POST", path: "/email/approve", binding: "EMAIL", downstreamMethod: "POST", downstreamPath: "/gatekeeper/email/approve", decision: true },
  { method: "POST", path: "/email/reject", binding: "EMAIL", downstreamMethod: "POST", downstreamPath: "/gatekeeper/email/reject", decision: true },

  // ---- the operator channel + agent control -------------------------
  { method: "POST", path: "/channel/send", binding: "TELEGRAM", downstreamMethod: "POST", downstreamPath: "/channel/send", decision: true },
  { method: "POST", path: "/channel/transcript", binding: "TELEGRAM", downstreamMethod: "POST", downstreamPath: "/channel/transcript" },
  { method: "POST", path: "/wake/*", binding: "SCHEDULER", downstreamMethod: "POST", downstreamPath: "/wake/*", decision: true },
  { method: "POST", path: "/disable/*", binding: "SCHEDULER", downstreamMethod: "POST", downstreamPath: "/disable/*", decision: true },
  { method: "POST", path: "/enable/*", binding: "SCHEDULER", downstreamMethod: "POST", downstreamPath: "/enable/*", decision: true }
];

export interface RouteMatch {
  route: OpsRoute;
  /** The "*" tail, when the route path ends in "*". */
  tail: string;
}

/** Match an operator method+path to a route, capturing any "*" tail. */
export function matchRoute(method: string, path: string): RouteMatch | null {
  for (const route of OPS_ROUTES) {
    if (route.method !== method) continue;
    if (route.path.endsWith("/*")) {
      const prefix = route.path.slice(0, -1); // keep trailing slash
      if (path.startsWith(prefix)) return { route, tail: path.slice(prefix.length) };
    } else if (route.path === path) {
      return { route, tail: "" };
    }
  }
  return null;
}

/** The downstream URL path for a matched route (substituting any tail). */
export function downstreamPath(match: RouteMatch): string {
  return match.route.downstreamPath.endsWith("/*")
    ? match.route.downstreamPath.slice(0, -1) + match.tail
    : match.route.downstreamPath;
}
