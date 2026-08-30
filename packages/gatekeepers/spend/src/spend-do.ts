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
  /** When the claim was taken; a stale claim (crashed approval) is overridable. */
  claimedAt?: string;
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

/**
 * A transactional audit event: written in the SAME DO turn as the state
 * change it describes, so a transition without its event (or an event
 * without its transition) is physically unrepresentable. Events drain
 * to the activity ledger as an at-least-once mirror (drainEvents +
 * ackEvents); until acked they are the durable audit truth here.
 */
export interface SpendEvent {
  id: string;
  kind: string;
  detail: Record<string, string | number | boolean | null>;
  at: string;
}

export class SpendLedger extends DurableObject {
  private eventSeq = 0;

  /** Same-turn audit write; every state mutation calls this alongside its puts. */
  private async event(
    kind: string,
    detail: Record<string, string | number | boolean | null>,
    at: string
  ): Promise<void> {
    // Monotonic within the turn; the timestamp prefix orders across turns.
    this.eventSeq += 1;
    const id = `${at}#${this.eventSeq.toString().padStart(4, "0")}#${crypto.randomUUID().slice(0, 8)}`;
    await this.ctx.storage.put(`event:${id}`, { id, kind, detail, at });
  }

  /**
   * Oldest unmirrored events, for the activity-ledger mirror. Draining
   * takes a short LEASE in the same turn, so two concurrent mirrors
   * cannot both append the same events; an expired lease (a mirror
   * that died mid-append) re-surfaces its events. The only remaining
   * duplicate window is an append that landed whose ack then failed,
   * and every mirrored row carries the eventId so those are
   * identifiable.
   */
  async drainEvents(limit = 50): Promise<SpendEvent[]> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<SpendEvent & { leasedUntil?: number }>({
      prefix: "event:",
      limit: limit * 2
    });
    const drained: SpendEvent[] = [];
    for (const [key, event] of entries) {
      if (drained.length >= limit) break;
      if (event.leasedUntil !== undefined && event.leasedUntil > now) continue;
      await this.ctx.storage.put(key, { ...event, leasedUntil: now + 30_000 });
      drained.push(event);
    }
    return drained;
  }

  /** Ack after the mirror landed; a failed mirror simply drains again. */
  async ackEvents(ids: string[]): Promise<void> {
    for (const id of ids) await this.ctx.storage.delete(`event:${id}`);
  }
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
        // separate approval would double the authorization. The URL is
        // part of the identity: two invoices that merely share a
        // recipient and a price are two proposals, not one.
        existing.agentId === payment.agentId &&
        existing.url === payment.url &&
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
    await this.ctx.storage.put(`held:${id}`, { ...held, claimed: true, claimedAt: new Date().toISOString() });
    return held;
  }

  async unclaimHeld(id: string): Promise<void> {
    const held = await this.ctx.storage.get<HeldPayment>(`held:${id}`);
    if (held) await this.ctx.storage.put(`held:${id}`, { ...held, claimed: false, claimedAt: undefined });
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

  /**
   * Idempotent, never-overwriting mint: a retry after a lost response
   * finds the record already present and leaves it EXACTLY as it is.
   * Overwriting would resurrect a consumed allowance as fresh spending
   * authority, which is the one thing a retry must never do.
   */
  /**
   * Approval's mint, ONE turn: revalidate that the source hold still
   * exists (a gate-free rejection may have raced the in-flight
   * approval and retired it; minting then would create authority for a
   * rejected payment), write the allowance with its event, and retire
   * the hold together. Idempotent: a retry after a lost response finds
   * the allowance and reports "exists" without re-recording.
   */
  async mintForHold(allowance: Allowance): Promise<"minted" | "exists" | "hold_gone"> {
    const existing = await this.ctx.storage.get<Allowance>(`allow:${allowance.id}`);
    if (existing) return "exists";
    const held = await this.ctx.storage.get<HeldPayment>(`held:${allowance.id}`);
    if (!held) return "hold_gone";
    await this.ctx.storage.put(`allow:${allowance.id}`, allowance);
    await this.event("allowance_minted", {
      agentId: allowance.agentId,
      allowanceId: allowance.id,
      origin: allowance.origin,
      recipient: allowance.recipient,
      display: allowance.display,
      expiresAt: allowance.expiresAt
    }, allowance.mintedAt);
    await this.ctx.storage.delete(`held:${allowance.id}`);
    return "minted";
  }

  /** Base units already reserved or spent by this agent today. */
  async spentToday(agentId: string, at: string): Promise<string> {
    return (await this.ctx.storage.get<string>(`spent:${agentId}:${day(at)}`)) ?? "0";
  }

  /**
   * Mark lapsed allowances expired and write each allowance_expired
   * event in the SAME turn as the mark: the terminal state and its
   * audit event commit together, and the mirror drains them later.
   */
  async sweepExpired(nowIso: string): Promise<void> {
    for (const allowance of await this.listAllowances()) {
      if (
        allowance.consumedAt === undefined &&
        allowance.revokedAt === undefined &&
        allowance.expiresAt <= nowIso &&
        allowance.expiryLedgered !== true
      ) {
        await this.ctx.storage.put(`allow:${allowance.id}`, { ...allowance, expiryLedgered: true });
        await this.event("allowance_expired", {
          agentId: allowance.agentId,
          allowanceId: allowance.id,
          origin: allowance.origin,
          display: allowance.display,
          expiresAt: allowance.expiresAt
        }, nowIso);
      }
    }
  }

  /**
   * Rejection, in ONE serialized turn and with no claim gate: the hold
   * (claimed or not; a crash mid-approval must not make rejected
   * authority unreachable) and any allowance minted for it are handled
   * together, so a racing consumption cannot slip between separate
   * calls. Outcomes:
   *
   * - "rejected": the hold is gone; an active allowance for it, if one
   *   leaked from a lost mint response, was voided (voided says so).
   * - "already_consumed": the allowance was spent before the rejection
   *   arrived; the settlement stood when it happened, the hold is
   *   retired, and the trail must say consumed, not cleanly rejected.
   * - "not_found": neither a hold nor an allowance exists for the id.
   *
   * An expired allowance is left as it lies: it met its terminal event
   * and cannot be consumed, and voiding it would give one allowance
   * two terminal audit voices.
   */
  async rejectHold(
    heldId: string,
    agentId: string,
    at: string
  ): Promise<
    | { status: "rejected"; voided: boolean }
    | { status: "already_consumed" }
    | { status: "approval_in_flight" }
    | { status: "not_found" }
  > {
    const held = await this.ctx.storage.get<HeldPayment>(`held:${heldId}`);
    const allowance = await this.ctx.storage.get<Allowance>(`allow:${heldId}`);
    if (!held && !allowance) return { status: "not_found" };
    // A FRESH claim means an approval is executing right now; rejecting
    // under it would report "rejected" while that payment completes.
    // The claim is respected while young and overridable once stale
    // (a crashed approval must not make rejection unreachable).
    if (held?.claimed && held.claimedAt !== undefined) {
      const ageMs = Date.parse(at) - Date.parse(held.claimedAt);
      if (Number.isFinite(ageMs) && ageMs < 5 * 60 * 1000) {
        return { status: "approval_in_flight" };
      }
    }
    if (allowance?.consumedAt !== undefined) {
      if (held) await this.ctx.storage.delete(`held:${heldId}`);
      await this.event("pay_rejected", {
        agentId,
        heldId,
        detail: "allowance_already_consumed: the settlement preceded the rejection"
      }, at);
      return { status: "already_consumed" };
    }
    let voided = false;
    if (allowance && allowance.revokedAt === undefined && allowance.expiresAt > at) {
      await this.ctx.storage.put(`allow:${heldId}`, { ...allowance, revokedAt: at });
      await this.event("allowance_revoked", { allowanceId: heldId, at, cause: "hold_rejected" }, at);
      voided = true;
    }
    if (held) await this.ctx.storage.delete(`held:${heldId}`);
    await this.event("pay_rejected", { agentId, heldId, origin: held?.origin ?? allowance?.origin ?? null }, at);
    return { status: "rejected", voided };
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
    await this.event("allowance_revoked", { allowanceId: id, at }, at);
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
    holdOption: { payment: Omit<HeldPayment, "id" | "queuedAt" | "claimed">; holdMax: string } | null,
    options?: {
      /**
       * Approval-time executions of a specific held proposal set this:
       * they must never silently consume an allowance minted for a
       * DIFFERENT proposal that happens to share the URL; on a cap
       * refusal the caller mints this hold's own allowance instead.
       */
      forbidAllowanceConsumption?: boolean;
    }
  ): Promise<
    | { outcome: "reserved"; outboxId: string; allowanceId?: string }
    | { outcome: "held"; held: HeldPayment; deduped: boolean }
    | { outcome: "refused"; problem: CapProblem }
  > {
    const plain = await this.reserve(row, caps);
    if (plain.ok) return { outcome: "reserved", outboxId: plain.outboxId };
    if (plain.problem === "over_max_amount") {
      await this.event("pay_refused", { agentId: row.agentId, url: row.url, problem: plain.problem }, row.at);
      return { outcome: "refused", problem: plain.problem };
    }

    for (const allowance of options?.forbidAllowanceConsumption ? [] : await this.listAllowances(row.agentId)) {
      if (allowanceMatches(allowance, row.agentId, row.url, summary, row.at)) {
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
        await this.event("allowance_consumed", {
          agentId: row.agentId,
          allowanceId: allowance.id,
          outboxId: id,
          origin: summary.origin,
          display: summary.display
        }, row.at);
        return { outcome: "reserved", outboxId: id, allowanceId: allowance.id };
      }
    }

    if (holdOption && BigInt(row.amount) <= BigInt(holdOption.holdMax)) {
      const { held, deduped } = await this.hold(holdOption.payment, row.at);
      if (!deduped) {
        await this.event("pay_held", {
          agentId: row.agentId, url: row.url, origin: summary.origin, heldId: held.id, kind: held.kind ?? "above_cap"
        }, row.at);
      }
      return { outcome: "held", held, deduped };
    }
    await this.event("pay_refused", { agentId: row.agentId, url: row.url, problem: plain.problem }, row.at);
    return { outcome: "refused", problem: plain.problem };
  }
}
