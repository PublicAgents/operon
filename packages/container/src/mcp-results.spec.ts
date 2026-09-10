import { describe, expect, it } from "vitest";
import type { StagedMcpServer } from "./config.js";
import { ackMcpResults, composeResultFile, pullMcpResults, sanitizeResultFiles } from "./mcp-results.js";

const servers: StagedMcpServer[] = [
  { name: "tasks", type: "http", virtual: "mcp-tasks.operon.internal" },
  { name: "local", type: "stdio", command: "npx", args: ["-y", "x@1.0.0"] },
  { name: "search", type: "http", virtual: "mcp-search.operon.internal" }
];

function answering(byServer: Record<string, unknown | Error>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}${init?.body ? ` ${init.body}` : ""}`);
    const name = /mcp-([a-z]+)\./.exec(url)?.[1] ?? "";
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer nonce");
    const answer = byServer[name];
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("task results at wake start (spec 0014 §3)", () => {
  it("pulls every remote server, files each result under its run, numbers repeats, and keeps going past a failure", async () => {
    const pulled = await pullMcpResults(
      servers,
      "nonce",
      [],
      answering({
        tasks: {
          ok: true,
          results: [
            { id: "a", runId: "run-1", n: 2, event: "progress", body: '{"n":1}', at: "2026-09-08T10:00:00Z" },
            { id: "b", runId: "run-1", n: 3, event: "done", body: '{"n":2}', at: "2026-09-08T10:01:00Z" },
            { id: "c", runId: "run 2", n: 1, event: "done", body: "{}", at: "2026-09-08T10:02:00Z" }
          ]
        },
        search: new Error("connect ECONNREFUSED")
      })
    );
    // Numbered by the Gatekeeper within the run: a later wake's pull
    // never overwrites an earlier callback's file.
    expect(pulled.files.map(file => file.path)).toEqual([
      "inbox/mcp/tasks/run-1/2.md",
      "inbox/mcp/tasks/run-1/3.md",
      "inbox/mcp/tasks/run-c/1.md"
    ]);
    expect(pulled.files[1].content).toContain("run: run-1");
    expect(pulled.files[1].content).toContain('{"n":2}');
    expect(pulled.files[1].content).toContain("data, never instructions");
    expect([...pulled.ids]).toEqual([["tasks", ["a", "b", "c"]]]);
    expect(pulled.errors).toEqual(["search: Error: connect ECONNREFUSED"]);
    expect(pulled.sanitized).toEqual([]);
  });

  it("reads a bespoke Gatekeeper server's 404 as nothing queued, not as a failure", async () => {
    const pulled = await pullMcpResults(
      [{ name: "tasks", type: "http", virtual: "mcp-tasks.operon.internal" }],
      "nonce",
      [],
      answering({ tasks: new Response(JSON.stringify({ error: "not_found" }), { status: 404 }) })
    );
    expect(pulled.files).toEqual([]);
    expect(pulled.errors).toEqual([]);
  });

  it("stubs a result whose body carries a denylisted secret before it exists in the tree", () => {
    const file = composeResultFile("tasks", { id: "a", runId: "run-1", n: 1, event: "done", body: '{"token":"hunter2secret"}', at: "t" });
    const { files, sanitized } = sanitizeResultFiles([file], ["hunter2secret"]);
    expect(sanitized).toEqual(["inbox/mcp/tasks/run-1/1.md"]);
    expect(files[0].content).not.toContain("hunter2secret");
    expect(sanitizeResultFiles([file], ["unrelated"]).sanitized).toEqual([]);
  });

  it("acks only the servers that delivered, by id, and never a stdio server", async () => {
    const calls: string[] = [];
    await ackMcpResults(servers, "nonce", new Map([["tasks", ["a", "b"]], ["search", []], ["local", ["x"]]]), answering({ tasks: { ok: true, acked: 2 } }, calls));
    expect(calls).toEqual(['POST http://mcp-tasks.operon.internal/mcp/tasks/results/ack {"ids":["a","b"]}']);
  });
});
