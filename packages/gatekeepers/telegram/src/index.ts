import { parseRoster } from "@operon/core";
import { errorResponse, json, readJson, requireBearer, requireAnyBearer, Ledger } from "@operon/worker-kit";
import { triageUpdate, type TelegramUpdate } from "./webhook.js";
import { Channel } from "./channel-do.js";

export { Ledger, Channel };
export { triageUpdate, type TelegramUpdate, type WebhookAction } from "./webhook.js";
export * from "./channel.js";

interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  NOTIFY_TOKEN?: string;
  WAKE_TRIGGER_TOKEN?: string;
  OPERATOR_API_TOKEN?: string;
  OPERATOR_CHAT_ID?: string;
  ROSTER?: string;
  LEDGER: DurableObjectNamespace<Ledger>;
  CHANNEL: DurableObjectNamespace<Channel>;
  SCHEDULER?: Fetcher;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("telegram"));
}

function channel(env: Env) {
  return env.CHANNEL.get(env.CHANNEL.idFromName("operator"));
}

/**
 * The roster's agent ids, whose unread backlog channel pruning must
 * respect. undefined when the roster is absent or unparseable: the
 * channel then fails safe and prunes nothing below its hard bound.
 */
function protectedAgents(env: Env): string[] | undefined {
  if (!env.ROSTER) return undefined;
  try {
    return parseRoster(env.ROSTER).agents.map(agent => agent.id);
  } catch {
    return undefined;
  }
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

  const body = await readJson<TelegramUpdate>(request);
  if (!body.ok) {
    await ledger(env).append("webhook_failed", { reason: "malformed_json" });
    // Ack anyway: Telegram retries non-2xx, and a malformed body will never
    // parse on retry. The failure is recorded; the delivery is done.
    return json({ ok: true });
  }
  const action = triageUpdate(body.value, env.OPERATOR_CHAT_ID);

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
    case "tell": {
      await channel(env).append(
        {
          at: new Date().toISOString(),
          from: "operator",
          agentId: action.agentId,
          text: action.text.slice(0, 4000)
        },
        protectedAgents(env)
      );
      await ledger(env).append("operator_tell", { agentId: action.agentId, length: action.text.length });
      await sendToOperator(env, `queued for ${action.agentId}; delivered on its next wake`);
      return json({ ok: true });
    }
    case "broadcast": {
      await channel(env).append(
        {
          at: new Date().toISOString(),
          from: "operator",
          agentId: "*",
          text: action.text.slice(0, 4000)
        },
        protectedAgents(env)
      );
      await ledger(env).append("operator_broadcast", { length: action.text.length });
      await sendToOperator(env, "queued for all agents; delivered on their next wakes");
      return json({ ok: true });
    }
    case "unknown_command":
      await ledger(env).append("unknown_command", { text: action.text.slice(0, 200) });
      await sendToOperator(
        env,
        "commands: /wake <agent-id>, /tell <agent-id> <message>. A plain message goes to all agents."
      );
      return json({ ok: true });
  }
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.NOTIFY_TOKEN);
  if (denied) {
    await ledger(env).append("notify_denied", { status: denied.status });
    return denied;
  }
  const body = await readJson<{ text?: string; agentId?: string }>(request);
  if (!body.ok) {
    await ledger(env).append("notify_failed", { reason: "malformed_json" });
    return errorResponse(400, "malformed_json");
  }
  const { text } = body.value;
  if (typeof text !== "string" || text.length === 0) {
    await ledger(env).append("notify_failed", { reason: "empty_text" });
    return errorResponse(400, "empty_text");
  }
  const delivered = await sendToOperator(env, text.slice(0, 4000));
  await ledger(env).append("notify", { delivered, length: text.length });
  // Attributed notifies join the conversation log, so when the operator
  // answers later, the agent's next wake sees what it had said. Recorded
  // even if the Telegram delivery failed: the channel is the memory.
  if (typeof body.value.agentId === "string" && body.value.agentId.length > 0) {
    try {
      await channel(env).append(
        {
          at: new Date().toISOString(),
          from: "agent",
          agentId: body.value.agentId,
          text: text.slice(0, 4000)
        },
        protectedAgents(env)
      );
    } catch (error) {
      console.error("channel append failed", error);
    }
  }
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
    if (url.pathname === "/channel/pull" && request.method === "POST") {
      const denied = requireBearer(request, env.NOTIFY_TOKEN);
      if (denied) return denied;
      const body = await readJson<{ agentId?: string }>(request);
      if (!body.ok || typeof body.value.agentId !== "string" || !body.value.agentId) {
        return errorResponse(400, "invalid_request");
      }
      return json({ ok: true, ...(await channel(env).pullFor(body.value.agentId)) });
    }
    if (url.pathname === "/channel/ack" && request.method === "POST") {
      const denied = requireBearer(request, env.NOTIFY_TOKEN);
      if (denied) return denied;
      const body = await readJson<{ agentId?: string; upTo?: number }>(request);
      if (
        !body.ok ||
        typeof body.value.agentId !== "string" ||
        !body.value.agentId ||
        typeof body.value.upTo !== "number"
      ) {
        return errorResponse(400, "invalid_request");
      }
      await channel(env).ack(body.value.agentId, body.value.upTo);
      return json({ ok: true });
    }
    if (url.pathname === "/channel/send" && request.method === "POST") {
      // Operator UI surface: same append the Telegram webhook uses, so a
      // custom UI is just another transport over the one channel.
      const denied = requireBearer(request, env.OPERATOR_API_TOKEN);
      if (denied) return denied;
      const body = await readJson<{ agentId?: string; text?: string }>(request);
      if (
        !body.ok ||
        typeof body.value.agentId !== "string" ||
        !body.value.agentId ||
        typeof body.value.text !== "string" ||
        !body.value.text
      ) {
        return errorResponse(400, "invalid_request", 'agentId ("*" broadcasts) and text required');
      }
      const entry = await channel(env).append(
        {
          at: new Date().toISOString(),
          from: "operator",
          agentId: body.value.agentId,
          text: body.value.text.slice(0, 4000)
        },
        protectedAgents(env)
      );
      await ledger(env).append("operator_api_send", { agentId: body.value.agentId });
      return json({ ok: true, id: entry.id });
    }
    if (url.pathname === "/channel/transcript" && request.method === "POST") {
      const denied = requireBearer(request, env.OPERATOR_API_TOKEN);
      if (denied) return denied;
      const body = await readJson<{ agentId?: string }>(request);
      if (!body.ok || typeof body.value.agentId !== "string" || !body.value.agentId) {
        return errorResponse(400, "invalid_request");
      }
      return json({ ok: true, ...(await channel(env).pullFor(body.value.agentId)) });
    }
    if (url.pathname === "/ledger" && request.method === "GET") {
      // Internal services and the operator UI may both tail the ledger.
      const denied = requireAnyBearer(request, [env.NOTIFY_TOKEN, env.OPERATOR_API_TOKEN]);
      if (denied) return denied;
      return json(await ledger(env).recent());
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
