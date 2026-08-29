import { describe, expect, it } from "vitest";
import { COMMANDS, completions, parseCommand, usage } from "./commands.js";

describe("parseCommand", () => {
  it("treats plain text as a message and any slash as a command attempt", () => {
    expect(parseCommand("hello agents")).toEqual({ kind: "message" });
    expect(parseCommand("/help")).toEqual({ kind: "help" });
    // The regression that motivated this module: /help must never
    // broadcast, and neither may a typo'd command.
    expect(parseCommand("/hlep").kind).toBe("invalid");
  });

  it("parses the agent control commands", () => {
    expect(parseCommand("/wake promoter")).toEqual({ kind: "wake", agentId: "promoter" });
    expect(parseCommand("/disable promoter")).toEqual({ kind: "disable", agentId: "promoter" });
    expect(parseCommand("/enable promoter")).toEqual({ kind: "enable", agentId: "promoter" });
    expect(parseCommand("/wake")).toMatchObject({ kind: "invalid" });
    expect(parseCommand("/wake Not-Valid")).toMatchObject({ kind: "invalid" });
    expect(parseCommand("/wake promoter extra")).toMatchObject({ kind: "invalid" });
  });

  it("parses /tell with the message intact", () => {
    expect(parseCommand("/tell promoter check the deploy  now")).toEqual({
      kind: "tell",
      agentId: "promoter",
      text: "check the deploy  now"
    });
    expect(parseCommand("/tell promoter")).toMatchObject({ kind: "invalid" });
  });

  it("parses held decisions", () => {
    expect(parseCommand("/approve promoter abc-123")).toEqual({
      kind: "approve",
      agentId: "promoter",
      heldId: "abc-123"
    });
    expect(parseCommand("/reject promoter abc-123")).toEqual({
      kind: "reject",
      agentId: "promoter",
      heldId: "abc-123"
    });
    expect(parseCommand("/approve promoter")).toMatchObject({ kind: "invalid" });
  });

  it("includes usage in every invalid reason", () => {
    const invalid = parseCommand("/wake");
    expect(invalid.kind).toBe("invalid");
    if (invalid.kind === "invalid") expect(invalid.reason).toContain("/wake <agent-id>");
  });
});

describe("completions", () => {
  const agents = ["promoter", "prior-two"];

  it("lists every command on a bare slash and filters by prefix", () => {
    expect(completions("/", agents).map(c => c.label)).toEqual(COMMANDS.map(usage));
    expect(completions("/wa", agents).map(c => c.replace)).toEqual(["/wake "]);
    expect(completions("/h", agents)).toEqual([
      { replace: "/help", label: "/help", detail: "list these commands" }
    ]);
  });

  it("completes agent ids as the first argument", () => {
    expect(completions("/wake p", agents).map(c => c.replace)).toEqual([
      "/wake promoter",
      "/wake prior-two"
    ]);
    expect(completions("/tell prom", agents).map(c => c.replace)).toEqual(["/tell promoter "]);
  });

  it("offers nothing for plain text, later arguments, or multiline drafts", () => {
    expect(completions("hello", agents)).toEqual([]);
    expect(completions("/wake promoter ", agents)).toEqual([]);
    expect(completions("/tell promoter hi", agents)).toEqual([]);
    expect(completions("/wake\np", agents)).toEqual([]);
  });
});
