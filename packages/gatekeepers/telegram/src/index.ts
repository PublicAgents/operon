import { errorResponse, json, requireBearer, Ledger } from "@operon/worker-kit";
import { triageUpdate, type TelegramUpdate } from "./webhook.js";

export { Ledger };
export { triageUpdate, type TelegramUpdate, type WebhookAction } from "./webhook.js";

interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  NOTIFY_TOKEN?: string;
  WAKE_TRIGGER_TOKEN?: string;
  OPERATOR_CHAT_ID?: string;
  LEDGER: DurableObjectNamespace<Ledger>;
  SCHEDULER?: Fetcher;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("telegram"));
}

async function sendToOperator(env: Env, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.OPERATOR_CHAT_ID) return false;
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.OPERATOR_CHAT_ID, text })
    }
  );
  return response.ok;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    await ledger(env).append("webhook_denied", { reason: "bad_secret_token" });
    return errorResponse(401, "invalid_webhook_secret");
  }
  if (!env.OPERATOR_CHAT_ID) {
    return errorResponse(500, "operator_chat_unconfigured");
  }

  const update = (await request.json()) as TelegramUpdate;
  const action = triageUpdate(update, env.OPERATOR_CHAT_ID);

  switch (action.kind) {
    case "noop":
      return json({ ok: true });
    case "ignored":
      await ledger(env).append("ignored_message", {
        chatId: action.chatId,
        text: action.text.slice(0, 500)
      });
      return json({ ok: true });
    case "wake": {
      if (!env.SCHEDULER || !env.WAKE_TRIGGER_TOKEN) {
        await ledger(env).append("wake_command_failed", {
          agentId: action.agentId,
          reason: "scheduler_unbound"
        });
        await sendToOperator(env, `cannot wake ${action.agentId}: scheduler not bound`);
        return json({ ok: true });
      }
      const response = await env.SCHEDULER.fetch(
        `https://scheduler.internal/wake/${action.agentId}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${env.WAKE_TRIGGER_TOKEN}` }
        }
      );
      const result = await response.text();
      await ledger(env).append("wake_command", {
        agentId: action.agentId,
        status: response.status,
        result: result.slice(0, 500)
      });
      await sendToOperator(env, `wake ${action.agentId}: ${result}`);
      return json({ ok: true });
    }
    case "operator_note":
      await ledger(env).append("operator_message", { text: action.text.slice(0, 500) });
      if (action.text.startsWith("/")) {
        await sendToOperator(env, "commands: /wake <agent-id>");
      }
      return json({ ok: true });
  }
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.NOTIFY_TOKEN);
  if (denied) {
    await ledger(env).append("notify_denied", { status: denied.status });
    return denied;
  }
  const { text } = (await request.json()) as { text?: string };
  if (typeof text !== "string" || text.length === 0) {
    await ledger(env).append("notify_failed", { reason: "empty_text" });
    return errorResponse(400, "empty_text");
  }
  const delivered = await sendToOperator(env, text.slice(0, 4000));
  await ledger(env).append("notify", { delivered, length: text.length });
  if (!delivered) return errorResponse(502, "telegram_send_failed");
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }
    if (url.pathname === "/notify" && request.method === "POST") {
      return handleNotify(request, env);
    }
    if (url.pathname === "/ledger" && request.method === "GET") {
      const denied = requireBearer(request, env.NOTIFY_TOKEN);
      if (denied) return denied;
      return json(await ledger(env).recent());
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
