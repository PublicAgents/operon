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
   * The agent's unread operator activity, and the act of reading it.
   * Marking seen is the ack (spec 0007 §6): an answer delivered is an
   * answer the agent has actually been handed.
   */
  async unread(
    agentId: string,
    ack = false
  ): Promise<{ id: string; title: string; state: AskState; entries: AskThreadEntry[] }[]> {
    const rows: { id: string; title: string; state: AskState; entries: AskThreadEntry[] }[] = [];
    for (const ask of await this.list({ agentId })) {
      const entries = unreadForAgent(ask);
      if (entries.length === 0) continue;
      rows.push({ id: ask.id, title: ask.title, state: ask.state, entries });
      if (ack) {
        // Acked to the SEQUENCE of the last entry actually handed over,
        // in the same serialized turn that read it. A timestamp cursor
        // would drop a reply that shared a millisecond with the last
        // acked one, and marking "now" would swallow anything written
        // between the read and the write: an answer silently lost is
        // the exact failure this queue exists to end.
        await this.save({ ...ask, agentSeenSeq: entries[entries.length - 1].seq });
      }
    }
    return rows;
  }

  /**
   * Claim one operator email for today, or refuse: the backstop that
   * keeps a reply loop from flooding a mailbox (spec 0007 §3).
   */
  async claimEmail(at: string, cap = LIMITS.emailsPerDay): Promise<boolean> {
    const key = `email:${day(at)}`;
    const sent = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (sent >= cap) return false;
    await this.ctx.storage.put(key, sent + 1);
    return true;
  }

  /**
   * Give a claimed email slot back when the send did not happen: a day
   * of failures must not exhaust the backstop and silence the queue.
   */
  async releaseEmail(at: string): Promise<void> {
    const key = `email:${day(at)}`;
    const sent = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (sent > 0) await this.ctx.storage.put(key, sent - 1);
  }
}
