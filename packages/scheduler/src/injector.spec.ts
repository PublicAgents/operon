import { describe, expect, it } from "vitest";
import { injectHeaders } from "./inject-headers.js";
import { INJECTED_CREDENTIAL_PLACEHOLDER } from "@operon/core";

describe("injectHeaders", () => {
  const creds = { "claude-code": "real-anthropic-token", codex: "real-openai-token" };

  it("swaps the auth header on the harness's own API host", () => {
    const out = injectHeaders(
      new Headers({ authorization: `Bearer ${INJECTED_CREDENTIAL_PLACEHOLDER}` }),
      "api.anthropic.com",
      creds
    );
    expect(out.get("authorization")).toBe("Bearer real-anthropic-token");
  });

  it("injects the codex credential on its own host", () => {
    const out = injectHeaders(new Headers(), "api.openai.com", creds);
    expect(out.get("authorization")).toBe("Bearer real-openai-token");
  });

  it("leaves every other host untouched (no credential ever leaks elsewhere)", () => {
    const original = new Headers({ authorization: "Bearer whatever" });
    const out = injectHeaders(original, "example.com", creds);
    expect(out.get("authorization")).toBe("Bearer whatever");
  });

  it("does not inject when the credential is absent", () => {
    const out = injectHeaders(new Headers({ authorization: "Bearer placeholder" }), "api.anthropic.com", {});
    expect(out.get("authorization")).toBe("Bearer placeholder");
  });
});
