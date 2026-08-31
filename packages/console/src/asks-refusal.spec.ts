import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { refusalFrom, refusalMessage } from "./asks-refusal.js";

describe("ask refusals", () => {
  const moved = new ApiError(409, { ok: false, error: "ask_state_moved", state: "retracted" });

  it("names where the gatekeeper said the ask went, before the refresh lands", () => {
    // The window between the refusal and the refreshed list: the card
    // still holds the old ask, so the message must come from the body.
    const refusal = refusalFrom(moved, "allowed", "open");
    expect(refusalMessage(refusal, "open")).toBe(
      "marking this allow was refused: the ask is now retracted, and nothing was overwritten"
    );
  });

  it("follows the ask once it moves again, rather than repeating itself", () => {
    // The finding this guards: a card that keeps polling must never go
    // on claiming a state the ask has since left.
    const refusal = refusalFrom(moved, "allowed", "open");
    expect(refusalMessage(refusal, "closed")).toContain("the ask is now closed");
  });

  it("says a terminal ask cannot move", () => {
    const terminal = new ApiError(409, { ok: false, error: "ask_terminal", state: "closed" });
    const refusal = refusalFrom(terminal, "declined", "acknowledged");
    expect(refusalMessage(refusal, "closed")).toContain("the ask is now closed");
  });

  it("does not invent a move when the state is unchanged", () => {
    const bare = new ApiError(409, { ok: false, error: "ask_state_moved" });
    const refusal = refusalFrom(bare, "allowed", "open");
    expect(refusalMessage(refusal, "open")).toBe(
      "marking this allow was refused; the ask is still open"
    );
  });

  it("keeps other failures verbatim, including replies", () => {
    const missing = new ApiError(404, { error: "ask_not_found" });
    expect(refusalMessage(refusalFrom(missing, "reply", "open"), "open")).toBe(
      "your reply was refused: ask_not_found"
    );
    expect(refusalMessage(refusalFrom(new TypeError("offline"), "reply", "open"), "open")).toBe(
      "your reply was refused: the request did not go through"
    );
  });
});
