import { DEFAULT_MAX_WAKE_MINUTES, type WakeRecord } from "@operon/core";

/**
 * Pure decision logic for the WakeContainer's alarm heartbeat, extracted so
 * the lifecycle rules are unit-testable without a Workers runtime.
 *
 * Why the heartbeat exists: a wake is a minutes-long container run during
 * which the Durable Object receives no requests. An idle DO gets evicted,
 * and an evicted DO's container is stopped (SIGTERM), killing the session
 * mid-wake. Re-arming an alarm while the container runs keeps the DO alive
 * for exactly as long as the wake needs it, and gives the DO a place to
 * enforce the hard wall and to reconcile state after a crash.
 */

/** How often the heartbeat re-arms while a wake runs. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Default hard wall: a wake older than this is forcibly stopped, losing any
 * unpushed work, so the default is generous. This is a hung-session
 * backstop, not a productivity budget; the stale threshold (45 min, in the
 * scheduler) reports a long-running wake to the operator far earlier
 * without touching it. Per-agent override: roster maxWakeMinutes.
 */
export const DEFAULT_HARD_WALL_MS = DEFAULT_MAX_WAKE_MINUTES * 60 * 1000;

export type AlarmAction =
  /** No wake in progress: let the alarm chain end. */
  | { kind: "idle" }
  /** Wake healthy: re-arm the heartbeat. */
  | { kind: "rearm"; atMs: number }
  /** Wake exceeded the hard wall: stop the container, record, notify. */
  | { kind: "hard_timeout" }
  /**
   * Record says running but the container is not, and no monitor callback
   * cleared it: the DO was evicted mid-wake and the outcome was lost.
   * Record honestly as failed with an outcome-unknown reason.
   */
  | { kind: "reconcile" };

export function decideAlarmAction(
  current: WakeRecord | undefined,
  containerRunning: boolean,
  nowMs: number,
  hardWallMs = DEFAULT_HARD_WALL_MS
): AlarmAction {
  if (!current) return { kind: "idle" };
  if (!containerRunning) return { kind: "reconcile" };
  const age = nowMs - Date.parse(current.startedAt);
  if (age > hardWallMs) return { kind: "hard_timeout" };
  return { kind: "rearm", atMs: nowMs + HEARTBEAT_INTERVAL_MS };
}
