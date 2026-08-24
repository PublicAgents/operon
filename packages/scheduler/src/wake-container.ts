import { DurableObject } from "cloudflare:workers";
import type { WakeRecord, WakeTrigger } from "@operon/core";

/**
 * One WakeContainer Durable Object per agent (id = agent id). It is the wake
 * lock, the wake ledger, and the container supervisor in one object:
 * Durable Objects serialize access per id, so two wakes for the same agent
 * can never race, and the ledger lives next to the thing it records.
 *
 * A held lock is surfaced, never silently broken: a wake that outlives the
 * stale threshold is reported to the caller (who alerts the operator) and
 * stays locked until the container actually exits.
 */

export interface LaunchArgs {
  wakeId: string;
  agentId: string;
  trigger: WakeTrigger;
  /** Full environment for the container process; assembled by the scheduler. */
  env: Record<string, string>;
  /** A running wake older than this is reported stale. */
  staleAfterMs: number;
}

export type LaunchResult =
  | { status: "started"; wakeId: string }
  | { status: "locked"; wakeId: string; startedAt: string; stale: boolean }
  | { status: "error"; error: string };

const CURRENT = "current";

function rowKey(record: WakeRecord): string {
  return `wake:${record.startedAt}:${record.wakeId}`;
}

export class WakeContainer extends DurableObject {
  async launch(args: LaunchArgs): Promise<LaunchResult> {
    const current = await this.ctx.storage.get<WakeRecord>(CURRENT);
    if (current) {
      const age = Date.now() - Date.parse(current.startedAt);
      return {
        status: "locked",
        wakeId: current.wakeId,
        startedAt: current.startedAt,
        stale: age > args.staleAfterMs
      };
    }

    if (!this.ctx.container) {
      await this.recordFailure(args, "no_container_runtime");
      return { status: "error", error: "no_container_runtime" };
    }

    const record: WakeRecord = {
      wakeId: args.wakeId,
      agentId: args.agentId,
      trigger: args.trigger,
      startedAt: new Date().toISOString(),
      status: "running"
    };
    await this.ctx.storage.put(CURRENT, record);
    await this.ctx.storage.put(rowKey(record), record);

    try {
      // Awaited so an asynchronous rejection is caught here: otherwise the
      // already-persisted CURRENT lock would never clear and every later
      // wake for this agent would be blocked or stale indefinitely.
      await this.ctx.container.start({ env: args.env, enableInternet: true });
    } catch (error) {
      await this.finish(record, "failed", String(error));
      return { status: "error", error: `container_start_failed: ${String(error)}` };
    }

    this.ctx.waitUntil(
      this.ctx.container.monitor().then(
        () => this.finish(record, "completed"),
        error => this.finish(record, "failed", String(error))
      )
    );
    return { status: "started", wakeId: record.wakeId };
  }

  /** Ledger a wake that failed before the container could start (e.g. no credential). */
  async recordFailure(
    args: Pick<LaunchArgs, "wakeId" | "agentId" | "trigger">,
    reason: string
  ): Promise<void> {
    const now = new Date().toISOString();
    const record: WakeRecord & { reason: string } = {
      wakeId: args.wakeId,
      agentId: args.agentId,
      trigger: args.trigger,
      startedAt: now,
      endedAt: now,
      status: "failed",
      reason
    };
    await this.ctx.storage.put(rowKey(record), record);
  }

  async wakes(limit = 50): Promise<WakeRecord[]> {
    const entries = await this.ctx.storage.list<WakeRecord>({
      prefix: "wake:",
      reverse: true,
      limit
    });
    return [...entries.values()];
  }

  private async finish(
    record: WakeRecord,
    status: "completed" | "failed",
    reason?: string
  ): Promise<void> {
    const finished: WakeRecord & { reason?: string } = {
      ...record,
      status,
      endedAt: new Date().toISOString(),
      ...(reason ? { reason } : {})
    };
    await this.ctx.storage.put(rowKey(record), finished);
    await this.ctx.storage.delete(CURRENT);
  }
}
