import { Link } from "react-router-dom";
import { callTool, type AgentRow } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";

interface DoorState {
  baseline: boolean;
  override?: boolean;
  effective: boolean;
}
interface DoorsAnswer {
  doors: string[];
  agents: { agentId: string; doors: Record<string, DoorState> }[];
}

/**
 * The doors matrix (spec 0006 §7): one checkbox per agent and door,
 * showing what is EFFECTIVE at the next wake. A click sets the
 * operator override; a second control clears it so the roster's
 * baseline rules again. Every flip is an audited decision.
 */
function DoorsMatrix() {
  const state = useTool<DoorsAnswer>("agent_doors", {});
  const rows = state.data?.agents ?? [];
  const doors = state.data?.doors ?? [];
  const set = async (agentId: string, door: string, enabled: boolean | null) => {
    await callTool("agent_door_set", { agentId, door, enabled });
    state.refresh();
  };
  return (
    <section className="doors">
      <header className="page-head">
        <h2>Doors</h2>
        <span className="sub">effective at each agent's next wake; a running wake keeps its doors</span>
      </header>
      <ErrorNote error={state.error} />
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}>
        {rows.length === 0 && !state.loading ? <Empty>no agents</Empty> : null}
        <table className="matrix">
          <thead>
            <tr>
              <th>agent</th>
              {doors.map(door => (
                <th key={door}>{door}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.agentId}>
                <td>{row.agentId}</td>
                {doors.map(door => {
                  const cell = row.doors[door];
                  if (!cell) return <td key={door} />;
                  const overridden = cell.override !== undefined;
                  return (
                    <td key={door} className={overridden ? "overridden" : ""}>
                      <label title={`baseline ${cell.baseline ? "open" : "closed"}${overridden ? `, override ${cell.override ? "open" : "closed"}` : ""}`}>
                        <input
                          type="checkbox"
                          checked={cell.effective}
                          onChange={event => void set(row.agentId, door, event.target.checked)}
                        />
                      </label>
                      {overridden ? (
                        <button className="clear" title="clear the override; the roster baseline rules" onClick={() => void set(row.agentId, door, null)}>
                          ×
                        </button>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </LoadingGate>
    </section>
  );
}

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
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}>
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
                {agent.disabled ? (
                  <button disabled title="lift the kill switch first (enable)">
                    wake
                  </button>
                ) : (
                  <ConfirmButton
                    label="wake"
                    onConfirm={async () => {
                      await callTool("wake", { agentId: agent.id });
                      state.refresh();
                    }}
                  />
                )}
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
      </LoadingGate>
          <DoorsMatrix />
    </section>
  );
}
