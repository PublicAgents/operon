/**
 * The refresh relay's pure half (spec 0010 §5): how a mind credential is
 * fingerprinted, what a relayed credential must satisfy to replace the
 * seed, and which value a launch should use. Runtime-free.
 */

/** SHA-256 hex of a secret: a tag that names the secret without holding it. */
export async function credentialFingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The account a file credential belongs to, when it is one. A Codex
 * login carries tokens.account_id; an API key or anything else has no
 * account, and a relay of such a credential is refused (nothing in it
 * rotates, so nothing legitimate would relay it).
 */
export function credentialAccount(credential: string): string | undefined {
  try {
    const parsed = JSON.parse(credential) as { tokens?: { account_id?: unknown } };
    const account = parsed?.tokens?.account_id;
    return typeof account === "string" && account.length > 0 ? account : undefined;
  } catch {
    return undefined;
  }
}

export type RelayVerdict = { ok: true; value: string } | { ok: false; error: string };

/**
 * Whether a credential the container relayed may replace the seed for
 * later launches. The mind owns the file the harness refreshes, so the
 * relay is trusted exactly as far as the seed reaches: same account,
 * a real file credential, and bounded in size (a Cloudflare secret's
 * own ceiling, so a value that could not have been seeded cannot be
 * relayed either).
 */
export function judgeRelay(seedAccount: string | undefined, relayed: unknown): RelayVerdict {
  if (typeof relayed !== "string" || relayed.length === 0) {
    return { ok: false, error: "relay_not_a_credential" };
  }
  if (relayed.length > 5 * 1024) return { ok: false, error: "relay_too_large" };
  if (!seedAccount) return { ok: false, error: "relay_seed_has_no_account" };
  const account = credentialAccount(relayed);
  if (!account) return { ok: false, error: "relay_has_no_account" };
  if (account !== seedAccount) return { ok: false, error: "relay_account_mismatch" };
  return { ok: true, value: relayed };
}

/**
 * The credential a launch runs with: the relayed one when it descends
 * from the CURRENT secret, otherwise the secret itself. An operator's
 * re-seed is a new fingerprint, so a stored refresh of the old secret
 * is simply never chosen again.
 */
export function chooseCredential(
  seed: string,
  seedFingerprint: string,
  stored: { seed: string; value: string } | undefined
): { value: string; relayed: boolean } {
  if (stored && stored.seed === seedFingerprint) return { value: stored.value, relayed: true };
  return { value: seed, relayed: false };
}
