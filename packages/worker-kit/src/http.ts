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

/**
 * Parse a request body as a JSON OBJECT without throwing. A malformed body
 * must not reject before a handler's ledger/failure path runs, and a valid
 * non-object body (null, a number, an array) must not either: every caller
 * destructures fields, so anything that is not a plain object is reported
 * as not-ok rather than handed over to crash on access.
 */
export async function readJson<T = unknown>(
  request: Request
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false };
    }
    return { ok: true, value: value as T };
  } catch {
    return { ok: false };
  }
}

/**
 * Consume and discard whatever is left of a request body. A handler that
 * answers without reading its body leaves the stream unread when the
 * response goes out; behind a service binding the proxying Worker then
 * logs "Can't read from request stream after response has been sent"
 * (the umbilical, spec 0003 step 4, forwards the container's request
 * stream as the binding's body). The chunks are read and dropped, never
 * buffered, so the cost is bounded whatever the caller sent. Draining
 * is idempotent: a body already read, or a request that never had one,
 * is a no-op, and a stream that fails mid-read is ignored because the
 * handler's answer does not depend on it.
 */
export async function drainBody(request: Request): Promise<void> {
  if (request.bodyUsed || request.body === null) return;
  try {
    const reader = request.body.getReader();
    while (!(await reader.read()).done) {
      // Discarded: the handler never asked for this body.
    }
  } catch {
    // Nothing to do: the body was never the handler's input.
  }
}

/**
 * Run a route, then drain the request body before its response leaves.
 * The rule for every Worker behind a service binding: the body is
 * consumed before the response is sent, whatever the route did with it
 * (read it, ignored it, or refused early with a named error). One place
 * per Worker, so no handler has to remember it.
 */
export async function respondThenDrain(
  request: Request,
  route: () => Response | Promise<Response>
): Promise<Response> {
  try {
    return await route();
  } finally {
    await drainBody(request);
  }
}

/**
 * The same rule for a default export: the fetch handler is wrapped in
 * respondThenDrain and every other export (scheduled, email, queue) is
 * carried through untouched.
 */
export function drainingBodies<E>(handler: ExportedHandler<E>): ExportedHandler<E> {
  const { fetch } = handler;
  if (!fetch) return handler;
  return {
    ...handler,
    fetch(request, env, ctx) {
      return respondThenDrain(request, () => fetch.call(handler, request, env, ctx));
    }
  };
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

/**
 * Accept any one of several bearers (e.g. an internal service token or the
 * operator API token). Unconfigured entries are skipped; all entries
 * unconfigured fails closed like requireBearer.
 */
export function requireAnyBearer(
  request: Request,
  expected: Array<string | undefined>
): Response | null {
  const configured = expected.filter((token): token is string => Boolean(token));
  if (configured.length === 0) {
    return errorResponse(500, "auth_not_configured", "server has no token configured");
  }
  let denied: Response | null = null;
  for (const token of configured) {
    const result = requireBearer(request, token);
    if (result === null) return null;
    denied = result;
  }
  return denied;
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
