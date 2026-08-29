import { useState } from "react";
import { callTool, type AgentRow } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, TimeStamp } from "../ui.js";

interface WebSession {
  name: string;
  live?: boolean;
  saved?: boolean;
  savedAt?: string;
  cookieDomains?: string[];
  cookieCount?: number;
}

function AgentSessions({ agentId }: { agentId: string }) {
  const state = useTool<{ sessions: WebSession[]; usage?: { minutes?: number } }>(
    "web_sessions",
    { agentId },
    { pollMs: 30_000 }
  );
  const sessions = state.data?.sessions ?? [];
  return (
    <div className="approval-block">
      <h2>{agentId}</h2>
      <ErrorNote error={state.error} />
      {sessions.length === 0 && !state.loading ? <Empty>no saved sessions</Empty> : null}
      {sessions.map(session => (
        <div key={session.name} className="held-card">
          <div className="held-facts">
            <strong>{session.name}</strong>
            {session.live ? <span className="state on">live</span> : <span className="state off">saved</span>}
            {session.savedAt ? <TimeStamp at={session.savedAt} /> : null}
            <span>
              {session.cookieCount ?? 0} cookies
              {session.cookieDomains?.length ? ` (${session.cookieDomains.join(", ")})` : ""}
            </span>
          </div>
          <div className="held-actions">
            <ConfirmButton
              label="delete"
              danger
              confirmName={session.name}
              detail={
                <span className="confirm-note">
                  the remote logout: destroys cookies, storage, and credentials; irreversible
                </span>
              }
              onConfirm={async () => {
                await callTool("web_session_delete", { agentId, name: session.name });
                state.refresh();
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function WebSessionsPage() {
  const agents = useTool<{ agents: AgentRow[] }>("agents_list", {});
  const webAgents = (agents.data?.agents ?? []).filter(agent => agent.web);
  const [showAll, setShowAll] = useState(false);
  const listed = showAll ? (agents.data?.agents ?? []) : webAgents;
  return (
    <section>
      <header className="page-head">
        <h1>Browser sessions</h1>
        <label className="toggle">
          <input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} />
          include agents without the web door
        </label>
      </header>
      <ErrorNote error={agents.error} />
      {listed.length === 0 && !agents.loading ? <Empty>no web-door agents</Empty> : null}
      {listed.map(agent => (
        <AgentSessions key={agent.id} agentId={agent.id} />
      ))}
    </section>
  );
}
