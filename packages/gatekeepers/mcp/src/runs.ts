/**
 * Runs and their callbacks for one webhook-bearing server (spec 0014
 * §3), pure over a key-value storage: the open creates (an agent has
 * asked the provider for a run and the answer is in flight), the run
 * ids attributed to agents, the callbacks delivered once per delivery
 * key, queued per agent until the wake that pulls them acks them after
 * its persist, and the callbacks nobody could be attributed, kept for
 * the operator.
 */
import type { KeyValueStorage } from "./meter.js";

export interface OpenCreate {
  id: string;
  agentId: string;
  tool: string;
  at: string;
}

export interface StoredResult {
  id: string;
  runId: string;
  /** The callback's number within its run, in arrival order: the inbox file's name. */
  n: number;
  event: string;
  /** The provider's callback body, verbatim: data, never instructions. */
  body: string;
  at: string;
}

export interface UnattributedResult extends StoredResult {
  /** The open creates at arrival: the evidence for the operator's decision. */
  openCreates: OpenCreate[];
}

/** Run attributions and open creates older than this are forgotten. */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class RunStore {
  constructor(private readonly storage: KeyValueStorage) {}

  /** An agent's create call is about to go: remembered until the run id comes back. */
  async openCreate(create: OpenCreate): Promise<void> {
    await this.storage.put(`create:${create.id}`, create);
  }

  /** The run id came back: the run is the agent's, the create is closed. */
  async closeCreate(createId: string, runId: string): Promise<boolean> {
    const create = await this.storage.get<OpenCreate>(`create:${createId}`);
    if (!create) return false;
    await this.storage.put(`run:${runId}`, { agentId: create.agentId, at: create.at, tool: create.tool });
    await this.storage.delete(`create:${createId}`);
    return true;
  }

  /** A create whose answer was lost stays open; the operator sees it beside an unattributed callback. */
  async listOpenCreates(at: string): Promise<OpenCreate[]> {
    const rows = await this.storage.list<OpenCreate>("create:");
    const cutoff = Date.parse(at) - RUN_RETENTION_MS;
    const out: OpenCreate[] = [];
    for (const [key, create] of rows) {
      if (Date.parse(create.at) < cutoff) {
        await this.storage.delete(key);
        continue;
      }
      out.push(create);
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** The run's agent, while the attribution is within retention; a stale one is forgotten, not honoured. */
  async agentOf(runId: string, at: string): Promise<string | undefined> {
    const run = await this.storage.get<{ agentId: string; at: string }>(`run:${runId}`);
    if (!run) return undefined;
    if (Date.parse(run.at) < Date.parse(at) - RUN_RETENTION_MS) {
      await this.storage.delete(`run:${runId}`);
      return undefined;
    }
    return run.agentId;
  }

  /**
   * A verified callback: stored once per delivery key, queued for the
   * run's agent, or kept for the operator when the run is nobody's.
   */
  async storeCallback(
    input: { runId: string; event: string; deliveryKey: string; body: string; at: string }
  ): Promise<{ stored: boolean; agentId?: string; id: string }> {
    const seenKey = `seen:${input.runId}:${input.deliveryKey}`;
    const seen = await this.storage.get<string>(seenKey);
    if (seen) return { stored: false, id: seen };
    const id = crypto.randomUUID();
    const agentId = await this.agentOf(input.runId, input.at);
    const n = ((await this.storage.get<number>(`seq:${input.runId}`)) ?? 0) + 1;
    await this.storage.put(`seq:${input.runId}`, n);
    const result: StoredResult = { id, runId: input.runId, n, event: input.event, body: input.body, at: input.at };
    if (agentId) {
      await this.storage.put(`result:${agentId}:${input.at}:${id}`, result);
    } else {
      const openCreates = await this.listOpenCreates(input.at);
      await this.storage.put(`orphan:${input.at}:${id}`, { ...result, openCreates } satisfies UnattributedResult);
    }
    await this.storage.put(seenKey, id);
    return { stored: true, ...(agentId ? { agentId } : {}), id };
  }

  /** The agent's queued results, oldest first; acked only after the wake persisted them. */
  async pullResults(agentId: string, limit = 50): Promise<StoredResult[]> {
    const rows = await this.storage.list<StoredResult>(`result:${agentId}:`);
    return [...rows.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit);
  }

  async ackResults(agentId: string, ids: readonly string[]): Promise<number> {
    const rows = await this.storage.list<StoredResult>(`result:${agentId}:`);
    let acked = 0;
    for (const [key, row] of rows) {
      if (ids.includes(row.id)) {
        await this.storage.delete(key);
        acked += 1;
      }
    }
    return acked;
  }

  async listUnattributed(): Promise<UnattributedResult[]> {
    const rows = await this.storage.list<UnattributedResult>("orphan:");
    return [...rows.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  /** The operator's decision: an unattributed callback becomes the named agent's, and the run too. */
  async assign(id: string, agentId: string): Promise<UnattributedResult | undefined> {
    const rows = await this.storage.list<UnattributedResult>("orphan:");
    for (const [key, row] of rows) {
      if (row.id !== id) continue;
      const { openCreates: _evidence, ...result } = row;
      await this.storage.put(`result:${agentId}:${row.at}:${row.id}`, result);
      await this.storage.put(`run:${row.runId}`, { agentId, at: row.at, tool: "assigned" });
      await this.storage.delete(key);
      return row;
    }
    return undefined;
  }
}
