/**
 * Pure transcript rendering (ported from tools/tail-wake.mjs, unit
 * tested): harness stream lines become readable entries (Claude Code's
 * stream-json and Codex's exec JSONL, spec 0010), chassis [operon]
 * lines pass through. Everything returned here is TEXT and is
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

/**
 * Anything the API hands us becomes readable text, never a crash: the
 * chronicle's detail fields are JSON objects, and an uncaught render
 * error unmounts the whole console.
 */
export function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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
  // Codex exec JSONL (spec 0010 §4): thread/turn events and items.
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  exit_code?: number;
  aggregated_output?: string;
  server?: string;
  tool?: string;
  query?: string;
  changes?: { path?: string; kind?: string }[];
  items?: { text?: string; completed?: boolean }[];
}

/** One Codex item, started or completed, as a transcript entry. */
function renderCodexItem(item: CodexItem, completed: boolean): RenderedLine[] | null {
  switch (item.type) {
    case "agent_message":
      return completed && item.text?.trim() ? [{ kind: "assistant", text: stripAnsi(item.text) }] : null;
    case "reasoning":
      return completed && item.text?.trim() ? [{ kind: "assistant", text: stripAnsi(trim(item.text, 300)) }] : null;
    case "command_execution": {
      if (!completed) return [{ kind: "tool", text: stripAnsi(`shell(${trim(item.command ?? "", 160)})`) }];
      const exit = item.exit_code === undefined ? item.status ?? "" : `exit ${item.exit_code}`;
      const output = item.aggregated_output ? `: ${trim(item.aggregated_output, 200)}` : "";
      return [{ kind: "tool-result", text: stripAnsi(`${exit}${output}`) }];
    }
    case "file_change": {
      if (!completed) return null;
      const files = (item.changes ?? []).map(change => `${change.kind ?? "edit"} ${change.path ?? "?"}`).join(", ");
      return [{ kind: "tool", text: stripAnsi(`files: ${trim(files, 200)}`) }];
    }
    case "mcp_tool_call":
      return completed
        ? [{ kind: "tool-result", text: stripAnsi(`${item.server ?? "?"}.${item.tool ?? "?"}: ${item.status ?? "done"}`) }]
        : [{ kind: "tool", text: stripAnsi(`${item.server ?? "?"}.${item.tool ?? "?"}()`) }];
    case "web_search":
      return completed ? [{ kind: "tool", text: stripAnsi(`web_search(${trim(item.query ?? "", 160)})`) }] : null;
    case "todo_list":
      return completed
        ? [{ kind: "plain", text: stripAnsi(`plan: ${trim((item.items ?? []).map(entry => `${entry.completed ? "x" : " "} ${entry.text ?? ""}`).join("; "), 300)}`) }]
        : null;
    default:
      return completed ? [{ kind: "plain", text: trim(JSON.stringify(item), 300) }] : null;
  }
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
    // Codex exec JSONL (spec 0010 §4).
    case "thread.started":
      return [{ kind: "session", text: "session ready (codex)" }];
    case "turn.started":
      return null;
    case "turn.completed": {
      const usage = event.usage;
      return usage
        ? [
            {
              kind: "result",
              text: `turn done: ${usage.input_tokens ?? 0} in (${usage.cached_input_tokens ?? 0} cached), ${usage.output_tokens ?? 0} out`
            }
          ]
        : null;
    }
    case "turn.failed":
    case "error": {
      const detail = typeof event.error === "string" ? event.error : event.error?.message;
      return [{ kind: "result", text: stripAnsi(`${event.type}: ${trim(detail ?? "", 300)}`) }];
    }
    case "item.started":
      return event.item ? renderCodexItem(event.item, false) : null;
    case "item.completed":
      return event.item ? renderCodexItem(event.item, true) : null;
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
