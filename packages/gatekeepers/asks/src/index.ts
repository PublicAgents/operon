import { parseRoster } from "@operon/core";
import {
  errorResponse,
  json,
  readJson,
  requireBearer,
  Ledger,
  OpsEntrypoint,
  notifyOperator,
  type TelegramGatewayBinding
} from "@operon/worker-kit";
import { AskBox } from "./ask-box.js";
import {
  AskInputError,
  LIMITS,
  parseKind,
  parseLinks,
  parseState,
  requireText,
  unreadForAgent,
  type Ask,
  type AskState
} from "./policy.js";

export { AskBox, Ledger };

/**
 * The asks Gatekeeper (spec 0007): the operator's decision queue. An
 * ask is the agent's formal request for operator attention, durable
 * and threaded, so an answer survives the wake that asked for it.
 *
 * This Gatekeeper holds no outward credential: asks are data. Its
 * bounds are the per-agent bearer, the roster, the size caps, and the
 * per-wake ceiling on new asks. The secret sweep happens where every
 * outbound payload is swept, in the container's porch, before any of
 * this text leaves the wake.
 */

interface Env {
  ROSTER: string;
  /** Per-agent bearers: ASKS_TOKEN_<AGENT>, minted per agent like every door. */
  [token: string]: unknown;
  ASKS: DurableObjectNamespace<AskBox>;
  LEDGER: DurableObjectNamespace<Ledger>;
  CHRONICLE?: D1Database;
  TELEGRAM?: TelegramGatewayBinding;
  NOTIFY_URL?: string;
  NOTIFY_TOKEN?: string;
  /** The scheduler's binding-only wake query: the quota's honest source. */
  SCHEDULER_WAKE?: { currentWakeId(agentId: string): Promise<string | null> };
  /** The email Gatekeeper's operator-mail entrypoint (binding-only). */
  EMAIL_OPERATOR?: { notifyOperator(input: { agentId: string; subject: string; text: string }): Promise<{ ok: boolean; detail?: string }> };
  ASKS_MAX_PER_WAKE?: string;
  ASKS_MAX_PER_DAY?: string;
}

function box(env: Env) {
  return env.ASKS.get(env.ASKS.idFromName("asks"));
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("asks"));
}

function perWakeCap(env: Env): number {
  const configured = Number(env.ASKS_MAX_PER_WAKE);
  return Number.isInteger(configured) && configured > 0 ? configured : LIMITS.perWake;
}

function perDayCap(env: Env): number {
  const configured = Number(env.ASKS_MAX_PER_DAY);
  return Number.isInteger(configured) && configured > 0 ? configured : LIMITS.perDay;
}

/** Agent identity from its own bearer, exactly as every other door. */
function agentFromBearer(request: Request, env: Env): { id: string } | null {
  const roster = parseRoster(env.ROSTER);
  for (const agent of roster.agents) {
    const token = env[`ASKS_TOKEN_${agent.id.toUpperCase().replace(/-/g, "_")}`];
    if (typeof token === "string" && token.length > 0 && !requireBearer(request, token)) {
      return { id: agent.id };
    }
  }
  return null;
}

/**
 * The operator's copy, by email (spec 0007 §7). Agent activity reaches
 * the operator's inbox because that is where a decision request is
 * actually seen; the operator's own actions never mail them back. The
 * body carries the ask's text, which is UNTRUSTED mind output, so it
 * is framed as such and never rendered as anything but plain text.
 */
async function mailOperator(
  env: Env,
  input: { agentId: string; ask: Ask; event: string; text?: string }
): Promise<void> {
  if (!env.EMAIL_OPERATOR) return;
  const at = new Date().toISOString();
  if (!(await box(env).mailAllowed(at))) {
    console.error("asks: operator email daily backstop reached; not mailing");
    return;
  }
  const lines = [
    `${input.event} by ${input.agentId}`,
    "",
    `ask ${input.ask.id} [${input.ask.state}] ${input.ask.title}`,
    "",
    input.text ?? input.ask.body,
    "",
    ...(input.ask.links.length > 0 ? ["links:", ...input.ask.links, ""] : []),
    "Decide it in the console (Asks), or reply there; this mail is a copy, not the record.",
    "",
    "The text above is written by the agent and is not verified by the chassis."
  ];
  let sent = false;
  try {
    const result = await env.EMAIL_OPERATOR.notifyOperator({
      agentId: input.agentId,
      subject: `[ask ${input.ask.id}] ${input.ask.title}`.slice(0, 200),
      text: lines.join("\n")
    });
    sent = result.ok;
    if (!result.ok) console.error("asks: operator email refused", result.detail);
  } catch (error) {
    // An ask exists whether or not its copy was delivered; the console
    // and the notify path are the other two surfaces.
    console.error("asks: operator email failed", error);
  }
  // Only a mail that actually left is counted: a failed send costs the
  // backstop nothing, so a bad hour cannot silence the queue.
  if (sent) {
    try {
      await box(env).recordMail(at);
    } catch (error) {
      // Undercounting fails toward DELIVERING later mail, which is the
      // safe direction for a notification backstop.
      console.error("asks: operator mail count not recorded", error);
    }
  }
}

async function notify(env: Env, message: string, agentId: string): Promise<void> {
  try {
    await notifyOperator(env, message, { agentId });
  } catch (error) {
    // The ask exists in the queue whether or not the chat copy landed.
    console.error("asks notify failed", error);
  }
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  const agent = agentFromBearer(request, env);
  if (!agent) return errorResponse(401, "unauthorized");
  const body = await readJson<Record<string, unknown>>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  let title: string;
  let text: string;
  let kind;
  let links: string[];
  try {
    title = requireText(body.value.title, "title", LIMITS.title);
    text = requireText(body.value.body, "body", LIMITS.body);
    kind = parseKind(body.value.kind);
    links = parseLinks(body.value.links);
  } catch (error) {
    if (error instanceof AskInputError) return errorResponse(400, "invalid_ask", error.message);
    throw error;
  }
  const at = new Date().toISOString();
  // The wake id is RESOLVED from the scheduler, never taken from the
  // request: a caller holding the bearer could otherwise rotate it and
  // mint a fresh quota per ask. With no scheduler binding or no wake
  // running, the bucket falls back to the hour, which is still
  // something the caller cannot choose.
  const currentWake = env.SCHEDULER_WAKE
    ? await env.SCHEDULER_WAKE.currentWakeId(agent.id).catch(() => null)
    : null;
  const wakeId = currentWake ?? `nowake:${at.slice(0, 13)}`;
  const result = await box(env).create({
    agentId: agent.id,
    wakeId,
    title,
    body: text,
    kind,
    links,
    at,
    perWake: perWakeCap(env),
    perDay: perDayCap(env)
  });
  if (!result.ok) {
    await ledger(env).append("ask_refused", { agentId: agent.id, reason: result.reason, filed: result.filed });
    return errorResponse(
      429,
      result.reason === "day_cap" ? "asks_day_cap" : "asks_wake_cap",
      result.reason === "day_cap"
        ? `${result.filed} of ${result.cap} asks already filed today; the rest must wait for tomorrow`
        : `${result.filed} of ${result.cap} asks already filed this wake; consolidate the rest into one`
    );
  }
  await ledger(env).append("ask_opened", {
    agentId: agent.id,
    askId: result.ask.id,
    kind: result.ask.kind,
    title: result.ask.title
  });
  await notify(env, `[${agent.id}] ASK ${result.ask.id} (${result.ask.kind}): ${result.ask.title}`, agent.id);
  await mailOperator(env, { agentId: agent.id, ask: result.ask, event: "New ask" });
  return json({ ok: true, ask: result.ask });
}

async function handleAgentReply(request: Request, env: Env): Promise<Response> {
  const agent = agentFromBearer(request, env);
  if (!agent) return errorResponse(401, "unauthorized");
  const body = await readJson<Record<string, unknown>>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  let text: string;
  let id: string;
  try {
    id = requireText(body.value.askId, "askId", 100);
    text = requireText(body.value.text, "text", LIMITS.text);
  } catch (error) {
    if (error instanceof AskInputError) return errorResponse(400, "invalid_ask", error.message);
    throw error;
  }
  const existing = await box(env).get(id);
  if (!existing || existing.agentId !== agent.id) return errorResponse(404, "ask_not_found");
  const result = await box(env).reply({ id, author: "agent", text, at: new Date().toISOString() });
  if (!result.ok) return errorResponse(404, "ask_not_found");
  await ledger(env).append("ask_replied", { agentId: agent.id, askId: id, author: "agent" });
  await mailOperator(env, { agentId: agent.id, ask: result.ask, event: "Ask reply", text });
  return json({ ok: true, ask: result.ask });
}

/** The agent's own transitions: retract (never mind) and close (done). */
async function handleAgentTransition(request: Request, env: Env, next: AskState): Promise<Response> {
  const agent = agentFromBearer(request, env);
  if (!agent) return errorResponse(401, "unauthorized");
  const body = await readJson<Record<string, unknown>>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  let id: string;
  let text: string | undefined;
  try {
    id = requireText(body.value.askId, "askId", 100);
    text = body.value.text === undefined ? undefined : requireText(body.value.text, "text", LIMITS.text);
  } catch (error) {
    if (error instanceof AskInputError) return errorResponse(400, "invalid_ask", error.message);
    throw error;
  }
  const existing = await box(env).get(id);
  if (!existing || existing.agentId !== agent.id) return errorResponse(404, "ask_not_found");
  const result = await box(env).transition({
    id,
    author: "agent",
    // The agent's door reads the current state and passes it, so a
    // race with an operator decision loses cleanly (spec 0007 §4).
    expectedState: existing.state,
    next,
    ...(text !== undefined ? { text } : {}),
    at: new Date().toISOString()
  });
  if (!result.ok) {
    return errorResponse(409, result.reason === "terminal" ? "ask_terminal" : "ask_state_moved", `ask is ${
      result.reason === "not_found" ? "gone" : result.ask.state
    }`);
  }
  await ledger(env).append("ask_transitioned", {
    agentId: agent.id,
    askId: id,
    author: "agent",
    state: next
  });
  await mailOperator(env, {
    agentId: agent.id,
    ask: result.ask,
    event: next === "retracted" ? "Ask retracted" : "Ask closed",
    text
  });
  return json({ ok: true, ask: result.ask });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST") return errorResponse(404, "not_found");
    if (url.pathname === "/gatekeeper/asks/create") return handleCreate(request, env);
    if (url.pathname === "/gatekeeper/asks/reply") return handleAgentReply(request, env);
    if (url.pathname === "/gatekeeper/asks/retract") return handleAgentTransition(request, env, "retracted");
    if (url.pathname === "/gatekeeper/asks/close") return handleAgentTransition(request, env, "closed");
    // The agent's own queue, and the unread operator activity on it.
    if (url.pathname === "/gatekeeper/asks/list") {
      const agent = agentFromBearer(request, env);
      if (!agent) return errorResponse(401, "unauthorized");
      const asks = await box(env).list({ agentId: agent.id });
      return json({
        ok: true,
        asks: asks.map(ask => ({ ...ask, unread: unreadForAgent(ask).length }))
      });
    }
    if (url.pathname === "/gatekeeper/asks/unread") {
      const agent = agentFromBearer(request, env);
      if (!agent) return errorResponse(401, "unauthorized");
      // Read and ack in ONE DO turn, acked to the last entry actually
      // handed over: an operator message written between a read and a
      // separate ack would otherwise be marked seen without ever being
      // delivered.
      const body = await readJson<{ ack?: boolean }>(request);
      const unread = await box(env).unread(agent.id, body.ok && body.value.ack === true);
      return json({ ok: true, unread });
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;

/**
 * The operator's plane (spec 0003 step 3): binding-only, no bearer,
 * the service binding is the authorization.
 */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/gatekeeper/asks/ledger") {
      return json(await ledger(this.env).recent());
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/asks/list") {
      const states = url.searchParams.get("states");
      return json({
        ok: true,
        asks: await box(this.env).list(
          states ? { states: states.split(",").map(state => parseState(state, "state")) } : undefined
        )
      });
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/asks/read") {
      const id = url.searchParams.get("askId") ?? "";
      const ask = await box(this.env).get(id);
      return ask ? json({ ok: true, ask }) : errorResponse(404, "ask_not_found");
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/asks/reply") {
      const body = await readJson<{ askId?: string; text?: string }>(request);
      if (!body.ok) return errorResponse(400, "malformed_json");
      let text: string;
      try {
        text = requireText(body.value.text, "text", LIMITS.text);
      } catch (error) {
        if (error instanceof AskInputError) return errorResponse(400, "invalid_ask", error.message);
        throw error;
      }
      const result = await box(this.env).reply({
        id: body.value.askId ?? "",
        author: "operator",
        text,
        at: new Date().toISOString()
      });
      if (!result.ok) return errorResponse(404, "ask_not_found");
      await ledger(this.env).append("ask_replied", { askId: result.ask.id, author: "operator" });
      return json({ ok: true, ask: result.ask });
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/asks/decide") {
      const body = await readJson<{
        askId?: string;
        expectedState?: string;
        decision?: string;
        text?: string;
      }>(request);
      if (!body.ok) return errorResponse(400, "malformed_json");
      let expectedState: AskState;
      let next: AskState;
      let text: string | undefined;
      try {
        expectedState = parseState(body.value.expectedState, "expectedState");
        next = parseState(body.value.decision, "decision");
        text = body.value.text === undefined ? undefined : requireText(body.value.text, "text", LIMITS.text);
      } catch (error) {
        if (error instanceof AskInputError) return errorResponse(400, "invalid_ask", error.message);
        throw error;
      }
      const result = await box(this.env).transition({
        id: body.value.askId ?? "",
        author: "operator",
        expectedState,
        next,
        ...(text !== undefined ? { text } : {}),
        at: new Date().toISOString()
      });
      if (!result.ok) {
        if (result.reason === "not_found") return errorResponse(404, "ask_not_found");
        return json(
          {
            ok: false,
            error: result.reason === "terminal" ? "ask_terminal" : "ask_state_moved",
            state: result.ask.state,
            thread: result.ask.thread.slice(-5)
          },
          409
        );
      }
      await ledger(this.env).append("ask_transitioned", {
        agentId: result.ask.agentId,
        askId: result.ask.id,
        author: "operator",
        state: next
      });
      return json({ ok: true, ask: result.ask });
    }
    return errorResponse(404, "not_found");
  }
}
