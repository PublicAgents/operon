import { findAgent, parseRoster, type RosterAgent } from "@operon/core";
import { recordMessage } from "@operon/chronicle";
import { drainingBodies, errorResponse, json, readJson, requireBearer, Ledger, OpsEntrypoint,
  notifyOperator as sendOperatorNotify,
  type TelegramGatewayBinding
} from "@operon/worker-kit";
import { authorizationHeader } from "./oauth1.js";
import { PosterBox } from "./poster-do.js";
import {
  contentProblem,
  dmContentProblem,
  effectiveDailyCap,
  effectiveDmDailyCap,
  xAccessSecretVar,
  xAccessTokenVar,
  xTokenVar
} from "./policy.js";

export { Ledger, PosterBox };

/** The operator's binding-only view of the X ledger (spec 0003 step 3). */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/gatekeeper/x/ledger") return json(await ledger(this.env).recent());
    return errorResponse(404, "not_found");
  }
}
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
  X_DM_DAILY_CAP?: string;
  /** Central audit mirror; optional. */
  CHRONICLE?: D1Database;
  /** The telegram Gatekeeper over a service binding (spec 0009). */
  TELEGRAM?: TelegramGatewayBinding;
  /** Secrets. */
  X_API_KEY?: string;
  X_API_SECRET?: string;
  NOTIFY_TOKEN?: string;
  /** Per-agent: X_TOKEN_<ID> (door bearer), X_ACCESS_TOKEN/SECRET_<ID> (account). */
  [name: string]: unknown;
  POSTER: DurableObjectNamespace<PosterBox>;
  LEDGER: DurableObjectNamespace<Ledger>;
}

const POST_ENDPOINT = "https://api.x.com/2/tweets";
const DM_EVENTS_ENDPOINT = "https://api.x.com/2/dm_events";
const ME_ENDPOINT = "https://api.x.com/2/users/me";

interface XCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
}

function credentialsFor(env: Env, agent: RosterAgent): XCredentials | null {
  const accessToken = env[xAccessTokenVar(agent.id)];
  const accessSecret = env[xAccessSecretVar(agent.id)];
  if (
    !env.X_API_KEY ||
    !env.X_API_SECRET ||
    typeof accessToken !== "string" ||
    typeof accessSecret !== "string"
  ) {
    return null;
  }
  return {
    consumerKey: env.X_API_KEY,
    consumerSecret: env.X_API_SECRET,
    accessToken,
    accessSecret
  };
}

/** One OAuth1-signed call to the X API (query params join the signature). */
async function xApi(
  credentials: XCredentials,
  method: "GET" | "POST",
  url: string,
  query?: Record<string, string>,
  jsonBody?: unknown
): Promise<Response> {
  const authorization = await authorizationHeader(
    {
      method,
      url,
      nonce: crypto.randomUUID().replace(/-/g, ""),
      timestamp: String(Math.floor(Date.now() / 1000)),
      extraParams: query
    },
    credentials
  );
  const target = query ? `${url}?${new URLSearchParams(query)}` : url;
  return fetch(target, {
    method,
    headers: {
      authorization,
      ...(jsonBody !== undefined ? { "content-type": "application/json" } : {})
    },
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
}

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

/** Operator alerts ride the TELEGRAM binding (spec 0009); the public path is gone. */
async function notifyOperator(env: Env, text: string): Promise<void> {
  await sendOperatorNotify(env, text);
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

  const credentials = credentialsFor(env, agent);
  if (!credentials) return errorResponse(503, "x_unconfigured", "app or account credentials missing");

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

  let response: Response;
  try {
    response = await xApi(credentials, "POST", POST_ENDPOINT, undefined, { text: post });
  } catch (error) {
    await poster(env, agent.id).release(now, reservation.prevLastPostAt);
    await record(env, "post_failed", { agentId: agent.id, detail: String(error).slice(0, 200) });
    return errorResponse(502, "x_unreachable", String(error).slice(0, 200));
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    await poster(env, agent.id).release(now, reservation.prevLastPostAt);
    await record(env, "post_failed", { agentId: agent.id, status: response.status, detail });
    return errorResponse(502, "x_rejected", `${response.status}: ${detail}`);
  }

  const result = (await response.json()) as { data?: { id?: string } };
  const id = result.data?.id ?? "unknown";
  const url = `https://x.com/i/web/status/${id}`;
  await poster(env, agent.id).recordPost(id, post, now);
  await record(env, "posted", { agentId: agent.id, id, url, length: post.length });
  await recordMessage(env.CHRONICLE, {
    at: now,
    kind: "x_post",
    agentId: agent.id,
    body: post,
    refId: id,
    meta: { url }
  });
  await notifyOperator(env, `[${agent.id}] posted on X: ${url}\n\n${post}`);
  return json({ ok: true, id, url });
}

/**
 * Send a DM, reply-only by construction: the recipient must resolve
 * against the correspondent map (people who DM'd this agent first), so a
 * cold DM is not a refused request, it is an unresolvable recipient.
 * X's automation rules prohibit unsolicited automated DMs; this is that
 * rule as data flow.
 */
async function handleDm(request: Request, env: Env, agent: RosterAgent): Promise<Response> {
  if (env.X_DISCLOSURE_ATTESTED !== "true") {
    await record(env, "dm_refused", { agentId: agent.id, reason: "disclosure_unattested" });
    return errorResponse(503, "x_disclosure_unattested");
  }
  const body = await readJson<{ to?: unknown; text?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { to, text } = body.value;
  if (typeof to !== "string" || to.length === 0) return errorResponse(400, "missing_to");
  const problem = dmContentProblem(text);
  if (problem) {
    await record(env, "dm_refused", { agentId: agent.id, reason: problem });
    return errorResponse(422, `x_dm_${problem}`);
  }
  const message = text as string;
  const credentials = credentialsFor(env, agent);
  if (!credentials) return errorResponse(503, "x_unconfigured");

  const box = poster(env, agent.id);
  const recipient = await box.resolveCorrespondent(to);
  if (!recipient) {
    await record(env, "dm_refused", { agentId: agent.id, reason: "not_a_correspondent", to });
    return errorResponse(
      403,
      "x_not_a_correspondent",
      "reply-only: DMs go only to people who have DM'd this agent first"
    );
  }

  const now = new Date().toISOString();
  const cap = effectiveDmDailyCap(env.X_DM_DAILY_CAP);
  const reservation = await box.reserveDm(now, cap);
  if (!reservation.ok) {
    await record(env, "dm_refused", { agentId: agent.id, reason: "over_daily_cap" });
    return errorResponse(429, "x_dm_over_daily_cap", `daily DM cap ${cap}`);
  }

  let response: Response;
  try {
    response = await xApi(
      credentials,
      "POST",
      `https://api.x.com/2/dm_conversations/with/${recipient.userId}/messages`,
      undefined,
      { text: message }
    );
  } catch (error) {
    await box.releaseDm(now);
    await record(env, "dm_failed", { agentId: agent.id, detail: String(error).slice(0, 200) });
    return errorResponse(502, "x_unreachable", String(error).slice(0, 200));
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    await box.releaseDm(now);
    await record(env, "dm_failed", { agentId: agent.id, status: response.status, detail });
    return errorResponse(502, "x_rejected", `${response.status}: ${detail}`);
  }

  await record(env, "dm_sent", { agentId: agent.id, to: `@${recipient.username}` });
  await recordMessage(env.CHRONICLE, {
    at: now,
    kind: "x_dm_out",
    agentId: agent.id,
    recipient: `@${recipient.username}`,
    body: message
  });
  await notifyOperator(env, `[${agent.id}] DM'd @${recipient.username} on X:\n\n${message.slice(0, 1000)}`);
  return json({ ok: true, to: `@${recipient.username}` });
}

interface DmEventsPayload {
  data?: Array<{
    id: string;
    text?: string;
    created_at?: string;
    sender_id?: string;
    event_type?: string;
  }>;
  includes?: { users?: Array<{ id: string; username?: string }> };
}

/**
 * Pull inbound DMs for the wake's inbox (delivered as data, sanitized at
 * delivery like email; acked only after the wake persists). Every
 * inbound sender becomes a correspondent, which is what makes them
 * DM-able. Mirrored to the chronicle exactly once via its own cursor.
 */
async function handleDmPull(env: Env, agent: RosterAgent, ctx: ExecutionContext): Promise<Response> {
  const credentials = credentialsFor(env, agent);
  if (!credentials) return json({ ok: true, messages: [], upTo: null });
  const box = poster(env, agent.id);

  let selfId = await box.selfId();
  if (!selfId) {
    const me = await xApi(credentials, "GET", ME_ENDPOINT);
    if (!me.ok) {
      return errorResponse(502, "x_rejected", `users/me answered ${me.status}`);
    }
    const parsed = (await me.json()) as { data?: { id?: string } };
    if (!parsed?.data?.id) return errorResponse(502, "x_rejected", "users/me had no id");
    selfId = parsed.data.id;
    await box.setSelfId(selfId);
  }

  let response: Response;
  try {
    response = await xApi(credentials, "GET", DM_EVENTS_ENDPOINT, {
      "dm_event.fields": "id,text,created_at,sender_id,event_type",
      event_types: "MessageCreate",
      expansions: "sender_id",
      "user.fields": "username",
      max_results: "100"
    });
  } catch (error) {
    return errorResponse(502, "x_unreachable", String(error).slice(0, 200));
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    await record(env, "dm_pull_failed", { agentId: agent.id, status: response.status, detail });
    return errorResponse(502, "x_rejected", `${response.status}: ${detail}`);
  }
  const payload = (await response.json()) as DmEventsPayload;
  const users = new Map((payload.includes?.users ?? []).map(user => [user.id, user.username ?? "unknown"]));

  const cursor = BigInt(await box.dmCursor());
  const mirrorCursor = BigInt(await box.dmMirrorCursor());
  const inbound = (payload.data ?? [])
    .filter(event => event.sender_id && event.sender_id !== selfId && event.text)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

  const messages: Array<{ id: string; from: string; subject: string; date: string; text: string }> = [];
  let maxId = 0n;
  for (const event of inbound) {
    const username = users.get(event.sender_id as string) ?? "unknown";
    const at = event.created_at ?? new Date().toISOString();
    // Every inbound sender is a correspondent from now on (idempotent).
    await box.recordDmCorrespondent(event.sender_id as string, username, at);
    const eventId = BigInt(event.id);
    if (eventId > maxId) maxId = eventId;
    if (eventId > mirrorCursor) {
      ctx.waitUntil(
        recordMessage(env.CHRONICLE, {
          at,
          kind: "x_dm_in",
          agentId: agent.id,
          sender: `@${username}`,
          body: event.text as string,
          refId: event.id
        })
      );
    }
    if (eventId > cursor) {
      messages.push({
        id: event.id,
        from: `@${username} (X DM)`,
        subject: `X DM from @${username}`,
        date: at,
        text: event.text as string
      });
    }
  }
  if (maxId > mirrorCursor) await box.setDmMirrorCursor(maxId.toString());
  return json({ ok: true, messages, upTo: messages.length ? maxId.toString() : null });
}

/**
 * The agent's own profile, straight from X: identity, bio, follower
 * counts, and pinned_tweet_id (pinning has no public API endpoint, the
 * operator pins by hand; this is how the agent VERIFIES the pin). Also
 * a credential self-check: a 401 here names the OAuth pair as the
 * problem before any post is attempted. Read-only, no caps consumed.
 */
async function handleMe(env: Env, agent: RosterAgent): Promise<Response> {
  const credentials = credentialsFor(env, agent);
  if (!credentials) {
    return errorResponse(503, "x_unconfigured", "no OAuth credentials for this agent");
  }
  // Every failure mode gets a NAMED error: this door is the credential
  // diagnostic, so a timeout or garbled body must not surface as a
  // generic porch failure.
  let me: Response;
  try {
    me = await xApi(credentials, "GET", ME_ENDPOINT, {
      "user.fields": "description,public_metrics,pinned_tweet_id,created_at,verified_type,url,location"
    });
  } catch (error) {
    return errorResponse(502, "x_unreachable", String(error).slice(0, 200));
  }
  if (!me.ok) return errorResponse(502, "x_rejected", `users/me answered ${me.status}`);
  let parsed: { data?: { id?: string } };
  try {
    parsed = (await me.json()) as { data?: { id?: string } };
  } catch {
    return errorResponse(502, "x_rejected", "users/me answered non-JSON");
  }
  if (!parsed?.data?.id) return errorResponse(502, "x_rejected", "users/me had no id");
  // Opportunistically cache the self id the DM path also needs;
  // best-effort, since the profile answer must not depend on storage.
  try {
    await poster(env, agent.id).setSelfId(parsed.data.id);
  } catch (error) {
    console.error("x me: selfId cache write failed", error);
  }
  return json({ ok: true, me: parsed.data });
}

export default drainingBodies({
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "POST") return errorResponse(404, "not_found");
    const agent = agentFromBearer(request, env);
    if (!agent) return errorResponse(401, "unauthorized");
    if (url.pathname === "/gatekeeper/x/post") return handlePost(request, env, agent);
    if (url.pathname === "/gatekeeper/x/me") return handleMe(env, agent);
    if (url.pathname === "/gatekeeper/x/posts") {
      return json({ ok: true, posts: await poster(env, agent.id).posts() });
    }
    if (url.pathname === "/gatekeeper/x/dm") return handleDm(request, env, agent);
    if (url.pathname === "/gatekeeper/x/dm/pull") return handleDmPull(env, agent, ctx);
    if (url.pathname === "/gatekeeper/x/dm/ack") {
      const body = await readJson<{ upTo?: unknown }>(request);
      if (!body.ok || typeof body.value.upTo !== "string" || !/^\d+$/.test(body.value.upTo)) {
        return errorResponse(400, "invalid_up_to");
      }
      await poster(env, agent.id).ackDms(body.value.upTo);
      return json({ ok: true });
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>);
