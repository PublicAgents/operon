import { useState } from "react";
import { type MessageRow } from "../api.js";
import { useTool } from "../hooks.js";
import { Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

const KINDS = [
  "", "email_in", "email_out", "channel_operator", "channel_agent", "x_post", "x_dm_in", "x_dm_out", "notify"
];

export function MessagesPage() {
  const [kind, setKind] = useState("");
  const [agent, setAgent] = useState("");
  const [contains, setContains] = useState("");
  const state = useTool<{ messages: MessageRow[] }>("chronicle_messages", {
    ...(kind ? { kind } : {}),
    ...(agent ? { agent } : {}),
    ...(contains ? { contains } : {}),
    limit: 100
  });
  const messages = state.data?.messages ?? [];
  return (
    <section>
      <header className="page-head">
        <h1>Messages</h1>
        <select value={kind} onChange={event => setKind(event.target.value)}>
          {KINDS.map(name => (
            <option key={name} value={name}>
              {name || "all kinds"}
            </option>
          ))}
        </select>
        <input placeholder="agent" value={agent} onChange={event => setAgent(event.target.value)} />
        <input
          placeholder="contains"
          value={contains}
          onChange={event => setContains(event.target.value)}
        />
        <button onClick={state.refresh}>refresh</button>
      </header>
      <ErrorNote error={state.error} />
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}>
      {messages.length === 0 && !state.loading ? <Empty>no messages match</Empty> : null}
      {messages.map(row => (
        <div key={row.id} className="message-card" data-provenance="agent">
          <div className="bubble-head">
            <span className="tag">{row.kind}</span>
            <span className="who">{row.agent_id}</span>
            {row.sender ? <span>from {row.sender}</span> : null}
            {row.recipient ? <span>to {row.recipient}</span> : null}
            <span className="untrusted-badge">untrusted</span>
            <TimeStamp at={row.at} />
          </div>
          {row.subject ? (
            <div className="subject">
              <UntrustedText text={row.subject} />
            </div>
          ) : null}
          <UntrustedText text={row.body} className="message-body" />
        </div>
      ))}
      </LoadingGate>
    </section>
  );
}
