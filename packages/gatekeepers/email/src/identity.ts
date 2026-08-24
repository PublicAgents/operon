import { findAgent, type Roster, type RosterAgent } from "@operon/core";

/**
 * An agent's email identity, derived from the roster. The local part is the
 * agent's chosen-name subdomain label (the first non-apex host), so Prior
 * (host "prior") is prior@<domain>; the display name and site URL follow.
 */

export interface EmailIdentity {
  agentId: string;
  localPart: string;
  address: string;
  name: string;
  siteUrl: string;
}

function label(agent: RosterAgent): string {
  const sub = agent.hosts.find(host => host !== "@");
  return sub ?? agent.id;
}

function displayName(localPart: string): string {
  return localPart.charAt(0).toUpperCase() + localPart.slice(1);
}

export function identityForAgent(
  agent: RosterAgent,
  emailDomain: string,
  zone: string
): EmailIdentity {
  const localPart = label(agent);
  const hasSubdomain = agent.hosts.some(host => host !== "@");
  return {
    agentId: agent.id,
    localPart,
    address: `${localPart}@${emailDomain}`,
    name: displayName(localPart),
    siteUrl: hasSubdomain ? `https://${localPart}.${zone}` : `https://${zone}`
  };
}

/** Map a recipient address's local part back to an agent via the roster. */
export function identityForRecipient(
  roster: Roster,
  emailDomain: string,
  recipient: string
): EmailIdentity | null {
  const at = recipient.toLowerCase().indexOf("@");
  if (at < 0) return null;
  const local = recipient.slice(0, at).toLowerCase();
  const domain = recipient.slice(at + 1).toLowerCase();
  if (domain !== emailDomain.toLowerCase()) return null;
  const agent = roster.agents.find(a => {
    const sub = a.hosts.find(host => host !== "@");
    return (sub ?? a.id).toLowerCase() === local;
  });
  if (!agent) return null;
  return identityForAgent(findAgent(roster, agent.id) as RosterAgent, emailDomain, roster.zone);
}
