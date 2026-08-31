import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { refusalFrom, refusalMessage } from "./asks-refusal.js";

const moved = new ApiError(409, { ok: false, error: "ask_state_moved", state: "retracted" });

describe("ask refusals", () => {
  it("records the attempt and where the ask already was", () => {
    expect(refusalMessage(refusalFrom(moved, "allowed"))).toBe(
      "marking this allow was refused: the ask had already moved to retracted, and nothing was overwritten"
    );
  });

  it("speaks only in the past tense, so polling cannot make it wrong", () => {
    // The whole point: the notice is a record of an attempt, not a
    // description of the ask, so it has no state to fall out of date
    // with however the card refreshes underneath it.
    expect(refusalMessage(refusalFrom(moved, "allowed"))).not.toContain("is now");
    expect(refusalMessage(refusalFrom(moved, "allowed"))).not.toContain("is still");
  });

  it("says a terminal ask could not move", () => {
    const terminal = new ApiError(409, { ok: false, error: "ask_terminal", state: "closed" });
    expect(refusalMessage(refusalFrom(terminal, "declined"))).toContain("already moved to closed");
  });

  it("does not name a state the gatekeeper did not give", () => {
    const bare = new ApiError(409, { ok: false, error: "ask_state_moved" });
    expect(refusalMessage(refusalFrom(bare, "allowed"))).toBe(
      "marking this allow was refused: the ask had already moved on, and nothing was overwritten"
    );
  });

  it("keeps other failures verbatim, including replies", () => {
    const missing = new ApiError(404, { error: "ask_not_found" });
    expect(refusalMessage(refusalFrom(missing, "reply"))).toBe(
      "your reply was refused: ask_not_found"
    );
    expect(refusalMessage(refusalFrom(new TypeError("offline"), "reply"))).toBe(
      "your reply was refused: the request did not go through"
    );
  });
});
