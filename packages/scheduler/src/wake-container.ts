import { DurableObject } from "cloudflare:workers";
import { allDoorHosts } from "./umbilical-routes.js";
import type { WakeRecord, WakeTrigger } from "@operon/core";
import {
  decideAlarmAction,
  HEARTBEAT_INTERVAL_MS,
  DEFAULT_HARD_WALL_MS
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
  /** Hard wall for this wake in ms; past it the container is stopped. */
  hardWallMs: number;
  /**
   * The umbilical nonce (spec 0003 step 4): the container carries it as
   * every door's bearer; the router validates it, so only the root-held
   * porch (not the mind, not a browser page) can reach the doors.
   */
  umbilicalNonce?: string;
}

export type LaunchResult =
  | { status: "started"; wakeId: string }
  | { status: "locked"; wakeId: string; startedAt: string; stale: boolean }
  | { status: "disabled" }
  | { status: "error"; error: string };

interface WakeEnv {
  NOTIFY_URL?: string;
  NOTIFY_TOKEN?: string;
  /** The umbilical router reads the real door bearers and Gatekeeper
   * service bindings from this (the scheduler worker) env. */
  [name: string]: unknown;
}

const CURRENT = "current";
const HARD_WALL = "hardWallMs";
/**
 * The operator kill switch. Set over Telegram (/disable) through the
 * scheduler; while present, launch() refuses every wake (cron and manual
 * alike) regardless of the roster, and setting it kills any wake already
 * running. Cleared only by an explicit /enable.
 */
const OPERATOR_DISABLED = "operatorDisabled";

function rowKey(record: WakeRecord): string {
  return `wake:${record.startedAt}:${record.wakeId}`;
}

export class WakeContainer extends DurableObject<WakeEnv> {
  /**
   * Synchronous single-finisher guard. The hard-wall alarm and the monitor
   * callback are both in-flight coroutines inside this DO, so input gates
   * do not serialize them: both could read a matching CURRENT before
   * either deletes it. Membership here is checked and set with no await in
   * between, which is what makes the first finisher win atomically. The
   * storage guard in finish() still covers cross-restart staleness.
   */
  private finishedWakeIds = new Set<string>();

  async launch(args: LaunchArgs): Promise<LaunchResult> {
    if (await this.ctx.storage.get<boolean>(OPERATOR_DISABLED)) {
      return { status: "disabled" };
    }
    const current = await this.ctx.storage.get<WakeRecord>(CURRENT);
    if (current) {
      if (!this.ctx.container?.running) {
        // Lock held but no container: the outcome was lost (eviction with
        // a failed heartbeat, or any supervisor gap). Self-heal here so a
        // lock can never be permanent, then proceed with this launch.
        await this.finish(
          current,
          "failed",
          "outcome_unknown: lock held with no running container; reconciled at next launch"
        );
      } else {
        const age = Date.now() - Date.parse(current.startedAt);
        return {
          status: "locked",
          wakeId: current.wakeId,
          startedAt: current.startedAt,
          stale: age > args.staleAfterMs
        };
      }
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
    await this.ctx.storage.put(HARD_WALL, args.hardWallMs);
    await this.ctx.storage.put(rowKey(record), record);

    try {
      // Awaited so an asynchronous rejection is caught here: otherwise the
      // already-persisted CURRENT lock would never clear and every later
      // wake for this agent would be blocked or stale indefinitely.
      // The umbilical (spec 0003 step 4): intercept the container's door
      // egress (http://<door>.operon.internal) and route it through the
      // supervisor, which holds the real bearers. No door credential rides
      // in the container. The router is created with the agent id and the
      // wake's nonce baked into its env, so identity is a fact of the
      // supervisor, not a container header, and only the porch can pass
      // the nonce.
      if (args.umbilicalNonce) {
        // interceptOutboundHttp requires a Fetcher: a loopback service
        // binding to the worker's own UmbilicalRouter export
        // (ctx.exports, enable_ctx_exports flag), with the per-wake
        // identity delivered as ctx.props.
        const exportsBag = (this.ctx as unknown as { exports: Record<string, (opts: { props: unknown }) => Fetcher> }).exports;
        const router = exportsBag.UmbilicalRouter({
          props: { nonce: args.umbilicalNonce, agentId: args.agentId }
        });
        const intercept = this.ctx.container as unknown as {
          interceptOutboundHttp(host: string, worker: Fetcher): Promise<void>;
        };
        for (const host of allDoorHosts()) {
          await intercept.interceptOutboundHttp(host, router);
        }
      }
      // Egress AUDIT, not a fence: every real outbound request the
      // container makes is intercepted, logged, and forwarded (spec
      // 0004 section 8). We deliberately do NOT block: a hijacked mind
      // can exfiltrate through the remote browser regardless (the
      // irreducible residual), so a fence is burden without benefit; the
      // value is a durable record to analyse later. Fail-open: if the
      // audit worker errors, the request still goes through.
      const exportsBag = (this.ctx as unknown as {
        exports: Record<string, (opts?: { props?: unknown }) => Fetcher>;
      }).exports;
      if (exportsBag.EgressAudit) {
        const audit = exportsBag.EgressAudit({ props: { agentId: args.agentId, wakeId: args.wakeId } });
        const intercept = this.ctx.container as unknown as {
          interceptOutboundHttps(host: string, worker: Fetcher): Promise<void>;
        };
        // "*" catches all HTTPS egress (npm, git, api hosts, everything);
        // the door virtual hosts are plain HTTP and stay on the umbilical.
        await intercept.interceptOutboundHttps("*", audit);
      }
      await this.ctx.container.start({ env: args.env, enableInternet: true });
    } catch (error) {
      await this.finish(record, "failed", String(error));
      return { status: "error", error: `container_start_failed: ${String(error)}` };
    }

    // Close the disable/launch race: a /disable that interleaved at any
    // await above may have seen no running container and killed nothing.
    // Every interleaving now ends dead: the flag was either visible at the
    // top check (refused), or is visible here, where this launch kills its
    // own container.
    if (await this.ctx.storage.get<boolean>(OPERATOR_DISABLED)) {
      try {
        this.ctx.container.destroy();
      } catch (error) {
        console.error("kill after disabled-race failed", error);
      }
      await this.finish(record, "failed", "killed_by_operator_disable");
      return { status: "disabled" };
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

    // The heartbeat that keeps this DO (and therefore the container) alive
    // for the duration of the wake. Arming it is REQUIRED: without it the
    // wake dies by eviction mid-session and, because reconciliation is
    // itself alarm-driven, the lock could stand until the next launch. A
    // wake that cannot heartbeat is aborted, not limped.
    try {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    } catch {
      try {
        await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
      } catch (error) {
        try {
          this.ctx.container.destroy();
        } catch {
          // Bookkeeping below must run regardless.
        }
        const detail = `heartbeat_arm_failed: ${String(error).slice(0, 200)}`;
        await this.finish(record, "failed", detail);
        await this.notify(`[${record.agentId}] wake ${record.wakeId} aborted: ${detail}`);
        return { status: "error", error: detail };
      }
    }
    return { status: "started", wakeId: record.wakeId };
  }

  /**
   * The operator kill switch. Disabling refuses all future wakes AND kills
   * a wake in flight: the container is destroyed, and the monitor callback
   * then finishes the record as failed. Work in that wake that was not yet
   * persisted is lost, which is what a kill switch means.
   */
  async setDisabled(disabled: boolean): Promise<{ disabled: boolean; killedWakeId?: string }> {
    if (!disabled) {
      await this.ctx.storage.delete(OPERATOR_DISABLED);
      return { disabled: false };
    }
    await this.ctx.storage.put(OPERATOR_DISABLED, true);
    const current = await this.ctx.storage.get<WakeRecord>(CURRENT);
    if (current) {
      // Kill a running container; a launch still mid-start sees the flag
      // in launch()'s post-start check and kills its own container, so a
      // CURRENT that is not running yet still ends dead.
      if (this.ctx.container?.running) {
        try {
          this.ctx.container.destroy();
        } catch (error) {
          console.error("kill on disable failed", error);
        }
      }
      return { disabled: true, killedWakeId: current.wakeId };
    }
    return { disabled: true };
  }

  async isDisabled(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(OPERATOR_DISABLED)) === true;
  }

  override async alarm(): Promise<void> {
    const current = await this.ctx.storage.get<WakeRecord>(CURRENT);
    const hardWallMs =
      (await this.ctx.storage.get<number>(HARD_WALL)) ?? DEFAULT_HARD_WALL_MS;
    const action = decideAlarmAction(
      current,
      this.ctx.container?.running ?? false,
      Date.now(),
      hardWallMs
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
        const detail = `hard_timeout: wake exceeded ${Math.round(hardWallMs / 60000)} minutes and was stopped`;
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
   * Finalize a wake exactly once. First line of defense is the synchronous
   * finishedWakeIds check (atomic between in-flight coroutines: no await
   * before membership is recorded); the storage comparison covers a DO
   * restart, where the in-memory set is empty but a stale callback cannot
   * exist either. Cleanup order matters: the alarm is deleted BEFORE the
   * lock clears, so no later launch can have armed its own heartbeat in
   * between and lost it to this wake's cleanup.
   */
  private async finish(
    record: WakeRecord,
    status: "completed" | "failed",
    reason?: string
  ): Promise<void> {
    if (this.finishedWakeIds.has(record.wakeId)) return;
    this.finishedWakeIds.add(record.wakeId);
    const finished: WakeRecord & { reason?: string } = {
      ...record,
      status,
      endedAt: new Date().toISOString(),
      ...(reason ? { reason } : {})
    };
    // The ownership check and the cleanup are one transaction: a stale
    // finisher that lost the lock to a newer launch can neither write its
    // row nor delete the new wake's lock or heartbeat, atomically and
    // regardless of how coroutines or events interleave. If the
    // transaction itself fails transiently, membership is rolled back so a
    // later finisher (the alarm's reconcile, or the racing callback) can
    // retry instead of being permanently suppressed.
    try {
      await this.ctx.storage.transaction(async txn => {
        const current = await txn.get<WakeRecord>(CURRENT);
        if (!current || current.wakeId !== record.wakeId) return;
        await txn.put(rowKey(record), finished);
        await txn.deleteAlarm();
        await txn.delete(CURRENT);
      });
    } catch (error) {
      this.finishedWakeIds.delete(record.wakeId);
      throw error;
    }
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
