import { DurableObject } from "cloudflare:workers";
import {
  LIMITS,
  transitionRefusal,
  unreadForAgent,
  type Ask,
  type AskKind,
  type AskState,
  type AskThreadEntry
} from "./policy.js";

/**
 * One AskBox per colony: every ask, its thread, and the counters that
 * bound them. State changes and their thread entries commit in ONE
 * serialized turn (spec 0007 §3), so no interleaving can produce a
 * decision without its record, and compare-and-set makes a losing
 * caller see the truth instead of overwriting it.
 */

export type TransitionResult =
  | { ok: true; ask: Ask }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "state_moved" | "terminal"; ask: Ask };

function day(at: string): string {
  return at.slice(0, 10);
}

export class AskBox extends DurableObject {
  private async load(id: string): Promise<Ask | undefined> {
    return this.ctx.storage.get<Ask>(`ask:${id}`);
  }

  private async save(ask: Ask): Promise<void> {
    await this.ctx.storage.put(`ask:${ask.id}`, ask);
  }

  /**
   * Open an ask, bounded by the per-wake cap. The wake id comes from
   * the porch, never the mind, so headroom cannot be minted by
   * claiming another wake (spec 0007 §3).
   */
  async create(input: {
    agentId: string;
    wakeId: string;
    title: string;
    body: string;
    kind: AskKind;
    links: string[];
    at: string;
    perWake: number;
    perDay: number;
  }): Promise<
    | { ok: true; ask: Ask }
    | { ok: false; reason: "wake_cap" | "day_cap"; filed: number; cap: number }
  > {
    const counterKey = `wake:${input.agentId}:${input.wakeId}`;
    const dayKey = `day:${input.agentId}:${day(input.at)}`;
    const filed = (await this.ctx.storage.get<number>(counterKey)) ?? 0;
    if (filed >= input.perWake) {
      return { ok: false, reason: "wake_cap", filed, cap: input.perWake };
    }
    // The daily backstop is counted on the DO's own clock and cannot be
    // reset by a caller choosing a different wake id: the per-wake cap
    // is the useful bound, this one is the un-bypassable one.
    const filedToday = (await this.ctx.storage.get<number>(dayKey)) ?? 0;
    if (filedToday >= input.perDay) {
      return { ok: false, reason: "day_cap", filed: filedToday, cap: input.perDay };
    }
    const ask: Ask = {
      id: crypto.randomUUID().slice(0, 8),
      agentId: input.agentId,
      wakeId: input.wakeId,
      title: input.title,
      body: input.body,
      kind: input.kind,
      links: input.links,
      state: "open",
      createdAt: input.at,
      updatedAt: input.at,
      thread: []
    };
    await this.ctx.storage.put(counterKey, filed + 1);
    await this.ctx.storage.put(dayKey, filedToday + 1);
    await this.save(ask);
    return { ok: true, ask };
  }

  async get(id: string): Promise<Ask | undefined> {
    return this.load(id);
  }

  /**
   * Every ask, newest first. A colony's ask set is small by
   * construction (ten per wake, resolved as they are answered), so a
   * full listing with a bound is honest rather than paginated.
   */
  async list(filter?: { agentId?: string; states?: AskState[] }, limit = 200): Promise<Ask[]> {
    const entries = await this.ctx.storage.list<Ask>({ prefix: "ask:" });
    const all = [...entries.values()]
      .filter(ask => (filter?.agentId ? ask.agentId === filter.agentId : true))
      .filter(ask => (filter?.states?.length ? filter.states.includes(ask.state) : true))
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    return all.slice(0, limit);
  }

  /** A thread message: never a state change, allowed in any state. */
  async reply(input: {
    id: string;
    author: "agent" | "operator";
    text: string;
    at: string;
  }): Promise<{ ok: true; ask: Ask } | { ok: false; reason: "not_found" }> {
    const ask = await this.load(input.id);
    if (!ask) return { ok: false, reason: "not_found" };
    const entry: AskThreadEntry = {
      seq: ask.thread.length + 1,
      at: input.at,
      author: input.author,
      kind: "message",
      text: input.text
    };
    const updated: Ask = { ...ask, updatedAt: input.at, thread: [...ask.thread, entry] };
    await this.save(updated);
    return { ok: true, ask: updated };
  }

  /**
   * A state change, compare-and-set on the state the caller believed,
   * committed with its thread entry in this turn.
   */
  async transition(input: {
    id: string;
    author: "agent" | "operator";
    expectedState: AskState;
    next: AskState;
    text?: string;
    at: string;
  }): Promise<TransitionResult> {
    const ask = await this.load(input.id);
    if (!ask) return { ok: false, reason: "not_found" };
    const refusal = transitionRefusal(ask.state, input.expectedState, input.next);
    if (refusal) return { ok: false, reason: refusal, ask };
    const entry: AskThreadEntry = {
      seq: ask.thread.length + 1,
      at: input.at,
      author: input.author,
      kind: "state_change",
      state: input.next,
      ...(input.text !== undefined ? { text: input.text } : {})
    };
    const updated: Ask = {
      ...ask,
      state: input.next,
      updatedAt: input.at,
      thread: [...ask.thread, entry]
    };
    await this.save(updated);
    return { ok: true, ask: updated };
  }

  /**
   * The agent's unread operator activity, handed out as a DELIVERY:
   * the rows plus a token naming exactly what this call returned.
   * Reading never acks (delivery is at-least-once, and the wake acks
   * only after it has persisted what it was handed), and the caller
   * never computes a cursor: it acks the token. That removes the last
   * way an ack can name entries it did not receive, including when
   * two reads for the same agent overlap.
   */
  async unread(agentId: string): Promise<{
    deliveryId: string;
    rows: { id: string; title: string; state: AskState; entries: AskThreadEntry[] }[];
  }> {
    const rows: { id: string; title: string; state: AskState; entries: AskThreadEntry[] }[] = [];
    const cursors: { askId: string; throughSeq: number }[] = [];
    for (const ask of await this.list({ agentId })) {
      const entries = unreadForAgent(ask);
      if (entries.length === 0) continue;
      rows.push({ id: ask.id, title: ask.title, state: ask.state, entries });
      cursors.push({ askId: ask.id, throughSeq: entries[entries.length - 1].seq });
    }
    const deliveryId = crypto.randomUUID();
    if (cursors.length > 0) {
      await this.ctx.storage.put(`delivery:${deliveryId}`, { agentId, cursors, at: new Date().toISOString() });
      await this.pruneDeliveries();
    }
    return { deliveryId, rows };
  }

  /**
   * Ack one delivery: every cursor it recorded, and nothing else. An
   * unknown or replayed token is a no-op, a cursor never moves
   * backwards, and an entry written after that delivery cannot be
   * swallowed by it, because the delivery remembers what it contained.
   */
  async ackDelivery(agentId: string, deliveryId: string): Promise<number> {
    const key = `delivery:${deliveryId}`;
    const delivery = await this.ctx.storage.get<{
      agentId: string;
      cursors: { askId: string; throughSeq: number }[];
    }>(key);
    if (!delivery || delivery.agentId !== agentId) return 0;
    for (const cursor of delivery.cursors) {
      const ask = await this.load(cursor.askId);
      if (!ask || ask.agentId !== agentId) continue;
      const next = Math.max(ask.agentSeenSeq ?? 0, cursor.throughSeq);
      if (next !== (ask.agentSeenSeq ?? 0)) await this.save({ ...ask, agentSeenSeq: next });
    }
    await this.ctx.storage.delete(key);
    return delivery.cursors.length;
  }

  /** Deliveries are short-lived receipts; keep the recent ones only. */
  private async pruneDeliveries(keep = 50): Promise<void> {
    const entries = await this.ctx.storage.list<{ at: string }>({ prefix: "delivery:" });
    if (entries.size <= keep) return;
    const sorted = [...entries.entries()].sort((left, right) =>
      (left[1].at ?? "") < (right[1].at ?? "") ? -1 : 1
    );
    for (const [key] of sorted.slice(0, entries.size - keep)) await this.ctx.storage.delete(key);
  }

  /**
   * The operator-mail backstop (spec 0007 §3), counted on DELIVERIES
   * ONLY. Reserving a slot up front needed a release when the send
   * failed, and a release that itself failed silently ate capacity
   * until the queue went quiet; counting only what actually left makes
   * that whole class impossible. The cost is that a burst of
   * simultaneous sends can overshoot slightly, which for a
   * runaway-loop backstop is the right way to be wrong: this bound
   * exists to stop a flood, not to ration a budget, and a
   * notification suppressed in error is worse than one too many.
   */
  async mailAllowed(at: string, cap = LIMITS.emailsPerDay): Promise<boolean> {
    const sent = (await this.ctx.storage.get<number>(`email:${day(at)}`)) ?? 0;
    return sent < cap;
  }

  /** Count a mail that actually went out. */
  async recordMail(at: string): Promise<void> {
    const key = `email:${day(at)}`;
    const sent = (await this.ctx.storage.get<number>(key)) ?? 0;
    await this.ctx.storage.put(key, sent + 1);
  }
}
