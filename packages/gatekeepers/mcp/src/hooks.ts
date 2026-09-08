/**
 * The webhook contract's mechanics (spec 0014 §3), pure: the signature
 * schemes by name, the registration template, dotted-path reads, and
 * the delivery key a callback deduplicates on. The Worker calls these;
 * the tests call them without the Worker.
 */
import type { McpSignatureScheme } from "@operon/core";

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(text: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) return undefined;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function fromBase64(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text), c => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}
/** Constant-time comparison of two byte strings. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * What the provider signed: the raw body, or `<timestamp>.<body>` when
 * the contract names a timestamp header.
 */
export function signedInput(body: string, timestamp?: string): string {
  return timestamp === undefined ? body : `${timestamp}.${body}`;
}

/** True when `signature` is the provider's signature of `input` under `scheme` with `secret`. */
export async function verifySignature(
  scheme: McpSignatureScheme,
  secret: string,
  signature: string,
  input: string
): Promise<boolean> {
  const given = signature.trim().replace(/^(sha256=|v1=)/, "");
  if (scheme === "hmac-sha256-hex" || scheme === "hmac-sha256-base64") {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(input)));
    const theirs = scheme === "hmac-sha256-hex" ? fromHex(given) : fromBase64(given);
    return theirs !== undefined && same(mac, theirs);
  }
  // ed25519-hex: the "secret" is the provider's public key, hex.
  const publicKey = fromHex(secret);
  const theirs = fromHex(given);
  if (!publicKey || !theirs) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, theirs, encoder.encode(input));
  } catch {
    return false;
  }
}

/** A timestamp header older than this is a replay, whatever its signature says. */
export const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/** Parse a provider timestamp (ISO 8601, or seconds/milliseconds since the epoch). */
export function timestampMs(text: string): number | undefined {
  const trimmed = text.trim();
  if (/^\d{9,10}$/.test(trimmed)) return Number(trimmed) * 1000;
  if (/^\d{12,14}$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * The registration, the provider's own shape with the callback filled
 * in: a string that is exactly a placeholder takes the value's JSON
 * type (so `"{events}"` becomes the array), `{events}` inside a longer
 * string is joined as text, and `{url}` is a whole field by contract.
 */
export function fillRegistration(template: unknown, url: string, events: readonly string[]): unknown {
  if (typeof template === "string") {
    if (template === "{url}") return url;
    if (template === "{events}") return [...events];
    return template.split("{url}").join(url).split("{events}").join(events.join(","));
  }
  if (Array.isArray(template)) return template.map(item => fillRegistration(item, url, events));
  if (typeof template === "object" && template !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) out[key] = fillRegistration(value, url, events);
    return out;
  }
  return template;
}

/** The value at a dotted path, or undefined; arrays index by number. */
export function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The delivery key: the provider's id when the contract names one, else the body's digest. */
export async function deliveryKey(callbackId: unknown, body: string): Promise<string> {
  if (typeof callbackId === "string" && callbackId.length > 0) return `id:${callbackId}`;
  if (typeof callbackId === "number") return `id:${callbackId}`;
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)))}`;
}

/** The run id from a tool result: the structured content first, else the text content parsed as JSON. */
export function runIdFromResult(result: unknown, runIdPath: string): string | undefined {
  const candidates: unknown[] = [];
  if (result !== null && typeof result === "object") {
    const r = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; toolResult?: unknown };
    if (r.structuredContent !== undefined) candidates.push(r.structuredContent);
    if (r.toolResult !== undefined) candidates.push(r.toolResult);
    for (const item of r.content ?? []) {
      if (item.type === "text" && typeof item.text === "string") {
        try {
          candidates.push(JSON.parse(item.text));
        } catch {
          /* not JSON: nothing to read */
        }
      }
    }
  }
  for (const candidate of candidates) {
    const found = readPath(candidate, runIdPath);
    if (typeof found === "string" && found.length > 0) return found;
    if (typeof found === "number") return String(found);
  }
  return undefined;
}
