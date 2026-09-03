import { DurableObject } from "cloudflare:workers";
import type { Door } from "@operon/core";
import { sanitizeOverrides, type DoorOverrides } from "./doors.js";

/**
 * A mind credential a harness refreshed in place (spec 0010 §5),
 * descended from the operator's secret with fingerprint `seed`. Only
 * that seed's launches use it; a re-seeded secret orphans it.
 */
export interface RefreshedCredential {
  seed: string;
  value: string;
  at: string;
}

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

  // ---- the doors matrix's runtime overrides (spec 0006 §7) ----------
  // One small store beside the pause: the operator's word on a door,
  // per agent, read at every launch and editable from the plane
  // without a deploy. Effective at the next wake; a running wake keeps
  // the doors it was wired with.

  // ---- the refresh relay (spec 0010 §5) ----------------------------
  // A file credential (Codex's login) rotates itself inside a wake; the
  // relayed copy lives here, per harness, tagged with the fingerprint of
  // the secret it descends from, so the operator's own re-seed always
  // wins over a stored refresh of an older secret.

  async refreshedCredential(harness: string): Promise<RefreshedCredential | undefined> {
    return this.ctx.storage.get<RefreshedCredential>(`mind:${harness}`);
  }

  async setRefreshedCredential(harness: string, seed: string, value: string): Promise<void> {
    await this.ctx.storage.put(`mind:${harness}`, {
      seed,
      value,
      at: new Date().toISOString()
    } satisfies RefreshedCredential);
  }

  async doorOverrides(agentId: string): Promise<DoorOverrides> {
    return sanitizeOverrides(await this.ctx.storage.get(`doors:${agentId}`));
  }

  /** enabled null clears the override, so the roster's baseline rules again. */
  async setDoor(agentId: string, door: Door, enabled: boolean | null): Promise<DoorOverrides> {
    const current = await this.doorOverrides(agentId);
    if (enabled === null) delete current[door];
    else current[door] = enabled;
    if (Object.keys(current).length === 0) await this.ctx.storage.delete(`doors:${agentId}`);
    else await this.ctx.storage.put(`doors:${agentId}`, current);
    return current;
  }
}
