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
  it("refuses to replay a request body to another origin", async () => {
    const mock = mockUpstream({
      revision: "stateless",
      tools: TOOLS,
      redirectTo: "https://elsewhere.example.net/mcp"
    });
    await expect(
      withUpstream({ url: URL_ }, { fetch: mock.fetch }, listUpstreamTools)
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("refuses a catalog larger than the bound instead of truncating it", async () => {
    const mock = mockUpstream({ revision: "stateless", tools: TOOLS, padBytes: 200 });
    await expect(
      withUpstream({ url: URL_ }, { fetch: mock.fetch, maxBytes: 100 }, listUpstreamTools)
    ).rejects.toMatchObject({ code: "mcp_upstream_unreachable" });
  });
});

describe("catalogRevision", () => {
  it("changes when a tool is added, removed, or flips read-only", () => {
    const base = catalogRevision(TOOLS);
    expect(catalogRevision([...TOOLS].reverse())).toBe(base);
    expect(catalogRevision(TOOLS.slice(0, 2))).not.toBe(base);
    expect(
      catalogRevision([
        { ...TOOLS[0], annotations: { readOnlyHint: false } },
        TOOLS[1],
        TOOLS[2]
      ])
    ).not.toBe(base);
  });
});
