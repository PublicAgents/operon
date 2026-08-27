import { DurableObject } from "cloudflare:workers";

/**
 * One WakeLog Durable Object per wake (idFromName(wakeId)): the LIVE,
 * tailable copy of a wake's transcript. Chunks arrive in order from the
 * container; a tail reader polls with ?after=<seq> and receives only
 * what is new. The durable forever-copy is the chronicle D1 mirror; this
 * object self-expires (alarm) once the wake is long over, so per-wake
 * storage does not accrete.
 */

export interface WakeChunk {
  seq: number;
  at: string;
  text: string;
  done: boolean;
}

/** DO copies expire this long after the last append; D1 keeps history. */
const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

export class WakeLog extends DurableObject {
  async append(agentId: string, chunk: WakeChunk): Promise<void> {
    await this.ctx.storage.put(`c:${String(chunk.seq).padStart(8, "0")}`, chunk);
    await this.ctx.storage.put("meta", { agentId, lastAt: chunk.at, done: chunk.done });
    await this.ctx.storage.setAlarm(Date.now() + EXPIRE_MS);
  }

  async read(afterSeq = -1): Promise<{ agentId?: string; done: boolean; chunks: WakeChunk[] }> {
    const meta = await this.ctx.storage.get<{ agentId: string; done: boolean }>("meta");
    const chunks = [...(await this.ctx.storage.list<WakeChunk>({ prefix: "c:" })).values()].filter(
      chunk => chunk.seq > afterSeq
    );
    return { agentId: meta?.agentId, done: meta?.done ?? false, chunks };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
