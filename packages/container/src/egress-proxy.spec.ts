import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { EgressProxy, parseUpstreamProxy, proxySessionEnv } from "./egress-proxy.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return address.port;
}

/** The origin the session wants to reach: echoes the path and records headers. */
async function startOrigin(): Promise<{ port: number; headers: IncomingMessage["headers"][] }> {
  const headers: IncomingMessage["headers"][] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`hello ${req.url}`);
  });
  return { port: await listen(server), headers };
}

interface Seen {
  kind: "connect" | "request";
  auth?: string;
  target: string;
}

/** A stand-in upstream proxy: records what it was asked, tunnels or forwards. */
async function startUpstream(options: { refuseWith?: number } = {}): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ kind: "request", auth: req.headers["proxy-authorization"], target: req.url ?? "" });
    if (options.refuseWith) {
      res.writeHead(options.refuseWith);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "");
    const out = request(
      {
        host: url.hostname,
        port: url.port,
        method: req.method,
        path: url.pathname + url.search,
        headers: { host: url.host, "x-seen-by-upstream": "1" }
      },
      up => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    req.pipe(out);
  });
  server.on("connect", (req, socket, head) => {
    seen.push({ kind: "connect", auth: req.headers["proxy-authorization"], target: req.url ?? "" });
    if (options.refuseWith) {
      socket.end(`HTTP/1.1 ${options.refuseWith} Refused\r\nConnection: close\r\n\r\n`);
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const target = connect({ host, port: Number(port) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
  });
  return { port: await listen(server), seen };
}

async function startForwarder(upstream: string): Promise<{ url: string; port: number; logs: string[] }> {
  const logs: string[] = [];
  const proxy = new EgressProxy({ upstream, log: message => logs.push(message) });
  const url = await proxy.start(0);
  cleanups.push(() => proxy.close());
  return { url, port: Number(new URL(url).port), logs };
}

/**
 * Speak raw HTTP over a socket: send `opening` on connect, then once the
 * first response head has arrived send `afterHead` (if any) through the
 * same socket, and collect everything until the peer closes it.
 */
function rawExchange(port: number, opening: string, afterHead?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    let sentAfterHead = false;
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(opening));
    socket.on("data", chunk => {
      received += chunk.toString();
      if (afterHead && !sentAfterHead && received.includes("\r\n\r\n")) {
        sentAfterHead = true;
        socket.write(afterHead);
      }
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
}

function fetchViaProxy(proxyPort: number, absolute: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(absolute);
    const req = request(
      { host: "127.0.0.1", port: proxyPort, path: absolute, headers: { host: target.host } },
      res => {
        let body = "";
        res.on("data", chunk => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const BASIC = `Basic ${Buffer.from("user:p@ss w").toString("base64")}`;

describe("parseUpstreamProxy", () => {
  it("reads host, port, scheme, and percent-encoded credentials", () => {
    expect(parseUpstreamProxy("http://user:p%40ss%20w@proxy.example:7777")).toEqual({
      tls: false,
      hostname: "proxy.example",
      port: 7777,
      authorization: BASIC
    });
    expect(parseUpstreamProxy("https://proxy.example")).toEqual({
      tls: true,
      hostname: "proxy.example",
      port: 443
    });
    expect(parseUpstreamProxy("http://[::1]:3128").hostname).toBe("::1");
  });

  it("refuses anything that is not a bare proxy address", () => {
    for (const bad of [
      "not a url",
      "socks5://proxy.example:1080",
      "http://proxy.example/path",
      "http://proxy.example/?q=1",
      "http://us%ZZer@proxy.example"
    ]) {
      expect(() => parseUpstreamProxy(bad)).toThrowError(/egress_proxy_invalid/);
    }
  });
});

describe("proxySessionEnv", () => {
  it("sets the standard variables, keeps loopback direct, and appends the bypass list", () => {
    const env = proxySessionEnv("http://127.0.0.1:41415", ["registry.example", ".internal.example"]);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:41415");
    expect(env.http_proxy).toBe("http://127.0.0.1:41415");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,registry.example,.internal.example");
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
  });
});

describe("EgressProxy", () => {
  it("listens on loopback only", async () => {
    const upstream = await startUpstream();
    const { url } = await startForwarder(`http://127.0.0.1:${upstream.port}`);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("forwards an absolute-form request through the upstream, adding the credential", async () => {
    const origin = await startOrigin();
    const upstream = await startUpstream();
    const forwarder = await startForwarder(`http://user:p%40ss%20w@127.0.0.1:${upstream.port}`);

    const result = await fetchViaProxy(forwarder.port, `http://127.0.0.1:${origin.port}/x?k=v`);
    expect(result).toEqual({ status: 200, body: "hello /x?k=v" });
    // The upstream saw the credential; the client never sent one.
    expect(upstream.seen).toEqual([
      { kind: "request", auth: BASIC, target: `http://127.0.0.1:${origin.port}/x?k=v` }
    ]);
    expect(origin.headers[0]["x-seen-by-upstream"]).toBe("1");
    expect(origin.headers[0]["proxy-authorization"]).toBeUndefined();
    // The log names the host, never the query.
    expect(forwarder.logs).toEqual([`egress proxy: GET 127.0.0.1:${origin.port}`]);
  });

  it("tunnels a CONNECT through the upstream and splices the sockets", async () => {
    const origin = await startOrigin();
    const upstream = await startUpstream();
    const forwarder = await startForwarder(`http://user:p%40ss%20w@127.0.0.1:${upstream.port}`);

    const target = `127.0.0.1:${origin.port}`;
    const transcript = await rawExchange(
      forwarder.port,
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
      `GET /y HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`
    );
    expect(transcript.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(true);
    expect(transcript).toContain("hello /y");
    expect(upstream.seen).toEqual([{ kind: "connect", auth: BASIC, target }]);
    expect(forwarder.logs).toEqual([`egress proxy: CONNECT ${target}`]);
  });

  it("reports an upstream refusal as a gateway failure, never as a challenge", async () => {
    const origin = await startOrigin();
    const upstream = await startUpstream({ refuseWith: 407 });
    const forwarder = await startForwarder(`http://127.0.0.1:${upstream.port}`);

    const target = `127.0.0.1:${origin.port}`;
    const transcript = await rawExchange(
      forwarder.port,
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`
    );
    expect(transcript).toContain("502 proxy_upstream_refused");

    const result = await fetchViaProxy(forwarder.port, `http://${target}/z`);
    expect(result.status).toBe(502);
    expect(result.body).toBe("proxy_upstream_refused");
    expect(forwarder.logs.filter(line => line.includes("refused upstream (407)"))).toHaveLength(2);
  });

  it("reports an unreachable upstream", async () => {
    // A port that was listening a moment ago and is now closed.
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    const closedPort = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const forwarder = await startForwarder(`http://127.0.0.1:${closedPort}`);

    const transcript = await rawExchange(
      forwarder.port,
      "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n"
    );
    expect(transcript).toContain("502 proxy_upstream_unreachable");
    const result = await fetchViaProxy(forwarder.port, "http://example.test/");
    expect(result).toEqual({ status: 502, body: "proxy_upstream_unreachable" });
  });

  it("refuses malformed targets and non-absolute requests", async () => {
    const upstream = await startUpstream();
    const forwarder = await startForwarder(`http://127.0.0.1:${upstream.port}`);
    const transcript = await rawExchange(
      forwarder.port,
      "CONNECT example.test HTTP/1.1\r\nHost: example.test\r\n\r\n"
    );
    expect(transcript).toContain("400 proxy_bad_target");
    const relative = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: forwarder.port, path: "/relative" }, res => {
        let body = "";
        res.on("data", chunk => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(relative).toEqual({ status: 400, body: "proxy_absolute_uri_required" });
    expect(upstream.seen).toEqual([]);
  });
});
