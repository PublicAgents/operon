import { describe, expect, it } from "vitest";
import { bindingFor, fleetOf, resolveProject, wakeTokenVar } from "./fleet.js";

const ENV = {
  HOST_PROJECT: "livevariant",
  HOST_ZONE: "livevariant.ai",
  WORKER_NAME_PREFIX: "operon-",
  DEFAULT_PROJECT: "livevariant",
  PROJECTS: JSON.stringify([{ project: "second-one", zone: "second.example", workerPrefix: "operon-second-one" }])
};

describe("fleetOf", () => {
  it("lists the host first, then the enrolled projects, with the default", () => {
    expect(fleetOf(ENV)).toEqual({
      host: "livevariant",
      defaultProject: "livevariant",
      projects: [
        { project: "livevariant", zone: "livevariant.ai", workerPrefix: "operon" },
        { project: "second-one", zone: "second.example", workerPrefix: "operon-second-one" }
      ]
    });
  });

  it("is a single-project plane without the vars, and enrolls nothing from a malformed list", () => {
    expect(fleetOf({})).toEqual({
      host: "default",
      defaultProject: "default",
      projects: [{ project: "default", workerPrefix: "operon" }]
    });
    expect(fleetOf({ ...ENV, PROJECTS: "{not json" }).projects).toHaveLength(1);
    expect(fleetOf({ ...ENV, PROJECTS: JSON.stringify([{ project: "x" }]) }).projects).toHaveLength(1);
  });
});

describe("resolveProject", () => {
  const fleet = fleetOf(ENV);

  it("fills an omitted project with the default and resolves a named one", () => {
    expect(resolveProject(fleet, undefined).project).toBe("livevariant");
    expect(resolveProject(fleet, "second-one").project).toBe("second-one");
  });

  it("refuses an unknown project by name rather than falling back", () => {
    expect(() => resolveProject(fleet, "third")).toThrow(/unknown project: third/);
    try {
      resolveProject(fleet, "third");
    } catch (error) {
      expect((error as { status: number }).status).toBe(404);
      expect((error as { payload: { enrolled: string[] } }).payload.enrolled).toEqual(["livevariant", "second-one"]);
    }
  });
});

describe("bindings and bearers per project", () => {
  const fleet = fleetOf(ENV);
  const [host, second] = fleet.projects;

  it("keeps the host's bare names and infixes the enrolled project's", () => {
    expect(bindingFor(fleet, host, "EMAIL")).toBe("EMAIL");
    expect(bindingFor(fleet, second, "EMAIL")).toBe("SECOND_ONE__EMAIL");
    expect(bindingFor(fleet, second, "SCHEDULER")).toBe("SECOND_ONE__SCHEDULER");
  });

  it("names the wake-trigger bearer per project", () => {
    expect(wakeTokenVar(fleet, host)).toBe("WAKE_TRIGGER_TOKEN");
    expect(wakeTokenVar(fleet, second)).toBe("WAKE_TRIGGER_TOKEN_SECOND_ONE");
  });
});
