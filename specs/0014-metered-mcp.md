# Spec 0014: Metered upstream servers: a fleet-wide budget for paid tools

Status: proposed. Builds on spec 0008 §5 (the mcp Gatekeeper and its
two trust tiers), spec 0002 (the spend door's accounting shape) and
spec 0009 (no public hostnames on Gatekeepers, with the one exception
this spec adds).

## 1. The problem

Some of the most useful upstream MCP servers bill per call: a web
search costs cents, a long-running research task costs dollars, and a
vendor's credit balance runs out on the vendor's clock, not ours.
Today the mcp Gatekeeper proxies every granted tool call and ledgers
it, but nothing caps what the fleet spends, an agent cannot learn what
is left before it plans a wake around forty searches, and a task that
answers by webhook has nowhere to answer to: the Gatekeepers have no
public hostnames, by construction. The operator's requirement is
plain: a monthly ceiling per vendor, shared by every agent, and every
agent told how much of today's share remains.

## 2. The rule

A remote server definition (spec 0008 `type: http` or `type: portal`)
may carry a budget and a webhook flag:

```yaml
mcp:
  search:
    type: http
    url: https://search.example/mcp        # the vendor is named in the colony, never here
    auth: bearer
    tools: [web_search, web_fetch]
    budget:
      monthlyUsd: 120
      perCall:                             # the operator's price list, in USD per call
        web_search: 0.02
        web_fetch: 0.01
  tasks:
    type: http
    url: https://tasks.example/mcp
    auth: bearer
    tools: [createDeepResearch, createTaskGroup, getStatus, getResultMarkdown]
    budget:
      monthlyUsd: 80
      perCall:
        createDeepResearch: 2.00
        createTaskGroup: 1.00
      free: [getStatus, getResultMarkdown]  # reads that cost nothing; named, never assumed
    webhook:                             # the provider's contract, named here, never in code
      createTools: [createDeepResearch, createTaskGroup]
      argument: webhook                  # the create call's parameter that takes {url, event_types}
      events: [task_run.status]
      runIdPath: run_id                  # where the create result carries the run id (dotted path)
      signature:
        header: X-Signature
        scheme: hmac-sha256-hex          # over the raw body; hmac-sha256-base64 and ed25519-hex also known
        timestampHeader: X-Timestamp     # optional; when named, joined to the body as "<ts>.<body>"
```

- **The cap is the month's, spread over its days.** Each server's
  meter keeps the month's spend and today's. Today's allotment is
  fixed once, at the first call of each UTC day:
  `allotmentToday = (monthlyUsd - spentBeforeToday) / daysLeftIncludingToday`,
  where `spentBeforeToday` excludes today, so today's own calls never
  shrink today's share (they are counted once, against it). An unspent
  day flows forward; a heavy day cannot borrow from tomorrow; on the
  month's last day the allotment is the whole remainder. A call whose
  price would push `spentToday` over `allotmentToday` refuses
  `mcp_budget_exhausted`, naming the price, what remains today, and
  when the day rolls (00:00 UTC).
- **Every tool is priced, free, or refused.** With a `budget` present,
  a tool that appears in neither `perCall` nor `free` refuses
  `mcp_tool_unpriced` before any upstream call. Prices are the
  operator's statement; the vendor's dashboard is the truth, and the
  meter is a governor on counts, not an invoice. The manifest comment
  says so where the numbers are.
- **The budget is the server's, shared by every agent that holds the
  grant.** One meter per server per project. A cap that must span two
  projects is the operator's arithmetic: each project's `monthlyUsd`
  set so the sum is the vendor ceiling, stated in the manifests.
- **Reserve before, settle after; ambiguous is billed.** The
  Gatekeeper reserves the price before it proxies the call and settles
  it when the upstream answers. A reservation is refunded only when the
  provider provably did no work: the connection was refused or the
  request failed before its body was sent, or the provider answered
  401, 402 or 403 (spec 0008's `mcp_upstream_auth`). A timeout, a lost
  or truncated answer, a response-boundary refusal, a 5xx: all keep
  the reservation, because the vendor may have billed. The meter
  therefore never undercounts; it can only overcount, and the
  operator's `mcp_budget_reset` is the correction after reading the
  vendor's dashboard. The spend door's outbox pattern (spec 0002
  §2.2), not "call then count".
- **The agent is told.** At wake start the container reads each
  granted metered server's remaining figure and prints
  `mcp budgets: search $3.90 today (about 195 searches), tasks $2.60
  today`; the capabilities answer carries the same numbers; the living
  help's MCP section says that a refusal names what is left and when
  it resets; `operon mcp budget` re-reads them mid-wake. A mind plans
  its wake against a number, never against a surprise.
- **Nothing here is enforced on the vendor's side.** A 402 from the
  upstream (credits gone on the vendor's clock) is `mcp_upstream_auth`
  with the vendor's detail, ledgered like any upstream failure, and the
  operator hears it through the notify door once per wake, not per call.

## 3. Webhooks: where an asynchronous answer lands

A task server answers hours later, to a URL. Spec 0009 gives
Gatekeepers no public hostnames; the Telegram Gatekeeper is the one
precedent, and it holds its webhook on a dedicated host with a secret
the sender proves. This spec adds one host of the same kind:
`hooks.<zone>`, on the mcp Gatekeeper, serving only
`POST /webhook/<server>` for servers that declare a `webhook` block.
The block is the provider's contract, stated by the operator in the
manifest: which tools create runs, the argument that takes the
callback, the events, where the run id sits in the create result, and
how the signature is made. The Gatekeeper implements a small set of
signature schemes by name and refuses an unknown one at validation
(`mcp_webhook_scheme_unknown`); a provider that fits none of them is a
chassis change, never an unverified webhook.

- **Verified or refused.** The per-server secret
  `MCP_<NAME>_WEBHOOK_SECRET` verifies the signature named by the
  block, over the raw body (joined to the timestamp header when one is
  named), compared in constant time; an unverified request is
  `401 mcp_webhook_unverified` and ledgered with the source address,
  never read further. A timestamp older than five minutes is refused
  the same way (replay). The Gatekeeper injects the public URL and the
  events into each `createTools` call's `argument` before proxying it,
  overwriting whatever the mind passed there, so a mind never chooses
  the URL and never learns the secret.
- **Attributed at creation.** The Gatekeeper reads the run id from the
  create result at `runIdPath` and records `run id -> agentId` (30
  days); a create result with no id at that path is proxied unchanged
  and ledgered `mcp_webhook_run_unattributed`, so a wrong path is
  visible on the first call. A webhook for an unknown run is
  `mcp_webhook_unknown_run`, ledgered, dropped; a webhook for a known
  run is stored once per (run id, event) and a repeat is acknowledged
  without a second delivery.
- **Delivered at the next wake, as inbox content.** The verified
  payload is stored for the agent and pulled by the container at wake
  start into `inbox/mcp/<server>/<run id>.md`, through the same
  sanitizing pull the email inbox uses (spec 0001: inbound is data,
  swept, chassis-written). The wake-start summary says `N task
  results landed in inbox/mcp/`. The mind may also poll the server's
  own status tool; the webhook saves it the polling, it does not
  replace it.

## 4. The wires

- **core** (`roster.ts`): `budget` and `webhook` keys on `http` and
  `portal` defs; `budget.monthlyUsd` positive, `perCall` prices
  non-negative, `free` names disjoint from `perCall`; `webhook`
  requires `createTools` (each a known tool of the def), `argument`,
  `events`, `runIdPath` and a `signature` with a known `scheme`; a
  webhook block without a budget is allowed (metering and answering
  are separate facts). Unknown keys refuse by name.
- **gatekeeper-mcp**: a `Meter` Durable Object per server holding
  `{month, spentUsd, day, spentTodayUsd, reservations}`; `reserve`,
  `settle`, `refund`, `remaining` as one-turn transitions; the proxy
  calls `reserve` before `callUpstreamTool` and `settle`/`refund`
  after; `GET /mcp/<name>/budget` (umbilical-authenticated, the
  calling agent's grant checked) answers the remaining figures; the
  `hooks.<zone>` route with the HMAC check and the run-id table; the
  Ops entrypoint gains `mcp_budgets` (read-only, every server's month
  and day) and `mcp_budget_reset` (a decision, audited, for the
  operator who topped up credits mid-month).
- **container**: `capabilities().mcpBudgets`, the wake-start line, the
  REGISTRY-style help lines in the MCP section, `operon mcp budget`,
  the inbox pull extended to `inbox/mcp/`.
- **fleet**: the `hooks.<zone>` custom domain rendered only when some
  server declares `webhook: true`; the secrets checklist names
  `MCP_<NAME>_WEBHOOK_SECRET` beside `MCP_<NAME>_TOKEN`.
- **ops-tools, console**: `mcp_budgets` on the registry (UI = API =
  MCP), a budgets block on the fleet page: month spent, today
  remaining, last refusal.
- **ledger**: `mcp_metered {agentId, server, tool, usd, remainingTodayUsd}`,
  `mcp_budget_exhausted`, `mcp_tool_unpriced`, `mcp_webhook_received`,
  `mcp_webhook_unverified`, `mcp_webhook_unknown_run`,
  `mcp_webhook_run_unattributed`.

## 5. Refusals and invariants, each with a test

- `mcp_budget_exhausted`: today's allotment would be exceeded; the
  detail names price, remaining and the reset time.
- `mcp_tool_unpriced`: a budgeted server's tool with no price and no
  `free` listing; refused before the network.
- `mcp_webhook_unverified` (bad signature, stale timestamp),
  `mcp_webhook_unknown_run`, `mcp_webhook_run_unattributed`,
  `mcp_webhook_scheme_unknown` (at validation).
- The daily allotment is fixed at the day's first call from the spend
  before that day; a day's own calls never shrink it; it never exceeds
  the month's remainder and on the last day equals it. A month of
  daily spending to the allotment lands exactly on `monthlyUsd`.
- A reservation is refunded only for a refused connection, an unsent
  body, or a 401/402/403; a timeout, a 5xx and a lost answer keep it.
- A repeated webhook (same run id and event) is delivered once.
- Two agents calling at once cannot both take the last cent (the
  meter is one Durable Object turn).
- The secret and the webhook URL never appear in a tool result, a
  ledger row, or the mind's arguments.
- The remaining figure the container prints equals the meter's answer
  at that instant, and a refusal a second later names the same number.

## 6. Order of work

1. This spec. 2. core keys and tests. 3. the Meter and the reserve
path in gatekeeper-mcp, with the mock upstream priced. 4. the budget
read, capabilities, help, wake-start line, cli verb. 5. ops tool and
console block. 6. webhooks: host, HMAC, run table, inbox delivery.
7. The reference colony names its vendor, prices and ceilings in its
manifest (a colony change; the chassis never names a vendor), with
the two projects' `monthlyUsd` summing to the operator's ceiling.
