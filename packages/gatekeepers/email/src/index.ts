import { findAgent, parseRoster } from "@operon/core";
import { recordMessage } from "@operon/chronicle";
import { WorkerEntrypoint } from "cloudflare:workers";
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
  /** Comma-separated addresses every agent mail is copied or forwarded to; unset means <name>@<zone>. */
  FORWARD_AGENT_EMAILS_TO?: string;
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

/** The operator's addresses, as configured: FORWARD_AGENT_EMAILS_TO split on commas, blanks dropped. */
function forwardAddresses(env: Env): string[] {
  return (env.FORWARD_AGENT_EMAILS_TO ?? "")
    .split(",")
    .map(address => address.trim())
    .filter(address => address.length > 0);
}

/** Where the operator's copies land: FORWARD_AGENT_EMAILS_TO, else <name>@<zone> (catch-all). */
function operatorCopies(env: Env, localPart: string, zone: string): string[] {
  const configured = forwardAddresses(env);
  return configured.length > 0 ? configured : [`${localPart}@${zone}`];
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

  // One copy per configured address; a single failure marks the copy failed.
  let copied = true;
  for (const copyTo of operatorCopies(env, identity.localPart, zone)) {
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

/** Every send awaiting the operator (the approvals surface). */
async function handleHeld(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ agentId?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const roster = parseRoster(env.ROSTER);
  const agent = typeof body.value.agentId === "string" ? findAgent(roster, body.value.agentId) : undefined;
  if (!agent) return errorResponse(404, "unknown_agent");
  return json({ ok: true, held: await mailbox(env, agent.id).listHeld() });
}

export default {
  async email(message, env, ctx): Promise<void> {
    const roster = parseRoster(env.ROSTER);
    const identity = identityForRecipient(roster, env.EMAIL_DOMAIN, message.to);
    if (!identity) {
      // Not an agent's address (hello@, a retired name, a typo): the
      // zone's catch-all lands here, so the mail goes on to the
      // operator's addresses rather than bouncing. Nothing else is
      // done with it: no mailbox, no notify, no agent ever sees it.
      // Only with no forward address configured does it bounce.
      const operators = forwardAddresses(env);
      if (operators.length === 0) {
        message.setReject("No such mailbox");
        return;
      }
      // Awaited, not backgrounded: a forward that fails (an address
      // Cloudflare has not verified yet) bounces the mail to its sender
      // rather than losing it in a log line.
      let delivered = 0;
      for (const to of operators) {
        try {
          await message.forward(to);
          delivered += 1;
        } catch (err) {
          console.error("operator forward failed", err);
        }
      }
      if (delivered === 0) message.setReject("Mailbox unavailable");
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
    // Full copy (attachments and all) to every configured operator address.
    for (const copyTo of operatorCopies(env, identity.localPart, roster.zone)) {
      ctx.waitUntil(message.forward(copyTo).catch(err => console.error("forward failed", err)));
    }
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
/**
 * The operator's own mail path (spec 0007 §7), binding-only: another
 * Gatekeeper hands this one a message FOR THE OPERATOR and it goes to
 * every FORWARD_AGENT_EMAILS_TO address. It is deliberately outside the agent's outbound
 * policy: the operator is not a stranger, so there is no first-contact
 * hold, and a notification must not consume the agent's daily send
 * budget or be silently dropped when that budget is spent. It is
 * still ledgered, and the caller carries its own volume backstop.
 */
export class OperatorMail extends WorkerEntrypoint<Env> {
  async notifyOperator(input: { agentId: string; subject: string; text: string }): Promise<{
    ok: boolean;
    detail?: string;
    /** False when this Gatekeeper's ledger could not record the outcome. */
    outcomeRecorded?: boolean;
  }> {
    // No fallback to a colony catch-all here: a notification the
    // operator never configured an address for should say so, not
    // vanish into a mailbox nobody reads.
    const recipients = forwardAddresses(this.env);
    if (recipients.length === 0) return { ok: false, detail: "operator_email_unset" };
    // Audit doctrine (spec 0003): the record lands BEFORE the
    // privileged act, and the act refuses when it cannot be recorded.
    // A notification is worth less than an unauditable send.
    // Intent first, and the intent row says INTENT: a row claiming a
    // delivered mail must never outlive a send that failed.
    try {
      await ledger(this.env).append("operator_mail_requested", {
        agentId: input.agentId,
        subject: input.subject
      });
    } catch (error) {
      console.error("operator mail refused: audit unavailable", error);
      return { ok: false, detail: "audit_unavailable" };
    }
    const from = { email: `${input.agentId}@${this.env.EMAIL_DOMAIN}`, name: input.agentId };
    try {
      for (const to of recipients) {
        await this.env.EMAIL.send({
          to,
          from,
          subject: input.subject,
          text: input.text
        });
      }
    } catch (error) {
      const detail = String(error).slice(0, 200);
      try {
        await ledger(this.env).append("operator_mail_failed", {
          agentId: input.agentId,
          subject: input.subject,
          detail
        });
        return { ok: false, detail, outcomeRecorded: true };
      } catch (auditError) {
        // The ledger holds only the requested row, which reads as
        // outcome-unknown; but this outcome is KNOWN and worse than
        // unknown, so it escalates on the other channel rather than
        // leaving an auditor to assume the softer reading.
        console.error("operator mail failure could not be ledgered", auditError);
        await notifyOperator(
          this.env,
          `audit gap: operator mail (${input.subject}) FAILED to send and the failure row could not be written either; the unresolved operator_mail_requested row is a known failure, not an unknown one.`
        ).catch(() => undefined);
      }
      return { ok: false, detail, outcomeRecorded: false };
    }
    // The send is an external side effect and the ledger is a Durable
    // Object: they cannot commit together, so the outcome row is
    // retried before the gap is declared. Most failures here are
    // transient.
    let outcomeError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await ledger(this.env).append("operator_mail_sent", {
          agentId: input.agentId,
          subject: input.subject
        });
        outcomeError = null;
        break;
      } catch (error) {
        outcomeError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    try {
      if (outcomeError) throw outcomeError;
    } catch (error) {
      // Delivered, but the ledger cannot say so even after retries.
      // This is not an undefined gap: a requested row with no outcome
      // row IS the outcome-unknown state, the same doctrine spec 0002
      // applies to a payment whose result was lost (the record assumes
      // it MAY have happened and an operator reconciles). Escalate on
      // a DIFFERENT channel than the one that just succeeded, and tell
      // the caller, so the ambiguity is visible from two directions
      // rather than reconstructed by guesswork later.
      console.error("operator mail sent but outcome row lost", error);
      await notifyOperator(
        this.env,
        `audit gap: operator mail to ${recipients.join(", ")} (${input.subject}) was DELIVERED but its outcome row could not be written after three attempts. Read the unresolved operator_mail_requested row as outcome-unknown; this notice is its resolution.`
      ).catch(() => undefined);
      return { ok: true, detail: "outcome_unrecorded", outcomeRecorded: false };
    }
    return { ok: true, outcomeRecorded: true };
  }
}

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
    if (request.method === "POST" && url.pathname === "/gatekeeper/email/held") {
      return handleHeld(request, this.env);
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/email/ledger") {
      return Promise.resolve(ledger(this.env).recent()).then(rows => json(rows));
    }
    return Promise.resolve(errorResponse(404, "not_found"));
  }
}
