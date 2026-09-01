import { findAgent, parseRoster } from "@operon/core";

/**
 * Which repos an agent may reach through this Gatekeeper (spec 0008 §3).
 *
 * Kept out of the Worker wiring so it can be tested as what it is: a
 * policy decision. Every door asks it per call rather than per Worker,
 * because the answer is now per agent.
 */
export interface GrantSource {
  ROSTER?: string;
  PR_REPOS?: string;
}

function fleetRepos(env: GrantSource): string[] {
  return (env.PR_REPOS ?? "")
    .split(",")
    .map(repo => repo.trim())
    .filter(repo => repo.length > 0);
}

/**
 * The agent's own `github.pr` grant when the roster carries one, else
 * the fleet-wide PR_REPOS for one release. An unparseable roster falls
 * back rather than widening: the fleet list is what this Worker
 * enforced before grants existed, and "everything" is never the safe
 * reading of a broken input.
 */
export function grantedRepos(env: GrantSource, agentId: string): string[] {
  if (typeof env.ROSTER === "string" && env.ROSTER.length > 0) {
    try {
      const agent = findAgent(parseRoster(env.ROSTER), agentId);
      if (agent?.github?.pr) return agent.github.pr;
      // A known agent with no grant, and an unknown agent, both fall
      // through to the fleet list; an unknown agent gets nothing from
      // it only because it has no PAT either (credential_unconfigured).
    } catch {
      /* fall through to the fleet list */
    }
  }
  return fleetRepos(env);
}
