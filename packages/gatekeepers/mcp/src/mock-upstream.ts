/**
 * A mock MCP upstream, for tests (spec 0008 §5).
 *
 * It speaks the wire, not a mock of our client: the point is to prove
 * our client against BOTH protocol revisions without depending on a
 * live server, and to prove it against upstreams that misbehave. The
 * matrix in the specs is the standing evidence that revision
 * negotiation still works after an SDK bump.
 *
 * Three shapes:
 *   stateful  initialize answers with an Mcp-Session-Id the client must
 *             echo on every later call (the 2025-06-18 handshake).
 *   stateless the same protocol with NO session id, which Streamable
 *             HTTP allows and newer servers prefer.
 *   future    a revision this client does not know, to pin what happens
 *             then: a named refusal, not a silent downgrade.
 *
 * Which revisions exist is the SDK's fact, not ours (it publishes
 * SUPPORTED_PROTOCOL_VERSIONS), so the matrix asserts behaviour against
 * what the installed client actually supports. Bumping the SDK is how a
 * newer revision becomes speakable, and this matrix is what tells us
 * whether that bump changed anything.
 */

export type Revision = "stateful" | "stateless" | "future";

export interface MockTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: unknown };
  result?: unknown;
  /** Declared on the tool; the SDK client then validates structuredContent against it. */
  outputSchema?: Record<string, unknown>;
  /** Returned beside the text content when set (must satisfy outputSchema). */
  structuredContent?: Record<string, unknown>;
}

export interface MockOptions {
  revision: Revision;
  tools: MockTool[];
  /** Answer everything with 401, as an upstream with a bad credential does. */
  unauthorized?: boolean;
  /** Answer initialize normally, then 401 mid-session. */
  expireAfterInitialize?: boolean;
  /** Redirect the first request here before serving. */
  redirectTo?: string;
  /** Which redirect code to answer with (default 307). */
  redirectStatus?: number;
  /** Answer in chunks with no content-length, as a streaming server does. */
  hideContentLength?: boolean;
  /** Pad the tools/list response past the body bound. */
  padBytes?: number;
}

const SESSION_ID = "mock-session-0001";
const PROTOCOL = {
  stateful: "2025-06-18",
  stateless: "2025-11-25",
  future: "2099-01-01"
} as const;

export interface MockServer {
  fetch: typeof fetch;
  /** Every request seen, for asserting what the client actually sent. */
  requests: Array<{ url: string; method: string; sessionId: string | null; body: unknown }>;
}

/**
 * Build a fetch that answers MCP JSON-RPC over Streamable HTTP. Only
 * the methods our proxy uses are implemented, because a mock that
 * answers more than the code under test can ask is a mock that hides
 * what the code actually does.
 */
export function mockUpstream(options: MockOptions): MockServer {
  const requests: MockServer["requests"] = [];
  let initialized = false;

  const respond = (body: unknown, extraHeaders: Record<string, string> = {}): Response => {
    const text = JSON.stringify(body);
    const headers = { "content-type": "application/json", ...extraHeaders };
    if (!options.hideContentLength) {
      return new Response(text, { status: 200, headers });
    }
    // Streamed in pieces with no content-length, which is what a real
    // chunked server does and what the byte bound must survive.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < text.length; i += 256) {
          controller.enqueue(encoder.encode(text.slice(i, i + 256)));
        }
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers });
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const raw = init?.body ? String(init.body) : "";
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ url, method, sessionId: headers.get("mcp-session-id"), body });

    if (options.redirectTo && requests.length === 1) {
      return new Response(null, {
        status: options.redirectStatus ?? 307,
        headers: { location: options.redirectTo }
      });
    }
    if (options.unauthorized) return new Response("unauthorized", { status: 401 });
    // A GET opens the server-to-client stream; nothing here pushes.
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 204 });

    const message = Array.isArray(body) ? body[0] : body;
    const id = message?.id;

    if (message?.method === "initialize") {
      initialized = true;
      return respond(
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL[options.revision],
            capabilities: { tools: {} },
            serverInfo: { name: "mock-upstream", version: "0.0.0" }
          }
        },
        options.revision === "stateful" ? { "mcp-session-id": SESSION_ID } : {}
      );
    }
    if (message?.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (options.expireAfterInitialize && initialized && message?.method !== "initialize") {
      return new Response("session expired", { status: 401 });
    }
    if (options.revision === "stateful" && headers.get("mcp-session-id") !== SESSION_ID) {
      // The 2025 revision requires the session id back on every call;
      // a client that drops it must fail loudly here, not silently.
      return new Response("missing session", { status: 400 });
    }
    if (message?.method === "tools/list") {
      const tools = options.tools.map(tool => ({
        name: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: { type: "object", properties: {} },
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {})
      }));
      const result: Record<string, unknown> = { tools };
      if (options.padBytes) result.padding = "x".repeat(options.padBytes);
      return respond({ jsonrpc: "2.0", id, result });
    }
    if (message?.method === "tools/call") {
      const tool = options.tools.find(entry => entry.name === message.params?.name);
      if (!tool) return respond({ jsonrpc: "2.0", id, error: { code: -32602, message: "no such tool" } });
      return respond({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(tool.result ?? { ok: true }) }],
          ...(tool.structuredContent ? { structuredContent: tool.structuredContent } : {})
        }
      });
    }
    return respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "not implemented" } });
  }) as typeof fetch;

  return { fetch: fetchImpl, requests };
}
