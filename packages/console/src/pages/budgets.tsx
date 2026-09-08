import { useState } from "react";
import { callTool } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, LoadingGate } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

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

/** A provider callback nobody could be attributed (spec 0014 §3): kept, never dropped, assigned by the operator. */
interface UnattributedRow {
  id: string;
  runId: string;
  n: number;
  event: string;
  at: string;
  openCreates: Array<{ id: string; agentId: string; tool: string; at: string }>;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

export function McpBudgets() {
  const state = useTool<{ budgets: BudgetRow[]; unattributed?: Array<{ server: string; results: UnattributedRow[] }> }>(
    "mcp_budgets",
    {},
    { pollMs: 30_000 }
  );
  const rows = state.data?.budgets ?? [];
  const orphans = (state.data?.unattributed ?? []).flatMap(entry => entry.results.map(result => ({ server: entry.server, ...result })));
  const [figures, setFigures] = useState<Record<string, string>>({});
  const [assignees, setAssignees] = useState<Record<string, string>>({});
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
        {orphans.length > 0 ? (
          <>
            <h3>Task results nobody could be attributed</h3>
            <p className="sub">
              a provider's callback for a run no agent recorded (spec 0014 §3): kept, never dropped; the open creates at its arrival are the
              evidence, the assignment is yours
            </p>
            <table>
              <thead>
                <tr>
                  <th>server</th>
                  <th>run</th>
                  <th>event</th>
                  <th>at</th>
                  <th>open creates at arrival</th>
                  <th>assign to</th>
                </tr>
              </thead>
              <tbody>
                {orphans.map(row => (
                  <tr key={`${row.server}:${row.id}`}>
                    <td>
                      <strong>{row.server}</strong>
                    </td>
                    <td>
                      <UntrustedText text={row.runId} className="held-reason" />
                    </td>
                    <td>
                      <UntrustedText text={row.event} className="held-reason" />
                    </td>
                    <td>
                      <code>{row.at}</code>
                    </td>
                    <td>
                      {row.openCreates.length === 0
                        ? "none"
                        : row.openCreates.map(create => `${create.agentId} ${create.tool} ${create.at.slice(0, 16)}`).join("; ")}
                    </td>
                    <td>
                      <input
                        type="text"
                        placeholder="agent id"
                        value={assignees[row.id] ?? ""}
                        onChange={event => setAssignees({ ...assignees, [row.id]: event.target.value })}
                      />
                      <ConfirmButton
                        label="assign"
                        detail={
                          <span className="confirm-note">
                            {(assignees[row.id] ?? "").trim() === ""
                              ? "name the agent first"
                              : `the result and the run become ${(assignees[row.id] ?? "").trim()}'s`}
                          </span>
                        }
                        onConfirm={async () => {
                          const agentId = (assignees[row.id] ?? "").trim();
                          if (agentId === "") return;
                          await callTool("mcp_result_assign", { server: row.server, id: row.id, agentId });
                          state.refresh();
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </LoadingGate>
    </section>
  );
}
