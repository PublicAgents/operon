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
    webhook: true
```

- **The cap is the month's, spread over its days.** Each server's
  meter keeps the month's spend and today's. Today's allotment is
  `(monthlyUsd - spentThisMonth) / daysLeftInMonth`, computed in UTC
  at each call, so an unspent day flows forward and a heavy day
  cannot borrow from tomorrow. A call whose price would push today's
  spend over today's allotment refuses `mcp_budget_exhausted`, naming
  the price, what remains today, and when the day rolls (00:00 UTC).
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
- **Reserve before, settle after.** The Gatekeeper reserves the price
  before it proxies the call and settles when the upstream answers; an
  upstream error refunds the reservation, a lost answer keeps it (a
  call the vendor may have billed is never given back). The spend
  door's outbox pattern (spec 0002 §2.2), not "call then count".
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
`POST /webhook/<server>` for servers declared `webhook: true`.

- **Verified or refused.** The per-server secret
  `MCP_<NAME>_WEBHOOK_SECRET` verifies the vendor's HMAC signature on
  the raw body; an unverified request is `401 mcp_webhook_unverified`
  and ledgered with the source address, never read further. The
  Gatekeeper passes the public URL and the secret to the upstream at
  task creation by rewriting the `createXxx` call's arguments (the
  `webhook` parameter), so a mind never learns the secret and never
  chooses the URL.
- **Attributed at creation.** When a create-tool's result carries a
  run id, the Gatekeeper records `run id -> agentId` (30 days). A
  webhook for an unknown run is `mcp_webhook_unknown_run`, ledgered,
  dropped.
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
  non-negative, `free` names disjoint from `perCall`; a `webhook: true`
  without a `budget` is allowed (metering and answering are separate
  facts). Unknown keys refuse by name.
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
  `mcp_webhook_unverified`, `mcp_webhook_unknown_run`.

## 5. Refusals and invariants, each with a test

- `mcp_budget_exhausted`: today's allotment would be exceeded; the
  detail names price, remaining and the reset time.
- `mcp_tool_unpriced`: a budgeted server's tool with no price and no
  `free` listing; refused before the network.
- `mcp_webhook_unverified`, `mcp_webhook_unknown_run`.
- The daily allotment never exceeds the month's remainder; on the
  month's last day it equals it.
- A reservation outlives a lost upstream answer and is refunded only
  by an upstream error.
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
