import { findAgent, parseRoster, type RosterAgent } from "@operon/core";
import { recordMessage } from "@operon/chronicle";
import { errorResponse, json, readJson, requireAnyBearer, requireBearer, Ledger } from "@operon/worker-kit";
import { authorizationHeader } from "./oauth1.js";
import { PosterBox } from "./poster-do.js";
import {
  contentProblem,
  dmContentProblem,
  effectiveDailyCap,
  effectiveDmDailyCap,
  effectiveFollowDailyCap,
  effectiveProfileDailyCap,
  imageProblem,
  MAX_AVATAR_BYTES,
  MAX_BANNER_BYTES,
  normalizeHandle,
  profileProblem,
  boundReadParams,
  effectiveReadDailyCap,
  validateReadPath,
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
  X_DM_DAILY_CAP?: string;
  X_PROFILE_DAILY_CAP?: string;
  X_FOLLOW_DAILY_CAP?: string;
  X_READ_DAILY_CAP?: string;
  /** The disclosure marker every bio must keep (case-insensitive). */
  X_BIO_DISCLOSURE?: string;
  /** Central audit mirror; optional. */
  CHRONICLE?: D1Database;
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

/** Form-encoded v1.1 call: the form params join the OAuth signature. */
async function xApiForm(
  credentials: XCredentials,
  url: string,
  params: Record<string, string>
): Promise<Response> {
  const authorization = await authorizationHeader(
    {
      method: "POST",
      url,
      nonce: crypto.randomUUID().replace(/-/g, ""),
      timestamp: String(Math.floor(Date.now() / 1000)),
      extraParams: params
    },
    credentials
  );
  return fetch(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000)
  });
}

/** Multipart v1.1 call (profile media): body params stay OUT of the signature. */
async function xApiMultipart(
  credentials: XCredentials,
  url: string,
  field: string,
  base64: string
): Promise<Response> {
  const authorization = await authorizationHeader(
    {
      method: "POST",
      url,
      nonce: crypto.randomUUID().replace(/-/g, ""),
      timestamp: String(Math.floor(Date.now() / 1000))
    },
    credentials
  );
  const form = new FormData();
  form.set(field, base64);
  return fetch(url, {
    method: "POST",
    headers: { authorization },
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
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

  const body = await readJson<{ text?: unknown; replyTo?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { text, replyTo } = body.value;
  if (replyTo !== undefined && (typeof replyTo !== "string" || !/^\d+$/.test(replyTo))) {
    return errorResponse(400, "invalid_reply_to");
  }
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
    response = await xApi(credentials, "POST", POST_ENDPOINT, undefined, {
      text: post,
      // Replying to a mention is solicited engagement; same caps apply.
      ...(typeof replyTo === "string" ? { reply: { in_reply_to_tweet_id: replyTo } } : {})
    });
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
    if (!parsed.data?.id) return errorResponse(502, "x_rejected", "users/me had no id");
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
 * Profile self-expression with the disclosure self-maintaining: a bio
 * missing the operator-configured marker is refused, so the account
 * attestation cannot be invalidated by the agent's own edits.
 */
async function handleProfile(request: Request, env: Env, agent: RosterAgent): Promise<Response> {
  if (env.X_DISCLOSURE_ATTESTED !== "true") return errorResponse(503, "x_disclosure_unattested");
  const body = await readJson<{ bio?: unknown; url?: unknown; location?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const disclosure = env.X_BIO_DISCLOSURE ?? "AI agent";
  const problem = profileProblem(body.value, disclosure);
  if (problem) {
    await record(env, "profile_refused", { agentId: agent.id, reason: problem });
    return errorResponse(
      422,
      `x_${problem}`,
      problem === "bio_missing_disclosure" ? `the bio must keep "${disclosure}"` : undefined
    );
  }
  const credentials = credentialsFor(env, agent);
  if (!credentials) return errorResponse(503, "x_unconfigured");

  const now = new Date().toISOString();
  const box = poster(env, agent.id);
  const reservation = await box.reserveProfileUpdate(
    now,
    effectiveProfileDailyCap(env.X_PROFILE_DAILY_CAP)
  );
  if (!reservation.ok) {
    await record(env, "profile_refused", { agentId: agent.id, reason: "over_daily_cap" });
    return errorResponse(429, "x_profile_over_daily_cap");
  }

  const params: Record<string, string> = {};
  if (typeof body.value.bio === "string") params.description = body.value.bio;
  if (typeof body.value.url === "string") params.url = body.value.url;
  if (typeof body.value.location === "string") params.location = body.value.location;
  let response: Response;
  try {
    response = await xApiForm(credentials, "https://api.x.com/1.1/account/update_profile.json", params);
  } catch (error) {
    await box.releaseProfileUpdate(now);
    return errorResponse(502, "x_unreachable", String(error).slice(0, 200));
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    await box.releaseProfileUpdate(now);
    await record(env, "profile_failed", { agentId: agent.id, status: response.status, detail });
    return errorResponse(502, "x_rejected", `${response.status}: ${detail}`);
  }
  await record(env, "profile_updated", { agentId: agent.id, fields: Object.keys(params), ...params });
  await notifyOperator(env, `[${agent.id}] updated its X profile (${Object.keys(params).join(", ")})` +
    (params.description ? `\n\nbio: ${params.description}` : ""));
  return json({ ok: true, updated: Object.keys(params) });
}

/** Avatar and banner: PNG/JPEG by magic bytes, X's byte budgets, same cap pool. */
async function handleProfileImage(
  request: Request,
  env: Env,
  agent: RosterAgent,
  kind: "avatar" | "banner"
): Promise<Response> {
  if (env.X_DISCLOSURE_ATTESTED !== "true") return errorResponse(503, "x_disclosure_unattested");
  const body = await readJson<{ imageBase64?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  if (typeof body.value.imageBase64 !== "string") return errorResponse(400, "missing_image");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(body.value.imageBase64), char => char.charCodeAt(0));
  } catch {
    return errorResponse(400, "invalid_base64");
  }
  const maxBytes = kind === "avatar" ? MAX_AVATAR_BYTES : MAX_BANNER_BYTES;
  const problem = imageProblem(bytes, maxBytes);
  if (problem) {
    await record(env, "profile_refused", { agentId: agent.id, reason: problem, kind });
    return errorResponse(422, `x_${problem}`);
  }
  const credentials = credentialsFor(env, agent);
  if (!credentials) return errorResponse(503, "x_unconfigured");

  const now = new Date().toISOString();
  const box = poster(env, agent.id);
  const reservation = await box.reserveProfileUpdate(
    now,
    effectiveProfileDailyCap(env.X_PROFILE_DAILY_CAP)
  );
  if (!reservation.ok) return errorResponse(429, "x_profile_over_daily_cap");

  const endpoint =
    kind === "avatar"
      ? "https://api.x.com/1.1/account/update_profile_image.json"
      : "https://api.x.com/1.1/account/update_profile_banner.json";
  const field = kind === "avatar" ? "image" : "banner";
  let response: Response;
  try {
    response = await xApiMultipart(credentials, endpoint, field, body.value.imageBase64);
  } catch (error) {
    await box.releaseProfileUpdate(now);
    return errorResponse(502, "x_unreachable", String(error).slice(0, 200));
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    await box.releaseProfileUpdate(now);
    await record(env, "profile_failed", { agentId: agent.id, status: response.status, detail, kind });
    return errorResponse(502, "x_rejected", `${response.status}: ${detail}`);
  }
  await record(env, "profile_updated", { agentId: agent.id, kind, bytes: bytes.length });
  await notifyOperator(env, `[${agent.id}] updated its X ${kind} (${Math.round(bytes.length / 1024)}KB)`);
  return json({ ok: true, kind });
}

/**
 * Follow/unfollow, small shared cap (aggressive following is X's classic
 * automation-suspension vector; churn spends the same budget). The
 * handle lookup here is a public read: following people the agent
 * discovers publicly is the point, unlike DMs.
 */
async function handleFollow(
  request: Request,
  env: Env,
  agent: RosterAgent,
  follow: boolean
): Promise<Response> {
  if (env.X_DISCLOSURE_ATTESTED !== "true") return errorResponse(503, "x_disclosure_unattested");
  const body = await readJson<{ handle?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const handle = normalizeHandle(body.value.handle);
  if (!handle) return errorResponse(400, "invalid_handle");
  const credentials = credentialsFor(env, agent);
  if (!credentials) return errorResponse(503, "x_unconfigured");
  const box = poster(env, agent.id);

  let selfId = await box.selfId();
  if (!selfId) {
    const me = await xApi(credentials, "GET", ME_ENDPOINT);
    if (!me.ok) return errorResponse(502, "x_rejected", `users/me answered ${me.status}`);
    const parsed = (await me.json()) as { data?: { id?: string } };
    if (!parsed.data?.id) return errorResponse(502, "x_rejected", "users/me had no id");
    selfId = parsed.data.id;
    await box.setSelfId(selfId);
  }

  const now = new Date().toISOString();
  const reservation = await box.reserveFollow(now, effectiveFollowDailyCap(env.X_FOLLOW_DAILY_CAP));
  if (!reservation.ok) {
    await record(env, "follow_refused", { agentId: agent.id, reason: "over_daily_cap" });
    return errorResponse(429, "x_follow_over_daily_cap");
  }

  try {
    const lookup = await xApi(credentials, "GET", `https://api.x.com/2/users/by/username/${handle}`);
    if (!lookup.ok) {
      await box.releaseFollow(now);
      return errorResponse(502, "x_rejected", `user lookup answered ${lookup.status}`);
    }
    const target = ((await lookup.json()) as { data?: { id?: string } }).data?.id;
    if (!target) {
      await box.releaseFollow(now);
      return errorResponse(404, "x_user_not_found", `@${handle}`);
    }
    const response = follow
      ? await xApi(credentials, "POST", `https://api.x.com/2/users/${selfId}/following`, undefined, {
          target_user_id: target
        })
      : await xApi(credentials, "DELETE" as "POST", `https://api.x.com/2/users/${selfId}/following/${target}`);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      await box.releaseFollow(now);
      await record(env, "follow_failed", { agentId: agent.id, handle, status: response.status, detail });
      return errorResponse(502, "x_rejected", `${response.status}: ${detail}`);
    }
  } catch (error) {
    await box.releaseFollow(now);
    return errorResponse(502, "x_unreachable", String(error).slice(0, 200));
  }
  const verb = follow ? "followed" : "unfollowed";
  await record(env, verb, { agentId: agent.id, handle: `@${handle}` });
  await notifyOperator(env, `[${agent.id}] ${verb} @${handle} on X`);
  return json({ ok: true, [verb]: `@${handle}` });
}

/**
 * The read door: an allowlisted GET passthrough. Reads are data
 * acquisition (the mind fetches public pages freely already); the
 * Gatekeeper's only jobs here are holding the credential, bounding the
 * spend (reads bill per use), and ledgering what was asked. The
 * RESPONSE is untrusted data to the mind, like everything it reads.
 */
async function handleRead(request: Request, env: Env, agent: RosterAgent): Promise<Response> {
  const body = await readJson<{ path?: unknown; params?: unknown }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const path = validateReadPath(body.value.path);
  if (!path) return errorResponse(403, "x_path_not_allowlisted");
  const params = boundReadParams(body.value.params);
  if (params === null) return errorResponse(400, "invalid_params");
  const credentials = credentialsFor(env, agent);
  if (!credentials) return errorResponse(503, "x_unconfigured");
  const box = poster(env, agent.id);

  let resolved = path;
  if (path.includes(":self")) {
    let selfId = await box.selfId();
    if (!selfId) {
      const me = await xApi(credentials, "GET", ME_ENDPOINT);
      if (!me.ok) return errorResponse(502, "x_rejected", `users/me answered ${me.status}`);
      const parsed = (await me.json()) as { data?: { id?: string } };
      if (!parsed.data?.id) return errorResponse(502, "x_rejected", "users/me had no id");
      selfId = parsed.data.id;
      await box.setSelfId(selfId);
    }
    resolved = path.replace(":self", selfId);
  }

  const now = new Date().toISOString();
  const reservation = await box.reserveRead(now, effectiveReadDailyCap(env.X_READ_DAILY_CAP));
  if (!reservation.ok) {
    await record(env, "read_refused", { agentId: agent.id, path, reason: "over_daily_cap" });
    return errorResponse(429, "x_read_over_daily_cap");
  }

  let response: Response;
  try {
    response = await xApi(
      credentials,
      "GET",
      `https://api.x.com${resolved}`,
      Object.keys(params).length ? params : undefined
    );
  } catch (error) {
    return errorResponse(502, "x_unreachable", String(error).slice(0, 200));
  }
  const text = (await response.text()).slice(0, 200_000);
  await record(env, "read", { agentId: agent.id, path, params, status: response.status });
  if (!response.ok) return errorResponse(502, "x_rejected", `${response.status}: ${text.slice(0, 300)}`);
  return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request, env, ctx) {
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
    if (url.pathname === "/gatekeeper/x/dm") return handleDm(request, env, agent);
    if (url.pathname === "/gatekeeper/x/profile") return handleProfile(request, env, agent);
    if (url.pathname === "/gatekeeper/x/avatar") return handleProfileImage(request, env, agent, "avatar");
    if (url.pathname === "/gatekeeper/x/banner") return handleProfileImage(request, env, agent, "banner");
    if (url.pathname === "/gatekeeper/x/read") return handleRead(request, env, agent);
    if (url.pathname === "/gatekeeper/x/follow") return handleFollow(request, env, agent, true);
    if (url.pathname === "/gatekeeper/x/unfollow") return handleFollow(request, env, agent, false);
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
} satisfies ExportedHandler<Env>;
