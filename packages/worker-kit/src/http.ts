/**
 * Small HTTP helpers shared by the scheduler and the Gatekeepers. Every
 * rejection is a distinct, named error: an invisible failure at a paid or
 * operational surface is the most expensive bug class this system can have.
 */

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export function errorResponse(status: number, code: string, detail?: string): Response {
  return json({ error: code, ...(detail ? { detail } : {}) }, status);
}

/**
 * Constant-time-ish bearer check. Returns null when authorized, otherwise a
 * ready-to-return error Response naming what failed. A missing server-side
 * token fails closed: an unset secret must never mean "open".
 */
export function requireBearer(request: Request, expected: string | undefined): Response | null {
  if (!expected) {
    return errorResponse(500, "auth_not_configured", "server has no token configured");
  }
  const header = request.headers.get("authorization");
  if (!header) return errorResponse(401, "missing_bearer");
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return errorResponse(401, "malformed_authorization_header");
  if (!timingSafeEqualString(match[1], expected)) {
    return errorResponse(401, "invalid_token");
  }
  return null;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufferA = encoder.encode(a);
  const bufferB = encoder.encode(b);
  if (bufferA.byteLength !== bufferB.byteLength) return false;
  let mismatch = 0;
  for (let i = 0; i < bufferA.byteLength; i++) {
    mismatch |= bufferA[i] ^ bufferB[i];
  }
  return mismatch === 0;
}
