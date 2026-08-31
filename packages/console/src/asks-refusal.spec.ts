import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { askVersion, refusalFrom, refusalMessage, type AskState } from "./asks-refusal.js";

/** The card as the operator saw it when they pressed the button. */
const seen = { state: "open" as AskState, version: 2 };
const moved = new ApiError(409, { ok: false, error: "ask_state_moved", state: "retracted" });

describe("ask refusals", () => {
  it("names where the gatekeeper said the ask went, before the refresh lands", () => {
    // The window between the 409 and the refreshed list: the card still
    // holds the stale ask, so the message must come from the body.
    const refusal = refusalFrom(moved, "allowed", seen);
    expect(refusalMessage(refusal, { state: "open", version: 2 })).toBe(
      "marking this allow was refused: the ask is now retracted, and nothing was overwritten"
    );
  });

  it("follows the ask once the refresh lands", () => {
    const refusal = refusalFrom(moved, "allowed", seen);
    expect(refusalMessage(refusal, { state: "retracted", version: 3 })).toContain(
      "the ask is now retracted"
    );
  });

  it("keeps following the ask as it moves on", () => {
    // A card that keeps polling must never go on describing a state the
    // ask has since left.
    const refusal = refusalFrom(moved, "allowed", { state: "open", version: 2 });
    expect(refusalMessage(refusal, { state: "closed", version: 4 })).toContain(
      "the ask is now closed"
    );
  });

  it("does not revive the reported state when the ask comes back around", () => {
    // States repeat: acknowledged to allowed and back again. Freshness
    // is the version, never state equality, or this would quote a body
    // that went out of date two transitions ago.
    const refusal = refusalFrom(
      new ApiError(409, { ok: false, error: "ask_state_moved", state: "allowed" }),
      "allowed",
      { state: "acknowledged", version: 2 }
    );
    expect(refusalMessage(refusal, { state: "acknowledged", version: 5 })).toBe(
      "marking this allow was refused; the ask is still acknowledged"
    );
  });

  it("counts a version per change, so same-instant changes still differ", () => {
    // Two changes can land in the same millisecond; the thread cannot
    // gain two entries and stay the same length.
    const before = { thread: [{ seq: 1 }, { seq: 2 }] };
    const after = { thread: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] };
    expect(askVersion(before)).toBe(2);
    expect(askVersion(after)).toBe(3);
    const refusal = refusalFrom(moved, "allowed", { state: "open", version: askVersion(before) });
    expect(refusalMessage(refusal, { state: "retracted", version: askVersion(after) })).toContain(
      "the ask is now retracted"
    );
  });

  it("says a terminal ask cannot move", () => {
    const terminal = new ApiError(409, { ok: false, error: "ask_terminal", state: "closed" });
    const refusal = refusalFrom(terminal, "declined", { state: "acknowledged", version: 2 });
    expect(refusalMessage(refusal, { state: "acknowledged", version: 2 })).toContain(
      "the ask is now closed"
    );
  });

  it("does not invent a move when the gatekeeper named no state", () => {
    const bare = new ApiError(409, { ok: false, error: "ask_state_moved" });
    const refusal = refusalFrom(bare, "allowed", seen);
    expect(refusalMessage(refusal, { state: "open", version: 2 })).toBe(
      "marking this allow was refused; the ask is still open"
    );
  });

  it("keeps other failures verbatim, including replies", () => {
    const missing = new ApiError(404, { error: "ask_not_found" });
    expect(refusalMessage(refusalFrom(missing, "reply", seen), seen)).toBe(
      "your reply was refused: ask_not_found"
    );
    expect(refusalMessage(refusalFrom(new TypeError("offline"), "reply", seen), seen)).toBe(
      "your reply was refused: the request did not go through"
    );
  });
});
