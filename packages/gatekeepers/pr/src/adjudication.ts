/**
 * The adjudication doors (spec 0012 §5 to §8) as logic over injected
 * dependencies: the agent's GitHub credential, the hold store, the
 * ledger and the operator notify. No Cloudflare import, so every flow
 * (auto merge, hold, lost response, reconciliation, approval on a moved
 * head, rejection under a young claim, a close resumed from its
 * marker) runs in a plain test. index.ts wires the Worker around it.
 */

import { GitDataError, type GithubApi } from "@operon/worker-kit/git-data";
import type { MergeGrant } from "@operon/core";
import type { OperatorAction } from "@operon/worker-kit";
import {
  findCommentWithMarker,
  getIssueRef,
  getPullMergeState,
  getPullSnapshot,
  mergePullRequest,
  postComment,
  submitReview,
  updateIssue,
  type PullSnapshot
} from "./github.js";
import { INTENT_STALE_MS, type HoldStore, type HeldMerge, type MergeIntent, type TerminalRecord } from "./holds.js";
import { mergeDecision, mergePreconditions, reviewDecision, type MergeContext } from "./merge-policy.js";

/** The hold store's surface, so the DO stub and the in-memory store both fit. */
export type HoldsApi = {
  [K in keyof HoldStore]: HoldStore[K];
};

export interface LedgerApi {
  append(kind: string, data: Record<string, unknown>): Promise<unknown>;
}

export interface Identities {
  /** login -> roster id, for every roster agent whose credential answered. */
  logins: ReadonlyMap<string, string>;
  /** Two roster agents resolved to one login (the shared PAT). */
  sharedIdentity: boolean;
}

export interface AdjudicationDeps {
  api: GithubApi;
  holds: HoldsApi;
  ledger: LedgerApi;
  notify: (text: string, actions?: OperatorAction[]) => Promise<void>;
  now: () => string;
  /** Test hook for the mergeable poll. */
  sleep?: (ms: number) => Promise<void>;
}

/** What a door answers: a status and a JSON body; errors carry `error` and `detail`. */
export interface DoorResult {
  status: number;
  body: Record<string, unknown>;
}

const ok = (body: Record<string, unknown>): DoorResult => ({ status: 200, body: { ok: true, ...body } });
const refuse = (status: number, error: string, detail?: string): DoorResult => ({
  status,
  body: { ok: false, error, ...(detail !== undefined ? { detail } : {}) }
});
const clip = (text: string) => text.slice(0, 300);

// ---- identity ---------------------------------------------------------------

/**
 * Which login each roster agent's credential authenticates as (spec 0012
 * §4). Resolved from the credentials, never from a roster field: a PAT
 * rotated onto another account cannot lie about who it is. Two agents
 * on one login is the shared PAT, and the merge door refuses it.
 */
export async function resolveIdentities(
  agents: Array<{ agentId: string; login: () => Promise<string> }>
): Promise<Identities> {
  const logins = new Map<string, string>();
  let sharedIdentity = false;
  for (const agent of agents) {
    let login: string;
    try {
      login = await agent.login();
    } catch {
      continue;
    }
    if (logins.has(login) && logins.get(login) !== agent.agentId) sharedIdentity = true;
    logins.set(login, agent.agentId);
  }
  return { logins, sharedIdentity };
}

// ---- review (§5) ------------------------------------------------------------

const REVIEW_EVENTS = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;

export async function reviewDoor(
  deps: AdjudicationDeps,
  input: { agentId: string; login: string; repo: string; number: number; verdict: unknown; body?: string; granted: boolean }
): Promise<DoorResult> {
  const { agentId, repo, number } = input;
  const denied = async (reason: string, status: number) => {
    await deps.ledger.append("review_denied", { agentId, repo, number, reason });
    return refuse(status, reason);
  };
  if (!input.granted) return denied("repo_not_granted", 403);
  let ref;
  try {
    ref = await getIssueRef(deps.api, repo, number);
  } catch (error) {
    return refuse(502, "review_failed", clip(String(error)));
  }
  const decision = reviewDecision({
    verdict: input.verdict,
    body: input.body,
    isPullRequest: ref.kind === "pr",
    prAuthor: ref.author,
    login: input.login,
    granted: true
  });
  if (!decision.ok) {
    const status = decision.reason === "invalid_verdict" || decision.reason === "missing_body" ? 400 : 403;
    return denied(decision.reason, status);
  }
  try {
    // Bound to the head the reviewer read: the review is GitHub's answer
    // for THAT sha, and a push in between is not approved unseen.
    const { headSha } = await getPullMergeState(deps.api, repo, number);
    const result = await submitReview(deps.api, repo, number, REVIEW_EVENTS[decision.verdict], input.body, headSha);
    await deps.ledger.append("review_posted", {
      agentId,
      identity: agentId,
      repo,
      number,
      verdict: decision.verdict,
      headSha,
      url: result.url
    });
    return ok({ status: "reviewed", verdict: decision.verdict, headSha, url: result.url });
  } catch (error) {
    const detail = clip(error instanceof GitDataError ? error.message : String(error));
    await deps.ledger.append("review_failed", { agentId, repo, number, detail });
    return refuse(502, "review_failed", detail);
  }
}

// ---- merge (§6) -------------------------------------------------------------

export interface MergeInput {
  agentId: string;
  login: string;
  repo: string;
  number: number;
  grant: MergeGrant | undefined;
  identities: Identities;
}

/** Whether a GitHub error is GitHub SAYING no (terminal) or the wire failing (unknown). */
function definitiveFailure(error: unknown): boolean {
  return error instanceof GitDataError && error.status >= 400 && error.status < 500;
}

/**
 * Bring an open intent to a terminal state from GitHub's truth (spec
 * 0012 §6): merged with this head, merged with another head (someone
 * else's merge), or not merged. Unreachable GitHub leaves it unknown.
 */
export async function reconcileIntent(deps: AdjudicationDeps, intent: MergeIntent): Promise<MergeIntent> {
  let state;
  try {
    state = await getPullMergeState(deps.api, intent.repo, intent.number);
  } catch {
    return (await deps.holds.resolveMerge(intent.id, { state: "unknown", detail: "github unreachable" }, deps.now())) ?? intent;
  }
  const at = deps.now();
  const base = { agentId: intent.agentId, repo: intent.repo, number: intent.number, headSha: intent.headSha, reconciled: true };
  // The intent's terminal state, the head's terminal record and the
  // hold it came from settle in ONE store turn: a hold whose approval
  // merged (or was overtaken) is deleted, one whose attempt provably
  // did not merge is given back. Nothing here is best-effort: a failed
  // settle leaves the intent open, and the next reconciliation retries.
  if (state.merged && state.headSha === intent.headSha) {
    const mergeSha = state.mergeCommitSha ?? "unknown";
    const resolved = await deps.holds.settleMerge(intent.id, { state: "merged", mergeSha }, at, {
      terminal: { ...terminalBase(intent, at), outcome: "merged", by: intent.agentId, mergeSha },
      hold: "delete"
    });
    await deps.ledger.append("pr_merged", { ...base, mode: intent.mode, mergeSha, heldId: intent.heldId });
    return resolved ?? intent;
  }
  if (state.merged) {
    const resolved = await deps.holds.settleMerge(
      intent.id,
      { state: "superseded", detail: `merged at ${state.headSha.slice(0, 7)}, intent was ${intent.headSha.slice(0, 7)}` },
      at,
      { terminal: { ...terminalBase(intent, at), outcome: "superseded", by: "unknown" }, hold: "delete" }
    );
    await deps.ledger.append("merge_superseded", { ...base, mergedHead: state.headSha });
    return resolved ?? intent;
  }
  const resolved = await deps.holds.settleMerge(intent.id, { state: "failed", detail: "reconciled: not merged" }, at, {
    hold: "unclaim"
  });
  await deps.ledger.append("merge_failed", { ...base, detail: "reconciled: not merged" });
  return resolved ?? intent;
}

/** A pending intent this old belongs to a door that crashed, not one still working. */
function stalePending(intent: MergeIntent, now: string): boolean {
  return intent.state === "pending" && Date.parse(now) - Date.parse(intent.at) >= INTENT_STALE_MS;
}

/**
 * Every open intent brought to GitHub's truth, with the credential of
 * the agent that made it (spec 0012 §6, §8): what the operator's held
 * listing does first, so a lost response never leaves a claimed hold
 * in the queue or an intent unknown longer than GitHub is unreachable.
 */
export async function reconcileOpenIntents(
  deps: Omit<AdjudicationDeps, "api">,
  apiFor: (agentId: string) => GithubApi | undefined
): Promise<MergeIntent[]> {
  const out: MergeIntent[] = [];
  for (const intent of await deps.holds.listOpenMergeIntents()) {
    if (intent.state === "pending" && !stalePending(intent, deps.now())) continue;
    const api = apiFor(intent.agentId);
    if (!api) continue;
    out.push(await reconcileIntent({ ...deps, api }, intent));
  }
  return out;
}

function terminalBase(intent: MergeIntent, at: string): Omit<TerminalRecord, "outcome" | "by"> {
  return {
    repo: intent.repo,
    number: intent.number,
    headSha: intent.headSha,
    at,
    ...(intent.heldId !== undefined ? { heldId: intent.heldId } : {})
  };
}

/**
 * The irreversible act with its accounting: intent row, the GitHub
 * call with the head pinned, the terminal result, then the ledger. A
 * definitive refusal from GitHub fails the intent; a lost response
 * leaves it unknown and the door says so.
 */
async function executeMerge(
  deps: AdjudicationDeps,
  input: {
    agentId: string;
    repo: string;
    number: number;
    headSha: string;
    mode: "auto" | "operator";
    heldId?: string;
    claimToken?: string;
    approvedBy: string[];
    files: string[];
    title: string;
  }
): Promise<DoorResult> {
  const { agentId, repo, number, headSha, mode, heldId } = input;
  const begun = await deps.holds.beginMerge({
    repo,
    number,
    headSha,
    agentId,
    mode,
    ...(heldId !== undefined ? { heldId, claimToken: input.claimToken } : {}),
    at: deps.now()
  });
  if (!begun.created && begun.reason === "hold_gone") {
    // The operator rejected this head while the approval was running:
    // the hold and its claim are gone, and so is this act.
    await deps.ledger.append("merge_denied", { agentId, repo, number, headSha, reason: "hold_gone", heldId });
    return refuse(409, "hold_gone", "the hold was decided while this approval ran; nothing was merged");
  }
  if (!begun.created) {
    // Another call started an irreversible act for this pull request
    // between our read and our write: the store refused a second one.
    // A hold this attempt had claimed goes back to the operator; the
    // winning intent, when it settles, deletes every hold for the
    // head it merged.
    if (heldId !== undefined) await deps.holds.unclaimHeld(heldId);
    await deps.ledger.append("merge_denied", { agentId, repo, number, headSha, reason: "merge_in_progress", intentId: begun.intent.id });
    return refuse(409, "merge_in_progress", `intent ${begun.intent.id} is ${begun.intent.state}; call again to reconcile`);
  }
  const intent = begun.intent;
  try {
    const result = await mergePullRequest(deps.api, repo, number, headSha);
    const at = deps.now();
    await deps.holds.settleMerge(
      intent.id,
      { state: "merged", mergeSha: result.mergeSha },
      at,
      {
        terminal: {
          repo,
          number,
          headSha,
          outcome: "merged",
          at,
          by: agentId,
          mergeSha: result.mergeSha,
          ...(heldId !== undefined ? { heldId } : {})
        },
        hold: "delete"
      }
    );
    await deps.ledger.append("pr_merged", {
      agentId,
      identity: agentId,
      repo,
      number,
      headSha,
      mergeSha: result.mergeSha,
      mode,
      approvedBy: input.approvedBy,
      files: input.files.length,
      ...(heldId !== undefined ? { heldId } : {})
    });
    await deps.notify(`[${agentId}] merged ${repo}#${number} "${input.title}" (${mode}, approved by ${input.approvedBy.join(", ") || "the operator"})`);
    return ok({ status: "merged", mergeSha: result.mergeSha, headSha, mode });
  } catch (error) {
    const detail = clip(error instanceof GitDataError ? error.message : String(error));
    if (definitiveFailure(error)) {
      // GitHub said no: the attempt is over and the hold, if any, goes
      // back to the operator in the same turn.
      await deps.holds.settleMerge(intent.id, { state: "failed", detail }, deps.now(), { hold: "unclaim" });
      await deps.ledger.append("merge_failed", { agentId, repo, number, headSha, mode, detail });
      return refuse(502, "merge_failed", detail);
    }
    await deps.holds.resolveMerge(intent.id, { state: "unknown", detail }, deps.now());
    await deps.ledger.append("merge_outcome_unknown", { agentId, repo, number, headSha, mode, detail });
    return refuse(503, "outcome_unknown", "the merge may have landed; the next call reconciles before anything else");
  }
}

export async function mergeDoor(deps: AdjudicationDeps, input: MergeInput): Promise<DoorResult> {
  const { agentId, repo, number, grant } = input;
  if (!grant) {
    await deps.ledger.append("merge_denied", { agentId, repo, number, reason: "repo_not_granted" });
    return refuse(403, "repo_not_granted", repo);
  }

  // An open intent is reconciled before anything else (spec 0012 §6).
  // A PENDING one younger than the stale bound is a door still working
  // this pull request: it is in progress, not lost.
  const open = await deps.holds.openMergeIntent(repo, number);
  if (open && open.state === "pending" && !stalePending(open, deps.now())) {
    await deps.ledger.append("merge_denied", { agentId, repo, number, reason: "merge_in_progress", intentId: open.id });
    return refuse(409, "merge_in_progress", `intent ${open.id} started at ${open.at}`);
  }
  if (open) {
    const reconciled = await reconcileIntent(deps, open);
    if (reconciled.state === "unknown") {
      return refuse(503, "outcome_unknown", "an earlier merge attempt has no known outcome yet and GitHub is unreachable");
    }
    if (reconciled.state === "merged") {
      return ok({ status: "merged", mergeSha: reconciled.mergeSha, headSha: reconciled.headSha, mode: reconciled.mode, reconciled: true });
    }
    // superseded or failed: a fresh decision follows.
  }

  let snapshot: PullSnapshot;
  try {
    snapshot = await getPullSnapshot(deps.api, repo, number, deps.sleep ? { sleep: deps.sleep } : {});
  } catch (error) {
    const detail = clip(error instanceof GitDataError ? error.message : String(error));
    await deps.ledger.append("merge_failed", { agentId, repo, number, detail });
    return refuse(502, "merge_failed", detail);
  }

  const terminal = await deps.holds.terminal(repo, number, snapshot.headSha);
  if (terminal?.outcome === "rejected") {
    await deps.ledger.append("merge_denied", { agentId, repo, number, headSha: snapshot.headSha, reason: "rejected_by_operator" });
    return {
      status: 409,
      body: { ok: false, error: "rejected_by_operator", reason: terminal.reason, at: terminal.at, headSha: snapshot.headSha }
    };
  }

  const ctx: MergeContext = {
    mergerAgentId: agentId,
    mergerLogin: input.login,
    logins: input.identities.logins,
    sharedIdentity: input.identities.sharedIdentity,
    auto: grant.auto ?? [],
    checks: grant.checks ?? []
  };
  const verdict = mergeDecision(snapshot, ctx);
  if (verdict.kind === "refuse") {
    await deps.ledger.append("merge_denied", {
      agentId,
      repo,
      number,
      headSha: snapshot.headSha,
      reason: verdict.reason,
      ...(verdict.detail !== undefined ? { detail: verdict.detail } : {})
    });
    return refuse(409, verdict.reason, verdict.detail);
  }
  const files = snapshot.files.map(file => file.filename);
  if (verdict.kind === "hold") {
    const { held, deduped } = await deps.holds.hold(
      {
        agentId,
        repo,
        number,
        title: snapshot.title,
        author: snapshot.author,
        headSha: snapshot.headSha,
        outside: verdict.outside,
        approvedBy: verdict.approvedBy
      },
      deps.now()
    );
    if (!deduped) {
      await deps.ledger.append("merge_held", {
        agentId,
        repo,
        number,
        headSha: snapshot.headSha,
        heldId: held.id,
        reason: "outside_auto_paths",
        outside: verdict.outside,
        approvedBy: verdict.approvedBy
      });
      await deps.notify(
        `[${agentId}] merge HELD: ${repo}#${number} (head ${snapshot.headSha.slice(0, 7)}) touches ${verdict.outside.length} path(s) outside the data directories:\n` +
          verdict.outside.slice(0, 20).map(path => `  ${path}`).join("\n") +
          `\nApproved by ${verdict.approvedBy.join(", ")}. A code change also needs your review on GitHub first: approve the pull request there, then tap Approve.\n${snapshot.url}`,
        [
          { label: "Approve", kind: "merge_approve", agentId, id: held.id },
          { label: "Reject", kind: "merge_reject", agentId, id: held.id }
        ]
      );
    }
    return ok({ status: "held_for_approval", heldId: held.id, headSha: snapshot.headSha, outside: verdict.outside });
  }
  return executeMerge(deps, {
    agentId,
    repo,
    number,
    headSha: snapshot.headSha,
    mode: "auto",
    approvedBy: verdict.approvedBy,
    files,
    title: snapshot.title
  });
}

// ---- close (§7) -------------------------------------------------------------

export const closeMarker = (intentId: string) => `<!-- operon-close ${intentId} -->`;

export async function closeDoor(
  deps: AdjudicationDeps,
  input: { agentId: string; repo: string; number: number; reason: string; granted: boolean }
): Promise<DoorResult> {
  const { agentId, repo, number, reason } = input;
  const denied = async (why: string, status: number, detail?: string) => {
    await deps.ledger.append("close_denied", { agentId, repo, number, reason: why });
    return refuse(status, why, detail);
  };
  if (!input.granted) return denied("repo_not_granted", 403, repo);
  if (reason.trim().length === 0) return denied("missing_reason", 400);

  let ref;
  try {
    ref = await getIssueRef(deps.api, repo, number);
  } catch (error) {
    return refuse(502, "close_failed", clip(String(error)));
  }
  if (ref.kind !== "pr") return denied("not_a_pr", 409);

  // A retry finds its own intent and resumes from GitHub's truth, not
  // from memory: the marker says whether the reason was posted, the
  // state says whether the patch landed. The begin is atomic in the
  // store, so two overlapping close calls cannot both work the same
  // intent: the second answers busy.
  const begun = await deps.holds.beginClose({ repo, number, agentId, reason, at: deps.now() });
  if (begun.status === "busy") return refuse(409, "close_in_progress", `intent ${begun.intent.id}`);
  if (begun.status === "created" && ref.state !== "open") {
    await deps.holds.resolveClose(begun.intent.id, "failed", deps.now(), "already closed");
    return denied("already_closed", 409);
  }
  const intent = begun.intent;
  const marker = closeMarker(intent.id);
  try {
    let commentUrl: string | undefined;
    if (!intent.steps.commented) {
      commentUrl = await findCommentWithMarker(deps.api, repo, number, marker);
      if (commentUrl === undefined) {
        commentUrl = (await postComment(deps.api, repo, number, `${intent.reason}\n\n${marker}`)).url;
      }
      await deps.holds.closeStep(intent.id, "commented");
    }
    if (!intent.steps.closed) {
      if (ref.state === "open") await updateIssue(deps.api, repo, number, { state: "closed" });
      await deps.holds.closeStep(intent.id, "closed");
    }
    await deps.holds.resolveClose(intent.id, "closed", deps.now());
    await deps.ledger.append("pr_closed", {
      agentId,
      identity: agentId,
      repo,
      number,
      author: ref.author,
      reason: intent.reason,
      ...(intent.steps.commented || intent.steps.closed ? { resumed: true } : {})
    });
    return ok({ status: "closed", ...(commentUrl !== undefined ? { commentUrl } : {}) });
  } catch (error) {
    const detail = clip(error instanceof GitDataError ? error.message : String(error));
    if (definitiveFailure(error)) {
      // GitHub said no: the intent is over, and a new call starts a new one.
      await deps.holds.resolveClose(intent.id, "failed", deps.now(), detail);
      await deps.ledger.append("close_failed", { agentId, repo, number, intentId: intent.id, detail });
      return refuse(502, "close_failed", detail);
    }
    // The wire dropped: the step may have landed. The intent stays
    // pending with the steps recorded so far and is released for the
    // next call, which resumes from GitHub's truth; a close that may
    // have happened is never reported as failed.
    await deps.holds.releaseClose(intent.id);
    const current = (await deps.holds.openCloseIntent(repo, number)) ?? intent;
    await deps.ledger.append("close_outcome_unknown", { agentId, repo, number, intentId: intent.id, steps: current.steps, detail });
    return { status: 503, body: { ok: false, error: "outcome_unknown", intentId: intent.id, steps: current.steps, detail } };
  }
}

// ---- the operator's surface (§8) -------------------------------------------

export async function listHeld(
  deps: Omit<AdjudicationDeps, "api">,
  apiFor: (agentId: string) => GithubApi | undefined
): Promise<DoorResult> {
  const reconciled = await reconcileOpenIntents(deps, apiFor);
  const held = await deps.holds.listHeld();
  const terminals = await deps.holds.listTerminals();
  const unknown = (await deps.holds.listOpenMergeIntents()).filter(intent => intent.state === "unknown");
  return ok({ held, terminals, unknown, ...(reconciled.length > 0 ? { reconciled: reconciled.length } : {}) });
}

export interface ApproveInput {
  heldId: string;
  /** The merger named on the hold, resolved by the caller to its credential and grant. */
  grantFor: (agentId: string, repo: string) => MergeGrant | undefined;
  apiFor: (agentId: string) => GithubApi | undefined;
  loginFor: (agentId: string) => Promise<string | undefined>;
  identities: Identities;
}

export async function approveHeld(deps: Omit<AdjudicationDeps, "api">, input: ApproveInput): Promise<DoorResult> {
  const at = deps.now();
  const held = await deps.holds.claimHeld(input.heldId, at);
  if (!held) return refuse(409, "held_unavailable", "already claimed, decided, or not found");
  const { agentId, repo, number } = held;
  const api = input.apiFor(agentId);
  const login = api ? await input.loginFor(agentId) : undefined;
  const grant = input.grantFor(agentId, repo);
  const giveBack = async (error: string, detail?: string) => {
    await deps.holds.unclaimHeld(held.id);
    await deps.ledger.append("merge_approve_failed", { agentId, repo, number, heldId: held.id, reason: error, detail });
    return refuse(409, error, detail);
  };
  if (!api || login === undefined) return giveBack("no_longer_qualifies", "credential_unconfigured");
  if (!grant) return giveBack("no_longer_qualifies", "merge_not_granted");

  const scoped: AdjudicationDeps = { ...deps, api };
  let snapshot: PullSnapshot;
  try {
    snapshot = await getPullSnapshot(api, repo, number, deps.sleep ? { sleep: deps.sleep } : {});
  } catch (error) {
    return giveBack("no_longer_qualifies", clip(String(error)));
  }
  if (snapshot.headSha !== held.headSha) {
    // The operator approved a revision that no longer exists: the hold
    // is void, and the next merge request makes a fresh one with fresh
    // evidence. Nothing is silently refreshed.
    await deps.holds.deleteHeld(held.id);
    await deps.ledger.append("merge_hold_invalidated", {
      agentId,
      repo,
      number,
      heldId: held.id,
      reason: "head_moved",
      heldHead: held.headSha,
      currentHead: snapshot.headSha
    });
    return refuse(409, "head_moved", `held ${held.headSha.slice(0, 7)}, head is now ${snapshot.headSha.slice(0, 7)}`);
  }
  const precondition = mergePreconditions(snapshot, {
    mergerLogin: login,
    checks: grant.checks ?? [],
    sharedIdentity: input.identities.sharedIdentity
  });
  if (precondition) {
    const reason =
      precondition.reason === "not_mergeable" && snapshot.mergeableState === "blocked"
        ? "blocked_by_branch_protection"
        : precondition.reason;
    return giveBack("no_longer_qualifies", precondition.detail ? `${reason}: ${precondition.detail}` : reason);
  }
  const result = await executeMerge(scoped, {
    agentId,
    repo,
    number,
    headSha: held.headSha,
    mode: "operator",
    heldId: held.id,
    ...(held.claimToken !== undefined ? { claimToken: held.claimToken } : {}),
    approvedBy: held.approvedBy,
    files: snapshot.files.map(file => file.filename),
    title: held.title
  });
  // The hold's fate (deleted on a merge, unclaimed on GitHub's refusal)
  // settled with the intent in one store turn; outcome_unknown keeps
  // the claim, and the reconciliation decides.
  return result;
}

export async function rejectHeld(
  deps: Omit<AdjudicationDeps, "api">,
  input: { heldId: string; reason?: string; apiFor: (agentId: string) => GithubApi | undefined }
): Promise<DoorResult> {
  const at = deps.now();
  const verdict = await deps.holds.rejectVerdict(input.heldId, at);
  if (verdict.status === "not_found") {
    const earlier = (await deps.holds.listTerminals()).find(record => record.heldId === input.heldId);
    if (earlier?.outcome === "rejected") return ok({ status: "rejected", repeated: true });
    if (earlier?.outcome === "merged") return refuse(409, "already_merged", earlier.mergeSha);
    return refuse(404, "not_found");
  }
  if (verdict.status === "approval_in_flight") {
    return refuse(409, "approval_in_flight", "an approval claimed this hold moments ago; wait for its outcome");
  }
  const held = verdict.held;
  if (verdict.status === "stale_claim") {
    // The claim is old, but the approval behind it may still be alive:
    // an intent it began says so. A young pending intent is an act in
    // flight; an unknown or stale one is reconciled first, and a
    // reconciled merge concedes.
    const api = input.apiFor(held.agentId);
    const open = await deps.holds.openMergeIntent(held.repo, held.number);
    if (open && open.state === "pending" && !stalePending(open, at)) {
      return refuse(409, "approval_in_flight", `intent ${open.id} began at ${open.at}; wait for its outcome`);
    }
    if (open && api) {
      const reconciled = await reconcileIntent({ ...deps, api }, open);
      if (reconciled.state === "merged" || reconciled.state === "superseded") {
        return refuse(409, "already_merged", "the approval that claimed this hold merged it");
      }
      if (reconciled.state === "unknown") {
        return refuse(503, "outcome_unknown", "a stale approval claim exists and GitHub is unreachable");
      }
    }
    if (api) {
      try {
        const state = await getPullMergeState(api, held.repo, held.number);
        if (state.merged) {
          await deps.holds.deleteHeld(held.id);
          await deps.ledger.append("merge_rejected", {
            agentId: held.agentId,
            repo: held.repo,
            number: held.number,
            heldId: held.id,
            outcome: "already_merged"
          });
          return refuse(409, "already_merged", "the approval that claimed this hold merged it");
        }
      } catch {
        return refuse(503, "outcome_unknown", "a stale approval claim exists and GitHub is unreachable");
      }
    }
  }
  // The terminal record and the hold's deletion land in one turn: a
  // stale approval that reaches beginMerge afterwards finds no hold and
  // stops before GitHub.
  await deps.holds.rejectAndRecord(held, {
    repo: held.repo,
    number: held.number,
    headSha: held.headSha,
    outcome: "rejected",
    at,
    by: "operator",
    heldId: held.id,
    ...(input.reason !== undefined ? { reason: input.reason } : {})
  });
  await deps.ledger.append("merge_rejected", {
    agentId: held.agentId,
    repo: held.repo,
    number: held.number,
    heldId: held.id,
    headSha: held.headSha,
    ...(input.reason !== undefined ? { reason: input.reason } : {})
  });
  return ok({ status: "rejected", heldId: held.id });
}

export type { HeldMerge };
