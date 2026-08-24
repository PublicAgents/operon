import { DurableObject } from "cloudflare:workers";

/**
 * The append-only ledger every Gatekeeper writes to. One row per call,
 * including denials and failures: an empty ledger must be distinguishable
 * from a dead rail, so the write happens even when the operation it records
 * did not.
 *
 * Keys are `row:<ISO timestamp>:<uuid>` so lexicographic order is time
 * order. Rows are never updated or deleted by this class.
 */

export interface LedgerRow {
  at: string;
  kind: string;
  detail: Record<string, unknown>;
}

export class Ledger extends DurableObject {
  async append(kind: string, detail: Record<string, unknown>): Promise<LedgerRow> {
    const row: LedgerRow = { at: new Date().toISOString(), kind, detail };
    await this.ctx.storage.put(`row:${row.at}:${crypto.randomUUID()}`, row);
    return row;
  }

  async recent(limit = 100): Promise<LedgerRow[]> {
    const entries = await this.ctx.storage.list<LedgerRow>({
      prefix: "row:",
      reverse: true,
      limit
    });
    return [...entries.values()];
  }
}
