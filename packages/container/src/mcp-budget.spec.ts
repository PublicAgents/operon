import { describe, expect, it } from "vitest";
import { budgetLine, describeBudget, readMcpBudgets } from "./mcp-budget.js";
import type { StagedMcpServer } from "./config.js";

const servers: StagedMcpServer[] = [
  { name: "search", type: "http", virtual: "mcp-search.operon.internal" },
  { name: "local", type: "stdio", command: "npx", args: ["-y", "x@1.0.0"] },
  { name: "tasks", type: "http", virtual: "mcp-tasks.operon.internal" }
];

function answering(byServer: Record<string, unknown | Error>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const name = /mcp-([a-z]+)\./.exec(url)?.[1] ?? "";
    expect(url).toBe(`http://mcp-${name}.operon.internal/mcp/${name}/budget`);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer nonce");
    const answer = byServer[name];
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("the metered servers' budgets at wake start (spec 0014 §2)", () => {
  it("reads every remote server, skips stdio, and keeps going past a failure", async () => {
    const views = await readMcpBudgets(
      servers,
      "nonce",
      answering({
        search: {
          ok: true,
          budgeted: true,
          remaining: { monthlyUsd: 120, spentMonthUsd: 3.5, allotmentTodayUsd: 4, spentTodayUsd: 0.1, remainingTodayUsd: 3.9, resetsAt: "2026-09-09T00:00:00.000Z" },
          perCall: { web_search: 0.02, web_fetch: 0.01 },
          free: []
        },
        tasks: new Error("umbilical refused")
      })
    );
    expect(views.map(view => view.server)).toEqual(["search", "tasks"]);
    expect(views[0]).toMatchObject({ budgeted: true, remainingTodayUsd: 3.9, perCall: { web_search: 0.02 } });
    expect(views[1]).toMatchObject({ budgeted: false, error: expect.stringContaining("umbilical refused") });
    expect(budgetLine(views)).toBe(
      "mcp budgets: search: $3.90 of $4.00 today (about 390 web_fetch), resets 00:00 UTC; $3.50 of $120.00 this month; tasks: budget unreadable (Error: umbilical refused)"
    );
  });

  it("says none when no server carries a budget", async () => {
    const views = await readMcpBudgets([servers[0]], "nonce", answering({ search: { ok: true, budgeted: false } }));
    expect(views).toEqual([{ server: "search", budgeted: false }]);
    expect(budgetLine(views)).toBe("mcp budgets: none");
    expect(describeBudget(views[0])).toBe("search: no budget");
  });
});
