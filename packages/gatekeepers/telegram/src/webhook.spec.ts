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

  it("rejects malformed wake targets as plain notes", () => {
    const action = triageUpdate(
      { message: { chat: { id: 12345 }, text: "/wake ../etc" } },
      OPERATOR
    );
    expect(action.kind).toBe("operator_note");
  });

  it("treats operator text as a note", () => {
    const action = triageUpdate(
      { message: { chat: { id: 12345 }, text: "looking good" } },
      OPERATOR
    );
    expect(action).toEqual({ kind: "operator_note", text: "looking good" });
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
