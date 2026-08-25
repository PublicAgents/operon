import { DurableObject } from "cloudflare:workers";
import { checkCaps, tupleKey, type CapProblem, type MerchantTuple } from "./policy.js";

/**
 * One SpendLedger Durable Object per colony: approved merchant tuples,
 * per-agent daily counters, the payment outbox, and held first-merchant
 * payments. Serialized by the DO, so reservations are atomic and an
 * ambiguous outcome can never release capacity it may have spent
 * (spec 0002 §2.2: one logical purchase, one outbox row, for life).
 */

export interface OutboxRow {
  id: string;
  agentId: string;
  url: string;
  origin: string;
  method: string;
  recipient: string;
  /** Base units as integer string. */
  amount: string;
  reason: string;
  at: string;
  status: "reserved" | "paid" | "released" | "outcome_unknown";
  receipt?: string;
  detail?: string;
}

export interface HeldPayment {
  id: string;
  agentId: string;
  url: string;
  origin: string;
  method: string;
  recipient: string;
  amount: string;
  decimals: number;
  display: string;
  maxAmount: string;
  reason: string;
  queuedAt: string;
  claimed?: boolean;
}

function day(at: string): string {
  return at.slice(0, 10);
}

export class SpendLedger extends DurableObject {
  // ---- merchant memory -------------------------------------------------

  async isApproved(tuple: MerchantTuple): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(`tuple:${tupleKey(tuple)}`)) === true;
  }

  async approveTuple(tuple: MerchantTuple): Promise<void> {
    await this.ctx.storage.put(`tuple:${tupleKey(tuple)}`, true);
  }

  // ---- outbox and reservation -----------------------------------------

  /**
   * Reserve capacity and write the durable outbox row in ONE serialized
   * turn: overlapping payments cannot both pass the caps, and the attempt
   * is operator-visible before any credential exists.
   */
  async reserve(
    row: Omit<OutboxRow, "id" | "status">,
    caps: { maxAmount: string; maxTx: string; dailyCap: string }
  ): Promise<{ ok: true; outboxId: string } | { ok: false; problem: CapProblem }> {
    const today = day(row.at);
    const spentKey = `spent:${row.agentId}:${today}`;
    const spentToday = BigInt((await this.ctx.storage.get<string>(spentKey)) ?? "0");
    const problem = checkCaps({
      amount: BigInt(row.amount),
      maxAmount: BigInt(caps.maxAmount),
      maxTx: BigInt(caps.maxTx),
      dailyCap: BigInt(caps.dailyCap),
      spentToday
    });
    if (problem) return { ok: false, problem };
    const id = crypto.randomUUID();
    await this.ctx.storage.put(spentKey, (spentToday + BigInt(row.amount)).toString());
    await this.ctx.storage.put(`out:${row.at}:${id}`, { id, status: "reserved", ...row });
    return { ok: true, outboxId: id };
  }

  private async findRow(outboxId: string): Promise<{ key: string; row: OutboxRow } | null> {
    const rows = await this.ctx.storage.list<OutboxRow>({ prefix: "out:" });
    for (const [key, row] of rows) {
      if (row.id === outboxId) return { key, row };
    }
    return null;
  }

  /**
   * Settle an attempt. "released" is legal ONLY for outcomes the rail
   * proved negative before a credential left; "outcome_unknown" keeps the
   * reservation until the operator reconciles (never auto-retried).
   */
  async settle(
    outboxId: string,
    status: "paid" | "released" | "outcome_unknown",
    detail?: string,
    receipt?: string
  ): Promise<void> {
    const found = await this.findRow(outboxId);
    if (!found) return;
    const { key, row } = found;
    if (row.status !== "reserved" && row.status !== "outcome_unknown") return;
    if (status === "released") {
      const spentKey = `spent:${row.agentId}:${day(row.at)}`;
      const spent = BigInt((await this.ctx.storage.get<string>(spentKey)) ?? "0");
      const reduced = spent - BigInt(row.amount);
      await this.ctx.storage.put(spentKey, (reduced > 0n ? reduced : 0n).toString());
    }
    await this.ctx.storage.put(key, { ...row, status, detail, receipt });
  }

  /**
   * Operator reconciliation of an unknown outcome: "not_charged" releases
   * the reserved capacity; "charged" finalizes it as paid.
   */
  async reconcile(outboxId: string, ruling: "charged" | "not_charged"): Promise<boolean> {
    const found = await this.findRow(outboxId);
    if (!found || found.row.status !== "outcome_unknown") return false;
    await this.settle(
      outboxId,
      ruling === "charged" ? "paid" : "released",
      `operator reconciliation: ${ruling}`
    );
    return true;
  }

  async outbox(agentId?: string, limit = 100): Promise<OutboxRow[]> {
    const rows = [...(await this.ctx.storage.list<OutboxRow>({ prefix: "out:", reverse: true, limit: 500 })).values()];
    const filtered = agentId ? rows.filter(row => row.agentId === agentId) : rows;
    return filtered.slice(0, limit);
  }

  // ---- holds (the email Gatekeeper's claim pattern, verbatim) ----------

  async hold(payment: Omit<HeldPayment, "id" | "queuedAt" | "claimed">, at: string): Promise<HeldPayment> {
    const held: HeldPayment = { id: crypto.randomUUID(), queuedAt: at, ...payment };
    await this.ctx.storage.put(`held:${held.id}`, held);
    return held;
  }

  async claimHeld(id: string): Promise<HeldPayment | undefined> {
    const held = await this.ctx.storage.get<HeldPayment>(`held:${id}`);
    if (!held || held.claimed) return undefined;
    await this.ctx.storage.put(`held:${id}`, { ...held, claimed: true });
    return held;
  }

  async unclaimHeld(id: string): Promise<void> {
    const held = await this.ctx.storage.get<HeldPayment>(`held:${id}`);
    if (held) await this.ctx.storage.put(`held:${id}`, { ...held, claimed: false });
  }

  async deleteHeld(id: string): Promise<void> {
    await this.ctx.storage.delete(`held:${id}`);
  }
}
