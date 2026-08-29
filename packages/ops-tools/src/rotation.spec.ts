import { describe, expect, it } from "vitest";
import { rotationGroups, workerNameForDir } from "./rotation.js";

describe("rotationGroups", () => {
  it("derives the four per-agent groups from each agent id", () => {
    const groups = rotationGroups(["promoter", "second-agent"]);
    for (const id of ["promoter", "second-agent"]) {
      for (const door of ["till", "spend", "vault", "x"]) {
        expect(groups[`${door}-${id}`], `${door}-${id}`).toBeDefined();
      }
    }
    expect(groups["till-second-agent"]).toEqual([
      ["gatekeeper-till", "TILL_TOKEN_SECOND_AGENT"],
      ["scheduler", "TILL_TOKEN_SECOND_AGENT"]
    ]);
  });

  it("keeps every pair well-formed", () => {
    for (const [group, pairs] of Object.entries(rotationGroups(["promoter"]))) {
      expect(pairs.length, group).toBeGreaterThan(1);
      for (const [dir, name] of pairs) {
        expect(dir).toMatch(/^[a-z0-9-]+$/);
        expect(name).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });

  it("maps worker dirs to deployed names with the colony prefix", () => {
    expect(workerNameForDir("scheduler")).toBe("operon-scheduler");
    expect(workerNameForDir("gatekeeper-till")).toBe("operon-gatekeeper-till");
    expect(workerNameForDir("scheduler", "acme-")).toBe("acme-scheduler");
  });
});
