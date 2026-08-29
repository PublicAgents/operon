import { useState } from "react";
import { Link } from "react-router-dom";
import { callTool, type AgentRow } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";

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
  const [shot, setShot] = useState<{ name: string; data: string } | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();

  async function watchLive(name: string) {
    setActionError(undefined);
    try {
      const result = (await callTool("web_live_view", { agentId, name })) as { url?: string };
      if (result.url) window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function takeScreenshot(name: string) {
    setActionError(undefined);
    try {
      const result = (await callTool("web_screenshot", { agentId, name })) as { data?: string };
      if (result.data) setShot({ name, data: result.data });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <div className="approval-block">
      <h2>{agentId}</h2>
      <ErrorNote error={state.error} />
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}>
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
            {session.live ? (
              <>
                <button onClick={() => void watchLive(session.name)} title="opens the provider's live view in a new tab">
                  watch live
                </button>
                <button onClick={() => void takeScreenshot(session.name)}>screenshot</button>
              </>
            ) : null}
            <Link className="picker-item" to={`/events?gatekeeper=web&agent=${agentId}`}>
              history
            </Link>
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
      <ErrorNote error={actionError} />
      {shot ? (
        <div className="screenshot-frame" data-provenance="agent">
          <div className="bubble-head">
            <span className="who">
              {agentId} / {shot.name}
            </span>
            <span className="untrusted-badge">untrusted</span>
            <button onClick={() => setShot(undefined)}>close</button>
            <button onClick={() => void takeScreenshot(shot.name)}>refresh</button>
          </div>
          <img
            className="screenshot"
            alt={`current page of ${agentId}'s ${shot.name} session (untrusted content)`}
            src={`data:image/jpeg;base64,${shot.data}`}
          />
        </div>
      ) : null}
      </LoadingGate>
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
        <span className="sub">
          watch live and screenshot work on RUNNING sessions; history is the door's audit trail;
          recordings replay in the Cloudflare dashboard (Browser Run &gt; Runs) after a session
          closes
        </span>
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
