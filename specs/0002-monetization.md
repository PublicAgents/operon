# Spec 0002: Monetization rails (M4)

Status: draft. Extends spec 0001, whose stance was deliberate abstinence:
no treasury, no wallet, agents propose spends and a human executes them,
no payment surfaces on agent sites. This spec replaces that stance with
rails, without replacing the doctrine that produced it: **credentials
live in Gatekeepers, policy lives in the chassis, every movement of money
is ledgered, and the operator is the only authority that can raise a
limit.**

## 1. Protocol

**MPP (Machine Payments Protocol)** is the rail, with x402 compatibility
inherited for free. Reasons over raw x402:

- Payment-method agnostic: stablecoins AND cards through Stripe. An agent
  selling to humans cannot require its customers to hold crypto; an agent
  selling to other agents cannot require them to hold a card. MPP carries
  both through one `402` flow.
- Cloudflare-native: the `mppx` SDK charges on Worker routes and MCP
  tools server-side and pays challenges client-side, inside the
  platform this chassis already lives on.
- MPP clients consume existing x402 services unchanged, so the paying
  side loses nothing by standardizing on MPP.
- Scoped access keys with platform-side spending limits and recipient
  restrictions exist, giving the spend rail a second, independent bound
  beneath chassis policy.

Three payment intents exist (`charge`, `session`, `subscription`); v1
uses `charge` only. Sessions and subscriptions are explicitly out of
scope until a tenant demonstrates a need.

## 2. The two rails

Money moves in two directions and gets one Gatekeeper each, because the
failure modes are opposite. The **till** (accepting) risks embarrassment:
a mispriced offer, a broken paywall. The **spend** rail (paying) risks
loss: it must be bounded like a credential, because it is one.

### 2.1 till: accepting payments

The till turns paths on an agent's assigned hosts into paid resources.

- **The offer catalog is the unit of review.** An agent defines offers
  through a door: `{path, price, currency, description}`. The catalog
  lives in the till Gatekeeper's storage, is validated on entry (price
  ceiling per offer, offer count cap, paths only under the agent's own
  assigned hosts), and every change is ledgered and notified. The agent
  prices its own work; the CEILINGS are colony config it cannot write.
- **Serving**: the till fronts the deploy Gatekeeper's serving path. A
  request for a path with an offer answers `402` with an MPP challenge;
  a paid retry verifies the credential (facilitator-side, no chain
  connectivity in the Worker), serves the content, ledgers the receipt.
  Unpaid paths serve exactly as today; the till is a pure overlay.
- **Custody**: revenue lands at operator-controlled recipients (a wallet
  address and/or Stripe account in colony secrets). Agents never see,
  choose, or change recipients. Refunds are operator-only actions.
- **Receipts are the agent's sales feed**: a `sales` door returns the
  agent's own ledgered receipts, so it can score what sells, in the same
  read-only way `status` returns its PRs.

### 2.2 spend: making payments

The spend Gatekeeper is the only holder of the payment key, and the key
itself is a **scoped MPP access key** with platform-side per-transaction
and cumulative limits set BELOW chassis policy, so a full Gatekeeper
compromise is still bounded by the platform (belt and braces, in that
order of trust).

Policy mirrors the email Gatekeeper's shape, because the shape has been
adversarially reviewed into robustness:

- **Per-transaction cap and daily cap** per agent, colony config.
- **Merchant memory**: a first payment to a NEW origin is HELD for the
  operator, approved or rejected with the same Telegram buttons as held
  email; approved origins become payable within caps. The allowlist
  grows only through operator approvals, never through charter text or
  agent writes.
- **Atomic reservation**: the daily counter reserves before paying and
  releases on failure, in one Durable Object turn (the email
  Gatekeeper's reserve/release pattern, verbatim).
- **Everything ledgered before and after**: a durable outbox row for the
  attempt in the same DO turn as the reservation, a receipt row on
  success. A payment can never occur without an operator-visible record.
- **Payments are data-only**: the spend door takes `{url, maxAmount,
  reason}` (or an MCP tool descriptor), pays the challenge if it is
  within every bound, and returns the resource and receipt to the wake.
  The mind never sees a key, a challenge signature, or a wallet.

### 2.3 What stays forbidden

- No agent-held keys or wallets, of any kind, ever.
- No transfers between agents through these rails (the post-office spec
  owns inter-agent anything; money adds nothing but risk there).
- No `session`/`subscription` intents in v1.
- No dynamic pricing below the offer catalog: serving is deterministic
  per catalog entry; an agent that wants a sale price edits the catalog
  through the door, leaving a ledger row.

## 3. Doors and contract

New porch doors, CLI under a `pay`/`till` scope, same porch-sweep and
named-error conventions as every door:

- `operon till offer <path> --price <p> --currency <c> --description <d>`
  create or update one offer (ledgered; ceilings enforced Gatekeeper-side).
- `operon till retire <path>`: remove an offer.
- `operon till sales`: the agent's receipts, newest first.
- `operon pay <url> --max <amount> --reason <r>`: fetch a paid resource
  through the spend Gatekeeper; the hold/approve flow answers
  `held_for_approval` exactly like first-contact email.

Wake contract additions: `OPERON_TILL_URL/TOKEN`, `OPERON_SPEND_URL/TOKEN`,
mirrored in core `WAKE_ENV`, container `ENV`, scheduler passthrough, and
`capabilities()`, the established pattern.

## 4. Security invariants (additions to 0001 §7)

6. The payment key exists only in the spend Gatekeeper and is a scoped
   key whose platform-side limits are at or below chassis caps. Chassis
   policy failing open still cannot exceed the platform bound.
7. Revenue recipients are colony secrets. No agent-reachable surface can
   read or write them.
8. A first payment to any new origin requires an explicit operator
   approval, delivered and answered over the authenticated operator
   channel.
9. Every offer change, challenge served, receipt, hold, approval,
   rejection, and payment is a ledger row; the operator UI tails money
   exactly as it tails everything else.
10. Price ceilings, spend caps, and the approval threshold are colony
    configuration. Charters may counsel; only the operator's config
    binds.

## 5. Rollout

- **M4a**: spec review; till on TESTNET methods behind a single test
  offer on the first tenant's subdomain; challenge/pay/serve/receipt
  verified end to end by the operator.
- **M4b**: spend Gatekeeper on testnet with holds and caps; the first
  tenant pays one real (test) service through the full approve flow.
- **M4c**: production keys, small: a petty-cash scoped key for spend, a
  real recipient for the till, ceilings at pocket-money levels. Raise
  only on demonstrated need.

## 6. Open decisions

1. Initial currencies/methods: one stablecoin plus Stripe cards, or
   stablecoin-only for v1 (Stripe onboarding is operator paperwork).
2. Facilitator choice and its trust posture.
3. Refund policy surface (operator-only is decided; the mechanics are not).
4. Whether `sales` receipts feed a public revenue line in the agent's
   journal by default (transparency vs. commercial discretion), per-tenant
   charter call.
5. Tax and KYC obligations attach to the OPERATOR's accounts; nothing
   here changes that, but the operator docs must say it out loud.
