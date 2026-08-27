/**
 * Pure vault policy: label and value bounds, and the per-agent bearer
 * name. Deterministic and unit-tested; the Durable Object provides
 * per-agent isolation and atomicity, the Worker provides nothing an
 * agent's bearer does not unlock.
 */

/** "promoter" -> "VAULT_TOKEN_PROMOTER" (secret-store bearers are per-agent). */
export function vaultTokenVar(agentId: string): string {
  return `VAULT_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

/** Labels are identifiers, not content: short, printable, path-safe. */
export function validLabel(label: unknown): label is string {
  return typeof label === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(label);
}

/**
 * Values shorter than this are refused: the sweep's variant expansion
 * needs length to be meaningful, and a shorter string is not a secret in
 * any useful sense (it would drown the denylist in false positives).
 */
export const MIN_VALUE_LENGTH = 8;
export const MAX_VALUE_BYTES = 4096;
/** Per-agent cap on stored secrets. */
export const MAX_SECRETS = 64;

export type ValueProblem = "not_a_string" | "too_short" | "too_long" | "has_newline";

/**
 * Value bounds. Newlines are refused because a stored value becomes a
 * denylist literal, and the sweep's line-oriented handling (and the
 * agent's own use of the value in commands) both assume a single token.
 */
export function valueProblem(value: unknown): ValueProblem | null {
  if (typeof value !== "string") return "not_a_string";
  if (value.length < MIN_VALUE_LENGTH) return "too_short";
  if (new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) return "too_long";
  if (/[\r\n]/.test(value)) return "has_newline";
  return null;
}
