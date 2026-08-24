import type { Roster, RosterAgent } from "./roster.js";

/**
 * Cadence matching is deliberately dumb: an agent is due when the cron
 * expression that fired equals its cadence, compared after whitespace
 * normalization. Cron *semantics* (does "0 6 * * *" cover 06:00?) belong to
 * the platform; the deployment registers every distinct cadence as a
 * trigger, and the scheduled event tells us verbatim which one fired.
 * Parsing cron ourselves would be a second clock that can disagree with
 * the real one.
 */
export function normalizeCadence(expression: string): string {
  return expression.trim().split(/\s+/).join(" ");
}

export function dueAgents(roster: Roster, firedCron: string): RosterAgent[] {
  const fired = normalizeCadence(firedCron);
  return roster.agents.filter(
    agent => agent.enabled && normalizeCadence(agent.cadence) === fired
  );
}

/** Every distinct cadence the deployment must register as a cron trigger. */
export function distinctCadences(roster: Roster): string[] {
  const cadences = new Set<string>();
  for (const agent of roster.agents) {
    if (agent.enabled) cadences.add(normalizeCadence(agent.cadence));
  }
  return [...cadences];
}
