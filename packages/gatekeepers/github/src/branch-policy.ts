/**
 * Every rule the branch door enforces, in one place (spec 0008 §6).
 *
 * Kept out of the Worker so the rules can be read and tested without a
 * runtime: what bounds this door is decided BEFORE a token exists, and
 * a reader should be able to see all of it at once.
 */

export interface BranchRequest {
  /** The agent's github.write grant; absent or empty grants nothing. */
  granted: string[];
  repo: unknown;
  branch: unknown;
  /**
   * The repo's default branch, once GitHub has told us. Omitted on the
   * pre-network pass, where the grant is checked before any call.
   */
  defaultBranch?: string;
}

export type BranchDecision =
  | { ok: false; status: number; code: string; detail: string }
  /** Validated by the same pass that could have refused them. */
  | { ok: true; repo: string; branch: string };

/** Branch names GitHub accepts and a ref path cannot be confused by. */
const BRANCH = /^(?!\.)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,240}$/;

export function branchDecision(input: BranchRequest, agentId: string): BranchDecision {
  const { granted, repo, branch, defaultBranch } = input;
  if (typeof repo !== "string" || !granted.includes(repo)) {
    return {
      ok: false,
      status: 403,
      code: "write_not_granted",
      detail: `granted to ${agentId}: ${granted.join(", ") || "nothing"}`
    };
  }
  if (typeof branch !== "string" || !BRANCH.test(branch) || branch.endsWith("/")) {
    return { ok: false, status: 400, code: "invalid_branch", detail: String(branch) };
  }
  // The merge gate: this door never touches the branch the repo merges
  // into. Review happens on a pull request, as it always has.
  if (defaultBranch !== undefined && branch === defaultBranch) {
    return {
      ok: false,
      status: 403,
      code: "default_branch_protected",
      detail: `${branch} is ${repo}'s default branch; open a pull request instead`
    };
  }
  return { ok: true, repo, branch };
}
