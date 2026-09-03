import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import type { WakeConfig } from "./config.js";

/**
 * The outbound proxy forwarder: a loopback-only HTTP proxy the entrypoint
 * runs beside the porch when the deployment routes the mind session's
 * outbound HTTP through upstream proxies (spec 0004 section 8). The
 * session is handed the loopback address through the standard proxy
 * variables (HTTP_PROXY, HTTPS_PROXY, NO_PROXY), so curl, git, npm, and
 * node clients route through it unchanged. The forwarder decides per
 * destination host which upstream proxy carries the request (or none),
 * and attaches that upstream's credential, which the session never
 * holds: root runs the forwarder, exactly as root holds the door tokens
 * behind the porch.
 *
 * Routing is a table of host patterns (spec 0004 section 8): "*" is the
 * catch-all, "host.example" an exact host, "*.example" a domain and its
 * subdomains; the most specific match wins, and a value of "direct" means
 * no proxy. The default table is {"*": "direct"}, under which no
 * forwarder runs unless a blocklist needs enforcing. A blocklist (spec
 * 0004 §5, the same list the browser door enforces) names hosts the
 * session may not reach: the forwarder answers 403 for them, which
 * holds for every client that honours the proxy variables (the rest of
 * container egress stays observe-only, as section 8 says). Hosts the chassis itself serves (loopback, the umbilical's
 * virtual hosts, every door URL the wake was handed) are ALWAYS direct,
 * derived from the wake config rather than listed in it, so a new door
 * cannot be forgotten.
 *
 * Two request shapes, both plain HTTP/1.1 proxying with no dependency:
 *  - CONNECT host:port (every https:// URL): a tunnel is opened (through
 *    the chosen upstream, or straight to the origin) and the two sockets
 *    are spliced. TLS stays end to end between the session and the
 *    origin, so the forwarder (and the log) sees hostnames only.
 *  - Absolute-form requests (http:// URLs): forwarded as they arrive,
 *    the response piped back.
 *
 * Only the session runs with the proxy variables set. The entrypoint's
 * own traffic (the clone, the doors, persist, notify) is unaffected.
 */

export const EGRESS_PROXY_PORT = 41415;

/**
 * The umbilical's virtual-host suffix, duplicated from @operon/core (the
 * Docker build context is this package alone); egress-proxy.spec.ts
 * asserts the two agree.
 */
export const INTERNAL_SUFFIX = ".operon.internal";

export interface UpstreamProxy {
  tls: boolean;
  hostname: string;
  port: number;
  /** The Proxy-Authorization value, when the address carried credentials. */
  authorization?: string;
}

export type EgressTarget = UpstreamProxy | "direct";

export interface EgressRule {
  /** "*", an exact hostname, or "*.domain" (the domain and its subdomains). */
  pattern: string;
  target: EgressTarget;
}

export interface EgressRoutes {
  rules: EgressRule[];
}

/** No proxy for anything: the table a wake runs with when none is configured. */
export const DEFAULT_EGRESS_ROUTES: EgressRoutes = { rules: [{ pattern: "*", target: "direct" }] };

/** Does any route name an upstream? If not, there is nothing for a forwarder to do. */
export function usesProxy(routes: EgressRoutes): boolean {
  return routes.rules.some(rule => rule.target !== "direct");
}

/** The blocklist as the wake env carries it: a JSON array of host patterns. */
export function parseBlocklist(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EgressProxyError("egress_blocklist_invalid: not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new EgressProxyError("egress_blocklist_invalid: must be a JSON array");
  const patterns: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") throw new EgressProxyError("egress_blocklist_invalid: entries must be strings");
    const pattern = entry.trim().toLowerCase();
    if (pattern !== "*" && !HOST_PATTERN.test(pattern)) {
      throw new EgressProxyError(`egress_blocklist_invalid: bad host pattern "${entry}"`);
    }
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

export class EgressProxyError extends Error {
  override name = "EgressProxyError";
}

/**
 * http(s)://[user:pass@]host[:port] and nothing else: a proxy address has
 * no path or query, and anything that looks like one is a mistake worth
 * refusing rather than a URL worth guessing at.
 */
export function parseUpstreamProxy(raw: string): UpstreamProxy {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressProxyError("egress_proxy_invalid: not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EgressProxyError("egress_proxy_invalid: scheme must be http or https");
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new EgressProxyError("egress_proxy_invalid: a proxy address carries no path or query");
  }
  if (!url.hostname) throw new EgressProxyError("egress_proxy_invalid: missing host");
  const tls = url.protocol === "https:";
  const port = url.port ? Number(url.port) : tls ? 443 : 80;
  let authorization: string | undefined;
  if (url.username || url.password) {
    let user: string;
    let pass: string;
    try {
      user = decodeURIComponent(url.username);
      pass = decodeURIComponent(url.password);
    } catch {
      throw new EgressProxyError("egress_proxy_invalid: malformed credentials");
    }
    authorization = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
  }
  return {
    tls,
    // The URL parser keeps IPv6 brackets; the socket dial wants none.
    hostname: unbracket(url.hostname),
    port,
    ...(authorization ? { authorization } : {})
  };
}

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The route table: a JSON object of host pattern -> proxy address or
 * "direct", and nothing else (a bare address is refused: the table is
 * the one shape, so a reader never has to guess which form is in use).
 * Every entry is validated here, at wake start, so a typo fails the wake
 * by name instead of the first request.
 */
export function parseEgressRoutes(raw: string): EgressRoutes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EgressProxyError("egress_proxy_invalid: routes are not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EgressProxyError("egress_proxy_invalid: routes must be a JSON object");
  }
  const rules: EgressRule[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const pattern = key.trim().toLowerCase();
    if (pattern !== "*" && !HOST_PATTERN.test(pattern)) {
      throw new EgressProxyError(`egress_proxy_invalid: bad host pattern "${key}"`);
    }
    if (typeof value !== "string") {
      throw new EgressProxyError(`egress_proxy_invalid: route "${key}" must be a proxy address or "direct"`);
    }
    rules.push({ pattern, target: value.trim() === "direct" ? "direct" : parseUpstreamProxy(value) });
  }
  if (rules.length === 0) throw new EgressProxyError("egress_proxy_invalid: no routes");
  return { rules };
}

function unbracket(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1");
}

/** Does `host` match `pattern` ("*", exact, or "*.domain" incl. the domain itself)? */
export function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const domain = pattern.slice(2);
    return host === domain || host.endsWith(`.${domain}`);
  }
  return host === pattern;
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const kind = isIP(host);
  if (kind === 4) return host.startsWith("127.");
  if (kind === 6) return host === "::1" || /^(0*:)*:?0*1$/.test(host) || host.toLowerCase().startsWith("::ffff:127.");
  return false;
}

/**
 * The target for one destination host. Most specific wins: an exact
 * rule, then the longest matching "*.domain", then "*"; a host no rule
 * names goes direct.
 */
export function routeFor(routes: EgressRoutes, hostname: string): EgressTarget {
  const host = unbracket(hostname).toLowerCase();
  let best: { specificity: number; target: EgressTarget } | null = null;
  for (const rule of routes.rules) {
    if (!hostMatches(rule.pattern, host)) continue;
    const specificity =
      rule.pattern === "*" ? 0 : rule.pattern.startsWith("*.") ? 1 + rule.pattern.length : Number.MAX_SAFE_INTEGER;
    if (!best || specificity > best.specificity) best = { specificity, target: rule.target };
  }
  return best?.target ?? "direct";
}

/**
 * The hosts the chassis itself serves, always direct: the umbilical's
 * virtual hosts and every door URL in this wake's config (matched
 * generically, by the `Url` suffix, so a door added later is covered
 * without anyone remembering this list), plus the MCP virtual hosts.
 * Loopback is handled separately and needs no entry.
 */
export function directHostsFrom(config: WakeConfig): string[] {
  const hosts = new Set<string>([`*${INTERNAL_SUFFIX}`]);
  for (const [key, value] of Object.entries(config)) {
    if (!key.endsWith("Url") || typeof value !== "string") continue;
    try {
      hosts.add(unbracket(new URL(value).hostname).toLowerCase());
    } catch {
      // Not a URL: nothing to keep direct.
    }
  }
  for (const server of config.mcpServers) {
    if (server.type === "http") hosts.add(server.virtual.toLowerCase());
  }
  return [...hosts];
}

/**
 * The variables the session runs with. NO_PROXY carries loopback and the
 * always-direct hosts (in NO_PROXY's own ".domain" spelling) so clients
 * skip the forwarder for them; the forwarder enforces the same rule for
 * any client that ignores the variable. NODE_USE_ENV_PROXY makes node's
 * own fetch honour the variables, as curl and git already do.
 */
export function proxySessionEnv(proxyUrl: string, direct: readonly string[] = []): Record<string, string> {
  const noProxy = [
    "localhost",
    "127.0.0.1",
    "::1",
    ...direct.map(entry => (entry.startsWith("*.") ? entry.slice(1) : entry))
  ].join(",");
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: "1"
  };
}

export interface EgressProxyContext {
  routes: EgressRoutes;
  /** Always-direct host patterns (directHostsFrom); loopback is implied. */
  direct: readonly string[];
  /** Host patterns refused outright (spec 0004 §5); chassis hosts are never among them. */
  blocked?: readonly string[];
  log(message: string): void;
}

/** Where a destination goes: a route, or nowhere. */
export type EgressDecision = EgressTarget | "blocked";

const CONNECT_TARGET = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;
/** An upstream that answers a CONNECT with more head than this is not a proxy. */
const MAX_UPSTREAM_HEAD = 16 * 1024;

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function plain(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain", connection: "close" });
  response.end(text);
}

/**
 * Hop-by-hop fields belong to ONE connection (RFC 9110 section 7.6.1);
 * the forwarder terminates the session's connection and opens its own,
 * so they must not cross. Connection-specific proxy fields go with them,
 * and so does anything the Connection header itself names.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function endToEndHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[]> {
  const named = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "connection" || value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      for (const token of entry.split(",")) {
        const field = token.trim().toLowerCase();
        if (field) named.add(field);
      }
    }
  }
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key) || named.has(key)) continue;
    kept[name] = value;
  }
  return kept;
}

function describe(target: EgressDecision): string {
  if (target === "blocked") return "blocked";
  return target === "direct" ? "direct" : `via ${target.hostname}:${target.port}`;
}

export class EgressProxy {
  private server: Server | null = null;
  /** Spliced tunnel sockets: the HTTP server stops tracking a socket once CONNECT is handed over. */
  private readonly tunnels = new Set<Duplex>();

  constructor(private readonly context: EgressProxyContext) {}

  async start(port = EGRESS_PROXY_PORT): Promise<string> {
    this.server = createServer((request, response) => this.forward(request, response));
    this.server.on("connect", (request: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.tunnel(request, socket, head)
    );
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    return `http://127.0.0.1:${boundPort}`;
  }

  async close(): Promise<void> {
    for (const socket of this.tunnels) socket.destroy();
    this.tunnels.clear();
    this.server?.closeAllConnections();
    await new Promise<void>(resolve => this.server?.close(() => resolve()));
  }

  /**
   * Chassis-served hosts are direct whatever the table or the blocklist
   * says (blocking the porch would end the wake); a blocked host goes
   * nowhere; the table decides the rest.
   */
  targetFor(hostname: string): EgressDecision {
    const host = unbracket(hostname).toLowerCase();
    if (isLoopback(host) || this.context.direct.some(pattern => hostMatches(pattern, host))) return "direct";
    if (this.context.blocked?.some(pattern => hostMatches(pattern, host))) return "blocked";
    return routeFor(this.context.routes, host);
  }

  private dial(upstream: UpstreamProxy): Socket {
    const { tls, hostname, port } = upstream;
    return tls ? tlsConnect({ host: hostname, port, servername: hostname }) : netConnect({ host: hostname, port });
  }

  /** CONNECT: open the tunnel (through the chosen upstream, or to the origin), then splice. */
  private tunnel(request: IncomingMessage, client: Duplex, head: Buffer): void {
    const targetSpec = request.url ?? "";
    const match = CONNECT_TARGET.exec(targetSpec);
    if (!match) {
      refuse(client, 400, "proxy_bad_target");
      return;
    }
    const host = unbracket(match[1]);
    const port = Number(match[2]);
    // The regex bounds the digits, not the value: a port outside the TCP
    // range would throw synchronously from the dial, inside root.
    if (port < 1 || port > 65535) {
      refuse(client, 400, "proxy_bad_target");
      return;
    }
    const target = this.targetFor(host);
    this.context.log(`egress proxy: CONNECT ${targetSpec} ${describe(target)}`);
    if (target === "blocked") {
      refuse(client, 403, "proxy_blocked_host");
      return;
    }
    if (target === "direct") {
      const origin = netConnect({ host, port });
      let settled = false;
      origin.once("connect", () => {
        settled = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) origin.write(head);
        this.splice(client, origin);
      });
      origin.on("error", () => {
        if (!settled) refuse(client, 502, "proxy_origin_unreachable");
      });
      client.on("close", () => {
        if (!settled) origin.destroy();
      });
      return;
    }

    const upstream = this.dial(target);
    let settled = false;
    const failed = (status: number, reason: string) => {
      if (settled) return;
      settled = true;
      refuse(client, status, reason);
      upstream.destroy();
    };
    upstream.once(target.tls ? "secureConnect" : "connect", () => {
      upstream.write(
        `CONNECT ${targetSpec} HTTP/1.1\r\nHost: ${targetSpec}\r\n` +
          (target.authorization ? `Proxy-Authorization: ${target.authorization}\r\n` : "") +
          "\r\n"
      );
    });
    let buffered = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_UPSTREAM_HEAD) failed(502, "proxy_upstream_garbled");
        return;
      }
      upstream.off("data", onHead);
      const statusLine = buffered.subarray(0, end).toString("latin1");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
      if (status !== 200) {
        this.context.log(`egress proxy: CONNECT ${targetSpec} refused upstream (${status || "no status"})`);
        failed(502, "proxy_upstream_refused");
        return;
      }
      settled = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = buffered.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head.length) upstream.write(head);
      this.splice(client, upstream);
    };
    upstream.on("data", onHead);
    upstream.on("error", () => failed(502, "proxy_upstream_unreachable"));
    client.on("error", () => upstream.destroy());
    client.on("close", () => {
      if (!settled) upstream.destroy();
    });
  }

  private splice(client: Duplex, upstream: Socket): void {
    this.tunnels.add(client);
    this.tunnels.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      this.tunnels.delete(client);
      this.tunnels.delete(upstream);
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.on("close", drop);
    upstream.on("close", drop);
  }

  /** Absolute-form http:// request: forward through the chosen upstream, or to the origin. */
  private forward(request: IncomingMessage, response: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(request.url ?? "");
    } catch {
      plain(response, 400, "proxy_absolute_uri_required");
      return;
    }
    if (url.protocol !== "http:") {
      plain(response, 400, "proxy_http_only");
      return;
    }
    // The URL parser already refuses ports above 65535 (the request fails
    // above as not-a-URL); this closes the rest of the range so no port
    // ever reaches a dial unvalidated, the same rule as CONNECT.
    const port = url.port ? Number(url.port) : 80;
    if (port < 1 || port > 65535) {
      plain(response, 400, "proxy_bad_target");
      return;
    }
    const target = this.targetFor(url.hostname);
    // Host only, as with every egress line: a query string can carry secrets.
    this.context.log(`egress proxy: ${request.method} ${url.host} ${describe(target)}`);
    if (target === "blocked") {
      plain(response, 403, "proxy_blocked_host");
      return;
    }
    const headers = endToEndHeaders(request.headers);
    const proxied =
      target === "direct"
        ? httpRequest({
            host: unbracket(url.hostname),
            port,
            method: request.method,
            path: url.pathname + url.search,
            headers
          })
        : (target.tls ? httpsRequest : httpRequest)({
            host: target.hostname,
            port: target.port,
            method: request.method,
            path: request.url,
            headers: target.authorization ? { ...headers, "proxy-authorization": target.authorization } : headers,
            ...(target.tls ? { servername: target.hostname } : {})
          });
    proxied.on("response", upstreamResponse => {
      if (target !== "direct" && upstreamResponse.statusCode === 407) {
        // The upstream wants a credential the session cannot supply; say
        // so as a gateway failure rather than relaying a challenge.
        this.context.log(`egress proxy: ${request.method} ${url.host} refused upstream (407)`);
        upstreamResponse.resume();
        plain(response, 502, "proxy_upstream_refused");
        return;
      }
      // The same rule on the way back: the upstream's connection fields
      // describe ITS connection to us, not ours to the session.
      response.writeHead(upstreamResponse.statusCode ?? 502, endToEndHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    proxied.on("error", () => {
      const reason = target === "direct" ? "proxy_origin_unreachable" : "proxy_upstream_unreachable";
      if (!response.headersSent) plain(response, 502, reason);
      else response.destroy();
    });
    request.pipe(proxied);
  }
}
