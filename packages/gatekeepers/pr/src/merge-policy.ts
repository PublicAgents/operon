/**
 * Adjudication policy (spec 0012 §5, §6): pure functions over what the
 * Gatekeeper read from GitHub. Nothing here touches the network or the
 * caller's claims; the snapshot is the evidence, the grant is the rule,
 * and every refusal has a name a test can assert.
 */

export interface SnapshotReview {
  login: string;
  /** GitHub's review state: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
  state: string;
  /** The head the review was submitted against. */
  commitId: string;
  submittedAt: string;
}

export interface SnapshotFile {
  filename: string;
  /** Present for renames: the path the file came from. */
  previousFilename?: string;
  /** GitHub's change status: added, removed, modified, renamed, copied, changed, unchanged. */
  status?: string;
}

export interface SnapshotChecks {
  /** Commit statuses on the head (the older API). */
  statuses: Array<{ context: string; state: string }>;
  /** Check runs on the head (what GitHub Actions reports). */
  runs: Array<{ name: string; status: string; conclusion: string | null }>;
}

export interface PrSnapshot {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** GitHub computes this lazily; null means "not yet". */
  mergeable: boolean | null;
  /** clean, behind, blocked, dirty, unstable, unknown, has_hooks, draft. */
  mergeableState: string;
  headSha: string;
  author: string;
  files: SnapshotFile[];
  /** True when the file listing hit GitHub's cap and may be missing paths. */
  filesTruncated: boolean;
  reviews: SnapshotReview[];
  checks: SnapshotChecks;
}

export interface MergeContext {
  mergerAgentId: string;
  mergerLogin: string;
  /** login -> roster id. A login that resolves to two agents is a shared credential. */
  logins: ReadonlyMap<string, string>;
  /** True when two roster agents resolved to the same login (spec 0012 §4). */
  sharedIdentity: boolean;
  /** Path globs that may merge without the operator; empty means everything is held. */
  auto: readonly string[];
  /** Check runs that must exist and be green by name; empty means "every run present, at least one". */
  checks: readonly string[];
}

export type MergeRefusal =
  | "not_open"
  | "already_merged"
  | "draft"
  | "author_is_merger"
  | "mergeability_unknown"
  | "not_mergeable"
  | "files_incomplete"
  | "no_checks"
  | "required_check_missing"
  | "checks_not_green"
  | "changes_requested"
  | "self_approval"
  | "shared_identity"
  | "no_qualifying_approval";

export type MergeVerdict =
  | { kind: "auto"; approvedBy: string[] }
  | { kind: "hold"; reason: "outside_auto_paths"; outside: string[]; approvedBy: string[] }
  | { kind: "refuse"; reason: MergeRefusal; detail?: string };

const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * A path glob with two forms of wildcard and nothing else: `**` spans
 * any number of segments (including none), `*` matches within one
 * segment. Everything else is literal. Zero dependencies on purpose:
 * the rule must be readable in one screen.
 */
export function matchPathGlob(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/").filter(part => part.length > 0);
  const pathParts = path.split("/").filter(part => part.length > 0);
  return matchParts(patternParts, 0, pathParts, 0);
}

function matchParts(pattern: string[], pi: number, path: string[], si: number): boolean {
  if (pi === pattern.length) return si === path.length;
  const part = pattern[pi];
  if (part === "**") {
    // Zero or more segments: try every split, shortest first.
    for (let skip = si; skip <= path.length; skip += 1) {
      if (matchParts(pattern, pi + 1, path, skip)) return true;
    }
    return false;
  }
  if (si === path.length) return false;
  return matchSegment(part, path[si]) && matchParts(pattern, pi + 1, path, si + 1);
}

function matchSegment(pattern: string, segment: string): boolean {
  if (!pattern.includes("*")) return pattern === segment;
  const pieces = pattern.split("*");
  let cursor = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    if (i === 0) {
      if (!segment.startsWith(piece)) return false;
      cursor = piece.length;
      continue;
    }
    if (i === pieces.length - 1) {
      return piece.length === 0 ? true : segment.endsWith(piece) && segment.length - piece.length >= cursor;
    }
    const at = segment.indexOf(piece, cursor);
    if (at < 0) return false;
    cursor = at + piece.length;
  }
  return true;
}

/** Every path a change touches, both sides of a rename included (spec 0012 §6). */
export function touchedPaths(files: readonly SnapshotFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    out.push(file.filename);
    if (file.previousFilename !== undefined) out.push(file.previousFilename);
  }
  return out;
}

/** The latest non-dismissed review per login, submission order preserved. */
function latestReviews(reviews: readonly SnapshotReview[]): Map<string, SnapshotReview> {
  const sorted = [...reviews]
    .filter(review => review.state !== "DISMISSED" && review.state !== "PENDING")
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const latest = new Map<string, SnapshotReview>();
  for (const review of sorted) {
    // COMMENTED never replaces a verdict: a follow-up comment after an
    // approval is still an approval on GitHub's side.
    if (review.state === "COMMENTED" && latest.has(review.login)) continue;
    latest.set(review.login, review);
  }
  return latest;
}

/**
 * The decision, first failure wins, in the order spec 0012 §6 lists.
 * Returns `auto` when every touched path matches an auto glob, `hold`
 * with the outside paths otherwise, and a named refusal before either
 * when the pull request does not qualify at all.
 */
/**
 * The state and checks half of the decision (spec 0012 §6), before any
 * review or path rule: what an operator's approval re-applies at claim
 * time, because the review rule and the path rule are what the operator
 * is deciding. Undefined means the pull request passes this half.
 */
export function mergePreconditions(
  pr: PrSnapshot,
  ctx: Pick<MergeContext, "mergerLogin" | "checks" | "sharedIdentity">
): { reason: MergeRefusal; detail?: string } | undefined {
  const refuse = (reason: MergeRefusal, detail?: string) => ({ reason, ...(detail !== undefined ? { detail } : {}) });
  if (pr.merged) return refuse("already_merged");
  if (pr.state !== "open") return refuse("not_open");
  if (pr.draft) return refuse("draft");
  if (pr.author === ctx.mergerLogin) return refuse("author_is_merger");
  if (pr.mergeable === null) return refuse("mergeability_unknown");
  if (pr.mergeable === false || pr.mergeableState !== "clean") {
    return refuse("not_mergeable", `mergeable_state: ${pr.mergeableState}`);
  }
  if (pr.filesTruncated) return refuse("files_incomplete", "the file listing reached GitHub's cap");

  const { statuses, runs } = pr.checks;
  if (statuses.length === 0 && runs.length === 0) return refuse("no_checks");
  for (const name of ctx.checks) {
    if (!runs.some(run => run.name === name)) return refuse("required_check_missing", name);
  }
  const redStatus = statuses.find(status => status.state !== "success");
  if (redStatus) return refuse("checks_not_green", `status ${redStatus.context}: ${redStatus.state}`);
  const redRun = runs.find(
    run => run.status !== "completed" || run.conclusion === null || !GREEN_CONCLUSIONS.has(run.conclusion)
  );
  if (redRun) {
    return refuse("checks_not_green", `check ${redRun.name}: ${redRun.status}/${redRun.conclusion ?? "none"}`);
  }
  if (ctx.sharedIdentity) return refuse("shared_identity");
  return undefined;
}

export function mergeDecision(pr: PrSnapshot, ctx: MergeContext): MergeVerdict {
  const refuse = (reason: MergeRefusal, detail?: string): MergeVerdict => ({
    kind: "refuse",
    reason,
    ...(detail !== undefined ? { detail } : {})
  });

  const precondition = mergePreconditions(pr, ctx);
  if (precondition) return refuse(precondition.reason, precondition.detail);

  const latest = latestReviews(pr.reviews);
  const discarded: string[] = [];
  const approvedBy: string[] = [];
  let authorApproved = false;
  for (const [login, review] of latest) {
    const agentId = ctx.logins.get(login);
    if (review.state === "CHANGES_REQUESTED") {
      if (agentId !== undefined) return refuse("changes_requested", `${agentId} (${login})`);
      continue;
    }
    if (review.state !== "APPROVED") continue;
    if (login === pr.author) {
      authorApproved = true;
      discarded.push(`${login}: the author`);
      continue;
    }
    if (agentId === undefined) {
      discarded.push(`${login}: not a roster agent`);
      continue;
    }
    if (agentId === ctx.mergerAgentId) {
      discarded.push(`${login}: the merger`);
      continue;
    }
    if (review.commitId !== pr.headSha) {
      discarded.push(`${login}: approved ${review.commitId.slice(0, 7)}, head is ${pr.headSha.slice(0, 7)}`);
      continue;
    }
    approvedBy.push(agentId);
  }
  if (approvedBy.length === 0) {
    if (authorApproved && discarded.length === 1) return refuse("self_approval");
    return refuse("no_qualifying_approval", discarded.length > 0 ? discarded.join("; ") : "no approvals");
  }

  // A deletion is never a data change (spec 0012 §6): a removed file
  // is outside the auto globs whatever its path, and a rename's old
  // side is a removal. The registry classifies the same way.
  const outside = [
    ...new Set([
      ...touchedPaths(pr.files).filter(path => !ctx.auto.some(glob => matchPathGlob(glob, path))),
      ...pr.files.filter(file => file.status === "removed").map(file => `${file.filename} (deleted)`),
      ...pr.files.filter(file => file.previousFilename !== undefined).map(file => `${file.previousFilename} (deleted)`)
    ])
  ];
  if (outside.length > 0) {
    return { kind: "hold", reason: "outside_auto_paths", outside, approvedBy };
  }
  return { kind: "auto", approvedBy };
}

export type ReviewVerdict = "approve" | "request_changes" | "comment";

export type ReviewRefusal = "repo_not_granted" | "not_a_pr" | "invalid_verdict" | "missing_body" | "own_pr";

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return value === "approve" || value === "request_changes" || value === "comment";
}

/**
 * Whether a review may be posted (spec 0012 §5). `own_pr` refuses every
 * verdict: a self "request changes" is theatre and a self-approval is
 * the thing the spec forbids.
 */
export function reviewDecision(input: {
  verdict: unknown;
  body: string | undefined;
  isPullRequest: boolean;
  prAuthor: string;
  login: string;
  granted: boolean;
}): { ok: true; verdict: ReviewVerdict } | { ok: false; reason: ReviewRefusal } {
  if (!input.granted) return { ok: false, reason: "repo_not_granted" };
  if (!isReviewVerdict(input.verdict)) return { ok: false, reason: "invalid_verdict" };
  if (!input.isPullRequest) return { ok: false, reason: "not_a_pr" };
  if (input.verdict !== "approve" && (input.body === undefined || input.body.trim().length === 0)) {
    return { ok: false, reason: "missing_body" };
  }
  if (input.login === input.prAuthor) return { ok: false, reason: "own_pr" };
  return { ok: true, verdict: input.verdict };
}
