import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { Mppx, tempo } from "mppx/hono";
import { findAgent, parseRoster, type RosterAgent } from "@operon/core";
import { errorResponse, json, requireBearer, Ledger, OpsEntrypoint, formatUnits, erc20Balance } from "@operon/worker-kit";
import { credentialClaimKey, durableStore, TillStore } from "./replay-store.js";
export { TillStore };
import { TillCatalog } from "./catalog-do.js";
import { tokenEnvName, validateOffer, type Offer, type OfferLimits } from "./gates.js";

export { Ledger, TillCatalog };
export * from "./gates.js";

/**
 * The till Gatekeeper (spec 0002 §2.1): fronts the agent hosts, turning
 * catalog paths into MPP-paid resources and passing every other request
 * untouched to the deploy Gatekeeper over a service binding. It is the
 * only holder of the MPP signing key; revenue recipients are colony
 * secrets; every offer change and every receipt is a ledger row.
 *
 * Money bearers are per-agent: the doors derive the agent from WHICH
 * TILL_TOKEN_<AGENTID> secret matched, never from a payload claim.
 */

interface Env {
  TILL_STORE: DurableObjectNamespace<import("./replay-store.js").TillStore>;
  ROSTER: string;
  /** Colony ceilings (vars): the agent prices; the operator bounds. */
  TILL_MAX_PRICE?: string;
  TILL_MAX_OFFERS?: string;
  /** Comma-separated allowed currency identifiers (token addresses). */
  TILL_CURRENCIES?: string;
  /** "true" while M4a runs on testnet methods. */
  TILL_TESTNET?: string;
  /**
   * Tempo chain id and dedicated RPC URL, for verification through a
   * provider instead of the public RPC (which rate-limits by IP, and
   * Workers egress IPs are shared: "too many connections from this IP").
   */
  TILL_RPC_CHAIN_ID?: string;
  /** Secrets. */
  MPP_SECRET_KEY?: string;
  TILL_RECIPIENT?: string;
  /**
   * Tempo API key (scope mpp:write): validation and broadcast go through
   * Tempo's MPP relay instead of raw RPC. The production-grade path; when
   * set it takes precedence over TILL_RPC_URL.
   */
  TEMPO_API_KEY?: string;
  TILL_RPC_URL?: string;
  /** Per-agent bearers as TILL_TOKEN_<AGENTID>. */
  [name: string]: unknown;
  DEPLOY: Fetcher;
  CATALOG: DurableObjectNamespace<TillCatalog>;
  LEDGER: DurableObjectNamespace<Ledger>;
}

/**
 * How long a spent credential stays claimed. Challenges expire in
 * minutes, so a credential is unusable long before this lapses; the
 * window only has to outlive the challenge it belongs to.
 */
const CREDENTIAL_CLAIM_MS = 30 * 60 * 1000;

/**
 * The MPP refusal for a replayed credential: 402 with the
 * invalid-challenge problem type (the spec groups already-used there)
 * and, when it can be minted, a FRESH challenge so an honest client
 * can pay again immediately.
 */
async function replayRefusal(
  mppx: unknown,
  offer: { price: string; currency: string; description: string },
  env: Env
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/problem+json",
    "cache-control": "no-store"
  });
  try {
    const generate = (mppx as {
      challenge?: { tempo?: { charge?: (options: unknown) => Promise<{ headers?: Headers }> } };
    }).challenge?.tempo?.charge;
    if (generate) {
      const challenge = await generate({
        amount: offer.price,
        currency: offer.currency,
        description: offer.description,
        recipient: env.TILL_RECIPIENT
      });
      const wwwAuthenticate = challenge?.headers?.get("WWW-Authenticate");
      if (wwwAuthenticate) headers.set("WWW-Authenticate", wwwAuthenticate);
    }
  } catch {
    // A refusal without a fresh challenge is still a correct refusal.
  }
  return new Response(
    JSON.stringify({
      type: "https://paymentauth.org/problems/invalid-challenge",
      title: "Invalid Challenge",
      status: 402,
      detail:
        "This credential has already been used: its challenge is spent. Request a fresh challenge and pay again."
    }),
    { status: 402, headers }
  );
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("till"));
}

function catalog(env: Env) {
  return env.CATALOG.get(env.CATALOG.idFromName("catalog"));
}

function limits(env: Env): OfferLimits {
  return {
    maxPrice: env.TILL_MAX_PRICE ?? "1.00",
    maxOffers: Number(env.TILL_MAX_OFFERS ?? "20"),
    currencies: (env.TILL_CURRENCIES ?? "")
      .split(",")
      .map(currency => currency.trim())
      .filter(currency => currency.length > 0)
  };
}

/**
 * Resolve the calling agent from which per-agent bearer matched. Returns
 * null when no configured bearer matches; a roster agent with no token
 * configured simply cannot use the money doors.
 */
function agentFromBearer(request: Request, env: Env): RosterAgent | null {
  const roster = parseRoster(env.ROSTER);
  for (const agent of roster.agents) {
    const expected = env[tokenEnvName(agent.id)];
    if (typeof expected === "string" && expected.length > 0) {
      if (requireBearer(request, expected) === null) return findAgent(roster, agent.id) ?? null;
    }
  }
  return null;
}

type Vars = { env: Env };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
/** The agents' doors (spec 0009): served by the Door entrypoint, never by the storefront. */
const doors = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---- doors -----------------------------------------------------------

doors.post("/gatekeeper/till/offer", async c => {
  const env = c.env;
  const agent = agentFromBearer(c.req.raw, env);
  if (!agent) return errorResponse(401, "invalid_token");
  const body = (await c.req.json().catch(() => null)) as {
    host?: string;
    path?: string;
    price?: string;
    currency?: string;
    description?: string;
  } | null;
  if (!body) return errorResponse(400, "malformed_json");
  const { host, path, price, currency, description } = body;
  if (
    typeof host !== "string" ||
    typeof path !== "string" ||
    typeof price !== "string" ||
    typeof currency !== "string" ||
    typeof description !== "string"
  ) {
    return errorResponse(400, "invalid_request");
  }
  const roster = parseRoster(env.ROSTER);
  const problem = validateOffer(
    { host, path, price, currency, description },
    agent,
    roster,
    limits(env)
  );
  if (problem) {
    await ledger(env).append("offer_rejected", { agentId: agent.id, host, path, problem });
    return errorResponse(422, problem);
  }
  const offer: Offer = { agentId: agent.id, host, path, price, currency, description };
  // The cap is enforced inside the DO's serialized turn (atomic).
  const capped = await catalog(env).putCapped(offer, limits(env).maxOffers);
  if (!capped.ok) {
    await ledger(env).append("offer_rejected", { agentId: agent.id, host, path, problem: "too_many_offers" });
    return errorResponse(422, "too_many_offers");
  }
  await ledger(env).append("offer_set", { agentId: agent.id, host, path, price, currency });
  return json({ ok: true, offer });
});

doors.post("/gatekeeper/till/retire", async c => {
  const env = c.env;
  const agent = agentFromBearer(c.req.raw, env);
  if (!agent) return errorResponse(401, "invalid_token");
  const body = (await c.req.json().catch(() => null)) as { host?: string; path?: string } | null;
  if (!body || typeof body.host !== "string" || typeof body.path !== "string") {
    return errorResponse(400, "invalid_request");
  }
  const existing = await catalog(env).get(body.host, body.path);
  if (!existing || existing.agentId !== agent.id) return errorResponse(404, "offer_not_found");
  await catalog(env).retire(body.host, body.path);
  await ledger(env).append("offer_retired", { agentId: agent.id, host: body.host, path: body.path });
  return json({ ok: true });
});

doors.post("/gatekeeper/till/sales", async c => {
  const env = c.env;
  const agent = agentFromBearer(c.req.raw, env);
  if (!agent) return errorResponse(401, "invalid_token");
  const rows = (await ledger(env).recent()) as Array<{ kind: string; detail?: { agentId?: string } }>;
  const sales = rows.filter(row => row.kind === "receipt" && row.detail?.agentId === agent.id);
  const offers = await catalog(env).listForAgent(agent.id);
  return json({ ok: true, offers, sales });
});

// ---- serving overlay -------------------------------------------------

app.all("*", async c => {
  const env = c.env;
  // The overlay serves pages: only a read can be a page. Anything else
  // is refused here rather than forwarded body-first to a Worker that
  // answers 405 without reading it (the runtime then logs a stream
  // error for every such POST; spec 0009's probes showed two).
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed");
  }
  const url = new URL(c.req.url);
  const offer = await catalog(env).get(url.hostname, url.pathname);
  if (!offer) {
    // Not for sale: the till is a pure overlay; the deploy Gatekeeper
    // serves exactly as it did when it held the routes itself.
    return env.DEPLOY.fetch(c.req.raw);
  }
  if (!env.MPP_SECRET_KEY || !env.TILL_RECIPIENT) {
    // A priced path with no payment configuration serves nothing rather
    // than serving free: failing open would be a silent giveaway.
    await ledger(env).append("serve_unconfigured", { host: offer.host, path: offer.path });
    return errorResponse(503, "till_unconfigured");
  }

  // Verification transport, in order of preference: Tempo's MPP relay
  // (api key), a dedicated RPC URL, then the public RPC (which
  // rate-limits shared Workers egress IPs and WILL fail under load).
  // A malformed chain id must fall back, not become NaN/0 as an rpcUrl key.
  const parsedChainId = Number(env.TILL_RPC_CHAIN_ID);
  const chainId = Number.isInteger(parsedChainId) && parsedChainId > 0 ? parsedChainId : 42431;
  const store = durableStore(env.TILL_STORE.get(env.TILL_STORE.idFromName("till")));
  const mppx = Mppx.create({
    methods: [
      tempo.charge({
        testnet: env.TILL_TESTNET === "true",
        // The SHARED replay store (operon#67): without it mppx falls
        // back to a per-isolate memory store and a replayed credential
        // hitting another isolate is re-served 200 instead of 402
        // invalid-challenge (already-used), the one scored failure on
        // conformance cert ea57e4fe.
        store: store as never,
        ...(typeof env.TEMPO_API_KEY === "string" && env.TEMPO_API_KEY.length > 0
          ? { relay: { apiKey: env.TEMPO_API_KEY } }
          : typeof env.TILL_RPC_URL === "string" && env.TILL_RPC_URL.length > 0
            ? { rpcUrl: { [chainId]: env.TILL_RPC_URL } }
            : {})
      })
    ],
    secretKey: env.MPP_SECRET_KEY
  });
  const middleware = mppx.charge({
    amount: offer.price,
    currency: offer.currency,
    description: offer.description,
    // Custody is operator-only: the recipient comes from colony secrets,
    // never from the offer.
    recipient: env.TILL_RECIPIENT
  });

  // SINGLE-USE CREDENTIALS, enforced by the till itself (operon#69).
  // MPP requires a replayed credential to be refused (its challenge is
  // already used), and a shipped conformance certificate turns on that
  // refusal. mppx's own claim path did not produce it in production
  // even with a working shared store, so the till owns the guarantee
  // rather than inheriting it: the credential is claimed BEFORE mppx
  // sees it, and released again if mppx then rejects it, so a refused
  // credential never burns its key and every hostile credential keeps
  // its own precise refusal reason.
  const authorization = c.req.header("authorization");
  const credentialKey = authorization ? await credentialClaimKey(authorization) : null;
  if (credentialKey && !(await store.tryClaim(credentialKey, Date.now() + CREDENTIAL_CLAIM_MS))) {
    await ledger(env).append("replay_refused", {
      agentId: offer.agentId,
      host: offer.host,
      path: offer.path
    });
    return replayRefusal(mppx, offer, env);
  }

  // The middleware decorates c.res with the Payment-Receipt header after
  // the handler runs; c.res (or a directly returned Response) is the
  // authoritative final response, never the raw deploy fetch.
  const result = await middleware(c, async () => {
    c.res = await env.DEPLOY.fetch(c.req.raw);
  });
  const out = result instanceof Response ? result : c.res;
  // A credential mppx refused was never spent: release its claim so
  // the refusal reason stays the true one on any resend.
  if (out.status === 402 && credentialKey) {
    await store.releaseClaim(credentialKey).catch(() => undefined);
  }
  if (out.status !== 402) {
    // The settlement reference rides the receipt row (operon#67's
    // secondary finding): a revenue ledger whose rows carry their
    // on-chain reference cannot silently overcount.
    const reference = out.headers.get("Payment-Receipt");
    await ledger(env).append("receipt", {
      agentId: offer.agentId,
      host: offer.host,
      path: offer.path,
      price: offer.price,
      currency: offer.currency,
      status: out.status,
      ...(reference !== null ? { reference: reference.slice(0, 500) } : {})
    });
  }
  return out;
});

/** The doors, over the umbilical's TILL_DOOR binding only (spec 0009). */
export class Door extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return Promise.resolve(doors.fetch(request, this.env, this.ctx));
  }
}

export default {
  // The public surface: the storefront overlay, and nothing else.
  fetch: app.fetch
} satisfies ExportedHandler<Env>;

/** The operator's binding-only view of the till ledger (spec 0003 step 3). */
/**
 * Display decimals for currencies the colony knows on sight. The till's
 * currency list carries no decimals (it is an allowlist of identifiers),
 * so display formatting exists only for mapped tokens; everything else
 * reports raw base units and a null display.
 */
const KNOWN_DECIMALS = new Map<string, number>([
  ["0x20c0000000000000000000000000000000000000", 6]
]);

export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/gatekeeper/till/ledger") {
      return json(await ledger(this.env).recent());
    }
    // The state of the till: every live offer across agents, plus the
    // colony ceilings that bound them (selling is cap-bounded, not
    // approval-gated: spec 0002 §2.1).
    if (pathname === "/gatekeeper/till/offers") {
      return json({
        ok: true,
        offers: await catalog(this.env).listAll(),
        limits: limits(this.env)
      });
    }
    // The RECEIVING wallet: where sales revenue lands. The address is
    // operator-configured colony custody (TILL_RECIPIENT); no key for it
    // exists anywhere in the chassis. Balances are best-effort chain
    // reads per allowed currency; decimals are known only for currencies
    // in the display map, others report raw base units.
    // Does the shared replay store actually work in production? The
    // claim path is only exercised by real payments, so operon#69 (a
    // replay served 200 after the store shipped) had no way to
    // distinguish "store broken" from "mppx never claimed". This
    // exercises the claim contract on a scratch key: a working store
    // claims once and refuses the second.
    if (pathname === "/gatekeeper/till/store-check") {
      const store = durableStore(this.env.TILL_STORE.get(this.env.TILL_STORE.idFromName("till")));
      const key = `selfcheck:${crypto.randomUUID()}`;
      const expires = Date.now() + 60_000;
      const first = await store.tryClaim(key, expires);
      const second = await store.tryClaim(key, expires);
      await store.put(`${key}:rt`, { probe: true });
      const readBack = await store.get(`${key}:rt`);
      await store.delete(`${key}:rt`);
      // The scratch claim is diagnostic litter, not a settlement:
      // release it so repeated checks cannot grow the claim set.
      await store.releaseClaim(key);
      return json({
        ok: first === true && second === false,
        claimedFirst: first,
        refusedSecond: second,
        roundTrip: readBack !== null
      });
    }
    if (pathname === "/gatekeeper/till/wallet") {
      if (!this.env.TILL_RECIPIENT) return errorResponse(503, "till_unconfigured");
      const address = this.env.TILL_RECIPIENT;
      // Mirror the CHARGE path's chain semantics: the testnet flag
      // decides the network (mainnet 4217 by default), and
      // TILL_RPC_CHAIN_ID is an explicit override, not a default. The
      // 42431 fallback elsewhere is an RPC-transport detail and must
      // not leak into what network this wallet reports (or which RPC
      // its balances are read from).
      const parsedChainId = Number(this.env.TILL_RPC_CHAIN_ID);
      const chainId =
        Number.isInteger(parsedChainId) && parsedChainId > 0
          ? parsedChainId
          : this.env.TILL_TESTNET === "true"
            ? 42431
            : 4217;
      const apiKey =
        typeof this.env.TEMPO_API_KEY === "string" && this.env.TEMPO_API_KEY.length > 0
          ? this.env.TEMPO_API_KEY
          : null;
      const rpcUrl = apiKey
        ? `https://api.tempo.xyz/rpc/${chainId}`
        : typeof this.env.TILL_RPC_URL === "string" && this.env.TILL_RPC_URL.length > 0
          ? this.env.TILL_RPC_URL
          : null;
      const currencies = (this.env.TILL_CURRENCIES ?? "")
        .split(",")
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
      const balances = await Promise.all(
        currencies.map(async currency => {
          const raw = rpcUrl ? await erc20Balance(rpcUrl, apiKey, currency, address) : null;
          const decimals = KNOWN_DECIMALS.get(currency.toLowerCase()) ?? null;
          return {
            currency,
            decimals,
            raw,
            display: raw !== null && decimals !== null ? formatUnits(raw, decimals) : null
          };
        })
      );
      return json({ ok: true, address, chainId, balances });
    }
    return errorResponse(404, "not_found");
  }
}
