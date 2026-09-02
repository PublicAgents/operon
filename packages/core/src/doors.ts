/**
 * The doors an agent may or may not have (spec 0006 §7). Whether an
 * agent has one is explicit policy: a BASELINE in the roster (`doors:`
 * per agent, absent means open), and a runtime OVERRIDE the operator
 * flips from the plane without a deploy, effective at the next wake.
 * Enforcement is at wake wiring: a closed door's URL and bearer are
 * simply not handed to the container, so the porch answers not_wired
 * and the living help marks the door disabled, with zero Gatekeeper
 * changes. Granularity is the door; per-subcommand policy would be a
 * compatible extension inside the same matrix.
 *
 * Not doors: persist (the state repo commit, without which a wake
 * loses its work) and chronicle (transcript shipping, the operator's
 * own record). Those are the wake's plumbing, not its capabilities.
 */
export const DOORS = [
  "notify",
  "publish",
  "github",
  "email",
  "till",
  "pay",
  "vault",
  "asks",
  "x",
  "web",
  "mcp"
] as const;

export type Door = (typeof DOORS)[number];

/** The roster's per-agent baseline: a door absent here is open. */
export type DoorBaseline = Partial<Record<Door, boolean>>;

export function isDoor(value: unknown): value is Door {
  return typeof value === "string" && (DOORS as readonly string[]).includes(value);
}
