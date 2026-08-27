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
  /**
   * Atomically apply the policy and reserve the slot. The returned
   * prevLastPostAt is the reservation's OWN rollback value: release()
   * takes it back and restores it only if this reservation is still the
   * latest (compare-and-swap on the spacing clock), so overlapping
   * attempts cannot corrupt each other's rollback state.
   */
  async reservePost(
    text: string,
    nowIso: string,
    dailyCap: number
  ): Promise<{ ok: true; prevLastPostAt: number | null } | { ok: false; problem: PostProblem }> {
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
    await this.ctx.storage.put("lastPostAt", Date.parse(nowIso));
    return { ok: true, prevLastPostAt: lastPostAt };
  }

  /**
   * Return a reserved-but-undelivered slot (delivery failed): the cap
   * slot always, the spacing clock only if this reservation is still
   * the latest one (a later reservation owns the clock now).
   */
  async release(nowIso: string, prevLastPostAt: number | null): Promise<void> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("window");
    if (window && window.day === day && window.count > 0) {
      await this.ctx.storage.put("window", { day, count: window.count - 1 });
    }
    const current = await this.ctx.storage.get<number>("lastPostAt");
    if (current !== Date.parse(nowIso)) return; // a later reservation owns the clock
    if (prevLastPostAt === null) {
      await this.ctx.storage.delete("lastPostAt");
    } else {
      await this.ctx.storage.put("lastPostAt", prevLastPostAt);
    }
  }

  /** Record a delivered post: duplicate memory + the agent-readable list. */
  async recordPost(id: string, text: string, nowIso: string): Promise<void> {
    const recentKeys = (await this.ctx.storage.get<string[]>("recentKeys")) ?? [];
    recentKeys.push(dupKey(text));
    await this.ctx.storage.put("recentKeys", recentKeys.slice(-DUP_MEMORY));
    await this.ctx.storage.put(`post:${nowIso}:${id}`, { id, at: nowIso, text } satisfies PostRecord);
  }

  // ---- DMs: reply-only correspondence -------------------------------

  /**
   * Record an inbound DM sender as a correspondent: from that moment the
   * agent may reply. This map is the ENTIRE cold-DM refusal: a handle
   * that never messaged first simply does not resolve.
   */
  async recordDmCorrespondent(userId: string, username: string, at: string): Promise<void> {
    const correspondents =
      (await this.ctx.storage.get<Record<string, { username: string; lastAt: string }>>(
        "dmCorrespondents"
      )) ?? {};
    correspondents[userId] = { username: username.toLowerCase(), lastAt: at };
    await this.ctx.storage.put("dmCorrespondents", correspondents);
  }

  /** Resolve "@handle" or a numeric id AGAINST the correspondent map only. */
  async resolveCorrespondent(to: string): Promise<{ userId: string; username: string } | null> {
    const correspondents =
      (await this.ctx.storage.get<Record<string, { username: string; lastAt: string }>>(
        "dmCorrespondents"
      )) ?? {};
    const wanted = to.replace(/^@/, "").toLowerCase();
    if (/^\d+$/.test(wanted) && correspondents[wanted]) {
      return { userId: wanted, username: correspondents[wanted].username };
    }
    for (const [userId, entry] of Object.entries(correspondents)) {
      if (entry.username === wanted) return { userId, username: entry.username };
    }
    return null;
  }

  /** Atomic daily-cap reservation for a DM (no spacing: replies converse). */
  async reserveDm(nowIso: string, dailyCap: number): Promise<{ ok: boolean }> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("dmWindow");
    const sentToday = window && window.day === day ? window.count : 0;
    if (sentToday >= dailyCap) return { ok: false };
    await this.ctx.storage.put("dmWindow", { day, count: sentToday + 1 });
    return { ok: true };
  }

  async releaseDm(nowIso: string): Promise<void> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("dmWindow");
    if (window && window.day === day && window.count > 0) {
      await this.ctx.storage.put("dmWindow", { day, count: window.count - 1 });
    }
  }

  /** Delivery cursor for inbound DM events (acked after the wake persists). */
  async dmCursor(): Promise<string> {
    return (await this.ctx.storage.get<string>("dmCursor")) ?? "0";
  }

  async ackDms(upTo: string): Promise<void> {
    const current = BigInt((await this.ctx.storage.get<string>("dmCursor")) ?? "0");
    if (BigInt(upTo) > current) await this.ctx.storage.put("dmCursor", upTo);
  }

  /** Mirror cursor: which inbound events already reached the chronicle. */
  async dmMirrorCursor(): Promise<string> {
    return (await this.ctx.storage.get<string>("dmMirrorCursor")) ?? "0";
  }

  async setDmMirrorCursor(upTo: string): Promise<void> {
    const current = BigInt((await this.ctx.storage.get<string>("dmMirrorCursor")) ?? "0");
    if (BigInt(upTo) > current) await this.ctx.storage.put("dmMirrorCursor", upTo);
  }

  /** The account's own user id, cached after the first /users/me call. */
  async selfId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("selfId")) ?? null;
  }

  async setSelfId(id: string): Promise<void> {
    await this.ctx.storage.put("selfId", id);
  }

  /** Atomic daily cap over ALL profile changes (bio, avatar, banner). */
  async reserveProfileUpdate(nowIso: string, dailyCap: number): Promise<{ ok: boolean }> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("profileWindow");
    const today = window && window.day === day ? window.count : 0;
    if (today >= dailyCap) return { ok: false };
    await this.ctx.storage.put("profileWindow", { day, count: today + 1 });
    return { ok: true };
  }

  async releaseProfileUpdate(nowIso: string): Promise<void> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("profileWindow");
    if (window && window.day === day && window.count > 0) {
      await this.ctx.storage.put("profileWindow", { day, count: window.count - 1 });
    }
  }

  /** Atomic daily cap shared by follow AND unfollow (churn is spend). */
  async reserveFollow(nowIso: string, dailyCap: number): Promise<{ ok: boolean }> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("followWindow");
    const today = window && window.day === day ? window.count : 0;
    if (today >= dailyCap) return { ok: false };
    await this.ctx.storage.put("followWindow", { day, count: today + 1 });
    return { ok: true };
  }

  async releaseFollow(nowIso: string): Promise<void> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("followWindow");
    if (window && window.day === day && window.count > 0) {
      await this.ctx.storage.put("followWindow", { day, count: window.count - 1 });
    }
  }

  /** Atomic daily read budget (reads bill per use; no rollback needed). */
  async reserveRead(nowIso: string, dailyCap: number): Promise<{ ok: boolean }> {
    const day = nowIso.slice(0, 10);
    const window = await this.ctx.storage.get<DayWindow>("readWindow");
    const today = window && window.day === day ? window.count : 0;
    if (today >= dailyCap) return { ok: false };
    await this.ctx.storage.put("readWindow", { day, count: today + 1 });
    return { ok: true };
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
