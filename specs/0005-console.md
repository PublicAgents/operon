# Spec 0005: The operator console and the tool registry

Status: draft. Builds on spec 0003 (the operator gateway, Access
verification, the audit doctrine) and spec 0004 (web door surfaces).
This spec covers step 6 of spec 0003 §9: the console UI on the gateway,
plus the API/MCP plane it rides on.

## 1. The problem

The operator plane serves JSON to three clients: Telegram, tail-wake,
and curl. Everything else the operator needs (reading ledgers, tailing
a wake, inspecting browser sessions, approving spend) means a terminal
and memorized paths. And each new client grows its own code path:
Telegram buttons call one shape, tail-wake another, curl a third.

Two requirements fix this shape permanently:

1. **A console**: a web UI on the ops gateway with all logs, live wake
   tails, browser sessions, channel messaging, approvals, and secrets.
2. **The parity rule**: everything the UI can do must be possible via
   the REST API and via MCP, from one shared implementation. A tool
   that exists in one surface exists in all three, mechanically.

## 2. The tool registry (the parity backbone)

One new package, `packages/ops-tools`, holds a registry of every
operator operation as data plus a handler:

- A `ToolDefinition` is `{name, title, description, input, output,
  readOnly, decision, handler(input, ToolContext)}`. Input and output
  are zod schemas. Handlers know nothing about HTTP, MCP, or React.
- `ToolContext` is the entire dependency surface: the gatekeeper Ops
  service bindings, the scheduler fetch + bearer, the chronicle D1,
  the audit writer, and the operator identity. Nothing ambient.
- The REST API is mounted by looping the registry: `POST
  /api/v1/<name-with-dashes>` per tool (reads included; POST bodies
  keep parameters out of URLs and access logs). The MCP server at
  `/mcp` registers the same loop (streamable HTTP, stateless, a fresh
  server per request). OpenAPI at `/openapi.json` and the generated
  SKILL document are emitted from the same schemas.
- Parity is enforced by tests, not discipline: registry == REST paths
  == MCP tool list == SKILL table, and CI fails on drift.
- The legacy `OPS_ROUTES` paths remain as thin aliases over the same
  handlers until Telegram buttons and tail-wake migrate, then die.

Dependency note: `ops-tools` takes `zod` and the MCP SDK, and the
console takes React. The zero-dependency bias stands for every other
Worker; these are the two justified exceptions, and the ops Worker
itself gains only the registry (which it already needs to serve).

## 3. Auth

Unchanged from spec 0003: Cloudflare Access, verified in-Worker on
every request, one trust domain. The console is a static SPA served by
the ops Worker behind the same Access application; same-origin fetches
carry the Access cookie. Programmatic clients (MCP, scripts, CI) use
Access service tokens on the same application, named per use.

Audit is unchanged in doctrine: decision tools write the intent row
first and refuse on audit failure; reads audit best-effort. The
operator identity in every row is the Access identity (email, sub, or
service token name).

## 4. Live push: WebSockets from the Durable Objects

The DOs that hold live state push it; clients do not poll.

- `WakeLog` accepts WebSocket subscribers (hibernation API). A client
  sends `{after: seq}`; the DO replays stored chunks past that seq and
  then streams appends live. A finished wake sends a `done` frame and
  closes. Wakes older than the DO's TTL fall back to a one-shot D1
  read.
- `Channel` broadcasts every appended entry (operator and agent) to
  subscribers; the console channel view and notification badge ride it.
- The ops Worker exposes `/ws/*` routes that verify Access, check the
  Origin header for cookie-authenticated upgrades, and pass the
  upgrade through the service binding to the owning DO (the umbilical
  already passes CDP WebSockets through a binding; same mechanism).
- tail-wake gains a WS mode and keeps polling as fallback.
- Query surfaces (events, ledgers, messages history) stay
  fetch-on-navigation: D1 has no push, and they are queries, not
  streams.

## 5. Telegram becomes one optional transport

The operator channel is already transport-neutral; Telegram is one
delivery path over it. The changes that make a Telegram-less colony
whole:

- The pure channel logic moves to `worker-kit`; the `Channel` DO stays
  hosted in the telegram Worker (a DO namespace cannot move without
  losing state, and the Worker keeps its name).
- Every notify is durably recorded in chronicle `messages` with kind
  `notify` (agent's id, or `system` for chassis alerts). That feed is
  the console's notification surface.
- `/notify` succeeds once recorded: `{ok, delivered, recorded}`.
  Telegram non-delivery is not an error when there is no Telegram.
  A notify that is neither delivered nor recorded still fails loudly.
- `notifyOperator` falls through to the public notify path only when
  the binding call failed or recorded nothing, so a recorded-but-
  undelivered notify is not double-appended.
- The Telegram secrets become optional in the deployment docs. The
  webhook, buttons, and chat commands are unchanged where configured.

## 6. Secrets from the operator plane

Worker secrets stay Cloudflare Worker secrets (spec 0003 blast-radius
table unchanged). What changes: the ops Worker can WRITE them via the
Cloudflare API, so rotation stops requiring a laptop.

- The ops Worker holds `CLOUDFLARE_API_TOKEN`, scoped to Workers
  Scripts edit on the account. It is the most powerful secret in the
  ops Worker; the scope is the control.
- Tools: `secret_set` (worker, name, value; the value is write-only,
  never echoed, never ledgered: labels ledgered, values never),
  `secret_list` (names only), `secret_rotate_group` (the rotate-tokens
  GROUPS fan-out table moves into shared chassis code; one logical
  bearer updates every worker/secret pair that must share it, value
  generated server-side and never returned).
- Rotation is SERIALIZED per group through a Durable Object
  (RotationGate, one instance per group): concurrent rotations cannot
  interleave two values over one group's members. Within a run, a
  failing member is retried with the same value; a member that
  exhausts its retries yields a rotation_incomplete report naming the
  written and failed halves. The gate keeps DURABLE resume state (the
  in-flight value plus the members still missing it, deleted the
  moment the group converges), so a re-run resumes with the SAME value
  over only the missing members: repeated transient failures can delay
  convergence but can never leave the group split across values. The
  pending value in the gate is the same value being written into
  Worker secrets, not a second credential, and it is the one sanctioned
  exception to "values are never stored"; a changed member list
  abandons the stale plan and starts fresh.
- The rotate-tokens CLI remains, refactored onto the same shared
  groups table, so rotate-coverage keeps pinning bearer coverage.
- A secret write creates a new Worker version (platform behavior); the
  console says so.
- External credential mints (the X OAuth PIN flow) stay CLI: they need
  a human browser session by nature.

## 7. The console

React + Vite SPA in `packages/console`, built to static assets, served
by the ops Worker (assets binding, SPA fallback for unmatched GETs
after Access verification). Views: agents (status, wake, enable,
disable), events explorer, ledgers, wakes with live tail, messages,
channel, approvals, web sessions, notifications, audit, secrets.

The console is a pure client of `/api/v1/*` and `/ws/*`: it contains
no logic a curl user would miss, by construction (the parity rule).

## 8. The console is a target (security model)

Everything the console renders is downstream of untrusted input: wake
transcripts are mind output and the mind reads the open web; channel
messages, ledger detail, email subjects, and session metadata are all
attacker-influenceable. The console runs in the operator's Access
session with approve/spend/secret authority. Rules, all mechanical:

- Untrusted strings render as text nodes only. The HTML-injection
  sinks (dangerouslySetInnerHTML and friends) are banned by lint in
  CI. No markdown rendering of agent content. ANSI escapes stripped.
- URLs in agent content are never live links; an explicit open
  affordance shows the full URL first, then opens in a new tab with
  noopener.
- Strict CSP on every response: default-src 'none', script/style/img/
  font/connect 'self' (plus the wss host), object 'none', base-uri
  'none', frame-ancestors 'none'; no inline scripts; no third-party
  origins, ever. Plus nosniff, no-referrer, deny framing, COOP/CORP,
  and Trusted Types where supported.
- Mutating calls require Content-Type application/json plus a custom
  header, and same-origin Sec-Fetch-Site/Origin for cookie-auth
  requests (CSRF). Service-token requests are exempt by construction.
- Provenance is visually hard-marked: agent output is labeled
  untrusted. Approval dialogs render only the gatekeeper's held record,
  never text quoted from messages; decisions confirm explicitly;
  secret and delete actions require typing the target name.
- The MCP/SKILL docs mark transcript/channel/detail fields untrusted
  so agent consumers inherit the same caution.

## 9. Order of work

1. Registry package + REST/MCP/OpenAPI/SKILL on the gateway, legacy
   paths as aliases.
2. Scheduler reads for the console: per-agent status, wake records.
3. WebSocket push: WakeLog, then Channel; ops /ws passthrough.
4. Telegram-optional notify + the notifications feed.
5. Secrets tools + shared rotation groups.
6. The console SPA over all of it.
7. Migrate Telegram buttons and tail-wake off the legacy aliases;
   delete the aliases.

## 10. Open decisions

1. Browser Run live-view (spec 0004 §6): spike-gated; ships when the
   CDP command is verified.
2. Whether the notifications feed later moves from chronicle messages
   to its own DO with push; the console abstracts the source either
   way.
