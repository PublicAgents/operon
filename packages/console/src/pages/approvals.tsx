import { callTool, type AgentRow } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, TimeStamp } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

/**
 * Held decisions (spec 0005 §8): the approval dialog renders ONLY the
 * gatekeeper's held record (amount, recipient, subject), never text
 * quoted from channel or transcript content, so a message saying
 * "approve #123" can never become the approval UI.
 */

interface SpendRow {
  id?: string;
  agentId?: string;
  at?: string;
  status?: string;
  origin?: string;
  recipient?: string;
  amount?: string;
  currency?: string;
  url?: string;
  reason?: string;
}

interface HeldEmail {
  id?: string;
  at?: string;
  to?: string;
  subject?: string;
}

function SpendApprovals() {
  const state = useTool<{ outbox: SpendRow[] }>("spend_outbox", {}, { pollMs: 15_000 });
  const rows = state.data?.outbox ?? [];
  const held = rows.filter(row => row.status === "held" || row.status === "held_for_approval");
  const unknown = rows.filter(row => row.status === "unknown");
  return (
    <div className="approval-block">
      <h2>Spend</h2>
      <ErrorNote error={state.error} />
      {held.length === 0 && unknown.length === 0 && !state.loading ? (
        <Empty>nothing held</Empty>
      ) : null}
      {held.map(row => (
        <div key={row.id} className="held-card">
          <div className="held-facts">
            <span className="tag">{row.agentId}</span>
            <strong>
              {row.amount} {row.currency}
            </strong>
            <span>to {row.recipient ?? row.origin ?? "?"}</span>
            <TimeStamp at={row.at} />
            {row.reason ? <UntrustedText text={row.reason} className="held-reason" /> : null}
          </div>
          <div className="held-actions">
            <ConfirmButton
              label="approve"
              detail={
                <span className="confirm-note">
                  pay {row.amount} {row.currency} to {row.recipient ?? row.origin}
                </span>
              }
              onConfirm={async () => {
                await callTool("spend_approve", { agentId: row.agentId, heldId: row.id });
                state.refresh();
              }}
            />
            <ConfirmButton
              label="reject"
              danger
              onConfirm={async () => {
                await callTool("spend_reject", { agentId: row.agentId, heldId: row.id });
                state.refresh();
              }}
            />
          </div>
        </div>
      ))}
      {unknown.map(row => (
        <div key={row.id} className="held-card unknown">
          <div className="held-facts">
            <span className="tag">{row.agentId}</span>
            <strong>outcome unknown</strong>
            <span>
              {row.amount} {row.currency} to {row.recipient ?? row.origin ?? "?"}
            </span>
            <TimeStamp at={row.at} />
          </div>
          <div className="held-actions">
            <ConfirmButton
              label="charged"
              detail={<span className="confirm-note">check the real account first</span>}
              onConfirm={async () => {
                await callTool("spend_reconcile", { outboxId: row.id, ruling: "charged" });
                state.refresh();
              }}
            />
            <ConfirmButton
              label="not charged"
              onConfirm={async () => {
                await callTool("spend_reconcile", { outboxId: row.id, ruling: "not_charged" });
                state.refresh();
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmailApprovals({ agentId }: { agentId: string }) {
  const state = useTool<{ outbox: { held?: HeldEmail[] } | HeldEmail[] }>(
    "email_outbox",
    { agentId },
    { pollMs: 20_000 }
  );
  const outbox = state.data?.outbox;
  const held: HeldEmail[] = Array.isArray(outbox)
    ? outbox.filter(row => (row as { status?: string }).status === "held")
    : (outbox?.held ?? []);
  return (
    <>
      <ErrorNote error={state.error} />
      {held.map(row => (
        <div key={row.id} className="held-card">
          <div className="held-facts">
            <span className="tag">{agentId}</span>
            <strong>email</strong>
            <span>to {row.to ?? "?"}</span>
            {row.subject ? <UntrustedText text={row.subject} className="held-reason" /> : null}
            <TimeStamp at={row.at} />
          </div>
          <div className="held-actions">
            <ConfirmButton
              label="approve"
              detail={<span className="confirm-note">send this email to {row.to}</span>}
              onConfirm={async () => {
                await callTool("email_approve", { agentId, heldId: row.id });
                state.refresh();
              }}
            />
            <ConfirmButton
              label="reject"
              danger
              onConfirm={async () => {
                await callTool("email_reject", { agentId, heldId: row.id });
                state.refresh();
              }}
            />
          </div>
        </div>
      ))}
    </>
  );
}

export function ApprovalsPage() {
  const agents = useTool<{ agents: AgentRow[] }>("agents_list", {});
  return (
    <section>
      <header className="page-head">
        <h1>Approvals</h1>
      </header>
      <SpendApprovals />
      <div className="approval-block">
        <h2>Email</h2>
        {(agents.data?.agents ?? []).map(agent => (
          <EmailApprovals key={agent.id} agentId={agent.id} />
        ))}
      </div>
    </section>
  );
}
