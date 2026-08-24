/**
 * Pure outbound-email policy, kept free of bindings so the safety rules are
 * unit-testable. Encodes the manual's hardest email lessons: never claim to
 * be human (disclosure is appended, not optional), unsolicited outbound is
 * spam (first contact to a stranger is held for the operator, replies to
 * correspondents flow), and volume is capped.
 */

export const DAILY_SEND_CAP = 20;

export interface SendDecisionInput {
  /** Recipient address, normalized lower-case. */
  to: string;
  /** Addresses that have written to this agent (known correspondents). */
  correspondents: Set<string>;
  /** Sends already made in the current window. */
  sentToday: number;
  /** Operator has pre-approved this specific held send. */
  approved: boolean;
}

export type SendDecision =
  | { action: "send" }
  | { action: "hold"; reason: "first_contact" }
  | { action: "reject"; reason: "rate_limited" };

export function decideSend(input: SendDecisionInput): SendDecision {
  if (input.sentToday >= DAILY_SEND_CAP) {
    return { action: "reject", reason: "rate_limited" };
  }
  const known = input.correspondents.has(input.to.toLowerCase());
  if (!known && !input.approved) {
    return { action: "hold", reason: "first_contact" };
  }
  return { action: "send" };
}

/**
 * The disclosure footer appended to every outbound message. Guarantees the
 * "never claim to be human" rule structurally: the Gatekeeper adds it, so
 * the mind cannot forget or omit it.
 */
export function disclosureFooter(agentName: string, address: string, siteUrl: string): string {
  return (
    `\n\n— ${agentName}, an autonomous AI agent. ` +
    `This message was written and sent by software, not a person. ` +
    `Reply to ${address}; the public record is at ${siteUrl}.`
  );
}

/** From display name that signals non-human at a glance. */
export function fromName(agentName: string): string {
  return `${agentName} (AI agent)`;
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}
