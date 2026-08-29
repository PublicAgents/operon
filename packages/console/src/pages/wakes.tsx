import { Link, useParams } from "react-router-dom";
import { type AgentRow, type WakeRecordRow } from "../api.js";
import { useTool } from "../hooks.js";
import { Empty, ErrorNote, TimeStamp } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

function AgentPicker({ selected }: { selected?: string }) {
  const state = useTool<{ agents: AgentRow[] }>("agents_list", {});
  return (
    <span className="picker">
      {(state.data?.agents ?? []).map(agent => (
        <Link
          key={agent.id}
          to={`/wakes/${agent.id}`}
          className={agent.id === selected ? "picker-item active" : "picker-item"}
        >
          {agent.id}
        </Link>
      ))}
    </span>
  );
}

export function WakesPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const wakes = useTool<WakeRecordRow[]>(
    "wakes_list",
    { agentId },
    { pollMs: 10_000, enabled: Boolean(agentId) }
  );
  return (
    <section>
      <header className="page-head">
        <h1>Wakes</h1>
        <AgentPicker selected={agentId} />
        {agentId ? <button onClick={wakes.refresh}>refresh</button> : null}
      </header>
      {!agentId ? <Empty>pick an agent</Empty> : null}
      <ErrorNote error={wakes.error} />
      {agentId && (wakes.data ?? []).length === 0 && !wakes.loading ? (
        <Empty>no wakes recorded for {agentId}</Empty>
      ) : null}
      <table>
        <tbody>
          {(wakes.data ?? []).map(wake => (
            <tr key={wake.wakeId}>
              <td>
                <Link to={`/wakes/${wake.agentId}/${wake.wakeId}`}>
                  <code>{wake.wakeId.slice(0, 8)}</code>
                </Link>
              </td>
              <td>
                <span className={`state wake-${wake.status}`}>{wake.status}</span>
              </td>
              <td>{wake.trigger}</td>
              <td>
                <TimeStamp at={wake.startedAt} />
              </td>
              <td>
                {wake.endedAt
                  ? `${Math.max(1, Math.round((Date.parse(wake.endedAt) - Date.parse(wake.startedAt)) / 60_000))}m`
                  : "…"}
              </td>
              <td className="reason">
                {wake.reason ? <UntrustedText text={wake.reason} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
