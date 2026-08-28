import { DurableObject } from "cloudflare:workers";

/**
 * One meter per AGENT (spec 0004 section 5). The concurrency cap is an
 * aggregate across every session the agent opens in a wake, named or
 * unnamed: N sessions must never mean N budgets. It also totals browser
 * minutes per wake for the operator's cost view, and remembers which
 * session names exist so the operator can list them.
 */

interface Held {
  at: string;
  /** Which relay holds this admission; a stale release must not free it. */
  token: string;
}

interface WakeUsage {
  wakeId: string;
  openedAt: Record<string, Held>;
  minutes: number;
}

export type Admission = { ok: true; token: string } | { ok: false; reason: string };

/**
 * How long a hold may sit without a release before another open may take
 * it over. Comfortably past Browser Run's 10-minute idle close, so it
 * only ever rescues a hold whose relay died without releasing.
 */
const STALE_HOLD_MS = 20 * 60_000;

export class WebMeter extends DurableObject {
  /** Admit a session open, or refuse it against the concurrency cap. */
  async admit(name: string, wakeId: string, maxConcurrent: number): Promise<Admission> {
    const usage = await this.currentUsage(wakeId);
    const open = Object.keys(usage.openedAt);
    const held = usage.openedAt[name];
    if (held) {
      // A name already held is LIVE: refuse the duplicate here rather
      // than issuing a second token. Overwriting the holder would let the
      // duplicate's release delete the live session's entry, erasing it
      // from the cap and losing its minutes. A hold left behind by a dead
      // relay ages out, so a legitimate reopen is never stuck.
      const age = Date.now() - Date.parse(held.at);
      if (!Number.isFinite(age) || age < STALE_HOLD_MS) {
        return { ok: false, reason: "web_session_busy" };
      }
    }
    if (!held && open.length >= maxConcurrent) {
      return { ok: false, reason: "web_concurrency_cap" };
    }
    // The token identifies THIS admission: a late release from a prior
    // holder of the same name must not free the current one, or a live
    // session would slip the cap and its minutes would go unaccrued.
    const token = crypto.randomUUID();
    usage.openedAt[name] = { at: new Date().toISOString(), token };
    await this.ctx.storage.put("usage", usage);

    const names = new Set((await this.ctx.storage.get<string[]>("names")) ?? []);
    names.add(name);
    await this.ctx.storage.put("names", [...names]);
    return { ok: true, token };
  }

  /** Mark a session closed and accrue its minutes into the wake total. */
  async release(name: string, wakeId: string, token: string): Promise<void> {
    const usage = await this.currentUsage(wakeId);
    const held = usage.openedAt[name];
    // Only the holder may release: a stale release is a no-op.
    if (!held || held.token !== token) return;
    const elapsed = Date.now() - Date.parse(held.at);
    if (Number.isFinite(elapsed) && elapsed > 0) usage.minutes += elapsed / 60_000;
    delete usage.openedAt[name];
    await this.ctx.storage.put("usage", usage);
  }

  /** Every session name this agent has (for the operator's list). */
  async sessions(): Promise<string[]> {
    return ((await this.ctx.storage.get<string[]>("names")) ?? []).sort();
  }

  /** Drop a deleted session from the listing. */
  async forget(name: string): Promise<void> {
    const names = ((await this.ctx.storage.get<string[]>("names")) ?? []).filter(item => item !== name);
    await this.ctx.storage.put("names", names);
    const usage = await this.ctx.storage.get<WakeUsage>("usage");
    if (usage?.openedAt[name]) {
      delete usage.openedAt[name];
      await this.ctx.storage.put("usage", usage);
    }
  }

  /** This wake's open sessions and accrued minutes. */
  async usage(): Promise<{ wakeId: string; open: string[]; minutes: number }> {
    const usage = (await this.ctx.storage.get<WakeUsage>("usage")) ?? {
      wakeId: "none",
      openedAt: {},
      minutes: 0
    };
    return {
      wakeId: usage.wakeId,
      open: Object.keys(usage.openedAt),
      minutes: Math.round(usage.minutes * 10) / 10
    };
  }

  /** Usage rolls over per wake: a new wake starts with a clean budget. */
  private async currentUsage(wakeId: string): Promise<WakeUsage> {
    const usage = await this.ctx.storage.get<WakeUsage>("usage");
    if (usage && usage.wakeId === wakeId) return usage;
    return { wakeId, openedAt: {}, minutes: 0 };
  }
}
