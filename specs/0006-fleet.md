# Spec 0006: The fleet (many projects, one operon)

Status: draft. Extends spec 0005, whose Phase 2 note promised this
design after living with the Phase 1 console. The goal, in the
operator's words: starting a new project should boil down to adding a
domain, adding git repos, and writing the goal and the charters, with
one Cloudflare account, one chassis lineage, and one upgrade motion
per project (independently pinned; see §9).

## 1. The unit: `.operon/` in any repo

A PROJECT is a repository carrying an `.operon/` directory, the way
`.github/` marks a repo as CI-aware:

```
.operon/
  colony.yaml        the manifest: everything colony-specific
  charters/          seed charters, one per agent (copied into the
                     agent's state repo at bootstrap, authored there
                     afterward: the state repo remains the living copy)
```

The manifest's first required field is `project:`, the explicit,
stable project name. It is never derived (a repo basename is neither
unique nor stable), it seeds every account-level resource name (worker
prefix `operon-<project>-*`, the D1 database, the Access application),
and bootstrap refuses to proceed when resources under that prefix
already exist and belong to a different repo: collisions are a
hard error at the door, not a surprise at deploy.

A repo may also host SEVERAL projects, as
`.operon/projects/<name>/{colony.yaml, charters/}`; the deploy CLI
takes `--project <name>` or acts on every project it finds. Projects
sharing a repo share its chassis pin and therefore upgrade together,
so co-locate projects you want in lockstep and give a project its own
repo when it should pin independently (the §9 canary pattern needs
that).

The chassis stays a git submodule pinned by the project (the pin is
the deploy gate, as today). The fleet is simply the set of repos that
carry `.operon/`; there is no central fleet repo. Shared deploy
credentials (the Cloudflare account token, held as org-level CI
secrets) are what make them one fleet in one account.

## 2. The manifest replaces the `workers/` directory

Today the colony repo hand-maintains one wrangler.jsonc per worker.
Most of that content is CHASSIS knowledge (binding topology, Durable
Object classes and their migration tags, entrypoints, compatibility
flags, assets blocks); only a small residue is colony knowledge. The
split inverts:

- **Operon owns `deploy/templates/`**: one wrangler template per
  worker, versioned with the code. A chassis change that adds a
  worker, a binding, or a DO migration ships its deployment config in
  the same reviewed diff. Migration tags in particular live here,
  because they track code history and a colony must never be able to
  forget one.
- **The project owns `colony.yaml`**: zone, account id, worker name
  prefix, policy values (caps, currencies, hold ceiling, allowance
  days), optional features (telegram), the agent list, and per-agent
  settings (state repo, hosts, cadence, model, doors). Nothing else.
- **The deploy renders**: templates plus manifest produce final
  configs in a build directory; deploy runs from there in the chassis
  deploy order (ops last). D1 bindings resolve by database NAME via
  the API at deploy time, so ids never live in a repo.

### Validation is the upgrade contract

The chassis ships a zod schema for the manifest, versioned with the
pin. `deploy --check` (already the CI gate) validates the project's
manifest against the NEW chassis's requirements:

- A bump that needs nothing new from the project deploys with no
  manifest change: this is the default and the point.
- A bump that introduces a required setting fails loudly, naming the
  missing key and its documentation, before anything deploys.
- Declared secrets are part of the schema: each template names the
  secrets its worker requires, and the check verifies PRESENCE by name
  through the gateway secrets API (labels ledgered, values never).

## 3. Isolation model

Each project deploys its own full set of workers under its prefix
(`operon-<project>-gatekeeper-*`), its own D1, its own Durable Object
namespaces (which follow the workers automatically), its own zone, its
own Access application at `ops.<zone>`. Projects share an account and
a chassis lineage and NOTHING else: no shared DO, no shared database,
no shared secret store. The blast radius of any compromise or bug
stays one project wide. Shared-runtime tenancy (projects inside one
set of workers) is explicitly out of scope; if the fleet ever grows
projects too small to deserve their own workers, this manifest is the
schema such a runtime would adopt.

## 4. Bootstrap

`operon bootstrap` (a chassis script, run from the project repo) turns
a fresh domain into a running project using the account-scoped
`CLOUDFLARE_API_TOKEN`:

1. Create or adopt the zone; DNS records; email routing for the
   agents' addresses.
2. Create the D1 database (named `operon-<project>`), the Access
   application for `ops.<zone>`, and the routes the templates expect.
3. Create agent state repos from the charter seeds if they do not
   exist.
4. Report the secrets the manifest declares but the workers lack, as a
   checklist; the operator sets them via the gateway secrets tools.
5. Deploy.

Idempotent: re-running converges and reports, never duplicates.

## 5. Naming

- `agentId` is unique WITHIN a project, enforced by manifest
  validation. Nothing keyed by agent id crosses a project boundary.
- Fleet-shared surfaces always render the qualified `project/agent`
  form: notification prefixes become `[project/agent]`, and inline
  decision buttons carry the project in their callback payloads so a
  press can never route to another project's gatekeeper.
- Command grammar: an unqualified name (`/tell prior ...`) resolves
  against the surface's project context (a console instance, a
  per-project Telegram group or forum topic). The qualified form
  (`/tell project/prior ...`) resolves absolutely and is required on
  any surface without a project context.
- GitHub bot accounts are globally named, so the convention includes
  the project (`<agent>-<project>-bot`).
- Public personas are brands: the system permits reuse across
  projects, and the operator should still avoid it, because
  counterparties bind reputation to the name.

## 6. Doors per agent

Whether an agent has a door (email, x, pay, till, vault, web, publish,
github, notify) becomes explicit policy instead of an accident of
which secrets exist:

- **Baseline** in the manifest: a `doors:` map per agent.
- **Runtime override** in a small scheduler-owned store, editable from
  the operator plane without a deploy, effective at the next wake.
- **Enforcement at wake wiring**: the scheduler consults baseline plus
  override and simply omits the URL and bearer for disabled doors. The
  porch answers `not_wired`, and the living help marks the door
  disabled, so the mind's guidance stays truthful with zero gatekeeper
  changes. Mid-wake emergencies use the existing kill switch; durable
  revocation is rotating that agent's bearer.
- **Operator surface with parity**: `agent_doors` (read) and
  `agent_door_set` (decision, ledgered) in the registry; a toggle
  matrix on the console Agents page. Every flip leaves an audit row.
- Granularity is door-level; per-subcommand policy is a compatible
  extension inside the same matrix if a need appears.

## 7. Secrets across the fleet

The DEFAULT posture is per-project values for every secret, because a
shared value extends that secret's blast radius fleet-wide by
definition: the §3 isolation claim is about infrastructure state, and
it cannot protect against a credential the operator has deliberately
made common. Sharing is therefore an explicit, per-secret opt-in in
the manifest, reserved for credentials that are inherently
account-wide anyway or whose duplication the operator judges worse
than their shared radius. The account-scoped Cloudflare API token is
the unavoidable case and is named for what it is: the fleet's
crown-jewel secret, scoped as narrowly as the platform allows and
first in line for rotation. Everything project-scoped (spend keys,
per-agent bearers, GitHub tokens, zone values) stays per-project,
always. The rotation-group machinery generalizes for the opted-in
shared secrets: a group's member list may span project prefixes, so
one rotation or `secrets sync` writes one value to every declared
worker through the gateway API, per project against its own pinned
schema (§9). Values never transit chat or logs, exactly as today.

## 8. The fleet gateway: one API and MCP plane

Per-project gateways multiply: an operator's tooling (a local model
over MCP, scripts, a future dashboard) should not need N connections
for N projects. The FLEET GATEWAY is one optional aggregator worker
behind its own single Access application:

- It exposes the SAME registry surface with one change: every tool
  gains a required `project` argument. One MCP connection, one tool
  list, all projects; REST mirrors it identically, so parity holds.
  (Prefixing tool names per project is rejected: it multiplies the
  tool list by the fleet size.)
- It resolves `project` to that project's gateway and forwards over
  HTTPS with a per-project Access SERVICE TOKEN. Enrollment is a
  config row plus one token, no redeploy; removal is revoking the
  token. Projects are opt-in.
- It is a PASSTHROUGH, not a validator, and it does not pretend one
  schema fits all pins. At enrollment (and on a refresh interval) it
  DISCOVERS each project's authoritative interface from that
  project's own `/openapi.json`. Its advertised MCP tool list carries,
  per tool, the schema from the newest enrolled pin as the working
  default, and two first-class tools make skew explicit:
  `fleet_projects` (every enrolled project with its chassis pin) and
  `fleet_tool_schema {project, tool}` (that project's authoritative
  schema for the tool). Each project's gateway remains the validation
  authority for its own pin (§9); per-project gateways remain the
  precise interface, the fleet gateway the convenient one.
- Audit identity survives aggregation: the operator's Access identity
  forwards in a header the downstream gateway records in its audit
  rows, trusted because the request arrived on that project's service
  token. A decision through the fleet plane ledgers as the operator,
  at the project, indistinguishable in accountability from a direct
  call.
- Blast radius, stated plainly: the fleet gateway holds a service
  token for every enrolled project, so its compromise is a fleet-wide
  operator-plane compromise. It sits in the crown-jewel tier beside
  the Cloudflare token; its per-project tokens are individually
  revocable, and enrollment being opt-in is the containment.

## 9. Version skew between projects

Projects pin the chassis independently, and the isolation model makes
that safe: every runtime artifact (workers, D1 schema, DO classes, the
wake image, the console assets) comes from the project's own pin and
deploys on its own. Two projects at different versions share an
account and nothing else, which is what makes CANARY BUMPS the normal
upgrade motion: bump a low-stakes project first, watch it, then roll
the rest.

The one discipline lives in fleet-level tooling: **no fleet operation
assumes a single chassis version.** Cross-project tools (secrets sync,
cross-prefix rotation, any future fleet dashboard) iterate projects
and use each project's OWN pinned scripts and manifest schema, never a
central copy at some other version. The only cross-version coupling
permitted at all is convention rather than code: the qualified
`project/agent` naming on shared surfaces, which is stable text with
no schema to drift.

## 10. Migrating a project between operon instances

Durable truth is portable by construction: agent memory is the state
repo (git), money is on-chain and follows the wallet key (a secret the
operator re-sets), history is chronicle D1 (export and import), and
secrets are re-set by manifest checklist. Durable Object state is
enumerable, and the runbook accounts for every consequential piece
rather than waving at it:

- **Vault** (agent-stored secrets, unrecoverable by design) and
  **spend state** (merchant tuples, active allowances, daily
  counters, outbox history): both covered by an operator-only sealed
  EXPORT and IMPORT tool pair in the registry. Losing tuples and
  allowances would fail safe (merchants re-hold once), but the tool
  exists so caps enforcement never resets: imported daily counters
  mean the migration day cannot double an agent's budget.
- **Pending work** must be zero at cutover, by the quiesce step:
  agents disabled, held payments and sends decided, outcome_unknown
  rows reconciled, in-flight rotations completed or aborted, channel
  and inbox messages pulled and acked by a final wake. Migration never
  proceeds with a nonzero pending set.
- **Disable and kill-switch state** re-asserts from the manifest and
  the runbook itself (agents come up disabled on the target and are
  enabled deliberately, one by one).
- **Ack cursors** re-deliver idempotently if not carried; the spend
  and vault export carries them anyway since it is already there.

The runbook: disable agents, drain and decide everything pending,
export D1 plus the sealed vault and spend export, stand up the target
from the same manifest and pin, re-set secrets with the same wallet
key, import, re-point at the same state repos, re-enable agent by
agent.

## 11. Out of scope

- Shared-runtime tenancy (see §3).
- Publishing the chassis as an installable package and prebuilt wake
  images; the submodule remains the distribution while operon is not
  public.
- Cross-project agent interaction of any kind.
- A unified multi-project console; each project's console stands
  alone, and a gateway picker in the console shell is the most this
  spec blesses.

## 12. Order of work

1. Manifest schema and template rendering in the chassis; `deploy
   --check` validation against the schema (the livevariant colony
   migrates first and its `workers/` directory is deleted).
2. Doors matrix: manifest baseline, scheduler wiring enforcement,
   registry tools, console toggles.
3. Bootstrap script, proven by standing up the operator's next real
   project end to end.
4. Fleet secrets: cross-prefix rotation groups and `secrets sync`.
5. The fleet gateway, once a second real project exists to justify
   it.
6. Vault and spend export and import tools; the migration runbook
   documented in DEPLOY.md.
