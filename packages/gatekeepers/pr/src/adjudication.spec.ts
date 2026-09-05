import { describe, expect, it } from "vitest";
import type { OperatorAction } from "@operon/worker-kit";
import {
  approveHeld,
  closeDoor,
  closeMarker,
  listHeld,
  mergeDoor,
  reconcileIntent,
  rejectHeld,
  resolveIdentities,
  reviewDoor,
  type AdjudicationDeps,
  type Identities
} from "./adjudication.js";
import { CLAIM_AGE_MS, HoldStore, INTENT_STALE_MS, UNKNOWN_GRACE_MS, memoryStorage } from "./holds.js";

const HEAD = "head1111111111111111111111111111111111111";
const HEAD2 = "head2222222222222222222222222222222222222";
const REPO = "org/registry";

/**
 * A scripted GitHub: a mutable pull request state, canned reviews and
 * checks, and a log of every mutation the door made. `fail` makes one
 * call throw as if the wire dropped (a lost response) or as GitHub
 * refusing (a 4xx).
 */
function github(over: Partial<GithubState> = {}) {
  const state: GithubState = {
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    mergeableState: "clean",
    headSha: HEAD,
    author: "researcher-bot",
    files: [{ filename: "registry/agents/prior/agent.json" }],
    reviews: [{ user: { login: "reviewer-bot" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-09-05T09:00:00Z" }],
    runs: [{ name: "validate", status: "completed", conclusion: "success" }],
    comments: [],
    mergeCommitSha: null,
    calls: [],
    fail: {},
    ...over
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const key = `${method} ${path.split("?")[0]}`;
    state.calls.push(key);
    const failure = state.fail[key];
    if (failure === "lost") {
      delete state.fail[key];
      throw new TypeError("fetch failed: socket hang up");
    }
    if (typeof failure === "number") {
      delete state.fail[key];
      return new Response(JSON.stringify({ message: "refused" }), { status: failure });
    }
    const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    if (key === `GET /repos/${REPO}/issues/7`) {
      return respond({ user: { login: state.author }, state: state.state, pull_request: {} });
    }
    if (key === `GET /repos/${REPO}/issues/9`) return respond({ user: { login: "someone" }, state: "open" });
    if (key === `GET /repos/${REPO}/pulls/7`) {
      return respond({
        state: state.state,
        merged: state.merged,
        draft: state.draft,
        mergeable: state.mergeable,
        mergeable_state: state.mergeableState,
        title: "add @Prior",
        html_url: `https://github.com/${REPO}/pull/7`,
        head: { sha: state.headSha, ref: "add-prior", repo: { full_name: "researcher-bot/registry" } },
        user: { login: state.author },
        merge_commit_sha: state.mergeCommitSha
      });
    }
    if (key === `GET /repos/${REPO}/pulls/7/files`) return respond(page === 1 ? state.files : []);
    if (key === `GET /repos/${REPO}/pulls/7/reviews`) return respond(page === 1 ? state.reviews : []);
    if (key.startsWith(`GET /repos/${REPO}/commits/`) && key.endsWith("/status")) return respond({ statuses: [] });
    if (key.startsWith(`GET /repos/${REPO}/commits/`) && key.endsWith("/check-runs")) {
      return respond({ total_count: state.runs.length, check_runs: page === 1 ? state.runs : [] });
    }
    if (key === `GET /repos/${REPO}/issues/7/comments`) return respond(page === 1 ? state.comments : []);
    if (key === `POST /repos/${REPO}/issues/7/comments`) {
      const body = JSON.parse(String(init?.body)) as { body: string };
      state.comments.push({ body: body.body, html_url: `https://github.com/${REPO}/pull/7#c${state.comments.length + 1}` });
      return respond({ html_url: `https://github.com/${REPO}/pull/7#c${state.comments.length}` });
    }
    if (key === `PATCH /repos/${REPO}/issues/7`) {
      state.state = (JSON.parse(String(init?.body)) as { state: "open" | "closed" }).state;
      return respond({ html_url: `https://github.com/${REPO}/pull/7` });
    }
    if (key === `POST /repos/${REPO}/pulls/7/reviews`) {
      state.reviewPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return respond({ html_url: `https://github.com/${REPO}/pull/7#r1`, id: 1 });
    }
    if (key === `PUT /repos/${REPO}/pulls/7/merge`) {
      const body = JSON.parse(String(init?.body)) as { sha: string; merge_method: string };
      state.mergePayload = body;
      if (body.sha !== state.headSha) return respond({ message: "Head branch was modified" }, 409);
      state.merged = true;
      state.state = "closed";
      state.mergeCommitSha = "merge-sha";
      return respond({ merged: true, sha: "merge-sha", message: "Pull Request successfully merged" });
    }
    if (key === "GET /user") return respond({ login: "cto-bot" });
    return new Response(`unexpected ${key}`, { status: 500 });
  }) as typeof fetch;
  return { state, fetch: fetchImpl };
}

interface GithubState {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  headSha: string;
  author: string;
  files: Array<{ filename: string; previous_filename?: string }>;
  reviews: Array<{ user: { login: string }; state: string; commit_id: string; submitted_at: string }>;
  runs: Array<{ name: string; status: string; conclusion: string | null }>;
  comments: Array<{ body: string; html_url: string }>;
  mergeCommitSha: string | null;
  calls: string[];
  fail: Record<string, "lost" | number>;
  reviewPayload?: Record<string, unknown>;
  mergePayload?: { sha: string; merge_method: string };
}

/**
 * A Durable Object runs one call at a time (its input gate holds other
 * events while a call awaits storage), which is what makes the store's
 * turns atomic. The in-memory store has no such gate, so the harness
 * serializes every call the way the DO would.
 */
function serialized(store: HoldStore): HoldStore {
  let chain: Promise<unknown> = Promise.resolve();
  return new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const run = chain.then(() => (value as (...a: unknown[]) => unknown).apply(target, args));
        chain = run.catch(() => undefined);
        return run;
      };
    }
  });
}

function harness(over: Partial<GithubState> = {}) {
  const gh = github(over);
  let n = 0;
  const holds = serialized(new HoldStore(memoryStorage(), () => `hold-${(n += 1)}`));
  const ledger: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const notes: Array<{ text: string; actions?: OperatorAction[] }> = [];
  let clock = Date.parse("2026-09-05T10:00:00Z");
  const deps: AdjudicationDeps = {
    api: { token: "pat", userAgent: "test", fetch: gh.fetch },
    holds,
    ledger: { append: async (kind, data) => void ledger.push({ kind, data }) },
    notify: async (text, actions) => void notes.push({ text, ...(actions ? { actions } : {}) }),
    now: () => new Date((clock += 1000)).toISOString(),
    sleep: async () => undefined
  };
  const identities: Identities = {
    logins: new Map([
      ["researcher-bot", "researcher"],
      ["reviewer-bot", "reviewer"],
      ["cto-bot", "cto"]
    ]),
    sharedIdentity: false
  };
  const grant = { repo: REPO, auto: ["registry/agents/**", "registry/jobs/**"], checks: ["validate"] };
  const mergeInput = { agentId: "cto", login: "cto-bot", repo: REPO, number: 7, grant, identities };
  const advance = (ms: number) => void (clock += ms);
  return { gh, holds, ledger, notes, deps, identities, grant, mergeInput, advance, kinds: () => ledger.map(row => row.kind) };
}

describe("reviewDoor (spec 0012 §5)", () => {
  it("binds the review to the head it read and ledgers it", async () => {
    const h = harness();
    const result = await reviewDoor(h.deps, {
      agentId: "reviewer",
      login: "reviewer-bot",
      repo: REPO,
      number: 7,
      verdict: "approve",
      granted: true
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "reviewed", verdict: "approve", headSha: HEAD });
    expect(h.gh.state.reviewPayload).toEqual({ event: "APPROVE", commit_id: HEAD });
    expect(h.kinds()).toEqual(["review_posted"]);
    expect(h.ledger[0].data).toMatchObject({ verdict: "approve", headSha: HEAD });
  });

  it("refuses by name and posts nothing", async () => {
    const h = harness();
    const base = { agentId: "reviewer", login: "reviewer-bot", repo: REPO, number: 7, granted: true };
    expect(await reviewDoor(h.deps, { ...base, verdict: "approve", granted: false })).toMatchObject({
      status: 403,
      body: { error: "repo_not_granted" }
    });
    expect(await reviewDoor(h.deps, { ...base, verdict: "lgtm" })).toMatchObject({ status: 400, body: { error: "invalid_verdict" } });
    expect(await reviewDoor(h.deps, { ...base, verdict: "request_changes" })).toMatchObject({
      status: 400,
      body: { error: "missing_body" }
    });
    expect(await reviewDoor(h.deps, { ...base, verdict: "approve", login: "researcher-bot" })).toMatchObject({
      status: 403,
      body: { error: "own_pr" }
    });
    expect(await reviewDoor(h.deps, { ...base, number: 9, verdict: "comment", body: "hi" })).toMatchObject({
      status: 403,
      body: { error: "not_a_pr" }
    });
    expect(h.gh.state.reviewPayload).toBeUndefined();
    expect(h.kinds().every(kind => kind === "review_denied")).toBe(true);
  });
});

describe("mergeDoor (spec 0012 §6)", () => {
  it("merges a qualifying data PR with the head pinned, an intent row and a terminal record", async () => {
    const h = harness();
    const result = await mergeDoor(h.deps, h.mergeInput);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "merged", mergeSha: "merge-sha", mode: "auto" });
    expect(h.gh.state.mergePayload).toEqual({ sha: HEAD, merge_method: "squash" });
    expect(h.kinds()).toEqual(["pr_merged"]);
    expect(h.ledger[0].data).toMatchObject({ mode: "auto", approvedBy: ["reviewer"], headSha: HEAD, mergeSha: "merge-sha" });
    expect(await h.holds.openMergeIntent(REPO, 7)).toBeUndefined();
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "merged", by: "cto", mergeSha: "merge-sha" });
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].actions).toBeUndefined();
  });

  it("refuses without a grant and refuses by the decision's name", async () => {
    const h = harness({ reviews: [] });
    expect(await mergeDoor(h.deps, { ...h.mergeInput, grant: undefined })).toMatchObject({
      status: 403,
      body: { error: "repo_not_granted" }
    });
    expect(await mergeDoor(h.deps, h.mergeInput)).toMatchObject({ status: 409, body: { error: "no_qualifying_approval" } });
    expect(h.gh.state.mergePayload).toBeUndefined();
    expect(h.kinds()).toEqual(["merge_denied", "merge_denied"]);
  });

  it("holds a code PR once, notifies with buttons, and dedupes the second call", async () => {
    const h = harness({ files: [{ filename: "registry/agents/x/agent.json" }, { filename: "site/index.ts" }] });
    const first = await mergeDoor(h.deps, h.mergeInput);
    expect(first.body).toMatchObject({ status: "held_for_approval", heldId: "hold-1", outside: ["site/index.ts"] });
    const second = await mergeDoor(h.deps, h.mergeInput);
    expect(second.body).toMatchObject({ status: "held_for_approval", heldId: "hold-1" });
    expect(h.kinds()).toEqual(["merge_held"]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].actions?.map(action => action.kind)).toEqual(["merge_approve", "merge_reject"]);
    expect(h.notes[0].text).toContain("approve the pull request there");
    expect(h.gh.state.mergePayload).toBeUndefined();
  });

  it("a lost response leaves the intent unknown, and the next call reconciles it as merged", async () => {
    const h = harness();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = "lost";
    // The merge landed on GitHub's side even though the response was lost.
    const first = await mergeDoor(h.deps, h.mergeInput);
    expect(first).toMatchObject({ status: 503, body: { error: "outcome_unknown" } });
    expect(await h.holds.openMergeIntent(REPO, 7)).toMatchObject({ state: "unknown" });
    expect(h.kinds()).toEqual(["merge_outcome_unknown"]);
    h.gh.state.merged = true;
    h.gh.state.state = "closed";
    h.gh.state.mergeCommitSha = "merge-sha";
    // Within the grace the door waits; GitHub may still be finishing the request.
    expect(await mergeDoor(h.deps, h.mergeInput)).toMatchObject({ status: 503, body: { error: "outcome_unknown" } });
    h.advance(UNKNOWN_GRACE_MS + 1000);
    const second = await mergeDoor(h.deps, h.mergeInput);
    expect(second.body).toMatchObject({ status: "merged", mergeSha: "merge-sha", reconciled: true });
    expect(h.kinds()).toEqual(["merge_outcome_unknown", "pr_merged"]);
    expect(h.ledger[1].data).toMatchObject({ reconciled: true });
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "merged" });
    // A third call finds a merged PR and refuses without a second merge.
    expect(await mergeDoor(h.deps, h.mergeInput)).toMatchObject({ status: 409, body: { error: "already_merged" } });
    expect(h.gh.state.calls.filter(call => call.startsWith("PUT"))).toHaveLength(1);
  });

  it("a lost response that never merged fails the intent and a fresh decision follows", async () => {
    const h = harness();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = "lost";
    await mergeDoor(h.deps, h.mergeInput);
    h.advance(UNKNOWN_GRACE_MS + 1000);
    const second = await mergeDoor(h.deps, h.mergeInput);
    expect(second.body).toMatchObject({ status: "merged", mode: "auto" });
    expect(h.kinds()).toEqual(["merge_outcome_unknown", "merge_failed", "pr_merged"]);
    expect(h.ledger[1].data).toMatchObject({ detail: "reconciled: not merged" });
    expect(h.gh.state.calls.filter(call => call.startsWith("PUT"))).toHaveLength(2);
  });

  it("a later head merged by someone else supersedes the intent", async () => {
    const h = harness();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = "lost";
    await mergeDoor(h.deps, h.mergeInput);
    h.gh.state.merged = true;
    h.gh.state.state = "closed";
    h.gh.state.headSha = HEAD2;
    h.advance(UNKNOWN_GRACE_MS + 1000);
    const second = await mergeDoor(h.deps, h.mergeInput);
    expect(second).toMatchObject({ status: 409, body: { error: "already_merged" } });
    expect(h.kinds()).toEqual(["merge_outcome_unknown", "merge_superseded", "merge_denied"]);
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "superseded", by: "unknown", agentId: "cto" });
  });

  it("GitHub saying no is a failed intent, not an unknown one", async () => {
    const h = harness();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = 405;
    expect(await mergeDoor(h.deps, h.mergeInput)).toMatchObject({ status: 502, body: { error: "merge_failed" } });
    expect(await h.holds.openMergeIntent(REPO, 7)).toBeUndefined();
    expect(h.kinds()).toEqual(["merge_failed"]);
  });

  it("stays unknown while GitHub is unreachable during reconciliation", async () => {
    const h = harness();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = "lost";
    await mergeDoor(h.deps, h.mergeInput);
    h.advance(UNKNOWN_GRACE_MS + 1000);
    h.gh.state.fail[`GET /repos/${REPO}/pulls/7`] = "lost";
    expect(await mergeDoor(h.deps, h.mergeInput)).toMatchObject({ status: 503, body: { error: "outcome_unknown" } });
    expect(await h.holds.openMergeIntent(REPO, 7)).toMatchObject({ state: "unknown" });
  });

  it("a pending intent still in flight answers in progress; a stale one is reconciled", async () => {
    const h = harness();
    await h.holds.beginMerge({ repo: REPO, number: 7, headSha: HEAD, agentId: "cto", mode: "auto", at: h.deps.now() });
    expect(await mergeDoor(h.deps, h.mergeInput)).toMatchObject({ status: 409, body: { error: "merge_in_progress" } });
    expect(h.gh.state.mergePayload).toBeUndefined();
    // Nobody resolved it: the door that made it crashed. Past the stale
    // bound plus the grace (its request, aborted at the bound, is over on
    // GitHub's side too) it is reconciled (not merged) and a fresh
    // decision follows. Before that the door still waits.
    h.advance(INTENT_STALE_MS + 1000);
    expect(await mergeDoor(h.deps, h.mergeInput)).toMatchObject({ status: 503, body: { error: "outcome_unknown" } });
    h.advance(UNKNOWN_GRACE_MS + 1000);
    expect((await mergeDoor(h.deps, h.mergeInput)).body).toMatchObject({ status: "merged" });
    expect(h.kinds()).toEqual(["merge_denied", "merge_failed", "pr_merged"]);
  });

  it("an executor whose intent aged past the bound never calls GitHub", async () => {
    const h = harness();
    const holds = h.holds;
    const slowBegin: typeof holds.beginMerge = async input => {
      const begun = await holds.beginMerge(input);
      if (begun.created) await holds.resolveMerge(begun.intent.id, { state: "unknown" }, input.at);
      // The intent is on record, then the executor stalls past the bound.
      h.advance(INTENT_STALE_MS + 1000);
      return begun.created ? { created: true, intent: { ...begun.intent, state: "pending" } } : begun;
    };
    const deps = { ...h.deps, holds: new Proxy(holds, { get: (target, key) => (key === "beginMerge" ? slowBegin : Reflect.get(target, key)) }) };
    expect(await mergeDoor(deps, h.mergeInput)).toMatchObject({ status: 409, body: { error: "executor_stale" } });
    expect(h.gh.state.mergePayload).toBeUndefined();
    expect(h.kinds()).toEqual(["merge_failed"]);
  });

  it("a head the operator rejected never holds again", async () => {
    const h = harness({ files: [{ filename: "site/index.ts" }] });
    await h.holds.recordTerminal({ repo: REPO, number: 7, headSha: HEAD, outcome: "rejected", at: "2026-09-05T09:00:00Z", by: "operator", reason: "not now" });
    const result = await mergeDoor(h.deps, h.mergeInput);
    expect(result).toMatchObject({ status: 409, body: { error: "rejected_by_operator", reason: "not now", headSha: HEAD } });
    expect(await h.holds.listHeld()).toEqual([]);
    expect(h.notes).toEqual([]);
    // A new push is a new head and holds normally.
    h.gh.state.headSha = HEAD2;
    h.gh.state.reviews = [{ user: { login: "reviewer-bot" }, state: "APPROVED", commit_id: HEAD2, submitted_at: "2026-09-05T11:00:00Z" }];
    expect((await mergeDoor(h.deps, h.mergeInput)).body).toMatchObject({ status: "held_for_approval", headSha: HEAD2 });
  });
});

describe("the operator's surface (spec 0012 §8)", () => {
  async function held(over: Partial<GithubState> = {}) {
    const h = harness({ files: [{ filename: "site/index.ts" }], ...over });
    const result = await mergeDoor(h.deps, h.mergeInput);
    expect(result.body).toMatchObject({ status: "held_for_approval", heldId: "hold-1" });
    const operatorDeps = { holds: h.holds, ledger: h.deps.ledger, notify: h.deps.notify, now: h.deps.now, sleep: h.deps.sleep };
    const approve = () =>
      approveHeld(operatorDeps, {
        heldId: "hold-1",
        grantFor: (agentId, repo) => (agentId === "cto" && repo === REPO ? h.grant : undefined),
        apiFor: agentId => (agentId === "cto" ? h.deps.api : undefined),
        loginFor: async agentId => (agentId === "cto" ? "cto-bot" : undefined),
        identities: h.identities
      });
    const reject = (reason?: string) =>
      rejectHeld(operatorDeps, { heldId: "hold-1", ...(reason !== undefined ? { reason } : {}), apiFor: () => h.deps.api });
    return { h, approve, reject, operatorDeps };
  }

  it("approves the held head, merges it as the operator's decision, and removes the hold", async () => {
    const { h, approve, operatorDeps } = await held();
    const result = await approve();
    expect(result.body).toMatchObject({ status: "merged", mode: "operator", mergeSha: "merge-sha" });
    expect(h.gh.state.mergePayload).toEqual({ sha: HEAD, merge_method: "squash" });
    expect(h.kinds()).toEqual(["merge_held", "pr_merged"]);
    expect(h.ledger[1].data).toMatchObject({ mode: "operator", heldId: "hold-1" });
    expect(await h.holds.listHeld()).toEqual([]);
    expect((await listHeld(operatorDeps, () => undefined)).body).toMatchObject({
      held: [],
      terminals: [expect.objectContaining({ outcome: "merged" })]
    });
    // A refusal about a decided hold still names the agent and the PR it concerned.
    expect(await approve()).toMatchObject({ status: 409, body: { error: "held_unavailable", agentId: "cto", repo: REPO, number: 7 } });
  });

  it("a refusal over a live hold names the agent and the pull request it concerns", async () => {
    const { h, approve, reject } = await held();
    await h.holds.claimHeld("hold-1", h.deps.now());
    expect(await approve()).toMatchObject({ status: 409, body: { error: "held_unavailable", agentId: "cto", repo: REPO, number: 7 } });
    expect(await reject("no")).toMatchObject({ status: 409, body: { error: "approval_in_flight", agentId: "cto", repo: REPO, number: 7 } });
  });

  it("an approval whose response was lost is reconciled by the held listing, and the hold is cleared", async () => {
    const { h, approve, operatorDeps } = await held();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = "lost";
    expect(await approve()).toMatchObject({ status: 503, body: { error: "outcome_unknown" } });
    // The hold stays claimed and the intent unknown until GitHub is read.
    expect((await h.holds.listHeld())[0]).toMatchObject({ id: "hold-1", claimed: true });
    h.gh.state.merged = true;
    h.gh.state.state = "closed";
    h.gh.state.mergeCommitSha = "merge-sha";
    h.advance(UNKNOWN_GRACE_MS + 1000);
    const listing = await listHeld(operatorDeps, () => h.deps.api);
    expect(listing.body).toMatchObject({ held: [], unknown: [], reconciled: 1 });
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "merged", heldId: "hold-1" });
    expect(h.kinds()).toEqual(["merge_held", "merge_outcome_unknown", "pr_merged"]);
    expect(h.ledger[2].data).toMatchObject({ mode: "operator", heldId: "hold-1", reconciled: true });
  });

  it("an approval whose response was lost but never merged gives the hold back", async () => {
    const { h, approve, operatorDeps } = await held();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = "lost";
    await approve();
    h.advance(UNKNOWN_GRACE_MS + 1000);
    const listing = await listHeld(operatorDeps, () => h.deps.api);
    expect(listing.body).toMatchObject({ held: [expect.objectContaining({ id: "hold-1", claimed: false })], reconciled: 1 });
    expect((await approve()).body).toMatchObject({ status: "merged" });
  });

  it("an approval that loses the intent race gives its hold back, and the winner's merge clears it", async () => {
    const { h, approve } = await held();
    // A concurrent merge call already holds the intent for this head.
    const { intent } = await h.holds.beginMerge({ repo: REPO, number: 7, headSha: HEAD, agentId: "cto", mode: "auto", at: h.deps.now() });
    expect(await approve()).toMatchObject({ status: 409, body: { error: "merge_in_progress" } });
    expect((await h.holds.listHeld())[0]).toMatchObject({ id: "hold-1", claimed: false });
    // The winner settles as merged: the hold for that head is gone too.
    await h.holds.settleMerge(intent.id, { state: "merged", mergeSha: "m" }, h.deps.now(), {
      terminal: { repo: REPO, number: 7, headSha: HEAD, outcome: "merged", at: h.deps.now(), by: "cto", mergeSha: "m" },
      hold: "delete"
    });
    expect(await h.holds.listHeld()).toEqual([]);
  });

  it("refuses a hold whose head moved and invalidates it", async () => {
    const { h, approve } = await held();
    h.gh.state.headSha = HEAD2;
    expect(await approve()).toMatchObject({ status: 409, body: { error: "head_moved", agentId: "cto", repo: REPO, number: 7 } });
    expect(await h.holds.listHeld()).toEqual([]);
    expect(h.kinds()).toEqual(["merge_held", "merge_hold_invalidated"]);
    // The held head's record survives the hold: a late answer about it still names the agent.
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "superseded", agentId: "cto", heldId: "hold-1" });
    expect(await approve()).toMatchObject({ status: 409, body: { error: "held_unavailable", agentId: "cto", repo: REPO, number: 7 } });
    expect(h.gh.state.mergePayload).toBeUndefined();
  });

  it("re-checks the preconditions and names branch protection when GitHub blocks", async () => {
    const { h, approve } = await held();
    h.gh.state.mergeableState = "blocked";
    expect(await approve()).toMatchObject({
      status: 409,
      body: { error: "no_longer_qualifies", detail: expect.stringContaining("blocked_by_branch_protection") }
    });
    // The hold is given back for a retry once the operator has approved on GitHub.
    expect((await h.holds.listHeld())[0]).toMatchObject({ id: "hold-1", claimed: false });
    h.gh.state.mergeableState = "clean";
    h.gh.state.runs = [{ name: "validate", status: "in_progress", conclusion: null }];
    expect(await approve()).toMatchObject({ body: { detail: expect.stringContaining("checks_not_green") } });
    h.gh.state.runs = [{ name: "validate", status: "completed", conclusion: "success" }];
    expect((await approve()).body).toMatchObject({ status: "merged" });
  });

  it("refuses to reject under a young claim, and rejects once it is stale and unmerged", async () => {
    const { h, reject } = await held();
    await h.holds.claimHeld("hold-1", h.deps.now());
    expect(await reject("no")).toMatchObject({ status: 409, body: { error: "approval_in_flight" } });
    h.advance(CLAIM_AGE_MS + 1000);
    expect((await reject("no")).body).toMatchObject({ status: "rejected", heldId: "hold-1" });
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "rejected", reason: "no", by: "operator" });
    expect(h.kinds()).toEqual(["merge_held", "merge_rejected"]);
    // A retry of a lost rejection answers rejected without a second ledger row.
    expect((await reject("no")).body).toMatchObject({ status: "rejected", repeated: true, agentId: "cto", repo: REPO, number: 7 });
    expect(h.kinds()).toEqual(["merge_held", "merge_rejected"]);
  });

  it("a rejection under a stale claim fences the slow approval out of GitHub", async () => {
    const { h, approve, reject } = await held();
    // The approval claims, then stalls before beginning its intent (a
    // slow snapshot); the operator rejects under the stale claim.
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const originalFetch = h.deps.api.fetch as typeof fetch;
    h.deps.api.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/pulls/7/reviews")) await gate;
      return originalFetch(input, init);
    }) as typeof fetch;
    const approval = approve();
    await new Promise(resolve => setTimeout(resolve, 10));
    h.advance(CLAIM_AGE_MS + 1000);
    expect((await reject("changed my mind")).body).toMatchObject({ status: "rejected" });
    release();
    expect(await approval).toMatchObject({ status: 409, body: { error: "hold_gone" } });
    expect(h.gh.state.mergePayload).toBeUndefined();
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "rejected" });
    expect(h.kinds()).toEqual(["merge_held", "merge_rejected", "merge_denied"]);
  });

  it("a rejection under a stale claim yields to an intent that is in flight", async () => {
    const { h, reject } = await held();
    const claimed = await h.holds.claimHeld("hold-1", h.deps.now());
    h.advance(CLAIM_AGE_MS + 1000);
    await h.holds.beginMerge({ repo: REPO, number: 7, headSha: HEAD, agentId: "cto", mode: "operator", heldId: "hold-1", claimToken: claimed?.claimToken, at: h.deps.now() });
    expect(await reject()).toMatchObject({ status: 409, body: { error: "approval_in_flight" } });
  });

  it("a rejection never lands over an unknown intent it cannot reconcile", async () => {
    const { h, approve, operatorDeps } = await held();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = "lost";
    await approve();
    h.advance(CLAIM_AGE_MS + 1000);
    // No credential for the agent: the intent cannot be reconciled, so the hold stays.
    const noApi = await rejectHeld(operatorDeps, { heldId: "hold-1", apiFor: () => undefined });
    expect(noApi).toMatchObject({ status: 503, body: { error: "outcome_unknown" } });
    expect(await h.holds.getHeld("hold-1")).toBeDefined();
    // With one, the intent reconciles (not merged) and the rejection lands.
    const withApi = await rejectHeld(operatorDeps, { heldId: "hold-1", reason: "no", apiFor: () => h.deps.api });
    expect(withApi.body).toMatchObject({ status: "rejected" });
  });

  it("two reconciliations of one intent settle once: one ledger row, the loser reports the winner's result", async () => {
    const h = harness();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = "lost";
    await mergeDoor(h.deps, h.mergeInput);
    h.gh.state.merged = true;
    h.gh.state.state = "closed";
    h.gh.state.mergeCommitSha = "merge-sha";
    h.advance(UNKNOWN_GRACE_MS + 1000);
    const open = (await h.holds.openMergeIntent(REPO, 7))!;
    const [a, b] = await Promise.all([reconcileIntent(h.deps, open), reconcileIntent(h.deps, open)]);
    expect(a).toMatchObject({ state: "merged", mergeSha: "merge-sha" });
    expect(b).toMatchObject({ state: "merged", mergeSha: "merge-sha" });
    expect(h.kinds().filter(kind => kind === "pr_merged")).toHaveLength(1);
  });

  it("a merge that lands after a rejection corrects the record and names the anomaly", async () => {
    const { h, approve, operatorDeps } = await held();
    h.gh.state.fail[`PUT /repos/${REPO}/pulls/7/merge`] = "lost";
    await approve();
    h.advance(CLAIM_AGE_MS + UNKNOWN_GRACE_MS + 1000);
    // Reconciled as not merged, then rejected.
    expect((await rejectHeld(operatorDeps, { heldId: "hold-1", reason: "no", apiFor: () => h.deps.api })).body).toMatchObject({ status: "rejected" });
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "rejected" });
    // The impossible: GitHub finishes the request anyway. The next
    // reconciliation (a new attempt's intent, or the listing) records
    // the merge and the anomaly.
    h.gh.state.merged = true;
    h.gh.state.state = "closed";
    h.gh.state.mergeCommitSha = "merge-sha";
    await h.holds.beginMerge({ repo: REPO, number: 7, headSha: HEAD, agentId: "cto", mode: "auto", at: h.deps.now() });
    const open = await h.holds.openMergeIntent(REPO, 7);
    await h.holds.resolveMerge(open!.id, { state: "unknown", detail: "test" }, h.deps.now());
    h.advance(UNKNOWN_GRACE_MS + 1000);
    await listHeld(operatorDeps, () => h.deps.api);
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "merged", mergeSha: "merge-sha" });
    expect(h.kinds()).toContain("merge_after_rejection");
  });

  it("a stale claim whose approval merged concedes", async () => {
    const { h, reject } = await held();
    await h.holds.claimHeld("hold-1", h.deps.now());
    h.advance(CLAIM_AGE_MS + 1000);
    h.gh.state.merged = true;
    expect(await reject()).toMatchObject({ status: 409, body: { error: "already_merged", agentId: "cto", repo: REPO, number: 7 } });
    // The merged head's record outlives the hold: a retry still names the agent.
    expect(await h.holds.terminal(REPO, 7, HEAD)).toMatchObject({ outcome: "merged", agentId: "cto", heldId: "hold-1" });
    expect(await reject()).toMatchObject({ status: 409, body: { error: "already_merged", agentId: "cto", repo: REPO, number: 7 } });
    expect(await h.holds.listHeld()).toEqual([]);
  });

  it("rejecting an unknown hold is not found", async () => {
    const { reject } = await held();
    const h2 = harness();
    expect(await rejectHeld({ holds: h2.holds, ledger: h2.deps.ledger, notify: h2.deps.notify, now: h2.deps.now }, { heldId: "nope", apiFor: () => undefined })).toMatchObject({
      status: 404
    });
    expect((await reject()).status).toBe(200);
  });
});

describe("closeDoor (spec 0012 §7)", () => {
  const input = { agentId: "cto", repo: REPO, number: 7, reason: "spam: unrelated content", granted: true };

  it("posts the reason once with a marker, closes, and ledgers", async () => {
    const h = harness();
    const result = await closeDoor(h.deps, input);
    expect(result.body).toMatchObject({ status: "closed" });
    expect(h.gh.state.comments).toHaveLength(1);
    expect(h.gh.state.comments[0].body).toContain(closeMarker("hold-1"));
    expect(h.gh.state.state).toBe("closed");
    expect(h.kinds()).toEqual(["pr_closed"]);
    expect(await h.holds.openCloseIntent(REPO, 7)).toBeUndefined();
  });

  it("a second close call while the first works answers in progress", async () => {
    const h = harness();
    const begun = await h.holds.beginClose({ repo: REPO, number: 7, agentId: "cto", reason: input.reason, at: h.deps.now() });
    expect(begun.status).toBe("created");
    expect(await closeDoor(h.deps, input)).toMatchObject({ status: 409, body: { error: "close_in_progress" } });
    expect(h.gh.state.comments).toEqual([]);
  });

  it("refuses by name", async () => {
    const h = harness();
    expect(await closeDoor(h.deps, { ...input, granted: false })).toMatchObject({ status: 403, body: { error: "repo_not_granted" } });
    expect(await closeDoor(h.deps, { ...input, reason: " " })).toMatchObject({ status: 400, body: { error: "missing_reason" } });
    expect(await closeDoor(h.deps, { ...input, number: 9 })).toMatchObject({ status: 409, body: { error: "not_a_pr" } });
    h.gh.state.state = "closed";
    expect(await closeDoor(h.deps, input)).toMatchObject({ status: 409, body: { error: "already_closed" } });
    expect(h.gh.state.comments).toEqual([]);
  });

  it("a retry after a lost close resumes from the marker and never posts the reason twice", async () => {
    const h = harness();
    // The comment lands, then the PATCH is lost.
    h.gh.state.fail[`PATCH /repos/${REPO}/issues/7`] = "lost";
    expect(await closeDoor(h.deps, input)).toMatchObject({
      status: 503,
      body: { error: "outcome_unknown", steps: { commented: true } }
    });
    expect(h.gh.state.comments).toHaveLength(1);
    expect(await h.holds.openCloseIntent(REPO, 7)).toMatchObject({ steps: { commented: true } });
    // Too soon: the lost request may still be finishing.
    expect(await closeDoor(h.deps, input)).toMatchObject({ status: 409, body: { error: "close_in_progress" } });
    h.advance(UNKNOWN_GRACE_MS + 1000);
    const retry = await closeDoor(h.deps, input);
    expect(retry.body).toMatchObject({ status: "closed" });
    expect(h.gh.state.comments).toHaveLength(1);
    expect(h.gh.state.state).toBe("closed");
    expect(h.kinds()).toEqual(["close_outcome_unknown", "pr_closed"]);
    expect(h.ledger[1].data).toMatchObject({ resumed: true });
  });

  it("GitHub refusing the close ends the intent as failed", async () => {
    const h = harness();
    h.gh.state.fail[`PATCH /repos/${REPO}/issues/7`] = 422;
    expect(await closeDoor(h.deps, input)).toMatchObject({ status: 502, body: { error: "close_failed" } });
    expect(await h.holds.openCloseIntent(REPO, 7)).toBeUndefined();
    expect(h.kinds()).toEqual(["close_failed"]);
  });

  it("a lost comment response is found by its marker on retry", async () => {
    const h = harness();
    // The comment was posted but the response never arrived: simulate by
    // recording the marker on GitHub's side before the retry.
    const { intent } = await h.holds.beginClose({ repo: REPO, number: 7, agentId: "cto", reason: input.reason, at: h.deps.now() });
    await h.holds.releaseClose(intent.id, intent.workToken, h.deps.now());
    h.advance(UNKNOWN_GRACE_MS + 1000);
    h.gh.state.comments.push({ body: `${input.reason}\n\n${closeMarker(intent.id)}`, html_url: "https://github.com/org/registry/pull/7#c0" });
    expect((await closeDoor(h.deps, input)).body).toMatchObject({ status: "closed", commentUrl: "https://github.com/org/registry/pull/7#c0" });
    expect(h.gh.state.comments).toHaveLength(1);
  });
});

describe("resolveIdentities (spec 0012 §4)", () => {
  it("maps logins to agents and flags a shared credential", async () => {
    const shared = await resolveIdentities([
      { agentId: "a", login: async () => "bot" },
      { agentId: "b", login: async () => "bot" },
      { agentId: "c", login: async () => "other" },
      { agentId: "d", login: async () => { throw new Error("401"); } }
    ]);
    expect(shared.sharedIdentity).toBe(true);
    expect([...shared.logins.keys()]).toEqual(["bot", "other"]);
    const own = await resolveIdentities([
      { agentId: "a", login: async () => "a-bot" },
      { agentId: "b", login: async () => "b-bot" }
    ]);
    expect(own).toEqual({ logins: new Map([["a-bot", "a"], ["b-bot", "b"]]), sharedIdentity: false });
  });
});
