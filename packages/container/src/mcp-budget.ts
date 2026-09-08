import type { StagedMcpServer } from "./config.js";

/**
 * The remaining figures of every budgeted MCP server this wake may
 * reach (spec 0014 §2), read from the mcp Gatekeeper through the
 * umbilical at wake start and on demand. A server without a budget
 * answers `budgeted: false`; a server that cannot be read answers an
 * error rather than a guess, and the wake goes on.
 */
export interface McpBudgetView {
  server: string;
  budgeted: boolean;
  monthlyUsd?: number;
  spentMonthUsd?: number;
  allotmentTodayUsd?: number;
  spentTodayUsd?: number;
  remainingTodayUsd?: number;
  resetsAt?: string;
  perCall?: Record<string, number>;
  free?: string[];
  error?: string;
}

const READ_TIMEOUT_MS = 8_000;

export async function readMcpBudgets(
  servers: readonly StagedMcpServer[],
  token: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<McpBudgetView[]> {
  const out: McpBudgetView[] = [];
  for (const server of servers) {
    if (server.type !== "http") continue;
    try {
      const response = await fetchImpl(`http://${server.virtual}/mcp/${server.name}/budget`, {
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-operon-porch": "1" },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS)
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        budgeted?: boolean;
        error?: string;
        remaining?: Record<string, unknown>;
        perCall?: Record<string, number>;
        free?: string[];
      };
      if (!response.ok || body.ok === false) {
        out.push({ server: server.name, budgeted: false, error: body.error ?? `${response.status}` });
        continue;
      }
      if (!body.budgeted) {
        out.push({ server: server.name, budgeted: false });
        continue;
      }
      const r = body.remaining ?? {};
      const num = (key: string) => (typeof r[key] === "number" ? (r[key] as number) : undefined);
      out.push({
        server: server.name,
        budgeted: true,
        monthlyUsd: num("monthlyUsd"),
        spentMonthUsd: num("spentMonthUsd"),
        allotmentTodayUsd: num("allotmentTodayUsd"),
        spentTodayUsd: num("spentTodayUsd"),
        remainingTodayUsd: num("remainingTodayUsd"),
        resetsAt: typeof r.resetsAt === "string" ? r.resetsAt : undefined,
        perCall: body.perCall ?? {},
        free: body.free ?? []
      });
    } catch (error) {
      out.push({ server: server.name, budgeted: false, error: String(error).slice(0, 160) });
    }
  }
  return out;
}

/** The cheapest priced tool, for the "about N calls" a mind plans with. */
function cheapest(perCall: Record<string, number> | undefined): { tool: string; usd: number } | undefined {
  let best: { tool: string; usd: number } | undefined;
  for (const [tool, usd] of Object.entries(perCall ?? {})) {
    if (usd > 0 && (best === undefined || usd < best.usd)) best = { tool, usd };
  }
  return best;
}

/** One line per budgeted server, the figures a mind plans against. */
export function describeBudget(view: McpBudgetView): string {
  if (!view.budgeted) return view.error ? `${view.server}: budget unreadable (${view.error})` : `${view.server}: no budget`;
  const remaining = view.remainingTodayUsd ?? 0;
  const about = cheapest(view.perCall);
  const calls = about ? ` (about ${Math.floor(remaining / about.usd)} ${about.tool})` : "";
  const reset = view.resetsAt ? `, resets ${view.resetsAt.slice(11, 16)} UTC` : "";
  return `${view.server}: $${remaining.toFixed(2)} of $${(view.allotmentTodayUsd ?? 0).toFixed(2)} today${calls}${reset}; $${(view.spentMonthUsd ?? 0).toFixed(2)} of $${(view.monthlyUsd ?? 0).toFixed(2)} this month`;
}

/** The wake-start line: every budgeted server, or none. */
export function budgetLine(views: readonly McpBudgetView[]): string {
  const budgeted = views.filter(view => view.budgeted || view.error);
  if (budgeted.length === 0) return "mcp budgets: none";
  return `mcp budgets: ${budgeted.map(describeBudget).join("; ")}`;
}
