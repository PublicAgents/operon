# Spec 0006: The fleet (many projects, one operon)

Status: draft. Extends spec 0005, whose Phase 2 note promised this
design after living with the Phase 1 console. The goal, in the
operator's words: starting a new project should boil down to adding a
domain, adding git repos, and writing the goal and the charters, with
one Cloudflare account, one chassis lineage, and one upgrade motion
per project (independently pinned; see §10).

## 1. The unit: `.operon/` in any repo

A PROJECT is a repository carrying an `.operon/` directory, the way
`.github/` marks a repo as CI-aware:

```
.operon/
  operon.yaml        the manifest: everything project-specific
  charters/          seed charters, one per agent (copied into the
                     agent's state repo at bootstrap, authored there
                     afterward: the state repo remains the living copy)
```

The manifest's first required field is `project:`, and it is THE
project identity in every layout: never derived (a repo basename is
neither unique nor stable), it alone seeds every account-level
resource name (worker prefix `operon-<project>-*`, the D1 database)
and every qualified agent name. Bootstrap refuses to proceed when
resources under that prefix already exist and belong to a different
repo: collisions are a hard error at the door, not a surprise at
deploy.

A repo may also host SEVERAL projects, as
`.operon/projects/<name>/{operon.yaml, charters/}`. The directory
name MUST equal the manifest's `project` field, validation refuses a
mismatch, and `--project <name>` therefore selects by the one
identity there is; the deploy CLI acts on every project it finds when
no selection is given. Projects sharing a repo share its chassis pin
and therefore upgrade together, so co-locate projects you want in
lockstep and give a project its own repo when it should pin
independently (the §10 canary pattern needs that).

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
- **The project owns `operon.yaml`**: zone, account id, worker name
  prefix, policy values (caps, currencies, hold ceiling, allowance
  days), optional features (telegram), the session's egress policy
  (`egress:`: the named `proxies` and the host map `proxy` of spec
  0004 §8, credentials named never valued, and the `blocklist` of spec
  0004 §5, one list for the browser door and the container forwarder),
  the
  agent list, and per-agent settings (state repo, hosts, cadence,
  model, doors). Nothing else.
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
own zone. Projects share an account, a chassis lineage, and the
CONTROL PLANE (§9) and nothing else: no shared DO, no shared
database, no shared secret store. The blast radius of any compromise or bug
stays one project wide. Shared-runtime tenancy (projects inside one
set of workers) is explicitly out of scope; if the fleet ever grows
projects too small to deserve their own workers, this manifest is the
schema such a runtime would adopt.

## 4. Bootstrap

`operon bootstrap` (a chassis script, run from the project repo) turns
a fresh domain into a running project using the account-scoped
`CLOUDFLARE_API_TOKEN`:

1. Create or adopt the zone; DNS records; email routing: one rule per
   agent address (`<first host>@<zone>`) to the email Gatekeeper, the
   catch-all forwarding to the operator's `forwardAgentEmailsTo`
   (verified destination addresses; bootstrap creates the missing ones
   and waits for the click). A catch-all pointed at the Gatekeeper
   would reject every address that is not an agent's.
2. Create the D1 database (named `operon-<project>`) and the routes
   the templates expect.
3. Create agent state repos from the charter seeds if they do not
   exist.
4. Report the secrets the manifest declares but the workers lack, as a
   checklist; the operator sets them via the gateway secrets tools.
5. Deploy the project, then enroll it in the control plane and
   redeploy the plane so its bindings exist (§9).

Idempotent: re-running converges and reports, never duplicates.

## 5. Deploys never kill running wakes

The image rollout terminating live containers has cost real wakes
(unjournaled work, an interrupted negotiation). The fleet deploy makes
that structurally impossible instead of a timing gamble:

- **Every deploy DRAINS**: image rebuilds are not reproducible (base
  layers and distro packages drift under byte-identical sources), so
  "this deploy rolls no containers" is unprovable from the repo, and a
  wrong guess kills wakes. The deploy therefore always pauses new wake
  starts (a paused cron fires again at its next cadence; nothing in
  flight is touched), waits for the current-wake set to be empty on
  two consecutive polls, bounded by the colony's maximum wake length,
  deploys, and resumes unconditionally, failing loudly if even the
  resume fails. An idle fleet drains in seconds; a busy one draining
  is the entire point. The pause is held by a per-deploy token so
  overlapping deploys refuse each other rather than releasing each
  other's pause, and the launch path re-checks the pause after
  registration so no preparing wake can slip past the quiet check. The
  entrypoint's existing SIGTERM grace (persist, then die) remains the
  last line, not the plan.
- `--force` exists for emergencies, does not wait, and says plainly in
  its output which wakes it is about to kill.
- Fleet-wide bumps compose this per project: each project drains and
  rolls independently, so one project's long wake never blocks
  another's deploy.

## 6. Naming

- `agentId` is unique WITHIN a project, enforced by manifest
  validation. Nothing keyed by agent id crosses a project boundary.
- Fleet-shared surfaces always render the qualified `project/agent`
  form: notification prefixes become `[project/agent]`, and inline
  decision buttons carry the project in their callback payloads so a
  press can never route to another project's gatekeeper.
- Command grammar: an unqualified name (`/tell prior ...`) resolves
  against the surface's project context (the console's selected
  project, a per-project Telegram group or forum topic). The qualified
  form
  (`/tell project/prior ...`) resolves absolutely and is required on
  any surface without a project context.
- GitHub bot accounts are globally named, so the convention includes
  the project (`<agent>-<project>-bot`).
- Public personas are brands: the system permits reuse across
  projects, and the operator should still avoid it, because
  counterparties bind reputation to the name.

## 7. Doors per agent

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

## 8. Secrets across the fleet

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
schema (§10). Values never transit chat or logs, exactly as today.

## 9. The control plane: one console, one API, one MCP, one CLI

There is ONE operator plane for the whole fleet, not one per project.
The control plane is the ops worker generalized: it already speaks to
gatekeepers exclusively over binding-only `Ops` entrypoints, so the
fleet version is the same worker with SERVICE BINDINGS to every
enrolled project's gatekeepers. No service tokens between planes, no
per-project Access applications, no per-project consoles: those
concepts retire.

- **`project` is a first-class argument on every registry tool.** The
  control plane's `ToolContext` resolves `(project, gatekeeper)` to
  the right binding. A configured DEFAULT PROJECT fills the argument
  when omitted on REST and MCP calls, and preselects the console's
  project selector; audit rows always record the resolved project
  explicitly, never the word "default".
- **One Access application** at the control plane's hostname guards
  the console, the API, and `/mcp`. One MCP connection and one CLI
  configuration control the whole fleet. The console gains a project
  selector in the shell; a selected project is the resolution context
  for unqualified names (§6), and live surfaces (wake tails, channel)
  ride the same `/ws/*` binding passthrough as today, per project.
- **Enrollment is config, deployment is rendered**: the control plane
  is fleet-level infrastructure with its own small manifest (enrolled
  projects, the default project, its hostname). Service bindings are
  declared at deploy time, so enrolling a project re-renders and
  redeploys the control plane; `operon bootstrap` for a new project
  ends by doing exactly that. Removal is the same motion in reverse.

  Decided 2026-09-02: the plane is HOSTED by one project rather than
  given a repo of its own. The hosting project's manifest carries a
  `control:` block (`default`, `projects: [{ project, zone,
  workerPrefix }]`); its ops worker keeps its bare bindings for the
  host and gains `<PROJECT>__<BINDING>` service bindings to every
  enrolled project's gatekeepers and scheduler, a `WAKE_TRIGGER_TOKEN_
  <PROJECT>` bearer per enrolled project, and the vars `HOST_PROJECT`,
  `HOST_ZONE`, `DEFAULT_PROJECT`, `PROJECTS`. The plane therefore
  upgrades with the host's pin, which is the canary order anyway (the
  host first, then the rest). The registry adds an optional `project`
  to every tool in one place; `fleet_projects` lists the fleet; an
  unknown project is refused by name (`unknown_project`), never
  defaulted.
- **Version skew across bindings is governed by a compatibility
  contract, not hope.** Registry inputs and gatekeeper `Ops` routes
  evolve ADDITIVELY within a control-plane major: new tools and new
  OPTIONAL fields only, and gatekeepers ignore unknown optional
  fields. The control plane deploys from its own pin, kept at or
  ahead of the newest enrolled project, and validates with its own
  registry; a tool or field an older project's pin lacks fails with a
  named error carrying both pins, never a silent mismatch. A BREAKING
  registry change declares a minimum project pin, and the control
  plane refuses calls to projects below that floor by name.
  `fleet_projects` reports each enrolled project's pin and any floors,
  as a registry tool like any other.
- **Blast radius, stated plainly**: one Access application now grants
  fleet-wide operator authority, which is the point and the price. The
  control plane sits in the crown-jewel tier beside the Cloudflare
  token; per-project containment is that bindings are explicit and
  removable per project by redeploying the plane.

## 10. Version skew between projects

Projects pin the chassis independently, and the isolation model makes
that safe: every project runtime artifact (workers, D1 schema, DO
classes, the wake image) comes from the project's own pin and deploys
on its own; the console ships with the control plane at ITS pin (§9).
Projects at different versions interact with nothing but the control
plane, which is what makes CANARY BUMPS the normal upgrade motion:
bump the control plane first, then a low-stakes project, watch it,
then roll the rest.

The one discipline lives in fleet-level tooling: **no fleet operation
assumes a single chassis version.** Cross-project tooling (secrets
sync, cross-prefix rotation, the control plane itself per §9) iterates
projects and respects each project's OWN pinned scripts and manifest
schema, never a central copy at some other version. The only cross-version coupling
permitted at all is convention rather than code: the qualified
`project/agent` naming on shared surfaces, which is stable text with
no schema to drift.

## 11. Migrating a project between operon instances

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

## 12. Out of scope

- Shared-runtime tenancy (see §3).
- Publishing the chassis as an installable package and prebuilt wake
  images; the submodule remains the distribution while operon is not
  public.
- Cross-project agent interaction of any kind.

## 13. Order of work

1. Manifest schema and template rendering in the chassis; `deploy
   --check` validation against the schema (the reference colony, livevariant,
   migrates first and its `workers/` directory is deleted).
2. Doors matrix: manifest baseline, scheduler wiring enforcement,
   registry tools, console toggles.
3. Bootstrap script, proven by standing up the operator's next real
   project end to end.
4. Fleet secrets: cross-prefix rotation groups and `secrets sync`.
5. The control plane generalization: project argument through the
   registry, the enrollment manifest and binding rendering, the
   console selector, the default project.
6. Vault and spend export and import tools; the migration runbook
   documented in DEPLOY.md.
