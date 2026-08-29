/**
 * Pure transcript rendering (ported from tools/tail-wake.mjs, unit
 * tested): harness stream-json lines become readable entries, chassis
 * [operon] lines pass through. Everything returned here is TEXT and is
 * rendered as text nodes only; ANSI/terminal escapes are stripped
 * before anything reaches the DOM (spec 0005 §8).
 */

export interface RenderedLine {
  kind: "session" | "assistant" | "tool" | "tool-result" | "result" | "plain";
  text: string;
}

/**
 * CSI/OSC/single-char escapes. A transcript is mind output; a terminal
 * escape can spoof or hide content in anything that treats it as ANSI,
 * so none survive to the DOM.
 */
const ANSI_PATTERN = new RegExp(
  ["\\u001B\\[[0-9;?]*[ -/]*[@-~]", "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)", "\\u001B[@-Z\\\\-_]"].join("|"),
  "g"
);
// eslint-disable-next-line no-control-regex -- stripping control chars is the point
const CONTROL_PATTERN = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

function trim(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  model?: string;
  num_turns?: number;
  message?: { content?: StreamBlock[] };
}

interface StreamBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

/** Render one transcript line; null when the line is harness bookkeeping. */
export function renderLine(line: string): RenderedLine[] | null {
  const clean = stripAnsi(line);
  if (!clean.startsWith("{")) {
    return clean.trim() === "" ? null : [{ kind: "plain", text: clean }];
  }
  let event: StreamEvent;
  try {
    event = JSON.parse(clean) as StreamEvent;
  } catch {
    return [{ kind: "plain", text: clean }];
  }
  switch (event.type) {
    case "rate_limit_event":
      return null;
    case "system":
      return event.subtype === "init"
        ? [{ kind: "session", text: `session ready (model ${event.model ?? "?"})` }]
        : null;
    case "assistant": {
      const parts: RenderedLine[] = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          parts.push({ kind: "assistant", text: stripAnsi(block.text) });
        }
        if (block.type === "tool_use") {
          parts.push({ kind: "tool", text: stripAnsi(`${block.name}(${trim(block.input, 160)})`) });
        }
      }
      return parts.length ? parts : null;
    }
    case "user": {
      const parts: RenderedLine[] = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_result") {
          const body = Array.isArray(block.content)
            ? (block.content as { text?: string }[]).map(inner => inner.text ?? "").join(" ")
            : block.content;
          parts.push({ kind: "tool-result", text: stripAnsi(trim(body ?? "", 200)) });
        }
      }
      return parts.length ? parts : null;
    }
    case "result":
      return [
        {
          kind: "result",
          text: `session result: ${event.subtype ?? "?"}${event.num_turns ? ` (${event.num_turns} turns)` : ""}`
        }
      ];
    default:
      return [{ kind: "plain", text: trim(clean, 300) }];
  }
}

/**
 * Split chunk text into whole lines, carrying the partial tail (chunk
 * boundaries are byte-aligned, not line-aligned).
 */
export function splitLines(carry: string, text: string): { lines: string[]; carry: string } {
  const combined = carry + text;
  const lines = combined.split("\n");
  const nextCarry = lines.pop() ?? "";
  return { lines, carry: nextCarry };
}
