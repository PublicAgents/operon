import { Challenge } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { createClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo as tempoMainnetChain, tempoModerato } from "viem/tempo/chains";
import { findAgent, parseRoster, type RosterAgent } from "@operon/core";
import { errorResponse, json, readJson, requireBearer, Ledger,
  notifyOperator as sendOperatorNotify,
  type OperatorAction,
  type TelegramGatewayBinding, OpsEntrypoint, formatUnits, erc20Balance } from "@operon/worker-kit";
import { SpendLedger , type HeldPayment } from "./spend-do.js";
import {
  parseCurrencyMap,
  spendTokenVar,
  summarizeChallenge,
  toBaseUnits,
  validatePayUrl,
  type ChallengeSummary, type Allowance } from "./policy.js";

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
  /** Ceiling for HOLDABLE above-cap proposals (display units); unset = feature off. */
  SPEND_HOLD_MAX?: string;
  /** One-time allowance lifetime in days (default 7). */
  SPEND_ALLOWANCE_DAYS?: string;
  SPEND_DAILY_CAP?: string;
  SPEND_TESTNET?: string;
  /** Known assets as "0xaddr=decimals,...": the spend-side currency map. */
  SPEND_CURRENCIES?: string;
  /** Optional dedicated RPC for push-mode payments (public RPC rate-limits Workers). */
  SPEND_RPC_URL?: string;
  /**
   * Tempo API key: chain reads go through the authenticated gateway
   * (api.tempo.xyz/rpc/{chain}) instead of the public RPC, whose per-IP
   * limits reject Workers egress. Takes precedence over SPEND_RPC_URL.
   */
  TEMPO_API_KEY?: string;
  /** REQUIRED when SPEND_TESTNET is not "true": the mainnet chain id. */
  SPEND_CHAIN_ID?: string;
  NOTIFY_URL?: string;
  /** Secrets. */
  MPP_PRIVATE_KEY?: string;
  NOTIFY_TOKEN?: string;
  /** telegram Gatekeeper over a service binding: the only path that carries buttons. */
  TELEGRAM?: TelegramGatewayBinding;
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
  actions?: OperatorAction[]
): Promise<void> {
  await sendOperatorNotify(env, text, actions ? { actions } : {});
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
  /**
   * When set, an over-cap challenge holds as a spend proposal (kind
   * above_cap) instead of refusing; unset on approval-time executions
   * where re-holding would loop.
   */
  holdPayment?: Omit<HeldPayment, "id" | "queuedAt" | "claimed">;
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
  const row = {
    agentId: context.agent.id,
    url: context.url,
    origin: summary.origin,
    method: summary.method,
    recipient: summary.recipient,
    currency: summary.currency,
    amount: summary.amount,
    reason: context.reason,
    at
  };
  const caps = {
    maxAmount: maxAmount.toString(),
    maxTx: (toBaseUnits(env.SPEND_MAX_TX ?? "0.10", summary.decimals) ?? 0n).toString(),
    dailyCap: (toBaseUnits(env.SPEND_DAILY_CAP ?? "1.00", summary.decimals) ?? 0n).toString()
  };
  // The reserve-or-allowance-or-hold decision is ONE serialized DO turn
  // (spec 0002 §2.2): no worker-side classification can go stale between
  // reading the budget and reserving against it. Expiry lapses observed
  // by this payment path are ledgered first (at-least-once).
  await ledgerExpiredAllowances(env, at);
  const holdMaxBase = context.holdPayment && env.SPEND_HOLD_MAX
    ? toBaseUnits(env.SPEND_HOLD_MAX, summary.decimals)
    : null;
  const decision = await spendLedger(env).decidePay(
    row,
    caps,
    summary,
    context.holdPayment && holdMaxBase !== null
      ? { payment: context.holdPayment, holdMax: holdMaxBase.toString() }
      : null
  );
  if (decision.outcome === "held") {
    if (!decision.deduped) {
      await ledger(env).append("pay_held", {
        agentId: context.agent.id, url: context.url, origin: summary.origin, heldId: decision.held.id, kind: "above_cap"
      });
      await notifyOperator(
        env,
        `[${context.agent.id}] ABOVE-CAP payment to ${summary.origin} HELD: ${summary.display} (${summary.method}) to ${summary.recipient}\nApproval mints a one-time allowance; the agent settles by re-running the pay.\nReason: ${context.reason}`,
        [
          { label: "Approve", kind: "spend_approve", agentId: context.agent.id, id: decision.held.id },
          { label: "Reject", kind: "spend_reject", agentId: context.agent.id, id: decision.held.id }
        ]
      );
    }
    return json({ ok: true, status: "held_for_approval", heldId: decision.held.id, challenge: summary });
  }
  if (decision.outcome === "refused") {
    await ledger(env).append("pay_refused", { agentId: context.agent.id, url: context.url, problem: decision.problem });
    return errorResponse(422, decision.problem);
  }
  if (decision.allowanceId !== undefined) {
    await ledger(env).append("allowance_consumed", {
      agentId: context.agent.id,
      allowanceId: decision.allowanceId,
      outboxId: decision.outboxId,
      origin: summary.origin,
      display: summary.display
    });
  }
  const reservation = { ok: true as const, outboxId: decision.outboxId };

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
    // Chain reads (fees, block state) must not hit the public RPC: its
    // per-IP limits reject shared Workers egress. Preference order: the
    // authenticated Tempo API gateway (Bearer key via a custom viem
    // client, mirroring the SDK's own default construction), then a
    // dedicated SPEND_RPC_URL, then the public RPC as last resort.
    const knownChains: Record<number, Parameters<typeof createClient>[0]["chain"]> = {
      [tempoModerato.id]: tempoModerato,
      [tempoMainnetChain.id]: tempoMainnetChain
    };
    const apiKey = typeof env.TEMPO_API_KEY === "string" && env.TEMPO_API_KEY.length > 0 ? env.TEMPO_API_KEY : null;
    const transportFor = apiKey
      ? ({ chainId }: { chainId?: number }) => {
          const id = chainId ?? expectedChainId;
          return createClient({
            chain: knownChains[id] ?? { ...tempoModerato, id },
            transport: http(`https://api.tempo.xyz/rpc/${id}`, {
              fetchOptions: { headers: { authorization: `Bearer ${apiKey}` } }
            })
          });
        }
      : null;
    const payments = Mppx.create({
      methods: [
        tempo.charge({
          account,
          expectedChainId,
          ...(transportFor
            ? { getClient: transportFor }
            : typeof env.SPEND_RPC_URL === "string" && env.SPEND_RPC_URL.length > 0
              ? { rpcUrl: { [expectedChainId]: env.SPEND_RPC_URL } }
              : {})
        })
      ],
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
        // PULL mode: the credential is an offline-signed authorization the
        // MERCHANT broadcasts, so credential creation needs no chain reads.
        // (Push mode builds a full transaction and needs RPC, which the
        // public endpoints rate-limit for Workers; SPEND_RPC_URL exists
        // for that path.) The flag flips only once a credential actually
        // exists: a failure during creation is pre-credential and safe to
        // release.
        const credential = await helpers.createCredential({ mode: "pull" });
        credentialCreated = true;
        return credential;
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
    const { held, deduped } = await spendLedger(env).hold(
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
    if (!deduped) {
      await ledger(env).append("pay_held", { agentId: agent.id, url, origin: summary.origin, heldId: held.id });
      await notifyOperator(
        env,
        `[${agent.id}] first payment to ${summary.origin} HELD: ${summary.display} (${summary.method}) to ${summary.recipient}\nReason: ${reason}`,
        [
          { label: "Approve", kind: "spend_approve", agentId: agent.id, id: held.id },
          { label: "Reject", kind: "spend_reject", agentId: agent.id, id: held.id }
        ]
      );
    }
    return json({ ok: true, status: "held_for_approval", heldId: held.id, challenge: summary });
  }

  // Approved merchant: the reserve-or-allowance-or-hold decision runs
  // atomically inside executePayment's DO turn. The hold payload rides
  // along so an over-cap challenge becomes a spend proposal instead of
  // a refusal (feature off without SPEND_HOLD_MAX).
  return executePayment(
    env,
    {
      agent,
      url,
      maxAmountDisplay: maxAmount,
      reason,
      holdPayment: {
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
        reason,
        kind: "above_cap"
      }
    },
    summary
  );
}

/**
 * Ledger allowances that lapsed by expiry, at-least-once: the rows are
 * appended FIRST and the DO acks each after it lands, so a failed
 * append re-surfaces the lapse instead of silently marking it swept
 * (spec §2.2: every state transition of a standing authorization
 * leaves an audit record; a duplicate row is benign, a lost one not).
 */
async function ledgerExpiredAllowances(env: Env, nowIso: string): Promise<void> {
  for (const lapsed of await spendLedger(env).lapsedUnledgered(nowIso)) {
    await ledger(env).append("allowance_expired", {
      agentId: lapsed.agentId,
      allowanceId: lapsed.id,
      origin: lapsed.origin,
      display: lapsed.display,
      expiresAt: lapsed.expiresAt
    });
    await spendLedger(env).markExpiryLedgered(lapsed.id);
  }
}

async function handleDecision(request: Request, env: Env, approve: boolean): Promise<Response> {
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

  // An over-cap hold (explicitly above_cap, or a first-merchant hold
  // whose amount the caps would refuse anyway) settles by ALLOWANCE:
  // nothing moves at approval, because the held challenge is minutes
  // stale and the wallet may not be funded yet. The agent re-runs the
  // pay; a fresh matching challenge consumes the allowance.
  const maxTx = toBaseUnits(env.SPEND_MAX_TX ?? "0.10", held.decimals) ?? 0n;
  const dailyCap = toBaseUnits(env.SPEND_DAILY_CAP ?? "1.00", held.decimals) ?? 0n;
  // Remaining budget counts: a held amount that fits the caps on paper
  // but not today's remaining budget would refuse over_daily_cap at
  // approval time, so it settles by allowance too.
  const spentNow = BigInt(await spendLedger(env).spentToday(agent.id, new Date().toISOString()));
  const overCap = BigInt(held.amount) > maxTx || spentNow + BigInt(held.amount) > dailyCap;
  if (held.kind === "above_cap" || overCap) {
    const days = Number(env.SPEND_ALLOWANCE_DAYS);
    const expiryDays = Number.isInteger(days) && days > 0 ? days : 7;
    const now = Date.now();
    const allowance: Allowance = {
      id: crypto.randomUUID(),
      agentId: agent.id,
      origin: held.origin,
      method: held.method,
      recipient: held.recipient,
      currency: held.currency,
      maxAmount: held.amount,
      decimals: held.decimals,
      display: held.display,
      mintedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiryDays * 24 * 60 * 60 * 1000).toISOString()
    };
    await spendLedger(env).mintAllowance(allowance);
    await spendLedger(env).deleteHeld(heldId);
    await ledger(env).append("allowance_minted", {
      agentId: agent.id,
      allowanceId: allowance.id,
      origin: allowance.origin,
      recipient: allowance.recipient,
      display: allowance.display,
      expiresAt: allowance.expiresAt
    });
    return json({ ok: true, status: "allowance_minted", allowance });
  }

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

/** Reconcile an ambiguous outbox row (operator ruling). */
async function handleReconcile(request: Request, env: Env): Promise<Response> {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/pay") {
      return handlePay(request, env);
    }
    // An agent reads its OWN outbox with its per-agent bearer; the full
    // outbox is the operator's, on the binding-only Ops entrypoint.
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/outbox") {
      const agent = agentFromBearer(request, env);
      if (!agent) return errorResponse(401, "unauthorized");
      return json({ ok: true, outbox: await spendLedger(env).outbox(agent.id) });
    }
    // Cross-wake visibility (spec §2.2): a memoryless agent can see its
    // own pending holds and unspent allowances without asking the
    // operator what happened while it slept.
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/proposals") {
      const agent = agentFromBearer(request, env);
      if (!agent) return errorResponse(401, "unauthorized");
      const now = new Date().toISOString();
      await ledgerExpiredAllowances(env, now);
      const held = (await spendLedger(env).listHeld()).filter(row => row.agentId === agent.id);
      const allowances = (await spendLedger(env).listAllowances(agent.id)).filter(
        allowance =>
          allowance.consumedAt === undefined &&
          allowance.revokedAt === undefined &&
          allowance.expiresAt > now
      );
      return json({ ok: true, held, allowances });
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;

/**
 * The spend wallet, for the operator: the ADDRESS derived from the key
 * (the key itself never leaves the Worker), the configured chain, and a
 * best-effort on-chain balance for every currency in the colony's
 * allowlist. Funding the wallet is sending to this address; there is
 * deliberately no other way to touch it.
 */
async function handleWallet(env: Env): Promise<Response> {
  if (!env.MPP_PRIVATE_KEY) return errorResponse(503, "spend_unconfigured");
  const address = privateKeyToAccount(env.MPP_PRIVATE_KEY as `0x${string}`).address;
  const configuredChain = Number(env.SPEND_CHAIN_ID);
  const chainId =
    env.SPEND_TESTNET === "true"
      ? 42431
      : Number.isInteger(configuredChain) && configuredChain > 0
        ? configuredChain
        : null;
  const currencies = [...parseCurrencyMap(env.SPEND_CURRENCIES).entries()];
  const apiKey = typeof env.TEMPO_API_KEY === "string" && env.TEMPO_API_KEY.length > 0 ? env.TEMPO_API_KEY : null;
  const rpcUrl = apiKey
    ? `https://api.tempo.xyz/rpc/${chainId}`
    : typeof env.SPEND_RPC_URL === "string" && env.SPEND_RPC_URL.length > 0
      ? env.SPEND_RPC_URL
      : null;
  const balances = await Promise.all(
    currencies.map(async ([currency, decimals]) => {
      const raw = rpcUrl && chainId !== null ? await erc20Balance(rpcUrl, apiKey, currency, address) : null;
      return { currency, decimals, raw, display: raw === null ? null : formatUnits(raw, decimals) };
    })
  );
  return json({ ok: true, address, chainId, balances });
}

/**
 * The operator's binding-only decision + read surface (spec 0003 step 3):
 * approve/reject/reconcile a hold, the full outbox, and the ledger. No
 * bearer, the service binding is the authorization.
 */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/approve") {
      return handleDecision(request, this.env, true);
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/reject") {
      return handleDecision(request, this.env, false);
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/reconcile") {
      return handleReconcile(request, this.env);
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/spend/outbox") {
      return json({ ok: true, outbox: await spendLedger(this.env).outbox() });
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/spend/held") {
      return json({ ok: true, held: await spendLedger(this.env).listHeld() });
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/spend/ledger") {
      return json(await ledger(this.env).recent());
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/spend/wallet") {
      return handleWallet(this.env);
    }
    if (request.method === "GET" && url.pathname === "/gatekeeper/spend/allowances") {
      await ledgerExpiredAllowances(this.env, new Date().toISOString());
      return json({ ok: true, allowances: await spendLedger(this.env).listAllowances() });
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper/spend/allowance-revoke") {
      const body = await readJson<{ allowanceId?: string }>(request);
      if (!body.ok || typeof body.value.allowanceId !== "string") {
        return errorResponse(400, "invalid_request");
      }
      const at = new Date().toISOString();
      const revoked = await spendLedger(this.env).revokeAllowance(body.value.allowanceId, at);
      await ledger(this.env).append("allowance_revoked", { allowanceId: body.value.allowanceId, done: revoked });
      return revoked ? json({ ok: true }) : errorResponse(404, "allowance_not_revocable");
    }
    return errorResponse(404, "not_found");
  }
}
