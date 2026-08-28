import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";

/**
 * The porch's WebSocket relay for the web door (spec 0004). The mind's
 * CDP client (chrome-devtools-mcp, or a connectOverCDP script) opens a
 * ws to the porch; the porch relays it to the web door over the
 * umbilical, attaching the per-wake nonce, exactly like every other
 * door but for a long-lived upgrade instead of one request.
 *
 * Raw socket piping, no ws dependency: on an HTTP Upgrade the porch
 * dials the internal web URL with the same Upgrade, and once the
 * upstream answers 101 the two TCP sockets are spliced. The mind never
 * sees the nonce (root holds it); a browser page cannot reach here (the
 * x-operon-porch header forces a preflight the porch refuses, below).
 */

const SESSION_PATH = /^\/web\/session\/[a-z0-9][a-z0-9-]{0,63}$/;

export interface WebRelayConfig {
  webUrl?: string;
  webToken?: string;
  /** This wake's id: the meter buckets concurrency and minutes by it. */
  wakeId?: string;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Handle an HTTP Upgrade on the porch. Returns true if it took
 * responsibility for the socket (relayed or refused), false if the path
 * is not a web-door path and the caller should refuse it itself.
 */
export function handleWebUpgrade(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  config: WebRelayConfig
): boolean {
  const url = new URL(request.url ?? "/", "http://porch");
  if (!SESSION_PATH.test(url.pathname)) return false;

  // Same CSRF fence as the request path: a browser cannot set this.
  if (request.headers["x-operon-porch"] !== "1") {
    refuse(clientSocket, 403, "porch_header_missing");
    return true;
  }
  if (!config.webUrl || !config.webToken) {
    refuse(clientSocket, 503, "web_not_wired");
    return true;
  }

  const upstream = new URL(config.webUrl.replace(/\/$/, "") + url.pathname + url.search);
  const proxied = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port || 80,
    path: upstream.pathname + upstream.search,
    method: "GET",
    headers: {
      ...request.headers,
      host: upstream.host,
      // The nonce is this door's bearer; the umbilical validates it and
      // swaps in binding-only auth. Root holds it, never the session.
      authorization: `Bearer ${config.webToken}`,
      // The meter buckets per wake; without this every wake would share
      // one "unknown" bucket and closed sessions would exhaust the cap.
      ...(config.wakeId ? { "x-operon-wake": config.wakeId } : {}),
      connection: "Upgrade",
      upgrade: "websocket"
    }
  });

  proxied.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    // Replay the upstream's 101 to the client, then splice the sockets.
    const lines = [`HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}`];
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upstreamHead?.length) clientSocket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);

    const drop = () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    };
    clientSocket.on("error", drop);
    upstreamSocket.on("error", drop);
    clientSocket.on("close", () => upstreamSocket.destroy());
    upstreamSocket.on("close", () => clientSocket.destroy());
  });

  proxied.on("response", response => {
    // No upgrade: relay the status so the client sees why (e.g. 503).
    refuse(clientSocket, response.statusCode ?? 502, response.statusMessage ?? "web_upstream_error");
  });
  proxied.on("error", () => refuse(clientSocket, 502, "web_upstream_unreachable"));
  proxied.end();
  return true;
}
