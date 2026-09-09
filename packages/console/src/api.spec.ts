import { describe, expect, it } from "vitest";
import { ApiError, apiErrorMessage } from "./api.js";

describe("a refused decision's message", () => {
  it("carries the refusal's detail beside its name, never the name alone when there is more to say", () => {
    expect(apiErrorMessage(502, { error: "send_failed", detail: "Error: destination address is not a verified address" })).toBe(
      "send_failed: Error: destination address is not a verified address"
    );
    expect(apiErrorMessage(403, { error: "forbidden" })).toBe("forbidden");
    expect(apiErrorMessage(500, "boom")).toBe("request failed (500)");
    expect(new ApiError(502, { error: "send_failed", detail: "x" }).message).toBe("send_failed: x");
  });
});
