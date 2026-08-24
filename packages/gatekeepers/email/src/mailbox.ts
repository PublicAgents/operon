import { DurableObject } from "cloudflare:workers";
import { DAILY_SEND_CAP, decideSend, type SendDecision } from "./policy.js";

export type SendReservation =
  | { action: "send"; count: number }
  | Exclude<SendDecision, { action: "send" }>;

/**
 * One Mailbox Durable Object per agent: the inbox (pending inbound
 * messages the wake pulls at boot), the set of known correspondents (who
 * the agent may reply to without operator approval), the daily send
 * counter (rate limit), and the queue of first-contact sends held for the
 * operator. Serialized per agent by the DO, so counts and queues never
 * race.
 */

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
}

export interface InboundMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  text: string;
  messageId?: string;
  /** Metadata only; the full attachments are in the operator's forwarded copy. */
  attachments?: AttachmentMeta[];
}

export interface HeldSend {
  id: string;
  to: string;
  subject: string;
  text: string;
  queuedAt: string;
}

interface SendWindow {
  day: string;
  count: number;
}

function today(nowIso: string): string {
  return nowIso.slice(0, 10);
}

export class Mailbox extends DurableObject {
  /** Store an inbound message and record its sender as a correspondent. */
  async deliver(message: Omit<InboundMessage, "id">): Promise<void> {
    const id = crypto.randomUUID();
    await this.ctx.storage.put(`in:${message.date}:${id}`, { id, ...message });
    const correspondents = (await this.ctx.storage.get<string[]>("correspondents")) ?? [];
    const from = message.from.toLowerCase();
    if (!correspondents.includes(from)) {
      correspondents.push(from);
      await this.ctx.storage.put("correspondents", correspondents);
    }
  }

  /**
   * Return pending inbound messages WITHOUT deleting them. Delivery is
   * at-least-once: the caller writes them to files, then calls ack(ids).
   * If the caller crashes before ack, they are re-delivered next wake, and
   * writing the same inbox file again is idempotent. Nothing is lost by an
   * interrupted response or a failed write.
   */
  async pull(): Promise<InboundMessage[]> {
    const entries = await this.ctx.storage.list<InboundMessage>({ prefix: "in:" });
    return [...entries.values()];
  }

  /** Delete inbound messages the caller has durably taken. */
  async ack(ids: string[]): Promise<void> {
    const wanted = new Set(ids);
    const entries = await this.ctx.storage.list<InboundMessage>({ prefix: "in:" });
    const keys = [...entries.entries()].filter(([, m]) => wanted.has(m.id)).map(([k]) => k);
    if (keys.length > 0) await this.ctx.storage.delete(keys);
  }

  async correspondents(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("correspondents")) ?? [];
  }

  /**
   * Atomically apply the send policy and, if it says send, RESERVE the slot
   * (increment the daily counter and record the correspondent) in one DO
   * turn. Because a Durable Object runs one method call at a time, two
   * overlapping sends near the cap cannot both pass. A caller whose actual
   * delivery then fails calls release() to give the slot back.
   */
  async reserveSend(
    to: string,
    subject: string,
    nowIso: string,
    approved: boolean
  ): Promise<SendReservation> {
    const day = today(nowIso);
    const window = await this.ctx.storage.get<SendWindow>("sendWindow");
    const sentToday = window && window.day === day ? window.count : 0;
    const correspondents = (await this.ctx.storage.get<string[]>("correspondents")) ?? [];

    const decision = decideSend({
      to,
      correspondents: new Set(correspondents),
      sentToday,
      approved
    });
    if (decision.action !== "send") return decision;

    const count = sentToday + 1;
    await this.ctx.storage.put("sendWindow", { day, count });
    const recipient = to.toLowerCase();
    if (!correspondents.includes(recipient)) {
      correspondents.push(recipient);
      await this.ctx.storage.put("correspondents", correspondents);
    }
    // Durable outbox record, written in the SAME DO turn as the reservation
    // and BEFORE the network send: the guaranteed operator-visible record of
    // every outbound attempt, independent of whether the email copy or the
    // Telegram notify then succeed. Readable via the outbox endpoint.
    await this.ctx.storage.put(`out:${nowIso}:${crypto.randomUUID()}`, {
      to: recipient,
      subject,
      at: nowIso
    });
    return { action: "send", count };
  }

  async outbox(limit = 100): Promise<Array<{ to: string; subject: string; at: string }>> {
    const entries = await this.ctx.storage.list<{ to: string; subject: string; at: string }>({
      prefix: "out:",
      reverse: true,
      limit
    });
    return [...entries.values()];
  }

  /** Return a reserved-but-undelivered slot to the daily counter. */
  async release(nowIso: string): Promise<void> {
    const day = today(nowIso);
    const window = await this.ctx.storage.get<SendWindow>("sendWindow");
    if (window && window.day === day && window.count > 0) {
      await this.ctx.storage.put("sendWindow", { day, count: window.count - 1 });
    }
  }

  async hold(send: Omit<HeldSend, "id" | "queuedAt">, nowIso: string): Promise<HeldSend> {
    const held: HeldSend = { id: crypto.randomUUID(), queuedAt: nowIso, ...send };
    await this.ctx.storage.put(`held:${held.id}`, held);
    return held;
  }

  /**
   * Atomically claim a held send for delivery: returns it only to the first
   * caller, so two concurrent approvals of the same id cannot both send it.
   * On delivery success the caller deletes it; on failure the caller
   * unclaims it so it can be retried.
   */
  async claimHeld(id: string): Promise<HeldSend | undefined> {
    const held = await this.ctx.storage.get<HeldSend & { claimed?: boolean }>(`held:${id}`);
    if (!held || held.claimed) return undefined;
    await this.ctx.storage.put(`held:${id}`, { ...held, claimed: true });
    return held;
  }

  async unclaimHeld(id: string): Promise<void> {
    const held = await this.ctx.storage.get<HeldSend & { claimed?: boolean }>(`held:${id}`);
    if (held) await this.ctx.storage.put(`held:${id}`, { ...held, claimed: false });
  }

  async deleteHeld(id: string): Promise<void> {
    await this.ctx.storage.delete(`held:${id}`);
  }

  async listHeld(): Promise<HeldSend[]> {
    const entries = await this.ctx.storage.list<HeldSend>({ prefix: "held:" });
    return [...entries.values()];
  }

  get dailyCap(): number {
    return DAILY_SEND_CAP;
  }
}
