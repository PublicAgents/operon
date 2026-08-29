import { useState } from "react";
import { type LedgerRow } from "../api.js";
import { useTool } from "../hooks.js";
import { Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

const LEDGERS = ["email", "spend", "vault", "x", "till", "deploy", "github", "pr", "web", "telegram"];

export function LedgersPage() {
  const [gatekeeper, setGatekeeper] = useState("spend");
  const state = useTool<LedgerRow[]>("ledger_recent", { gatekeeper });
  const rows = state.data ?? [];
  return (
    <section>
      <header className="page-head">
        <h1>Ledgers</h1>
        <span className="picker">
          {LEDGERS.map(name => (
            <button
              key={name}
              className={name === gatekeeper ? "picker-item active" : "picker-item"}
              onClick={() => setGatekeeper(name)}
            >
              {name}
            </button>
          ))}
        </span>
        <button onClick={state.refresh}>refresh</button>
      </header>
      <ErrorNote error={state.error} />
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}>
      {rows.length === 0 && !state.loading ? <Empty>the {gatekeeper} ledger is empty</Empty> : null}
      <table className="events">
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.at}-${index}`}>
              <td>
                <TimeStamp at={row.at} />
              </td>
              <td>
                <code>{row.kind}</code>
              </td>
              <td className="detail">
                <UntrustedText text={JSON.stringify(row.detail)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </LoadingGate>
    </section>
  );
}
