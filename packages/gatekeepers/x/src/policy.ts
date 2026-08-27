/**
 * The X policy, as code (spec 0001 5.3 doctrine: policy lives in the
 * chassis, which agents cannot write to). Everything here is a pure,
 * unit-tested refusal; the Durable Object provides atomicity, the Worker
 * provides the credential and the attestation gate.
 *
 * The policy the first tenant asked to be held to, made mechanical:
 * - labeled automation: posting is refused entirely until the operator
 *   attests the ACCOUNT carries X's automated-account label and an AI
 *   disclosure in its bio (account-level facts only the operator can
 *   establish; the Worker fails closed without the attestation).
 * - low volume, value first: a daily cap under a hard server ceiling,
 *   minimum spacing between posts, and duplicate refusal.
 * - no spam shapes: mention and hashtag caps per post.
 */

/** "promoter" -> "X_TOKEN_PROMOTER" (posting bearers are per-agent). */
export function xTokenVar(agentId: string): string {
  return `X_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

/** Per-agent OAuth1 user credentials (the agent's OWN account). */
export function xAccessTokenVar(agentId: string): string {
  return `X_ACCESS_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}
export function xAccessSecretVar(agentId: string): string {
  return `X_ACCESS_SECRET_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

export const DEFAULT_DAILY_CAP = 4;
/** The operator's X_DAILY_CAP can lower or raise the default, never past this. */
export const HARD_DAILY_CEILING = 10;
export const MIN_SPACING_MS = 20 * 60 * 1000;
export const MAX_LENGTH = 280;
export const MAX_MENTIONS = 3;
export const MAX_HASHTAGS = 3;
/** Recent posts remembered for duplicate refusal. */
export const DUP_MEMORY = 50;

export function effectiveDailyCap(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed < 1) return DEFAULT_DAILY_CAP;
  return Math.min(parsed, HARD_DAILY_CEILING);
}

export type ContentProblem =
  | "empty"
  | "too_long"
  | "too_many_mentions"
  | "too_many_hashtags";

/**
 * Pre-flight content rules. Plain character count is used for length:
 * X counts URLs as 23 and some scripts as 2, so a 280-char bound here is
 * conservative for URLs and the DO's refusal reason names the rule.
 */
export function contentProblem(text: unknown): ContentProblem | null {
  if (typeof text !== "string" || text.trim().length === 0) return "empty";
  if ([...text].length > MAX_LENGTH) return "too_long";
  if ((text.match(/(^|\s)@\w{1,15}/g) ?? []).length > MAX_MENTIONS) return "too_many_mentions";
  if ((text.match(/(^|\s)#\w+/g) ?? []).length > MAX_HASHTAGS) return "too_many_hashtags";
  return null;
}

/** Normalized form used for duplicate detection. */
export function dupKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface PostCheck {
  postedToday: number;
  dailyCap: number;
  /** Epoch ms of the most recent post, or null. */
  lastPostAt: number | null;
  now: number;
  /** dupKey()s of recent posts. */
  recentKeys: string[];
  key: string;
}

export type PostProblem = "over_daily_cap" | "too_soon" | "duplicate";

export function decidePost(check: PostCheck): PostProblem | null {
  if (check.postedToday >= check.dailyCap) return "over_daily_cap";
  if (check.lastPostAt !== null && check.now - check.lastPostAt < MIN_SPACING_MS) {
    return "too_soon";
  }
  if (check.recentKeys.includes(check.key)) return "duplicate";
  return null;
}

/** DMs are reply-only (enforced by correspondent memory in the DO) with
 * their own, laxer volume rule: conversations need back-and-forth, so
 * there is no spacing requirement, only a daily cap. */
export const DEFAULT_DM_DAILY_CAP = 20;
export const HARD_DM_DAILY_CEILING = 50;
/** X's DM length limit is 10k; bounded a little under it. */
export const MAX_DM_LENGTH = 9500;

export function effectiveDmDailyCap(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed < 1) return DEFAULT_DM_DAILY_CAP;
  return Math.min(parsed, HARD_DM_DAILY_CEILING);
}

export type DmContentProblem = "empty" | "too_long";

export function dmContentProblem(text: unknown): DmContentProblem | null {
  if (typeof text !== "string" || text.trim().length === 0) return "empty";
  if ([...text].length > MAX_DM_LENGTH) return "too_long";
  return null;
}
