import { WorkerEntrypoint } from "cloudflare:workers";
import { parseRoster } from "@operon/core";
import { recordMessage } from "@operon/chronicle";
import {
  errorResponse,
  json,
  readJson,
  requireBearer,
  Ledger,
  OpsEntrypoint,
  type OperatorAction
} from "@operon/worker-kit";
import { triageUpdate, type TelegramUpdate } from "./webhook.js";
import { Channel } from "./channel-do.js";
import { concernsAgent } from "./channel.js";

export { Ledger, Channel };

export { triageUpdate, type TelegramUpdate, type WebhookAction } from "./webhook.js";
export * from "./channel.js";

interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  NOTIFY_TOKEN?: string;
  WAKE_TRIGGER_TOKEN?: string;
  OPERATOR_CHAT_ID?: string;
  ROSTER?: string;
  /** email, spend and pr Gatekeepers over service bindings (their Ops entrypoints). */
  EMAIL?: Fetcher;
  SPEND?: Fetcher;
  PR?: Fetcher;
  LEDGER: DurableObjectNamespace<Ledger>;
  CHANNEL: DurableObjectNamespace<Channel>;
  SCHEDULER?: Fetcher;
  /** The notifications feed (spec 0005 §5): every notify is recorded
   * here whether or not Telegram delivered it. */
  CHRONICLE?: D1Database;
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
  "Held spends and merges: the buttons on the hold message decide them; a held CODE merge also needs your review on GitHub first\n" +
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
  spend_reject: "sr",
  merge_approve: "ma",
  merge_reject: "mr"
};

/** Which Gatekeeper a decision prefix reaches, and where its Ops doors live. */
type HeldGate = "email" | "spend" | "merge";
const GATES: Record<HeldGate, { binding: (env: Env) => Fetcher | undefined; base: string }> = {
  email: { binding: env => env.EMAIL, base: "/gatekeeper/email" },
  spend: { binding: env => env.SPEND, base: "/gatekeeper/spend" },
  merge: { binding: env => env.PR, base: "/gatekeeper/pr" }
};
const GATE_BY_PREFIX: Record<string, { gate: HeldGate; approve: boolean }> = {
  ea: { gate: "email", approve: true },
  er: { gate: "email", approve: false },
  sa: { gate: "spend", approve: true },
  sr: { gate: "spend", approve: false },
  ma: { gate: "merge", approve: true },
  mr: { gate: "merge", approve: false }
};

function callbackData(action: NotifyAction): string | null {
  const prefix = ACTION_PREFIXES[action.kind];
  if (!prefix) return null;
  // A merge decision is addressed by its hold alone (the pr Gatekeeper's
  // Ops doors take heldId only), so the agent id stays out of the
  // payload and a long roster id can never push it past Telegram's cap.
  const data = prefix === "ma" || prefix === "mr" ? `${prefix}:${action.id}` : `${prefix}:${action.agentId}:${action.id}`;
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
        // Notify text routinely quotes untrusted content (inbound mail,
        // merchant URLs, post text); a link preview would let a sender
        // decorate the operator's oversight channel with chosen content.
        link_preview_options: { is_disabled: true },
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

/** Execute an approve/reject against the email, spend or pr Gatekeeper. */
async function heldDecision(
  env: Env,
  gate: HeldGate,
  approve: boolean,
  agentId: string | undefined,
  heldId: string
): Promise<{ ok: boolean; detail: string; agentId?: string; pr?: { repo: string; number: number } }> {
  const verb = approve ? "approve" : "reject";
  // The decision goes over a private service binding to the Gatekeeper's
  // binding-only Ops entrypoint: no bearer on the wire, and only workers
  // with the binding (this one and the ops gateway) can execute it.
  const binding = GATES[gate].binding(env);
  if (!binding) return { ok: false, detail: `${gate} gatekeeper not bound`, agentId };
  const response = await binding.fetch(`https://internal${GATES[gate].base}/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // A merge hold names its agent itself; the others are addressed per agent.
    body: JSON.stringify(gate === "merge" ? { heldId } : { agentId, heldId })
  });
  const text = await response.text();
  const detail = text.slice(0, 200);
  // A merge callback carries no agent; the Gatekeeper's answer names the
  // holding agent and the pull request, and the audit row carries each
  // in its own field (the agent id stays the bare roster id, so the
  // chronicle's exact-match queries find it).
  // A hold nobody remembers any more (no hold, no terminal record) is
  // ledgered without an agent rather than under a placeholder that a
  // roster-scoped query would never match.
  let named: string | undefined = agentId;
  let pr: { repo: string; number: number } | undefined;
  if (gate === "merge") {
    named = undefined;
    try {
      const body = JSON.parse(text) as { agentId?: string; repo?: string; number?: number };
      if (typeof body.agentId === "string") named = body.agentId;
      if (typeof body.repo === "string" && typeof body.number === "number") pr = { repo: body.repo, number: body.number };
    } catch {
      /* the detail carries what came back */
    }
  }
  await ledger(env).append(`${gate}_decision`, {
    verb,
    ...(named !== undefined ? { agentId: named } : {}),
    heldId,
    status: response.status,
    ...(pr ?? {})
  });
  return { ok: response.ok, detail, agentId: named, pr };
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
      const match =
        /^(ea|er|sa|sr):([a-z0-9-]+):([a-f0-9-]{8,64})$/.exec(action.data) ??
        /^(ma|mr):()([a-f0-9-]{8,64})$/.exec(action.data);
      if (!match) {
        await answerCallback(env, action.callbackId, "unknown action");
        return json({ ok: true });
      }
      const { gate, approve } = GATE_BY_PREFIX[match[1]];
      const result = await heldDecision(env, gate, approve, match[2], match[3]);
      const agent = result.agentId ?? "an agent no longer on record";
      const who = result.pr ? `${agent} (${result.pr.repo}#${result.pr.number})` : agent;
      await answerCallback(
        env,
        action.callbackId,
        result.ok ? (approve ? `Approved, executing for ${who}` : `Rejected for ${who}`) : `Failed: ${result.detail.slice(0, 100)}`
      );
      await sendToOperator(
        env,
        result.ok
          ? `${approve ? "approved and sent" : "rejected"}: ${who} held ${match[3].slice(0, 8)}`
          : `${approve ? "approve" : "reject"} failed for ${who}: ${result.detail}`
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

/** Attribute an agent notify into the operator conversation log (best-effort). */
async function recordAgentNotify(env: Env, agentId: string, text: string): Promise<void> {
  try {
    await channel(env).append(
      { at: new Date().toISOString(), from: "agent", agentId, text: text.slice(0, 4000) },
      protectedAgents(env)
    );
  } catch (error) {
    console.error("channel append failed", error);
  }
}

/**
 * Durable notify record (spec 0005 §5): the notifications feed the
 * console reads, independent of any Telegram delivery. Returns whether
 * the record landed; a notify that is neither delivered nor recorded is
 * a loud failure.
 */
async function recordNotifyFeed(env: Env, agentId: string | undefined, text: string): Promise<boolean> {
  if (!env.CHRONICLE) return false;
  // recordMessage reports whether the row actually landed; a suppressed
  // D1 failure must NOT read as "recorded", or a notify that also missed
  // Telegram would report success while reaching nothing (spec 0005 §5).
  return recordMessage(env.CHRONICLE, {
    at: new Date().toISOString(),
    kind: "notify",
    agentId: agentId && agentId.length > 0 ? agentId : "system",
    sender: "chassis",
    body: text.slice(0, 4000)
  });
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
  // Button-gating (spec 0003 §7): the PUBLIC, bearer-authenticated path
  // NEVER renders action buttons. Buttons come only from our own Workers
  // over the TELEGRAM service binding (the entrypoint below), so a forged
  // notify with a leaked NOTIFY_TOKEN is text spam, never a decision.
  if (body.value.actions && body.value.actions.length > 0) {
    await ledger(env).append("notify_actions_stripped", { count: body.value.actions.length });
  }
  const delivered = await sendToOperator(env, text.slice(0, 4000));
  const agentId = typeof body.value.agentId === "string" ? body.value.agentId : undefined;
  const recorded = await recordNotifyFeed(env, agentId, text);
  await ledger(env).append("notify", { delivered, recorded, length: text.length });
  // Attributed notifies join the conversation log, so when the operator
  // answers later, the agent's next wake sees what it had said. Recorded
  // even if the Telegram delivery failed: the channel is the memory.
  if (agentId && agentId.length > 0) {
    await recordAgentNotify(env, agentId, text);
  }
  // Telegram is one optional transport (spec 0005 §5): recorded-but-
  // undelivered is success (the feed has it). Reaching NEITHER the
  // operator nor the record is the loud failure.
  if (!delivered && !recorded) return errorResponse(502, "notify_unrecorded");
  return json({ ok: true, delivered, recorded });
}

/**
 * The binding-only operator gateway (spec 0003 §7): our own Workers call
 * env.TELEGRAM.notify(...) over a private service binding, and ONLY this
 * path renders action buttons. No bearer, no public route, so a leaked
 * token cannot reach it.
 */
export class TelegramGateway extends WorkerEntrypoint<Env> {
  async notify(input: { text: string; actions?: OperatorAction[]; agentId?: string }): Promise<{
    delivered: boolean;
    recorded: boolean;
  }> {
    const text = String(input.text ?? "").slice(0, 4000);
    if (!text) return { delivered: false, recorded: false };
    const delivered = await sendToOperator(this.env, text, input.actions);
    const recorded = await recordNotifyFeed(
      this.env,
      typeof input.agentId === "string" ? input.agentId : undefined,
      text
    );
    await ledger(this.env).append("notify", { delivered, recorded, length: text.length, viaBinding: true });
    if (typeof input.agentId === "string" && input.agentId.length > 0) {
      await recordAgentNotify(this.env, input.agentId, text);
    }
    return { delivered, recorded };
  }
}

/**
 * The doors (spec 0009): the container's notify and channel paths,
 * reachable only over the umbilical's TELEGRAM_DOOR binding. The bearer
 * checks stay (the umbilical attaches the real NOTIFY_TOKEN); what is
 * gone is any way to address these paths from the public hostname.
 */
export class Door extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const env = this.env;
    const url = new URL(request.url);
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
    if (url.pathname === "/channel/original" && request.method === "POST") {
      // The stored, unredacted original of one channel entry: the wake's
      // transcript may have withheld a scanner-tripping line, but the
      // message remains the agent's conversation to read. Scoped to
      // entries that concern the requesting agent.
      const denied = requireBearer(request, env.NOTIFY_TOKEN);
      if (denied) return denied;
      const body = await readJson<{ agentId?: string; id?: number }>(request);
      if (
        !body.ok ||
        typeof body.value.agentId !== "string" ||
        !body.value.agentId ||
        typeof body.value.id !== "number" ||
        !Number.isInteger(body.value.id)
      ) {
        return errorResponse(400, "invalid_request");
      }
      const entry = await channel(env).entry(body.value.id);
      if (!entry || !concernsAgent(entry, body.value.agentId)) {
        return errorResponse(404, "entry_not_found", String(body.value.id));
      }
      return json({ ok: true, entry });
    }
    return errorResponse(404, "not_found");
  }
}

export default {
  async fetch(request, env) {
    // The public surface: Telegram's webhook, and nothing else (spec 0009).
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;

/**
 * The operator's binding-only channel surface (spec 0003 step 3): send a
 * message to an agent, read an agent's transcript, tail the ledger. No
 * bearer, the binding is the auth. (Notify buttons keep their own
 * TelegramGateway.notify entrypoint above.)
 */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const env = this.env;
    // Live channel subscription (spec 0005 §4): the upgrade passes
    // through to the Channel DO, which replays from the subscriber's
    // cursor and then streams appends.
    if (url.pathname === "/ws/channel") {
      return channel(env).fetch(request);
    }
    if (url.pathname === "/channel/send" && request.method === "POST") {
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
      const body = await readJson<{ agentId?: string }>(request);
      if (!body.ok || typeof body.value.agentId !== "string" || !body.value.agentId) {
        return errorResponse(400, "invalid_request");
      }
      return json({ ok: true, ...(await channel(env).pullFor(body.value.agentId)) });
    }
    if (url.pathname === "/ledger" && request.method === "GET") {
      return json(await ledger(env).recent());
    }
    return errorResponse(404, "not_found");
  }
}
