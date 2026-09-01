import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { guardedFetch, UpstreamError, type GuardedFetchOptions } from "./guarded-fetch.js";
import type { UpstreamTool } from "./classify.js";

/**
 * Talking to an upstream MCP server (spec 0008 §5).
 *
 * The client is the OFFICIAL SDK's, not a hand-rolled one, because the
 * thing worth not reimplementing is protocol-revision negotiation: the
 * 2025-era stateful handshake with `Mcp-Session-Id` and the stateless
 * 2026-07-28 revision differ in ways a bespoke client would get subtly
 * wrong and only discover against a real server. What we do own is the
 * transport's fetch, which is where the redirect and size guards live.
 *
 * Only tools/* is spoken. Prompts, resources, sampling and elicitation
 * are not implemented, and sampling in particular is not an oversight:
 * it would let an upstream drive the agent.
 */

export interface UpstreamConfig {
  url: string;
  /** Bearer for a plain http server; absent for a public one. */
  bearer?: string;
  /** Cloudflare Access service token, for a portal upstream. */
  accessClientId?: string;
  accessClientSecret?: string;
}

export interface UpstreamDeps extends GuardedFetchOptions {
  /** Injected in tests; production uses the SDK's own transport. */
  now?: () => number;
}

function authHeaders(config: UpstreamConfig): Record<string, string> {
  return {
    ...(config.bearer ? { authorization: `Bearer ${config.bearer}` } : {}),
    ...(config.accessClientId && config.accessClientSecret
      ? {
          "cf-access-client-id": config.accessClientId,
          "cf-access-client-secret": config.accessClientSecret
        }
      : {})
  };
}

/**
 * The transport's fetch: every request the SDK makes goes through the
 * guarded one, so redirect handling and body bounds cannot be bypassed
 * by a protocol path we did not anticipate.
 *
 * It also remembers whether the upstream ever answered 401/403. The
 * status is a FACT we hold here; by the time the SDK reports a failure
 * it is a sentence, and classifying a credential problem by matching
 * that sentence would break on the next SDK release.
 */
function transportFetch(deps: UpstreamDeps, seen: { auth: boolean }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const result = await guardedFetch(url, init ?? {}, deps);
    if (result.status === 401 || result.status === 403) seen.auth = true;
    // A bodyless answer (202 for a notification, 204 for a delete) must
    // stay bodyless: handing back an empty STRING makes it text/plain,
    // and the protocol rejects that content type.
    const bodyless = result.text.length === 0;
    return new Response(bodyless ? null : result.text, {
      status: result.status,
      headers: result.headers
    });
  }) as typeof fetch;
}

export async function withUpstream<T>(
  config: UpstreamConfig,
  deps: UpstreamDeps,
  use: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client(
    { name: "operon-gatekeeper-mcp", version: "0.0.0" },
    { capabilities: {} }
  );
  const seen = { auth: false };
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: transportFetch(deps, seen),
    requestInit: { headers: authHeaders(config) }
  });
  try {
    // connect() runs initialize, which is where revision negotiation
    // happens; a 401 here is an upstream credential problem, not ours.
    await client.connect(transport);
    return await use(client);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (seen.auth) throw new UpstreamError("mcp_upstream_auth", message.slice(0, 300));
    throw new UpstreamError("mcp_upstream_unreachable", message.slice(0, 300));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listUpstreamTools(client: Client): Promise<UpstreamTool[]> {
  const { tools } = await client.listTools();
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations as UpstreamTool["annotations"]
  })) as UpstreamTool[];
}

export async function callUpstreamTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return client.callTool({ name, arguments: args });
}

/**
 * A fingerprint of the catalog, so a changed tool list is adopted and
 * LEDGERED rather than adopted silently. Refusing to see new tools
 * would break working agents; not noticing is how a scope quietly
 * grows.
 */
export function catalogRevision(tools: UpstreamTool[]): string {
  const names = tools
    .map(tool => `${tool.name}:${tool.annotations?.readOnlyHint === true ? "r" : "w"}`)
    .sort()
    .join(",");
  let hash = 2166136261;
  for (let i = 0; i < names.length; i++) {
    hash ^= names.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
