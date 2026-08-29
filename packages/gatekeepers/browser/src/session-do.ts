import { DurableObject } from "cloudflare:workers";
import { auditEvent } from "./audit.js";
import { applyFill, cdpDecision, redactCredentials, type RelayPolicy } from "./cdp-policy.js";
import { pickPageTarget, resolveProvider, type ProviderEnv, type TargetInfo } from "./provider.js";

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

export interface SessionEnv extends ProviderEnv {
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
  /** The open sequence of the relay that wrote this (write ordering). */
  seq?: number;
}

/** A cheap CDP call on an interval keeps a quiet session from idling out. */
const HEARTBEAT_MS = 4 * 60_000;
/** How often to capture identity from a live session. */
const SNAPSHOT_MS = 60_000;
/** How long a closing session waits for its last capture to land. */
const FINAL_CAPTURE_MS = 3_000;

/** An unpredictable CDP frame id, so a client cannot forge a probe reply. */
function randomFrameId(): number {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  // Well above any client's counter, and not guessable.
  return 1_000_000_000 + (bytes[0] % 1_000_000_000);
}

export class WebSession extends DurableObject<SessionEnv> {
  private upstream: WebSocket | null = null;
  private opening = false;
  private nextId = 900_000_000;
  private liveViewSupported = false;
  private pendingOrigin = new Map<number, { raw: string; credential: string }>();
  private pendingCookieCapture = new Set<number>();
  private pendingStorageCapture = new Set<number>();
  /** Operator-initiated control commands (live view, screenshot). */
  private pendingControl = new Map<
    number,
    { resolve: (reply: { result?: Record<string, unknown>; error?: string }) => void }
  >();
  private timers: ReturnType<typeof setInterval>[] = [];

  /** Drop any live relay, then forget the saved identity (remote logout). */
  async destroySession(): Promise<{ deleted: boolean }> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const generation = ((await this.ctx.storage.get<number>("generation")) ?? 0) + 1;
      await this.ctx.storage.put("generation", generation);
      await this.ctx.storage.delete("state");
    });
    if (this.upstream) {
      try {
        this.upstream.close(1000, "deleted_by_operator");
      } catch {
        /* already closing */
      }
      this.upstream = null;
    }
    this.stopTimers();
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
    const provider = resolveProvider(this.env);
    if ("error" in provider) return new Response(provider.error, { status: 503 });
    // One relay per DO. The dial below awaits, which yields; a second
    // concurrent connect must be refused synchronously here, before that
    // yield, or both would observe a null upstream and open two browsers.
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "unnamed";
    const wakeId = url.searchParams.get("wake") ?? "unknown";
    const cap = Number(url.searchParams.get("cap")) || 3;
    const agentId = request.headers.get("x-operon-agent") ?? "unknown";
    // This DO IS the source of truth for liveness (it holds the socket),
    // so the duplicate check happens BEFORE the meter is ever asked: a
    // live name is refused here and the meter is never touched, which is
    // why a stale takeover can never unmeter a running session.
    if (this.upstream || this.opening) {
      return new Response("session_busy", { status: 409 });
    }
    this.opening = true;
    // Only now, with liveness confirmed absent, ask the meter for a slot.
    const admitted = await this.admitSlot(agentId, name, wakeId, cap);
    if (!admitted.ok) {
      this.opening = false;
      return new Response(admitted.reason, {
        status: admitted.reason === "web_concurrency_cap" ? 429 : 409
      });
    }
    const slotToken = admitted.token;
    const generation = (await this.ctx.storage.get<number>("generation")) ?? 0;
    const policy = await this.policy();

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(provider.url, {
        headers: { upgrade: "websocket", ...provider.headers }
      });
    } catch (error) {
      this.opening = false;
      // A failed open must hand its slot back, or a few unreachable
      // dials would exhaust the concurrency cap for the rest of the wake.
      this.ctx.waitUntil(this.releaseSlot(agentId, name, wakeId, slotToken));
      return new Response(`browser_run_unreachable: ${String(error).slice(0, 200)}`, { status: 502 });
    }
    const upstream = upstreamResponse.webSocket;
    if (!upstream) {
      this.opening = false;
      this.ctx.waitUntil(this.releaseSlot(agentId, name, wakeId, slotToken));
      return new Response(`browser_run_refused: ${upstreamResponse.status}`, { status: 502 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    upstream.accept();
    server.accept();
    this.upstream = upstream;
    this.liveViewSupported = provider.liveView;
    this.opening = false;
    // Each relay gets a monotonic open SEQUENCE. A write is accepted
    // only if no NEWER relay has written since: that keeps a prior
    // relay's still-settling final capture (which holds the freshest
    // login) while never letting it clobber a replacement's newer state.
    const openSeq = ((await this.ctx.storage.get<number>("openSeq")) ?? 0) + 1;
    await this.ctx.storage.put("openSeq", openSeq);
    const relayId = openSeq;

    const record = (kind: string, detail: Record<string, unknown>) => {
      this.ctx.waitUntil(this.reportEvent(kind, { agentId, name, ...detail }));
    };
    record("web_session_open", { provider: provider.name });

    const teardown = (reason: string) => {
      // Identity check, not null check: a stale close/error from a PRIOR
      // session must not clear the REPLACEMENT that reused this DO.
      if (this.upstream !== upstream) return;
      this.upstream = null;
      this.opening = false;
      this.stopTimers();
      // An operator control command in flight must fail fast, not hang
      // to its timeout against a dead socket.
      for (const [, pending] of this.pendingControl) {
        pending.resolve({ error: "session_closed" });
      }
      this.pendingControl.clear();
      record("web_session_close", { reason });
      // Free the concurrency slot and accrue this session's minutes, or
      // a closed session would hold its slot until the cap is exhausted.
      this.ctx.waitUntil(this.releaseSlot(agentId, name, wakeId, slotToken));
      // A login inside the first interval must not be lost, so capture
      // once more and let the replies LAND before closing: firing the
      // commands and closing immediately would drop them on the floor.
      this.ctx.waitUntil(
        this.finalCapture(upstream).finally(() => {
          try {
            upstream.close();
          } catch {
            /* already closed */
          }
        })
      );
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
      // A client frame must never carry one of OUR in-flight ids: that
      // is the origin-spoofing attempt above, so drop it outright.
      if (this.usesReservedId(event.data)) {
        record("web_blocked", { method: "reserved_id", reason: "probe_id_collision" });
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
        // Our own probes, captures, and control replies never reach the client.
        if (this.consumeOriginReply(event.data, upstream, server, policy, record, teardown)) return;
        if (this.consumeCookieCapture(event.data, generation, relayId)) return;
        if (this.consumeStorageCapture(event.data, generation, relayId)) return;
        if (this.consumeControlReply(event.data)) return;
        const audit = auditEvent(event.data);
        if (audit) {
          record(`web_${audit.kind}`, { url: audit.url });
          // A login ends in a navigation, so capture identity HERE, while
          // the socket is certainly alive. Teardown-time capture cannot be
          // relied on: an upstream close fires after the socket is gone.
          if (audit.kind === "navigation") this.captureNow(upstream);
        }
        // A fill puts the real password INTO the page, so an ordinary
        // read-back (input.value via evaluate) would hand it to the mind.
        // Redact every known credential value on the way out; the mind
        // sees the placeholder it typed.
        const scrubbed = redactCredentials(event.data, policy);
        if (scrubbed.redacted.length > 0) {
          record("web_credential_redacted", { credentials: scrubbed.redacted });
        }
        this.send(server, scrubbed.frame, teardown);
        return;
      }
      this.send(server, event.data as ArrayBuffer, teardown);
    });
    server.addEventListener("close", () => teardown("client_closed"));
    upstream.addEventListener("close", () => teardown("upstream_closed"));
    server.addEventListener("error", () => teardown("client_error"));
    upstream.addEventListener("error", () => teardown("upstream_error"));

    await this.restore(upstream);
    this.startTimers(upstream, agentId, name, wakeId, slotToken);
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
    // The probe id must be UNPREDICTABLE: with a sequential id a client
    // could send its own frame carrying the next id and an attacker-chosen
    // "origin" value, and the reply would satisfy the pending probe, so
    // the credential would be injected against a forged origin.
    const probeId = randomFrameId();
    this.pendingOrigin.set(probeId, { raw, credential });
    const objectId = message.params?.objectId;
    const contextId = message.params?.contextId ?? message.params?.executionContextId;
    // An Input.* fill names no context: it goes wherever FOCUS is, which
    // may be inside a cross-origin iframe even though the top page is on
    // a bound origin. Probing the top frame would then authorize against
    // the wrong document, so the probe reports the focused frame instead:
    // if focus is delegated into a subframe we cannot resolve it safely
    // from here, and the fill is refused (the client should target the
    // field's objectId, which resolves exactly).
    const focusAware =
      "(function(){ const a = document.activeElement; " +
      "return (a && a.tagName === 'IFRAME') ? 'operon:focus-in-subframe' : location.origin })()";
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
            expression: contextId !== undefined ? "location.origin" : focusAware,
            returnByValue: true,
            ...(contextId !== undefined ? { contextId } : {})
          },
          ...(message.sessionId ? { sessionId: message.sessionId } : {})
        };
    record("web_fill_probe", { credential });
    this.send(upstream, JSON.stringify(probe), teardown);
  }

  /** Does a client frame reuse an id the relay currently has in flight? */
  private usesReservedId(data: string): boolean {
    if (
      this.pendingOrigin.size === 0 &&
      this.pendingCookieCapture.size === 0 &&
      this.pendingStorageCapture.size === 0 &&
      this.pendingControl.size === 0
    ) {
      return false;
    }
    let message: { id?: unknown };
    try {
      message = JSON.parse(data);
    } catch {
      return false;
    }
    const id = typeof message.id === "number" ? message.id : -1;
    return (
      this.pendingOrigin.has(id) ||
      this.pendingCookieCapture.has(id) ||
      this.pendingStorageCapture.has(id) ||
      this.pendingControl.has(id)
    );
  }

  // ---- operator control commands (spec 0004 §6: see the browser) ------

  /** True when the frame answered an operator control command. */
  private consumeControlReply(data: string): boolean {
    if (this.pendingControl.size === 0) return false;
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      message = JSON.parse(data);
    } catch {
      return false;
    }
    const id = typeof message.id === "number" ? message.id : -1;
    const pending = this.pendingControl.get(id);
    if (!pending) return false;
    this.pendingControl.delete(id);
    pending.resolve(
      message.error
        ? { error: message.error.message ?? "cdp_error" }
        : { result: message.result ?? {} }
    );
    return true;
  }

  /**
   * One CDP command on the live upstream, awaited. Ids come from the
   * same unpredictable space as the fill probes, so a client can
   * neither collide with nor forge a reply (usesReservedId drops the
   * attempt).
   */
  private controlCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<{ result?: Record<string, unknown>; error?: string }> {
    const upstream = this.upstream;
    if (!upstream) return Promise.resolve({ error: "no_live_session" });
    const id = randomFrameId();
    return new Promise(resolve => {
      let settled = false;
      const finish = (reply: { result?: Record<string, unknown>; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(reply);
      };
      const timer = setTimeout(() => {
        this.pendingControl.delete(id);
        finish({ error: "control_timeout" });
      }, 8000);
      const untimed = (reply: { result?: Record<string, unknown>; error?: string }) => {
        clearTimeout(timer);
        finish(reply);
      };
      this.pendingControl.set(id, { resolve: untimed });
      try {
        upstream.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
        );
      } catch {
        this.pendingControl.delete(id);
        clearTimeout(timer);
        finish({ error: "send_failed" });
      }
    });
  }

  /** The page to observe: an explicit URL-substring match wins; the
   * heuristic (attached, non-blank, newest) otherwise. Every candidate
   * page comes back too, so the operator SEES an ambiguous pick and can
   * re-ask with page=<substring> instead of trusting a guess. */
  private async observedTarget(
    match?: string
  ): Promise<{ targetId?: string; pageUrl?: string; pages: string[]; error?: string }> {
    const targets = await this.controlCommand("Target.getTargets", {});
    if (targets.error) return { pages: [], error: targets.error };
    const infos = (targets.result?.targetInfos ?? []) as TargetInfo[];
    const { chosen, pages, contenders } = pickPageTarget(infos, match);
    const pageUrls = pages.map(page => page.url ?? "");
    if (!chosen?.targetId) {
      return { pages: pageUrls, error: match ? "no_page_matches" : "no_page_target" };
    }
    // Enumeration order proves nothing about the foreground: when the
    // heuristic leaves a genuine tie, ask the browser which document is
    // actually VISIBLE (the driven tab in a headless session). A page
    // lying about its own visibilityState can at worst point the
    // operator at itself, the same page whose pixels are already marked
    // untrusted; the candidate list in the response keeps the final say
    // with the operator either way.
    let picked = chosen;
    if (contenders.length > 1) {
      const visible = await this.probeVisible(contenders.slice(0, 4));
      if (visible) picked = visible;
    }
    return { targetId: picked.targetId, pageUrl: picked.url, pages: pageUrls };
  }

  /** The first candidate whose document reports itself visible. */
  private async probeVisible(candidates: TargetInfo[]): Promise<TargetInfo | undefined> {
    for (const candidate of candidates) {
      if (!candidate.targetId) continue;
      const attach = await this.controlCommand("Target.attachToTarget", {
        targetId: candidate.targetId,
        flatten: true
      });
      const sessionId =
        typeof attach.result?.sessionId === "string" ? attach.result.sessionId : undefined;
      if (!sessionId) continue;
      try {
        const evaluated = await this.controlCommand(
          "Runtime.evaluate",
          { expression: "document.visibilityState === 'visible'", returnByValue: true },
          sessionId
        );
        const inner = evaluated.result?.result as { value?: unknown } | undefined;
        if (inner?.value === true) return candidate;
      } finally {
        void this.controlCommand("Target.detachFromTarget", { sessionId });
      }
    }
    return undefined;
  }

  /**
   * A live-view URL from the provider's vendor command (Cloudflare
   * Browser Run today). Providers without the command answer with a
   * named refusal rather than a hang; web_screenshot is the
   * provider-neutral way to see the page.
   */
  async liveView(
    mode: "tab" | "devtools",
    match?: string
  ): Promise<{ ok: boolean; url?: string; pageUrl?: string; pages?: string[]; reason?: string }> {
    if (!this.upstream) return { ok: false, reason: "no_live_session" };
    if (!this.liveViewSupported) {
      return { ok: false, reason: "live_view_unsupported_by_provider" };
    }
    const target = await this.observedTarget(match);
    if (target.error) return { ok: false, reason: target.error, pages: target.pages };
    const reply = await this.controlCommand("Cloudflare.getLiveView", {
      targetId: target.targetId,
      mode,
      expiresInMs: 300_000
    });
    if (reply.error) return { ok: false, reason: reply.error };
    const url =
      (typeof reply.result?.url === "string" && reply.result.url) ||
      (typeof reply.result?.liveViewUrl === "string" && reply.result.liveViewUrl) ||
      (typeof reply.result?.devtoolsFrontendUrl === "string" && reply.result.devtoolsFrontendUrl);
    if (!url) return { ok: false, reason: `unexpected_reply: ${Object.keys(reply.result ?? {}).join(",")}` };
    return { ok: true, url, pageUrl: target.pageUrl, pages: target.pages };
  }

  /**
   * Provider-neutral "what is the browser showing": plain CDP
   * Page.captureScreenshot against the first page target. The image is
   * WORLD CONTENT (whatever page the mind is on): untrusted pixels.
   */
  async screenshot(
    match?: string
  ): Promise<{ ok: boolean; data?: string; pageUrl?: string; pages?: string[]; reason?: string }> {
    if (!this.upstream) return { ok: false, reason: "no_live_session" };
    const target = await this.observedTarget(match);
    if (target.error) return { ok: false, reason: target.error, pages: target.pages };
    const attach = await this.controlCommand("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true
    });
    if (attach.error) return { ok: false, reason: attach.error };
    const sessionId = typeof attach.result?.sessionId === "string" ? attach.result.sessionId : undefined;
    if (!sessionId) return { ok: false, reason: "attach_failed" };
    try {
      const shot = await this.controlCommand(
        "Page.captureScreenshot",
        { format: "jpeg", quality: 70 },
        sessionId
      );
      if (shot.error) return { ok: false, reason: shot.error };
      const data = typeof shot.result?.data === "string" ? shot.result.data : undefined;
      return data
        ? { ok: true, data, pageUrl: target.pageUrl, pages: target.pages }
        : { ok: false, reason: "no_image" };
    } finally {
      // Best-effort detach; the client's own targets are untouched either way.
      void this.controlCommand("Target.detachFromTarget", { sessionId });
    }
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
  private consumeCookieCapture(data: string, generation: number, relayId: number): boolean {
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
      this.ctx.waitUntil(this.saveState(cookies, generation, relayId));
    }
    return true;
  }

  /** True when the frame answered one of our localStorage captures. */
  private consumeStorageCapture(data: string, generation: number, relayId: number): boolean {
    if (this.pendingStorageCapture.size === 0) return false;
    let message: { id?: number; result?: { result?: { value?: unknown } } };
    try {
      message = JSON.parse(data);
    } catch {
      return false;
    }
    const id = typeof message.id === "number" ? message.id : -1;
    if (!this.pendingStorageCapture.has(id)) return false;
    this.pendingStorageCapture.delete(id);
    const raw = message.result?.result?.value;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as { origin?: string; data?: Record<string, string> };
        if (parsed.origin && parsed.data && Object.keys(parsed.data).length > 0) {
          this.ctx.waitUntil(this.saveLocalStorage(parsed.origin, parsed.data, generation, relayId));
        }
      } catch {
        /* a page can refuse localStorage access; nothing to store */
      }
    }
    return true;
  }

  /** Merge one origin's localStorage into the saved identity. */
  private async saveLocalStorage(
    origin: string,
    data: Record<string, string>,
    generation: number,
    relayId: number
  ): Promise<void> {
    // Atomic for the same reason as saveState: a delete must not be
    // reversed by a write that checked the generation before it landed.
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = (await this.ctx.storage.get<number>("generation")) ?? 0;
      if (current !== generation) return;
      const previous = await this.ctx.storage.get<StoredState>("state");
      if (previous?.seq !== undefined && previous.seq > relayId) return;
      const state: StoredState = {
        cookies: previous?.cookies ?? [],
        localStorage: { ...(previous?.localStorage ?? {}), [origin]: data },
        savedAt: new Date().toISOString(),
        seq: relayId
      };
      await this.ctx.storage.put("state", state);
    });
  }

  /**
   * A last capture whose replies are awaited (briefly) before the socket
   * closes. Without the wait the commands are sent into a closing socket
   * and the session loses whatever it learned since the last interval.
   */
  private async finalCapture(upstream: WebSocket): Promise<void> {
    this.captureNow(upstream);
    const deadline = Date.now() + FINAL_CAPTURE_MS;
    while (
      (this.pendingCookieCapture.size > 0 || this.pendingStorageCapture.size > 0) &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /** One capture round: cookies + localStorage, both best-effort. */
  private captureNow(upstream: WebSocket): void {
    const cookieId = randomFrameId();
    this.pendingCookieCapture.add(cookieId);
    try {
      upstream.send(JSON.stringify({ id: cookieId, method: "Storage.getCookies" }));
    } catch {
      this.pendingCookieCapture.delete(cookieId);
    }
    const storageId = randomFrameId();
    this.pendingStorageCapture.add(storageId);
    try {
      upstream.send(
        JSON.stringify({
          id: storageId,
          method: "Runtime.evaluate",
          params: {
            expression:
              "JSON.stringify({origin: location.origin, data: Object.fromEntries(Object.entries(localStorage))})",
            returnByValue: true
          }
        })
      );
    } catch {
      this.pendingStorageCapture.delete(storageId);
    }
  }

  private startTimers(
    upstream: WebSocket,
    agentIdForTimers: string,
    name: string,
    wakeId: string,
    slotToken: string
  ): void {
    this.stopTimers();
    // keep_alive is an IDLE window, not a lifetime: a cheap call inside
    // it keeps a quiet session alive for the length of the wake.
    this.timers.push(
      setInterval(() => {
        if (this.upstream !== upstream) return;
        try {
          upstream.send(JSON.stringify({ id: randomFrameId(), method: "Browser.getVersion" }));
        } catch {
          /* teardown handles it */
        }
        // The meter learns this relay is alive, so a long HEALTHY session
        // is never mistaken for an abandoned hold and taken over.
        this.ctx.waitUntil(this.renewSlot(agentIdForTimers, name, wakeId, slotToken));
      }, HEARTBEAT_MS)
    );
    // Capture identity while the session is LIVE: at teardown the socket
    // is usually already gone, so a close-time export cannot be relied on.
    // Plenty of apps keep auth in localStorage, so cookies alone are an
    // incomplete identity: capture both, on an interval AND at teardown.
    this.timers.push(
      setInterval(() => {
        if (this.upstream !== upstream) return;
        this.captureNow(upstream);
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
  private async saveState(cookies: StoredCookie[], generation: number, relayId: number): Promise<void> {
    // The generation check and the write must be ATOMIC: a delete landing
    // between them would be reversed by this write, which is exactly the
    // resurrection the operator's logout must never allow.
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = (await this.ctx.storage.get<number>("generation")) ?? 0;
      if (current !== generation) return;
      const previous = await this.ctx.storage.get<StoredState>("state");
      // Ordering, not ownership: a late write from an older relay is kept
      // unless a NEWER relay has already saved.
      if (previous?.seq !== undefined && previous.seq > relayId) return;
      const state: StoredState = {
        cookies,
        localStorage: previous?.localStorage ?? {},
        savedAt: new Date().toISOString(),
        seq: relayId
      };
      await this.ctx.storage.put("state", state);
    });
  }

  private async policy(): Promise<RelayPolicy> {
    const denylist = (this.env.WEB_ORIGIN_DENYLIST ?? "")
      .split(",")
      .map(host => host.trim())
      .filter(host => host.length > 0);
    const credentials = await this.ctx.storage.get<RelayPolicy["credentials"]>("credentials");
    return { originDenylist: denylist, ...(credentials ? { credentials } : {}) };
  }

  /** Claim a concurrency slot; the DO calls this only when not live. */
  private async admitSlot(
    agentId: string,
    name: string,
    wakeId: string,
    cap: number
  ): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
    const namespace = this.env.WEB_METER as DurableObjectNamespace | undefined;
    if (!namespace) return { ok: true, token: "" };
    const meter = namespace.get(namespace.idFromName(agentId)) as unknown as {
      admit(name: string, wakeId: string, cap: number): Promise<{ ok: true; token: string } | { ok: false; reason: string }>;
    };
    return meter.admit(name, wakeId, cap);
  }

  /** Tell the meter this relay is still breathing. */
  private async renewSlot(agentId: string, name: string, wakeId: string, token: string): Promise<void> {
    const namespace = this.env.WEB_METER as DurableObjectNamespace | undefined;
    if (!namespace || !token) return;
    try {
      const meter = namespace.get(namespace.idFromName(agentId)) as unknown as {
        renew(name: string, wakeId: string, token: string): Promise<void>;
      };
      await meter.renew(name, wakeId, token);
    } catch (error) {
      console.error("web meter renew failed", error);
    }
  }

  /** Hand the concurrency slot back to the agent's meter. */
  private async releaseSlot(agentId: string, name: string, wakeId: string, token: string): Promise<void> {
    const namespace = this.env.WEB_METER as DurableObjectNamespace | undefined;
    if (!namespace) return;
    try {
      const meter = namespace.get(namespace.idFromName(agentId)) as unknown as {
        release(name: string, wakeId: string, token: string): Promise<void>;
      };
      await meter.release(name, wakeId, token);
    } catch (error) {
      console.error("web meter release failed", error);
    }
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
