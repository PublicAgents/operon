/**
 * The mind credential's refresh, done by the scheduler (spec 0010 §5),
 * pure half: how a credential is fingerprinted, when a Codex login is
 * due for a refresh, what the refresh call looks like, and which value a
 * launch should use. Runtime-free apart from the fetch it is handed.
 *
 * Why here and not in the container: a login the harness refreshes in
 * place inside a wake would have to come back OUT of the container to
 * survive, and a file the mind owns is a file the mind can write. The
 * scheduler refreshing it first, on the day before Codex would, keeps
 * the credential flowing in one direction only.
 */

/** SHA-256 hex of a secret: a tag that names the secret without holding it. */
export async function credentialFingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface CodexLoginFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/** A Codex login file (a `tokens` table), or undefined for any other credential (an API key, a setup-token). */
export function parseCodexLogin(credential: string): CodexLoginFile | undefined {
  try {
    const parsed = JSON.parse(credential) as CodexLoginFile;
    return typeof parsed?.tokens === "object" && parsed.tokens !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex refreshes a login on its own when last_refresh is eight days
 * old. The scheduler refreshes a day earlier, so a wake never finds
 * its login due and never spends the single-use refresh token inside
 * the container.
 */
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function loginNeedsRefresh(login: CodexLoginFile, nowMs: number): boolean {
  if (!login.tokens.refresh_token) return false;
  const last = login.last_refresh ? Date.parse(login.last_refresh) : NaN;
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= REFRESH_AFTER_MS;
}

/** The access token's expiry from its JWT payload, epoch ms, or undefined when unreadable. */
export function accessTokenExpiry(login: CodexLoginFile): number | undefined {
  const token = login.tokens.access_token;
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Codex CLI's own public OAuth client and token endpoint; a refresh needs no secret. */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

export class RefreshError extends Error {
  override name = "RefreshError";
  constructor(
    readonly code: string,
    detail: string
  ) {
    super(`${code}: ${detail}`);
  }
}

/**
 * Refresh a login against the authority and return the new file: the
 * same shape Codex writes, with the rotated tokens and a fresh
 * last_refresh. The authority's error code (expired, reused, revoked)
 * is surfaced by name; it is the operator's cue to authorize again.
 */
export async function refreshCodexLogin(
  login: CodexLoginFile,
  fetchImpl: typeof fetch,
  nowMs = Date.now()
): Promise<string> {
  if (!login.tokens.refresh_token) throw new RefreshError("refresh_token_missing", "the login has no refresh token");
  let response: Response;
  try {
    response = await fetchImpl(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: login.tokens.refresh_token
      })
    });
  } catch (error) {
    throw new RefreshError("refresh_unreachable", String(error).slice(0, 200));
  }
  const body = (await response.json().catch(() => ({}))) as {
    id_token?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
    error?: unknown;
    error_description?: unknown;
  };
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    throw new RefreshError(`refresh_failed:${code}`, String(body.error_description ?? "").slice(0, 200));
  }
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new RefreshError("refresh_malformed", "the authority answered without an access token");
  }
  const refreshed: CodexLoginFile = {
    ...login,
    tokens: {
      ...login.tokens,
      access_token: body.access_token,
      ...(typeof body.id_token === "string" ? { id_token: body.id_token } : {}),
      ...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {})
    },
    last_refresh: new Date(nowMs).toISOString()
  };
  return JSON.stringify(refreshed);
}

/**
 * The credential a launch starts from: the stored refresh when it
 * descends from the CURRENT secret, otherwise the secret itself. An
 * operator's re-authorize is a new fingerprint, so a stored refresh of
 * the old secret is simply never chosen again.
 */
export function chooseCredential(
  seed: string,
  seedFingerprint: string,
  stored: { seed: string; value: string } | undefined
): { value: string; refreshed: boolean } {
  if (stored && stored.seed === seedFingerprint) return { value: stored.value, refreshed: true };
  return { value: seed, refreshed: false };
}
