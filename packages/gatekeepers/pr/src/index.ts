import { grantedRepos, mergeGrant, reachableRepos, reviewRepos, rosterAgentIds, rosterVerdict } from "./grants.js";
import {
  approveHeld,
  closeDoor,
  listHeld,
  mergeDoor,
  rejectHeld,
  resolveIdentities,
  reviewDoor,
  type AdjudicationDeps,
  type DoorResult,
  type Identities
} from "./adjudication.js";
import { PrHolds } from "./holds-do.js";
import {
  drainingBodies,
  errorResponse,
  json,
  readJson,
  requireBearer,
  Ledger,
  notifyOperator,
  GitDataError,
  OpsEntrypoint,
  type OperatorAction,
  type TelegramGatewayBinding
} from "@operon/worker-kit";
import {
  authenticatedLogin,
  getIssueRef,
  getUpstreamFile,
  getThread,
  listActivity,
  openIssue,
  openPullRequest,
  postComment,
  pushToPr,
  replyToReviewComment,
  updateIssue,
  type PrRequest
} from "./github.js";

export { Ledger, PrHolds };

/**
 * The operator's binding-only view (spec 0003 step 3, spec 0012 §8):
 * the ledger, the merges held for a decision, and the decisions.
 */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/gatekeeper/pr/ledger") return json(await ledger(this.env).recent());
    if (path === "/gatekeeper/pr/held" && request.method === "POST") {
      return toResponse(await listHeld(operatorDeps(this.env), apiFor(this.env)));
    }
    if (path === "/gatekeeper/pr/approve" && request.method === "POST") {
      return handleApprove(request, this.env);
    }
    if (path === "/gatekeeper/pr/reject" && request.method === "POST") {
      return handleReject(request, this.env);
    }
    return errorResponse(404, "not_found");
  }
}
export * from "./github.js";
export { grantedRepos } from "./grants.js";

/**
 * The PR Gatekeeper: opens fork-based pull requests and issues for
 * allowlisted repos, and reports the status of what an agent opened, all
 * through the GitHub API. It holds the machine credential; no wake
 * container ever does. Callers (the porch) authenticate with an internal
 * bearer and submit DATA; this Worker turns it into GitHub actions.
 */

interface Env {
  ROSTER?: string;
  MACHINE_PAT?: string;
  PR_SERVICE_TOKEN?: string;
  PR_REPOS?: string;
  LEDGER: DurableObjectNamespace<Ledger>;
  /** Holds, intents and terminal records (spec 0012 §8). */
  HOLDS: DurableObjectNamespace<PrHolds>;
  /** The operator's channel, over a service binding (spec 0009). */
  TELEGRAM?: TelegramGatewayBinding;
  [secret: string]: unknown;
}

/**
 * The GitHub identity for an agent: its OWN account's PAT
 * (MACHINE_PAT_<AGENTID>) when set, else the shared MACHINE_PAT.
 *
 * Which one answered matters enough to travel with the result. Every
 * authorship rule below asks "did this credential's login author the
 * item", so under the shared PAT "mine" means "any agent's", and one
 * agent can update or push to another's pull request (spec 0008 §6).
 * Per-agent accounts make that check mean what it says; the shared
 * fallback keeps existing colonies working and is ledgered as the
 * degradation it is.
 */
function patForAgent(env: Env, agentId: string): { token: string; shared: boolean } | undefined {
  const perAgent = env[`MACHINE_PAT_${agentId.toUpperCase().replace(/-/g, "_")}`];
  if (typeof perAgent === "string" && perAgent.length > 0) {
    return { token: perAgent, shared: false };
  }
  if (typeof env.MACHINE_PAT === "string" && env.MACHINE_PAT.length > 0) {
    return { token: env.MACHINE_PAT, shared: true };
  }
  return undefined;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("pr"));
}

function holds(env: Env) {
  return env.HOLDS.get(env.HOLDS.idFromName("pr"));
}

const UA = "operon-gatekeeper-pr";

function toResponse(result: DoorResult): Response {
  // Door bodies already carry ok, error and detail; refusals may add
  // the operator's reason and the head beside the error name.
  return json(result.body, result.status);
}

/**
 * Who each roster agent's credential authenticates as (spec 0012 §4),
 * resolved from the credentials and cached briefly per isolate. The
 * shared PAT resolves two agents to one login, which the merge door
 * refuses by name.
 */
const IDENTITY_TTL_MS = 5 * 60 * 1000;
let identityCache: { at: number; fingerprint: string; identities: Identities } | undefined;

async function identities(env: Env): Promise<Identities> {
  const agents = rosterAgentIds(env)
    .map(agentId => ({ agentId, pat: patForAgent(env, agentId) }))
    .filter((entry): entry is { agentId: string; pat: { token: string; shared: boolean } } => entry.pat !== undefined);
  // The fingerprint is a digest of which agent uses which credential,
  // so a rotation to ANY new value invalidates the cache (a restart
  // does too); no token is held by the cache.
  const fingerprint = await digest(
    agents.map(entry => `${entry.agentId}:${entry.pat.shared ? "shared" : "own"}:${entry.pat.token}`).join("\n")
  );
  if (identityCache && identityCache.fingerprint === fingerprint && Date.now() - identityCache.at < IDENTITY_TTL_MS) {
    return identityCache.identities;
  }
  const resolved = await resolveIdentities(
    agents.map(entry => ({
      agentId: entry.agentId,
      login: () => authenticatedLogin({ token: entry.pat.token, userAgent: UA })
    }))
  );
  identityCache = { at: Date.now(), fingerprint, identities: resolved };
  return resolved;
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function operatorDeps(env: Env): Omit<AdjudicationDeps, "api"> {
  return {
    holds: holds(env),
    ledger: ledger(env),
    notify: (text: string, actions?: OperatorAction[]) => notifyOperator(env, text, actions ? { actions } : {}),
    now: () => new Date().toISOString()
  };
}

function deps(env: Env, token: string): AdjudicationDeps {
  return {
    api: { token, userAgent: UA },
    holds: holds(env),
    ledger: ledger(env),
    notify: (text: string, actions?: OperatorAction[]) => notifyOperator(env, text, actions ? { actions } : {}),
    now: () => new Date().toISOString()
  };
}

async function handleReview(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; repo?: string; number?: number; verdict?: string; body?: string }>(
    request
  );
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number, verdict, body: text } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  const pat = identify(env, agentId);
  if (pat instanceof Response) return pat;
  const login = await authenticatedLogin({ token: pat.token, userAgent: UA });
  return toResponse(
    await reviewDoor(deps(env, pat.token), {
      agentId: agentId as string,
      login,
      repo,
      number,
      verdict,
      ...(typeof text === "string" ? { body: text } : {}),
      granted: reviewRepos(env, agentId as string).includes(repo)
    })
  );
}

async function handleMerge(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; repo?: string; number?: number }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  const pat = identify(env, agentId);
  if (pat instanceof Response) return pat;
  const login = await authenticatedLogin({ token: pat.token, userAgent: UA });
  return toResponse(
    await mergeDoor(deps(env, pat.token), {
      agentId: agentId as string,
      login,
      repo,
      number,
      grant: mergeGrant(env, agentId as string, repo),
      identities: await identities(env)
    })
  );
}

async function handleClose(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; repo?: string; number?: number; reason?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number, reason } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  const pat = identify(env, agentId);
  if (pat instanceof Response) return pat;
  return toResponse(
    await closeDoor(deps(env, pat.token), {
      agentId: agentId as string,
      repo,
      number,
      reason: typeof reason === "string" ? reason : "",
      granted: mergeGrant(env, agentId as string, repo) !== undefined
    })
  );
}

/** The merger's credential for a hold, or nothing: the hold names the agent, the roster names the PAT. */
function apiFor(env: Env): (agentId: string) => { token: string; userAgent: string } | undefined {
  return agentId => {
    if (rosterVerdict(env, agentId) !== "known") return undefined;
    const pat = patForAgent(env, agentId);
    return pat ? { token: pat.token, userAgent: UA } : undefined;
  };
}

async function handleApprove(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ heldId?: string }>(request);
  if (!body.ok || typeof body.value.heldId !== "string") return errorResponse(400, "invalid_request");
  const api = apiFor(env);
  return toResponse(
    await approveHeld(
      operatorDeps(env),
      {
        heldId: body.value.heldId,
        grantFor: (agentId, repo) => mergeGrant(env, agentId, repo),
        apiFor: api,
        loginFor: async agentId => {
          const credential = api(agentId);
          return credential ? authenticatedLogin(credential) : undefined;
        },
        identities: await identities(env)
      }
    )
  );
}

async function handleReject(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ heldId?: string; reason?: string }>(request);
  if (!body.ok || typeof body.value.heldId !== "string") return errorResponse(400, "invalid_request");
  return toResponse(
    await rejectHeld(
      operatorDeps(env),
      {
        heldId: body.value.heldId,
        ...(typeof body.value.reason === "string" ? { reason: body.value.reason } : {}),
        apiFor: apiFor(env)
      }
    )
  );
}

/**
 * The one place an agent's claimed identity becomes a credential. The
 * name arrives in the request body, so it is checked against the roster
 * before it selects anything: an unknown name must not pick up the
 * shared PAT and the fleet repo list on its way past.
 */
function identify(env: Env, agentId: unknown): { token: string; shared: boolean } | Response {
  if (typeof agentId !== "string" || agentId.length === 0) {
    return errorResponse(400, "missing_agent_id");
  }
  const verdict = rosterVerdict(env, agentId);
  if (verdict === "unknown") return errorResponse(404, "unknown_agent", agentId);
  if (verdict === "no-roster") {
    // Every Worker is deployed with the ROSTER var, so this is a broken
    // deployment rather than a bad request. Fail closed and say which:
    // an unverifiable claim must not reach the shared credential, and
    // an operator reading "unknown_agent" would hunt the wrong thing.
    return errorResponse(500, "roster_unavailable", "this Worker has no parseable ROSTER var");
  }
  const pat = patForAgent(env, agentId);
  if (!pat) return errorResponse(500, "credential_unconfigured");
  return pat;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

async function handlePr(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) {
    await ledger(env).append("pr_denied", { status: denied.status });
    return denied;
  }
  const body = await readJson<PrRequest & { agentId?: string }>(request);
  if (!body.ok) {
    await ledger(env).append("pr_failed", { reason: "malformed_json" });
    return errorResponse(400, "malformed_json");
  }
  const { repo, title, body: prBody, files, submodules, agentId } = body.value;

  const granted = typeof agentId === "string" ? grantedRepos(env, agentId) : [];
  if (typeof repo !== "string" || !REPO.test(repo) || !granted.includes(repo)) {
    await ledger(env).append("pr_failed", { reason: "repo_not_granted", agentId, repo });
    return errorResponse(403, "repo_not_granted", `granted to ${agentId}: ${granted.join(", ") || "nothing"}`);
  }
  if (typeof title !== "string" || !title || typeof prBody !== "string" || !prBody) {
    await ledger(env).append("pr_failed", { reason: "missing_title_or_body", repo });
    return errorResponse(400, "missing_title_or_body");
  }
  const links = submodules ?? [];
  if (!Array.isArray(links)) return errorResponse(400, "invalid_submodules");
  for (const link of links) {
    if (
      typeof link?.path !== "string" ||
      !SAFE_PATH.test(link.path) ||
      link.path.includes("..") ||
      link.path.startsWith("/") ||
      typeof link?.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(link.sha)
    ) {
      await ledger(env).append("pr_failed", { reason: "invalid_submodule", repo, path: link?.path });
      return errorResponse(400, "invalid_submodule", String(link?.path));
    }
  }
  // A pure submodule-bump PR carries no files; something must change.
  if (!Array.isArray(files) || (files.length === 0 && links.length === 0)) {
    await ledger(env).append("pr_failed", { reason: "no_files", repo });
    return errorResponse(400, "no_files");
  }
  // One tree entry per path, and no nesting across kinds: a path claimed
  // twice, an entry under a submodule path (nothing lives inside a
  // gitlink), or a submodule under a file path would all produce a Git
  // tree GitHub rejects.
  {
    const filePaths = files.map(file => file?.path).filter((p): p is string => typeof p === "string");
    const allPaths = [...filePaths, ...links.map(link => link.path)];
    const seen = new Set<string>();
    for (const path of allPaths) {
      if (seen.has(path)) {
        await ledger(env).append("pr_failed", { reason: "duplicate_path", repo, path });
        return errorResponse(400, "duplicate_path", path);
      }
      seen.add(path);
    }
    for (const link of links) {
      const under = allPaths.find(path => path !== link.path && path.startsWith(`${link.path}/`));
      if (under) {
        await ledger(env).append("pr_failed", { reason: "path_under_submodule", repo, path: under });
        return errorResponse(400, "path_under_submodule", `${under} is inside submodule ${link.path}`);
      }
      const over = filePaths.find(path => link.path.startsWith(`${path}/`));
      if (over) {
        await ledger(env).append("pr_failed", { reason: "submodule_under_file", repo, path: link.path });
        return errorResponse(400, "submodule_under_file", `${link.path} is under file ${over}`);
      }
    }
  }
  for (const file of files) {
    if (
      typeof file?.path !== "string" ||
      !SAFE_PATH.test(file.path) ||
      file.path.includes("..") ||
      file.path.startsWith("/") ||
      typeof file.contentBase64 !== "string"
    ) {
      await ledger(env).append("pr_failed", { reason: "invalid_file", repo, path: file?.path });
      return errorResponse(400, "invalid_file", String(file?.path));
    }
  }
  const pat = identify(env, agentId);
  if (pat instanceof Response) {
    await ledger(env).append("pr_failed", { reason: "identity_refused", agentId, repo });
    return pat;
  }

  try {
    const result = await openPullRequest(
      { token: pat.token, userAgent: "operon-gatekeeper-pr" },
      { repo, title, body: prBody, files, submodules: links },
      crypto.randomUUID()
    );
    await ledger(env).append("pr_opened", {
      agentId,
      identity: pat.shared ? "shared" : agentId,
      repo,
      url: result.url,
      branch: result.branch,
      files: files.length,
      submodules: links.length
    });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("pr_failed", { reason: "github_error", repo, detail: detail.slice(0, 300) });
    return errorResponse(502, "pr_open_failed", detail.slice(0, 300));
  }
}

async function handleIssue(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) {
    await ledger(env).append("issue_denied", { status: denied.status });
    return denied;
  }
  const body = await readJson<{ agentId?: string; repo?: string; title?: string; body?: string }>(
    request
  );
  if (!body.ok) {
    await ledger(env).append("issue_failed", { reason: "malformed_json" });
    return errorResponse(400, "malformed_json");
  }
  const { repo, title, body: issueBody, agentId } = body.value;
  const grantedForIssue = typeof agentId === "string" ? grantedRepos(env, agentId) : [];
  if (typeof repo !== "string" || !REPO.test(repo) || !grantedForIssue.includes(repo)) {
    await ledger(env).append("issue_failed", { reason: "repo_not_granted", agentId, repo });
    return errorResponse(
      403,
      "repo_not_granted",
      `granted to ${agentId}: ${grantedForIssue.join(", ") || "nothing"}`
    );
  }
  if (typeof title !== "string" || !title || typeof issueBody !== "string" || !issueBody) {
    await ledger(env).append("issue_failed", { reason: "missing_title_or_body", repo });
    return errorResponse(400, "missing_title_or_body");
  }
  const pat = identify(env, agentId);
  if (pat instanceof Response) return pat;
  try {
    const result = await openIssue(
      { token: pat.token, userAgent: "operon-gatekeeper-pr" },
      repo,
      title,
      issueBody
    );
    await ledger(env).append("issue_opened", {
      agentId,
      identity: pat.shared ? "shared" : agentId,
      repo,
      url: result.url
    });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("issue_failed", { reason: "github_error", repo, detail: detail.slice(0, 300) });
    return errorResponse(502, "issue_open_failed", detail.slice(0, 300));
  }
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const pat = identify(env, body.value.agentId);
  if (pat instanceof Response) return pat;
  try {
    // Watched repos are everything the agent may read (spec 0012 §3):
    // a reviewer with no authoring grant still sees what it adjudicates.
    const activity = await listActivity(
      { token: pat.token, userAgent: "operon-gatekeeper-pr" },
      reachableRepos(env, body.value.agentId as string)
    );
    return json({ ok: true, ...activity });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    return errorResponse(502, "status_failed", detail.slice(0, 300));
  }
}


/**
 * Conversation policy. Reading a thread or commenting is allowed on any
 * item in an allowlisted repo (answering users' issues is the point) and
 * on any item this agent's own account authored anywhere (its own PRs on
 * outside repos). Updating or pushing to an item requires AUTHORSHIP, not
 * just the allowlist: an agent must never rewrite or close someone else's
 * thread, and pushes additionally require the PR's head to live on the
 * agent's own account (its fork), never a branch of the upstream repo.
 */

async function conversationAccess(
  env: Env,
  agentId: string,
  pat: string,
  repo: string,
  number: number
): Promise<{ ref: Awaited<ReturnType<typeof getIssueRef>>; own: boolean } | Response> {
  const login = await authenticatedLogin({ token: pat, userAgent: "operon-gatekeeper-pr" });
  const ref = await getIssueRef({ token: pat, userAgent: "operon-gatekeeper-pr" }, repo, number);
  const own = ref.author === login;
  if (!own && !reachableRepos(env, agentId).includes(repo)) {
    return errorResponse(403, "not_own_and_not_granted", `${repo}#${number}`);
  }
  return { ref, own };
}

async function handleThread(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; repo?: string; number?: number }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  const pat = identify(env, agentId);
  if (pat instanceof Response) return pat;
  try {
    const access = await conversationAccess(env, agentId as string, pat.token, repo, number);
    if (access instanceof Response) return access;
    return json({
      ok: true,
      thread: await getThread({ token: pat.token, userAgent: "operon-gatekeeper-pr" }, repo, number)
    });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    return errorResponse(502, "thread_failed", detail.slice(0, 300));
  }
}

async function handleComment(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{
    agentId?: string;
    repo?: string;
    number?: number;
    body?: string;
    replyTo?: number;
  }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number, body: text, replyTo } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  if (typeof text !== "string" || !text) return errorResponse(400, "missing_body");
  const pat = identify(env, agentId);
  if (pat instanceof Response) return pat;
  try {
    const access = await conversationAccess(env, agentId as string, pat.token, repo, number);
    if (access instanceof Response) {
      await ledger(env).append("comment_denied", { agentId, repo, number });
      return access;
    }
    const api = { token: pat.token, userAgent: "operon-gatekeeper-pr" };
    const result =
      typeof replyTo === "number"
        ? await replyToReviewComment(api, repo, number, replyTo, text)
        : await postComment(api, repo, number, text);
    await ledger(env).append("comment_posted", { agentId, repo, number, replyTo, url: result.url });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("comment_failed", { agentId, repo, number, detail: detail.slice(0, 300) });
    return errorResponse(502, "comment_failed", detail.slice(0, 300));
  }
}

async function handleUpdate(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{
    agentId?: string;
    repo?: string;
    number?: number;
    title?: string;
    body?: string;
    state?: string;
  }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number, title, body: text, state } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  if (state !== undefined && state !== "open" && state !== "closed") {
    return errorResponse(400, "invalid_state");
  }
  const patch: { title?: string; body?: string; state?: "open" | "closed" } = {};
  if (typeof title === "string" && title) patch.title = title;
  if (typeof text === "string" && text) patch.body = text;
  if (state) patch.state = state;
  if (Object.keys(patch).length === 0) return errorResponse(400, "empty_patch");
  const pat = identify(env, agentId);
  if (pat instanceof Response) return pat;
  try {
    const access = await conversationAccess(env, agentId as string, pat.token, repo, number);
    if (access instanceof Response) return access;
    if (!access.own) {
      await ledger(env).append("update_denied", { agentId, repo, number, reason: "not_author" });
      return errorResponse(403, "not_author", "only the item's own author may update it");
    }
    const result = await updateIssue(
      { token: pat.token, userAgent: "operon-gatekeeper-pr" },
      repo,
      number,
      patch
    );
    await ledger(env).append("item_updated", {
      agentId,
      identity: pat.shared ? "shared" : agentId,
      repo,
      number,
      fields: Object.keys(patch)
    });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    return errorResponse(502, "update_failed", detail.slice(0, 300));
  }
}

async function handlePush(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{
    agentId?: string;
    repo?: string;
    number?: number;
    message?: string;
    files?: Array<{ path?: string; contentBase64?: string }>;
  }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, number, message, files } = body.value;
  if (typeof repo !== "string" || !REPO.test(repo) || typeof number !== "number") {
    return errorResponse(400, "invalid_request");
  }
  if (typeof message !== "string" || !message) return errorResponse(400, "missing_message");
  if (!Array.isArray(files) || files.length === 0) return errorResponse(400, "no_files");
  for (const file of files) {
    if (
      typeof file?.path !== "string" ||
      !SAFE_PATH.test(file.path) ||
      file.path.includes("..") ||
      file.path.startsWith("/") ||
      typeof file.contentBase64 !== "string"
    ) {
      return errorResponse(400, "invalid_file", String(file?.path));
    }
  }
  const pat = identify(env, agentId);
  if (pat instanceof Response) return pat;
  try {
    const api = { token: pat.token, userAgent: "operon-gatekeeper-pr" };
    const login = await authenticatedLogin(api);
    const ref = await getIssueRef(api, repo, number);
    if (ref.kind !== "pr") return errorResponse(400, "not_a_pr");
    if (ref.author !== login) {
      await ledger(env).append("push_denied", { agentId, repo, number, reason: "not_author" });
      return errorResponse(403, "not_author", "only the PR's own author may push to it");
    }
    if (!ref.headRepo || !ref.headBranch || !ref.headRepo.startsWith(`${login}/`)) {
      await ledger(env).append("push_denied", { agentId, repo, number, reason: "head_not_own_fork" });
      return errorResponse(403, "head_not_own_fork", String(ref.headRepo));
    }
    const result = await pushToPr(
      api,
      ref.headRepo,
      ref.headBranch,
      message,
      files as Array<{ path: string; contentBase64: string }>
    );
    await ledger(env).append("pr_pushed", {
      agentId,
      identity: pat.shared ? "shared" : agentId,
      repo,
      number,
      commit: result.commitSha,
      files: files.length
    });
    return json({ ok: true, ...result });
  } catch (error) {
    const detail = error instanceof GitDataError ? error.message : String(error);
    await ledger(env).append("push_failed", { agentId, repo, number, detail: detail.slice(0, 300) });
    return errorResponse(502, "push_failed", detail.slice(0, 300));
  }
}

async function handleUpstreamFile(request: Request, env: Env): Promise<Response> {
  const denied = requireBearer(request, env.PR_SERVICE_TOKEN);
  if (denied) return denied;
  const body = await readJson<{ agentId?: string; repo?: string; path?: string }>(request);
  if (!body.ok) return errorResponse(400, "malformed_json");
  const { agentId, repo, path } = body.value;
  const grantedForFile = typeof agentId === "string" ? reachableRepos(env, agentId) : [];
  if (typeof repo !== "string" || !REPO.test(repo) || !grantedForFile.includes(repo)) {
    return errorResponse(
      403,
      "repo_not_granted",
      `granted to ${agentId}: ${grantedForFile.join(", ") || "nothing"}`
    );
  }
  if (
    typeof path !== "string" ||
    !SAFE_PATH.test(path) ||
    path.includes("..") ||
    path.startsWith("/")
  ) {
    return errorResponse(400, "invalid_path");
  }
  const pat = identify(env, agentId);
  if (pat instanceof Response) return pat;
  try {
    const file = await getUpstreamFile({ token: pat.token, userAgent: "operon-gatekeeper-pr" }, repo, path);
    return json({ ok: true, ...file });
  } catch (error) {
    return errorResponse(502, "upstream_file_failed", String(error).slice(0, 300));
  }
}

export default drainingBodies({
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/gatekeeper/pr" && request.method === "POST") {
      return handlePr(request, env);
    }
    if (url.pathname === "/gatekeeper/issue" && request.method === "POST") {
      return handleIssue(request, env);
    }
    if (url.pathname === "/gatekeeper/status" && request.method === "POST") {
      return handleStatus(request, env);
    }
    if (url.pathname === "/gatekeeper/upstream-file" && request.method === "POST") {
      return handleUpstreamFile(request, env);
    }
    if (url.pathname === "/gatekeeper/thread" && request.method === "POST") {
      return handleThread(request, env);
    }
    if (url.pathname === "/gatekeeper/comment" && request.method === "POST") {
      return handleComment(request, env);
    }
    if (url.pathname === "/gatekeeper/update" && request.method === "POST") {
      return handleUpdate(request, env);
    }
    if (url.pathname === "/gatekeeper/push" && request.method === "POST") {
      return handlePush(request, env);
    }
    if (url.pathname === "/gatekeeper/review" && request.method === "POST") {
      return handleReview(request, env);
    }
    if (url.pathname === "/gatekeeper/merge" && request.method === "POST") {
      return handleMerge(request, env);
    }
    if (url.pathname === "/gatekeeper/close" && request.method === "POST") {
      return handleClose(request, env);
    }
    return errorResponse(404, "not_found");
  }
} satisfies ExportedHandler<Env>);
