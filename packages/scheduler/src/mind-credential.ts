/**
 * The mind credential's refresh, done by the scheduler (spec 0010 §5),
 * pure half: how a credential is fingerprinted, when a Codex or Grok
 * login is due for a refresh, what each refresh call looks like, and
 * which value a launch should use. Runtime-free apart from the fetch it
 * is handed.
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

/** A JWT's exp claim as epoch ms, or undefined for an opaque or unreadable token. */
export function jwtExpiry(token: string | undefined): number | undefined {
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

/** The access token's expiry from its JWT payload, epoch ms, or undefined when unreadable. */
export function accessTokenExpiry(login: CodexLoginFile): number | undefined {
  return jwtExpiry(login.tokens.access_token);
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
 * A Grok login file (`grok login`'s auth.json): issuer-keyed entries,
 * the signed-in account being the one with an access token under `key`
 * (a six-hour `at+jwt`), its refresh token, and the authority that
 * issued them (`oidc_issuer`, `oidc_client_id`). Unknown fields ride
 * along untouched.
 */
export interface GrokLoginEntry {
  key?: string;
  refresh_token?: string;
  expires_at?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  [field: string]: unknown;
}

export interface GrokLogin {
  file: Record<string, unknown>;
  /** The entry's key in the file (the issuer-keyed name Grok gave it). */
  entryKey: string;
  entry: GrokLoginEntry;
}

/** A Grok login file, or undefined for any other credential (an API key, a Codex file). */
export function parseGrokLogin(credential: string): GrokLogin | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const file = parsed as Record<string, unknown>;
  for (const [entryKey, value] of Object.entries(file)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as GrokLoginEntry;
    if (typeof entry.key === "string" && entry.key.length > 0) return { file, entryKey, entry };
  }
  return undefined;
}

/**
 * Grok's access token lives six hours. The launch refreshes it whenever
 * less than the wake's hard wall plus this slack remains, so the token
 * outlives the wake and Grok never spends the refresh token inside the
 * container (the authority rotates it on every grant: a token spent in
 * the container is a stored chain broken). A hard wall of five hours or
 * more exceeds what a fresh token covers; such a wake may still refresh
 * in the container near its end, which the spec names as unsupported.
 */
export const GROK_REFRESH_SLACK_MS = 60 * 60 * 1000;

export function grokRefreshMarginMs(hardWallMs: number): number {
  return hardWallMs + GROK_REFRESH_SLACK_MS;
}

/** The Grok access token's expiry: its JWT exp, else the entry's expires_at, epoch ms. */
export function grokAccessTokenExpiry(login: GrokLogin): number | undefined {
  const fromToken = jwtExpiry(login.entry.key);
  if (fromToken !== undefined) return fromToken;
  const fromEntry = login.entry.expires_at ? Date.parse(login.entry.expires_at) : NaN;
  return Number.isFinite(fromEntry) ? fromEntry : undefined;
}

/** An entry can only be refreshed when it names its authority and holds a refresh token. */
function grokRefreshable(entry: GrokLoginEntry): boolean {
  return (
    typeof entry.refresh_token === "string" &&
    entry.refresh_token.length > 0 &&
    typeof entry.oidc_issuer === "string" &&
    /^https:\/\//.test(entry.oidc_issuer) &&
    typeof entry.oidc_client_id === "string" &&
    entry.oidc_client_id.length > 0
  );
}

export function grokLoginNeedsRefresh(login: GrokLogin, nowMs: number, hardWallMs: number): boolean {
  if (!grokRefreshable(login.entry)) return false;
  const expiry = grokAccessTokenExpiry(login);
  if (expiry === undefined) return true;
  return expiry - nowMs < grokRefreshMarginMs(hardWallMs);
}

/**
 * The issuer's token endpoint. Its discovery document
 * (`<issuer>/.well-known/openid-configuration`) names this path and
 * lists the refresh_token grant with the `none` client auth method, so
 * the public client id in the login file is all the grant needs.
 */
export function grokTokenEndpoint(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/oauth2/token`;
}

/** What a fresh Grok access token is good for when the authority does not say. */
const GROK_ACCESS_TOKEN_LIFETIME_MS = 6 * 60 * 60 * 1000;

/**
 * Refresh a Grok login against its own authority and return the new
 * file: the same entry with the new access token under `key`, the
 * rotated refresh token when one is returned, and `expires_at` moved.
 * The authority's error code is surfaced by name, as for Codex.
 */
export async function refreshGrokLogin(
  login: GrokLogin,
  fetchImpl: typeof fetch,
  nowMs = Date.now()
): Promise<string> {
  const { entry } = login;
  if (!grokRefreshable(entry)) {
    throw new RefreshError("refresh_token_missing", "the login names no authority or holds no refresh token");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: entry.oidc_client_id as string,
    refresh_token: entry.refresh_token as string
  });
  let response: Response;
  try {
    response = await fetchImpl(grokTokenEndpoint(entry.oidc_issuer as string), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString()
    });
  } catch (error) {
    throw new RefreshError("refresh_unreachable", String(error).slice(0, 200));
  }
  const answer = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
  };
  if (!response.ok) {
    const code = typeof answer.error === "string" ? answer.error : `http_${response.status}`;
    throw new RefreshError(`refresh_failed:${code}`, String(answer.error_description ?? "").slice(0, 200));
  }
  if (typeof answer.access_token !== "string" || answer.access_token.length === 0) {
    throw new RefreshError("refresh_malformed", "the authority answered without an access token");
  }
  const lifetimeMs =
    typeof answer.expires_in === "number" && answer.expires_in > 0
      ? answer.expires_in * 1000
      : (jwtExpiry(answer.access_token) ?? nowMs + GROK_ACCESS_TOKEN_LIFETIME_MS) - nowMs;
  const refreshedEntry: GrokLoginEntry = {
    ...entry,
    key: answer.access_token,
    ...(typeof answer.refresh_token === "string" && answer.refresh_token.length > 0
      ? { refresh_token: answer.refresh_token }
      : {}),
    expires_at: new Date(nowMs + lifetimeMs).toISOString()
  };
  return JSON.stringify({ ...login.file, [login.entryKey]: refreshedEntry });
}

/** Whether a credential is a login the scheduler refreshes, and where it stands now. */
export interface RefreshPlan {
  /** A refresh is due before this launch. */
  due: boolean;
  /** When the current access token expires (epoch ms), to decide whether a refused refresh still lets the wake run. */
  expiry: number | undefined;
}

/**
 * The refresh plan for a harness's credential; undefined when it is not
 * a refreshable login. The wake's hard wall only matters to Grok, whose
 * access token is short.
 */
export function refreshPlan(
  harness: string,
  credential: string,
  nowMs: number,
  hardWallMs: number
): RefreshPlan | undefined {
  if (harness === "codex") {
    const login = parseCodexLogin(credential);
    if (!login) return undefined;
    return { due: loginNeedsRefresh(login, nowMs), expiry: accessTokenExpiry(login) };
  }
  if (harness === "grok") {
    const login = parseGrokLogin(credential);
    if (!login) return undefined;
    return { due: grokLoginNeedsRefresh(login, nowMs, hardWallMs), expiry: grokAccessTokenExpiry(login) };
  }
  return undefined;
}

/** Refresh a harness's login against its authority; the harness picks the grant. */
export async function refreshLogin(
  harness: string,
  credential: string,
  fetchImpl: typeof fetch,
  nowMs = Date.now()
): Promise<string> {
  if (harness === "codex") {
    const login = parseCodexLogin(credential);
    if (!login) throw new RefreshError("not_a_login", "the codex credential is not a login file");
    return refreshCodexLogin(login, fetchImpl, nowMs);
  }
  if (harness === "grok") {
    const login = parseGrokLogin(credential);
    if (!login) throw new RefreshError("not_a_login", "the grok credential is not a login file");
    return refreshGrokLogin(login, fetchImpl, nowMs);
  }
  throw new RefreshError("harness_not_refreshable", `no refresh grant is known for harness "${harness}"`);
}

/** The operator's command to authorize a harness again, for the refusal's message. */
export function authorizeHint(harness: string): string {
  if (harness === "codex") return "npm run authorize:codex";
  if (harness === "grok") return "node operon/tools/grok-authorize.mjs";
  return `set MIND_CREDENTIAL_${harness.toUpperCase().replace(/-/g, "_")} again`;
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

/** What a launch starts its wake on, or why it cannot. */
export type SettledCredential =
  | { ok: true; value: string; notes: string[] }
  | { ok: false; code: "mind_credential_refresh_failed"; detail: string };

export interface SettleDeps {
  /** The stored refresh for the harness, with the seed fingerprint it descends from. */
  getStored(harness: string): Promise<{ seed: string; value: string } | undefined>;
  /** Keep a refreshed credential under the seed it descends from. */
  store(harness: string, seed: string, value: string): Promise<void>;
  /** Refresh a login against its authority (refreshLogin bound to a fetch). Throws RefreshError. */
  refresh(harness: string, login: string): Promise<string>;
}

/**
 * The whole credential decision for one launch, in order: choose the
 * stored refresh while it descends from the current secret, refresh it
 * when due, store what came back, and wake on it. A refusal by the
 * authority while the access token is still valid lets the wake run on
 * what it has, noted; once the access token is gone too the launch is
 * refused by name and the operator authorizes again. The caller holds
 * the per-harness lock (FleetControl does): two launches that overlap
 * must not each spend the one refresh token.
 */
export async function settleCredential(
  harness: string,
  seed: string,
  seedFingerprint: string,
  hardWallMs: number,
  deps: SettleDeps,
  nowMs = Date.now()
): Promise<SettledCredential> {
  const chosen = chooseCredential(seed, seedFingerprint, await deps.getStored(harness));
  const notes: string[] = [];
  if (chosen.refreshed) notes.push(`mind credential (${harness}): starting from the scheduler's stored refresh`);
  const plan = refreshPlan(harness, chosen.value, nowMs, hardWallMs);
  if (!plan || !plan.due) return { ok: true, value: chosen.value, notes };
  try {
    const refreshed = await deps.refresh(harness, chosen.value);
    await deps.store(harness, seedFingerprint, refreshed);
    notes.push(`mind credential (${harness}): login refreshed by the scheduler and stored for later launches`);
    return { ok: true, value: refreshed, notes };
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
    if (plan.expiry !== undefined && plan.expiry > nowMs) {
      notes.push(`mind credential (${harness}): refresh failed (${detail}); the access token is still valid, waking on it`);
      return { ok: true, value: chosen.value, notes };
    }
    return {
      ok: false,
      code: "mind_credential_refresh_failed",
      detail: `${detail}; the access token has expired too: authorize the ${harness} account again (${authorizeHint(harness)})`
    };
  }
}

/**
 * One run per key at a time, in arrival order: a call that arrives while
 * another is running for the same key waits for it to finish (however it
 * ends) and then runs its own, so it reads the store the earlier run just
 * wrote and makes its own decision for its own seed and wake length.
 * FleetControl holds the map for settleCredential: overlapping launches
 * on a harness never each spend the refresh token, because the second
 * finds the first's refreshed login stored and not due.
 */
export function serialized<T>(tails: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const own = previous.then(run, run);
  const tail = own.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return own;
}
