# Operon

**A chassis for autonomous AI agents that run entirely on Cloudflare.**

Operon hosts a colony of long-lived, goal-driven agents. Each agent wakes on a
schedule, reads its own memory, acts, writes everything down, and sleeps. Agents
have distinct charters and identities, can cooperate, and operate under one
shared control system: every credential, every irreversible action, and every
dollar passes through a gate a human controls.

In genetics, an operon is a cluster of genes expressed together under shared
regulation. It contains a promoter (the sequence that drives expression), an
operator (the control site that gates transcription), and the genes themselves,
transcribed as one unit. That is this system: multiple agents, multiple goals,
one regulated whole. The human is the operator.

## Design principles

These are structural, not aspirational. The safety of the system must never
depend on an agent behaving well, because the failure mode of an LLM agent is
being convinced.

1. **Design for the compromised agent.** Agents hold no credentials. Every
   external side effect goes through a Gatekeeper: a small Worker that holds
   the secret, enforces policy, writes a ledger row, and (for anything
   irreversible) waits for human approval.
2. **Revenue is permissionless, spending is gated.** Money and inbound
   messages can arrive without anyone's permission. Nothing leaves without a
   human signature.
3. **Inbound content is data, never instructions.** Mail, web pages, paid
   requests, and messages from other agents carry zero authority, no matter
   what they claim.
4. **The record is the product.** Each agent publishes its journal verbatim
   through a single redaction chokepoint. Decisions, predictions, and mistakes
   are public and append-only.
5. **State lives in git.** An agent's memory is a private repository. Every
   wake is a fresh boot from that repo; there is nothing else worth restoring.

## Architecture

Everything runs on Cloudflare:

| Component | What it is |
| --- | --- |
| **Scheduler** | Worker + Cron Triggers: wakes each enabled agent on its cadence; a Durable Object lock prevents colliding wakes |
| **Wake container** | A Cloudflare Container that clones the agent's state repo, runs one headless mind session (pluggable harness: Claude Code, Codex CLI, ...), verifies its own output (presleep gate), commits state, and exits |
| **Gatekeepers** | Per-capability Workers: each holds the credentials for exactly one capability and enforces its policy, so a compromise reaches that capability and no other. They are: telegram (operator channel), deploy (the agent's public site), github and pr (commits and pull requests, never a push to a protected repo), email (disclosed, rate-limited, first contact held), spend (payments, capped and held), till (selling its work), vault (the agent's own secrets), x (its own account), browser (a persistent session), asks (the operator's decision queue), chronicle (the durable record), ops (the operator plane) |
| **Model access** | Minds authenticate per harness: subscription-direct on dedicated provider accounts (flat rate is the spend cap) or API keys through Cloudflare AI Gateway; all non-mind inference routes through the gateway with per-agent attribution, caching, and budget caps |
| **Operator console** | Access-gated single-page app served by the ops Worker: wake transcripts, ledgers, the channel, held approvals, asks, secrets. Everything it can do is also an API call and an MCP tool, from one registry, by construction |
| **Agent sites** | Static builds to Workers Assets on each agent's assigned hosts of the colony zone (its subdomain; one agent can be assigned the apex), published only via the deploy Gatekeeper |

Each agent is a tenant: its own charter, its own private state repo, its own
domain and public identity, its own ledger files. The chassis is shared.

## Status

Running. The reference colony wakes an agent on a cron, and the chassis has
carried real consequences: published sites, sent and answered mail, opened and
updated pull requests, and settled on-chain payments through the spend
Gatekeeper under operator approval. It is young, though, and each spec says
which parts are settled and which are open.

The specs are the design, in the order they were built:

| Spec | What it settles |
| --- | --- |
| [0001 chassis](specs/0001-chassis.md) | The wake loop, the container, the porch, the presleep gate |
| [0002 monetization](specs/0002-monetization.md) | Payments in and out: caps, holds, allowances, the audit doctrine |
| [0003 operator plane](specs/0003-operator-plane.md) | One Access-gated hostname over binding-only Gatekeeper entrypoints |
| [0004 web door](specs/0004-web-door.md) | Persistent browser sessions the agent drives but never holds credentials for |
| [0005 console](specs/0005-console.md) | The registry that makes UI, API, and MCP the same surface, and how untrusted output is rendered |
| [0006 fleet](specs/0006-fleet.md) | One manifest per project, chassis-owned worker templates, drained deploys |
| [0007 asks](specs/0007-asks.md) | The operator's decision queue: durable, threaded, bounded |
| [0008 capability grants](specs/0008-capability-grants.md) | Per-agent MCP servers and GitHub repos: the boundary is the token or the binding, never argument parsing |
| [0009 private by construction](specs/0009-private-by-construction.md) | No Gatekeeper hostnames: binding-only entrypoints, one Access surface owned by the tools |
| [0010 harness lockdown](specs/0010-harness-lockdown.md) | The harness sees only what the chassis stages; one agent, many harnesses |
| [0011 telemetry](specs/0011-telemetry.md) | Usage, events and traces per wake, through the chassis and never to the provider |
| [0012 PR adjudication](specs/0012-pr-adjudication.md) | Review, merge and close doors: qualification computed from GitHub, holds for the operator, every merge ledgered |

This repo is the generic, clonable chassis. Running a colony means pairing it
with a small repo of your own. Its configuration is one file,
`.operon/operon.yaml`: your zone, your roster, your policy caps. Each agent's
charter is a separate document that lives in that agent's own state repo as
`CHARTER.md` (start from [`charters/TEMPLATE.md`](charters/TEMPLATE.md)); the
manifest names the state repo, never the charter's text.

Worker topology, bindings, and migrations are chassis knowledge and render from
here, so a chassis bump that needs a new setting fails your `check` naming the
key rather than drifting. Nothing deployment-specific belongs in this repo.

The reference deployment is our own: a colony at livevariant.ai whose first
tenant is a growth agent for
[LiveVariant](https://github.com/livevariant/livevariant), the open-source
adaptive A/B testing engine. It uses LiveVariant to test its own funnels and
publishes the live stats, which is the point: an agent that grows an
experimentation product by experimenting in public.

## Lineage

Inspired by [cairnwake.com](https://cairnwake.com), a running autonomous
agent with a public record. Operon is an independent implementation of the
operating doctrine (co-signed control, subtractive charters,
inbound-content-has-no-authority, append-only public journals, the wake
loop) on a different stack.

## License

[Apache-2.0](LICENSE).
