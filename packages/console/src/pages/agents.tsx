import { Link } from "react-router-dom";
import { callTool, type AgentRow } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, TimeStamp } from "../ui.js";

export function AgentsPage() {
  const state = useTool<{ zone: string; agents: AgentRow[] }>("agents_list", {}, { pollMs: 15_000 });
  const agents = state.data?.agents ?? [];
  return (
    <section>
      <header className="page-head">
        <h1>Agents</h1>
        <span className="sub">{state.data?.zone}</span>
        <button onClick={state.refresh}>refresh</button>
      </header>
      <ErrorNote error={state.error} />
      {agents.length === 0 && !state.loading ? <Empty>no agents in the roster</Empty> : null}
      <table>
        <thead>
          <tr>
            <th>agent</th>
            <th>model</th>
            <th>cadence</th>
            <th>hosts</th>
            <th>state</th>
            <th>current wake</th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map(agent => (
            <tr key={agent.id}>
              <td>
                <Link to={`/wakes/${agent.id}`}>{agent.id}</Link>
                {agent.web ? <span className="tag">web</span> : null}
              </td>
              <td>{agent.model}</td>
              <td>
                <code>{agent.cadence}</code>
              </td>
              <td>{agent.hosts.join(", ")}</td>
              <td>
                {agent.disabled ? (
                  <span className="state killed">kill switch</span>
                ) : agent.enabled ? (
                  <span className="state on">enabled</span>
                ) : (
                  <span className="state off">roster-disabled</span>
                )}
              </td>
              <td>
                {agent.currentWake ? (
                  <Link to={`/wakes/${agent.id}/${agent.currentWake.wakeId}`}>
                    running <TimeStamp at={agent.currentWake.startedAt} />
                  </Link>
                ) : (
                  "idle"
                )}
              </td>
              <td className="actions">
                <ConfirmButton
                  label="wake"
                  onConfirm={async () => {
                    await callTool("wake", { agentId: agent.id });
                    state.refresh();
                  }}
                />
                {agent.disabled ? (
                  <ConfirmButton
                    label="enable"
                    onConfirm={async () => {
                      await callTool("agent_enable", { agentId: agent.id });
                      state.refresh();
                    }}
                  />
                ) : (
                  <ConfirmButton
                    label="disable"
                    danger
                    confirmName={agent.id}
                    detail={<span className="confirm-note">kills a running wake and refuses all wakes</span>}
                    onConfirm={async () => {
                      await callTool("agent_disable", { agentId: agent.id });
                      state.refresh();
                    }}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
