import { describe, expect, it } from "vitest";
import {
  matchPathGlob,
  mergeDecision,
  reviewDecision,
  touchedPaths,
  type MergeContext,
  type PrSnapshot
} from "./merge-policy.js";

const HEAD = "head000000000000000000000000000000000000";
const OLD = "old0000000000000000000000000000000000000";

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    mergeableState: "clean",
    headSha: HEAD,
    author: "author-bot",
    files: [{ filename: "registry/agents/prior/agent.json" }],
    filesTruncated: false,
    reviews: [{ login: "reviewer-bot", state: "APPROVED", commitId: HEAD, submittedAt: "2026-09-05T10:00:00Z" }],
    checks: {
      statuses: [],
      runs: [
        { name: "validate", status: "completed", conclusion: "success" },
        { name: "build", status: "completed", conclusion: "success" }
      ]
    },
    ...over
  };
}

function context(over: Partial<MergeContext> = {}): MergeContext {
  return {
    mergerAgentId: "cto",
    mergerLogin: "cto-bot",
    logins: new Map([
      ["author-bot", "researcher"],
      ["reviewer-bot", "reviewer"],
      ["cto-bot", "cto"]
    ]),
    sharedIdentity: false,
    auto: ["registry/agents/**", "registry/tools/**", "registry/jobs/**", "registry/evidence/**"],
    checks: ["validate", "build"],
    ...over
  };
}

describe("matchPathGlob", () => {
  it("spans segments with ** and stays inside one with *", () => {
    expect(matchPathGlob("registry/agents/**", "registry/agents/prior/agent.json")).toBe(true);
    expect(matchPathGlob("registry/agents/**", "registry/agents/x")).toBe(true);
    expect(matchPathGlob("registry/agents/**", "registry/agents")).toBe(true);
    expect(matchPathGlob("registry/agents/**", "registry/tools/x")).toBe(false);
    expect(matchPathGlob("registry/*/agent.json", "registry/prior/agent.json")).toBe(true);
    expect(matchPathGlob("registry/*/agent.json", "registry/a/b/agent.json")).toBe(false);
    expect(matchPathGlob("*.md", "README.md")).toBe(true);
    expect(matchPathGlob("*.md", "docs/README.md")).toBe(false);
    expect(matchPathGlob("**/*.json", "a/b/c.json")).toBe(true);
    expect(matchPathGlob("registry/**", "registry")).toBe(true);
    expect(matchPathGlob("registry/**", "registryx/a")).toBe(false);
    expect(matchPathGlob("a*b", "ab")).toBe(true);
    expect(matchPathGlob("a*b", "axxb")).toBe(true);
    expect(matchPathGlob("a*b", "axxc")).toBe(false);
  });
});

describe("touchedPaths", () => {
  it("counts both sides of a rename", () => {
    expect(
      touchedPaths([
        { filename: "registry/agents/x/agent.json", previousFilename: "site/index.ts" },
        { filename: "registry/jobs/cs/a.json" }
      ])
    ).toEqual(["registry/agents/x/agent.json", "site/index.ts", "registry/jobs/cs/a.json"]);
  });
});

describe("mergeDecision (spec 0012 §6)", () => {
  it("merges automatically when everything qualifies", () => {
    expect(mergeDecision(snapshot(), context())).toEqual({ kind: "auto", approvedBy: ["reviewer"] });
  });

  it("refuses by name, first failure wins", () => {
    const cases: Array<[Partial<PrSnapshot>, string]> = [
      [{ state: "closed" }, "not_open"],
      [{ state: "closed", merged: true }, "already_merged"],
      [{ draft: true }, "draft"],
      [{ author: "cto-bot" }, "author_is_merger"],
      [{ mergeable: null }, "mergeability_unknown"],
      [{ mergeable: false }, "not_mergeable"],
      [{ mergeableState: "behind" }, "not_mergeable"],
      [{ mergeableState: "blocked" }, "not_mergeable"],
      [{ filesTruncated: true }, "files_incomplete"],
      [{ checks: { statuses: [], runs: [] } }, "no_checks"],
      [{ checks: { statuses: [], runs: [{ name: "validate", status: "completed", conclusion: "success" }] } }, "required_check_missing"],
      [
        {
          checks: {
            statuses: [{ context: "ci/legacy", state: "pending" }],
            runs: [
              { name: "validate", status: "completed", conclusion: "success" },
              { name: "build", status: "completed", conclusion: "success" }
            ]
          }
        },
        "checks_not_green"
      ],
      [
        {
          checks: {
            statuses: [],
            runs: [
              { name: "validate", status: "in_progress", conclusion: null },
              { name: "build", status: "completed", conclusion: "success" }
            ]
          }
        },
        "checks_not_green"
      ],
      [
        {
          checks: {
            statuses: [],
            runs: [
              { name: "validate", status: "completed", conclusion: "success" },
              { name: "build", status: "completed", conclusion: "success" },
              { name: "stray", status: "completed", conclusion: "failure" }
            ]
          }
        },
        "checks_not_green"
      ],
      [
        {
          reviews: [
            { login: "reviewer-bot", state: "CHANGES_REQUESTED", commitId: HEAD, submittedAt: "2026-09-05T10:00:00Z" }
          ]
        },
        "changes_requested"
      ],
      [
        { reviews: [{ login: "author-bot", state: "APPROVED", commitId: HEAD, submittedAt: "2026-09-05T10:00:00Z" }] },
        "self_approval"
      ],
      [{ reviews: [] }, "no_qualifying_approval"]
    ];
    for (const [over, reason] of cases) {
      const verdict = mergeDecision(snapshot(over), context());
      expect(verdict.kind, reason).toBe("refuse");
      expect((verdict as { reason: string }).reason, JSON.stringify(over)).toBe(reason);
    }
  });

  it("names why each approval was discarded", () => {
    const verdict = mergeDecision(
      snapshot({
        reviews: [
          { login: "reviewer-bot", state: "APPROVED", commitId: OLD, submittedAt: "2026-09-05T09:00:00Z" },
          { login: "cto-bot", state: "APPROVED", commitId: HEAD, submittedAt: "2026-09-05T09:30:00Z" },
          { login: "passer-by", state: "APPROVED", commitId: HEAD, submittedAt: "2026-09-05T09:40:00Z" }
        ]
      }),
      context()
    );
    expect(verdict.kind).toBe("refuse");
    const detail = (verdict as { detail: string }).detail;
    expect(detail).toContain("reviewer-bot: approved old0000");
    expect(detail).toContain("cto-bot: the merger");
    expect(detail).toContain("passer-by: not a roster agent");
  });

  it("uses the latest review per login and keeps a verdict over a later comment", () => {
    const approvedThenCommented = snapshot({
      reviews: [
        { login: "reviewer-bot", state: "APPROVED", commitId: HEAD, submittedAt: "2026-09-05T10:00:00Z" },
        { login: "reviewer-bot", state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-05T10:05:00Z" }
      ]
    });
    expect(mergeDecision(approvedThenCommented, context()).kind).toBe("auto");
    const changedThenApproved = snapshot({
      reviews: [
        { login: "reviewer-bot", state: "CHANGES_REQUESTED", commitId: OLD, submittedAt: "2026-09-05T09:00:00Z" },
        { login: "reviewer-bot", state: "APPROVED", commitId: HEAD, submittedAt: "2026-09-05T10:00:00Z" }
      ]
    });
    expect(mergeDecision(changedThenApproved, context()).kind).toBe("auto");
    const dismissed = snapshot({
      reviews: [{ login: "reviewer-bot", state: "DISMISSED", commitId: HEAD, submittedAt: "2026-09-05T10:00:00Z" }]
    });
    expect(mergeDecision(dismissed, context())).toMatchObject({ kind: "refuse", reason: "no_qualifying_approval" });
  });

  it("changes requested by a stranger do not block, by a roster agent they do", () => {
    const stranger = snapshot({
      reviews: [
        { login: "passer-by", state: "CHANGES_REQUESTED", commitId: HEAD, submittedAt: "2026-09-05T09:00:00Z" },
        { login: "reviewer-bot", state: "APPROVED", commitId: HEAD, submittedAt: "2026-09-05T10:00:00Z" }
      ]
    });
    expect(mergeDecision(stranger, context()).kind).toBe("auto");
  });

  it("refuses the shared credential before looking at reviews", () => {
    expect(mergeDecision(snapshot(), context({ sharedIdentity: true }))).toEqual({
      kind: "refuse",
      reason: "shared_identity"
    });
  });

  it("holds anything outside the auto globs, renames included, and dedupes the list", () => {
    const verdict = mergeDecision(
      snapshot({
        files: [
          { filename: "registry/agents/prior/agent.json" },
          { filename: ".github/workflows/ci.yml" },
          { filename: "registry/jobs/cs/x.json", previousFilename: "site/src/pages/index.astro" },
          { filename: ".github/workflows/ci.yml" }
        ]
      }),
      context()
    );
    expect(verdict).toEqual({
      kind: "hold",
      reason: "outside_auto_paths",
      outside: [".github/workflows/ci.yml", "site/src/pages/index.astro"],
      approvedBy: ["reviewer"]
    });
  });

  it("holds everything when the grant has no auto globs", () => {
    expect(mergeDecision(snapshot(), context({ auto: [] }))).toMatchObject({ kind: "hold" });
  });

  it("with no named checks, any green run suffices and any red run refuses", () => {
    const anyGreen = snapshot({
      checks: { statuses: [], runs: [{ name: "whatever", status: "completed", conclusion: "skipped" }] }
    });
    expect(mergeDecision(anyGreen, context({ checks: [] })).kind).toBe("auto");
    const oneRed = snapshot({
      checks: {
        statuses: [],
        runs: [
          { name: "a", status: "completed", conclusion: "neutral" },
          { name: "b", status: "completed", conclusion: "timed_out" }
        ]
      }
    });
    expect(mergeDecision(oneRed, context({ checks: [] }))).toMatchObject({ reason: "checks_not_green" });
  });

  it("registry/** would also cover the policy files, which is why the grant names directories", () => {
    const policyFile = snapshot({ files: [{ filename: "registry/functions.json" }] });
    expect(mergeDecision(policyFile, context()).kind).toBe("hold");
    expect(mergeDecision(policyFile, context({ auto: ["registry/**"] })).kind).toBe("auto");
  });
});

describe("reviewDecision (spec 0012 §5)", () => {
  const base = {
    verdict: "approve",
    body: undefined,
    isPullRequest: true,
    prAuthor: "author-bot",
    login: "reviewer-bot",
    granted: true
  };

  it("allows a bodiless approval and requires a body otherwise", () => {
    expect(reviewDecision(base)).toEqual({ ok: true, verdict: "approve" });
    expect(reviewDecision({ ...base, verdict: "request_changes" })).toEqual({ ok: false, reason: "missing_body" });
    expect(reviewDecision({ ...base, verdict: "comment", body: "  " })).toEqual({ ok: false, reason: "missing_body" });
    expect(reviewDecision({ ...base, verdict: "request_changes", body: "no" })).toEqual({
      ok: true,
      verdict: "request_changes"
    });
  });

  it("refuses by name", () => {
    expect(reviewDecision({ ...base, granted: false })).toEqual({ ok: false, reason: "repo_not_granted" });
    expect(reviewDecision({ ...base, verdict: "lgtm" })).toEqual({ ok: false, reason: "invalid_verdict" });
    expect(reviewDecision({ ...base, isPullRequest: false })).toEqual({ ok: false, reason: "not_a_pr" });
    for (const verdict of ["approve", "request_changes", "comment"]) {
      expect(reviewDecision({ ...base, verdict, body: "x", login: "author-bot" })).toEqual({
        ok: false,
        reason: "own_pr"
      });
    }
  });
});
