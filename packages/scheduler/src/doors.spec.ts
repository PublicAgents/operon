import { describe, expect, it } from "vitest";
import type { RosterAgent } from "@operon/core";
import { closedDoors, disabledDoors, effectiveDoors, sanitizeOverrides } from "./doors.js";

const agent: RosterAgent = {
  id: "promoter",
  stateRepo: "o/r",
  cadence: "0 6 * * *",
  harness: "claude-code",
  model: "m",
  fallbackModel: "f",
  maxWakeMinutes: 30,
  hosts: ["@"],
  enabled: true
};

describe("doors", () => {
  it("opens every door by default, the web door only on opt-in", () => {
    const doors = effectiveDoors(agent, {});
    expect(doors.notify.effective).toBe(true);
    expect(doors.x.effective).toBe(true);
    expect(doors.web).toEqual({ baseline: false, effective: false });
    expect(effectiveDoors({ ...agent, web: true }, {}).web.effective).toBe(true);
  });

  it("takes the roster's baseline, and lets an override win either way", () => {
    const fenced = { ...agent, web: true, doors: { x: false, web: false } };
    expect(closedDoors(fenced, {})).toEqual(new Set(["x", "web"]));
    // The operator reopens x and closes pay without a deploy.
    const doors = effectiveDoors(fenced, { x: true, pay: false });
    expect(doors.x).toEqual({ baseline: false, override: true, effective: true });
    expect(doors.pay).toEqual({ baseline: true, override: false, effective: false });
    expect(closedDoors(fenced, { x: true, pay: false })).toEqual(new Set(["web", "pay"]));
  });

  it("names as disabled only the doors closed by a decision, never a door merely not opted into", () => {
    expect(disabledDoors(agent, {})).toEqual([]);
    expect(disabledDoors({ ...agent, doors: { x: false } }, {})).toEqual(["x"]);
    expect(disabledDoors({ ...agent, doors: { x: false } }, { x: true, pay: false })).toEqual(["pay"]);
    expect(disabledDoors({ ...agent, web: true }, { web: false })).toEqual(["web"]);
  });

  it("keeps only named doors and booleans from a stored override", () => {
    expect(sanitizeOverrides({ x: false, persist: false, pay: "no", junk: 1 })).toEqual({ x: false });
    expect(sanitizeOverrides(null)).toEqual({});
  });
});
