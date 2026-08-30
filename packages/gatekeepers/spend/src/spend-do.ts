import { DurableObject } from "cloudflare:workers";
import { allowanceMatches, checkCaps, tupleKey, type Allowance, type CapProblem, type ChallengeSummary, type MerchantTuple } from "./policy.js";

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
  currency: string;
  /** Base units as integer string. */
  amount: string;
  reason: string;
  at: string;
  status: "reserved" | "paid" | "released" | "outcome_unknown";
  receipt?: string;
  detail?: string;
  /** Set when this attempt spent a one-time allowance (cap-exempt). */
  allowanceId?: string;
}

export interface HeldPayment {
  id: string;
  agentId: string;
  url: string;
  origin: string;
  method: string;
  recipient: string;
  currency: string;
  amount: string;
  decimals: number;
  display: string;
  maxAmount: string;
  reason: string;
  queuedAt: string;
  claimed?: boolean;
  /**
   * Why it is held: a first payment to a new merchant, or a payment over
   * the caps (spec 0002 §2.2 allowance flow). Missing means "merchant"
   * (rows held before the field existed).
   */
  kind?: "merchant" | "above_cap";
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
    // Allowance-spent rows never touched the daily counter, so a release
    // must not decrement it (and the allowance stays consumed: fails safe).
    if (status === "released" && row.allowanceId === undefined) {
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

  private async findEquivalentHold(
    payment: Omit<HeldPayment, "id" | "queuedAt" | "claimed">
  ): Promise<HeldPayment | null> {
    for (const existing of await this.listHeld()) {
      if (
        // Claimed rows count too: a decision in flight is still THE hold
        // for this payment, and reporting it beats minting a twin whose
        // separate approval would double the authorization.
        existing.agentId === payment.agentId &&
        existing.origin === payment.origin &&
        existing.method === payment.method &&
        existing.recipient.toLowerCase() === payment.recipient.toLowerCase() &&
        existing.currency.toLowerCase() === payment.currency.toLowerCase() &&
        existing.amount === payment.amount
      ) {
        return existing;
      }
    }
    return null;
  }

  /**
   * Hold a payment for the operator, DEDUPLICATED against every pending
   * hold (claimed included): the caller learns whether this is a new
   * hold (ledger it, notify the operator) or an existing one (report
   * it, notify nobody twice). Serialized by the DO, so atomic.
   */
  async hold(
    payment: Omit<HeldPayment, "id" | "queuedAt" | "claimed">,
    at: string
  ): Promise<{ held: HeldPayment; deduped: boolean }> {
    const existing = await this.findEquivalentHold(payment);
    if (existing) return { held: existing, deduped: true };
    const held: HeldPayment = { id: crypto.randomUUID(), queuedAt: at, ...payment };
    await this.ctx.storage.put(`held:${held.id}`, held);
    return { held, deduped: false };
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

  /** Every payment awaiting the operator (the approvals surface). */
  async listHeld(): Promise<HeldPayment[]> {
    const entries = await this.ctx.storage.list<HeldPayment>({ prefix: "held:" });
    return [...entries.values()];
  }

  // ---- one-time allowances (spec 0002 §2.2, the operon#59 shape) -------

  async mintAllowance(allowance: Allowance): Promise<void> {
    await this.ctx.storage.put(`allow:${allowance.id}`, allowance);
  }

  /** Base units already reserved or spent by this agent today. */
  async spentToday(agentId: string, at: string): Promise<string> {
    return (await this.ctx.storage.get<string>(`spent:${agentId}:${day(at)}`)) ?? "0";
  }

  /**
   * Allowances that lapsed by expiry and are not yet audit-ledgered.
   * Read-only: the caller appends the ledger rows first and acks with
   * markExpiryLedgered after they land, so a failed append re-surfaces
   * the lapse next sweep (at-least-once; a duplicate audit row is
   * benign, a lost one is not).
   */
  async lapsedUnledgered(nowIso: string): Promise<Allowance[]> {
    return (await this.listAllowances()).filter(
      allowance =>
        allowance.consumedAt === undefined &&
        allowance.revokedAt === undefined &&
        allowance.expiresAt <= nowIso &&
        !(allowance as Allowance & { expiryLedgered?: boolean }).expiryLedgered
    );
  }

  async markExpiryLedgered(id: string): Promise<void> {
    const allowance = await this.ctx.storage.get<Allowance>(`allow:${id}`);
    if (allowance) await this.ctx.storage.put(`allow:${id}`, { ...allowance, expiryLedgered: true });
  }

  async listAllowances(agentId?: string): Promise<Allowance[]> {
    const entries = await this.ctx.storage.list<Allowance>({ prefix: "allow:" });
    const all = [...entries.values()];
    return agentId ? all.filter(allowance => allowance.agentId === agentId) : all;
  }

  /**
   * Operator revocation of an UNSPENT, UNEXPIRED allowance. An expired
   * one is not revocable: it already lapsed, and refusing here keeps
   * the audit trail single-voiced (one allowance, one terminal event,
   * never both allowance_revoked and allowance_expired).
   */
  async revokeAllowance(id: string, at: string): Promise<boolean> {
    const allowance = await this.ctx.storage.get<Allowance>(`allow:${id}`);
    if (
      !allowance ||
      allowance.consumedAt !== undefined ||
      allowance.revokedAt !== undefined ||
      allowance.expiresAt <= at
    ) {
      return false;
    }
    await this.ctx.storage.put(`allow:${id}`, { ...allowance, revokedAt: at });
    return true;
  }

  /**
   * THE pay decision, in one serialized turn so no worker-side read can
   * go stale between classification and reservation (spec 0002 §2.2):
   *
   * 1. Caps admit it -> reserve normally.
   * 2. A cap refuses it -> a matching one-time allowance is consumed
   *    atomically with the outbox row (cap-exempt by doctrine, counted
   *    against nothing else, no double-spend possible).
   * 3. No allowance, amount under the hold ceiling -> hold a proposal,
   *    deduplicated against every pending hold, claimed included.
   * 4. Otherwise -> refused with the cap problem.
   *
   * The agent's own maxAmount refuses before anything else: an amount
   * the agent did not agree to is never reserved, allowed, or held.
   */
  async decidePay(
    row: Omit<OutboxRow, "id" | "status" | "allowanceId">,
    caps: { maxAmount: string; maxTx: string; dailyCap: string },
    summary: ChallengeSummary,
    holdOption: { payment: Omit<HeldPayment, "id" | "queuedAt" | "claimed">; holdMax: string } | null
  ): Promise<
    | { outcome: "reserved"; outboxId: string; allowanceId?: string }
    | { outcome: "held"; held: HeldPayment; deduped: boolean }
    | { outcome: "refused"; problem: CapProblem }
  > {
    const plain = await this.reserve(row, caps);
    if (plain.ok) return { outcome: "reserved", outboxId: plain.outboxId };
    if (plain.problem === "over_max_amount") return { outcome: "refused", problem: plain.problem };

    for (const allowance of await this.listAllowances(row.agentId)) {
      if (allowanceMatches(allowance, row.agentId, summary, row.at)) {
        const id = crypto.randomUUID();
        await this.ctx.storage.put(`allow:${allowance.id}`, {
          ...allowance,
          consumedAt: row.at,
          outboxId: id
        });
        await this.ctx.storage.put(`out:${row.at}:${id}`, {
          id,
          status: "reserved",
          allowanceId: allowance.id,
          ...row
        });
        return { outcome: "reserved", outboxId: id, allowanceId: allowance.id };
      }
    }

    if (holdOption && BigInt(row.amount) <= BigInt(holdOption.holdMax)) {
      const { held, deduped } = await this.hold(holdOption.payment, row.at);
      return { outcome: "held", held, deduped };
    }
    return { outcome: "refused", problem: plain.problem };
  }
}
