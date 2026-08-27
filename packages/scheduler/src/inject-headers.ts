import { HARNESS_CREDENTIAL_INJECTION, type CredentialInjection } from "@operon/core";

/**
 * Pure header injection (spec 0003 phase 2): swap the credential header
 * for a known harness API host. Runtime-free so it is unit-tested
 * without the Workers runtime; the entrypoint in injector.ts wraps it.
 */
export function injectHeaders(
  headers: Headers,
  host: string,
  credentials: Record<string, string | undefined>
): Headers {
  for (const [harness, spec] of Object.entries(HARNESS_CREDENTIAL_INJECTION) as [
    string,
    CredentialInjection
  ][]) {
    if (!spec.hosts.includes(host)) continue;
    const credential = credentials[harness];
    if (!credential) continue;
    const out = new Headers(headers);
    out.set(spec.header, `${spec.scheme}${credential}`);
    return out;
  }
  return headers;
}

/** "claude-code" -> "MIND_CREDENTIAL_CLAUDE_CODE". */
export function mindCredentialVar(harness: string): string {
  return `MIND_CREDENTIAL_${harness.toUpperCase().replace(/-/g, "_")}`;
}
