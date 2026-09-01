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
 * An unparseable roster falls back rather than widening: the fleet list
 * is what this Worker enforced before grants existed, and "everything"
 * is never the safe reading of a broken input.
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
