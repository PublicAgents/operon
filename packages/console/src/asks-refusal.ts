import { ApiError } from "./api.js";

/**
 * What the console says when the asks gatekeeper refuses (spec 0007 §3
 * and §5). Kept pure and out of the page so it can be tested: this is
 * the sentence sitting next to the decision buttons, and a sentence
 * there that is out of date is worse than no sentence at all.
 *
 * The notice describes a PAST ATTEMPT, in the past tense, out of facts
 * that were true at the moment of the refusal: what the operator tried,
 * and where the gatekeeper said the ask already was. Such a statement
 * cannot expire, whatever the ask does next.
 *
 * An earlier version kept the sentence pointed at the ask's CURRENT
 * state, which meant chasing the card's polling: a state can repeat,
 * two changes can share a millisecond, and each fix left another window
 * where the notice and the card disagreed. A record of what happened
 * has no windows.
 */

export type AskState = "open" | "acknowledged" | "allowed" | "declined" | "closed" | "retracted";

export interface Refusal {
  attempted: AskState | "reply";
  /** Where the gatekeeper said the ask already was, when it refused. */
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

export function refusalFrom(error: unknown, attempted: Refusal["attempted"]): Refusal {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown; state?: unknown } | null;
    // The 409 body also carries a thread tail. It is deliberately not
    // read: this notice sits next to the decision buttons, and only
    // gatekeeper facts belong that close to them (spec 0005 §8).
    if (body?.error === "ask_state_moved" || body?.error === "ask_terminal") {
      return {
        attempted,
        ...(typeof body.state === "string" ? { reported: body.state as AskState } : {})
      };
    }
    return { attempted, raw: error.message };
  }
  return { attempted, raw: "the request did not go through" };
}

export function refusalMessage(refusal: Refusal): string {
  const what =
    refusal.attempted === "reply" ? "your reply" : `marking this ${LABEL[refusal.attempted]}`;
  if (refusal.raw !== undefined) return `${what} was refused: ${refusal.raw}`;
  const where = refusal.reported === undefined ? "moved on" : `moved to ${refusal.reported}`;
  return `${what} was refused: the ask had already ${where}, and nothing was overwritten`;
}
