/**
 * The rotation table now lives in @operon/ops-tools (spec 0005 §6), so
 * the secret_rotate_group tool, this CLI, and the coverage spec all
 * share ONE table. This file adapts the roster-shaped signature the CLI
 * and the spec always had. Requires a built chassis (dist present),
 * exactly like the deploy scripts.
 */
import { rotationGroups } from "../packages/ops-tools/dist/rotation.js";

export function groupsFor(roster) {
  return rotationGroups(roster.agents.map(agent => agent.id));
}
