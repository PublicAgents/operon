import { describe, expect, it } from "vitest";
import { renderLine, splitLines, stripAnsi } from "./render.js";

const ESC = "\u001B";

describe("stripAnsi", () => {
  it("removes CSI, OSC, and bare escapes plus control characters", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`${ESC}]0;title\u0007text`)).toBe("text");
    expect(stripAnsi(`a${ESC}Mb\u007Fc`)).toBe("abc");
  });

  it("keeps newlines and tabs", () => {
    expect(stripAnsi("a\n\tb")).toBe("a\n\tb");
  });
});

describe("renderLine", () => {
  it("passes chassis lines through and drops blank ones", () => {
    expect(renderLine("[operon] presleep ok")).toEqual([
      { kind: "plain", text: "[operon] presleep ok" }
    ]);
    expect(renderLine("   ")).toBeNull();
  });

  it("renders assistant text and tool use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "thinking about it" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } }
        ]
      }
    });
    expect(renderLine(line)).toEqual([
      { kind: "assistant", text: "thinking about it" },
      { kind: "tool", text: 'Bash({"command":"ls"})' }
    ]);
  });

  it("renders results and hides rate-limit bookkeeping", () => {
    expect(renderLine(JSON.stringify({ type: "result", subtype: "success", num_turns: 4 }))).toEqual([
      { kind: "result", text: "session result: success (4 turns)" }
    ]);
    expect(renderLine(JSON.stringify({ type: "rate_limit_event" }))).toBeNull();
  });

  it("strips escapes hidden inside stream-json text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `safe${ESC}[2Jwiped` }] }
    });
    expect(renderLine(line)).toEqual([{ kind: "assistant", text: "safewiped" }]);
  });

  it("renders a malformed JSON-looking line as plain text", () => {
    expect(renderLine("{not json")).toEqual([{ kind: "plain", text: "{not json" }]);
  });
});

describe("splitLines", () => {
  it("carries the partial trailing line across chunks", () => {
    const first = splitLines("", '{"a":1}\n{"b"');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.carry).toBe('{"b"');
    const second = splitLines(first.carry, ":2}\n");
    expect(second.lines).toEqual(['{"b":2}']);
    expect(second.carry).toBe("");
  });
});
