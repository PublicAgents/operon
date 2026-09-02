import { DOORS, type Door, type RosterAgent } from "@operon/core";

/**
 * Baseline plus override, per door (spec 0006 §7). The baseline is the
 * roster's word (absent means open; the web door's baseline is its
 * opt-in flag); an override is the operator's runtime word from the
 * plane and wins while it stands. Pure, so the rule is testable without
 * a Durable Object.
 */
export type DoorOverrides = Partial<Record<Door, boolean>>;

export interface DoorState {
  baseline: boolean;
  override?: boolean;
  effective: boolean;
}

export function baselineDoor(agent: RosterAgent, door: Door): boolean {
  const declared = agent.doors?.[door];
  if (declared !== undefined) return declared;
  return door === "web" ? agent.web === true : true;
}

export function effectiveDoors(agent: RosterAgent, overrides: DoorOverrides): Record<Door, DoorState> {
  const out = {} as Record<Door, DoorState>;
  for (const door of DOORS) {
    const baseline = baselineDoor(agent, door);
    const override = overrides[door];
    out[door] = { baseline, ...(override !== undefined ? { override } : {}), effective: override ?? baseline };
  }
  return out;
}

/** The doors a wake must NOT be wired with. */
export function closedDoors(agent: RosterAgent, overrides: DoorOverrides): Set<Door> {
  const closed = new Set<Door>();
  for (const [door, state] of Object.entries(effectiveDoors(agent, overrides)) as Array<[Door, DoorState]>) {
    if (!state.effective) closed.add(door);
  }
  return closed;
}

/**
 * The doors closed by a DECISION: the roster's explicit false or the
 * operator's override. A door that is merely not opted into (web
 * without `web: true`) is not disabled, it is not wired, and the living
 * help must keep saying so.
 */
export function disabledDoors(agent: RosterAgent, overrides: DoorOverrides): Door[] {
  const out: Door[] = [];
  for (const door of DOORS) {
    const override = overrides[door];
    const decided = override !== undefined ? override === false : agent.doors?.[door] === false;
    if (decided) out.push(door);
  }
  return out;
}

/** Overrides as stored: named doors and booleans only, anything else dropped. */
export function sanitizeOverrides(value: unknown): DoorOverrides {
  const out: DoorOverrides = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [door, enabled] of Object.entries(value as Record<string, unknown>)) {
    if ((DOORS as readonly string[]).includes(door) && typeof enabled === "boolean") out[door as Door] = enabled;
  }
  return out;
}
