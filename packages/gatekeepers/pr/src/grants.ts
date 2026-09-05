import { findAgent, parseRoster, reachableGithubRepos, type MergeGrant, type RosterAgent } from "@operon/core";

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
 * The agent's own grant when the roster carries one, else the
 * fleet-wide PR_REPOS for one release.
 *
 * The switch is the PRESENCE OF A `github:` BLOCK, not of a `pr` key
 * inside it. An operator who wrote `github: { write: [...] }` said what
 * this agent may reach; reading the missing `pr` as "and also
 * everything the fleet allows" would hand a write-only agent the whole
 * fleet list. The container's copy of this rule keys on exactly the
 * same thing, so the pre-check and the authority agree.
 *
 * A caller that reached this function has already been identified
 * against the roster (see rosterVerdict), so the unparseable-roster
 * branch is defense in depth rather than a path the doors take: the
 * doors refuse an unverifiable claim outright.
 */
export function grantedRepos(env: GrantSource, agentId: string): string[] {
  if (typeof env.ROSTER === "string" && env.ROSTER.length > 0) {
    try {
      const agent = findAgent(parseRoster(env.ROSTER), agentId);
      if (agent?.github) return agent.github.pr ?? [];
      // No block at all: this agent predates grants, so the fleet list
      // still binds. An unknown agent falls through too, and gets
      // nothing from it because it has no PAT either.
    } catch {
      /* fall through to the fleet list */
    }
  }
  return fleetRepos(env);
}

/**
 * Whether the roster knows this agent at all.
 *
 * The caller names the agent in its request body, so the name is a
 * CLAIM: it selects both the repo grant and the GitHub credential, and
 * a name nobody put in the roster must select neither. "no-roster" is
 * kept distinct from "unknown" because a deployment whose ROSTER var is
 * missing or unparseable cannot answer the question, and refusing every
 * door there would take out a working colony to fix a claim we cannot
 * check anyway.
 */
export function rosterVerdict(
  env: GrantSource,
  agentId: string
): "known" | "unknown" | "no-roster" {
  if (typeof env.ROSTER !== "string" || env.ROSTER.length === 0) return "no-roster";
  try {
    return findAgent(parseRoster(env.ROSTER), agentId) ? "known" : "unknown";
  } catch {
    return "no-roster";
  }
}

function rosterAgent(env: GrantSource, agentId: string): RosterAgent | undefined {
  if (typeof env.ROSTER !== "string" || env.ROSTER.length === 0) return undefined;
  try {
    return findAgent(parseRoster(env.ROSTER), agentId);
  } catch {
    return undefined;
  }
}

/**
 * The repos an agent may READ and discuss (spec 0012 §3): everything it
 * may author on, review on, or merge on. A reviewer with no pr grant
 * still reads the pull requests it adjudicates. An agent with no
 * github block keeps the fleet list, exactly as grantedRepos does.
 */
export function reachableRepos(env: GrantSource, agentId: string): string[] {
  const agent = rosterAgent(env, agentId);
  if (agent?.github) return reachableGithubRepos(agent.github);
  return fleetRepos(env);
}

/** The repos this agent may post reviews on (spec 0012 §5). Nothing without a roster grant. */
export function reviewRepos(env: GrantSource, agentId: string): string[] {
  return rosterAgent(env, agentId)?.github?.review ?? [];
}

/** This agent's merge grant on a repo (spec 0012 §6), or undefined when it has none. */
export function mergeGrant(env: GrantSource, agentId: string, repo: string): MergeGrant | undefined {
  return (rosterAgent(env, agentId)?.github?.merge ?? []).find(grant => grant.repo === repo);
}

/**
 * Every roster agent id, for resolving which logins are colleagues
 * (spec 0012 §4). Empty without a roster: nobody counts as a colleague.
 */
export function rosterAgentIds(env: GrantSource): string[] {
  if (typeof env.ROSTER !== "string" || env.ROSTER.length === 0) return [];
  try {
    return parseRoster(env.ROSTER).agents.map(agent => agent.id);
  } catch {
    return [];
  }
}
