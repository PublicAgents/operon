import { describe, expect, it } from "vitest";
import { validLabel, valueProblem, vaultTokenVar, MAX_VALUE_BYTES } from "./policy.js";

describe("vaultTokenVar", () => {
  it("maps agent ids to env names", () => {
    expect(vaultTokenVar("promoter")).toBe("VAULT_TOKEN_PROMOTER");
    expect(vaultTokenVar("second-tenant")).toBe("VAULT_TOKEN_SECOND_TENANT");
  });
});

describe("validLabel", () => {
  it("accepts identifier-shaped labels", () => {
    expect(validLabel("livevariant-stats.lv-001")).toBe(true);
    expect(validLabel("A")).toBe(true);
  });

  it("rejects paths, spaces, leading punctuation, and oversize", () => {
    expect(validLabel("../etc")).toBe(false);
    expect(validLabel("two words")).toBe(false);
    expect(validLabel(".hidden")).toBe(false);
    expect(validLabel("x".repeat(65))).toBe(false);
    expect(validLabel(42)).toBe(false);
    expect(validLabel("")).toBe(false);
  });
});

describe("valueProblem", () => {
  it("accepts a plausible secret", () => {
    expect(valueProblem("sk-a-real-looking-secret-value")).toBeNull();
  });

  it("rejects short, oversize, multiline, and non-string values", () => {
    expect(valueProblem("short")).toBe("too_short");
    expect(valueProblem("x".repeat(MAX_VALUE_BYTES + 1))).toBe("too_long");
    expect(valueProblem("line one\nline two")).toBe("has_newline");
    expect(valueProblem(42)).toBe("not_a_string");
  });
});
