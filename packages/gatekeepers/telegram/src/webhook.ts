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
  | { kind: "operator_note"; text: string }
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

  return { kind: "operator_note", text };
}
