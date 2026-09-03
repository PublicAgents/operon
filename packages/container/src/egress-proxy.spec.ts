import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { INTERNAL_SUFFIX as CORE_INTERNAL_SUFFIX } from "@operon/core";
import type { WakeConfig } from "./config.js";
import {
  DEFAULT_EGRESS_ROUTES,
  EgressProxy,
  INTERNAL_SUFFIX,
  directHostsFrom,
  endToEndHeaders,
  parseBlocklist,
  parseEgressRoutes,
  parseUpstreamProxy,
  proxySessionEnv,
  routeFor,
  usesProxy,
  type EgressRoutes
} from "./egress-proxy.js";

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
    // A connection-specific field the origin sets on ITS connection: the
    // forwarder must not carry it to the session's connection.
    res.writeHead(200, {
      "content-type": "text/plain",
      connection: "close, x-hop-response",
      "x-hop-response": "origin-only"
    });
    res.end(`hello ${req.url}`);
  });
  return { port: await listen(server), headers };
}

interface Seen {
  kind: "connect" | "request";
  auth?: string;
  target: string;
}

/**
 * A stand-in upstream proxy: records what it was asked, then tunnels or
 * forwards to LOOPBACK on the requested port whatever the host says, so a
 * name like origin.example:PORT reaches the test origin without DNS (the
 * forwarder keeps loopback itself always direct, so a proxied path needs
 * a non-loopback name to exercise).
 */
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
    // Pass the request's headers on (minus the credential meant for us),
    // so the origin records exactly what the forwarder let through.
    const passed = { ...req.headers };
    delete passed["proxy-authorization"];
    const out = request(
      {
        host: "127.0.0.1",
        port: url.port,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...passed, host: url.host, "x-seen-by-upstream": "1" }
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
    const port = Number((req.url ?? "").split(":").pop());
    const target = connect({ host: "127.0.0.1", port }, () => {
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

/** A bare address here means "that proxy for everything". */
async function startForwarder(
  routes: string | EgressRoutes,
  direct: string[] = [],
  blocked: string[] = []
): Promise<{ url: string; port: number; logs: string[] }> {
  const logs: string[] = [];
  const proxy = new EgressProxy({
    routes: typeof routes === "string" ? parseEgressRoutes(JSON.stringify({ "*": routes })) : routes,
    direct,
    blocked,
    log: message => logs.push(message)
  });
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

function connectThrough(port: number, target: string): Promise<string> {
  return rawExchange(
    port,
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
    `GET /y HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`
  );
}

function fetchViaProxy(
  proxyPort: number,
  absolute: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const target = new URL(absolute);
    const req = request(
      { host: "127.0.0.1", port: proxyPort, path: absolute, headers: { host: target.host, ...extraHeaders } },
      res => {
        let body = "";
        res.on("data", chunk => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const BASIC = `Basic ${Buffer.from("user:p@ss w").toString("base64")}`;
const PROXY_A = { tls: false, hostname: "a.proxy.example", port: 7777 };
const PROXY_B = { tls: false, hostname: "b.proxy.example", port: 8888 };

describe("INTERNAL_SUFFIX", () => {
  it("matches @operon/core's, so the always-direct rule and the umbilical agree", () => {
    expect(INTERNAL_SUFFIX).toBe(CORE_INTERNAL_SUFFIX);
  });
});

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

describe("parseEgressRoutes", () => {
  it("defaults to everything direct, which needs no forwarder", () => {
    expect(DEFAULT_EGRESS_ROUTES).toEqual({ rules: [{ pattern: "*", target: "direct" }] });
    expect(usesProxy(DEFAULT_EGRESS_ROUTES)).toBe(false);
    expect(usesProxy(parseEgressRoutes('{"*": "direct", "docs.example": "direct"}'))).toBe(false);
    expect(usesProxy(parseEgressRoutes('{"docs.example": "http://a.proxy.example:7777"}'))).toBe(true);
  });

  it("reads a table of patterns to addresses or direct", () => {
    const routes = parseEgressRoutes(
      JSON.stringify({
        "*": "http://a.proxy.example:7777",
        "Docs.Example": "http://b.proxy.example:8888",
        "*.registry.example": "direct"
      })
    );
    expect(routes.rules).toEqual([
      { pattern: "*", target: PROXY_A },
      { pattern: "docs.example", target: PROXY_B },
      { pattern: "*.registry.example", target: "direct" }
    ]);
  });

  it("refuses malformed tables by name, a bare address included", () => {
    for (const bad of [
      "http://a.proxy.example:7777",
      "{not json",
      "[]",
      "{}",
      '{"*": 7}',
      '{"bad host": "http://p.example"}',
      '{"*.": "http://p.example"}',
      '{"*": "socks5://p.example"}'
    ]) {
      expect(() => parseEgressRoutes(bad)).toThrowError(/egress_proxy_invalid/);
    }
  });
});

describe("routeFor", () => {
  const routes = parseEgressRoutes(
    JSON.stringify({
      "*": "http://a.proxy.example:7777",
      "*.example.org": "http://b.proxy.example:8888",
      "deep.sub.example.org": "direct",
      "*.sub.example.org": "http://c.proxy.example:9999"
    })
  );

  it("picks the most specific match: exact, then longest domain, then the catch-all", () => {
    expect(routeFor(routes, "anything.test")).toEqual(PROXY_A);
    expect(routeFor(routes, "example.org")).toEqual(PROXY_B);
    expect(routeFor(routes, "www.example.org")).toEqual(PROXY_B);
    expect(routeFor(routes, "x.sub.example.org")).toMatchObject({ hostname: "c.proxy.example" });
    expect(routeFor(routes, "DEEP.sub.example.org")).toBe("direct");
  });

  it("sends an unmatched host direct when there is no catch-all", () => {
    const partial = parseEgressRoutes('{"docs.example": "http://a.proxy.example:7777"}');
    expect(routeFor(partial, "docs.example")).toEqual(PROXY_A);
    expect(routeFor(partial, "other.example")).toBe("direct");
  });
});

describe("directHostsFrom", () => {
  it("derives the chassis hosts from the wake config, so a new door needs no listing", () => {
    const config = {
      notifyUrl: "http://notify.operon.internal/notify",
      publishUrl: "http://publish.operon.internal/gatekeeper/publish",
      webUrl: "http://web.operon.internal",
      someFutureDoorUrl: "https://door.elsewhere.example:8443/x",
      notAUrl: "http://",
      mcpServers: [
        { name: "ga", type: "http", virtual: "mcp-ga.operon.internal" },
        { name: "local", type: "stdio", command: "npx", args: [] }
      ]
    } as unknown as WakeConfig;
    expect(directHostsFrom(config).sort()).toEqual(
      [
        "*.operon.internal",
        "door.elsewhere.example",
        "mcp-ga.operon.internal",
        "notify.operon.internal",
        "publish.operon.internal",
        "web.operon.internal"
      ].sort()
    );
  });
});

describe("parseBlocklist", () => {
  it("normalises host patterns and refuses anything else by name", () => {
    expect(parseBlocklist('[" Tracker.Example ", "*.ads.example", "*", "tracker.example"]')).toEqual([
      "tracker.example",
      "*.ads.example",
      "*"
    ]);
    for (const bad of ["not json", '"tracker.example"', "[7]", '["bad host"]']) {
      expect(() => parseBlocklist(bad)).toThrowError(/egress_blocklist_invalid/);
    }
  });
});

describe("proxySessionEnv", () => {
  it("sets the standard variables and spells the direct hosts in NO_PROXY form", () => {
    const env = proxySessionEnv("http://127.0.0.1:41415", ["*.operon.internal", "web.operon.internal"]);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:41415");
    expect(env.http_proxy).toBe("http://127.0.0.1:41415");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,.operon.internal,web.operon.internal");
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

    const target = `origin.example:${origin.port}`;
    const result = await fetchViaProxy(forwarder.port, `http://${target}/x?k=v`);
    expect(result).toMatchObject({ status: 200, body: "hello /x?k=v" });
    // The upstream saw the credential; the client never sent one.
    expect(upstream.seen).toEqual([{ kind: "request", auth: BASIC, target: `http://${target}/x?k=v` }]);
    expect(origin.headers[0]["x-seen-by-upstream"]).toBe("1");
    expect(origin.headers[0]["proxy-authorization"]).toBeUndefined();
    // The log names the host and the route, never the query.
    expect(forwarder.logs).toEqual([`egress proxy: GET ${target} via 127.0.0.1:${upstream.port}`]);
  });

  it("tunnels a CONNECT through the upstream and splices the sockets", async () => {
    const origin = await startOrigin();
    const upstream = await startUpstream();
    const forwarder = await startForwarder(`http://user:p%40ss%20w@127.0.0.1:${upstream.port}`);

    const target = `origin.example:${origin.port}`;
    const transcript = await connectThrough(forwarder.port, target);
    expect(transcript.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(true);
    expect(transcript).toContain("hello /y");
    expect(upstream.seen).toEqual([{ kind: "connect", auth: BASIC, target }]);
    expect(forwarder.logs).toEqual([`egress proxy: CONNECT ${target} via 127.0.0.1:${upstream.port}`]);
  });

  it("routes each host to its own upstream, the catch-all taking the rest", async () => {
    const origin = await startOrigin();
    const catchAll = await startUpstream();
    const forDocs = await startUpstream();
    const forwarder = await startForwarder({
      rules: [
        { pattern: "*", target: parseUpstreamProxy(`http://127.0.0.1:${catchAll.port}`) },
        { pattern: "*.docs.example", target: parseUpstreamProxy(`http://127.0.0.1:${forDocs.port}`) }
      ]
    });

    expect((await connectThrough(forwarder.port, `api.docs.example:${origin.port}`)).includes("hello /y")).toBe(
      true
    );
    expect((await connectThrough(forwarder.port, `other.example:${origin.port}`)).includes("hello /y")).toBe(true);
    expect(forDocs.seen.map(s => s.target)).toEqual([`api.docs.example:${origin.port}`]);
    expect(catchAll.seen.map(s => s.target)).toEqual([`other.example:${origin.port}`]);
  });

  it("goes direct to loopback whatever the table says, and to hosts the table marks direct", async () => {
    const origin = await startOrigin();
    const upstream = await startUpstream();
    const forwarder = await startForwarder({
      rules: [
        { pattern: "*", target: parseUpstreamProxy(`http://127.0.0.1:${upstream.port}`) },
        { pattern: "127.0.0.1", target: parseUpstreamProxy(`http://127.0.0.1:${upstream.port}`) },
        { pattern: "direct.example", target: "direct" }
      ]
    });

    // Loopback: the porch lives there; no table entry may send it away.
    const loopback = `127.0.0.1:${origin.port}`;
    const transcript = await connectThrough(forwarder.port, loopback);
    expect(transcript).toContain("hello /y");
    const viaHttp = await fetchViaProxy(forwarder.port, `http://${loopback}/z`);
    expect(viaHttp).toMatchObject({ status: 200, body: "hello /z" });
    expect(origin.headers.every(h => h["x-seen-by-upstream"] === undefined)).toBe(true);

    // A host marked direct is dialled by the forwarder itself (here an
    // unresolvable name, so the origin is unreachable), never the upstream.
    const marked = await connectThrough(forwarder.port, "direct.example:443");
    expect(marked).toContain("502 proxy_origin_unreachable");
    expect(upstream.seen).toEqual([]);
    expect(forwarder.logs).toEqual([
      `egress proxy: CONNECT ${loopback} direct`,
      `egress proxy: GET ${loopback} direct`,
      "egress proxy: CONNECT direct.example:443 direct"
    ]);
  });

  it("refuses blocklisted hosts on both paths, chassis hosts excepted", async () => {
    const origin = await startOrigin();
    const upstream = await startUpstream();
    const forwarder = await startForwarder(
      `http://127.0.0.1:${upstream.port}`,
      ["*.operon.internal"],
      ["tracker.example", "*.ads.example", "127.0.0.1"]
    );
    const blocked = await rawExchange(
      forwarder.port,
      "CONNECT tracker.example:443 HTTP/1.1\r\nHost: tracker.example:443\r\n\r\n"
    );
    expect(blocked).toContain("403 proxy_blocked_host");
    expect(await fetchViaProxy(forwarder.port, "http://cdn.ads.example/pixel")).toMatchObject({
      status: 403,
      body: "proxy_blocked_host"
    });
    // Nothing blocked reached the upstream, and the log names the decision.
    expect(upstream.seen).toEqual([]);
    expect(forwarder.logs).toEqual([
      "egress proxy: CONNECT tracker.example:443 blocked",
      "egress proxy: GET cdn.ads.example blocked"
    ]);
    // Loopback and the chassis's hosts stay direct even when listed.
    expect((await connectThrough(forwarder.port, `127.0.0.1:${origin.port}`)).includes("hello /y")).toBe(true);
    // An unlisted host still takes its route.
    expect((await connectThrough(forwarder.port, `origin.example:${origin.port}`)).includes("hello /y")).toBe(true);
    expect(upstream.seen.map(s => s.target)).toEqual([`origin.example:${origin.port}`]);
  });

  it("keeps the chassis's own hosts direct even when the table would proxy them", async () => {
    const upstream = await startUpstream();
    const forwarder = await startForwarder(`http://127.0.0.1:${upstream.port}`, [
      "*.operon.internal",
      "door.elsewhere.example"
    ]);
    for (const host of ["web.operon.internal", "mcp-ga.operon.internal", "door.elsewhere.example"]) {
      const transcript = await connectThrough(forwarder.port, `${host}:443`);
      expect(transcript).toContain("502 proxy_origin_unreachable");
      const plainHttp = await fetchViaProxy(forwarder.port, `http://${host}/mcp`);
      expect(plainHttp).toMatchObject({ status: 502, body: "proxy_origin_unreachable" });
    }
    expect(upstream.seen).toEqual([]);
    expect(forwarder.logs.every(line => line.endsWith(" direct"))).toBe(true);
  });

  it("reports an upstream refusal as a gateway failure, never as a challenge", async () => {
    const origin = await startOrigin();
    const upstream = await startUpstream({ refuseWith: 407 });
    const forwarder = await startForwarder(`http://127.0.0.1:${upstream.port}`);

    const target = `origin.example:${origin.port}`;
    const transcript = await rawExchange(forwarder.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
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
    expect(result).toMatchObject({ status: 502, body: "proxy_upstream_unreachable" });
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

  it("refuses a CONNECT port outside the TCP range instead of throwing from the dial", async () => {
    const upstream = await startUpstream();
    const forwarder = await startForwarder(`http://127.0.0.1:${upstream.port}`);
    for (const target of ["127.0.0.1:70000", "127.0.0.1:0", "example.test:99999"]) {
      const transcript = await rawExchange(forwarder.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      expect(transcript).toContain("400 proxy_bad_target");
    }
    expect(upstream.seen).toEqual([]);
    // The forwarder is still alive to serve the next request.
    const origin = await startOrigin();
    expect((await connectThrough(forwarder.port, `origin.example:${origin.port}`)).includes("hello /y")).toBe(true);
  });

  it("refuses an absolute-form port outside the TCP range without dialling anything", async () => {
    const upstream = await startUpstream();
    const forwarder = await startForwarder({
      rules: [
        { pattern: "*", target: parseUpstreamProxy(`http://127.0.0.1:${upstream.port}`) },
        { pattern: "direct.example", target: "direct" }
      ]
    });
    // Above the range the URL parser refuses it outright; at zero the
    // forwarder's own guard does, on the direct and the proxied path alike.
    // (Raw, since node's own client refuses to build such a URL.)
    const overRange = await rawExchange(
      forwarder.port,
      "GET http://direct.example:99999/x HTTP/1.1\r\nHost: direct.example:99999\r\n\r\n"
    );
    expect(overRange).toContain("400 Bad Request");
    expect(overRange).toContain("proxy_absolute_uri_required");
    expect(await fetchViaProxy(forwarder.port, "http://direct.example:0/x")).toMatchObject({
      status: 400,
      body: "proxy_bad_target"
    });
    expect(await fetchViaProxy(forwarder.port, "http://proxied.example:0/x")).toMatchObject({
      status: 400,
      body: "proxy_bad_target"
    });
    expect(upstream.seen).toEqual([]);
    // Still serving afterwards.
    const origin = await startOrigin();
    expect(await fetchViaProxy(forwarder.port, `http://origin.example:${origin.port}/ok`)).toMatchObject({
      status: 200,
      body: "hello /ok"
    });
  });

  it("drops hop-by-hop headers in both directions", async () => {
    const origin = await startOrigin();
    const upstream = await startUpstream();
    const forwarder = await startForwarder(`http://127.0.0.1:${upstream.port}`);
    const result = await fetchViaProxy(forwarder.port, `http://origin.example:${origin.port}/h`, {
      connection: "keep-alive, x-hop-request",
      "x-hop-request": "session-only",
      te: "trailers",
      "keep-alive": "timeout=5",
      "x-end-to-end": "kept"
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe("hello /h");
    // The origin saw the end-to-end field and none of the connection-bound ones.
    const seen = origin.headers[0];
    expect(seen["x-end-to-end"]).toBe("kept");
    expect(seen["x-hop-request"]).toBeUndefined();
    expect(seen.te).toBeUndefined();
    expect(seen["keep-alive"]).toBeUndefined();
    // And the origin's connection-bound response field never reached the session.
    expect(result.headers["x-hop-response"]).toBeUndefined();
    expect(result.headers["content-type"]).toBe("text/plain");
  });
});

describe("endToEndHeaders", () => {
  it("removes the hop-by-hop set and whatever Connection names, keeping the rest", () => {
    expect(
      endToEndHeaders({
        host: "origin.example",
        Connection: "close, X-Custom",
        "x-custom": "1",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        "proxy-authorization": "Basic x",
        accept: ["text/html", "*/*"],
        dropped: undefined
      })
    ).toEqual({ host: "origin.example", accept: ["text/html", "*/*"] });
  });
});
