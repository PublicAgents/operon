import { describe, expect, it } from "vitest";
import type { WakeRecord } from "@operon/core";
import {
  decideAlarmAction,
  HEARTBEAT_INTERVAL_MS,
  HARD_WALL_MS
} from "./wake-lifecycle.js";

const now = Date.parse("2026-08-24T12:00:00Z");

function running(ageMs: number): WakeRecord {
  return {
    wakeId: "w1",
    agentId: "growth",
    trigger: "cron",
    startedAt: new Date(now - ageMs).toISOString(),
    status: "running"
  };
}

describe("decideAlarmAction", () => {
  it("idles when no wake is in progress, ending the alarm chain", () => {
    expect(decideAlarmAction(undefined, false, now)).toEqual({ kind: "idle" });
  });

  it("re-arms the heartbeat for a healthy running wake", () => {
    expect(decideAlarmAction(running(5 * 60_000), true, now)).toEqual({
      kind: "rearm",
      atMs: now + HEARTBEAT_INTERVAL_MS
    });
  });

  it("re-arms right up to the hard wall, then stops the wake past it", () => {
    expect(decideAlarmAction(running(HARD_WALL_MS - 1), true, now).kind).toBe("rearm");
    expect(decideAlarmAction(running(HARD_WALL_MS + 1), true, now)).toEqual({
      kind: "hard_timeout"
    });
  });

  it("reconciles a running record whose container is gone (lost monitor)", () => {
    expect(decideAlarmAction(running(60_000), false, now)).toEqual({
      kind: "reconcile"
    });
  });
});
