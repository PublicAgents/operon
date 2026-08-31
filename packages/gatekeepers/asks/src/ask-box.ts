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
   * The agent's unread operator activity. Reading NEVER acks: the
   * chassis delivers at-least-once and acks only after the wake has
   * persisted what it was handed (the same rule the mail and channel
   * cursors follow). Acking on read would lose every entry in a
   * response that never arrived, which is precisely the failure this
   * queue exists to end.
   */
  async unread(
    agentId: string
  ): Promise<{ id: string; title: string; state: AskState; entries: AskThreadEntry[] }[]> {
    const rows: { id: string; title: string; state: AskState; entries: AskThreadEntry[] }[] = [];
    for (const ask of await this.list({ agentId })) {
      const entries = unreadForAgent(ask);
      if (entries.length === 0) continue;
      rows.push({ id: ask.id, title: ask.title, state: ask.state, entries });
      // Record what was handed over, so a later ack can be bounded by
      // it. This is the only honest ceiling: the thread length at ack
      // time may already include entries this read never returned.
      const offered = Math.max(ask.agentOfferedSeq ?? 0, entries[entries.length - 1].seq);
      if (offered !== (ask.agentOfferedSeq ?? 0)) await this.save({ ...ask, agentOfferedSeq: offered });
    }
    return rows;
  }

  /**
   * Ack what the wake actually kept, per ask, up to a sequence it
   * names. Idempotent and monotonic: a replayed ack is a no-op, and a
   * stale one can never move a cursor backwards and re-deliver.
   */
  async ackUnread(agentId: string, cursors: { askId: string; throughSeq: number }[]): Promise<void> {
    for (const cursor of cursors) {
      const ask = await this.load(cursor.askId);
      if (!ask || ask.agentId !== agentId) continue;
      // Clamped to what this ask actually HANDED OVER, never to the
      // thread's current length: an operator entry written between the
      // read and the ack must survive an over-large cursor, and an
      // invented number must not reach past delivery at all.
      const ceiling = ask.agentOfferedSeq ?? 0;
      const next = Math.min(Math.max(ask.agentSeenSeq ?? 0, cursor.throughSeq), ceiling);
      if (next !== (ask.agentSeenSeq ?? 0)) await this.save({ ...ask, agentSeenSeq: next });
    }
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
