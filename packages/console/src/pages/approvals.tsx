import { callTool, type AgentRow } from "../api.js";
import { useTool } from "../hooks.js";
import { ConfirmButton, Empty, ErrorNote, LoadingGate, TimeStamp } from "../ui.js";
import { UntrustedText } from "../untrusted.js";

/**
 * Held decisions (spec 0005 §8): the approval dialog renders ONLY the
 * gatekeeper's held record (amount, recipient, subject), never text
 * quoted from channel or transcript content, so a message saying
 * "approve #123" can never become the approval UI.
 */

interface HeldPayment {
  id: string;
  agentId: string;
  origin: string;
  recipient: string;
  display: string;
  reason: string;
  queuedAt: string;
}

interface UnknownOutcome {
  id: string;
  agentId: string;
  amount: string;
  currency: string;
  recipient: string;
  origin: string;
  at: string;
  status: string;
}

interface HeldEmail {
  id: string;
  to: string;
  subject: string;
  queuedAt: string;
}

function SpendApprovals() {
  const held = useTool<{ held: HeldPayment[] }>("spend_held", {}, { pollMs: 15_000 });
  const outbox = useTool<{ outbox: UnknownOutcome[] }>("spend_outbox", {}, { pollMs: 30_000 });
  const heldRows = held.data?.held ?? [];
  const unknown = (outbox.data?.outbox ?? []).filter(row => row.status === "outcome_unknown");
  return (
    <div className="approval-block">
      <h2>Spend</h2>
      <ErrorNote error={held.error ?? outbox.error} />
      <LoadingGate loading={held.loading} hasData={held.data !== undefined}>
      {heldRows.length === 0 && unknown.length === 0 && !held.loading ? (
        <Empty>nothing held</Empty>
      ) : null}
      {heldRows.map(row => (
        <div key={row.id} className="held-card">
          <div className="held-facts">
            <span className="tag">{row.agentId}</span>
            <strong>{row.display}</strong>
            <span>to {row.recipient || row.origin}</span>
            <TimeStamp at={row.queuedAt} />
            {row.reason ? <UntrustedText text={row.reason} className="held-reason" /> : null}
          </div>
          <div className="held-actions">
            <ConfirmButton
              label="approve"
              detail={
                <span className="confirm-note">
                  pay {row.display} to {row.recipient || row.origin}
                </span>
              }
              onConfirm={async () => {
                await callTool("spend_approve", { agentId: row.agentId, heldId: row.id });
                held.refresh();
                outbox.refresh();
              }}
            />
            <ConfirmButton
              label="reject"
              danger
              onConfirm={async () => {
                await callTool("spend_reject", { agentId: row.agentId, heldId: row.id });
                held.refresh();
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
              {row.amount} {row.currency} to {row.recipient || row.origin}
            </span>
            <TimeStamp at={row.at} />
          </div>
          <div className="held-actions">
            <ConfirmButton
              label="charged"
              detail={<span className="confirm-note">check the real account first</span>}
              onConfirm={async () => {
                await callTool("spend_reconcile", { outboxId: row.id, ruling: "charged" });
                outbox.refresh();
              }}
            />
            <ConfirmButton
              label="not charged"
              onConfirm={async () => {
                await callTool("spend_reconcile", { outboxId: row.id, ruling: "not_charged" });
                outbox.refresh();
              }}
            />
          </div>
        </div>
      ))}
      </LoadingGate>
    </div>
  );
}

function EmailApprovals({ agentId }: { agentId: string }) {
  const state = useTool<{ held: HeldEmail[] }>("email_held", { agentId }, { pollMs: 20_000 });
  return (
    <>
      <ErrorNote error={state.error} />
      <LoadingGate loading={state.loading} hasData={state.data !== undefined}><span /></LoadingGate>
      {(state.data?.held ?? []).map(row => (
        <div key={row.id} className="held-card">
          <div className="held-facts">
            <span className="tag">{agentId}</span>
            <strong>email</strong>
            <span>to {row.to}</span>
            <UntrustedText text={row.subject} className="held-reason" />
            <TimeStamp at={row.queuedAt} />
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
        {(agents.data?.agents ?? []).length === 0 && !agents.loading ? (
          <Empty>no agents</Empty>
        ) : null}
        {(agents.data?.agents ?? []).map(agent => (
          <EmailApprovals key={agent.id} agentId={agent.id} />
        ))}
      </div>
    </section>
  );
}
