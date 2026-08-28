import { DurableObject } from "cloudflare:workers";
import { auditEvent, upstreamEndpoint } from "./audit.js";
import { cdpDecision } from "./cdp-policy.js";

/**
 * One live browser relay per (agent, session name): the spike scope of
 * spec 0004 section 3. It dials Browser Run with the Worker-held API
 * token, pipes CDP frames both ways, and reports audit events + open/
 * close to the Gatekeeper (which ledgers them). Storage-state snapshots,
 * the WebMeter, and passkeys are the MVP phase, not here yet.
 */

export interface SessionEnv {
  CF_ACCOUNT_ID?: string;
  BROWSER_RUN_TOKEN?: string;
  [name: string]: unknown;
}

export class WebSession extends DurableObject<SessionEnv> {
  private upstream: WebSocket | null = null;
  private opening = false;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket_required", { status: 426 });
    }
    const accountId = this.env.CF_ACCOUNT_ID;
    const token = this.env.BROWSER_RUN_TOKEN;
    if (!accountId || !token) return new Response("browser_run_unconfigured", { status: 503 });
    // One relay per DO. The dial below awaits, which yields; a second
    // concurrent connect must be refused synchronously here, before that
    // yield, or both would observe a null upstream and open two browsers.
    if (this.upstream || this.opening) return new Response("session_busy", { status: 409 });
    this.opening = true;

    const agentId = request.headers.get("x-operon-agent") ?? "unknown";
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "unnamed";

    // Dial Browser Run. In Workers an outbound WebSocket is a fetch
    // carrying an Upgrade header; https because the runtime upgrades it.
    const endpoint = upstreamEndpoint(accountId).replace("wss://", "https://");
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(endpoint, {
        headers: { upgrade: "websocket", authorization: `Bearer ${token}` }
      });
    } catch (error) {
      this.opening = false;
      return new Response(`browser_run_unreachable: ${String(error).slice(0, 200)}`, { status: 502 });
    }
    const upstream = upstreamResponse.webSocket;
    if (!upstream) {
      this.opening = false;
      return new Response(`browser_run_refused: ${upstreamResponse.status}`, { status: 502 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    upstream.accept();
    server.accept();
    this.upstream = upstream;
    this.opening = false;

    const record = (kind: string, detail: Record<string, unknown>) => {
      // waitUntil keeps the DO alive until the ledger append lands, so a
      // close/error/idle mid-append cannot drop an audit row.
      this.ctx.waitUntil(this.reportEvent(kind, { agentId, name, ...detail }));
    };
    record("web_session_open", {});

    const teardown = (reason: string) => {
      // Identity check, not null check: a stale close/error from a
      // PRIOR session must not clear the REPLACEMENT that reused this
      // DO. Only this closure's own upstream may release the slot.
      if (this.upstream !== upstream) return;
      this.upstream = null;
      this.opening = false;
      record("web_session_close", { reason });
      try {
        upstream.close();
      } catch {
        /* already closed */
      }
      try {
        server.close();
      } catch {
        /* already closed */
      }
    };

    server.addEventListener("message", event => {
      // The relay is a policy point: credential-export CDP methods are
      // refused here (an error back to the client) and never forwarded.
      if (typeof event.data === "string") {
        const decision = cdpDecision(event.data);
        if (decision.action === "block") {
          record("web_blocked", { method: decision.method });
          try {
            server.send(decision.response);
          } catch {
            teardown("client_send_failed");
          }
          return;
        }
      }
      try {
        upstream.send(event.data);
      } catch {
        teardown("upstream_send_failed");
      }
    });
    upstream.addEventListener("message", event => {
      if (typeof event.data === "string") {
        const audit = auditEvent(event.data);
        if (audit) record(`web_${audit.kind}`, { url: audit.url });
      }
      try {
        server.send(event.data);
      } catch {
        teardown("client_send_failed");
      }
    });
    server.addEventListener("close", () => teardown("client_closed"));
    upstream.addEventListener("close", () => teardown("upstream_closed"));
    server.addEventListener("error", () => teardown("client_error"));
    upstream.addEventListener("error", () => teardown("upstream_error"));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** The Gatekeeper worker's Ledger is reached through the env binding. */
  private async reportEvent(kind: string, detail: Record<string, unknown>): Promise<void> {
    const namespace = this.env.LEDGER as DurableObjectNamespace | undefined;
    if (!namespace) return;
    try {
      const ledger = namespace.get(namespace.idFromName("web")) as unknown as {
        append(kind: string, detail: Record<string, unknown>): Promise<unknown>;
      };
      await ledger.append(kind, detail);
    } catch (error) {
      console.error("web ledger append failed", error);
    }
  }
}
