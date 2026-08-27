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

/**
 * Profile self-expression, with the disclosure self-maintaining: a bio
 * that drops the operator-configured disclosure marker is refused, so
 * the account-level attestation cannot be invalidated by the agent's own
 * edits. Field bounds are X's own.
 */
export const MAX_BIO_LENGTH = 160;
export const MAX_URL_LENGTH = 100;
export const MAX_LOCATION_LENGTH = 30;
export const DEFAULT_PROFILE_DAILY_CAP = 4;
export const HARD_PROFILE_DAILY_CEILING = 10;
/** Byte budgets X enforces for profile media. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_BANNER_BYTES = 5 * 1024 * 1024;

export function effectiveProfileDailyCap(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed < 1) return DEFAULT_PROFILE_DAILY_CAP;
  return Math.min(parsed, HARD_PROFILE_DAILY_CEILING);
}

export type ProfileProblem =
  | "empty"
  | "bio_too_long"
  | "bio_missing_disclosure"
  | "url_too_long"
  | "location_too_long";

export function profileProblem(
  fields: { bio?: unknown; url?: unknown; location?: unknown },
  disclosure: string
): ProfileProblem | null {
  const { bio, url, location } = fields;
  if (bio === undefined && url === undefined && location === undefined) return "empty";
  if (bio !== undefined) {
    if (typeof bio !== "string" || [...bio].length > MAX_BIO_LENGTH) return "bio_too_long";
    if (!bio.toLowerCase().includes(disclosure.toLowerCase())) return "bio_missing_disclosure";
  }
  if (url !== undefined && (typeof url !== "string" || url.length > MAX_URL_LENGTH)) {
    return "url_too_long";
  }
  if (
    location !== undefined &&
    (typeof location !== "string" || [...location].length > MAX_LOCATION_LENGTH)
  ) {
    return "location_too_long";
  }
  return null;
}

export type ImageProblem = "not_png_or_jpeg" | "too_large";

/** PNG or JPEG only, judged by magic bytes, within X's byte budget. */
export function imageProblem(bytes: Uint8Array, maxBytes: number): ImageProblem | null {
  const isPng =
    bytes.length > 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) return "not_png_or_jpeg";
  if (bytes.length > maxBytes) return "too_large";
  return null;
}

/**
 * Follows: public, low-stakes, but the classic automation-suspension
 * vector when aggressive, so the cap is deliberately small and shared
 * between follow and unfollow (churn spends the same budget).
 */
export const DEFAULT_FOLLOW_DAILY_CAP = 5;
export const HARD_FOLLOW_DAILY_CEILING = 20;

export function effectiveFollowDailyCap(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed < 1) return DEFAULT_FOLLOW_DAILY_CAP;
  return Math.min(parsed, HARD_FOLLOW_DAILY_CEILING);
}

/** "@Name_1" -> "name_1"; null when it is not a plausible X handle. */
export function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const handle = raw.replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

/**
 * The read door: X reads are data acquisition (the same trust category
 * as fetching a public web page, which the mind does freely), gated only
 * because the credential lives here and reads cost money. One
 * allowlisted passthrough instead of a door per shape; extending the
 * agent's reach is one line here.
 */
export const READ_ALLOWLIST: RegExp[] = [
  /^\/2\/tweets\/search\/recent$/,
  /^\/2\/tweets$/,
  /^\/2\/tweets\/\d+$/,
  /^\/2\/users\/me$/,
  /^\/2\/users\/by\/username\/[A-Za-z0-9_]{1,15}$/,
  /^\/2\/users\/\d+$/,
  /^\/2\/users\/(\d+|:self)\/tweets$/,
  /^\/2\/users\/(\d+|:self)\/mentions$/,
  /^\/2\/users\/(\d+|:self)\/followers$/,
  /^\/2\/users\/(\d+|:self)\/following$/,
  /^\/2\/users\/(\d+|:self)\/liked_tweets$/
];

export const DEFAULT_READ_DAILY_CAP = 200;
export const HARD_READ_DAILY_CEILING = 1000;

export function effectiveReadDailyCap(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed < 1) return DEFAULT_READ_DAILY_CAP;
  return Math.min(parsed, HARD_READ_DAILY_CEILING);
}

/** Normalized allowlisted path, or null. ":self" resolves to the account id later. */
export function validateReadPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  if (path.includes("?") || path.includes("#") || path.includes("..")) return null;
  return READ_ALLOWLIST.some(pattern => pattern.test(path)) ? path : null;
}

/** Query params, bounded: count, key shape, value length, max_results clamp. */
export function boundReadParams(raw: unknown): Record<string, string> | null {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 10) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[a-z_.]{1,40}$/.test(key) || typeof value !== "string" || value.length > 512) return null;
    out[key] = value;
  }
  if (out.max_results !== undefined) {
    const n = Number(out.max_results);
    if (!Number.isInteger(n) || n < 1) return null;
    out.max_results = String(Math.min(n, 100));
  }
  return out;
}
