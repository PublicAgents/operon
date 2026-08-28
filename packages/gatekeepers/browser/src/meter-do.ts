import { DurableObject } from "cloudflare:workers";

/**
 * One meter per AGENT (spec 0004 section 5). The concurrency cap is an
 * aggregate across every session the agent opens in a wake, named or
 * unnamed: N sessions must never mean N budgets. It also totals browser
 * minutes per wake for the operator's cost view, and remembers which
 * session names exist so the operator can list them.
 */

interface WakeUsage {
  wakeId: string;
  openedAt: Record<string, string>;
  minutes: number;
}

export type Admission = { ok: true } | { ok: false; reason: string };

export class WebMeter extends DurableObject {
  /** Admit a session open, or refuse it against the concurrency cap. */
  async admit(name: string, wakeId: string, maxConcurrent: number): Promise<Admission> {
    const usage = await this.currentUsage(wakeId);
    const open = Object.keys(usage.openedAt);
    if (!open.includes(name) && open.length >= maxConcurrent) {
      return { ok: false, reason: "web_concurrency_cap" };
    }
    usage.openedAt[name] = new Date().toISOString();
    await this.ctx.storage.put("usage", usage);

    const names = new Set((await this.ctx.storage.get<string[]>("names")) ?? []);
    names.add(name);
    await this.ctx.storage.put("names", [...names]);
    return { ok: true };
  }

  /** Mark a session closed and accrue its minutes into the wake total. */
  async release(name: string, wakeId: string): Promise<void> {
    const usage = await this.currentUsage(wakeId);
    const openedAt = usage.openedAt[name];
    if (openedAt) {
      const elapsed = Date.now() - Date.parse(openedAt);
      if (Number.isFinite(elapsed) && elapsed > 0) usage.minutes += elapsed / 60_000;
      delete usage.openedAt[name];
      await this.ctx.storage.put("usage", usage);
    }
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
