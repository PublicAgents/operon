import { DurableObject } from "cloudflare:workers";
import { decidePost, dupKey, DUP_MEMORY, type PostProblem } from "./policy.js";

/**
 * One PosterBox Durable Object per agent: the daily counter, spacing,
 * duplicate memory, and the record of posts made. Serialized by the DO,
 * so two overlapping posts near the cap cannot both pass and the slot is
 * reserved BEFORE the network call; a failed delivery releases it.
 */

export interface PostRecord {
  id: string;
  at: string;
  text: string;
}

interface DayWindow {
  day: string;
  count: number;
}

export class PosterBox extends DurableObject {
  /** Atomically apply the policy and reserve the slot. */
  async reservePost(
    text: string,
    nowIso: string,
    dailyCap: number
  ): Promise<{ ok: true } | { ok: false; problem: PostProblem }> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("window");
    const postedToday = window && window.day === day ? window.count : 0;
    const lastPostAt = (await this.ctx.storage.get<number>("lastPostAt")) ?? null;
    const recentKeys = (await this.ctx.storage.get<string[]>("recentKeys")) ?? [];

    const problem = decidePost({
      postedToday,
      dailyCap,
      lastPostAt,
      now: Date.parse(nowIso),
      recentKeys,
      key: dupKey(text)
    });
    if (problem) return { ok: false, problem };

    await this.ctx.storage.put("window", { day, count: postedToday + 1 });
    // The previous spacing clock is kept until the delivery is known
    // good: a failed delivery must restore it, or the retry would be
    // blocked 20 minutes for a post that never happened.
    await this.ctx.storage.put("prevLastPostAt", lastPostAt);
    await this.ctx.storage.put("lastPostAt", Date.parse(nowIso));
    return { ok: true };
  }

  /** Return a reserved-but-undelivered slot (delivery failed): cap AND spacing. */
  async release(nowIso: string): Promise<void> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("window");
    if (window && window.day === day && window.count > 0) {
      await this.ctx.storage.put("window", { day, count: window.count - 1 });
    }
    const previous = await this.ctx.storage.get<number | null>("prevLastPostAt");
    if (previous === null || previous === undefined) {
      await this.ctx.storage.delete("lastPostAt");
    } else {
      await this.ctx.storage.put("lastPostAt", previous);
    }
  }

  /** Record a delivered post: duplicate memory + the agent-readable list. */
  async recordPost(id: string, text: string, nowIso: string): Promise<void> {
    const recentKeys = (await this.ctx.storage.get<string[]>("recentKeys")) ?? [];
    recentKeys.push(dupKey(text));
    await this.ctx.storage.put("recentKeys", recentKeys.slice(-DUP_MEMORY));
    await this.ctx.storage.put(`post:${nowIso}:${id}`, { id, at: nowIso, text } satisfies PostRecord);
  }

  /** The agent's own recent posts, newest first (cross-wake memory). */
  async posts(limit = 20): Promise<PostRecord[]> {
    const entries = await this.ctx.storage.list<PostRecord>({
      prefix: "post:",
      reverse: true,
      limit
    });
    return [...entries.values()];
  }
}
