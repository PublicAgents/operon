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

export function refusalFrom(
  error: unknown,
  attempted: Refusal["attempted"],
  from: AskState
): Refusal {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown; state?: unknown } | null;
    // The 409 body also carries a thread tail. It is deliberately not
    // read: this notice sits next to the decision buttons, and only
    // gatekeeper facts belong that close to them (spec 0005 §8).
    if (body?.error === "ask_state_moved" || body?.error === "ask_terminal") {
      return {
        attempted,
        from,
        ...(typeof body.state === "string" ? { reported: body.state as AskState } : {})
      };
    }
    return { attempted, from, raw: error.message };
  }
  return { attempted, from, raw: "the request did not go through" };
}

/**
 * The live ask once the refresh has landed, and until then the state
 * the refusal itself reported. Both are the gatekeeper's word, so the
 * sentence is never a guess, never lags the card, and never outlives
 * the state it describes.
 */
export function refusalMessage(refusal: Refusal, current: AskState): string {
  const what =
    refusal.attempted === "reply" ? "your reply" : `marking this ${LABEL[refusal.attempted]}`;
  if (refusal.raw !== undefined) return `${what} was refused: ${refusal.raw}`;
  const now = current !== refusal.from ? current : refusal.reported;
  if (now === undefined || now === refusal.from) {
    return `${what} was refused; the ask is still ${refusal.from}`;
  }
  return `${what} was refused: the ask is now ${now}, and nothing was overwritten`;
}
