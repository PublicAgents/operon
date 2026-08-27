import { describe, expect, it } from "vitest";
import { doorHost, resolveDoor, DOOR_ROUTES } from "./umbilical-routes.js";

const env = {
  NOTIFY_TOKEN: "notify-real",
  EMAIL_TOKEN: "email-real",
  PUBLISH_TOKEN: "publish-real",
  PERSIST_TOKEN: "persist-real",
  PR_TOKEN: "pr-real",
  CHRONICLE_TOKEN: "chronicle-real",
  TILL_TOKEN_PROMOTER: "till-promoter-real",
  SPEND_TOKEN_PROMOTER: "spend-promoter-real",
  VAULT_TOKEN_PROMOTER: "vault-promoter-real",
  X_TOKEN_PROMOTER: "x-promoter-real"
};

describe("umbilical door resolution", () => {
  it("maps a shared-bearer door to its binding and real bearer", () => {
    expect(resolveDoor("email.operon.internal", env, "promoter")).toEqual({
      binding: "EMAIL",
      bearer: "email-real"
    });
  });

  it("resolves the per-agent bearer for THIS container's agent", () => {
    expect(resolveDoor("spend.operon.internal", env, "promoter")).toEqual({
      binding: "SPEND",
      bearer: "spend-promoter-real"
    });
  });

  it("rejects a non-internal host, an unknown door, and a missing bearer", () => {
    expect(resolveDoor("api.anthropic.com", env, "promoter")).toEqual({ error: "not_internal" });
    expect(resolveDoor("nope.operon.internal", env, "promoter")).toEqual({ error: "unknown_door" });
    expect(resolveDoor("x.operon.internal", env, "other-agent")).toEqual({ error: "bearer_unconfigured" });
  });

  it("every door route names a binding and exactly one bearer source", () => {
    for (const [door, route] of Object.entries(DOOR_ROUTES)) {
      expect(route.binding, door).toBeTruthy();
      expect(Boolean(route.bearerEnv) !== Boolean(route.perAgentPrefix), door).toBe(true);
    }
  });

  it("builds the virtual host for a door", () => {
    expect(doorHost("email")).toBe("email.operon.internal");
  });
});
