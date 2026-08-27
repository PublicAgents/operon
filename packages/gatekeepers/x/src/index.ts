import { findAgent, parseRoster, type RosterAgent } from "@operon/core";
import { errorResponse, json, readJson, requireAnyBearer, requireBearer, Ledger } from "@operon/worker-kit";
import { authorizationHeader } from "./oauth1.js";
import { PosterBox } from "./poster-do.js";
import {
  contentProblem,
  effectiveDailyCap,
  xAccessSecretVar,
  xAccessTokenVar,
  xTokenVar
} from "./policy.js";

export { Ledger, PosterBox };
export * from "./policy.js";
export * from "./oauth1.js";

/**
 * The X Gatekeeper (the posting door the first tenant asked for, with the
 * containment it asked for). An agent posts to its OWN account
 * autonomously; the policy is code, not guidance:
 *
 * - Disclosure fails closed: no post leaves until the operator sets
 *   X_DISCLOSURE_ATTESTED="true", the attestation that the account
 *   carries X's automated-account label and an AI disclosure in its bio
 *   (account-level facts only the operator can establish on x.com).
 * - Volume and shape rules run BEFORE any credential is touched, with
 *   the slot reserved atomically in the per-agent PosterBox.
 * - Every post and refusal is ledgered (and therefore chronicled) and
 *   the operator is notified with the live URL: oversight after the
 *   fact, no approval gate in the path.
 *
 * The OAuth1 credentials (app key/secret + per-agent access token/secret
 * for the agent's own account) exist only here.
 */

interface Env {
  ROSTER: string;
  /** "true" once the operator has labeled the account on x.com. */
  X_DISCLOSURE_ATTESTED?: string;
  X_DAILY_CAP?: string;
  NOTIFY_URL?: string;
  /** Secrets. */
  X_API_KEY?: string;
  X_API_SECRET?: string;
  NOTIFY_TOKEN?: string;
  OPERATOR_API_TOKEN?: string;
  /** Per-agent: X_TOKEN_<ID> (door bearer), X_ACCESS_TOKEN/SECRET_<ID> (account). */
  [name: string]: unknown;
  POSTER: DurableObjectNamespace<PosterBox>;
  LEDGER: DurableObjectNamespace<Ledger>;
}

const POST_ENDPOINT = "https://api.x.com/2/tweets";

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("x"));
}

function poster(env: Env, agentId: string) {
  return env.POSTER.get(env.POSTER.idFromName(agentId));
}

function agentFromBearer(request: Request, env: Env): RosterAgent | null {
  const roster = parseRoster(env.ROSTER);
  for (const agent of roster.agents) {
    const expected = env[xTokenVar(agent.id)];
    if (typeof expected === "string" && expected.length > 0) {
      if (requireBearer(request, expected) === null) return findAgent(roster, agent.id) ?? null;
    }
  }
  return null;
}

async function notifyOperator(env: Env, text: string): Promise<void> {
  if (!env.NOTIFY_URL || !env.NOTIFY_TOKEN) return;
  try {
    const response = await fetch(env.NOTIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.NOTIFY_TOKEN}` },
      body: JSON.stringify({ text })
    });
    if (!response.ok) console.error(`x notify rejected: ${response.status}`);
  } catch (error) {
    console.error("x notify failed", error);
  }
}

async function record(env: Env, kind: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await ledger(env).append(kind, detail);
  } catch (error) {
    console.error("x ledger append failed", error);
  }
}

async function handlePost(request: Request, env: Env, agent: RosterAgent): Promise<Response> {
  // The disclosure gate comes first: without the operator's attestation
  // that the ACCOUNT is labeled automated with an AI-disclosure bio,
  // this Gatekeeper refuses to exist as a posting surface at all.
  if (env.X_DISCLOSURE_ATTESTED !== "true") {
    await record(env, "post_refused", { agentId: agent.id, reason: "disclosure_unattested" });
    return errorResponse(
      503,
      "x_disclosure_unattested",
      "the operator has not attested the account's automated label + AI-disclosure bio"
    );
  }

  const body = await readJson<{ text?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { text } = body.value;
  const problem = contentProblem(text);
  if (problem) {
    await record(env, "post_refused", { agentId: agent.id, reason: problem });
    return errorResponse(422, `x_${problem}`);
  }
  const post = text as string;

  const accessToken = env[xAccessTokenVar(agent.id)];
  const accessSecret = env[xAccessSecretVar(agent.id)];
  if (
    !env.X_API_KEY ||
    !env.X_API_SECRET ||
    typeof accessToken !== "string" ||
    typeof accessSecret !== "string"
  ) {
    return errorResponse(503, "x_unconfigured", "app or account credentials missing");
  }

  const now = new Date().toISOString();
  const cap = effectiveDailyCap(env.X_DAILY_CAP);
  // Atomic check-and-reserve BEFORE the network call (the email
  // Gatekeeper's pattern): overlapping posts near the cap cannot both
  // pass, and a failed delivery releases the slot.
  const reservation = await poster(env, agent.id).reservePost(post, now, cap);
  if (!reservation.ok) {
    await record(env, "post_refused", { agentId: agent.id, reason: reservation.problem });
    return errorResponse(429, `x_${reservation.problem}`, `daily cap ${cap}, minimum spacing 20m`);
  }

  const credentials = {
    consumerKey: env.X_API_KEY,
    consumerSecret: env.X_API_SECRET,
    accessToken,
    accessSecret
  };
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const authorization = await authorizationHeader(
    { method: "POST", url: POST_ENDPOINT, nonce, timestamp },
    credentials
  );

  let response: Response;
  try {
    response = await fetch(POST_ENDPOINT, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: post })
    });
  } catch (error) {
    await poster(env, agent.id).release(now);
    await record(env, "post_failed", { agentId: agent.id, detail: String(error).slice(0, 200) });
    return errorResponse(502, "x_unreachable", String(error).slice(0, 200));
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    await poster(env, agent.id).release(now);
    await record(env, "post_failed", { agentId: agent.id, status: response.status, detail });
    return errorResponse(502, "x_rejected", `${response.status}: ${detail}`);
  }

  const result = (await response.json()) as { data?: { id?: string } };
  const id = result.data?.id ?? "unknown";
  const url = `https://x.com/i/web/status/${id}`;
  await poster(env, agent.id).recordPost(id, post, now);
  await record(env, "posted", { agentId: agent.id, id, url, length: post.length });
  await notifyOperator(env, `[${agent.id}] posted on X: ${url}\n\n${post}`);
  return json({ ok: true, id, url });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/gatekeeper/x/ledger" && request.method === "GET") {
      const denied = requireAnyBearer(request, [env.OPERATOR_API_TOKEN]);
      if (denied) return denied;
      return json(await ledger(env).recent());
    }
    if (request.method !== "POST") return errorResponse(404, "not_found");
    const agent = agentFromBearer(request, env);
    if (!agent) return errorResponse(401, "unauthorized");
    if (url.pathname === "/gatekeeper/x/post") return handlePost(request, env, agent);
    if (url.pathname === "/gatekeeper/x/posts") {
      return json({ ok: true, posts: await poster(env, agent.id).posts() });
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>;
