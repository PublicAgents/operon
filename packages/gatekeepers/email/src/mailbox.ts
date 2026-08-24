import { DurableObject } from "cloudflare:workers";
import { DAILY_SEND_CAP } from "./policy.js";

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

  /** Return pending inbound messages and clear them (the wake has them now). */
  async pull(): Promise<InboundMessage[]> {
    const entries = await this.ctx.storage.list<InboundMessage>({ prefix: "in:" });
    const messages = [...entries.values()];
    if (entries.size > 0) await this.ctx.storage.delete([...entries.keys()]);
    return messages;
  }

  async correspondents(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("correspondents")) ?? [];
  }

  async sentToday(nowIso: string): Promise<number> {
    const window = await this.ctx.storage.get<SendWindow>("sendWindow");
    return window && window.day === today(nowIso) ? window.count : 0;
  }

  /** Record a successful send against the daily window; returns the new count. */
  async recordSend(to: string, nowIso: string): Promise<number> {
    const day = today(nowIso);
    const window = await this.ctx.storage.get<SendWindow>("sendWindow");
    const count = window && window.day === day ? window.count + 1 : 1;
    await this.ctx.storage.put("sendWindow", { day, count });
    // A recipient we send to becomes a correspondent (replies flow after).
    const correspondents = (await this.ctx.storage.get<string[]>("correspondents")) ?? [];
    const recipient = to.toLowerCase();
    if (!correspondents.includes(recipient)) {
      correspondents.push(recipient);
      await this.ctx.storage.put("correspondents", correspondents);
    }
    return count;
  }

  async hold(send: Omit<HeldSend, "id" | "queuedAt">, nowIso: string): Promise<HeldSend> {
    const held: HeldSend = { id: crypto.randomUUID(), queuedAt: nowIso, ...send };
    await this.ctx.storage.put(`held:${held.id}`, held);
    return held;
  }

  async takeHeld(id: string): Promise<HeldSend | undefined> {
    const held = await this.ctx.storage.get<HeldSend>(`held:${id}`);
    if (held) await this.ctx.storage.delete(`held:${id}`);
    return held;
  }

  async listHeld(): Promise<HeldSend[]> {
    const entries = await this.ctx.storage.list<HeldSend>({ prefix: "held:" });
    return [...entries.values()];
  }

  get dailyCap(): number {
    return DAILY_SEND_CAP;
  }
}
