import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

/**
 * The outbound proxy forwarder: a loopback-only HTTP proxy the entrypoint
 * runs beside the porch when the deployment names an upstream proxy for
 * the mind session's outbound HTTP (spec 0004 section 8). The session is
 * handed the loopback address through the standard proxy variables
 * (HTTP_PROXY, HTTPS_PROXY, NO_PROXY), so curl, git, npm, and node
 * clients route through it unchanged. The forwarder chains every request
 * to the upstream proxy and attaches the upstream's credential, which
 * the session never holds: root runs the forwarder, exactly as root
 * holds the door tokens behind the porch.
 *
 * Two request shapes, both plain HTTP/1.1 proxying with no dependency:
 *  - CONNECT host:port (every https:// URL): a tunnel is opened through
 *    the upstream and the two sockets are spliced. TLS stays end to end
 *    between the session and the origin, so the forwarder (and the log)
 *    sees hostnames only.
 *  - Absolute-form requests (http:// URLs): forwarded to the upstream as
 *    they arrive, the response piped back.
 *
 * Only the session runs with the proxy variables set. The entrypoint's
 * own traffic (the clone, the doors, persist, notify) is unaffected.
 */

export const EGRESS_PROXY_PORT = 41415;

export interface UpstreamProxy {
  tls: boolean;
  hostname: string;
  port: number;
  /** The Proxy-Authorization value, when the address carried credentials. */
  authorization?: string;
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
    hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port,
    ...(authorization ? { authorization } : {})
  };
}

/**
 * The variables the session runs with. Loopback is always direct (the
 * porch and this forwarder live there); the operator's bypass list names
 * further hosts that go direct. NODE_USE_ENV_PROXY makes node's own fetch
 * honour the variables, as curl and git already do.
 */
export function proxySessionEnv(
  proxyUrl: string,
  bypass: readonly string[] = []
): Record<string, string> {
  const direct = ["localhost", "127.0.0.1", "::1", ...bypass].join(",");
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: direct,
    no_proxy: direct,
    NODE_USE_ENV_PROXY: "1"
  };
}

export interface EgressProxyContext {
  /** The upstream proxy address, http(s)://[user:pass@]host[:port]. */
  upstream: string;
  log(message: string): void;
}

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

export class EgressProxy {
  private server: Server | null = null;
  private readonly upstream: UpstreamProxy;
  /** Spliced tunnel sockets: the HTTP server stops tracking a socket once CONNECT is handed over. */
  private readonly tunnels = new Set<Duplex>();

  constructor(private readonly context: EgressProxyContext) {
    this.upstream = parseUpstreamProxy(context.upstream);
  }

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

  private dial(): Socket {
    const { tls, hostname, port } = this.upstream;
    return tls ? tlsConnect({ host: hostname, port, servername: hostname }) : netConnect({ host: hostname, port });
  }

  /** CONNECT: open the same tunnel through the upstream, then splice. */
  private tunnel(request: IncomingMessage, client: Duplex, head: Buffer): void {
    const target = request.url ?? "";
    if (!CONNECT_TARGET.test(target)) {
      refuse(client, 400, "proxy_bad_target");
      return;
    }
    this.context.log(`egress proxy: CONNECT ${target}`);
    const upstream = this.dial();
    let settled = false;
    const failed = (status: number, reason: string) => {
      if (settled) return;
      settled = true;
      refuse(client, status, reason);
      upstream.destroy();
    };
    upstream.once(this.upstream.tls ? "secureConnect" : "connect", () => {
      upstream.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
          (this.upstream.authorization ? `Proxy-Authorization: ${this.upstream.authorization}\r\n` : "") +
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
        this.context.log(`egress proxy: CONNECT ${target} refused upstream (${status || "no status"})`);
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

  /** Absolute-form http:// request: forward to the upstream as is, plus the credential. */
  private forward(request: IncomingMessage, response: ServerResponse): void {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      plain(response, 400, "proxy_absolute_uri_required");
      return;
    }
    if (target.protocol !== "http:") {
      plain(response, 400, "proxy_http_only");
      return;
    }
    // Host only, as with every egress line: a query string can carry secrets.
    this.context.log(`egress proxy: ${request.method} ${target.host}`);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || name === "proxy-authorization" || name === "proxy-connection") continue;
      headers[name] = value;
    }
    if (this.upstream.authorization) headers["proxy-authorization"] = this.upstream.authorization;
    const proxied = (this.upstream.tls ? httpsRequest : httpRequest)({
      host: this.upstream.hostname,
      port: this.upstream.port,
      method: request.method,
      path: request.url,
      headers,
      ...(this.upstream.tls ? { servername: this.upstream.hostname } : {})
    });
    proxied.on("response", upstreamResponse => {
      if (upstreamResponse.statusCode === 407) {
        // The upstream wants a credential the session cannot supply; say
        // so as a gateway failure rather than relaying a challenge.
        this.context.log(`egress proxy: ${request.method} ${target.host} refused upstream (407)`);
        upstreamResponse.resume();
        plain(response, 502, "proxy_upstream_refused");
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    proxied.on("error", () => {
      if (!response.headersSent) plain(response, 502, "proxy_upstream_unreachable");
      else response.destroy();
    });
    request.pipe(proxied);
  }
}
