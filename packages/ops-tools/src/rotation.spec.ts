import { describe, expect, it } from "vitest";
import {
  executeRotation,
  freshBearer,
  planRotation,
  rotationGroups,
  workerNameForDir
} from "./rotation.js";

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

describe("executeRotation", () => {
  const PAIRS = [
    ["gatekeeper-till", "TILL_TOKEN_PROMOTER"],
    ["scheduler", "TILL_TOKEN_PROMOTER"]
  ] as const;

  it("retries a flaky member with the SAME value inside one invocation", async () => {
    const writes: { dir: string; value: string }[] = [];
    let tillAttempts = 0;
    const outcome = await executeRotation(
      PAIRS,
      "value-a",
      async (dir, _name, value) => {
        if (dir === "gatekeeper-till" && tillAttempts++ === 0) {
          throw new Error("cloudflare api 502");
        }
        writes.push({ dir, value });
      },
      0
    );
    expect(outcome).toEqual({
      written: ["gatekeeper-till/TILL_TOKEN_PROMOTER", "scheduler/TILL_TOKEN_PROMOTER"],
      failed: [],
      failedPairs: []
    });
    expect(tillAttempts).toBe(2);
    // A fresh value per attempt could keep a group split forever; the
    // retried member must receive the same value as everyone else.
    expect(new Set(writes.map(w => w.value))).toEqual(new Set(["value-a"]));
  });

  it("attempts every member and reports both lists on a persistent failure", async () => {
    let attempts = 0;
    const outcome = await executeRotation(
      PAIRS,
      "value-b",
      async dir => {
        if (dir === "gatekeeper-till") {
          attempts++;
          throw new Error("cloudflare api 502");
        }
      },
      0
    );
    expect(attempts).toBe(3);
    expect(outcome.written).toEqual(["scheduler/TILL_TOKEN_PROMOTER"]);
    expect(outcome.failed).toEqual([
      "gatekeeper-till/TILL_TOKEN_PROMOTER (cloudflare api 502)"
    ]);
    // The failed members come back as pairs: the durable resume state.
    expect(outcome.failedPairs).toEqual([["gatekeeper-till", "TILL_TOKEN_PROMOTER"]]);
  });

  it("mints 256-bit hex bearers", () => {
    const value = freshBearer();
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(freshBearer()).not.toBe(value);
  });
});

describe("planRotation", () => {
  const PAIRS = [
    ["gatekeeper-till", "TILL_TOKEN_PROMOTER"],
    ["scheduler", "TILL_TOKEN_PROMOTER"]
  ] as const;

  it("starts fresh over every member when nothing is pending", () => {
    const plan = planRotation(undefined, PAIRS, () => "fresh");
    expect(plan).toEqual({ value: "fresh", target: PAIRS, resumed: false });
  });

  it("resumes an incomplete rotation with the SAME value over only the missing members", () => {
    const plan = planRotation(
      { value: "in-flight", remaining: [["scheduler", "TILL_TOKEN_PROMOTER"]], all: [...PAIRS] },
      PAIRS,
      () => "fresh"
    );
    // Durable recovery: a re-run must not mint another value, or
    // transient failures across attempts could keep the group split.
    expect(plan.resumed).toBe(true);
    expect(plan.value).toBe("in-flight");
    expect(plan.target).toEqual([["scheduler", "TILL_TOKEN_PROMOTER"]]);
  });

  it("abandons stale state when the member list changed", () => {
    const plan = planRotation(
      { value: "in-flight", remaining: [["scheduler", "OLD_NAME"]], all: [["scheduler", "OLD_NAME"]] },
      PAIRS,
      () => "fresh"
    );
    expect(plan).toEqual({ value: "fresh", target: PAIRS, resumed: false });
  });

  it("starts fresh when the pending state already converged", () => {
    const plan = planRotation({ value: "old", remaining: [], all: [...PAIRS] }, PAIRS, () => "fresh");
    expect(plan.resumed).toBe(false);
    expect(plan.value).toBe("fresh");
  });
});
