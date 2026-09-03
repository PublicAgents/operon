import { Link, Navigate, useParams } from "react-router-dom";
import { type AgentRow, type WakeRecordRow, type WakeUsageRow } from "../api.js";
import { useTool } from "../hooks.js";
import { Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";
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
  const agents = useTool<{ agents: AgentRow[] }>("agents_list", {}, { enabled: !agentId });
  const wakes = useTool<WakeRecordRow[]>(
    "wakes_list",
    { agentId },
    { pollMs: 10_000, enabled: Boolean(agentId) }
  );
  // What each wake spent (spec 0011), joined by wake id; a wake with no
  // row shows nothing rather than a zero.
  const usage = useTool<{ wakes: WakeUsageRow[] }>(
    "wakes_usage",
    { agentId, limit: 100 },
    { pollMs: 30_000, enabled: Boolean(agentId) }
  );
  const usageByWake = new Map((usage.data?.wakes ?? []).map(row => [row.wakeId, row]));
  // No agent in the URL: pick the first one instead of asking (a
  // one-agent colony should land on its wakes directly).
  const firstAgent = agents.data?.agents[0]?.id;
  if (!agentId && firstAgent) {
    return <Navigate to={`/wakes/${firstAgent}`} replace />;
  }
  return (
    <section>
      <header className="page-head">
        <h1>Wakes</h1>
        <AgentPicker selected={agentId} />
        {agentId ? <button onClick={wakes.refresh}>refresh</button> : null}
      </header>
      {!agentId && !agents.loading && !agents.error ? <Empty>no agents in the roster</Empty> : null}
      <ErrorNote error={agents.error ?? wakes.error} />
      <LoadingGate loading={wakes.loading || agents.loading} hasData={wakes.data !== undefined || !agentId}>
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
              <td>
                {wake.trigger}
                {wake.harness ? <span className="tag">{wake.harness}</span> : null}
              </td>
              <td>
                <TimeStamp at={wake.startedAt} />
              </td>
              <td>
                {wake.endedAt
                  ? `${Math.max(1, Math.round((Date.parse(wake.endedAt) - Date.parse(wake.startedAt)) / 60_000))}m`
                  : "…"}
              </td>
              <td className="usage">{formatUsage(usageByWake.get(wake.wakeId))}</td>
              <td className="reason">
                {wake.reason ? <UntrustedText text={wake.reason} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </LoadingGate>
    </section>
  );
}

/** "412k in / 3.8k out" and the cost when known; empty when no row exists. */
export function formatUsage(row: WakeUsageRow | undefined): string {
  if (!row) return "";
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
  const parts = [`${k(row.inputTokens)} in / ${k(row.outputTokens)} out`];
  if (row.costUsd !== null && row.costUsd !== undefined) parts.push(`$${row.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}
