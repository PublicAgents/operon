import { DurableObject } from "cloudflare:workers";

/**
 * Colony-wide wake pause (spec 0006 §5): the drain primitive. Pausing
 * DEFERS new wake starts and touches nothing in flight, which is the
 * whole point: the kill switch (per-agent disable) destroys a running
 * wake, and a deploy drain must never do that. A paused cron simply
 * fires again at its next cadence; the pause, every skipped fire, and
 * the resume are ledgered by the callers.
 */
export class FleetControl extends DurableObject {
  async pause(reason: string): Promise<void> {
    await this.ctx.storage.put("paused", { at: new Date().toISOString(), reason });
  }

  async resume(): Promise<void> {
    await this.ctx.storage.delete("paused");
  }

  async state(): Promise<{ paused: false } | { paused: true; at: string; reason: string }> {
    const paused = await this.ctx.storage.get<{ at: string; reason: string }>("paused");
    return paused ? { paused: true, ...paused } : { paused: false };
  }
}
