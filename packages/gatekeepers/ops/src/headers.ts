/**
 * Security headers for every console asset/HTML response (spec 0005 §8).
 * The console renders mind output, which is downstream of the open web,
 * so the page gets a strict, third-party-free CSP: scripts, styles, and
 * connections only from this host (plus its own wss endpoint; older
 * engines do not match wss under 'self'), nothing framed, nothing
 * sniffed, no referrer leaking the ops hostname.
 */

export function securityHeaders(host: string): Record<string, string> {
  return {
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' wss://${host}`,
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "require-trusted-types-for 'script'"
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin"
  };
}

export function withSecurityHeaders(response: Response, headers: Record<string, string>): Response {
  const wrapped = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    wrapped.headers.set(name, value);
  }
  return wrapped;
}
