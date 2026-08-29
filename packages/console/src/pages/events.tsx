import { useState } from "react";
import { type EventRow } from "../api.js";
import { useTool } from "../hooks.js";
import { Empty, ErrorNote, TimeStamp } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

const GATEKEEPERS = [
  "", "email", "spend", "vault", "x", "till", "deploy", "github", "pr", "web", "telegram", "ops", "chronicle"
];

export function EventsPage() {
  const [gatekeeper, setGatekeeper] = useState("");
  const [kind, setKind] = useState("");
  const [agent, setAgent] = useState("");
  const [until, setUntil] = useState("");
  const state = useTool<{ events: EventRow[] }>("chronicle_events", {
    ...(gatekeeper ? { gatekeeper } : {}),
    ...(kind ? { kind } : {}),
    ...(agent ? { agent } : {}),
    ...(until ? { until } : {}),
    limit: 100
  });
  const events = state.data?.events ?? [];
  const oldest = events.length > 0 ? events[events.length - 1].at : undefined;
  return (
    <section>
      <header className="page-head">
        <h1>Events</h1>
        <select value={gatekeeper} onChange={event => setGatekeeper(event.target.value)}>
          {GATEKEEPERS.map(name => (
            <option key={name} value={name}>
              {name || "all gatekeepers"}
            </option>
          ))}
        </select>
        <input placeholder="kind" value={kind} onChange={event => setKind(event.target.value)} />
        <input placeholder="agent" value={agent} onChange={event => setAgent(event.target.value)} />
        <button onClick={state.refresh}>refresh</button>
        {oldest ? (
          <button onClick={() => setUntil(oldest)} title="page to older events">
            older
          </button>
        ) : null}
        {until ? <button onClick={() => setUntil("")}>newest</button> : null}
      </header>
      <ErrorNote error={state.error} />
      {events.length === 0 && !state.loading ? <Empty>no events match</Empty> : null}
      <table className="events">
        <tbody>
          {events.map(row => (
            <tr key={row.id}>
              <td>
                <TimeStamp at={row.at} />
              </td>
              <td>
                <span className="tag">{row.gatekeeper}</span>
              </td>
              <td>
                <code>{row.kind}</code>
              </td>
              <td>{row.agent_id}</td>
              <td className="detail">
                {row.detail ? <UntrustedText text={row.detail} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
