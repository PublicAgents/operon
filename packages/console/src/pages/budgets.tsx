import { useState } from "react";
import { callTool } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, LoadingGate } from "../ui.js";

/**
 * The metered MCP servers' budgets (spec 0014 §4): the meter's figures
 * per server, and the operator's reset to the vendor's month-to-date
 * figure. Server names and numbers are the Gatekeeper's facts; nothing
 * here is agent-authored.
 */
interface Remaining {
  month: string;
  monthlyUsd: number;
  spentMonthUsd: number;
  day: string;
  allotmentTodayUsd: number;
  spentTodayUsd: number;
  remainingTodayUsd: number;
  openReservationsUsd: number;
  resetsAt: string;
}

interface BudgetRow {
  server: string;
  budget: { monthlyUsd: number; perCall: Record<string, number>; free?: string[] };
  remaining: Remaining;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

export function McpBudgets() {
  const state = useTool<{ budgets: BudgetRow[] }>("mcp_budgets", {}, { pollMs: 30_000 });
  const rows = state.data?.budgets ?? [];
  const [figures, setFigures] = useState<Record<string, string>>({});
  return (
    <section className="budgets">
      <header className="page-head">
        <h2>Budgets</h2>
        <span className="sub">metered MCP servers: one monthly cap each, shared by every agent, spread over the month's days</span>
      </header>
      <ErrorNote error={state.error} />
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}>
        {rows.length === 0 && !state.loading ? <Empty>no metered servers</Empty> : null}
        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>server</th>
                <th>month</th>
                <th>today</th>
                <th>in flight</th>
                <th>rolls at</th>
                <th>reset to the vendor's figure</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.server}>
                  <td>
                    <strong>{row.server}</strong>
                  </td>
                  <td>
                    {usd(row.remaining.spentMonthUsd)} of {usd(row.remaining.monthlyUsd)}
                  </td>
                  <td>
                    {usd(row.remaining.remainingTodayUsd)} left of {usd(row.remaining.allotmentTodayUsd)}
                  </td>
                  <td>{usd(row.remaining.openReservationsUsd)}</td>
                  <td>
                    <code>{row.remaining.resetsAt.slice(11, 16)} UTC</code>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="month-to-date USD"
                      value={figures[row.server] ?? ""}
                      onChange={event => setFigures({ ...figures, [row.server]: event.target.value })}
                    />
                    <ConfirmButton
                      label="reset"
                      danger
                      detail={
                        <span className="confirm-note">
                          {(figures[row.server] ?? "").trim() === ""
                            ? `${row.server}: enter the vendor's month-to-date figure first`
                            : `${row.server}: the month starts over from ${usd(Number(figures[row.server]))}`}
                        </span>
                      }
                      onConfirm={async () => {
                        // An empty field is not a figure: Number("") is 0,
                        // and a reset to zero hands out the whole month.
                        const figure = (figures[row.server] ?? "").trim();
                        if (figure === "") return;
                        const value = Number(figure);
                        if (!Number.isFinite(value) || value < 0) return;
                        await callTool("mcp_budget_reset", { server: row.server, spentMonthUsd: value });
                        state.refresh();
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </LoadingGate>
    </section>
  );
}
