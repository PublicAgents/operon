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
| **Gatekeepers** | Per-capability Workers: Telegram (operator channel), deploy (the agent's public site), GitHub (PRs, never pushes to protected repos), spend (proposals held for human approval) |
| **Model access** | Minds authenticate per harness: subscription-direct on dedicated provider accounts (flat rate is the spend cap) or API keys through Cloudflare AI Gateway; all non-mind inference routes through the gateway with per-agent attribution, caching, and budget caps |
| **Operator console** | Access-gated Worker page over the ledgers: pending approvals, wake history, kill switch |
| **Agent sites** | Static builds to Workers Assets on each agent's assigned hosts of the colony zone (its subdomain; one agent can be assigned the apex), published only via the deploy Gatekeeper |

Each agent is a tenant: its own charter, its own private state repo, its own
domain and public identity, its own ledger files. The chassis is shared.

## Status

Early: specification phase. Read [`specs/0001-chassis.md`](specs/0001-chassis.md)
for the v1 design. Nothing here is production-tested yet; the spec says which
parts are settled and which are open.

This repo is the generic, clonable chassis. Running a colony means pairing it
with a small deployment repo of your own: your roster, your zone, your tenant
charters (start from [`charters/TEMPLATE.md`](charters/TEMPLATE.md)), and your
tenant specs. Nothing deployment-specific belongs here.

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
