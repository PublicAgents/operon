import { DurableObject } from "cloudflare:workers";
import { auditEvent, upstreamEndpoint } from "./audit.js";
import { applyFill, cdpDecision, type RelayPolicy } from "./cdp-policy.js";

/**
 * One browser session per (agent, session name): the relay, its policy,
 * and the identity that survives between wakes (spec 0004 section 3).
 *
 * Persistence is the point of the DO: Browser Run sessions die after ten
 * idle minutes, but a named session's cookies and localStorage live here
 * and are restored into the next one, so "logged in" outlives the
 * session. Deleting that state is the operator's remote logout, and a
 * GENERATION counter makes it stick: a snapshot from a killed session
 * carries the generation it began under and is refused if stale.
 *
 * The relay is a POLICY POINT (cdp-policy.ts): credential-export methods
 * are dropped, navigation is checked against the origin denylist, and a
 * vault placeholder is substituted only after the relay asks the browser
 * for the TARGET context's origin.
 */

export interface SessionEnv {
  CF_ACCOUNT_ID?: string;
  BROWSER_RUN_TOKEN?: string;
  /** Comma-separated hosts navigation may never reach. */
  WEB_ORIGIN_DENYLIST?: string;
  [name: string]: unknown;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
  sameSite?: string;
}

interface StoredState {
  cookies: StoredCookie[];
  /** origin -> (key -> value) */
  localStorage: Record<string, Record<string, string>>;
  savedAt: string;
}

/** A cheap CDP call on an interval keeps a quiet session from idling out. */
const HEARTBEAT_MS = 4 * 60_000;
/** How often to capture identity from a live session. */
const SNAPSHOT_MS = 60_000;

export class WebSession extends DurableObject<SessionEnv> {
  private upstream: WebSocket | null = null;
  private opening = false;
  private nextId = 900_000_000;
  private pendingOrigin = new Map<number, { raw: string; credential: string }>();
  private pendingCookieCapture = new Set<number>();
  private timers: ReturnType<typeof setInterval>[] = [];

  /** Drop any live relay, then forget the saved identity (remote logout). */
  async destroySession(): Promise<{ deleted: boolean }> {
    const generation = ((await this.ctx.storage.get<number>("generation")) ?? 0) + 1;
    await this.ctx.storage.put("generation", generation);
    if (this.upstream) {
      try {
        this.upstream.close(1000, "deleted_by_operator");
      } catch {
        /* already closing */
      }
      this.upstream = null;
    }
    this.stopTimers();
    await this.ctx.storage.delete("state");
    return { deleted: true };
  }

  /** End the live relay but KEEP the saved identity (agent-initiated). */
  async closeLive(): Promise<{ closed: boolean }> {
    if (!this.upstream) return { closed: false };
    try {
      this.upstream.close(1000, "closed_by_agent");
    } catch {
      /* already closing */
    }
    return { closed: true };
  }

  /** What the operator sees: where this session is logged in, never values. */
  async describe(): Promise<Record<string, unknown>> {
    const state = await this.ctx.storage.get<StoredState>("state");
    const domains = [...new Set((state?.cookies ?? []).map(cookie => cookie.domain))].sort();
    return {
      live: this.upstream !== null,
      saved: Boolean(state),
      savedAt: state?.savedAt ?? null,
      cookieDomains: domains,
      cookieCount: state?.cookies.length ?? 0
    };
  }

  /** Store a door-minted credential for placeholder substitution. */
  async putCredential(name: string, value: string, domains: string[]): Promise<void> {
    const credentials = (await this.ctx.storage.get<Record<string, { value: string; domains: string[] }>>(
      "credentials"
    )) ?? {};
    credentials[name] = { value, domains };
    await this.ctx.storage.put("credentials", credentials);
  }

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
    const generation = (await this.ctx.storage.get<number>("generation")) ?? 0;
    const policy = await this.policy();

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
      this.ctx.waitUntil(this.reportEvent(kind, { agentId, name, ...detail }));
    };
    record("web_session_open", {});

    const teardown = (reason: string) => {
      // Identity check, not null check: a stale close/error from a PRIOR
      // session must not clear the REPLACEMENT that reused this DO.
      if (this.upstream !== upstream) return;
      this.upstream = null;
      this.opening = false;
      this.stopTimers();
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
      if (typeof event.data !== "string") {
        this.send(upstream, event.data as ArrayBuffer, teardown);
        return;
      }
      const decision = cdpDecision(event.data, policy);
      if (decision.action === "block") {
        record("web_blocked", { method: decision.method, reason: decision.reason });
        this.send(server, decision.response, teardown);
        return;
      }
      if (decision.action === "resolve-origin") {
        // A vault placeholder: ask the browser for the TARGET CONTEXT's
        // origin before injecting anything (bind on the context being
        // written to, never the top page).
        this.probeOrigin(upstream, event.data, decision.credential, record, teardown);
        return;
      }
      this.send(upstream, event.data, teardown);
    });

    upstream.addEventListener("message", event => {
      if (typeof event.data === "string") {
        // Our own probes and captures never reach the client.
        if (this.consumeOriginReply(event.data, upstream, server, policy, record, teardown)) return;
        if (this.consumeCookieCapture(event.data, generation)) return;
        const audit = auditEvent(event.data);
        if (audit) record(`web_${audit.kind}`, { url: audit.url });
      }
      this.send(server, event.data as string | ArrayBuffer, teardown);
    });
    server.addEventListener("close", () => teardown("client_closed"));
    upstream.addEventListener("close", () => teardown("upstream_closed"));
    server.addEventListener("error", () => teardown("client_error"));
    upstream.addEventListener("error", () => teardown("upstream_error"));

    await this.restore(upstream);
    this.startTimers(upstream);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- relay plumbing -------------------------------------------------

  private send(socket: WebSocket, data: string | ArrayBuffer, teardown: (why: string) => void): void {
    try {
      socket.send(data);
    } catch {
      teardown("send_failed");
    }
  }

  /**
   * Ask the browser for the origin of the exact execution context the
   * fill targets. `callFunctionOn` on the objectId executes in the
   * object's OWN context, so no assumption about `this` is needed and a
   * utility-script object cannot mislead it.
   */
  private probeOrigin(
    upstream: WebSocket,
    raw: string,
    credential: string,
    record: (kind: string, detail: Record<string, unknown>) => void,
    teardown: (why: string) => void
  ): void {
    const message = JSON.parse(raw) as {
      sessionId?: string;
      params?: { objectId?: string; contextId?: number; executionContextId?: number };
    };
    const probeId = this.nextId++;
    this.pendingOrigin.set(probeId, { raw, credential });
    const objectId = message.params?.objectId;
    const contextId = message.params?.contextId ?? message.params?.executionContextId;
    const probe = objectId
      ? {
          id: probeId,
          method: "Runtime.callFunctionOn",
          params: {
            objectId,
            functionDeclaration: "function(){ return location.origin }",
            returnByValue: true
          },
          ...(message.sessionId ? { sessionId: message.sessionId } : {})
        }
      : {
          id: probeId,
          method: "Runtime.evaluate",
          params: {
            expression: "location.origin",
            returnByValue: true,
            ...(contextId !== undefined ? { contextId } : {})
          },
          ...(message.sessionId ? { sessionId: message.sessionId } : {})
        };
    record("web_fill_probe", { credential });
    this.send(upstream, JSON.stringify(probe), teardown);
  }

  /** True when the frame was one of our origin probes (consumed here). */
  private consumeOriginReply(
    data: string,
    upstream: WebSocket,
    server: WebSocket,
    policy: RelayPolicy,
    record: (kind: string, detail: Record<string, unknown>) => void,
    teardown: (why: string) => void
  ): boolean {
    if (this.pendingOrigin.size === 0) return false;
    let message: { id?: number; result?: { result?: { value?: unknown } } };
    try {
      message = JSON.parse(data);
    } catch {
      return false;
    }
    const id = typeof message.id === "number" ? message.id : -1;
    const pending = this.pendingOrigin.get(id);
    if (!pending) return false;
    this.pendingOrigin.delete(id);

    const origin = typeof message.result?.result?.value === "string" ? message.result.result.value : "";
    const outcome = applyFill(pending.raw, pending.credential, origin, policy);
    if (!outcome.ok) {
      record("web_fill_refused", { credential: pending.credential, origin, reason: outcome.reason });
      this.send(server, outcome.response, teardown);
      return true;
    }
    record("web_fill", { credential: pending.credential, origin });
    this.send(upstream, outcome.frame, teardown);
    return true;
  }

  /** True when the frame answered one of our periodic cookie captures. */
  private consumeCookieCapture(data: string, generation: number): boolean {
    if (this.pendingCookieCapture.size === 0) return false;
    let message: { id?: number; result?: { cookies?: StoredCookie[] } };
    try {
      message = JSON.parse(data);
    } catch {
      return false;
    }
    const id = typeof message.id === "number" ? message.id : -1;
    if (!this.pendingCookieCapture.has(id)) return false;
    this.pendingCookieCapture.delete(id);
    const cookies = message.result?.cookies;
    if (Array.isArray(cookies)) {
      this.ctx.waitUntil(this.saveState(cookies, generation));
    }
    return true;
  }

  private startTimers(upstream: WebSocket): void {
    this.stopTimers();
    // keep_alive is an IDLE window, not a lifetime: a cheap call inside
    // it keeps a quiet session alive for the length of the wake.
    this.timers.push(
      setInterval(() => {
        if (this.upstream !== upstream) return;
        try {
          upstream.send(JSON.stringify({ id: this.nextId++, method: "Browser.getVersion" }));
        } catch {
          /* teardown handles it */
        }
      }, HEARTBEAT_MS)
    );
    // Capture identity while the session is LIVE: at teardown the socket
    // is usually already gone, so a close-time export cannot be relied on.
    this.timers.push(
      setInterval(() => {
        if (this.upstream !== upstream) return;
        const id = this.nextId++;
        this.pendingCookieCapture.add(id);
        try {
          upstream.send(JSON.stringify({ id, method: "Storage.getCookies" }));
        } catch {
          this.pendingCookieCapture.delete(id);
        }
      }, SNAPSHOT_MS)
    );
  }

  private stopTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  // ---- identity: restore and snapshot ---------------------------------

  /** Put the saved cookies + localStorage back into a fresh session. */
  private async restore(upstream: WebSocket): Promise<void> {
    const state = await this.ctx.storage.get<StoredState>("state");
    if (!state) return;
    try {
      if (state.cookies.length > 0) {
        upstream.send(
          JSON.stringify({
            id: this.nextId++,
            method: "Storage.setCookies",
            params: { cookies: state.cookies }
          })
        );
      }
      for (const [origin, entries] of Object.entries(state.localStorage)) {
        // An init script re-seeds localStorage for that origin on load.
        const script =
          `if (location.origin === ${JSON.stringify(origin)}) { ` +
          `const d = ${JSON.stringify(entries)}; ` +
          `for (const k in d) { try { localStorage.setItem(k, d[k]) } catch (e) {} } }`;
        upstream.send(
          JSON.stringify({
            id: this.nextId++,
            method: "Page.addScriptToEvaluateOnNewDocument",
            params: { source: script }
          })
        );
      }
    } catch (error) {
      console.error("web session restore failed", error);
    }
  }

  /**
   * Persist captured identity. The generation guard is the teeth behind
   * the operator's delete: a capture that began before a delete carries
   * the old generation and is refused, so deleted cookies cannot come
   * back under the same name.
   */
  private async saveState(cookies: StoredCookie[], generation: number): Promise<void> {
    const current = (await this.ctx.storage.get<number>("generation")) ?? 0;
    if (current !== generation) return;
    const previous = await this.ctx.storage.get<StoredState>("state");
    const state: StoredState = {
      cookies,
      localStorage: previous?.localStorage ?? {},
      savedAt: new Date().toISOString()
    };
    await this.ctx.storage.put("state", state);
  }

  private async policy(): Promise<RelayPolicy> {
    const denylist = (this.env.WEB_ORIGIN_DENYLIST ?? "")
      .split(",")
      .map(host => host.trim())
      .filter(host => host.length > 0);
    const credentials = await this.ctx.storage.get<RelayPolicy["credentials"]>("credentials");
    return { originDenylist: denylist, ...(credentials ? { credentials } : {}) };
  }

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
