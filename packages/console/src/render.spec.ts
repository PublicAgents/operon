import { describe, expect, it } from "vitest";
import { coerceText, renderLine, splitLines, stripAnsi } from "./render.js";

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

  it("renders Codex exec JSONL: messages, commands, files, MCP calls, and turn usage (spec 0010)", () => {
    expect(renderLine(JSON.stringify({ type: "thread.started", thread_id: "t1" }))).toEqual([
      { kind: "session", text: "session ready (codex)" }
    ]);
    expect(renderLine(JSON.stringify({ type: "turn.started" }))).toBeNull();
    expect(
      renderLine(
        JSON.stringify({ type: "item.started", item: { id: "i1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } })
      )
    ).toEqual([{ kind: "tool", text: "shell(bash -lc ls)" }]);
    expect(
      renderLine(
        JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", exit_code: 0, aggregated_output: "a\nb" } })
      )
    ).toEqual([{ kind: "tool-result", text: "exit 0: a\nb" }]);
    expect(renderLine(JSON.stringify({ type: "item.completed", item: { id: "i3", type: "agent_message", text: "done" } }))).toEqual([
      { kind: "assistant", text: "done" }
    ]);
    expect(
      renderLine(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "JOURNAL.md", kind: "update" }] } }))
    ).toEqual([{ kind: "tool", text: "files: update JOURNAL.md" }]);
    expect(renderLine(JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "livevariant", tool: "list_tests" } }))).toEqual([
      { kind: "tool", text: "livevariant.list_tests()" }
    ]);
    expect(
      renderLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } }))
    ).toEqual([{ kind: "result", text: "turn done: 24763 in (24448 cached), 122 out" }]);
    expect(renderLine(JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }))).toEqual([
      { kind: "result", text: "turn.failed: rate limited" }
    ]);
  });

  it("renders a malformed JSON-looking line as plain text", () => {
    expect(renderLine("{not json")).toEqual([{ kind: "plain", text: "{not json" }]);
  });
});

describe("coerceText", () => {
  it("passes strings through and renders objects as JSON (the events regression)", () => {
    expect(coerceText("plain")).toBe("plain");
    expect(coerceText({ operator: "op", tool: "wake" })).toBe('{"operator":"op","tool":"wake"}');
    expect(coerceText(null)).toBe("");
    expect(coerceText(undefined)).toBe("");
    expect(coerceText(42)).toBe("42");
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
