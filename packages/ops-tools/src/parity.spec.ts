import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { renderOpenApi } from "./openapi.js";
import { renderSkill } from "./docs.js";
import { z } from "zod";
import { createMcpServer, NO_AUDIT } from "./mcp.js";
import { TOOLS } from "./tools.js";
import { toolPath, type ToolContext } from "./types.js";

/**
 * The parity rule (spec 0005 §2), enforced: registry == REST paths ==
 * MCP tool list == SKILL table. A tool added to one surface without the
 * others cannot pass CI.
 */

const context: ToolContext = {
  operator: "spec",
  project: "spec-project",
  ops: async () => ({}),
  scheduler: async () => ({}),
  auditRecent: async () => []
};

describe("parity", () => {
  it("OpenAPI documents exactly the tools that exist, and no others", () => {
    const doc = renderOpenApi() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths).sort()).toEqual(
      TOOLS.map(tool => toolPath(tool.name)).sort()
    );
  });

  it("MCP advertises exactly the registry", async () => {
    const server = createMcpServer(context);
    const client = new Client({ name: "spec", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual(
      TOOLS.map(tool => tool.name).sort()
    );
    await client.close();
    await server.close();
  });

  it("the SKILL documents every tool and invents none", () => {
    const skill = renderSkill("https://ops.example.test");
    const documented = [...skill.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map(m => m[1]);
    expect(documented.sort()).toEqual(TOOLS.map(tool => tool.name).sort());
  });

  it("gives every tool the project argument, on both surfaces", async () => {
    for (const tool of TOOLS) {
      const schema = z.toJSONSchema(tool.input, { io: "input" }) as {
        properties?: Record<string, unknown>;
      };
      expect(schema.properties?.project, tool.name).toBeDefined();
    }
    const doc = renderOpenApi() as {
      paths: Record<string, { post: { requestBody: { content: Record<string, { schema: { properties?: Record<string, unknown> } }> } } }>;
    };
    for (const [path, entry] of Object.entries(doc.paths)) {
      expect(entry.post.requestBody.content["application/json"].schema.properties?.project, path).toBeDefined();
    }
  });

  it("binds each MCP call to the project it names", async () => {
    const seen: Array<string | undefined> = [];
    const server = createMcpServer(project => {
      seen.push(project);
      return { context: { ...context, project: project ?? "spec-project" }, audit: NO_AUDIT };
    });
    const client = new Client({ name: "spec", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "fleet_projects", arguments: { project: "other" } });
    const result = await client.callTool({ name: "fleet_projects", arguments: {} });
    expect(seen).toEqual(["other", undefined]);
    expect((result.structuredContent as { host: string }).host).toBe("spec-project");
    await client.close();
    await server.close();
  });

  it("marks untrusted-data caution on the surfaces agents read", () => {
    expect(renderSkill()).toMatch(/UNTRUSTED/);
    const doc = renderOpenApi() as { info: { description: string } };
    expect(doc.info.description).toMatch(/untrusted/i);
  });
});
