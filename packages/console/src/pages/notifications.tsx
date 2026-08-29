import { type MessageRow } from "../api.js";
import { useTool } from "../hooks.js";
import { Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

/**
 * The notifications feed (spec 0005 §5): every notify, durably recorded
 * whether or not a Telegram delivery happened. Telegram-less colonies
 * live entirely off this view.
 */
export function NotificationsPage() {
  const state = useTool<{ messages: MessageRow[] }>(
    "notifications",
    { limit: 100 },
    { pollMs: 20_000 }
  );
  const rows = state.data?.messages ?? [];
  return (
    <section>
      <header className="page-head">
        <h1>Notifications</h1>
        <button onClick={state.refresh}>refresh</button>
      </header>
      <ErrorNote error={state.error} />
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}>
      {rows.length === 0 && !state.loading ? <Empty>no notifications recorded</Empty> : null}
      {rows.map(row => (
        <div key={row.id} className="message-card" data-provenance="agent">
          <div className="bubble-head">
            <span className="who">{row.agent_id}</span>
            <span className="untrusted-badge">untrusted</span>
            <TimeStamp at={row.at} />
          </div>
          <UntrustedText text={row.body} className="message-body" />
        </div>
      ))}
      </LoadingGate>
    </section>
  );
}
