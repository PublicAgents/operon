import { describe, expect, it } from "vitest";
import { branchDecision } from "./branch-policy.js";

const GRANTED = ["demo/product"];

describe("branchDecision (spec 0008 §6)", () => {
  it("refuses a repo the agent holds no write grant on, before any token exists", () => {
    const decision = branchDecision({ granted: GRANTED, repo: "demo/secrets", branch: "wip" }, "scout");
    expect(decision).toMatchObject({ ok: false, status: 403, code: "write_not_granted" });
    if (!decision.ok) expect(decision.detail).toContain("demo/product");
  });

  it("says plainly when an agent is granted nothing", () => {
    const decision = branchDecision({ granted: [], repo: "demo/product", branch: "wip" }, "scout");
    if (decision.ok) throw new Error("expected a refusal");
    expect(decision.detail).toContain("nothing");
  });

  it("refuses the default branch: the merge gate is the point", () => {
    const decision = branchDecision(
      { granted: GRANTED, repo: "demo/product", branch: "main", defaultBranch: "main" },
      "scout"
    );
    expect(decision).toMatchObject({ ok: false, status: 403, code: "default_branch_protected" });
    if (!decision.ok) expect(decision.detail).toContain("pull request");
  });

  it("allows a non-default branch of a granted repo", () => {
    expect(
      branchDecision(
        { granted: GRANTED, repo: "demo/product", branch: "prior/experiment", defaultBranch: "main" },
        "scout"
      )
    ).toEqual({ ok: true, repo: "demo/product", branch: "prior/experiment" });
  });

  it("refuses branch names that could confuse a ref path", () => {
    const bad = ["../main", "a..b", "wip/", ".hidden", "a//b", "", 7, null, "x".repeat(241)];
    for (const branch of bad) {
      const decision = branchDecision({ granted: GRANTED, repo: "demo/product", branch }, "scout");
      expect(decision.ok, `expected ${String(branch)} to refuse`).toBe(false);
      if (!decision.ok) expect(decision.code).toBe("invalid_branch");
    }
  });

  it("checks the grant before the branch name, so a stranger learns nothing about the repo", () => {
    const decision = branchDecision({ granted: GRANTED, repo: "demo/secrets", branch: "!!" }, "scout");
    if (decision.ok) throw new Error("expected a refusal");
    expect(decision.code).toBe("write_not_granted");
  });
});
