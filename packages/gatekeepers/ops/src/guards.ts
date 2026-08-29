/**
 * Request-forgery guards for the gateway (spec 0005 §8), pure over the
 * request so they are unit-testable (no worker-kit import: that pulls
 * cloudflare:workers, which the node test runner cannot resolve).
 */

function errorResponse(status: number, code: string, detail?: string): Response {
  return new Response(JSON.stringify({ error: code, ...(detail ? { detail } : {}) }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * CSRF fence for COOKIE-authenticated mutations: the console sends a
 * custom header (which a cross-origin form cannot), and the browser's
 * own Sec-Fetch-Site/Origin must agree the call is same-origin.
 * Header-authenticated callers (service tokens, cloudflared) are exempt
 * by construction: no cookie, no CSRF.
 */
export function csrfDenied(request: Request, url: URL): Response | null {
  if (request.headers.get("cf-access-jwt-assertion")) return null;
  if (request.method !== "POST") return null;
  if (request.headers.get("x-operon-console") !== "1") {
    return errorResponse(
      403,
      "csrf_header_missing",
      "cookie-authenticated writes need x-operon-console: 1"
    );
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return errorResponse(403, "csrf_cross_site", site);
  }
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) {
        return errorResponse(403, "csrf_origin_mismatch");
      }
    } catch {
      return errorResponse(403, "csrf_origin_mismatch");
    }
  }
  return null;
}

/** Browser WebSocket upgrades carry the cookie; pin their Origin. */
export function wsOriginDenied(request: Request, url: URL): Response | null {
  if (request.headers.get("cf-access-jwt-assertion")) return null;
  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    if (new URL(origin).host === url.host) return null;
  } catch {
    // fall through to the denial
  }
  return errorResponse(403, "ws_origin_mismatch");
}

/**
 * The Access JWT for a WebSocket upgrade from a non-browser client. The
 * WHATWG WebSocket API cannot set custom headers, so the CLI offers the
 * token as a subprotocol entry (operon-access.<jwt>) beside the real
 * protocol (operon-ws), the standard workaround; never a query string.
 * Browsers need none of this: the same-origin upgrade carries the
 * Access cookie.
 */
export function wsProtocolToken(request: Request): string | null {
  const protocols = request.headers.get("sec-websocket-protocol") ?? "";
  for (const entry of protocols.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.startsWith("operon-access.")) {
      return trimmed.slice("operon-access.".length) || null;
    }
  }
  return null;
}
