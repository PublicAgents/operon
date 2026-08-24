import { DurableObject } from "cloudflare:workers";
import type { WakeRecord, WakeTrigger } from "@operon/core";
import {
  decideAlarmAction,
  HEARTBEAT_INTERVAL_MS,
  HARD_WALL_MS
} from "./wake-lifecycle.js";

/**
 * One WakeContainer Durable Object per agent (id = agent id). It is the wake
 * lock, the wake ledger, and the container supervisor in one object:
 * Durable Objects serialize access per id, so two wakes for the same agent
 * can never race, and the ledger lives next to the thing it records.
 *
 * While a wake runs, an alarm heartbeat re-arms every HEARTBEAT_INTERVAL_MS.
 * This is load-bearing: without it the idle DO is evicted and its container
 * is stopped mid-session (observed in production as the harness dying with
 * SIGTERM/exit 143). The heartbeat also enforces the hard wall (a hung
 * session is stopped and the failure recorded and notified, rather than
 * holding the agent's wake lock forever) and reconciles state if the DO
 * ever restarts mid-wake and loses the monitor callback.
 */

export interface LaunchArgs {
  wakeId: string;
  agentId: string;
  trigger: WakeTrigger;
  /** Full environment for the container process; assembled by the scheduler. */
  env: Record<string, string>;
  /** A running wake older than this is reported stale to callers. */
  staleAfterMs: number;
}

export type LaunchResult =
  | { status: "started"; wakeId: string }
  | { status: "locked"; wakeId: string; startedAt: string; stale: boolean }
  | { status: "error"; error: string };

interface WakeEnv {
  NOTIFY_URL?: string;
  NOTIFY_TOKEN?: string;
}

const CURRENT = "current";

function rowKey(record: WakeRecord): string {
  return `wake:${record.startedAt}:${record.wakeId}`;
}

export class WakeContainer extends DurableObject<WakeEnv> {
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

    // Supervision first, heartbeat second: if arming the alarm fails, the
    // monitor callback still supervises the wake; the reverse order could
    // strand a running container with a held lock and no supervisor at all.
    this.ctx.waitUntil(
      this.ctx.container.monitor().then(
        () => this.finish(record, "completed"),
        error => this.finish(record, "failed", String(error))
      )
    );

    try {
      // The heartbeat that keeps this DO (and therefore the container)
      // alive for the duration of the wake.
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    } catch (error) {
      // The wake proceeds under monitor supervision, but without the
      // heartbeat it can be evicted mid-session: the operator should know.
      console.error("heartbeat arming failed", error);
      await this.notify(
        `[${record.agentId}] wake ${record.wakeId}: heartbeat arming failed (${String(error).slice(0, 200)}); the wake may be stopped early by eviction`
      );
    }
    return { status: "started", wakeId: record.wakeId };
  }

  override async alarm(): Promise<void> {
    const current = await this.ctx.storage.get<WakeRecord>(CURRENT);
    const action = decideAlarmAction(
      current,
      this.ctx.container?.running ?? false,
      Date.now()
    );
    switch (action.kind) {
      case "idle":
        return;
      case "rearm":
        await this.ctx.storage.setAlarm(action.atMs);
        return;
      case "hard_timeout": {
        const record = current as WakeRecord;
        try {
          this.ctx.container?.destroy();
        } catch {
          // Destroy failing must not stop the bookkeeping below.
        }
        const detail = `hard_timeout: wake exceeded ${HARD_WALL_MS / 60000} minutes and was stopped`;
        await this.finish(record, "failed", detail);
        await this.notify(`[${record.agentId}] wake ${record.wakeId} ${detail}`);
        return;
      }
      case "reconcile": {
        const record = current as WakeRecord;
        const detail =
          "outcome_unknown: the supervisor restarted mid-wake and the container exit was not observed";
        await this.finish(record, "failed", detail);
        await this.notify(`[${record.agentId}] wake ${record.wakeId} ${detail}`);
        return;
      }
    }
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

  /**
   * Finalize a wake exactly once. The hard-wall alarm and the monitor
   * callback can race to finish the same record (destroy makes the monitor
   * settle right after the alarm already recorded hard_timeout), and a
   * stale monitor callback could otherwise clear a LATER wake's lock and
   * heartbeat. The guard makes the first finisher win and every other call
   * a no-op.
   */
  private async finish(
    record: WakeRecord,
    status: "completed" | "failed",
    reason?: string
  ): Promise<void> {
    const current = await this.ctx.storage.get<WakeRecord>(CURRENT);
    if (!current || current.wakeId !== record.wakeId) return;
    const finished: WakeRecord & { reason?: string } = {
      ...record,
      status,
      endedAt: new Date().toISOString(),
      ...(reason ? { reason } : {})
    };
    await this.ctx.storage.put(rowKey(record), finished);
    await this.ctx.storage.delete(CURRENT);
    await this.ctx.storage.deleteAlarm();
  }

  /** Best-effort operator alert through the telegram Gatekeeper; never throws. */
  private async notify(text: string): Promise<void> {
    if (!this.env.NOTIFY_URL || !this.env.NOTIFY_TOKEN) return;
    try {
      const response = await fetch(this.env.NOTIFY_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.NOTIFY_TOKEN}`
        },
        body: JSON.stringify({ text })
      });
      if (!response.ok) {
        console.error(
          `wake-container notify rejected: ${response.status} ${(await response.text()).slice(0, 200)}`
        );
      }
    } catch (error) {
      console.error("wake-container notify failed", error);
    }
  }
}
