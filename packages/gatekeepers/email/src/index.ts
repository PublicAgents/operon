import { findAgent, parseRoster } from "@operon/core";
import { errorResponse, json, readJson, requireBearer } from "@operon/worker-kit";
import PostalMime from "postal-mime";
import { Mailbox, type AttachmentMeta } from "./mailbox.js";
import { identityForAgent, identityForRecipient } from "./identity.js";
import { decideSend, disclosureFooter, fromName, normalizeAddress } from "./policy.js";

export { Mailbox };
export * from "./identity.js";
export * from "./policy.js";

/**
 * The email Gatekeeper. Inbound: Email Routing delivers to email(); we store
 * the message in the agent's per-agent Mailbox and forward a full copy to
 * the operator. Outbound: the wake POSTs /send; we enforce the outbound
 * policy (disclosure appended, first contact held for the operator, rate
 * limited), send through the Email Service binding, and BCC the operator.
 * The wake never holds a mail credential; it only sends data over a bearer.
 */

interface Env {
  ROSTER: string;
  EMAIL_DOMAIN: string;
  EMAIL_SERVICE_TOKEN?: string;
  OPERATOR_EMAIL?: string;
  NOTIFY_URL?: string;
  NOTIFY_TOKEN?: string;
  EMAIL: {
    send(message: {
      to: string;
      from: string;
      subject: string;
      text: string;
      html?: string;
    }): Promise<{ messageId?: string }>;
  };
  MAILBOX: DurableObjectNamespace<Mailbox>;
}

function mailbox(env: Env, agentId: string) {
  return env.MAILBOX.get(env.MAILBOX.idFromName(agentId));
}

/** Address the operator's copy lands at: OPERATOR_EMAIL, else <name>@<zone> (catch-all). */
function operatorCopy(env: Env, localPart: string, zone: string): string {
  return env.OPERATOR_EMAIL && env.OPERATOR_EMAIL.length > 0
    ? env.OPERATOR_EMAIL
    : `${localPart}@${zone}`;
}

async function notifyOperator(env: Env, text: string): Promise<void> {
  if (!env.NOTIFY_URL || !env.NOTIFY_TOKEN) return;
  try {
    await fetch(env.NOTIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.NOTIFY_TOKEN}` },
      body: JSON.stringify({ text })
    });
  } catch (error) {
    console.error("email gatekeeper notify failed", error);
  }
}

async function handleSend(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.EMAIL_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; to?: string; subject?: string; text?: string }>(
    request
  );
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, to, subject, text } = body.value;

  const roster = parseRoster(env.ROSTER);
  const agent = typeof agentId === "string" ? findAgent(roster, agentId) : undefined;
  if (!agent) return errorResponse(404, "unknown_agent", String(agentId));
  if (typeof to !== "string" || !to.includes("@")) return errorResponse(400, "invalid_to");
  if (typeof subject !== "string" || !subject) return errorResponse(400, "missing_subject");
  if (typeof text !== "string" || !text) return errorResponse(400, "missing_text");

  const identity = identityForAgent(agent, env.EMAIL_DOMAIN, roster.zone);
  const recipient = normalizeAddress(to);
  const box = mailbox(env, agent.id);
  const now = new Date().toISOString();
  const decision = decideSend({
    to: recipient,
    correspondents: new Set(await box.correspondents()),
    sentToday: await box.sentToday(now),
    approved: false
  });

  if (decision.action === "reject") {
    return errorResponse(429, "rate_limited", `daily send cap is ${box.dailyCap}`);
  }
  if (decision.action === "hold") {
    const held = await box.hold({ to: recipient, subject, text }, now);
    await notifyOperator(
      env,
      `[${agent.id}] first-contact email HELD to ${recipient}: "${subject}". Approve id ${held.id} or it will not send.`
    );
    return json({ ok: true, status: "held_for_approval", heldId: held.id });
  }

  return doSend(env, agent.id, identity, roster.zone, { to: recipient, subject, text }, now);
}

async function doSend(
  env: Env,
  agentId: string,
  identity: { address: string; name: string; siteUrl: string; localPart: string },
  zone: string,
  msg: { to: string; subject: string; text: string },
  now: string
): Promise<Response> {
  const from = `${fromName(identity.name)} <${identity.address}>`;
  const footer = disclosureFooter(identity.name, identity.address, identity.siteUrl);
  try {
    const result = await env.EMAIL.send({
      to: msg.to,
      from,
      subject: msg.subject,
      text: msg.text + footer
    });
    // Operator oversight copy (guaranteed, independent of bcc support).
    const copyTo = operatorCopy(env, identity.localPart, zone);
    await env.EMAIL.send({
      to: copyTo,
      from,
      subject: `[${identity.name} sent] ${msg.subject}`,
      text: `To: ${msg.to}\n\n${msg.text}${footer}`
    });
    const count = await mailbox(env, agentId).recordSend(msg.to, now);
    await notifyOperator(env, `[${agentId}] emailed ${msg.to}: "${msg.subject}" (send ${count} today)`);
    return json({ ok: true, status: "sent", messageId: result.messageId, sentToday: count });
  } catch (error) {
    return errorResponse(502, "send_failed", String(error).slice(0, 300));
  }
}

async function handleApprove(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.EMAIL_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; heldId?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, heldId } = body.value;
  const roster = parseRoster(env.ROSTER);
  const agent = typeof agentId === "string" ? findAgent(roster, agentId) : undefined;
  if (!agent || typeof heldId !== "string") return errorResponse(400, "invalid_request");
  const held = await mailbox(env, agent.id).takeHeld(heldId);
  if (!held) return errorResponse(404, "held_not_found", heldId);
  const identity = identityForAgent(agent, env.EMAIL_DOMAIN, roster.zone);
  return doSend(
    env,
    agent.id,
    identity,
    roster.zone,
    { to: held.to, subject: held.subject, text: held.text },
    new Date().toISOString()
  );
}

async function handlePull(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.EMAIL_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const roster = parseRoster(env.ROSTER);
  const agent = typeof body.value.agentId === "string" ? findAgent(roster, body.value.agentId) : undefined;
  if (!agent) return errorResponse(404, "unknown_agent");
  return json({ ok: true, messages: await mailbox(env, agent.id).pull() });
}

export default {
  async email(message, env, ctx): Promise<void> {
    const roster = parseRoster(env.ROSTER);
    const identity = identityForRecipient(roster, env.EMAIL_DOMAIN, message.to);
    if (!identity) {
      message.setReject("No such mailbox");
      return;
    }
    const parsed = await PostalMime.parse(message.raw);
    const attachments: AttachmentMeta[] = (parsed.attachments ?? []).map(a => ({
      filename: a.filename ?? "attachment",
      mimeType: a.mimeType ?? "application/octet-stream",
      size: typeof a.content === "string" ? a.content.length : (a.content?.byteLength ?? 0)
    }));
    await mailbox(env, identity.agentId).deliver({
      from: parsed.from?.address ?? message.from,
      subject: parsed.subject ?? "(no subject)",
      date: parsed.date ?? new Date().toISOString(),
      text: (parsed.text ?? "").slice(0, 100_000),
      messageId: parsed.messageId,
      attachments: attachments.length ? attachments : undefined
    });
    // Full copy (attachments and all) to the operator's catch-all box.
    const copyTo = operatorCopy(env, identity.localPart, roster.zone);
    ctx.waitUntil(message.forward(copyTo).catch(err => console.error("forward failed", err)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST") {
      if (url.pathname === "/gatekeeper/email/send") return handleSend(request, env);
      if (url.pathname === "/gatekeeper/email/pull") return handlePull(request, env);
      if (url.pathname === "/gatekeeper/email/approve") return handleApprove(request, env);
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
