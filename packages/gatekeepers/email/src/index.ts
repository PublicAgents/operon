import { findAgent, parseRoster } from "@operon/core";
import { recordMessage } from "@operon/chronicle";
import { errorResponse, json, readJson, requireBearer, Ledger, OpsEntrypoint,
  notifyOperator as sendOperatorNotify,
  type OperatorAction,
  type TelegramGatewayBinding
} from "@operon/worker-kit";
import PostalMime from "postal-mime";
import { Mailbox, type AttachmentMeta } from "./mailbox.js";
import { identityForAgent, identityForRecipient } from "./identity.js";
import { disclosureFooter, fromName, normalizeAddress } from "./policy.js";

export { Mailbox, Ledger };
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
  /** telegram Gatekeeper over a service binding: the only path that carries buttons. */
  TELEGRAM?: TelegramGatewayBinding;
  /** Central audit mirror; optional (a deployment without D1 still works). */
  CHRONICLE?: D1Database;
  EMAIL: {
    send(message: {
      to: string;
      from: { email: string; name?: string };
      subject: string;
      text: string;
      html?: string;
    }): Promise<{ messageId?: string }>;
  };
  MAILBOX: DurableObjectNamespace<Mailbox>;
  LEDGER: DurableObjectNamespace<Ledger>;
}

function mailbox(env: Env, agentId: string) {
  return env.MAILBOX.get(env.MAILBOX.idFromName(agentId));
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("email"));
}

/** Address the operator's copy lands at: OPERATOR_EMAIL, else <name>@<zone> (catch-all). */
function operatorCopy(env: Env, localPart: string, zone: string): string {
  return env.OPERATOR_EMAIL && env.OPERATOR_EMAIL.length > 0
    ? env.OPERATOR_EMAIL
    : `${localPart}@${zone}`;
}

/**
 * Notify the operator; optional actions render as inline buttons in
 * Telegram (approve/reject a held send) and execute back against this
 * Gatekeeper when pressed.
 */
async function notifyOperator(
  env: Env,
  text: string,
  actions?: OperatorAction[]
): Promise<void> {
  await sendOperatorNotify(env, text, actions ? { actions } : {});
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

  // Atomic check-and-reserve in the DO: two overlapping sends near the cap
  // cannot both pass, and the slot is reserved before delivery.
  const reservation = await box.reserveSend(recipient, subject, now, false);
  if (reservation.action === "reject") {
    return errorResponse(429, "rate_limited", `daily send cap is ${box.dailyCap}`);
  }
  if (reservation.action === "hold") {
    const held = await box.hold({ to: recipient, subject, text }, now);
    await notifyOperator(
      env,
      `[${agent.id}] first-contact email HELD to ${recipient}: "${subject}"\n\n${text.slice(0, 1000)}`,
      [
        { label: "Approve", kind: "email_approve", agentId: agent.id, id: held.id },
        { label: "Reject", kind: "email_reject", agentId: agent.id, id: held.id }
      ]
    );
    return json({ ok: true, status: "held_for_approval", heldId: held.id });
  }

  return deliver(env, agent.id, identity, roster.zone, { to: recipient, subject, text }, now, reservation.count);
}

/**
 * Deliver a reserved send. The recipient send is the authoritative action;
 * once it succeeds the send is real and counted, so the operator copy and
 * notify must never undo it: a copy failure falls back to a Telegram notify
 * carrying the content, so oversight is preserved through the other channel.
 * A recipient-send failure releases the reserved slot.
 */
async function deliver(
  env: Env,
  agentId: string,
  identity: { address: string; name: string; siteUrl: string; localPart: string },
  zone: string,
  msg: { to: string; subject: string; text: string },
  now: string,
  count: number
): Promise<Response> {
  // The structured send() takes from as an object; the RFC "Name <addr>"
  // string form is SMTP-only and rejected as an invalid address.
  const from = { email: identity.address, name: fromName(identity.name) };
  const footer = disclosureFooter(identity.name, identity.address, identity.siteUrl);

  let result: { messageId?: string };
  try {
    result = await env.EMAIL.send({ to: msg.to, from, subject: msg.subject, text: msg.text + footer });
  } catch (error) {
    await mailbox(env, agentId).release(now); // give the reserved slot back
    return errorResponse(502, "send_failed", String(error).slice(0, 300));
  }

  // Sent for real from here on. The durable operator-visible record already
  // exists: reserveSend wrote an outbox row in the DO, before this network
  // send, readable via /outbox. So every channel here is best-effort and
  // non-throwing (a failure can neither hide the send nor, for an approved
  // send, strand the claimed message): the ledger, the operator email copy,
  // and the Telegram notify are richer surfaces layered on the outbox.
  console.log(`email_sent agent=${agentId} to=${msg.to} count=${count}`);
  try {
    await ledger(env).append("email_sent", { agentId, to: msg.to, subject: msg.subject, count });
  } catch (error) {
    console.error("email ledger append failed", error);
  }
  // Chronicle mirror with the full body (the ledger row above carries the
  // envelope only). Best-effort like every mirror write.
  await recordMessage(env.CHRONICLE, {
    at: now,
    kind: "email_out",
    agentId,
    sender: identity.address,
    recipient: msg.to,
    subject: msg.subject,
    body: msg.text,
    refId: result.messageId,
    meta: { count }
  });

  const copyTo = operatorCopy(env, identity.localPart, zone);
  let copied = true;
  try {
    await env.EMAIL.send({
      to: copyTo,
      from,
      subject: `[${identity.name} sent] ${msg.subject}`,
      text: `To: ${msg.to}\n\n${msg.text}${footer}`
    });
  } catch {
    copied = false;
  }
  await notifyOperator(
    env,
    `[${agentId}] emailed ${msg.to}: "${msg.subject}" (send ${count} today)` +
      (copied ? "" : `\nOPERATOR EMAIL COPY FAILED. Content:\n${msg.text.slice(0, 1500)}`)
  );
  return json({ ok: true, status: "sent", messageId: result.messageId, sentToday: count, copied });
}

async function handleApprove(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ agentId?: string; heldId?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, heldId } = body.value;
  const roster = parseRoster(env.ROSTER);
  const agent = typeof agentId === "string" ? findAgent(roster, agentId) : undefined;
  if (!agent || typeof heldId !== "string") return errorResponse(400, "invalid_request");
  const box = mailbox(env, agent.id);
  // Atomically claim: only the first concurrent approval of this id gets the
  // message, so it can never be sent twice. Failure unclaims for retry.
  const held = await box.claimHeld(heldId);
  if (!held) return errorResponse(409, "held_unavailable", "already claimed or not found");

  const now = new Date().toISOString();
  const reservation = await box.reserveSend(held.to, held.subject, now, true);
  if (reservation.action === "reject") {
    await box.unclaimHeld(heldId);
    return errorResponse(429, "rate_limited", `daily send cap is ${box.dailyCap}`);
  }
  const identity = identityForAgent(agent, env.EMAIL_DOMAIN, roster.zone);
  const response = await deliver(
    env,
    agent.id,
    identity,
    roster.zone,
    { to: held.to, subject: held.subject, text: held.text },
    now,
    reservation.action === "send" ? reservation.count : 0
  );
  if (response.ok) {
    // Delivered. Cleanup is best-effort: a failed delete leaves a claimed
    // orphan, which the claim keeps from ever resending, so it must not turn
    // a successful delivery into an error. Unclaim only on delivery failure,
    // so the message can be retried.
    try {
      await box.deleteHeld(heldId);
    } catch (error) {
      console.error(`held cleanup failed after delivery (claimed, will not resend): ${String(error)}`);
    }
  } else {
    await box.unclaimHeld(heldId).catch(() => undefined);
  }
  return response;
}

async function handleReject(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ agentId?: string; heldId?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, heldId } = body.value;
  const roster = parseRoster(env.ROSTER);
  const agent = typeof agentId === "string" ? findAgent(roster, agentId) : undefined;
  if (!agent || typeof heldId !== "string") return errorResponse(400, "invalid_request");
  await mailbox(env, agent.id).deleteHeld(heldId);
  try {
    await ledger(env).append("held_rejected", { agentId: agent.id, heldId });
  } catch (error) {
    console.error("ledger append failed", error);
  }
  return json({ ok: true, status: "rejected" });
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

async function handleAck(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.EMAIL_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; ids?: string[] }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const roster = parseRoster(env.ROSTER);
  const agent = typeof body.value.agentId === "string" ? findAgent(roster, body.value.agentId) : undefined;
  if (!agent) return errorResponse(404, "unknown_agent");
  const ids = Array.isArray(body.value.ids) ? body.value.ids.filter(i => typeof i === "string") : [];
  await mailbox(env, agent.id).ack(ids);
  return json({ ok: true, acked: ids.length });
}

/**
 * The stored, UNREDACTED original of one inbound message. Delivery may
 * have redacted a scanner-tripping line (operon#24), but a verification
 * link or sign-up URL in that line is still the agent's mail to read:
 * redaction protects the repo, not the agent's access. The value flows
 * to the wake only; whatever the agent does with it stays subject to the
 * same sweeps as everything else.
 */
async function handleOriginal(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.EMAIL_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; id?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, id } = body.value;
  const roster = parseRoster(env.ROSTER);
  const agent = typeof agentId === "string" ? findAgent(roster, agentId) : undefined;
  if (!agent) return errorResponse(404, "unknown_agent");
  if (typeof id !== "string" || !/^[0-9a-f-]{8,36}$/.test(id)) {
    return errorResponse(400, "invalid_id", "pass the message id (or its 8+ char prefix from the inbox file name)");
  }
  const message = await mailbox(env, agent.id).original(id);
  if (!message) return errorResponse(404, "message_not_found", id);
  try {
    await ledger(env).append("original_read", { agentId: agent.id, id: message.id });
  } catch (error) {
    console.error("email ledger append failed", error);
  }
  return json({ ok: true, message });
}

async function handleOutbox(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ agentId?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const roster = parseRoster(env.ROSTER);
  const agent = typeof body.value.agentId === "string" ? findAgent(roster, body.value.agentId) : undefined;
  if (!agent) return errorResponse(404, "unknown_agent");
  return json({ ok: true, outbox: await mailbox(env, agent.id).outbox() });
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
    const from = parsed.from?.address ?? message.from;
    const subject = parsed.subject ?? "(no subject)";
    const text = (parsed.text ?? "").slice(0, 100_000);
    await mailbox(env, identity.agentId).deliver({
      from,
      subject,
      date: parsed.date ?? new Date().toISOString(),
      text,
      messageId: parsed.messageId,
      attachments: attachments.length ? attachments : undefined
    });
    // Full copy (attachments and all) to the operator's catch-all box.
    const copyTo = operatorCopy(env, identity.localPart, roster.zone);
    ctx.waitUntil(message.forward(copyTo).catch(err => console.error("forward failed", err)));
    // Telegram is the oversight channel the colony controls end to end:
    // the email forward above rides third-party deliverability (strict-
    // DMARC senders routinely get spam-foldered after forwarding), so
    // the operator hears about every inbound mail here too. Content is
    // untrusted display text, exactly like a held-send notification.
    ctx.waitUntil(
      notifyOperator(
        env,
        `[${identity.agentId}] inbound email from ${from.slice(0, 200)}: "${subject.slice(0, 200)}"\n\n` +
          `${text.slice(0, 800)}${text.length > 800 ? "…" : ""}\n\n` +
          `(full copy: the chronicle, the agent's next wake, and your mailbox forward)`
      )
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST") {
      if (url.pathname === "/gatekeeper/email/send") return handleSend(request, env);
      if (url.pathname === "/gatekeeper/email/pull") return handlePull(request, env);
      if (url.pathname === "/gatekeeper/email/ack") return handleAck(request, env);
      if (url.pathname === "/gatekeeper/email/original") return handleOriginal(request, env);
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;

/**
 * The operator's binding-only decision + read surface (spec 0003 step 3):
 * approve/reject a held first-contact email, the outbox, the ledger. No
 * bearer, the binding is the auth. Moving these off EMAIL_SERVICE_TOKEN
 * (which the wake container also holds) also stops a compromised wake
 * from approving its own held email.
 */
export class Ops extends OpsEntrypoint<Env> {
  protected handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/gatekeeper/email/approve") {
      return handleApprove(request, this.env);
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/email/reject") {
      return handleReject(request, this.env);
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/email/outbox") {
      return handleOutbox(request, this.env);
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/email/ledger") {
      return Promise.resolve(ledger(this.env).recent()).then(rows => json(rows));
    }
    return Promise.resolve(errorResponse(404, "not_found"));
  }
}
