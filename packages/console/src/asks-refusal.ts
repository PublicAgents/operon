import { ApiError } from "./api.js";

/**
 * What the console says when the asks gatekeeper refuses (spec 0007 §3
 * and §5). Kept pure and out of the page so it can be tested: this is
 * the sentence sitting next to the decision buttons, and a sentence
 * there that is out of date is worse than no sentence at all.
 *
 * A refusal is remembered as FACTS, never as a rendered string: what
 * the operator attempted, the state the card was showing at the time,
 * and the state the gatekeeper reported back. The sentence is composed
 * at render time from whichever gatekeeper fact is furthest ahead, so
 * it neither lags the refusal nor outlives it.
 */

export type AskState = "open" | "acknowledged" | "allowed" | "declined" | "closed" | "retracted";

export interface Refusal {
  attempted: AskState | "reply";
  /** The state the card rendered when the attempt was made. */
  from: AskState;
  /**
   * The ask's version as the card had it (see askVersion). It marks
   * "the refreshed ask has not landed yet": the ask on the server has
   * moved on, so a different version means we are holding fresher
   * truth than the refusal body and should stop quoting it.
   */
  seenVersion: number;
  /** Where the gatekeeper said the ask actually was, when it said so. */
  reported?: AskState;
  /** Only for failures that are not the gatekeeper refusing a transition. */
  raw?: string;
}

export const LABEL: Record<AskState, string> = {
  open: "open",
  acknowledged: "on it",
  allowed: "allow",
  declined: "decline",
  closed: "close",
  retracted: "retracted"
};

/**
 * An ask's version: the length of its thread. Every change to an ask
 * appends exactly one thread entry, a state change or a message, so
 * this counts revisions exactly. It is used in place of updatedAt
 * because two changes can land in the same millisecond and a clock
 * that stands still would make a refreshed ask look like a stale one.
 */
export function askVersion(ask: { thread: unknown[] }): number {
  return ask.thread.length;
}

export function refusalFrom(
  error: unknown,
  attempted: Refusal["attempted"],
  seen: { state: AskState; version: number }
): Refusal {
  const from = seen.state;
  const seenVersion = seen.version;
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown; state?: unknown } | null;
    // The 409 body also carries a thread tail. It is deliberately not
    // read: this notice sits next to the decision buttons, and only
    // gatekeeper facts belong that close to them (spec 0005 §8).
    if (body?.error === "ask_state_moved" || body?.error === "ask_terminal") {
      return {
        attempted,
        from,
        seenVersion,
        ...(typeof body.state === "string" ? { reported: body.state as AskState } : {})
      };
    }
    return { attempted, from, seenVersion, raw: error.message };
  }
  return { attempted, from, seenVersion, raw: "the request did not go through" };
}

/**
 * The state the refusal reported, but ONLY until the refreshed ask
 * lands; from then on the live ask, always. Freshness is decided by
 * the ask's version rather than by comparing states, because states
 * repeat: an ask can be moved back to where it was, and a message that
 * reasoned from equality would revive the refusal body long after it
 * went out of date. Both sources are the gatekeeper's word, so the
 * sentence is never a guess, never lags the refusal, and never
 * outlives it.
 */
export function refusalMessage(
  refusal: Refusal,
  current: { state: AskState; version: number }
): string {
  const what =
    refusal.attempted === "reply" ? "your reply" : `marking this ${LABEL[refusal.attempted]}`;
  if (refusal.raw !== undefined) return `${what} was refused: ${refusal.raw}`;
  const landed = current.version !== refusal.seenVersion;
  const now = landed ? current.state : refusal.reported;
  if (now === undefined || now === refusal.from) {
    return `${what} was refused; the ask is still ${refusal.from}`;
  }
  return `${what} was refused: the ask is now ${now}, and nothing was overwritten`;
}
