/**
 * The relay is a POLICY POINT, not a transparent pipe (spec 0004
 * section 2, corrected). A raw CDP connection can export the very
 * credentials the door protects: cookies and passkeys leave through
 * `Network.getAllCookies`, `Storage.getCookies`, and `WebAuthn.*`,
 * bypassing every content sweep. Those methods are dropped at the
 * relay, on the client -> upstream direction, before they reach Browser
 * Run.
 *
 * This is layer one (clean, no false positives). Layer two, folding
 * restored cookie VALUES into the wake secret denylist so an extraction
 * via `Runtime.evaluate("document.cookie")` still cannot leave through
 * publish/PR/email, arrives with storage-state snapshots in the MVP.
 */

/** CDP methods that read or export credentials; refused at the relay. */
export const BLOCKED_METHODS = new Set<string>([
  "Network.getCookies",
  "Network.getAllCookies",
  "Storage.getCookies",
  "Storage.getStorageKeyForFrame"
]);

/** Whole domains the container may never drive; the DO owns them. */
export const BLOCKED_DOMAINS = new Set<string>([
  // The virtual authenticator and its credentials belong to the relay,
  // exactly as the Cloudflare API token does; the mind never touches it.
  "WebAuthn"
]);

export type CdpDecision =
  | { action: "forward" }
  | { action: "block"; response: string; method: string };

/**
 * Decide a single client -> upstream CDP frame. A blocked frame gets a
 * CDP error response synthesized for the CLIENT (so its request settles
 * instead of hanging) and is never forwarded.
 */
export function cdpDecision(frame: string): CdpDecision {
  // Only object frames with a method can be commands; anything else
  // (binary, malformed) is forwarded and let the upstream judge it.
  if (frame.length === 0 || frame[0] !== "{") return { action: "forward" };
  let message: { id?: unknown; method?: unknown; sessionId?: unknown };
  try {
    message = JSON.parse(frame);
  } catch {
    return { action: "forward" };
  }
  const method = typeof message.method === "string" ? message.method : "";
  if (!method) return { action: "forward" };
  const domain = method.slice(0, method.indexOf("."));
  if (BLOCKED_METHODS.has(method) || BLOCKED_DOMAINS.has(domain)) {
    const response = JSON.stringify({
      id: typeof message.id === "number" ? message.id : 0,
      error: { code: -32601, message: `blocked_by_operon: ${method}` },
      ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {})
    });
    return { action: "block", response, method };
  }
  return { action: "forward" };
}
