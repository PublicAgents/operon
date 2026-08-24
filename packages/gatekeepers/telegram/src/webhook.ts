/**
 * Pure webhook triage. Identity is the chat id, nothing else: display names,
 * usernames, and "it's your operator" claims from any other chat are not the
 * operator. Everything that is not the operator is recorded and ignored.
 */

export interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
}

export type WebhookAction =
  | { kind: "ignored"; chatId: string; text: string }
  | { kind: "wake"; agentId: string }
  | { kind: "tell"; agentId: string; text: string }
  | { kind: "broadcast"; text: string }
  | { kind: "unknown_command"; text: string }
  | { kind: "noop" };

export function triageUpdate(update: TelegramUpdate, operatorChatId: string): WebhookAction {
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text ?? "";
  if (chatId === undefined) return { kind: "noop" };

  if (String(chatId) !== operatorChatId) {
    return { kind: "ignored", chatId: String(chatId), text };
  }

  const wakeCommand = /^\/wake\s+([a-z0-9-]+)\s*$/.exec(text);
  if (wakeCommand) return { kind: "wake", agentId: wakeCommand[1] };

  const tellCommand = /^\/tell\s+([a-z0-9-]+)\s+([\s\S]+)$/.exec(text);
  if (tellCommand) return { kind: "tell", agentId: tellCommand[1], text: tellCommand[2].trim() };

  // Any other slash input is a command typo, not a message for the agents.
  if (text.startsWith("/")) return { kind: "unknown_command", text };

  // A plain message in the operator chat goes to every agent.
  if (text.trim().length > 0) return { kind: "broadcast", text: text.trim() };
  return { kind: "noop" };
}
