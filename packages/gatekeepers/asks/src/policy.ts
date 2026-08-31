/**
 * Pure ask policy (spec 0007): the shapes, the bounds, and the
 * transition rules. Deterministic and unit-tested; the Durable Object
 * provides atomicity, the Worker provides identity.
 */

export const ASK_KINDS = ["decision", "request", "question"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/**
 * open          the agent is waiting
 * acknowledged  "on it": the operator has taken it, not yet resolved
 * allowed       the operator's yes
 * declined      the operator's no
 * closed        done, by either party
 * retracted     the agent withdrew it (never mind)
 */
export const ASK_STATES = [
  "open",
  "acknowledged",
  "allowed",
  "declined",
  "closed",
  "retracted"
] as const;
export type AskState = (typeof ASK_STATES)[number];

/** Terminal states: nothing transitions out of them (spec 0007 §3). */
export const TERMINAL_STATES: readonly AskState[] = ["closed", "retracted"];

export const LIMITS = {
  title: 200,
  body: 8_000,
  text: 4_000,
  links: 5,
  linkLength: 500,
  /** New asks per agent per wake; the eleventh is noise or a loop. */
  perWake: 10,
  /**
   * New asks per agent per UTC day, whatever wake they claim. The
   * per-wake cap trusts the porch to supply the wake id; this one
   * trusts nothing, so a caller that could rotate wake ids still
   * cannot mint unbounded interrupts.
   */
  perDay: 40,
  /** Backstop on operator emails per day, so a reply loop cannot flood a mailbox. */
  emailsPerDay: 100
} as const;

export interface AskThreadEntry {
  at: string;
  author: "agent" | "operator";
  kind: "message" | "state_change";
  /** Always present on a state_change: the state it moved the ask TO. */
  state?: AskState;
  text?: string;
}

export interface Ask {
  id: string;
  agentId: string;
  wakeId: string;
  title: string;
  body: string;
  kind: AskKind;
  links: string[];
  state: AskState;
  createdAt: string;
  updatedAt: string;
  /** Last time the agent read this thread; operator entries after it are unread. */
  agentSeenAt?: string;
  thread: AskThreadEntry[];
}

export class AskInputError extends Error {}

function fail(message: string): never {
  throw new AskInputError(message);
}

/** Text within its cap, with control characters refused. */
export function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} is required`);
  const text = value.trim();
  if (text.length > max) fail(`${label} exceeds ${max} characters`);
  // Control characters other than tab and newline: an ask is read by a
  // human in a terminal and a console, and neither should be steered by
  // an escape sequence the mind embedded.
  // eslint-disable-next-line no-control-regex -- detecting them IS the check
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    fail(`${label} contains control characters`);
  }
  return text;
}

export function parseKind(value: unknown): AskKind {
  if (value === undefined || value === null) return "question";
  if (typeof value !== "string" || !ASK_KINDS.includes(value as AskKind)) {
    fail(`kind must be one of ${ASK_KINDS.join(", ")}`);
  }
  return value as AskKind;
}

export function parseLinks(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length > LIMITS.links) fail(`at most ${LIMITS.links} links`);
  return raw.map(entry => {
    const link = requireText(entry, "link", LIMITS.linkLength);
    if (!link.startsWith("https://")) fail("links must be https");
    return link;
  });
}

export function parseState(value: unknown, label: string): AskState {
  if (typeof value !== "string" || !ASK_STATES.includes(value as AskState)) {
    fail(`${label} must be one of ${ASK_STATES.join(", ")}`);
  }
  return value as AskState;
}

/**
 * The transition decision (spec 0007 §3): compare-and-set on the state
 * the caller believed, and terminal states never move. A reason rather
 * than a throw keeps the DO's answer machine-readable.
 */
export function transitionRefusal(
  current: AskState,
  expected: AskState,
  next: AskState
): "state_moved" | "terminal" | null {
  if (TERMINAL_STATES.includes(current)) return "terminal";
  if (current !== expected) return "state_moved";
  if (current === next) return "state_moved";
  return null;
}

/** Operator entries the agent has not read yet (spec 0007 §6). */
export function unreadForAgent(ask: Ask): AskThreadEntry[] {
  const since = ask.agentSeenAt;
  return ask.thread.filter(
    entry => entry.author === "operator" && (since === undefined || entry.at > since)
  );
}
