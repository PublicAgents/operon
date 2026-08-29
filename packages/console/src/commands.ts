/**
 * Slash commands for the channel composer, mirroring the Telegram
 * webhook's command set (spec 0005 §5: the console is a transport over
 * the same channel, so the operator's muscle memory carries over).
 * Pure logic, spec-tested; the composer executes the parsed intent
 * against the same registry tools every other surface uses.
 *
 * A leading slash NEVER broadcasts: an unknown or malformed command is
 * reported locally, so a typo cannot land in every agent's context.
 */

const AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface CommandSpec {
  name: string;
  /** Argument placeholders, for usage text and completion. */
  args: string[];
  description: string;
  /** Which arg positions complete to agent ids (0-based). */
  agentArg?: number;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "wake", args: ["<agent-id>"], description: "wake an agent now", agentArg: 0 },
  {
    name: "tell",
    args: ["<agent-id>", "<message>"],
    description: "message one agent (delivered on its next wake)",
    agentArg: 0
  },
  {
    name: "approve",
    args: ["<agent-id>", "<held-id>"],
    description: "release a held email send",
    agentArg: 0
  },
  {
    name: "reject",
    args: ["<agent-id>", "<held-id>"],
    description: "discard a held email send",
    agentArg: 0
  },
  {
    name: "disable",
    args: ["<agent-id>"],
    description: "KILL SWITCH: refuse all wakes and kill a wake in flight",
    agentArg: 0
  },
  { name: "enable", args: ["<agent-id>"], description: "lift the kill switch", agentArg: 0 },
  { name: "help", args: [], description: "list these commands" }
];

export function usage(spec: CommandSpec): string {
  return ["/" + spec.name, ...spec.args].join(" ");
}

export type ParsedCommand =
  | { kind: "message" }
  | { kind: "help" }
  | { kind: "wake" | "disable" | "enable"; agentId: string }
  | { kind: "tell"; agentId: string; text: string }
  | { kind: "approve" | "reject"; agentId: string; heldId: string }
  | { kind: "invalid"; reason: string };

export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "message" };
  const [head, ...rest] = text.slice(1).split(/\s+/);
  const name = (head ?? "").toLowerCase();
  const spec = COMMANDS.find(candidate => candidate.name === name);
  if (!spec) {
    return {
      kind: "invalid",
      reason: `unknown command /${name}; /help lists the commands (a leading slash never broadcasts)`
    };
  }
  const bad = (why: string): ParsedCommand => ({
    kind: "invalid",
    reason: `${why}; usage: ${usage(spec)}`
  });
  switch (spec.name) {
    case "help":
      return { kind: "help" };
    case "wake":
    case "disable":
    case "enable": {
      const agentId = rest[0] ?? "";
      if (!AGENT_ID.test(agentId)) return bad("an agent id is required");
      if (rest.length > 1) return bad("too many arguments");
      return { kind: spec.name, agentId };
    }
    case "tell": {
      const agentId = rest[0] ?? "";
      if (!AGENT_ID.test(agentId)) return bad("an agent id is required");
      const message = text.slice(text.indexOf(agentId) + agentId.length).trim();
      if (!message) return bad("a message is required");
      return { kind: "tell", agentId, text: message };
    }
    case "approve":
    case "reject": {
      const agentId = rest[0] ?? "";
      const heldId = rest[1] ?? "";
      if (!AGENT_ID.test(agentId)) return bad("an agent id is required");
      if (!heldId) return bad("a held id is required");
      if (rest.length > 2) return bad("too many arguments");
      return { kind: spec.name, agentId, heldId };
    }
    default:
      return bad("unhandled command");
  }
}

export interface Completion {
  /** The full replacement draft when this suggestion is chosen. */
  replace: string;
  label: string;
  detail: string;
}

/**
 * Completions for the composer, Claude Code style: "/" opens the
 * command list filtered by prefix; a command whose next argument is an
 * agent id completes agent ids.
 */
export function completions(draft: string, agents: readonly string[]): Completion[] {
  if (!draft.startsWith("/") || draft.includes("\n")) return [];
  const body = draft.slice(1);
  const firstSpace = body.search(/\s/);
  if (firstSpace === -1) {
    // Completing the command name itself.
    return COMMANDS.filter(spec => spec.name.startsWith(body.toLowerCase())).map(spec => ({
      replace: spec.args.length > 0 ? `/${spec.name} ` : `/${spec.name}`,
      label: usage(spec),
      detail: spec.description
    }));
  }
  const name = body.slice(0, firstSpace).toLowerCase();
  const spec = COMMANDS.find(candidate => candidate.name === name);
  if (!spec || spec.agentArg === undefined) return [];
  const argText = body.slice(firstSpace).replace(/^\s+/, "");
  // Only the FIRST argument completes to an agent id (agentArg 0 for
  // every current command); once it is followed by a space, the
  // operator is past it.
  if (/\s/.test(argText)) return [];
  return agents
    .filter(id => id.startsWith(argText))
    .map(id => ({
      replace: `/${spec.name} ${id}${spec.args.length > 1 ? " " : ""}`,
      label: id,
      detail: usage(spec)
    }));
}
