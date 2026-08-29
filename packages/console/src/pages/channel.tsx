import { useEffect, useRef, useState } from "react";
import { callTool, type AgentRow, type ChannelEntry } from "../api.js";
import { useTool } from "../hooks.js";
import { openLive } from "../live.js";
import { ErrorNote } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

/**
 * The operator channel (spec 0005 §5): the Telegram-equivalent surface.
 * Live over the Channel DO's WebSocket; sending posts the channel_send
 * tool. Agent entries are hard-marked untrusted; delivery to an agent
 * happens at its next wake pull, and the UI says so.
 */

export function ChannelPage() {
  const agents = useTool<{ agents: AgentRow[] }>("agents_list", {});
  const [target, setTarget] = useState("*");
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [status, setStatus] = useState("connecting");
  const [sendError, setSendError] = useState<string | undefined>();
  const lastId = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = openLive({
      path: "/ws/channel",
      after: () => lastId.current,
      onFrame: frame => {
        const incoming: ChannelEntry[] =
          frame.type === "entries"
            ? ((frame.entries as ChannelEntry[]) ?? [])
            : frame.type === "entry"
              ? [frame.entry as ChannelEntry]
              : [];
        const fresh = incoming.filter(entry => entry.id > lastId.current);
        if (fresh.length === 0) return;
        lastId.current = Math.max(...fresh.map(entry => entry.id));
        setEntries(current => [...current, ...fresh].slice(-500));
      },
      onStatus: setStatus
    });
    return close;
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  const visible =
    target === "*"
      ? entries
      : entries.filter(entry => entry.agentId === target || entry.agentId === "*");

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setSendError(undefined);
    try {
      await callTool("channel_send", { agentId: target, text });
      setDraft("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="channel">
      <header className="page-head">
        <h1>Channel</h1>
        <span className={`state tail-${status === "live" ? "live" : "connecting"}`}>{status}</span>
        <select value={target} onChange={event => setTarget(event.target.value)}>
          <option value="*">all agents (broadcast)</option>
          {(agents.data?.agents ?? []).map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.id}
            </option>
          ))}
        </select>
      </header>
      <div className="channel-log">
        {visible.map(entry => (
          <div key={entry.id} className={`bubble ${entry.from}`} data-provenance={entry.from}>
            <div className="bubble-head">
              {entry.from === "agent" ? (
                <>
                  <span className="who agent-badge">{entry.agentId}</span>
                  <span className="untrusted-badge">untrusted</span>
                </>
              ) : (
                <span className="who">operator → {entry.agentId === "*" ? "all" : entry.agentId}</span>
              )}
              <span className="time" title={entry.at}>
                {entry.at.slice(11, 16)}
              </span>
            </div>
            <UntrustedText text={entry.text} className={entry.from} />
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="composer">
        <textarea
          placeholder={
            target === "*"
              ? "message all agents (delivered at each agent's next wake)"
              : `message ${target} (delivered at its next wake)`
          }
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
          }}
        />
        <button onClick={() => void send()} disabled={!draft.trim()}>
          send
        </button>
      </div>
      <ErrorNote error={sendError ?? agents.error} />
    </section>
  );
}
