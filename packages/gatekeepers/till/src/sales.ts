/**
 * What `operon till sales` shows an agent of its own ledger: the
 * receipts, and the refusals the door wrote on its behalf. A replay
 * refusal (a spent credential presented again) is the one row that
 * proves a refusal path ran, so it is surfaced beside the sale it
 * protected rather than filtered out with every other non-receipt
 * kind (#80).
 */
export interface TillLedgerRow {
  at?: string;
  kind: string;
  detail?: { agentId?: string } & Record<string, unknown>;
}

export interface SalesView {
  sales: TillLedgerRow[];
  /** `replay_refused` rows on this agent's offers, newest first as the ledger lists them. */
  refusals: TillLedgerRow[];
}

const SURFACED_REFUSALS = new Set(["replay_refused"]);

export function salesView(rows: readonly TillLedgerRow[], agentId: string): SalesView {
  const mine = rows.filter(row => row.detail?.agentId === agentId);
  return {
    sales: mine.filter(row => row.kind === "receipt"),
    refusals: mine.filter(row => SURFACED_REFUSALS.has(row.kind))
  };
}
