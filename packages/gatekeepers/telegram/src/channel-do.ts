import { DurableObject } from "cloudflare:workers";
import {
  RETENTION,
  transcriptFor,
  type AgentTranscript,
  type ChannelEntry
} from "./channel.js";

/**
 * One Channel Durable Object per colony: the operator-conversation log and
 * each agent's delivery cursor. Serialized by the DO, so ids are strictly
 * monotonic and pulls never race appends.
 */
export class Channel extends DurableObject {
  async append(entry: Omit<ChannelEntry, "id">): Promise<ChannelEntry> {
    const nextId = ((await this.ctx.storage.get<number>("nextId")) ?? 1);
    const stored: ChannelEntry = { id: nextId, ...entry };
    await this.ctx.storage.put(`e:${String(nextId).padStart(10, "0")}`, stored);
    await this.ctx.storage.put("nextId", nextId + 1);
    // Prune beyond retention; the channel is a recent-context window, not
    // an archive (the ledger and the agents' own journals are the archive).
    const entries = await this.ctx.storage.list({ prefix: "e:" });
    if (entries.size > RETENTION) {
      const keys = [...entries.keys()].slice(0, entries.size - RETENTION);
      await this.ctx.storage.delete(keys);
    }
    return stored;
  }

  /**
   * The agent's recent transcript plus which operator entries are new since
   * its last acked wake. Does NOT advance the cursor: the wake acks after
   * its state persists, so a dead wake re-receives the same [NEW] marks.
   */
  async pullFor(agentId: string): Promise<AgentTranscript> {
    const entries = [...(await this.ctx.storage.list<ChannelEntry>({ prefix: "e:" })).values()];
    const cursor = (await this.ctx.storage.get<number>(`cursor:${agentId}`)) ?? 0;
    return transcriptFor(entries, agentId, cursor);
  }

  async ack(agentId: string, upTo: number): Promise<void> {
    const cursor = (await this.ctx.storage.get<number>(`cursor:${agentId}`)) ?? 0;
    if (upTo > cursor) await this.ctx.storage.put(`cursor:${agentId}`, upTo);
  }
}
