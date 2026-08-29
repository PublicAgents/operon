import { type LedgerRow } from "../api.js";
import { useTool } from "../hooks.js";
import { Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";

/**
 * The gateway's own audit ledger: every operator read and decision,
 * attributed. This is chassis-authored data (operator identity, tool
 * names, statuses), not agent content.
 */
export function AuditPage() {
  const state = useTool<LedgerRow[]>("audit_recent", { limit: 200 }, { pollMs: 30_000 });
  const rows = state.data ?? [];
  return (
    <section>
      <header className="page-head">
        <h1>Audit</h1>
        <button onClick={state.refresh}>refresh</button>
      </header>
      <ErrorNote error={state.error} />
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}>
      {rows.length === 0 && !state.loading ? <Empty>no operator actions yet</Empty> : null}
      <table className="events">
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.at}-${index}`} className={row.kind === "operator_decision" ? "decision" : ""}>
              <td>
                <TimeStamp at={row.at} />
              </td>
              <td>
                <code>{row.kind}</code>
              </td>
              <td>{String(row.detail.operator ?? "")}</td>
              <td>
                <code>{String(row.detail.tool ?? row.detail.path ?? "")}</code>
              </td>
              <td className="detail">
                {row.detail.body !== undefined ? String(row.detail.body) : ""}
                {row.detail.status !== undefined ? ` → ${String(row.detail.status)}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </LoadingGate>
    </section>
  );
}
