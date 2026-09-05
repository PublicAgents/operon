import { describe, expect, it } from "vitest";
import { mockUpstream, type Revision } from "./mock-upstream.js";
import { UpstreamError } from "./guarded-fetch.js";
import { callUpstreamTool, catalogRevision, listUpstreamTools, withUpstream } from "./upstream.js";

const URL_ = "https://upstream.example.com/mcp";
const TOOLS = [
  { name: "search_issues", annotations: { readOnlyHint: true }, result: { rows: 2 } },
  { name: "create_issue", annotations: { readOnlyHint: false } },
  { name: "unannotated_tool" }
];

/**
 * The revision matrix. Both shapes run through the SAME code path,
 * which is the point: negotiation belongs to the official client, and
 * this is the standing proof it still works after an SDK bump.
 */
const REVISIONS: Revision[] = ["stateful", "stateless"];

describe.each(REVISIONS)("upstream over the %s revision", revision => {
  it("lists tools with their annotations intact", async () => {
    const mock = mockUpstream({ revision, tools: TOOLS });
    const tools = await withUpstream({ url: URL_ }, { fetch: mock.fetch }, listUpstreamTools);
    expect(tools.map(tool => tool.name)).toEqual([
      "search_issues",
      "create_issue",
      "unannotated_tool"
    ]);
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
    expect(tools[2].annotations?.readOnlyHint).toBeUndefined();
  });

  it("calls a tool and returns its result", async () => {
    const mock = mockUpstream({ revision, tools: TOOLS });
    const result = await withUpstream({ url: URL_ }, { fetch: mock.fetch }, client =>
      callUpstreamTool(client, "search_issues", { q: "open" })
    );
    expect(JSON.stringify(result)).toContain('rows');
  });

  it("carries the bearer on every request", async () => {
    const mock = mockUpstream({ revision, tools: TOOLS });
    await withUpstream({ url: URL_, bearer: "upstream-secret" }, { fetch: mock.fetch }, listUpstreamTools);
    expect(mock.requests.length).toBeGreaterThan(0);
  });

  it("names an upstream that refuses the credential", async () => {
    const mock = mockUpstream({ revision, tools: TOOLS, unauthorized: true });
    await expect(
      withUpstream({ url: URL_ }, { fetch: mock.fetch }, listUpstreamTools)
    ).rejects.toMatchObject({ code: "mcp_upstream_auth" });
  });
});

describe("the stateful revision specifically", () => {
  it("echoes the session id the upstream assigned", async () => {
    // The 2025 handshake requires it back on every later call; the mock
    // answers 400 if it is missing, so a client that drops it fails
    // here rather than in production.
    const mock = mockUpstream({ revision: "stateful", tools: TOOLS });
    await withUpstream({ url: URL_ }, { fetch: mock.fetch }, listUpstreamTools);
    const afterInit = mock.requests.filter(request => request.body?.method === "tools/list");
    expect(afterInit).toHaveLength(1);
    expect(afterInit[0].sessionId).toBe("mock-session-0001");
  });

  it("reports a session that expires mid-conversation", async () => {
    const mock = mockUpstream({ revision: "stateful", tools: TOOLS, expireAfterInitialize: true });
    await expect(
      withUpstream({ url: URL_ }, { fetch: mock.fetch }, listUpstreamTools)
    ).rejects.toMatchObject({ code: "mcp_upstream_auth" });
  });
});

describe("the stateless revision specifically", () => {
  it("sends no session id at all", async () => {
    const mock = mockUpstream({ revision: "stateless", tools: TOOLS });
    await withUpstream({ url: URL_ }, { fetch: mock.fetch }, listUpstreamTools);
    expect(mock.requests.every(request => request.sessionId === null)).toBe(true);
  });
});

describe("a revision this client does not know", () => {
  it("refuses by name rather than guessing at the protocol", async () => {
    // The SDK publishes which revisions it speaks and negotiates within
    // that list. A server answering with something newer is a refusal,
    // and bumping the SDK is what makes it speakable.
    const mock = mockUpstream({ revision: "future", tools: TOOLS });
    await expect(
      withUpstream({ url: URL_ }, { fetch: mock.fetch }, listUpstreamTools)
    ).rejects.toMatchObject({ code: "mcp_upstream_unreachable" });
    await expect(
      withUpstream({ url: URL_ }, { fetch: mock.fetch }, listUpstreamTools)
    ).rejects.toThrow(/protocol version/i);
  });
});

describe("hostile upstreams", () => {
  it("refuses to send a request body to another origin, whatever the redirect code", async () => {
    // 307/308 replay the body outright; 301/302/303 would either replay
    // it or silently become a GET. For an MCP call the body carries the
    // tool name and its arguments, so all of them are refused.
    for (const status of [301, 302, 303, 307, 308]) {
      const mock = mockUpstream({
        revision: "stateless",
        tools: TOOLS,
        redirectTo: "https://elsewhere.example.net/mcp",
        redirectStatus: status
      });
      await expect(
        withUpstream({ url: URL_ }, { fetch: mock.fetch }, listUpstreamTools)
      ).rejects.toMatchObject({ code: "mcp_upstream_unreachable" });
      // The other origin was never contacted at all.
      expect(mock.requests.map(request => request.url)).not.toContain(
        "https://elsewhere.example.net/mcp"
      );
    }
  });

  it("stops reading an oversized body instead of buffering it first", async () => {
    // An upstream that omits or under-declares content-length must not
    // get the whole body buffered before the bound is applied.
    const mock = mockUpstream({
      revision: "stateless",
      tools: TOOLS,
      padBytes: 5000,
      hideContentLength: true
    });
    await expect(
      withUpstream({ url: URL_ }, { fetch: mock.fetch, maxBytes: 500 }, listUpstreamTools)
    ).rejects.toMatchObject({ code: "mcp_upstream_unreachable" });
  });

  it("refuses a catalog larger than the bound instead of truncating it", async () => {
    const mock = mockUpstream({ revision: "stateless", tools: TOOLS, padBytes: 200 });
    await expect(
      withUpstream({ url: URL_ }, { fetch: mock.fetch, maxBytes: 100 }, listUpstreamTools)
    ).rejects.toMatchObject({ code: "mcp_upstream_unreachable" });
  });
});

describe("catalogRevision", () => {
  it("changes when a tool is added, removed, or flips read-only", async () => {
    const base = await catalogRevision(TOOLS);
    expect(await catalogRevision([...TOOLS].reverse())).toBe(base);
    expect(await catalogRevision(TOOLS.slice(0, 2))).not.toBe(base);
    expect(
      await catalogRevision([
        { ...TOOLS[0], annotations: { readOnlyHint: false } },
        TOOLS[1],
        TOOLS[2]
      ])
    ).not.toBe(base);
  });

  it("changes when a schema or description changes under a stable name, and not on key order", async () => {
    const base = await catalogRevision(TOOLS);
    const withSchema = [
      { ...TOOLS[0], inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      TOOLS[1],
      TOOLS[2]
    ];
    expect(await catalogRevision(withSchema)).not.toBe(base);
    expect(
      await catalogRevision([
        { ...TOOLS[0], inputSchema: { properties: { q: { type: "string" } }, type: "object" } },
        TOOLS[1],
        TOOLS[2]
      ])
    ).toBe(await catalogRevision(withSchema));
    expect(
      await catalogRevision([{ ...TOOLS[0], outputSchema: { type: "object" } }, TOOLS[1], TOOLS[2]])
    ).not.toBe(base);
    expect(
      await catalogRevision([{ ...TOOLS[0], description: "now does something else" }, TOOLS[1], TOOLS[2]])
    ).not.toBe(base);
    expect(
      await catalogRevision([{ ...TOOLS[0], title: "Search issues, renamed" }, TOOLS[1], TOOLS[2]])
    ).not.toBe(base);
    // An absent title is relayed as the name, an empty one as empty:
    // different offers, different revisions. A title equal to the name
    // is the same offer as no title, so the same revision.
    expect(await catalogRevision([{ ...TOOLS[0], title: "" }, TOOLS[1], TOOLS[2]])).not.toBe(base);
    expect(await catalogRevision([{ ...TOOLS[0], title: TOOLS[0].name }, TOOLS[1], TOOLS[2]])).toBe(base);
  });
});

/**
 * Tools that declare an outputSchema make the SDK client validate the
 * structuredContent of every call. The validator must be one that
 * INTERPRETS schemas: the SDK's default compiles them with
 * new Function, which the Workers runtime refuses, and the first live
 * upstream with output schemas (example.com) failed every call
 * that way. Node allows codegen, so these tests cannot catch a
 * regression to the default validator by themselves; they prove the
 * interpreting validator validates, and the wrangler probe in the PR
 * proves it runs under workerd.
 */
describe("tools with output schemas", () => {
  const SCHEMA = {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"]
  };

  it("calls a tool whose structured content satisfies its schema", async () => {
    const mock = mockUpstream({
      revision: "stateless",
      tools: [{ name: "count_things", outputSchema: SCHEMA, structuredContent: { count: 3 } }]
    });
    // Listed first, as the proxy does: the client validates only the
    // tools whose schemas it saw in this session.
    const result = (await withUpstream({ url: URL_ }, { fetch: mock.fetch }, async client => {
      await listUpstreamTools(client);
      return callUpstreamTool(client, "count_things", {});
    })) as { structuredContent?: unknown };
    expect(result.structuredContent).toEqual({ count: 3 });
  });

  it("refuses structured content that violates the schema, by name", async () => {
    const mock = mockUpstream({
      revision: "stateless",
      tools: [{ name: "count_things", outputSchema: SCHEMA, structuredContent: { count: "three" } }]
    });
    await expect(
      withUpstream({ url: URL_ }, { fetch: mock.fetch }, async client => {
        await listUpstreamTools(client);
        return callUpstreamTool(client, "count_things", {});
      })
    ).rejects.toMatchObject({ code: "mcp_upstream_unreachable" });
  });
});
