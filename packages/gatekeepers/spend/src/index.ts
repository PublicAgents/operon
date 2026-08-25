import { Challenge } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";
import { findAgent, parseRoster, type RosterAgent } from "@operon/core";
import { errorResponse, json, readJson, requireBearer, Ledger } from "@operon/worker-kit";
import { SpendLedger } from "./spend-do.js";
import {
  parseCurrencyMap,
  spendTokenVar,
  summarizeChallenge,
  toBaseUnits,
  validatePayUrl,
  type ChallengeSummary
} from "./policy.js";

export { Ledger, SpendLedger };
export * from "./policy.js";

/**
 * The spend Gatekeeper (spec 0002 §2.2): the colony's only payment-key
 * holder. The mind submits {url, maxAmount, reason}; policy runs BEFORE
 * any credential exists. First payment to a new (origin, method,
 * recipient) tuple is held for the operator; approved tuples pay within
 * per-transaction and daily caps reserved atomically. Ambiguous outcomes
 * freeze their reservation (outcome_unknown) and are never auto-retried.
 */

interface Env {
  ROSTER: string;
  SPEND_MAX_TX?: string;
  SPEND_DAILY_CAP?: string;
  SPEND_TESTNET?: string;
  /** Known assets as "0xaddr=decimals,...": the spend-side currency map. */
  SPEND_CURRENCIES?: string;
  /** REQUIRED when SPEND_TESTNET is not "true": the mainnet chain id. */
  SPEND_CHAIN_ID?: string;
  NOTIFY_URL?: string;
  /** Secrets. */
  MPP_PRIVATE_KEY?: string;
  NOTIFY_TOKEN?: string;
  OPERATOR_API_TOKEN?: string;
  /** Per-agent bearers as SPEND_TOKEN_<AGENTID>. */
  [name: string]: unknown;
  SPEND: DurableObjectNamespace<SpendLedger>;
  LEDGER: DurableObjectNamespace<Ledger>;
}

const PROBE_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("spend"));
}

function spendLedger(env: Env) {
  return env.SPEND.get(env.SPEND.idFromName("spend"));
}

function agentFromBearer(request: Request, env: Env): RosterAgent | null {
  const roster = parseRoster(env.ROSTER);
  for (const agent of roster.agents) {
    const expected = env[spendTokenVar(agent.id)];
    if (typeof expected === "string" && expected.length > 0) {
      if (requireBearer(request, expected) === null) return findAgent(roster, agent.id) ?? null;
    }
  }
  return null;
}

async function notifyOperator(
  env: Env,
  text: string,
  actions?: Array<{ label: string; kind: string; agentId: string; id: string }>
): Promise<void> {
  if (!env.NOTIFY_URL || !env.NOTIFY_TOKEN) return;
  try {
    await fetch(env.NOTIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.NOTIFY_TOKEN}` },
      body: JSON.stringify({ text, ...(actions ? { actions } : {}) })
    });
  } catch (error) {
    console.error("spend notify failed", error);
  }
}

/**
 * The SSRF-guarded fetch used for probe and payment: re-validates every
 * URL (redirects included, followed manually), attaches no ambient
 * credentials, and caps response size.
 */
function guardedFetch(zone: string): typeof fetch {
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let hops = 0;
    for (;;) {
      const problem = validatePayUrl(url, zone);
      if (problem) throw new Error(`blocked_url:${problem}`);
      const response = await fetch(url, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        body: init?.body,
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || ++hops > 3) throw new Error("blocked_url:redirects");
        url = new URL(location, url).toString();
        continue;
      }
      // Content-Length is attacker-controlled and only a fast-fail; the
      // REAL limit is enforced when the body is read (readBoundedBody).
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > MAX_RESPONSE_BYTES) throw new Error("blocked_url:too_large");
      return response;
    }
  };
  return guarded as typeof fetch;
}

/** Parse the first MPP challenge off a 402 response. */
function challengeFrom(response: Response): Challenge.Challenge | null {
  try {
    const parsed = Challenge.fromResponseList(response);
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a response body through a hard byte limit: the stream aborts the
 * moment it exceeds the cap, regardless of what Content-Length claimed.
 */
async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("blocked_url:too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Chunked base64: String.fromCharCode over megabytes blows the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

interface PayContext {
  agent: RosterAgent;
  url: string;
  maxAmountDisplay: string;
  reason: string;
}

/**
 * Execute an APPROVED, capped payment: reserve atomically, pay through the
 * client SDK restricted to exactly this challenge, and settle. Any failure
 * after the credential may have left the building keeps the reservation
 * as outcome_unknown (spec §2.2); only pre-credential refusals release.
 */
async function executePayment(
  env: Env,
  context: PayContext,
  summary: ChallengeSummary
): Promise<Response> {
  const zone = parseRoster(env.ROSTER).zone;
  const maxAmount = toBaseUnits(context.maxAmountDisplay, summary.decimals);
  if (maxAmount === null) return errorResponse(400, "invalid_max_amount");
  const at = new Date().toISOString();
  const caps = {
    maxAmount: maxAmount.toString(),
    maxTx: (toBaseUnits(env.SPEND_MAX_TX ?? "0.10", summary.decimals) ?? 0n).toString(),
    dailyCap: (toBaseUnits(env.SPEND_DAILY_CAP ?? "1.00", summary.decimals) ?? 0n).toString()
  };
  const reservation = await spendLedger(env).reserve(
    {
      agentId: context.agent.id,
      url: context.url,
      origin: summary.origin,
      method: summary.method,
      recipient: summary.recipient,
      currency: summary.currency,
      amount: summary.amount,
      reason: context.reason,
      at
    },
    caps
  );
  if (!reservation.ok) {
    await ledger(env).append("pay_refused", { agentId: context.agent.id, url: context.url, problem: reservation.problem });
    return errorResponse(422, reservation.problem);
  }

  if (!env.MPP_PRIVATE_KEY) {
    await spendLedger(env).settle(reservation.outboxId, "released", "spend_unconfigured");
    return errorResponse(503, "spend_unconfigured");
  }

  let credentialCreated = false;
  try {
    const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as `0x${string}`);
    // The client PINS the chain: challenges on any other chain are refused
    // outright. Testnet is moderato (42431); production requires the chain
    // id as explicit colony config and fails closed without it, because a
    // guessed chain id in money code is a wrong-network payment waiting.
    const configuredChain = Number(env.SPEND_CHAIN_ID);
    const expectedChainId =
      env.SPEND_TESTNET === "true"
        ? 42431
        : Number.isInteger(configuredChain) && configuredChain > 0
          ? configuredChain
          : null;
    if (expectedChainId === null) {
      await spendLedger(env).settle(reservation.outboxId, "released", "chain_id_unconfigured");
      return errorResponse(503, "chain_id_unconfigured");
    }
    const payments = Mppx.create({
      methods: [tempo.charge({ account, expectedChainId })],
      polyfill: false,
      fetch: guardedFetch(zone),
      maxPaymentRetries: 1,
      onChallenge: async (challenge, helpers) => {
        // Pay exactly the summarized challenge shape and nothing else: a
        // merchant swapping recipient/amount between probe and payment is
        // refused before a credential exists.
        const again = summarizeChallenge(context.url, challenge, parseCurrencyMap(env.SPEND_CURRENCIES));
        // The FULL approved shape binds: origin, method, recipient, ASSET,
        // and decimals. Same integer amount of a different token, or shifted
        // decimals, is a different payment and is refused pre-credential.
        if (
          !again ||
          again.origin !== summary.origin ||
          again.method !== summary.method ||
          again.recipient !== summary.recipient ||
          again.currency !== summary.currency ||
          again.decimals !== summary.decimals ||
          BigInt(again.amount) > BigInt(summary.amount)
        ) {
          return undefined;
        }
        credentialCreated = true;
        return helpers.createCredential();
      }
    });
    const response = await payments.fetch(context.url);
    if (response.ok) {
      const receipt = response.headers.get("payment-receipt") ?? undefined;
      await spendLedger(env).settle(reservation.outboxId, "paid", undefined, receipt);
      await ledger(env).append("paid", {
        agentId: context.agent.id,
        url: context.url,
        origin: summary.origin,
        amount: summary.display
      });
      await notifyOperator(
        env,
        `[${context.agent.id}] paid ${summary.display} to ${summary.origin} (${context.reason})`
      );
      const body = await readBoundedBody(response);
      return new Response(
        JSON.stringify({
          ok: true,
          status: "paid",
          amount: summary.display,
          receipt,
          contentType: response.headers.get("content-type"),
          contentBase64: toBase64(body)
        }),
        { headers: { "content-type": "application/json" } }
      );
    }
    if (!credentialCreated) {
      // The rail proved negative before any credential existed.
      await spendLedger(env).settle(reservation.outboxId, "released", `pre_credential_status_${response.status}`);
      return errorResponse(502, "payment_refused", `merchant answered ${response.status} before payment`);
    }
    // A credential left and the result is not success: funds may have moved.
    await spendLedger(env).settle(reservation.outboxId, "outcome_unknown", `status_${response.status}`);
    await notifyOperator(
      env,
      `[${context.agent.id}] payment to ${summary.origin} has UNKNOWN outcome (merchant answered ${response.status}). Outbox ${reservation.outboxId}; reconcile before any retry.`
    );
    return errorResponse(502, "outcome_unknown", `outbox ${reservation.outboxId}`);
  } catch (error) {
    const detail = String(error).slice(0, 300);
    if (!credentialCreated) {
      await spendLedger(env).settle(reservation.outboxId, "released", detail);
      return errorResponse(502, "payment_failed", detail);
    }
    await spendLedger(env).settle(reservation.outboxId, "outcome_unknown", detail);
    await notifyOperator(
      env,
      `[${context.agent.id}] payment to ${summary.origin} has UNKNOWN outcome (${detail}). Outbox ${reservation.outboxId}; reconcile before any retry.`
    );
    return errorResponse(502, "outcome_unknown", `outbox ${reservation.outboxId}`);
  }
}

async function handlePay(request: Request, env: Env): Promise<Response> {
  const agent = agentFromBearer(request, env);
  if (!agent) return errorResponse(401, "invalid_token");
  const body = await readJson<{ url?: string; maxAmount?: string; reason?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { url, maxAmount, reason } = body.value;
  if (typeof url !== "string" || typeof maxAmount !== "string" || typeof reason !== "string" || !reason) {
    return errorResponse(400, "invalid_request");
  }
  const roster = parseRoster(env.ROSTER);
  const urlProblem = validatePayUrl(url, roster.zone);
  if (urlProblem) {
    await ledger(env).append("pay_refused", { agentId: agent.id, url, problem: urlProblem });
    return errorResponse(422, urlProblem);
  }

  // The bounded probe: capture the challenge with no payment ability.
  let probe: Response;
  try {
    probe = await guardedFetch(roster.zone)(url);
  } catch (error) {
    return errorResponse(502, "probe_failed", String(error).slice(0, 200));
  }
  if (probe.status !== 402) {
    // Free content needs no payment; return it through the same bounded pipe.
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = await readBoundedBody(probe);
    } catch (error) {
      return errorResponse(502, "probe_failed", String(error).slice(0, 200));
    }
    return json({
      ok: true,
      status: "free",
      httpStatus: probe.status,
      contentType: probe.headers.get("content-type"),
      contentBase64: toBase64(bodyBytes)
    });
  }
  const challenge = challengeFrom(probe);
  const summary = challenge
    ? summarizeChallenge(url, challenge, parseCurrencyMap(env.SPEND_CURRENCIES))
    : null;
  if (!summary) return errorResponse(422, "unreadable_challenge");

  const approved = await spendLedger(env).isApproved(summary);
  if (!approved) {
    const maxBase = toBaseUnits(maxAmount, summary.decimals);
    if (maxBase === null) return errorResponse(400, "invalid_max_amount");
    const held = await spendLedger(env).hold(
      {
        agentId: agent.id,
        url,
        origin: summary.origin,
        method: summary.method,
        recipient: summary.recipient,
        currency: summary.currency,
        amount: summary.amount,
        decimals: summary.decimals,
        display: summary.display,
        maxAmount,
        reason
      },
      new Date().toISOString()
    );
    await ledger(env).append("pay_held", { agentId: agent.id, url, origin: summary.origin, heldId: held.id });
    await notifyOperator(
      env,
      `[${agent.id}] first payment to ${summary.origin} HELD: ${summary.display} (${summary.method}) to ${summary.recipient}\nReason: ${reason}`,
      [
        { label: "Approve", kind: "spend_approve", agentId: agent.id, id: held.id },
        { label: "Reject", kind: "spend_reject", agentId: agent.id, id: held.id }
      ]
    );
    return json({ ok: true, status: "held_for_approval", heldId: held.id, challenge: summary });
  }

  return executePayment(env, { agent, url, maxAmountDisplay: maxAmount, reason }, summary);
}

async function handleDecision(request: Request, env: Env, approve: boolean): Promise<Response> {
  const denied = requireBearer(request, env.OPERATOR_API_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; heldId?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, heldId } = body.value;
  const roster = parseRoster(env.ROSTER);
  const agent = typeof agentId === "string" ? findAgent(roster, agentId) : undefined;
  if (!agent || typeof heldId !== "string") return errorResponse(400, "invalid_request");

  const held = await spendLedger(env).claimHeld(heldId);
  if (!held) return errorResponse(409, "held_unavailable");
  if (!approve) {
    await spendLedger(env).deleteHeld(heldId);
    await ledger(env).append("pay_rejected", { agentId: agent.id, heldId, origin: held.origin });
    return json({ ok: true, status: "rejected" });
  }
  // The approval BINDS the tuple exactly as held (spec §2.2): origin,
  // method, and recipient. A future challenge differing in any of the
  // three is a new hold, not a payable request.
  await spendLedger(env).approveTuple(held);
  await ledger(env).append("tuple_approved", { agentId: agent.id, origin: held.origin, recipient: held.recipient });
  const summary: ChallengeSummary = {
    origin: held.origin,
    method: held.method,
    recipient: held.recipient,
    currency: held.currency,
    amount: held.amount,
    decimals: held.decimals,
    display: held.display
  };
  const response = await executePayment(
    env,
    { agent, url: held.url, maxAmountDisplay: held.maxAmount, reason: held.reason },
    summary
  );
  if (response.ok) {
    try {
      await spendLedger(env).deleteHeld(heldId);
    } catch (error) {
      console.error("held cleanup failed after payment (claimed, will not re-pay)", error);
    }
  } else {
    await spendLedger(env).unclaimHeld(heldId).catch(() => undefined);
  }
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/pay") {
      return handlePay(request, env);
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/approve") {
      return handleDecision(request, env, true);
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/reject") {
      return handleDecision(request, env, false);
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/reconcile") {
      const denied = requireBearer(request, env.OPERATOR_API_TOKEN);
      if (denied) return denied;
      const body = await readJson<{ outboxId?: string; ruling?: string }>(request);
      if (
        !body.ok ||
        typeof body.value.outboxId !== "string" ||
        (body.value.ruling !== "charged" && body.value.ruling !== "not_charged")
      ) {
        return errorResponse(400, "invalid_request");
      }
      const done = await spendLedger(env).reconcile(body.value.outboxId, body.value.ruling);
      await ledger(env).append("reconciled", { outboxId: body.value.outboxId, ruling: body.value.ruling, done });
      return done ? json({ ok: true }) : errorResponse(404, "outbox_row_not_unknown");
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/outbox") {
      // Agents read their own outbox with their bearer; the operator token
      // reads everything.
      const agent = agentFromBearer(request, env);
      if (agent) return json({ ok: true, outbox: await spendLedger(env).outbox(agent.id) });
      const denied = requireBearer(request, env.OPERATOR_API_TOKEN);
      if (denied) return denied;
      return json({ ok: true, outbox: await spendLedger(env).outbox() });
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/spend/ledger") {
      const denied = requireBearer(request, env.OPERATOR_API_TOKEN);
      if (denied) return denied;
      return json(await ledger(env).recent());
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
