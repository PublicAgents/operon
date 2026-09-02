import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mockUpstream } from "./mock-upstream.js";
import { createProxyServer, type ProxyGrant } from "./proxy.js";
import { callUpstreamTool, listUpstreamTools, withUpstream } from "./upstream.js";

/**
 * The whole chain a wake sees: an MCP client (the mind's) talking to
 * the proxy over an in-memory transport, the proxy talking to a mock
 * upstream through the real upstream client.
 */
const URL_ = "https://upstream.example.com/mcp";
const OUTPUT = { type: "object", properties: { count: { type: "integer" } }, required: ["count"] };

async function throughProxy<T>(
  grant: ProxyGrant,
  tools: Parameters<typeof mockUpstream>[0]["tools"],
  use: (client: Client, events: Array<[string, Record<string, unknown>]>) => Promise<T>
): Promise<{ value: T; requests: ReturnType<typeof mockUpstream>["requests"] }> {
  const mock = mockUpstream({ revision: "stateless", tools });
  const events: Array<[string, Record<string, unknown>]> = [];
  const value = await withUpstream({ url: URL_ }, { fetch: mock.fetch }, async upstream => {
    const proxy = await createProxyServer(grant, {
      tools: await listUpstreamTools(upstream),
      call: (name, args) => callUpstreamTool(upstream, name, args),
      record: async (event, detail) => {
        events.push([event, detail]);
      }
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverSide);
    const client = new Client({ name: "mind", version: "0" });
    await client.connect(clientSide);
    try {
      return await use(client, events);
    } finally {
      await client.close();
      await proxy.close();
    }
  });
  return { value, requests: mock.requests };
}

const BYO: ProxyGrant = { name: "lv", trust: "byo", pinned: ["brief"] };

describe("the proxy's tool list", () => {
  it("relays the upstream's input and output schemas verbatim, for granted tools only", async () => {
    const { value } = await throughProxy(
      BYO,
      [
        { name: "brief", description: "Brief", outputSchema: OUTPUT },
        { name: "delete_everything", annotations: { readOnlyHint: true } }
      ],
      client => client.listTools()
    );
    expect(value.tools.map(tool => tool.name)).toEqual(["brief"]);
    // The mock advertises an empty object schema; that exact object must
    // arrive, not a schema the proxy invented.
    expect(value.tools[0].inputSchema).toEqual({ type: "object", properties: {} });
    expect(value.tools[0].outputSchema).toEqual(OUTPUT);
    expect(value.tools[0].description).toBe("Brief");
  });

  it("speaks the verdict's readOnlyHint, never the upstream's", async () => {
    const { value } = await throughProxy(
      { name: "lv", trust: "vetted", pinned: ["write_thing"] },
      [
        { name: "read_thing", annotations: { readOnlyHint: true } },
        { name: "write_thing", annotations: { readOnlyHint: true } }
      ],
      client => client.listTools()
    );
    const byName = Object.fromEntries(value.tools.map(tool => [tool.name, tool.annotations?.readOnlyHint]));
    expect(byName).toEqual({ read_thing: true, write_thing: false });
  });
});

describe("a call through the proxy", () => {
  it("forwards the arguments untouched and returns the upstream's result as the result", async () => {
    const { value, requests } = await throughProxy(
      BYO,
      [{ name: "brief", outputSchema: OUTPUT, structuredContent: { count: 2 }, result: { count: 2 } }],
      client => client.callTool({ name: "brief", arguments: { goal: "signups", channel: "web" } })
    );
    const forwarded = requests.find(
      request => (request.body as { method?: string })?.method === "tools/call"
    );
    expect((forwarded?.body as { params: { arguments: unknown } }).params.arguments).toEqual({
      goal: "signups",
      channel: "web"
    });
    expect(value.structuredContent).toEqual({ count: 2 });
    expect(value.isError).toBeFalsy();
  });

  it("refuses an ungranted tool by name and ledgers the refusal", async () => {
    const { value } = await throughProxy(
      BYO,
      [{ name: "brief" }, { name: "other" }],
      async (client, events) => {
        const result = await client.callTool({ name: "other", arguments: {} });
        return { result, events: [...events] };
      }
    );
    expect(value.result.isError).toBe(true);
    expect(JSON.stringify(value.result.content)).toContain("mcp_tool_needs_grant");
    expect(value.events.map(([event]) => event)).toContain("mcp_tool_refused");
  });

  it("reports an upstream refusal as a failed call, not a protocol fault", async () => {
    const { value } = await throughProxy(
      BYO,
      [{ name: "brief" }],
      async (client, events) => {
        // The mock answers a call to an unknown tool with a JSON-RPC error.
        const result = await client.callTool({ name: "brief", arguments: {} });
        return { result, events: [...events] };
      }
    );
    expect(value.events.map(([event]) => event)).toContain("mcp_tool_called");
    expect(value.result.isError).toBeFalsy();
  });
});
