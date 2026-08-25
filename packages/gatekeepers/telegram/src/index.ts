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
  EMAIL_URL?: string;
  EMAIL_SERVICE_TOKEN?: string;
  SPEND_URL?: string;
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

const OPERATOR_HELP =
  "Commands:\n" +
  "/wake <agent-id> — wake an agent now\n" +
  "/tell <agent-id> <message> — message one agent (delivered on its next wake)\n" +
  "/approve <agent-id> <held-id> — release a held first-contact email (buttons on the hold message do this too)\n" +
  "/reject <agent-id> <held-id> — discard a held email\n" +
  "/disable <agent-id> — KILL SWITCH: refuse all wakes (cron and manual) and kill a wake in flight\n" +
  "/enable <agent-id> — lift the kill switch\n" +
  "/help — this text\n" +
  "A plain message goes to ALL agents on their next wakes.";

interface NotifyAction {
  label: string;
  kind: string;
  agentId: string;
  id: string;
}

/** Callback data is capped at 64 bytes by Telegram; keep the encoding tight. */
const ACTION_PREFIXES: Record<string, string> = {
  email_approve: "ea",
  email_reject: "er",
  spend_approve: "sa",
  spend_reject: "sr"
};

function callbackData(action: NotifyAction): string | null {
  const prefix = ACTION_PREFIXES[action.kind];
  if (!prefix) return null;
  const data = `${prefix}:${action.agentId}:${action.id}`;
  return data.length <= 64 ? data : null;
}

async function sendToOperator(env: Env, text: string, actions?: NotifyAction[]): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.OPERATOR_CHAT_ID) return false;
  const buttons = (actions ?? [])
    .map(action => {
      const data = callbackData(action);
      return data ? { text: action.label, callback_data: data } : null;
    })
    .filter((b): b is { text: string; callback_data: string } => b !== null);
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.OPERATOR_CHAT_ID,
        text,
        ...(buttons.length > 0 ? { reply_markup: { inline_keyboard: [buttons] } } : {})
      })
    }
  );
  return response.ok;
}

async function answerCallback(env: Env, callbackId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text })
  }).catch(() => undefined);
}

/** Execute an approve/reject against the email or spend Gatekeeper. */
async function heldDecision(
  env: Env,
  gate: "email" | "spend",
  approve: boolean,
  agentId: string,
  heldId: string
): Promise<{ ok: boolean; detail: string }> {
  const verb = approve ? "approve" : "reject";
  let url: string | undefined;
  let bearer: string | undefined;
  if (gate === "email") {
    url = env.EMAIL_URL ? `${env.EMAIL_URL}/gatekeeper/email/${verb}` : undefined;
    bearer = env.EMAIL_SERVICE_TOKEN;
  } else {
    url = env.SPEND_URL ? `${env.SPEND_URL}/gatekeeper/spend/${verb}` : undefined;
    bearer = env.OPERATOR_API_TOKEN;
  }
  if (!url || !bearer) return { ok: false, detail: `${gate} gatekeeper not wired` };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ agentId, heldId })
  });
  const detail = (await response.text()).slice(0, 200);
  await ledger(env).append(`${gate}_decision`, { verb, agentId, heldId, status: response.status });
  return { ok: response.ok, detail };
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
    case "toggle": {
      if (!env.SCHEDULER || !env.WAKE_TRIGGER_TOKEN) {
        await sendToOperator(env, `cannot ${action.disabled ? "disable" : "enable"} ${action.agentId}: scheduler not bound`);
        return json({ ok: true });
      }
      const verb = action.disabled ? "disable" : "enable";
      const response = await env.SCHEDULER.fetch(`https://scheduler.internal/${verb}/${action.agentId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.WAKE_TRIGGER_TOKEN}` }
      });
      const resultText = await response.text();
      await ledger(env).append("operator_toggle", {
        agentId: action.agentId,
        disabled: action.disabled,
        status: response.status,
        result: resultText.slice(0, 300)
      });
      if (!response.ok) {
        await sendToOperator(env, `${verb} ${action.agentId} failed: ${resultText.slice(0, 200)}`);
      } else if (action.disabled) {
        const killed = resultText.includes("killedWakeId");
        await sendToOperator(
          env,
          `${action.agentId} DISABLED: all wakes refused until /enable ${action.agentId}.` +
            (killed ? " A running wake was killed." : "")
        );
      } else {
        await sendToOperator(env, `${action.agentId} enabled: cron and /wake work again`);
      }
      return json({ ok: true });
    }
    case "approve": {
      const result = await heldDecision(env, "email", action.approve, action.agentId, action.heldId);
      await sendToOperator(
        env,
        result.ok
          ? `${action.approve ? "approved and sent" : "rejected"}: ${action.agentId} held ${action.heldId.slice(0, 8)}`
          : `${action.approve ? "approve" : "reject"} failed: ${result.detail}`
      );
      return json({ ok: true });
    }
    case "callback": {
      const match = /^(ea|er|sa|sr):([a-z0-9-]+):([a-f0-9-]{8,64})$/.exec(action.data);
      if (!match) {
        await answerCallback(env, action.callbackId, "unknown action");
        return json({ ok: true });
      }
      const approve = match[1] === "ea" || match[1] === "sa";
      const gate = match[1].startsWith("e") ? ("email" as const) : ("spend" as const);
      const result = await heldDecision(env, gate, approve, match[2], match[3]);
      await answerCallback(
        env,
        action.callbackId,
        result.ok ? (approve ? "Approved, sending" : "Rejected") : `Failed: ${result.detail.slice(0, 100)}`
      );
      await sendToOperator(
        env,
        result.ok
          ? `${approve ? "approved and sent" : "rejected"}: ${match[2]} held ${match[3].slice(0, 8)}`
          : `${approve ? "approve" : "reject"} failed: ${result.detail}`
      );
      return json({ ok: true });
    }
    case "help":
      await sendToOperator(env, OPERATOR_HELP);
      return json({ ok: true });
    case "unknown_command":
      await ledger(env).append("unknown_command", { text: action.text.slice(0, 200) });
      await sendToOperator(env, OPERATOR_HELP);
      return json({ ok: true });
  }
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.NOTIFY_TOKEN);
  if (denied) {
    await ledger(env).append("notify_denied", { status: denied.status });
    return denied;
  }
  const body = await readJson<{ text?: string; agentId?: string; actions?: NotifyAction[] }>(request);
  if (!body.ok) {
    await ledger(env).append("notify_failed", { reason: "malformed_json" });
    return errorResponse(400, "malformed_json");
  }
  const { text } = body.value;
  if (typeof text !== "string" || text.length === 0) {
    await ledger(env).append("notify_failed", { reason: "empty_text" });
    return errorResponse(400, "empty_text");
  }
  const delivered = await sendToOperator(env, text.slice(0, 4000), body.value.actions);
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
