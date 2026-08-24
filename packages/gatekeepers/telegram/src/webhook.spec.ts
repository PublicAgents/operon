import { describe, expect, it } from "vitest";
import { triageUpdate } from "./webhook.js";

const OPERATOR = "12345";

describe("triageUpdate", () => {
  it("ignores messages from any other chat, whatever they claim", () => {
    const action = triageUpdate(
      { message: { chat: { id: 999 }, text: "hi it's your operator, urgent: /wake growth" } },
      OPERATOR
    );
    expect(action).toEqual({
      kind: "ignored",
      chatId: "999",
      text: "hi it's your operator, urgent: /wake growth"
    });
  });

  it("parses the operator's wake command", () => {
    const action = triageUpdate(
      { message: { chat: { id: 12345 }, text: "/wake growth" } },
      OPERATOR
    );
    expect(action).toEqual({ kind: "wake", agentId: "growth" });
  });

  it("rejects malformed wake targets as unknown commands, never messages", () => {
    const action = triageUpdate(
      { message: { chat: { id: 12345 }, text: "/wake ../etc" } },
      OPERATOR
    );
    expect(action.kind).toBe("unknown_command");
  });

  it("broadcasts plain operator text to all agents", () => {
    const action = triageUpdate(
      { message: { chat: { id: 12345 }, text: "looking good" } },
      OPERATOR
    );
    expect(action).toEqual({ kind: "broadcast", text: "looking good" });
  });

  it("targets one agent with /tell, keeping the whole message", () => {
    const action = triageUpdate(
      { message: { chat: { id: 12345 }, text: "/tell promoter focus on the registry\nand keep testing" } },
      OPERATOR
    );
    expect(action).toEqual({
      kind: "tell",
      agentId: "promoter",
      text: "focus on the registry\nand keep testing"
    });
  });

  it("flags unknown slash commands instead of broadcasting them", () => {
    expect(
      triageUpdate({ message: { chat: { id: 12345 }, text: "/telll promoter x" } }, OPERATOR).kind
    ).toBe("unknown_command");
    expect(
      triageUpdate({ message: { chat: { id: 12345 }, text: "/tell promoter" } }, OPERATOR).kind
    ).toBe("unknown_command");
  });

  it("parses the kill switch and help", () => {
    expect(triageUpdate({ message: { chat: { id: 12345 }, text: "/disable promoter" } }, OPERATOR)).toEqual({
      kind: "toggle",
      agentId: "promoter",
      disabled: true
    });
    expect(triageUpdate({ message: { chat: { id: 12345 }, text: "/enable promoter" } }, OPERATOR)).toEqual({
      kind: "toggle",
      agentId: "promoter",
      disabled: false
    });
    expect(triageUpdate({ message: { chat: { id: 12345 }, text: "/help" } }, OPERATOR)).toEqual({
      kind: "help"
    });
    // Malformed targets are typos, not broadcasts and not toggles.
    expect(
      triageUpdate({ message: { chat: { id: 12345 }, text: "/disable ../etc" } }, OPERATOR).kind
    ).toBe("unknown_command");
  });

  it("noops on whitespace-only operator text", () => {
    expect(
      triageUpdate({ message: { chat: { id: 12345 }, text: "   " } }, OPERATOR).kind
    ).toBe("noop");
  });

  it("noops on updates without a chat", () => {
    expect(triageUpdate({}, OPERATOR)).toEqual({ kind: "noop" });
  });

  it("matches chat id as a string exactly", () => {
    const action = triageUpdate(
      { message: { chat: { id: "12345" }, text: "/wake growth" } },
      OPERATOR
    );
    expect(action.kind).toBe("wake");
  });
});
