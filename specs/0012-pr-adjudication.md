# Spec 0012: PR adjudication: review, merge and close doors

Status: accepted. Builds on spec 0008 (grants, fork-only containment),
spec 0007 (asks; holds are the other decision shape), spec 0006 (many
projects, one operon) and spec 0009 (the CI service token).

## 1. The problem

A colony wants to run a public registry that is changed only through
pull requests, from anyone, and to have its own agents decide those
pull requests: one agent authors entries, a second adjudicates them, a
third merges what qualifies. Nobody edits the default branch directly,
and the three verbs are held by three identities on purpose, so that
no single agent can put a line into the record on its own.

The chassis cannot do this today. The pr Gatekeeper has eight doors
(status, thread, comment, pr, issue, push, update, upstream-file) and
every one of them is either read-only or bounded to the agent's own
authorship. Reviews are read (`GET /pulls/{n}/reviews`) and never
posted. Nothing merges. Nothing closes another party's pull request.
The pr Worker has no hold storage and no Telegram binding, so a
decision that belongs to the operator has nowhere to wait.

Two smaller gaps surface on the same path. `tools/access.mjs` names the
CI service token per PROJECT and stores it in the repository's secrets,
so the second project bootstrapped in one colony repository overwrites
the first project's token and breaks its deploy drain. And
`tools/bootstrap.mjs` looks for charters and writes the Access block
in the single-manifest locations only, so a second project seeds
without charters and writes its Access block into the wrong manifest.

## 2. Doctrine

- **Adjudication is identity-bearing, so it lives on the pr Worker.**
  A review or a merge is a social act signed by an account. That is
  the machine account's Worker (spec 0008 §2: "pr = the account's
  worker"), never the App's. The github Gatekeeper keeps its
  content-write doors and gains nothing here.
- **Qualification is computed from GitHub, never claimed by the
  caller.** The merge door reads the pull request, its files, its
  reviews and its checks itself. The agent supplies a repo and a
  number; everything that decides comes from the other side of the
  credential. The merger's own words are not evidence.
- **Holds, not asks.** An ask (spec 0007) is a question the agent
  writes. A hold is an act the chassis stopped: the agent asked to
  merge, the rule said "the operator decides", and the act waits
  with its evidence attached. The email and spend Gatekeepers already
  hold this way (first contact, spends over the cap); merge joins them
  with the same claim semantics.
- **Every merge is ledgered, and the ledger cannot miss one.** A merge
  is irreversible, so it gets the spend door's accounting: a durable
  intent row before the GitHub call, a terminal result after it, and a
  reconciliation path for a lost response. "Mutate, then ledger" is
  not enough, because storage can fail after GitHub has already
  merged.
- **Three legs, each failing closed.** The Gatekeeper rule (grants plus
  `mergeDecision`), GitHub's branch protection (required checks,
  required approvals, restricted pushes) and the accounts' own
  permissions (the author's token cannot merge, the reviewer's login
  is not on the push list) each refuse on their own. A bug in one leg
  does not open the door.

## 3. Grants

`GithubGrants` (core roster) grows two lists beside `pr` and `write`:

```yaml
agents:
  - id: researcher
    github: { pr: [PublicAgents/public-agents] }
  - id: reviewer
    harness: codex
    github: { review: [PublicAgents/public-agents] }
  - id: cto
    github:
      pr: [PublicAgents/public-agents]
      merge:
        - repo: PublicAgents/public-agents
          auto: ["registry/agents/**", "registry/tools/**", "registry/jobs/**", "registry/evidence/**"]
          checks: ["validate", "verify-ownership", "links", "build"]
```

- `review: string[]`: repos on which this agent may post pull-request
  reviews. Its own list, not `pr`: reusing `pr` would let the author
  role approve other agents' work and defeat the separation.
- `merge: MergeGrant[]` with `{repo, auto?, checks?}`. `auto` is a list
  of path globs; a pull request whose every changed path matches one
  of them merges without the operator, anything else is held. Absent
  or empty means every merge is held. Globs name directories
  explicitly (`registry/agents/**`); a glob like `registry/**` that
  also covers operator-owned policy files is a manifest mistake the
  operator must not make, and the living help says so. `checks` names
  the check runs that must exist and be green on the head; absent
  means "every check run present must be green, and at least one must
  exist", which is weaker and is stated as such in `check` output.
- Unknown keys refuse at parse time like every other roster field.
  `auto` entries are non-empty, use the safe path charset plus `*`,
  and carry no leading `/` and no `..`.
- A `github:` block still switches the agent off the fleet-wide
  `PR_REPOS`; both at once refuses (spec 0008 §3). `review` and `merge`
  blocks count as a `github:` block for that rule.
- **Reachable repos.** Reading and commenting (`status`, `thread`,
  `comment`, `upstream-file`) key on the union of `pr`, `review` and
  `merge[].repo`, so a reviewer with no `pr` grant can read and discuss
  the pull requests it adjudicates. Authoring (`pr`, `issue`) keys on
  `pr` alone.
- The manifest cross-check refuses `merge_without_reviewer`: a merge
  grant on a repo where no OTHER agent holds `review` is a policy that
  can never fire on the auto path, and a policy the operator believes
  is in force but is dead is worse than none.
- The wake env `OPERON_GITHUB_GRANTS` gains `review` and `merge` as
  repo lists (names only; `auto` and `checks` are the Gatekeeper's
  business). An older container image against a newer scheduler reads
  the new lists as empty and refuses by name, which is the right
  failure.

## 4. Machine accounts and branch protection

Each roster agent has its own machine account and its own classic PAT
(`MACHINE_PAT_<AGENT>`, spec 0008 §3). Classic, not fine-grained: a
fine-grained token is bound to one resource owner, and one token must
both push to the bot's own fork (user-owned) and act on the
organization's repository, which is what `openPullRequest` does with
one credential. Scope `public_repo` suffices for a public registry.
The colony verifies the flow by hand with the author bot's token
(fork, branch, pull request) before the doors are built on it.

Permissions on the registry repository, by role:

| role | collaborator role | why |
| --- | --- | --- |
| author (researcher) | none | fork pull requests on a public repo need no invite |
| adjudicator (reviewer) | Write | an approval by a user without write does not count toward "required approving reviews" |
| merger (cto) | Write, on the push allowlist of the default branch | the only account beside the operator that can merge |

Branch protection on the default branch: require a pull request,
require one approving review, dismiss stale approvals on push, require
status checks by name (the same list as the grant's `checks`), require
branches to be up to date before merging, restrict pushes to the
merger's account and the operator, squash merges only, administrators
included. With CODEOWNERS naming the operator for the code paths and
the adjudicator for the data paths, a held code pull request cannot be
merged by the merger's token until the operator has approved it on
GitHub as code owner. The chassis hold approval (§8) is therefore the
second half of a two-step act for code, and the door says so.

**Identity resolution.** Approvals are attributed to roster agents by
resolving `GET /user` with each agent's own PAT (`rosterLogins`:
login to roster id, memoized for a few minutes per isolate). No
`machineLogin` roster field: a second source of truth drifts when a
PAT is rotated onto a different account, and the credential cannot lie
about who it is. Under the shared `MACHINE_PAT` fallback two agents
resolve to one login; the merge door then refuses `shared_identity`,
a deployment defect that fails loud rather than silently weakening the
"different agent" rule.

## 5. The review door

`POST /gatekeeper/review {agentId, repo, number, verdict, body?}`,
bearer `PR_SERVICE_TOKEN`, verdict one of `approve`,
`request_changes`, `comment`.

The door reads the pull request's current head sha and posts the
review with `commit_id` set to it, so the approval binds to the head
the reviewer read. Without it GitHub attaches the review to whatever
head exists at submit time, and a push between the reviewer's read and
its submit would be approved unseen. The response and the ledger name
the sha reviewed.

Refusals, by name: `repo_not_granted` (not in `review`), `not_a_pr`,
`invalid_verdict`, `missing_body` (required for `request_changes` and
`comment`; an approval may be bodiless), `own_pr` (the agent's own
authorship, for every verdict: a self "request changes" is theatre
and a self-approval is the thing this spec forbids), and GitHub's own
answer surfaced verbatim as `review_failed`.

Ledger kinds: `review_posted {agentId, identity, repo, number,
verdict, headSha, url}`, `review_denied {reason}`, `review_failed
{detail}`.

## 6. The merge door

`POST /gatekeeper/merge {agentId, repo, number}`.

**Snapshot.** The door reads: the pull request (state, merged, draft,
`mergeable`, `mergeable_state`, head sha, author login), every page of
its files (`filename`, `previous_filename`, `status`), its reviews,
the combined status and the check runs on the head sha. GitHub
computes `mergeable` lazily; the door polls up to five times at two
seconds, like the fork loop, and refuses `mergeability_unknown` after
that. Check runs from a `pull_request` workflow are reported on the
head sha even though they ran the synthetic merge commit; the head sha
is what qualification reads.

**Decision.** `mergeDecision(snapshot, ctx)` is a pure function over
the snapshot and the grant, tested by name. First failure wins:

| refusal | rule |
| --- | --- |
| `not_open` | state is not open |
| `already_merged` | merged |
| `draft` | draft |
| `author_is_merger` | the merger's login authored it |
| `mergeability_unknown` | `mergeable` still null |
| `not_mergeable` | `mergeable` false, or `mergeable_state` not `clean` (`behind` and `blocked` refuse here, which is what makes "require branches up to date" bite: two data pull requests green against the same stale base cannot both merge and invalidate each other) |
| `files_incomplete` | the file inventory reached GitHub's cap (3,000 files) |
| `no_checks` | no status and no check run on the head; a repo without CI never auto-merges |
| `required_check_missing` | a check named in the grant is absent on the head |
| `checks_not_green` | any status not `success`, any run not completed with `success`, `neutral` or `skipped` |
| `changes_requested` | a roster agent's latest review is CHANGES_REQUESTED |
| `self_approval` | the only approval is the author's own |
| `shared_identity` | two roster agents resolve to one login |
| `no_qualifying_approval` | no APPROVED review on the current head (`commitId === headSha`; stale approvals never count) by a roster login that is neither the author nor the merger; detail names why each candidate was discarded |

Reviews are the latest non-dismissed review per login. Then paths:
every changed path, and for a rename BOTH `filename` and
`previous_filename` (moving operator-owned code into a data path is
not a data change), must match an `auto` glob for the verdict `auto`;
otherwise the verdict is `hold` with the outside list. `matchPathGlob`
is a tiny in-file matcher (`**` any segments, `*` within a segment),
zero dependencies.

**Auto path.** The merge is an irreversible act with the spend door's
accounting. The `PrHolds` Durable Object first records a durable
intent row `{repo, number, headSha, agentId, at}`; then the door calls
`PUT /repos/{o}/{r}/pulls/{n}/merge {merge_method: "squash", sha:
headSha}` (the `sha` argument makes GitHub refuse a head that moved
after the decision); then the terminal result (`merged {mergeSha}` or
`failed {detail}`) lands on the same row; then the ledger row
`pr_merged {mode: "auto", approvedBy, files, headSha, mergeSha}` and a
notify without buttons. A lost GitHub response (timeout, 5xx after the
merge landed) leaves the intent open in state `unknown`: the door
answers `outcome_unknown`, and the next call for that pull request,
or the operator's held listing, reconciles FIRST by reading `merged`
and `merge_commit_sha` on the pull request. The reconciliation has
three outcomes and each is a defined transition: merged with the
intent's head (`merged {mergeSha}`, the ledger row `pr_merged` is
written then, with `reconciled: true`); merged with a different head
(`superseded`: someone else merged a later revision, ledgered as
`merge_superseded`, never counted as this agent's merge); not merged
(`failed {detail: "reconciled: not merged"}`). Only a terminal intent
lets a new merge call for the same pull request proceed, and that call
makes a NEW intent after fresh qualification; the at-most-once
guarantee is per intent, never "never again". While GitHub itself is
unreachable the intent stays `unknown` and the door keeps answering
`outcome_unknown`; it never guesses. A merge is never reported as
failed after it succeeded and never attempted twice.

Two kinds of row, never confused: INTENT rows are keyed by their own
id, one per attempt, never overwritten, so a head that was attempted,
reconciled as not merged and attempted again keeps both histories.
TERMINAL records are keyed by `(repo, number, headSha)` and say what
became of a head: `merged`, `superseded` or `rejected`, the outcomes
after which that head can never merge through this door again. A
failed or not-merged attempt writes NO terminal record (the head is
still open and a fresh attempt is legitimate), so a retry against the
same head overwrites nothing. Terminal records stay for thirty days.

**Hold path.** `PrHolds.hold` deduplicates on `(repo, number,
headSha)` (a claimed hold counts), ledgers `merge_held {heldId,
reason, outside, approvedBy}` only for a new hold, notifies the
operator with Approve and Reject buttons, and answers `{ok: true,
status: "held_for_approval", heldId, outside}`. A head the operator
already REJECTED answers `rejected_by_operator {reason, at}` from the
terminal record instead of holding again, so a later wake cannot
re-queue the same revision and re-notify; a new push is a new head and
a new hold. The agent learns outcomes from the door's answer and from
`operon github status`, which lists this agent's holds and terminal
results for its merge-granted repos.

**Refusals** ledger `merge_denied {reason, detail}` and answer 403 or
409 with the reason as the error name. GitHub errors answer
`merge_failed` 502 after the intent row says failed.

**Concurrency.** Beginning an intent is one serialized turn in the
store: the check for an open intent and the write happen together, so
two overlapping merge calls for one pull request cannot both start an
irreversible act; the loser answers 409 `merge_in_progress`. A pending
intent younger than the stale bound (five minutes) is a door still
working; an older one belongs to a door that crashed and is reconciled
like an unknown one. The same rule closes the close door
(`close_in_progress`): a close intent carries `workingSince` while a
door works it and is released on a lost response. The operator's held
listing reconciles every open intent first, with the credential of the
agent that made it, so a lost response never leaves a claimed hold in
the queue: a reconciled merge deletes its hold, a reconciled
not-merged attempt unclaims it for another decision. The claim itself
is a fence: it mints a token the approval must present when it begins
its intent, and the begin refuses `hold_gone` when the hold is no
longer there with that token. A rejection that overrides a stale claim
reconciles an older intent first, and then, in ONE store turn with no
network read between them, checks again for an intent in flight
(`approval_in_flight`), writes the terminal record and deletes the
hold; the begin is one turn too, so the two cannot interleave, and a
slow approval that wakes up afterwards stops before GitHub. The
executor has a deadline too: no merge call starts once its intent is
older than the stale bound, and the call carries the time that
remains; past the bound the attempt answers `executor_stale` and is
over. A call the client gave up on is a lost response (the intent goes
`unknown`), and because the server may still be finishing it,
reconciliation of an unknown intent waits a grace (one minute after
it became unknown) before reading GitHub as the truth; a pending
intent is reconciled only past the stale bound. No rejection ever
lands over an open intent: the store's one-turn reject answers
`approval_in_flight` for a young pending one and `unresolved` for any
other, and the door reconciles first, with the agent's credential, or
answers `outcome_unknown` when it has none.

## 7. The close door

`POST /gatekeeper/close {agentId, repo, number, reason}`: for spam and
for pull requests that will never qualify. Requires a merge grant on
the repo (`repo_not_granted`), a pull request (`not_a_pr`), an open
one (`already_closed`) and a reason (`missing_reason`). Closing is
two GitHub calls, and a lost response between them must neither
duplicate the reason nor misreport the close, so it is accounted like
a merge: `PrHolds` records a close intent `{repo, number, reason,
steps}` first; the reason is posted as a comment carrying an
invisible marker (`<!-- operon-close <intentId> -->`) and the step
`commented` is recorded; the state is patched to closed and the step
`closed` is recorded; then the ledger row. A retry for the same pull
request finds the open intent and resumes from GitHub's truth, not
from memory: it lists the comments for the marker before posting
again, and reads the state before patching (closing a closed pull
request is a no-op). The terminal record says which steps completed,
so a close whose comment landed but whose patch was lost is finished
on retry rather than reported as failed. A lost response on either
step (the wire dropped, a 5xx) leaves the intent pending with the
steps recorded so far and answers 503 `outcome_unknown {intentId,
steps}`, ledgered as `close_outcome_unknown`; the door never reports
`close_failed` for a close that may have landed. Only GitHub's own
refusal (a 4xx) resolves the intent `failed` and answers 502
`close_failed`. Ledger `pr_closed {agentId, identity, repo, number,
author, reason}`, `close_denied`, `close_failed`,
`close_outcome_unknown`. The update door's `not_author` refusal is untouched:
closing another party's pull request exists only here, only for
merge-granted agents, only with a reason on the record.

## 8. The operator's surface

Storage: a second Durable Object on the pr Worker, `PrHolds`
(wrangler migration v2), in the Mailbox and SpendLedger shape: `hold`,
`claimHeld`, `unclaimHeld`, `deleteHeld`, `listHeld`, plus the intent
and terminal rows of §6. The state transitions are factored into a
pure `HoldStore` over a minimal `{get, put, delete, list}` so vitest
covers the lifecycle without a DO runtime. Held record: `{id,
queuedAt, agentId, repo, number, title (untrusted), author, headSha,
outside, approvedBy, claimed?, claimedAt?}`.

`Ops` entrypoint (binding-only):

- `POST /gatekeeper/pr/held`: every hold and every terminal record of
  the last thirty days, across agents, like spend.
- `POST /gatekeeper/pr/approve {agentId, heldId}`: atomic `claimHeld`
  (409 `held_unavailable`), re-snapshot, and the head must EQUAL the
  hold's recorded `headSha`: `head_moved` invalidates and deletes the
  hold, because the operator approved a revision that no longer
  exists, and the next merge request makes a fresh hold with fresh
  evidence. The approval never silently refreshes what the operator
  saw. Then the merger's grant must still exist in the current ROSTER,
  and the open/merged/draft/author/mergeable/checks rules are
  re-applied (the review rule and the path rule are what the operator
  is deciding, so they are not). On failure `unclaimHeld` and 409
  `no_longer_qualifies` with the reason; `mergeable_state: blocked`
  answers `blocked_by_branch_protection`, which for a code pull
  request means the operator has not yet approved it on GitHub. On
  success the same intent-row accounting as the auto path, the merge
  with `sha`, ledger `pr_merged {mode: "operator", heldId}`, delete
  best-effort (a claimed orphan can never re-merge).
- `POST /gatekeeper/pr/reject {agentId, heldId, reason?}`: mirrors
  spend's `rejectHold`, not a bare delete. A hold with a YOUNG claim
  means an approval is executing now, so the rejection answers 409
  `approval_in_flight` rather than reporting "rejected" while a merge
  completes; a stale claim (older than the claim age bound, a crashed
  approval) is overridable, but the pull request is re-read first and
  an already-merged one makes the rejection concede with
  `already_merged`; a retry of a lost rejection finds no hold and
  answers `rejected` idempotently. The terminal record `rejected
  {reason, at}` is written for the head. Ledger `merge_rejected`.
- `GET /gatekeeper/pr/ledger` unchanged.

Telegram: callback kinds `merge_approve` (`ma:`) and `merge_reject`
(`mr:`) beside the email and spend kinds; `heldDecision` becomes a
gate table `{email, spend, merge}`; the telegram Worker gains a `PR`
Ops binding; the operator help names the buttons. The notify for a
held CODE pull request says "approve the pull request on GitHub, then
tap Approve", because the button alone cannot satisfy CODEOWNERS.

Registry tools (`packages/ops-tools`), beside `email_*` and `spend_*`:
`merge_held` (read-only, UNTRUSTED in its description because titles
are the author's words), `merge_approve` and `merge_reject`
(`decision: true`, audited through the runner). UI, REST and MCP come
from the one registry (spec 0005). Console: a `MergeApprovals` block
on the approvals page showing `repo#number`, author, head sha, the
outside paths and the approvers as Gatekeeper facts, the title through
`UntrustedText`, and the confirm note quoting only `repo#number` and
the sha.

## 9. The container doors and the living help

Verbs, swept like every outbound payload:

- `operon github review <owner/repo> <n> --approve | --request-changes
  | --comment [--body <text> | --body-file <file>]` (exactly one
  verdict flag)
- `operon github merge <owner/repo> <n>`
- `operon github close <owner/repo> <n> --reason <text>`

The porch pre-checks `review_not_granted` and `merge_not_granted` from
`OPERON_GITHUB_GRANTS` (the Gatekeeper stays authoritative), sweeps
`body` and `reason`, and lists `githubReview` and `githubMerge` in its
capabilities. The living help states the rule to the mind plainly:
never approve your own pull request; merge only what qualifies (open,
green on the named checks, approved by another agent on the current
head, data paths only); held means wait, the operator decides, do not
retry the same head; close is for spam, with a reason, on the record.
Spec 0008 §6's count of Gatekeeper-authoritative doors becomes eleven.

## 10. Fleet plumbing and the multi-project fixes

- `templates.ts`: gatekeeper-pr gains a `TELEGRAM` service binding, a
  `HOLDS` DO binding and migration v2 (`packages/gatekeepers/pr/
  wrangler.jsonc` too); gatekeeper-telegram gains a `PR` Ops binding.
  `secrets.ts` says per-agent PATs are REQUIRED where an agent holds
  `merge` (the shared fallback refuses `shared_identity`).
- **One CI service token per repository** (amends spec 0009 §3). The
  token is named `operon-ci-<owner>-<repo>` (lowercased, non-slug
  characters to `-`) and every project's Access application in that
  repository carries a Service Auth policy for it. Deploy resolves the
  repository from `GITHUB_REPOSITORY` or the checkout's origin.
  Migration without churn: when the repository-named token is absent
  but a legacy `operon-<project>-ci` token exists, it is renamed in
  place (client id and secret unchanged, so the repository secrets
  keep working) and the rename is logged; only when neither exists
  does bootstrap mint and store one; deploy never mints.
- `tools/bootstrap.mjs` looks for charters under
  `.operon/projects/<project>/charters/<id>.md` first, and writes the
  Access block into the manifest it LOADED (the path from
  `findManifests`), never into `.operon/operon.yaml` by preference.
- `tools/fleet.mjs` `rosterVar` serialises every top-level roster
  field the scheduler reads (a whitelist that misses a field is a
  capability that validates at check and vanishes in production), with
  a deployed-value test; `opsCall` takes a per-project override
  (`OPERON_OPS_URL_<PROJECT>`) and refuses the bare `OPERON_OPS_URL`
  when more than one manifest is deployed; migrations are applied for
  every rendered chronicle config, so a colony workflow stops naming
  projects.
- The wake-trigger rotation group writes the host project's
  `WAKE_TRIGGER_TOKEN_<PROJECT>` copy (spec 0006 §9) in the same
  operation as the project's own three workers, and reports a partial
  write by worker name so a retry finishes it.
- Bootstrap's FIRST deploy of a project runs two passes: pass one
  deploys every worker with its service bindings stripped (nothing has
  a bearer yet, so nothing is reachable), pass two deploys the real
  configs. Cycles through gatekeeper-telegram already exist and the
  templates' "run twice" note was never a tested path; pr joining the
  cycle makes it one.

## 11. Invariants, each with a test

1. An agent never approves its own pull request (`own_pr`).
2. Nothing auto-merges without an APPROVED review on the current head
   by a roster agent other than the author and the merger.
3. Nothing outside the grant's `auto` globs merges without a claimed
   operator approval whose recorded head equals the merged head.
4. A hold merges at most once; a rejected head never re-holds; a lost
   GitHub response is reconciled before any retry, and every
   reconciliation outcome (merged, superseded, not merged) is a
   terminal transition.
9. A close retried after a lost response posts its reason once and
   finishes the step that was lost; a lost response is reported as
   unknown, never as failed.
10. A failed or not-merged attempt writes no terminal record; a retry
    against the same head overwrites no history.
5. The shared PAT never satisfies a merge (`shared_identity`).
6. A closed `github` door closes review, merge and close.
7. Renaming operator-owned code into a data path is not a data change.
8. A repository with no checks never auto-merges; a named check that is
   absent refuses.

## 12. Order of work

1. This spec, with the drift fixes in specs 0008 and 0009.
2. Core grants (`review`, `merge`), roster tests.
3. Scheduler and container plumbing, manifest cross-checks.
4. `merge-policy.ts` (pure) and `reachableRepos`, tests by refusal name.
5. GitHub snapshot, review and close doors, identity resolution.
6. Merge door with holds, intent rows and reconciliation; wrangler
   migration; templates bindings.
7. Telegram, ops-tools and console surfaces.
8. Container verbs, living help, parity specs.
9. Multi-project fixes: CI token per repository, bootstrap paths,
   `rosterVar`, per-project ops URL, migrations loop, wake-trigger
   rotation, two-pass first deploy.
