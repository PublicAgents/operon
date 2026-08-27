import { DurableObject } from "cloudflare:workers";
import { recordEvent } from "@operon/chronicle";

/**
 * The append-only ledger every Gatekeeper writes to. One row per call,
 * including denials and failures: an empty ledger must be distinguishable
 * from a dead rail, so the write happens even when the operation it records
 * did not.
 *
 * Keys are `row:<ISO timestamp>:<uuid>` so lexicographic order is time
 * order. Rows are never updated or deleted by this class.
 *
 * When the hosting Worker carries a CHRONICLE D1 binding, every row is
 * ALSO mirrored there (best-effort, off the hot path via waitUntil): one
 * interception point gives the central audit database full coverage of
 * every Gatekeeper, current and future, with no call-site changes. The
 * DO storage remains the source of truth.
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
    const chronicle = (this.env as { CHRONICLE?: D1Database }).CHRONICLE;
    if (chronicle) {
      // idFromName-created ledgers know their own name; it doubles as the
      // gatekeeper column ("email", "spend", ...).
      this.ctx.waitUntil(
        recordEvent(chronicle, {
          at: row.at,
          gatekeeper: this.ctx.id.name ?? "unknown",
          kind,
          agentId: typeof detail.agentId === "string" ? detail.agentId : undefined,
          detail
        })
      );
    }
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
