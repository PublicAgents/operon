# Spec 0008: Per-agent capability grants — MCP servers and GitHub repos

Status: draft. Extends spec 0006 (the manifest) and spec 0001's
credential doctrine; builds on spec 0005's registry conventions and
spec 0004's "MCP is the mind-side surface". A GRANT is the operator's
reviewable statement of what one agent may reach: which MCP servers,
and which GitHub repositories at which strength. An agent starts with
nothing; every capability it holds is a line in the manifest the
operator wrote.

## 1. The problem

Two capability surfaces have outgrown their configuration.

MCP first: the only MCP server a wake gets today is the browser server
spec 0004 stages, hard-wired in the chassis. The operator cannot add a
server (Google Analytics is the first concrete want) without a chassis
change, and there is no doctrine for where such a server's credential
would live. The one obvious place, inside the container, is the one
place it must never be.

GitHub second: access is split across two credentials with opposite
scoping. The github Gatekeeper's App mints installation tokens scoped
to one repo and one permission, but only ever for the agent's own
state repo. The pr Gatekeeper holds one classic PAT with broad `repo`
scope, shared by every agent, contained by a fleet-wide `PR_REPOS`
var. That produces real holes: authorship checks compare against the
PAT's login, so with a shared PAT one agent can update or push to
another agent's pull requests; `MACHINE_PAT_<AGENT>` support exists in
code but is undocumented and unmanaged; and the container's porch
double-gates only three of the eight github doors. The operator also
cannot say "this agent may write to this repo and that agent may not",
which is the actual per-agent boundary a growing colony needs.

## 2. Doctrine

**Credentials never enter the container. No exceptions.** A capability
is granted to an agent as a route, never as a secret: either a
credential-less process in the container, or a virtual host through
the umbilical to a Worker that holds the credential. This spec adds no
third option, and it removes the temptation for one: a "read-only
credential in the container" tier was considered and rejected by the
operator. The precedent is cloudflare-os, whose gatekeeper doctrine
this chassis shares; where this spec borrows a mechanism, the borrow
is named.

**The boundary is the token or the binding, never argument parsing.**
Per-repo GitHub access is enforced by minting tokens that can only
reach the granted repo, not by inspecting request payloads for repo
names. Per-server MCP access is enforced by routing, and per-tool
access by a grant check that runs before any network call. Argument
inspection appears nowhere as a security boundary, because arguments
are the caller's to shape and schemas drift ("MCP tools take
arguments, not capabilities").

**One classification module is the whole trust boundary for MCP tool
annotations.** Exactly one module reads a tool's annotations. A tool
is a READ iff `readOnlyHint === true` (strict equality; an unannotated
tool is a write). Reads from an administrator-vetted upstream pass;
everything else requires the operator to have pinned the tool by name
in the manifest. No annotation an upstream publishes can widen access,
only narrow it.

**Grants are subtractive and explicit.** `agents[].mcp` and
`agents[].github` default to nothing. The manifest is the reviewable
record; a capability that is not written there does not exist for that
agent.

## 3. The grant vocabulary

Colony-level definitions, per-agent references:

```yaml
mcp:
  google-analytics:
    type: gatekeeper                 # a bespoke operon Worker speaking MCP
    worker: gatekeeper-google-analytics
  linear:
    type: portal                     # upstream lives in the Cloudflare MCP portal
    server: linear
    tools: [linear_create_issue]     # write pins; reads pass via the vetted tier
  plain:
    type: http                       # fallback: bearer or no-auth remote server
    url: https://mcp.example.com/mcp
    auth: bearer                     # bearer -> secret MCP_PLAIN_TOKEN on gatekeeper-mcp
    tools: [some_tool]               # byo tier: ONLY pinned tools are callable
  somelocal:
    type: stdio                      # in-container, credential-less by construction
    command: npx
    args: ["-y", "some-mcp@1.2.3"]   # a version pin is required; "latest" refuses

agents:
  - id: promoter
    mcp: [google-analytics]
    github:
      pr: [livevariant/livevariant, PublicAgents/operon]
      write: [livevariant/livevariant]

policy:
  google-analytics:
    GA_PROPERTY_ID: "properties/XXXXXXXXX"
```

`github.pr` is the per-agent successor of the fleet-wide `PR_REPOS`
policy var. During one release both are accepted with `PR_REPOS` as
the fallback for agents without a `github:` block; a manifest that
sets both for the same agent refuses at `--check`, because two sources
of the same truth is how allowlists rot.

The switch is the PRESENCE OF THE BLOCK, not of a key inside it, and
every layer keys on the same thing: an agent whose entry says
`github:` has per-agent grants, and a list missing from inside that
block means nothing rather than the fleet's. Reading a missing `pr:`
as a fallback would hand an agent granted only `write:` the entire
fleet allowlist, and an explicit `pr: []` must mean what it says.

`github.write` names repos where the agent may commit to non-default
branches through the App (section 6). The App installation must cover
those repos; that cannot be validated offline, so it refuses at mint
time with GitHub's own error surfaced verbatim.

Validation lives in ONE place, core `parseRoster`, which the fleet
`--check`, the deployed `ROSTER` var, and every Worker that reads the
roster all ride. Named refusals: an `agents[].mcp` entry naming an
undefined server; unknown keys in a server definition or an env entry;
a stdio arg containing `latest`; an `env` field on a stdio def
(`stdio_env_unsupported`, see section 4); a `tools:` list on a stdio def; a repo not shaped
`owner/repo`; a secret name not shaped `MCP_*`. `parseAgent` also
gains the unknown-key refusal `validatePolicy` already has: a
misspelled grant must fail the check, not silently grant nothing.

## 4. Reaching an MCP server from a wake

The wake's merged MCP config is written to
`/home/mind/.operon/mcp.json` (0600, chowned to the mind) and handed
to the harness with `--mcp-config`. It is NOT written into the state
repo: the previous `.mcp.json`-in-worktree arrangement committed
chassis config into the agent's memory every wake, and a config file
that may one day carry per-server settings must live where `git add
-A` cannot reach it. The browser server of spec 0004 moves into the
same merged file.

Entries by type:

- `stdio`: command and args, nothing else. It runs in the container as
  the mind's uid; what it can reach, the mind could reach anyway
  (egress is audited, spec 0004 section 8). It cannot carry a
  credential STRUCTURALLY, because the definition has no `env` field
  at all: there is no place to put one, short or long, recognizable or
  not (`stdio_env_unsupported` names the refusal and the alternative,
  a gatekeeper or portal server). Non-secret env for stdio servers is
  deferred until a concrete server needs it, and returns, if ever,
  with a mechanism that cannot be misused for secrets.
- `gatekeeper`, `portal`, `http`: an entry of the form
  `{"type": "http", "url": "http://mcp-<name>.operon.internal/mcp",
  "headers": {"authorization": "Bearer <wake nonce>"}}`. The container
  knows a name and a virtual host, nothing else: no upstream URL, no
  credential, no distinction it could exploit.

The umbilical resolves `mcp-<name>.operon.internal` against the
roster's definitions: `gatekeeper` defs route to that Worker's service
binding, `portal` and `http` defs route to the generic gatekeeper-mcp
binding. The umbilical also enforces the per-agent grant: a name
absent from the calling agent's `mcp:` list answers `mcp_not_granted`
BEFORE any binding is touched. Hosts are only intercepted for granted
names, so an ungranted server is unreachable twice over.

The wake logs one line per staged server at start, and an explicit
`mcp: no servers configured` when there are none; a silent door
indistinguishable from an unwired one is a failure mode this chassis
has already paid for. `operon capabilities` lists the live server
names, and the living help states them.

Launch fails closed: a granted server whose secret is missing raises
`mcp_secret_missing` and the wake does not start, exactly like a
missing mind credential. The operator granted the capability
deliberately; a wake quietly missing its tools is the silent-door
failure again.

## 5. The MCP Gatekeepers

### gatekeeper-google-analytics

A bespoke Worker speaking MCP (the ops gateway's `createMcpServer`
machinery, spec 0005), because Google ships no remote GA MCP endpoint
and its official server exists to hold a local Google credential,
which doctrine forbids. Tools: `run_report`, `run_realtime_report`,
`get_property_metadata`, `get_account_summaries`, all read-only by
construction, all pinned to the `GA_PROPERTY_ID` policy var: the agent
cannot name another property, because the property is not an argument.

The Worker holds `GA_SERVICE_ACCOUNT` (a service-account JSON whose
only power is Viewer on the GA property, the real fence, set at the
Google side). It mints Google access tokens itself: an RS256
service-account JWT via WebCrypto, exchanged at Google's token
endpoint, cached until expiry, single-flight so a burst of calls
collapses into one mint. Binding-only; identity rides
`x-operon-agent`; every tool call is ledgered as `analytics_query`
with the tool name and date range, never the row data.

The measurement side is the deploy Gatekeeper's job, not the agent's.
A GA measurement id is public by design (it ships in every page's
HTML to every visitor), so it lives in `policy.deploy` as
`GA_MEASUREMENT_ID`, and the site-serving path injects the gtag
snippet into every `text/html` response at serve time, before
`</head>`, skipping pages that already carry the id so a hand-rolled
tag never double-counts. Serve-time rather than publish-time because
the server already holds the full body, coverage is uniform across
everything ever published, and the tag changes without a republish.
The living help tells the agent the id and that the base tag is
injected for it: the agent writes custom `gtag('event', ...)` calls
against that id and reads the results back through its
`google-analytics` MCP tools, with no credential anywhere near it.

### gatekeeper-mcp

The generic front for remote servers, in two trust tiers.

`type: portal` is the preferred path: the upstream is configured in
the deployment's Cloudflare MCP Server Portal, where Cloudflare One
holds every upstream credential, including OAuth (dynamic client
registration or manual client credentials), and the operator connects
a server once in the dashboard. This Worker authenticates to the
portal with a Cloudflare Access service token
(`MCP_PORTAL_CLIENT_ID`/`MCP_PORTAL_CLIENT_SECRET`; the portal URL is
a policy var). A grant is always scoped to ONE upstream server behind
the portal. Attribution of a tool to its server uses the portal's
`<server>_` name prefixes, and prefix grammars are ambiguous when one
server id prefixes another (`foo` vs `foo_bar`), so two rules make it
exact. At validation time, two declared portal defs whose server ids
are prefixes of one another refuse (`portal_server_ambiguous`). At
call time, a tool belongs to granted server S iff its name starts
with `S_` AND does not start with `T_` for any LONGER server id known
from the manifest or the portal's own server listing: longest match
wins, so `foo_bar_create` can never ride a grant for `foo`. The
syntactic check is the pre-network gate; the cached catalog is the
authority when they disagree, and a disagreement is ledgered. `portal_*` tools are never grantable at any
scope: they change which upstream servers a session reaches, which is
this manifest's decision, not a tool call's. Portal upstreams are
administrator-vetted, so classification runs at the `vetted` tier:
`readOnlyHint === true` reads pass without a pin.

`type: http` is the fallback for bearer or no-auth servers and for
deployments without the portal: the per-server secret `MCP_<NAME>_TOKEN`
lives on this Worker, and classification runs at the `byo` tier, where
no annotation is trusted and ONLY pinned tools are callable.

The upstream client is the official MCP SDK client over Streamable
HTTP, which owns protocol-revision negotiation and accepts a custom
fetch. Which revisions can be spoken is the SDK's fact rather than
ours: it publishes the list, negotiates within it (the stateful
handshake with `Mcp-Session-Id`, and the same protocol stateless), and
refuses a revision it does not know rather than guessing. Bumping the
SDK is therefore how a newer revision becomes speakable, and the mock
matrix below is what says whether the bump changed anything. That fetch is the guarded one:
redirects followed by hand and re-checked per hop, authorization
dropped cross-origin, response sizes capped; the Worker sets
`global_fetch_strictly_public` so resolved-private addresses are
refused after DNS. Only `tools/*` is spoken; prompts, resources,
sampling, and elicitation are not implemented, because sampling and
elicitation let a server drive the agent. The tool catalog is cached
with a revision fingerprint; a changed catalog is adopted and
ledgered, never silently.

Named refusals: `mcp_tool_needs_grant` (write without a pin, or byo
tool without a pin, naming the tool and the manifest key that would
grant it), `mcp_upstream_auth`, `mcp_upstream_unreachable`,
`mcp_portal_unconfigured`.

## 6. GitHub, per agent

The two Workers keep their split, which is by credential blast radius:
**github is the App's Worker** (repo-content writes with mint-time
scoping; the App key could rewrite every state repo, the agents'
memory, so it stays out of any Worker that parses untrusted content),
and **pr is the account's Worker** (identity-bearing social acts:
fork PRs, comments, issues; it chews on PR bodies and inbound review
threads all day and holds nothing that can touch memory). Neither
credential can absorb the other's job: Apps cannot fork and are not
installed on external repos; a PAT must never write our repos'
contents.

### Per-agent identity (pr)

Each agent gets its own machine account (`<agent>-<project>-bot`, the
spec 0006 section 6 convention) whose PAT is `MACHINE_PAT_<AGENT>` on
the pr Worker. The shared `MACHINE_PAT` remains as a fallback so
existing colonies keep working, and its use is logged by name as a
degradation, because with a shared login "authored by me" means
"authored by everyone". All allowlist checks resolve the calling
agent's `github.pr` grant from the roster; authorship checks resolve
against that agent's own login.

The agent id arrives in the request body, so it is a CLAIM, and it
selects both the repo grant and the credential. Both Gatekeepers
therefore check it against the roster before it selects anything: an
id the roster does not list is `unknown_agent`, and a Worker with no
parseable `ROSTER` refuses with `roster_unavailable` rather than
guessing, because every Worker is deployed with that var and its
absence is a broken deployment, not a request to be served. Other
refusals: `repo_not_granted`, `not_author`, `write_not_granted`,
`default_branch_protected`.

### Branch write (github)

A deliberate doctrine change, operator-approved: an agent granted
`github.write: [repo]` may commit to NON-DEFAULT branches of that repo
through a new door. The Worker mints an installation token scoped to
exactly that one repo with `contents: write` (the same mint the state
repo commit path has always used), and commits via the Git Data API.
The merge gate survives on three legs, all required: the mint-time
token scope (other repos are unreachable), the door's refusal to touch
the repo's default branch (`default_branch_protected`), and branch
protection on the GitHub side, which the colony must actually enable
for the repos it grants. Ledgered like `/commit`.

The container door is `operon github branch <owner/repo> [dir]
--branch <b> --message <m>`, swept like every outbound payload. The
porch pre-checks the agent's own grants (delivered as
`OPERON_GITHUB_GRANTS`) wherever the rule is knowable locally: the pr,
issue, upstream-file, and branch doors, so a refusal costs no round
trip and every door says the same thing. The authorship doors (thread,
comment, update, push) are deliberately NOT pre-checked, because their
rule is "this agent's account authored the item", which is only
knowable from GitHub; pre-checking a repo list there would refuse the
legitimate case the rule exists for, an agent's own pull request on a
repo nobody granted it. The Gatekeeper remains authoritative for all
of them: eight here, eleven once spec 0012 adds review, merge and
close.

### Why not the GitHub MCP server

Evaluated and rejected for writes: the hosted server accepts only
OAuth and PATs (App installation tokens are refused), its write tools
push branches directly upstream, and repo boundaries would rest on
parsing tool arguments, which section 2 forbids as a boundary. As a
read-only enrichment through gatekeeper-mcp with a fine-grained
read-only PAT it remains a phase-2 option.

## 7. What is deferred, named

- An approval queue for MCP writes (submit, held, operator decides,
  result collected later), mapping the asks/held-rows model onto tool
  calls. Until then, a write needs a manifest pin, which is an
  operator decision with a slower loop but the same authority.
- OAuth done by gatekeeper-mcp itself for `type: http` upstreams; the
  portal covers OAuth upstreams today.
- Codex MCP staging (its config form differs); declared servers are
  skipped for that harness with a named log line.
- Runtime (console-editable) grants; grants stay manifest-only until
  spec 0006's doors matrix lands.

## 8. Security invariants (testable)

1. No MCP server definition can place a secret in the container: stdio
   env is validated credential-less, and every other type resolves to
   a virtual host plus the wake nonce.
2. An agent's reachable MCP set is exactly its `mcp:` list: ungranted
   names are unintercepted AND answer `mcp_not_granted` at the
   umbilical; granted-but-unpinned write tools answer
   `mcp_tool_needs_grant` at the gatekeeper.
3. `portal_*` tools are never callable through any grant.
4. A `github.write` token can reach exactly one repo and cannot touch
   its default branch through the door.
5. With per-agent PATs configured, no agent can update or push to an
   item authored by another agent's account.
6. The state repo never contains chassis MCP config: `.mcp.json` is
   not written into the worktree.

## 9. Order of work

1. This spec, plus spec 0001 drift fixes (invariant 1's "machine-user
   PR token" is not held in the container; PR-opening belongs to the
   pr Gatekeeper's description, not github's).
2. Core: the grant vocabulary in the roster, wake env plumbing, fleet
   round-trip.
3. GitHub: per-agent allowlists and authorship in pr; the branch door
   in github; porch symmetry; colony docs.
4. Umbilical MCP routes in the scheduler.
5. gatekeeper-google-analytics.
6. gatekeeper-mcp with the mock-upstream test matrix (both protocol
   revisions plus hostile upstreams).
7. Container staging (`--mcp-config`, merged file, wake-start lines),
   then the hand-run wake AGENTS.md requires.
