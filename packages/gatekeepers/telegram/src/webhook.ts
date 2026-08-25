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
  callback_query?: {
    id?: string;
    data?: string;
    message?: { chat?: { id?: number | string }; message_id?: number };
  };
}

export type WebhookAction =
  | { kind: "ignored"; chatId: string; text: string }
  | { kind: "wake"; agentId: string }
  | { kind: "tell"; agentId: string; text: string }
  | { kind: "toggle"; agentId: string; disabled: boolean }
  | { kind: "approve"; agentId: string; heldId: string; approve: boolean }
  | {
      kind: "callback";
      callbackId: string;
      data: string;
      messageId?: number;
    }
  | { kind: "help" }
  | { kind: "broadcast"; text: string }
  | { kind: "unknown_command"; text: string }
  | { kind: "noop" };

export function triageUpdate(update: TelegramUpdate, operatorChatId: string): WebhookAction {
  // Button presses arrive as callback queries; identity is still the chat.
  const callback = update.callback_query;
  if (callback) {
    const cbChat = callback.message?.chat?.id;
    if (cbChat === undefined || String(cbChat) !== operatorChatId) {
      return { kind: "ignored", chatId: String(cbChat ?? "unknown"), text: callback.data ?? "" };
    }
    if (!callback.id || !callback.data) return { kind: "noop" };
    return {
      kind: "callback",
      callbackId: callback.id,
      data: callback.data,
      messageId: callback.message?.message_id
    };
  }

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

  const approveCommand = /^\/(approve|reject)\s+([a-z0-9-]+)\s+([a-f0-9-]{8,64})\s*$/.exec(text);
  if (approveCommand) {
    return {
      kind: "approve",
      agentId: approveCommand[2],
      heldId: approveCommand[3],
      approve: approveCommand[1] === "approve"
    };
  }

  const toggleCommand = /^\/(disable|enable)\s+([a-z0-9-]+)\s*$/.exec(text);
  if (toggleCommand) {
    return { kind: "toggle", agentId: toggleCommand[2], disabled: toggleCommand[1] === "disable" };
  }

  if (/^\/help\s*$/.test(text)) return { kind: "help" };

  // Any other slash input is a command typo, not a message for the agents.
  if (text.startsWith("/")) return { kind: "unknown_command", text };

  // A plain message in the operator chat goes to every agent.
  if (text.trim().length > 0) return { kind: "broadcast", text: text.trim() };
  return { kind: "noop" };
}
