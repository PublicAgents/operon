import { DurableObject } from "cloudflare:workers";

/**
 * Colony-wide wake pause (spec 0006 §5): the drain primitive. Pausing
 * DEFERS new wake starts and touches nothing in flight, which is the
 * whole point: the kill switch (per-agent disable) destroys a running
 * wake, and a deploy drain must never do that. A paused cron simply
 * fires again at its next cadence.
 *
 * The pause is HELD BY A TOKEN: a deploy resumes only the pause it
 * took, so two overlapping image-changing deploys cannot release each
 * other (the second pause attempt is refused and that deploy fails
 * fast instead). The operator's resume tool passes force to clear a
 * stuck pause regardless of holder.
 */
export class FleetControl extends DurableObject {
  async pause(
    reason: string,
    token: string
  ): Promise<{ ok: true } | { ok: false; heldBy: string; at: string; reason: string }> {
    const existing = await this.ctx.storage.get<{ at: string; reason: string; token: string }>("paused");
    if (existing && existing.token !== token) {
      return { ok: false, heldBy: existing.token, at: existing.at, reason: existing.reason };
    }
    await this.ctx.storage.put("paused", { at: new Date().toISOString(), reason, token });
    return { ok: true };
  }

  async resume(token: string, force: boolean): Promise<{ ok: boolean; wasPaused: boolean }> {
    const existing = await this.ctx.storage.get<{ token: string }>("paused");
    if (!existing) return { ok: true, wasPaused: false };
    if (!force && existing.token !== token) return { ok: false, wasPaused: true };
    await this.ctx.storage.delete("paused");
    return { ok: true, wasPaused: true };
  }

  async state(): Promise<{ paused: false } | { paused: true; at: string; reason: string }> {
    const paused = await this.ctx.storage.get<{ at: string; reason: string }>("paused");
    return paused ? { paused: true, at: paused.at, reason: paused.reason } : { paused: false };
  }
}
